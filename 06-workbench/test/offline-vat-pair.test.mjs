import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, copyFileSync, linkSync, unlinkSync, renameSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createPairFixture, readJson, writeJson } from './helpers/offline-vat-pair-fixture.mjs';
import { openOfflineVatPairContext as rawOpen, assertOfflineVatPairContextCurrent as current, closeOfflineVatPairContext as close } from '../server/offline-vat-pair-context.mjs';
import { openVatInputPairFiles, assertVatInputPairCurrent } from '../server/offline-vat-input.mjs';
import { openReadonlyLedgerSource, captureLedgerSnapshotPair, validateLedgerSnapshotPair } from '../server/offline-ledger-snapshot.mjs';
import { hash, stable } from '../server/offline-material-adapters.mjs';
import { initMaterialStore, receiveMaterials } from '../server/offline-material-store.mjs';
const wb = resolve('.'); mkdirSync(join(wb, '.agent-runs'), { recursive: true });
const root = mkdtempSync(join(wb, '.agent-runs', 'pair-synthetic-'));
let serial = 0, passed = 0, failed = 0; const receipts = new Set(), fixtures = new WeakSet();
const test = async (name, work) => { try { await work(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } };
const fixture = async options => { const f = await createPairFixture(join(root, String(++serial)), options); fixtures.add(f); return f; };
const open = async r => { const p = await rawOpen(fixtures.has(r) ? r.request : r); if (p.receipt) receipts.add(p.receipt); return p; };
const inspect = (f, work, readonly = false) => { const db = new DatabaseSync(f.dbPath, { readOnly: readonly }); try { return work(db); } finally { db.close(); } };
const state = f => inspect(f, db => db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(s => ({ ...s, rows: s.type === 'table' ? db.prepare('SELECT * FROM "' + s.name + '"').all() : [] })), true);
const flags = d => { for (const k of ['q2CalculationReady','periodComplete','submittable','authorizesExecution']) assert.equal(d[k], false); assert.equal(d.accountantApproval,'pending'); assert.equal(d.sourceAuthenticity,'unverified'); };
const row = (p,r) => p.cells.find(c=>c.row===r&&c.column==='services'&&c.period==='current');
function probe(f, code, deployment = wb) {
  const child = spawnSync(process.execPath, ['--input-type=module','-e', `import assert from 'node:assert/strict';import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const request=JSON.parse(process.argv[1]);const base=${JSON.stringify(pathToFileURL(deployment + '/').href)};${code}`, JSON.stringify(f.request)], { cwd: root, encoding: 'utf8', timeout: 45000, env: {...process.env,NODE_NO_WARNINGS:'1',WORKBENCH_DATA_DIR:join(root,'forbidden-default')} });
  assert.equal(child.status,0,child.stderr); assert.equal(child.signal,null); assert.equal(child.stderr,''); return child.stdout;
}
function copyCode() { const dest=join(root,'code-'+(++serial));mkdirSync(dest);cpSync(join(wb,'server'),join(dest,'server'),{recursive:true});mkdirSync(join(dest,'scripts'));copyFileSync(join(wb,'scripts/offline-vat-pair.mjs'),join(dest,'scripts/offline-vat-pair.mjs'));return dest; }
try {
  const f = await fixture();
  await test('actual two-quarter originals through public formal posting; real Q1 recompute and Q2 ledger held separately', async () => {
    const before = state(f), p = await open(f), d=p.diagnostic; assert.ok(p.receipt,JSON.stringify(d)); flags(d);
    assert.equal(d.status,'pair_bound_prior_q1_recomputed'); assert.equal(d.targetBinding,'same_held_readonly_source');
    assert.deepEqual([15,16,22].map(r=>row(d.priorComputation,r).value),['12215.73','8143.82','4071.91']);
    assert.equal(d.priorComputation.calculationReady,true); assert.deepEqual(d.priorComputation.issues,[]);
    assert.equal(d.binding.relationship,'same_held_readonly_source_same_capture');assert.equal(d.binding.accountSetId,f.id);assert.equal(d.binding.databaseInstanceId,f.instanceId);
    assert.equal(d.binding.prior.scope.period,'2026-Q1');assert.equal(d.binding.target.scope.period,'2026-Q2');assert.equal(d.codeBinding.files.length,32);
    assert.equal(d.targetDiagnostics.calculationImplemented,false);assert.equal(d.targetDiagnostics.reconciled.length,1);assert.equal(d.targetDiagnostics.reconciled[0].date,'2026-04-17');
    assert.deepEqual(d.targetDiagnostics.reconciled[0].entries.map(e=>[e.accountCode,e.debitMinor,e.creditMinor]),[['1122','61956127','0'],['5001','0','61342700'],['2221','0','613427']]);
    assert.deepEqual(d.targetDiagnostics.issues,[]);assert.deepEqual(d.targetDiagnostics.legacyHistoryIssues.map(i=>i.field),['opening','history']);assert.equal(d.targetDiagnostics.priorEvidenceProvided,true);assert.equal(d.targetDiagnostics.actualQ1Recomputed,true);assert.equal(d.targetDiagnostics.historyReadinessIntegration,'not_implemented');assert.ok(d.targetDiagnostics.legacyHistoryIssues.every(i=>i.audience==='operator_engineering'&&i.customerActionRequired===false));assert.ok(d.targetDiagnostics.engineeringIssues.every(i=>i.customerActionRequired===false));assert.equal(d.targetDiagnostics.history.priorVoucherIds.length,1);
    assert.deepEqual(await current(p.receipt),d);await close(p.receipt);assert.deepEqual(state(f),before);
    inspect(f,db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM voucher_entries').get().n,6);},true);
  });
  await test('private pair source/session proof cannot be copied or recombined from public snapshots', async()=>{
    const s=await openVatInputPairFiles(f.request);try{const original=await assertVatInputPairCurrent(s);assert.equal(original.proof.relationship,'same_held_readonly_source_same_capture');assert.throws(()=>validateLedgerSnapshotPair(s.source,structuredClone(s.snapshots)),e=>e.code==='ledger_pair_untrusted');await assert.rejects(()=>assertVatInputPairCurrent({...s}));}finally{s.close();}
    const source=openReadonlyLedgerSource(f.dbPath);try{assert.throws(()=>validateLedgerSnapshotPair(source,{prior:{},target:{}}),e=>e.code==='ledger_pair_untrusted');}finally{source.close();}
  });
  await test('strict descriptors including nested proxies hidden fields symbols and canonical integer targets',async()=>{
    let traps=0;const proxy=new Proxy({},{get(){traps++;},getPrototypeOf(){traps++;},ownKeys(){traps++;}});
    const bad=[proxy,{...f.request,target:proxy},{...f.request,priorInputPath:proxy},{...f.request,target:{...f.request.target,accountSetId:'1'}},{...f.request,target:{...f.request.target,accountSetId:1.1}},{...f.request,priorInputPath:'relative.json'},{...f.request,snapshot:{calculationReady:true}}];
    for(const mutate of [r=>Object.defineProperty(r,'hidden',{value:1}),r=>Object.defineProperty(r.target,'hidden',{value:1}),r=>{r[Symbol('authority')]=true;},r=>Object.defineProperty(r.target,'dbPath',{enumerable:true,get(){traps++;return f.dbPath;}})]){const r=structuredClone(f.request);mutate(r);bad.push(r);}
    for(const r of bad){const p=await open(r);assert.equal(p.receipt,null);assert.equal(p.diagnostic.code,'pair_request_invalid');}assert.equal(traps,0);
  });
  await test('opaque receipt JSON and foreign-context diagnostics carry no authority; close waits for child',async()=>{
    const p=await open(f), original=structuredClone(p.diagnostic);p.diagnostic.priorComputation.cells.length=0;p.diagnostic.authorizesExecution=true;
    assert.deepEqual(await current(p.receipt),original);assert.equal(Object.getPrototypeOf(p.receipt),null);assert.equal(Object.isFrozen(p.receipt),true);
    for(const fake of [{},null,structuredClone(p.receipt),JSON.parse(JSON.stringify(p.receipt)),p.diagnostic])assert.equal((await current(fake)).code,'pair_receipt_untrusted');
    await close(p.receipt);assert.equal((await current(p.receipt)).code,'pair_receipt_closed');
  });
  await test('independent second amounts are read from originals rather than cached expected values',async()=>{
    const other=await fixture({priorAmount:'467833.00',targetAmount:'728351.00'}),p=await open(other);assert.ok(p.receipt);assert.equal(row(p.diagnostic.priorComputation,22).value,'4678.33');assert.equal(p.diagnostic.targetDiagnostics.reconciled[0].entries[1].creditMinor,'72835100');await close(p.receipt);
  });
  await test('same-instance clone used by only one input, wrong enterprise/account set/instance/profile/quarter and 01 alias rejected',async()=>{
    const clone=join(root,'clone.db');copyFileSync(f.dbPath,clone);
    for(const mutate of [r=>{r.target.dbPath=clone;},r=>{r.target.enterpriseKey='OTHER';},r=>{r.target.accountSetId=999;},r=>{r.target.databaseInstanceId='00000000-0000-4000-8000-000000000000';}]){const r=structuredClone(f.request);mutate(r);assert.equal((await open(r)).receipt,null);}
    for(const [path,mutate,code] of [[f.targetInputPath,c=>{c.db=clone;},'pair_target_mismatch'],[f.targetInputPath,c=>{c.profileId='cas-2006-basic-v1';},'pair_profile_mismatch'],[f.priorInputPath,c=>{c.scope.accountSetId='01';},'pair_account_set_invalid'],[f.targetInputPath,c=>{c.scope.period='2026-Q1';},'pair_quarter_mismatch']]){const old=readFileSync(path);const c=readJson(path);mutate(c);writeJson(path,c);try{const p=await open(f);assert.equal(p.receipt,null);assert.equal(p.diagnostic.code,code);}finally{writeFileSync(path,old);}}
  });
  await test('actual hardlink alias rejected and original becomes usable after unlink',async()=>{
    const linked=join(root,'hardlink.db');linkSync(f.dbPath,linked);try{const p=await open(f);assert.equal(p.receipt,null);assert.equal(p.diagnostic.code,'pair_ledger_invalid');}finally{unlinkSync(linked);}const p=await open(f);assert.ok(p.receipt);await close(p.receipt);
  });
  await test('both periods raw basis amount and date observation permanently retires even after byte restoration',async()=>{
    for(const dir of [f.dir,f.targetDir])for(const [name,mutate]of [['business.json',b=>b.replace('completed','partial')],['sales.csv',b=>b.replace('407191.00','407192.00').replace('613427.00','613428.00')],['sales.csv',b=>b.replace('2026-01-13','2026-01-14').replace('2026-04-17','2026-04-18')],['accounting.json',b=>b.replace('合成合同','新证据合成合同')],['tax.json',b=>b.replace('登记','新登记')],['declaration.json',b=>b.replace('合成企业','新合成企业')]]){const path=join(dir,name),old=readFileSync(path),p=await open(f);assert.ok(p.receipt);writeFileSync(path,mutate(old.toString()));assert.equal((await current(p.receipt)).code,'pair_context_stale');writeFileSync(path,old);assert.equal((await current(p.receipt)).code,'pair_context_stale');}
  });
  await test('both-quarter ledger changes permanently retire while read-only failures do not add audit/batch writes',async()=>{
    for(const quarter of ['2026-01','2026-04']){const p=await open(f);inspect(f,db=>db.prepare("UPDATE voucher_entries SET summary=summary||'CHANGED' WHERE voucher_id=(SELECT id FROM vouchers WHERE period=?)").run(quarter));const before=state(f);assert.equal((await current(p.receipt)).code,'pair_context_stale');assert.deepEqual(state(f),before);inspect(f,db=>db.prepare("UPDATE voucher_entries SET summary=replace(summary,'CHANGED','') WHERE voucher_id=(SELECT id FROM vouchers WHERE period=?)").run(quarter));assert.equal((await current(p.receipt)).code,'pair_context_stale');}
  });
  await test('target unknown ledger, bad money, unsupported kind and missing source stay explicit separate diagnostics',async()=>{
    const modifications=[ ["UPDATE vouchers SET status='unexpected' WHERE period='2026-04'","UPDATE vouchers SET status='posted' WHERE period='2026-04'",'ledger_unknown_status'],["UPDATE voucher_entries SET credit=6134.271 WHERE code='2221' AND voucher_id=(SELECT id FROM vouchers WHERE period='2026-04')","UPDATE voucher_entries SET credit=6134.27 WHERE code='2221' AND voucher_id=(SELECT id FROM vouchers WHERE period='2026-04')",'ledger_stored_money_invalid'],["UPDATE vouchers SET kind='unknown' WHERE period='2026-04'","UPDATE vouchers SET kind='normal' WHERE period='2026-04'",'ledger_voucher_kind_unsupported'],["UPDATE import_voucher_sources SET source_system='unknown' WHERE voucher_id=(SELECT id FROM vouchers WHERE period='2026-04')","UPDATE import_voucher_sources SET source_system='offline-bookkeeping-candidates-v1' WHERE voucher_id=(SELECT id FROM vouchers WHERE period='2026-04')",'candidate_posted_source_missing_or_ambiguous'] ];
    for(const [change,restore,code]of modifications){inspect(f,db=>db.exec(change));try{const p=await open(f);assert.ok(p.receipt,JSON.stringify(p.diagnostic));assert.equal(p.diagnostic.targetBinding,'same_held_readonly_source');assert.ok(p.diagnostic.targetDiagnostics.issues.some(i=>i.code===code));flags(p.diagnostic);await close(p.receipt);}finally{inspect(f,db=>db.exec(restore));}}
    const path=join(f.targetDir,'sales.csv');renameSync(path,path+'.held');try{const p=await open(f);assert.equal(p.receipt,null);assert.equal(p.diagnostic.code,'pair_input_rejected');}finally{renameSync(path+'.held',path);}
  });
  await test('Q1 historical/unknown guard remains effective rather than replaced with a ready flag',async()=>{
    const path=join(f.dir,'tax.json'),old=readFileSync(path),tax=readJson(path);tax.period.exclusions[0].state='unknown';writeJson(path,tax);try{const p=await open(f);assert.equal(p.receipt,null);assert.equal(p.diagnostic.code,'pair_calculation_blocked');assert.equal(p.diagnostic.priorComputation.calculationReady,false);assert.equal(p.diagnostic.targetDiagnostics.priorEvidenceProvided,false);assert.equal(p.diagnostic.targetDiagnostics.actualQ1Recomputed,false);}finally{writeFileSync(path,old);}
  });
  await test('non-January establishment rejected despite actual v1-ready February sales',async()=>{
    const later=await fixture({priorDate:'2026-02-13',establishedOn:'2026-02-01'}),p=await open(later);
    assert.equal(p.receipt,null);assert.equal(p.diagnostic.code,'pair_january_establishment_required');assert.equal(p.diagnostic.priorComputation.calculationReady,true);
    assert.equal(p.diagnostic.priorComputation.taxFactsEvidence.enterprise.establishedOn,'2026-02-01');assert.equal(p.diagnostic.targetDiagnostics.priorEvidenceProvided,false);assert.equal(p.diagnostic.targetDiagnostics.actualQ1Recomputed,false);
  });
  await test('cross-quarter known enterprise facts conflict while Q2 unknown stays unknown; physical binding and zero writes remain',async()=>{
    const path=join(f.targetDir,'tax.json'),old=readFileSync(path);
    for(const [field,value,code,classification]of [
      ['establishedOn','2026-02-01','cross_quarter_establishment_date_conflict','conflict'],
      ['form','individual_business','cross_quarter_enterprise_form_conflict','conflict'],
      ['establishedOn',null,'tax_establishment_unknown','unknown'],
      ['form','unknown','tax_enterprise_form_unknown','unknown'],
    ]){
      const doc=JSON.parse(old.toString());doc.enterprise[field]=value;writeJson(path,doc);const before=state(f);
      try{
        const p=await open(f);assert.ok(p.receipt,JSON.stringify(p.diagnostic));assert.equal(p.diagnostic.status,'pair_bound_prior_q1_recomputed');assert.equal(p.diagnostic.targetBinding,'same_held_readonly_source');flags(p.diagnostic);
        assert.equal(p.diagnostic.priorComputation.taxFactsEvidence.enterprise.establishedOn,'2026-01-01');assert.equal(p.diagnostic.priorComputation.taxFactsEvidence.enterprise.form,'enterprise');
        assert.equal(p.diagnostic.targetDiagnostics.priorEvidenceProvided,true);assert.equal(p.diagnostic.targetDiagnostics.actualQ1Recomputed,true);
        const issue=p.diagnostic.targetDiagnostics.issues.find(i=>i.code===code);assert.ok(issue);assert.equal(issue.field,'taxFacts.enterprise.'+field);assert.equal(issue.classification,classification);
        if(classification==='unknown')assert.ok(!p.diagnostic.targetDiagnostics.issues.some(i=>i.code.startsWith('cross_quarter_')));
        assert.deepEqual(await current(p.receipt),p.diagnostic);await close(p.receipt);assert.deepEqual(state(f),before);
      }finally{writeFileSync(path,old);}
    }
  });
  await test('material receipt-store input holds actual source versions and lock is distinguished',async()=>{
    const store=join(root,'material-store'),m=readJson(join(f.targetDir,'materials.json'));await initMaterialStore(store,m.scope);await receiveMaterials(store,join(f.targetDir,'materials.json'));
    const path=f.targetInputPath,old=readFileSync(path),c=readJson(path);delete c.materialsInput;c.materialStore=store;writeJson(path,c);
    try{const p=await open(f);assert.ok(p.receipt,JSON.stringify(p.diagnostic));await close(p.receipt);writeFileSync(join(store,'lock.json'),'held');try{const x=await open(f);assert.equal(x.receipt,null);assert.equal(x.diagnostic.code,'pair_material_store_not_current');}finally{unlinkSync(join(store,'lock.json'));}}finally{writeFileSync(path,old);}
  });
  await test('parent cached tax and default DB cannot contaminate fresh worker real amounts',()=>{
    probe(f,`const cached=await import(new URL('server/tax-calculation.mjs',base));const api=await import(new URL('server/offline-vat-pair-context.mjs',base));const p=await api.openOfflineVatPairContext(request);try{assert.ok(p.receipt);assert.equal(p.diagnostic.priorComputation.cells.find(c=>c.row===22&&c.column==='services'&&c.period==='current').value,'4071.91');assert.equal(fs.existsSync(process.env.WORKBENCH_DATA_DIR),false);}finally{await api.closeOfflineVatPairContext(p.receipt);}`);
  });
  await test('a parent cached default DB containing zero vouchers does not become the worker target',()=>{
    probe(f,`const old=process.env.WORKBENCH_DATA_DIR;const {db}=await import(new URL('server/db.mjs',base));try{assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,0);const api=await import(new URL('server/offline-vat-pair-context.mjs',base));const p=await api.openOfflineVatPairContext(request);assert.ok(p.receipt);try{assert.equal(p.diagnostic.priorComputation.cells.find(c=>c.row===22&&c.column==='services'&&c.period==='current').value,'4071.91');assert.equal(p.diagnostic.targetDiagnostics.reconciled.length,1);}finally{await api.closeOfflineVatPairContext(p.receipt);}}finally{db.close();}`);
  });
  await test('parent pre-cached function cannot execute stale tax bytes under a new disk manifest',()=>{
    const dest=copyCode();probe(f,`const file=new URL('server/tax-calculation.mjs',base);await import(file);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('export function calculateOfflineVat(input, source, snapshot) {',"export function calculateOfflineVat(input, source, snapshot) { throw new Error('ACTUAL_CHILD_SENTINEL');"));const api=await import(new URL('server/offline-vat-pair-context.mjs',base));const p=await api.openOfflineVatPairContext(request);assert.equal(p.receipt,null);assert.equal(p.diagnostic.code,'pair_input_rejected');`,dest);
  });
  await test('an unresponsive actual worker times out, retires and is killed before close returns',()=>{
    const dest=copyCode(),file=join(dest,'server/offline-vat-pair-worker.mjs');writeFileSync(file,readFileSync(file,'utf8').replace('const result = await recompute(), prior = result.priorComputation;',"if(message.command==='current')await new Promise(()=>{});const result = await recompute(), prior = result.priorComputation;"));
    probe(f,`let child;const original=cp.spawn;cp.spawn=(...a)=>(child=original(...a));syncBuiltinESMExports();const api=await import(new URL('server/offline-vat-pair-context.mjs',base));const p=await api.openOfflineVatPairContext(request);assert.ok(p.receipt);const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===30000?30:ms,...args);try{assert.equal((await api.assertOfflineVatPairContextCurrent(p.receipt)).code,'pair_worker_timeout');assert.equal((await api.assertOfflineVatPairContextCurrent(p.receipt)).code,'pair_worker_timeout');}finally{globalThis.setTimeout=timer;await api.closeOfflineVatPairContext(p.receipt);}assert.ok(child.exitCode!==null||child.signalCode!==null);`,dest);
  });
  await test('spawn ENOENT settles on actual close without an exit event',()=>{
    probe(f,`const original=cp.spawn;cp.spawn=(exe,args,opts)=>original(new URL('absent-node.exe',base).pathname,args,opts);syncBuiltinESMExports();const api=await import(new URL('server/offline-vat-pair-context.mjs',base));const p=await api.openOfflineVatPairContext(request);assert.equal(p.receipt,null);assert.equal(p.diagnostic.code,'pair_worker_unavailable');`);
  });
  await test('worker termination/disconnect never leave receipts usable or child alive after close',()=>{
    for(const action of ['kill','disconnect'])probe(f,`let child;const original=cp.spawn;cp.spawn=(...a)=>{child=original(...a);return child;};syncBuiltinESMExports();const api=await import(new URL('server/offline-vat-pair-context.mjs',base));const p=await api.openOfflineVatPairContext(request);assert.ok(p.receipt);const exit=new Promise(ok=>child.once('exit',ok));${action==='kill'?"child.kill('SIGKILL');await exit;":"child.disconnect();"}const d=await api.assertOfflineVatPairContextCurrent(p.receipt);assert.equal(d.status,'stale');await api.closeOfflineVatPairContext(p.receipt);assert.ok(child.exitCode!==null||child.signalCode!==null);`);
  });
  await test('observed rule provider worker/context/CLI code bytes retire permanently; restored bytes require fresh process',()=>{
    for(const name of ['tax-rule-registry.mjs','offline-vat-input.mjs','offline-ledger-snapshot.mjs','offline-vat-pair-worker.mjs','offline-vat-pair-context.mjs','../scripts/offline-vat-pair.mjs']){const dest=copyCode();probe(f,`const api=await import(new URL('server/offline-vat-pair-context.mjs',base));const p=await api.openOfflineVatPairContext(request);assert.ok(p.receipt);const file=new URL(${JSON.stringify('server/'+name)},base),old=fs.readFileSync(file);fs.appendFileSync(file,'\\n// observed change\\n');assert.equal((await api.assertOfflineVatPairContextCurrent(p.receipt)).code,'pair_code_restart_required');fs.writeFileSync(file,old);assert.equal((await api.assertOfflineVatPairContextCurrent(p.receipt)).code,'pair_code_restart_required');assert.equal((await api.openOfflineVatPairContext(request)).diagnostic.code,'pair_code_restart_required');await api.closeOfflineVatPairContext(p.receipt);`,dest);}
  });
  await test('worker-observed code change latches parent retirement even when restored before reply handling',()=>{
    const dest=copyCode();probe(f,`const original=cp.spawn;let observed=false;const file=new URL('server/tax-calculation.mjs',base),old=fs.readFileSync(file);cp.spawn=(...args)=>{const child=original(...args),send=child.send.bind(child);child.send=(m,...rest)=>{if(m.command==='current')fs.appendFileSync(file,'\\n// observed worker ABA\\n');return send(m,...rest);};child.on('message',m=>{if(m.reply?.code==='pair_code_restart_required'){observed=true;fs.writeFileSync(file,old);}});return child;};syncBuiltinESMExports();const api=await import(new URL('server/offline-vat-pair-context.mjs',base));const p=await api.openOfflineVatPairContext(request);assert.ok(p.receipt);assert.equal((await api.assertOfflineVatPairContextCurrent(p.receipt)).code,'pair_code_restart_required');assert.equal(observed,true);assert.equal((await api.openOfflineVatPairContext(request)).diagnostic.code,'pair_code_restart_required');await api.closeOfflineVatPairContext(p.receipt);`,dest);
  });
  await test('pre-spawn code replaced before child loads application is rejected; application sentinel never executes',()=>{
    const dest=copyCode(),marker=join(dest,'application-loaded.txt');
    const sentinel="\n(await import('node:fs')).writeFileSync("+JSON.stringify(marker)+",'BAD');\n";
    probe(f,`const original=cp.spawn;let saved,file;cp.spawn=(...a)=>{file=new URL('server/offline-vat-input.mjs',base);saved=fs.readFileSync(file);fs.writeFileSync(file,Buffer.concat([saved,Buffer.from(${JSON.stringify(sentinel)})]));return original(...a);};syncBuiltinESMExports();const api=await import(new URL('server/offline-vat-pair-context.mjs',base));try{const p=await api.openOfflineVatPairContext(request);assert.equal(p.receipt,null);assert.equal(p.diagnostic.code,'pair_code_restart_required');assert.equal(fs.existsSync(${JSON.stringify(marker)}),false);}finally{fs.writeFileSync(file,saved);}`,dest);
  });
  await test('CLI relative request resolution, wx output and fixed safe stdout',()=>{
    const request=join(root,'cli-request.json');writeJson(request,{...f.request,priorInputPath:join('1','case-1','input.json'),targetInputPath:join('1','q2','input.json')});const out=join(root,'pair-output.json');
    const run=()=>spawnSync(process.execPath,[join(wb,'scripts/offline-vat-pair.mjs'),'--input',request,'--output',out],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'},cwd:root});
    const p=run();assert.equal(p.status,0,p.stderr+p.stdout);assert.equal(p.stderr,'');assert.match(p.stdout,/^OFFLINE_VAT_PAIR_WRITTEN status=pair_bound_prior_q1_recomputed issues=0\r?\n$/);flags(readJson(out));assert.equal(run().status,4);
  });
  await test('CLI post-write and sync rechecks request and both original periods and invalidates failed publication',()=>{
    for(const path of [f.requestPath,join(f.dir,'sales.csv'),join(f.targetDir,'sales.csv')]){
      const old=readFileSync(path),out=join(root,'publication-'+(++serial)+'.json');
      try{probe(f,`const original=fs.promises.open;fs.promises.open=async(...args)=>{const h=await original(...args);if(args[1]==='wx'){const write=h.writeFile.bind(h);h.writeFile=async(...a)=>{const r=await write(...a);fs.appendFileSync(${JSON.stringify(path)},'\\n');return r;};}return h;};syncBuiltinESMExports();const {runCli}=await import(new URL('scripts/offline-vat-pair.mjs',base));const r=await runCli(['--input',${JSON.stringify(f.requestPath)},'--output',${JSON.stringify(out)}]);assert.equal(r.exitCode,4);const p=JSON.parse(fs.readFileSync(${JSON.stringify(out)},'utf8'));assert.equal(p.publicationStatus,'failed');assert.equal(p.targetBinding,'not_verified');assert.equal(p.authorizesExecution,false);`);}finally{writeFileSync(path,old);}
    }
  });
  await test('read-only open/current/close including warm WAL preserve whole schema/all rows and file bytes',async()=>{
    const held=new DatabaseSync(f.dbPath);held.exec('PRAGMA journal_mode=WAL');held.prepare('SELECT COUNT(*) FROM vouchers').get();const files=[f.dbPath,f.dbPath+'-wal'].filter(existsSync),before=files.map(p=>hash(readFileSync(p))),rows=state(f);
    try{const p=await open(f);assert.ok(p.receipt);const checks=await Promise.all([current(p.receipt),current(p.receipt),current(p.receipt)]);assert.ok(checks.every(d=>d.status==='pair_bound_prior_q1_recomputed'));await close(p.receipt);assert.deepEqual(files.map(p=>hash(readFileSync(p))),before);assert.deepEqual(state(f),rows);}finally{held.close();}
  });
} finally { for(const receipt of receipts)await close(receipt); }
console.log(`offline-vat-pair ${passed} passed ${failed} failed; all contexts closed`);process.exitCode=failed?1:0;
