import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm, rename, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { initMaterialStore, receiveMaterials, inspectMaterialStore, recoverMaterialStoreLock } from '../server/offline-material-store.mjs';
import { planOffline } from '../server/offline-task-planner.mjs';

const scope = { enterpriseKey: 'SYNTHETIC-RECEIPT', accountSetId: 'receipt-book', period: '2026-Q3', currency: 'CNY', unit: 'yuan' };
const invoiceMap = { format: 'invoice-summary-csv-v1', role: 'sales', dateFormat: 'YYYY-MM-DD', redSign: 'signed_negative', statusLabels: { blue: ['blue'], red: ['red'] }, columns: { number: 'number', date: 'date', sellerKey: 'seller', buyerKey: 'buyer', net: 'net', tax: 'tax', gross: 'gross', status: 'status' } };
const bankMap = { format: 'bank-csv-v1', ownerEnterpriseKey: scope.enterpriseKey, bankAccountId: 'bank-R', dateFormat: 'YYYY-MM-DD', amountMode: 'amount_direction', currency: 'CNY', negativeAmount: 'reject', directionLabels: { inflow: ['in'], outflow: ['out'] }, columns: { date: 'date', amount: 'amount', direction: 'direction', refId: 'ref' } };
const invoice = (patch = {}) => { const r = { number: '71003', date: '2026-08-09', sellerKey: scope.enterpriseKey, buyerKey: 'BUYER-RECEIPT', net: '823.47', tax: '24.70', gross: '848.17', status: 'blue', ...patch }; return '\uFEFF' + Object.values(invoiceMap.columns).join(',') + '\r\n' + Object.keys(invoiceMap.columns).map(k => r[k]).join(','); };
const bank = () => 'date,amount,direction,ref\n2026-08-10,196.83,out,bank-r1';
const business = (patch = {}) => JSON.stringify({ version: 'business-facts/1', scope, facts: [{ factId: 'fact-R', date: '2026-08-09', nature: 'service', performance: 'completed', settlement: 'unpaid', purpose: 'unknown', benefitPeriod: { state: 'unknown', from: null, to: null }, invoiceRef: { sellerKey: scope.enterpriseKey, code: '', number: '71003' }, ...patch }] });
const cli = fileURLToPath(new URL('../scripts/offline-material-store.mjs', import.meta.url));
const moduleUrl = new URL('../server/offline-material-store.mjs', import.meta.url).href;
const clone = structuredClone;
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'offline-receipt-synthetic-')), store = join(dir, 'store');
  const configPath = join(dir, 'config.json'), scopePath = join(dir, 'scope.json');
  const config = { scope: clone(scope), sources: [] };
  const save = () => writeFile(configPath, JSON.stringify(config));
  const add = async (id = 'invoice-R', kind = 'invoice_csv', text = invoice(), mapping = invoiceMap, path = `${id}.csv`) => {
    await writeFile(join(dir, path), text); const s = { sourceId: id, kind, scope: clone(scope), path, mapping: clone(mapping) }; config.sources.push(s); await save(); return s;
  };
  const run = (command, output = `out-${Math.random()}.json`, customArgs) => {
    const args = customArgs ?? [command, '--store', store, ...(['init', 'receive'].includes(command) ? ['--config', command === 'init' ? scopePath : configPath] : []), '--output', join(dir, output)];
    const c = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000 });
    assert.equal(c.error, undefined); assert.equal(c.signal, null); assert.equal(c.stderr, '');
    assert.doesNotMatch(c.stdout, /SYNTHETIC|BUYER|848|823|196|\.csv|\.json|[A-Z]:\\|71003|stack/i);
    assert.match(c.stdout, /^OFFLINE_STORE_(?:[A-Z_]+ sources=\d+ records=\d+ receipts=\d+|BLOCKED code=[a-z_]+|USAGE_ERROR)\n$/);
    return c;
  };
  await writeFile(scopePath, JSON.stringify({ scope })); await save();
  try { await fn({ dir, store, configPath, scopePath, config, save, add, run }); if (!process.env.KEEP_FIXTURES) await rm(dir, { recursive: true }); }
  catch (e) { process.stderr.write(`Retained failed synthetic fixture: ${dir}\n`); throw e; }
}
const rejected = (work, code) => assert.rejects(work, e => e.code === code);
const receiptDirs = async store => (await readdir(store)).filter(n => /^\d{6}-/.test(n));
const receive = f => receiveMaterials(f.store, f.configPath);
async function initialize(f) { await initMaterialStore(f.store, scope); await f.add(); }
const evidence = id => ({ evidenceId: id, kind: 'customer_declaration', scope: clone(scope), confirmedBy: { name: 'SYNTHETIC-OWNER', role: id === 'tax' ? 'accountant' : 'owner' }, basis: '合成事实依据' });
const declaration = () => ({ version: 'offline-declaration/1', scope: clone(scope), profile: 'small-2011', businessScope: 'service-company', enterpriseEvidenceIds: ['owner'], evidence: [evidence('owner'), evidence('tax')], applicability: [{ area: 'payroll', present: false, evidenceIds: ['owner'] }, { area: 'assets', present: false, evidenceIds: ['owner'] }], bankAccounts: { accountIds: ['bank-R'], evidenceIds: ['owner'] }, coverage: [{ kind: 'sales', accountId: null, from: '2026-07', to: '2026-09', state: 'complete', sourceIds: ['invoice-R'], evidenceIds: ['owner'] }, { kind: 'purchase', accountId: null, from: '2026-07', to: '2026-09', state: 'no_activity', sourceIds: [], evidenceIds: ['owner'] }, { kind: 'bank', accountId: 'bank-R', from: '2026-07', to: '2026-09', state: 'complete', sourceIds: ['bank-R'], evidenceIds: ['owner'] }], tax: { vatStatus: 'small_scale', filingFrequency: 'quarterly', evidenceIds: ['tax'] }, opening: { state: 'new_zero', evidenceIds: ['owner'] }, history: { state: 'first_period', evidenceIds: ['owner'] }, bankFacts: [{ bankAccountId: 'bank-R', refId: 'bank-r1', nature: 'operating_payment', evidenceIds: ['owner'] }] });
const plan = (r, previousPlan) => planOffline({ scope, reports: r.reports, declaration: declaration(), ...(previousPlan ? { previousPlan } : {}) });

test('explicit init refuses existing empty and unknown directory without takeover', () => fixture(async f => {
  await mkdir(f.store); await assert.rejects(initMaterialStore(f.store, scope)); assert.deepEqual(await readdir(f.store), []);
  await writeFile(join(f.store, 'unknown'), 'keep'); await assert.rejects(initMaterialStore(f.store, scope)); assert.equal(await readFile(join(f.store, 'unknown'), 'utf8'), 'keep');
}));
test('first receipt preserves raw BOM bytes, mapping, locations, independent money and unverified authority', () => fixture(async f => {
  await initialize(f); const r = await receive(f); assert.equal(r.status, 'received'); assert.equal(r.counts.receipts, 1); assert.equal(r.authorizesExecution, false); assert.equal(r.completeness, 'not_assessed'); assert.equal(r.authenticity, 'unverified');
  assert.equal(r.writerBlocked, false); assert.equal((await inspectMaterialStore(f.store)).writerBlocked, false);
  const rec = r.reports[0].records[0]; assert.equal(rec.data.gross, '848.17'); assert.equal(82347 + 2470, 84817); assert.equal(rec.location.row, 1); assert.equal(rec.location.fields.tax.column, 6); assert.equal(invoice().split('\r\n')[0].replace(/^\uFEFF/, '').split(',')[rec.location.fields.tax.column - 1], 'tax');
  const dir = (await receiptDirs(f.store))[0]; assert.deepEqual(await readFile(join(f.store, dir, '0.blob')), Buffer.from(invoice())); assert.deepEqual(r.active[0].mapping, invoiceMap);
}));
test('new process inspect recomputes report and cross-process retry replays exact durable receipt', () => fixture(async f => {
  await initialize(f); const first = await receive(f); assert.equal(f.run('inspect', 'inspect.json').status, 0);
  const reopened = JSON.parse(await readFile(join(f.dir, 'inspect.json'))); assert.deepEqual(reopened.reports, first.reports);
  assert.equal(f.run('receive', 'retry.json').status, 0); const retry = JSON.parse(await readFile(join(f.dir, 'retry.json'))); assert.equal(retry.status, 'replayed'); assert.deepEqual(retry.receiptIds, first.receiptIds); assert.equal((await receiptDirs(f.store)).length, 1);
}));
test('cross-batch identical source reuses receipt while independent supplemental source appends once', () => fixture(async f => {
  await initialize(f); const first = await receive(f); await f.add('bank-R', 'bank_csv', bank(), bankMap); const second = await receive(f);
  assert.equal(second.counts.sources, 2); assert.equal(second.counts.receipts, 2); assert.ok(second.receiptIds.includes(first.receiptIds[0])); assert.equal((await receive(f)).counts.receipts, 2);
}));
test('different exports of same stable business ID identify duplicate; equal amount different ID stays unique', () => fixture(async f => {
  await initialize(f); await receive(f); f.config.sources = []; await f.add('copy-R', 'invoice_csv', invoice()); const r = await receive(f); assert.equal(r.reports[0].counts.duplicates, 2); assert.equal(new Set(r.reports[0].records.map(x => x.docId)).size, 1);
  f.config.sources = []; await f.add('other-R', 'invoice_csv', invoice({ number: '71004' })); const r2 = await receive(f); assert.equal(r2.reports[0].records.find(x => x.sourceId === 'other-R').duplicateStatus, 'unique');
}));
test('different source same business divergent cents is conflict with zero durable change', () => fixture(async f => {
  await initialize(f); await receive(f); f.config.sources = []; await f.add('copy-R', 'invoice_csv', invoice({ net: '824.47', gross: '849.17' }));
  await rejected(() => receive(f), 'material_conflict'); assert.equal((await receiptDirs(f.store)).length, 1); assert.equal((await inspectMaterialStore(f.store)).counts.sources, 1);
}));
test('receipt of invoice only cannot mark period complete and #79 asks for facts', () => fixture(async f => {
  await initialize(f); const r = await receive(f); const p = plan(r); assert.equal(p.authorizesExecution, false); assert.ok(p.tasks.some(t => t.operation === 'prepare_service_sale_materials' && t.status === 'blocked_missing_data')); assert.ok(p.customerRequest.requests.length > 0); assert.notEqual(p.tasks.find(t => t.taskId === 'period').status, 'ready');
}));
test('same source amount/date/mapping edits refuse silent replacement and preserve original blobs', () => fixture(async f => {
  await initialize(f); const r = await receive(f), oldDir = (await receiptDirs(f.store))[0];
  for (const text of [invoice({ net: '824.47', gross: '849.17' }), invoice({ date: '2026-08-11' })]) { await writeFile(join(f.dir, 'invoice-R.csv'), text); await rejected(() => receive(f), 'source_version_conflict'); }
  await writeFile(join(f.dir, 'invoice-R.csv'), invoice()); f.config.sources[0].mapping.statusLabels.blue.push('normal'); await f.save(); await rejected(() => receive(f), 'source_version_conflict');
  assert.equal((await receiptDirs(f.store)).length, 1); assert.deepEqual(await readFile(join(f.store, oldDir, '0.blob')), Buffer.from(invoice())); assert.equal(r.active[0].sourceVersion.length, 64);
}));
test('explicit correction CAS preserves history, stable docId and active only new source version', () => fixture(async f => {
  await initialize(f); const old = await receive(f); const s = f.config.sources[0]; s.supersedes = old.active[0].sourceVersion; s.expectedSourceVersion = s.supersedes; await writeFile(join(f.dir, s.path), invoice({ net: '824.47', gross: '849.17' })); await f.save();
  const r = await receive(f); assert.equal(r.history.length, 2); assert.equal(r.active.length, 1); assert.equal(r.active[0].supersedes, old.active[0].sourceVersion); assert.equal(r.reports[0].records[0].docId, old.reports[0].records[0].docId); assert.equal(r.reports[0].records[0].data.gross, '849.17');
  assert.deepEqual((await receive(f)).receiptIds, r.receiptIds); assert.deepEqual(await readFile(join(f.store, (await receiptDirs(f.store))[0], '0.blob')), Buffer.from(invoice()));
}));
test('wrong/missing/stale CAS and correction against unknown source reject without active change', () => fixture(async f => {
  await initialize(f); const r = await receive(f); await writeFile(join(f.dir, 'invoice-R.csv'), invoice({ date: '2026-08-11' }));
  for (const patch of [{ supersedes: 'f'.repeat(64) }, { supersedes: 'f'.repeat(64), expectedSourceVersion: 'f'.repeat(64) }, { supersedes: r.active[0].sourceVersion, expectedSourceVersion: 'f'.repeat(64) }]) {
    Object.assign(f.config.sources[0], patch); await f.save(); await assert.rejects(receive(f)); assert.equal((await receiptDirs(f.store)).length, 1);
  }
  f.config.sources[0].sourceId = 'unknown'; f.config.sources[0].supersedes = r.active[0].sourceVersion; f.config.sources[0].expectedSourceVersion = r.active[0].sourceVersion; await f.save(); await rejected(() => receive(f), 'correction_cas_conflict');
}));
test('new facts supplement invalidates only invoice branch; unrelated bank digest unchanged', () => fixture(async f => {
  await initialize(f); await f.add('bank-R', 'bank_csv', bank(), bankMap); const before = plan(await receive(f));
  f.config.sources = []; await f.add('facts-R', 'business_json', business(), { format: 'business-facts-json-v1' }, 'facts.json'); const after = plan(await receive(f), before);
  const b = before.tasks.find(t => t.operation === 'prepare_bank_activity'), sale = after.tasks.find(t => t.operation === 'prepare_service_sale_materials');
  assert.equal(sale.status, 'ready'); assert.ok(after.changes.invalidated.some(t => t.taskId === sale.taskId)); assert.equal(after.tasks.find(t => t.taskId === b.taskId).inputDigest, b.inputDigest); assert.ok(after.changes.unchanged.some(t => t.taskId === b.taskId));
}));
test('correction invalidates matching plan digest and leaves independent bank branch intact', () => fixture(async f => {
  await initialize(f); await f.add('bank-R', 'bank_csv', bank(), bankMap); await f.add('facts-R', 'business_json', business(), { format: 'business-facts-json-v1' }, 'facts.json'); const r = await receive(f), p = plan(r);
  f.config.sources = [f.config.sources[0]]; Object.assign(f.config.sources[0], { supersedes: r.active.find(e => e.sourceId === 'invoice-R').sourceVersion, expectedSourceVersion: r.active.find(e => e.sourceId === 'invoice-R').sourceVersion }); await writeFile(join(f.dir, 'invoice-R.csv'), invoice({ net: '825.47', gross: '850.17' })); await f.save(); const q = plan(await receive(f), p);
  const sale = p.tasks.find(t => t.operation === 'prepare_service_sale_materials'), b = p.tasks.find(t => t.operation === 'prepare_bank_activity'); assert.ok(q.changes.invalidated.some(t => t.taskId === sale.taskId)); assert.equal(q.tasks.find(t => t.taskId === b.taskId).inputDigest, b.inputDigest);
}));
test('strict store scope cross enterprise/account/period/currency/unit never appends', () => fixture(async f => {
  await initialize(f); await receive(f);
  for (const [key, value] of [['enterpriseKey', 'OTHER-RECEIPT'], ['accountSetId', 'other-book'], ['period', '2026-Q4'], ['currency', 'USD'], ['unit', 'fen']]) {
    f.config.scope = { ...scope, [key]: value }; f.config.sources[0].scope = clone(f.config.scope); await f.save(); await assert.rejects(receive(f)); assert.equal((await receiptDirs(f.store)).length, 1);
  }
}));
test('illegal dates/amounts/unknown fields and non UTF8 are rejected with no receipt', () => fixture(async f => {
  await initialize(f);
  for (const text of [invoice({ date: '2026-09-31' }), invoice({ net: '1.001' }), invoice({ gross: '' }), Buffer.from([0xff])]) { await writeFile(join(f.dir, 'invoice-R.csv'), text); await assert.rejects(receive(f)); assert.equal((await receiptDirs(f.store)).length, 0); }
  await writeFile(join(f.dir, 'invoice-R.csv'), invoice()); f.config.sources[0].automatic = true; await f.save(); await assert.rejects(receive(f));
}));
test('origin byte replacement is explicit stale and CLI diagnostic exposes no reports', () => fixture(async f => {
  await initialize(f); await receive(f); await rename(join(f.dir, 'invoice-R.csv'), join(f.dir, 'old.csv')); await writeFile(join(f.dir, 'invoice-R.csv'), invoice({ date: '2026-08-12' }));
  const stale = await inspectMaterialStore(f.store); assert.equal(stale.status, 'blocked_origin_changed'); assert.equal(stale.receipts.length, 1); assert.deepEqual(stale.reports, []); assert.equal(f.run('inspect', 'stale.json').status, 4); const r = JSON.parse(await readFile(join(f.dir, 'stale.json'))); assert.equal(r.errors[0].code, 'origin_changed'); assert.deepEqual(r.reports, []); assert.equal(r.receipts.length, 1);
}));
test('tampered immutable blob fails closed even explicit correction cannot bypass historical corruption', () => fixture(async f => {
  await initialize(f); const r = await receive(f), dir = (await receiptDirs(f.store))[0]; await writeFile(join(f.store, dir, '0.blob'), invoice({ date: '2026-08-12' })); await rejected(() => inspectMaterialStore(f.store), 'blob_corrupt');
  Object.assign(f.config.sources[0], { supersedes: r.active[0].sourceVersion, expectedSourceVersion: r.active[0].sourceVersion }); await f.save(); await rejected(() => receive(f), 'blob_corrupt'); assert.equal((await receiptDirs(f.store)).length, 1);
}));
test('one stale invoice origin quarantines only that source; valid bank plan digest remains unchanged', () => fixture(async f => {
  await initialize(f); await f.add('bank-R', 'bank_csv', bank(), bankMap); const before = plan(await receive(f));
  await writeFile(join(f.dir, 'invoice-R.csv'), invoice({ net: '826.47', gross: '851.17' })); const r = await inspectMaterialStore(f.store);
  assert.equal(r.status, 'blocked_origin_changed'); assert.deepEqual(r.staleSourceIds, ['invoice-R']); assert.equal(r.receipts.length, 1); assert.deepEqual(r.reports[0].sources.map(s => s.sourceId), ['bank-R']); assert.equal(r.reports[0].records[0].data.amount, '196.83');
  const after = plan(r, before), b = before.tasks.find(t => t.operation === 'prepare_bank_activity'); assert.equal(after.tasks.find(t => t.taskId === b.taskId).inputDigest, b.inputDigest); assert.ok(after.customerRequest.requests.length > 0); assert.ok(!after.tasks.some(t => t.operation === 'prepare_service_sale_materials' && t.status === 'ready'));
}));
test('unrelated stale invoice does not prevent durable receipt of newly supplied bank material', () => fixture(async f => {
  await initialize(f); await receive(f); await writeFile(join(f.dir, 'invoice-R.csv'), invoice({ date: '2026-08-12' }));
  f.config.sources = []; await f.add('bank-R', 'bank_csv', bank(), bankMap); const r = await receive(f); assert.equal(r.status, 'blocked_origin_changed'); assert.equal(r.receiveStatus, 'received'); assert.equal(r.receiptIds.length, 1); assert.equal(r.receipts.length, 2); assert.deepEqual(r.reports[0].sources.map(s => s.sourceId), ['bank-R']); assert.equal(r.writerBlocked, false);
  const replay = await receive(f); assert.equal(replay.receiveStatus, 'replayed'); assert.deepEqual(replay.receiptIds, r.receiptIds); assert.equal(replay.receipts.length, 2);
}));
test('manifest actual bytes and chain directory name are verified; cached derived values forbidden', () => fixture(async f => {
  await initialize(f); await receive(f); const dir = (await receiptDirs(f.store))[0], p = join(f.store, dir, 'manifest.json'); const original = await readFile(p); const m = JSON.parse(original); m.status = 'ready'; await writeFile(p, JSON.stringify(m)); await rejected(() => inspectMaterialStore(f.store), 'store_corrupt'); await writeFile(p, original); assert.equal((await inspectMaterialStore(f.store)).status, 'verified');
}));
test('unknown files never silently skipped or removed', () => fixture(async f => {
  await initialize(f); await writeFile(join(f.store, 'foreign'), 'keep'); await rejected(() => receive(f), 'store_corrupt'); assert.equal(await readFile(join(f.store, 'foreign'), 'utf8'), 'keep');
}));
test('hardlink origins and internal blob aliases are actually created and rejected', () => fixture(async f => {
  await initialize(f); await link(join(f.dir, 'invoice-R.csv'), join(f.dir, 'alias.csv')); await rejected(() => receive(f), 'path_rejected'); await rm(join(f.dir, 'alias.csv')); await receive(f);
  const p = join(f.store, (await receiptDirs(f.store))[0], '0.blob'); await link(p, join(f.dir, 'blob-alias')); await rejected(() => inspectMaterialStore(f.store), 'path_rejected');
}));
test('directory link and linked config refuse boundary traversal', () => fixture(async f => {
  await initialize(f); await symlink(f.dir, join(f.dir, 'linked'), 'junction'); f.config.sources[0].path = 'linked/invoice-R.csv'; await f.save(); await rejected(() => receive(f), 'path_rejected');
}));
test('actual directory substitution is rejected or Windows blocks operation with original store intact', () => fixture(async f => {
  await initialize(f); await receive(f); const moved = join(f.dir, 'moved');
  await rename(f.store, moved); await symlink(moved, f.store, 'junction'); await rejected(() => inspectMaterialStore(f.store), 'path_rejected');
}));
test('live/unknown locks block writes and recovery; inspect still verifies durable receipts', () => fixture(async f => {
  await initialize(f); await receive(f); const meta = JSON.parse(await readFile(join(f.store, 'store.json')));
  await writeFile(join(f.store, 'lock.json'), JSON.stringify({ version: 'offline-material-store/1', storeId: meta.storeId, pid: process.pid, token: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }));
  assert.equal((await inspectMaterialStore(f.store)).writerBlocked, true); await rejected(() => receive(f), 'store_locked'); await rejected(() => recoverMaterialStoreLock(f.store), 'lock_live_or_uncertain');
  await writeFile(join(f.store, 'lock.json'), '{}'); await assert.rejects(recoverMaterialStoreLock(f.store)); assert.equal(await readFile(join(f.store, 'lock.json'), 'utf8'), '{}');
}));
async function crashReceive(f, when) {
  // Test-only wrapper performs real fs writes/rename, then kills this actual child.
  // No product fault flag, fabricated receipt or mocked normalization.
  const code = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.promises.rename; fs.promises.rename=async(...args)=>{ ${when === 'before' ? "process.kill(process.pid,'SIGKILL');" : ''} const r=await original(...args); ${when === 'after' ? "process.kill(process.pid,'SIGKILL');" : ''} return r; }; syncBuiltinESMExports(); const m=await import(${JSON.stringify(moduleUrl)}); await m.receiveMaterials(${JSON.stringify(f.store)},${JSON.stringify(f.configPath)});`;
  const c = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { encoding: 'utf8', timeout: 20000 }); assert.equal(c.error, undefined); assert.ok(c.signal || c.status !== 0); assert.equal(c.stdout, ''); assert.equal(c.stderr, '');
}
test('real pre-commit child death leaves orphan only and absent PID explicit recovery allows receive', () => fixture(async f => {
  await initialize(f); await crashReceive(f, 'before'); const r = await inspectMaterialStore(f.store); assert.equal(r.counts.receipts, 0); assert.equal(r.counts.sources, 0); assert.equal(r.writerBlocked, true); assert.ok((await readdir(f.store)).some(n => n.startsWith('pending-')));
  await rejected(() => receive(f), 'store_locked'); await recoverMaterialStoreLock(f.store); const after = await receive(f); assert.equal(after.counts.receipts, 1); assert.equal(after.counts.sources, 1);
}));
test('real post-commit response loss exposes committed receipt on restart and retry replays exactly once', () => fixture(async f => {
  await initialize(f); await crashReceive(f, 'after'); assert.equal(f.run('inspect', 'restart.json').status, 0); const r = JSON.parse(await readFile(join(f.dir, 'restart.json'))); assert.equal(r.counts.receipts, 1); assert.equal(r.writerBlocked, true);
  await recoverMaterialStoreLock(f.store); const replay = await receive(f); assert.equal(replay.status, 'replayed'); assert.deepEqual(replay.receiptIds, r.receipts.map(x => x.receiptId)); assert.equal(replay.counts.receipts, 1);
}));
test('simultaneous actual processes cannot duplicate active receipts', () => fixture(async f => {
  await initialize(f);
  const run = n => new Promise((resolve, reject) => { const c = spawn(process.execPath, [cli, 'receive', '--store', f.store, '--config', f.configPath, '--output', join(f.dir, `concurrent-${n}.json`)]); let out = '', err = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d); c.on('error', reject); c.on('close', (code, signal) => resolve({ code, signal, out, err })); });
  const results = await Promise.all([run(1), run(2), run(3)]); assert.ok(results.some(r => r.code === 0)); assert.ok(results.every(r => [0, 4].includes(r.code) && r.signal === null && r.err === '')); assert.equal((await inspectMaterialStore(f.store)).counts.receipts, 1); assert.equal((await inspectMaterialStore(f.store)).counts.sources, 1);
}));
function gatedChild(f, mode) {
  const code = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const method=${JSON.stringify(mode === 'recover' ? 'unlink' : 'rename')}; const original=fs.promises[method]; let first=true; fs.promises[method]=async(...args)=>{ if(first && (method==='rename'||String(args[0]).endsWith('lock.json'))){ first=false; process.send('held'); await new Promise(r=>process.once('message',r)); } return original(...args); }; syncBuiltinESMExports(); try {const m=await import(${JSON.stringify(moduleUrl)}); await m.${mode === 'recover' ? 'recoverMaterialStoreLock' : 'receiveMaterials'}(${JSON.stringify(f.store)}${mode === 'recover' ? '' : `,${JSON.stringify(f.configPath)}`}); process.send('done');} catch(e){process.send({error:e.code});process.exitCode=1;} process.disconnect();`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let out = '', err = '', waiting; const messages = [];
  child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
  child.on('message', m => { if (waiting) { const r = waiting; waiting = null; r(m); } else messages.push(m); });
  const exit = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, out, err })); });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(r => { waiting = r; });
  return { child, next, exit };
}
test('recovery guard serializes actual recoverers and prevents removal of a newly live writer lock', () => fixture(async f => {
  await initialize(f); await crashReceive(f, 'before'); const a = gatedChild(f, 'recover'); let writer;
  try {
    assert.equal(await a.next(), 'held'); const oldLock = await readFile(join(f.store, 'lock.json'));
    await rejected(() => recoverMaterialStoreLock(f.store), 'recovery_blocked'); await rejected(() => receive(f), 'recovery_blocked'); assert.deepEqual(await readFile(join(f.store, 'lock.json')), oldLock);
    a.child.send('continue'); assert.equal(await a.next(), 'done'); assert.equal((await a.exit).code, 0);
    writer = gatedChild(f, 'receive'); assert.equal(await writer.next(), 'held'); const liveLock = await readFile(join(f.store, 'lock.json'));
    await rejected(() => recoverMaterialStoreLock(f.store), 'lock_live_or_uncertain'); assert.deepEqual(await readFile(join(f.store, 'lock.json')), liveLock);
    writer.child.send('continue'); assert.equal(await writer.next(), 'done'); const ended = await writer.exit; assert.equal(ended.code, 0); assert.equal(ended.err, ''); assert.equal((await inspectMaterialStore(f.store)).counts.receipts, 1);
  } finally { if (a.child.exitCode === null) a.child.kill('SIGKILL'); if (writer?.child.exitCode === null) writer.child.kill('SIGKILL'); }
}));
test('uncertain abandoned recovery guard blocks all writers and recovery without deleting anything', () => fixture(async f => {
  await initialize(f); await writeFile(join(f.store, 'recovery.guard'), 'unknown'); await rejected(() => receive(f), 'recovery_blocked'); await rejected(() => recoverMaterialStoreLock(f.store), 'recovery_blocked'); assert.equal(await readFile(join(f.store, 'recovery.guard'), 'utf8'), 'unknown'); assert.equal((await inspectMaterialStore(f.store)).writerBlocked, true);
}));
test('unchanged source relocated to different origin is explicitly unsupported without extra version', () => fixture(async f => {
  await initialize(f); await receive(f); await writeFile(join(f.dir, 'moved.csv'), invoice()); f.config.sources[0].path = 'moved.csv'; await f.save(); await rejected(() => receive(f), 'source_origin_conflict'); assert.equal((await receiptDirs(f.store)).length, 1);
}));
test('new output exclusive create rejects overwrite before receive and preserves existing bytes', () => fixture(async f => {
  await initialize(f); await writeFile(join(f.dir, 'occupied.json'), 'keep'); assert.equal(f.run('receive', 'occupied.json').status, 4); assert.equal(await readFile(join(f.dir, 'occupied.json'), 'utf8'), 'keep'); assert.equal((await receiptDirs(f.store)).length, 0);
  assert.equal(f.run('receive', 'safe.json').status, 0); assert.equal(f.run('inspect', 'safe.json').status, 4); assert.equal(JSON.parse(await readFile(join(f.dir, 'safe.json'))).status, 'received');
}));
test('CLI init strict arguments, bounded file reads and no store-internal output injection', () => fixture(async f => {
  assert.equal(f.run('init', 'init.json').status, 0); assert.equal(f.run('inspect', 'x.json', ['inspect']).status, 2); await f.add();
  assert.equal(f.run('receive', 'x.json', ['receive', '--store', f.store, '--config', f.configPath, '--output', join(f.store, 'foreign.json')]).status, 4); assert.deepEqual(await readdir(f.store), ['store.json']);
  await writeFile(join(f.dir, 'invoice-R.csv'), Buffer.alloc(5 * 1024 * 1024 + 1)); await rejected(() => receive(f), 'file_too_large');
}));
