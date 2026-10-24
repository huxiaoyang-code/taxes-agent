import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, renameSync, cpSync, linkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { runOfflinePosting, validatePostingRequest, capturePostingCode } from '../server/offline-posting.mjs';
import { createPostingFixture, postingRequest, executionRequest, readJson, writeJson } from './helpers/offline-posting-fixture.mjs';
import { initMaterialStore, receiveMaterials } from '../server/offline-material-store.mjs';
import ExcelJS from 'exceljs';
const home = resolve('.agent-runs'); mkdirSync(home, { recursive: true });
const root = mkdtempSync(join(home, 'offline-posting-'));
let count = 0, failed = false;
const test = async (name, work) => { try { await work(); count++; process.stdout.write(`PASS ${name}\n`); } catch (e) { failed = true; throw e; } };
const inspect = (f, work) => { const db = new DatabaseSync(f.dbPath); try { return work(db); } finally { db.close(); } };
let f, request, prepared;
try {
  f = createPostingFixture(join(root, 'main')); request = await postingRequest(f); prepared = runOfflinePosting(request);
  await test('actual raw files prepare explicit existing target', () => { assert.equal(prepared.status, 'prepared', JSON.stringify(prepared)); assert.equal(prepared.branches.length, 3); assert.equal(prepared.requiresNewSourceConfirmation, true); assert.equal(prepared.periodComplete, false); });
  await test('strict descriptor validation without proxy/getter traps', () => {
    let traps = 0; const proxy = new Proxy({}, { get() { traps++; }, ownKeys() { traps++; }, getPrototypeOf() { traps++; } });
    for (const bad of [proxy, { ...request, target: proxy }, { ...request, selected: proxy }, { ...request, command: 'execute', confirmation: proxy }]) assert.throws(() => validatePostingRequest(bad));
    for (const mutate of [r => Object.defineProperty(r, 'hidden', { value: 1 }), r => { r[Symbol('x')] = 1; }, r => Object.defineProperty(r, 'inputPath', { get() { traps++; return 'x'; }, enumerable: true }), r => Object.defineProperty(r.target, 'hidden', { value: 1 })]) { const r = structuredClone(request); mutate(r); assert.throws(() => validatePostingRequest(r)); }
    const bad = executionRequest(request, prepared); bad.confirmation.dependencyDigest = proxy; assert.throws(() => validatePostingRequest(bad)); assert.equal(traps, 0);
  });
  await test('query genuinely readonly and missing DB never created', () => {
    const before = readFileSync(f.dbPath); assert.equal(runOfflinePosting({ ...request, command: 'query' }).status, 'not_applied'); assert.deepEqual(readFileSync(f.dbPath), before);
    const missing = join(root, 'missing', 'workbench.db'); assert.equal(runOfflinePosting({ ...request, target: { ...request.target, dbPath: missing } }).applied, false); assert.equal(existsSync(missing), false);
  });
  await test('actual hardlink database alias is refused', () => { const alias=join(root,'alias');mkdirSync(alias);const linked=join(alias,'workbench.db');linkSync(f.dbPath,linked);try { const x=runOfflinePosting({...request,target:{...request.target,dbPath:linked}});assert.equal(x.code,'posting_db_invalid');assert.equal(x.applied,false); } finally { unlinkSync(linked); } });
  await test('first source evidence requires explicit same enterprise confirmation', () => { assert.equal(runOfflinePosting(executionRequest(request, prepared, false)).code, 'posting_new_source_confirmation_required'); });
  await test('real sales append returns public business value and durable proof', () => {
    const result = runOfflinePosting(executionRequest(request, prepared)); assert.equal(result.status, 'applied', JSON.stringify(result)); assert.equal(result.value.status, 'applied'); assert.equal(result.value.ok, true); assert.equal(result.batchEvidence.voucherCount, 1);
    inspect(f, db => { const rows = db.prepare('SELECT code,debit,credit FROM voucher_entries').all(); assert.deepEqual(rows.map(e => [e.code, e.debit, e.credit]), [['1122',900.28,0],['5001',0,891.37],['2221',0,8.91]]); const op = db.prepare('SELECT * FROM audit_operations WHERE operation_id=?').get(prepared.operationId); assert.equal(op.state, 'succeeded'); assert.equal(op.actor, 'cli'); });
  });
  await test('restart query and execute recover without another audit or voucher', () => {
    const before = inspect(f, db => [db.prepare('SELECT COUNT(*) n FROM vouchers').get().n, db.prepare('SELECT COUNT(*) n FROM audit_events').get().n]);
    for (const r of [{ ...request, command: 'query' }, executionRequest(request, prepared, false)]) { const x = runOfflinePosting(r); assert.equal(x.status, 'recovered', JSON.stringify(x)); assert.equal(x.evidence.originalResponseReplayed, false); assert.equal('value' in x, false); }
    assert.deepEqual(inspect(f, db => [db.prepare('SELECT COUNT(*) n FROM vouchers').get().n, db.prepare('SELECT COUNT(*) n FROM audit_events').get().n]), before);
  });
  await test('other two candidate types actually posted with independent amounts/date', async () => {
    for (const kind of ['administrative_service','service_prepayment']) { const r = await postingRequest(f, kind), p = runOfflinePosting(r); assert.equal(p.status, 'prepared', JSON.stringify(p)); const result = runOfflinePosting(executionRequest(r,p,false)); assert.equal(result.status, 'applied', JSON.stringify(result)); }
    inspect(f, db => { assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,3); const rows = db.prepare('SELECT v.voucher_date,e.code,e.debit,e.credit FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE e.code IN (\'5602\',\'1123\') ORDER BY e.code').all(); assert.deepEqual(rows.map(e => [e.voucher_date,e.code,e.debit,e.credit]), [['2026-03-27','1123',153.29,0],['2026-03-19','5602',279.68,0]]); });
  });
  await test('facts reorder keeps task binding and dedup stable', () => { const path=join(f.dir,'accounting.json'), doc=readJson(path); doc.facts.reverse(); writeJson(path,doc); const x=runOfflinePosting({...request,command:'query'}); assert.equal(x.status,'recovered',JSON.stringify(x)); assert.equal(x.operationId,prepared.operationId); });
  await test('same identity amount correction conflicts without new operation', () => { const path=join(f.dir,'sales.csv'), old=readFileSync(path,'utf8'); writeFileSync(path,old.replace('891.37,8.91,900.28','892.37,8.92,901.29')); const x=runOfflinePosting({...request,command:'query'}); assert.equal(x.code,'posting_semantic_conflict',JSON.stringify(x)); assert.equal(x.operationId,prepared.operationId); writeFileSync(path,old); });
  await test('fact basis only change conflicts at stable identity', () => { const path=join(f.dir,'accounting.json'), doc=readJson(path), old=JSON.stringify(doc); doc.facts.find(x=>x.kind==='service_sale').basis+='新增合同事实'; writeJson(path,doc); const x=runOfflinePosting({...request,command:'query'}); assert.equal(x.code,'posting_semantic_conflict',JSON.stringify(x)); assert.equal(x.operationId,prepared.operationId); writeFileSync(path,old); });
  await test('missing committed original preserves applied fact and stable ID', () => { const p=join(f.dir,'sales.csv'); renameSync(p,p+'.saved'); try { const x=runOfflinePosting({...request,command:'query'}); assert.equal(x.status,'needs_local_review',JSON.stringify(x)); assert.equal(x.applied,true); assert.equal(x.operationId,prepared.operationId); } finally { renameSync(p+'.saved',p); } assert.equal(runOfflinePosting({...request,command:'query'}).status,'recovered'); });
  await test('current posted/source fingerprint must still match', () => { inspect(f,db=>db.exec("UPDATE vouchers SET status='draft' WHERE id=(SELECT voucher_id FROM import_voucher_sources WHERE source_voucher_id='"+request.selected.businessKey+"')")); const x=runOfflinePosting({...request,command:'query'}); assert.equal(x.code,'posting_ledger_evidence_inconsistent'); assert.equal(x.applied,'unknown'); inspect(f,db=>db.exec("UPDATE vouchers SET status='posted'")); });
  await test('fresh current-policy postings require actual normal voucher classification to recover', async () => {
    const classified = createPostingFixture(join(root, 'classification'));
    for (const candidateKind of ['service_sale', 'administrative_service', 'service_prepayment']) {
      const r = await postingRequest(classified, candidateKind), p = runOfflinePosting(r);
      assert.equal(p.status, 'prepared', JSON.stringify(p));
      const posted = runOfflinePosting(executionRequest(r, p)); assert.equal(posted.status, 'applied', JSON.stringify(posted));
      const id = posted.evidence.voucherId;
      const before = inspect(classified, db => [db.prepare('SELECT COUNT(*) n FROM vouchers').get().n, db.prepare('SELECT COUNT(*) n FROM audit_events').get().n]);
      assert.equal(inspect(classified, db => db.prepare('SELECT kind FROM vouchers WHERE id=?').get(id).kind), 'normal');
      for (const corruptKind of ['carryforward', 'depreciation', 'unknown']) {
        inspect(classified, db => db.prepare('UPDATE vouchers SET kind=? WHERE id=?').run(corruptKind, id));
        try {
          for (const retry of [{ ...r, command: 'query' }, executionRequest(r, p, false)]) {
            const result = runOfflinePosting(retry);
            assert.equal(result.status, 'needs_local_review', JSON.stringify(result));
            assert.equal(result.code, 'posting_stored_entries_inconsistent', JSON.stringify(result));
            assert.equal(result.applied, 'unknown'); assert.equal(result.operationId, p.operationId);
            assert.equal(result.dependencyDigest, p.dependencyDigest); assert.equal(result.policyDigest, p.policyDigest);
          }
        } finally { inspect(classified, db => db.prepare("UPDATE vouchers SET kind='normal' WHERE id=?").run(id)); }
        const restored = runOfflinePosting({ ...r, command: 'query' });
        assert.equal(restored.status, 'recovered', JSON.stringify(restored)); assert.equal(restored.evidence.voucherId, id);
      }
      assert.deepEqual(inspect(classified, db => [db.prepare('SELECT COUNT(*) n FROM vouchers').get().n, db.prepare('SELECT COUNT(*) n FROM audit_events').get().n]), before);
    }
  });
  await test('persisted subcent/nonfinite/negative amounts cannot recover through rounded fingerprint', () => {
    const entry=inspect(f,db=>db.prepare("SELECT e.id,e.debit FROM voucher_entries e JOIN vouchers v ON e.voucher_id=v.id JOIN import_voucher_sources s ON s.voucher_id=v.id WHERE s.source_voucher_id=? AND e.code='1122'").get(request.selected.businessKey));
    for(const amount of [900.281,Infinity,-0.001]) { inspect(f,db=>db.prepare('UPDATE voucher_entries SET debit=? WHERE id=?').run(amount,entry.id));const x=runOfflinePosting({...request,command:'query'});assert.equal(x.code,'posting_stored_entries_inconsistent',JSON.stringify(x));assert.equal(x.applied,'unknown');inspect(f,db=>db.prepare('UPDATE voucher_entries SET debit=? WHERE id=?').run(entry.debit,entry.id)); }
    assert.equal(runOfflinePosting({...request,command:'query'}).status,'recovered');
  });
  await test('local receipt maps every actual entry to raw field and rule evidence', () => { const x=runOfflinePosting({...request,command:'query'});assert.equal(x.scope.accountSetId,String(f.id));assert.equal(x.target.databaseInstanceId,f.instanceId);assert.ok(x.inputEvidence.files.some(e=>e.path.endsWith('sales.csv')&&/^[a-f0-9]{64}$/.test(e.fileSha256)));for(const e of x.evidence.entries){assert.ok(e.entryId>0);assert.equal(e.lineNo,e.candidateEntryIndex+1);const line=x.candidate.entries[e.candidateEntryIndex];assert.equal(e.accountCode,line.accountCode);assert.ok(line.sourceFields.every(s=>s.fileSha256&&s.location));assert.ok(line.factSources.length>0);assert.ok(line.ruleSources.every(s=>s.url&&s.locator));} });
  await test('unavailable audit never misreports committed business as unapplied', () => { const sql=inspect(f,db=>db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='audit_events_no_update'").get().sql);inspect(f,db=>db.exec('DROP TRIGGER audit_events_no_update'));try { const x=runOfflinePosting({...request,command:'query'});assert.equal(x.status,'needs_local_review');assert.equal(x.applied,'unknown');assert.equal(x.operationId,prepared.operationId); } finally { inspect(f,db=>db.exec(sql)); }assert.equal(runOfflinePosting({...request,command:'query'}).status,'recovered'); });
  await test('wrong instance/enterprise and numeric string target are refused', () => { for(const target of [{...request.target,databaseInstanceId:'wrong-instance'},{...request.target,enterpriseKey:'OTHER-ENTERPRISE'}]) assert.equal(runOfflinePosting({...request,target}).applied,false); assert.throws(()=>runOfflinePosting({...request,target:{...request.target,accountSetId:'1'}})); });
  await test('scope account-set alias is rejected without loose Number coercion', () => { const doc=readJson(f.inputPath), old=JSON.stringify(doc); doc.scope.accountSetId='01'; writeJson(f.inputPath,doc); const x=runOfflinePosting({...request,command:'query'}); assert.equal(x.applied,true); assert.equal(x.code,'posting_current_inputs_unverified'); writeFileSync(f.inputPath,old); });
  const guarded=createPostingFixture(join(root,'guarded')), gr=await postingRequest(guarded), gp=runOfflinePosting(gr);
  await test('actual canonical binding cannot be guessed or changed by confirmation', () => { inspect(guarded,db=>db.prepare('UPDATE import_enterprise_account_sets SET enterprise_key=? WHERE account_set_id=?').run('SYN-OTHER-OWNER',guarded.id));try { assert.equal(runOfflinePosting(executionRequest(gr,gp)).code,'posting_enterprise_binding_mismatch');inspect(guarded,db=>assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,0)); } finally { inspect(guarded,db=>db.prepare('UPDATE import_enterprise_account_sets SET enterprise_key=? WHERE account_set_id=?').run(guarded.key,guarded.id)); } });
  await test('existing source without matching bridge operation stops instead of changing namespace', async () => { const unpaired=createPostingFixture(join(root,'unpaired')),r=await postingRequest(unpaired);inspect(unpaired,db=>db.prepare("INSERT INTO import_voucher_sources(source_system,enterprise_key,source_voucher_id,account_set_id,voucher_id,content_fingerprint,batch_id,created_at,voucher_fingerprint) VALUES('offline-bookkeeping-candidates-v1',?,?,?,999999,'synthetic','other-batch','2026-01-01T00:00:00.000Z','synthetic')").run(unpaired.key,r.selected.businessKey,unpaired.id));const x=runOfflinePosting(r);assert.equal(x.code,'posting_unmatched_existing_source_or_batch');assert.equal(x.applied,'unknown');inspect(unpaired,db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_operations WHERE action='import.append'").get().n,0);}); });
  await test('nonleaf/descendant and semantic 2221 chart changes block', () => {
    for(const [sql,restore,code] of [["UPDATE accounts SET is_leaf=0 WHERE code='2221'","UPDATE accounts SET is_leaf=1 WHERE code='2221'",'posting_account_not_leaf'],["INSERT INTO accounts(account_set_id,code,name,category,direction,contra,is_leaf) VALUES(1,'222101','合成VAT','负债','credit',0,1)","DELETE FROM accounts WHERE code='222101'",'posting_account_not_leaf'],["UPDATE accounts SET name='其他税' WHERE code='2221'","UPDATE accounts SET name='应交税费' WHERE code='2221'",'posting_account_semantics_unsupported']]) { inspect(guarded,db=>db.exec(sql)); assert.equal(runOfflinePosting(gr).code,code); inspect(guarded,db=>db.exec(restore)); }
  });
  await test('unresolved auxiliary dimensions and wrong profile block', () => {
    inspect(guarded,db=>db.exec('CREATE TABLE aux_requirements(account_set_id INTEGER,code TEXT,project INTEGER,department INTEGER,party INTEGER); INSERT INTO aux_requirements VALUES(1,\'2221\',0,0,1)')); assert.equal(runOfflinePosting(gr).code,'posting_aux_required'); inspect(guarded,db=>db.exec('DROP TABLE aux_requirements'));
    inspect(guarded,db=>db.exec("UPDATE account_sets SET accounting_profile_id='cas-2006-basic-v1'")); assert.equal(runOfflinePosting(gr).code,'posting_profile_unsupported'); inspect(guarded,db=>db.exec("UPDATE account_sets SET accounting_profile_id='small-2011-basic-v1'"));
  });
  await test('closed period rejects before any formal operation', () => { inspect(guarded,db=>db.exec("UPDATE periods SET status='closed'")); assert.equal(runOfflinePosting(executionRequest(gr,gp)).code,'posting_period_closed'); inspect(guarded,db=>{assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_operations WHERE action='import.append'").get().n,0);db.exec("UPDATE periods SET status='open'");}); });
  await test('blocked business does not silently complete period or block independent sale', async () => { const p=join(guarded.dir,'accounting.json'),doc=readJson(p); const old=JSON.stringify(doc); doc.facts.find(x=>x.kind==='administrative_service').nonAsset=false; writeJson(p,doc); const r=await postingRequest(guarded,'administrative_service'), x=runOfflinePosting(r), sale=runOfflinePosting(gr); assert.equal(x.status,'blocked'); assert.equal(sale.status,'prepared'); assert.equal(sale.branches.some(b=>b.status==='unsupported'),true); assert.equal(sale.periodComplete,false); writeFileSync(p,old); });
  await test('real formal failure rolls back and persists failure; never increments attempt', () => {
    inspect(guarded,db=>db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON vouchers BEGIN SELECT RAISE(ABORT,'synthetic'); END"));
    const p=runOfflinePosting(gr),x=runOfflinePosting(executionRequest(gr,p)); assert.equal(x.status,'needs_local_review',JSON.stringify(x)); assert.equal(x.applied,false); assert.equal(x.code,'posting_previous_failure');
    inspect(guarded,db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,0);assert.equal(db.prepare('SELECT status FROM import_batches WHERE batch_id=?').get(p.batchId).status,'failed');db.exec('DROP TRIGGER synthetic_failure');});
    assert.equal(runOfflinePosting(executionRequest(gr,p)).code,'posting_previous_failure'); inspect(guarded,db=>assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_operations WHERE operation_id=?').get(p.operationId).n,1));
  });
  await test('real failed failure-persistence leaves pending unknown and stops after restart', async () => {
    const pending=createPostingFixture(join(root,'pending')),r=await postingRequest(pending),p=runOfflinePosting(r);
    inspect(pending,db=>db.exec("CREATE TRIGGER synthetic_business BEFORE INSERT ON vouchers BEGIN SELECT RAISE(ABORT,'synthetic'); END; CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON import_batches WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'synthetic'); END"));
    const x=runOfflinePosting(executionRequest(r,p)); assert.equal(x.applied,'unknown',JSON.stringify(x)); assert.equal(x.code,'audit_operation_pending'); inspect(pending,db=>{assert.equal(db.prepare('SELECT state FROM audit_operations WHERE operation_id=?').get(p.operationId).state,'pending');db.exec('DROP TRIGGER synthetic_business; DROP TRIGGER synthetic_audit_failure');});
    for(const rr of [{...r,command:'query'},executionRequest(r,p)]) { const y=runOfflinePosting(rr);assert.equal(y.applied,'unknown');assert.equal(y.code,'audit_operation_pending'); }
    renameSync(pending.inputPath,pending.inputPath+'.saved');try { const y=runOfflinePosting({...r,command:'query'});assert.equal(y.applied,'unknown');assert.equal(y.code,'posting_current_inputs_unverified');assert.equal(y.operationId,p.operationId); } finally { renameSync(pending.inputPath+'.saved',pending.inputPath); }
    inspect(pending,db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_operations WHERE operation_id=?').get(p.operationId).n,1);});
  });
  await test('new independent facts and reordered source inventory preserve committed task digest', () => { const p=join(f.dir,'materials.json'),doc=readJson(p);doc.sources.reverse();writeJson(p,doc);const x=runOfflinePosting({...request,command:'query'});assert.equal(x.status,'recovered',JSON.stringify(x)); });
  await test('same JSON gains independent business without changing posted semantic request', () => {
    const business=readJson(join(f.dir,'business.json')),facts=readJson(join(f.dir,'accounting.json'));
    const b=structuredClone(business.facts[0]),a=structuredClone(facts.facts.find(x=>x.kind==='service_sale'));b.factId='new-basic';b.invoiceRef.number='1002';a.factId='new-sale';a.invoiceRef.number='1002';a.contractId='NEW-CONTRACT';business.facts.push(b);facts.facts.push(a);
    writeFileSync(join(f.dir,'sales.csv'),readFileSync(join(f.dir,'sales.csv'),'utf8')+'\n1002,2026-01-13,'+f.key+',NEW-BUYER,37.83,0.38,38.21,blue');writeJson(join(f.dir,'business.json'),business);writeJson(join(f.dir,'accounting.json'),facts);
    const x=runOfflinePosting({...request,command:'query'});assert.equal(x.status,'recovered',JSON.stringify(x));assert.equal(x.branches.length,4);
  });
  await test('actual XLSX receipt store to domain append and stale original stops proof', async () => {
    const xlsx=createPostingFixture(join(root,'xlsx')),materials=readJson(join(xlsx.dir,'materials.json')),sales=materials.sources.find(s=>s.sourceId==='sales');
    const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('发票');const rows=readFileSync(join(xlsx.dir,'sales.csv'),'utf8').split('\n').map(r=>r.split(','));for(const row of rows)sheet.addRow(row);
    await book.xlsx.writeFile(join(xlsx.dir,'sales.xlsx'));sales.kind='invoice_xlsx';sales.path='sales.xlsx';sales.mapping={...sales.mapping,format:'invoice-summary-xlsx-v1',sheet:'发票',headerRow:1};writeJson(join(xlsx.dir,'materials.json'),materials);
    const store=join(xlsx.dir,'receipts');await initMaterialStore(store,xlsx.scope);await receiveMaterials(store,join(xlsx.dir,'materials.json'));const config=readJson(xlsx.inputPath);delete config.materialsInput;config.materialStore='receipts';writeJson(xlsx.inputPath,config);
    const r=await postingRequest(xlsx),p=runOfflinePosting(r);assert.equal(p.status,'prepared',JSON.stringify(p));assert.equal(runOfflinePosting(executionRequest(r,p)).status,'applied');
    writeFileSync(join(xlsx.dir,'sales.xlsx'),Buffer.from('stale synthetic original'));const q=runOfflinePosting({...r,command:'query'});assert.equal(q.applied,true);assert.equal(q.status,'needs_local_review');assert.equal(q.code,'posting_current_inputs_unverified');
  });
  await test('actual code bytes change invalidates confirmation without changing business ID', async () => {
    const fresh=createPostingFixture(join(root,'code')),r=await postingRequest(fresh),deployment=join(root,'isolated');mkdirSync(deployment);cpSync(resolve('server'),join(deployment,'server'),{recursive:true});
    const driver=join(deployment,'probe.mjs');writeFileSync(driver,"import {runOfflinePosting} from './server/offline-posting.mjs'; import {readFileSync} from 'node:fs'; process.stdout.write(JSON.stringify(runOfflinePosting(JSON.parse(readFileSync(0,'utf8')))));");
    const run=r=>{const child=spawnSync(process.execPath,[driver],{input:JSON.stringify(r),encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'},windowsHide:true});assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);};
    const p=run(r);assert.equal(p.status,'prepared',JSON.stringify(p));assert.equal(p.policyDigest,runOfflinePosting(r).policyDigest);writeFileSync(join(deployment,'server','offline-bookkeeping.mjs'),readFileSync(join(deployment,'server','offline-bookkeeping.mjs'),'utf8')+'\n// synthetic policy code drift\n');
    const q=run(executionRequest(r,p));assert.equal(q.code,'posting_confirmation_stale');assert.equal(q.operationId,p.operationId);assert.notEqual(q.policyDigest,p.policyDigest);inspect(fresh,db=>assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,0));
  });
  for (const changedFile of ['offline-posting-target.mjs','offline-bookkeeping.mjs']) await test(`parent pre-spawn manifest rejects persistent ${changedFile} replacement after worker parse before hash`, async () => {
    const fresh=createPostingFixture(join(root,'startup-'+changedFile)),r=await postingRequest(fresh),deployment=join(root,'startup-copy-'+changedFile);mkdirSync(deployment);cpSync(resolve('server'),join(deployment,'server'),{recursive:true});
    const target=join(deployment,'server','offline-posting-target.mjs'),barrier=join(deployment,'barrier');mkdirSync(barrier);
    let text=readFileSync(target,'utf8');text=text.replace('const initialCode = capturePostingCode()',"import {writeFileSync as syntheticWrite, existsSync as syntheticExists} from 'node:fs';\nif(process.env.SYNTHETIC_POSTING_BARRIER){const d=process.env.SYNTHETIC_POSTING_BARRIER;syntheticWrite(d+'/ready','parsed');while(!syntheticExists(d+'/go'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}\nconst initialCode = capturePostingCode()");writeFileSync(target,text);
    const driver=join(deployment,'probe.mjs');writeFileSync(driver,"import {runOfflinePosting} from './server/offline-posting.mjs'; import {readFileSync} from 'node:fs'; process.stdout.write(JSON.stringify(runOfflinePosting(JSON.parse(readFileSync(0,'utf8')))));");
    const first=spawnSync(process.execPath,[driver],{input:JSON.stringify(r),encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'},windowsHide:true});assert.equal(first.status,0,first.stderr);const p=JSON.parse(first.stdout);assert.equal(p.status,'prepared',JSON.stringify(p));
    const child=spawn(process.execPath,[driver],{env:{...process.env,NODE_NO_WARNINGS:'1',SYNTHETIC_POSTING_BARRIER:barrier},stdio:['pipe','pipe','pipe'],windowsHide:true});let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});const closed=new Promise((ok,no)=>{child.on('error',no);child.on('close',(code,signal)=>ok({code,signal}));});child.stdin.end(JSON.stringify(executionRequest(r,p)));
    try {
      const deadline=Date.now()+10000;while(!existsSync(join(barrier,'ready'))&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,10));assert.equal(existsSync(join(barrier,'ready')),true,'actual worker parse barrier');
      const changed=join(deployment,'server',changedFile);writeFileSync(changed,readFileSync(changed,'utf8')+'\n// persistent startup code replacement\n');writeFileSync(join(barrier,'go'),'continue');
      const exit=await closed;assert.equal(exit.code,0,stderr);assert.equal(exit.signal,null);assert.equal(stderr,'');const x=JSON.parse(stdout);assert.equal(x.code,'posting_code_restart_required');assert.equal(x.applied,'unknown');assert.equal(x.operationId,p.operationId);
      inspect(fresh,db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_operations WHERE action='import.append'").get().n,0);});assert.equal(existsSync(join(deployment,'data')),false);
    } finally { if(!existsSync(join(barrier,'go')))writeFileSync(join(barrier,'go'),'cleanup');await closed; }
  });
  await test('CLI wx/safe stdout and simulated lost output recover with a fresh process', async () => {
    const fresh=createPostingFixture(join(root,'cli')),r=await postingRequest(fresh),p=runOfflinePosting(r),file=join(fresh.dir,'posting.json'),out=join(fresh.dir,'receipt.json'); writeJson(file,executionRequest(r,p));
    const child=spawnSync(process.execPath,['scripts/offline-posting.mjs','--input',file,'--output',out],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'},windowsHide:true}); assert.equal(child.status,0,child.stdout+child.stderr);assert.equal(child.signal,null);assert.equal(child.stderr,'');assert.match(child.stdout,/status=applied applied=true/);assert.equal(child.stdout.includes('SYNTHETIC'),false);assert.equal(child.stdout.includes(fresh.dbPath),false);
    // The caller loses its response artifact after the actual commit; a new process proves it.
    rmSync(out); const recovered=runOfflinePosting({...r,command:'query'});assert.equal(recovered.status,'recovered');assert.equal(recovered.evidence.operationId,p.operationId);
    writeFileSync(out,'KEEP');const repeat=spawnSync(process.execPath,['scripts/offline-posting.mjs','--input',file,'--output',out],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'},windowsHide:true}); assert.equal(repeat.status,4);assert.equal(readFileSync(out,'utf8'),'KEEP');inspect(fresh,db=>assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,1));
  });
  await test('real commit with broken response pipe recovers without a new success', async () => {
    const lost=createPostingFixture(join(root,'lost-pipe')),r=await postingRequest(lost),p=runOfflinePosting(r);
    const child=spawn(process.execPath,[resolve('server/offline-posting-target.mjs')],{env:{...process.env,NODE_NO_WARNINGS:'1'},stdio:['pipe','pipe','pipe'],windowsHide:true});let errors='';child.stderr.on('data',b=>{errors+=b;});child.stdout.destroy();child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({version:'offline-posting-private/1',expectedCode:capturePostingCode(),request:executionRequest(r,p)}));
    const closed=await new Promise((ok,no)=>{child.on('error',no);child.on('close',(code,signal)=>ok({code,signal}));});assert.equal(closed.signal,null);assert.equal(closed.code,5,errors);
    const before=inspect(lost,db=>[db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='import.append' AND outcome='succeeded'").get().n]);assert.deepEqual(before,[1,1]);
    const q=runOfflinePosting({...r,command:'query'});assert.equal(q.status,'recovered',JSON.stringify(q));assert.equal(q.operationId,p.operationId);
    inspect(lost,db=>assert.deepEqual([db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='import.append' AND outcome='succeeded'").get().n],before));
  });
} finally { if (!failed && process.env.KEEP_FIXTURES !== '1') rmSync(root,{recursive:true,force:true}); else process.stdout.write('SYNTHETIC_FIXTURES_RETAINED\n'); }
process.stdout.write(`offline-posting ${count}/${count}\n`);
