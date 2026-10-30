// 仅使用合成账簿。下方年度预期金额为手算结果；
// 此套件验证证据适配，不验证尚缺的税费/Harness 业务工作。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tempBase = resolve(tmpdir());
const root = mkdtempSync(join(tempBase, 'annual-close-synthetic-'));
const dataDir = join(root, 'data');
mkdirSync(dataDir);
process.env.WORKBENCH_DATA_DIR = dataDir;
// 现有审计/备份保护要求使用普通、非别名临时路径。
process.env.TMP = root; process.env.TEMP = root;
let db, failures = 0, passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
}
const e = (code, debit = 0, credit = 0) => ({ code, debit, credit });
try {
  const { createAnnualCloseAdapter, compareAnnualCloseReviews } = await import('../server/annual-close.mjs');
  await test('importing the annual adapter creates no database or default data directory', () => {
    assert.equal(existsSync(join(dataDir, 'workbench.db')), false);
  });
  ({ db } = await import('../server/db.mjs'));
  const A = await import('../server/accounting.mjs');
  const { buildReportExport } = await import('../server/report-export.mjs');
  const adapter = createAnnualCloseAdapter({ db, buildReportExport, periodEndCheck: A.periodEndCheck });
  const make = (key, start = '2025-12') => A.createAccountSet({ name: '合成年度公司', start_period: start, profileId: 'small-2011-basic-v1', enterprise: { enterpriseKey: key } }).id;
  const voucher = (id, period, entries) => A.createVoucher(id, { period, voucher_date: `${period}-15`, status: 'posted', entries });
  const id = make('SYNTHETIC-ANNUAL-A');
  A.setOpeningBalances(id, [e('1002', 1000), e('3001', 0, 1000)]);
  voucher(id, '2025-12', [e('1002', 200), e('5001', 0, 200)]);
  voucher(id, '2025-12', [e('5602', 40), e('1002', 0, 40)]);
  A.carryForwardProfit(id, '2025-12', { yearEnd: true });
  const annualVoucherIds = [];
  for (let m = 1; m <= 12; m++) {
    const period = `2026-${String(m).padStart(2, '0')}`;
    annualVoucherIds.push(voucher(id, period, [e('1002', 100 * m), e('5001', 0, 100 * m)]).id);
    voucher(id, period, [e('5602', 10 * m), e('1002', 0, 10 * m)]);
  }
  A.setPeriodStatus(id, '2027-01', 'open');
  const scope = { accountSetId: id, enterpriseKey: 'SYNTHETIC-ANNUAL-A', year: '2026' };
  let original;
  await test('normal full year and history use actual annual reports with independent expected amounts', () => {
    original = adapter.inspect(scope);
    // 以前期初 1000 + 200 - 40 = 1160。全年销售额=100*(1+...+12)=7800，
    // 费用=10*78=780，全年净额=7020；最终银行余额=1160+7020=8180。
    assert.equal(original.annualNumbers.incomeStatementYtd['营业利润'], 7020);
    assert.equal(original.reports['income-statement'].data.current['营业利润'], 1080);
    assert.equal(original.annualNumbers.cashFlowYtd.cash.begin, 1160);
    assert.equal(original.annualNumbers.cashFlowYtd.cash.end, 8180);
    assert.equal(original.annualNumbers.cashFlowYtd.totals.net_increase, 7020);
    assert.deepEqual(original.coverage.missingLedgerPeriods, []);
    assert.ok(original.ledgerEvidence.priorVoucherCount >= 2);
    assert.equal(original.periodChecks.length, 12);
    assert.equal(original.nextYear.status, 'ledger_balances_tie');
    assert.equal(original.nextYear.lines.find(r => r.code === '1002').opening.debit, 8180);
    assert.match(original.codeEvidence.codeDigest, /^[a-f0-9]{64}$/);
  });
  await test('unverified sources and business/tax/review dependencies prevent claiming annual completion', () => {
    assert.equal(original.annualComplete, false);
    assert.equal(original.accountantApproval, 'pending');
    assert.equal(original.authorizesExecution, false);
    assert.equal(original.incomeTaxSettlement.result, null);
    assert.equal(original.coverage.annualMaterials, 'unverified');
    assert.ok(original.reports['income-statement'].warnings.some(w => w.code === 'completeness_unverified'));
    assert.ok(original.ledgerEvidence.completeness.vouchersWithoutRegisteredSource.length > 0);
    assert.ok(original.pending.some(p => p.code === 'annual_adjustment_and_tax_dependency'));
    assert.ok(original.planHints.find(p => p.taskId === 'annual.inventory').applicability === 'enterprise_fact_required');
  });
  await test('repeated inspection is read-only, stable and never duplicates posting', () => {
    const count = db.prepare('SELECT COUNT(*) n FROM vouchers').get().n;
    const again = adapter.inspect(scope);
    assert.equal(again.contentDigest, original.contentDigest);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n, count);
    assert.equal(adapter.validate({ ...scope, expectedDigest: original.contentDigest }).status, 'current');
  });
  await test('missing periods and late-start evidence remain explicit, then filling ledger coverage changes the version', () => {
    const partialId = make('SYNTHETIC-ANNUAL-LATE', '2026-07');
    voucher(partialId, '2026-12', [e('1002', 200), e('5001', 0, 200)]);
    const partialScope = { accountSetId: partialId, enterpriseKey: 'SYNTHETIC-ANNUAL-LATE', year: '2026' };
    const before = adapter.inspect(partialScope);
    assert.equal(before.coverage.missingLedgerPeriods.length, 10);
    assert.ok(before.reports['income-statement'].warnings.some(w => w.code === 'partial_year'));
    assert.equal(before.coverage.priorHistory, 'unverified');
    assert.equal(before.coverage.legalExistenceRange, 'enterprise_fact_required');
    A.setPeriodStatus(partialId, '2026-08', 'open');
    const after = adapter.inspect(partialScope);
    assert.equal(after.coverage.missingLedgerPeriods.length, 9);
    assert.equal(after.coverage.annualMaterials, 'unverified');
    assert.equal(adapter.validate({ ...partialScope, expectedDigest: before.contentDigest }).status, 'stale');
  });
  await test('posted correction invalidates old evidence and reports actual before/after differences without reposting', () => {
    // 额外一笔受支持的更正分录产生费用 20：全年利润=7000，
    // 银行期末/次年期初=8160。只读适配器不进行记账。
    voucher(id, '2026-12', [e('5602', 20), e('1002', 0, 20)]);
    const count = db.prepare('SELECT COUNT(*) n FROM vouchers').get().n;
    const current = adapter.inspect(scope);
    assert.equal(current.annualNumbers.incomeStatementYtd['营业利润'], 7000);
    assert.equal(current.nextYear.lines.find(r => r.code === '1002').opening.debit, 8160);
    assert.equal(adapter.validate({ ...scope, expectedDigest: original.contentDigest }).status, 'stale');
    const differences = compareAnnualCloseReviews(JSON.parse(JSON.stringify(original)), current);
    assert.equal(differences.confirmation, 'previous_confirmation_must_be_revalidated');
    assert.ok(differences.changes.some(r => r.path.endsWith('/营业利润') && r.before === 7020 && r.after === 7000));
    assert.equal(differences.authorizesExecution, false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n, count);
  });
  await test('actual auxiliary allocation-only correction invalidates the annual version', async () => {
    const { ensureAuxiliarySchema } = await import('../server/auxiliary-storage.mjs');
    const X = await import('../server/auxiliary-accounting.mjs');
    await ensureAuxiliarySchema(db, { dbPath: join(dataDir, 'workbench.db'), outDir: join(root, 'before-aux') });
    const p1 = X.createAuxiliaryEntity(db, { accountSetId: id, kind: 'party', code: 'P1', name: '合成往来一', requestId: 'annual-p1' }).id;
    const p2 = X.createAuxiliaryEntity(db, { accountSetId: id, kind: 'party', code: 'P2', name: '合成往来二', requestId: 'annual-p2' }).id;
    const entryId = db.prepare("SELECT id FROM voucher_entries WHERE voucher_id=? AND code='1002'").get(annualVoucherIds[0]).id;
    const assign = (partyId, requestId) => X.replaceAuxiliaryAllocations(db, { accountSetId: id, entryId, allocations: [{ partyId, debit: 100 }], requestId, reason: '合成辅助归属更正' });
    assign(p1, 'annual-aux-first');
    const before = adapter.inspect(scope);
    assign(p2, 'annual-aux-correction');
    const after = adapter.inspect(scope);
    assert.equal(before.annualNumbers.incomeStatementYtd['营业利润'], after.annualNumbers.incomeStatementYtd['营业利润']);
    assert.notEqual(before.ledgerEvidence.inventory.aux_allocations.digest, after.ledgerEvidence.inventory.aux_allocations.digest);
    assert.equal(adapter.validate({ ...scope, expectedDigest: before.contentDigest }).status, 'stale');
  });
  await test('identity binding rejects cross-enterprise reads and review comparisons', () => {
    const otherId = make('SYNTHETIC-ANNUAL-B', '2026-01');
    voucher(otherId, '2026-12', [e('1002', 7), e('5001', 0, 7)]);
    assert.throws(() => adapter.inspect({ ...scope, accountSetId: otherId }), /ledger_binding_mismatch/);
    const other = adapter.inspect({ accountSetId: otherId, enterpriseKey: 'SYNTHETIC-ANNUAL-B', year: '2026' });
    assert.equal(other.annualNumbers.incomeStatementYtd['营业利润'], 7);
    assert.throws(() => compareAnnualCloseReviews(original, other), /annual_review_scope_mismatch/);
    assert.throws(() => adapter.inspect({ ...scope, completed: true }), /annual_scope_invalid/);
  });
} finally {
  db?.close();
  // 仅使用本进程通过 mkdtemp 拥有的目录；不打开真实数据库。
  const target = resolve(root);
  if (target.startsWith(tempBase + (process.platform === 'win32' ? '\\' : '/'))) rmSync(target, { recursive: true, force: true });
}
console.log(`annual-close ${passed} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
