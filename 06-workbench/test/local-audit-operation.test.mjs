import {assert,fs,join,resolve,DatabaseSync,pathToFileURL,ROOT,WORKBENCH,LS,LA,LB,OP,fresh,input,logical,child,suite} from './local-audit-install.test.mjs';
const id=h=>LS.currentAuditInstanceId(h.db);
const query=(h,operationId,attempt=1)=>OP.queryOperation(h.db,{databaseInstanceId:id(h),operationId,attempt});
const apply=(h,operationId,fn=()=>({state:'succeeded'}),over={})=>{const p=OP.prepareOperation(h.db,input(operationId,over));assert.equal(p.code,'prepared');return OP.executePreparedOperation(h.db,p.authorization,fn);};
await suite('durable pending, receipt-only success/no_change replay, conflicts and two actual connections',async()=>{
 const h=await fresh(),other=new DatabaseSync(h.file);other.exec('PRAGMA foreign_keys=ON');try {
  let calls=0;const p=OP.prepareOperation(h.db,input('once'));assert.equal(p.code,'prepared');assert.equal(h.db.isTransaction,false);assert.equal(other.prepare('SELECT state FROM audit_operations').get().state,'pending');
  assert.equal(OP.prepareOperation(other,input('once')).needsReview,true);
  assert.throws(()=>OP.executePreparedOperation(other,p.authorization,()=>{calls++;}),/audit_authorization_invalid/);
  assert.throws(()=>OP.executePreparedOperation(h.db,{},()=>{calls++;}),/audit_authorization_invalid/);
  assert.throws(()=>OP.executePreparedOperation(h.db,JSON.parse(JSON.stringify(p.authorization)),()=>{calls++;}),/audit_authorization_invalid/);
  const result=OP.executePreparedOperation(h.db,p.authorization,()=>{calls++;h.db.prepare("UPDATE schema_backups SET integrity='business-137'").run();return {state:'succeeded'};});assert.equal(result.ok,true);assert.equal(calls,1);
  const bytes=h.db.prepare('SELECT receipt_json FROM audit_operations').get().receipt_json;assert.equal(LA.canonicalAuditJson(result.receipt),bytes);
  assert.throws(()=>OP.executePreparedOperation(h.db,p.authorization,()=>{calls++;}),/audit_authorization_invalid/);
  const replay=OP.prepareOperation(other,input('once'));assert.equal(replay.replayed,true);assert.equal(LA.canonicalAuditJson(replay.receipt),bytes);assert.equal(calls,1);
  const conflict=input('once');conflict.request.amountCents=138;assert.equal(OP.prepareOperation(h.db,conflict).code,'audit_operation_conflict');
  for(const change of [{action:'voucher.unpost'},{attempt:2}])assert.equal(OP.prepareOperation(h.db,input('once',change)).code,'audit_operation_conflict');
  const no=apply(h,'noop',()=>({state:'no_change'}));assert.equal(no.code,'no_change');assert.deepEqual(query(h,'noop').receipt,no.receipt);
  assert.equal(LS.verifyAuditEvents(h.db).mismatched.length,0);assert.equal(LS.inspectAuditSchema(h.db).ok,true);
 }finally{other.close();h.close();}
});
await suite('caller BEGIN and SAVEPOINT rejected without write/commit/rollback; authorization remains usable',async()=>{
 const h=await fresh();try {
  const p=OP.prepareOperation(h.db,input('outer-exec'));
  for(const sql of ['BEGIN','SAVEPOINT caller']) {
   const before=logical(h.db);h.db.exec(sql);let calls=0;
   assert.throws(()=>OP.prepareOperation(h.db,input('outer-prepare')),/audit_transaction_conflict/);
   assert.throws(()=>OP.executePreparedOperation(h.db,p.authorization,()=>{calls++;}),/audit_transaction_conflict/);assert.equal(calls,0);assert.equal(h.db.isTransaction,true);assert.equal(logical(h.db),before);h.db.exec('ROLLBACK');
  }
  assert.equal(OP.executePreparedOperation(h.db,p.authorization,()=>({state:'succeeded'})).ok,true);
 }finally{h.close();}
});
await suite('scope/binding/parent targets and data-only safety reject getters, proxies, undefined and noninteger',async()=>{
 const h=await fresh();try {
  let getters=0;const obj={};Object.defineProperty(obj,'context',{enumerable:true,get(){getters++;return input().context;}});
  assert.throws(()=>OP.prepareOperation(h.db,obj));assert.equal(getters,0);
  const proxied=new Proxy(input('proxy'),{ownKeys(){getters++;return [];}});assert.throws(()=>OP.prepareOperation(h.db,proxied));assert.equal(getters,0);
  for(const value of [{x:undefined},{x:1.5},{x:Infinity},Object.assign([],{x:1})]) {const bad=input('bad-request');bad.request=value;assert.throws(()=>OP.prepareOperation(h.db,bad));}
  const parent=input('child',{parentOperationId:'parent',parentAttempt:1});assert.equal(OP.prepareOperation(h.db,parent).code,'prepared');
  assert.throws(()=>OP.prepareOperation(h.db,input('bad-parent',{parentOperationId:'parent'})));
  const account=input('scope',{accountSetId:1});account.scope={kind:'account_set',value:2};assert.throws(()=>OP.prepareOperation(h.db,account));
  const p=OP.prepareOperation(h.db,input('getter-result'));const badResult={state:'succeeded'};Object.defineProperty(badResult,'then',{enumerable:true,get(){getters++;return ()=>{};}});
  const r=OP.executePreparedOperation(h.db,p.authorization,()=>badResult);assert.equal(r.state,'rejected');assert.equal(r.receipt.reasonCode,'audit_result_invalid');assert.equal(getters,0);
 }finally{h.close();}
});
await suite('failure DTO/throw/thenable rollback, deterministic attempts, forged error properties and privacy',async()=>{
 const h=await fresh();try {
  const before=h.db.prepare('SELECT integrity FROM schema_backups ORDER BY id').all();
  for(const [operationId,fn,state] of [
   ['dto',()=>({state:'failed',resultCode:'failed',reasonCode:'internal_error'}),'failed'],
   ['false',()=>false,'rejected'],['promise',()=>Promise.resolve({state:'succeeded'}),'rejected'],
   ['thenable',()=>({then(){},state:'succeeded'}),'rejected'],
   ['throw',()=>{throw Object.assign(new Error('SENSITIVE-原文-金额137'),{code:'unknown-secret',auditControlledSpec:{state:'succeeded',resultCode:'ok',targets:{}}});},'failed'],
  ]) {
   const p=OP.prepareOperation(h.db,input(operationId));let calls=0;
   const r=OP.executePreparedOperation(h.db,p.authorization,()=>{calls++;h.db.exec("UPDATE schema_backups SET integrity='dirty'");return fn();});assert.equal(r.state,state);assert.equal(r.durability,'committed');assert.equal(calls,1);assert.deepEqual(h.db.prepare('SELECT integrity FROM schema_backups ORDER BY id').all(),before);
   assert.equal(query(h,operationId).receipt.eventId,r.receipt.eventId);assert.equal(OP.prepareOperation(h.db,input(operationId)).replayed,true);
   assert.equal(OP.prepareOperation(h.db,input(operationId,{attempt:3})).code,'audit_operation_conflict');
   const retry=input(operationId,{attempt:2});assert.equal(OP.prepareOperation(h.db,retry).code,'prepared');
  }
  const text=logical(h.db);assert.equal(text.includes('SENSITIVE'),false);assert.equal(text.includes('auditControlledSpec'),false);
  assert.equal(LS.inspectAuditSchema(h.db).ok,true);
 }finally{h.close();}
});
await suite('real BUSY admission and COMMIT BUSY with proven rollback then durable failure',async()=>{
 const h=await fresh(),reader=new DatabaseSync(h.file);try {
  reader.exec('BEGIN IMMEDIATE');assert.equal(OP.prepareOperation(h.db,input('admission')).code,'audit_admission_busy');reader.exec('ROLLBACK');
  const p=OP.prepareOperation(h.db,input('busy-commit')),before=logical(h.db);reader.exec('BEGIN');reader.prepare('SELECT * FROM schema_backups').all();
  const exec=h.db.exec.bind(h.db);let actualBusy=0,actualRollback=0;
  h.db.exec=sql=>{try{const value=exec(sql);if(sql==='ROLLBACK')actualRollback++;return value;}catch(e){if(sql==='COMMIT'&&h.db.isTransaction){actualBusy++;reader.exec('ROLLBACK');}throw e;}};
  const r=OP.executePreparedOperation(h.db,p.authorization,()=>{h.db.exec("UPDATE schema_backups SET integrity='not-committed'");return {state:'succeeded'};});h.db.exec=exec;
  assert.equal(actualBusy,1);assert.equal(actualRollback,1);assert.equal(r.state,'failed');assert.equal(r.durability,'committed');assert.equal(h.db.isTransaction,false);assert.equal(h.db.prepare("SELECT COUNT(*) n FROM schema_backups WHERE integrity='not-committed'").get().n,0);assert.notEqual(logical(h.db),before);
 }finally{if(reader.isTransaction)reader.exec('ROLLBACK');reader.close();h.close();}
});
await suite('audit RAISE rollback, failure audit also RAISE leaves only pending',async()=>{
 for(const all of [false,true]) {
  const h=await fresh();try {
   const p=OP.prepareOperation(h.db,input('raise'));const setter=h.db.setAuthorizer.bind(h.db);let injected=false;
   h.db.setAuthorizer=value=>{setter(value);if(value===null&&!injected){injected=true;h.db.exec(`CREATE TRIGGER synthetic_raise BEFORE INSERT ON audit_events ${all?'':"WHEN NEW.outcome='succeeded'"} BEGIN SELECT RAISE(ABORT,'synthetic'); END`);}};
   // 在回调后、自有事务内注入触发器，再随业务一起回滚。
   if(all) {const prepare=h.db.prepare.bind(h.db);h.db.prepare=sql=>{if(sql.startsWith('INSERT INTO audit_events')){h.db.exec("CREATE TEMP TRIGGER IF NOT EXISTS synthetic_persistent_raise BEFORE INSERT ON main.audit_events BEGIN SELECT RAISE(ABORT,'synthetic'); END");}return prepare(sql);};}
   const r=OP.executePreparedOperation(h.db,p.authorization,()=>{h.db.exec("UPDATE schema_backups SET integrity='raise-dirty'");return {state:'succeeded'};});h.db.setAuthorizer=setter;
   assert.equal(h.db.prepare("SELECT COUNT(*) n FROM schema_backups WHERE integrity='raise-dirty'").get().n,0);
   assert.equal(r.state,all?'unknown':'failed');if(all){assert.equal(query(h,'raise').needsReview,true);assert.equal(h.db.prepare('SELECT COUNT(*) n FROM audit_events').get().n,0);}assert.equal(h.db.isTransaction,false);
  }finally{h.close();}
 }
});
await suite('callback transaction escape and post-COMMIT exception return unknown, never autocommit audit',async()=>{
 for(const mode of ['escape','after-commit']) {
  const h=await fresh();try {
   const p=OP.prepareOperation(h.db,input(mode));const exec=h.db.exec.bind(h.db),setter=h.db.setAuthorizer.bind(h.db);
   if(mode==='after-commit')h.db.exec=sql=>{const r=exec(sql);if(sql==='COMMIT')throw Error('SENSITIVE response lost');return r;};
   const r=OP.executePreparedOperation(h.db,p.authorization,()=>{if(mode==='escape'){setter(null);exec('COMMIT');}return {state:'succeeded'};});
   assert.equal(r.state,'unknown');assert.equal(r.needsReview,true);h.db.exec=exec;
   const reopened=new DatabaseSync(h.file);try{const q=OP.queryOperation(reopened,{databaseInstanceId:id(h),operationId:mode,attempt:1});assert.equal(mode==='escape'?q.needsReview:q.receipt.state,mode==='escape'?true:'succeeded');assert.equal(reopened.prepare('SELECT COUNT(*) n FROM audit_events').get().n,mode==='escape'?0:1);}finally{reopened.close();}
  }finally{h.close();}
 }
});
await suite('real process interruption: after pending, business, before COMMIT, committed response loss',async()=>{
 for(const window of ['pending','business','before-commit','after-commit']) {
  const h=await fresh({journal:'wal'});const instance=id(h);h.close();
  const program=`import {DatabaseSync} from 'node:sqlite';import * as O from ${JSON.stringify(pathToFileURL(join(WORKBENCH,'server/local-audit-operation.mjs')).href)};const d=new DatabaseSync(${JSON.stringify(h.file)});d.exec('PRAGMA foreign_keys=ON');const input=${JSON.stringify(input(window))};const p=O.prepareOperation(d,input);const stop=()=>{console.log('STOP');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};if(${JSON.stringify(window)}==='pending')stop();const exec=d.exec.bind(d);d.exec=sql=>{if(sql==='COMMIT'&&${JSON.stringify(window)}==='before-commit')stop();const r=exec(sql);if(sql==='COMMIT'&&${JSON.stringify(window)}==='after-commit')stop();return r;};O.executePreparedOperation(d,p.authorization,()=>{d.exec("UPDATE schema_backups SET integrity='process-business'");if(${JSON.stringify(window)}==='business')stop();return {state:'succeeded'};});d.close();`;
  const r=await child(['--input-type=module','-e',program],{onOutput:(text,c)=>{if(text.includes('STOP'))c.kill();}});assert.equal(r.closed,true);assert.ok(r.out.includes('STOP'));
  const db=new DatabaseSync(h.file);db.exec('PRAGMA foreign_keys=ON');try {
   const q=OP.queryOperation(db,{databaseInstanceId:instance,operationId:window,attempt:1});
   if(window==='after-commit'){assert.equal(q.receipt.state,'succeeded');assert.equal(db.prepare("SELECT COUNT(*) n FROM schema_backups WHERE integrity='process-business'").get().n>0,true);}else{assert.equal(q.needsReview,true);assert.equal(db.prepare("SELECT COUNT(*) n FROM schema_backups WHERE integrity='process-business'").get().n,0);}
   const p=OP.prepareOperation(db,input(window));assert.equal(p.authorization,undefined);assert.equal(window==='after-commit'?p.replayed:p.needsReview,true);assert.equal(LS.inspectAuditSchema(db).ok,true);
  }finally{db.close();console.log('reopened DB actualclose');}
 }
});
await suite('cross-instance/closed handle receipt invalidation and direct transaction-control denial',async()=>{
 const h=await fresh(),other=await fresh();try {
  const p=OP.prepareOperation(h.db,input('cross'));assert.throws(()=>OP.executePreparedOperation(other.db,p.authorization,()=>({state:'succeeded'})),/audit_authorization_invalid/);
  const control=apply(h,'control',()=>{h.db.exec('COMMIT');return {state:'succeeded'};});assert.equal(control.state,'failed');assert.equal(h.db.isTransaction,false);
  h.close();assert.throws(()=>OP.executePreparedOperation(h.db,p.authorization,()=>({state:'succeeded'})));
 }finally{h.close();other.close();}
});await suite('simultaneous real processes same identity perform exactly one balanced 137-cent business effect',async()=>{
 const h=await fresh({journal:'wal'}),instance=LS.currentAuditInstanceId(h.db),request=input('concurrent',{accountSetId:1});request.scope={kind:'account_set',value:1};
 const before=h.db.prepare("SELECT account_set_id,code,ROUND(debit*100) d,ROUND(credit*100) c FROM opening_balances ORDER BY account_set_id,code").all();assert.equal(before.find(r=>r.account_set_id===1&&r.code==='1002').d,979);h.close();
 const programs=[0,1].map(n=>`import fs from 'node:fs';import{DatabaseSync}from'node:sqlite';import*as O from ${JSON.stringify(pathToFileURL(join(WORKBENCH,'server/local-audit-operation.mjs')).href)};const db=new DatabaseSync(${JSON.stringify(h.file)});try{db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');fs.writeFileSync(${JSON.stringify(join(h.dir,'ready-'+n))},'ready');const other=${JSON.stringify(join(h.dir,'ready-'+(1-n)))};let tries=0;while(!fs.existsSync(other)){if(++tries>500)throw Error('barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}const p=O.prepareOperation(db,${JSON.stringify(request)});let r=p;if(p.code==='prepared')r=O.executePreparedOperation(db,p.authorization,()=>{console.log('CALLBACK');db.exec("UPDATE opening_balances SET debit=11.16 WHERE account_set_id=1 AND code='1002';UPDATE opening_balances SET credit=11.16 WHERE account_set_id=1 AND code='3001'");return{state:'succeeded'};});console.log(JSON.stringify(r));}finally{db.close();console.log('DB actualclose');}`);
 const results=await Promise.all(programs.map(program=>child(['--input-type=module','-e',program])));for(const r of results){assert.equal(r.code,0,r.err+r.out);assert.equal(r.closed,true);assert.ok(r.out.includes('DB actualclose'));}assert.equal(results.map(r=>r.out).join('\n').split('CALLBACK').length-1,1);
 const db=new DatabaseSync(h.file);try {assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_events').get().n,1);const q=OP.queryOperation(db,{databaseInstanceId:instance,operationId:'concurrent',attempt:1});assert.equal(q.receipt.state,'succeeded');assert.equal(db.prepare("SELECT ROUND(debit*100) n FROM opening_balances WHERE account_set_id=1 AND code='1002'").get().n,1116);assert.equal(db.prepare("SELECT ROUND(debit*100) n FROM opening_balances WHERE account_set_id=2 AND code='1002'").get().n,2863);assert.equal(db.prepare('SELECT ROUND(SUM(debit-credit)*100) n FROM opening_balances').get().n,0);assert.equal(LS.inspectAuditSchema(db).ok,true);}finally{db.close();}
});
