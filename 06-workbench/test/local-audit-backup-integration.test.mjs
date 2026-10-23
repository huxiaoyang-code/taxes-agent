import {assert,fs,join,DatabaseSync,LS,LA,LB,OP,fresh,input,logical,hash,suite,historyEvent,child,WORKBENCH} from './local-audit-install.test.mjs';
await suite('WAL and non-WAL committed audit/business + pending snapshots preserve bytes without authority',async()=>{
 for(const journal of ['wal','delete']) {
  const h=await fresh({journal});try {
   const old=h.db.prepare('SELECT * FROM audit_database_instances').all();
   const p=OP.prepareOperation(h.db,input('committed'));const first=OP.executePreparedOperation(h.db,p.authorization,()=>{h.db.exec("UPDATE schema_backups SET integrity='committed-137'");return {state:'succeeded'};});assert.equal(first.ok,true);
   const pending=OP.prepareOperation(h.db,input('pending'));assert.equal(pending.code,'prepared');
   const source=logical(h.db),b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'snapshot')});assert.equal(b.ok,true,JSON.stringify(b));assert.equal(logical(h.db),source);assert.equal(b.manifest.components.find(c=>c.name==='business-audit').version,2);
   const verified=LB.verifyBackup({backupDir:b.backupDir});assert.equal(verified.ok,true,JSON.stringify(verified));LB.assertBackupSourceConnection(h.db,verified.manifest);
   const restored=join(h.dir,'restored');assert.equal(LB.restoreNew({backupDir:b.backupDir,targetDir:restored}).ok,true);
   const copy=new DatabaseSync(join(restored,LB.TARGET_DATABASE_FILE));copy.exec('PRAGMA foreign_keys=ON');try {
    assert.equal(logical(copy),source);assert.deepEqual(copy.prepare('SELECT * FROM audit_database_instances').all(),old);
    const replay=OP.prepareOperation(copy,input('committed'));assert.deepEqual(replay.receipt,first.receipt);assert.equal(replay.replayed,true);
    const wait=OP.prepareOperation(copy,input('pending'));assert.equal(wait.needsReview,true);assert.equal(wait.authorization,undefined);
    assert.throws(()=>OP.executePreparedOperation(copy,pending.authorization,()=>{throw Error('never');}),/audit_authorization_invalid/);
    assert.equal(LB.createBackup({dbPath:join(restored,LB.TARGET_DATABASE_FILE),outDir:join(h.dir,'again')}).ok,true);
   }finally{copy.close();}
   assert.equal(LS.inspectAuditSchema(h.db).ok,true);
  }finally{h.close();}
 }
});
await suite('strict audit1 history is official backup/restore compatible and v2 upgrade preserves original digest/dedupe',async()=>{
 const h=await fresh({audit:1});try {
  const event=historyEvent(h.db),instance=LS.currentAuditInstanceId(h.db);assert.equal(LS.assertAuditSchema(h.db).version,1);
  const b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'v1')});assert.equal(b.ok,true,JSON.stringify(b));assert.equal(b.manifest.components.find(c=>c.name==='business-audit').version,1);assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,true);
  const target=join(h.dir,'historical');assert.equal(LB.restoreNew({backupDir:b.backupDir,targetDir:target}).ok,true);
  const c=new DatabaseSync(join(target,LB.TARGET_DATABASE_FILE));try{assert.deepEqual(c.prepare('SELECT * FROM audit_events').get(),event);assert.equal(LS.verifyAuditEvents(c).mismatched.length,0);}finally{c.close();}
  await LS.installAuditSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'protected-upgrade')});assert.equal(LS.currentAuditInstanceId(h.db),instance);const {event_format_version,...row}=h.db.prepare('SELECT * FROM audit_events').get();assert.equal(LA.canonicalAuditJson(row),LA.canonicalAuditJson(event));assert.equal(event_format_version,1);
 }finally{h.close();}
});
const attacks=[
 ['extra-index',db=>db.exec('CREATE INDEX audit_extra ON audit_operations(action)')],
 ['collation-desc',db=>db.exec('DROP INDEX idx_audit_events_action;CREATE INDEX idx_audit_events_action ON audit_events(action COLLATE NOCASE DESC,seq)')],
 ['partial',db=>db.exec('DROP INDEX idx_audit_events_action;CREATE INDEX idx_audit_events_action ON audit_events(action,seq) WHERE seq>0')],
 ['expression',db=>db.exec('DROP INDEX idx_audit_events_action;CREATE INDEX idx_audit_events_action ON audit_events(lower(action),seq)')],
 ['extra-unique',db=>db.exec('CREATE UNIQUE INDEX audit_extra_unique ON audit_operations(binding_digest)')],
 ['trigger',db=>db.exec('CREATE TRIGGER audit_extra_trigger AFTER INSERT ON audit_events BEGIN SELECT 1; END')],
 ['view',db=>db.exec('CREATE VIEW audit_extra_view AS SELECT operation_id FROM audit_events')],
 ['wrong-trigger',db=>db.exec('DROP TRIGGER audit_operations_no_delete;CREATE TRIGGER audit_operations_no_delete BEFORE DELETE ON audit_operations BEGIN SELECT 1; END')],
 ['missing-trigger',db=>db.exec('DROP TRIGGER audit_events_no_replace')],
 ['missing-column',db=>db.exec('ALTER TABLE audit_events DROP COLUMN stage_id')],
 ['instance-cycle',db=>{const a=LS.currentAuditInstanceId(db);db.prepare('INSERT INTO audit_database_instances VALUES(?,?,?,?,?)').run('cycle-second','2026-10-22T00:00:00.000Z',a,0,'restore-new');db.prepare("UPDATE audit_database_instances SET parent_instance_id='cycle-second',note_code='restore-new' WHERE instance_id=?").run(a);}],
 ['instance-initial-parent',db=>{const a=LS.currentAuditInstanceId(db);db.prepare('INSERT INTO audit_database_instances VALUES(?,?,?,?,?)').run('bad-initial','2026-10-22T00:00:00.000Z',a,0,'initial');}],
 ['instance-restore-root',db=>db.prepare('INSERT INTO audit_database_instances VALUES(?,?,?,?,?)').run('bad-restore','2026-10-22T00:00:00.000Z',null,0,'restore-new')],
 ['unknown-version',db=>db.exec("UPDATE audit_components SET version=3")],
 ['binding-content',db=>{OP.prepareOperation(db,input('bad'));db.exec('DROP TRIGGER audit_operations_guard_update');db.exec("UPDATE audit_operations SET binding_digest='"+'0'.repeat(64)+"'");db.exec(LS.AUDIT_OPERATION_TRIGGER_SQL.audit_operations_guard_update);}],
 ['receipt-content',db=>{const p=OP.prepareOperation(db,input('bad'));OP.executePreparedOperation(db,p.authorization,()=>({state:'succeeded'}));db.exec('DROP TRIGGER audit_operations_guard_update');db.exec("UPDATE audit_operations SET receipt_json='{}'");db.exec(LS.AUDIT_OPERATION_TRIGGER_SQL.audit_operations_guard_update);}],
 ['orphan-format2',db=>{const e=LA.normalizeAuditEvent({operationId:'orphan',actor:'system',action:'voucher.post',attempt:1,outcome:'succeeded',resultCode:'ok'},null,LA.serverEventFields(LS.currentAuditInstanceId(db)));db.prepare(`INSERT INTO audit_events(event_id,dedupe_key,database_instance_id,occurred_at,action,outcome,result_code,reason_code,actor,operation_id,attempt,content_digest,event_format_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,2)`).run(e.eventId,LA.auditV2DedupeKey(e),e.databaseInstanceId,e.occurredAt,e.action,e.outcome,e.resultCode,e.reasonCode,e.actor,e.operationId,e.attempt,LA.auditV2EventDigest(e));}],
 ['operation-event-direction',db=>{const p=OP.prepareOperation(db,input('bad'));OP.executePreparedOperation(db,p.authorization,()=>({state:'succeeded'}));db.exec('DROP TRIGGER audit_events_no_update');db.exec("UPDATE audit_events SET event_format_version=1");db.exec(LS.AUDIT_TRIGGER_SQL.audit_events_no_update);}],
];
await suite('source and snapshot strict structure/content attack matrix rejects create/verify/restore',async()=>{
 for(const [name,attack] of attacks) {
  const h=await fresh();try {
   const b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'valid')});assert.equal(b.ok,true);
   attack(h.db);const before=logical(h.db);assert.equal(LS.inspectAuditSchema(h.db).ok,false,name);const bad=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'bad-source')});assert.equal(bad.ok,false,name);assert.equal(logical(h.db),before,name);
   const snapshot=join(b.backupDir,LB.SNAPSHOT_FILE),c=new DatabaseSync(snapshot);c.exec('PRAGMA foreign_keys=ON');try{attack(c);}finally{c.close();}
   const manifest=JSON.parse(fs.readFileSync(join(b.backupDir,LB.MANIFEST_FILE),'utf8'));manifest.snapshot.sha256=hash(snapshot);manifest.snapshot.bytes=fs.statSync(snapshot).size;fs.writeFileSync(join(b.backupDir,LB.MANIFEST_FILE),JSON.stringify(manifest));
   assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,false,name);const target=join(h.dir,'refused');assert.equal(LB.restoreNew({backupDir:b.backupDir,targetDir:target}).ok,false,name);assert.equal(fs.existsSync(target),false,name);console.log('attack actual '+name);
  }finally{h.close();}
 }
});
await suite('SQL CHECK/FK/rowid and full autoindex facts, omitted component manifest reject',async()=>{
 for(const [name,rewrite] of [
  ['CHECK',s=>s.replace('attempt BETWEEN 1 AND 1000000','attempt BETWEEN 0 AND 1000000')],
  ['FK',s=>s.replace('ON DELETE RESTRICT','ON DELETE CASCADE')],
  ['rowid',s=>s+' WITHOUT ROWID'],
  ['UNIQUE',s=>s.replace('terminal_event_id TEXT UNIQUE','terminal_event_id TEXT')],
 ]) {
  const h=await fresh();try {
   const valid=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'sql-valid')});assert.equal(valid.ok,true);
   const mutate=db=>{const sql=db.prepare("SELECT sql FROM sqlite_master WHERE name='audit_operations'").get().sql;for(const name of Object.keys(LS.AUDIT_OPERATION_TRIGGER_SQL))db.exec('DROP TRIGGER '+name);db.exec('DROP TABLE audit_operations');db.exec(rewrite(sql));for(const sql of Object.values(LS.AUDIT_OPERATION_TRIGGER_SQL))db.exec(sql);};
   mutate(h.db);const before=logical(h.db);assert.equal(LS.inspectAuditSchema(h.db).ok,false,name);assert.equal(LB.createBackup({dbPath:h.file,outDir:join(h.dir,'invalid-'+name)}).ok,false);assert.equal(logical(h.db),before);
   const snapshot=join(valid.backupDir,LB.SNAPSHOT_FILE),copy=new DatabaseSync(snapshot);try{mutate(copy);}finally{copy.close();}
   const manifest=valid.manifest;manifest.snapshot.sha256=hash(snapshot);manifest.snapshot.bytes=fs.statSync(snapshot).size;fs.writeFileSync(join(valid.backupDir,LB.MANIFEST_FILE),JSON.stringify(manifest));
   assert.equal(LB.verifyBackup({backupDir:valid.backupDir}).ok,false,name);const target=join(h.dir,'invalid-target');assert.equal(LB.restoreNew({backupDir:valid.backupDir,targetDir:target}).ok,false,name);assert.equal(fs.existsSync(target),false);console.log('SQL attack create/verify/restore actual '+name);
  }finally{h.close();}
 }
 const h=await fresh();try{const b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'omit')});assert.equal(b.ok,true);const m=b.manifest;delete m.components;fs.writeFileSync(join(b.backupDir,LB.MANIFEST_FILE),JSON.stringify(m));assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,false);}finally{h.close();}
});
await suite('read-only CLI audit1/2 schema/events/verify and missing database have no write side effect',async()=>{
 for(const audit of [1,2]) {
  const h=await fresh({audit});try{
   if(audit===1)historyEvent(h.db);else {const p=OP.prepareOperation(h.db,input('cli'));OP.executePreparedOperation(h.db,p.authorization,()=>({state:'succeeded'}));}
   const before=logical(h.db);for(const command of ['schema','events','verify']){const r=await child([join(WORKBENCH,'scripts','local-audit.mjs'),command,'--db',h.file]);assert.equal(r.code,0,r.err+r.out);const json=JSON.parse(r.out);assert.equal(JSON.stringify(json).includes(h.file),false);}assert.equal(logical(h.db),before);
  }finally{h.close();}
 }
 const missing=join(WORKBENCH,'..','.agent-runs','nonexistent-'+Date.now()+'.db');const r=await child([join(WORKBENCH,'scripts','local-audit.mjs'),'events','--db',missing]);assert.equal(r.code,3);assert.equal(fs.existsSync(missing),false);assert.equal((r.out+r.err).includes(missing),false);
});
