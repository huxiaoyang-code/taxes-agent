// 仅使用合成原件。不导入账簿，不准备会计分录或预期产品输入。
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sourceBytes, sourceText, hash } from '../server/offline-material-adapters.mjs';
import { preflightMaterials } from '../server/offline-materials.mjs';
import { replayReports } from '../server/material-completeness.mjs';
import { initMaterialStore, receiveMaterials, inspectMaterialStore } from '../server/offline-material-store.mjs';
import { openOfflineActionInput } from '../server/offline-action-input.mjs';
import { buildOfflineActionPlan, buildOfflineActionPlanFromFiles } from '../server/offline-action-plan.mjs';

const wbDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'), parent = join(wbDir, '.agent-runs');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'bank-xlsx-synthetic-'));
process.env.TEMP = root; process.env.TMP = root; process.env.WORKBENCH_DATA_DIR = join(root, 'unused-db');
const scope = { enterpriseKey: 'SYNTHETIC-BANK-XLSX', accountSetId: 'BOOK', period: '2026-Q1', currency: 'CNY', unit: 'yuan' };
const refId = '0000000000000001234567890123456789';
const clone = structuredClone, json = JSON.stringify;
const map = () => ({ format: 'bank-xlsx-v1', sheet: '银行原始流水', headerRow: 3, ownerEnterpriseKey: scope.enterpriseKey, bankAccountId: 'bank-A', dateFormat: 'YYYY-MM-DD', amountMode: 'amount_direction', currency: 'CNY', negativeAmount: 'reject', directionLabels: { inflow: ['收'], outflow: ['付'] }, columns: { date: '日期', amount: '金额', direction: '收付', refId: '流水号', balance: '余额', currency: '币种', summary: '摘要' } });
const data = () => ['2026-03-20', 684.23, '付', refId, -315.77, 'CNY', 'PRIVATE-SYNTHETIC'];
let serial = 0, passed = 0, failed = 0;
const write = (p, v) => writeFileSync(p, Buffer.isBuffer(v) || typeof v === 'string' ? v : json(v));
const test = async (name, run) => { try { await run(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } };
async function workbook({ row = data(), modify } = {}) {
  const w = new ExcelJS.Workbook(); w.addWorksheet('无关表').addRow(['说明']); const s = w.addWorksheet(map().sheet);
  s.getRow(1).values = ['合成银行导出']; s.getRow(3).values = Object.values(map().columns); s.getRow(4).values = row;
  if (modify) modify(s, w);
  const path = join(root, `original-${++serial}.xlsx`); write(path, Buffer.from(await w.xlsx.writeBuffer())); return readFileSync(path);
}
const src = (bytes, mapping = map(), sourceId = 'bank') => ({ sourceId, kind: 'bank_xlsx', scope: clone(scope), mapping, text: sourceText('bank_xlsx', bytes), fileSha256: hash(bytes) });
const report = sources => preflightMaterials({ scope, sources });
const valid = (b, mapping = map()) => { const r = report([src(b, mapping)]); assert.notEqual(r.status, 'rejected', json(r.errors)); return r; };
const reject = (b, codes, mapping = map()) => { const r = report([src(b, mapping)]); assert.equal(r.status, 'rejected'); if (codes) assert.ok(codes.includes(r.errors[0].code), json(r.errors)); return r; };
const change = (b, name, fn) => { const e = unzipSync(b); e[name] = strToU8(fn(strFromU8(e[name]))); return Buffer.from(zipSync(e)); };
const child = args => { const c = spawnSync(process.execPath, args, { cwd: wbDir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }); assert.equal(c.signal, null); assert.equal(c.stderr, ''); return c; };
const csvSource = () => { const { sheet, headerRow, ...m } = map(); const text = Object.values(m.columns).join(',') + '\n' + data().join(','); return { sourceId: 'bank-copy', kind: 'bank_csv', scope: clone(scope), mapping: { ...m, format: 'bank-csv-v1' }, text, fileSha256: hash(text) }; };
function facts() {
  const conf = { confirmedBy: { name: 'SYNTHETIC-OPERATOR', role: 'business_operator' }, basis: '合成合同履约记录' };
  return { version: 'offline-accounting-facts/1', scope: clone(scope), facts: [
    { factId: 'future', kind: 'service_prepayment', ...clone(conf), bankRef: { bankAccountId: 'bank-A', refId }, contractId: 'FUTURE-CONTRACT', supplierKey: 'SUPPLIER', serviceStartDate: '2026-04-01', serviceEndDate: '2026-06-30', ordinaryService: true, performanceThroughPeriodEnd: 'not_started', refundThroughPeriodEnd: 'none', paymentCount: 1, otherRecognitionInProvidedMaterials: 'none', relatedInvoiceRefs: [] },
    { factId: 'sale', kind: 'service_sale', ...clone(conf), invoiceRef: { sellerKey: scope.enterpriseKey, code: '', number: '92173' }, contractId: 'SALE', serviceStartDate: '2026-03-01', completionDate: '2026-03-12', collectionRightDate: '2026-03-12', mainService: true, ordinaryService: true }
  ] };
}
function declaration() {
  const ev = (id, role) => ({ evidenceId: id, kind: 'customer_declaration', scope: clone(scope), confirmedBy: { name: 'SYNTHETIC-DECLARANT', role }, basis: '合成Q1完整范围登记' });
  return { version: 'offline-declaration/1', scope: clone(scope), profile: 'small-2011', businessScope: 'service-company', evidence: [ev('owner', 'owner'), ev('tax', 'accountant')], enterpriseEvidenceIds: ['owner'], bankAccounts: { accountIds: ['bank-A'], evidenceIds: ['owner'] }, coverage: ['sales', 'purchase', 'bank'].map(kind => ({ kind, accountId: kind === 'bank' ? 'bank-A' : null, from: '2026-01', to: '2026-03', state: kind === 'purchase' ? 'no_activity' : 'complete', sourceIds: kind === 'purchase' ? [] : [kind], evidenceIds: ['owner'] })), tax: { vatStatus: 'small_scale', filingFrequency: 'quarterly', evidenceIds: ['tax'] }, applicability: ['payroll', 'assets'].map(area => ({ area, present: false, evidenceIds: ['owner'] })), opening: { state: 'new_zero', evidenceIds: ['tax'] }, history: { state: 'first_period', evidenceIds: ['tax'] }, bankFacts: [] };
}
function independentSources() {
  const text = 'number,date,seller,buyer,net,tax,gross,status\n92173,2026-03-12,SYNTHETIC-BANK-XLSX,CUSTOMER,914.37,9.14,923.51,blue';
  const basic = { version: 'business-facts/1', scope: clone(scope), facts: [{ factId: 'basic', date: '2026-03-12', nature: 'service', performance: 'completed', settlement: 'unpaid', purpose: 'unknown', benefitPeriod: { state: 'unknown', from: null, to: null }, invoiceRef: { sellerKey: scope.enterpriseKey, code: '', number: '92173' } }] };
  return [{ sourceId: 'sales', kind: 'invoice_csv', scope: clone(scope), mapping: { format: 'invoice-summary-csv-v1', role: 'sales', dateFormat: 'YYYY-MM-DD', redSign: 'signed_negative', statusLabels: { blue: ['blue'], red: ['red'] }, columns: { number: 'number', date: 'date', sellerKey: 'seller', buyerKey: 'buyer', net: 'net', tax: 'tax', gross: 'gross', status: 'status' } }, text, fileSha256: hash(text) }, { sourceId: 'basic', kind: 'business_json', scope: clone(scope), mapping: { format: 'business-facts-json-v1' }, text: json(basic), fileSha256: hash(json(basic)) }];
}
function pureInput(bytes, copies = []) { const f = json(facts()); return { scope: clone(scope), profileId: 'small-2011-basic-v1', reports: [report([src(bytes), ...copies, ...independentSources()])], declaration: declaration(), accountingFacts: { text: f, fileSha256: hash(f) } }; }
function diskFixture(bytes) {
  const dir = join(root, `disk-${++serial}`); mkdirSync(dir); const bankPath = join(dir, 'bank.xlsx'); write(bankPath, bytes);
  const sources = [src(bytes), ...independentSources()].map(s => { const path = s.kind === 'bank_xlsx' ? bankPath : join(dir, s.sourceId + '.txt'); write(path, sourceBytes(s.kind, s.text)); const { text, fileSha256, ...config } = s; return { ...config, path }; });
  const materials = { scope: clone(scope), sources }, config = { version: 'offline-action-input/1', scope: clone(scope), profileId: 'small-2011-basic-v1', materialsInput: 'materials.json', declaration: 'declaration.json', accountingFacts: 'facts.json' };
  const f = facts(), d = declaration(); const save = () => { write(join(dir, 'materials.json'), materials); write(join(dir, 'config.json'), config); write(join(dir, 'facts.json'), f); write(join(dir, 'declaration.json'), d); }; save();
  const open = () => openOfflineActionInput(join(dir, 'config.json'));
  const plan = async () => { save(); const s = await open(); try { return await buildOfflineActionPlanFromFiles(s); } finally { s.close(); } };
  return { dir, bankPath, materials, config, facts: f, declaration: d, save, open, plan };
}
const payment = p => p.tasks.find(t => t.kind === 'service_prepayment');
let original;
try {
  original = await workbook();
  await test('actual binary Chinese sheet/nonfirst header keeps long text ref and exact amount/negative balance A1', () => {
    const r = valid(original), b = r.records[0]; assert.equal(b.data.refId, refId); assert.equal(b.data.amount, '684.23'); assert.equal(b.data.balance, '-315.77'); assert.equal(b.data.direction, 'outflow');
    assert.equal(b.location.sheet, map().sheet); assert.equal(b.location.row, 4); assert.equal(b.location.fields.amount.cell, 'B4'); assert.equal(b.location.fields.balance.cell, 'E4'); assert.equal(b.location.fields.refId.cell, 'D4'); assert.equal(b.location.fields.balance.column, 5);
    assert.equal(b.fileSha256, hash(original)); assert.notEqual(hash(r.sources[0].rawContent), hash(original)); assert.equal(r.missingKinds.includes('bank_csv'), false); assert.equal(r.authorizesExecution, false);
  });
  await test('numeric General/0/0.00 and text/inline exact values reuse bank semantics', async () => {
    for (const numFmt of ['General', '0', '0.00']) assert.equal(valid(await workbook({ modify: s => { s.getCell('B4').numFmt = numFmt; s.getCell('E4').numFmt = numFmt; } })).records[0].data.amount, '684.23');
    const row = data(); row[1] = '684.23'; row[4] = '-315.77'; let b = await workbook({ row });
    b = change(b, 'xl/worksheets/sheet2.xml', s => s.replace(/<c r="D4" t="s"><v>\d+<\/v><\/c>/, `<c r="D4" t="inlineStr"><is><t>${refId}</t></is></c>`));
    assert.match(strFromU8(unzipSync(b)['xl/worksheets/sheet2.xml']), /inlineStr/); assert.deepEqual(valid(b).records[0].data, valid(original).records[0].data);
  });
  await test('explicit text currency/thousands options and negative reversal retain existing bank behavior', async () => {
    const row = data(); row[1] = '￥1,684.23'; const m = map(); m.thousandsSeparator = ','; m.allowCurrencySymbol = true;
    assert.equal(valid(await workbook({ row }), m).records[0].data.amount, '1684.23');
    row[1] = -684.23; m.negativeAmount = 'reverse_direction'; assert.equal(valid(await workbook({ row }), m).records[0].data.direction, 'inflow');
    reject(await workbook({ row }), ['bank_row_invalid']);
  });
  await test('OOXML numeric amount and balance cannot use text currency or grouping options', () => {
    for (const [literal, separator] of [['￥2,849.63', ','], ['2,849.63', ','], ['2 849.63', ' ']]) {
      const m = map(); m.allowCurrencySymbol = true; m.thousandsSeparator = separator;
      for (const raw of ['684.23', '-315.77']) {
        const b = change(original, 'xl/worksheets/sheet2.xml', s => s.replace(`<v>${raw}</v>`, `<v>${literal}</v>`));
        reject(b, ['xlsx_cell_invalid'], m);
      }
    }
    for (const literal of [' 2849.63', '2849.63 ', '2849.63\n', '2849.63\r\n', '\t2849.63', '+2849.63', '.63', '2849.', '02849.63', '-2 849.63', '￥-2,849.63']) {
      const m = map(); m.allowCurrencySymbol = true; m.thousandsSeparator = literal.includes(' ') ? ' ' : ',';
      for (const raw of ['684.23', '-315.77']) reject(change(original, 'xl/worksheets/sheet2.xml', s => s.replace(`<v>${raw}</v>`, `<v>${literal}</v>`)), ['xlsx_cell_invalid'], m);
    }
  });
  await test('actual text amount/balance still accept declared currency/grouping options identically to CSV', async () => {
    for (const [amount, balance, separator] of [['￥2,849.63', '￥-2,849.63', ','], ['2,849.63', '-2,849.63', ','], ['2 849.63', '-2 849.63', ' ']]) {
      const m = map(); m.allowCurrencySymbol = true; m.thousandsSeparator = separator;
      const row = data(); row[1] = amount; row[4] = balance; const b = await workbook({ row }), x = valid(b, m).records[0];
      assert.equal(x.data.amount, '2849.63'); assert.equal(x.data.balance, '-2849.63');
      const { sheet, headerRow, ...csvMap } = m;
      const quote = v => String(v).includes(',') ? `"${v}"` : String(v);
      const text = Object.values(m.columns).join(',') + '\n' + row.map(quote).join(',');
      const c = { sourceId: 'formatted-csv', kind: 'bank_csv', scope: clone(scope), mapping: { ...csvMap, format: 'bank-csv-v1' }, text, fileSha256: hash(text) };
      const p = report([src(b, m), c]); assert.notEqual(p.status, 'rejected', json(p.errors)); assert.equal(p.counts.duplicates, 2); assert.equal(p.records[0].semanticDigest, p.records[1].semanticDigest); assert.equal(p.records[0].docId, p.records[1].docId);
    }
  });
  await test('bank CSV identity/digest/raw location remain stable; cross-format duplicate is one actual candidate', () => {
    const csv = csvSource(), before = report([csv]).records[0], p = report([src(original), csv]);
    assert.equal(before.docId, p.records[0].docId); assert.equal(before.semanticDigest, p.records[0].semanticDigest); assert.equal(p.counts.duplicates, 2); assert.equal(before.location.line, 2); assert.equal(before.location.fields.amount.column, 2);
    assert.deepEqual(report([csv]).records[0], before); const plan = buildOfflineActionPlan(pureInput(original, [csv])); assert.equal(plan.candidates.filter(c => c.kind === 'service_prepayment').length, 1); assert.equal(payment(plan).candidate.entries[0].debit, '684.23');
    csv.text = csv.text.replace('684.23', '684.24'); csv.fileSha256 = hash(csv.text); const conflict = report([src(original), csv]); assert.equal(conflict.status, 'blocked_conflict'); assert.equal(conflict.counts.conflicts, 2); assert.equal(buildOfflineActionPlan(pureInput(original, [csv])).candidates.some(c => c.kind === 'service_prepayment'), false);
  });
  await test('canonical bounded base64 uses actual binary SHA and refuses noncanonical transport', () => {
    assert.deepEqual(sourceBytes('bank_xlsx', sourceText('bank_xlsx', original)), original);
    const boundary = Buffer.alloc(5 * 1024 * 1024, 17); assert.equal(sourceBytes('bank_xlsx', sourceText('bank_xlsx', boundary)).length, boundary.length);
    for (const text of ['YQ', 'YR==', 'YQ==\n', '=AAA', sourceText('bank_xlsx', Buffer.alloc(boundary.length + 1))]) assert.throws(() => sourceBytes('bank_xlsx', text), e => e.code === 'source_digest_invalid');
    const s = src(original); s.fileSha256 = hash(s.text); assert.equal(report([s]).errors[0].code, 'source_digest_invalid');
  });
  await test('mapping format/owner/account/required/unknown columns and arbitrary numeric permissions fail closed', () => {
    for (const mutate of [m => { m.format = 'bank-csv-v1'; }, m => { m.ownerEnterpriseKey = 'OTHER'; }, m => { m.bankAccountId = ''; }, m => { delete m.ownerEnterpriseKey; }, m => { delete m.columns.amount; }, m => { m.columns.debit = '借'; }, m => { m.amountMode = 'debit_credit'; }, m => { m.numericKeys = ['refId']; }, m => { delete m.dateFormat; }, m => { delete m.directionLabels; }, m => { m.currency = 'USD'; }]) { const m = map(); mutate(m); reject(original, null, m); }
  });
  await test('explicit sheet/header, duplicate header and missing actual fields are never guessed', async () => {
    reject(original, ['xlsx_sheet_missing'], { ...map(), sheet: '不存在' }); reject(original, ['xlsx_header_missing'], { ...map(), headerRow: 2 });
    for (const headerRow of [0, 1.5, 10000, '3']) reject(original, ['mapping_invalid'], { ...map(), headerRow });
    reject(await workbook({ modify: s => { s.getCell('H3').value = '金额'; } }), ['xlsx_header_ambiguous']);
    for (const cell of ['A4', 'B4', 'C4', 'F4']) reject(await workbook({ modify: s => { s.getCell(cell).value = null; } }));
  });
  await test('outside period, invalid date and foreign source scope reject', async () => {
    for (const date of ['2026-04-01', '2026-02-30']) { const row = data(); row[0] = date; reject(await workbook({ row }), [date.endsWith('30') ? 'date_invalid' : 'date_outside_scope']); }
    for (const [key, value] of [['enterpriseKey', 'OTHER'], ['accountSetId', 'OTHER'], ['period', '2026-Q2']]) { const s = src(original); s.scope[key] = value; assert.equal(report([s]).errors[0].code, 'scope_mismatch'); }
  });
  await test('unknown direction/currency and absent required row values never become zero activity', async () => {
    for (const [column, value] of [[2, '借'], [5, 'USD'], [1, 0], [0, ''], [1, ''], [2, ''], [5, '']]) { const row = data(); row[column] = value; reject(await workbook({ row }), ['bank_row_invalid', 'date_invalid']); }
  });
  await test('noncontiguous original rows preserve actual source row and A1 without a CSV projection', async () => {
    const b = await workbook({ modify: s => { s.getRow(12).values = s.getRow(4).values; s.getRow(4).values = []; } }), r = valid(b).records[0];
    assert.equal(r.location.row, 12); assert.equal(r.location.fields.amount.cell, 'B12'); assert.equal(r.location.fields.refId.cell, 'D12'); assert.equal(r.data.refId, refId);
  });
  await test('date/ref/direction/currency/summary numeric cells never reconstruct lost text', async () => {
    for (const [cell, value] of [['A4', 46101], ['D4', 12345678901234568], ['C4', 1], ['F4', 156], ['G4', 1]]) reject(await workbook({ modify: s => { s.getCell(cell).value = value; } }), ['xlsx_text_required']);
  });
  await test('cached formula/error/boolean/merged and rich text cells reject', async () => {
    reject(await workbook({ modify: s => { s.getCell('B4').value = { formula: '600+84.23', result: 684.23 }; } }), ['xlsx_formula_unsupported']);
    for (const value of [true, { error: '#VALUE!' }]) reject(await workbook({ modify: s => { s.getCell('B4').value = value; } }), ['xlsx_cell_type_unsupported']);
    reject(await workbook({ modify: s => s.mergeCells('A4:B4') }), ['xlsx_structure_unsupported']);
    reject(await workbook({ modify: s => { s.getCell('D4').value = { richText: [{ text: '000' }, { text: '123' }] }; } }), ['xlsx_structure_unsupported']);
  });
  await test('scientific/subcent/invalid raw numeric words and complex amount/balance styles reject without rounding', async () => {
    for (const value of ['6.8423E2', '684.2300000000001', '684.231', 'NaN', 'Infinity']) reject(change(original, 'xl/worksheets/sheet2.xml', s => s.replace('<v>684.23</v>', `<v>${value}</v>`)), ['xlsx_cell_invalid']);
    for (const cell of ['B4', 'E4']) for (const numFmt of ['0.00%', 'yyyy-mm-dd', '"¥"0.00', '0.000']) reject(await workbook({ modify: s => { s.getCell(cell).numFmt = numFmt; } }), ['xlsx_numeric_format_unsupported']);
    reject(change(original, 'xl/worksheets/sheet2.xml', s => s.replace('<v>-315.77</v>', '<v>-315.771</v>')), ['xlsx_cell_invalid']);
  });
  await test('malformed XML, DTD, duplicate cell/tree and OOXML escape use unchanged safety boundary', () => {
    const part = 'xl/worksheets/sheet2.xml';
    reject(change(original, part, s => s.replace('</sheetData>', '</broken>')), ['xlsx_xml_invalid']);
    reject(change(original, part, s => s.replace('?>', '?><!DOCTYPE worksheet [<!ENTITY x "1">]>')), ['xlsx_structure_unsupported']);
    reject(change(original, part, s => s.replace('<sheetData>', '<sheetData><row r="9"><sheetData/></row>')), ['xlsx_structure_unsupported']);
    reject(change(original, part, s => s.replace('r="B4"', 'r="A4"')), ['xlsx_cell_invalid']);
    reject(change(original, 'xl/sharedStrings.xml', s => s.replace('PRIVATE-SYNTHETIC', '_x0050_RIVATE-SYNTHETIC')), ['xlsx_string_escape_unsupported']);
  });
  await test('external links/macros/unknown parts, missing part and hidden selection reject', async () => {
    reject(await workbook({ modify: s => { s.getCell('H4').value = { text: 'link', hyperlink: 'https://example.com' }; } }), ['xlsx_external_link_unsupported']);
    reject(await workbook({ modify: s => { s.state = 'hidden'; } }), ['xlsx_structure_unsupported']);
    let e = unzipSync(original); delete e['xl/styles.xml']; reject(Buffer.from(zipSync(e)), ['xlsx_part_missing']);
    e = unzipSync(original); e['xl/vbaProject.bin'] = new Uint8Array([1]); reject(Buffer.from(zipSync(e)), ['xlsx_external_link_unsupported']);
    reject(change(original, 'xl/_rels/workbook.xml.rels', s => s.replace('/styles"', '/vbaProject"')), ['xlsx_structure_unsupported']);
    e = unzipSync(original); e['unknown.bin'] = new Uint8Array([1]); reject(Buffer.from(zipSync(e)), ['xlsx_structure_unsupported']);
  });
  await test('ZIP truncation/declared lie/entry expansion/count and physical row/column limits reject', async () => {
    for (const b of [Buffer.from('notzip'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), original.subarray(0, original.length - 50)]) reject(b, ['xlsx_zip_or_xml_invalid', 'xlsx_zip_invalid']);
    let e = unzipSync(original); e['huge.xml'] = new Uint8Array(4 * 1024 * 1024 + 1); reject(Buffer.from(zipSync(e)), ['xlsx_limit']);
    e = unzipSync(original); for (let i = 0; i < 101; i++) e['extra-' + i] = new Uint8Array(); reject(Buffer.from(zipSync(e)), ['xlsx_zip_invalid']);
    e = unzipSync(original); for (let i = 0; i < 5; i++) e['extra-' + i] = new Uint8Array(4 * 1024 * 1024); reject(Buffer.from(zipSync(e)), ['xlsx_limit']);
    const lying = Buffer.from(zipSync({ ...unzipSync(original), 'inflated.bin': new Uint8Array(1024 * 1024).fill(65) })); let changed = false;
    for (let i = 0; i + 46 < lying.length; i++) if (lying.readUInt32LE(i) === 0x02014b50 && lying.subarray(i + 46, i + 46 + lying.readUInt16LE(i + 28)).toString() === 'inflated.bin') { lying.writeUInt32LE(1, i + 24); changed = true; break; }
    assert.equal(changed, true); reject(lying, ['xlsx_zip_invalid']);
    for (const cell of ['IW4', 'A10001']) reject(await workbook({ modify: s => { s.getCell(cell).value = 'too-far'; } }), ['xlsx_limit']);
  });
  await test('replay reparses binary and discards forged public records; raw/base64/SHA tampering rejects source', () => {
    const p = valid(original); p.records[0].data.amount = '0.00'; assert.equal(replayReports(scope, [p]).records[0].data.amount, '684.23');
    for (const mutate of [s => { s.rawContent = Buffer.from('replacement').toString('base64'); }, s => { s.fileSha256 = hash(s.rawContent); }, s => { s.rawContent += '\n'; }]) { const q = valid(original); mutate(q.sources[0]); const r = replayReports(scope, [q]); assert.equal(r.records.length, 0); assert.equal(r.issues[0].reason, 'source_replay_rejected'); }
  });
  await test('actual materials CLI binary transport fixed stdout/two writes/wx and originals unchanged', () => {
    const f = diskFixture(original), config = join(f.dir, 'materials.json');
    for (const name of ['one', 'two']) { const out = join(f.dir, name + '.json'), c = child(['scripts/offline-materials.mjs', '--config', config, '--output', out]); assert.equal(c.status, 0, c.stdout); assert.match(c.stdout, /^OFFLINE_MATERIALS_PREFLIGHT sources=3 records=3\r?\n$/); const p = JSON.parse(readFileSync(out)); assert.equal(p.sources[0].fileSha256, hash(original)); assert.deepEqual(sourceBytes('bank_xlsx', p.sources[0].rawContent), original); }
    const out = join(f.dir, 'one.json'), before = readFileSync(out); assert.equal(child(['scripts/offline-materials.mjs', '--config', config, '--output', out]).status, 4); assert.deepEqual(readFileSync(out), before); assert.deepEqual(readFileSync(f.bankPath), original); assert.equal(existsSync(process.env.WORKBENCH_DATA_DIR), false);
  });
  await test('actual receive saves raw binary; child restart verifies receipt/origin and replay', async () => {
    const f = diskFixture(original), store = join(f.dir, 'store'); await initMaterialStore(store, scope); const r = await receiveMaterials(store, join(f.dir, 'materials.json')); assert.equal(r.status, 'received');
    const entry = r.history.find(e => e.sourceId === 'bank'); assert.deepEqual(readFileSync(join(store, `000001-${r.receipts[0].receiptId}`, entry.blob)), original);
    const out = join(f.dir, 'reopened.json'), c = child(['scripts/offline-material-store.mjs', 'inspect', '--store', store, '--output', out]); assert.equal(c.status, 0, c.stdout); const reopened = JSON.parse(readFileSync(out)); assert.equal(reopened.status, 'verified'); assert.equal(reopened.reports[0].records.find(r => r.kind === 'bank_activity').data.amount, '684.23');
    assert.equal(reopened.active.find(e => e.sourceId === 'bank').receiptId, r.receipts[0].receiptId); assert.equal((await receiveMaterials(store, join(f.dir, 'materials.json'))).status, 'replayed');
    f.config.materialStore = 'store'; delete f.config.materialsInput; const plan = await f.plan(); assert.equal(payment(plan).status, 'candidate_preparation_ready'); assert.ok(json(plan).includes(r.receipts[0].receiptId)); assert.ok(json(plan).includes(hash(original)));
  });
  await test('changed origin invalidates stored preparation; CAS correction changes amount and historic blob remains', async () => {
    const f = diskFixture(original), store = join(f.dir, 'store'); await initMaterialStore(store, scope); const r = await receiveMaterials(store, join(f.dir, 'materials.json')), old = r.active.find(e => e.sourceId === 'bank').sourceVersion;
    f.config.materialStore = 'store'; delete f.config.materialsInput; const before = await f.plan(); const row = data(); row[1] = 685.27; row[4] = -316.81; const b = await workbook({ row }); write(f.bankPath, b);
    const stale = await inspectMaterialStore(store); assert.equal(stale.status, 'blocked_origin_changed'); assert.deepEqual(stale.staleSourceIds, ['bank']); assert.equal(stale.reports.flatMap(r => r.records).some(r => r.kind === 'bank_activity'), false);
    const blocked = await f.plan(); assert.equal(blocked.candidates.some(c => c.kind === 'service_prepayment'), false); assert.equal(blocked.candidates.some(c => c.kind === 'service_sale'), true);
    await assert.rejects(receiveMaterials(store, join(f.dir, 'materials.json')), e => e.code === 'source_version_conflict');
    f.materials.sources[0].supersedes = old; f.materials.sources[0].expectedSourceVersion = old; f.save(); const corrected = await receiveMaterials(store, join(f.dir, 'materials.json')); assert.equal(corrected.status, 'received'); assert.equal(corrected.history.filter(e => e.sourceId === 'bank').length, 2);
    const now = await f.plan(); assert.equal(payment(now).candidate.entries[0].debit, '685.27'); assert.notEqual(payment(now).dependencyDigest, payment(before).dependencyDigest); assert.equal(now.authorizesExecution, false);
    const entry = r.history.find(e => e.sourceId === 'bank'); assert.deepEqual(readFileSync(join(store, `000001-${r.receipts[0].receiptId}`, entry.blob)), original);
  });
  await test('real file action input gives bank coverage and independent exact balanced future-service candidate', async () => {
    const f = diskFixture(original), p = await f.plan(); assert.equal(p.matrix.find(r => r.id === 'coverage:bank:bank-A').status, 'provided_valid'); assert.equal(p.candidates.length, 2);
    assert.deepEqual(payment(p).candidate.entries.map(e => [e.accountCode, e.debit, e.credit]), [['1123', '684.23', '0.00'], ['1002', '0.00', '684.23']]);
    assert.ok(payment(p).candidate.entries.flatMap(e => e.sourceFields).some(s => s.fileSha256 === hash(original) && s.location.cell === 'B4' && s.location.sheet === map().sheet)); assert.equal(p.customerRequest.requests.length, 0);
    assert.equal(p.periodComplete, false); assert.equal(p.authorizesExecution, false); assert.ok(p.tasks.every(t => t.authorizesExecution === false && t.periodComplete === false && t.completed === false));
  });
  await test('only actually missing refund fact is requested once; restored facts remove obsolete requests', async () => {
    const f = diskFixture(original); delete f.facts.facts[0].refundThroughPeriodEnd; const p = await f.plan(); assert.equal(payment(p).status, 'missing'); assert.equal(p.customerRequest.requests.length, 1); assert.match(p.customerRequest.forwardableText, /截至期末是否退款/); assert.doesNotMatch(p.customerRequest.forwardableText, /银行账户.*整期覆盖|实际完成日|行政日常用途/); assert.equal(p.candidates.some(c => c.kind === 'service_sale'), true);
    f.facts.facts[0].refundThroughPeriodEnd = 'none'; assert.equal((await f.plan()).customerRequest.requests.length, 0);
  });
  await test('wrong account/no-activity/owner prevent payment while independent sales stay ready', async () => {
    for (const mode of ['account', 'no_activity', 'owner']) { const f = diskFixture(original); if (mode === 'account') f.declaration.bankAccounts.accountIds = []; if (mode === 'no_activity') f.declaration.coverage[2].state = 'no_activity'; if (mode === 'owner') f.materials.sources[0].mapping.ownerEnterpriseKey = 'OTHER'; const p = await f.plan(); assert.equal(p.candidates.some(c => c.kind === 'service_prepayment'), false, mode); assert.equal(p.candidates.some(c => c.kind === 'service_sale'), true, mode); assert.equal(p.periodComplete, false); }
  });
  await test('missing actual bank file stays invalid; appearing file invalidates open session', async () => {
    const f = diskFixture(original); rmSync(f.bankPath); f.save(); const s = await f.open(); try { const p = await buildOfflineActionPlanFromFiles(s); assert.equal(p.candidates.some(c => c.kind === 'service_prepayment'), false); assert.equal(p.candidates.some(c => c.kind === 'service_sale'), true); write(f.bankPath, original); await assert.rejects(buildOfflineActionPlanFromFiles(s), e => e.code === 'action_input_changed'); } finally { s.close(); }
  });
  await test('file change after open and cross-enterprise config never consume old binary report', async () => {
    const f = diskFixture(original); const s = await f.open(); try { write(f.bankPath, Buffer.from('changed')); await assert.rejects(buildOfflineActionPlanFromFiles(s), e => e.code === 'action_input_changed'); } finally { s.close(); }
    const g = diskFixture(original); g.config.scope.enterpriseKey = 'OTHER'; g.save(); await assert.rejects(g.open(), e => e.code === 'scope_mismatch');
  });
} finally {
  console.log(`OFFLINE_BANK_XLSX_RESULT passed=${passed} failed=${failed}`);
  if (failed || process.env.KEEP_FIXTURES === '1') console.log('SYNTHETIC_FIXTURES_RETAINED ' + root);
  else { assert.equal(dirname(root), parent); rmSync(root, { recursive: true }); }
  process.exitCode = failed ? 1 : 0;
}
