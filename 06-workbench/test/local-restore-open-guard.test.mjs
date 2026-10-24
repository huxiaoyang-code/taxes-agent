import {assert,fs,join,resolve,DatabaseSync,randomUUID,ROOT,S,LB,AS,fresh,logical,hash,child,suite,C,LR,args,backup,restore,target} from './local-restore-domain.test.mjs';
import {fileURLToPath} from 'node:url';
await suite('default startup and explicit domain/runner admissions refuse before callback, DDL and epochs',async()=>{
 const h=await fresh({audit:2,batch:3,bank:true,aux:true});try{
  const {file,a}=restore(h),before=hash(file),source=logical(h.db),d=new DatabaseSync(file);d.exec('PRAGMA foreign_keys=ON');
  try{
   let calls=0;const OP=await import('../server/local-audit-operation.mjs'),W=await import('../server/local-write-lock.mjs'),B=await import('../server/bank-storage.mjs'),X=await import('../server/auxiliary-accounting.mjs');
   const state=logical(d);
   for(const fn of [()=>C.assertRestoreWritable(d),()=>S.assertBatchRunnable(d),()=>S.acquireLock(d,{resourceKey:'account-set:1',instance:'old-authority',pid:process.pid}),()=>W.acquireWriteResources(d,['account-set:1']),()=>B.assertBankPublicAdmission(d)])assert.throws(fn,/restore_target_pending/);
   await assert.rejects(AS.installAuditSchema(d,{dbPath:file,outDir:join(h.dir,'audit-forbidden')}),/restore_target_pending/);await assert.rejects(S.installBatchSchema(d,{dbPath:file,outDir:join(h.dir,'batch-forbidden')}),/restore_target_pending/);
   assert.throws(()=>OP.prepareOperation(d,{context:{operationId:randomUUID(),actor:'domain',action:'voucher.post',attempt:1},scope:{kind:'database',value:null},request:{value:1}}),/restore_target_pending/);
   const AUX=await import('../server/auxiliary-storage.mjs');assert.throws(()=>AUX.auxTransaction(d,()=>calls++),/restore_target_pending/);assert.equal(calls,0);assert.equal(logical(d),state);
   d.exec('BEGIN');assert.throws(()=>W.acquireWriteResources(d,['account-set:1']),/restore_target_pending/);assert.equal(d.isTransaction,true);d.exec('ROLLBACK');assert.equal(logical(d),state);
  }finally{d.close();}
  for(const entry of ['server/db.mjs','server/accounting.mjs','server/agent-tools.mjs']){const c=await child(['--input-type=module','-e',`try{await import('./${entry}');throw Error('opened')}catch(e){if(e.code!=='restore_target_pending')throw e;console.log(e.code)}`],{env:{WORKBENCH_DATA_DIR:a.targetDir}});assert.equal(c.code,0,c.out+c.err);assert.equal(c.closed,true);}
  assert.equal(hash(file),before);assert.equal(logical(h.db),source);assert.equal(fs.existsSync(file+'-wal'),false);assert.equal(fs.existsSync(file+'-shm'),false);target(file,d=>assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check,'ok'));
  // Missing receipt or marker cannot make a controlled database writable.
  fs.renameSync(join(a.targetDir,'restore.json'),join(a.targetDir,'receipt.saved'));assert.throws(()=>C.assertRestoreOpenPath(file),/restore_target_pending/);assert.equal(hash(file),before);
  assert.equal(LB.createBackup({dbPath:file,outDir:join(h.dir,'pending-readonly-backup')}).ok,true);
 }finally{h.close();}
});
await suite('partial, half/future control and aliases refuse; fsync EIO closes only owned fds and preserves evidence',async()=>{
 const h=await fresh({audit:2,batch:3});try{
  const b=backup(h),a=args(b.backupDir,join(h.dir,'eio')),original=fs.fsyncSync,open=fs.openSync,close=fs.closeSync,owned=new Set();let injected=false;
  fs.openSync=function(p,...rest){const fd=open.call(fs,p,...rest);if(String(p).startsWith(a.targetDir))owned.add(fd);return fd;};fs.closeSync=function(fd){const r=close.call(fs,fd);owned.delete(fd);return r;};fs.fsyncSync=function(fd){if(owned.has(fd)){injected=true;throw Object.assign(Error('synthetic'),{code:'EIO'});}return original.call(fs,fd);};
  let r;try{r=LB.restoreNew(a);}finally{fs.fsyncSync=original;fs.openSync=open;fs.closeSync=close;}
  assert.equal(injected,true);assert.equal(r.ok,false);assert.equal(owned.size,0);assert.equal(fs.existsSync(join(a.targetDir,'workbench.db')),false);assert.equal(fs.existsSync(a.targetDir),true);assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,true);
  const good=restore(h,b),d=new DatabaseSync(good.file);try{d.exec('DROP TABLE restore_control_state');assert.equal(C.inspectRestoreControl(d).ok,false);assert.throws(()=>C.assertRestoreWritable(d),/restore_control_invalid/);}finally{d.close();}
  const partial=join(h.dir,'.partial-'+randomUUID()+'.db');fs.copyFileSync(h.file,partial);assert.throws(()=>C.assertRestoreOpenPath(partial),/restore_target_pending/);
  const hard=join(h.dir,'hard.db');fs.linkSync(h.file,hard);assert.throws(()=>C.plainRestorePath(hard),/restore_target_binding_mismatch/);assert.equal(LB.restoreNew(args(b.backupDir,join(h.dir,'alias-target'))).ok,true);
 }finally{h.close();}
});
await suite('lost marker after actual copy/control crash never admits a new standard DB or Agent',async()=>{
 for(const window of ['copy','control-commit']){
  const h=await fresh({audit:2,batch:3});try{
   const b=backup(h),a=args(b.backupDir,join(h.dir,'lost-'+window)),source=logical(h.db),snapshot=hash(join(b.backupDir,LB.SNAPSHOT_FILE));
   const code=`import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';const a=JSON.parse(process.argv[1]),mode=process.argv[2];let copied=false;const cp=fs.copyFileSync;fs.copyFileSync=function(...v){const r=cp.apply(fs,v);copied=true;if(mode==='copy')process.exit(92);return r};const ex=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){const r=ex.call(this,sql);if(copied&&mode==='control-commit'&&sql==='COMMIT'&&this.prepare("SELECT 1 FROM sqlite_master WHERE name='restore_control_state'").get())process.exit(92);return r};const LB=await import('./server/local-backup.mjs');console.log(LB.restoreNew(a));throw Error('crash was not reached');`;
   const crashed=await child(['--input-type=module','-e',code,JSON.stringify(a),window]);assert.equal(crashed.code,92,crashed.out+crashed.err);assert.equal(crashed.closed,true);
   const partial=fs.readdirSync(a.targetDir).filter(n=>n.startsWith('.partial-')&&n.endsWith('.db'));assert.equal(partial.length,1);const partialFile=join(a.targetDir,partial[0]),partialHash=hash(partialFile),ledgerHash=hash(a.ledgerPath);
   // Simulate the operator losing only the disposable marker, preserving it under an explicit name.
   fs.renameSync(join(a.targetDir,'.restore-incomplete'),join(a.targetDir,'marker.saved'));
   for(const entry of ['server/db.mjs','server/agent-tools.mjs','server/server.mjs']){
    const denied=await child(['--input-type=module','-e',`let callbacks=0;try{await import('./${entry}');callbacks++;throw Error('opened')}catch(e){if(e.code!=='restore_target_pending')throw e;if(callbacks!==0)throw Error('callback reached');console.log(e.code)}`],{env:{WORKBENCH_DATA_DIR:a.targetDir}});assert.equal(denied.code,0,denied.out+denied.err);assert.equal(denied.closed,true);
   }
   assert.equal(fs.existsSync(join(a.targetDir,'workbench.db')),false);for(const suffix of ['-wal','-shm','-journal'])assert.equal(fs.existsSync(join(a.targetDir,'workbench.db'+suffix)),false);assert.equal(hash(partialFile),partialHash);assert.equal(hash(a.ledgerPath),ledgerHash);assert.equal(hash(join(b.backupDir,LB.SNAPSHOT_FILE)),snapshot);assert.equal(logical(h.db),source);
  }finally{h.close();}
 }
 class ArraySubclass extends Array{};assert.throws(()=>C.restoreHash(new ArraySubclass(1,2)),/restore_contract_required/);
});
await suite('non-equivalent CHECK literal case drift with otherwise legal rows rejects inspect and official backup',async()=>{
 const h=await fresh({audit:2,batch:3});try{
  const b=backup(h);
  for(const attack of [{table:'restore_control_component',from:"'restore-control'",to:"'RESTORE-CONTROL'"},{table:'restore_control_state',from:"'pending'",to:"'PENDING'"}]){
   const {file}=restore(h,b),d=new DatabaseSync(file);try{
    const rows=d.prepare('SELECT * FROM '+attack.table).all(),sql=d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(attack.table).sql;
    d.exec('PRAGMA ignore_check_constraints=ON;DROP TABLE '+attack.table);const drift=sql.replaceAll(attack.from,attack.to);assert.notEqual(drift,sql);d.exec(drift);
    for(const row of rows){const keys=Object.keys(row);d.prepare('INSERT INTO '+attack.table+' ('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...Object.values(row));}d.exec('PRAGMA ignore_check_constraints=OFF');
    assert.equal(C.inspectRestoreControl(d).ok,false);assert.throws(()=>C.assertRestoreWritable(d),/restore_control_invalid/);assert.equal(LB.createBackup({dbPath:file,outDir:join(h.dir,randomUUID())}).ok,false);
   }finally{d.close();}
  }
 }finally{h.close();}
});
await suite('explicit directory ancestors are plain before any retained-artifact scan',async()=>{
 const h=await fresh({audit:2,batch:3});try{
  const b=backup(h),{a}=restore(h,b),before=logical(h.db),snapshot=hash(join(b.backupDir,LB.SNAPSHOT_FILE)),ledger=hash(a.ledgerPath);
  const owned=join(h.dir,'owned-other-root'),alias=join(h.dir,'junction');fs.mkdirSync(owned);fs.mkdirSync(join(owned,'nested'));fs.writeFileSync(join(owned,'.partial-'+randomUUID()+'.db'),'owned retained artifact');fs.symlinkSync(owned,alias,'junction');assert.equal(fs.lstatSync(alias).isSymbolicLink(),true);
  const list=fs.readdirSync;let scans=0;fs.readdirSync=function(...v){scans++;return list.apply(fs,v);};
  try{for(const dir of [alias,join(alias,'nested')])assert.throws(()=>C.assertRestoreOpenPath(join(dir,'workbench.db')),e=>e.code==='restore_target_binding_mismatch');assert.equal(scans,0,'readdir must never reach the alias root or any child through it');}
  finally{fs.readdirSync=list;}
  for(const dir of [owned,join(owned,'nested')])for(const suffix of ['','-wal','-shm','-journal'])assert.equal(fs.existsSync(join(dir,'workbench.db'+suffix)),false);
  assert.equal(logical(h.db),before);assert.equal(hash(join(b.backupDir,LB.SNAPSHOT_FILE)),snapshot);assert.equal(hash(a.ledgerPath),ledger);
  // A missing, non-aliased fresh directory is still admitted without creating it.
  const missing=join(h.dir,'missing-fresh');C.assertRestoreOpenPath(join(missing,'workbench.db'));assert.equal(fs.existsSync(missing),false);
 }finally{h.close();}
});
console.log('local-restore-open-guard PASS');
