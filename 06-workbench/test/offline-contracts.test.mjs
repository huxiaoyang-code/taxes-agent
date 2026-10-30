import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateOfflineContract, offlineMoneyToCents, OFFLINE_CONTRACT_VERSION as version } from '../server/offline-contracts.mjs';

const fixture = new URL('./fixtures/offline-close-loop/', import.meta.url);
const read = (folder, name) => JSON.parse(readFileSync(new URL(`${folder}/${name}.json`, fixture), 'utf8'));
const base = () => read('inputs', '01-service-sale');
const copy = value => structuredClone(value);
const header = (kind, m = base()) => ({ kind, version, id: `${kind}-1`, scope: copy(m.scope), sourceVersion: m.sourceVersion });
const validate = (doc, m = base()) => validateOfflineContract(doc, { manifest: m });
const yes = (doc, m) => { const result = validate(doc, m); assert.equal(result.valid, true, JSON.stringify(result)); assert.equal(result.validationOnly, true); assert.equal(result.authorizesExecution, false); };
const no = (doc, m) => { const result = validate(doc, m); assert.equal(result.valid, false); assert.equal(result.authorizesExecution, false); assert.match(JSON.stringify(result.errors), /^\[\{"code":"offline_[a-z_]+"\}\]$/); };
const line = () => ({ manifestId: 'manifest-1', inputVersion: 'v1', ledgerVersion: 'ledger-v1', ruleVersion: 'unverified-v1' });

// 独立测试算术：既不调用产品解析器，也不将测试样本作为运行时输入。
function manualCents(value) {
  const negative = value.startsWith('-');
  const digits = value.replace('-', '').replace('.', '');
  let result = 0n;
  for (const digit of digits) result = result * 10n + BigInt(digit.charCodeAt(0) - 48);
  return negative ? -result : result;
}
function decimal(cents) { const sign = cents < 0n ? '-' : ''; const abs = cents < 0n ? -cents : cents; return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`; }

const names = readdirSync(new URL('inputs/', fixture)).map(n => n.replace('.json', ''));
test('at least twelve independent paired synthetic fixtures; expectations are not product payloads', () => {
  assert.equal(names.length, 16);
  assert.deepEqual(readdirSync(new URL('expectations/', fixture)).sort(), names.map(n => `${n}.json`).sort());
  for (const name of names) no(read('expectations', name));
});
for (const name of names) {
  test(`engineering fixture ${name}: validation, entries and independent pre-close trial balances`, () => {
    const input = read('inputs', name), expected = read('expectations', name);
    assert.equal(validateOfflineContract(input).valid, expected.contractValid);
    assert.equal(expected.fixtureOnly, true); assert.equal(expected.accountantStatus, 'pending');
    assert.equal(expected.taxStatus, 'blocked'); assert.equal(expected.expectedTaxFields.vat_payable.amount, null);
    if (!expected.contractValid) { assert.deepEqual(expected.expectedEntries, []); return; }
    const entries = [];
    for (const fact of input.facts.filter(f => f.state === 'known')) {
      if (fact.type === 'sales') { assert.equal(fact.business.performance, 'completed'); assert.equal(fact.business.settlement, 'received'); }
      if (fact.type === 'service_expense') { assert.equal(fact.business.performance, 'completed'); assert.equal(fact.business.settlement, 'paid'); }
      if (fact.type === 'sales') entries.push({ debitAccount: '1002', creditAccount: '5001', amount: fact.amount });
      if (fact.type === 'service_expense') entries.push({ debitAccount: '5602', creditAccount: '1002', amount: fact.amount });
    }
    assert.deepEqual(entries, expected.expectedEntries);
    const balances = {};
    if (input.history.length) {
      // 连续的第二季度显式使用独立 Q2 预期。
      const prior = read('expectations', '01-service-sale').expectedPreCloseTrialBalances;
      for (const [key, value] of Object.entries(prior)) balances[key] = manualCents(value);
    }
    for (const row of entries) {
      balances[row.debitAccount] = (balances[row.debitAccount] ?? 0n) + manualCents(row.amount);
      balances[row.creditAccount] = (balances[row.creditAccount] ?? 0n) - manualCents(row.amount);
    }
    assert.deepEqual(Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, decimal(v)])), expected.expectedPreCloseTrialBalances);
    assert.equal(Object.values(balances).reduce((a, b) => a + b, 0n), 0n);
    assert.deepEqual(input.facts.filter(f => ['missing', 'unknown', 'conflict', 'unsupported'].includes(f.state)).map(f => f.factId), expected.blockingFactIds);
    if (expected.syntheticArithmetic) {
      const arithmetic = expected.syntheticArithmetic;
      assert.equal(arithmetic.testOnly, true);
      const sourceBase = input.facts.filter(f => f.type === 'sales' || name.startsWith('11')).reduce((sum, f) => sum + manualCents(f.amount), 0n);
      assert.equal(manualCents(arithmetic.base), sourceBase);
      const product = sourceBase * BigInt(arithmetic.numerator), divisor = BigInt(arithmetic.denominator);
      // 独立的商/余数方法，对比测试样本中的字面十进制推导。
      const rounded = product / divisor + ((product % divisor) * 2n >= divisor ? 1n : 0n);
      assert.equal(decimal(rounded), arithmetic.roundedAmount);
    }
  });
}

test('exact money rejects coercion, precision loss and noncanonical strings', () => {
  assert.equal(offlineMoneyToCents('90071992547.41'), 9007199254741n);
  assert.equal(offlineMoneyToCents('-2.12'), -212n);
  for (const value of [0, 1.01, null, '', '01.00', '-0.00', '1', '1.0', '1.001', '1e2', ' 1.00', '+1.00', '10000000000000.00']) assert.throws(() => offlineMoneyToCents(value), { code: 'offline_amount_invalid' });
});
test('rejects dates, periods, scope/version mismatch and unversioned references', () => {
  for (const date of ['2026-02-30', '2026-04-31', '2026-05-00', '2026-03-31', '2026-07-01']) { const m = base(); m.facts[0].date = date; no(m); }
  for (const period of ['2026-13', '2026-Q0', '2026-Q5', '2026-Q2 ']) { const m = base(); m.scope.period = period; no(m); }
  const m = base(); m.evidence[0].scope.accountSetId = 'other-book'; no(m);
  const n = base(); n.facts[0].evidenceRefs[0].sourceVersion = 'v2'; no(n);
  const p = base(); p.evidence[0].coveragePeriod = '2026-Q1'; no(p);
});
test('no customer vouchers, accounts, computed tax or expectation bypass', () => {
  for (const field of ['vouchers', 'entries', 'debitAccount', 'taxPayable', 'golden', 'expectations']) { const m = base(); m[field] = []; no(m); }
  const m = base(); m.mode = 'historical_migration'; no(m);
  const n = base(); n.facts[0].type = 'tax_adjustment'; no(n);
});
test('zero and not applicable require actual provided evidence; unknown never becomes zero', () => {
  const m = read('inputs', '04-evidenced-zero'); yes(m); m.facts[0].evidenceRefs = []; no(m);
  const n = read('inputs', '15-not-applicable'); yes(n); n.evidence[0].status = 'unsupported'; no(n);
  for (const state of ['missing', 'unknown', 'unsupported', 'not_applicable']) { const p = base(); p.facts[0].state = state; p.facts[0].reasonCode = 'reason'; no(p); }
  const conflict = read('inputs', '14-conflicting-evidence'); conflict.facts[0].evidenceRefs.pop(); no(conflict);
});
test('negative correction needs prior version and invoice evidence', () => {
  const m = base(); m.sourceVersion = 'v2'; m.facts[0].amount = '-2.12'; no(m);
  m.facts[0].correctionOf = { factId: 'sale', sourceVersion: 'v1' }; no(m);
  m.evidence[0].category = 'invoice'; yes(m);
  m.facts[0].correctionOf.sourceVersion = 'v2'; no(m);
});
test('questionnaire takes business facts without requiring accounting entries', () => {
  const m = base(); const doc = { ...header('questionnaire', m), facts: copy(m.facts) }; yes(doc, m);
  doc.facts[0] = { ...doc.facts[0], type: 'business_scope', amount: null, answer: 'service_company' }; delete doc.facts[0].business; yes(doc, m);
  doc.facts[0].debit = '1002'; no(doc, m);
});
test('evidence preserves local source sheet/row/field; locator is not a path or URL', () => {
  const e = base().evidence[0]; e.format = 'xlsx'; e.sourceLocation = { sheet: '销售明细', row: '2', field: '含税金额' }; yes(e);
  e.sourceLocation.row = '0'; no(e);
  e.sourceLocation.row = '2'; e.locator = 'https://example.com/private.csv'; no(e);
});
function plan(m = base()) { return { ...header('task-plan', m), periodStatus: 'partial', tasks: [{ taskId: 'normalize', operation: 'normalize', dependencies: [], factIds: ['sale'], state: 'ready', blockerCodes: [] }] }; }
test('task graph permits independent readiness and preserves blocked branches', () => {
  const m = base(); m.facts.push(copy(read('inputs', '06-missing-category').facts[0]));
  const p = plan(m); p.tasks.push({ taskId: 'bank', operation: 'assess', dependencies: [], factIds: ['bank'], state: 'blocked_missing_data', blockerCodes: ['bank_statement_required'] }); yes(p, m);
  p.periodStatus = 'ready_for_review'; no(p, m); p.periodStatus = 'partial'; p.tasks[1].state = 'ready'; p.tasks[1].blockerCodes = []; no(p, m);
});
test('task graphs reject cycles, forged completion, unknown refs and fake tax readiness', () => {
  const p = plan(); p.tasks[0].dependencies = ['normalize']; no(p);
  const q = plan(); q.tasks[0].dependencies = ['missing-task']; no(q);
  const r = plan(); r.tasks[0].state = 'completed'; no(r);
  const s = plan(); s.tasks[0].operation = 'compute_tax'; no(s);
  const t = plan(); t.tasks[0].factIds = ['not-a-fact']; no(t);
});
test('data requests stay local and do not re-request provided facts', () => {
  const m = read('inputs', '06-missing-category');
  const d = { ...header('data-request', m), delivery: 'local_only', items: [{ requestId: 'request-bank', factIds: ['bank'], reason: '核对资金完整性，需要本期完整银行流水。', affectedTasks: ['bank-reconcile'], acceptedMaterials: ['bank_statement_csv', 'bank_statement_xlsx'], alternativeEvidence: ['bank_signed_statement_pdf'] }] };
  yes(d, m); d.delivery = 'email'; no(d, m); d.delivery = 'local_only';
  for (const field of ['acceptedMaterials', 'alternativeEvidence']) {
    for (const forbidden of ['precomputed_tax', 'voucher', 'journal_entries', 'final_tax_amount', 'unregistered_material']) {
      const requested = copy(d); requested.items[0][field] = [forbidden]; no(requested, m);
    }
  }
  d.items[0].factIds = ['sale']; no(d, base());
});
function candidate() { return { ...header('voucher-candidate'), date: '2026-04-01', factIds: ['sale'], evidenceRefs: copy(base().facts[0].evidenceRefs), ruleId: 'engineering-example', ruleVersion: 'pending-v1', status: 'candidate', idempotencyKey: 'sale-v1', entries: [{ accountCode: '1002', debit: '1001.23', credit: '0.00' }, { accountCode: '5001', debit: '0.00', credit: '1001.23' }] }; }
test('candidate is balanced and traceable but never permission to post', () => {
  const d = candidate(); yes(d); d.entries[1].credit = '1001.22'; no(d); d.entries[1].credit = '1001.23'; d.entries[0].credit = '1.00'; no(d);
  const n = candidate(); n.factIds = ['unknown']; no(n);
  const p = candidate(); p.sourceVersion = 'v2'; no(p);
  const negativeSide = candidate(); negativeSide.entries = [{ accountCode: '1002', debit: '100.00', credit: '-10.00' }, { accountCode: '5001', debit: '-10.00', credit: '100.00' }]; no(negativeSide);
  negativeSide.entries = [{ accountCode: '1002', debit: '-10.00', credit: '100.00' }, { accountCode: '5001', debit: '100.00', credit: '-10.00' }]; no(negativeSide);
  const q3 = read('inputs', '10-next-quarter-history'); const unrelated = candidate();
  unrelated.scope = copy(q3.scope); unrelated.date = '2026-07-01';
  unrelated.entries[0].debit = '312.48'; unrelated.entries[1].credit = '312.48';
  yes(unrelated, q3);
  unrelated.evidenceRefs = [{ evidenceId: 'historical-e1', sourceVersion: 'v1' }]; no(unrelated, q3);
  unrelated.evidenceRefs.push({ evidenceId: 'e1', sourceVersion: 'v1' }); no(unrelated, q3);
});
function tax() { return { ...header('tax-computation'), taxType: 'vat_small_scale', status: 'blocked', ruleStatus: 'source_checked_accountant_pending', lineage: line(), blockerCodes: ['applicable_rules_pending'], fields: [{ fieldId: 'vat_payable', amount: null, state: 'unknown', factIds: ['sale'], voucherIds: [], adjustmentIds: [], evidenceRefs: copy(base().facts[0].evidenceRefs) }] }; }
test('unknown official rules cannot masquerade as ready or as a computed zero', () => {
  const d = tax(); yes(d); d.status = 'ready'; no(d); d.status = 'blocked'; d.fields[0].amount = '0.00'; no(d);
  const n = tax(); n.ruleStatus = 'verified'; no(n);
  const p = tax(); p.testOnly = true; no(p);
});
test('review feedback links immutable input version; confirmation is reserved to #82', () => {
  const bundle = { ...header('review-bundle'), resultVersion: 'result-1', lineage: line(), voucherIds: ['voucher-1'], taxComputationIds: ['tax-1'], unresolvedCodes: ['tax_rules_pending'], status: 'blocked' }; yes(bundle);
  bundle.status = 'pending_review'; no(bundle);
  const decision = { ...header('review-decision'), bundleId: 'bundle-1', resultVersion: 'result-1', lineage: line(), decision: 'request_correction', reviewerRef: 'local-reviewer', feedback: [{ factId: 'sale', reasonCode: 'wrong_amount', comment: '请核对合同结算金额。' }] }; yes(decision);
  decision.lineage.inputVersion = 'v2'; no(decision); decision.lineage.inputVersion = 'v1'; decision.decision = 'confirm'; decision.feedback = []; no(decision);
});
test('history cannot cross enterprise, use current evidence or point into future', () => {
  const original = read('inputs', '10-next-quarter-history'); yes(original);
  const m = copy(original); m.history[0].enterpriseKey = 'OTHER'; no(m);
  const n = copy(original); n.history[0].period = '2026-Q4'; no(n);
  const p = copy(original); p.history[0].evidenceRefs[0].evidenceId = 'e1'; no(p);
});
test('plain JSON guard rejects getters without executing, cycles, sparse arrays and no mutation', () => {
  let called = false; const m = base(); Object.defineProperty(m, 'hidden', { get() { called = true; throw new Error('private'); }, enumerable: true }); no(m); assert.equal(called, false);
  const n = base(); n.circular = n; no(n);
  const p = base(); p.facts = Array(1); no(p);
  const q = base(); const before = JSON.stringify(q); yes(q); assert.equal(JSON.stringify(q), before);
  const r = base(); r.secret = 'PRIVATE-CUSTOMER-NAME'; assert.equal(JSON.stringify(validate(r)).includes('PRIVATE'), false);
  assert.equal(validateOfflineContract(candidate()).valid, false);
});
test('options boundary returns fixed errors for null/accessor/unknown fields without invoking getters', () => {
  assert.deepEqual(validateOfflineContract(base(), null), { valid: false, validationOnly: true, authorizesExecution: false, errors: [{ code: 'offline_fields_invalid' }] });
  let called = false;
  const options = Object.defineProperty({}, 'manifest', { enumerable: true, get() { called = true; throw new Error('PRIVATE-OPTIONS-CONTENT'); } });
  const result = validateOfflineContract(candidate(), options);
  assert.equal(called, false);
  assert.deepEqual(result, { valid: false, validationOnly: true, authorizesExecution: false, errors: [{ code: 'offline_fields_invalid' }] });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(validateOfflineContract(base(), { extra: 'unexpected' }).valid, false);
  assert.equal(validateOfflineContract(base(), []).valid, false);
});
test('fresh import and validation in empty temporary cwd do not create DB/files or write output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-contract-'));
  try {
    const moduleUrl = new URL('../server/offline-contracts.mjs', import.meta.url).href;
    const code = `const m=await import(${JSON.stringify(moduleUrl)});if(m.validateOfflineContract({}).valid)process.exitCode=1;`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); assert.deepEqual(readdirSync(dir), []);
    const source = readFileSync(fileURLToPath(new URL('../server/offline-contracts.mjs', import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /from ['"](?:node:fs|\.\/db\.mjs|\.\/accounting\.mjs|.*fixtures|.*expectations)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
