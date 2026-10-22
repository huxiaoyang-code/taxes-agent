#!/usr/bin/env node
// LOCAL-08 independent acceptance for the finance output policy module.
//
// 只用合成内存对象：不建库、不设 WORKBENCH_DATA_DIR、不连旧后端、不读真实账套。
// 每条预期值都是手算的常量，不从被测实现反推（不是镜像实现）。
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

const M = await import('../server/finance-output-policy.mjs');
const { FinanceOutputPolicy, OutputPolicyError, sanitizeProjection, measureRawValue, safeErrorProjection } = M;

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  PASS ${name}`); }
  catch (error) { results.push(false); console.error(`  FAIL ${name}\n${error.stack}`); }
}

// ---------------------------------------------------------------- 合成敏感标记
// 都是合成数据；故意用非十六进制字符，避免与随机引用 hex 撞字符串。
const X = {
  enterprise: '合成机密企业名称甲',
  accountName: '合成机密科目名称乙',
  accountCode: 'ZC-998877',
  summary: '合成机密摘要丙',
  counterparty: '合成机密往来单位丁',
  person: '合成机密经办人戊',
  filePath: 'D:/合成机密路径/凭证明细.zip',
  taxId: '91350000SECRETX01',
  note: '合成机密备注己',
};
const MARKERS = Object.values(X);
function assertNoLeak(value, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const found = MARKERS.filter(marker => text.includes(marker));
  assert.deepEqual(found, [], `${label} 泄漏合成敏感原值：${found.join(' / ')}`);
}
const expectCode = (fn, code) => {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof OutputPolicyError, `期望 OutputPolicyError，实际 ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
};

// ---------------------------------------------------------------- 合成原始结果（形状对齐 accounting.mjs）
const rawBalanceSheet = {
  period: '2026-01',
  assets: [
    { label: '货币资金', value: 1234.5, name: X.accountName, code: X.accountCode },
    { label: '应收账款', value: 200.1, counterparty: X.counterparty },
    { label: '存货', value: 99.99, summary: X.summary },
    { label: '固定资产账面价值', value: 5000, person: X.person },
    { label: `其它行-${X.note}`, value: 777 },
  ],
  liabilities: [{ label: '负债合计', value: 11, source: X.filePath }],
  totals: { assets: 6534.6, liabilities: 11, equity: 6523.6 },
  balanced: true,
  enterprise: X.enterprise,
  taxpayerId: X.taxId,
};
const rawVoucherList = [
  {
    id: 11, period: '2026-01', status: 'posted', summary: X.summary, created_at: '2026-01-05 10:00:00',
    entries: [
      { line_no: 1, code: '1002', summary: X.counterparty, debit: 150.25, credit: 0 },
      { line_no: 2, code: '5001', summary: X.person, debit: 0, credit: 150.25 },
    ],
    total_debit: 150.25, total_credit: 150.25,
  },
  {
    id: 12, period: '2026-01', status: 'draft', summary: X.note,
    entries: [
      { line_no: 1, code: '5602', summary: X.filePath, debit: 0.5, credit: 0 },
      { line_no: 2, code: '1002', summary: X.accountName, debit: 0, credit: 0.5 },
    ],
  },
];
const rawCreatedVoucher = {
  id: 77, account_set_id: 5, period: '2026-02', voucher_date: '2026-02-28', word: '记', number: 3,
  summary: X.summary, status: 'posted', created_at: '2026-02-28 09:00:00',
  entries: [
    { line_no: 1, code: X.accountCode, summary: X.counterparty, debit: 100, credit: 0 },
    { line_no: 2, code: '5001', summary: X.person, debit: 0, credit: 100 },
  ],
  total_debit: 100, total_credit: 100,
};

// ================================================================ 1. 查询：模型通道
await test('query: 模型摘要只含白名单数值/状态，敏感原值全部不出模型通道', () => {
  const policy = new FinanceOutputPolicy();
  const envelope = policy.wrapQuery('finance_query:report.balance_sheet', { accountSetId: 5, value: rawBalanceSheet });
  assert.deepEqual(envelope.projection, {
    period: '2026-01',
    assets: 6534.6, liabilities: 11, equity: 6523.6,
    balanced: true, lineCount: 6,
    cash: 1234.5, receivables: 200.1, inventory: 99.99, fixedAssetsNet: 5000,
  });
  assert.equal(envelope.channel, 'model');
  assert.equal(envelope.operationCategory, 'query');
  assert.equal(envelope.rawValuesIncluded, false);
  assert.equal(envelope.refPersistence, 'process_memory');
  assert.match(envelope.localRef, M.REF_PATTERN);
  assert.equal(envelope.projectionDropped, 0);
  assertNoLeak(envelope, 'balance sheet envelope');
  assert.ok(!JSON.stringify(envelope.projection).includes('777'), '明细行数值不应进入模型摘要');
  assert.ok(Object.isFrozen(envelope.projection), 'projection 必须冻结，模型侧不能改写后回读');
  policy.dispose();
});

await test('query: projection 只出现登记字段（未知字段默认拒绝，不是黑名单）', () => {
  const policy = new FinanceOutputPolicy();
  const encryptedExtras = { ...rawBalanceSheet, enterprise: X.enterprise, extraList: [{ secret: X.note }] };
  const envelope = policy.wrapQuery('finance_query:report.balance_sheet', { accountSetId: 5, value: encryptedExtras });
  assert.deepEqual(Object.keys(envelope.projection).sort(), [
    'assets', 'balanced', 'cash', 'equity', 'fixedAssetsNet', 'inventory', 'liabilities', 'lineCount', 'period', 'receivables',
  ]);
  assertNoLeak(envelope.projection, 'projection keys');
  policy.dispose();
});

await test('query: 凭证列表只给数量与合计，凭证行/摘要/科目不出模型通道', () => {
  const policy = new FinanceOutputPolicy();
  const envelope = policy.wrapQuery('finance_query:voucher.generated.list', { accountSetId: 5, value: rawVoucherList });
  assert.deepEqual(envelope.projection, {
    voucherCount: 2, entryCount: 4, postedCount: 1, draftCount: 1,
    totalDebit: 150.75, totalCredit: 150.75, balanced: true,
  });
  assertNoLeak(envelope, 'voucher list envelope');
  policy.dispose();
});

await test('query: 账套/科目/期末/试算/利润/现金流/明细账的有限摘要独立核对', () => {
  const policy = new FinanceOutputPolicy();
  const wrap = (op, value) => policy.wrapQuery(op, { accountSetId: 5, value }).projection;

  const set = wrap('finance_query:enterprise_account.account_set', {
    id: 5, name: X.enterprise, taxpayer_type: '一般纳税人', accounting_standard: '企业会计准则', start_period: '2026-01',
  });
  assert.deepEqual(set, {
    accountSetId: 5, startPeriod: '2026-01', taxpayerType: 'general',
    accountingStandard: 'enterprise', hasDisplayName: true,
  });
  assertNoLeak(set, 'account set projection');

  const accounts = wrap('finance_query:enterprise_account.subject_system.all', [
    { code: '1001', name: X.accountName, category: '资产', direction: 'debit', contra: 0, is_leaf: 1 },
    { code: '2202', name: X.counterparty, category: '负债', direction: 'credit', contra: 0, is_leaf: 1 },
    { code: '5001', name: X.summary, category: '损益', direction: 'credit', contra: 0, is_leaf: 0 },
  ]);
  assert.deepEqual(accounts, {
    accountCount: 3, leafCount: 2, contraCount: 0,
    byCategory: { assets: 1, liabilities: 1, equity: 0, cost: 0, profit_loss: 1 },
  });
  assertNoLeak(accounts, 'accounts projection');

  const trial = wrap('finance_query:report.trial_balance', {
    period: '2026-01',
    lines: [{ code: X.accountCode, name: X.accountName, closing_debit: 300, closing_credit: 0 }],
    totals: { opening_debit: 0, opening_credit: 0, period_debit: 300, period_credit: 300, closing_debit: 300, closing_credit: 300 },
  });
  assert.deepEqual(trial, {
    period: '2026-01', lineCount: 1, openingDebit: 0, openingCredit: 0,
    periodDebit: 300, periodCredit: 300, closingDebit: 300, closingCredit: 300, balanced: true,
  });

  const income = wrap('finance_query:report.income_statement', {
    period: '2026-01',
    current: { 营业收入: 1000, 营业成本: 400, 销售费用: 10, 管理费用: 20, 财务费用: 5, 利润总额: 565, 净利润: 565 },
    ytd: { 营业收入: 1000, 净利润: 565 },
  });
  assert.deepEqual(income, {
    period: '2026-01', currentRevenue: 1000, currentCost: 400, currentExpenses: 35,
    currentProfitBeforeTax: 565, currentNetProfit: 565, ytdRevenue: 1000, ytdNetProfit: 565,
  });

  const cash = wrap('finance_query:report.cash_flow_statement', {
    period: '2026-01', method: '直接法（按对方科目分类）',
    operating: [{ code: '2202', name: X.counterparty, value: 120 }, { code: '1122', name: X.accountName, value: -20 }],
    investing: [{ code: '1601', name: X.summary, value: -20 }],
    financing: [],
    totals: { operating: 100, investing: -20, financing: 0, net_increase: 80 },
    cash: { begin: 50, end: 130, change: 80 },
    reconciles: true,
    supplement_indirect: { 净利润: 565 },
  });
  assert.deepEqual(cash, {
    period: '2026-01', operating: 100, investing: -20, financing: 0, netIncrease: 80,
    cashBegin: 50, cashEnd: 130, cashChange: 80, reconciles: true, lineCount: 3,
  });
  assertNoLeak(cash, 'cash flow projection');

  const periodEnd = wrap('finance_query:period_end.summary', {
    periods: [{ period: '2026-01', status: 'open' }, { period: '2026-02', status: 'closed' }],
    trial_balance: { period: '2026-02', lines: [{ code: '1001', name: X.accountName }], totals: { closing_debit: 250, closing_credit: 250 } },
  });
  assert.deepEqual(periodEnd, {
    periodCount: 2, openPeriodCount: 1, closedPeriodCount: 1, period: '2026-02',
    closingDebit: 250, closingCredit: 250, balanced: true,
  });

  // 明细账：期初 100/0，本期借 10 贷 4.5 → 期末 105.5（手算）
  const ledger = wrap('finance_query:ledger.general', {
    code: X.accountCode, name: X.accountName, direction: 'debit', period: '2026-01',
    opening: { debit: 100, credit: 0 },
    items: [
      { period: '2026-01', voucher_id: 11, summary: X.summary, debit: 10, credit: 0, balance: 110 },
      { period: '2026-01', voucher_id: 12, summary: X.note, debit: 0, credit: 4.5, balance: 105.5 },
    ],
  });
  assert.deepEqual(ledger, {
    period: '2026-01', direction: 'debit', itemCount: 2, openingDebit: 100, openingCredit: 0,
    periodDebit: 10, periodCredit: 4.5, closingBalance: 105.5,
  });
  assertNoLeak(ledger, 'ledger projection');
  policy.dispose();
});

await test('query: 未登记 operation 直接拒绝（不做兜底投影）', () => {
  const policy = new FinanceOutputPolicy();
  expectCode(() => policy.wrapQuery('finance_query:enterprise_account.bank', { accountSetId: 5, value: {} }), 'output_policy_unknown_operation');
  expectCode(() => policy.wrapQuery('report.balance_sheet', { accountSetId: 5, value: {} }), 'output_policy_unknown_operation');
  assert.ok(M.SUPPORTED_OPERATIONS.query.includes('finance_query:report.balance_sheet'));
  assert.ok(!M.SUPPORTED_OPERATIONS.query.includes('finance_query:enterprise_account.bank'));
  policy.dispose();
});

// ================================================================ 2. 本机通道
await test('local: 合法通道可用同一引用取回原数据，模型 resolve 仍只得到同一份安全摘要', () => {
  const policy = new FinanceOutputPolicy();
  const channel = policy.issueChannel('local_ui');
  const envelope = policy.wrapQuery('finance_query:report.balance_sheet', { accountSetId: 5, value: rawBalanceSheet });
  const local = policy.localRead(envelope.localRef, {
    channel, accountSetId: 5, operation: 'finance_query:report.balance_sheet',
  });
  assert.equal(local.channel, 'local');
  assert.equal(local.value, rawBalanceSheet, '本机读取应返回同一原对象（不复制、不改写）');
  assert.equal(local.value.assets[0].name, X.accountName);
  assert.equal(local.value.liabilities[0].source, X.filePath);

  const resolved = policy.resolveForModel(envelope.localRef, {
    operation: 'finance_query:report.balance_sheet', accountSetId: 5,
  });
  assert.deepEqual(resolved.projection, envelope.projection);
  assert.equal(resolved.rawValuesIncluded, false);
  assertNoLeak(resolved, 'model resolve');
  policy.dispose();
});

await test('local: 伪造 channel（local=true / channel 字符串 / JSON 克隆对象）一律拒绝', () => {
  const policy = new FinanceOutputPolicy();
  const channel = policy.issueChannel('local_ui');
  const ref = policy.wrapQuery('finance_query:voucher.detail', { accountSetId: 5, value: rawCreatedVoucher }).localRef;

  expectCode(() => policy.localRead(ref, { accountSetId: 5 }), 'output_policy_channel_required');
  expectCode(() => policy.localRead(ref, { local: true, accountSetId: 5 }), 'output_policy_channel_untrusted');
  expectCode(() => policy.localRead(ref, { channel: 'local', accountSetId: 5 }), 'output_policy_channel_untrusted');
  expectCode(() => policy.localRead(ref, { channel: { channelId: 'localch_0000' }, accountSetId: 5 }), 'output_policy_channel_untrusted');
  expectCode(() => policy.localCompute(ref, { local: true, accountSetId: 5, op: 'count', path: 'entries' }), 'output_policy_channel_untrusted');
  expectCode(() => policy.localRead(ref, { channel: Object.freeze({ ...channel }), accountSetId: 5 }), 'output_policy_channel_untrusted');

  policy.releaseChannel(channel);
  expectCode(() => policy.localRead(ref, { channel, accountSetId: 5 }), 'output_policy_channel_revoked');
  assert.equal(policy.stats().channels, 0);
  policy.dispose();
});

await test('local: 本机读取必须显式给账套；跨账套引用一律拒绝（模型与本机都拒绝）', () => {
  const policy = new FinanceOutputPolicy();
  const channel = policy.issueChannel('local_ui');
  const ref = policy.wrapQuery('finance_query:report.balance_sheet', { accountSetId: 5, value: rawBalanceSheet }).localRef;

  expectCode(() => policy.localRead(ref, { channel }), 'output_policy_account_set_invalid');
  expectCode(() => policy.localRead(ref, { channel, accountSetId: 6 }), 'output_policy_ref_cross_account');
  expectCode(() => policy.localCompute(ref, { channel, accountSetId: 6, op: 'sum', path: 'totals.assets' }), 'output_policy_ref_cross_account');
  expectCode(() => policy.resolveForModel(ref, { accountSetId: 6 }), 'output_policy_ref_cross_account');
  expectCode(() => policy.localRead(ref, { channel, accountSetId: 'abc' }), 'output_policy_account_set_invalid');
  policy.dispose();
});

await test('local: 换工具解引用被拒绝（引用绑定工具/操作）', () => {
  const policy = new FinanceOutputPolicy();
  const channel = policy.issueChannel('local_ui');
  const envelope = policy.wrapQuery('finance_query:report.balance_sheet', { accountSetId: 5, value: rawBalanceSheet });

  expectCode(() => policy.localRead(envelope.localRef, { channel, accountSetId: 5, operation: 'finance_query:voucher.detail' }), 'output_policy_ref_binding_mismatch');
  expectCode(() => policy.resolveForModel(envelope.localRef, { accountSetId: 5, operation: 'finance_query:ledger.general' }), 'output_policy_ref_binding_mismatch');
  // 同名工具 + 正确账套 + 正确绑定仍必须再持有 channel：换一个工具拿不到原文。
  expectCode(() => policy.localRead(envelope.localRef, { accountSetId: 5, operation: 'finance_query:report.balance_sheet' }), 'output_policy_channel_required');
  policy.dispose();
});

await test('local: 伪造/畸形/已撤销引用与过期引用都取不到数据', () => {
  let clock = 1_700_000_000_000;
  const policy = new FinanceOutputPolicy({ now: () => clock, ttlMs: 60_000 });
  const channel = policy.issueChannel('local_ui');
  const ref = policy.wrapQuery('finance_query:voucher.detail', { accountSetId: 5, value: rawCreatedVoucher }).localRef;

  expectCode(() => policy.localRead('finref_' + 'a'.repeat(48), { channel, accountSetId: 5 }), 'output_policy_ref_unknown');
  expectCode(() => policy.localRead('finref_short', { channel, accountSetId: 5 }), 'output_policy_ref_invalid');
  expectCode(() => policy.localRead(42, { channel, accountSetId: 5 }), 'output_policy_ref_invalid');

  clock += 60_001; // 到期后再取
  expectCode(() => policy.localRead(ref, { channel, accountSetId: 5 }), 'output_policy_ref_expired');
  expectCode(() => policy.resolveForModel(ref), 'output_policy_ref_unknown');
  assert.equal(policy.stats().refs, 0);

  const ref2 = policy.wrapQuery('finance_query:voucher.detail', { accountSetId: 5, value: rawCreatedVoucher }).localRef;
  const revokeCtx = { channel, accountSetId: 5, operation: 'finance_query:voucher.detail' };
  assert.deepEqual(policy.revokeLocalRef(ref2, revokeCtx), { revoked: true, ref: ref2 });
  expectCode(() => policy.localRead(ref2, { channel, accountSetId: 5, operation: 'finance_query:voucher.detail' }), 'output_policy_ref_unknown');
  expectCode(() => policy.revokeLocalRef(ref2, revokeCtx), 'output_policy_ref_unknown');
  policy.dispose();
});

await test('local: 引用持有上限——查询失败即失败，写结果不因引用满而伪失败', () => {
  const policy = new FinanceOutputPolicy({ maxRefs: 2 });
  const channel = policy.issueChannel('local_ui');
  policy.wrapQuery('finance_query:voucher.detail', { accountSetId: 5, value: rawCreatedVoucher });
  policy.wrapQuery('finance_query:voucher.detail', { accountSetId: 5, value: rawCreatedVoucher });
  expectCode(
    () => policy.wrapQuery('finance_query:voucher.detail', { accountSetId: 5, value: rawCreatedVoucher }),
    'output_policy_ref_capacity_exceeded',
  );

  const write = policy.wrapWrite('voucher_create', { accountSetId: 5, value: rawCreatedVoucher });
  assert.equal(write.ok, true, '写已经发生，不能因为引用满就报失败');
  assert.equal(write.applied, true);
  assert.equal(write.localRef, null);
  assert.equal(write.refUnavailable, 'capacity');
  assert.deepEqual(write.projection.voucherId, 77);
  assert.equal(policy.stats().refs, 2);
  assert.equal(policy.localRead.length >= 0, true);
  policy.releaseChannel(channel);
  policy.dispose();
  expectCode(() => policy.wrapQuery('finance_query:voucher.detail', { accountSetId: 5, value: rawCreatedVoucher }), 'output_policy_disposed');
});

await test('local: 节点预算——批量持有超预算时查询失败、写只降级引用', () => {
  const policy = new FinanceOutputPolicy({ nodeBudget: 40 });
  policy.wrapQuery('finance_query:voucher.detail', { accountSetId: 5, value: rawCreatedVoucher });
  expectCode(
    () => policy.wrapQuery('finance_query:voucher.detail', { accountSetId: 5, value: rawCreatedVoucher }),
    'output_policy_ref_capacity_exceeded',
  );
  assert.equal(policy.stats().refs, 1, '唯一的引用仍保留，不因超预算被动丢弃');
  const write = policy.wrapWrite('voucher_create', { accountSetId: 5, value: rawCreatedVoucher });
  assert.equal(write.ok, true);
  assert.equal(write.applied, true);
  assert.equal(write.localRef, null);
  assert.equal(write.refUnavailable, 'node_budget');
  assert.equal(policy.stats().refs, 1);
  policy.dispose();
});

// ================================================================ 3. 本机算术
await test('local compute: sum/count/min/max 结果可独立手算核对，且只在本机通道', () => {
  const policy = new FinanceOutputPolicy();
  const channel = policy.issueChannel('local_ui');
  const ref = policy.wrapQuery('finance_query:voucher.detail', { accountSetId: 5, value: rawCreatedVoucher }).localRef;
  const compute = (op, path) => policy.localCompute(ref, {
    channel, accountSetId: 5, operation: 'finance_query:voucher.detail', op, path,
  });

  const sum = compute('sum', 'entries.[].debit'); // 100 + 0
  assert.deepEqual({ value: sum.value, matched: sum.matched, skipped: sum.skipped }, { value: 100, matched: 2, skipped: 0 });
  assert.deepEqual(compute('count', 'entries.[].credit').value, 2);
  assert.deepEqual(compute('max', 'entries.[].credit').value, 100);
  assert.deepEqual(compute('min', 'entries.[].debit').value, 0);
  assert.deepEqual(compute('sum', 'total_debit').value, 100);

  const empty = compute('sum', 'entries'); // 数组本身不是数值 → 跳过
  assert.equal(empty.value, null);
  assert.equal(empty.empty, true);
  assert.equal(empty.matched, 0);
  assert.equal(empty.skipped, 1);

  const bad = (extra) => () => policy.localCompute(ref, {
    channel, accountSetId: 5, operation: 'finance_query:voucher.detail', ...extra,
  });
  expectCode(bad({ op: 'avg', path: 'total_debit' }), 'output_policy_compute_op_invalid');
  expectCode(bad({ op: 'sum', path: '__proto__' }), 'output_policy_path_invalid');
  expectCode(bad({ op: 'sum', path: 'a.[].b.[].c' }), 'output_policy_path_invalid');
  expectCode(bad({ op: 'sum', path: '' }), 'output_policy_path_invalid');
  expectCode(bad({ op: 'sum', path: 'constructor.prototype' }), 'output_policy_path_invalid');
  policy.dispose();
});

// ================================================================ 4. 写动作
await test('write: 有正面证据才 applied=true，未验证结果不得伪成功', () => {
  const policy = new FinanceOutputPolicy();
  const ok = policy.wrapWrite('voucher_create', { accountSetId: 5, value: rawCreatedVoucher });
  assert.equal(ok.ok, true);
  assert.equal(ok.applied, true);
  assert.equal(ok.needsLocalReview, false);
  assert.deepEqual(ok.projection, {
    voucherId: 77, period: '2026-02', status: 'posted', lineCount: 2,
    totalDebit: 100, totalCredit: 100, balanced: true,
  });
  assertNoLeak(ok, 'write envelope');

  const bare = policy.wrapWrite('voucher_create', { accountSetId: 5, value: {} });
  assert.equal(bare.applied, 'unknown');
  assert.equal(bare.needsLocalReview, true);
  assert.equal(bare.appliedReason, 'unverified_result');

  const noId = policy.wrapWrite('voucher_post', { accountSetId: 5, value: { status: 'posted' } });
  assert.equal(noId.applied, 'unknown');
  assert.equal(noId.appliedReason, 'missing_voucher_id');

  const nothingDue = policy.wrapWrite('depreciation_run', { accountSetId: 5, value: { voucher: null, runs: [], note: X.note } });
  assert.equal(nothingDue.applied, false);
  assert.equal(nothingDue.appliedReason, 'nothing_due');
  assertNoLeak(nothingDue, 'depreciation envelope');

  const dryRun = policy.wrapWrite('legacy_book_import', {
    accountSetId: 5,
    value: { dryRun: true, validation: { ok: true, errors: [], warnings: [X.summary] }, created: null },
  });
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.appliedReason, 'dry_run');
  assert.equal(dryRun.projection.dryRun, true);
  assertNoLeak(dryRun, 'dry run envelope');

  const created = policy.wrapWrite('legacy_book_import', {
    accountSetId: 5,
    value: { dryRun: false, validation: { ok: true, errors: [], warnings: [] }, created: { id: 9, name: X.enterprise, start_period: '2026-01', accounts: 12, vouchers: 3 } },
  });
  assert.equal(created.applied, true);
  assert.deepEqual(created.projection, {
    dryRun: false, validationOk: true, blockedByValidation: false,
    createdAccountSetId: 9, createdAccountCount: 12, createdVoucherCount: 3, warningCount: 0,
  });
  assertNoLeak(created, 'import envelope');
  policy.dispose();
});

await test('write: runWrite 抛出时 applied=unknown + 安全错误，绝不报成功', () => {
  const policy = new FinanceOutputPolicy();
  let calls = 0;
  const failure = Object.assign(new Error(`记账失败：${X.enterprise} / ${X.accountName} / ${X.filePath}`), {
    code: 'voucher_invalid',
    details: { entries: [{ code: X.accountCode, summary: X.summary }] },
  });
  failure.stack = `Error: ${X.taxId}`;
  const envelope = policy.runWrite('voucher_create', {
    accountSetId: 5,
    execute: () => { calls++; throw failure; },
  });
  assert.equal(calls, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.applied, 'unknown');
  assert.equal(envelope.needsLocalReview, true);
  assert.equal(envelope.error.code, 'voucher_invalid');
  assert.equal(envelope.rawErrorIncluded, false);
  assertNoLeak(envelope, 'failed write envelope');
  assert.ok(!JSON.stringify(envelope).includes('stack'));
  assert.ok(!JSON.stringify(envelope).includes('details'));

  const ok = policy.runWrite('period_set_status', {
    accountSetId: 5,
    execute: () => ({ period: '2026-01', status: 'closed' }),
  });
  assert.equal(ok.applied, true);
  assert.deepEqual(ok.projection, { period: '2026-01', status: 'closed' });

  expectCode(() => policy.runWrite('period_set_status', { accountSetId: 5 }), 'output_policy_option_invalid');
  expectCode(() => policy.runWrite('period_close_all', { accountSetId: 5, execute: () => ({}) }), 'output_policy_unknown_operation');
  policy.dispose();
});

await test('write: 结果超量 / 形状超限时仍报真实 applied，只是没有本地引用', () => {
  const policy = new FinanceOutputPolicy({ valueNodes: 20 });
  const bigRuns = Array.from({ length: 60 }, (_, index) => ({ asset_id: index + 1, amount: 1 }));
  const envelope = policy.wrapWrite('depreciation_run', {
    accountSetId: 5,
    value: { voucher: { id: 88, period: '2026-02' }, runs: bigRuns },
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.applied, true, '写已经发生，超量不能反过来变成失败');
  assert.equal(envelope.localRef, null);
  assert.equal(envelope.refUnavailable, 'value_limit');
  assert.deepEqual(envelope.projection, { voucherId: 88, runCount: 60, totalAmount: 60, period: '2026-02' });
  assertNoLeak(envelope, 'degraded write envelope');
  policy.dispose();
});

// ================================================================ 5. 原始结果不变
await test('write/local: 包装与读取都不改写原始业务结果', () => {
  const policy = new FinanceOutputPolicy();
  const channel = policy.issueChannel('local_ui');
  const before = structuredClone(rawCreatedVoucher);
  const envelope = policy.wrapWrite('voucher_create', { accountSetId: 5, value: rawCreatedVoucher });
  const local = policy.localRead(envelope.localRef, {
    channel, accountSetId: 5, operation: 'voucher_create',
  });
  assert.equal(local.value, rawCreatedVoucher);
  assert.deepEqual(rawCreatedVoucher, before, '原始凭证结果不得被策略层改写');
  const rawListBefore = structuredClone(rawVoucherList);
  policy.wrapQuery('finance_query:voucher.generated.list', { accountSetId: 5, value: rawVoucherList });
  assert.deepEqual(rawVoucherList, rawListBefore);
  policy.dispose();
});

// ================================================================ 6. 错误安全投影
await test('error: message/details/stack 里的敏感原值一律不进安全投影', () => {
  const error = Object.assign(new Error(`科目 ${X.accountName}（${X.accountCode}）摘要 ${X.summary} 往来 ${X.counterparty} 人员 ${X.person} 文件 ${X.filePath}`), {
    code: 'account_not_found',
    details: { enterprise: X.enterprise, taxId: X.taxId },
  });
  error.stack = `Error: ${X.taxId}\n    at ${X.filePath}`;
  const safe = safeErrorProjection(error, { operation: 'voucher_create' });
  assert.deepEqual(safe, {
    ok: false,
    outputPolicy: M.OUTPUT_POLICY_VERSION,
    operation: 'voucher_create',
    error: { code: 'account_not_found', category: 'account', retriable: false, messageKey: 'account_not_found' },
    rawErrorIncluded: false,
  });
  assertNoLeak(safe, 'safe error');

  // 域错误常用 `new Error('xxx_code')`：只有命中固定 allowlist 才回声，其他一律 operation_failed。
  const plain = safeErrorProjection(new Error('period_closed'));
  assert.equal(plain.error.code, 'period_closed');
  const unknown = safeErrorProjection(Object.assign(new Error(X.enterprise), { code: X.accountCode }));
  assert.equal(unknown.error.code, 'operation_failed');
  assert.equal(unknown.error.category, 'unknown');
  assertNoLeak(unknown, 'unknown error');
  // 常见敏感文本不会被当成 code 回显
  assert.equal(safeErrorProjection(new Error('账户 100201 余额 12345.67')).error.code, 'operation_failed');
});

// ================================================================ 7. 形状 / 超量 / 循环 / 原型
await test('shape: projection 白名单拒绝自由文本、中文、深层嵌套、非标量数组', () => {
  const { value, dropped } = sanitizeProjection({
    total: 1234.567, ok: true, period: '2026-03', label: X.accountName, 名称: X.enterprise,
    deep: { a: { b: { c: 1 } } }, badKey: { 'x.y': 1 }, arr: [1, 2, 'ok_token'],
    mixedArr: [{ secret: X.summary }], huge: 1e15, nan: Number.NaN, big: 10n,
    fn: () => 1, when: new Date(), map: new Map(), ref: 'finref_demo',
  });
  assert.deepEqual(value, {
    total: 1234.57, ok: true, period: '2026-03',
    deep: { a: {} }, badKey: {}, arr: [1, 2, 'ok_token'], mixedArr: [], ref: 'finref_demo',
  });
  assert.ok(dropped >= 8, `应丢弃多项非法字段，实际 ${dropped}`);
  assertNoLeak(value, 'sanitized projection');
  expectCode(() => sanitizeProjection([1, 2, 3]), 'output_policy_projection_invalid');

  // 原型链上的值不参与投影：unknown fields deny 由自有键驱动。
  const inherited = sanitizeProjection(Object.create({ enterprise: X.enterprise, total: 5 }));
  assert.deepEqual(inherited.value, {});
  assertNoLeak(inherited.value, 'inherited projection');
});

await test('shape: 循环引用 / 访问器 / 类实例 / 超量原数据都被明确拒绝，不做 JSON.stringify', () => {
  const policy = new FinanceOutputPolicy({ valueNodes: 50 });
  const cyclic = { period: '2026-01', totals: {} };
  cyclic.totals.self = cyclic;
  expectCode(() => policy.wrapQuery('finance_query:report.trial_balance', { accountSetId: 5, value: cyclic }), 'output_policy_value_invalid');

  const accessor = { period: '2026-01', totals: {} };
  Object.defineProperty(accessor, 'totals', { enumerable: true, get() { throw new Error(X.enterprise); } });
  expectCode(() => policy.wrapQuery('finance_query:report.trial_balance', { accountSetId: 5, value: accessor }), 'output_policy_value_invalid');

  expectCode(
    () => policy.wrapQuery('finance_query:report.trial_balance', { accountSetId: 5, value: { period: '2026-01', when: new Date() } }),
    'output_policy_value_invalid',
  );
  expectCode(
    () => policy.wrapQuery('finance_query:report.trial_balance', { accountSetId: 5, value: Object.create({ enterprise: X.enterprise }) }),
    'output_policy_value_invalid',
  );
  expectCode(
    () => policy.wrapQuery('finance_query:voucher.generated.list', { accountSetId: 5, value: Array.from({ length: 6000 }, () => ({})) }),
    'output_policy_value_too_large',
  );
  // 节点预算可配置：超出即失败，不静默截断后假装成功。
  expectCode(
    () => policy.wrapQuery('finance_query:voucher.generated.list', {
      accountSetId: 5,
      value: Array.from({ length: 40 }, () => ({ entries: [{ debit: 1 }, { debit: 1 }] })),
    }),
    'output_policy_value_too_large',
  );
  assert.equal(measureRawValue({ a: [1, 2, { b: 3 }] }, 100) > 0, true);
  policy.dispose();
});

await test('input: accountSetId 必须是正整数（不猜默认账套）', () => {
  const policy = new FinanceOutputPolicy();
  for (const bad of [undefined, null, '', 0, -1, 1.5, 'abc', {}, []]) {
    expectCode(() => policy.wrapQuery('finance_query:report.balance_sheet', { accountSetId: bad, value: rawBalanceSheet }), 'output_policy_account_set_invalid');
  }
  const ok = policy.wrapQuery('finance_query:report.balance_sheet', { accountSetId: '5', value: rawBalanceSheet });
  assert.equal(ok.accountSetId, 5);
  policy.dispose();
});

// ================================================================ 8. 契约可见性
await test('contract: 模块暴露的契约与限制是显式的（供后续接线核对）', () => {
  assert.equal(M.OUTPUT_POLICY_VERSION, 'finance-output-policy/v1');
  assert.equal(M.REF_PERSISTENCE, 'process_memory');
  assert.equal(M.MODEL_OUTPUT_CONTRACT.modelChannel.unknownFields, 'deny');
  assert.equal(M.MODEL_OUTPUT_CONTRACT.localChannel.channelFromModelArgs, 'rejected');
  assert.deepEqual(M.MODEL_OUTPUT_CONTRACT.localChannel.arithmetic, ['sum', 'count', 'min', 'max']);
  assert.ok(M.MODEL_OUTPUT_CONTRACT.modelChannel.neverReturned.includes('voucher_line'));
  assert.ok(M.SUPPORTED_OPERATIONS.write.includes('voucher_create'));
  assert.ok(!M.SUPPORTED_OPERATIONS.write.includes('voucher_approve'));
  const policy = new FinanceOutputPolicy();
  const stats = policy.stats();
  assert.deepEqual(stats, {
    refs: 0, channels: 0, maxRefs: 256, ttlMs: 15 * 60 * 1000,
    nodes: 0, nodeBudget: 1000000, bytes: 0, byteBudget: 64 * 1024 * 1024,
    persistence: 'process_memory',
  });
  assert.ok(M.MODEL_OUTPUT_CONTRACT.modelChannel.operationMustBeRegisteredString === true);
  assert.deepEqual(M.MODEL_OUTPUT_CONTRACT.ref.callRequires, ['accountSetId', 'operation']);
  expectCode(() => new FinanceOutputPolicy({ ttlMs: 0 }), 'output_policy_option_invalid');
  expectCode(() => policy.issueChannel('Local UI'), 'output_policy_channel_untrusted');
  policy.dispose();
});

// ================================================================ 9. 独立审查回归（LOCAL-08 review1）
// 每条都很直接地重规审查发现的问题；预期值是手写常量，不从实现反推。
await test('review1: operation 必须是已登记的原始字符串，带 toString 的对象不进查表也不进信封', () => {
  const policy = new FinanceOutputPolicy();
  let toStringCalls = 0;
  const hostileOp = {
    toString() { toStringCalls++; return 'voucher_create'; },
    valueOf() { toStringCalls++; return 'voucher_create'; },
    enterprise: X.enterprise,
    details: { path: X.filePath },
  };

  // 写通道 / 查询通道 / runWrite：均在读取值或执行回调前拒绝，且不调用 toString
  expectCode(() => policy.wrapWrite(hostileOp, { accountSetId: 5, value: rawCreatedVoucher }), 'output_policy_unknown_operation');
  expectCode(() => policy.wrapQuery(hostileOp, { accountSetId: 5, value: rawBalanceSheet }), 'output_policy_unknown_operation');
  let calls = 0;
  expectCode(() => policy.runWrite(hostileOp, { accountSetId: 5, execute: () => { calls++; return {}; } }), 'output_policy_unknown_operation');
  assert.equal(toStringCalls, 0, '查表 / 转换阶段不得执行用户 toString');
  assert.equal(calls, 0, '未登记 operation 不得先执行写回调');

  // 字符串对象、Symbol 等“看起来像 operation”的值同样拒绝
  expectCode(() => policy.wrapQuery(new String('finance_query:report.balance_sheet'), { accountSetId: 5, value: rawBalanceSheet }), 'output_policy_unknown_operation');
  expectCode(() => policy.wrapWrite(Symbol('voucher_create'), { accountSetId: 5, value: rawCreatedVoucher }), 'output_policy_unknown_operation');

  // 拒绝时错误对象本身不得携带对象属性里的敏感标记
  let thrown = null;
  try { policy.wrapWrite(hostileOp, { accountSetId: 5, value: rawCreatedVoucher }); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof OutputPolicyError);
  assertNoLeak({ code: thrown.code, message: thrown.message, details: thrown.details }, 'unknown operation error');

  // 合法调用的信封里 operation 只能是登记的常量字符串
  const envelope = policy.wrapWrite('voucher_create', { accountSetId: 5, value: rawCreatedVoucher });
  assert.equal(typeof envelope.operation, 'string');
  assert.equal(envelope.operation, 'voucher_create');
  assert.ok(M.SUPPORTED_OPERATIONS.write.includes(envelope.operation));
  assertNoLeak(envelope, 'write envelope operation');
  policy.dispose();
});

await test('review1: 预校验先于写执行：未登记 / 错账套 / 缺回调时回调从未执行（负例）', () => {
  const policy = new FinanceOutputPolicy();
  let calls = 0;
  const execute = () => { calls++; return { id: 9, status: 'posted', entries: [{ debit: 1, credit: 0 }] }; };

  expectCode(() => policy.runWrite('unregistered_write', { accountSetId: 5, execute }), 'output_policy_unknown_operation');
  assert.equal(calls, 0);
  expectCode(() => policy.runWrite('voucher_create', { accountSetId: 0, execute }), 'output_policy_account_set_invalid');
  assert.equal(calls, 0);
  expectCode(() => policy.runWrite('voucher_create', { accountSetId: 'abc', execute }), 'output_policy_account_set_invalid');
  assert.equal(calls, 0);
  expectCode(() => policy.runWrite('voucher_create', { accountSetId: 5 }), 'output_policy_option_invalid');
  assert.equal(calls, 0);

  // 正例：同一回调在合法调用下确实执行一次（避免“永不执行”也能通过）
  const ok = policy.runWrite('voucher_create', { accountSetId: 5, execute });
  assert.equal(calls, 1);
  assert.equal(ok.ok, true);
  assert.equal(ok.applied, true);
  assert.equal(ok.projection.voucherId, 9);
  policy.dispose();
});

await test('review1: 访问器 / 恶意对象不会在摘要阶段触发 getter，写后失败仍给安全信封与可证实 applied', () => {
  const policy = new FinanceOutputPolicy();

  // 审查复现：enumerable 的索引 getter（抛错且 message 带合成标记）
  const entries = [];
  Object.defineProperty(entries, 0, {
    enumerable: true,
    get() { throw new Error('synthetic_sensitive_summary'); },
  });
  const value = { id: 9, status: 'posted', period: '2026-02', entries };

  let calls = 0;
  const envelope = policy.runWrite('voucher_create', { accountSetId: 5, execute: () => { calls++; return value; } });
  assert.equal(calls, 1, '回调确实执行了一次');
  assert.equal(envelope.ok, true, '写已发生，形状非法不能反转为业务失败');
  assert.equal(envelope.applied, true, 'applied 来自自有 data 属性 id + status（正面证据）');
  assert.equal(envelope.needsLocalReview, false);
  assert.equal(envelope.localRef, null);
  assert.equal(envelope.refUnavailable, 'value_invalid');
  assert.deepEqual(envelope.projection, {});
  assert.ok(!JSON.stringify(envelope).includes('synthetic_sensitive_summary'), 'getter 抛出的原文不得进信封');
  assert.ok(!JSON.stringify(envelope).includes('stack'));
  assertNoLeak(envelope, 'accessor write envelope');

  // 查询通道：同一数据明确拒绝（不是返回部分摘要）
  expectCode(() => policy.wrapQuery('finance_query:voucher.detail', { accountSetId: 5, value }), 'output_policy_value_invalid');

  // 连证据字段都是访问器 → applied 只能是 unknown（不能伪成功）
  const statusOnlyGetter = { id: 9, period: '2026-02', entries: [] };
  Object.defineProperty(statusOnlyGetter, 'status', {
    enumerable: true,
    get() { throw new Error('synthetic_sensitive_status'); },
  });
  const unknown = policy.wrapWrite('voucher_create', { accountSetId: 5, value: statusOnlyGetter });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.applied, 'unknown');
  assert.equal(unknown.needsLocalReview, true);
  assert.equal(unknown.appliedReason, 'unverified_result');
  assert.equal(unknown.localRef, null);
  assert.equal(unknown.refUnavailable, 'value_invalid');
  assert.ok(!JSON.stringify(unknown).includes('synthetic_sensitive_status'));
  assertNoLeak(unknown, 'accessor evidence envelope');

  // 超量数组：写后摘要失败也只能降级，并保持真实 applied
  const huge = { id: 9, status: 'posted', entries: Array.from({ length: 5001 }, () => ({ debit: 1, credit: 0 })) };
  const degraded = policy.wrapWrite('voucher_create', { accountSetId: 5, value: huge });
  assert.equal(degraded.ok, true);
  assert.equal(degraded.applied, true);
  assert.equal(degraded.localRef, null);
  assert.equal(degraded.refUnavailable, 'value_limit');
  policy.dispose();
});

await test('review1: 字节预算——单个大字符串与累计持有都受限，撤销 / 过期后扣除', () => {
  const longText = '合成长文本'.repeat(20); // 5 个汉字 × 3 B × 20 = 300 B
  assert.equal(Buffer.byteLength(longText, 'utf8'), 300);
  const small = {
    period: '2026-01',
    lines: [],
    totals: {
      opening_debit: 0, opening_credit: 0, period_debit: 0, period_credit: 0,
      closing_debit: 0, closing_credit: 0,
    },
    note: longText,
  }; // 节点很少，字节很多

  // （1）单值字节上限：节点预算把不住，必须靠字节预算
  expectCode(
    () => new FinanceOutputPolicy({ valueBytes: 200 }).wrapQuery('finance_query:report.trial_balance', { accountSetId: 5, value: small }),
    'output_policy_value_too_large',
  );
  // 宽字节预算下同样的值能通过（证明上一条不是别的限制引起的）
  const permissive = new FinanceOutputPolicy({ valueBytes: 4096 });
  assert.equal(permissive.wrapQuery('finance_query:report.trial_balance', { accountSetId: 5, value: small }).ok, true);
  permissive.dispose();

  // （2）写结果超单值字节：降级但不伪失败
  const writeByte = new FinanceOutputPolicy({ valueBytes: 200 }).wrapWrite('voucher_create', {
    accountSetId: 5,
    value: { id: 9, status: 'posted', entries: [{ debit: 1, credit: 0, summary: longText }] },
  });
  assert.equal(writeByte.ok, true);
  assert.equal(writeByte.applied, true);
  assert.equal(writeByte.localRef, null);
  assert.equal(writeByte.refUnavailable, 'value_limit');
  assert.equal(writeByte.projection.voucherId, 9);

  // （3）累计字节预算：用“实测单值占用”定预算，避免镜像实现的字节公式
  const probe = new FinanceOutputPolicy();
  probe.wrapQuery('finance_query:report.trial_balance', { accountSetId: 5, value: small });
  const perValueBytes = probe.stats().bytes;
  assert.ok(perValueBytes > 300, `单值应至少计入字符串字节，实测 ${perValueBytes}`);
  probe.dispose();

  let clock = 1_700_000_000_000;
  const policy = new FinanceOutputPolicy({ byteBudget: perValueBytes + 16, now: () => clock, ttlMs: 60_000 });
  const channel = policy.issueChannel('local_ui');
  const operation = 'finance_query:report.trial_balance';
  const first = policy.wrapQuery(operation, { accountSetId: 5, value: small });
  assert.equal(policy.stats().bytes, perValueBytes);

  // 第二个同尺寸引用超累计字节预算 → 查询拒绝
  expectCode(() => policy.wrapQuery(operation, { accountSetId: 5, value: small }), 'output_policy_ref_capacity_exceeded');
  // 写结果同条件 → 只降级引用
  const writeByteBudget = policy.wrapWrite('voucher_create', {
    accountSetId: 5,
    value: { id: 9, status: 'posted', entries: [{ debit: 1, credit: 0, summary: longText }] },
  });
  assert.equal(writeByteBudget.ok, true);
  assert.equal(writeByteBudget.applied, true);
  assert.equal(writeByteBudget.localRef, null);
  assert.equal(writeByteBudget.refUnavailable, 'byte_budget');
  assert.equal(policy.stats().bytes, perValueBytes, '失败的写不得改变已有占用');

  // 撤销后字节预算立即释放，同一操作可再次持有
  policy.revokeLocalRef(first.localRef, { channel, accountSetId: 5, operation });
  assert.equal(policy.stats().bytes, 0);
  const again = policy.wrapQuery(operation, { accountSetId: 5, value: small });
  assert.equal(policy.stats().refs, 1);

  // 过期清理后同样扣除；节点预算也不因到期残留
  clock += 60_001;
  assert.deepEqual({ refs: policy.stats().refs, bytes: policy.stats().bytes, nodes: policy.stats().nodes }, { refs: 0, bytes: 0, nodes: 0 });
  assert.ok(again.localRef.length > 0);
  policy.releaseChannel(channel);
  policy.dispose();
});

await test('review1: 所有引用调用统一要求显式 accountSetId + operation（不存在缺省账套）', () => {
  const policy = new FinanceOutputPolicy();
  const channel = policy.issueChannel('local_ui');
  const operation = 'finance_query:report.balance_sheet';
  const ref = policy.wrapQuery(operation, { accountSetId: 5, value: rawBalanceSheet }).localRef;

  // resolveForModel：缺账套 / 缺 operation / 跨账套 / 换工具全部拒绝
  expectCode(() => policy.resolveForModel(ref), 'output_policy_account_set_invalid');
  expectCode(() => policy.resolveForModel(ref, { accountSetId: 5 }), 'output_policy_operation_required');
  expectCode(() => policy.resolveForModel(ref, { accountSetId: 6, operation }), 'output_policy_ref_cross_account');
  expectCode(() => policy.resolveForModel(ref, { accountSetId: 5, operation: 'finance_query:voucher.detail' }), 'output_policy_ref_binding_mismatch');
  let coerced = 0;
  const fakeOp = { toString() { coerced++; return operation; } };
  expectCode(() => policy.resolveForModel(ref, { accountSetId: 5, operation: fakeOp }), 'output_policy_ref_binding_mismatch');
  assert.equal(coerced, 0, 'operation 比较不得触发 toString');

  // localRead / localCompute / revokeLocalRef 同一契约
  expectCode(() => policy.localRead(ref, { channel }), 'output_policy_account_set_invalid');
  expectCode(() => policy.localRead(ref, { channel, accountSetId: 5 }), 'output_policy_operation_required');
  expectCode(() => policy.localCompute(ref, { channel, accountSetId: 5, op: 'sum', path: 'assets' }), 'output_policy_operation_required');
  expectCode(() => policy.revokeLocalRef(ref, { channel, accountSetId: 5 }), 'output_policy_operation_required');
  expectCode(() => policy.revokeLocalRef(ref, { channel, accountSetId: 6, operation }), 'output_policy_ref_cross_account');
  expectCode(() => policy.revokeLocalRef(ref, { channel, accountSetId: 5, operation: 'voucher_create' }), 'output_policy_ref_binding_mismatch');
  expectCode(() => policy.revokeLocalRef(ref, { accountSetId: 5, operation }), 'output_policy_channel_required');

  // 正确上下文仍可解引用 / 撤销（证明不是一律拒绝）
  assert.equal(policy.resolveForModel(ref, { accountSetId: 5, operation }).ok, true);
  assert.deepEqual(policy.revokeLocalRef(ref, { channel, accountSetId: 5, operation }), { revoked: true, ref });

  // 每个已登记 operation 都要求显式账套：本模块没有“全局工具 / 默认账套”路径
  for (const op of M.SUPPORTED_OPERATIONS.query) {
    expectCode(() => policy.wrapQuery(op, { value: {} }), 'output_policy_account_set_invalid');
  }
  for (const op of M.SUPPORTED_OPERATIONS.write) {
    expectCode(() => policy.wrapWrite(op, { value: {} }), 'output_policy_account_set_invalid');
  }
  assert.deepEqual(M.MODEL_OUTPUT_CONTRACT.localChannel.requiresExplicitAccountSetId, true);
  assert.deepEqual(M.MODEL_OUTPUT_CONTRACT.localChannel.requiresExplicitOperation, true);

  // issueChannel 只接受本机代码给的小写标签：模型形状的输入拿不到任何能力
  expectCode(() => policy.issueChannel({ channelId: 'localch_forged', label: 'local_ui' }), 'output_policy_channel_untrusted');
  expectCode(() => policy.issueChannel('localch_' + 'a'.repeat(32)), 'output_policy_channel_untrusted');
  assert.deepEqual(policy.releaseChannel({ channelId: 'localch_forged' }), { released: false });
  policy.dispose();
});

await test('review1: Proxy 陷阱无法完全避免触发，但失败必须是安全拒绝（原始异常不出模型通道）', () => {
  const policy = new FinanceOutputPolicy();
  const hostileProxy = new Proxy({ period: '2026-01' }, {
    ownKeys() { throw new Error('synthetic_sensitive_proxy'); },
    getOwnPropertyDescriptor() { throw new Error('synthetic_sensitive_proxy'); },
  });
  expectCode(
    () => policy.wrapQuery('finance_query:report.trial_balance', { accountSetId: 5, value: hostileProxy }),
    'output_policy_value_invalid',
  );
  const envelope = policy.wrapWrite('voucher_create', { accountSetId: 5, value: hostileProxy });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.applied, 'unknown');
  assert.equal(envelope.needsLocalReview, true);
  assert.equal(envelope.localRef, null);
  assert.deepEqual(envelope.projection, {});
  assert.ok(!JSON.stringify(envelope).includes('synthetic_sensitive_proxy'));
  assertNoLeak(envelope, 'proxy write envelope');
  policy.dispose();
});

await test('adapter-prep: project 数组同时接受状态 token 与期间，自由文本仍被丢弃', () => {
  const { value, dropped } = sanitizeProjection({
    periods: ['2026-01', 'ok_token', X.summary, 12, true],
    labels: [X.enterprise, X.accountName, '2026-13'],
  });
  assert.deepEqual(value, { periods: ['2026-01', 'ok_token', 12, true], labels: [] });
  assert.equal(dropped, 4);
  assertNoLeak(value, 'period/token array projection');
});

await test('adapter-prep: 普通工具 DTO spec 存在，无引用摘要只回白名单字段且不泄漏原值', () => {
  const { summarizeQueryResult, summarizeWriteResult } = M;
  assert.ok(M.SUPPORTED_OPERATIONS.query.includes('account_list'));
  assert.ok(M.SUPPORTED_OPERATIONS.query.includes('book_import_batch'));
  assert.ok(M.SUPPORTED_OPERATIONS.write.includes('book_import_incremental'));

  const accounts = summarizeQueryResult('account_list', {
    accountSetId: 5,
    items: [
      { code: X.accountCode, name: X.accountName, category: '资产', direction: 'debit', is_leaf: 1, contra: 0 },
      { code: '1602', name: '累计折旧', category: '资产', direction: 'credit', is_leaf: 1, contra: 1 },
    ],
  });
  assert.deepEqual(accounts.projection, {
    accountCount: 2, leafCount: 2, contraCount: 1,
    byCategory: { assets: 2, liabilities: 0, equity: 0, cost: 0, profit_loss: 0 },
  });
  assert.equal(accounts.summaryUnavailable, false);
  assertNoLeak(accounts.projection, 'account_list projection');

  const batch = summarizeQueryResult('book_import_batch', {
    batch: { id: X.taxId, status: 'completed', mode: 'create', accountSetId: 9, result: { accountSetCreated: false, vouchersCreated: 2, vouchersDeduplicated: 0 } },
    source: { system: X.person, enterpriseKey: X.taxId },
    sourceTrace: [{ sourceVoucherId: X.taxId, voucherId: 31, state: 'ok' }, { state: 'inconsistent' }],
    voucherCount: 2,
  });
  assert.deepEqual(batch.projection, {
    batchStatus: 'completed', batchMode: 'create', accountSetId: 9, traceCount: 2, okTraceCount: 1,
    inconsistentTraceCount: 1, voucherCount: 2, accountSetCreated: false, vouchersCreated: 2,
    vouchersDeduplicated: 0,
  });
  assertNoLeak(batch.projection, 'book_import_batch projection');

  const preview = summarizeWriteResult('book_import_incremental', {
    status: 'preview', accountSetId: null, validation: { ok: true },
    conflicts: [{ code: 'x', message: X.summary }], errors: [],
    planned: { accountSetCreated: true, vouchersToCreate: ['a', 'b'], vouchersDeduplicated: ['c'] },
    source: { enterpriseKey: X.taxId, enterpriseName: X.enterprise }, batch: { id: X.taxId },
  });
  assert.equal(preview.applied, false);
  assert.equal(preview.appliedReason, 'dry_run');
  assert.equal(preview.needsLocalReview, true);
  assert.equal(preview.projection.status, 'preview');
  assert.equal(preview.projection.plannedVouchers, 2);
  assert.equal(preview.projection.plannedVouchersDeduplicated, 1);
  assert.equal(preview.projection.conflictCount, 1);
  assertNoLeak({ ...preview, projection: preview.projection }, 'incremental projection');

  const applied = summarizeWriteResult('book_import_incremental', {
    status: 'applied', created: { accountSetId: 11, accountSetCreated: true, vouchersCreated: 1 },
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.projection.accountSetId, 11);

  expectCode(() => summarizeQueryResult('finance_query:enterprise_account.bank', {}), 'output_policy_unknown_operation');
});

await test('adapter-prep: 共享引用（DAG）是合法 DTO，不算循环；真循环仍拒绝', () => {
  const shared = { rows: [{ amount: 1 }] };
  const dag = { created: { sourceTrace: shared.rows }, sourceTrace: shared.rows };
  const { nodes, bytes } = M.inspectRawValue(dag, 1000, 1_000_000);
  assert.ok(nodes >= 4 && bytes > 0);
  const policy = new FinanceOutputPolicy();
  const envelope = policy.wrapWrite('legacy_book_import', {
    accountSetId: 5,
    value: { dryRun: false, validation: { ok: true, errors: [], warnings: [] }, created: { id: 9, sourceTrace: shared.rows }, sourceTrace: shared.rows },
  });
  assert.equal(envelope.applied, true);
  assert.match(envelope.localRef, /^finref_/);
  assert.equal(envelope.projection.createdAccountSetId, 9);
  policy.dispose();

  const cyclic = { created: {} };
  cyclic.created.self = cyclic;
  expectCode(() => M.inspectRawValue(cyclic), 'output_policy_value_invalid');
});

await test('review3 F2: 投影期间 / 状态按固定值域（自由 ASCII 不当 token），真 0 保留', () => {
  const { summarizeQueryResult } = M;
  const income = (period) => ({
    period,
    current: { 营业收入: 0, 营业成本: 0, 销售费用: 0, 管理费用: 0, 财务费用: 0, 利润总额: 0, 净利润: 0 },
    ytd: { 营业收入: 0, 净利润: 0 },
  });

  const ok = summarizeQueryResult('finance_query:report.income_statement', income('2026-01'));
  assert.equal(ok.summaryUnavailable, false);
  assert.equal(ok.projection.period, '2026-01');
  assert.equal(ok.projection.currentRevenue, 0, '真实 0 必须保留');
  assert.equal(ok.projection.ytdNetProfit, 0);

  // 自由 ASCII / 非法月份都不算期间
  for (const bad of ['synthetic_sensitive_period', '2026-13', '2026-1', '2026-00']) {
    const broken = summarizeQueryResult('finance_query:report.income_statement', income(bad));
    assert.equal(broken.summaryUnavailable, true, `period=${bad} 应失败`);
    assert.deepEqual(broken.projection, {});
  }
  expectCode(
    () => new FinanceOutputPolicy().wrapQuery('finance_query:report.income_statement', {
      accountSetId: 5, value: income('synthetic_sensitive_period'),
    }),
    'output_policy_value_invalid',
  );

  // 凭证状态 / 期间状态 / 科目分类 / 资产种类 / 方向：未登记值一律失败
  const detail = (status) => ({ id: 7, period: '2026-01', status, entries: [{ debit: 1, credit: 1 }] });
  assert.equal(summarizeQueryResult('finance_query:voucher.detail', detail('posted')).summaryUnavailable, false);
  assert.equal(summarizeQueryResult('finance_query:voucher.detail', detail('synthetic_sensitive_status')).summaryUnavailable, true);
  assert.equal(summarizeQueryResult('finance_query:voucher.detail', detail('open')).summaryUnavailable, true, '凭证状态不接受期间状态');
  assert.equal(summarizeQueryResult('finance_query:voucher.detail', { ...detail('posted'), period: 'synthetic_sensitive_period' }).summaryUnavailable, true);

  const periodEnd = (status) => ({
    periods: [{ period: '2026-01', status }],
    trial_balance: { period: '2026-01', totals: { closing_debit: 0, closing_credit: 0 } },
  });
  assert.equal(summarizeQueryResult('finance_query:period_end.summary', periodEnd('open')).summaryUnavailable, false);
  assert.equal(summarizeQueryResult('finance_query:period_end.summary', periodEnd('synthetic_sensitive_status')).summaryUnavailable, true);
  assert.equal(summarizeQueryResult('finance_query:period_end.summary', periodEnd('posted')).summaryUnavailable, true, '期间状态不接受凭证状态');

  const ledger = (direction) => ({
    period: '2026-01', direction, opening: { debit: 0, credit: 0 }, items: [],
  });
  assert.equal(summarizeQueryResult('finance_query:ledger.general', ledger('debit')).summaryUnavailable, false);
  assert.equal(summarizeQueryResult('finance_query:ledger.general', ledger('synthetic_sensitive_direction')).summaryUnavailable, true);

  const accounts = (category) => summarizeQueryResult('account_list', {
    items: [{ code: '1001', name: 'x', category, is_leaf: 1, contra: 0 }],
  });
  assert.equal(accounts('资产').summaryUnavailable, false);
  assert.equal(accounts('synthetic_sensitive_category').summaryUnavailable, true);

  const cards = (kind) => summarizeQueryResult('asset_list', [{
    kind, original_cost: 0, accumulated: 0, remaining: 0,
  }]);
  assert.equal(cards('intangible').summaryUnavailable, false);
  assert.equal(cards('synthetic_sensitive_kind').summaryUnavailable, true);

  // 批次审计：追溯状态按固定域，非 ok 计入需复核（不再静默漏计）
  const batch = (state) => ({
    batch: {
      status: 'completed', mode: 'create', accountSetId: 9,
      result: { accountSetCreated: false, vouchersCreated: 1, vouchersDeduplicated: 0 },
    },
    sourceTrace: [{ state }],
    voucherCount: 1,
  });
  const missing = summarizeQueryResult('book_import_batch', batch('missing'));
  assert.equal(missing.summaryUnavailable, false);
  assert.equal(missing.projection.okTraceCount, 0);
  assert.equal(missing.projection.inconsistentTraceCount, 1, '非 ok 状态必须计入需复核');
  assert.equal(summarizeQueryResult('book_import_batch', batch('synthetic_sensitive_state')).summaryUnavailable, true);
  assert.equal(summarizeQueryResult('book_import_batch', {
    ...batch('ok'), batch: { ...batch('ok').batch, status: 'synthetic_sensitive_status' },
  }).summaryUnavailable, true);
});

console.log(`\nFinance output policy acceptance: ${results.filter(Boolean).length}/${results.length} passed`);
if (results.some((passed) => !passed)) process.exitCode = 1;
