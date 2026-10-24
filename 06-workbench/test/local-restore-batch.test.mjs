// W4b explicit activation: synthetic strict databases and real CLI children only.
import {assert,fs,join,resolve,DatabaseSync,randomUUID,pathToFileURL,ROOT,S,LB,AS,fresh,job,logical,hash,child,suite} from './local-batch-install.test.mjs';
import {dirname} from 'node:path';
import * as C from '../server/local-restore-control.mjs';
import * as RB from '../server/local-restore-batch.mjs';
export {assert,fs,join,resolve,DatabaseSync,randomUUID,pathToFileURL,ROOT,S,LB,AS,fresh,job,logical,hash,child,suite,C,RB};
export function explicitRestore(h) {
 const backupDir=join(h.dir,randomUUID()),targetDir=join(h.dir,randomUUID()),ledgerRoot=join(dirname(ROOT),randomUUID());fs.mkdirSync(ledgerRoot);
 const b=LB.createBackup({dbPath:h.file,outDir:backupDir});assert.equal(b.ok,true,JSON.stringify(b));
 const args={backupDir,targetDir,ledgerPath:join(ledgerRoot,'restore.db'),operationId:randomUUID()};
 const r=LB.restoreNew(args);assert.equal(r.ok,true,JSON.stringify(r));return {args,file:join(targetDir,'workbench.db'),receipt:r.receipt};
}
export function readDb(file,fn,{write=false}={}){const d=new DatabaseSync(file,{readOnly:!write});try{if(write)d.exec('PRAGMA foreign_keys=ON');return fn(d);}finally{d.close();console.log('actual DB close '+file);}}
export function planFor(file,{mode='saved_snapshot',reportAction='review',prefix=dirname(file)}={}) {
 return readDb(file,d=>({version:1,targetInstanceId:C.assertRestoreControl(d).row.target_instance_id,jobs:RB.restorePlanRequirements(d).map(j=>({jobKey:j.jobKey,outputRoot:join(dirname(prefix),randomUUID()),inputs:j.inputs.map(i=>({inputKey:i.inputKey,mode,source:null})),reports:j.reports.map(r=>({stageId:r.stageId,action:reportAction}))}))}));
}
export async function cli(command,args,{plan,outDir,extra=[]}={}) {
 const flags=[command,'--data-dir',args.targetDir,'--backup',args.backupDir,'--ledger',args.ledgerPath,'--operation',args.operationId];
 if(plan){const file=join(dirname(args.targetDir),randomUUID()+'.json');fs.writeFileSync(file,JSON.stringify(plan));flags.push('--plan',file);}
 if(outDir)flags.push('--out-dir',outDir);
 const r=await child(['scripts/local-batch.mjs',...flags,...extra]);
 const result=JSON.parse(r.out.trim().split(/\r?\n/).at(-1));return {...r,result};
}
async function main(){
 await suite('read-only check and real CLI activation install exact legal component combinations',async()=>{
  for(const options of [{audit:2,batch:3},{audit:0,batch:3},{audit:1,batch:2},{audit:0,batch:1},{version:3},{version:4}]){
   const h=await fresh(options);try{
    if(options.batch===3)job(h,{file:true});
    const source=logical(h.db),r=explicitRestore(h),before=hash(r.file),receiptBefore=hash(join(r.args.targetDir,'restore.json')),ledgerBefore=hash(r.args.ledgerPath),plan=planFor(r.file),outDir=join(h.dir,randomUUID());
    const check=await cli('restore-check',r.args);assert.equal(check.code,0,check.out+check.err);assert.equal(check.result.writeState,'pending');assert.equal(hash(r.file),before);
    const a=await cli('restore-activate',r.args,{plan,outDir});assert.equal(a.code,0,a.out+a.err);assert.equal(a.result.protectionVerified,true);
    const v=LB.verifyBackup({backupDir:outDir});assert.equal(v.ok,true,JSON.stringify(v));
    readDb(join(outDir,LB.SNAPSHOT_FILE),d=>{assert.equal(C.assertRestoreControl(d).row.write_state,'pending');assert.equal(d.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,options.version??5);});
    readDb(r.file,d=>{LB.assertSupportedDatabaseConnection(d);assert.equal(C.assertRestoreControl(d).row.write_state,'ready');assert.equal(AS.inspectAuditSchema(d).version,2);assert.equal(S.assertBatchSchema(d).version,3);assert.equal(d.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,5);assert.equal(d.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'bank_%' OR name LIKE 'aux_%'").get().n,0);assert.equal(d.prepare("SELECT COUNT(*) n FROM audit_operations WHERE action='restore.activate' AND state='succeeded'").get().n,1);if(options.version)assert.equal(d.prepare('SELECT COUNT(*) n FROM account_sets WHERE accounting_profile_id<>?').get('legacy-small-coa-v1').n,0);if(r.receipt.target.auditInstanceId)assert.equal(AS.currentAuditInstanceId(d),r.receipt.target.auditInstanceId);if(r.receipt.target.batchInstanceId)assert.equal(S.readBatchInstance(d).instance_id,r.receipt.target.batchInstanceId);});
    const current=hash(r.file),replay=await cli('restore-activate',r.args,{plan,outDir});assert.equal(replay.code,0,replay.out+replay.err);assert.equal(replay.result.replayed,true);assert.equal(hash(r.file),current);
    assert.equal(LB.reconcileRestore(r.args).ok,true,'ready uses real immutable protection/activation evidence');assert.equal(hash(join(r.args.targetDir,'restore.json')),receiptBefore);assert.equal(hash(r.args.ledgerPath),ledgerBefore);assert.equal(logical(h.db),source);
    if(plan.jobs.length){const conflict=structuredClone(plan);conflict.jobs[0].outputRoot=join(h.dir,randomUUID());const c=await cli('restore-activate',r.args,{plan:conflict,outDir});assert.equal(c.code,2);assert.equal(c.result.code,'restore_plan_conflict');}
   }finally{h.close();}
  }
 });
 await suite('pending rejects normal mutators, fake rights, wrong durable bindings and caller transaction',async()=>{
  const h=await fresh({audit:2,batch:3});try{job(h);const r=explicitRestore(h),before=hash(r.file),plan=planFor(r.file);
   await readDb(r.file,async d=>{},{});
   const d=new DatabaseSync(r.file);try{d.exec('PRAGMA foreign_keys=ON');assert.throws(()=>S.refreshStatuses(d,1),/restore_target_pending/);assert.throws(()=>S.acquireLock(d,{resourceKey:'job:1',instance:'fake',pid:process.pid}),/restore_target_pending/);await assert.rejects(AS.installAuditSchema(d,{dbPath:r.file,outDir:join(h.dir,randomUUID())}),/restore_target_pending/);d.exec('BEGIN');assert.throws(()=>LB.assertPrivateRestoreCapability(d,{}),/restore_contract_required/);const b=await RB.activateRestoreBatch({...r.args,plan,outDir:join(h.dir,randomUUID()),db:d});assert.equal(b.ok,false);assert.equal(d.isTransaction,true);d.exec('ROLLBACK');}finally{d.close();}
   let callbacks=0;const bad=await RB.activateRestoreBatch({...r.args,plan,outDir:join(h.dir,randomUUID()),verify:()=>{callbacks++;return true;}});assert.equal(bad.ok,false);assert.equal(callbacks,0);
   for(const changed of [{operationId:randomUUID()},{targetDir:h.dir}])assert.equal((await RB.checkRestoreBatch({...r.args,...changed})).ok,false);
   const missing=structuredClone(plan);missing.jobs=[];assert.equal((await RB.activateRestoreBatch({...r.args,plan:missing,outDir:join(h.dir,randomUUID())})).ok,false);
   const unknown=structuredClone(plan);unknown.force=true;assert.equal((await RB.activateRestoreBatch({...r.args,plan:unknown,outDir:join(h.dir,randomUUID())})).ok,false);
   assert.equal(hash(r.file),before);assert.equal(LB.reconcileRestore(r.args).ok,true);
  }finally{h.close();}
 });
 await suite('protection or commit-boundary failure rolls back exact pending target and retains artifacts',async()=>{
  const h=await fresh({version:3});try{const r=explicitRestore(h),plan=planFor(r.file),before=hash(r.file),outDir=join(h.dir,randomUUID());
   // Real fsync failure after official backup creation: no DDL or ready survives.
   const original=fs.fsyncSync;let count=0;fs.fsyncSync=(...a)=>{count++;if(count===1)throw Object.assign(Error('synthetic EIO'),{code:'EIO'});return original(...a);};
   let failed;try{failed=await RB.activateRestoreBatch({...r.args,plan,outDir});}finally{fs.fsyncSync=original;}
   assert.equal(failed.ok,false);assert.equal(hash(r.file),before);readDb(r.file,d=>{assert.equal(C.assertRestoreControl(d).row.write_state,'pending');assert.equal(d.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,3);});assert.equal(fs.existsSync(outDir),true);
   const retry=await cli('restore-activate',r.args,{plan,outDir:join(h.dir,randomUUID())});assert.equal(retry.code,0,retry.out+retry.err);
  }finally{h.close();}
 });
 await suite('actual abrupt maintenance exit and lost COMMIT acknowledgement reconcile without repeat installation',async()=>{
  for(const mode of ['precommit','postcommit']){
   const h=await fresh({version:3});try{const r=explicitRestore(h),plan=planFor(r.file),outDir=join(h.dir,randomUUID()),input={...r.args,plan,outDir};
    const code=`import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {syncBuiltinESMExports} from 'node:module';const args=${JSON.stringify(input)};const fds=new Map(),open=fs.openSync,close=fs.closeSync,sync=fs.fsyncSync;fs.openSync=function(p,...a){const fd=open.call(this,p,...a);fds.set(fd,String(p));return fd;};fs.closeSync=function(fd,...a){fds.delete(fd);return close.call(this,fd,...a);};fs.fsyncSync=function(fd,...a){const r=sync.call(this,fd,...a);if(${JSON.stringify(mode)}==='precommit'&&fds.get(fd)?.endsWith('restore-activation.json'))process.exit(73);return r;};const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql,...a){const r=exec.call(this,sql,...a);if(${JSON.stringify(mode)}==='postcommit'&&sql==='COMMIT'&&this.prepare("SELECT 1 FROM sqlite_master WHERE name='restore_control_state'").get()&&this.prepare('SELECT write_state FROM restore_control_state').get()?.write_state==='ready')throw Error('lost actual COMMIT acknowledgement');return r;};syncBuiltinESMExports();const api=await import('./server/local-restore-batch.mjs');console.log(JSON.stringify(await api.activateRestoreBatch(args)));`;
    const exited=await child(['--input-type=module','-e',code]);assert.equal(exited.code,mode==='precommit'?73:0,exited.out+exited.err);
    if(mode==='postcommit')assert.equal(JSON.parse(exited.out.trim()).status,'unknown');
    else {assert.equal(fs.existsSync(join(r.args.targetDir,'restore-maintenance.json')),true);assert.equal((await RB.checkRestoreBatch(r.args)).ok,false);}
    const recovered=await cli('restore-activate',r.args,{plan,outDir});assert.equal(recovered.code,0,recovered.out+recovered.err);
    readDb(r.file,d=>{assert.equal(C.assertRestoreControl(d).row.write_state,'ready');assert.equal(AS.inspectAuditSchema(d).version,2);assert.equal(S.assertBatchSchema(d).version,3);assert.equal(d.prepare("SELECT COUNT(*) n FROM audit_operations WHERE action='restore.activate'").get().n,1);});
    assert.equal(LB.reconcileRestore(r.args).ok,true);
   }finally{h.close();}
  }
 });
 console.log('local-restore-batch PASS retained '+ROOT);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
