import {assert,fs,join,DatabaseSync,randomUUID,ROOT,S,LB,AS,fresh,job,logical,digest,hash,suite} from './local-batch-install.test.mjs';
await suite('48 core3/4/5 x bank/aux x audit0/1/2 x batch1/2 official roundtrips',async()=>{
 let count=0;
 for(const version of [3,4,5])for(const bank of [false,true])for(const aux of version===5?[false,true]:[false])for(const audit of [0,1,2])for(const batch of [1,2]){
  const h=await fresh({version,bank,aux,audit,batch});try{
   const before=logical(h.db),b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'roundtrip')});assert.equal(b.ok,true,JSON.stringify({version,bank,aux,audit,batch,b}));const component=b.manifest.components.find(c=>c.name==='local-batch');assert.equal(component.version,batch);assert.equal(component.tables.length,batch===1?8:11);assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,true);LB.assertBackupSourceConnection(h.db,b.manifest);
   const target=join(h.dir,'new-target'),r=LB.restoreNew({backupDir:b.backupDir,targetDir:target});assert.equal(r.ok,true,JSON.stringify(r));const file=join(target,LB.TARGET_DATABASE_FILE),copy=new DatabaseSync(file);try{assert.equal(logical(copy),before);assert.equal(S.assertBatchSchema(copy).version,batch);if(batch===2)assert.equal(S.readBatchInstance(copy).instance_id,S.readBatchInstance(h.db).instance_id);}finally{copy.close();console.log('restored DB actualclose');}
   assert.equal(LB.createBackup({dbPath:file,outDir:join(h.dir,'again')}).ok,true);assert.equal(logical(h.db),before);count++;
  }finally{h.close();}
 }assert.equal(count,48);console.log('48 actual backup/verify/restore-new/again combinations');
});
await suite('four component installation orders and legacy batch1 before audit protection',async()=>{
 for(const order of [['audit','batch','bank','aux'],['batch','audit','aux','bank'],['bank','batch','aux','audit'],['aux','audit','bank','batch']]){
  const h=await fresh();try{for(const name of order){if(name==='audit')await AS.installAuditSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'order-audit')});if(name==='batch')await S.installBatchSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'order-batch')});if(name==='bank')await (await import('../server/bank-storage.mjs')).ensureBankSchema(h.db,{dbPath:h.file,dataDir:h.dir,backupService:LB});if(name==='aux')await (await import('../server/auxiliary-storage.mjs')).ensureAuxiliarySchema(h.db,{dbPath:h.file,outDir:join(h.dir,'order-aux')});}assert.equal(S.readBatchInstance(h.db).audit_instance_id,AS.currentAuditInstanceId(h.db));LB.assertSupportedDatabaseConnection(h.db);const b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'all')});assert.equal(b.ok,true,JSON.stringify(b));assert.equal(b.manifest.components.length,4);assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,true);}finally{h.close();}
 }
 const h=await fresh({batch:1});try{await AS.installAuditSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'before-audit')});assert.equal(S.assertBatchSchema(h.db).version,1);assert.equal(LB.createBackup({dbPath:h.file,outDir:join(h.dir,'legacy-combined')}).ok,true);}finally{h.close();}
});
await suite('audit late install maps current NULL only, preserves instance/history and later jobs',async()=>{
 const h=await fresh({batch:2});try{
  const first=S.readBatchInstance(h.db).instance_id;h.db.prepare('UPDATE local_batch_database_instances SET is_active=0 WHERE instance_id=?').run(first);const active=randomUUID();h.db.prepare("INSERT INTO local_batch_database_instances VALUES(?,?,NULL,1,?,'restore-new','ready',?,?)").run(active,first,'2026-10-23T00:00:00.000Z','synthetic-restore','a'.repeat(64));assert.equal(S.inspectBatchSchema(h.db).ok,true);
  await AS.installAuditSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'late-audit')});assert.equal(S.readBatchInstance(h.db).instance_id,active);assert.equal(S.readBatchInstance(h.db).audit_instance_id,AS.currentAuditInstanceId(h.db));assert.equal(h.db.prepare('SELECT audit_instance_id FROM local_batch_database_instances WHERE instance_id=?').get(first).audit_instance_id,null);
  job(h);assert.equal(S.inspectBatchSchema(h.db).ok,true);assert.equal(h.db.prepare('SELECT COUNT(*) n FROM local_batch_job_bindings WHERE database_instance_id=?').get(first).n,0);
 }finally{h.close();}
 const old=await fresh({audit:1,batch:2});try{const prior=S.readBatchInstance(old.db),priorAudit=AS.currentAuditInstanceId(old.db),newAudit=randomUUID(),newBatch=randomUUID();old.db.exec('UPDATE audit_database_instances SET is_active=0; UPDATE local_batch_database_instances SET is_active=0');old.db.prepare('INSERT INTO audit_database_instances VALUES(?,?,?,1,?)').run(newAudit,'2026-10-23T00:00:00.000Z',priorAudit,'restore-new');old.db.prepare("INSERT INTO local_batch_database_instances VALUES(?,?,?,1,?,'restore-new','ready',?,?)").run(newBatch,prior.instance_id,newAudit,'2026-10-23T00:00:00.000Z','synthetic-fork','f'.repeat(64));const batch=S.readBatchInstance(old.db),auditId=AS.currentAuditInstanceId(old.db);await AS.installAuditSchema(old.db,{dbPath:old.file,outDir:join(old.dir,'upgrade-audit')});assert.equal(S.readBatchInstance(old.db).instance_id,batch.instance_id);assert.equal(S.readBatchInstance(old.db).audit_instance_id,auditId);assert.equal(old.db.prepare('SELECT audit_instance_id FROM local_batch_database_instances WHERE instance_id=?').get(prior.instance_id).audit_instance_id,priorAudit);}finally{old.close();}
});
await suite('WAL/non-WAL saved decimal manifest/input/DTO/csv hashes survive missing source',async()=>{
 for(const journal of ['wal','delete']){const h=await fresh({batch:2,audit:2,journal});try{const j=job(h,{file:true,report:true}),stage=h.db.prepare("SELECT * FROM local_batch_stages WHERE stage_key LIKE 'report:%'").get(),dto=JSON.stringify({z:12.39,a:0.03}),csv='12.39,0.03\n';S.saveSnapshot(h.db,{jobId:j.job.id,itemId:stage.item_id,period:'2026-01',kind:'balance-sheet',dtoHash:S.sha256(dto),businessHash:'b'.repeat(64),dtoJson:dto,csvText:csv,csvHash:S.sha256(csv)});fs.unlinkSync(join(h.dir,'input.json'));const before=logical(h.db),b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'hashes')});assert.equal(b.ok,true,JSON.stringify(b));assert.equal(logical(h.db),before);assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,true);const copy=new DatabaseSync(join(b.backupDir,LB.SNAPSHOT_FILE),{readOnly:true});try{assert.equal(logical(copy),before);console.log(journal+' before/after '+digest(before)+' '+digest(logical(copy)));}finally{copy.close();}}
 finally{h.close();}}
});
await suite('audit namespace table reference contexts and case-insensitive object names remain strict',async()=>{
 const attacks=[
  'CREATE VIEW random_view AS SELECT * FROM "audit_events"',
  'CREATE VIEW random_view AS SELECT * FROM (audit_events)',
  'CREATE VIEW random_view AS SELECT * FROM (main.audit_events)',
  'CREATE VIEW random_view AS SELECT * FROM (SELECT * FROM audit_events)',
  'CREATE VIEW random_view AS SELECT * FROM local_batch_jobs, audit_events',
  "CREATE VIEW random_view AS SELECT * FROM 'audit_events'",
  'CREATE TRIGGER random_trigger AFTER INSERT ON local_batch_jobs BEGIN SELECT 1 FROM [audit_events]; END',
  'CREATE INDEX strange_index ON audit_events(actor)',
  'CREATE TRIGGER strange_trigger AFTER INSERT ON audit_events BEGIN SELECT 1; END',
  'CREATE VIEW AUDIT_extra AS SELECT 1','CREATE TABLE AUDIT_extra(x)',
  'CREATE INDEX IDX_AUDIT_extra ON local_batch_jobs(status)',
 ];
 for(const sql of attacks){const h=await fresh({batch:2,audit:2});try{h.db.exec(sql);assert.equal(AS.inspectAuditSchema(h.db).ok,false,sql);const before=logical(h.db);assert.equal(LB.createBackup({dbPath:h.file,outDir:join(h.dir,'rejected')}).ok,false,sql);assert.equal(logical(h.db),before);}finally{h.close();}}
 const h=await fresh({batch:2,audit:2});try{h.db.exec("CREATE VIEW harmless AS SELECT 'audit_events' AS literal, audit_instance_id AS harmless FROM local_batch_database_instances /* FROM audit_events */");assert.equal(AS.inspectAuditSchema(h.db).ok,true);h.db.exec('DROP VIEW harmless');assert.equal(AS.inspectAuditSchema(h.db).ok,true);assert.equal(LB.createBackup({dbPath:h.file,outDir:join(h.dir,'positive')}).ok,true);}finally{h.close();}
});
await suite('strict source/snapshot drift and component omission reject without source mutation',async()=>{
 const attacks=[
  ['version',d=>d.exec('UPDATE local_batch_component SET version=3')],['half',d=>d.exec('DROP TABLE local_batch_input_bindings')],
  ['extra index',d=>d.exec('CREATE INDEX extra ON local_batch_jobs(status)')],
  ['DESC',d=>d.exec('DROP INDEX idx_local_batch_stages_item; CREATE INDEX idx_local_batch_stages_item ON local_batch_stages(item_id DESC,period,stage_order)')],
  ['collation',d=>d.exec('DROP INDEX idx_local_batch_stages_item; CREATE INDEX idx_local_batch_stages_item ON local_batch_stages(item_id,period COLLATE NOCASE,stage_order)')],
  ['partial',d=>d.exec("DROP INDEX idx_local_batch_stages_item; CREATE INDEX idx_local_batch_stages_item ON local_batch_stages(item_id,period,stage_order) WHERE status='pending'")],
  ['expression',d=>d.exec('CREATE INDEX extra ON local_batch_jobs(lower(status))')],
  ['trigger',d=>d.exec('CREATE TRIGGER extra AFTER INSERT ON local_batch_jobs BEGIN SELECT 1; END')],
  ['quoted view',d=>d.exec('CREATE VIEW extra AS SELECT * FROM "local_batch_jobs"')],['uppercase prefix',d=>d.exec('CREATE VIEW LOCAL_BATCH_extra AS SELECT 1')],
  ['manifest hash',d=>d.exec("UPDATE local_batch_jobs SET manifest_hash='"+'0'.repeat(64)+"'")],['source hash',d=>d.exec("UPDATE local_batch_inputs SET source_hash='"+'0'.repeat(64)+"'")],
  ['binding missing',d=>d.exec('DELETE FROM local_batch_input_bindings')],['active mismatch',d=>d.exec('UPDATE local_batch_database_instances SET audit_instance_id=NULL')],
 ];
 for(const [name,attack] of attacks){const h=await fresh({batch:2,audit:2});try{job(h);const b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'valid')});assert.equal(b.ok,true);attack(h.db);const before=logical(h.db);assert.equal(S.inspectBatchSchema(h.db,{allowUnmappedAudit:true}).ok,false,name);assert.equal(LB.createBackup({dbPath:h.file,outDir:join(h.dir,'bad-source')}).ok,false,name);assert.equal(logical(h.db),before);const snapshot=join(b.backupDir,LB.SNAPSHOT_FILE),d=new DatabaseSync(snapshot);try{attack(d);}finally{d.close();}rewriteSnapshotDigest(b);assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,false,name);assert.equal(LB.restoreNew({backupDir:b.backupDir,targetDir:join(h.dir,'bad-target')}).ok,false,name);assert.equal(fs.existsSync(join(h.dir,'bad-target')),false);}finally{h.close();}}
 for(const [name,replace] of [['literal case',sql=>sql.replace("'restore_pending'","'RESTORE_PENDING'")],['FK',sql=>sql.replaceAll('ON DELETE RESTRICT','ON DELETE CASCADE')],['CHECK',sql=>sql.replace('is_active IN (0,1)','is_active IN (0,1,2)')]]){const h=await fresh({batch:2});try{const b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'valid')});assert.equal(b.ok,true);for(const file of [h.file,join(b.backupDir,LB.SNAPSHOT_FILE)]){const d=file===h.file?h.db:new DatabaseSync(file);try{const old=d.prepare("SELECT sql FROM sqlite_master WHERE name='local_batch_database_instances'").get().sql;const rows=d.prepare('SELECT * FROM local_batch_database_instances').all();d.exec('DROP TABLE local_batch_database_instances');d.exec(replace(old));d.exec('CREATE UNIQUE INDEX idx_local_batch_instances_active ON local_batch_database_instances(is_active) WHERE is_active=1');for(const row of rows)d.prepare('INSERT INTO local_batch_database_instances VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(row));}finally{if(d!==h.db)d.close();}}assert.equal(S.inspectBatchSchema(h.db).ok,false,name);assert.equal(LB.createBackup({dbPath:h.file,outDir:join(h.dir,'bad-source')}).ok,false,name);rewriteSnapshotDigest(b);assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,false,name);}finally{h.close();}}
 const half=await fresh();try{half.db.exec('CREATE VIEW LOCAL_BATCH_extra AS SELECT 1');assert.equal(S.inspectBatchSchema(half.db).state,'invalid');const before=logical(half.db);await assert.rejects(S.installBatchSchema(half.db,{dbPath:half.file,outDir:join(half.dir,'denied')}));assert.equal(logical(half.db),before);}finally{half.close();}
 const h=await fresh({batch:2});try{const b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'omitted')}),m=b.manifest;assert.equal(b.ok,true);m.components=m.components.filter(c=>c.name!=='local-batch');fs.writeFileSync(join(b.backupDir,LB.MANIFEST_FILE),JSON.stringify(m));assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,false);}finally{h.close();}
});
function rewriteSnapshotDigest(b){const snapshot=join(b.backupDir,LB.SNAPSHOT_FILE),m=JSON.parse(fs.readFileSync(join(b.backupDir,LB.MANIFEST_FILE),'utf8'));m.snapshot.sha256=hash(snapshot);m.snapshot.bytes=fs.statSync(snapshot).size;fs.writeFileSync(join(b.backupDir,LB.MANIFEST_FILE),JSON.stringify(m));}
console.log('6 local-batch-backup-integration suites passed; retained '+ROOT);
