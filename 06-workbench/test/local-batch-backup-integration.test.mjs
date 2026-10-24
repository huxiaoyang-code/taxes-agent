import {assert,fs,join,DatabaseSync,randomUUID,ROOT,S,LB,AS,fresh,job,logical,digest,hash,suite as baseSuite,realReports,child,originalRows,downgrade} from './local-batch-install.test.mjs';
const REPORT_ONLY=process.env.BATCH_BACKUP_TEST_CASE==='report-p2';if(process.env.BATCH_BACKUP_TEST_CASE&&!REPORT_ONLY)throw Error('unknown backup test selection');let executed=0;
async function suite(name,fn){if(REPORT_ONLY&&!name.startsWith('real report publication')&&!name.startsWith('each malformed snapshot/artifact'))return;await baseSuite(name,fn);executed++;}
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

await suite('real report publication windows and mutable history keep only saved-row authority',async()=>{
 const roundtrip=async(h,name)=>{
  assert.equal(S.inspectBatchSchema(h.db).ok,true,JSON.stringify(S.inspectBatchSchema(h.db)));const before=logical(h.db),b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,name+'-backup')});assert.equal(b.ok,true,JSON.stringify(b));assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,true);const target=join(h.dir,name+'-restore');assert.equal(LB.restoreNew({backupDir:b.backupDir,targetDir:target}).ok,true);const file=join(target,LB.TARGET_DATABASE_FILE),d=new DatabaseSync(file);d.exec('PRAGMA foreign_keys=ON');try{assert.equal(logical(d),before);assert.equal(S.inspectBatchSchema(d).ok,true);if(d.prepare("SELECT 1 FROM sqlite_master WHERE name='local_batch_lock_epochs'").get())d.exec('DROP TABLE local_batch_lock_epochs');d.exec('DROP TABLE local_batch_input_bindings;DROP TABLE local_batch_job_bindings;DROP TABLE local_batch_database_instances;UPDATE local_batch_component SET version=1');const old=originalRows(d);await S.installBatchSchema(d,{dbPath:file,outDir:join(h.dir,name+'-upgrade')});assert.equal(originalRows(d),old);assert.equal(S.inspectBatchSchema(d).ok,true);}finally{d.close();console.log('restored/upgraded DB actualclose '+name);}assert.equal(logical(h.db),before);assert.equal(LB.createBackup({dbPath:file,outDir:join(h.dir,name+'-again')}).ok,true);console.log('legal actual '+name+' logical SHA256 '+digest(before));
 };
 const pending=await fresh({batch:3});try{const j=job(pending,{report:true});assert.equal(pending.db.prepare('SELECT COUNT(*) n FROM local_batch_snapshots').get().n,0);assert.equal(pending.db.prepare('SELECT COUNT(*) n FROM local_batch_artifacts').get().n,0);assert.equal(pending.db.prepare('SELECT MAX(attempt) n FROM local_batch_stages').get().n,0);await roundtrip(pending,'unclaimed-no-report-records');}finally{pending.close();}
 const claimed=await fresh({batch:3});try{await realReports(claimed,{window:'before-register',formats:['csv']});assert.equal(claimed.db.prepare('SELECT COUNT(*) n FROM local_batch_snapshots').get().n,1);assert.equal(claimed.db.prepare('SELECT COUNT(*) n FROM local_batch_artifacts').get().n,0);const stage=claimed.db.prepare('SELECT * FROM local_batch_stages').get();assert.equal(stage.status,'running');assert.equal(stage.attempt,1);await roundtrip(claimed,'claimed-snapshot-no-artifact');}finally{claimed.close();}
 for(const window of ['before-rename','after-publish']){const h=await fresh({batch:3});try{await realReports(h,{window,formats:['csv']});assert.equal(h.db.prepare('SELECT status FROM local_batch_artifacts').get().status,'publishing');assert.equal(h.db.prepare('SELECT status FROM local_batch_stages').get().status,'running');
  const artifact=h.db.prepare('SELECT * FROM local_batch_artifacts').get();
  for(const [field,bad] of [['bytes_hash','e'.repeat(64)],['bytes',artifact.bytes+1],['snapshot_hash','e'.repeat(64)]]) {
   h.db.prepare('UPDATE local_batch_artifacts SET '+field+'=? WHERE id=?').run(bad,artifact.id);const badState=logical(h.db);assert.equal(S.inspectBatchSchema(h.db).ok,false,'current publishing '+field);assert.equal(LB.createBackup({dbPath:h.file,outDir:join(h.dir,'refuse-current-'+field)}).ok,false);assert.equal(logical(h.db),badState);h.db.prepare('UPDATE local_batch_artifacts SET '+field+'=? WHERE id=?').run(artifact[field],artifact.id);assert.equal(S.inspectBatchSchema(h.db).ok,true);
  }
  await roundtrip(h,window);}finally{h.close();}}
 const invalid=await fresh({batch:3});try{const saved=await realReports(invalid,{formats:['csv']}),artifact=invalid.db.prepare('SELECT * FROM local_batch_artifacts').get(),stage=invalid.db.prepare('SELECT * FROM local_batch_stages').get();fs.writeFileSync(join(saved.outputDir,artifact.relative_path),'synthetic changed bytes');S.resetStage(invalid.db,{stageId:stage.id,status:S.STAGE_STATUS.NEEDS_REVIEW,errorCode:'evidence_changed'});S.resetStagesForRetry(invalid.db,{jobKey:saved.job.job_key});
  const code="const R=await import('./server/local-batch-runner.mjs');try{await R.resumeJob({jobKey:"+JSON.stringify(saved.job.job_key)+",hooks:{beforeArtifactPublish(){console.log('W3A_INVALID_WINDOW');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);}}});}finally{R.database.close();}";const c=await child(['--input-type=module','-e',code],{env:{WORKBENCH_DATA_DIR:invalid.dir},onOutput(text,p){if(text.includes('W3A_INVALID_WINDOW'))p.kill();}});assert.equal(c.closed,true);assert.match(c.out,/W3A_INVALID_WINDOW/);const old=invalid.db.prepare('SELECT * FROM local_batch_artifacts').get(),current=invalid.db.prepare('SELECT * FROM local_batch_stages').get();assert.equal(old.status,'invalid');assert.equal(old.attempt<current.attempt,true);await roundtrip(invalid,'invalid-old-attempt');
 }finally{invalid.close();}
 const h=await fresh({batch:3});try{const saved=await realReports(h),stage=h.db.prepare("SELECT * FROM local_batch_stages WHERE stage_key='report:balance-sheet:csv'").get(),old=h.db.prepare("SELECT * FROM local_batch_artifacts WHERE format='csv'").get();
  const priorSnapshot=h.db.prepare('SELECT * FROM local_batch_snapshots').get(),changedCsv=priorSnapshot.csv_text+'\n';S.saveSnapshot(h.db,{jobId:priorSnapshot.job_id,itemId:priorSnapshot.item_id,period:priorSnapshot.period,kind:priorSnapshot.kind,dtoHash:priorSnapshot.dto_hash,businessHash:priorSnapshot.business_hash,dtoJson:priorSnapshot.dto_json,csvText:changedCsv,csvHash:S.sha256(changedCsv)});assert.notEqual(old.bytes_hash,S.sha256(changedCsv));await roundtrip(h,'checkpointed-csv-representation-history');
  S.resetStage(h.db,{stageId:stage.id,status:S.STAGE_STATUS.NEEDS_REVIEW,errorCode:'evidence_changed'});S.resetStagesForRetry(h.db,{jobKey:saved.job.job_key,stageKey:stage.stage_key});
  const code="const {db}=await import('./server/db.mjs');try{const A=await import('./server/accounting.mjs');const B=await import('./server/local-batch-actions.mjs');const S=await import('./server/local-batch-storage.mjs');A.setOpeningBalances(1,[{code:'1002',debit:402.41},{code:'3001',credit:402.41}]);const snapshots=B.buildReportSnapshots({item:S.getItem(db,"+stage.item_id+"),period:'2026-01',reports:[{kind:'balance-sheet',code:null}]});for(const snapshot of snapshots.reports)B.persistSnapshot({jobId:"+saved.job.id+",itemId:"+stage.item_id+",snapshot});console.log('actual business 379.23 -> 402.41; new DTO persisted');}finally{db.close();console.log('DB actualclose');}";const c=await child(['--input-type=module','-e',code],{env:{WORKBENCH_DATA_DIR:h.dir}});assert.equal(c.code,0,c.err+c.out);const snap=h.db.prepare('SELECT * FROM local_batch_snapshots').get(),nextHash=S.sha256(S.canonicalJson({dtoHash:snap.dto_hash,businessHash:snap.business_hash,format:'csv',code:null}));assert.notEqual(nextHash,old.snapshot_hash);assert.equal(S.inspectBatchSchema(h.db).ok,true);const claimCode="import {DatabaseSync} from 'node:sqlite';const S=await import('./server/local-batch-storage.mjs');const db=new DatabaseSync("+JSON.stringify(h.file)+");db.exec('PRAGMA foreign_keys=ON');try{const lock=S.acquireLock(db,{resourceKey:'job:"+saved.job.id+"',instance:'synthetic-next-claim',pid:process.pid});S.claimStage(db,{stageId:"+stage.id+",instance:'synthetic-next-claim',token:lock.token,inputHash:"+JSON.stringify(nextHash)+"});console.log(process.pid);}finally{db.close();console.log('DB actualclose');}";const claimed=await child(['--input-type=module','-e',claimCode]);assert.equal(claimed.code,0,claimed.err+claimed.out);assert.equal(old.attempt<h.db.prepare('SELECT attempt FROM local_batch_stages WHERE id=?').get(stage.id).attempt,true);await roundtrip(h,'mutable-latest-history');
 }finally{h.close();}
});
await suite('each malformed snapshot/artifact field rejects inspect source verify restore and protected v1 upgrade',async()=>{
 const h=await fresh({batch:3});let v1;
 try{
  const actual=await realReports(h);const other=await realReports(h,{formats:['csv'],jobKey:'other-'+randomUUID()});const ownItem=h.db.prepare('SELECT id FROM local_batch_items WHERE job_id=?').get(actual.job.id).id,otherArtifact=h.db.prepare('SELECT * FROM local_batch_artifacts WHERE job_id=?').get(other.job.id);job(h,{file:true});
  // Synthetic historical saved-row projection only: actual reports above ran on
  // batch3. This is not an official downgrade or historical runner execution.
  // v2 shares these eleven tables and saved rows; released epoch history has no
  // v2 representation. Keep all rows/sequence bytes, then validate strict v2.
  const beforeRows=originalRows(h.db);assert.equal(h.db.prepare('SELECT COUNT(*) n FROM local_batch_locks').get().n,0);h.db.exec('DROP TABLE local_batch_lock_epochs;UPDATE local_batch_component SET version=2');assert.equal(S.assertBatchSchema(h.db).version,2);assert.equal(originalRows(h.db),beforeRows);
  const initial=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'template-v2')});assert.equal(initial.ok,true);
  const v1dir=join(ROOT,randomUUID());fs.mkdirSync(v1dir);const v1file=join(v1dir,'workbench.db');fs.copyFileSync(join(initial.backupDir,LB.SNAPSHOT_FILE),v1file);const d=new DatabaseSync(v1file);d.exec('PRAGMA foreign_keys=ON');try{downgrade({db:d});v1=LB.createBackup({dbPath:v1file,outDir:join(v1dir,'template-v1')});assert.equal(v1.ok,true);}finally{d.close();console.log('v1 template DB actualclose');}
  const csv=" WHERE format='csv' AND item_id="+ownItem,snap=" WHERE kind='balance-sheet' AND item_id="+ownItem;
  const ownStage=" WHERE item_id="+ownItem+" AND stage_key='report:balance-sheet:csv'";
  const attacks=[
   ['succeeded-own-artifact-missing',d=>d.exec('DELETE FROM local_batch_artifacts'+csv)],
   ['succeeded-own-records-missing',d=>d.exec('DELETE FROM local_batch_artifacts WHERE item_id='+ownItem+';DELETE FROM local_batch_snapshots'+snap)],
   ['succeeded-deleted-artifact-cross-item-evidence',d=>{d.exec('DELETE FROM local_batch_artifacts'+csv);const r=d.prepare('SELECT * FROM local_batch_stages'+ownStage).get(),e=JSON.parse(r.evidence_json);e.artifactKey=otherArtifact.artifact_key;d.prepare('UPDATE local_batch_stages SET evidence_json=?'+ownStage).run(S.canonicalJson(e));}],
   ['claimed-running-own-snapshot-missing',d=>d.exec("UPDATE local_batch_stages SET status='running' WHERE item_id="+ownItem+";DELETE FROM local_batch_artifacts WHERE item_id="+ownItem+';DELETE FROM local_batch_snapshots'+snap)],
   ['snapshot-key',d=>d.exec("UPDATE local_batch_snapshots SET snapshot_key='wrong'"+snap)],
   ['snapshot-period-invalid',d=>d.exec("UPDATE local_batch_snapshots SET period='2099-99',snapshot_key=job_id||':'||item_id||':2099-99:'||kind"+snap)],
   ['snapshot-period-unrequested',d=>d.exec("UPDATE local_batch_snapshots SET period='2026-02',snapshot_key=job_id||':'||item_id||':2026-02:'||kind"+snap)],
   ['snapshot-kind-invalid',d=>d.exec("UPDATE local_batch_snapshots SET kind='not-a-report',snapshot_key=job_id||':'||item_id||':'||period||':not-a-report'"+snap)],
   ['snapshot-kind-unrequested',d=>d.exec("UPDATE local_batch_snapshots SET kind='income-statement',snapshot_key=job_id||':'||item_id||':'||period||':income-statement'"+snap)],
   ['snapshot-job',d=>d.exec('UPDATE local_batch_snapshots SET job_id=(SELECT MAX(id) FROM local_batch_jobs)'+snap)],
   ['snapshot-item',d=>d.exec('UPDATE local_batch_snapshots SET item_id=(SELECT MAX(id) FROM local_batch_items)'+snap)],
   ['snapshot-dto-kind',d=>{const r=d.prepare('SELECT * FROM local_batch_snapshots'+snap).get(),dto=JSON.parse(r.dto_json);dto.kind='income-statement';const json=JSON.stringify(dto);d.prepare('UPDATE local_batch_snapshots SET dto_json=?,dto_hash=?'+snap).run(json,S.sha256(json));}],
   ['snapshot-dto-period',d=>{const r=d.prepare('SELECT * FROM local_batch_snapshots'+snap).get(),dto=JSON.parse(r.dto_json);dto.period='2026-02';const json=JSON.stringify(dto);d.prepare('UPDATE local_batch_snapshots SET dto_json=?,dto_hash=?'+snap).run(json,S.sha256(json));}],
   ['snapshot-dto-hash',d=>d.exec("UPDATE local_batch_snapshots SET dto_hash='"+'e'.repeat(64)+"'"+snap)],
   ['snapshot-csv-hash',d=>d.exec("UPDATE local_batch_snapshots SET csv_hash='"+'e'.repeat(64)+"'"+snap)],
   ['snapshot-csv-content',d=>d.exec("UPDATE local_batch_snapshots SET csv_text=csv_text||'changed'"+snap)],
   ['snapshot-missing',d=>d.exec('DELETE FROM local_batch_snapshots'+snap)],
   ['artifact-key',d=>d.exec("UPDATE local_batch_artifacts SET artifact_key='wrong'"+csv)],
   ['artifact-stage',d=>d.exec("UPDATE local_batch_artifacts SET stage_key='report:no-such-stage'"+csv)],
   ['artifact-period',d=>d.exec("UPDATE local_batch_artifacts SET period='2026-02'"+csv)],
   ['artifact-kind-invalid',d=>d.exec("UPDATE local_batch_artifacts SET kind='not-a-report'"+csv)],
   ['artifact-kind-unrequested',d=>d.exec("UPDATE local_batch_artifacts SET kind='income-statement'"+csv)],
   ['artifact-format-invalid',d=>d.exec("UPDATE local_batch_artifacts SET format='txt'"+csv)],
   ['artifact-format-mismatch',d=>d.exec("UPDATE local_batch_artifacts SET format='pdf'"+csv)],
   ['artifact-account-code',d=>d.exec("UPDATE local_batch_artifacts SET account_code='1002'"+csv)],
   ['artifact-job',d=>d.exec('UPDATE local_batch_artifacts SET job_id=(SELECT MAX(id) FROM local_batch_jobs)'+csv)],
   ['artifact-item',d=>d.exec('UPDATE local_batch_artifacts SET item_id=(SELECT MAX(id) FROM local_batch_items)'+csv)],
   ['artifact-status',d=>d.exec("UPDATE local_batch_artifacts SET status='not-a-status'"+csv)],
   ['artifact-path-traversal',d=>d.exec("UPDATE local_batch_artifacts SET relative_path='../../outside.csv'"+csv)],
   ['artifact-path-absolute',d=>d.exec("UPDATE local_batch_artifacts SET relative_path='C:/outside.csv'"+csv)],
   ['artifact-path-backslash',d=>d.prepare('UPDATE local_batch_artifacts SET relative_path=?'+csv).run('..\\outside.csv')],
   ['artifact-path-unrelated-safe',d=>d.exec("UPDATE local_batch_artifacts SET relative_path='elsewhere/report.csv'"+csv)],
   ['artifact-attempt-negative',d=>d.exec('UPDATE local_batch_artifacts SET attempt=-4'+csv)],
   ['artifact-attempt-zero',d=>d.exec('UPDATE local_batch_artifacts SET attempt=0'+csv)],
   ['artifact-attempt-future',d=>d.exec('UPDATE local_batch_artifacts SET attempt=attempt+1'+csv)],
   ['artifact-snapshot-hash',d=>d.exec("UPDATE local_batch_artifacts SET snapshot_hash='"+'e'.repeat(64)+"'"+csv)],
   ['artifact-bytes-hash',d=>d.exec("UPDATE local_batch_artifacts SET bytes_hash='"+'e'.repeat(64)+"'"+csv)],
   ['artifact-bytes',d=>d.exec('UPDATE local_batch_artifacts SET bytes=bytes+1'+csv)],
   ['artifact-empty-bytes',d=>d.exec('UPDATE local_batch_artifacts SET bytes=0'+csv)],
   ['artifact-mime',d=>d.exec("UPDATE local_batch_artifacts SET mime='application/pdf'"+csv)],
   ['artifact-csv-worker',d=>d.exec('UPDATE local_batch_artifacts SET worker_thread_id=1'+csv)],
   ['artifact-render-start',d=>d.exec('UPDATE local_batch_artifacts SET render_started=-1'+csv)],
   ['artifact-csv-render-finish',d=>d.exec('UPDATE local_batch_artifacts SET render_finished=render_started+1'+csv)],
   ['artifact-xlsx-worker',d=>d.exec("UPDATE local_batch_artifacts SET worker_thread_id=0 WHERE format='xlsx'")],
   ['artifact-xlsx-render-order',d=>d.exec("UPDATE local_batch_artifacts SET render_finished=render_started-1 WHERE format='xlsx'")],
   ['artifact-xlsx-render-missing',d=>d.exec("UPDATE local_batch_artifacts SET render_finished=NULL WHERE format='xlsx'")],
  ];
  const watched=[actual.outputDir,other.outputDir,join(h.dir,'input.json')].map(p=>p.toLowerCase().replaceAll('\\','/'));const external=[];const methods=['readFileSync','openSync','statSync','lstatSync','existsSync','realpathSync'],originals=new Map(methods.map(k=>[k,fs[k]]));
  const {syncBuiltinESMExports}=await import('node:module');for(const method of methods){const real=fs[method];fs[method]=function(file,...args){const full=typeof file==='string'?file.toLowerCase().replaceAll('\\','/'):'';if(watched.some(p=>full===p||full.startsWith(p+'/'))){external.push({method,file});throw Error('validator tried external path');}return real.call(fs,file,...args);};if(method==='realpathSync')fs[method].native=originals.get(method).native;}syncBuiltinESMExports();
  let rejected=0;try{
   assert.equal(S.inspectBatchSchema(h.db).ok,true);assert.equal(LB.createBackup({dbPath:h.file,outDir:join(h.dir,'no-external-read')}).ok,true);
   for(const template of [v1,initial])for(const [name,attack] of attacks){const dir=join(ROOT,randomUUID());fs.mkdirSync(dir);const file=join(dir,'workbench.db');fs.copyFileSync(join(template.backupDir,LB.SNAPSHOT_FILE),file);const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');try{assert.equal(S.inspectBatchSchema(db).ok,true);attack(db);const before=logical(db),sourceHash=hash(file);assert.equal(S.inspectBatchSchema(db).ok,false,name);assert.equal(LB.createBackup({dbPath:file,outDir:join(dir,'bad-source')}).ok,false,name);await assert.rejects(S.installBatchSchema(db,{dbPath:file,outDir:join(dir,'bad-upgrade')}));assert.equal(logical(db),before,name);assert.equal(hash(file),sourceHash,name);assert.equal(fs.existsSync(join(dir,'bad-source')),false);assert.equal(fs.existsSync(join(dir,'bad-upgrade')),false);console.log('bad field v'+template.manifest.components.find(c=>c.name==='local-batch').version+' '+name+' source zero-change '+digest(before));}finally{db.close();console.log('malformed source DB actualclose '+name);}
    const backupDir=join(dir,'tampered');fs.mkdirSync(backupDir);const snapshot=join(backupDir,LB.SNAPSHOT_FILE);fs.copyFileSync(join(template.backupDir,LB.SNAPSHOT_FILE),snapshot);const copy=new DatabaseSync(snapshot);copy.exec('PRAGMA foreign_keys=ON');try{attack(copy);}finally{copy.close();console.log('tampered snapshot DB actualclose '+name);}const manifest=JSON.parse(JSON.stringify(template.manifest));manifest.snapshot.sha256=hash(snapshot);manifest.snapshot.bytes=fs.statSync(snapshot).size;fs.writeFileSync(join(backupDir,LB.MANIFEST_FILE),JSON.stringify(manifest));const before=hash(snapshot);assert.equal(LB.verifyBackup({backupDir}).ok,false,name);assert.equal(LB.restoreNew({backupDir,targetDir:join(dir,'refused-target')}).ok,false,name);assert.equal(fs.existsSync(join(dir,'refused-target')),false);assert.equal(hash(snapshot),before);rejected++;
   }
   assert.equal(external.length,0,JSON.stringify(external));assert.equal(rejected,attacks.length*2);console.log('independent bad fields '+attacks.length+' x versions1/2 = '+rejected+'; external input/output reads '+external.length);
  }finally{for(const [method,real] of originals)fs[method]=real;syncBuiltinESMExports();}
 }finally{h.close();}
});


await suite('current batch3 exact epoch history official roundtrips without replacing 48 historical combinations',async()=>{
 for(const options of [{version:3,batch:3},{version:5,bank:true,aux:true,audit:2,batch:3}]){const h=await fresh(options);try{h.db.prepare('INSERT INTO local_batch_lock_epochs VALUES(?,7)').run('account-set:999999');h.db.prepare('INSERT INTO local_batch_lock_epochs VALUES(?,12)').run('book:RELEASED-HISTORY');const before=logical(h.db),epochs=h.db.prepare('SELECT * FROM local_batch_lock_epochs ORDER BY resource_key').all();const b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'three')});assert.equal(b.ok,true,JSON.stringify(b));assert.equal(b.manifest.components.find(c=>c.name==='local-batch').version,3);assert.equal(b.manifest.components.find(c=>c.name==='local-batch').tables.length,12);assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,true);const target=join(h.dir,'three-restore');assert.equal(LB.restoreNew({backupDir:b.backupDir,targetDir:target}).ok,true);const db=new DatabaseSync(join(target,'workbench.db'),{readOnly:true});try{assert.equal(logical(db),before);assert.equal(S.assertBatchSchema(db).version,3);assert.deepEqual(db.prepare('SELECT * FROM local_batch_lock_epochs ORDER BY resource_key').all(),epochs);}finally{db.close();console.log('batch3 restore readonly actualclose');}assert.equal(logical(h.db),before);}finally{h.close();}}
});

assert.equal(executed,REPORT_ONLY?2:9);console.log(executed+' local-batch-backup-integration suites passed; retained '+ROOT);
