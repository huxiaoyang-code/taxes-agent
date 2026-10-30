#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, readdirSync, watch } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { preflightMaterials } from '../server/offline-materials.mjs';
import { buildOfflineCandidates } from '../server/offline-bookkeeping.mjs';
import { hash, stable } from '../server/offline-material-adapters.mjs';
import { VAT_EXCLUSIONS, VAT_SOURCE_SYSTEM } from '../server/tax-calculation.mjs';
import { initMaterialStore, receiveMaterials } from '../server/offline-material-store.mjs';
import { initReviewStore, registerReview, recordReviewFeedback, inspectReviewStore } from '../server/accountant-review-store.mjs';
const workbench = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = join(workbench, '.agent-runs'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'feedback-synthetic-'));
process.env.TEMP = root; process.env.TMP = root; process.env.WORKBENCH_DATA_DIR = join(root, 'data'); mkdirSync(process.env.WORKBENCH_DATA_DIR);
let db, A, IM, passed = 0, failed = 0, serial = 0;
const test = async (name, work) => { try { await work(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } };
const clone = structuredClone, wrap = value => { const text = JSON.stringify(value); return { text, fileSha256: hash(text) }; };
const write = (path, x) => writeFileSync(path, typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const cell = (p, row, period = 'current', column = 'services') => p.cells.find(c => c.row === row && c.period === period && c.column === column);
const blocked = p => { assert.equal(p.calculationReady, false); for (const row of p.selectedFields) assert.equal(cell(p, row).value, null); assert.equal(p.periodComplete, false); };
const code = (p, code) => assert.ok(p.issues.some(i => i.code === code), JSON.stringify(p.issues));
const cents = v => { const [whole, fract] = v.split('.'); return BigInt(whole) * 100n + BigInt(fract); };
const fmt = n => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
function evidence(scope, evidenceId, role, basis) { return { evidenceId, kind: 'customer_declaration', scope: clone(scope), confirmedBy: { name: '=会计中文+@-731', role }, basis }; }
function taxDocument(f) {
  const refs = [{ kind: 'declaration', fileSha256: hash(stable(f.input.declaration)), pointer: '/evidence/1/basis' }];
  const confirm = basis => ({ confirmedBy: { name: '=会计中文+@-731', role: 'accountant' }, basis, sourceRefs: clone(refs) });
  return { version: 'offline-tax-facts/1', scope: clone(f.input.scope), enterprise: { form: 'enterprise', establishedOn: '2026-01-01', ...confirm('核对企业登记，2026年1月1日新设企业，非个体或自然人') }, period: { ...confirm('核对Q1全部合同、发票、支付和预缴台账，除逐笔服务外无其他交易'), exclusions: VAT_EXCLUSIONS.map(area => ({ area, state: 'none', ...confirm(`核对完整登记，无${area}事项`) })) }, invoices: f.saleRefs.map(invoiceRef => ({ invoiceRef, invoiceClass: 'ordinary', domesticConsumption: 'domestic', serviceCategory: 'ordinary_main_service', ...confirm('逐票核对普通增值税发票，境内消费普通主营服务，无专票及其他复杂事项') })) };
}
function refreshFacts(f, doc) { f.input.taxFacts = wrap(doc ?? taxDocument(f)); }
function reload(f) {
  const sources = f.sources.map(s => ({ ...s, text: readFileSync(join(f.dir, s.sourceId + (s.kind === 'business_json' ? '.json' : '.csv')), 'utf8') })).map(s => ({ ...s, fileSha256: hash(s.text) }));
  f.input.reports = sources.length ? [preflightMaterials({ scope: f.input.scope, sources })] : [];
  assert.ok(!f.input.reports.some(r => r.status === 'rejected'));
}
function persist(f) {
  for (const s of f.sources) write(join(f.dir, s.sourceId + (s.kind === 'business_json' ? '.json' : '.csv')), s.text);
  write(join(f.dir, 'materials.json'), { scope: f.input.scope, sources: f.sources.map(({ text, fileSha256, ...s }) => ({ ...s, path: s.sourceId + (s.kind === 'business_json' ? '.json' : '.csv') })) });
  write(join(f.dir, 'declaration.json'), f.input.declaration); write(join(f.dir, 'accounting.json'), f.input.accountingFacts.text); write(join(f.dir, 'tax.json'), f.input.taxFacts.text);
  write(join(f.dir, 'input.json'), { version: 'offline-vat-input/1', scope: f.input.scope, profileId: f.input.profileId, materialsInput: 'materials.json', declaration: 'declaration.json', accountingFacts: 'accounting.json', taxFacts: 'tax.json', db: join(process.env.WORKBENCH_DATA_DIR, 'workbench.db') });
}
function fixture(amounts = ['271828.00', '161803.00'], extra = false) {
  const n = ++serial, key = 'SYNTHETIC-VAT-' + n, dir = join(root, 'case-' + n); mkdirSync(dir);
  const set = A.createAccountSet({ name: key, start_period: '2026-01', profileId: 'small-2011-basic-v1', enterprise: { enterpriseKey: key } });
  for (const p of ['2026-01', '2026-02', '2026-03']) A.ensurePeriod(set.id, p);
  const scope = { enterpriseKey: key, accountSetId: String(set.id), period: '2026-Q1', currency: 'CNY', unit: 'yuan' };
  const ref = number => ({ sellerKey: key, code: '', number: String(number).padStart(24, '0') });
  const map = role => ({ format: 'invoice-summary-csv-v1', role, dateFormat: 'YYYY-MM-DD', redSign: 'signed_negative', statusLabels: { blue: ['blue'], red: ['red'] }, columns: { number: 'number', date: 'date', sellerKey: 'seller', buyerKey: 'buyer', net: 'net', tax: 'tax', gross: 'gross', status: 'status' } });
  const src = (sourceId, kind, text, mapping) => ({ sourceId, kind, text, mapping, fileSha256: hash(text), scope: clone(scope) });
  const dates = amounts.map((_, i) => `2026-0${i % 3 + 1}-13`);
  const saleRefs = amounts.map((_, i) => ref(1001 + i));
  const sources = amounts.length ? [src('sales', 'invoice_csv', 'number,date,seller,buyer,net,tax,gross,status\n' + amounts.map((amount, i) => {
    const net = cents(amount), tax = net / 100n; return [String(1001 + i).padStart(24, '0'), dates[i], key, 'BUYER', amount, fmt(tax), fmt(net + tax), 'blue'].join(',');
  }).join('\n'), map('sales'))] : [];
  const basic = amounts.map((_, i) => ({ factId: 'basic-' + i, date: dates[i], nature: 'service', performance: 'completed', settlement: 'unpaid', purpose: 'unknown', benefitPeriod: { state: 'unknown', from: null, to: null }, invoiceRef: saleRefs[i] }));
  const factConfirmation = { confirmedBy: { name: 'SENSITIVE-OPERATOR', role: 'business_operator' }, basis: '合成合同、验收及索款登记同日，全部为本期普通主营服务' };
  const af = amounts.map((_, i) => ({ factId: 'sale-' + i, kind: 'service_sale', ...clone(factConfirmation), invoiceRef: saleRefs[i], contractId: 'CONTRACT-' + i, serviceStartDate: dates[i], completionDate: dates[i], collectionRightDate: dates[i], mainService: true, ordinaryService: true }));
  if (extra) {
    sources.push(src('purchase', 'invoice_csv', 'number,date,seller,buyer,net,tax,gross,status\n2001,2026-03-15,SUPPLIER,' + key + ',266.83,8.00,274.83,blue', map('purchase')));
    const purchaseRef = { sellerKey: 'SUPPLIER', code: '', number: '2001' };
    basic.push({ factId: 'basic-admin', date: '2026-03-15', nature: 'service', performance: 'completed', settlement: 'unpaid', purpose: 'unknown', benefitPeriod: { state: 'unknown', from: null, to: null }, invoiceRef: purchaseRef });
    af.push({ factId: 'admin', kind: 'administrative_service', ...clone(factConfirmation), invoiceRef: purchaseRef, contractId: 'ADMIN', completionDate: '2026-03-15', purpose: 'organizational_administration', nonAsset: true, nonProjectCost: true, benefitFrom: '2026-03-01', benefitTo: '2026-03-31', benefitBasis: '当月日常行政服务' });
    const mapping = { format: 'bank-csv-v1', ownerEnterpriseKey: key, bankAccountId: 'bank-A', dateFormat: 'YYYY-MM-DD', amountMode: 'amount_direction', currency: 'CNY', negativeAmount: 'reject', directionLabels: { inflow: ['in'], outflow: ['out'] }, columns: { date: 'date', amount: 'amount', direction: 'direction', refId: 'ref', summary: 'summary' } };
    sources.push(src('bank', 'bank_csv', 'date,amount,direction,ref,summary\n2026-03-20,61.29,out,PREPAY-1,=SUM(1+2)中文-1.23@危险', mapping));
    af.push({ factId: 'prepay', kind: 'service_prepayment', ...clone(factConfirmation), bankRef: { bankAccountId: 'bank-A', refId: 'PREPAY-1' }, contractId: 'FUTURE', supplierKey: 'FUTURE-SUPPLIER', serviceStartDate: '2026-04-01', serviceEndDate: '2026-06-30', ordinaryService: true, performanceThroughPeriodEnd: 'not_started', refundThroughPeriodEnd: 'none', paymentCount: 1, otherRecognitionInProvidedMaterials: 'none', relatedInvoiceRefs: [] });
  }
  if (basic.length) sources.push(src('business', 'business_json', JSON.stringify({ version: 'business-facts/1', scope, facts: basic }), { format: 'business-facts-json-v1' }));
  const declaration = { version: 'offline-declaration/1', scope: clone(scope), profile: 'small-2011', businessScope: 'service-company', evidence: [evidence(scope, 'owner', 'owner', '核对完整Q1业务清单、所有账户，无工资资产'), evidence(scope, 'accountant', 'accountant', '合成企业登记新设首期、季度小规模税种登记、Q1完整业务及无各排除事项核对台账')], enterpriseEvidenceIds: ['owner'], bankAccounts: { accountIds: extra ? ['bank-A'] : [], evidenceIds: ['owner'] },
    coverage: ['sales', 'purchase', ...(extra ? ['bank'] : [])].map(kind => ({ kind, accountId: kind === 'bank' ? 'bank-A' : null, from: '2026-01', to: '2026-03', state: kind === 'sales' ? amounts.length ? 'complete' : 'no_activity' : extra ? 'complete' : 'no_activity', sourceIds: kind === 'sales' ? amounts.length ? ['sales'] : [] : extra ? [kind] : [], evidenceIds: ['owner'] })),
    tax: { vatStatus: 'small_scale', filingFrequency: 'quarterly', evidenceIds: ['accountant'] }, applicability: ['payroll', 'assets'].map(area => ({ area, present: false, evidenceIds: ['owner'] })), opening: { state: 'new_zero', evidenceIds: ['accountant'] }, history: { state: 'first_period', evidenceIds: ['accountant'] }, bankFacts: extra ? [{ bankAccountId: 'bank-A', refId: 'PREPAY-1', nature: 'operating_payment', evidenceIds: ['owner'] }] : [] };
  const f = { id: set.id, key, dir, sources, saleRefs, input: { scope, reports: [], declaration, profileId: 'small-2011-basic-v1', accountingFacts: wrap({ version: 'offline-accounting-facts/1', scope, facts: af }) } };
  refreshFacts(f); persist(f); reload(f);
  return f;
}
function rebuilt(f) { const { taxFacts, previousComputation, ...x } = f.input; return buildOfflineCandidates(x); }
function post(f) {
  const p = rebuilt(f); assert.ok(p.decisions.every(d => d.status === 'candidate'), JSON.stringify(p.decisions));
  if (!p.candidates.length) return;
  const result = IM.importIncremental({ dryRun: false, confirmNewBinding: true, accountSetId: f.id, batchId: 'synthetic-vat-' + f.id, source: { system: VAT_SOURCE_SYSTEM, enterpriseKey: f.key }, payload: { account_set: { name: f.key, start_period: '2026-01', profileId: 'small-2011-basic-v1' }, vouchers: p.candidates.map(c => ({ period: c.date.slice(0, 7), date: c.date, sourceVoucherId: c.businessKey, summary: `offline:${c.businessKey}`, entries: c.entries.map(e => ({ code: e.accountCode, debit: e.debit, credit: e.credit, summary: e.detail ?? c.kind })) })) } });
  assert.equal(result.status, 'applied', JSON.stringify(result));
}

let feedbackSerial = 0;
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const inputFile = f => join(f.dir, 'input.json');
const payload = (v, action = 'confirm_selected_fields', id = 'feedback-' + (++feedbackSerial)) => ({ version: 'offline-accountant-feedback/1', feedbackId: id, action, scope: clone(v.scope), versionId: v.current.versionId, binding: clone(v.current.binding), expectedJournalHead: v.journalHead, actor: { name: 'SYNTHETIC-会计', role: 'accountant' }, occurredAt: '2026-10-24T01:23:45.678Z', reason: '核对完整原票、登记、业务及账证依据的本机声明', ...(action === 'confirm_selected_fields' ? { selectedFields: [1, 2, 3, 15, 16, 20, 21, 22].map(row => ({ row, column: 'services', period: 'current' })) } : { facts: [{ field: '/taxFacts/invoices/0/invoiceClass', observedFact: '原登记分类待核对', requestedFact: '请提供原发票类别及开具登记依据，不要求客户计算税额或编分录' }] }) });
async function setup(amounts, transform) {
  const f = fixture(amounts); post(f);
  if (transform) { const doc = taxDocument(f); transform(doc); refreshFacts(f, doc); persist(f); }
  f.store = join(f.dir, 'review-store'); await initReviewStore(f.store, f.input.scope);
  f.view = await registerReview(f.store, inputFile(f), { expectedJournalHead: null, supersedes: null }); return f;
}
const artifactDir = (f, v = f.view.current) => join(f.store, 'artifacts', v.versionId);
const fileHashes = dir => readdirSync(dir).sort().map(name => [name, hash(readFileSync(join(dir, name)))]);
const cli = (args, env = {}) => spawnSync(process.execPath, ['scripts/accountant-review-feedback.mjs', ...args], { cwd: workbench, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', ...env } });
const childModule = async (code, args = []) => new Promise((resolveChild, reject) => {
  const c = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { cwd: workbench, env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; c.stdout.on('data', b => stdout += b); c.stderr.on('data', b => stderr += b); c.on('error', reject); c.on('close', (status, signal) => resolveChild({ status, signal, stdout, stderr }));
});
const storeModuleUrl = pathToFileURL(join(workbench, 'server', 'accountant-review-store.mjs')).href;

try {
  ({ db } = await import('../server/db.mjs')); A = await import('../server/accounting.mjs'); IM = await import('../server/import-incremental.mjs');
  await test('independent 433631 actual posted ledger -> own pending seven-sheet artifact and durable current', async () => {
    const f = await setup(), v = f.view;
    assert.equal(v.operation, 'registered'); assert.equal(v.current.calculationReady, true); assert.equal(v.current.effectiveConfirmation, false);
    const bundle = readJson(join(artifactDir(f), 'bundle.json'));
    assert.deepEqual([1, 2, 3, 15, 16, 20, 21, 22].map(row => cell(bundle.computation, row).value), ['433631.00', '0.00', '433631.00', '13008.93', '8672.62', '4336.31', '0.00', '4336.31']);
    assert.equal(bundle.computation.cells.length, 100); assert.equal(bundle.accountantApproval, 'pending'); assert.equal(v.authorizesExecution, false); assert.equal(v.periodComplete, false);
    const manifest = readJson(join(artifactDir(f), 'manifest.json')); assert.equal(manifest.status, 'complete_draft');
    const before = fileHashes(artifactDir(f)), duplicate = await registerReview(f.store, inputFile(f), { expectedJournalHead: v.journalHead, supersedes: v.current.versionId });
    assert.equal(duplicate.operation, 'replayed'); assert.equal(duplicate.journalHead, v.journalHead); assert.equal(duplicate.history.length, 1); assert.deepEqual(fileHashes(artifactDir(f)), before);
    assert.equal((await inspectReviewStore(f.store)).status, 'current');
  });
  await test('request/reject/selected confirmation, no draft rewrite and later request revokes effective fields', async () => {
    const f = await setup(['364927.00']), original = fileHashes(artifactDir(f)); let v = f.view;
    assert.equal(v.reviewState, 'pending_review');
    for (const action of ['request_materials', 'reject', 'confirm_selected_fields']) { v = await recordReviewFeedback(f.store, payload(v, action)); assert.equal(v.current.effectiveConfirmation, action === 'confirm_selected_fields'); assert.equal(v.reviewState, ({ request_materials: 'materials_requested', reject: 'rejected', confirm_selected_fields: 'selected_fields_confirmed' })[action]); assert.equal(v.feedbackStatus, action === 'confirm_selected_fields' ? 'recorded_effective' : 'recorded_current'); }
    assert.equal(v.feedbackStatus, 'recorded_effective'); assert.equal(v.current.confirmedFields.length, 8); assert.equal(v.submittable, false); assert.equal(v.authorizesExecution, false);
    v = await recordReviewFeedback(f.store, payload(v, 'request_materials')); assert.equal(v.current.effectiveConfirmation, false); assert.ok(v.feedbacks.every(f => !f.effectiveConfirmation)); assert.deepEqual(fileHashes(artifactDir(f)), original);
  });
  await test('fresh child restart query/replay same ID is durable and no duplicate receipt', async () => {
    const f = await setup(['385719.00']), p = payload(f.view), v = await recordReviewFeedback(f.store, p); write(join(f.dir, 'feedback.json'), p);
    const c = cli(['inspect', '--store', f.store, '--output', join(f.dir, 'inspect.json')]); assert.equal(c.status, 0, c.stdout + c.stderr); assert.equal(c.signal, null); assert.equal(c.stderr, ''); assert.equal(readJson(join(f.dir, 'inspect.json')).current.effectiveConfirmation, true);
    const r = cli(['feedback', '--store', f.store, '--feedback', join(f.dir, 'feedback.json'), '--output', join(f.dir, 'replay.json')]); assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.signal, null); assert.equal(r.stderr, '');
    const replay = readJson(join(f.dir, 'replay.json')); assert.equal(replay.operation, 'replayed'); assert.equal(replay.feedbackStatus, 'recorded_effective'); assert.equal(replay.journalHead, v.journalHead); assert.equal(replay.feedbacks.length, 1);
  });
  await test('conflicting ID, old CAS, cross enterprise/period and bad digest rejected without new receipts', async () => {
    const f = await setup(), p = payload(f.view), v = await recordReviewFeedback(f.store, p);
    await assert.rejects(recordReviewFeedback(f.store, { ...p, reason: '同ID改原因' }), /feedback_id_conflict/);
    await assert.rejects(recordReviewFeedback(f.store, payload(f.view)), /cas_mismatch/);
    for (const mutate of [x => x.scope.enterpriseKey = 'OTHER', x => x.scope.period = '2026-Q2', x => x.versionId = 'old-version', x => x.binding.inputHash = '0'.repeat(64), x => x.binding.bundleDigest = '0'.repeat(64), x => x.binding.ruleVersion = 'bad', x => x.binding.ruleDigest = '1'.repeat(64), x => x.binding.ledgerSnapshotDigest = '2'.repeat(64)]) { const x = payload(v); mutate(x); await assert.rejects(recordReviewFeedback(f.store, x), /target_mismatch/); }
    const other = fixture(['361947.00']); post(other); await assert.rejects(registerReview(f.store, inputFile(other), { expectedJournalHead: v.journalHead, supersedes: v.current.versionId }), /scope_mismatch/);
    await assert.rejects(registerReview(f.store, inputFile(f), { expectedJournalHead: null, supersedes: null }), /cas_mismatch/); assert.equal((await inspectReviewStore(f.store)).journalHead, v.journalHead);
  });
  await test('strict feedback whitelist/time/role and selected computed fields only', async () => {
    const f = await setup();
    for (const mutate of [x => x.ready = true, x => x.tax = '999', x => x.entries = [], x => x.patch = {}, x => x.reason = ' ', x => x.actor.role = 'owner', x => x.actor.name = '', x => x.actor.signature = 'fake', x => x.occurredAt = '2026-02-30T01:23:45.678Z', x => x.occurredAt = '2026-10-24T01:23:45Z', x => x.selectedFields[0].column = 'goods', x => x.selectedFields[0].value = '0', x => x.selectedFields = [{ row: 22, column: 'services', period: 'yearToDate' }], x => x.selectedFields = [], x => x.selectedFields.push(clone(x.selectedFields[0]))]) { const x = payload(f.view); mutate(x); await assert.rejects(recordReviewFeedback(f.store, x)); }
    const material = payload(f.view, 'request_materials'); material.facts[0].formula = 'run'; await assert.rejects(recordReviewFeedback(f.store, material), /fields_invalid/);
    assert.equal((await inspectReviewStore(f.store)).feedbacks.length, 0);
  });
  await test('actual receipt materialStore -> own register -> inspect -> confirm -> fresh child reopen and replay', async () => {
    const f = fixture(['402817.00']); post(f); const materials = join(f.dir, 'receipt-materials');
    await initMaterialStore(materials, f.input.scope); await receiveMaterials(materials, join(f.dir, 'materials.json'));
    const cfg = readJson(inputFile(f)); delete cfg.materialsInput; cfg.materialStore = 'receipt-materials'; write(inputFile(f), cfg);
    f.store = join(f.dir, 'receipt-review'); await initReviewStore(f.store, f.input.scope);
    const v = await registerReview(f.store, inputFile(f), { expectedJournalHead: null, supersedes: null }); assert.equal(v.current.calculationReady, true); assert.equal((await inspectReviewStore(f.store)).status, 'current');
    const manifest = readJson(join(artifactDir(f, v.current), 'manifest.json')); assert.ok(manifest.inputFiles.some(x => x.receiptId));
    const p = payload(v); await recordReviewFeedback(f.store, p); write(join(f.dir, 'receipt-feedback.json'), p);
    const reopened = cli(['feedback', '--store', f.store, '--feedback', join(f.dir, 'receipt-feedback.json'), '--output', join(f.dir, 'receipt-reopen.json')]); assert.equal(reopened.status, 0, reopened.stdout + reopened.stderr); assert.equal(reopened.signal, null); assert.equal(reopened.stderr, ''); assert.equal(readJson(join(f.dir, 'receipt-reopen.json')).feedbackStatus, 'recorded_effective');
    write(join(f.dir, 'sales.csv'), f.sources[0].text + '\n'); const stale = await inspectReviewStore(f.store); assert.equal(stale.current.effectiveConfirmation, false); assert.equal(stale.status, 'stale'); assert.equal((await recordReviewFeedback(f.store, p)).feedbackStatus, 'recorded_stale/history');
  });
  await test('current blocked and unsupported drafts allow original-fact request/reject but refuse confirmation', async () => {
    for (const form of ['unknown', 'natural_person']) {
      const f = await setup(['361947.00'], doc => doc.enterprise.form = form); assert.equal(f.view.current.calculationReady, false);
      await assert.rejects(recordReviewFeedback(f.store, payload(f.view)), /calculation_blocked/);
      let v = await recordReviewFeedback(f.store, payload(f.view, 'request_materials')); v = await recordReviewFeedback(f.store, payload(v, 'reject'));
      assert.equal(v.current.effectiveConfirmation, false); assert.equal(v.feedbacks.length, 2);
    }
  });
  await test('actual original tax file mutation invalidates old confirmation and ID replay remains stale history', async () => {
    const f = await setup(), p = payload(f.view); const v = await recordReviewFeedback(f.store, p);
    write(join(f.dir, 'tax.json'), f.input.taxFacts.text + ' ');
    const changed = await inspectReviewStore(f.store); assert.equal(changed.status, 'stale'); assert.equal(changed.current.effectiveConfirmation, false);
    const repeat = await recordReviewFeedback(f.store, p); assert.equal(repeat.feedbackStatus, 'recorded_stale/history'); assert.equal(repeat.current.effectiveConfirmation, false); assert.equal(repeat.journalHead, v.journalHead);
    await assert.rejects(recordReviewFeedback(f.store, payload(changed)), /version_stale/);
    write(join(f.dir, 'tax.json'), f.input.taxFacts.text); assert.equal((await inspectReviewStore(f.store)).current.effectiveConfirmation, true);
    write(inputFile(f), readFileSync(inputFile(f), 'utf8') + ' '); assert.equal((await inspectReviewStore(f.store)).current.effectiveConfirmation, false);
  });
  await test('actual ledger draft addition and unavailable original DB make previous selected confirmation stale', async () => {
    const f = await setup(), p = payload(f.view); await recordReviewFeedback(f.store, p);
    A.createVoucher(f.id, { period: '2026-03', voucher_date: '2026-03-21', summary: 'synthetic actual extra draft', entries: [{ code: '5602', debit: 17.83 }, { code: '1002', credit: 17.83 }] });
    const changed = await inspectReviewStore(f.store); assert.equal(changed.current.effectiveConfirmation, false); assert.equal(changed.current.freshness, 'stale'); assert.equal((await recordReviewFeedback(f.store, p)).feedbackStatus, 'recorded_stale/history');
    const cfg = readJson(inputFile(f)); cfg.db = join(f.dir, 'missing.db'); write(inputFile(f), cfg); const missing = await inspectReviewStore(f.store); assert.equal(missing.current.effectiveConfirmation, false); assert.equal(missing.history.length, 1); assert.ok(!existsSync(cfg.db));
  });
  await test('wrong original invoice classification -> reject -> user new raw facts -> fresh new version/diff -> new confirmation', async () => {
    const f = await setup(['397531.00'], doc => doc.invoices[0].invoiceClass = 'special'), original = fileHashes(artifactDir(f));
    assert.equal(f.view.current.calculationReady, false); const oldVersion = f.view.current.versionId;
    const rejected = await recordReviewFeedback(f.store, payload(f.view, 'reject'));
    const corrected = taxDocument(f); write(join(f.dir, 'tax-corrected.json'), JSON.stringify(corrected)); const cfg = readJson(inputFile(f)); cfg.taxFacts = 'tax-corrected.json'; write(join(f.dir, 'input-corrected.json'), cfg);
    const next = await registerReview(f.store, join(f.dir, 'input-corrected.json'), { expectedJournalHead: rejected.journalHead, supersedes: oldVersion });
    assert.equal(next.reviewState, 'changed_pending_review');
    assert.equal(next.current.calculationReady, true); assert.equal(next.current.effectiveConfirmation, false); assert.equal(next.current.supersedes, oldVersion); assert.equal(next.history[0].state, 'superseded'); assert.equal(next.feedbacks[0].status, 'recorded_stale/history');
    const row22 = next.current.fieldDifferences.find(c => c.row === 22 && c.column === 'services' && c.period === 'current'); assert.deepEqual(row22.before, { status: 'blocked', minor: null, value: null }); assert.deepEqual(row22.after, { status: 'computed', minor: '397531', value: '3975.31' });
    const row21 = next.current.fieldDifferences.find(c => c.row === 21 && c.column === 'services' && c.period === 'current'); assert.equal(row21.after.minor, '0'); assert.ok(!next.current.fieldDifferences.some(c => c.row === 22 && c.period === 'yearToDate'));
    await assert.rejects(recordReviewFeedback(f.store, payload(rejected)), /target_mismatch/);
    const final = await recordReviewFeedback(f.store, payload(next)); assert.equal(final.current.effectiveConfirmation, true); assert.deepEqual(fileHashes(join(f.store, 'artifacts', oldVersion)), original);
    const repeat = await recordReviewFeedback(f.store, rejected.feedbacks[0].payload); assert.equal(repeat.feedbackStatus, 'recorded_stale/history'); assert.equal(repeat.current.effectiveConfirmation, true); assert.equal(repeat.history[0].effectiveConfirmation, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE account_set_id=?').get(f.id).n, 1);
  });
  await test('superseding a previously confirmed version preserves confirmation history without inheriting it', async () => {
    const f = await setup(), p = payload(f.view), confirmed = await recordReviewFeedback(f.store, p), oldHashes = fileHashes(artifactDir(f));
    write(join(f.dir, 'tax.json'), f.input.taxFacts.text + ' ');
    const next = await registerReview(f.store, inputFile(f), { expectedJournalHead: confirmed.journalHead, supersedes: confirmed.current.versionId });
    assert.equal(next.history.length, 2); assert.equal(next.current.effectiveConfirmation, false); assert.equal(next.feedbacks[0].status, 'recorded_stale/history'); assert.deepEqual(fileHashes(artifactDir(f)), oldHashes);
    const repeat = await recordReviewFeedback(f.store, p); assert.equal(repeat.feedbackStatus, 'recorded_stale/history'); assert.equal(repeat.current.effectiveConfirmation, false); assert.equal(repeat.journalHead, next.journalHead);
  });
  await test('real child writer wx lock and two simultaneous writers never append competing heads', async () => {
    const f = await setup(), p = payload(f.view); write(join(f.dir, 'p.json'), p);
    const lockPath = join(f.store, 'writer.lock');
    const locker = spawn(process.execPath, ['--input-type=module', '-e', "import {open,unlink} from 'node:fs/promises'; const h=await open(process.argv[1],'wx'); await h.writeFile('synthetic-held-lock'); await h.sync(); process.stdout.write('HELD\\n'); process.stdin.once('data',async()=>{await h.close();await unlink(process.argv[1]);process.exit(0)});", lockPath], { env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; locker.stderr.on('data', b => stderr += b); const closed = new Promise(resolveClose => locker.on('close', (status, signal) => resolveClose({ status, signal })));
    try { await new Promise((ready, reject) => { locker.stdout.once('data', ready); locker.once('error', reject); }); await assert.rejects(recordReviewFeedback(f.store, p), /EEXIST/); assert.equal((await inspectReviewStore(f.store)).writerBlocked, true); }
    finally { locker.stdin.end('release'); const c = await closed; assert.equal(c.status, 0); assert.equal(c.signal, null); assert.equal(stderr, ''); }
    const code = `import {recordReviewFeedback} from ${JSON.stringify(storeModuleUrl)}; import {readFileSync} from 'node:fs'; try { await recordReviewFeedback(process.argv[1],JSON.parse(readFileSync(process.argv[2]))); process.exitCode=0; } catch {process.exitCode=4;}`;
    const outcomes = await Promise.all([childModule(code, [f.store, join(f.dir, 'p.json')]), childModule(code, [f.store, join(f.dir, 'p.json')])]);
    assert.ok(outcomes.some(o => o.status === 0)); assert.ok(outcomes.every(o => [0, 4].includes(o.status) && o.signal === null && o.stderr === ''));
    const v = await inspectReviewStore(f.store); assert.equal(v.feedbacks.length, 1); assert.equal(readdirSync(join(f.store, 'receipts')).length, 2);
  });
  await test('all referenced historic artifacts/manifest and entire journal verified on every reopen', async () => {
    for (const target of ['bundle.json', 'workpaper.xlsx', 'manifest.json', 'journal', 'gap', 'partial']) {
      const f = await setup(); await recordReviewFeedback(f.store, payload(f.view));
      if (target === 'journal') write(join(f.store, 'receipts', '00000001.json'), '{}');
      else if (target === 'gap') write(join(f.store, 'receipts', '00000004.json'), '{}');
      else if (target === 'partial') write(join(f.store, 'receipts', '00000003.json'), '{');
      else write(join(artifactDir(f), target), 'corrupted');
      await assert.rejects(inspectReviewStore(f.store)); await assert.rejects(recordReviewFeedback(f.store, payload(f.view))); assert.ok(!existsSync(join(f.store, 'writer.lock')));
    }
  });
  await test('source mutation during export leaves uncommitted diagnostic artifact and no effective registration', async () => {
    const f = fixture(); post(f); f.store = join(f.dir, 'store-failure'); await initReviewStore(f.store, f.input.scope); let changed = false;
    const watcher = watch(join(f.store, 'artifacts'), () => { if (!changed && readdirSync(join(f.store, 'artifacts')).length) { changed = true; write(join(f.dir, 'tax.json'), f.input.taxFacts.text + ' '); } });
    try { await assert.rejects(registerReview(f.store, inputFile(f), { expectedJournalHead: null, supersedes: null })); assert.equal(changed, true); assert.equal(readdirSync(join(f.store, 'receipts')).length, 0); assert.equal(readdirSync(join(f.store, 'artifacts')).length, 1); const v = await inspectReviewStore(f.store); assert.equal(v.current, null); assert.equal(v.history.length, 0); }
    finally { watcher.close(); }
  });
  await test('actual current rule bytes in isolated copied runtime invalidate original confirmations across restart', async () => {
    const f = await setup(), p = payload(f.view); await recordReviewFeedback(f.store, p);
    const runtime = join(root, 'isolated-runtime'); cpSync(join(workbench, 'server'), join(runtime, 'server'), { recursive: true });
    const rule = join(runtime, 'server', 'tax-rule-registry.mjs'); write(rule, readFileSync(rule, 'utf8').replace("checkedOn: '2026-10-24'", "checkedOn: '2026-10-25'"));
    const moduleUrl = pathToFileURL(join(runtime, 'server', 'accountant-review-store.mjs')).href, out = join(f.dir, 'rule-result.json');
    const child = await childModule(`import {inspectReviewStore} from ${JSON.stringify(moduleUrl)}; import {writeFileSync} from 'node:fs'; const r=await inspectReviewStore(process.argv[1]); writeFileSync(process.argv[2],JSON.stringify(r));`, [f.store, out]);
    assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null); assert.equal(child.stderr, ''); const v = readJson(out); assert.equal(v.current.effectiveConfirmation, false); assert.equal(v.status, 'stale');
    const liveOut = join(f.dir, 'live-rule.json');
    const live = await childModule(`import {inspectReviewStore} from ${JSON.stringify(moduleUrl)}; import {appendFileSync,writeFileSync} from 'node:fs'; appendFileSync(process.argv[3],'\\n// local test code change'); const r=await inspectReviewStore(process.argv[1]); writeFileSync(process.argv[2],JSON.stringify(r));`, [f.store, liveOut, rule]);
    assert.equal(live.status, 0, live.stderr); assert.equal(live.signal, null); assert.equal(readJson(liveOut).current.effectiveConfirmation, false);
  });
  await test('source change in receipt commit window keeps recorded history and returns stale rather than effective', async () => {
    const f = await setup(), p = payload(f.view); let changed = false;
    const watcher = watch(join(f.store, 'receipts'), () => { if (!changed && existsSync(join(f.store, 'receipts', '00000002.json'))) { changed = true; write(join(f.dir, 'tax.json'), f.input.taxFacts.text + ' '); } });
    try { const result = await recordReviewFeedback(f.store, p); assert.equal(changed, true); assert.equal(result.feedbacks.length, 1); assert.equal(result.feedbackStatus, 'recorded_stale/history'); assert.equal(result.status, 'stale'); assert.equal(result.current.effectiveConfirmation, false); assert.equal((await recordReviewFeedback(f.store, p)).feedbackStatus, 'recorded_stale/history'); }
    finally { watcher.close(); }
  });
  await test('non-tax loader cached code change fails live fresh checks and restarted runtime cannot reuse old binding', async () => {
    const f = await setup(), p = payload(f.view); await recordReviewFeedback(f.store, p); write(join(f.dir, 'old-feedback.json'), p);
    const runtime = join(root, 'isolated-loader-runtime'); cpSync(join(workbench, 'server'), join(runtime, 'server'), { recursive: true });
    const moduleUrl = pathToFileURL(join(runtime, 'server', 'accountant-review-store.mjs')).href, loader = join(runtime, 'server', 'offline-vat-input.mjs'), out = join(f.dir, 'loader-live.json');
    const code = `import {inspectReviewStore,recordReviewFeedback,registerReview} from ${JSON.stringify(moduleUrl)}; import {readFileSync,appendFileSync,writeFileSync} from 'node:fs'; const before=await inspectReviewStore(process.argv[1]); appendFileSync(process.argv[3],'\\n// isolated live loader change'); const after=await inspectReviewStore(process.argv[1]); const p=JSON.parse(readFileSync(process.argv[4]));p.feedbackId='new-after-loader-change'; p.expectedJournalHead=after.journalHead; let feedbackError,registerError; try {await recordReviewFeedback(process.argv[1],p);}catch(e){feedbackError=e.code;} try{await registerReview(process.argv[1],after.current.inputPath,{expectedJournalHead:after.journalHead,supersedes:after.current.versionId});}catch(e){registerError=e.code;} writeFileSync(process.argv[2],JSON.stringify({before,after,feedbackError,registerError}));`;
    const live = await childModule(code, [f.store, out, loader, join(f.dir, 'old-feedback.json')]); assert.equal(live.status, 0, live.stderr); assert.equal(live.signal, null); assert.equal(live.stderr, '');
    const observed = readJson(out); assert.equal(observed.before.current.effectiveConfirmation, true); assert.equal(observed.after.current.effectiveConfirmation, false); assert.equal(observed.feedbackError, 'review_version_stale'); assert.equal(observed.registerError, 'review_code_restart_required');
    const restarted = await childModule(`import {inspectReviewStore} from ${JSON.stringify(moduleUrl)}; import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],JSON.stringify(await inspectReviewStore(process.argv[1])));`, [f.store, join(f.dir, 'loader-restart.json')]); assert.equal(restarted.status, 0, restarted.stderr); assert.equal(restarted.signal, null); assert.equal(readJson(join(f.dir, 'loader-restart.json')).current.effectiveConfirmation, false);
  });
  await test('2000 actual valid receipts remain queryable/replayable and capacity refusal writes no 2001 or artifact', async () => {
    const f = await setup(), initial = readJson(join(f.store, 'receipts', '00000001.json')); let head = initial.digest, last;
    // 直接构造合成的合法链，避免重复 1999 次昂贵的文件/数据库计算。
    for (let sequence = 2; sequence <= 2000; sequence++) {
      last = payload({ ...f.view, journalHead: head }, 'request_materials', 'capacity-' + sequence);
      const body = { version: initial.version, sequence, previousHead: head, metadataDigest: initial.metadataDigest, kind: 'feedback', data: last }, receipt = { ...body, digest: hash(stable(body)) };
      write(join(f.store, 'receipts', String(sequence).padStart(8, '0') + '.json'), stable(receipt) + '\n'); head = receipt.digest;
    }
    const v = await inspectReviewStore(f.store); assert.equal(v.status, 'current'); assert.equal(v.journalHead, head); assert.equal(v.feedbacks.length, 1999);
    assert.equal((await recordReviewFeedback(f.store, last)).operation, 'replayed');
    await assert.rejects(recordReviewFeedback(f.store, payload(v)), /receipt_capacity_reached/);
    assert.equal((await registerReview(f.store, inputFile(f), { expectedJournalHead: head, supersedes: v.current.versionId })).operation, 'replayed');
    const artifacts = readdirSync(join(f.store, 'artifacts')); write(join(f.dir, 'tax.json'), f.input.taxFacts.text + ' ');
    await assert.rejects(registerReview(f.store, inputFile(f), { expectedJournalHead: head, supersedes: v.current.versionId }), /receipt_capacity_reached/);
    assert.equal(readdirSync(join(f.store, 'receipts')).length, 2000); assert.deepEqual(readdirSync(join(f.store, 'artifacts')), artifacts); assert.equal((await inspectReviewStore(f.store)).history.length, 1); assert.ok(!existsSync(join(f.store, 'writer.lock')));
  });
  await test('CLI rejects prototype action names and internal output paths before creating locks or receipts', async () => {
    const f = await setup();
    for (const args of [['constructor', '--store', f.store], ['__proto__'], ['toString']]) { const c = cli(args); assert.equal(c.status, 2); assert.equal(c.stderr, ''); assert.equal(c.stdout, 'ACCOUNTANT_FEEDBACK_USAGE_ERROR\n'); }
    for (const out of [join(f.store, 'writer.lock'), join(f.store, 'receipts', '00000002.json'), join(f.store, 'artifacts', 'poison.json'), join(f.store, '..local.json')]) { const c = cli(['inspect', '--store', f.store, '--output', out]); assert.equal(c.status, 4); assert.equal(c.stderr, ''); assert.ok(!existsSync(out)); }
    const internalInput = join(f.store, '..input.json'); write(internalInput, readFileSync(inputFile(f), 'utf8')); await assert.rejects(registerReview(f.store, internalInput, { expectedJournalHead: f.view.journalHead, supersedes: f.view.current.versionId }), /input_inside_store/);
    const sibling = join(f.dir, '..legitimate'); mkdirSync(sibling); const accepted = cli(['inspect', '--store', f.store, '--output', join(sibling, 'outside.json')]); assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr); assert.ok(existsSync(join(sibling, 'outside.json')));
    assert.equal((await inspectReviewStore(f.store)).writerBlocked, false); assert.equal(readdirSync(join(f.store, 'receipts')).length, 1);
  });
  await test('CLI reserves NEW output before mutation, safe stdout and DB/WAL/logical zero writes', async () => {
    const f = await setup(), p = payload(f.view), out = join(f.dir, 'feedback-result.json'); write(join(f.dir, 'p.json'), p); write(out, 'preexisting');
    const dbFile = join(process.env.WORKBENCH_DATA_DIR, 'workbench.db'), bytes = () => [dbFile, dbFile + '-wal'].map(p => existsSync(p) ? hash(readFileSync(p)) : null);
    const logical = () => stable(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => ({ name, rows: db.prepare('SELECT * FROM "' + name + '"').all() })));
    const before = bytes(), tables = logical(), head = f.view.journalHead;
    const args = ['feedback', '--store', f.store, '--feedback', join(f.dir, 'p.json'), '--output', out]; const rejected = cli(args); assert.equal(rejected.status, 4); assert.equal(rejected.stderr, ''); assert.equal(readFileSync(out, 'utf8'), 'preexisting'); assert.equal((await inspectReviewStore(f.store)).journalHead, head);
    args[args.length - 1] = join(f.dir, 'new-result.json'); const accepted = cli(args); assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr); assert.equal(accepted.signal, null); assert.equal(accepted.stderr, ''); assert.match(accepted.stdout, /^ACCOUNTANT_FEEDBACK_RESULT versions=1 feedbacks=1 effective=1\r?\n$/); assert.ok(!accepted.stdout.includes(f.key));
    assert.deepEqual(bytes(), before); assert.equal(logical(), tables); assert.equal(cli([]).status, 2);
    const unknown = join(f.dir, 'unknown'); mkdirSync(unknown); write(join(f.dir, 'scope.json'), f.input.scope); const init = cli(['init', '--store', unknown, '--scope', join(f.dir, 'scope.json'), '--output', join(f.dir, 'init-result.json')]); assert.equal(init.status, 4); assert.deepEqual(readdirSync(unknown), []);
    const missing = cli(['inspect', '--store', f.store, '--output', join(f.dir, 'no-parent', 'result.json')]); assert.equal(missing.status, 4); assert.equal((await inspectReviewStore(f.store)).feedbacks.length, 1);
  });
} finally {
  db?.close(); console.log(`accountant-review-feedback ${passed}/${passed + failed}; DB actualclose; child close observed; fixtures retained: ${root}`);
}
if (failed) process.exitCode = 1;
