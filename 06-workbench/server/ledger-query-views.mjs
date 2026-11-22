// 每次在同一个 SQLite SELECT 快照内计算全期合计、版本和有界页，翻页前核对版本。
// 稳定排序和内容版本保证跨进程重试不漏行。仅保留当前页，客户名称和摘要不离开账库。
import {createHash} from 'node:crypto';
import {PAGE_LIMIT,snapshotPattern,visibleAccountCode} from './query-view-contract.mjs';
import {storedCents,centsToNumber} from './money.mjs';
import {db} from './db.mjs';

const fail = code => { throw Object.assign(new Error(code), {code}); };

function readPage(opts, scope, view, filters = []) {
  const allowed = ['view','limit','offset','snapshot',...filters];
  if (view === 'voucher_check') allowed.push('voucherId');
  if (Object.keys(opts).some(k=>!allowed.includes(k))) fail('query_page_invalid');
  const {limit = 10, offset = 0, snapshot} = opts;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT || !Number.isSafeInteger(offset) || offset < 0
    || (snapshot !== undefined && (typeof snapshot !== 'string' || !snapshotPattern.test(snapshot)))) fail('query_page_invalid');
  if (offset && snapshot === undefined) fail('query_snapshot_required');
  for (const key of filters) {
    if (opts[key] !== undefined && (typeof opts[key] !== 'string' || !opts[key].trim() || opts[key].length > 120)) fail('query_page_invalid');
  }
  const instance = db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get();
  if (!instance) fail('model_scope_mismatch');
  const digest = createHash('sha256').update(JSON.stringify([instance.instance_id, view,...scope,...filters.map(k=>opts[k]??null)]));
  const rows = [];
  let totalCount = 0;
  return {
    hash(row) { digest.update('\n'+JSON.stringify(row)); },
    add(row) {
      if (totalCount >= offset && rows.length < limit) rows.push(row);
      totalCount++;
    },
    finish(extra = {}) {
      const version = digest.digest('hex');
      if (snapshot !== undefined && version !== snapshot) fail('query_snapshot_changed');
      return {accountSetId:scope[0], queryView:{view,offset,limit,totalCount,pageCount:rows.length,
        nextOffset:offset+rows.length < totalCount ? offset+rows.length : null,snapshot:version,rows,...extra}};
    }
  };
}

export function postedVoucherIndex(setId, period, opts) {
  const page = readPage(opts,[setId,period],'voucher_index');
  const entries = db.prepare(`SELECT v.id, v.number, v.voucher_date, v.summary, e.id AS entryId,
      e.code, e.summary AS lineSummary, e.debit, e.credit FROM vouchers v
    LEFT JOIN voucher_entries e ON e.voucher_id=v.id WHERE v.account_set_id=? AND v.period=? AND v.status='posted'
    ORDER BY v.id,e.line_no,e.id`).iterate(setId,period);
  let previousId, entryCount = 0, debit = 0n, credit = 0n;
  for (const row of entries) {
    page.hash(row);
    if (row.id !== previousId) {
      page.add({voucherId:row.id,number:row.number});
      previousId = row.id;
    }
    if (row.entryId !== null) {
      entryCount++;
      debit += storedCents(row.debit);
      credit += storedCents(row.credit);
    }
  }
  return page.finish({period,entryCount,totalDebit:centsToNumber(debit),totalCredit:centsToNumber(credit)});
}

export function accountIndex(setId, opts) {
  const page = readPage(opts,[setId],'account_index',['nameContains','codePrefix']);
  const accounts = db.prepare(`SELECT id,code,name,is_leaf,direction FROM accounts WHERE account_set_id=?
    AND instr(name,?)>0 AND substr(code,1,length(?))=? ORDER BY code,id`)
    .iterate(setId,opts.nameContains??'',opts.codePrefix??'',opts.codePrefix??'');
  for (const row of accounts) {
    page.hash(row);
    page.add({accountId:row.id,code:visibleAccountCode(row.code),leaf:row.is_leaf===1,direction:row.direction});
  }
  return page.finish();
}

export function voucherCheckPage(setId, period, voucherId, opts) {
  const page = readPage(opts,[setId,period,voucherId],'voucher_check',['partyText','basisText']);
  const entries = db.prepare(`SELECT v.voucher_date,v.number,v.status,v.summary,e.line_no,e.code,e.summary AS lineSummary,
      e.debit,e.credit,a.id AS accountId,a.name AS accountName FROM vouchers v
    LEFT JOIN voucher_entries e ON e.voucher_id=v.id LEFT JOIN accounts a ON a.account_set_id=v.account_set_id AND a.code=e.code
    WHERE v.account_set_id=? AND v.period=? AND v.id=? ORDER BY e.line_no,e.id`).iterate(setId,period,voucherId);
  let voucher, debit = 0n, credit = 0n;
  const found = {};
  for (const row of entries) {
    page.hash(row);
    voucher ??= {voucherId,period,voucherDate:row.voucher_date,number:row.number,status:row.status};
    for (const key of ['partyText','basisText']) {
      if (opts[key] !== undefined) {
        const texts = [row.summary,row.lineSummary];
        if (key === 'partyText') texts.push(row.accountName);
        found[key+'Found'] ||= texts.some(t => typeof t === 'string' && t.includes(opts[key]));
      }
    }
    if (row.line_no !== null) {
      debit += storedCents(row.debit);
      credit += storedCents(row.credit);
      page.add({lineNo:row.line_no,accountId:row.accountId,code:visibleAccountCode(row.code),debit:row.debit,credit:row.credit});
    }
  }
  if (!voucher) fail('voucher_not_found');
  return page.finish({...voucher,totalDebit:centsToNumber(debit),totalCredit:centsToNumber(credit),...found});
}

export function resolveLedgerCode(setId, params, legacyCode) {
  if (params?.accountId === undefined) return legacyCode;
  if (!Number.isSafeInteger(params.accountId) || params.accountId <= 0) fail('model_arguments_invalid');
  const account = db.prepare('SELECT code FROM accounts WHERE account_set_id=? AND id=?').get(setId,params.accountId);
  if (!account) fail('account_not_found');
  if (legacyCode && account.code !== legacyCode) fail('model_arguments_invalid');
  return account.code;
}
