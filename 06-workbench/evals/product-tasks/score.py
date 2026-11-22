"""验收者只读核账。预期由合成原件、客户约定和独立算术得出。"""
import argparse
import csv
import hashlib
import json
import sqlite3
from decimal import Decimal
from pathlib import Path

OCT, NOV, DEC, SEP, JAN = '2026-10', '2026-11', '2026-12', '2026-09', '2027-01'


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def table(path):
    with Path(path).open(encoding='utf-8-sig', newline='') as file:
        return list(csv.DictReader(file))


def money(x):
    return f'{Decimal(str(x)):.2f}'


class Score:
    def __init__(self):
        self.items = []

    def check(self, label, expected, actual):
        self.items.append(dict(check=label, expected=expected, actual=actual, passed=expected == actual))


def records(root):
    for p in sorted(root.glob('*/begin.json')):
        meta = read(p)
        last = read(p.parent / 'end.json')
        if last['output']['file'] not in ('result.json','error.json'):
            raise ValueError('调用输出引用无效')
        out = p.parent / last['output']['file']
        args = p.parent / 'input.json'
        if sha(args) != meta['input']['sha256'] or sha(out) != last['output']['sha256'] or sha(p) != last['beginSha256']:
            raise ValueError(f'调用内容已变更 {p.parent.name}')
        yield dict(id=p.parent.name, tool=meta['tool'], args=read(args), out=read(out))


def score_bank(s, f, reviewer, calls):
    before = read(reviewer / 'before.json')
    s.check('只核账阶段尚未导入或保存', dict(bank_batches=0, bank_transactions=0, bank_matches=0), read(reviewer / '核账阶段终态.json'))
    original = table(f['original'])
    s.check('原件版本', before['sourceSha'], sha(f['original']))
    account = f['accountSetId']
    with sqlite3.connect(Path(f['dbPath']).resolve().as_uri()+'?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        def rows(sql):
            return [dict(row) for row in db.execute(sql, (account,))]
        vouchers = rows('SELECT * FROM vouchers WHERE account_set_id=? ORDER BY id')
        entries = rows('SELECT e.* FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? ORDER BY e.id')
        s.check('原凭证及状态逐笔不变', before['vouchers'], vouchers)
        s.check('原分录及金额逐笔不变', before['entries'], entries)
        dates = {v['id']:v['voucher_date'] for v in before['vouchers']}
        approved, expected, results = None, [], []
        for row in original:
            incoming = bool(row['收入'])
            amount = Decimal(row['收入'] or row['支出'])
            ref = row['流水号']
            candidates = [e for e in before['entries'] if e['code']=='1002' and dates[e['voucher_id']]==row['日期']
                          and Decimal(str(e['debit' if incoming else 'credit']))==amount]
            expected.append(dict(bank_ref_id=ref,txn_date=row['日期'],direction='inflow' if incoming else 'outflow',amount_cents=int(amount*100)))
            results.append((ref,'已核上' if len(candidates)==1 else '待查'))
            if ref=='R1' and len(candidates)==1:
                approved = candidates[0]
        s.check('办理前已按原件及原分录核清每笔', sorted(results), sorted((r['流水号'],r['核对结论']) for r in table(reviewer/'第一次核对表.csv')))
        s.check('只导入一次且无重复流水', expected, rows('SELECT bank_ref_id,txn_date,direction,amount_cents FROM bank_transactions WHERE account_set_id=? ORDER BY row_index'))
        s.check('唯一的业务批次', 1, len(rows('SELECT id FROM bank_transactions WHERE account_set_id=? GROUP BY batch_id')))
        s.check('唯一的业务批次记录', 1, len(rows('SELECT batch_id FROM bank_batches WHERE account_set_id=?')))
        s.check('只保存批准的那笔及正确凭证分录', [dict(bank_ref_id='R1',voucher_id=approved['voucher_id'],entry_id=approved['id'],status='confirmed')],
                rows('SELECT t.bank_ref_id,m.voucher_id,m.entry_id,m.status FROM bank_matches m LEFT JOIN bank_transactions t ON t.id=m.transaction_id WHERE m.account_set_id=?'))
        expected_ops = []
        order = []
        for stage, tool, action in [('preview','bank_import_preview',None),('import','bank_import','bank.import'),('confirm','bank_confirm','bank.match.confirm'),('readback','bank_matches',None)]:
            draft = read(reviewer / (stage+'.json'))
            matching = [i for i,r in enumerate(calls) if r['tool']==tool and r['args'].get('draftRef')==draft['draftRef'] and r['out'].get('ok')]
            s.check('使用操作员签发的 '+tool, True, bool(matching))
            if matching:
                order.append(matching[0])
                if stage=='readback':
                    s.check('回读匹配状态和数量',dict(confirmed=1,cancelled=0,invalidated=0),calls[matching[-1]]['out']['projection']['statusCounts'])
            if action:
                expected_ops.append(dict(action=action, outcome='succeeded', operation_id=draft['operationId']))
        s.check('按序预览、导入、保存、回读原匹配', True, len(order)==4 and order==sorted(order))
        s.check('原操作号与唯一提交事件逐一对应',expected_ops,rows("SELECT action,outcome,operation_id FROM audit_events WHERE account_set_id=? AND action LIKE 'bank.%' AND action!='bank.account.register' AND NOT(action='bank.refresh' AND outcome='no_change') ORDER BY seq"))
        s.check('流水、匹配实际写入次数', ['bank_account_registered','import_completed','match_confirmed'], [r['event_type'] for r in rows('SELECT event_type FROM bank_audit_events WHERE account_set_id=? ORDER BY id')])


def vat_checks(s, f, reviewer, calls, requested):
    packs = [r for r in calls if r['tool']=='finance_vat_plan' and r['out'].get('handoff') and r['id']!=f.get('previous')]
    candidates = [r for r in packs if not requested or r['id']==requested]
    s.check('有本次生成的交接包', True, bool(candidates))
    if not candidates:
        return
    call = candidates[-1]
    directory = Path(f['audit']) / call['id']
    pack = read(directory/'vat-handoff.json')
    digests = call['out']['handoff']['digests']
    for key, name in [('data','vat-handoff.json'),('report','vat-handoff.html'),('evidence','vat-planning-evidence.json')]:
        s.check(name+' 完整性', digests[key], sha(directory/name))
    s.check('账套、所属期与决策日', [f['accountSetId'],OCT,'2026-11-02',DEC],[pack['scope']['accountSetId'],pack['scope']['period'],pack['asOf'],pack['through']])
    originals = Path(f['source'])
    s.check('交接引用本次实际原件版本', sorted((str(p),sha(p)) for p in originals.glob('*.json')), sorted((r['path'],r['sha256']) for r in pack['originals']))
    source_docs = [read(p) for p in originals.glob('*.json')]
    def facts(kind):
        return [row for doc in source_docs for row in doc.get(kind,[])]
    raw_invoices = {r['invoiceNumber']:r for r in facts('invoice') if r['receipt']<=pack['asOf']}
    inv = {r['invoiceNumber']:r for r in pack['invoices']}
    s.check('决策日可知的完整逐票清单及金额', sorted((n,money(row['taxAmount'])) for n,row in raw_invoices.items()), sorted((r['invoiceNumber'],r['taxAmount']) for r in pack['invoices']))
    used = facts('confirmation')[0]
    old = inv[used['invoiceNumber']]
    s.check('已用票沿用所属期，两方案均不重复选择', [used['taxPeriod'],None,None,used['taxPeriod']], [old[k] for k in ('fixedPeriod','baseline','plan','recommendedPeriod')])
    for row in pack['invoices']:
        first = raw_invoices[row['invoiceNumber']]['receipt'][:7]
        s.check('收件月份限制 '+row['invoiceNumber'],True,all(row.get(k) is None or row[k]>=first for k in ('baseline','plan','recommendedPeriod')))
    chosen = pack['recommendation']['choice']
    other = {'plan':'baseline','baseline':'plan'}[chosen]
    scenarios = pack['scenarios']
    chosen_rows = {r['period']:r for r in scenarios[chosen]['months']}
    other_rows = {r['period']:r for r in scenarios[other]['months']}
    months = {r['period']:r for r in facts('month')}
    prior = facts('opening')[0]
    selected = raw_invoices['QH-0926']['taxAmount']
    expected_oct = months[OCT]['outputVat']-selected
    schedule = facts('agreement')[0]
    s.check('按签订的单月最低税负判断', [schedule['burdenMode'],money(schedule['minimumPercent'])], [pack['recommendation']['agreement'][k] for k in ('burdenMode','minimumPercent')])
    s.check('十月实际资料基础、未来预算分别呈现', {p:r['basis'] for p,r in months.items()}, {p:r['basis'] for p,r in chosen_rows.items()})
    s.check('十月推荐方案及单月、累计税负', [money(expected_oct),round(expected_oct/months[OCT]['salesExcludingVat']*100,4),round((prior['ytdDueBeforePrepayment']+expected_oct)/(prior['ytdSalesExcludingVat']+months[OCT]['salesExcludingVat'])*100,4)],
            [chosen_rows[OCT]['due'],chosen_rows[OCT]['burden']['monthly']['percent'],chosen_rows[OCT]['burden']['ytd']['percent']])
    filing = facts('filing')[0]
    filing_rows = [r for r in pack['months'] if r['period']==SEP]
    s.check('九月申报独立核实', [money(filing['declaredDue'])],[r['declaredDue'] for r in filing_rows])
    cash = {r['paymentMonth']:r for r in pack['cash']}
    paid = facts('event')[0]
    s.check('回单只确认实际支付月份', {p:money(paid['amount']) if p==paid['operationDate'][:7] else None for p in cash}, {p:r['observedActualPaid'] for p,r in cash.items()})
    if f['task']=='vat-selection':
        delayed = raw_invoices['QH-1020']['taxAmount']
        november = months[NOV]['outputVat']-raw_invoices['QH-1101']['taxAmount']
        expect = {OCT:expected_oct,NOV:november-delayed,DEC:months[DEC]['outputVat']}
        alt = {OCT:expected_oct-delayed,NOV:november,DEC:months[DEC]['outputVat']}
        for label, expected, actual in [('符合约定的去向',expect,chosen_rows),('全选方案',alt,other_rows)]:
            s.check(label+'逐月应纳', {p:money(v) for p,v in expected.items()}, {p:r['due'] for p,r in actual.items()})
        s.check('推荐方案逐票对应', [OCT,NOV,NOV], [inv[n]['recommendedPeriod'] for n in ('QH-0926','QH-1020','QH-1101')])
        s.check('年底累计应纳和预计税负', [money(sum(expect.values())),money(prior['ytdDueBeforePrepayment']+sum(expect.values()))], [scenarios[chosen]['yearEnd']['dueFromStart'],scenarios[chosen]['yearEnd']['burden']['dueBeforePrepayment']])
        s.check('年度税额及年底现金差异', ['0.00','0.00'], [pack['deltas']['yearAttributedVat'],pack['deltas']['yearEndAfterVatCash']])
        s.check('付款月现金差异按方案方向计算', [money(0),money(-delayed if chosen=='plan' else delayed),money(delayed if chosen=='plan' else -delayed),money(0)], [r['afterVatCash'] for r in sorted(pack['deltas']['byPaymentMonth'],key=lambda r:r['paymentMonth'])])
        s.check('预计付款月及金额', {NOV:money(expect[OCT]),DEC:money(expect[NOV]),JAN:money(expect[DEC])}, {p:r['expectedOutstanding'] for p,r in cash.items() if p!=OCT})
    else:
        before = read(reviewer/'before.json')
        oldpack = read(before['dataPath'])
        next_receipt = read(reviewer/('交接验证-'+call['id']+'.json'))
        s.check('下一期独立工作区读回本次报告', [call['id'],True,sha(directory/'vat-handoff.html'),'verified'],
                [next_receipt['callId'],Path(next_receipt['successor'])!=Path(f['host']),next_receipt['reportSha'],next_receipt['artifactIntegrity']])
        s.check('旧报告及底稿完整保留',[before['dataHash'],before['reportHash']], [sha(before[k]) for k in ('dataPath','reportPath')])
        old_hashes = {r['path']:r['sha256'] for r in oldpack['originals']}
        new_hashes = {r['path']:r['sha256'] for r in pack['originals']}
        s.check('同名登记表换版并新增独立回单', sorted(['购票登记及确认回单.json','补到的九月税款支付凭证.json']),
                sorted(Path(path).name for path in new_hashes if new_hashes[path]!=old_hashes.get(path)))
        s.check('旧操作号绑定且另出新版本',[before['callId'],'verified_record',True],[pack['previous']['callId'],pack['previous']['status'],pack['callId']!=before['callId']])
        def reviewed(record_id, align):
            return any(r['tool']=='finance_period_review' and r['args'].get('target',{}).get('period')==NOV and align(r['id'])
                       and any(leaf.get('callId')==record_id and leaf.get('artifactIntegrity')=='verified' for leaf in r['out'].get('records',[])) for r in calls)
        s.check('新工作区先找回原操作，再交给下一次会话', [True,True],[reviewed(before['callId'],lambda k:k<call['id']),reviewed(call['id'],lambda k:k>call['id'])])
        impact = pack['previous']['impact']
        s.check('变化范围含次月累计、两个付款月和九月回执', [[OCT,NOV],[OCT,NOV],[SEP],[inv['QH-0926']['invoiceRef']]], [impact[k] for k in ('taxPeriods','cashMonths','receiptPeriods','invoiceRefs')])
        s.check('缺件只阻断十二月及年底预测', [[DEC],NOV,None], [sorted({r['period'] for r in pack['gaps']}),pack['recommendation']['comparedThrough'],pack['yearEnd']])
        old_bill = next(r for r in read(reviewer/'旧购票登记.json')['invoice'] if r['invoiceNumber']=='QH-0926')
        old_rows = {r['period']:r for r in oldpack['months']}
        s.check('十一月单月不变、累计随十月调整', money(old_bill['taxAmount']-selected),
                money(Decimal(chosen_rows[NOV]['burden']['ytd']['dueBeforePrepayment'])-Decimal(old_rows[NOV]['burden']['ytd']['dueBeforePrepayment'])))
        s.check('逐月重算和未变月份应纳', [money(months[OCT]['outputVat']-old_bill['taxAmount']),money(expected_oct),money(months[NOV]['outputVat']),money(months[NOV]['outputVat'])],
                [old_rows[OCT]['due'],chosen_rows[OCT]['due'],old_rows[NOV]['due'],chosen_rows[NOV]['due']])
        s.check('只补记实缴、原申报金额保留', [money(filing['declaredDue']),None,money(paid['amount'])], [old_rows[SEP]['declaredDue'],next((r['observedActualPaid'] for r in oldpack['cash'] if r['paymentMonth']==OCT),None),cash[OCT]['observedActualPaid']])
        s.check('新交接标出受影响的四类交付', sorted(['invoice_inventory','monthly_tax_calculation','payment_month_cash','receipt_reconciliation']), sorted(impact['outputs']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root',type=Path)
    parser.add_argument('--call-id',help='评分指定交接版本；默认最新')
    parser.add_argument('--output',type=Path)
    a = parser.parse_args()
    reviewer = a.root/'reviewer'
    f = read(reviewer/'fixture.json')
    s = Score()
    try:
        for name,digest in read(reviewer/'原件指纹.json').items():
            s.check('原件版本 '+name,digest,sha(Path(f['source'])/name))
        calls = list(records(Path(f['audit'])))
        if f['task']=='bank':
            score_bank(s,f,reviewer,calls)
        else:
            vat_checks(s,f,reviewer,calls,a.call_id)
    except (KeyError,IndexError,FileNotFoundError,ValueError,TypeError,sqlite3.Error,StopIteration) as exc:
        s.check('必需证据齐备',True,f'{type(exc).__name__}: {exc}')
    result = dict(task=f['task'],evaluation='scripted_product_replay' if (reviewer/'program-replay.json').exists() else 'product_state_only',passed=bool(s.items) and all(i['passed'] for i in s.items),checks=s.items)
    report = json.dumps(result,ensure_ascii=False,indent=2)
    if a.output:
        a.output.write_text(report+'\n',encoding='utf-8')
    print(report)
    return 0 if result['passed'] else 1


if __name__=='__main__':
    raise SystemExit(main())
