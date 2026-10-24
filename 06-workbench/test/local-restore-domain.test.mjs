import {assert,fs,join,resolve,DatabaseSync,randomUUID,ROOT,S,LB,AS,fresh,job,logical,hash,child,suite} from './local-batch-install.test.mjs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as C from '../server/local-restore-control.mjs';
import * as LR from '../server/local-restore-audit.mjs';
export {assert,fs,join,resolve,DatabaseSync,randomUUID,ROOT,S,LB,AS,fresh,job,logical,hash,child,suite,C,LR};
export function args(backupDir,targetDir){const root=join(dirname(ROOT),'s-'+randomUUID());fs.mkdirSync(root);C.plainRestorePath(root,{directory:true});return {backupDir,targetDir,ledgerPath:join(root,'ledger.db'),operationId:randomUUID()};}
export function backup(h,name=randomUUID()){const b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,name)});assert.equal(b.ok,true,JSON.stringify(b));assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,true);return b;}
export function restore(h,b=backup(h)){const a=args(b.backupDir,join(h.dir,randomUUID())),r=LB.restoreNew(a);assert.equal(r.ok,true,JSON.stringify(r));return {a,r,file:join(a.targetDir,'workbench.db')};}
export function target(file,fn){const db=new DatabaseSync(file,{readOnly:true});try{return fn(db);}finally{db.close();console.log('target actualclose');}}
export function preserved(source,copy){for(const table of LB.backupContract().requiredTables){assert.deepEqual(copy.prepare('SELECT * FROM "'+table+'" ORDER BY rowid').all(),source.prepare('SELECT * FROM "'+table+'" ORDER BY rowid').all(),table);}}
const FROZEN_LEDGER1_DDL="CREATE TABLE restore_ledger_meta (\n     component TEXT PRIMARY KEY,\n     version INTEGER NOT NULL,\n     installed_at TEXT NOT NULL,\n     note TEXT\n   );\nCREATE TABLE restore_operations (\n     operation_id TEXT PRIMARY KEY,\n     started_at TEXT NOT NULL,\n     updated_at TEXT NOT NULL,\n     status TEXT NOT NULL,\n     result_code TEXT NOT NULL,\n     reason_code TEXT NOT NULL DEFAULT 'none',\n     backup_digest TEXT NOT NULL,\n     backup_bytes INTEGER NOT NULL,\n     backup_schema_version INTEGER,\n     component_versions TEXT NOT NULL,\n     producer TEXT NOT NULL,\n     receipt TEXT,\n     target_digest TEXT,\n     target_instance_id TEXT,\n     prepared_at TEXT,\n     published_at TEXT,\n     terminal_at TEXT,\n     attempts INTEGER NOT NULL DEFAULT 1,\n     note_code TEXT\n   );\nCREATE INDEX idx_restore_operations_status ON restore_operations (status, started_at);\nCREATE TABLE restore_operation_events (\n     id INTEGER PRIMARY KEY AUTOINCREMENT,\n     operation_id TEXT NOT NULL,\n     at TEXT NOT NULL,\n     from_status TEXT,\n     to_status TEXT NOT NULL,\n     result_code TEXT NOT NULL,\n     reason_code TEXT NOT NULL DEFAULT 'none',\n     note_code TEXT\n   );\nCREATE INDEX idx_restore_events_operation ON restore_operation_events (operation_id, id);\nCREATE TRIGGER restore_events_no_update BEFORE UPDATE ON restore_operation_events\n     BEGIN SELECT RAISE(ABORT, 'restore_events_append_only'); END;\nCREATE TRIGGER restore_events_no_delete BEFORE DELETE ON restore_operation_events\n     BEGIN SELECT RAISE(ABORT, 'restore_events_append_only'); END;\nCREATE TRIGGER restore_events_no_replace BEFORE INSERT ON restore_operation_events\n     WHEN EXISTS (SELECT 1 FROM restore_operation_events WHERE id = NEW.id)\n     BEGIN SELECT RAISE(ABORT, 'restore_events_append_only'); END";

export function testLedgerLiteral(){
 const root=join(ROOT,randomUUID());fs.mkdirSync(root);const path=join(root,'literal-ledger.db'),d=LR.openRestoreLedger(path,{create:true});
 try{
  LR.beginRestoreOperation(d,{operationId:randomUUID(),backupDigest:'a'.repeat(64),backupBytes:4096,backupSchemaVersion:5,componentVersions:{core:5},producer:'literal-test',targetInstanceId:randomUUID(),targetBindingDigest:'1'.repeat(64)});
  const rows=d.prepare('SELECT * FROM restore_operations').all(),objects=d.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='restore_operations' AND sql IS NOT NULL ORDER BY type,name").all(),table=objects.find(r=>r.type==='table').sql;
  const changed=table.replaceAll('[^a-f0-9]','[^A-F0-9]');assert.notEqual(changed,table);d.exec('DROP TABLE restore_operations');d.exec(changed);
  for(const row of rows){const keys=Object.keys(row);d.prepare('INSERT INTO restore_operations('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...Object.values(row));}
  for(const object of objects.filter(r=>r.type!=='table'))d.exec(object.sql);
  // The digit-only digest obeys both CHECKs; only exact DDL semantics can detect the drift.
  assert.equal(d.prepare('SELECT target_binding_digest FROM restore_operations').get().target_binding_digest,'1'.repeat(64));assert.equal(LR.inspectRestoreLedger(d).ok,false);assert.throws(()=>LR.getRestoreOperation(d,rows[0].operation_id),/restore_ledger_inconsistent/);
 }finally{d.close();console.log('literal ledger actualclose');}
 console.log('PASS ledger2 literal GLOB case drift rejected with otherwise legal bound row');
}

if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
 for(const config of [{version:3},{version:4,audit:1},{version:5},{version:5,audit:2},{version:5,batch:1},{version:5,batch:3},{version:5,audit:2,batch:3},{version:5,audit:1,batch:2}])await suite('restore real strict version '+JSON.stringify(config),async()=>{
  const h=await fresh(config);try{
   if(!h.db.prepare("SELECT 1 FROM account_sets WHERE id=1").get()){h.db.prepare("INSERT INTO account_sets(id,name,start_period,created_at) VALUES(1,?,?,?)").run("Synthetic legacy","2026-01",new Date().toISOString());h.db.prepare("INSERT INTO accounts(account_set_id,code,name,category,direction) VALUES(1,?,?,?,?,?)".replace("?,?,?,?,?","?,?,?,?")).run("1002","银行","asset","debit");h.db.prepare("INSERT INTO opening_balances VALUES(1,?,?,?)").run("1002",91.37,0);}

   const before=logical(h.db),sourceAudit=AS.inspectAuditSchema(h.db).activeInstanceId??null,batch=S.inspectBatchSchema(h.db),oldBatch=batch.version>=2?S.readBatchInstance(h.db).instance_id:null;
   if(batch.version===3){const lock=S.acquireLock(h.db,{resourceKey:'account-set:1',instance:'source-live-'+randomUUID(),pid:process.pid});assert.ok(lock.token);}
   const held=logical(h.db),b=backup(h),snapshotHash=hash(join(b.backupDir,LB.SNAPSHOT_FILE)),{a,r,file}=restore(h,b);
   assert.equal(logical(h.db),held);assert.equal(hash(join(b.backupDir,LB.SNAPSHOT_FILE)),snapshotHash);assert.equal(r.receipt.receiptVersion,2);assert.equal(r.receipt.source.snapshot.sha256,snapshotHash);assert.notEqual(r.receipt.target.database.sha256,snapshotHash);assert.equal(r.receipt.target.writeState,'pending');assert.equal(C.isRestoreUuid(r.receipt.targetInstanceId),true);
   target(file,d=>{preserved(h.db,d);assert.equal(C.assertRestoreControl(d).row.write_state,'pending');assert.throws(()=>C.assertRestoreWritable(d),/restore_target_pending/);assert.equal(AS.inspectAuditSchema(d).version,config.audit??0);assert.equal(S.inspectBatchSchema(d).version,config.batch??0);
    if(sourceAudit){const id=AS.currentAuditInstanceId(d);assert.notEqual(id,sourceAudit);assert.equal(d.prepare('SELECT parent_instance_id FROM audit_database_instances WHERE is_active=1').get().parent_instance_id,sourceAudit);}
    if(oldBatch){assert.notEqual(S.readBatchInstance(d).instance_id,oldBatch);assert.equal(S.readBatchInstance(d).parent_instance_id,oldBatch);assert.equal(S.readBatchInstance(d).write_state,'restore_pending');}
    if(batch.version){assert.equal(d.prepare('SELECT COUNT(*) n FROM local_batch_locks').get().n,0);assert.throws(()=>S.assertBatchRunnable(d),/restore_target_pending/);}
    if(batch.version===3){const old=h.db.prepare('SELECT * FROM local_batch_lock_epochs').all(),next=d.prepare('SELECT * FROM local_batch_lock_epochs').all();assert.deepEqual(next.map(v=>({...v})),old.map(v=>({...v,last_token:v.last_token+1})));}
   });
   assert.equal(LB.reconcileRestore(a).ok,true);assert.equal(logical(h.db),held);
   if(batch.version===3){h.db.exec('DELETE FROM local_batch_locks');assert.equal(S.assertBatchRunnable(h.db).write_state,'ready');}
   h.db.prepare("UPDATE account_sets SET name=name||' source-continues' WHERE id=1").run();assert.ok(h.db.prepare('SELECT name FROM account_sets WHERE id=1').get().name.endsWith('source-continues'));
  }finally{h.close();}
 });
 await suite('pending backup preservation and restore again creates separate control and audit identities',async()=>{
  const h=await fresh({audit:2,batch:3});try{const one=restore(h),b=LB.createBackup({dbPath:one.file,outDir:join(h.dir,'pending-backup')});assert.equal(b.ok,true,JSON.stringify(b));assert.ok(b.manifest.components.some(c=>c.name==='restore-control'));const a=args(b.backupDir,join(h.dir,'second')),two=LB.restoreNew(a);assert.equal(two.ok,true,JSON.stringify(two));assert.equal(two.receipt.source.controlTargetInstanceId,one.r.receipt.targetInstanceId);assert.notEqual(two.receipt.targetInstanceId,one.r.receipt.targetInstanceId);assert.equal(two.receipt.source.auditInstanceId,one.r.receipt.target.auditInstanceId);}finally{h.close();}
 });
 await suite('control exact DDL/content, getters/proxies, fake capability and target binding are rejected',async()=>{
  let traps=0;const proxy=new Proxy({},{get(){traps++;throw Error('trap')}}),getter={};Object.defineProperty(getter,'x',{enumerable:true,get(){traps++;return 1}});for(const v of [proxy,getter,{x:Infinity},{x:1.5}])assert.throws(()=>C.restoreHash(v));assert.equal(traps,0);
  const h=await fresh({audit:2,batch:3});try{const {file,a}=restore(h);const d=new DatabaseSync(file);try{d.exec('PRAGMA foreign_keys=ON');assert.throws(()=>AS.markAuditInstanceFork(d,{capability:{}}),/restore_contract_required/);const original=logical(d);await assert.rejects(AS.installAuditSchema(d,{dbPath:file,outDir:join(h.dir,'no-install')}),/restore_target_pending/);await assert.rejects(S.installBatchSchema(d,{dbPath:file,outDir:join(h.dir,'no-batch')}),/restore_target_pending/);assert.equal(logical(d),original);
   d.exec('CREATE INDEX restore_control_extra ON restore_control_state(write_state)');assert.equal(C.inspectRestoreControl(d).ok,false);assert.equal(LB.createBackup({dbPath:file,outDir:join(h.dir,'bad-control')}).ok,false);
  }finally{d.close();}assert.equal(LB.reconcileRestore(a).ok,false);}finally{h.close();}
 });

 await suite('frozen ledger1 protection copies exact history/sequence; failure is zero change and legacy IDs stay read-only',async()=>{
  const root=join(ROOT,randomUUID());fs.mkdirSync(root);const path=join(root,'ledger1.db'),d=new DatabaseSync(path),at='2026-10-20T00:00:00.000Z',digest='a'.repeat(64),receipt='b'.repeat(64);
  try{d.exec(FROZEN_LEDGER1_DDL);d.prepare('INSERT INTO restore_ledger_meta VALUES(?,?,?,?)').run('restore-ledger',1,at,'legacy');
   d.prepare("INSERT INTO restore_operations VALUES(?,?,?,'succeeded','restore_new_succeeded','none',?,4096,4,?,'old-producer',?,?,'instance-1',?,?,?,3,NULL)").run('old-op',at,at,digest,JSON.stringify({core:4}),receipt,'c'.repeat(64),at,at,at);
   for(const [id,from,to,result] of [[7,null,'started','restore_started'],[8,'started','prepared','restore_prepared'],[9,'prepared','succeeded','restore_new_succeeded']])d.prepare("INSERT INTO restore_operation_events VALUES(?,?,?, ?,?,?, 'none',NULL)").run(id,'old-op',at,from,to,result);
   assert.equal(LR.inspectRestoreLedger(d).version,1);assert.equal(LR.inspectRestoreLedger(d).ok,true);
  }finally{d.close();}
  const before=hash(path),old=LR.openRestoreLedger(path,{readOnly:true});try{assert.equal(LR.getRestoreOperation(old,'old-op').targetInstanceId,'instance-1');assert.equal(LR.getRestoreOperation(old,'old-op').bindingVersion,0);}finally{old.close();}
  const sync=fs.fsyncSync;fs.fsyncSync=()=>{throw Object.assign(Error('synthetic EIO'),{code:'EIO'})};try{assert.throws(()=>LR.upgradeRestoreLedger(path,{backupPath:join(root,'failed-protection.db')}));}finally{fs.fsyncSync=sync;}assert.equal(hash(path),before);assert.equal(fs.existsSync(join(root,'failed-protection.db')),true);
  const protectedFile=join(root,'protected-ledger1.db');assert.equal(LR.upgradeRestoreLedger(path,{backupPath:protectedFile}).version,2);const upgraded=LR.openRestoreLedger(path),copy=LR.openRestoreLedger(protectedFile,{readOnly:true});
  try{assert.equal(C.isRestoreUuid(LR.restoreLedgerId(upgraded)),true);const original=LR.getRestoreOperation(copy,'old-op'),current=LR.getRestoreOperation(upgraded,'old-op');assert.deepEqual(current,original);assert.deepEqual(LR.listRestoreTransitions(upgraded,'old-op'),LR.listRestoreTransitions(copy,'old-op'));assert.deepEqual(upgraded.prepare('SELECT * FROM sqlite_sequence').all(),copy.prepare('SELECT * FROM sqlite_sequence').all());assert.throws(()=>LR.reconcileRestoreOperation(upgraded,{operationId:'old-op',verifyPublished:()=>{throw Error('must never run')}}),/restore_contract_required/);assert.throws(()=>upgraded.prepare('UPDATE restore_operations SET target_instance_id=?').run(randomUUID()),/restore_binding_immutable/);
  }finally{upgraded.close();copy.close();}
 });

 await suite('ledger2 exact GLOB literal semantics',testLedgerLiteral);
 console.log('local-restore-domain PASS');
}
