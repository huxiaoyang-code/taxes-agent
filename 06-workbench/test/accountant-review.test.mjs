#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, watch } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ExcelJS from 'exceljs';
import { unzipSync, strFromU8 } from 'fflate';
import { preflightMaterials } from '../server/offline-materials.mjs';
import { buildOfflineCandidates } from '../server/offline-bookkeeping.mjs';
import { hash, stable, sourceText } from '../server/offline-material-adapters.mjs';
import { openReadonlyLedgerSource, captureLedgerSnapshot, validateLedgerSnapshot } from '../server/offline-ledger-snapshot.mjs';
import { calculateOfflineVat, VAT_EXCLUSIONS, VAT_SOURCE_SYSTEM } from '../server/tax-calculation.mjs';
import { initMaterialStore, receiveMaterials } from '../server/offline-material-store.mjs';
import { openVatInputFiles, assertVatInputSessionCurrent } from '../server/offline-vat-input.mjs';
import { createAccountantReview, assertAccountantReviewCurrent } from '../server/accountant-review.mjs';
import { exportAccountantReview, buildAccountantReviewWorkbook } from '../server/accountant-review-export.mjs';
const workbench = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = resolve(workbench, '..', '.agent-runs'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'accountant-review-synthetic-'));
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
function fixture(amounts = ['314159.00', '123456.00'], extra = false) {
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
const snapshot = f => captureLedgerSnapshot(source, { enterpriseKey: f.key, accountSetId: f.id, fromPeriod: '2026-01', toPeriod: '2026-03' });
const calc = (f, s = snapshot(f)) => calculateOfflineVat(f.input, source, s);
const cli = (f, name = 'review') => spawnSync(process.execPath, ['scripts/accountant-review.mjs', '--input', join(f.dir, 'input.json'), '--output', join(f.dir, name)], { cwd: workbench, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });

const review = (f, s = snapshot(f)) => createAccountantReview(f.input, source, s);
const readBook = async bytes => { const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes); return book; };
const allText = book => book.worksheets.flatMap(s => s.getSheetValues().flatMap(r => r ? r.slice(1) : [])).filter(v => v !== undefined);
const noExecutableCells = bytes => {
  for (const [name, bytesPart] of Object.entries(unzipSync(bytes))) if (/\.xml$|\.rels$/.test(name)) { const xml = strFromU8(bytesPart); assert.ok(!/<(?:\w+:)?f(?:\s|>)/.test(xml), name); assert.ok(!/<hyperlink(?:\s|>)/.test(xml), name); assert.ok(!/TargetMode="External"/.test(xml), name); }
};
try {
  ({ db } = await import('../server/db.mjs')); A = await import('../server/accounting.mjs'); IM = await import('../server/import-incremental.mjs');
  source = openReadonlyLedgerSource(join(process.env.WORKBENCH_DATA_DIR, 'workbench.db'));
  await test('fresh raw CSV/JSON -> auto candidates -> actual posted book -> seven sheets exact independent amounts', async () => {
    const f = fixture(undefined, true); post(f);
    const session = await openVatInputFiles(join(f.dir, 'input.json'));
    try {
      const p = createAccountantReview(session.rawInput, session.source, session.snapshot), out = join(f.dir, 'export');
      const manifest = await exportAccountantReview(p, out, { inputSession: session });
      assert.equal(manifest.status, 'complete_draft'); assert.equal(manifest.accountantApproval, 'pending'); assert.equal(manifest.authorizesExecution, false);
      const saved = JSON.parse(readFileSync(join(out, 'bundle.json'))); assert.equal(saved.contentDigest, p.contentDigest);
      for (const item of manifest.files) { const bytes = readFileSync(join(out, item.name)); assert.equal(hash(bytes), item.sha256); assert.equal(bytes.length, item.bytes); }
      const bytes = readFileSync(join(out, 'workpaper.xlsx')), book = await readBook(bytes); noExecutableCells(bytes);
      assert.deepEqual(book.worksheets.map(s => s.name), ['概览', '材料完整性', '申报字段', '计算及调整', '原始来源及凭证索引', '异常', '待确认']);
      const expected = { 1: '437615.00', 2: '0.00', 3: '437615.00', 15: '13128.45', 16: '8752.30', 20: '4376.15', 21: '0.00', 22: '4376.15' };
      const fields = book.getWorksheet('申报字段'); assert.equal(fields.rowCount, 101);
      for (let n = 2; n <= fields.rowCount; n++) { const row = fields.getRow(n), [r, , column, period, state, amount, minor, node] = row.values.slice(1); const selected = column === 'services' && r in expected; const na = period === 'yearToDate' && ['21', '22'].includes(r);
        if (na) { assert.equal(state, 'not_applicable'); assert.equal(amount, '不适用（NA，官方横杠）'); }
        else if (selected) { assert.equal(state, 'computed'); assert.equal(amount, expected[r]); assert.equal(BigInt(minor), cents(expected[r])); assert.ok(node); }
        else { assert.equal(state, 'not_computed'); assert.equal(amount, 'NULL（未计算/未知）'); }
      }
      const nodeExpected = { taxable_base: '437615.00', initial_book_vat: '4376.15', no_adjustment: '0.00', standard_vat: '13128.45', relief: '8752.30', payable: '4376.15', prepaid: '0.00', due: '4376.15', ordinary_only: '0.00' };
      const saleExpected = [ { revenueNetMinor: '314159.00', initialLedgerVatMinor: '3141.59', taxableBaseMinor: '314159.00', adjustmentMinor: '0.00' }, { revenueNetMinor: '123456.00', initialLedgerVatMinor: '1234.56', taxableBaseMinor: '123456.00', adjustmentMinor: '0.00' } ];
      const calculations = book.getWorksheet('计算及调整'); let saleIndex = -1;
      calculations.eachRow((row, n) => { if (n === 1) return; const [kind, id, amount, minor] = row.values.slice(1); if (kind === '计算节点') { assert.equal(amount, nodeExpected[id]); assert.equal(BigInt(minor), cents(nodeExpected[id])); } else { if (kind === 'revenueNetMinor') saleIndex++; assert.equal(amount, saleExpected[saleIndex][kind]); assert.equal(BigInt(minor), cents(amount)); } });
      assert.equal(p.computation.sales[0].entries[2].creditMinor, '314159');
      const index = allText(book).join('\n'); assert.ok(index.includes('000000000000000000001001')); assert.ok(index.includes('=SUM(1+2)中文-1.23@危险')); assert.ok(index.includes('2026-03-20')); assert.ok(index.includes('=会计中文+@-731'));
      assert.ok(index.includes(f.input.reports[0].sources[0].fileSha256)); assert.ok(index.includes('/computation/calculationNodes/')); assert.ok(index.includes('https://')); assert.ok(index.includes('voucherId'));
      assert.ok(manifest.inputFiles.some(x => x.path.endsWith('sales.csv')));
      assert.ok(!JSON.stringify(saved).includes('rawContent')); // 不嵌入源码或 base64 载荷。
      for (const sheet of book.worksheets) sheet.eachRow((row, n) => { if (n > 1) row.eachCell(c => assert.equal(c.type, ExcelJS.ValueType.String)); });
      assert.equal(book.getWorksheet('申报字段').views[0].state, 'frozen');
    } finally { session.close(); }
  });
  await test('actual XLSX material retains binary hash and precise Chinese sheet/cell provenance', async () => {
    const f = fixture(); const csv = f.sources[0], rows = csv.text.split('\n').map(r => r.split(','));
    const original = new ExcelJS.Workbook(), ws = original.addWorksheet('原票'); ws.addRow(['合成原票']); ws.addRow([]); rows.forEach(r => ws.addRow(r));
    const binary = Buffer.from(await original.xlsx.writeBuffer()), path = join(f.dir, 'original.xlsx'); writeFileSync(path, binary);
    const mapping = { ...csv.mapping, format: 'invoice-summary-xlsx-v1', sheet: '原票', headerRow: 3 };
    f.input.reports = [preflightMaterials({ scope: f.input.scope, sources: [{ ...csv, kind: 'invoice_xlsx', text: sourceText('invoice_xlsx', binary), fileSha256: hash(binary), mapping }, ...f.sources.slice(1)] })];
    post(f); const config = JSON.parse(readFileSync(join(f.dir, 'materials.json'))); Object.assign(config.sources[0], { kind: 'invoice_xlsx', path: 'original.xlsx', mapping }); write(join(f.dir, 'materials.json'), config);
    const result = cli(f, 'xlsx'); assert.equal(result.status, 0, result.stdout + result.stderr);
    const bundle = JSON.parse(readFileSync(join(f.dir, 'xlsx', 'bundle.json'))), manifest = JSON.parse(readFileSync(join(f.dir, 'xlsx', 'manifest.json')));
    assert.equal(bundle.computation.cells.find(c => c.row === 22 && c.column === 'services' && c.period === 'current').value, '4376.15');
    const origin = manifest.inputFiles.find(o => o.sourceId === 'sales'); assert.equal(origin.hash, hash(binary)); assert.equal(origin.path, path);
    const book = await readBook(readFileSync(join(f.dir, 'xlsx', 'workpaper.xlsx'))), text = allText(book).join('\n'); assert.ok(text.includes('原票')); assert.ok(text.includes('E4')); assert.ok(text.includes(hash(binary))); assert.ok(!JSON.stringify(bundle).includes(binary.toString('base64')));
  });
  await test('clone/tampered JSON, forged computation and arbitrary source never obtain capability', async () => {
    const f = fixture(); post(f); const b = review(f);
    await assert.rejects(exportAccountantReview(clone(b), join(f.dir, 'clone')), /review_bundle_untrusted/);
    await assert.rejects(buildAccountantReviewWorkbook({ ...b, accountantApproval: 'approved' }), /review_bundle_untrusted/);
    assert.throws(() => createAccountantReview(b.computation, source, snapshot(f)), /fields_invalid/);
    assert.throws(() => createAccountantReview(f.input, db, snapshot(f)), /ledger_source_unavailable/);
    assert.throws(() => createAccountantReview(f.input, source, clone(snapshot(f))), /ledger_snapshot_untrusted/);
    assert.ok(!existsSync(join(f.dir, 'clone'))); assert.equal(b.confirmationStatus, 'pending'); assert.equal(b.computation.accountantApproval, 'pending');
  });
  await test('cross enterprise and period cannot reuse a private snapshot/session', async () => {
    const f = fixture(), g = fixture(); post(f); post(g);
    assert.throws(() => review(f, snapshot(g)), /tax_ledger_scope_mismatch/);
    const old = clone(f.input.scope); f.input.scope.period = '2026-Q2'; assert.throws(() => review(f), /tax_ledger_scope_mismatch/); f.input.scope = old;
    const session = await openVatInputFiles(join(g.dir, 'input.json'));
    try { await assert.rejects(buildAccountantReviewWorkbook(review(f), { inputSession: session }), /input_session_untrusted/); }
    finally { session.close(); }
  });
  await test('missing/unknown/conflicting/unsupported materials stay explicit blocked drafts with no derived tax amounts', async () => {
    for (const kind of ['missing', 'unknown', 'conflict', 'unsupported']) {
      const f = fixture(); post(f); const t = taxDocument(f);
      if (kind === 'missing') t.invoices = []; if (kind === 'unknown') t.enterprise.form = 'unknown'; if (kind === 'conflict') t.invoices.push(clone(t.invoices[0])); if (kind === 'unsupported') t.invoices[0].invoiceClass = 'special'; refreshFacts(f, t);
      const b = review(f); blocked(b.computation); assert.ok(b.exceptions.some(e => e.classification === kind));
      const out = join(f.dir, kind); await exportAccountantReview(b, out); const book = await readBook(readFileSync(join(out, 'workpaper.xlsx')));
      const ws = book.getWorksheet('申报字段'); ws.eachRow((r, n) => { if (n > 1) assert.equal(r.getCell(6).value, r.getCell(5).value === 'not_applicable' ? '不适用（NA，官方横杠）' : 'NULL（未计算/未知）'); });
      assert.equal(JSON.parse(readFileSync(join(out, 'manifest.json'))).status, 'complete_draft'); assert.equal(b.accountantApproval, 'pending');
    }
    const f = fixture(); post(f); f.input.declaration.coverage[0].state = 'partial'; refreshFacts(f); blocked(review(f).computation);
  });
  await test('changed in-memory raw input and actual ledger make old bundle invalid', async () => {
    const f = fixture(); post(f); const b = review(f); const old = f.input.taxFacts.text;
    f.input.taxFacts.text += ' '; await assert.rejects(assertAccountantReviewCurrent(b), /review_input_changed/); f.input.taxFacts.text = old;
    const v = snapshot(f).vouchers[0]; db.prepare("UPDATE vouchers SET summary=summary||'changed' WHERE id=?").run(v.id);
    await assert.rejects(exportAccountantReview(b, join(f.dir, 'stale')), /review_ledger_changed/); assert.ok(!existsSync(join(f.dir, 'stale')));
  });
  await test('loader-derived nested source, declaration and tax payload cannot be altered before minting', async () => {
    const f = fixture(); post(f);
    for (const mutate of [
      raw => { const source = raw.reports[0].sources[0]; source.rawContent += '\n'; source.fileSha256 = hash(source.rawContent); },
      raw => { raw.declaration.evidence[0].basis += '更改'; refreshFacts({ input: raw, saleRefs: f.saleRefs }); },
      raw => { raw.taxFacts.text += ' '; raw.taxFacts.fileSha256 = hash(raw.taxFacts.text); },
    ]) {
      const session = await openVatInputFiles(join(f.dir, 'input.json'));
      try { mutate(session.rawInput); assert.throws(() => createAccountantReview(session.rawInput, session.source, session.snapshot), /input_payload_changed/);
        await assert.rejects(session.assertCurrent(), /input_payload_changed/);
      } finally { session.close(); }
    }
  });
  await test('actual original file replacement invalidates held loader even if saved raw report remains unchanged', async () => {
    const f = fixture(); post(f); const session = await openVatInputFiles(join(f.dir, 'input.json'));
    const originalAssert = session.assertCurrent;
    try { const b = createAccountantReview(session.rawInput, session.source, session.snapshot);
      const inventory = await assertVatInputSessionCurrent(session, session.rawInput, session.source, session.snapshot); inventory.length = 0;
      assert.ok((await assertVatInputSessionCurrent(session, session.rawInput, session.source, session.snapshot)).length > 0);
      write(join(f.dir, 'sales.csv'), f.sources[0].text + '\n');
      session.assertCurrent = async () => {}; // 改变外观对象不能替换私有保护。
      await assert.rejects(assertVatInputSessionCurrent(session, session.rawInput, session.source, session.snapshot), /input_changed/);
      await assert.rejects(exportAccountantReview(b, join(f.dir, 'stale-file'), { inputSession: session }), /input_changed/);
      await assert.rejects(exportAccountantReview(b, join(f.dir, 'omitted-session')), /input_changed/);
      assert.ok(!existsSync(join(f.dir, 'omitted-session'))); assert.ok(!existsSync(join(f.dir, 'stale-file')));
    } finally { session.close(); }
    await assert.rejects(originalAssert(), /input_session_closed/);
  });
  await test('store reopens actual receipts and refuses stale original files', async () => {
    const f = fixture(); post(f); const store = join(f.dir, 'store'); await initMaterialStore(store, f.input.scope); await receiveMaterials(store, join(f.dir, 'materials.json'));
    const cfg = JSON.parse(readFileSync(join(f.dir, 'input.json'))); delete cfg.materialsInput; cfg.materialStore = 'store'; write(join(f.dir, 'input.json'), cfg);
    assert.equal(cli(f, 'store-out').status, 0);
    const manifest = JSON.parse(readFileSync(join(f.dir, 'store-out', 'manifest.json')));
    const origin = manifest.inputFiles.find(x => x.sourceId === 'sales'); assert.equal(origin.path, join(f.dir, 'sales.csv')); assert.ok(origin.receiptId); assert.ok(origin.sourceVersion); assert.equal(origin.fileSha256, hash(readFileSync(origin.path)));
    const book = await readBook(readFileSync(join(f.dir, 'store-out', 'workpaper.xlsx'))); assert.ok(allText(book).some(v => v.includes(origin.path.replaceAll('\\', '\\\\')) || v.includes(origin.receiptId)));
    write(join(f.dir, 'sales.csv'), f.sources[0].text + '\n'); const c = cli(f, 'store-stale'); assert.equal(c.status, 4); assert.equal(c.stderr, ''); assert.ok(!existsSync(join(f.dir, 'store-stale')));
  });
  await test('oversized external text remains complete in JSON and is explicitly referenced from XLSX', async () => {
    const f = fixture(); post(f); const draft = A.createVoucher(f.id, { period: '2026-03', voucher_date: '2026-03-28', summary: 'draft', entries: [{ code: '5602', debit: 1.23 }, { code: '1002', credit: 1.23 }] });
    const long = '=中文-@+' + '长'.repeat(40000); db.prepare('UPDATE vouchers SET summary=? WHERE id=?').run(long, draft.id);
    db.prepare('UPDATE voucher_entries SET debit=-1.23,summary=? WHERE voucher_id=? AND line_no=1').run('控制\u0001原文', draft.id);
    const b = review(f), out = join(f.dir, 'long'); blocked(b.computation); const m = await exportAccountantReview(b, out);
    assert.ok(m.displayDiagnostics.some(d => d.reason === 'excel_cell_text_limit' && d.pointer.includes('summary')));
    assert.ok(m.displayDiagnostics.some(d => d.reason === 'excel_xml_control_character'));
    const saved = JSON.parse(readFileSync(join(out, 'bundle.json'))); assert.equal(saved.ledgerSnapshot.vouchers.find(v => v.id === draft.id).summary, long);
    const bytes = readFileSync(join(out, 'workpaper.xlsx')), book = await readBook(bytes); assert.ok(allText(book).some(v => v.includes('完整内容见 bundle.json#'))); assert.ok(allText(book).includes('-1.23')); noExecutableCells(bytes);
    for (const v of allText(book)) assert.ok(v.length <= 32767);
  });
  await test('exclusive new directory and parent failure never overwrite files or claim completion', async () => {
    const f = fixture(); post(f); const b = review(f), out = join(f.dir, 'existing'); mkdirSync(out); write(join(out, 'keep'), 'untouched');
    await assert.rejects(exportAccountantReview(b, out)); assert.equal(readFileSync(join(out, 'keep'), 'utf8'), 'untouched'); assert.ok(!existsSync(join(out, 'manifest.json')));
    await assert.rejects(exportAccountantReview(b, join(f.dir, 'missing-parent', 'out'))); assert.ok(!existsSync(join(f.dir, 'missing-parent')));
  });
  await test('real second-file write failure preserves first file and has no success manifest', async () => {
    const f = fixture(); post(f); const b = review(f), out = join(f.dir, 'partial'); let planted = false;
    const watcher = watch(f.dir, () => { if (!planted && existsSync(out)) { planted = true; mkdirSync(join(out, 'workpaper.xlsx')); } });
    try { await assert.rejects(exportAccountantReview(b, out)); assert.equal(planted, true); assert.ok(existsSync(join(out, 'bundle.json'))); assert.ok(!existsSync(join(out, 'manifest.json'))); }
    finally { watcher.close(); }
  });
  await test('real manifest open failure leaves both detail files without a valid success marker', async () => {
    const f = fixture(); post(f); const out = join(f.dir, 'manifest-failure'); let planted = false;
    const watcher = watch(f.dir, () => { if (!planted && existsSync(out)) { planted = true; mkdirSync(join(out, 'manifest.json')); } });
    try { await assert.rejects(exportAccountantReview(review(f), out)); assert.equal(planted, true); assert.ok(existsSync(join(out, 'bundle.json'))); assert.ok(existsSync(join(out, 'workpaper.xlsx'))); assert.throws(() => JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))); }
    finally { watcher.close(); }
  });
  await test('actual input mutation during multi-file output prevents completion manifest', async () => {
    const f = fixture(); post(f); const session = await openVatInputFiles(join(f.dir, 'input.json')), out = join(f.dir, 'changed-mid-write'); let changed = false;
    const watcher = watch(f.dir, () => { if (!changed && existsSync(out)) { changed = true; write(join(f.dir, 'tax.json'), session.rawInput.taxFacts.text + ' '); } });
    const originalAssert = session.assertCurrent;
    try { const b = createAccountantReview(session.rawInput, session.source, session.snapshot); await assert.rejects(exportAccountantReview(b, out, { inputSession: session }), /input_changed/); assert.equal(changed, true); assert.ok(!existsSync(join(out, 'manifest.json'))); }
    finally { watcher.close(); session.close(); }
  });
  await test('CLI safe statuses, blocked output, no default DB and source closure; DB/WAL and logical zero writes', async () => {
    const f = fixture(); post(f);
    const file = join(process.env.WORKBENCH_DATA_DIR, 'workbench.db');
    const bytes = () => [file, file + '-wal'].map(p => existsSync(p) ? hash(readFileSync(p)) : null);
    const logical = () => stable(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => ({ name, rows: db.prepare('SELECT * FROM "' + name + '"').all() })));
    const before = bytes(), tables = logical(), c = cli(f); assert.equal(c.status, 0, c.stdout + c.stderr); assert.equal(c.signal, null); assert.equal(c.stderr, ''); assert.match(c.stdout, /^ACCOUNTANT_REVIEW_WRITTEN draft=1 ready=1 issues=0\r?\n$/); assert.ok(!c.stdout.includes(f.key)); assert.deepEqual(bytes(), before); assert.equal(logical(), tables);
    assert.equal(cli(f).status, 4); const tax = taxDocument(f); tax.enterprise.form = 'unknown'; refreshFacts(f, tax); persist(f); const blockedCli = cli(f, 'blocked-cli'); assert.equal(blockedCli.status, 3); assert.equal(blockedCli.stderr, ''); assert.ok(existsSync(join(f.dir, 'blocked-cli', 'manifest.json')));
    const cfg = JSON.parse(readFileSync(join(f.dir, 'input.json'))); delete cfg.db; write(join(f.dir, 'input.json'), cfg); assert.equal(cli(f, 'no-db').status, 4); assert.ok(!existsSync(join(f.dir, 'no-db')));
    const usage = spawnSync(process.execPath, ['scripts/accountant-review.mjs'], { cwd: workbench, encoding: 'utf8' }); assert.equal(usage.status, 2); assert.equal(usage.stderr, '');
  });
} finally {
  source?.close(); db?.close(); console.log(`accountant-review ${passed}/${passed + failed}; DB/source actualclose`);
  if (!failed && process.env.KEEP_FIXTURES !== '1') rmSync(root, { recursive: true, force: true }); else console.log('Synthetic fixtures retained: ' + root);
}
if (failed) process.exitCode = 1;
