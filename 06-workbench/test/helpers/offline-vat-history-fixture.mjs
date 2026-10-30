// 仅使用合成原始蓝图。核心写入限制在全新子进程内。
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { preflightMaterials } from '../../server/offline-materials.mjs';
import { buildOfflineCandidates } from '../../server/offline-bookkeeping.mjs';
import { hash, stable } from '../../server/offline-material-adapters.mjs';
import { VAT_EXCLUSIONS, VAT_SOURCE_SYSTEM } from '../../server/tax-calculation.mjs';
const clone = structuredClone;
const wrap = value => { const text = JSON.stringify(value); return { text, fileSha256: hash(text) }; };
const write = (path, x) => writeFileSync(path, typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const cents = v => { const [whole, fract] = v.split('.'); return BigInt(whole) * 100n + BigInt(fract); };
const fmt = n => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
let root, A, IM, serial = 0;
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

export function createHistoryFixture(directory, options = {}) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'create', directory, JSON.stringify(options)], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null);
  return JSON.parse(child.stdout);
}
export function unpostHistoryFixture(f) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'unpost', f.directory, String(f.id)], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null);
}
if (process.argv[2] === 'unpost') {
  root = resolve(process.argv[3]); process.env.WORKBENCH_DATA_DIR = join(root, 'data'); process.env.TEMP = root; process.env.TMP = root;
  let db;
  try {
    ({ db } = await import('../../server/db.mjs')); A = await import('../../server/accounting.mjs');
    const id = Number(process.argv[4]);
    for (const v of db.prepare("SELECT id FROM vouchers WHERE account_set_id=? AND status='posted'").all(id)) A.unpostVoucher(id, v.id);
  } finally { db?.close(); }
}
if (process.argv[2] === 'create') {
  root = resolve(process.argv[3]); const options = JSON.parse(process.argv[4]); mkdirSync(root, { recursive: true });
  process.env.WORKBENCH_DATA_DIR = join(root, 'data'); process.env.TEMP = root; process.env.TMP = root; mkdirSync(process.env.WORKBENCH_DATA_DIR);
  let db;
  try {
    ({ db } = await import('../../server/db.mjs')); A = await import('../../server/accounting.mjs'); IM = await import('../../server/import-incremental.mjs');
    const f = fixture(options.amounts ?? ['173211.00', '238456.00']);
    if (options.opening) A.setOpeningBalances(f.id, [{ code: '1002', debit: '12.34', credit: '0.00' }, { code: '3001', debit: '0.00', credit: '12.34' }]);
    if (options.post !== false) post(f);
    const requestPath = join(f.dir, 'request.json'); write(requestPath, { version: 'offline-vat-prior-request/1', priorInputPath: 'input.json' });
    process.stdout.write(JSON.stringify({ directory: root, dir: f.dir, inputPath: join(f.dir, 'input.json'), requestPath, dbPath: join(process.env.WORKBENCH_DATA_DIR, 'workbench.db'), id: f.id, key: f.key, scope: f.input.scope }));
  } finally { db?.close(); }
}
