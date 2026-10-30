import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
export { assert,fs,join,DatabaseSync };
export async function harness({install=true,bank=false}={}) {
 const work=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
 const verify=p=>{ for(let x=p;;x=dirname(x)) {assert.equal(fs.lstatSync(x).isSymbolicLink(),false);assert.equal(fs.realpathSync.native(x).toLowerCase(),resolve(x).toLowerCase());if(dirname(x)===x)break;} };
 verify(work); const root=join(work,'.agent-runs','aux-tests-'+randomUUID()); fs.mkdirSync(root,{recursive:true});verify(root); const data=join(root,'data');fs.mkdirSync(data);verify(data);
 process.env.TEMP=root;process.env.TMP=root;process.env.WORKBENCH_DATA_DIR=data;
 const {db}=await import('../server/db.mjs'); const A=await import('../server/accounting.mjs'),X=await import('../server/auxiliary-accounting.mjs'),S=await import('../server/auxiliary-storage.mjs'),LB=await import('../server/local-backup.mjs');
 const dbPath=join(data,'workbench.db');
 if(bank) { const B=await import('../server/bank-storage.mjs'); await B.ensureBankSchema(db,{dbPath,backupService:LB,dataDir:data}); }
 if(install) await S.ensureAuxiliarySchema(db,{dbPath,outDir:join(root,'before-aux')});
 const makeSet=(suffix,profileId='small-2011-basic-v1')=>A.createAccountSet({name:'Synthetic '+suffix,start_period:'2025-12',profileId,enterprise:{enterpriseKey:'SYNTH-'+suffix,enterpriseName:'Synthetic '+suffix}}).id;
 let sequence=0;
 const entity=(accountSetId,kind,code)=>X.createAuxiliaryEntity(db,{accountSetId,kind,code,name:'Same display',requestId:'create-'+(++sequence)}).id;
 const allocate=(accountSetId,target,allocations,requestId='assign-'+(++sequence))=>X.replaceAuxiliaryAllocations(db,{accountSetId,...target,allocations,requestId,reason:'synthetic allocation'});
 const voucher=(setId,period,entries)=>A.createVoucher(setId,{period,voucher_date:period+'-15',number:++sequence,entries});
 return {root,data,dbPath,db,A,X,S,LB,makeSet,entity,allocate,voucher};
}
export async function suite(name,fn) { const h=await harness(); try {await fn(h);console.log(name+' PASS');} finally {h.db.close();console.log(name+' database closed');} }
if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)) {
 const h=await harness({install:false}); const {db,dbPath,root,S,LB,makeSet,entity,allocate,voucher,A}=h;
 try {
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'aux_%'").get().n,0);
  const wrong=new DatabaseSync(join(root,'wrong.db')); await assert.rejects(S.ensureAuxiliarySchema(wrong,{dbPath,outDir:join(root,'wrong-backup')}),/handle_mismatch/);wrong.close();
  db.exec('CREATE TABLE audit_unknown(id INTEGER)'); await assert.rejects(S.ensureAuxiliarySchema(db,{dbPath,outDir:join(root,'unknown-combination')}),/backup_failed/); assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'aux_%'").get().n,0);db.exec('DROP TABLE audit_unknown');
  const busy=new DatabaseSync(dbPath);try{busy.exec('BEGIN IMMEDIATE');await assert.rejects(S.ensureAuxiliarySchema(db,{dbPath,outDir:join(root,'busy-install')}),/locked/);assert.equal(db.isTransaction,false);}finally{busy.exec('ROLLBACK');busy.close();}
  const installed=await S.ensureAuxiliarySchema(db,{dbPath,outDir:join(root,'before-install')});assert.equal(installed.status,'installed');assert.equal((await LB.verifyBackup({backupDir:installed.backupDir})).ok,true); assert.equal((await S.ensureAuxiliarySchema(db,{dbPath,outDir:join(root,'unused')})).status,'already_installed');
  for(const boundary of ['BEGIN IMMEDIATE','COMMIT']) {
   const target=join(root,'installer-'+boundary.split(' ')[0]+'.db');fs.copyFileSync(join(installed.backupDir,LB.SNAPSHOT_FILE),target);const c=new DatabaseSync(target),exec=c.exec.bind(c);let injected=false;
   c.exec=function(sql){if(!injected&&sql===boundary){injected=true;exec(sql);throw new Error('synthetic install boundary');}return exec(sql);};
   try{await assert.rejects(S.ensureAuxiliarySchema(c,{dbPath:target,outDir:join(root,'install-fault-'+boundary.split(' ')[0])}),/aux_commit_unknown/);assert.equal(injected,true);assert.throws(()=>S.assertAuxiliaryReady(c),/aux_connection_quarantined/);}finally{if(c.isTransaction)exec('ROLLBACK');c.close();}
  }
  db.exec('CREATE TABLE audit_after_aux(id INTEGER)');await assert.rejects(S.ensureAuxiliarySchema(db,{dbPath,outDir:join(root,'not-used')}));db.exec('DROP TABLE audit_after_aux');
  const a=makeSet('storage-a'),b=makeSet('storage-b'),p=entity(a,'party','P'),q=entity(b,'party','P'),d=entity(a,'department','D');
  const v=voucher(a,'2025-12',[{code:'1122',debit:10},{code:'5001',credit:10}]);const e=db.prepare("SELECT id FROM voucher_entries WHERE voucher_id=? AND code='1122'").get(v.id).id;
  const insert=db.prepare('INSERT INTO aux_allocations(account_set_id,code,entry_id,party_id,debit_cents,credit_cents) VALUES(?,?,?,?,?,0)');
  assert.throws(()=>insert.run(a,'1122',e,q,100),/dimension_invalid/);assert.throws(()=>insert.run(a,'1122',e,d,100),/dimension_invalid/);assert.throws(()=>insert.run(b,'1122',e,q,100),/owner_mismatch/);
  allocate(a,{entryId:e},[{partyId:p,debit:10}]);
  for(const [sql,args] of [['UPDATE voucher_entries SET debit=11 WHERE id=?',[e]],['UPDATE voucher_entries SET code=\'1002\' WHERE id=?',[e]],['UPDATE voucher_entries SET line_no=9 WHERE id=?',[e]],['UPDATE vouchers SET account_set_id=? WHERE id=?',[b,v.id]],['UPDATE vouchers SET period=\'2026-01\' WHERE id=?',[v.id]],['DELETE FROM vouchers WHERE id=?',[v.id]],['UPDATE aux_entities SET account_set_id=? WHERE id=?',[b,p]],['DELETE FROM aux_entities WHERE id=?',[p]],['DELETE FROM accounts WHERE account_set_id=? AND code=\'1122\'',[a]]]) assert.throws(()=>db.prepare(sql).run(...args));
  assert.throws(()=>insert.run(a,'1122',e,p,1),/exceeds_entry/); assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  console.log('auxiliary-storage PASS: install, backup binding, unknown combination zero DDL, cross-set/type/budget and parent mutation guards');
 } finally {db.close();console.log('auxiliary-storage database closed');}
}
/** 每个子进程均由本次调用拥有；只在 close 后确认结束，绝不推测 PID。 */
export async function runChild(args,{env={},timeout=60000,cwd}={}) {
 const {spawn}=await import('node:child_process');
 return await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',timedOut=false,spawnError=null;
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});child.on('error',error=>{spawnError=error;});
  const timer=setTimeout(()=>{timedOut=true;child.kill();},timeout);
  child.on('close',(code,signal)=>{clearTimeout(timer);if(spawnError)reject(spawnError);else resolve({code,signal,stdout,stderr,timedOut,closed:true});});
 });
}
