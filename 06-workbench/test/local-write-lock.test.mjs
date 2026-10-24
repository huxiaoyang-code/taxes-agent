import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync,lstatSync,realpathSync,writeFileSync,copyFileSync } from 'node:fs';
import { resolve,dirname,join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const root=resolve('../../../.agent-runs','s-'+randomUUID());mkdirSync(root,{recursive:true});
for(let p=root;;p=dirname(p)){assert.equal(lstatSync(p).isSymbolicLink(),false);assert.equal(realpathSync.native(p).toLowerCase(),p.toLowerCase());if(dirname(p)===p)break;}
process.env.TEMP=root;process.env.TMP=root;process.env.WORKBENCH_DATA_DIR=join(root,'d');process.env.KEEP_FIXTURES='1';process.env.WORKBENCH_TEST_KEEP_FIXTURES='1';
console.log('FIXTURES '+root);
let db;
try {
 ({db}=await import('../server/db.mjs'));
 const A=await import('../server/accounting.mjs');
 const S=await import('../server/local-batch-storage.mjs');
 const L=await import('../server/local-write-lock.mjs');
 assert.equal(S.assertBatchSchema(db).version,3);
 const set=A.createAccountSet({name:'synthetic',enterprise:{enterpriseKey:'LOCK-A'},start_period:'2026-01'});
 A.setOpeningBalances(set.id,[{code:'1002',debit:10000},{code:'3001',credit:10000}]);
 const handle=L.acquireWriteResources(db,['book:LOCK-A',`account-set:${set.id}`]);
 assert.throws(()=>A.ensurePeriod(set.id,'2026-02'),e=>['lock_active','owner_active'].includes(e.code));
 const token=L.writeResourceLocks(db,handle).find(l=>l.resourceKey===`account-set:${set.id}`).token;
 L.releaseWriteResources(db,handle);
 A.ensurePeriod(set.id,'2026-02');
 assert.ok(db.prepare('SELECT last_token FROM local_batch_lock_epochs WHERE resource_key=?').get(`account-set:${set.id}`).last_token>token);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM local_batch_locks').get().n,0);
 const owner='same-public-owner';
 const low=S.acquireLock(db,{resourceKey:'book:PUBLIC-OWNER',instance:owner,pid:process.pid});
 assert.throws(()=>S.acquireLock(db,{resourceKey:'book:PUBLIC-OWNER',instance:owner,pid:process.pid}),e=>e.code==='lock_active');
 assert.throws(()=>S.renewLock(db,{resourceKey:'book:PUBLIC-OWNER',instance:owner,token:low.token}),e=>e.code==='lock_capability_invalid');
 S.releaseLock(db,{resourceKey:'book:PUBLIC-OWNER',instance:owner,token:low.token});
 const again=S.acquireLock(db,{resourceKey:'book:PUBLIC-OWNER',instance:owner,pid:process.pid});assert.ok(again.token>low.token);S.releaseLock(db,{resourceKey:'book:PUBLIC-OWNER',instance:owner,token:again.token});
 const held=L.acquireWriteResources(db,[`account-set:${set.id}`]);
 assert.throws(()=>L.acquireWriteResources(db,['book:PARTIAL',`account-set:${set.id}`]),e=>e.code==='lock_active');
 assert.equal(db.prepare('SELECT 1 FROM local_batch_locks WHERE resource_key=?').get('book:PARTIAL'),undefined);assert.ok(db.prepare('SELECT last_token FROM local_batch_lock_epochs WHERE resource_key=?').get('book:PARTIAL').last_token>0);
 L.renewWriteResources(db,held);
 const other=new DatabaseSync(join(process.env.WORKBENCH_DATA_DIR,'workbench.db'));try{other.exec('PRAGMA foreign_keys=ON');assert.throws(()=>L.withWriteResources(other,held,()=>assert.fail('cross handle callback')),e=>e.code==='fence_lost');}finally{other.close();console.log('OTHER_DB_CLOSED');}
 L.releaseWriteResources(db,held);assert.throws(()=>L.withWriteResources(db,held,()=>assert.fail('revoked callback')),e=>e.code==='fence_lost');
 assert.throws(()=>L.withWriteResources(db,{},()=>assert.fail('forged callback')),e=>e.code==='fence_lost');
 const opaque=L.acquireWriteResources(db,[`account-set:${set.id}`]);const active=S.readBatchInstance(db);
 const nextInstance=randomUUID();db.prepare('UPDATE local_batch_database_instances SET is_active=0,audit_instance_id=NULL WHERE instance_id=?').run(active.instance_id);db.prepare("INSERT INTO local_batch_database_instances VALUES(?,?,?,1,?,'restore-new','ready',?,?)").run(nextInstance,active.instance_id,active.audit_instance_id,new Date().toISOString(),'synthetic-instance','a'.repeat(64));assert.throws(()=>L.withWriteResources(db,opaque,()=>assert.fail('cross instance callback')),e=>e.code==='fence_lost');db.prepare('DELETE FROM local_batch_database_instances WHERE instance_id=?').run(nextInstance);db.prepare('UPDATE local_batch_database_instances SET is_active=1,audit_instance_id=? WHERE instance_id=?').run(active.audit_instance_id,active.instance_id);L.releaseWriteResources(db,opaque);
 // Real unknown PID classification: process.kill rejects this positive safe integer as out of range.
 assert.equal(S.isProcessAlive(Number.MAX_SAFE_INTEGER),null);const unknown=S.acquireLock(db,{resourceKey:'book:UNKNOWN',instance:'unknown-owner',pid:Number.MAX_SAFE_INTEGER});assert.throws(()=>S.acquireLock(db,{resourceKey:'book:UNKNOWN',instance:'next',pid:process.pid}),e=>e.code==='lock_active');S.releaseLock(db,{resourceKey:'book:UNKNOWN',instance:'unknown-owner',token:unknown.token});
 const child=spawn(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';import {acquireLock} from './server/local-batch-storage.mjs';const db=new DatabaseSync(process.env.WORKBENCH_DATA_DIR+'/workbench.db');try{db.exec('PRAGMA foreign_keys=ON');console.log(JSON.stringify(acquireLock(db,{resourceKey:'book:DEAD',instance:'dead-child',pid:process.pid})));}finally{db.close();console.log('DB_CLOSED');}`],{cwd:process.cwd(),env:{...process.env},windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',exited;child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('exit',(code,signal)=>exited={code,signal});const closed=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});assert.deepEqual(closed,exited);assert.equal(closed.code,0,stderr);assert.match(stdout,/DB_CLOSED/);assert.equal(S.isProcessAlive(child.pid),false);const deadToken=JSON.parse(stdout.split('\n')[0]).token;const takeover=S.acquireLock(db,{resourceKey:'book:DEAD',instance:'takeover',pid:process.pid});assert.ok(takeover.token>deadToken);S.releaseLock(db,{resourceKey:'book:DEAD',instance:'takeover',token:takeover.token});console.log('CHILD_EXIT_CLOSE '+JSON.stringify(closed));
 const blocker=new DatabaseSync(join(process.env.WORKBENCH_DATA_DIR,'workbench.db'));try{
  blocker.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=0');db.exec('PRAGMA busy_timeout=0');
  const busyHandle=L.acquireWriteResources(db,['book:BUSY-RELEASE',`account-set:${set.id}`]);blocker.exec('BEGIN IMMEDIATE');const busyReleased=L.releaseWriteResources(db,busyHandle);assert.equal(busyReleased.pending,true);assert.throws(()=>L.withWriteResources(db,busyHandle,()=>assert.fail('revoked cleanup capability executes')),e=>e.code==='fence_lost');assert.throws(()=>L.renewWriteResources(db,busyHandle),e=>e.code==='fence_lost');blocker.exec('ROLLBACK');assert.equal(L.releaseWriteResources(db,busyHandle).released,true);assert.equal(S.listLocks(db).length,0);
  const exec=db.exec;let blocked=false;db.exec=function(sql){const result=exec.call(db,sql);if(!blocked&&sql==='COMMIT'){blocked=true;blocker.exec('BEGIN IMMEDIATE');}return result;};try{assert.throws(()=>L.acquireWriteResources(db,['book:BUSY-PARTIAL',`account-set:${set.id}`]),e=>e.errcode===5);}finally{db.exec=exec;if(blocker.isTransaction)blocker.exec('ROLLBACK');}assert.equal(blocked,true);assert.ok(db.prepare('SELECT 1 FROM local_batch_locks WHERE resource_key=?').get('book:BUSY-PARTIAL'));assert.equal(L.cleanupWriteResources(db).pending,false);assert.equal(S.listLocks(db).length,0);assert.ok(db.prepare('SELECT last_token FROM local_batch_lock_epochs WHERE resource_key=?').get('book:BUSY-PARTIAL').last_token>0);
 }finally{if(blocker.isTransaction)blocker.exec('ROLLBACK');blocker.close();console.log('BUSY_BLOCKER_DB_CLOSED');}
 const busyAfterCommit=new DatabaseSync(join(process.env.WORKBENCH_DATA_DIR,'workbench.db'));try{
  busyAfterCommit.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=0');const C=await import('../server/local-audit-coordinator.mjs');
  for(const changedOwner of [false,true]){
   const operationId='busy-release-'+randomUUID(),exec=db.exec;let blocked=false;db.exec=function(sql){const result=exec.call(db,sql);if(!blocked&&sql==='COMMIT'&&db.prepare("SELECT state FROM audit_operations WHERE operation_id=?").get(operationId)?.state==='succeeded'){blocked=true;busyAfterCommit.exec('BEGIN IMMEDIATE');}return result;};let value;try{value=C.withRequestMetadata({operationId,actor:'domain'},()=>A.createVoucher(set.id,{period:'2026-01',voucher_date:'2026-01-02',status:'posted',entries:[{code:'1002',debit:2},{code:'5001',credit:2}]}));}finally{db.exec=exec;}
   assert.equal(blocked,true);assert.ok(A.getVoucher(set.id,value.id));const owned=S.listLocks(db);assert.equal(owned.length,2);const epochs=owned.map(l=>({key:l.resource_key,token:l.fencing_token}));busyAfterCommit.exec('ROLLBACK');
   if(changedOwner){db.exec('BEGIN IMMEDIATE');db.prepare("UPDATE local_batch_locks SET owner_instance='changed-owner',fencing_token=fencing_token+1 WHERE resource_key=?").run(`account-set:${set.id}`);db.prepare('UPDATE local_batch_lock_epochs SET last_token=last_token+1 WHERE resource_key=?').run(`account-set:${set.id}`);db.exec('COMMIT');}
   const until=Date.now()+5000;while(S.listLocks(db).length>(changedOwner?1:0)){if(Date.now()>until)assert.fail('autonomous cleanup did not finish');await new Promise(r=>setTimeout(r,20));}
   if(changedOwner){const remaining=S.listLocks(db);assert.equal(remaining[0].owner_instance,'changed-owner');assert.equal(remaining[0].fencing_token,epochs.find(l=>l.key===`account-set:${set.id}`).token+1);S.releaseLock(db,{resourceKey:remaining[0].resource_key,instance:remaining[0].owner_instance,token:remaining[0].fencing_token});}
   for(const epoch of epochs)assert.ok(db.prepare('SELECT last_token FROM local_batch_lock_epochs WHERE resource_key=?').get(epoch.key).last_token>=epoch.token);assert.equal(db.prepare('SELECT state FROM audit_operations WHERE operation_id=?').get(operationId).state,'succeeded');
  }
 }finally{if(busyAfterCommit.isTransaction)busyAfterCommit.exec('ROLLBACK');busyAfterCommit.close();console.log('POST_COMMIT_BUSY_DB_CLOSED');}
 const C=await import('../server/local-audit-coordinator.mjs');
 // A real trigger invalidates the set epoch during the business write. The outer rolls everything back.
 const beforeVouchers=db.prepare('SELECT COUNT(*) n FROM vouchers').get().n;
 db.exec(`CREATE TRIGGER injected_epoch_loss AFTER INSERT ON vouchers BEGIN UPDATE local_batch_lock_epochs SET last_token=last_token+1 WHERE resource_key='account-set:${set.id}';UPDATE local_batch_locks SET fencing_token=fencing_token+1 WHERE resource_key='account-set:${set.id}'; END`);
 try{assert.throws(()=>A.createVoucher(set.id,{period:'2026-01',voucher_date:'2026-01-01',status:'posted',entries:[{code:'1002',debit:5},{code:'5001',credit:5}]}));assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,beforeVouchers);}finally{db.exec('DROP TRIGGER injected_epoch_loss');}
 const LB=await import('../server/local-backup.mjs');
 // Released history is independent of present business objects and remains strictly validated.
 db.prepare('INSERT INTO local_batch_lock_epochs VALUES(?,?)').run('account-set:999999',7);assert.equal(S.assertBatchSchema(db).version,3);
 db.prepare('INSERT INTO local_batch_lock_epochs VALUES(?,?)').run('book:OVERFLOW',Number.MAX_SAFE_INTEGER);assert.throws(()=>S.acquireLock(db,{resourceKey:'book:OVERFLOW',instance:'overflow',pid:process.pid}),e=>e.code==='lock_epoch_overflow');assert.equal(db.prepare('SELECT last_token FROM local_batch_lock_epochs WHERE resource_key=?').get('book:OVERFLOW').last_token,Number.MAX_SAFE_INTEGER);
 db.prepare('INSERT INTO local_batch_lock_epochs VALUES(?,?)').run('book: bad ',1);assert.equal(S.inspectBatchSchema(db).ok,false);assert.equal(LB.createBackup({dbPath:join(process.env.WORKBENCH_DATA_DIR,'workbench.db'),outDir:join(root,'bad')}).ok,false);db.prepare('DELETE FROM local_batch_lock_epochs WHERE resource_key=?').run('book: bad ');
 // Preserve strict v2 bytes/signature; only the official protected upgrade adds the epoch table.
 db.exec('DROP TABLE local_batch_lock_epochs; UPDATE local_batch_component SET version=2');assert.equal(S.assertBatchSchema(db).version,2);
 const file=join(process.env.WORKBENCH_DATA_DIR,'workbench.db');const historical=LB.createBackup({dbPath:file,outDir:join(root,'v2')});assert.equal(historical.ok,true);assert.equal(historical.manifest.components.find(c=>c.name==='local-batch').tables.length,11);assert.equal(LB.verifyBackup({backupDir:historical.backupDir}).ok,true);
 const upgraded=await S.installBatchSchema(db,{dbPath:file,outDir:join(root,'v2-up')});assert.equal(upgraded.to,3);assert.equal(S.assertBatchSchema(db).version,3);
 db.exec('DROP TABLE local_batch_lock_epochs; DROP TABLE local_batch_input_bindings; DROP TABLE local_batch_job_bindings; DROP TABLE local_batch_database_instances; UPDATE local_batch_component SET version=1');assert.equal(S.assertBatchSchema(db).version,1);
 const v1=LB.createBackup({dbPath:file,outDir:join(root,'v1')});assert.equal(v1.ok,true);assert.equal(v1.manifest.components.find(c=>c.name==='local-batch').tables.length,8);await S.installBatchSchema(db,{dbPath:file,outDir:join(root,'v1-up')});assert.equal(S.assertBatchSchema(db).version,3);
 const blockedLock=S.acquireLock(db,{resourceKey:'book:UPGRADE-ACTIVE',instance:'still-live',pid:process.pid});db.exec('DROP TABLE local_batch_lock_epochs;UPDATE local_batch_component SET version=2');const beforeUpgrade=db.prepare('SELECT * FROM local_batch_component').get();await assert.rejects(S.installBatchSchema(db,{dbPath:file,outDir:join(root,'blocked-up')}),e=>e.code==='batch_owner_active');assert.deepEqual(db.prepare('SELECT * FROM local_batch_component').get(),beforeUpgrade);S.releaseLock(db,{resourceKey:'book:UPGRADE-ACTIVE',instance:'still-live',token:blockedLock.token});await S.installBatchSchema(db,{dbPath:file,outDir:join(root,'v2-final')});
 const preCore=db.prepare('SELECT path FROM schema_backups ORDER BY id LIMIT 1').get().path;
 for(const coreVersion of [3,4]){const dir=join(root,'core'+coreVersion);mkdirSync(dir);const file=join(dir,'workbench.db');copyFileSync(preCore,file);const legacy=new DatabaseSync(file);try{legacy.exec('PRAGMA foreign_keys=ON');const I=await import('../server/import-storage.mjs');I.ensureImportSchema(legacy,{dataDir:dir,targetVersion:coreVersion});assert.equal(legacy.prepare("SELECT 1 FROM sqlite_master WHERE name='import_enterprise_account_sets'").get()===undefined,false);
   const created=legacy.prepare("INSERT INTO account_sets(name,start_period,created_at) VALUES('legacy-unbound','2026-01',?)").run(new Date().toISOString());const legacyId=Number(created.lastInsertRowid);legacy.prepare("INSERT INTO accounts(account_set_id,code,name,category,direction) VALUES(?,'1002','bank','资产','debit')").run(legacyId);
   const Bank=await import('../server/bank-storage.mjs'),Domain=await import('../server/bank-reconciliation.mjs'),Audit=await import('../server/local-audit-storage.mjs');await Bank.ensureBankSchema(legacy,{dbPath:file,dataDir:dir,backupService:LB});await Audit.installAuditSchema(legacy,{dbPath:file,outDir:join(dir,'audit')});
   assert.deepEqual(L.domainResources(legacy,{action:'bank.account.register',scope:{kind:'account_set',value:legacyId},request:{accountSetId:legacyId}}),[`account-set:${legacyId}`]);assert.equal(Domain.registerBankAccount(legacy,{accountSetId:legacyId,bankAccountId:'LEGACY',sourceId:'SYN',glAccountCode:'1002'}).created,true);assert.equal(S.assertBatchSchema(legacy).version,3);
   // A separate absent-table fallback probe is not called an official product backup.
   legacy.exec('DROP TABLE import_source_bindings; DROP TABLE import_enterprise_account_sets');assert.deepEqual(L.domainResources(legacy,{action:'bank.account.register',scope:{kind:'account_set',value:legacyId},request:{accountSetId:legacyId}}),[`account-set:${legacyId}`]);
  }finally{legacy.close();console.log('LEGACY_CORE_DB_CLOSED '+coreVersion);}}
 writeFileSync(join(root,'facts.json'),JSON.stringify({version:S.assertBatchSchema(db).version,epochs:db.prepare('SELECT * FROM local_batch_lock_epochs ORDER BY resource_key').all(),child:closed}));
 console.log('local-write-lock: domain, epochs, private/cross-handle capability, real PID takeover, full rollback and historical 1/2 protected upgrades passed');
}finally {if(db){db.close();console.log('DB_CLOSED');}}
