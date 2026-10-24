#!/usr/bin/env node
// Fixed synthetic test identities, independent of display names and production defaults.
let identityFixtureSequence = 0;
const identityFixture = () => ({ enterpriseKey: 'SYNTHETIC-report-export-test-mjs-' + (++identityFixtureSequence) });
const identityFixtureCreate = (A, options) => A.createAccountSet({ enterprise: identityFixture(), ...options });
// RC-B independent acceptance: every expected amount below is hand-calculated.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'wb-report-export-'));
process.env.WORKBENCH_DATA_DIR = dataDir;
let db;
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  PASS ${name}`); }
  catch (error) { results.push(false); console.error(`  FAIL ${name}\n${error.stack}`); }
}
const e = (code, debit = 0, credit = 0, summary) => ({ code, debit, credit, summary });
const value = (data, label) => [...data.assets, ...data.liabilities].find(row => row.label === label)?.value;
// Independent RFC4180 reader; deliberately does not reuse accounting.parseCsv.
function csvRows(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && ch === ',') { row.push(field); field = ''; }
    else if (!quoted && ch === '\r' && text[i + 1] === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i++;
    } else field += ch;
  }
  assert.equal(quoted, false, 'CSV quotes must close');
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

try {
  ({ db } = await import('../server/db.mjs'));
  const A = await import('../server/accounting.mjs');
  const { buildReportExport, pairedBalanceRows } = await import('../server/report-export.mjs');
  const make = (name = '合成验收账套', start_period = '2025-12') => identityFixtureCreate(A, { name, start_period }).id;
  const voucher = (s, period, entries, extra = {}) => A.createVoucher(s, { period, status: 'posted', entries, ...extra });
  const out = (s, kind, period = '2026-01', extra = {}) => buildReportExport(s, { kind, period, ...extra });
  const report = (s, kind, period, extra) => out(s, kind, period, extra).report;
  const s = make();
  A.addAccount(s, { code: '100201', name: '银行中文明细', category: '资产', direction: 'debit' });
  A.setOpeningBalances(s, [e('1002', 1000), e('100201', 200), e('1601', 1200), e('3001', 0, 2400)]);
  voucher(s, '2025-12', [e('1002', 300), e('5001', 0, 300)]);
  voucher(s, '2025-12', [e('5602', 60), e('1002', 0, 60)]);
  A.carryForwardProfit(s, '2025-12', { yearEnd: true });
  voucher(s, '2026-01', [e('100201', 400), e('5001', 0, 400)]);
  voucher(s, '2026-01', [e('1403', 120), e('1601', 180), e('1002', 0, 300)]);
  voucher(s, '2026-01', [e('5602', 50), e('1002', 0, 50)]);
  // 期初设备在启用月（2025-12）已存在：显式登记取得期间，不靠 start_period 推测取得日。
  A.addAssetCard(s, { name: '期初设备', original_cost: 1200, residual_rate: 0, useful_life_months: 12, start_period: '2026-01', acquired_period: '2025-12' });
  A.generateDepreciation(s, '2026-01');
  // 2026-01 购入的设备（1601 借方 180）必须有对应卡片，否则卡片与总账差异会阻止封账。
  A.addAssetCard(s, { name: '新增设备', original_cost: 180, residual_rate: 0, useful_life_months: 60, start_period: '2026-02', acquired_period: '2026-01' });
  voucher(s, '2026-02', [e('100201', 200), e('5001', 0, 200)]);
  voucher(s, '2026-02', [e('5602', 20), e('1002', 0, 20)]);

  await test('P2: opening, raw posted movements, ledger running and totals preserve every cent; unsafe totals reject', () => {
    const id = make('合成导出整数分', '2025-12');
    const opening = [], entries = [];
    for (let i = 0; i < 1000; i++) {
      const code = '1002' + String(i + 1).padStart(4, '0');
      A.addAccount(id, { code, name: '合成分精度' + i, category: '资产', direction: 'debit' });
      opening.push(e(code, i === 0 ? 900000000000.01 : 0.01));
      entries.push(e('1002', i === 0 ? 900000000000.01 : 0.01));
    }
    opening.push(e('3001', 0, 900000000010)); A.setOpeningBalances(id, opening);
    entries.push(e('3001', 0, 900000000010)); voucher(id, '2025-12', entries);
    voucher(id, '2026-01', [e('1002', 0.03), e('3001', 0, 0.03)]);
    const dec = report(id, 'trial-balance', '2025-12');
    for (const field of ['opening_debit', 'opening_credit', 'period_debit', 'period_credit', 'ytd_debit', 'ytd_credit']) assert.equal(dec.data.totals[field], 900000000010, field);
    assert.equal(dec.data.totals.closing_debit, 1800000000020); assert.equal(dec.data.totals.closing_credit, 1800000000020);
    const jan = report(id, 'trial-balance', '2026-01');
    assert.equal(jan.data.totals.opening_debit, 1800000000020); assert.equal(jan.data.totals.closing_debit, 1800000000020.03);
    assert.equal(jan.data.totals.ytd_debit, 0.03);
    const ledger = report(id, 'ledger', '2025-12', { code: '1002' });
    assert.deepEqual(ledger.data.opening, { debit: 900000000010, credit: 0 });
    assert.deepEqual(ledger.data.current, { debit: 900000000010, credit: 0 });
    assert.equal(ledger.data.items.at(-1).balance, 1800000000020);
    assert.deepEqual(ledger.data.closing, { debit: 1800000000020, credit: 0 });
    const cash = report(id, 'cash-flow-statement', '2026-01');
    assert.equal(cash.data.ytd.totals.financing, 0.03); assert.equal(cash.data.ytd.cash.change, 0.03);
    const csv = csvRows(out(id, 'ledger', '2025-12', { code: '1002' }).body);
    assert.deepEqual(csv.find(row => row[0] === '期末' && row.length === 3), ['期末', '1800000000020.00', '0.00']);
    for (const [a, b] of [[45035996273704.95, 45035996273704.96], [45035996273704.96, 45035996273704.96]]) {
      for (const field of ['debit', 'credit']) {
        const bad = make('合成超界拒绝', '2026-01');
        db.prepare('INSERT INTO opening_balances(account_set_id,code,debit,credit) VALUES(?,?,?,?)').run(bad, '1001', field === 'debit' ? a : 0, field === 'credit' ? a : 0);
        db.prepare('INSERT INTO opening_balances(account_set_id,code,debit,credit) VALUES(?,?,?,?)').run(bad, '1002', field === 'debit' ? b : 0, field === 'credit' ? b : 0);
        assert.throws(() => out(bad, 'trial-balance'), error => error.code === 'report_data_invalid');
      }
    }
  });
  await test('P2: legal 100 cash/capital details total 90071992547409.90 in real CSV without toFixed cent drift', () => {
    const id = make('合成合法极界CSV', '2026-01'), opening = [];
    for (let i = 0; i < 100; i++) {
      const amount = i === 0 ? 900719925474.99 : 900719925474.09;
      for (const [prefix, category, direction] of [['1002', '资产', 'debit'], ['3001', '权益', 'credit']]) {
        const code = prefix + String(i + 1).padStart(4, '0');
        A.addAccount(id, { code, name: '合成合法边界' + code, category, direction });
        opening.push({ code, [direction]: amount });
      }
    }
    A.setOpeningBalances(id, opening);
    const trial = out(id, 'trial-balance');
    assert.equal(trial.report.data.totals.opening_debit, 90071992547409.9); assert.equal(trial.report.data.totals.closing_credit, 90071992547409.9);
    const totals = csvRows(trial.body).find(row => row[0] === '合计');
    for (const column of [3, 4, 9, 10]) assert.equal(totals[column], '90071992547409.90');
    const ledger = out(id, 'ledger', '2026-01', { code: '1002' });
    assert.deepEqual(csvRows(ledger.body).find(row => row[0] === '期间期初' && row.length === 3), ['期间期初', '90071992547409.90', '0.00']);
    assert.deepEqual(csvRows(ledger.body).find(row => row[0] === '期末' && row.length === 3), ['期末', '90071992547409.90', '0.00']);
    assert.ok(!ledger.body.includes('90071992547409.91'));
  });
  await test('balance sheet: opening and January key lines have independent amounts', () => {
    const r = report(s, 'balance-sheet');
    assert.equal(r.data.totals.assets, 2890); assert.equal(r.data.totals.equity, 2890);
    assert.equal(value(r.data, '货币资金'), 1490); assert.equal(value(r.data, '存货'), 120);
    assert.equal(value(r.data, '固定资产原价'), 1380); assert.equal(value(r.data, '减：累计折旧'), -100);
    assert.equal(value(r.data, '固定资产账面价值'), 1280); assert.equal(value(r.data, '未分配利润'), 490);
    assert.equal(r.data.opening.totals.assets, 2640); assert.equal(r.data.balanced, true);
  });
  await test('income: next year excludes December and next month has distinct current/YTD', () => {
    const jan = report(s, 'income-statement').data, feb = report(s, 'income-statement', '2026-02').data;
    assert.equal(jan.current['营业收入'], 400); assert.equal(jan.current['管理费用'], 150);
    assert.equal(jan.current['净利润'], 250); assert.equal(jan.ytd['净利润'], 250);
    assert.equal(feb.current['营业收入'], 200); assert.equal(feb.current['净利润'], 180);
    assert.equal(feb.ytd['营业收入'], 600); assert.equal(feb.ytd['管理费用'], 170); assert.equal(feb.ytd['净利润'], 430);
  });
  await test('downloaded CSV key rows match independent amounts for all five reports', () => {
    const bs = csvRows(out(s, 'balance-sheet').body);
    assert.deepEqual(bs.find(row => row[1] === '货币资金'), ['资产', '货币资金', '1440.00', '1490.00']);
    assert.deepEqual(bs.find(row => row[1] === '资产总计'), ['资产', '资产总计', '2640.00', '2890.00']);
    const income = csvRows(out(s, 'income-statement', '2026-02').body);
    assert.deepEqual(income.find(row => row[0] === '净利润'), ['净利润', '180.00', '430.00']);
    const cash = csvRows(out(s, 'cash-flow-statement', '2026-02').body);
    assert.deepEqual(cash.find(row => row[0] === '现金净增加额'), ['现金净增加额', '', '', '180.00', '230.00']);
    const trial = csvRows(out(s, 'trial-balance', '2026-02').body);
    assert.deepEqual(trial.find(row => row[0] === '100201').slice(3), ['600.00', '0.00', '200.00', '0.00', '600.00', '0.00', '800.00', '0.00']);
    const ledger = csvRows(out(s, 'ledger', '2026-02', { code: '1002' }).body);
    assert.deepEqual(ledger.find(row => row[0] === '期末' && row.length === 3), ['期末', '1670.00', '0.00']);
  });
  // Both persistent profiles use hand-calculated amounts: 1000 + 123.45 - 23.45 = 1100;
  // profit and operating cash increase are 100. No report DTO supplies the expected CSV values.
  for (const [standard, profile, capital, revenue, expense] of [
    ['小企业会计准则', 'small-2011-basic-v1', '3001', '5001', '5602'],
    ['企业会计准则', 'enterprise-2019-general-basic-v1', '4001', '6001', '6602'],
  ]) {
    const id = identityFixtureCreate(A, { name: `合成CSV元数据-${standard}`, accounting_standard: standard, start_period: '2026-01' }).id;
    A.setOpeningBalances(id, [e('1002', 1000), e(capital, 0, 1000)]);
    voucher(id, '2026-01', [e('1002', 123.45), e(revenue, 0, 123.45)], { summary: '合成收入' });
    voucher(id, '2026-01', [e(expense, 23.45), e('1002', 0, 23.45)], { summary: '合成费用' });
    for (const [kind, title] of [
      ['balance-sheet', '资产负债表'], ['income-statement', '利润表'], ['cash-flow-statement', '现金流量表'],
      ['trial-balance', '科目余额表'], ['ledger', '明细账'],
    ]) await test(`${profile}/${kind}: one CNY/yuan metadata pair preserves CSV headings, period and independent amounts`, () => {
      const file = out(id, kind, '2026-01', { code: '1002' });
      assert.equal(file.body.charCodeAt(0), 0xfeff);
      assert.ok(file.body.endsWith('\r\n'));
      assert.doesNotMatch(file.body.replaceAll('\r\n', ''), /[\r\n]/);
      const rows = csvRows(file.body);
      for (const expected of [['币种', '人民币(CNY)'], ['金额单位', '元'], ['报表', title], ['期间', '2026-01'], ['持久profile', profile]]) {
        assert.deepEqual(rows.filter(row => row[0] === expected[0]), [expected]);
      }
      const row = (label, column = 0, length) => rows.find(item => item[column] === label && (length === undefined || item.length === length));
      if (kind === 'balance-sheet') {
        assert.deepEqual(row('分类'), ['分类', '项目', '期间期初', '期末']);
        assert.deepEqual(row('货币资金', 1), ['资产', '货币资金', '1000.00', '1100.00']);
        assert.deepEqual(row('资产总计', 1), ['资产', '资产总计', '1000.00', '1100.00']);
      } else if (kind === 'income-statement') {
        assert.deepEqual(row('项目'), ['项目', '本期发生', '本年累计']);
        for (const [label, amount] of [['营业收入', '123.45'], ['管理费用', '23.45'], ['净利润', '100.00']])
          assert.deepEqual(row(label), [label, amount, amount]);
      } else if (kind === 'cash-flow-statement') {
        assert.deepEqual(row('分类'), ['分类', '科目编码', '科目名称', '本期发生', '本年累计']);
        for (const [label, amount] of [['经营活动净额', '100.00'], ['现金净增加额', '100.00'], ['现金期初余额', '1000.00'], ['现金期末余额', '1100.00']])
          assert.deepEqual(row(label), [label, '', '', amount, amount]);
      } else if (kind === 'trial-balance') {
        assert.deepEqual(row('科目编码'), ['科目编码', '科目名称', '方向', '期初借方', '期初贷方', '本期借方', '本期贷方', '本年借方', '本年贷方', '期末借方', '期末贷方']);
        assert.deepEqual(row('1002'), ['1002', '银行存款', 'debit', '1000.00', '0.00', '123.45', '23.45', '123.45', '23.45', '1100.00', '0.00']);
      } else {
        assert.deepEqual(row('日期'), ['日期', '凭证字', '凭证号', '凭证ID', '分录ID', '科目编码', '科目名称', '摘要', '借方', '贷方', '余额（借减贷）']);
        for (const [label, debit, credit] of [['期间期初', '1000.00', '0.00'], ['本期发生', '123.45', '23.45'], ['本年累计', '123.45', '23.45'], ['期末', '1100.00', '0.00']])
          assert.deepEqual(row(label, 0, 3), [label, debit, credit]);
        const details = rows.filter(item => item[5] === '1002');
        assert.deepEqual(details.map(item => item.slice(7)), [['合成收入', '123.45', '0.00', '1123.45'], ['合成费用', '0.00', '23.45', '1100.00']]);
      }
    });
  }
  await test('trial balance: direct parent and child stay separate without double counting', () => {
    const r = report(s, 'trial-balance', '2026-02');
    const bank = r.data.lines.find(x => x.code === '1002'), child = r.data.lines.find(x => x.code === '100201');
    assert.equal(bank.opening_debit, 890); assert.equal(bank.period_credit, 20);
    assert.equal(bank.ytd_credit, 370); assert.equal(bank.closing_debit, 870);
    assert.equal(child.opening_debit, 600); assert.equal(child.period_debit, 200);
    assert.equal(child.ytd_debit, 600); assert.equal(child.closing_debit, 800);
    for (const check of Object.values(r.checks.trialBalance)) assert.equal(check.balanced, true);
  });
  await test('ledger: parent includes descendants, selected month only, and entry provenance', () => {
    const d = report(s, 'ledger', '2026-02', { code: '1002' }).data;
    assert.deepEqual(d.opening, { debit: 1490, credit: 0 });
    assert.deepEqual(d.current, { debit: 200, credit: 20 });
    assert.deepEqual(d.ytd, { debit: 600, credit: 370 });
    assert.deepEqual(d.closing, { debit: 1670, credit: 0 });
    assert.equal(d.items.length, 2); assert.equal(d.items.at(-1).balance, 1670);
    assert.deepEqual(d.items.map(x => x.code).sort(), ['1002', '100201']);
    for (const item of d.items) {
      assert.equal(item.period, '2026-02'); assert.ok(item.entry_id); assert.ok(item.voucher_id);
      assert.ok(A.getVoucher(s, item.voucher_id).entries.some(x => x.code === item.code));
    }
  });
  await test('child ledger does not include parent amounts', () => {
    const d = report(s, 'ledger', '2026-02', { code: '100201' }).data;
    assert.deepEqual(d.opening, { debit: 600, credit: 0 });
    assert.deepEqual(d.closing, { debit: 800, credit: 0 }); assert.equal(d.items.length, 1);
  });
  await test('credit ledger preserves direction, credit opening and negative running balance', () => {
    const credit = make('贷方账', '2026-01');
    A.setOpeningBalances(credit, [e('1002', 500), e('2202', 0, 500)]);
    voucher(credit, '2026-01', [e('2202', 80), e('1002', 0, 80)]);
    const d = report(credit, 'ledger', '2026-01', { code: '2202' }).data;
    assert.equal(d.direction, 'credit'); assert.deepEqual(d.opening, { debit: 0, credit: 500 });
    assert.deepEqual(d.current, { debit: 80, credit: 0 }); assert.deepEqual(d.closing, { debit: 0, credit: 420 });
    assert.equal(d.items[0].balance, -420);
    assert.ok(csvRows(out(credit, 'ledger', '2026-01', { code: '2202' }).body).flat().includes('-420.00'));
  });
  await test('midyear start is explicit and opening capital is not counted as YTD activity', () => {
    const mid = make('年中启用', '2026-07');
    A.setOpeningBalances(mid, [e('1002', 500), e('3001', 0, 500)]);
    voucher(mid, '2026-07', [e('1002', 100), e('5001', 0, 100)]);
    voucher(mid, '2026-08', [e('1002', 200), e('5001', 0, 200)]);
    const r = report(mid, 'trial-balance', '2026-08');
    const bank = r.data.lines.find(row => row.code === '1002');
    assert.equal(bank.opening_debit, 600); assert.equal(bank.period_debit, 200);
    assert.equal(bank.ytd_debit, 300); assert.equal(bank.closing_debit, 800);
    assert.equal(r.scope.yearStart, '2026-07-01'); assert.ok(r.warnings.some(w => w.code === 'partial_year'));
    assert.deepEqual(report(mid, 'cash-flow-statement', '2026-08').data.ytd.cash, { begin: 500, end: 800, change: 300 });
  });
  await test('cash flow: mixed inventory/equipment purchase and monthly/YTD reconciliation', () => {
    const jan = report(s, 'cash-flow-statement').data, feb = report(s, 'cash-flow-statement', '2026-02').data;
    assert.deepEqual(jan.totals, { operating: 230, investing: -180, financing: 0, net_increase: 50 });
    assert.deepEqual(jan.cash, { begin: 1440, end: 1490, change: 50 }); assert.equal(jan.reconciles, true);
    assert.equal(jan.reportStatus.complete, true); assert.equal(jan.reportStatus.partialValues, false);
    assert.equal(jan.unknown.length, 0);
    assert.equal(feb.totals.operating, 180); assert.equal(feb.totals.net_increase, 180);
    assert.deepEqual(feb.ytd.totals, { operating: 410, investing: -180, financing: 0, net_increase: 230 });
    assert.deepEqual(feb.ytd.cash, { begin: 1440, end: 1670, change: 230 }); assert.equal(feb.ytd.reconciles, true);
    assert.equal(feb.reportStatus.complete, true); assert.equal(feb.ytd.reportStatus.complete, true);
    assert.equal(report(s, "cash-flow-statement", "2026-02").reportStatus.partialValues, false);
  });
  await test('true unknown history remains partial through later month and resets only next year', () => {
    const id = make('合成在建用途未知', '2025-11');
    A.setOpeningBalances(id, [e('1002', 1000), e('3001', 0, 1000)]);
    voucher(id, '2025-11', [e('1604', 100), e('1002', 0, 100)]);
    voucher(id, '2025-12', [e('1002', 20), e('5001', 0, 20)]);
    voucher(id, '2026-01', [e('1403', 12.01), e('1601', 18.02), e('1002', 0, 30.03)]);
    const dec = report(id, 'cash-flow-statement', '2025-12');
    assert.equal(dec.data.reportStatus.complete, true); assert.equal(dec.data.ytd.reportStatus.complete, false);
    assert.equal(dec.reportStatus.partialValues, true); assert.equal(dec.data.ytd.totals.net_increase, 20);
    assert.deepEqual(dec.data.ytd.cash, { begin: 1000, end: 920, change: -80 });
    assert.ok(dec.reportStatus.diagnostics.some(d => d.code === 'cash_flow_classification_incomplete'));
    const jan = report(id, 'cash-flow-statement', '2026-01');
    assert.equal(jan.reportStatus.complete, true); assert.equal(jan.reportStatus.partialValues, false);
    assert.deepEqual(jan.data.ytd.totals, { operating: -12.01, investing: -18.02, financing: 0, net_increase: -30.03 });
    assert.deepEqual(jan.data.ytd.cash, { begin: 920, end: 889.97, change: -30.03 });
  });
  await test('year-end carryforward changes equity location without wiping December profit', () => {
    const d = report(s, 'income-statement', '2025-12').data;
    assert.equal(d.current['营业收入'], 300); assert.equal(d.current['管理费用'], 60); assert.equal(d.current['净利润'], 240);
    const t = report(s, 'trial-balance', '2025-12').data.lines;
    assert.equal(t.find(x => x.code === '3103').closing_credit, 0);
    assert.equal(t.find(x => x.code === '3104').closing_credit, 240);
  });
  await test('draft and unposted vouchers never enter five report outputs', () => {
    const kinds = ['balance-sheet', 'income-statement', 'cash-flow-statement', 'trial-balance', 'ledger'];
    const before = kinds.map(kind => report(s, kind, '2026-02', { code: '1002' }).data);
    voucher(s, '2026-02', [e('1002', 8888), e('5001', 0, 8888)], { status: 'draft' });
    const reversed = voucher(s, '2026-02', [e('1002', 7777), e('5001', 0, 7777)]);
    A.unpostVoucher(s, reversed.id);
    kinds.forEach((kind, i) => assert.deepEqual(report(s, kind, '2026-02', { code: '1002' }).data, before[i]));
  });
  await test('depreciation posting and unposting affect asset and profit by exactly 100', () => {
    const d = make('折旧状态', '2026-01');
    A.setOpeningBalances(d, [e('1601', 1200), e('3001', 0, 1200)]);
    A.addAssetCard(d, { name: '设备', original_cost: 1200, residual_rate: 0, useful_life_months: 12, start_period: '2026-01' });
    assert.equal(report(d, 'balance-sheet').data.totals.assets, 1200, 'asset card must not duplicate ledger');
    const depreciation = A.generateDepreciation(d, '2026-01').voucher;
    assert.equal(report(d, 'balance-sheet').data.totals.assets, 1100);
    assert.equal(report(d, 'income-statement').data.current['净利润'], -100);
    A.unpostVoucher(d, depreciation.id);
    assert.equal(report(d, 'balance-sheet').data.totals.assets, 1200);
    assert.equal(report(d, 'income-statement').data.current['净利润'], 0);
  });
  await test('empty registered books are explicit, not proof of complete zero activity', () => {
    const empty = make('空账套', '2026-01');
    for (const kind of ['balance-sheet', 'income-statement', 'cash-flow-statement', 'trial-balance', 'ledger']) {
      const r = report(empty, kind, '2026-01', { code: '1002' });
      assert.equal(r.dataStatus.empty, true); assert.equal(r.dataStatus.completeness, 'unverified');
      assert.equal(r.dataStatus.taxFilingReady, false); assert.ok(r.warnings.length);
    }
  });
  await test('all four trial balance checkpoints expose an unbalanced imported/corrupt book', () => {
    const bad = make('失衡合成库', '2026-01');
    // Deliberate isolated corruption, never a production write or relaxed import rule.
    db.prepare('INSERT INTO opening_balances (account_set_id,code,debit,credit) VALUES (?,?,?,?)').run(bad, '1002', 10, 0);
    const r = report(bad, 'trial-balance');
    assert.equal(r.checks.trialBalance.opening.balanced, false);
    assert.equal(r.checks.trialBalance.closing.balanced, false);
    assert.equal(r.checks.trialBalance.closing.difference, 10);
    assert.equal(r.dataStatus.taxFilingReady, false); assert.ok(r.warnings.length);
  });
  await test('closed period exports are read only, deterministic and preserve database changes count', () => {
    // LOCAL-02 封账前置：按期间顺序封账，且封账前必须先结转本期损益（本期有损益发生）。
    A.setPeriodStatus(s, '2025-12', 'closed');
    A.carryForwardProfit(s, '2026-01');
    A.setPeriodStatus(s, '2026-01', 'closed');
    const before = db.prepare('SELECT total_changes() AS n').get().n;
    for (const kind of ['balance-sheet', 'income-statement', 'cash-flow-statement', 'trial-balance', 'ledger']) {
      const first = out(s, kind, '2026-01', { code: '1002' });
      assert.equal(first.report.scope.periodStatus, 'closed');
      assert.deepEqual(out(s, kind, '2026-01', { code: '1002' }), first);
    }
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
  });
  await test('nonfinite damaged amounts fail explicitly instead of emitting null/Infinity', () => {
    const broken = make('非有限值损坏库', '2026-01');
    db.prepare('INSERT INTO opening_balances (account_set_id,code,debit,credit) VALUES (?,?,1e999,0)').run(broken, '1002');
    assert.throws(() => report(broken, 'trial-balance'), error => error.code === 'report_data_invalid');
  });
  await test('invalid export requests fail with stable codes without registering periods', () => {
    const before = A.listPeriods(s);
    const cases = [
      [{ kind: 'trial-balance' }, 'period_required'],
      [{ kind: 'trial-balance', period: '2026-13' }, 'period_invalid'],
      [{ kind: 'trial-balance', period: '2026-1' }, 'period_invalid'],
      [{ kind: 'trial-balance', period: '2025-11' }, 'period_before_start'],
      [{ kind: 'trial-balance', period: '2026-03' }, 'period_not_registered'],
      [{ kind: 'unknown', period: '2026-01' }, 'report_kind_unsupported'],
      [{ kind: 'trial-balance', period: '2026-01', format: 'xlsx' }, 'report_format_unsupported'],
      [{ kind: 'ledger', period: '2026-01' }, 'account_code_required'],
      [{ kind: 'ledger', period: '2026-01', code: '999999' }, 'account_not_found'],
    ];
    for (const [options, code] of cases) assert.throws(() => buildReportExport(s, options), error => error.code === code || error.message === code, code);
    assert.throws(() => out(999999, 'trial-balance'), /account_set_not_found/);
    assert.throws(() => buildReportExport(s, null), /report_options_invalid/);
    assert.deepEqual(A.listPeriods(s), before);
  });
  await test('CSV has UTF-8 BOM, escaped Chinese commas/quotes/newlines and exact amounts', () => {
    const chinese = make('中文,"账套"\r\n分行', '2026-01');
    voucher(chinese, '2026-01', [e('1002', 12.34, 0, '中文,"摘要"\r\n第二行'), e('3001', 0, 12.34)]);
    const file = out(chinese, 'ledger', '2026-01', { code: '1002' });
    assert.equal(file.body.charCodeAt(0), 0xfeff); assert.match(file.contentType, /text\/csv.*utf-8/i);
    assert.ok(!/[\r\n]/.test(file.filename));
    const fields = csvRows(file.body).flat();
    assert.ok(fields.includes('中文,"账套"\r\n分行')); assert.ok(fields.includes('中文,"摘要"\r\n第二行'));
    assert.ok(fields.includes('12.34')); assert.ok(fields.includes('0.00'));
  });
  await test('CSV formula injection is neutralized in account names and entry summaries', () => {
    const inj = make('=SUM(1,2)', '2026-01');
    A.addAccount(inj, { code: '100201', name: '@危险科目', category: '资产', direction: 'debit' });
    const samples = ['=1+1', '+SUM(1,2)', '-1+2', '@SUM(1,2)', '\t=1+1', '\r=1+1'];
    for (const summary of samples) voucher(inj, '2026-01', [e('100201', 1, 0, summary), e('3001', 0, 1)]);
    const fields = csvRows(out(inj, 'ledger', '2026-01', { code: '100201' }).body).flat();
    for (const dangerous of [...samples, '=SUM(1,2)', '@危险科目']) {
      assert.ok(!fields.includes(dangerous), `raw formula escaped: ${JSON.stringify(dangerous)}`);
      assert.ok(fields.includes(`'${dangerous}`), `apostrophe prefix: ${JSON.stringify(dangerous)}`);
    }
  });
  await test('same period in another book does not leak into results', () => {
    const other = make('另一账套', '2026-01');
    voucher(other, '2026-01', [e('1002', 999999), e('3001', 0, 999999)]);
    assert.equal(report(s, 'balance-sheet').data.totals.assets, 2890);
    assert.equal(report(other, 'balance-sheet').data.totals.assets, 999999);
  });
  await test('ambiguous mixed cash/noncash voucher warns rather than claiming filing readiness', () => {
    const mixed = make('混合对方分录', '2026-01');
    voucher(mixed, '2026-01', [e('1002', 100), e('1601', 60), e('2001', 0, 160)]);
    const r = report(mixed, 'cash-flow-statement');
    assert.equal(r.data.cash.change, 100); assert.equal(r.data.totals.net_increase, 100);
    assert.equal(r.dataStatus.taxFilingReady, false);
    assert.ok(r.warnings.some(w => /cash|现金|比例/.test(w.code + w.message)));
  });
  await test('B2 stable IDs pair reordered balance rows independently of labels', () => {
    assert.deepEqual(pairedBalanceRows([{ id: 'cash', label: '新标签', value: 120 }, { id: 'stock', label: '同名', value: 50 }],
      [{ id: 'stock', label: '同名', value: 30 }, { id: 'cash', label: '旧标签', value: 100 }]),
    [{ id: 'cash', label: '新标签', value: 120, opening: 100 }, { id: 'stock', label: '同名', value: 50, opening: 30 }]);
  });
  await test('B2 legacy mixed COA preserves real amounts with an explicit compatibility status', () => {
    const legacy = make('合成迁移旧账企业标签', '2026-01');
    A.addAccount(legacy, { code: '6602', name: '旧账管理费用', category: '损益', direction: 'debit' });
    A.setOpeningBalances(legacy, [e('1002', 1000), e('3001', 0, 1000)]);
    db.prepare("UPDATE account_sets SET accounting_profile_id='legacy-small-coa-v1',accounting_standard='企业会计准则' WHERE id=?").run(legacy);
    voucher(legacy, '2026-01', [e('1002', 100), e('5001', 0, 100)]);
    voucher(legacy, '2026-01', [e('6602', 30), e('1002', 0, 30)]);
    const income = out(legacy, 'income-statement');
    assert.equal(income.report.data.current['净利润'], 70);
    assert.equal(income.report.reportStatus.status, 'legacy_compatibility');
    assert.equal(income.report.reportStatus.complete, false);
    assert.equal(income.report.accountingContext.profileId, 'legacy-small-coa-v1');
    assert.ok(csvRows(income.body).some(row => row[0] === '净利润' && row[1] === '70.00'));
    assert.equal(value(report(legacy, 'balance-sheet').data, '货币资金'), 1070);
    voucher(legacy, '2026-01', [e('1002', 100), e('1601', 60), e('2001', 0, 160)]);
    const mixed = report(legacy, 'cash-flow-statement');
    assert.equal(mixed.data.cash.end, 1170);
    assert.equal(mixed.data.cash.change, 170);
    assert.equal(mixed.data.totals.net_increase, 170);
    assert.equal(mixed.reportStatus.status, 'legacy_compatibility');
    assert.equal(mixed.reportStatus.complete, false);
    assert.ok(mixed.warnings.some(w => w.message.includes('比例分摊') && w.message.includes('可能净额抵销')));
  });
} finally {
  db?.close();
  if (process.env.KEEP_FIXTURES !== "1" && results.every(Boolean)) rmSync(dataDir, { recursive: true, force: true });
  else console.log(`Failed fixture retained: ${dataDir}`);
}
console.log(`\nReport export acceptance: ${results.filter(Boolean).length}/${results.length} passed`);
if (results.some(x => !x)) process.exitCode = 1;
