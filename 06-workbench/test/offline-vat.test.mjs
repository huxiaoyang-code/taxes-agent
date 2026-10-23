#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { preflightMaterials } from '../server/offline-materials.mjs';
import { buildOfflineCandidates } from '../server/offline-bookkeeping.mjs';
import { hash, stable } from '../server/offline-material-adapters.mjs';
import { openReadonlyLedgerSource, captureLedgerSnapshot, validateLedgerSnapshot } from '../server/offline-ledger-snapshot.mjs';
import { calculateOfflineVat, vatComparisonSummary, VAT_EXCLUSIONS, VAT_SOURCE_SYSTEM } from '../server/tax-calculation.mjs';
import { VAT_RULE_REGISTRY, getVatRules } from '../server/tax-rule-registry.mjs';
import { persistedVoucherFingerprint } from '../server/import-storage.mjs';
import { initMaterialStore, receiveMaterials } from '../server/offline-material-store.mjs';

const workbench = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = resolve(workbench, '..', '.agent-runs'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'offline-vat-synthetic-'));
process.env.TEMP = root; process.env.TMP = root; process.env.WORKBENCH_DATA_DIR = join(root, 'data');
mkdirSync(process.env.WORKBENCH_DATA_DIR);
let db, source, A, IM, passed = 0, failed = 0, serial = 0;
const test = async (name, work) => { try { await work(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } };
const clone = structuredClone, wrap = value => { const text = JSON.stringify(value); return { text, fileSha256: hash(text) }; };
const write = (path, x) => writeFileSync(path, typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const cell = (p, row, period = 'current', column = 'services') => p.cells.find(c => c.row === row && c.period === period && c.column === column);
const blocked = p => { assert.equal(p.calculationReady, false); for (const row of p.selectedFields) assert.equal(cell(p, row).value, null); assert.equal(p.periodComplete, false); };
const code = (p, code) => assert.ok(p.issues.some(i => i.code === code), JSON.stringify(p.issues));
const cents = v => { const [whole, fract] = v.split('.'); return BigInt(whole) * 100n + BigInt(fract); };
const fmt = n => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
function evidence(scope, evidenceId, role, basis) { return { evidenceId, kind: 'customer_declaration', scope: clone(scope), confirmedBy: { name: 'SENSITIVE-ACCOUNTANT-731', role }, basis }; }
function taxDocument(f) {
  const refs = [{ kind: 'declaration', fileSha256: hash(stable(f.input.declaration)), pointer: '/evidence/1/basis' }];
  const confirm = basis => ({ confirmedBy: { name: 'SENSITIVE-ACCOUNTANT-731', role: 'accountant' }, basis, sourceRefs: clone(refs) });
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
function fixture(amounts = ['100000.00', '100001.00', '100122.00'], extra = false) {
  const n = ++serial, key = 'SYNTHETIC-VAT-' + n, dir = join(root, 'case-' + n); mkdirSync(dir);
  const set = A.createAccountSet({ name: key, start_period: '2026-01', profileId: 'small-2011-basic-v1', enterprise: { enterpriseKey: key } });
  for (const p of ['2026-01', '2026-02', '2026-03']) A.ensurePeriod(set.id, p);
  const scope = { enterpriseKey: key, accountSetId: String(set.id), period: '2026-Q1', currency: 'CNY', unit: 'yuan' };
  const ref = number => ({ sellerKey: key, code: '', number: String(number) });
  const map = role => ({ format: 'invoice-summary-csv-v1', role, dateFormat: 'YYYY-MM-DD', redSign: 'signed_negative', statusLabels: { blue: ['blue'], red: ['red'] }, columns: { number: 'number', date: 'date', sellerKey: 'seller', buyerKey: 'buyer', net: 'net', tax: 'tax', gross: 'gross', status: 'status' } });
  const src = (sourceId, kind, text, mapping) => ({ sourceId, kind, text, mapping, fileSha256: hash(text), scope: clone(scope) });
  const dates = amounts.map((_, i) => `2026-0${i % 3 + 1}-13`);
  const saleRefs = amounts.map((_, i) => ref(1001 + i));
  const sources = amounts.length ? [src('sales', 'invoice_csv', 'number,date,seller,buyer,net,tax,gross,status\n' + amounts.map((amount, i) => {
    const net = cents(amount), tax = net / 100n; return [1001 + i, dates[i], key, 'BUYER', amount, fmt(tax), fmt(net + tax), 'blue'].join(',');
  }).join('\n'), map('sales'))] : [];
  const basic = amounts.map((_, i) => ({ factId: 'basic-' + i, date: dates[i], nature: 'service', performance: 'completed', settlement: 'unpaid', purpose: 'unknown', benefitPeriod: { state: 'unknown', from: null, to: null }, invoiceRef: saleRefs[i] }));
  const factConfirmation = { confirmedBy: { name: 'SENSITIVE-OPERATOR', role: 'business_operator' }, basis: '合成合同、验收及索款登记同日，全部为本期普通主营服务' };
  const af = amounts.map((_, i) => ({ factId: 'sale-' + i, kind: 'service_sale', ...clone(factConfirmation), invoiceRef: saleRefs[i], contractId: 'CONTRACT-' + i, serviceStartDate: dates[i], completionDate: dates[i], collectionRightDate: dates[i], mainService: true, ordinaryService: true }));
  if (extra) {
    sources.push(src('purchase', 'invoice_csv', 'number,date,seller,buyer,net,tax,gross,status\n2001,2026-03-15,SUPPLIER,' + key + ',406.53,12.20,418.73,blue', map('purchase')));
    const purchaseRef = { sellerKey: 'SUPPLIER', code: '', number: '2001' };
    basic.push({ factId: 'basic-admin', date: '2026-03-15', nature: 'service', performance: 'completed', settlement: 'unpaid', purpose: 'unknown', benefitPeriod: { state: 'unknown', from: null, to: null }, invoiceRef: purchaseRef });
    af.push({ factId: 'admin', kind: 'administrative_service', ...clone(factConfirmation), invoiceRef: purchaseRef, contractId: 'ADMIN', completionDate: '2026-03-15', purpose: 'organizational_administration', nonAsset: true, nonProjectCost: true, benefitFrom: '2026-03-01', benefitTo: '2026-03-31', benefitBasis: '当月日常行政服务' });
    const mapping = { format: 'bank-csv-v1', ownerEnterpriseKey: key, bankAccountId: 'bank-A', dateFormat: 'YYYY-MM-DD', amountMode: 'amount_direction', currency: 'CNY', negativeAmount: 'reject', directionLabels: { inflow: ['in'], outflow: ['out'] }, columns: { date: 'date', amount: 'amount', direction: 'direction', refId: 'ref', summary: 'summary' } };
    sources.push(src('bank', 'bank_csv', 'date,amount,direction,ref,summary\n2026-03-20,73.91,out,PREPAY-1,SENSITIVE-BANK', mapping));
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
const snapshot = f => captureLedgerSnapshot(source, { enterpriseKey: f.key, accountSetId: f.id, fromPeriod: '2026-01', toPeriod: '2026-03' });
const calc = (f, s = snapshot(f)) => calculateOfflineVat(f.input, source, s);
const cli = (f, name = 'out.json') => spawnSync(process.execPath, ['scripts/offline-vat.mjs', '--input', join(f.dir, 'input.json'), '--output', join(f.dir, name)], { cwd: workbench, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
try {
  ({ db } = await import('../server/db.mjs')); A = await import('../server/accounting.mjs'); IM = await import('../server/import-incremental.mjs');
  source = openReadonlyLedgerSource(join(process.env.WORKBENCH_DATA_DIR, 'workbench.db'));
  await test('real raw material replay -> automatic candidates -> core posted ledger -> nonzero selected rows and exact links', () => {
    const f = fixture(undefined, true); post(f); const p = calc(f); assert.equal(p.calculationReady, true, JSON.stringify(p.issues));
    assert.deepEqual([1, 2, 3, 15, 16, 20, 21, 22].map(r => cell(p, r).value), ['300123.00', '0.00', '300123.00', '9003.69', '6002.46', '3001.23', '0.00', '3001.23']);
    assert.equal(p.reconciledBusinesses.length, 5); assert.equal(p.sales.length, 3);
    const independentlyExpected = 300123n; assert.equal(BigInt(cell(p, 22).minor), independentlyExpected);
    for (const sale of p.sales) { assert.equal(sale.initialLedgerVatMinor, sale.invoice.data.tax.replace('.', '')); assert.ok(sale.entries.every(e => Number.isInteger(e.entryId) && e.candidateSources.sourceFields.every(r => r.fileSha256 && r.location))); assert.equal(sale.sourceCheck.status, 'matches_persisted_content'); assert.equal(sale.adjustmentMinor, '0'); assert.match(sale.taxFactSource.pointer, /^\/invoices\/\d+$/); }
    assert.equal(p.sales[0].entries[2].accountCode, '2221'); assert.equal(p.accountantApproval, 'pending'); assert.equal(p.sourceAuthenticity, 'unverified'); assert.equal(p.submittable, false); assert.equal(p.reviewReady, true); assert.equal(p.periodComplete, false);
    for (const c of p.cells) if (c.column === 'goods' || !p.selectedFields.includes(c.row)) assert.equal(c.value, null);
    assert.equal(cell(p, 21, 'yearToDate').status, 'not_applicable'); assert.equal(cell(p, 22, 'yearToDate').value, null); assert.equal(cell(p, 15, 'yearToDate').value, '9003.69');
    assert.equal(BigInt(cell(p, 15).minor) - BigInt(cell(p, 16).minor), BigInt(cell(p, 20).minor)); assert.equal(BigInt(cell(p, 20).minor) - BigInt(cell(p, 21).minor), BigInt(cell(p, 22).minor));
  });
  await test('300000 exact threshold is fully taxable and another independently specified amount preserves cents', () => {
    for (const [amount, values] of [['300000.00', ['9000.00', '6000.00', '3000.00']], ['412789.00', ['12383.67', '8255.78', '4127.89']]]) { const f = fixture([amount]); post(f); const p = calc(f); assert.equal(p.calculationReady, true, JSON.stringify(p.issues)); assert.deepEqual([15, 16, 22].map(r => cell(p, r).value), values); }
  });
  await test('below threshold and evidenced empty no-activity book are explicit unsupported, never fabricated zero', () => {
    const f = fixture(['299999.00']); post(f); const p = calc(f); blocked(p); code(p, 'below_threshold_exemption_path_unsupported'); assert.equal(p.status, 'unsupported');
    const empty = fixture([]), z = calc(empty); blocked(z); code(z, 'zero_or_no_sales_path_unsupported'); assert.equal(z.status, 'unsupported', JSON.stringify(z.issues));
  });
  await test('no default qualification, historical opening, payroll and complete coverage evidence each required', () => {
    const f = fixture(['300123.00']); post(f);
    for (const mutate of [d => { delete d.tax; }, d => { d.tax.evidenceIds = ['owner']; }, d => { d.tax.filingFrequency = 'monthly'; }, d => { delete d.opening; }, d => { d.history.state = 'prior_required'; }, d => { d.applicability = []; }, d => { d.coverage[0].state = 'partial'; }, d => { d.bankAccounts.accountIds = ['omitted-account']; }]) {
      const old = clone(f.input.declaration); mutate(f.input.declaration); refreshFacts(f); blocked(calc(f)); f.input.declaration = old;
    } refreshFacts(f); assert.equal(calc(f).calculationReady, true);
  });
  await test('every exclusion is evidenced; unknown/missing blocks, known non-supported fact is unsupported', () => {
    const f = fixture(['300123.00']); post(f);
    for (const area of VAT_EXCLUSIONS) {
      for (const state of ['unknown', 'present', 'absent']) { const t = taxDocument(f), e = t.period.exclusions.find(x => x.area === area); if (state === 'absent') t.period.exclusions = t.period.exclusions.filter(x => x.area !== area); else e.state = state; refreshFacts(f, t); const p = calc(f); blocked(p); code(p, state === 'present' ? 'unsupported_' + area : 'missing_exclusion_' + area); }
    }
  });
  await test('special invoices, overseas, property, land, construction, natural persons and missing ordinary evidence fail closed', () => {
    const f = fixture(['300123.00']); post(f);
    for (const patch of [{ invoiceClass: 'special' }, { invoiceClass: 'unknown' }, { domesticConsumption: 'cross_border' }, { serviceCategory: 'real_estate' }, { serviceCategory: 'land' }, { serviceCategory: 'construction' }]) { const t = taxDocument(f); Object.assign(t.invoices[0], patch); refreshFacts(f, t); blocked(calc(f)); }
    for (const form of ['individual_business', 'natural_person', 'unknown']) { const t = taxDocument(f); t.enterprise.form = form; refreshFacts(f, t); blocked(calc(f)); }
    const t = taxDocument(f); t.invoices = []; refreshFacts(f, t); const missing = calc(f); blocked(missing); assert.equal(missing.issues.find(i => i.code === 'invoice_tax_facts_missing_or_ambiguous').classification, 'missing');
    const conflict = taxDocument(f); conflict.invoices.push({ ...clone(conflict.invoices[0]), invoiceClass: 'special' }); refreshFacts(f, conflict); const ambiguous = calc(f); blocked(ambiguous); assert.equal(ambiguous.issues.find(i => i.code === 'invoice_tax_facts_missing_or_ambiguous').classification, 'conflict');
  });
  await test('tax supplement forbids amounts/bases/entries/account/ready and invalid references or source digests', () => {
    const f = fixture(['300123.00']); post(f);
    for (const key of ['tax', 'taxableBase', 'entries', 'accountCode', 'ready']) { const t = taxDocument(f); t.invoices[0][key] = key === 'ready' ? true : '3001.23'; refreshFacts(f, t); assert.throws(() => calc(f), /fields_invalid/); }
    const t = taxDocument(f); t.invoices[0].sourceRefs[0].pointer = '/evidence/999'; refreshFacts(f, t); assert.throws(() => calc(f), /tax_reference_invalid/);
    refreshFacts(f); f.input.taxFacts.fileSha256 = '0'.repeat(64); assert.throws(() => calc(f), /tax_source_digest_invalid/);
  });
  await test('fractional original net requires unsupported rounding policy; original 3% and book cannot masquerade as final VAT', () => {
    const f = fixture(['300123.01']); post(f); const p = calc(f); blocked(p); code(p, 'fractional_net_requires_rounding_policy'); assert.equal(p.sales[0].adjustmentMinor, null);
    const g = fixture(['300123.00']); g.sources[0].text = g.sources[0].text.replace('3001.23,303124.23', '9003.69,309126.69'); persist(g); reload(g); post(g); const q = calc(g); blocked(q); code(q, 'invoice_one_percent_or_book_tax_adjustment_required');
  });
  await test('nonposted candidate, extra draft, unexplained normal and carryforward posted voucher block tax calculation', () => {
    const f = fixture(['300123.00']); blocked(calc(f)); post(f); const s = snapshot(f), v = s.vouchers[0];
    A.unpostVoucher(f.id, v.id); blocked(calc(f)); A.postVoucher(f.id, v.id);
    const draft = A.createVoucher(f.id, { period: '2026-03', voucher_date: '2026-03-20', summary: 'extra', entries: [{ code: '5602', debit: 12.34 }, { code: '1002', credit: 12.34 }] });
    code(calc(f), 'draft_not_posted'); A.postVoucher(f.id, draft.id); const p = calc(f); blocked(p); code(p, 'unexplained_posted_business_or_carryforward');
  });
  await test('actual amount/account/date/order/source/fingerprint changes reject after capture and cannot be uploaded as trusted evidence', () => {
    const f = fixture(['300123.00']); post(f); const s = snapshot(f), v = s.vouchers[0];
    assert.throws(() => calculateOfflineVat(f.input, source, JSON.parse(JSON.stringify(s))), /ledger_snapshot_untrusted/); assert.throws(() => calculateOfflineVat(f.input, db, s), /ledger_source_unavailable/);
    const mutations = [
      ["UPDATE voucher_entries SET credit=credit+0.01 WHERE voucher_id=? AND line_no=3", "UPDATE voucher_entries SET credit=credit-0.01 WHERE voucher_id=? AND line_no=3"],
      ["UPDATE voucher_entries SET code='5001' WHERE voucher_id=? AND line_no=3", "UPDATE voucher_entries SET code='2221' WHERE voucher_id=? AND line_no=3"],
      ["UPDATE vouchers SET voucher_date='2026-01-14' WHERE id=?", "UPDATE vouchers SET voucher_date='2026-01-13' WHERE id=?"],
      ["UPDATE voucher_entries SET line_no=line_no+10 WHERE voucher_id=?", "UPDATE voucher_entries SET line_no=line_no-10 WHERE voucher_id=?"],
      ["UPDATE import_voucher_sources SET voucher_fingerprint='bad' WHERE voucher_id=?", null],
    ];
    for (const [sql, undo] of mutations) { const saved = db.prepare('SELECT voucher_fingerprint FROM import_voucher_sources WHERE voucher_id=?').get(v.id); db.prepare(sql).run(v.id); try { assert.equal(validateLedgerSnapshot(source, s).status, 'stale'); blocked(calc(f)); } finally { if (undo) db.prepare(undo).run(v.id); else db.prepare('UPDATE import_voucher_sources SET voucher_fingerprint=? WHERE voucher_id=?').run(saved.voucher_fingerprint, v.id); } }
    const p = calc(f, s); assert.equal(p.calculationReady, true);
  });
  await test('candidate match still checks raw source after attacker rewrites matching persisted fingerprint', () => {
    const f = fixture(['300123.00']); post(f); const s = snapshot(f), v = s.vouchers[0];
    db.prepare("UPDATE voucher_entries SET credit=3001.24 WHERE voucher_id=? AND line_no=3").run(v.id);
    const changed = db.prepare('SELECT * FROM vouchers WHERE id=?').get(v.id), entries = db.prepare('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY line_no').all(v.id);
    db.prepare('UPDATE import_voucher_sources SET voucher_fingerprint=? WHERE voucher_id=?').run(persistedVoucherFingerprint(changed, entries), v.id);
    const p = calc(f); blocked(p); assert.equal(snapshot(f).sources.checks[0].status, 'matches_persisted_content'); code(p, 'posted_candidate_content_or_source_mismatch');
  });
  await test('missing source relations/months and prior book balance never imply a zero return', () => {
    const f = fixture(['300123.00']); post(f); db.prepare("DELETE FROM periods WHERE account_set_id=? AND period='2026-02'").run(f.id); code(calc(f), 'ledger_months_missing'); A.ensurePeriod(f.id, '2026-02');
    const g = fixture(['300123.00']); A.setOpeningBalances(g.id, [{ code: '1002', debit: 17.31 }, { code: '3001', credit: 17.31 }]); post(g); blocked(calc(g));
    const sourceId = snapshot(f).sources.voucherSources[0].id; db.prepare('DELETE FROM import_batch_vouchers WHERE voucher_id=?').run(snapshot(f).vouchers[0].id); blocked(calc(f)); code(calc(f), 'posted_candidate_content_or_source_mismatch');
    db.prepare('DELETE FROM import_voucher_sources WHERE id=?').run(sourceId); blocked(calc(f)); code(calc(f), 'candidate_posted_source_missing_or_ambiguous');
  });
  await test('completed real import batch and persistent standard/profile consistency are required', () => {
    const f = fixture(['300123.00']); post(f); const s = snapshot(f), batchId = s.sources.batches[0].batch_id;
    for (const status of ['failed', 'unknown']) { db.prepare('UPDATE import_batches SET status=? WHERE batch_id=?').run(status, batchId); const p = calc(f); blocked(p); code(p, 'source_import_batch_not_completed'); }
    db.prepare("UPDATE import_batches SET status='completed' WHERE batch_id=?").run(batchId); assert.equal(calc(f).calculationReady, true);
    for (const standard of ['企业会计准则', 'unknown']) { db.prepare('UPDATE account_sets SET accounting_standard=? WHERE id=?').run(standard, f.id); const p = calc(f); blocked(p); code(p, 'ledger_profile_standard_mismatch'); }
    db.prepare("UPDATE account_sets SET accounting_standard='小企业会计准则' WHERE id=?").run(f.id); assert.equal(calc(f).calculationReady, true);
  });
  await test('legal unknown facts have specific missing-data reasons without fabricated dates or categories', () => {
    const f = fixture(['300123.00']); post(f); const t = taxDocument(f); t.enterprise.establishedOn = null; refreshFacts(f, t); const p = calc(f); blocked(p); code(p, 'missing_establishment_date'); assert.equal(p.issues.find(i => i.code === 'missing_establishment_date').classification, 'unknown');
    const form = taxDocument(f); form.enterprise.form = 'unknown'; refreshFacts(f, form); const unknownForm = calc(f); blocked(unknownForm); assert.equal(unknownForm.issues.find(i => i.code === 'missing_enterprise_form').classification, 'unknown');
    const u = taxDocument(f); u.invoices[0].invoiceClass = 'unknown'; refreshFacts(f, u); const q = calc(f); blocked(q); code(q, 'missing_invoice_tax_business_facts');
    assert.equal(q.issues.find(i => i.code === 'missing_invoice_tax_business_facts').classification, 'unknown');
    const d = clone(f.input.declaration); d.tax.vatStatus = 'general'; f.input.declaration = d; refreshFacts(f); const g = calc(f); blocked(g); assert.equal(g.issues.find(i => i.code === 'vat_status_unsupported').classification, 'unsupported');
  });
  await test('frozen result never freezes or mutates editable caller facts, scope or raw materials', () => {
    const f = fixture(['300123.00']); post(f); const before = stable(f.input); calc(f); assert.equal(stable(f.input), before); assert.equal(Object.isFrozen(f.input.scope), false); assert.equal(Object.isFrozen(f.input.reports[0].sources[0]), false); f.input.scope.accountSetId = String(f.id); f.input.declaration.tax.filingFrequency = 'unknown'; refreshFacts(f); blocked(calc(f));
  });
  await test('cross enterprise/account-set and cross-period scope cannot reuse current private snapshot', () => {
    const f = fixture(['300123.00']), g = fixture(['300123.00']); post(f); post(g); assert.throws(() => calc(f, snapshot(g)), /tax_ledger_scope_mismatch/);
    const original = clone(f.input.scope); f.input.scope.period = '2026-Q2'; assert.throws(() => calc(f), /tax_ledger_scope_mismatch/); f.input.scope = original;
  });
  await test('historical/future engineering dates and caller supplied ready/candidates never broaden support', () => {
    const f = fixture(['300123.00']); post(f);
    const injected = { ...f.input, candidates: rebuilt(f).candidates }; assert.throws(() => calculateOfflineVat(injected, source, snapshot(f)), /fields_invalid/);
    const tampered = clone(f.input); tampered.reports[0].status = 'ready'; tampered.reports[0].records = []; tampered.reports[0].sources[0].rawContent += 'tamper'; const bad = calculateOfflineVat(tampered, source, snapshot(f)); blocked(bad); assert.ok(bad.issues.some(i => i.code === 'materials_provided_invalid'));
    for (const year of ['2025', '2027']) {
      const g = fixture(['300123.00']); g.input.scope.period = `${year}-Q1`;
      g.input.declaration = JSON.parse(JSON.stringify(g.input.declaration).replaceAll('2026', year)); g.input.declaration.scope = clone(g.input.scope); g.input.declaration.evidence.forEach(e => { e.scope = clone(g.input.scope); });
      const af = JSON.parse(g.input.accountingFacts.text.replaceAll('2026', year)); af.scope = clone(g.input.scope); g.input.accountingFacts = wrap(af);
      for (const s of g.sources) { s.scope = clone(g.input.scope); s.text = s.text.replaceAll('2026', year); }
      persist(g); reload(g); const t = taxDocument(g); t.enterprise.establishedOn = `${year}-01-01`; refreshFacts(g, t);
      const s = captureLedgerSnapshot(source, { enterpriseKey: g.key, accountSetId: g.id, fromPeriod: `${year}-01`, toPeriod: `${year}-03` }); const p = calculateOfflineVat(g.input, source, s); blocked(p); code(p, 'engineering_period_unsupported');
    }
  });
  await test('stable replay, source-only correction and local previous comparison never reuse approval', () => {
    const f = fixture(['300123.00']); post(f); const p = calc(f), again = calc(f); assert.equal(again.contentDigest, p.contentDigest); f.input.previousComputation = vatComparisonSummary(p); assert.equal(calc(f).comparison.status, 'unchanged');
    const before = snapshot(f); const other = fixture(['413579.00']); post(other); assert.equal(validateLedgerSnapshot(source, before).status, 'current'); assert.equal(calc(f).contentDigest, p.contentDigest);
    const original = f.sources[0].text; f.sources[0].text += '\n'; persist(f); reload(f); const rawChanged = calc(f); assert.equal(rawChanged.calculationReady, true); assert.notEqual(rawChanged.inputHash, p.inputHash); assert.equal(rawChanged.comparison.status, 'stale_previous_new_version'); assert.equal(rawChanged.comparison.oldApprovalReusable, false);
    f.sources[0].text = original.replace('300123.00,3001.23,303124.23', '300124.00,3001.24,303125.24'); persist(f); reload(f); blocked(calc(f));
  });
  await test('changed original amounts block old book; independent new fixture verifies revised arithmetic only', () => {
    const f = fixture(['300123.00']); post(f); const old = calc(f);
    f.input.previousComputation = vatComparisonSummary(old);
    f.sources[0].text = f.sources[0].text.replace('300123.00,3001.23,303124.23', '300124.00,3001.24,303125.24'); persist(f); reload(f);
    const stale = calc(f); blocked(stale); assert.equal(stale.comparison.status, 'stale_previous_new_version');
    const independent = fixture(['300124.00']); post(independent); const p = calc(independent);
    assert.equal(cell(p, 15).value, '9003.72'); assert.equal(cell(p, 16).value, '6002.48'); assert.equal(cell(p, 22).value, '3001.24');
    assert.notEqual(p.scope.accountSetId, old.scope.accountSetId); // This is not an existing-book correction/receipt chain.
  });
  await test('rules are recursively frozen and clones do not contaminate next invocation; legal and form dates differ', () => {
    assert.throws(() => { VAT_RULE_REGISTRY.sources.relief.effectiveFrom = '2027-01-01'; }, TypeError);
    const r = getVatRules(); r.selectedRows[15].formula = 'bad'; assert.equal(getVatRules().selectedRows[15].formula, 'row1*3/100');
    const f = fixture(['300123.00']); post(f); const p = calc(f); assert.throws(() => { p.rules.sources.relief.effectiveFrom = 'bad'; }, TypeError); assert.throws(() => { p.cells[0].value = '1.00'; }, TypeError); assert.equal(calc(f).rules.sources.relief.effectiveFrom, '2026-01-01'); assert.equal(p.rules.sources.transition.effectiveFrom, '2026-02-01'); assert.equal(p.rules.engineeringScope.period, '2026-Q1');
    f.input.previousComputation = { ...vatComparisonSummary(calc(f)), ruleVersion: 'old', ruleDigest: '0'.repeat(64), contentDigest: '1'.repeat(64) }; const q = calc(f); assert.ok(q.comparison.changed.includes('ruleVersion')); assert.equal(q.comparison.oldApprovalReusable, false);
  });
  await test('CLI reads actual raw files, explicit DB each run, safe stdout/new wx output, DB logical/file/WAL zero writes', () => {
    const f = fixture(['300123.00']); post(f); persist(f);
    const file = join(process.env.WORKBENCH_DATA_DIR, 'workbench.db');
    const checksums = () => [file, file + '-wal'].map(p => existsSync(p) ? hash(readFileSync(p)) : null);
    const logical = () => stable(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => ({ name, rows: db.prepare('SELECT * FROM "' + name + '"').all() })));
    const bytes = checksums(), tables = logical(); const c = cli(f); assert.equal(c.status, 0, c.stdout + c.stderr); assert.equal(c.signal, null); assert.equal(c.stderr, ''); assert.match(c.stdout, /^OFFLINE_VAT_WRITTEN ready=1 issues=0\r?\n$/); assert.ok(!c.stdout.includes('SENSITIVE')); assert.deepEqual(checksums(), bytes); assert.equal(logical(), tables);
    const p = JSON.parse(readFileSync(join(f.dir, 'out.json'), 'utf8')); assert.equal(cell(p, 22).value, '3001.23'); assert.equal(cli(f).status, 4); assert.equal(JSON.parse(readFileSync(join(f.dir, 'out.json'))).contentDigest, p.contentDigest);
    write(join(f.dir, 'sales.csv'), f.sources[0].text.replace('300123.00,3001.23,303124.23', '300124.00,3001.24,303125.24')); const changed = cli(f, 'changed.json'); assert.equal(changed.status, 3); blocked(JSON.parse(readFileSync(join(f.dir, 'changed.json'))));
    const bad = JSON.parse(readFileSync(join(f.dir, 'input.json'))); delete bad.db; write(join(f.dir, 'input.json'), bad); const rejected = cli(f, 'no-default.json'); assert.equal(rejected.status, 4); assert.equal(rejected.stderr, ''); assert.ok(!existsSync(join(f.dir, 'no-default.json')));
  });
  await test('CLI store inspect is fresh on every call and stale origin cannot fall back to saved report ready', async () => {
    const f = fixture(['300123.00']); post(f); persist(f); const store = join(f.dir, 'store'); await initMaterialStore(store, f.input.scope); await receiveMaterials(store, join(f.dir, 'materials.json'));
    const cfg = JSON.parse(readFileSync(join(f.dir, 'input.json'))); delete cfg.materialsInput; cfg.materialStore = 'store'; write(join(f.dir, 'input.json'), cfg);
    assert.equal(cli(f).status, 0); write(join(f.dir, 'sales.csv'), f.sources[0].text + '\n'); const c = cli(f, 'stale-store.json'); assert.equal(c.status, 4); assert.equal(c.stderr, ''); assert.ok(!existsSync(join(f.dir, 'stale-store.json')));
  });
} finally {
  source?.close(); db?.close(); console.log(`offline-vat ${passed}/${passed + failed}; DB actualclose`);
  if (!failed && process.env.KEEP_FIXTURES !== '1') rmSync(root, { recursive: true, force: true }); else console.log('Synthetic fixtures retained: ' + root);
}
if (failed) process.exitCode = 1;
