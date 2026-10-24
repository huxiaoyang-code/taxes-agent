import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {batchComponentContract} from '../server/local-batch-storage.mjs';
import {runChild} from './auxiliary-storage.test.mjs';
const work=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const root=join(work,'.agent-runs','bank-aux-'+randomUUID());fs.mkdirSync(root,{recursive:true});
for(let p=root;;p=dirname(p)){assert.equal(fs.lstatSync(p).isSymbolicLink(),false);assert.equal(fs.realpathSync.native(p).toLowerCase(),resolve(p).toLowerCase());if(dirname(p)===p)break;}
process.env.TEMP=root;process.env.TMP=root;process.env.WORKBENCH_DATA_DIR=join(root,'data');process.env.KEEP_FIXTURES='1';
function assertAuditAppend(after,before,actions,message,state='failure') {
 const row=v=>typeof v==='string'?JSON.parse(v):v;
 const business=value=>Object.fromEntries(Object.entries(value).filter(([name])=>!['audit_events','audit_operations','local_batch_lock_epochs'].includes(name)).map(([name,rows])=>[name,name==='sqlite_sequence'?rows.filter(v=>row(v).name!=='audit_events'):rows]));
 assert.deepEqual(business(after),business(before),message);
 for(const table of ['audit_events','audit_operations'])for(const original of before[table]??[])assert.ok((after[table]??[]).some(v=>JSON.stringify(v)===JSON.stringify(original)),table+' history must remain exact');
 const added=table=>(after[table]??[]).filter(v=>!(before[table]??[]).some(old=>JSON.stringify(old)===JSON.stringify(v))).map(row);
 const events=added('audit_events').sort((a,b)=>a.seq-b.seq),ops=added('audit_operations');
 const expected=new Map(),binding=new Map((before.import_enterprise_account_sets??[]).map(row).map(r=>[r.account_set_id,r.enterprise_key]));
 for(const event of events){assert.ok(Number.isSafeInteger(event.account_set_id)&&event.account_set_id>0);for(const key of [`account-set:${event.account_set_id}`,...(binding.has(event.account_set_id)?[`book:${binding.get(event.account_set_id)}`]:[])])expected.set(key,(expected.get(key)??0)+1);}
 const epochMap=value=>new Map((value.local_batch_lock_epochs??[]).map(row).map(r=>[r.resource_key,r.last_token]));const oldEpoch=epochMap(before),newEpoch=epochMap(after);
 assert.deepEqual([...newEpoch.keys()].sort(),[...oldEpoch.keys()].sort(),'failure may only advance the exact existing resources');
 for(const [key,token] of oldEpoch)assert.equal(newEpoch.get(key),token+(expected.get(key)??0),'exact resource acquisition count: '+key);
 assert.deepEqual(after.local_batch_locks,before.local_batch_locks);assert.equal((after.local_batch_locks??[]).length,0,'all temporary active ownership released');
 assert.deepEqual(events.map(e=>e.action),actions);assert.equal(ops.length,actions.length);
 for(const event of events){
  const operation=ops.find(o=>o.operation_id===event.operation_id&&o.attempt===event.attempt&&o.database_instance_id===event.database_instance_id);assert.ok(operation);
  if(state==='failure')assert.ok(['failed','rejected'].includes(operation.state));else assert.equal(operation.state,state);
  assert.equal(event.outcome,operation.state);assert.equal(event.action,operation.action);assert.ok(operation.receipt_json);
  const receipt=JSON.parse(operation.receipt_json);
  assert.deepEqual(Object.keys(receipt).sort(),['receiptVersion','databaseInstanceId','operationId','attempt','state','resultCode','reasonCode','eventId','eventSeq','targets','resultRefs','resultDigest'].sort());
  assert.equal(receipt.receiptVersion,2);assert.equal(receipt.operationId,operation.operation_id);assert.equal(receipt.databaseInstanceId,operation.database_instance_id);assert.equal(receipt.attempt,operation.attempt);assert.equal(receipt.state,operation.state);assert.equal(receipt.eventId,event.event_id);assert.equal(receipt.eventSeq,event.seq);assert.equal(receipt.resultCode,event.result_code);assert.equal(receipt.reasonCode,event.reason_code);assert.match(receipt.resultDigest,/^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.targets,{accountSetId:event.account_set_id,voucherId:event.voucher_id,period:event.period,jobId:event.job_id,itemId:event.item_id,stageId:event.stage_id,correlation:event.correlation});
 }
 const seq=value=>(value.sqlite_sequence??[]).map(row).find(r=>r.name==='audit_events')?.seq??0;
 assert.equal(seq(after)-seq(before),actions.length);
}

const scenario=process.argv[2];
if(!scenario){
 for(const order of ['aux-first','bank-first']){const c=await runChild([fileURLToPath(import.meta.url),order],{timeout:180000});process.stdout.write(c.stdout);assert.equal(c.code,0,c.stderr);assert.equal(c.closed,true);assert.equal(c.timedOut,false);console.log(order+' actual child close');}
 console.log('local-bank-aux-integration PASS: both installation orders, profiles, real CLI and independent 1130');
}else{
 const {db}=await import('../server/db.mjs');const A=await import('../server/accounting.mjs'),S=await import('../server/bank-storage.mjs'),X=await import('../server/auxiliary-accounting.mjs'),AS=await import('../server/auxiliary-storage.mjs'),LB=await import('../server/local-backup.mjs'),B=await import('../server/bank-reconciliation.mjs');
 const dbPath=join(process.env.WORKBENCH_DATA_DIR,'workbench.db'),cliFile=fileURLToPath(new URL('../scripts/bank-reconcile.mjs',import.meta.url));
 const mapping={columns:{date:'date',summary:'summary',amount:'amount',direction:'direction',refId:'ref'},amountMode:'amount_direction',directionLabels:{inflow:['in'],outflow:['out']},currency:'CNY'};
 const mappingFile=join(root,'mapping.json');fs.writeFileSync(mappingFile,JSON.stringify(mapping));
 let n=0;const request=()=>`req-${++n}`;
 const rows=c=>Object.fromEntries(c.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,c.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
 const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 const cli=async(path,scope,command,args=[])=>{const c=await runChild([cliFile,command,'--db',path,'--account-set',String(scope.accountSetId),'--bank-account',scope.bankAccountId,...args],{timeout:60000});assert.equal(c.code,0,c.stderr);assert.equal(c.closed,true);assert.equal(c.timedOut,false);return JSON.parse(c.stdout);};
 const backup=(path,folder)=>{const b=LB.createBackup({dbPath:path,outDir:join(root,folder)});assert.equal(b.ok,true,JSON.stringify(b));assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,true);return b;};
 const restore=(dir,folder)=>{const r=LB.restoreNew({backupDir:dir,targetDir:join(root,folder)});assert.equal(r.ok,true,JSON.stringify(r));return join(r.targetDir,'workbench.db');};
 const components=c=>{const manifest=LB.createBackup({dbPath:c,outDir:join(root,'facts-'+request())}).manifest;const batch=manifest.components.find(v=>v.name==='local-batch');assert.equal(batch.version,3);assert.equal(batch.tables.length,12);assert.deepEqual(batch.tables,batchComponentContract(3).tables);return manifest.components.map(v=>v.name);};
 const reconArgs=['--period','2025-12','--as-of','2025-12-31','--statement-open','1000','--statement-close','1110','--coverage-from','2025-12-01','--coverage-to','2025-12-31','--statement-source','synthetic independent 1130'];
 const expect1130=r=>{assert.equal(r.book.closingCents,112000);assert.equal(r.statement.closeCents,111000);assert.equal(r.adjusted.bookCents,113000);assert.equal(r.adjusted.bankCents,113000);assert.equal(r.adjusted.differenceCents,0);};
 try{
  db.exec('PRAGMA wal_autocheckpoint=0');
  // A real WAL-committed row must be included in every installation snapshot.
  const sets=[];
  for(const [key,profile,capital,expense] of [['small','small-2011-basic-v1','3001','5602'],['enterprise','enterprise-2019-general-basic-v1','4001','6602'],['legacy','legacy-small-coa-v1','3001','5602']]){
   let accountSetId;
   if(key==='legacy'){
    // Historical persisted profile, never offered as a creatable user profile.
    accountSetId=Number(db.prepare("INSERT INTO account_sets(name,start_period,created_at) VALUES('Synthetic legacy','2025-12',?)").run(new Date().toISOString()).lastInsertRowid);
    const {COA}=await import('../server/coa.mjs');for(const a of COA)db.prepare('INSERT INTO accounts(account_set_id,code,name,category,direction,contra,is_leaf) VALUES(?,?,?,?,?,?,1)').run(accountSetId,a.code,a.name,a.category,a.direction,a.contra?1:0);
   }else accountSetId=A.createAccountSet({name:'Synthetic '+key,start_period:'2025-12',profileId:profile,enterprise:{enterpriseKey:'BANK-AUX-'+key,enterpriseName:'Synthetic '+key}}).id;
   A.setOpeningBalances(accountSetId,[{code:'1002',debit:1000},{code:capital,credit:1000}]);
   const vouchers=[];for(const [i,amount,inflow] of [[1,200,true],[2,50,true],[3,100,false],[4,30,false]]){
    const v=A.createVoucher(accountSetId,{period:'2025-12',voucher_date:'2025-12-15',number:i,entries:inflow?[{code:'1002',debit:amount},{code:'1122',credit:amount}]:[{code:expense,debit:amount},{code:'1002',credit:amount}]});A.postVoucher(accountSetId,v.id);vouchers.push({voucherId:v.id,entryId:db.prepare("SELECT id FROM voucher_entries WHERE voucher_id=? AND code='1002'").get(v.id).id});
   }
   sets.push({key,scope:{accountSetId,bankAccountId:'BANK-'+key},vouchers});
  }
  assert.equal(fs.existsSync(dbPath+'-wal'),true);
  let beforeSecond;
  if(scenario==='aux-first'){
   await AS.ensureAuxiliarySchema(db,{dbPath,outDir:join(root,'before-aux')});
   const result=await S.ensureBankSchema(db,{dbPath,dataDir:dirname(dbPath),backupService:LB});beforeSecond=result.backup.backupDir;
  }else{
   await S.ensureBankSchema(db,{dbPath,dataDir:dirname(dbPath),backupService:LB});
   const result=await AS.ensureAuxiliarySchema(db,{dbPath,outDir:join(root,'before-aux')});beforeSecond=result.backupDir;
  }
  assert.equal((await S.ensureBankSchema(db,{dbPath,backupService:LB})).migrated,false);assert.equal((await AS.ensureAuxiliarySchema(db,{dbPath,outDir:join(root,'unused')})).status,'already_installed');
  const beforePath=restore(beforeSecond,'before-second-restored');const beforeDb=new DatabaseSync(beforePath);try{
   assert.deepEqual(components(beforePath),scenario==='aux-first'?['auxiliary','business-audit','local-batch']:['bank','business-audit','local-batch']);assert.equal(beforeDb.prepare('SELECT COUNT(*) n FROM vouchers WHERE status=\'posted\'').get().n,12);
   if(scenario==='aux-first')X.createAuxiliaryEntity(beforeDb,{accountSetId:sets[0].scope.accountSetId,kind:'project',code:'RESTORED',name:'continued',requestId:'continued'});
   else {
    const scope=sets[0].scope;B.registerBankAccount(beforeDb,{...scope,sourceId:'statement',glAccountCode:'1002'});
    const imported=B.importBankBatch(beforeDb,{...scope,sourceId:'statement',period:'2025-12',batchId:'without-aux',mapping,csvText:'date,summary,amount,direction,ref\n2025-12-15,uninstalled,200,in,NO-AUX\n'});
    const before=rows(beforeDb),view=B.listCandidates(beforeDb,{...scope,transactionId:imported.transactionIds[0]}).candidates[0];
    assert.deepEqual(view.partyAllocation,{installed:false,status:'not_installed',accountSetId:scope.accountSetId,entryId:view.entryId});assertAuditAppend(rows(beforeDb),before,['bank.refresh'],'display business rows unchanged','no_change');assert.equal(AS.inspectAuxiliarySchema(beforeDb).present,false);
   }
  }finally{beforeDb.close();}
  for(const item of sets){
   const {key,scope,vouchers}=item;
   await cli(dbPath,scope,'account-register',['--source','statement','--gl-code','1002']);
   const csv=join(root,key+'.csv');fs.writeFileSync(csv,'date,summary,amount,direction,ref\n2025-12-15,not party proof,200,in,R1\n2025-12-15,bank only,20,in,R2\n2025-12-15,payment,100,out,R3\n2025-12-15,fee,10,out,R4\n');
   const imported=await cli(dbPath,scope,'import',['--source','statement','--period','2025-12','--batch','batch-'+key,'--csv',csv,'--mapping',mappingFile]);assert.equal(imported.transactionIds.length,4);item.transactionIds=imported.transactionIds;
   const candidate=async()=>{const before=rows(db);const r=await cli(dbPath,scope,'candidates',['--transaction',String(item.transactionIds[0])]);assertAuditAppend(rows(db),before,['bank.refresh'],'display business rows unchanged','no_change');return r.candidates.find(v=>v.entryId===vouchers[0].entryId);};
   assert.equal((await candidate()).partyAllocation.status,'unknown');assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_matches WHERE account_set_id=?').get(scope.accountSetId).n,0,'single candidate never auto confirms');
   const matched=await cli(dbPath,scope,'confirm',['--transaction',String(item.transactionIds[0]),'--voucher',String(vouchers[0].voucherId),'--entry',String(vouchers[0].entryId),'--reason','manual identity']);item.matchId=matched.match.matchId;
   await cli(dbPath,scope,'confirm',['--transaction',String(item.transactionIds[2]),'--voucher',String(vouchers[2].voucherId),'--entry',String(vouchers[2].entryId),'--reason','manual payment']);
   const entity=code=>X.createAuxiliaryEntity(db,{accountSetId:scope.accountSetId,kind:'party',code,name:'Same display',requestId:request()}).id;
   const p=entity('P'),q=entity('Q');const allocate=parts=>X.replaceAuxiliaryAllocations(db,{accountSetId:scope.accountSetId,entryId:vouchers[0].entryId,allocations:parts,requestId:request(),reason:'synthetic allocation'});
   allocate([{partyId:p,debit:120},{partyId:q,debit:80}]);assert.equal((await candidate()).partyAllocation.status,'ambiguous');
   allocate([{partyId:p,debit:200}]);let view=(await candidate()).partyAllocation;assert.equal(view.status,'confirmed');assert.equal(view.partyId,p);assert.equal(view.partyActive,true);assert.equal(view.accountSetId,scope.accountSetId);assert.equal(view.entryId,vouchers[0].entryId);
   const snap=db.prepare('SELECT snapshot_json FROM bank_matches WHERE id=?').get(item.matchId);X.updateAuxiliaryEntity(db,{accountSetId:scope.accountSetId,entityId:p,name:'Renamed local party',active:false,reason:'synthetic deactivate'});
   view=(await candidate()).partyAllocation;assert.equal(view.status,'confirmed');assert.equal(view.partyActive,false);assert.deepEqual(view.inactivePartyIds,[p]);
   const before=rows(db);const matches=await cli(dbPath,scope,'matches');assertAuditAppend(rows(db),before,['bank.refresh'],'matches business rows unchanged','no_change');const m=matches.matches.find(m=>m.matchId===item.matchId);assert.equal(m.status,'confirmed');assert.deepEqual(m.partyAllocation,view);assert.deepEqual(db.prepare('SELECT snapshot_json FROM bank_matches WHERE id=?').get(item.matchId),snap);assert.equal(B.refreshMatchStates(db,scope).invalidated.length,0);
   const other=sets.find(v=>v.key!==key);const foreign=X.createAuxiliaryEntity(db,{accountSetId:other.scope.accountSetId,kind:'party',code:'FOREIGN-'+key,name:'Same display',requestId:request()}).id;
   assert.throws(()=>allocate([{partyId:foreign,debit:200}]),/dimension_invalid/);
   assert.throws(()=>X.entryPartyAllocation(db,{accountSetId:other.scope.accountSetId,entryId:vouchers[0].entryId}),/target_not_found|owner|entry/);
   expect1130(await cli(dbPath,scope,'reconcile',reconArgs));
   const actual=db.prepare('SELECT direction,amount_cents FROM bank_transactions WHERE account_set_id=? ORDER BY id').all(scope.accountSetId);assert.deepEqual(actual.map(r=>r.amount_cents),[20000,2000,10000,1000]);
   console.log(scenario+' '+key+': CLI posted identity, display-only unknown/ambiguous/confirmed/inactive, independent 1130');
  }
  const joint=backup(dbPath,'joint');assert.deepEqual(joint.manifest.components.map(c=>c.name),['bank','auxiliary','business-audit','local-batch']);const restored=restore(joint.backupDir,'joint-restored');const expectedTables={'bank':[...S.BANK_TABLES].sort(),'auxiliary':AS.AUX_TABLES,'business-audit':['audit_components','audit_database_instances','audit_events','audit_operations'],'local-batch':batchComponentContract(3).tables};assert.equal(expectedTables['local-batch'].length,12);for(const component of joint.manifest.components){assert.equal(component.version,component.name==='business-audit'?2:component.name==='local-batch'?3:1);assert.deepEqual(component.tables,expectedTables[component.name]);for(const key of ['structureDigest','contentDigest'])assert.match(component[key],/^[a-f0-9]{64}$/);}const restoredAudit=new DatabaseSync(restored,{readOnly:true});try{for(const table of expectedTables['business-audit'])assert.deepEqual(restoredAudit.prepare('SELECT * FROM '+table+' ORDER BY rowid').all(),db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());}finally{restoredAudit.close();}
  for(const item of sets){
   expect1130(await cli(restored,item.scope,'reconcile',reconArgs));
   const csv=join(root,item.key+'-continued.csv');fs.writeFileSync(csv,'date,summary,amount,direction,ref\n2026-01-02,continued,0.01,in,NEXT\n');
   const r=await cli(restored,item.scope,'import',['--source','statement','--period','2026-01','--batch','continued-'+item.key,'--csv',csv,'--mapping',mappingFile]);assert.equal(r.transactionIds.length,1);
  }
  const check=new DatabaseSync(restored);try{
   for(const mutate of [c=>c.exec('CREATE TABLE aux_unknown(id INTEGER)'),c=>c.exec('PRAGMA ignore_check_constraints=ON;UPDATE aux_component_migrations SET version=2')]){
    mutate(check);const before=rows(check);assert.throws(()=>B.listCandidates(check,{...sets[0].scope,transactionId:sets[0].transactionIds[0]}),e=>e.code==='aux_structure_invalid');assertAuditAppend(rows(check),before,['bank.refresh'],'invalid auxiliary rejects and records exact failed terminal');check.exec('DROP TABLE IF EXISTS aux_unknown;UPDATE aux_component_migrations SET version=1');
   }
   assert.equal(check.prepare('SELECT COUNT(*) n FROM bank_transactions WHERE amount_cents=1').get().n,3);assert.equal(check.prepare('PRAGMA foreign_key_check').all().length,0);}finally{check.close();}
  for(const item of sets){
   await cli(dbPath,item.scope,'cancel',['--match',String(item.matchId),'--reason','manual cancel']);
   const r=await cli(dbPath,item.scope,'confirm',['--transaction',String(item.transactionIds[0]),'--voucher',String(item.vouchers[0].voucherId),'--entry',String(item.vouchers[0].entryId),'--reason','manual reconfirm']);
   A.unpostVoucher(item.scope.accountSetId,item.vouchers[0].voucherId);assert.equal(B.refreshMatchStates(db,item.scope).invalidated.length,1);assert.equal(B.refreshMatchStates(db,item.scope).invalidated.length,0);assert.equal(B.listMatchesView(db,item.scope).matches.find(m=>m.matchId===r.match.matchId).status,'invalidated');
  }
  if(scenario==='aux-first'){
   // Every negative starts from the real official aux-only pre-install snapshot.
   const seed=join(beforeSecond,LB.SNAPSHOT_FILE);
   const negative=async(label,mutate,service)=>{const folder=join(root,'negative-'+label);fs.mkdirSync(folder);const path=join(folder,'workbench.db');fs.copyFileSync(seed,path);const c=new DatabaseSync(path);c.exec('PRAGMA foreign_keys=ON');try{if(mutate)mutate(c);const backupService=service?.(path,c)??LB;const before=rows(c),bytes=hash(path);await assert.rejects(S.ensureBankSchema(c,{dbPath:path,dataDir:folder,backupService}),e=>e.code==='migration_backup_failed'||e.code==='migration_backup_invalid'||e.code==='bank_schema_corrupt');assert.deepEqual(rows(c),before,label+' zero DDL/business');assert.equal(c.isTransaction,false);assert.equal(hash(path),bytes,label+' main bytes');}finally{c.close();}console.log('strict negative '+label);};
   const wrongDir=join(root,'wrong-source');fs.mkdirSync(wrongDir);const wrong=join(wrongDir,'workbench.db');fs.copyFileSync(seed,wrong);const w=new DatabaseSync(wrong);try{w.prepare("UPDATE account_sets SET name='different source content' WHERE id=1").run();}finally{w.close();}const wrongBackup=backup(wrong,'wrong-official');
   await negative('same-basename-content',null,()=>({createBackup:()=>wrongBackup,verifyBackup:LB.verifyBackup,assertBackupSourceConnection:()=>true}));
   for(const [label,mutation] of [['unknown',c=>c.exec('CREATE TABLE audit_unknown(id INTEGER)')],['future',c=>c.exec('PRAGMA ignore_check_constraints=ON;UPDATE aux_component_migrations SET version=2')],['damaged',c=>c.exec('DROP TRIGGER aux_voucher_update')]])await negative(label,mutation);
   for(const label of ['missing','duplicate','unknown-component','future-component','stale-content','fake-hash','false-verifier'])await negative(label,null,(path)=>({
    createBackup:({outDir})=>{const b=LB.createBackup({dbPath:path,outDir});assert.equal(b.ok,true);if(label==='false-verifier')return b;const m=JSON.parse(JSON.stringify(b.manifest));if(label==='missing')delete m.components;if(label==='duplicate')m.components.push(m.components[0]);if(label==='unknown-component')m.components.find(c=>c.name==='auxiliary').name='audit';if(label==='future-component')m.components.find(c=>c.name==='auxiliary').version=2;if(label==='stale-content')m.content.digest='0'.repeat(64);if(label==='fake-hash')m.snapshot.sha256='0'.repeat(64);fs.writeFileSync(join(b.backupDir,LB.MANIFEST_FILE),JSON.stringify(m));return {...b,manifest:m,backupMeta:{...b.backupMeta,snapshotSha256:m.snapshot.sha256}};},
    verifyBackup:({backupDir})=>{if(label==='false-verifier')return {ok:false,status:'corrupt'};const manifest=JSON.parse(fs.readFileSync(join(backupDir,LB.MANIFEST_FILE)));return {ok:true,status:'ok',manifest,summary:{snapshotBytes:manifest.snapshot.bytes,snapshotSha256:manifest.snapshot.sha256}};},assertBackupSourceConnection:()=>true
   }));
   // Stale but fully valid official backup of the same source path is also refused.
   await negative('stale-valid-official',null,(path,c)=>{const b=backup(path,'stale-official');c.prepare("UPDATE account_sets SET name='newer committed WAL' WHERE id=1").run();return {createBackup:()=>b,verifyBackup:LB.verifyBackup};});
  }
  console.log(scenario+' PASS: actual backups/verify/restore before and after both components; continued writes; DBs closed');
 }finally{db.close();console.log(scenario+' source database closed');}
}
