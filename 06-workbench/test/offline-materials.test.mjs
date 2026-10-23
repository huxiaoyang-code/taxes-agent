import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { preflightMaterials } from '../server/offline-materials.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);
const scope = { enterpriseKey: 'SYNTHETIC-OWNER', accountSetId: 'synthetic-book', period: '2026-Q3', currency: 'CNY', unit: 'yuan' };
const invoiceMap = { format: 'invoice-summary-csv-v1', role: 'sales', dateFormat: 'YYYY-MM-DD', redSign: 'signed_negative', statusLabels: { blue: ['蓝字', '正常'], red: ['红字'] }, columns: { number: '发票号码', code: '发票代码', date: '开票日期', sellerKey: '销方识别号', buyerKey: '购方识别号', net: '金额', tax: '税额', gross: '价税合计', status: '状态', originalNumber: '原票号码', originalCode: '原票代码', originalSourceVersion: '原来源版本' } };
const bankMap = { format: 'bank-csv-v1', ownerEnterpriseKey: scope.enterpriseKey, bankAccountId: 'bank-A', columns: { date: '发生日期', amount: '交易金额', direction: '收支', summary: '摘要', refId: '流水号' }, dateFormat: 'YYYY/MM/DD', amountMode: 'amount_direction', currency: 'CNY', negativeAmount: 'reject', directionLabels: { inflow: ['收'], outflow: ['付'] } };
const invoiceRow = (patch = {}) => ({ number: '10000001', code: '0200', date: '2026-07-16', sellerKey: scope.enterpriseKey, buyerKey: 'SYNTHETIC-BUYER', net: '1234.57', tax: '37.04', gross: '1271.61', status: '蓝字', originalNumber: '', originalCode: '', originalSourceVersion: '', ...patch });
const escape = v => `"${String(v).replaceAll('"', '""')}"`;
const invoiceCsv = (rows = [invoiceRow()]) => '\uFEFF' + Object.values(invoiceMap.columns).map(escape).join(',') + '\r\n' + rows.map(row => Object.keys(invoiceMap.columns).map(k => escape(row[k])).join(',')).join('\r\n');
const bankCsv = (tail = '') => '发生日期,交易金额,收支,摘要,流水号\r\n2026/07/17,647.29,收,"往来款,中文""备注""\n第二行",bank-001' + tail;
const businessDoc = () => ({ version: 'business-facts/1', scope: clone(scope), facts: [{ factId: 'service-1', date: '2026-07-16', nature: 'service', performance: 'completed', settlement: 'unpaid', purpose: 'unknown', benefitPeriod: { state: 'unknown', from: null, to: null }, invoiceRef: { sellerKey: scope.enterpriseKey, code: '0200', number: '10000001' } }] });
const source = (kind, text, mapping, sourceId = kind) => ({ kind, text, mapping: clone(mapping), scope: clone(scope), sourceId, fileSha256: digest(text) });
const invoices = rows => source('invoice_csv', invoiceCsv(rows), invoiceMap);
const banks = text => source('bank_csv', text ?? bankCsv(), bankMap);
const business = doc => source('business_json', JSON.stringify(doc ?? businessDoc()), { format: 'business-facts-json-v1' });
const batch = sources => ({ scope: clone(scope), sources: sources ?? [invoices(), banks(), business()] });
const preflight = sources => preflightMaterials(batch(sources));
const accepted = input => { const result = preflightMaterials(input); assert.equal(result.ok, true, JSON.stringify(result.errors)); assert.equal(result.completeness, 'not_assessed'); assert.equal(result.authorizesExecution, false); return result; };
const rejected = input => { const result = preflightMaterials(input); assert.equal(result.ok, false); assert.equal(result.status, 'rejected'); assert.deepEqual(result.records, []); assert.match(result.errors[0].code, /^[a-z_]+$/); assert.ok(Object.keys(result.errors[0]).every(k => ['code', 'sourceIndex', 'row', 'line', 'field'].includes(k))); return result; };
const cli = fileURLToPath(new URL('../scripts/offline-materials.mjs', import.meta.url));
function onDisk(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'offline-materials-synthetic-'));
  try {
    const input = batch();
    const config = { scope: input.scope, sources: input.sources.map((s, i) => {
      const path = `SENSITIVE-PATH-${i}.${s.kind === 'business_json' ? 'json' : 'csv'}`;
      writeFileSync(join(dir, path), s.text);
      return { sourceId: s.sourceId, kind: s.kind, scope: s.scope, mapping: s.mapping, path };
    }) };
    const configPath = join(dir, 'config.json'), output = join(dir, 'report.json');
    const save = () => writeFileSync(configPath, JSON.stringify(config)); save();
    const run = (args = ['--config', configPath, '--output', output]) => {
      const child = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000, cwd: dir });
      assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.stderr, '');
      assert.doesNotMatch(child.stdout, /SENSITIVE|SYNTHETIC|1234|647|report\.json|config\.json|往来/);
      return child;
    };
    fn({ dir, config, configPath, output, save, run });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('nonzero invoice, quoted BOM Chinese CSV and business facts preserve independent expected cents', () => {
  const r = accepted(batch());
  assert.equal(r.status, 'preflight_only'); assert.equal(r.assessment.status, 'not_implemented');
  const invoice = r.records.find(r => r.kind === 'invoice');
  assert.equal(invoice.data.net, '1234.57'); assert.equal(invoice.data.tax, '37.04'); assert.equal(invoice.data.gross, '1271.61');
  assert.equal(123457 + 3704, 127161);
  assert.equal(invoice.location.line, 2); assert.equal(invoice.location.fields.tax.column, 7);
  assert.equal(r.records[1].data.amount, '647.29'); assert.equal(r.records[1].data.summary, '往来款,中文"备注"\n第二行');
  assert.equal(r.records[1].data.accountingMeaning, 'unclassified_bank_activity');
  assert.equal(r.records[2].data.settlement, 'unpaid'); assert.equal(r.records[2].location.fields.nature.pointer, '/facts/0/nature');
});
test('input not mutated and byte-identical replay deterministic', () => { const x = batch(), before = JSON.stringify(x); assert.deepEqual(accepted(x), accepted(clone(x))); assert.equal(JSON.stringify(x), before); });
test('pure boundary refuses accessors without invoking them, cycles, sparse arrays and non JSON objects', () => {
  const b = batch(); let calls = 0; Object.defineProperty(b, 'scope', { get() { calls++; throw new Error('SENSITIVE'); }, enumerable: true }); rejected(b); assert.equal(calls, 0);
  const c = batch(); c.self = c; rejected(c); const d = batch(); delete d.sources[1]; rejected(d); const e = batch(); e.scope = new Date(); rejected(e);
});
test('explicit zero tax accepted; blank tax is missing and rejected', () => { accepted(batch([invoices([invoiceRow({ tax: '0', gross: '1234.57' })])])); rejected(batch([invoices([invoiceRow({ tax: '', gross: '1234.57' })])])); });
test('sub-cent, exponent, overflow, negative zero and total cent mismatch rejected', () => {
  for (const net of ['1.001', '1e3', '10000000000000.00', '-0.00', '', ' 1234.57']) rejected(batch([invoices([invoiceRow({ net })])]));
  rejected(batch([invoices([invoiceRow({ gross: '1271.62' })])]));
});
test('pure errors retain fixed classification and numeric source/row plus fixed field without raw content', () => {
  const r = rejected(batch([invoices([invoiceRow(), invoiceRow({ tax: 'SENSITIVE' })])]));
  assert.deepEqual(r.errors, [{ code: 'amount_invalid', sourceIndex: 0, row: 2, line: 3, field: 'tax' }]); assert.doesNotMatch(JSON.stringify(r), /SENSITIVE|SYNTHETIC|1234/);
});
test('real calendar and quarter boundary enforced', () => { for (const date of ['2026-02-30', '2026-09-31', '2026-06-30', '2026-10-01']) rejected(batch([invoices([invoiceRow({ date })])])); });
test('explicit month range includes both ends and rejects outside', () => {
  const b = batch([invoices([invoiceRow({ date: '2026-08-31' })])]); b.scope.period = { from: '2026-07', to: '2026-08' }; b.sources[0].scope = clone(b.scope); accepted(b);
  b.scope.period = { from: '2026-07', to: '2026-07' }; b.sources[0].scope = clone(b.scope); rejected(b);
});
test('wrong enterprise and purchase role owner rejected or accepted explicitly', () => {
  rejected(batch([invoices([invoiceRow({ sellerKey: 'WRONG-OWNER' })])]));
  const i = invoices([invoiceRow({ buyerKey: scope.enterpriseKey, sellerKey: 'SELLER-OTHER' })]); i.mapping.role = 'purchase'; accepted(batch([i]));
  i.mapping.role = 'sales'; rejected(batch([i]));
});
test('cross enterprise/account/period/currency/unit source metadata rejected', () => { for (const [key, value] of [['enterpriseKey', 'OTHER'], ['accountSetId', 'other'], ['period', '2026-Q2'], ['currency', 'USD'], ['unit', 'fen']]) { const b = batch(); b.sources[0].scope[key] = value; rejected(b); } });
test('strict column mapping no guessing unknown fields duplicate header malformed quote rejected', () => {
  const a = invoices(); delete a.mapping.columns.tax; rejected(batch([a]));
  const b = invoices(); b.mapping.columns.tax = '不存在'; rejected(batch([b]));
  const c = invoices(); c.mapping.columns.accountCode = '科目'; rejected(batch([c]));
  for (const csv of ['a,a\n1,2', '"broken', invoiceCsv().replace('"税额"', '"金额"')]) { const s = invoices(); s.text = csv; s.fileSha256 = digest(csv); rejected(batch([s])); }
});
test('empty files/header only/empty facts never zero business', () => {
  for (const text of ['', Object.values(invoiceMap.columns).join(',')]) rejected(batch([source('invoice_csv', text, invoiceMap)]));
  const doc = businessDoc(); doc.facts = []; rejected(batch([invoices(), business(doc)]));
});
test('missing entire class stays partial not_assessed', () => { const r = accepted(batch([invoices()])); assert.equal(r.status, 'partial'); assert.deepEqual(r.missingKinds, ['bank_csv', 'business_json']); });
test('same amounts different invoice IDs are unique', () => { const r = accepted(batch([invoices([invoiceRow(), invoiceRow({ number: '10000002' })])])); assert.equal(new Set(r.records.map(r => r.docId)).size, 2); assert.ok(r.records.every(r => r.duplicateStatus === 'unique')); });
test('same stable invoice same semantic retains all locations as duplicate', () => { const r = accepted(batch([invoices([invoiceRow(), invoiceRow()])])); assert.equal(r.counts.duplicates, 2); assert.deepEqual(r.records.map(r => r.location.line), [2, 3]); });
test('stable ID changed contents blocked conflict never overwritten', () => { const r = preflight([invoices([invoiceRow(), invoiceRow({ net: '1234.58', gross: '1271.62' })])]); assert.equal(r.ok, false); assert.equal(r.status, 'blocked_conflict'); assert.equal(r.records.length, 2); assert.equal(r.counts.conflicts, 2); });
test('duplicate and conflict detection works across multiple files', () => { const a = invoices(), b = invoices(); b.sourceId = 'file-two'; assert.equal(preflight([a, b]).counts.duplicates, 2); const c = invoices([invoiceRow({ buyerKey: 'CHANGED-BUYER' })]); c.sourceId = 'file-three'; assert.equal(preflight([a, c]).status, 'blocked_conflict'); });
test('red signed negative needs original identity/version, all signs consistent', () => {
  const red = invoiceRow({ number: '10000002', status: '红字', net: '-1234.57', tax: '-37.04', gross: '-1271.61', originalNumber: '10000001', originalCode: '0200', originalSourceVersion: 'a'.repeat(64) });
  assert.equal(accepted(batch([invoices([red])])).records[0].data.gross, '-1271.61');
  for (const patch of [{ originalNumber: '' }, { originalSourceVersion: '' }, { tax: '37.04', gross: '-1197.53' }, { originalNumber: '10000002' }]) rejected(batch([invoices([{ ...red, ...patch }])]));
});
test('unsigned red amounts converted only under explicit sign declaration', () => {
  const red = invoiceRow({ number: '10000002', status: '红字', originalNumber: '10000001', originalCode: '0200', originalSourceVersion: 'b'.repeat(64) });
  const s = invoices([red]); rejected(batch([s])); s.mapping.redSign = 'unsigned_positive'; assert.equal(accepted(batch([s])).records[0].data.net, '-1234.57');
});
test('blue negative/status unsupported rejected', () => { rejected(batch([invoices([invoiceRow({ net: '-10', tax: '-1', gross: '-11' })])])); rejected(batch([invoices([invoiceRow({ status: '已作废' })])])); });
test('bank amount/real date/scope/direction rejected, never guessed', () => {
  for (const patch of ['2026/07/17,0,收,x,b1', '2026/07/17,1.001,收,x,b1', '2026/07/17,1,未知,x,b1', '2026/06/30,1,收,x,b1', '2026/09/31,1,收,x,b1']) rejected(batch([banks('发生日期,交易金额,收支,摘要,流水号\n' + patch)]));
  const b = banks(); b.mapping.ownerEnterpriseKey = 'WRONG'; rejected(batch([b]));
});
test('bank stable ID conflicting amount rejected; no ID only suspected duplicates', () => {
  const r = preflight([banks('\uFEFF发生日期,交易金额,收支,摘要,流水号\n2026/07/17,647.29,收,x,b1\n2026/07/17,647.30,收,x,b1')]); assert.equal(r.status, 'blocked_conflict');
  const r2 = accepted(batch([banks('发生日期,交易金额,收支,摘要,流水号\n2026/07/17,647.29,收,x,\n2026/07/17,647.29,收,x,\n2026/07/17,648.29,收,x,')]));
  assert.equal(r2.counts.suspectedDuplicates, 2); assert.equal(r2.counts.duplicates, 0); assert.equal(r2.records[2].duplicateStatus, 'unique');
});
test('bank explicit outflow and sign reversal do not infer expense/income', () => { const b = banks('发生日期,交易金额,收支,摘要,流水号\n2026/07/17,-42.83,收,借款,b1'); b.mapping.negativeAmount = 'reverse_direction'; const r = accepted(batch([b])); assert.equal(r.records[0].data.direction, 'outflow'); assert.equal(r.records[0].data.amount, '42.83'); assert.equal(r.records[0].kind, 'bank_activity'); });
test('JSON strict basic facts refuse prebuilt vouchers, accounts, final tax, unknown structure', () => { for (const key of ['entries', 'accountCode', 'taxAmount', 'amount']) { const d = businessDoc(); d.facts[0][key] = 'SECRET'; rejected(batch([invoices(), business(d)])); } const d = businessDoc(); d.kind = 'voucher-candidate'; rejected(batch([business(d)])); });
test('JSON date and referenced invoice IDs require canonical strings without coercion', () => {
  for (const value of [['2026-07-16'], ' 2026-07-16 ', 20260716, null]) { const d = businessDoc(); d.facts[0].date = value; rejected(batch([business(d)])); }
  for (const key of ['number', 'code']) for (const value of [10000001, ['10000001'], null]) { const d = businessDoc(); d.facts[0].invoiceRef[key] = value; rejected(batch([business(d)])); }
});
test('business scope/date/reference and conflicting facts checked', () => {
  const d = businessDoc(); d.scope.enterpriseKey = 'OTHER'; rejected(batch([invoices(), business(d)]));
  const e = businessDoc(); e.facts[0].date = '2026-10-01'; rejected(batch([invoices(), business(e)]));
  const f = businessDoc(); f.facts[0].invoiceRef.number = '999'; const missing = accepted(batch([invoices(), business(f)])); assert.equal(missing.records[1].referenceVerification, 'missing'); assert.equal(missing.status, 'partial');
  const g = businessDoc(); g.facts.push({ ...clone(g.facts[0]), settlement: 'received' }); assert.equal(preflight([invoices(), business(g)]).status, 'blocked_conflict');
});
test('purchase purpose and benefit period preserved without account or recognition inference', () => {
  const i = invoices([invoiceRow({ sellerKey: 'SUPPLIER', buyerKey: scope.enterpriseKey })]); i.mapping.role = 'purchase';
  const d = businessDoc(); d.facts[0].invoiceRef.sellerKey = 'SUPPLIER'; d.facts[0].purpose = 'asset_related'; d.facts[0].benefitPeriod = { state: 'known', from: '2026-07-01', to: '2027-06-30' };
  const r = accepted(batch([i, business(d)])); assert.equal(r.records[1].data.purpose, 'asset_related'); assert.equal(r.records[1].data.benefitPeriod.to, '2027-06-30'); assert.equal(r.records[1].data.accountCode, undefined);
  d.facts[0].benefitPeriod.from = '2026-02-30'; rejected(batch([i, business(d)]));
});
test('sourceVersion binds exact bytes, mapping, scope and rule version', () => {
  const a = accepted(batch([invoices()]));
  const b = invoices(); b.mapping.statusLabels.blue.push('有效'); const br = accepted(batch([b])); assert.notEqual(a.sources[0].sourceVersion, br.sources[0].sourceVersion); assert.equal(a.records[0].docId, br.records[0].docId);
  const c = invoices(); c.text += '\r\n'; c.fileSha256 = digest(c.text); assert.notEqual(a.sources[0].sourceVersion, accepted(batch([c])).sources[0].sourceVersion);
  const d = invoices(); d.fileSha256 = 'f'.repeat(64); rejected(batch([d]));
});
test('caller-supplied sourceVersion and duplicate source IDs refused', () => { const a = invoices(); a.sourceVersion = 'fabricated'; rejected(batch([a])); rejected(batch([invoices(), invoices()])); });
test('CLI actual files hash/replay/local output and safe stdout', () => onDisk(({ run, output, dir, config }) => {
  const child = run(); assert.equal(child.status, 0); assert.equal(child.stdout, 'OFFLINE_MATERIALS_PREFLIGHT sources=3 records=3\n');
  const report = JSON.parse(readFileSync(output, 'utf8')); assert.equal(report.completeness, 'not_assessed'); assert.equal(report.localFiles.length, 3);
  assert.equal(report.sources[0].fileSha256, digest(readFileSync(join(dir, config.sources[0].path))));
  const replay = accepted({ scope: report.scope, sources: report.sources.map(s => ({ sourceId: s.sourceId, kind: s.kind, scope: s.scope, text: s.rawContent, fileSha256: s.fileSha256, mapping: s.mapping })) }); assert.equal(replay.batchVersion, report.batchVersion);
}));
test('standalone business supplementation remains normalized with missing invoice reference in real CLI', () => onDisk(({ run, config, save, output }) => {
  config.sources = [config.sources[2]]; save(); assert.equal(run().status, 0);
  const r = JSON.parse(readFileSync(output, 'utf8')); assert.equal(r.records.length, 1); assert.equal(r.records[0].referenceVerification, 'missing'); assert.equal(r.status, 'partial'); assert.equal(r.unresolvedReferences[0].reasonCode, 'invoice_reference_missing'); assert.equal(r.completeness, 'not_assessed');
}));
test('CLI existing output unchanged and input/config cannot be overwritten', () => onDisk(({ run, output, configPath, dir, config }) => {
  writeFileSync(output, 'SENTINEL'); assert.equal(run().status, 4); assert.equal(readFileSync(output, 'utf8'), 'SENTINEL');
  for (const file of [configPath, join(dir, config.sources[0].path)]) { const before = readFileSync(file); assert.equal(run(['--config', configPath, '--output', file]).status, 4); assert.deepEqual(readFileSync(file), before); }
}));
test('CLI invalid material no output and all inputs unchanged', () => onDisk(({ run, dir, config }) => {
  writeFileSync(join(dir, config.sources[0].path), 'SENSITIVE-invalid'); const before = readdirSync(dir).map(p => [p, readFileSync(join(dir, p))]);
  assert.equal(run().status, 3); assert.deepEqual(readdirSync(dir), before.map(([p]) => p)); for (const [p, bytes] of before) assert.deepEqual(readFileSync(join(dir, p)), bytes);
}));
test('CLI bad config/path/UTF8 fixed safe error and no artifact', () => onDisk(({ run, config, save, dir }) => {
  const path = config.sources[0].path; config.sources[0].path = 'SENSITIVE-missing.csv'; save(); assert.equal(run().status, 4); config.sources[0].path = path; save(); writeFileSync(join(dir, path), Buffer.from([0xff])); assert.equal(run().status, 4); assert.equal(readdirSync(dir).includes('report.json'), false);
}));
test('CLI conflicts retained in explicit new local report with rejection exit', () => onDisk(({ run, config, dir, output }) => {
  writeFileSync(join(dir, config.sources[0].path), invoiceCsv([invoiceRow(), invoiceRow({ net: '12.34', tax: '0', gross: '12.34' })])); const child = run(); assert.equal(child.status, 3); const r = JSON.parse(readFileSync(output, 'utf8')); assert.equal(r.status, 'blocked_conflict'); assert.equal(r.records.filter(r => r.kind === 'invoice').length, 2);
}));
test('CLI requires explicit config/output and refuses unknown arguments', () => onDisk(({ run }) => { for (const args of [[], ['--config', 'SENSITIVE'], ['--help'], ['--config', 'a', '--output', 'b', '--verbose']]) { const r = run(args); assert.equal(r.status, 2); assert.equal(r.stdout, 'OFFLINE_MATERIALS_USAGE_ERROR\n'); } }));
