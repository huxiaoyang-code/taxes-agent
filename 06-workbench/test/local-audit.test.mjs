// LOCAL06 A 覆盖已迁移到 audit1 历史读取及 W2a 协议闭合。
// 生产实现不再暴露未经认证的全新安装、追加或嵌套执行入口。
import {assert,fs,join,DatabaseSync,ROOT,WORKBENCH,LS,LA,fresh,historyEvent,logical,child,suite,pathToFileURL} from './local-audit-install.test.mjs';
await suite('import remains inert and read-only missing/non-SQLite database does not create default data',async()=>{
 const absent=join(ROOT,'never-created-data');const script=`await import(${JSON.stringify(pathToFileURL(join(WORKBENCH,'server/local-audit-storage.mjs')).href)});await import(${JSON.stringify(pathToFileURL(join(WORKBENCH,'server/local-audit-operation.mjs')).href)});`;
 const c=await child(['--input-type=module','-e',script],{env:{WORKBENCH_DATA_DIR:absent}});assert.equal(c.code,0,c.err);assert.equal(fs.existsSync(absent),false);
 const missing=join(ROOT,'missing.db');assert.throws(()=>LS.openAuditDatabase(missing),/audit_database_missing/);assert.equal(fs.existsSync(missing),false);
 const bad=join(ROOT,'not-sqlite.db');fs.writeFileSync(bad,'synthetic');assert.throws(()=>LS.openAuditDatabase(bad),/audit_database_invalid/);
});
await suite('no unprotected install, append, legacy operation, forged deferred failure or restore fork',async()=>{
 const raw=new DatabaseSync(join(ROOT,'empty.db'));try{const before=logical(raw);assert.throws(()=>LS.ensureAuditSchema(raw),/audit_install_requires_verified_backup/);assert.equal(logical(raw),before);}finally{raw.close();}
 for(const audit of [1,2]) {
  const h=await fresh({audit});try {
   const before=logical(h.db);let calls=0;
   assert.throws(()=>LS.appendAuditEvent(h.db,{outcome:'succeeded'}),/audit_operation_protocol_required/);
   assert.throws(()=>LS.runAuditedOperation(h.db,{},()=>calls++),/audit_operation_protocol_required/);assert.equal(calls,0);
   assert.throws(()=>LS.appendDeferredFailure(h.db,{auditFailurePending:{context:{},spec:{}}}),/audit_operation_protocol_required/);
   assert.throws(()=>LS.markAuditInstanceFork(h.db,{parentInstanceId:LS.currentAuditInstanceId(h.db)}),/audit_operation_protocol_required/);
   assert.equal(logical(h.db),before);assert.equal(LS.ensureAuditSchema(h.db).installed,false);
   h.db.exec('SAVEPOINT caller');assert.throws(()=>LS.runAuditedOperation(h.db,{},()=>calls++),/audit_operation_protocol_required/);assert.equal(h.db.isTransaction,true);h.db.exec('ROLLBACK');assert.equal(calls,0);
  }finally{h.close();}
 }
});
await suite('frozen v1 events retain digest, dedupe, targets, instance and pagination/stats across readonly reopen',async()=>{
 const h=await fresh({audit:1});try {
  const instance=LS.currentAuditInstanceId(h.db),events=[];
  for(let i=0;i<17;i++)events.push(historyEvent(h.db,{operationId:'historical-'+i,accountSetId:i%2+1,voucherId:i+1,period:'2026-01',attempt:i+1,action:i%2?'voucher.unpost':'voucher.post'}));
  const before=logical(h.db);const a=LS.queryAuditEvents(h.db,{accountSetId:1,limit:3});assert.equal(a.events.length,3);assert.equal(a.hasMore,true);
  const all=[];let cursor=0;do{const p=LS.queryAuditEvents(h.db,{afterSeq:cursor,limit:4});all.push(...p.events);cursor=p.nextCursor;if(!p.hasMore)break;}while(true);
  assert.equal(all.length,17);assert.equal(new Set(all.map(e=>e.seq)).size,17);assert.ok(all.every((e,i)=>e.seq===i+1));
  assert.equal(LS.queryAuditEvents(h.db,{accountSetId:2}).events.length,8);assert.equal(LS.queryAuditEvents(h.db,{voucherId:2}).events.length,1);assert.equal(LS.auditEventStats(h.db).total,17);
  assert.equal(LS.getAuditEvent(h.db,{eventId:events[0].event_id}).eventId,events[0].event_id);assert.equal(LS.getAuditEvent(h.db,{seq:999}),null);
  assert.deepEqual(LS.verifyAuditEvents(h.db),{checked:17,mismatched:[]});assert.equal(LS.listAuditInstances(h.db)[0].instanceId,instance);
  const read=LS.openAuditDatabase(h.file);try{assert.equal(LS.queryAuditEvents(read).events.length,17);assert.equal(LS.assertAuditSchema(read).version,1);}finally{read.close();}
  assert.equal(logical(h.db),before);
 }finally{h.close();}
});
await suite('strict query filters and contract whitelist never echo synthetic sensitive values',async()=>{
 const h=await fresh({audit:1});try {
  const secret='SYNTH-税务-秘密-137';const before=logical(h.db);
  for(const filter of [{metadata:secret},{action:'voucher.delete'},{outcome:secret},{actor:secret},{resultCode:secret},{operationId:secret},{period:"2026-01' UNION SELECT 1 --"},{accountSetId:'1'},{limit:501},{limit:0},{limit:1.5},{afterSeq:-1}]) {
   try{LS.queryAuditEvents(h.db,filter);assert.fail('should reject');}catch(e){assert.equal(e.code,'audit_filter_invalid');assert.equal(String(e).includes(secret),false);assert.equal(JSON.stringify(e).includes(secret),false);}
  }
  const context=LA.createOperationContext({operationId:'pure',actor:'domain',action:'voucher.post'});
  for(const extra of [{metadata:secret},{payload:secret},{outcome:'arbitrary'},{resultCode:secret},{reasonCode:secret},{accountSetId:1.5},{correlation:secret}])assert.throws(()=>LA.normalizeAuditEvent({outcome:'succeeded',resultCode:'ok',...extra},context));
  const mapped=LA.classifyFailure(Object.assign(new Error(secret),{code:secret,stack:secret}));assert.deepEqual(mapped,{outcome:'failed',resultCode:'internal_error',reasonCode:'internal_error'});
  assert.throws(()=>LA.correlationToken({secret}));assert.equal(LA.correlationToken(secret).includes(secret),false);assert.equal(logical(h.db),before);
 }finally{h.close();}
});
await suite('historical append-only protects UPDATE DELETE REPLACE/UPSERT; wrong SQL and corrupt content reject',async()=>{
 const h=await fresh({audit:1});try {
  const event=historyEvent(h.db),before=logical(h.db);
  assert.throws(()=>h.db.exec("UPDATE audit_events SET result_code='no_change'"));assert.throws(()=>h.db.exec('DELETE FROM audit_events'));
  const fields=Object.keys(event);assert.throws(()=>h.db.prepare(`INSERT OR REPLACE INTO audit_events(${fields.join(',')}) VALUES(${fields.map(()=>'?')})`).run(...fields.map(k=>event[k])));
  assert.throws(()=>h.db.prepare(`INSERT INTO audit_events(${fields.join(',')}) VALUES(${fields.map(()=>'?')}) ON CONFLICT(event_id) DO UPDATE SET outcome='failed'`).run(...fields.map(k=>event[k])));assert.equal(logical(h.db),before);
  h.db.exec('DROP TRIGGER audit_events_no_update');h.db.exec("UPDATE audit_events SET result_code='no_change'");h.db.exec(LS.AUDIT_TRIGGER_SQL.audit_events_no_update);assert.equal(LS.inspectAuditSchema(h.db).ok,false);assert.throws(()=>LS.queryAuditEvents(h.db),/audit_schema_inconsistent/);
 }finally{h.close();}
});
await suite('pure transaction utility owner/nested rollback remains available without granting audit authority',async()=>{
 const db=new DatabaseSync(join(ROOT,'utility.db'));try {
  db.exec('CREATE TABLE synthetic(id INTEGER)');assert.equal(LA.runInTransaction(db,()=>db.exec('INSERT INTO synthetic VALUES(1)')).owner,true);
  db.exec('BEGIN');const nested=LA.runInTransaction(db,()=>db.exec('INSERT INTO synthetic VALUES(2)'));assert.equal(nested.owner,false);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');assert.equal(db.prepare('SELECT COUNT(*) n FROM synthetic').get().n,1);
  assert.throws(()=>LA.runInTransaction(db,()=>{db.exec('INSERT INTO synthetic VALUES(3)');throw Error('synthetic');}));assert.equal(db.isTransaction,false);assert.equal(db.prepare('SELECT COUNT(*) n FROM synthetic').get().n,1);
 }finally{db.close();}
});await suite('CLI stats/instances, invalid commands/options/no-db/init forbidden and missing DB never create data',async()=>{
 const h=await fresh({audit:1});const cli=join(WORKBENCH,'scripts','local-audit.mjs'),marker='SYNTH-CLI-PRIVATE-137',missing=join(ROOT,marker+'.db'),defaultData=join(ROOT,'cli-default-never-created');
 try {
  historyEvent(h.db);const before=logical(h.db);
  const stats=await child([cli,'stats','--db',h.file],{env:{WORKBENCH_DATA_DIR:defaultData}});assert.equal(stats.code,0,stats.err);assert.equal(JSON.parse(stats.out).total,1);
  const instances=await child([cli,'instances','--db',h.file]);assert.equal(instances.code,0,instances.err);assert.equal(JSON.parse(instances.out).instances[0].instanceId,LS.currentAuditInstanceId(h.db));
  for(const args of [[],['events'],['stats'],['init','--db',missing],[marker,'--db',h.file],['events','--db',h.file,'--unknown',marker],['events','--db',h.file,'--limit',marker],['events','--db',h.file,'--limit','0'],['events','--db',h.file,'--period',marker],['schema','--db',h.file,'--limit','1'],['stats','--db',h.file,'--db',h.file],['events','--db'],['events','extra-positional-'+marker]]) {
   const r=await child([cli,...args],{env:{WORKBENCH_DATA_DIR:defaultData}});assert.equal(r.code,2,r.out+r.err);assert.equal((r.out+r.err).includes(marker),false);assert.equal(logical(h.db),before);assert.equal(fs.existsSync(missing),false);assert.equal(fs.existsSync(defaultData),false);
  }
  for(const command of ['schema','events','verify','stats','instances']){const r=await child([cli,command,'--db',missing],{env:{WORKBENCH_DATA_DIR:defaultData}});assert.equal(r.code,3);assert.equal((r.out+r.err).includes(marker),false);assert.equal(fs.existsSync(missing),false);assert.equal(fs.existsSync(defaultData),false);}
  assert.equal(logical(h.db),before);
 }finally{h.close();}
});
await suite('CLI bad version/column/trigger/instance state refuses all readonly commands without repair',async()=>{
 const cli=join(WORKBENCH,'scripts','local-audit.mjs');
 for(const [name,corrupt] of [
  ['future',db=>db.exec('UPDATE audit_components SET version=3')],
  ['column',db=>db.exec('ALTER TABLE audit_events DROP COLUMN stage_id')],
  ['trigger',db=>db.exec('DROP TRIGGER audit_events_no_delete;CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT 1; END')],
  ['instance',db=>db.exec('UPDATE audit_database_instances SET is_active=0')],
 ]) {
  const h=await fresh({audit:1});try {corrupt(h.db);const before=logical(h.db);for(const command of ['schema','events','verify','stats','instances']){const r=await child([cli,command,'--db',h.file]);assert.equal(r.code,3,name+'/'+command+':'+r.err+r.out);assert.equal(logical(h.db),before);if(command==='schema'){const output=JSON.parse(r.out);assert.equal(output.ok,false);assert.equal(output.state,name==='future'?'unsupported':'invalid');}}}finally{h.close();}
 }
});