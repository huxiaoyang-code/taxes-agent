// All materials and ledgers below are synthetic and isolated before importing DB modules.
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sourceBytes, sourceText, hash, stable } from '../server/offline-material-adapters.mjs';
import { preflightMaterials } from '../server/offline-materials.mjs';
import { replayReports } from '../server/material-completeness.mjs';
import { planOffline } from '../server/offline-task-planner.mjs';
import { buildOfflineCandidates } from '../server/offline-bookkeeping.mjs';
import { initMaterialStore, receiveMaterials, inspectMaterialStore } from '../server/offline-material-store.mjs';
import { openReadonlyLedgerSource, captureLedgerSnapshot } from '../server/offline-ledger-snapshot.mjs';
import { VAT_EXCLUSIONS, VAT_SOURCE_SYSTEM, calculateOfflineVat } from '../server/tax-calculation.mjs';

const wbDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'), parent = resolve(wbDir, '..', '.agent-runs'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'offline-xlsx-synthetic-'));
process.env.TEMP = root; process.env.TMP = root; process.env.WORKBENCH_DATA_DIR = join(root, 'data'); mkdirSync(process.env.WORKBENCH_DATA_DIR);
const clone = structuredClone, json = v => JSON.stringify(v), wrap = v => { const text = json(v); return { text, fileSha256: hash(text) }; };
let passed = 0, failed = 0, db, source, A, IM;
const test = async (name, run) => { try { await run(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } };
const scope = { enterpriseKey: 'SYNTHETIC-XLSX', accountSetId: 'BOOK', period: '2026-Q1', currency: 'CNY', unit: 'yuan' };
const map = () => ({ format: 'invoice-summary-xlsx-v1', sheet: '原票', headerRow: 3, role: 'sales', dateFormat: 'YYYY-MM-DD', redSign: 'signed_negative', statusLabels: { blue: ['blue'], red: ['red'] }, columns: { number: 'number', date: 'date', sellerKey: 'seller', buyerKey: 'buyer', net: 'net', tax: 'tax', gross: 'gross', status: 'status' } });
const row = s => ['00001973100489', '2026-03-12', s.enterpriseKey, 'SYNTHETIC-BUYER', 531.79, 5.32, 537.11, 'blue'];
async function workbook({ data = row(scope), shared = true, modify, s = scope } = {}) {
  const w = new ExcelJS.Workbook(); w.addWorksheet('无关表').addRow(['ignored']); const sheet = w.addWorksheet('原票');
  sheet.getRow(1).values = ['合成原始汇总']; sheet.getRow(3).values = Object.values(map().columns); sheet.getRow(4).values = data;
  if (modify) modify(sheet, w); const bytes = Buffer.from(await w.xlsx.writeBuffer({ useSharedStrings: shared }));
  const file = join(root, 'xlsx-' + (++workbook.serial) + '.xlsx'); writeFileSync(file, bytes); return readFileSync(file);
}
workbook.serial = 0;
const src = (bytes, s = scope, mapping = map(), sourceId = 'sales') => ({ sourceId, kind: 'invoice_xlsx', scope: clone(s), mapping, text: sourceText('invoice_xlsx', bytes), fileSha256: hash(bytes) });
const report = (sources, s = scope) => preflightMaterials({ scope: s, sources });
const valid = (bytes, mapping = map()) => { const p = report([src(bytes, scope, mapping)]); assert.notEqual(p.status, 'rejected', json(p.errors)); return p; };
const reject = (bytes, codes, mapping = map()) => { const p = report([src(bytes, scope, mapping)]); assert.equal(p.status, 'rejected'); if (codes) assert.ok(codes.includes(p.errors[0].code), json(p.errors)); return p; };
function changePart(bytes, name, update) { const e = unzipSync(bytes); e[name] = strToU8(update(strFromU8(e[name]))); return Buffer.from(zipSync(e)); }
const child = args => { const c = spawnSync(process.execPath, args, { cwd: wbDir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }); assert.equal(c.signal, null); assert.equal(c.stderr, ''); return c; };
const write = (path, value) => writeFileSync(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value));
const input = (sources, s, declaration, accountingFacts) => ({ scope: s, reports: [report(sources, s)], declaration, profileId: 'small-2011-basic-v1', accountingFacts: wrap(accountingFacts) });
function declaration(s, bank = true) {
  const ev = (evidenceId, role) => ({ evidenceId, kind: 'customer_declaration', scope: clone(s), confirmedBy: { name: 'SYNTHETIC-CONFIRMER', role }, basis: '合成完整Q1合同、发票、银行与登记资料核对' });
  return { version: 'offline-declaration/1', scope: clone(s), profile: 'small-2011', businessScope: 'service-company', evidence: [ev('owner', 'owner'), ev('accountant', 'accountant')], enterpriseEvidenceIds: ['owner'], bankAccounts: { accountIds: bank ? ['bank-A'] : [], evidenceIds: ['owner'] },
    coverage: ['sales', 'purchase', ...(bank ? ['bank'] : [])].map(kind => ({ kind, accountId: kind === 'bank' ? 'bank-A' : null, from: '2026-01', to: '2026-03', state: kind === 'purchase' ? 'no_activity' : 'complete', sourceIds: kind === 'purchase' ? [] : [kind], evidenceIds: ['owner'] })), tax: { vatStatus: 'small_scale', filingFrequency: 'quarterly', evidenceIds: ['accountant'] }, applicability: ['payroll', 'assets'].map(area => ({ area, present: false, evidenceIds: ['owner'] })), opening: { state: 'new_zero', evidenceIds: ['accountant'] }, history: { state: 'first_period', evidenceIds: ['accountant'] }, bankFacts: bank ? [{ bankAccountId: 'bank-A', refId: 'PAY-1', nature: 'operating_payment', evidenceIds: ['owner'] }] : [] };
}
function businessSources(s, number = row(s)[0]) {
  const ref = { sellerKey: s.enterpriseKey, code: '', number };
  const b = { version: 'business-facts/1', scope: s, facts: [{ factId: 'service-basic', date: '2026-03-12', nature: 'service', performance: 'completed', settlement: 'unpaid', purpose: 'unknown', benefitPeriod: { state: 'unknown', from: null, to: null }, invoiceRef: ref }] };
  const bankMap = { format: 'bank-csv-v1', ownerEnterpriseKey: s.enterpriseKey, bankAccountId: 'bank-A', dateFormat: 'YYYY-MM-DD', amountMode: 'amount_direction', currency: 'CNY', negativeAmount: 'reject', directionLabels: { inflow: ['in'], outflow: ['out'] }, columns: { date: 'date', amount: 'amount', direction: 'direction', refId: 'ref', summary: 'summary' } };
  return [{ sourceId: 'business', kind: 'business_json', scope: clone(s), mapping: { format: 'business-facts-json-v1' }, ...wrap(b) }, { sourceId: 'bank', kind: 'bank_csv', scope: clone(s), mapping: bankMap, text: 'date,amount,direction,ref,summary\n2026-03-20,182.49,out,PAY-1,SYNTHETIC', fileSha256: hash('date,amount,direction,ref,summary\n2026-03-20,182.49,out,PAY-1,SYNTHETIC') }];
}
function accountingFacts(s, number = row(s)[0]) {
  const conf = { confirmedBy: { name: 'SYNTHETIC-OPERATOR', role: 'business_operator' }, basis: '合成合同验收及收款权利登记' };
  return { version: 'offline-accounting-facts/1', scope: s, facts: [{ factId: 'sale', kind: 'service_sale', ...conf, invoiceRef: { sellerKey: s.enterpriseKey, code: '', number }, contractId: 'SALE', serviceStartDate: '2026-03-01', completionDate: '2026-03-12', collectionRightDate: '2026-03-12', mainService: true, ordinaryService: true }, { factId: 'prepay', kind: 'service_prepayment', ...conf, bankRef: { bankAccountId: 'bank-A', refId: 'PAY-1' }, contractId: 'FUTURE', supplierKey: 'SUPPLIER', serviceStartDate: '2026-04-01', serviceEndDate: '2026-06-30', ordinaryService: true, performanceThroughPeriodEnd: 'not_started', refundThroughPeriodEnd: 'none', paymentCount: 1, otherRecognitionInProvidedMaterials: 'none', relatedInvoiceRefs: [] }] };
}
let original;
try {
  original = await workbook();
  await test('actual ExcelJS binary -> exact cents, original sheet2/A1, raw hash and repeat replay', () => {
    const p = valid(original), r = p.records[0]; assert.deepEqual([r.data.number, r.data.net, r.data.tax, r.data.gross], ['00001973100489', '531.79', '5.32', '537.11']);
    assert.equal(r.location.sheet, '原票'); assert.equal(r.location.row, 4); assert.equal(r.location.fields.net.cell, 'E4'); assert.equal(r.fileSha256, hash(original)); assert.notEqual(r.fileSha256, hash(p.sources[0].rawContent));
    assert.deepEqual(replayReports(scope, [p]).records, p.records); assert.deepEqual(replayReports(scope, [p]).records, p.records); assert.ok(!p.missingKinds.includes('invoice_csv')); assert.equal(p.authorizesExecution, false);
  });
  await test('inline string and shared string workbooks preserve leading zero identity and text amounts', async () => {
    let b = await workbook({ shared: false, data: ['00001973100489', '2026-03-12', scope.enterpriseKey, 'SYNTHETIC-BUYER', '531.79', '5.32', '537.11', 'blue'] });
    // ExcelJS document writer always shares strings; construct an explicit valid inline cell variant.
    b = changePart(b, 'xl/worksheets/sheet2.xml', text => text.replace(/<c r="A4" t="s"><v>\d+<\/v><\/c>/, '<c r="A4" t="inlineStr"><is><t>00001973100489</t></is></c>'));
    write(join(root, 'actual-inline.xlsx'), b); const p = valid(readFileSync(join(root, 'actual-inline.xlsx'))); assert.equal(p.records[0].data.number, '00001973100489'); assert.equal(p.records[0].data.gross, '537.11');
    assert.match(strFromU8(unzipSync(b)['xl/worksheets/sheet2.xml']), /inlineStr/);
  });
  await test('CSV semantics equal XLSX; same business duplicate and changed amount conflict across formats', () => {
    const x = src(original), { sheet, headerRow, ...m } = map(), csvMap = { ...m, format: 'invoice-summary-csv-v1' }, text = Object.values(m.columns).join(',') + '\n' + row(scope).join(',');
    const c = { sourceId: 'csv', kind: 'invoice_csv', scope: clone(scope), mapping: csvMap, text, fileSha256: hash(text) };
    const p = report([x, c]); assert.equal(p.records[0].docId, p.records[1].docId); assert.equal(p.records[0].semanticDigest, p.records[1].semanticDigest); assert.equal(p.counts.duplicates, 2);
    c.text = text.replace('531.79,5.32,537.11', '531.80,5.32,537.12'); c.fileSha256 = hash(c.text); const conflict = report([x, c]); assert.equal(conflict.status, 'blocked_conflict'); assert.equal(conflict.counts.conflicts, 2);
  });
  await test('base64 is canonical and bounded at actual 5MiB without regex recursion', () => {
    const boundary = Buffer.alloc(5 * 1024 * 1024, 17); assert.deepEqual(sourceBytes('invoice_xlsx', sourceText('invoice_xlsx', boundary)), boundary);
    for (const text of ['YQ', 'YQ==\n', 'YR==', '=AAA', sourceText('invoice_xlsx', Buffer.alloc(boundary.length + 1))]) assert.throws(() => sourceBytes('invoice_xlsx', text), e => e.code === 'source_digest_invalid');
    const s = src(original); s.fileSha256 = hash(s.text); assert.equal(report([s]).errors[0].code, 'source_digest_invalid');
  });
  await test('missing sheet/header, duplicate header and missing mapped value reject', async () => {
    reject(original, ['xlsx_sheet_missing'], { ...map(), sheet: 'not-there' }); reject(original, ['xlsx_header_missing'], { ...map(), headerRow: 2 });
    reject(await workbook({ modify: s => { s.getCell('I3').value = 'net'; } }), ['xlsx_header_ambiguous']);
    reject(await workbook({ modify: s => { s.getCell('E4').value = null; } }), ['amount_invalid', 'xlsx_cell_invalid']);
  });
  await test('numeric identity/date, invalid date and different enterprise never guessed', async () => {
    for (const [column, value, codes] of [['A4', 1973100489, ['xlsx_text_required']], ['A4', 12345678901234568, ['xlsx_text_required']], ['B4', 46093, ['xlsx_text_required']], ['B4', '2026-02-30', ['date_invalid']], ['C4', 'OTHER', ['enterprise_mismatch']]]) reject(await workbook({ modify: s => { s.getCell(column).value = value; } }), codes);
  });
  await test('cached formulas, errors, bools, merged and unknown cell types reject', async () => {
    reject(await workbook({ modify: s => { s.getCell('E4').value = { formula: '500+31.79', result: 531.79 }; } }), ['xlsx_formula_unsupported']);
    reject(await workbook({ modify: s => { s.getCell('E4').value = { error: '#VALUE!' }; } }), ['xlsx_cell_type_unsupported']);
    reject(await workbook({ modify: s => { s.getCell('E4').value = true; } }), ['xlsx_cell_type_unsupported']);
    reject(await workbook({ modify: s => s.mergeCells('A4:B4') }), ['xlsx_structure_unsupported']);
    reject(changePart(original, 'xl/worksheets/sheet2.xml', s => s.replace('<c r="E4">', '<c r="E4" t="weird">')), ['xlsx_cell_type_unsupported']);
  });
  await test('raw numeric lexical precision, scientific, percent/currency/date formats not rounded or normalized', async () => {
    for (const value of ['531.79000000000001', '5.3179E2', '531.791', 'NaN', 'Infinity']) reject(changePart(original, 'xl/worksheets/sheet2.xml', s => s.replace('<v>531.79</v>', `<v>${value}</v>`)), ['amount_invalid']);
    for (const numFmt of ['0.00%', 'yyyy-mm-dd', '"¥"0.00', '0.000']) reject(await workbook({ modify: s => { s.getCell('E4').numFmt = numFmt; } }), ['xlsx_numeric_format_unsupported']);
    for (const numFmt of ['0', '0.00']) assert.equal(valid(await workbook({ modify: s => { s.getCell('E4').numFmt = numFmt; } })).records[0].data.net, '531.79');
  });
  await test('rich text and OOXML escapes explicitly unsupported; XML grammar/DTD/tree corruption rejects', async () => {
    reject(await workbook({ modify: s => { s.getCell('A4').value = { richText: [{ text: '0000' }, { text: '1973100489' }] }; } }), ['xlsx_structure_unsupported']);
    reject(changePart(original, 'xl/sharedStrings.xml', s => s.replace('SYNTHETIC-BUYER', '_x0053_YNTHETIC-BUYER')), ['xlsx_string_escape_unsupported']);
    reject(changePart(original, 'xl/worksheets/sheet2.xml', s => s.replace('<sheetData>', '<sheetData><row r="9"><sheetData/></row>')), ['xlsx_structure_unsupported']);
    reject(changePart(original, 'xl/worksheets/sheet2.xml', s => s.replace('</sheetData>', '</bad>')), ['xlsx_xml_invalid']);
    reject(changePart(original, 'xl/worksheets/sheet2.xml', s => s.replace('?>', '?><!DOCTYPE worksheet [<!ENTITY x "53">]>')), ['xlsx_structure_unsupported']);
  });
  await test('actual external relationships, hidden selected sheet and encrypted/nonZIP/truncated containers reject', async () => {
    reject(await workbook({ modify: s => { s.getCell('I4').value = { text: 'link', hyperlink: 'https://example.com/' }; } }), ['xlsx_external_link_unsupported']);
    reject(await workbook({ modify: s => { s.state = 'hidden'; } }), ['xlsx_structure_unsupported']);
    for (const bytes of [Buffer.from('notzip'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), original.subarray(0, original.length - 50)]) reject(bytes, ['xlsx_zip_or_xml_invalid', 'xlsx_zip_invalid']);
  });
  await test('macro relationship/contenttype with innocuous filename, OLE and unknown parts reject', () => {
    for (const type of ['http://schemas.microsoft.com/office/2006/relationships/vbaProject', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject', 'urn:unknown']) {
      let b = changePart(original, 'xl/_rels/workbook.xml.rels', text => text.replace('</Relationships>', `<Relationship Id="rId999" Type="${type}" Target="code.bin"/></Relationships>`));
      const e = unzipSync(b); e['xl/code.bin'] = new Uint8Array([0, 1, 2]); b = Buffer.from(zipSync(e));
      reject(b, ['xlsx_structure_unsupported', 'xlsx_external_link_unsupported']);
    }
    reject(changePart(original, '[Content_Types].xml', text => text.replace('</Types>', '<Override PartName="/xl/code.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>')), ['xlsx_structure_unsupported', 'xlsx_part_missing']);
  });
  await test('ZIP declared sizes, actual decompression, entry limits and cell dimensions bounded', async () => {
    const e = unzipSync(original); e['huge.xml'] = new Uint8Array(4 * 1024 * 1024 + 1); reject(Buffer.from(zipSync(e)), ['xlsx_limit']);
    // Synthetic archive fault only: locate central signatures to lie about uncompressed size.
    // Product never parses ZIP binary headers. This proves streaming bytes catch the lie.
    const lying = Buffer.from(zipSync({ ...unzipSync(original), 'inflated.bin': new Uint8Array(2 * 1024 * 1024).fill(65) }));
    let changed = false;
    for (let i = 0; i + 46 < lying.length; i++) if (lying.readUInt32LE(i) === 0x02014b50 && lying.subarray(i + 46, i + 46 + lying.readUInt16LE(i + 28)).toString() === 'inflated.bin') { lying.writeUInt32LE(1, i + 24); changed = true; break; }
    assert.equal(changed, true); reject(lying, ['xlsx_zip_invalid']);
    const many = { ...unzipSync(original) }; for (let i = 0; i < 101; i++) many['n-' + i] = new Uint8Array(); reject(Buffer.from(zipSync(many)), ['xlsx_zip_invalid']);
    reject(await workbook({ modify: s => { s.getCell('IW4').value = 'too-far'; } }), ['xlsx_limit']);
    reject(await workbook({ modify: s => { s.getCell('A10001').value = 'too-many'; } }), ['xlsx_limit']);
  });
  await test('dangling existing relationships and duplicate workbook sheet targets never imply valid material', () => {
    const missing = unzipSync(original); delete missing['xl/styles.xml']; reject(Buffer.from(zipSync(missing)), ['xlsx_part_missing']);
    reject(changePart(original, 'xl/workbook.xml', text => text.replace('sheetId="2"', 'sheetId="1"')), ['xlsx_structure_unsupported']);
    const total = { ...unzipSync(original) }; for (let i = 0; i < 5; i++) total['extra-' + i + '.xml'] = new Uint8Array(4 * 1024 * 1024); reject(Buffer.from(zipSync(total)), ['xlsx_limit']);
  });
  await test('source replay discards forged records and altered binary/base64 evidence', () => {
    const p = valid(original); p.records[0].data.net = '0.00'; assert.equal(replayReports(scope, [p]).records[0].data.net, '531.79');
    p.sources[0].rawContent = Buffer.from('replacement').toString('base64'); assert.equal(replayReports(scope, [p]).records.length, 0);
  });
  await test('XLSX covers semantic sales evidence; missing coverage blocks while independent bank digest remains', async () => {
    const s = [src(original), ...businessSources(scope)], d = declaration(scope); const p = planOffline({ scope, reports: [report(s)], declaration: d });
    assert.equal(p.matrix.find(r => r.id === 'coverage:sales:all').status, 'provided_valid'); const t = p.tasks.find(t => t.taskId.startsWith('prepare:bank:')); assert.ok(t && t.status === 'ready');
    const missing = clone(d); missing.coverage = missing.coverage.filter(c => c.kind !== 'sales'); const q = planOffline({ scope, reports: [report(s)], declaration: missing, previousPlan: p });
    assert.equal(q.matrix.find(r => r.id === 'coverage:sales:all').status, 'missing'); assert.equal(q.tasks.find(x => x.taskId === t.taskId).inputDigest, t.inputDigest); assert.equal(q.periodComplete, undefined);
  });
  await test('automatic balanced candidates derive actual XLSX amounts and per-entry E/F/G4 provenance', () => {
    const p = buildOfflineCandidates(input([src(original), ...businessSources(scope)], scope, declaration(scope), accountingFacts(scope)));
    assert.equal(p.candidates.length, 2, json(p.decisions)); const sale = p.candidates.find(c => c.kind === 'service_sale');
    assert.deepEqual(sale.entries.map(e => [e.accountCode, e.debit, e.credit]), [['1122', '537.11', '0.00'], ['5001', '0.00', '531.79'], ['2221', '0.00', '5.32']]);
    assert.ok(sale.entries.flatMap(e => e.sourceFields).some(r => r.location.cell === 'E4' && r.location.sheet === '原票' && r.fileSha256 === hash(original))); assert.equal(p.authorizesExecution, false);
    const noCoverage = declaration(scope); noCoverage.coverage = noCoverage.coverage.filter(c => c.kind !== 'sales'); const blocked = buildOfflineCandidates(input([src(original), ...businessSources(scope)], scope, noCoverage, accountingFacts(scope))); assert.equal(blocked.candidates.some(c => c.kind === 'service_sale'), true); assert.equal(blocked.plan.matrix.find(r => r.id === 'coverage:sales:all').status, 'missing'); assert.notEqual(blocked.plan.tasks.find(t => t.taskId === 'period').status, 'ready');
  });
  await test('materials CLI reads binary file, safe stdout, two invocations and rejects output overwrite', () => {
    const path = join(root, 'original.xlsx'), config = join(root, 'materials.json'); write(path, original); write(config, { scope, sources: [{ sourceId: 'sales', kind: 'invoice_xlsx', scope, mapping: map(), path }] });
    for (const n of ['one', 'two']) { const out = join(root, n + '.json'), c = child(['scripts/offline-materials.mjs', '--config', config, '--output', out]); assert.equal(c.status, 0, c.stdout); assert.match(c.stdout, /^OFFLINE_MATERIALS_PREFLIGHT sources=1 records=1\r?\n$/); assert.equal(JSON.parse(readFileSync(out)).sources[0].fileSha256, hash(original)); }
    assert.equal(child(['scripts/offline-materials.mjs', '--config', config, '--output', join(root, 'one.json')]).status, 4);
  });
  await test('durable binary receipt child restart, stale origin isolation, CAS correction and historic blob replay', async () => {
    const store = join(root, 'store'), path = join(root, 'stored.xlsx'), bank = businessSources(scope)[1], bankPath = join(root, 'bank.csv'), config = join(root, 'store-input.json');
    write(path, original); write(bankPath, bank.text); const configDoc = { scope, sources: [{ sourceId: 'sales', kind: 'invoice_xlsx', scope, mapping: map(), path }, { ...bank, path: bankPath }] }; delete configDoc.sources[1].text; delete configDoc.sources[1].fileSha256; write(config, configDoc);
    await initMaterialStore(store, scope); const received = await receiveMaterials(store, config); assert.equal(received.status, 'received'); const old = received.active.find(s => s.sourceId === 'sales').sourceVersion;
    const inspect = join(root, 'child-inspect.json'), c = child(['scripts/offline-material-store.mjs', 'inspect', '--store', store, '--output', inspect]); assert.equal(c.status, 0, c.stdout); assert.equal(JSON.parse(readFileSync(inspect)).reports[0].records.find(r => r.kind === 'invoice').data.gross, '537.11');
    const entry = received.history.find(s => s.sourceId === 'sales'); assert.deepEqual(readFileSync(join(store, '000001-' + received.receipts[0].receiptId, entry.blob)), original);
    const replacement = await workbook({ data: ['00001973100489', '2026-03-12', scope.enterpriseKey, 'SYNTHETIC-BUYER', 531.80, 5.32, 537.12, 'blue'] }); write(path, replacement);
    const stale = await inspectMaterialStore(store); assert.equal(stale.status, 'blocked_origin_changed'); assert.deepEqual(stale.staleSourceIds, ['sales']); assert.equal(stale.reports[0].records[0].data.amount, '182.49');
    await assert.rejects(receiveMaterials(store, config), e => e.code === 'source_version_conflict'); configDoc.sources[0].supersedes = old; configDoc.sources[0].expectedSourceVersion = old; write(config, configDoc);
    const corrected = await receiveMaterials(store, config); assert.equal(corrected.status, 'received'); assert.equal(corrected.history.filter(s => s.sourceId === 'sales').length, 2); assert.equal(corrected.reports[0].records.find(r => r.kind === 'invoice').data.gross, '537.12'); assert.equal((await receiveMaterials(store, config)).status, 'replayed');
    assert.equal((await inspectMaterialStore(store)).reports[0].records.find(r => r.kind === 'invoice').data.gross, '537.12');
  });
  await test('actual XLSX -> auto candidates -> posted core fixture -> fresh snapshot/VAT CLI/store selected rows', async () => {
    ({ db } = await import('../server/db.mjs')); A = await import('../server/accounting.mjs'); IM = await import('../server/import-incremental.mjs');
    const set = A.createAccountSet({ name: 'SYNTHETIC-XLSX-TAX', start_period: '2026-01', profileId: 'small-2011-basic-v1', enterprise: { enterpriseKey: 'SYNTHETIC-XLSX-TAX' } }); for (const p of ['2026-01', '2026-02', '2026-03']) A.ensurePeriod(set.id, p);
    const s = { ...scope, enterpriseKey: 'SYNTHETIC-XLSX-TAX', accountSetId: String(set.id) }, b = await workbook({ s, data: ['00001973100489', '2026-03-12', s.enterpriseKey, 'SYNTHETIC-BUYER', 388927, 3889.27, 392816.27, 'blue'] }), sources = [src(b, s), ...businessSources(s)], d = declaration(s), x = input(sources, s, d, accountingFacts(s));
    const p = buildOfflineCandidates(x); assert.equal(p.candidates.length, 2, json(p.decisions));
    const posted = IM.importIncremental({ dryRun: false, confirmNewBinding: true, accountSetId: set.id, batchId: 'synthetic-xlsx', source: { system: VAT_SOURCE_SYSTEM, enterpriseKey: s.enterpriseKey }, payload: { account_set: { name: 'SYNTHETIC-XLSX-TAX', start_period: '2026-01', profileId: 'small-2011-basic-v1' }, vouchers: p.candidates.map(c => ({ period: c.date.slice(0, 7), date: c.date, sourceVoucherId: c.businessKey, summary: `offline:${c.businessKey}`, entries: c.entries.map(e => ({ code: e.accountCode, debit: e.debit, credit: e.credit, summary: e.detail ?? c.kind })) })) } }); assert.equal(posted.status, 'applied', json(posted));
    const confirm = basis => ({ confirmedBy: { name: 'SYNTHETIC-ACCOUNTANT', role: 'accountant' }, basis, sourceRefs: [{ kind: 'declaration', fileSha256: hash(stable(d)), pointer: '/evidence/1/basis' }] });
    x.taxFacts = wrap({ version: 'offline-tax-facts/1', scope: s, enterprise: { form: 'enterprise', establishedOn: '2026-01-01', ...confirm('新设企业登记') }, period: { ...confirm('全Q1资料完整核对'), exclusions: VAT_EXCLUSIONS.map(area => ({ area, state: 'none', ...confirm('无' + area) })) }, invoices: [{ invoiceRef: { sellerKey: s.enterpriseKey, code: '', number: '00001973100489' }, invoiceClass: 'ordinary', domesticConsumption: 'domestic', serviceCategory: 'ordinary_main_service', ...confirm('普通境内主营服务') }] });
    source = openReadonlyLedgerSource(join(process.env.WORKBENCH_DATA_DIR, 'workbench.db')); const snap = captureLedgerSnapshot(source, { enterpriseKey: s.enterpriseKey, accountSetId: set.id, fromPeriod: '2026-01', toPeriod: '2026-03' }), tax = calculateOfflineVat(x, source, snap);
    assert.equal(tax.calculationReady, true, json(tax.issues)); const cells = y => [15, 16, 22].map(r => y.cells.find(c => c.row === r && c.period === 'current' && c.column === 'services').value); assert.deepEqual(cells(tax), ['11667.81', '7778.54', '3889.27']);
    const incomplete = clone(x); incomplete.declaration.coverage = incomplete.declaration.coverage.filter(c => c.kind !== 'sales'); incomplete.taxFacts.text = incomplete.taxFacts.text.replaceAll(hash(stable(d)), hash(stable(incomplete.declaration))); incomplete.taxFacts.fileSha256 = hash(incomplete.taxFacts.text);
    const blocked = calculateOfflineVat(incomplete, source, snap); assert.equal(blocked.calculationReady, false); assert.equal(blocked.cells.find(c => c.row === 22 && c.period === 'current' && c.column === 'services').value, null);
    assert.equal(tax.periodComplete, false);
    const dir = join(root, 'tax'); mkdirSync(dir); const configs = sources.map((v, i) => { const path = join(dir, 'material-' + i + (v.kind === 'invoice_xlsx' ? '.xlsx' : '.txt')); write(path, sourceBytes(v.kind, v.text)); const { text, fileSha256, ...c } = v; return { ...c, path }; });
    write(join(dir, 'materials.json'), { scope: s, sources: configs }); write(join(dir, 'declaration.json'), d); write(join(dir, 'accounting.json'), x.accountingFacts.text); write(join(dir, 'tax.json'), x.taxFacts.text);
    const materialOut = join(dir, 'preflight.json'); assert.equal(child(['scripts/offline-materials.mjs', '--config', join(dir, 'materials.json'), '--output', materialOut]).status, 0);
    write(join(dir, 'planning.json'), { version: 'offline-planning-input/1', scope: s, reports: ['preflight.json'], declaration: 'declaration.json' });
    assert.equal(child(['scripts/offline-plan.mjs', '--input', join(dir, 'planning.json'), '--output', join(dir, 'plan.json')]).status, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'plan.json'))).matrix.find(r => r.id === 'coverage:sales:all').status, 'provided_valid');
    write(join(dir, 'bookkeeping.json'), { version: 'offline-bookkeeping-input/1', planningInput: 'planning.json', accountingFacts: 'accounting.json', profileId: x.profileId });
    assert.equal(child(['scripts/offline-bookkeeping.mjs', '--input', join(dir, 'bookkeeping.json'), '--output', join(dir, 'candidates.json')]).status, 0);
    const fromCli = JSON.parse(readFileSync(join(dir, 'candidates.json'))); assert.equal(fromCli.candidates.length, 2); assert.equal(fromCli.candidates.find(c => c.kind === 'service_sale').entries[0].debit, '392816.27');
    const config = { version: 'offline-vat-input/1', scope: s, profileId: x.profileId, materialsInput: 'materials.json', declaration: 'declaration.json', accountingFacts: 'accounting.json', taxFacts: 'tax.json', db: join(process.env.WORKBENCH_DATA_DIR, 'workbench.db') }; write(join(dir, 'input.json'), config);
    const c = child(['scripts/offline-vat.mjs', '--input', join(dir, 'input.json'), '--output', join(dir, 'out.json')]); assert.equal(c.status, 0, c.stdout); assert.deepEqual(cells(JSON.parse(readFileSync(join(dir, 'out.json')))), ['11667.81', '7778.54', '3889.27']); assert.match(c.stdout, /^OFFLINE_VAT_WRITTEN ready=1 issues=0\r?\n$/);
    const store = join(dir, 'store'); await initMaterialStore(store, s); await receiveMaterials(store, join(dir, 'materials.json')); delete config.materialsInput; config.materialStore = 'store'; write(join(dir, 'store-input.json'), config);
    assert.equal(child(['scripts/offline-vat.mjs', '--input', join(dir, 'store-input.json'), '--output', join(dir, 'store-out.json')]).status, 0); assert.deepEqual(cells(JSON.parse(readFileSync(join(dir, 'store-out.json')))), ['11667.81', '7778.54', '3889.27']);
    write(configs[0].path, original); assert.equal(child(['scripts/offline-vat.mjs', '--input', join(dir, 'store-input.json'), '--output', join(dir, 'stale.json')]).status, 4);
  });
} finally {
  source?.close(); db?.close();
  console.log(`OFFLINE_XLSX_RESULT passed=${passed} failed=${failed}`);
  if (failed || process.env.KEEP_FIXTURES === '1') console.log('SYNTHETIC_FIXTURES_RETAINED ' + root);
  else { assert.ok(resolve(root).startsWith(parent + '\\') || resolve(root).startsWith(parent + '/')); rmSync(root, { recursive: true }); }
  process.exitCode = failed ? 1 : 0;
}
