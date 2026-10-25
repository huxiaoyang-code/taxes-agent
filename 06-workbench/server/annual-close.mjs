// Annual evidence adapter. No default database imports, posting, formula engine,
// task persistence or accountant-approval authority. The server binds the fixed
// existing report/check functions to its already-open database in trusted code.
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { captureHarnessCode } from './harness-code.mjs';
import {
  openReadonlyLedgerSource, captureLedgerSnapshot, validateLedgerSnapshot,
  assertLedgerSourcePath,
} from './offline-ledger-snapshot.mjs';

export const ANNUAL_CLOSE_VERSION = 'annual-close-review/1';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (value, code) => { if (!value) fail(code); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  if (typeof value === 'number' && !Number.isFinite(value)) fail('annual_evidence_number_invalid');
  return value;
};
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const copy = structuredClone;
const months = year => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
// Reuse the Harness's fixed static dependency closure; unrelated source files
// do not change this annual result. Hot edits still require a fresh worker.
export const ANNUAL_CLOSE_CODE_ROOTS = Object.freeze(['./annual-close.mjs', './report-export.mjs', './period-end-controls.mjs']);
const sourceCodeDigest = () => captureHarnessCode(ANNUAL_CLOSE_CODE_ROOTS).digest;
const loadedSourceDigest = sourceCodeDigest();
function scopeOf(input, validation = false) {
  const keys = validation ? ['accountSetId', 'enterpriseKey', 'year', 'expectedDigest'] : ['accountSetId', 'enterpriseKey', 'year'];
  check(plain(input) && keys.every(k => Object.hasOwn(input, k)) && Object.keys(input).every(k => keys.includes(k)), 'annual_scope_invalid');
  const { accountSetId, enterpriseKey, year } = input;
  check(Number.isSafeInteger(accountSetId) && accountSetId > 0 && typeof enterpriseKey === 'string' && enterpriseKey.length > 0 && enterpriseKey.length <= 128 && enterpriseKey === enterpriseKey.normalize('NFKC').trim() && !/[\u0000-\u001f\u007f]/.test(enterpriseKey), 'annual_scope_invalid');
  check(typeof year === 'string' && /^20\d\d$/.test(year), 'annual_scope_invalid');
  if (validation) check(typeof input.expectedDigest === 'string' && /^[a-f0-9]{64}$/.test(input.expectedDigest), 'annual_digest_invalid');
  return { accountSetId, enterpriseKey, year };
}

// Fixed tables only. Inventory changes are part of the review version; absent
// optional schemas are unknown, never proof that the enterprise has no activity.
const INVENTORY_TABLES = ['asset_cards', 'asset_depreciation_runs', 'aux_entities', 'aux_requirements', 'aux_allocations', 'bank_accounts', 'bank_batches', 'bank_transactions', 'bank_matches', 'bank_reconcile_runs'];
function readInventory(db, accountSetId) {
  return Object.fromEntries(INVENTORY_TABLES.map(table => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [table, { availability: 'unknown', rows: [] }];
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
    if (!columns.includes('account_set_id')) return [table, { availability: 'unsupported_scope', rows: [] }];
    // All columns/rows are hashed locally; only counts and digests leave this helper.
    const rows = db.prepare(`SELECT * FROM ${table} WHERE account_set_id=?`).all(accountSetId).map(r => ({ ...r }));
    rows.sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))));
    return [table, { availability: 'present', count: rows.length, digest: digest(rows) }];
  }));
}
function reportView(report, scope, kind, period) {
  check(report?.accountSet?.id === scope.accountSetId && report.kind === kind && report.period === period && report.scope?.status === 'posted', 'annual_report_scope_mismatch');
  // Keep the original report warnings, mapping status, and completeness markers.
  return copy(report);
}
function planHints(snapshot, inventory) {
  const codes = [...new Set([
    ...snapshot.openingBalances.filter(r => r.debitMinor !== 0 || r.creditMinor !== 0).map(r => r.code),
    ...snapshot.vouchers.flatMap(v => v.entries.map(r => r.code)),
  ])].sort();
  const observed = prefix => codes.filter(code => prefix.some(p => code.startsWith(p)));
  const rows = [
    ['bank', ['1002'], '全年银行账户清单、对账单与未达项；无账簿活动仍须核实账户事实'],
    ['receivables-payables', ['112', '113', '122', '220', '224'], '往来明细、账龄、对方确认、坏账与跨年结算'],
    ['inventory', ['14'], '存货台账、年末盘点、成本归属和截止'],
    ['assets', ['16', '17'], '资产卡片、历史累计、处置、盘点与总账勾稽'],
    ['payroll', ['221'], '工资社保、计提支付和未付明细'],
    ['taxes', ['222'], '全年及历史申报、预缴、税会差异与适用资格'],
    ['equity-financing', ['20', '23', '24', '25', '3', '4'], '借款权益、利息、投资与历史结转'],
    ['cutoff-accruals', ['5', '6'], '合同履约、收入费用截止、预提摊销及期后事项'],
  ];
  return rows.map(([taskId, prefixes, requestedFact]) => ({
    taskId: `annual.${taskId}`, observedAccountCodes: observed(prefixes),
    applicability: observed(prefixes).length || taskId === 'assets' && inventory.asset_cards.count > 0 ? 'investigate_observed_activity' : 'enterprise_fact_required',
    requestedFact, evidenceBasis: 'persisted_account_codes_and_scoped_inventory_not_business_applicability_decision',
  }));
}
function nextYearBridge(yearEnd, nextReport) {
  if (!yearEnd || !nextReport) return { status: 'not_verified', lines: [], request: '登记并核对次年期初；跨年税务/资产/往来台账另需业务能力及会计确认' };
  const previous = new Map(yearEnd.data.lines.map(r => [r.code, r]));
  const current = new Map(nextReport.data.lines.map(r => [r.code, r]));
  const lines = [...new Set([...previous.keys(), ...current.keys()])].sort().map(code => {
    const a = previous.get(code), b = current.get(code);
    const ending = a ? { debit: a.closing_debit, credit: a.closing_credit } : null;
    const opening = b ? { debit: b.opening_debit, credit: b.opening_credit } : null;
    return { code, ending, opening, matches: !!a && !!b && ending.debit === opening.debit && ending.credit === opening.credit };
  });
  return { status: lines.every(r => r.matches) ? 'ledger_balances_tie' : 'difference', lines,
    source: { yearEndPeriod: yearEnd.period, nextOpeningPeriod: nextReport.period },
    limitations: ['same_book_balance_continuity_only', 'no_next_year_posting', 'tax_asset_auxiliary_rollforwards_not_confirmed'] };
}

/** Runtime-only factory. The MCP wire never accepts db handles, functions,
 * precomputed reports, completion flags, or fabricated execution receipts. */
export function createAnnualCloseAdapter({ db, buildReportExport, periodEndCheck }) {
  check(db && typeof db.prepare === 'function' && typeof buildReportExport === 'function' && typeof periodEndCheck === 'function', 'annual_runtime_invalid');
  const runtimeFunctionDigest = digest({ report: buildReportExport.toString(), periodCheck: periodEndCheck.toString() });
  const codeEvidence = { codeDigest: digest({ loadedSourceDigest, runtimeFunctionDigest }), dependencySourceDigest: loadedSourceDigest,
    runtimeFunctionDigest, dependencyRoots: ANNUAL_CLOSE_CODE_ROOTS, restartRequiredOnSourceChange: true };
  const inspect = input => {
    check(sourceCodeDigest() === loadedSourceDigest, 'annual_runtime_restart_required');
    const scope = scopeOf(input), yearPeriods = months(scope.year), last = yearPeriods.at(-1);
    const dbPath = db.prepare('PRAGMA database_list').all().find(r => r.name === 'main')?.file;
    check(typeof dbPath === 'string' && dbPath.length > 0, 'annual_database_target_invalid');
    const source = openReadonlyLedgerSource(dbPath);
    try {
      assertLedgerSourcePath(source, dbPath);
      const snapshot = captureLedgerSnapshot(source, { enterpriseKey: scope.enterpriseKey, accountSetId: scope.accountSetId, fromPeriod: yearPeriods[0], toPeriod: last });
      const physical = statSync(dbPath, { bigint: true });
      const databaseFileIdentityDigest = digest([String(physical.dev), String(physical.ino), String(physical.birthtimeNs)]);
      const inventory = readInventory(db, scope.accountSetId);
      const availablePeriods = new Set(snapshot.periods.map(r => r.period));
      const reports = {}, reportErrors = [], executionRecords = [];
      for (const kind of ['trial-balance', 'balance-sheet', 'income-statement', 'cash-flow-statement']) {
        if (!availablePeriods.has(last)) { reportErrors.push({ kind, code: 'period_not_registered', period: last }); continue; }
        try {
          reports[kind] = reportView(buildReportExport(scope.accountSetId, { kind, period: last }).report, scope, kind, last);
          executionRecords.push({ entrypoint: 'buildReportExport', kind, period: last, effect: 'read', resultDigest: digest(reports[kind]) });
        } catch (error) { reportErrors.push({ kind, code: error.code || error.message || 'annual_report_failed', period: last }); }
      }
      const periodChecks = yearPeriods.map(period => {
        if (!availablePeriods.has(period)) return { period, availability: 'missing', result: null };
        try {
          const result = copy(periodEndCheck(scope.accountSetId, period));
          executionRecords.push({ entrypoint: 'periodEndCheck', period, effect: 'read', resultDigest: digest(result) });
          return { period, availability: 'available', result };
        } catch (error) { return { period, availability: 'failed', code: error.code || error.message || 'annual_check_failed', result: null }; }
      });
      const nextPeriod = `${Number(scope.year) + 1}-01`;
      const nextSnapshot = captureLedgerSnapshot(source, { enterpriseKey: scope.enterpriseKey, accountSetId: scope.accountSetId, fromPeriod: nextPeriod, toPeriod: nextPeriod });
      let nextReport = null;
      if (nextSnapshot.periods.some(r => r.period === nextPeriod)) {
        try {
          nextReport = reportView(buildReportExport(scope.accountSetId, { kind: 'trial-balance', period: nextPeriod }).report, scope, 'trial-balance', nextPeriod);
          executionRecords.push({ entrypoint: 'buildReportExport', kind: 'trial-balance', period: nextPeriod, effect: 'read', resultDigest: digest(nextReport) });
        } catch (error) { reportErrors.push({ kind: 'next-year-trial-balance', code: error.code || error.message || 'annual_report_failed', period: nextPeriod }); }
      }
      check(validateLedgerSnapshot(source, snapshot).status === 'current' && validateLedgerSnapshot(source, nextSnapshot).status === 'current' && digest(readInventory(db, scope.accountSetId)) === digest(inventory), 'annual_evidence_changed_during_read');
      check(sourceCodeDigest() === loadedSourceDigest, 'annual_runtime_restart_required');
      const bundle = {
        version: ANNUAL_CLOSE_VERSION, kind: 'annual_review_draft', scope: { ...scope, databaseInstanceId: snapshot.instance.instanceId, currency: 'CNY' },
        annualComplete: false, accountantApproval: 'pending', authorizesExecution: false, submittable: false,
        codeEvidence, ruleContext: { profile: copy(snapshot.profile), reportContexts: Object.fromEntries(Object.entries(reports).map(([kind, report]) => [kind, copy(report.accountingContext)])) },
        sourceAuthenticity: 'unverified',
        coverage: { requestedPeriods: yearPeriods, missingLedgerPeriods: snapshot.completeness.missingPeriods,
          ledgerStartPeriod: snapshot.accountSet.start_period, annualMaterials: 'unverified', priorHistory: 'unverified',
          openingBalances: 'unverified', originalFiles: 'unverified', legalExistenceRange: 'enterprise_fact_required',
          ledgerRegisteredPeriodsDoNotProveMaterialsCoverage: true },
        ledgerEvidence: { contentDigest: snapshot.contentDigest, nextContentDigest: nextSnapshot.contentDigest, databaseFileIdentityDigest,
          counts: snapshot.counts, priorVoucherCount: snapshot.counts.priorVouchers, completeness: snapshot.completeness,
          sourceChecks: snapshot.sources.checks, inventory },
        reports, reportErrors, periodChecks,
        annualNumbers: { incomeStatementYtd: reports['income-statement']?.data.ytd ?? null,
          cashFlowYtd: reports['cash-flow-statement']?.data.ytd ?? null,
          yearEndTrialBalance: reports['trial-balance']?.data ?? null },
        sourceReferences: snapshot.sources.voucherSources.map(r => ({ sourceId: r.id, sourceSystem: r.source_system, sourceVoucherId: r.source_voucher_id, voucherId: r.voucher_id, batchId: r.batch_id, fingerprint: r.content_fingerprint, originalVerification: 'unverified' })),
        policyBasis: { status: 'requires_applicable_business_rules_and_accountant_review', references: [] },
        adjustmentDrafts: { status: 'business_capability_required', entries: [], note: '空草稿不代表无需调整；不得把诊断、补差或未核实金额写为凭证' },
        incomeTaxSettlement: { status: 'business_capability_required', applicability: 'enterprise_fact_required', result: null, filing: 'human_only', payment: 'human_only' },
        planHints: planHints(snapshot, inventory), executionRecords,
        nextYear: { ...nextYearBridge(reports['trial-balance'], nextReport), period: nextPeriod, trialBalance: nextReport, carryoverSchedules: 'business_capability_and_accountant_confirmation_required' },
        pending: [
          { code: 'annual_materials_and_history_unverified', request: '客户提供全年与承接历史的资料及适用期间事实；由Agent整理覆盖、提出补件并保留未决' },
          { code: 'annual_reconciliation_unreviewed', request: '逐项核对银行、总分账、资产往来台账、截止与差异原因，缺失明细不能补零' },
          { code: 'annual_adjustment_and_tax_dependency', request: '调用已发布会计处理、年度调整、结转及适用所得税业务能力；缺失能力保留未完成' },
          { code: 'annual_review_and_recovery_dependency', request: '使用共享Harness管理版本反馈、确认失效、补件和中断恢复；本适配不自行保存状态' },
          { code: 'accountant_confirmation_pending', request: '人类会计审定本版本结果及未决；企业特例是否推广公共规则由人决定' },
          { code: 'cross_year_schedules_unconfirmed', request: '核对次年余额、资产/往来/税务跨年台账与本年审定版本的关系' },
        ],
      };
      bundle.contentDigest = digest(bundle);
      return freeze(bundle);
    } finally { source.close(); }
  };
  return Object.freeze({ inspect, validate(input) {
    const scope = scopeOf(input, true), current = inspect(scope);
    return freeze({ version: ANNUAL_CLOSE_VERSION, scope: current.scope, expectedDigest: input.expectedDigest,
      currentDigest: current.contentDigest, status: current.contentDigest === input.expectedDigest ? 'current' : 'stale',
      annualComplete: false, authorizesExecution: false, accountantApproval: 'pending' });
  } });
}

/** Public JSON comparison is diagnostic, never a current-version capability. */
export function compareAnnualCloseReviews(previous, current) {
  check(previous?.version === ANNUAL_CLOSE_VERSION && current?.version === ANNUAL_CLOSE_VERSION, 'annual_review_version_invalid');
  for (const key of ['enterpriseKey', 'accountSetId', 'databaseInstanceId', 'year', 'currency']) check(previous.scope?.[key] === current.scope?.[key], 'annual_review_scope_mismatch');
  const changes = [];
  function walk(a, b, path) {
    if (JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))) return;
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${path}/${key}`);
    } else changes.push({ path, before: a === undefined ? null : copy(a), after: b === undefined ? null : copy(b), beforePresent: a !== undefined, afterPresent: b !== undefined });
  }
  walk(previous, current, '');
  return freeze({ kind: 'annual_review_difference', scope: copy(current.scope), previousDigest: previous.contentDigest, currentDigest: current.contentDigest,
    changes, confirmation: previous.contentDigest === current.contentDigest ? 'not_assessed' : 'previous_confirmation_must_be_revalidated',
    diagnosticOnly: true, authorizesExecution: false });
}
