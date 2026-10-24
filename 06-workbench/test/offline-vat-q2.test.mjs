import assert from 'node:assert/strict';
import { lstatSync, realpathSync, mkdirSync, readFileSync, writeFileSync, cpSync, copyFileSync, linkSync, unlinkSync, renameSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createQ2Fixture, createPublicNoopBatch, createPublicDedupBatch, addFuturePostedQuarter, readJson, writeJson } from './helpers/offline-vat-q2-fixture.mjs';
import { runOfflineVatQ2 as run, checkOfflineVatQ2Current as current } from '../server/offline-vat-q2.mjs';
import { openVatInputPairFiles } from '../server/offline-vat-input.mjs';
import { calculateOfflineVat, calculateOfflineVatQ2 } from '../server/tax-calculation.mjs';
import { validateLedgerSnapshot, validateLedgerSnapshotPair } from '../server/offline-ledger-snapshot.mjs';
import { getVatRules, getVatQ2Rules } from '../server/tax-rule-registry.mjs';
import { hash, stable } from '../server/offline-material-adapters.mjs';
import { persistedVoucherFingerprint } from '../server/import-storage.mjs';
const wb = resolve('.'); mkdirSync(join(wb, '.agent-runs'), { recursive: true });
const root=resolve(wb,'.agent-runs','q-'+randomUUID());mkdirSync(root);
for(let p=root;;p=dirname(p)){assert.equal(lstatSync(p).isSymbolicLink(),false);assert.equal(resolve(realpathSync.native(p)).toLowerCase(),p.toLowerCase());if(dirname(p)===p)break;}
Object.assign(process.env,{TEMP:root,TMP:root,WORKBENCH_DATA_DIR:join(root,'d'),KEEP_FIXTURES:'1',WORKBENCH_TEST_KEEP_FIXTURES:'1'});console.log('FIXTURES '+root);
const selectedCase=process.env.OFFLINE_Q2_CASE??'';
const regressionNames=new Set(['real hardlink aliases are rejected and unlink restores the original target','cached parent financial function cannot execute stale code under a new native manifest','actual worker timeout waits for termination before returning']);
assert.ok(['','r7-existing-failures'].includes(selectedCase),'unknown OFFLINE_Q2_CASE');
let serial = 0, passed = 0, failed = 0, skipped = 0;
const test = async (name, work) => { if(selectedCase&&!regressionNames.has(name)){skipped++;return;} try { await work(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } };
const fixture = options => createQ2Fixture(join(root, String(++serial)), options);
const row = (p, n, period = 'current') => p.cells.find(c => c.row === n && c.column === 'services' && c.period === period);
const inspect = (f, work, readOnly = false) => { const db = new DatabaseSync(f.dbPath, { readOnly }); try { return work(db); } finally { db.close(); } };
const state = f => inspect(f, db => db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(s => ({ ...s, rows: s.type === 'table' ? db.prepare('SELECT * FROM "' + s.name + '"').all() : [] })), true);
const flags = d => { for (const k of ['periodComplete', 'submittable', 'authorizesExecution']) assert.equal(d[k], false); assert.equal(d.accountantApproval, 'pending'); assert.equal(d.sourceAuthenticity, 'unverified'); };
const insertHeader = (f, mutate = () => {}) => inspect(f, db => {
  const row = {...db.prepare("SELECT * FROM import_batches WHERE account_set_id=? AND enterprise_key=? AND status='completed' ORDER BY batch_id LIMIT 1").get(f.id, f.key),batch_id:'orphan-'+(++serial)};
  mutate(row); const keys = Object.keys(row); db.prepare('INSERT INTO import_batches('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k])); return row;
});
const deleteHeader = (f, row) => inspect(f, db => db.prepare('DELETE FROM import_batches WHERE batch_id=?').run(row.batch_id));
const blocked = d => { assert.equal(d.q2CalculationReady, false); flags(d); if (d.computation) assert.ok(d.computation.cells.every(c => c.value === null)); };
async function changeFile(path, work, check) { const old = readFileSync(path); try { const doc = readJson(path); work(doc); writeJson(path, doc); await check(); } finally { writeFileSync(path, old); } }
async function declaration(f, dir, mutate, check) {
  const path = join(dir, 'declaration.json'), taxPath = join(dir, 'tax.json'), old = readFileSync(path), oldTax = readFileSync(taxPath);
  try {
    const d = readJson(path); mutate(d); writeJson(path, d); const tax = readJson(taxPath);
    for (const x of [tax.enterprise, tax.period, ...tax.period.exclusions, ...tax.invoices]) for (const ref of x.sourceRefs) if (ref.kind === 'declaration') ref.fileSha256 = hash(stable(d));
    writeJson(taxPath, tax); await check();
  } finally { writeFileSync(path, old); writeFileSync(taxPath, oldTax); }
}
function copyCode() { const dest = join(root, 'code-' + (++serial)); mkdirSync(dest); cpSync(join(wb, 'server'), join(dest, 'server'), { recursive: true }); mkdirSync(join(dest, 'scripts')); copyFileSync(join(wb, 'scripts/offline-vat-q2.mjs'), join(dest, 'scripts/offline-vat-q2.mjs')); return dest; }
function probe(f, code, deployment = wb) {
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict';import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const request=JSON.parse(process.argv[1]);const base=${JSON.stringify(pathToFileURL(deployment + '/').href)};${code}`, JSON.stringify(f.request)], { cwd: root, encoding: 'utf8', timeout: 45000, env: { ...process.env, NODE_NO_WARNINGS: '1', WORKBENCH_DATA_DIR: join(root, 'forbidden-' + (++serial)) } });
  assert.equal(p.status, 0, p.stderr + p.stdout); assert.equal(p.signal, null); assert.equal(p.stderr, ''); return p.stdout;
}
const f = await fixture();
await test('actual originals through formal prepare/execute produce real Q1, Q2 and selected cumulative cells without any writes', async () => {
  const before = state(f), d = await run(f.request); assert.equal(d.status, 'q2_selected_fields_calculated', JSON.stringify(d)); flags(d);
  assert.equal(d.calculationReady, true); assert.equal(d.reviewReady, true); assert.equal(d.q2CalculationReady, true);
  assert.deepEqual(d.computation.issues, []); assert.deepEqual(d.priorComputation.issues, []);
  assert.deepEqual([1, 15, 16, 20].map(r => row(d.priorComputation, r).value), ['509873.00', '15296.19', '10197.46', '5098.73']);
  assert.deepEqual([1, 2, 3, 15, 16, 20, 21, 22].map(r => row(d.computation, r).value), ['347291.00', '0.00', '347291.00', '10418.73', '6945.82', '3472.91', '0.00', '3472.91']);
  assert.deepEqual([1, 2, 3, 15, 16, 20].map(r => row(d.computation, r, 'yearToDate').value), ['857164.00', '0.00', '857164.00', '25714.92', '17143.28', '8571.64']);
  for (const r of [21, 22]) { assert.equal(row(d.computation, r, 'yearToDate').value, null); assert.equal(row(d.computation, r, 'yearToDate').status, 'not_applicable'); }
  assert.equal(d.binding.relationship, 'same_held_readonly_source_same_capture'); assert.equal(d.binding.accountSetId, f.id); assert.equal(d.binding.databaseInstanceId, f.instanceId);
  assert.equal(d.computation.scope.period, '2026-Q2'); assert.equal(d.computation.sales[0].date, '2026-04-17'); assert.equal(d.computation.historyBridge.status, 'same_capture_Q1_history_explained');
  assert.deepEqual(state(f), before); assert.deepEqual(await run(f.request), d); assert.equal((await current(f.request, d.contentDigest)).status, 'current');
});
await test('every selected cell traces actual nodes, entry IDs, source and raw materials; no adjustment requires exact original tax and posted VAT', async () => {
  const d = await run(f.request), p = d.computation;
  for (const c of p.cells.filter(c => c.value !== null)) assert.ok(p.calculationNodes.some(n => n.id === c.calculationNode));
  for (const n of p.calculationNodes.filter(n => n.id.startsWith('ytd_'))) { assert.ok(n.dependencies[0].startsWith('Q1:')); assert.ok(p.calculationNodes.some(x => x.id === n.dependencies[0])); assert.match(n.engineeringInference, /pending_accountant_review/); }
  assert.equal(p.sales[0].adjustmentMinor, '0'); assert.equal(p.sales[0].initialLedgerVatMinor, '347291'); assert.ok(p.sales[0].entries.every(e => Number.isInteger(e.entryId))); assert.equal(p.sales[0].sourceCheck.status, 'matches_persisted_content'); assert.ok(p.sales[0].invoice.provenance || p.sales[0].invoice.docId); assert.ok(d.inputFiles.prior.length && d.inputFiles.target.length);
  assert.ok(p.cells.filter(c => c.column === 'goods' || !p.selectedFields.includes(c.row)).every(c => c.value === null));
});
await test('unassociated nonzero completed batch is captured privately, blocks Q2 and stales old digest without readonly writes', async () => {
  const old = await run(f.request), held = await openVatInputPairFiles(f.request);
  assert.equal(held.snapshots.prior.sources.targetBatchInventory, undefined); assert.equal(held.snapshots.target.sources.targetBatchInventory.version, 'q2-target-batch-inventory/1');
  const orphan = insertHeader(f, row => { row.created_at='2099-01-01T00:00:00.000Z'; row.updated_at=row.created_at; });
  try {
    assert.equal(validateLedgerSnapshot(held.source, held.snapshots.target).status, 'stale'); assert.throws(()=>validateLedgerSnapshotPair(held.source,held.snapshots));
    const before = state(f), bytes = hash(readFileSync(f.dbPath)), d = await run(f.request); blocked(d);
    const issue=d.computation.issues.find(i=>i.code==='unexplained_nonzero_import_batch'); assert.ok(issue); assert.equal(issue.audience,'operator_engineering');assert.equal(issue.customerActionRequired,false);
    assert.notEqual(d.contentDigest,old.contentDigest); assert.equal((await current(f.request,old.contentDigest)).status,'stale');assert.deepEqual(state(f),before);assert.equal(hash(readFileSync(f.dbPath)),bytes);
  } finally { held.close(); deleteHeader(f, orphan); }
  const legacy = await openVatInputPairFiles({...f.request,version:'offline-vat-pair-request/1'});
  try {assert.equal(legacy.snapshots.target.sources.targetBatchInventory,undefined);assert.equal(calculateOfflineVat(legacy.prior.rawInput,legacy.source,legacy.snapshots.prior).calculationReady,true);await assert.rejects(()=>calculateOfflineVatQ2(legacy),e=>e.code==='q2_private_batch_inventory_required');}finally{legacy.close();}
});
await test('real public empty append is an explained noop and malformed/missing/nonzero/status metadata are never defaulted to zero', async () => {
  const g=await fixture(), noop=createPublicNoopBatch(g); const persisted=inspect(g,db=>db.prepare('SELECT * FROM import_batches WHERE batch_id=?').get(noop.batchId),true);
  assert.deepEqual(JSON.parse(persisted.result_json),{accountSetCreated:false,accountsAdded:0,openingBalancesApplied:0,vouchersCreated:0,vouchersDeduplicated:0,contentFingerprint:persisted.content_fingerprint,mode:'append',accountSetId:g.id,source:{system:persisted.source_system,enterpriseKey:g.key},sourceTrace:[]});
  const before=state(g),d=await run(g.request);assert.equal(d.q2CalculationReady,true,JSON.stringify(d));assert.deepEqual(d.computation.issues,[]);assert.deepEqual(state(g),before);
  for(const mutate of [r=>{r.result_json='{}';},r=>{r.result_json='{broken';},r=>{r.result_json='null';},r=>{r.result_json=JSON.stringify({accountSetCreated:false,accountsAdded:0,openingBalancesApplied:0,vouchersCreated:0});},r=>{r.result_json=JSON.stringify({accountSetCreated:false,accountsAdded:1,openingBalancesApplied:0,vouchersCreated:0,vouchersDeduplicated:0});},r=>{r.status='pending';},r=>{r.status='failed';},r=>{r.status='unknown';},r=>{r.mode='unknown';},r=>{r.error_code='CONTRADICTION';}]){
    const orphan=insertHeader(g,r=>{Object.assign(r,{...persisted,batch_id:r.batch_id});mutate(r);});try{const stateBefore=state(g);blocked(await run(g.request));assert.deepEqual(state(g),stateBefore);}finally{deleteHeader(g,orphan);}
  }
});
await test('new public Q1, Q2 and mixed-period dedup batches preserve original accounting and selected tax without customer rework', async () => {
  const g=await fixture(),old=await run(g.request);
  for(const quarters of [['prior'],['target'],['prior','target']]) {
    const operation=await createPublicDedupBatch(g,quarters);
    assert.equal(operation.result.created.vouchersDeduplicated,quarters.length);
    assert.deepEqual(inspect(g,db=>({vouchers:db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,entries:db.prepare('SELECT COUNT(*) n FROM voucher_entries').get().n}),true),{vouchers:2,entries:6});
    const before=state(g),bytes=hash(readFileSync(g.dbPath)),d=await run(g.request);
    assert.equal(d.q2CalculationReady,true,JSON.stringify(d.computation.issues));assert.equal(d.priorComputation.calculationReady,true);assert.deepEqual(d.computation.issues,[]);
    assert.deepEqual(d.computation.cells,old.computation.cells);assert.deepEqual(d.priorComputation.cells,old.priorComputation.cells);assert.equal(d.computation.sales.length,1);assert.equal(d.priorComputation.sales.length,1);
    assert.deepEqual(state(g),before);assert.equal(hash(readFileSync(g.dbPath)),bytes);assert.equal((await current(g.request,old.contentDigest)).status,'stale');
  }
});
await test('dedup is authenticated by actual creator source, persisted fingerprint, strict header counts and recognized action', async () => {
  const g=await fixture(),{batchId}=await createPublicDedupBatch(g,['prior','target']),old=await run(g.request);assert.equal(old.q2CalculationReady,true);
  const link=inspect(g,db=>db.prepare('SELECT * FROM import_batch_vouchers WHERE batch_id=? ORDER BY voucher_id LIMIT 1').get(batchId),true);
  const source=inspect(g,db=>db.prepare('SELECT * FROM import_voucher_sources WHERE voucher_id=?').get(link.voucher_id),true);
  const header=inspect(g,db=>db.prepare('SELECT * FROM import_batches WHERE batch_id=?').get(batchId),true);
  const mutations=[
    ['import_batch_vouchers','action','unknown',link.action,'id',link.id],
    ['import_batch_vouchers','action','created',link.action,'id',link.id],
    ['import_batch_vouchers','enterprise_key',g.key+'-WRONG',link.enterprise_key,'id',link.id],
    ['import_batch_vouchers','content_fingerprint','0'.repeat(64),link.content_fingerprint,'id',link.id],
    ['import_voucher_sources','content_fingerprint','0'.repeat(64),source.content_fingerprint,'id',source.id],
    ['import_voucher_sources','voucher_fingerprint','0'.repeat(64),source.voucher_fingerprint,'id',source.id],
    ['import_batches','result_json',JSON.stringify({...JSON.parse(header.result_json),vouchersDeduplicated:1}),header.result_json,'batch_id',batchId],
    ['import_batches','status','failed',header.status,'batch_id',batchId],
  ];
  for(const [table,column,value,restore,key,id]of mutations){
    inspect(g,db=>db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`).run(value,id));
    try{const before=state(g),bytes=hash(readFileSync(g.dbPath)),d=await run(g.request);blocked(d);assert.equal((await current(g.request,old.contentDigest)).status,'stale');assert.deepEqual(state(g),before);assert.equal(hash(readFileSync(g.dbPath)),bytes);}finally{inspect(g,db=>db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`).run(restore,id));}
  }
  inspect(g,db=>db.prepare('DELETE FROM import_voucher_sources WHERE id=?').run(source.id));
  try{blocked(await run(g.request));}finally{inspect(g,db=>{const keys=Object.keys(source);db.prepare('INSERT INTO import_voucher_sources('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>source[k]));});}
  assert.equal((await run(g.request)).q2CalculationReady,true);
});
await test('other enterprise and account-set batches stay outside Q2 digest while either target identity contradiction is explicit', async () => {
  const g=await fixture(),old=await run(g.request),other=createPublicNoopBatch(g,{otherEnterprise:true});assert.notEqual(other.id,g.id);assert.notEqual(other.key,g.key);
  assert.equal((await run(g.request)).contentDigest,old.contentDigest);assert.equal((await current(g.request,old.contentDigest)).status,'current');
  for(const [column,value,restore]of [['account_set_id',g.id,other.id],['enterprise_key',g.key,other.key]]){
    inspect(g,db=>db.prepare('UPDATE import_batches SET '+column+'=? WHERE batch_id=?').run(value,other.batchId));try{const d=await run(g.request);blocked(d);assert.ok(d.computation.issues.some(i=>i.code==='target_batch_metadata_conflict'&&i.classification==='conflict'));}finally{inspect(g,db=>db.prepare('UPDATE import_batches SET '+column+'=? WHERE batch_id=?').run(restore,other.batchId));}
  }
});
await test('fully explained posted Q3 batch does not enter Q1/Q2 dependency, but ambiguous future result remains visible and blocked', async () => {
  const g=await fixture(),old=await run(g.request);await addFuturePostedQuarter(g);const before=state(g),bytes=hash(readFileSync(g.dbPath)),d=await run(g.request);
  assert.equal(d.q2CalculationReady,true,JSON.stringify(d));assert.equal(d.contentDigest,old.contentDigest);assert.equal((await current(g.request,old.contentDigest)).status,'current');assert.deepEqual(state(g),before);assert.equal(hash(readFileSync(g.dbPath)),bytes);
  const h=inspect(g,db=>db.prepare("SELECT b.* FROM import_batches b JOIN import_batch_vouchers l ON l.batch_id=b.batch_id JOIN vouchers v ON v.id=l.voucher_id WHERE v.period='2026-07'").get(),true);
  inspect(g,db=>db.prepare("UPDATE import_batches SET result_json='{}' WHERE batch_id=?").run(h.batch_id));try{const x=await run(g.request);blocked(x);assert.ok(x.computation.issues.some(i=>i.code==='target_batch_result_missing_or_invalid'));assert.equal((await current(g.request,old.contentDigest)).status,'stale');}finally{inspect(g,db=>db.prepare('UPDATE import_batches SET result_json=? WHERE batch_id=?').run(h.result_json,h.batch_id));}
  const v=inspect(g,db=>db.prepare("SELECT * FROM vouchers WHERE period='2026-07'").get(),true),source=inspect(g,db=>db.prepare('SELECT * FROM import_voucher_sources WHERE voucher_id=?').get(v.id),true),entries=inspect(g,db=>db.prepare('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY line_no,id').all(v.id),true);
  for(const [period,date]of [['2026-13','2026-13-17'],['2026-07','2026-07-32'],['2026-07','2026-08-17'],['','']]){
    inspect(g,db=>{db.prepare('UPDATE vouchers SET period=?,voucher_date=? WHERE id=?').run(period,date,v.id);db.prepare('UPDATE import_voucher_sources SET voucher_fingerprint=? WHERE id=?').run(persistedVoucherFingerprint({...v,period,voucher_date:date},entries),source.id);});
    try{const stateBefore=state(g),x=await run(g.request);blocked(x);assert.ok(x.computation.issues.some(i=>i.code==='target_batch_voucher_period_date_invalid'));assert.equal((await current(g.request,old.contentDigest)).status,'stale');assert.deepEqual(state(g),stateBefore);}finally{inspect(g,db=>{db.prepare('UPDATE vouchers SET period=?,voucher_date=? WHERE id=?').run(v.period,v.voucher_date,v.id);db.prepare('UPDATE import_voucher_sources SET voucher_fingerprint=? WHERE id=?').run(source.voucher_fingerprint,source.id);});}
  }
  assert.equal((await run(g.request)).contentDigest,old.contentDigest);
});
await test('strict enriched10 and legacy5 results retain target/future semantics; incomplete or contradictory enrichment never downgrades', async () => {
  const g=await fixture(),baseline=await run(g.request);await addFuturePostedQuarter(g);assert.equal((await run(g.request)).contentDigest,baseline.contentDigest);
  for(const period of ['2026-04','2026-07']){
    const header=inspect(g,db=>db.prepare('SELECT b.* FROM import_batches b JOIN import_batch_vouchers l ON l.batch_id=b.batch_id JOIN vouchers v ON v.id=l.voucher_id WHERE v.period=?').get(period),true),enriched=JSON.parse(header.result_json);
    assert.deepEqual(Object.keys(enriched).sort(),['accountSetCreated','accountsAdded','openingBalancesApplied','vouchersCreated','vouchersDeduplicated','contentFingerprint','mode','accountSetId','source','sourceTrace'].sort());assert.equal(enriched.sourceTrace.length,1);
    const legacy=Object.fromEntries(['accountSetCreated','accountsAdded','openingBalancesApplied','vouchersCreated','vouchersDeduplicated'].map(k=>[k,enriched[k]]));
    inspect(g,db=>db.prepare('UPDATE import_batches SET result_json=? WHERE batch_id=?').run(JSON.stringify(legacy),header.batch_id));
    try{const before=state(g),d=await run(g.request);assert.equal(d.q2CalculationReady,true,JSON.stringify(d.computation.issues));assert.deepEqual(d.computation.cells,baseline.computation.cells);assert.deepEqual(state(g),before);if(period==='2026-07')assert.equal(d.contentDigest,baseline.contentDigest,'fully explained legacy future remains excluded');}
    finally{inspect(g,db=>db.prepare('UPDATE import_batches SET result_json=? WHERE batch_id=?').run(header.result_json,header.batch_id));}
    for(const [label,mutate]of [
      ['extra-field',r=>{r.extra=true;}],['missing-anchor',r=>{delete r.mode;}],['fingerprint-anchor',r=>{r.contentFingerprint='f'.repeat(64);}],
      ['set-anchor',r=>{r.accountSetId+=999;}],['source-anchor',r=>{r.source.enterpriseKey+='-WRONG';}],['extra-source-field',r=>{r.source.extra=true;}],
      ['missing-trace',r=>{r.sourceTrace=[];}],['duplicate-trace',r=>{r.sourceTrace.push({...r.sourceTrace[0]});}],
      ['trace-period',r=>{r.sourceTrace[0].period='2026-08';}],['trace-fingerprint',r=>{r.sourceTrace[0].contentFingerprint='e'.repeat(64);}],
      ['trace-state',r=>{r.sourceTrace[0].state='unknown';}],['extra-trace-field',r=>{r.sourceTrace[0].extra=true;}],
    ]){
      const bad=structuredClone(enriched);mutate(bad);inspect(g,db=>db.prepare('UPDATE import_batches SET result_json=? WHERE batch_id=?').run(JSON.stringify(bad),header.batch_id));
      try{const before=state(g),bytes=hash(readFileSync(g.dbPath)),d=await run(g.request);blocked(d);assert.ok(d.computation.issues.some(i=>i.code==='target_batch_result_missing_or_invalid'),period+' '+label);assert.equal((await current(g.request,baseline.contentDigest)).status,'stale');assert.deepEqual(state(g),before);assert.equal(hash(readFileSync(g.dbPath)),bytes);}
      finally{inspect(g,db=>db.prepare('UPDATE import_batches SET result_json=? WHERE batch_id=?').run(header.result_json,header.batch_id));}
    }
  }
  assert.equal((await run(g.request)).contentDigest,baseline.contentDigest);
});
await test('independent amounts and multiple invoices in both quarters are calculated from raw evidence', async () => {
  const g = await fixture({ priorAmounts: ['103789.00', '201113.00', '86791.00'], targetAmounts: ['133127.00', '217913.00', '99837.00'] }), d = await run(g.request);
  assert.equal(d.q2CalculationReady, true, JSON.stringify(d)); assert.equal(d.priorComputation.sales.length, 3); assert.equal(d.computation.sales.length, 3);
  assert.equal(row(d.computation, 1).value, '450877.00'); assert.equal(row(d.computation, 20).value, '4508.77'); assert.equal(row(d.computation, 1, 'yearToDate').value, '842570.00');
});
await test('each quarter includes exact threshold, below threshold and fractional-net engineering gates', async () => {
  const g = await fixture({ priorAmount: '300000.00', targetAmount: '300000.00' }); assert.equal((await run(g.request)).q2CalculationReady, true);
  for (const options of [{ priorAmount: '299999.00' }, { targetAmount: '299999.00' }, { targetAmount: '300000.01' }]) { const x = await fixture(options), d = await run(x.request); blocked(d); assert.ok(d.computation.issues.some(i => /actual_Q1|below_threshold|fractional_net/.test(i.code))); }
});
await test('rules retain v1 and state official effective dates, limited cumulative inference and no invented rounding policy', () => {
  const old = getVatRules(), rules = getVatQ2Rules(); assert.equal(old.version, 'offline-vat-selected/1'); assert.equal(old.engineeringScope.period, '2026-Q1');
  assert.equal(rules.engineeringScope.period, '2026-Q2'); assert.equal(rules.sources.relief.effectiveFrom, '2026-01-01'); assert.equal(rules.sources.relief.effectiveThrough, '2027-12-31'); assert.equal(rules.sources.transition.effectiveFrom, '2026-02-01');
  assert.deepEqual(rules.yearToDate.rows, [1, 2, 3, 15, 16, 20]); assert.equal(rules.yearToDate.directOfficialQ2AccumulationFAQFound, false); assert.match(rules.engineeringScope.rounding, /not_official/);
});
await test('Q2 cannot run through the old Q1 historical gate or copied public pair/session/raw authority', async () => {
  const s = await openVatInputPairFiles(f.request);
  try {
    const p = calculateOfflineVat(s.target.rawInput, s.source, s.snapshots.target); assert.equal(p.calculationReady, false); assert.ok(p.issues.some(i => i.code === 'historical_history_unsupported'));
    await assert.rejects(() => calculateOfflineVatQ2({ ...s })); await assert.rejects(() => calculateOfflineVatQ2(structuredClone({ source: {}, snapshots: {}, prior: {}, target: {} })));
    assert.equal((await calculateOfflineVatQ2(s)).computation.calculationReady, true);
  } finally { s.close(); }
  await assert.rejects(() => calculateOfflineVatQ2(s));
  // A witnessed tuple change may permanently retire its real pair. Each attack
  // gets its own held pair; restoring public fields never restores authority.
  for (const mutate of [s => { s.target.rawInput = structuredClone(s.target.rawInput); }, s => { s.prior = { ...s.prior }; }, s => { s.snapshots = structuredClone(s.snapshots); }]) {
    const held = await openVatInputPairFiles(f.request); try { mutate(held); await assert.rejects(() => calculateOfflineVatQ2(held)); } finally { held.close(); }
  }
});
await test('strict descriptors reject nested proxies, getters, hidden and symbolic fields without triggering traps', async () => {
  let traps = 0; const proxy = new Proxy({}, { get() { traps++; }, getPrototypeOf() { traps++; }, ownKeys() { traps++; } });
  const bad = [proxy, { ...f.request, target: proxy }, { ...f.request, priorInputPath: proxy }, { ...f.request, previousComputation: {} }, { ...f.request, target: { ...f.request.target, accountSetId: '1' } }, { ...f.request, target: { ...f.request.target, accountSetId: 1.1 } }, { ...f.request, targetInputPath: 'relative.json' }];
  for (const mutate of [r => Object.defineProperty(r, 'hidden', { value: 1 }), r => Object.defineProperty(r.target, 'hidden', { value: 1 }), r => { r[Symbol('authority')] = true; }, r => Object.defineProperty(r.target, 'dbPath', { enumerable: true, get() { traps++; return f.dbPath; } })]) { const r = structuredClone(f.request); mutate(r); bad.push(r); }
  for (const r of bad) assert.equal((await run(r)).code, 'q2_request_invalid'); assert.equal(traps, 0);
});
await test('same UUID physical clone, cross-enterprise, account alias, wrong instance/profile/quarter remain blocked', async () => {
  const clone = join(root, 'clone.db'); copyFileSync(f.dbPath, clone);
  for (const mutate of [r => { r.target.dbPath = clone; }, r => { r.target.enterpriseKey = 'OTHER'; }, r => { r.target.accountSetId = 999; }, r => { r.target.databaseInstanceId = '00000000-0000-4000-8000-000000000000'; }]) { const r = structuredClone(f.request); mutate(r); blocked(await run(r)); }
  for (const [path, mutate] of [[f.targetInputPath, c => { c.db = clone; }], [f.targetInputPath, c => { c.profileId = 'cas-2006-basic-v1'; }], [f.priorInputPath, c => { c.scope.accountSetId = '01'; }], [f.targetInputPath, c => { c.scope.period = '2026-Q1'; }], [f.targetInputPath, c => { c.previousComputation = f.priorInputPath; }]]) await changeFile(path, mutate, async () => blocked(await run(f.request)));
});
await test('real hardlink aliases are rejected and unlink restores the original target', async () => {
  const path = join(root, 'hardlink.db'); linkSync(f.dbPath, path); try { blocked(await run(f.request)); } finally { unlinkSync(path); } assert.equal((await run(f.request)).q2CalculationReady, true);
});
await test('January establishment/start gate remains additional to fully passed Q1 v1', async () => {
  const g = await fixture({ priorDate: '2026-02-13', establishedOn: '2026-02-01' }), d = await run(g.request); blocked(d); assert.equal(d.priorComputation.calculationReady, true); assert.ok(d.computation.issues.some(i => i.code === 'prior_january_establishment_required'));
  inspect(f, db => db.exec("UPDATE account_sets SET start_period='2026-02'")); try { blocked(await run(f.request)); } finally { inspect(f, db => db.exec("UPDATE account_sets SET start_period='2026-01'")); }
});
await test('upstream unknown exclusion/date, actual conflict and known non-January retain precise causes and fact requests', async () => {
  for(const [mutate,code,classification]of [[d=>{d.period.exclusions[0].state='unknown';},'missing_exclusion_otherSales','unknown'],[d=>{d.enterprise.establishedOn=null;},'missing_establishment_date','unknown']])await changeFile(join(f.dir,'tax.json'),mutate,async()=>{
    const d=await run(f.request);blocked(d);const original=d.priorComputation.issues.find(i=>i.code===code),cause=d.computation.issues.find(i=>i.upstream?.code===code);assert.ok(original&&cause);assert.equal(cause.classification,classification);assert.equal(cause.requestedFact,original.requestedFact);assert.equal(cause.field,'prior.'+original.field);assert.ok(!d.computation.issues.some(i=>i.code==='prior_january_establishment_required'));assert.equal(d.computation.historyBridge.priorAccountingExplained,true);assert.ok(!d.computation.issues.some(i=>/^unexplained_(posted|source|import_batch)/.test(i.code)));
  });
  inspect(f,db=>db.exec("UPDATE voucher_entries SET summary=summary||'CONFLICT' WHERE voucher_id=(SELECT id FROM vouchers WHERE period='2026-01')"));try{const d=await run(f.request);blocked(d);const cause=d.computation.issues.find(i=>i.upstream?.code==='posted_candidate_content_or_source_mismatch');assert.ok(cause);assert.equal(cause.classification,'conflict');assert.equal(cause.requestedFact,d.priorComputation.issues.find(i=>i.code===cause.upstream.code).requestedFact);}finally{inspect(f,db=>db.exec("UPDATE voucher_entries SET summary=replace(summary,'CONFLICT','') WHERE voucher_id=(SELECT id FROM vouchers WHERE period='2026-01')"));}
  const g=await fixture({priorDate:'2026-02-13',establishedOn:'2026-02-01'}),d=await run(g.request);blocked(d);assert.equal(d.priorComputation.calculationReady,true);const january=d.computation.issues.find(i=>i.code==='prior_january_establishment_required');assert.equal(january.status,'unsupported');assert.equal(january.classification,'unsupported');
});
await test('known enterprise contradictions are conflicts and missing enterprise facts stay unknown', async () => {
  for (const [field, value, kind] of [['form', 'individual_business', 'conflict'], ['establishedOn', '2026-02-01', 'conflict'], ['form', 'unknown', 'unknown'], ['establishedOn', null, 'unknown']]) await changeFile(join(f.targetDir, 'tax.json'), d => { d.enterprise[field] = value; }, async () => {
    const d = await run(f.request); blocked(d); assert.ok(d.computation.issues.some(i => i.field === 'taxFacts.enterprise.' + field && i.classification === kind)); if (kind === 'unknown') assert.ok(!d.computation.issues.some(i => i.code.startsWith('cross_quarter_enterprise_')));
  });
});
await test('every Q2 qualification, accountant tax fact and exclusion guard remains effective', async () => {
  for (const mutate of [d => { d.tax.vatStatus = 'general'; }, d => { d.tax.filingFrequency = 'monthly'; }, d => { d.tax.vatStatus = 'unknown'; }, d => { d.evidence[1].confirmedBy.role = 'owner'; }]) await declaration(f, f.targetDir, mutate, async () => blocked(await run(f.request)));
  for (const mutate of [d => { d.enterprise.confirmedBy.role = 'owner'; }, d => { d.period.confirmedBy.role = 'owner'; }, d => { d.period.exclusions.pop(); }, d => { d.period.exclusions[0].state = 'unknown'; }, d => { d.period.exclusions[1].state = 'present'; }]) await changeFile(join(f.targetDir, 'tax.json'), mutate, async () => blocked(await run(f.request)));
});
await test('both periods retain legal owner/operator invoice fact roles with real references, while invalid roles and missing references reject', async () => {
  for (const dir of [f.dir, f.targetDir]) for (const role of ['owner', 'business_operator']) await changeFile(join(dir, 'tax.json'), d => { d.invoices[0].confirmedBy.role = role; }, async () => {
    const d = await run(f.request); assert.equal(d.q2CalculationReady, true, JSON.stringify(d)); assert.equal(row(d.computation, 20).value, '3472.91');
  });
  for (const dir of [f.dir, f.targetDir]) for (const mutate of [d => { d.invoices[0].confirmedBy.role = 'invalid_role'; }, d => { d.invoices[0].sourceRefs = []; }]) await changeFile(join(dir, 'tax.json'), mutate, async () => blocked(await run(f.request)));
});
await test('historical bridge resolves only explicit evidenced dependency; external materials, unknown/conflict never erased', async () => {
  for (const mutate of [d => { d.opening.state = 'unknown'; }, d => { d.history.state = 'first_period'; }, d => { d.history.evidenceIds = ['owner']; }, d => { d.materials = [{ area: 'history', format: 'unparsed-history', evidenceIds: ['accountant'] }]; }, d => { d.materials = [{ area: 'opening', format: 'unparsed-balances', evidenceIds: ['accountant'] }]; }]) await declaration(f, f.targetDir, mutate, async () => blocked(await run(f.request)));
  await changeFile(join(f.dir, 'tax.json'), d => { d.period.exclusions[0].state = 'unknown'; }, async () => { const d = await run(f.request); blocked(d); assert.equal(d.priorComputation.calculationReady, false); });
});
await test('missing originals block and supplied corrections restore readiness; raw basis change invalidates old digest without changing tax', async () => {
  const d = await run(f.request), path = join(f.targetDir, 'sales.csv'); renameSync(path, path + '.held'); try { blocked(await run(f.request)); } finally { renameSync(path + '.held', path); }
  assert.equal((await run(f.request)).contentDigest, d.contentDigest);
  await changeFile(join(f.targetDir, 'accounting.json'), doc => { doc.facts[0].basis += ' 新核对依据'; }, async () => { const c = await current(f.request, d.contentDigest); assert.equal(c.status, 'stale'); assert.equal(c.diagnostic.q2CalculationReady, true); assert.equal(row(c.diagnostic.computation, 20).value, '3472.91'); });
});
await test('identical duplicate originals stay idempotent while conflicting identities, wrong tax and unsupported facts block', async () => {
  const path = join(f.targetDir, 'sales.csv'), old = readFileSync(path);
  try {
    writeFileSync(path, old.toString() + '\n' + old.toString().split('\n')[1]);
    const before = state(f), d = await run(f.request); assert.equal(d.q2CalculationReady, true); assert.equal(d.computation.sales.length, 1); assert.equal(row(d.computation, 1).value, '347291.00'); assert.equal(d.computation.reconciledBusinesses.length, 1); assert.deepEqual(state(f), before);
  } finally { writeFileSync(path, old); }
  try { writeFileSync(path, old.toString() + '\n' + old.toString().split('\n')[1].replace('347291.00,3472.91,350763.91', '347292.00,3472.92,350764.92')); blocked(await run(f.request)); } finally { writeFileSync(path, old); }
  try { writeFileSync(path, old.toString().replace('3472.91,350763.91', '3472.90,350763.90')); blocked(await run(f.request)); } finally { writeFileSync(path, old); }
  for (const mutate of [d => { d.invoices[0].invoiceClass = 'special'; }, d => { d.invoices[0].domesticConsumption = 'cross_border'; }, d => { d.invoices.push(structuredClone(d.invoices[0])); }, d => { d.invoices[0].invoiceRef.number = '99999'; }]) await changeFile(join(f.targetDir, 'tax.json'), mutate, async () => blocked(await run(f.request)));
});
await test('both quarters draft, illegal money, kind, missing source and batch changes cannot be ignored as prior history', async () => {
  for (const period of ['2026-01', '2026-04']) for (const [change, restore] of [
    ["UPDATE vouchers SET status='draft' WHERE period=?", "UPDATE vouchers SET status='posted' WHERE period=?"],
    ["UPDATE vouchers SET kind='unknown' WHERE period=?", "UPDATE vouchers SET kind='normal' WHERE period=?"],
    ["UPDATE vouchers SET status='unexpected' WHERE period=?", "UPDATE vouchers SET status='posted' WHERE period=?"],
    ["UPDATE voucher_entries SET credit=credit+0.001 WHERE code='2221' AND voucher_id=(SELECT id FROM vouchers WHERE period=?)", "UPDATE voucher_entries SET credit=ROUND(credit,2) WHERE code='2221' AND voucher_id=(SELECT id FROM vouchers WHERE period=?)"],
    ["UPDATE import_voucher_sources SET source_system='unknown' WHERE voucher_id=(SELECT id FROM vouchers WHERE period=?)", "UPDATE import_voucher_sources SET source_system='offline-bookkeeping-candidates-v1' WHERE voucher_id=(SELECT id FROM vouchers WHERE period=?)"],
  ]) { inspect(f, db => db.prepare(change).run(period)); try { const before = state(f); blocked(await run(f.request)); assert.deepEqual(state(f), before); } finally { inspect(f, db => db.prepare(restore).run(period)); } }
  const batch = inspect(f, db => db.prepare("SELECT batch_id FROM import_voucher_sources WHERE voucher_id=(SELECT id FROM vouchers WHERE period='2026-01')").get().batch_id, true);
  inspect(f, db => db.prepare("UPDATE import_batches SET status='running' WHERE batch_id=?").run(batch)); try { blocked(await run(f.request)); } finally { inspect(f, db => db.prepare("UPDATE import_batches SET status='completed' WHERE batch_id=?").run(batch)); }
});
await test('unknown extra source and unpaired batch rows remain unexplained rather than filtered', async () => {
  const saved = inspect(f, db => db.prepare('SELECT * FROM import_batch_vouchers ORDER BY voucher_id LIMIT 1').get(), true);
  inspect(f, db => db.prepare("UPDATE import_batch_vouchers SET source_voucher_id='unknown' WHERE voucher_id=?").run(saved.voucher_id));
  try { blocked(await run(f.request)); } finally { inspect(f, db => db.prepare('UPDATE import_batch_vouchers SET source_voucher_id=? WHERE voucher_id=?').run(saved.source_voucher_id, saved.voucher_id)); }
  const s = inspect(f, db => db.prepare('SELECT * FROM import_source_bindings LIMIT 1').get(), true);
  inspect(f, db => db.prepare("UPDATE import_source_bindings SET source_system='unknown' WHERE id=?").run(s.id)); try { blocked(await run(f.request)); } finally { inspect(f, db => db.prepare('UPDATE import_source_bindings SET source_system=? WHERE id=?').run(s.source_system, s.id)); }
});
await test('old digest becomes stale on ledger content even if sales number stays unchanged; fake summaries authorize nothing', async () => {
  const d = await run(f.request); inspect(f, db => db.exec("UPDATE voucher_entries SET summary=summary||'CHANGED' WHERE voucher_id=(SELECT id FROM vouchers WHERE period='2026-01')"));
  try { const c = await current(f.request, d.contentDigest); assert.equal(c.status, 'stale'); blocked(c.diagnostic); } finally { inspect(f, db => db.exec("UPDATE voucher_entries SET summary=replace(summary,'CHANGED','') WHERE voucher_id=(SELECT id FROM vouchers WHERE period='2026-01')")); }
  assert.equal((await current(f.request, { contentDigest: d.contentDigest, authorizesExecution: true })).status, 'stale'); assert.equal((await current(f.request, d.contentDigest)).authorizesExecution, false);
});
await test('parent cached tax and cached default DB cannot contaminate worker target; inherited preloads/data env removed', () => {
  probe(f, `const {db}=await import(new URL('server/db.mjs',base));try{assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,0);await import(new URL('server/tax-calculation.mjs',base));process.env.node_options='--import=ABSENT_PRELOAD';process.env.node_path='ABSENT_MODULES';let captured;const spawn=cp.spawn;cp.spawn=(exe,args,opts)=>{captured=opts.env;return spawn(exe,args,opts);};syncBuiltinESMExports();const api=await import(new URL('server/offline-vat-q2.mjs',base));const d=await api.runOfflineVatQ2(request);assert.equal(d.q2CalculationReady,true);assert.ok(!Object.keys(captured).some(k=>['NODE_OPTIONS','NODE_PATH','WORKBENCH_DATA_DIR'].includes(k.toUpperCase())));assert.equal(d.computation.cells.find(c=>c.row===20&&c.column==='services'&&c.period==='current').value,'3472.91');}finally{db.close();}`);
});
await test('cached parent financial function cannot execute stale code under a new native manifest', () => {
  const dest = copyCode(); probe(f, `const file=new URL('server/tax-calculation.mjs',base);await import(file);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('export function calculateOfflineVat(input, source, snapshot) {',"export function calculateOfflineVat(input, source, snapshot) { throw new Error('ACTUAL_CHILD_SENTINEL');"));const api=await import(new URL('server/offline-vat-q2.mjs',base));const d=await api.runOfflineVatQ2(request);assert.equal(d.q2CalculationReady,false);assert.equal(d.code,'q2_input_rejected');`, dest);
});
await test('observed rule/provider/worker/facade/CLI byte changes permanently latch restart even after restore', () => {
  for (const name of ['tax-rule-registry.mjs', 'offline-vat-input.mjs', 'offline-ledger-snapshot.mjs', 'offline-vat-q2-worker.mjs', 'offline-vat-q2-code.mjs', 'offline-vat-q2.mjs', '../scripts/offline-vat-q2.mjs']) {
    const dest = copyCode(); probe(f, `const api=await import(new URL('server/offline-vat-q2.mjs',base));const file=new URL(${JSON.stringify('server/' + name)},base),old=fs.readFileSync(file);fs.appendFileSync(file,${JSON.stringify('\n// observed\n')});assert.equal((await api.runOfflineVatQ2(request)).code,'q2_code_restart_required');fs.writeFileSync(file,old);assert.equal((await api.runOfflineVatQ2(request)).code,'q2_code_restart_required');`, dest);
  }
});
await test('native pre-spawn code replacement is rejected before application sentinel execution', () => {
  const dest = copyCode(), marker = join(dest, 'sentinel.txt');
  const sentinel = "\n(await import('node:fs')).writeFileSync(" + JSON.stringify(marker) + ",'BAD');\n";
  probe(f, `const original=cp.spawn;let file,saved;cp.spawn=(...a)=>{file=new URL('server/offline-vat-input.mjs',base);saved=fs.readFileSync(file);fs.writeFileSync(file,Buffer.concat([saved,Buffer.from(${JSON.stringify(sentinel)})]));return original(...a);};syncBuiltinESMExports();const api=await import(new URL('server/offline-vat-q2.mjs',base));try{assert.equal((await api.runOfflineVatQ2(request)).code,'q2_code_restart_required');assert.equal(fs.existsSync(${JSON.stringify(marker)}),false);}finally{fs.writeFileSync(file,saved);}`, dest);
});
await test('worker-observed code replacement latches parent restart after restored bytes before parent result handling', () => {
  const dest = copyCode();
  probe(f, `const file=new URL('server/offline-vat-input.mjs',base),old=fs.readFileSync(file),original=cp.spawn;let observed=false;cp.spawn=(...a)=>{fs.appendFileSync(file,${JSON.stringify('\n// worker observed\n')});const child=original(...a);child.on('message',m=>{if(m.code==='q2_code_restart_required'){observed=true;fs.writeFileSync(file,old);}});return child;};syncBuiltinESMExports();const api=await import(new URL('server/offline-vat-q2.mjs',base));assert.equal((await api.runOfflineVatQ2(request)).code,'q2_code_restart_required');assert.equal(observed,true);assert.equal((await api.runOfflineVatQ2(request)).code,'q2_code_restart_required');`, dest);
});
await test('native initial inventory missing provider is reported as restart before financial sentinel and remains retired after restore', () => {
  const dest = copyCode(), marker = join(dest, 'financial-imported.txt');
  writeFileSync(join(dest, 'server/tax-calculation.mjs'), readFileSync(join(dest, 'server/tax-calculation.mjs'), 'utf8') + "\n(await import('node:fs')).writeFileSync(" + JSON.stringify(marker) + ",'BAD');\n");
  probe(f, `const file=new URL('server/offline-vat-input.mjs',base),old=fs.readFileSync(file),spawn=cp.spawn;let observed=false;cp.spawn=(...a)=>{fs.unlinkSync(file);const child=spawn(...a);child.on('message',m=>{if(m.code==='q2_code_restart_required'){observed=true;fs.writeFileSync(file,old);}});return child;};syncBuiltinESMExports();const api=await import(new URL('server/offline-vat-q2.mjs',base));try{assert.equal((await api.runOfflineVatQ2(request)).code,'q2_code_restart_required');assert.equal(observed,true);assert.equal(fs.existsSync(${JSON.stringify(marker)}),false);assert.equal((await api.runOfflineVatQ2(request)).code,'q2_code_restart_required');}finally{if(!fs.existsSync(file))fs.writeFileSync(file,old);}`, dest);
});
await test('actual worker timeout waits for termination before returning', () => {
  const dest = copyCode(), file = join(dest, 'server/offline-vat-q2-worker.mjs'); writeFileSync(file, readFileSync(file, 'utf8').replace('session = await loader.openVatInputPairFiles(request);', 'await new Promise(()=>{});session = await loader.openVatInputPairFiles(request);'));
  probe(f, `let child;const original=cp.spawn;cp.spawn=(...a)=>(child=original(...a));syncBuiltinESMExports();const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...a)=>timer(fn,ms===30000?150:ms,...a);const api=await import(new URL('server/offline-vat-q2.mjs',base));const d=await api.runOfflineVatQ2(request);assert.equal(d.code,'q2_worker_timeout');assert.ok(child.exitCode!==null||child.signalCode!==null);`, dest);
});
await test('actual spawn error, exit and disconnect settle and close all child resources', () => {
  for (const action of ['missing', 'kill', 'disconnect']) probe(f, `let child;const original=cp.spawn;cp.spawn=(exe,args,opts)=>{child=original(${action === 'missing' ? "new URL('ABSENT-node.exe',base).pathname" : 'exe'},args,opts);${action === 'kill' ? "setTimeout(()=>child.kill('SIGKILL'),50);" : action === 'disconnect' ? 'setTimeout(()=>child.disconnect(),50);' : ''}return child;};syncBuiltinESMExports();const api=await import(new URL('server/offline-vat-q2.mjs',base));assert.equal((await api.runOfflineVatQ2(request)).code,'q2_worker_unavailable');assert.ok(child.exitCode!==null||child.signalCode!==null);`);
});
await test('CLI relative paths, wx collision, safe stdout and a fully recomputed post-publication result', () => {
  const out = join(root, 'cli-output.json'); const cli = join(wb, 'scripts/offline-vat-q2.mjs');
  const request = join(root, 'cli-request.json'); writeJson(request, { ...f.request, priorInputPath: join('1', 'case-1', 'input.json'), targetInputPath: join('1', 'q2', 'input.json') });
  const go = () => spawnSync(process.execPath, [cli, '--input', request, '--output', out], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  const p = go(); assert.equal(p.status, 0, p.stderr + p.stdout); assert.equal(p.stderr, ''); assert.match(p.stdout, /^OFFLINE_VAT_Q2_WRITTEN status=q2_selected_fields_calculated\r?\n$/); assert.equal(readJson(out).q2CalculationReady, true); assert.equal(go().status, 4);
});
await test('CLI publication window rechecks request, both raw periods and ledger before reporting success', () => {
  for (const hook of ['writeFile', 'sync']) for (const path of [f.requestPath, join(f.dir, 'sales.csv'), join(f.targetDir, 'sales.csv')]) {
    const old = readFileSync(path), out = join(root, 'failed-' + (++serial) + '.json');
    try { probe(f, `const original=fs.promises.open;fs.promises.open=async(...a)=>{const h=await original(...a);if(a[1]==='wx'){const originalMethod=h[${JSON.stringify(hook)}].bind(h);let once=false;h[${JSON.stringify(hook)}]=async(...args)=>{const r=await originalMethod(...args);if(!once){once=true;fs.appendFileSync(${JSON.stringify(path)},${JSON.stringify('\n')});}return r;};}return h;};syncBuiltinESMExports();const {runCli}=await import(new URL('scripts/offline-vat-q2.mjs',base));const d=await runCli(['--input',${JSON.stringify(f.requestPath)},'--output',${JSON.stringify(out)}]);assert.equal(d.exitCode,4);const p=JSON.parse(fs.readFileSync(${JSON.stringify(out)},'utf8'));assert.equal(p.publicationStatus,'failed');assert.equal(p.authorizesExecution,false);`); } finally { writeFileSync(path, old); }
  }
  const out = join(root, 'ledger-window.json');
  try { probe(f, `const {DatabaseSync}=await import('node:sqlite');const original=fs.promises.open;fs.promises.open=async(...a)=>{const h=await original(...a);if(a[1]==='wx'){const sync=h.sync.bind(h);let once=false;h.sync=async()=>{await sync();if(!once){once=true;const db=new DatabaseSync(request.target.dbPath);try{db.exec("UPDATE vouchers SET summary=summary||'WINDOW' WHERE period='2026-04'");}finally{db.close();}}};}return h;};syncBuiltinESMExports();const {runCli}=await import(new URL('scripts/offline-vat-q2.mjs',base));assert.equal((await runCli(['--input',${JSON.stringify(f.requestPath)},'--output',${JSON.stringify(out)}])).exitCode,4);assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(out)},'utf8')).publicationStatus,'failed');`); } finally { inspect(f, db => db.exec("UPDATE vouchers SET summary=replace(summary,'WINDOW','') WHERE period='2026-04'")); }
});
await test('a supplied complete Q1 remains independently calculated while a missing Q2 dependency blocks target cells', async () => {
  await changeFile(join(f.targetDir, 'tax.json'), d => { d.period.exclusions.find(x => x.area === 'prepayments').state = 'unknown'; }, async () => {
    const d = await run(f.request); blocked(d); assert.equal(d.priorComputation.calculationReady, true); assert.equal(row(d.priorComputation, 20).value, '5098.73'); assert.ok(d.computation.issues.some(i => i.code === 'missing_exclusion_prepayments'));
  });
});
await test('read-only successful and blocked runs preserve full schema, every row and warm WAL file bytes', async () => {
  const held = new DatabaseSync(f.dbPath); held.exec('PRAGMA journal_mode=WAL'); held.prepare('SELECT COUNT(*) FROM vouchers').get();
  const files = [f.dbPath, f.dbPath + '-wal'].filter(existsSync), hashes = files.map(p => hash(readFileSync(p))), before = state(f);
  try { const results = await Promise.all([run(f.request), run(f.request)]); assert.ok(results.every(d => d.q2CalculationReady)); blocked(await run({ ...f.request, target: { ...f.request.target, enterpriseKey: 'OTHER' } })); assert.deepEqual(state(f), before); assert.deepEqual(files.map(p => hash(readFileSync(p))), hashes); } finally { held.close(); }
});
if(selectedCase){assert.equal(passed+failed,regressionNames.size,'all three explicitly registered regressions executed');console.log('OFFLINE_Q2_CASE '+selectedCase+' executed='+(passed+failed)+' skipped='+skipped);}
console.log(`offline-vat-q2 ${passed} passed ${failed} failed; all one-shot children exited`); process.exitCode = failed ? 1 : 0;
