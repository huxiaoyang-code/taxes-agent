#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, existsSync, renameSync, linkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHistoryFixture, unpostHistoryFixture } from './helpers/offline-vat-history-fixture.mjs';
import { hash } from '../server/offline-material-adapters.mjs';
import { REVIEW_CODE_FILES } from '../server/accountant-review-store.mjs';
import { initMaterialStore, receiveMaterials, inspectMaterialStore } from '../server/offline-material-store.mjs';
import { openOfflineVatPriorContext as rawOpenPrior, assertOfflineVatPriorContextCurrent as current, closeOfflineVatPriorContext as close } from '../server/offline-vat-history-context.mjs';

const wb = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = join(wb, '.agent-runs'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'history-synthetic-')); let serial = 0, passed = 0, failed = 0;
const cleanups = new Set();
const tracked = (p, closer = close) => { if (p.receipt) cleanups.add(() => closer(p.receipt)); return p; };
const openPrior = async request => tracked(await rawOpenPrior(request));
const test = async (name, work) => { try { await work(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } };
const fixture = opts => createHistoryFixture(join(root, String(++serial)), opts);
const request = f => ({ version: 'offline-vat-prior-request/1', priorInputPath: f.inputPath });
const open = f => openPrior(request(f));
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, v) => writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
const cell = (p, row) => p.cells.find(c => c.row === row && c.column === 'services' && c.period === 'current');
const query = (f, sql, ...args) => { const d = new DatabaseSync(f.dbPath); try { return d.prepare(sql).all(...args); } finally { d.close(); } };
const edit = (f, sql, ...args) => { const d = new DatabaseSync(f.dbPath); try { return d.prepare(sql).run(...args); } finally { d.close(); } };
const noAuthority = d => { assert.equal(d.targetBinding, 'not_verified'); assert.equal(d.q2CalculationReady, false); assert.equal(d.accountantApproval, 'pending'); assert.equal(d.periodComplete, false); assert.equal(d.submittable, false); assert.equal(d.authorizesExecution, false); assert.equal(d.sourceAuthenticity, 'unverified'); assert.deepEqual(d.limitations.slice(0, 4), ['prior_Q1_only', 'no_target_database_binding', 'no_Q2_tax_calculation', 'no_reusable_accountant_confirmation']); };
const cli = (f, out, input = f.requestPath, module = join(wb, 'scripts/offline-vat-history.mjs')) => spawnSync(process.execPath, [module, '--input', input, '--output', out], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
function copyCodeTree() {
  const dir = join(root, 'code-' + ++serial); mkdirSync(join(dir, 'server'), { recursive: true });
  const names = new Set([...REVIEW_CODE_FILES, 'offline-vat-history-code.mjs', 'offline-vat-history-context.mjs', 'offline-vat-history-worker.mjs']);
  for (const name of names) {
    const text = readFileSync(join(wb, 'server', name), 'utf8');
    for (const m of text.matchAll(/(?:from\s*|import\s*)['"]\.\/([^'"]+\.mjs)['"]/g)) names.add(m[1]);
  }
  for (const name of names) copyFileSync(join(wb, 'server', name), join(dir, 'server', name));
  return dir;
}
function workerProbe(f, dir, setup, check) {
  const code = `import assert from 'node:assert/strict';import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const spawned=[];const original=cp.spawn;cp.spawn=(...args)=>{const child=original(...args);spawned.push({child,args});return child;};syncBuiltinESMExports();${setup};const api=await import(${JSON.stringify(pathToFileURL(join(dir, 'server/offline-vat-history-context.mjs')).href)});let p;try{p=await api.openOfflineVatPriorContext(JSON.parse(process.argv[1]));${check}}finally{if(p?.receipt)await api.closeOfflineVatPriorContext(p.receipt);}console.log('WORKER_PROBE_OK');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(request(f))], { encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_NO_WARNINGS: '1', WORKBENCH_DATA_DIR: join(root, 'must-not-inherit') } });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null); assert.equal(child.stderr, ''); assert.equal(child.stdout, 'WORKER_PROBE_OK\n');
}
const freshControl = dir => `const control=cp.spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(`import assert from 'node:assert/strict';const api=await import(${JSON.stringify(pathToFileURL(join(dir, 'server/offline-vat-history-context.mjs')).href)});const p=await api.openOfflineVatPriorContext(JSON.parse(process.argv[1]));try{assert.ok(p.receipt);assert.equal(p.diagnostic.status,'prior_q1_recomputed');}finally{if(p.receipt)await api.closeOfflineVatPriorContext(p.receipt);}`)},process.argv[1]],{encoding:'utf8',timeout:10000,env:{...process.env,NODE_NO_WARNINGS:'1'}});assert.equal(control.status,0,control.stderr);assert.equal(control.signal,null);assert.equal(control.stderr,'');`;

try {
  await test('actual raw files -> core importer -> private Q1 recompute with independently specified cents and trace', async () => {
    const f = fixture(), { receipt, diagnostic: d } = await open(f);
    assert.ok(receipt); assert.equal(d.status, 'prior_q1_recomputed'); noAuthority(d);
    assert.deepEqual([15, 16, 22].map(row => cell(d.computation, row).value), ['12350.01', '8233.34', '4116.67']);
    assert.equal(cell(d.computation, 1).minor, '41166700');
    assert.equal(d.computation.scope.enterpriseKey, f.key); assert.equal(d.computation.scope.accountSetId, String(f.id));
    assert.equal(d.computation.sales.length, 2); assert.equal(d.code, null); assert.equal(d.codeBinding.files.length, 31); assert.equal(new Set(d.codeBinding.files.map(x => x.name)).size, 31);
    assert.ok(d.inputFiles.length >= 8 && d.inputFiles.every(x => /^[a-f0-9]{64}$/.test(x.hash)));
    for (const sale of d.computation.sales) {
      assert.equal(query(f, 'SELECT status FROM vouchers WHERE id=?', sale.voucherId)[0].status, 'posted');
      assert.equal(sale.sourceCheck.status, 'matches_persisted_content'); assert.equal(sale.sourceCheck.batchAssociation, 'registered');
      assert.ok(sale.entries.every(e => query(f, 'SELECT id FROM voucher_entries WHERE id=? AND voucher_id=?', e.entryId, sale.voucherId).length === 1 && e.candidateSources.sourceFields.every(x => x.fileSha256 && x.location)));
      assert.match(sale.taxFactSource.fileSha256, /^[a-f0-9]{64}$/); assert.match(sale.taxFactSource.pointer, /^\/invoices\/\d+$/);
    }
    assert.ok(d.computation.calculationNodes.every(x => x.ruleSources.length)); assert.ok(d.computation.rules.sources.law.url);
    const d2 = await current(receipt); assert.deepEqual(d2, d); assert.notEqual(d2, d); await close(receipt);
  });
  await test('strict requests reject extras, null, accessors and proxies before reading any values', async () => {
    let calls = 0;
    for (const extra of ['rawInput', 'source', 'session', 'snapshot', 'calculation', 'ready', 'history', 'targetDb', 'targetScope']) {
      const p = await openPrior({ version: 'offline-vat-prior-request/1', priorInputPath: 'NEVER-READ', [extra]: true }); assert.equal(p.receipt, null); assert.equal(p.diagnostic.code, 'prior_request_invalid');
    }
    const accessor = { version: 'offline-vat-prior-request/1', get priorInputPath() { calls++; return 'NEVER-READ'; } };
    const proxy = new Proxy({}, { get() { calls++; throw Error('SECRET'); }, getPrototypeOf() { calls++; throw Error('SECRET'); } });
    for (const value of [null, [], false, accessor, proxy, Object.create(null)]) { const p = await openPrior(value); assert.equal(p.receipt, null); assert.equal(p.diagnostic.code, 'prior_request_invalid'); }
    assert.equal(calls, 0);
  });
  await test('non-enumerable/symbol fields and nested Proxy values reject without getter or Proxy traps', async () => {
    const f = fixture(); let calls = 0;
    const proxy = new Proxy({}, { get() { calls++; throw Error('SECRET'); }, getPrototypeOf() { calls++; throw Error('SECRET'); }, ownKeys() { calls++; throw Error('SECRET'); } });
    const hidden = Object.defineProperty(request(f), 'calculation', { value: { calculationReady: true }, enumerable: false });
    const hiddenGetter = Object.defineProperty(request(f), 'history', { get() { calls++; return true; }, enumerable: false });
    const symbol = Object.defineProperty(request(f), Symbol('source'), { get() { calls++; return true; } });
    const hiddenPath = { version: 'offline-vat-prior-request/1' }; Object.defineProperty(hiddenPath, 'priorInputPath', { get() { calls++; return f.inputPath; } });
    for (const value of [hidden, hiddenGetter, symbol, hiddenPath, { ...request(f), version: proxy }, { ...request(f), priorInputPath: proxy }]) {
      const p = await openPrior(value); assert.equal(p.receipt, null); assert.equal(p.diagnostic.code, 'prior_request_invalid');
    }
    assert.equal(calls, 0);
  });
  await test('only original process receipt works; public diagnostic mutation, clone, forgery, close and cross-process fail closed', async () => {
    const f = fixture(), p = await open(f), original = structuredClone(p.diagnostic);
    p.diagnostic.computation.cells[0].value = '999999'; p.diagnostic.codeBinding.files.length = 0; p.diagnostic.inputFiles.length = 0; p.diagnostic.authorizesExecution = true;
    assert.deepEqual(await current(p.receipt), original);
    for (const fake of [null, {}, structuredClone(p.receipt), JSON.parse(JSON.stringify(p.receipt)), { ...p }]) assert.equal((await current(fake)).code, 'prior_receipt_untrusted');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { assertOfflineVatPriorContextCurrent as check } from ${JSON.stringify(pathToFileURL(join(wb, 'server/offline-vat-history-context.mjs')).href)}; console.log((await check(JSON.parse(process.argv[1]))).code)`, JSON.stringify(p.receipt)], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    assert.equal(child.status, 0); assert.equal(child.stdout.trim(), 'prior_receipt_untrusted');
    assert.equal((await close(p.receipt)).code, 'prior_receipt_closed'); assert.equal((await current(p.receipt)).code, 'prior_receipt_closed');
    const next = await open(f); assert.ok(next.receipt); await close(next.receipt);
  });
  await test('observed source byte change permanently retires receipt even after restoring identical bytes', async () => {
    const f = fixture(), p = await open(f), path = join(f.dir, 'sales.csv'), original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from('\n')])); assert.equal((await current(p.receipt)).code, 'prior_context_stale');
    writeFileSync(path, original); assert.equal((await current(p.receipt)).code, 'prior_context_stale');
    const fresh = await open(f); assert.ok(fresh.receipt); await close(fresh.receipt);
  });
  await test('missing actual material and corrected amount cannot inherit uploaded ready computation', async () => {
    const f = fixture(), input = json(f.inputPath); input.previousComputation = 'fake-ready.json'; write(f.inputPath, input); write(join(f.dir, 'fake-ready.json'), { calculationReady: true, ready: true, cells: [] });
    assert.equal((await open(f)).receipt, null);
    delete input.previousComputation; write(f.inputPath, input);
    const path = join(f.dir, 'sales.csv'), original = readFileSync(path); renameSync(path, path + '.held');
    const missing = await open(f); assert.equal(missing.receipt, null); assert.equal(missing.diagnostic.code, 'prior_input_rejected'); renameSync(path + '.held', path);
    write(path, original.toString().replace('173211.00,1732.11,174943.11', '173212.00,1732.12,174944.12'));
    const changed = await open(f); assert.equal(changed.receipt, null); assert.equal(changed.diagnostic.status, 'blocked');
  });
  await test('v1 unsupported low threshold, zero sales, historical opening, missing facts and unknown facts never mint', async () => {
    for (const options of [{ amounts: ['299997.00'] }, { amounts: [] }, { opening: true }, { post: false }]) {
      const p = await open(fixture(options)); assert.equal(p.receipt, null); assert.ok(['blocked', 'unsupported'].includes(p.diagnostic.status)); noAuthority(p.diagnostic);
      assert.ok(['prior_calculation_blocked', 'prior_calculation_unsupported'].includes(p.diagnostic.code));
      assert.equal(p.diagnostic.computation.calculationReady, false); assert.equal(cell(p.diagnostic.computation, 22).minor, null);
    }
    for (const mutation of [d => { d.history.state = 'prior_required'; }, d => { d.tax.vatStatus = 'unknown'; }, d => { delete d.tax; }, d => { d.opening.state = 'unknown'; }]) {
      const f = fixture(), path = join(f.dir, 'declaration.json'), d = json(path); mutation(d); write(path, d);
      const t = json(join(f.dir, 'tax.json')); for (const value of [t.enterprise, t.period, ...t.period.exclusions, ...t.invoices]) value.sourceRefs[0].fileSha256 = (await import('../server/offline-material-adapters.mjs')).hash((await import('../server/offline-material-adapters.mjs')).stable(d)); write(join(f.dir, 'tax.json'), t);
      const p = await open(f); assert.equal(p.receipt, null); assert.ok(['blocked', 'unsupported'].includes(p.diagnostic.status));
    }
  });
  await test('wrong enterprise/book/period and non-January enterprise reject instead of binding a target snapshot', async () => {
    for (const change of [c => { c.scope.enterpriseKey = 'ANOTHER-ENTERPRISE'; }, c => { c.scope.accountSetId = '999'; }, c => { c.scope.period = '2026-Q2'; }]) {
      const f = fixture(), c = json(f.inputPath); change(c); write(f.inputPath, c); assert.equal((await open(f)).receipt, null);
    }
    for (const date of ['2025-12-31', '2026-02-01']) { const f = fixture(), path = join(f.dir, 'tax.json'), t = json(path); t.enterprise.establishedOn = date; write(path, t); assert.equal((await open(f)).receipt, null); }
  });
  await test('actual unposting, entry fingerprint and source association changes permanently stale held receipt', async () => {
    for (const mutation of [unpostHistoryFixture, f => edit(f, "UPDATE voucher_entries SET summary='changed' WHERE voucher_id=(SELECT MIN(id) FROM vouchers WHERE account_set_id=?)", f.id), f => edit(f, "UPDATE import_voucher_sources SET content_fingerprint='changed' WHERE account_set_id=?", f.id)]) {
      const f = fixture(), p = await open(f); assert.ok(p.receipt); mutation(f); assert.equal((await current(p.receipt)).code, 'prior_context_stale'); await close(p.receipt);
    }
  });
  await test('a real Q2 voucher beyond snapshot cutoff does not stale Q1', async () => {
    const f = fixture(), p = await open(f);
    // 独立子进程使用已有核心记账路径，不手写分录。
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `process.env.WORKBENCH_DATA_DIR=process.argv[1]; const {db}=await import(${JSON.stringify(pathToFileURL(join(wb, 'server/db.mjs')).href)}); const A=await import(${JSON.stringify(pathToFileURL(join(wb, 'server/accounting.mjs')).href)}); try {const id=Number(process.argv[2]); A.ensurePeriod(id,'2026-04'); const v=A.createVoucher(id,{period:'2026-04',date:'2026-04-12',summary:'synthetic Q2',entries:[{code:'1002',debit:'19.31',credit:'0.00'},{code:'3001',debit:'0.00',credit:'19.31'}]}); A.postVoucher(id,v.id);} finally {db.close();}`, dirname(f.dbPath), String(f.id)], { encoding: 'utf8', env: { ...process.env, TEMP: root, TMP: root, NODE_NO_WARNINGS: '1' } });
    assert.equal(child.status, 0, child.stderr); assert.equal((await current(p.receipt)).status, 'prior_q1_recomputed'); await close(p.receipt);
  });
  await test('false/null/unknown excluded-business facts remain blocked and no receipt outlives rejected open', async () => {
    for (const state of [false, null, 'unknown']) {
      const f = fixture(), path = join(f.dir, 'tax.json'), t = json(path); t.period.exclusions[0].state = state; write(path, t);
      const p = await open(f); assert.equal(p.receipt, null); assert.equal(p.diagnostic.status, 'blocked'); noAuthority(p.diagnostic);
      // Windows 上持有中的数据库不能重命名：此处重命名成功证明被拒绝的打开已释放源。
      renameSync(f.dbPath, f.dbPath + '.released'); renameSync(f.dbPath + '.released', f.dbPath);
    }
  });
  await test('importing the history API creates no default data directory or journal', () => {
    const data = join(root, 'must-not-create');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(wb, 'server/offline-vat-history-context.mjs')).href)});`], { encoding: 'utf8', env: { ...process.env, WORKBENCH_DATA_DIR: data, TEMP: root, TMP: root, NODE_NO_WARNINGS: '1' } });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, ''); assert.equal(child.stderr, ''); assert.equal(existsSync(data), false);
  });
  await test('main and warm WAL bytes remain unchanged during read-only open/consume/close', async () => {
    const f = fixture(), held = new DatabaseSync(f.dbPath); held.exec('PRAGMA journal_mode=WAL'); held.prepare('SELECT COUNT(*) FROM vouchers').get();
    const files = [f.dbPath, f.dbPath + '-wal'].filter(existsSync); const before = files.map(p => hash(readFileSync(p)));
    try { const p = await open(f); assert.ok(p.receipt); assert.equal((await current(p.receipt)).status, 'prior_q1_recomputed'); await close(p.receipt); assert.deepEqual(files.map(p => hash(readFileSync(p))), before); } finally { held.close(); }
  });
  await test('database path replacement is detected or OS held-file protection prevents replacement', async () => {
    const f = fixture(), p = await open(f); let moved = false;
    try { renameSync(f.dbPath, f.dbPath + '.held'); moved = true; copyFileSync(f.dbPath + '.held', f.dbPath); assert.equal((await current(p.receipt)).code, 'prior_context_stale'); }
    catch (e) { if (moved || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e; assert.equal((await current(p.receipt)).status, 'prior_q1_recomputed'); console.log('INFO OS prevented held DB replacement; replacement detection branch not exercised'); }
    finally { await close(p.receipt); }
  });
  await test('material store receipts/origins and CAS correction are actually verified', async () => {
    const f = fixture(), store = join(f.directory, 'materials-store'); await initMaterialStore(store, f.scope);
    const r = await receiveMaterials(store, join(f.dir, 'materials.json'));
    assert.equal(r.status, 'received'); const c = json(f.inputPath); delete c.materialsInput; c.materialStore = store; write(f.inputPath, c);
    const p = await open(f); assert.ok(p.receipt);
    const origin = join(f.dir, 'sales.csv'), bytes = readFileSync(origin); writeFileSync(origin, Buffer.concat([bytes, Buffer.from('\n')]));
    assert.equal((await current(p.receipt)).code, 'prior_context_stale'); writeFileSync(origin, bytes); assert.equal((await current(p.receipt)).code, 'prior_context_stale');
    const state = await inspectMaterialStore(store), fresh = await open(f); assert.ok(fresh.receipt);
    writeFileSync(origin, Buffer.concat([bytes, Buffer.from('\n')]));
    await assert.rejects(receiveMaterials(store, join(f.dir, 'materials.json')), /source_version_conflict/);
    const configPath = join(f.dir, 'materials.json'), config = json(configPath), sale = config.sources.find(s => s.sourceId === 'sales');
    sale.supersedes = state.active.find(s => s.sourceId === 'sales').sourceVersion; sale.expectedSourceVersion = sale.supersedes; write(configPath, config);
    const corrected = await receiveMaterials(store, configPath); assert.equal(corrected.status, 'received');
    assert.equal((await current(fresh.receipt)).code, 'prior_context_stale');
    sale.supersedes = '0'.repeat(64); sale.expectedSourceVersion = sale.supersedes; write(configPath, config);
    await assert.rejects(receiveMaterials(store, configPath), /correction_cas_conflict/);
    assert.ok(corrected.active.find(s => s.sourceId === 'sales').receiptId);
  });
  await test('cached code byte change on copied source closure requires restart, including restored bytes', async () => {
    const f = fixture(), dir = copyCodeTree();
    const api = await import(pathToFileURL(join(dir, 'server/offline-vat-history-context.mjs')));
    const p = tracked(await api.openOfflineVatPriorContext(request(f)), api.closeOfflineVatPriorContext); assert.ok(p.receipt);
    const file = join(dir, 'server/tax-calculation.mjs'), bytes = readFileSync(file); writeFileSync(file, Buffer.concat([bytes, Buffer.from('\n// synthetic hot byte change\n')]));
    assert.equal((await api.assertOfflineVatPriorContextCurrent(p.receipt)).code, 'prior_code_restart_required'); writeFileSync(file, bytes);
    assert.equal((await api.assertOfflineVatPriorContextCurrent(p.receipt)).code, 'prior_code_restart_required'); assert.equal((await api.openOfflineVatPriorContext(request(f))).diagnostic.status, 'restart_required');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {openOfflineVatPriorContext as open,closeOfflineVatPriorContext as close} from ${JSON.stringify(pathToFileURL(join(dir, 'server/offline-vat-history-context.mjs')).href)};const p=await open(JSON.parse(process.argv[1]));console.log(p.diagnostic.status);await close(p.receipt);`, JSON.stringify(request(f))], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }); assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), 'prior_q1_recomputed');
  });
  await test('all three new actual module bytes are included in copied-source code guard', async () => {
    for (const name of ['offline-vat-history-context.mjs', 'offline-vat-history-code.mjs', 'offline-vat-history-worker.mjs']) {
      const f = fixture(), dir = copyCodeTree(), api = await import(pathToFileURL(join(dir, 'server/offline-vat-history-context.mjs'))), p = tracked(await api.openOfflineVatPriorContext(request(f)), api.closeOfflineVatPriorContext);
      assert.ok(p.receipt); const file = join(dir, 'server', name); writeFileSync(file, readFileSync(file, 'utf8') + '\n');
      assert.equal((await api.assertOfflineVatPriorContextCurrent(p.receipt)).code, 'prior_code_restart_required');
    }
  });
  await test('a parent pre-cached tax function cannot execute old bytes under a new cold history code binding', () => {
    const f = fixture(), dir = copyCodeTree(), taxFile = join(dir, 'server/tax-calculation.mjs');
    workerProbe(f, dir, `await import(${JSON.stringify(pathToFileURL(taxFile).href)});const file=${JSON.stringify(taxFile)};fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('export function calculateOfflineVat(input, source, snapshot) {',"export function calculateOfflineVat(input, source, snapshot) { throw new Error('DISK_CODE_SENTINEL');"));`, `assert.equal(p.receipt,null);assert.equal(p.diagnostic.code,'prior_input_rejected');assert.equal(p.diagnostic.computation,undefined);assert.equal(spawned.length,1);assert.ok(spawned[0].child.exitCode!==null || spawned[0].child.signalCode!==null);`);
  });
  await test('code changes during fork cannot mismatch parent and worker execution byte manifests', () => {
    const f = fixture(), dir = copyCodeTree(), taxFile = join(dir, 'server/tax-calculation.mjs');
    workerProbe(f, dir, `const wrapped=cp.spawn;cp.spawn=(...args)=>{const child=wrapped(...args);fs.appendFileSync(${JSON.stringify(taxFile)},'\\n// actual fork window byte change\\n');return child;};syncBuiltinESMExports();`, `assert.equal(p.receipt,null);assert.equal(p.diagnostic.code,'prior_code_restart_required');assert.ok(spawned[0].child.exitCode!==null || spawned[0].child.signalCode!==null);`);
  });
  await test('observed fork manifest ABA permanently latches restart even after restored bytes; fresh process recovers', () => {
    const f = fixture(), dir = copyCodeTree(), tax = join(dir, 'server/tax-calculation.mjs');
    workerProbe(f, dir, `const file=${JSON.stringify(tax)},bytes=fs.readFileSync(file);let once=true,observed=false;const wrapped=cp.spawn;cp.spawn=(...args)=>{const child=wrapped(...args);if(once){once=false;fs.appendFileSync(file,'\\n// observed fork ABA\\n');child.on('message',m=>{if(m.type==='ready'){observed=true;fs.writeFileSync(file,bytes);}});}return child;};syncBuiltinESMExports();`, `assert.equal(observed,true);assert.equal(p.receipt,null);assert.equal(p.diagnostic.code,'prior_code_restart_required');const again=await api.openOfflineVatPriorContext(JSON.parse(process.argv[1]));assert.equal(again.receipt,null);assert.equal(again.diagnostic.code,'prior_code_restart_required');assert.equal(spawned.length,1);${freshControl(dir)}`);
  });
  await test('worker-observed code ABA permanently latches parent restart after restoration before parent reply handling', () => {
    const f = fixture(), dir = copyCodeTree(), tax = join(dir, 'server/tax-calculation.mjs');
    workerProbe(f, dir, `const file=${JSON.stringify(tax)},bytes=fs.readFileSync(file);let observed=false;const wrapped=cp.spawn;cp.spawn=(...args)=>{const child=wrapped(...args),send=child.send.bind(child);child.send=(message,...rest)=>{if(message.command==='current')fs.appendFileSync(file,'\\n// worker observed ABA\\n');return send(message,...rest);};child.on('message',m=>{if(m.type==='result'&&m.reply?.code==='prior_code_restart_required'){observed=true;fs.writeFileSync(file,bytes);}});return child;};syncBuiltinESMExports();`, `assert.ok(p.receipt);assert.equal((await api.assertOfflineVatPriorContextCurrent(p.receipt)).code,'prior_code_restart_required');assert.equal(observed,true);assert.equal((await api.assertOfflineVatPriorContextCurrent(p.receipt)).code,'prior_code_restart_required');const again=await api.openOfflineVatPriorContext(JSON.parse(process.argv[1]));assert.equal(again.receipt,null);assert.equal(again.diagnostic.code,'prior_code_restart_required');assert.equal(spawned.length,1);${freshControl(dir)}`);
  });
  await test('parallel consumes serialize; asynchronous close cancels in-flight work and awaits actual exit', () => {
    const f = fixture(), dir = copyCodeTree(), worker = join(dir, 'server/offline-vat-history-worker.mjs');
    write(worker, readFileSync(worker, 'utf8').replace('const result = await recompute();', "if (message.command === 'current') await new Promise(ok => setTimeout(ok, 40)); const result = await recompute();"));
    workerProbe(f, dir, '', `assert.ok(p.receipt);assert.equal(spawned.length,1);assert.equal(Object.hasOwn(spawned[0].args[2].env,'WORKBENCH_DATA_DIR'),false);assert.equal(Object.hasOwn(spawned[0].args[2].env,'NODE_OPTIONS'),false);const all=await Promise.all([api.assertOfflineVatPriorContextCurrent(p.receipt),api.assertOfflineVatPriorContextCurrent(p.receipt),api.assertOfflineVatPriorContextCurrent(p.receipt)]);assert.ok(all.every(x=>x.status==='prior_q1_recomputed'));const pending=api.assertOfflineVatPriorContextCurrent(p.receipt);await new Promise(ok=>setTimeout(ok,10));assert.equal((await api.closeOfflineVatPriorContext(p.receipt)).code,'prior_receipt_closed');assert.equal((await pending).code,'prior_receipt_closed');assert.equal((await api.assertOfflineVatPriorContextCurrent(p.receipt)).code,'prior_receipt_closed');assert.ok(spawned[0].child.exitCode!==null || spawned[0].child.signalCode!==null);`);
  });
  await test('unexpected worker exit permanently rejects its receipt and never restarts it silently', () => {
    const f = fixture(), dir = copyCodeTree();
    workerProbe(f, dir, '', `assert.ok(p.receipt);const child=spawned[0].child;const exit=new Promise(ok=>child.once('exit',ok));child.kill('SIGKILL');await exit;assert.equal((await api.assertOfflineVatPriorContextCurrent(p.receipt)).code,'prior_worker_unavailable');assert.equal((await api.assertOfflineVatPriorContextCurrent(p.receipt)).code,'prior_worker_unavailable');assert.equal(spawned.length,1);const next=await api.openOfflineVatPriorContext(JSON.parse(process.argv[1]));assert.ok(next.receipt);await api.closeOfflineVatPriorContext(next.receipt);assert.equal(spawned.length,2);assert.ok(spawned.every(x=>x.child.exitCode!==null || x.child.signalCode!==null));`);
  });
  await test('a real Node spawn ENOENT closes without waiting for an exit event that never arrives', () => {
    const f = fixture(), dir = copyCodeTree(), absent = join(root, 'does-not-exist-node.exe');
    workerProbe(f, dir, `cp.spawn=(exe,args,options)=>{const child=original(${JSON.stringify(absent)},args,options);spawned.push({child,args:[exe,args,options]});return child;};syncBuiltinESMExports();`, `assert.equal(p.receipt,null);assert.equal(p.diagnostic.code,'prior_worker_unavailable');assert.equal(spawned.length,1);assert.equal(spawned[0].child.pid,undefined);`);
  });
  await test('an unresponsive actual worker times out, closes and leaves no surviving child', () => {
    const f = fixture(), dir = copyCodeTree(), worker = join(dir, 'server/offline-vat-history-worker.mjs');
    write(worker, readFileSync(worker, 'utf8').replace('const result = await recompute();', "if (message.command === 'current') await new Promise(() => {}); const result = await recompute();"));
    workerProbe(f, dir, '', `assert.ok(p.receipt);const originalTimer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...rest)=>originalTimer(fn,ms===30000?30:ms,...rest);const stale=await api.assertOfflineVatPriorContextCurrent(p.receipt);globalThis.setTimeout=originalTimer;assert.equal(stale.code,'prior_worker_timeout');assert.equal((await api.assertOfflineVatPriorContextCurrent(p.receipt)).code,'prior_worker_timeout');assert.ok(spawned[0].child.exitCode!==null || spawned[0].child.signalCode!==null);`);
  });
  await test('parent disconnection closes the held source and the actual worker exits', async () => {
    const f = fixture(), dir = copyCodeTree();
    const script = `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';let worker;const spawn=cp.spawn;cp.spawn=(...a)=>(worker=spawn(...a));syncBuiltinESMExports();const api=await import(${JSON.stringify(pathToFileURL(join(dir, 'server/offline-vat-history-context.mjs')).href)});const p=await api.openOfflineVatPriorContext(JSON.parse(process.argv[1]));if(!p.receipt)process.exit(2);console.log(worker.pid);process.exit(0);`;
    const parent = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(request(f))], { encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    assert.equal(parent.status, 0, parent.stderr); const pid = Number(parent.stdout.trim()); assert.ok(Number.isSafeInteger(pid) && pid > 0);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) { try { process.kill(pid, 0); await new Promise(ok => setTimeout(ok, 25)); } catch (e) { assert.equal(e.code, 'ESRCH'); alive = false; } }
    if (alive) process.kill(pid, 'SIGKILL'); assert.equal(alive, false);
    renameSync(f.dbPath, f.dbPath + '.released'); renameSync(f.dbPath + '.released', f.dbPath);
  });
  await test('real child CLI resolves request-relative config, emits safe diagnostics, uses wx and closes', async () => {
    const f = fixture(), output = join(f.dir, 'diagnostic.json'), before = hash(readFileSync(f.inputPath)), p = cli(f, output);
    assert.equal(p.status, 0, p.stderr); assert.equal(p.signal, null); assert.equal(p.stderr, ''); assert.equal(p.stdout, 'OFFLINE_VAT_HISTORY_WRITTEN status=prior_q1_recomputed issues=0\n');
    const d = json(output); noAuthority(d); assert.equal(d.publicationStatus, 'diagnostic_only'); assert.equal(Object.hasOwn(d, 'receipt'), false); assert.equal(cell(d.computation, 22).value, '4116.67');
    assert.equal(cli(f, output).status, 4); assert.equal(cli(f, f.inputPath).status, 4); assert.equal(hash(readFileSync(f.inputPath)), before);
    assert.equal(cli(f, join(f.dir, 'bad.json'), join(f.dir, 'MISSING-SENSITIVE-PATH')).stdout, 'OFFLINE_VAT_HISTORY_REJECTED\n');
    const low = fixture({ amounts: ['123.00'] }), bad = cli(low, join(low.dir, 'blocked.json')); assert.equal(bad.status, 3); assert.equal(json(join(low.dir, 'blocked.json')).status, 'unsupported');
    const absent = join(f.dir, 'symbolic-target'), link = join(f.dir, 'output-link'); write(absent, 'keep');
    linkSync(absent, link); assert.equal(cli(f, link).status, 4); assert.equal(readFileSync(absent, 'utf8'), 'keep');
  });
  await test('CLI final publication guard rejects actual source and request mutations after writeFile', async () => {
    for (const kind of ['source', 'request']) {
      const f = fixture(), output = join(f.dir, 'raced.json');
      const target = kind === 'source' ? join(f.dir, 'sales.csv') : f.requestPath;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.promises.open;fs.promises.open=async(...args)=>{const h=await original(...args);if(args[1]==='wx'){const write=h.writeFile.bind(h);h.writeFile=async(...a)=>{const r=await write(...a);fs.appendFileSync(process.argv[1],'\\n');return r;};}return h;};syncBuiltinESMExports();const {runCli}=await import(${JSON.stringify(pathToFileURL(join(wb, 'scripts/offline-vat-history.mjs')).href)});const r=await runCli(['--input',process.argv[2],'--output',process.argv[3]]);console.log(r.message);process.exitCode=r.exitCode;`, target, f.requestPath, output], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
      assert.equal(child.status, 4, child.stderr); assert.equal(child.stderr, ''); assert.equal(child.stdout, 'OFFLINE_VAT_HISTORY_REJECTED\n');
      assert.deepEqual(json(output), { publicationStatus: 'failed', authorizesExecution: false });
    }
  });
} finally {
  for (const cleanup of cleanups) await cleanup();
  console.log(`offline-vat-history-context ${passed}/${passed + failed}; all fixture children actualclose`);
  if (!failed && process.env.KEEP_FIXTURES !== '1') rmSync(root, { recursive: true, force: true });
  else console.log('synthetic fixtures retained: ' + root);
}
process.exitCode = failed ? 1 : 0;
