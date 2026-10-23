import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
export {assert,fs,join,resolve,DatabaseSync,randomUUID,pathToFileURL};
export const WORKBENCH=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const ROOT=join(WORKBENCH,'..','.agent-runs','batch2-test-'+randomUUID());
export function plain(p){for(let x=resolve(p);;x=dirname(x)){assert.equal(fs.lstatSync(x).isSymbolicLink(),false);assert.equal(fs.realpathSync.native(x).toLowerCase(),x.toLowerCase());if(dirname(x)===x)break;}}
fs.mkdirSync(ROOT,{recursive:true});plain(ROOT);fs.mkdirSync(join(ROOT,'seed'));plain(join(ROOT,'seed'));
process.env.TEMP=ROOT;process.env.TMP=ROOT;process.env.WORKBENCH_DATA_DIR=join(ROOT,'seed');process.env.KEEP_FIXTURES='1';process.env.WORKBENCH_TEST_KEEP_FIXTURES='1';
export const S=await import('../server/local-batch-storage.mjs'),LB=await import('../server/local-backup.mjs'),AS=await import('../server/local-audit-storage.mjs');
let seed;
export async function fresh({version=5,batch=0,audit=0,bank=false,aux=false,journal='delete'}={}) {
 if(!seed)seed=(async()=>{const {db}=await import('../server/db.mjs');try{const A=await import('../server/accounting.mjs');for(const [key,amount] of [['甲',379.23],['乙',68.59]]){const id=A.createAccountSet({name:'Synthetic '+key,start_period:'2026-01',profileId:'small-2011-basic-v1',enterprise:{enterpriseKey:'BATCH-SYNTH-'+key,enterpriseName:'Synthetic '+key}}).id;A.setOpeningBalances(id,[{code:'1002',debit:amount},{code:'3001',credit:amount}]);}return db.prepare('SELECT path FROM schema_backups ORDER BY id LIMIT 1').get().path;}finally{db.close();console.log('seed DB actualclose');}})();
 const old=await seed,dir=join(ROOT,randomUUID());fs.mkdirSync(dir);plain(dir);const file=join(dir,'workbench.db');
 fs.copyFileSync(version===5?join(ROOT,'seed','workbench.db'):old,file);
 if(version!==5){const I=await import('../server/import-storage.mjs'),d=new DatabaseSync(file);try{I.ensureImportSchema(d,{dataDir:dir,targetVersion:version});}finally{d.close();}}
 const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=0');db.exec('PRAGMA journal_mode='+journal);
 const h={db,file,dir,closed:false,close(){if(!this.closed){db.close();this.closed=true;console.log('DB actualclose '+file);}}};
 try{
  if(bank)await (await import('../server/bank-storage.mjs')).ensureBankSchema(db,{dbPath:file,dataDir:dir,backupService:LB});
  if(aux)await (await import('../server/auxiliary-storage.mjs')).ensureAuxiliarySchema(db,{dbPath:file,outDir:join(dir,'before-aux')});
  if(audit===1)installLegacyAudit(db);else if(audit===2)await AS.installAuditSchema(db,{dbPath:file,outDir:join(dir,'before-audit')});
  if(batch===1)installLegacyBatch(db);else if(batch===2)await S.installBatchSchema(db,{dbPath:file,outDir:join(dir,'before-batch')});
  return h;
 }catch(e){h.close();throw e;}
}
function contractDdl(db,contract){for(const r of contract.facts.objects.filter(r=>r.type==='table'))db.exec(r.sql);for(const table of contract.facts.tables)for(const index of [...table.indexes].sort((a,b)=>b.seq-a.seq)){const r=contract.facts.objects.find(r=>r.type==='index'&&r.name===index.name);if(r?.sql)db.exec(r.sql);}for(const type of ['trigger','view'])for(const r of contract.facts.objects.filter(r=>r.sql!==null&&r.type===type))db.exec(r.sql);}
export function installLegacyBatch(db){contractDdl(db,S.batchComponentContract(1));db.prepare('INSERT INTO local_batch_component VALUES(?,?,?,?)').run(S.LOCAL_BATCH_COMPONENT,1,'2026-10-23T00:00:00.000Z','legacy');}
export function installLegacyAudit(db){contractDdl(db,AS.auditComponentContract(1));db.prepare('INSERT INTO audit_components VALUES(?,?,?,?)').run('business-audit',1,'2026-10-23T00:00:00.000Z','legacy');db.prepare('INSERT INTO audit_database_instances VALUES(?,?,NULL,1,?)').run(randomUUID(),'2026-10-23T00:00:00.000Z','initial');}
export const logical=db=>JSON.stringify(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all().concat(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>({name,rows:db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()}))));
export const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export const digest=v=>createHash('sha256').update(v).digest('hex');
export async function child(args,{env={},onOutput}={}){return new Promise((ok,no)=>{const c=spawn(process.execPath,args,{cwd:WORKBENCH,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>{out+=b;onOutput?.(String(b),c);});c.stderr.on('data',b=>err+=b);c.on('error',no);c.on('close',(code,signal)=>{console.log('child actualclose '+code+'/'+signal);ok({code,signal,out,err,closed:true});});});}
const CASE_FILTER=process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href?process.env.BATCH_TEST_CASE:null;let selectedSuites=0;
export async function suite(name,fn){if(CASE_FILTER&&name!==CASE_FILTER)return;selectedSuites++;try{await fn();console.log('PASS '+name);}catch(e){console.error('FAIL '+name,e);process.exitCode=1;throw e;}}
export function job(h,{file=false,long=false,report=false}={}) {
 const raw={schemaVersion:1,jobKey:'job-'+randomUUID(),items:[{itemKey:'item1',source:{system:'synthetic',enterpriseKey:long?'中'.repeat(128):'合成企业',enterpriseName:'Synthetic'},periods:[{period:'2026-01',imports:[{batchId:long?'b'.repeat(128):'b1',mode:'create',payload:{amount:42.37},confirmNewBinding:true}],reports:report?[{kind:'balance-sheet',formats:['csv']}]:[]}]}]};
 if(file){fs.writeFileSync(join(h.dir,'input.json'),' { "amount": 42.37 }\n');raw.items[0].periods[0].imports[0].payloadFile='input.json';delete raw.items[0].periods[0].imports[0].payload;}
 const validated=S.validateManifest(raw);assert.equal(validated.ok,true,JSON.stringify(validated.errors));const manifest=validated.manifest,manifestJson=S.canonicalJson(manifest),manifestHash=S.sha256(manifestJson),plan=S.buildPlan({manifest,manifestDir:h.dir});
 const result=S.createJob(h.db,{manifest,manifestJson,manifestHash,outputDir:join(h.dir,'out'),...plan});return {...result,manifest,...plan};
}
export function downgrade(h){h.db.exec('DROP TABLE local_batch_input_bindings; DROP TABLE local_batch_job_bindings; DROP TABLE local_batch_database_instances; UPDATE local_batch_component SET version=1');assert.equal(S.assertBatchSchema(h.db).version,1);}
export function originalRows(db){return JSON.stringify(S.LOCAL_BATCH_V1_TABLES.filter(t=>t!=='local_batch_component').map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]).concat([['sequence',db.prepare("SELECT * FROM sqlite_sequence WHERE name GLOB 'local_batch_*' ORDER BY name").all()]]));}
export async function realReports(h,{window=null,formats=['csv','xlsx'],jobKey='report-'+randomUUID()}={}) {
 const account=h.db.prepare('SELECT account_set_id,enterprise_key FROM import_enterprise_account_sets ORDER BY account_set_id LIMIT 1').get();
 assert.ok(account);const manifest=S.validateManifest({schemaVersion:1,jobKey,concurrency:1,items:[{itemKey:'actual',source:{system:'synthetic',enterpriseKey:account.enterprise_key,enterpriseName:'Synthetic'},accountSetId:account.account_set_id,periods:[{period:'2026-01',reports:[{kind:'balance-sheet',formats}]}]}]}).manifest;
 assert.ok(manifest);const outputDir=join(h.dir,'reports-'+jobKey);
 const pause="console.log('W3A_WINDOW');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);";
 const setup=window==='before-rename'?"import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;fs.renameSync=function(a,b,...rest){if(String(b).endsWith('.csv')){"+pause+"}return rename(a,b,...rest);};syncBuiltinESMExports();":"";
 const hook=window==='after-publish'?"{afterArtifactPublish(){"+pause+"}}":'null';
 const code=setup+"const R=await import('./server/local-batch-runner.mjs');const S=await import('./server/local-batch-storage.mjs');const manifest="+JSON.stringify(manifest)+";try{const manifestJson=S.canonicalJson(manifest);const result=await R.createAndRun({manifest,manifestJson,manifestHash:S.sha256(manifestJson),...S.buildPlan({manifest,manifestDir:"+JSON.stringify(h.dir)+"}),outputDir:"+JSON.stringify(outputDir)+",hooks:"+hook+"});console.log(JSON.stringify({status:result.finalStatus??result.status}));}finally{R.database.close();console.log('DB actualclose');}";
 const result=await child(['--input-type=module','-e',code],{env:{WORKBENCH_DATA_DIR:h.dir},onOutput:window?(text,p)=>{if(text.includes('W3A_WINDOW'))p.kill();}:undefined});
 if(window){assert.equal(result.closed,true);assert.match(result.out,/W3A_WINDOW/);}else {assert.equal(result.code,0,result.err+result.out);assert.match(result.out,/"status":"succeeded"/);}
 const saved=S.getJobByKey(h.db,jobKey);assert.ok(saved);return {job:saved,manifest,outputDir,result};
}
async function main(){
 await suite('sync ensure is strict and genuine fresh receipt builds one atomic v2 instance',async()=>{
  const dir=join(ROOT,randomUUID()),receipt=S.claimFreshDataDir(dir),db=new DatabaseSync(join(dir,'workbench.db'));db.exec('PRAGMA foreign_keys=ON');try{const r=S.ensureBatchSchema(db,{receipt});assert.equal(r.version,2);assert.equal(r.created,true);assert.equal(typeof r.then,'undefined');const id=S.readBatchInstance(db).instance_id;assert.equal(S.ensureBatchSchema(db).created,false);assert.equal(S.readBatchInstance(db).instance_id,id);assert.equal(S.inspectBatchSchema(db).ok,true);}finally{db.close();S.releaseFreshClaim(receipt);}
  const h=await fresh();try{const before=logical(h.db);assert.throws(()=>S.ensureBatchSchema(h.db,{receipt:{}}));assert.equal(logical(h.db),before);}finally{h.close();}
 });
 await suite('v1 upgrade keeps eight old tables, decimals, IDs, sequence, stages, inputs and locks',async()=>{
  const h=await fresh({batch:2,journal:'wal'});try{const j=job(h,{file:true,long:true,report:true});const stage=h.db.prepare("SELECT * FROM local_batch_stages WHERE stage_key LIKE 'report:%'").get();const dto=JSON.stringify({name:'合成',amount:42.37}),csv='amount\n42.37\n',business='a'.repeat(64);S.saveSnapshot(h.db,{jobId:j.job.id,itemId:stage.item_id,period:stage.period,kind:'balance-sheet',dtoHash:S.sha256(dto),businessHash:business,dtoJson:dto,csvText:csv,csvHash:S.sha256(csv)});const inputHash=S.sha256(S.canonicalJson({dtoHash:S.sha256(dto),businessHash:business,format:'csv',code:null}));h.db.prepare("UPDATE local_batch_stages SET attempt=1,status='succeeded',input_hash=?,evidence_json=? WHERE id=?").run(inputHash,S.canonicalJson({snapshotHash:inputHash,businessHash:business}),stage.id);
   const dead=await child(['--input-type=module','-e','console.log(process.pid)']);assert.equal(dead.code,0);const pid=Number(dead.out.trim());assert.equal(S.isProcessAlive(pid),false);
   S.acquireLock(h.db,{resourceKey:'book:'+'中'.repeat(128),instance:'dead-owner',pid});downgrade(h);const before=originalRows(h.db),v1=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'v1-proof')});assert.equal(v1.ok,true,JSON.stringify(v1));const r=await S.installBatchSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'upgrade')});assert.equal(r.from,1);assert.equal(r.to,2);assert.equal(originalRows(h.db),before);assert.equal(S.assertBatchSchema(h.db).version,2);assert.equal(h.db.prepare('SELECT COUNT(*) n FROM local_batch_input_bindings').get().n,1);console.log('old tables SHA256 '+digest(before)+' -> '+digest(originalRows(h.db)));
   h.close();const reopened=new DatabaseSync(h.file);try{assert.equal(S.readBatchInstance(reopened).instance_id,r.activeInstanceId);}finally{reopened.close();}
  }finally{h.close();}
 });
 await suite('caller BEGIN/SAVEPOINT, wrong path, zero file and in-memory all fail without caller rollback',async()=>{
  const h=await fresh({batch:1}),other=await fresh();try{for(const sql of ['BEGIN','SAVEPOINT caller']){h.db.exec(sql);const before=logical(h.db);await assert.rejects(S.installBatchSchema(h.db,{dbPath:h.file,outDir:join(h.dir,randomUUID())}),e=>e.code==='batch_transaction_conflict');assert.equal(h.db.isTransaction,true);assert.equal(logical(h.db),before);h.db.exec('ROLLBACK');}const before=logical(h.db);await assert.rejects(S.installBatchSchema(h.db,{dbPath:other.file,outDir:join(h.dir,'wrong')}),e=>e.code==='batch_backup_source_mismatch');assert.equal(logical(h.db),before);const file=join(h.dir,'zero.db');fs.writeFileSync(file,'');const d=new DatabaseSync(file);d.exec('PRAGMA foreign_keys=ON');try{await assert.rejects(S.installBatchSchema(d,{dbPath:file,outDir:join(h.dir,'zero')}));assert.equal(d.prepare('SELECT COUNT(*) n FROM sqlite_master').get().n,0);}finally{d.close();}}
  finally{h.close();other.close();}
 });
 await suite('real living PID, NULL/unverifiable PID, and running without corroborating lock deny maintenance',async()=>{
  for(const mode of ['alive','unknown','unlinked-stage']){const h=await fresh({batch:2});try{job(h);downgrade(h);if(mode==='unlinked-stage')h.db.exec("UPDATE local_batch_stages SET status='running',owner_instance='no-proof'");else S.acquireLock(h.db,{resourceKey:'job:1',instance:'owner',pid:mode==='alive'?process.pid:null});const before=logical(h.db);await assert.rejects(S.installBatchSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'denied')}),e=>e.code==='batch_owner_active');assert.equal(logical(h.db),before);assert.equal(fs.existsSync(join(h.dir,'denied')),false);}finally{h.close();}}
 });
 await suite('official backup/create failure and DDL failure roll back exact original source and retain evidence',async()=>{
  const h=await fresh({batch:1});try{const before=logical(h.db);fs.mkdirSync(join(h.dir,'occupied'));await assert.rejects(S.installBatchSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'occupied')}),e=>e.code==='batch_backup_invalid');assert.equal(logical(h.db),before);
   const exec=h.db.exec.bind(h.db);h.db.exec=sql=>{if(sql.startsWith('CREATE TABLE local_batch_database_instances'))throw Error('injected DDL');return exec(sql);};await assert.rejects(S.installBatchSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'ddl-failed')}),e=>e.code==='batch_schema_install_failed');h.db.exec=exec;assert.equal(logical(h.db),before);assert.equal(LB.verifyBackup({backupDir:join(h.dir,'ddl-failed')}).ok,true);console.log('rollback source SHA256 '+digest(before));
  }finally{h.close();}
 });
 await suite('active bindings gate cancel/retry/create before cancel mutation or external source reads',async()=>{
  const h=await fresh({batch:2});try{const j=job(h,{file:true});h.db.exec('UPDATE local_batch_jobs SET cancel_requested=1');fs.unlinkSync(join(h.dir,'input.json'));h.db.exec("UPDATE local_batch_input_bindings SET mode='disabled',source_path=NULL");const before=logical(h.db);assert.throws(()=>S.requestCancel(h.db,j.job.job_key),e=>e.code==='batch_binding_disabled');assert.throws(()=>S.resetStagesForRetry(h.db,{jobKey:j.job.job_key,allowSnapshotOnly:true}),e=>e.code==='batch_binding_disabled');assert.throws(()=>job(h),e=>e.code==='batch_binding_disabled');assert.equal(logical(h.db),before);
   const manifest=join(h.dir,'m.json');fs.writeFileSync(manifest,JSON.stringify({...j.manifest,jobKey:'fresh-job'}));const c=await child(['scripts/local-batch.mjs','start','--data-dir',h.dir,'--manifest',manifest,'--output-dir',join(h.dir,'newout')]);assert.equal(JSON.parse(c.out.trim()).error.code,'batch_binding_disabled');assert.equal(fs.existsSync(join(h.dir,'newout')),false);assert.equal(logical(h.db),before);
  }finally{h.close();}
 });
 await suite('v1 readonly status/inspect and CLI explicit install never implicitly upgrade',async()=>{
  const h=await fresh({batch:2});try{const j=job(h);downgrade(h);const before=logical(h.db);assert.equal(S.inspectDataDir(h.dir).batchVersion,1);const st=await child(['scripts/local-batch.mjs','status','--data-dir',h.dir,'--job-key',j.job.job_key]);assert.equal(st.code,1);assert.equal(JSON.parse(st.out).jobKey,j.job.job_key);assert.equal(logical(h.db),before);
   const r=await child(['scripts/local-batch.mjs','resume','--data-dir',h.dir,'--job-key',j.job.job_key]);assert.equal(r.code,3);assert.equal(JSON.parse(r.out).error.code,'migration_requires_backup');assert.equal(logical(h.db),before);
   const c=await child(['scripts/local-batch.mjs','install','--data-dir',h.dir,'--out-dir',join(h.dir,'cli-install')]);assert.equal(c.code,0,c.err+c.out);assert.equal(S.assertBatchSchema(h.db).version,2);
   const missing=join(h.dir,'missing');const no=await child(['scripts/local-batch.mjs','status','--data-dir',missing,'--job-key','x']);assert.equal(no.code,3);assert.equal(fs.existsSync(missing),false);
  }finally{h.close();}
 });
 await suite('real second connection write reservation blocks competing installer without mutation',async()=>{
  const h=await fresh({batch:1});try{h.db.exec('BEGIN IMMEDIATE');const before=logical(h.db);const result=await child(['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';import {installBatchSchema} from './server/local-batch-storage.mjs';const db=new DatabaseSync(${JSON.stringify(h.file)});db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=0');try{await installBatchSchema(db,{dbPath:${JSON.stringify(h.file)},outDir:${JSON.stringify(join(h.dir,'compete'))}});process.exitCode=7;}catch(e){console.log(e.code);if(e.code!=='batch_admission_busy')process.exitCode=8;}finally{db.close();console.log('DB actualclose');}`]);assert.equal(result.code,0,result.err+result.out);assert.equal(h.db.isTransaction,true);assert.equal(logical(h.db),before);h.db.exec('ROLLBACK');assert.equal(fs.existsSync(join(h.dir,'compete')),false);}finally{h.close();}
 });
 await suite('official verify fault, stale backup and file links reject under source reservation',async()=>{
  const h=await fresh({batch:1}),other=new DatabaseSync(h.file),read=fs.readFileSync;let corrupted=false;
  try{const before=logical(h.db);fs.readFileSync=function(file,...args){if(!corrupted&&String(file).endsWith(LB.MANIFEST_FILE)&&String(file).includes('verify-fault')){corrupted=true;assert.throws(()=>other.exec('BEGIN IMMEDIATE'),e=>e.errcode===5);const m=JSON.parse(read.call(fs,file,'utf8'));m.product='synthetic-invalid';fs.writeFileSync(file,JSON.stringify(m));}return read.call(fs,file,...args);};await assert.rejects(S.installBatchSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'verify-fault')}),e=>e.code==='batch_backup_invalid');fs.readFileSync=read;assert.equal(corrupted,true);assert.equal(logical(h.db),before);assert.equal(h.db.isTransaction,false);
   const b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'stale')});assert.equal(b.ok,true);h.db.exec("UPDATE schema_backups SET integrity='synthetic-new-content'");assert.throws(()=>LB.assertBackupSourceConnection(h.db,b.manifest));
   const link=join(h.dir,'hardlink.db');fs.linkSync(h.file,link);try{await assert.rejects(S.installBatchSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'linked')}),e=>e.code==='batch_database_invalid');}finally{fs.unlinkSync(link);}
   const alias=join(h.dir,'alias');fs.symlinkSync(h.dir,alias,'junction');try{await assert.rejects(S.installBatchSchema(h.db,{dbPath:join(alias,'workbench.db'),outDir:join(h.dir,'alias-backup')}),e=>e.code==='batch_database_invalid');}finally{fs.rmdirSync(alias);}
  }finally{fs.readFileSync=read;if(other.isTransaction)other.exec('ROLLBACK');other.close();h.close();}
 });
 await suite('restore_pending gates storage and direct runner before output or source effects',async()=>{
  const h=await fresh({batch:2});try{const j=job(h,{file:true}),parent=S.readBatchInstance(h.db).instance_id,active=randomUUID();h.db.exec('UPDATE local_batch_database_instances SET is_active=0');h.db.prepare("INSERT INTO local_batch_database_instances VALUES(?,?,NULL,1,?,'restore-new','restore_pending',?,?)").run(active,parent,'2026-10-23T00:00:00.000Z','restore-pending-test','b'.repeat(64));h.db.prepare("INSERT INTO local_batch_job_bindings SELECT ?,job_id,'disabled',NULL,bound_at FROM local_batch_job_bindings WHERE database_instance_id=?").run(active,parent);h.db.prepare("INSERT INTO local_batch_input_bindings SELECT ?,input_key,'disabled',NULL,bound_at FROM local_batch_input_bindings WHERE database_instance_id=?").run(active,parent);fs.unlinkSync(join(h.dir,'input.json'));const before=logical(h.db);
   assert.throws(()=>S.requestCancel(h.db,j.job.job_key),e=>e.code==='batch_not_ready');assert.throws(()=>S.resetStagesForRetry(h.db,{jobKey:j.job.job_key}),e=>e.code==='batch_not_ready');
   const output=join(h.dir,'forbidden-output'),code="const R=await import('./server/local-batch-runner.mjs');try{await R.createAndRun({outputDir:"+JSON.stringify(output)+"});process.exitCode=7;}catch(e){console.log(e.code);if(e.code!=='batch_not_ready')process.exitCode=8;}finally{R.database.close();console.log('DB actualclose');}",r=await child(['--input-type=module','-e',code],{env:{WORKBENCH_DATA_DIR:h.dir}});assert.equal(r.code,0,r.err+r.out);assert.equal(fs.existsSync(output),false);assert.equal(logical(h.db),before);
  }finally{h.close();}
 });
 await suite('mutable report snapshot retry window preserves saved history and rejects succeeded hash drift',async()=>{
  const h=await fresh({batch:2});try{const j=job(h,{report:true}),stage=h.db.prepare("SELECT * FROM local_batch_stages WHERE stage_key LIKE 'report:%'").get();
   const persist=(amount,business)=>{const dto=JSON.stringify({amount});S.saveSnapshot(h.db,{jobId:j.job.id,itemId:stage.item_id,period:stage.period,kind:'balance-sheet',dtoHash:S.sha256(dto),businessHash:business,dtoJson:dto,csvText:null,csvHash:null});return S.sha256(S.canonicalJson({dtoHash:S.sha256(dto),businessHash:business,format:'csv',code:null}));};
   const oldHash=persist(19.37,'a'.repeat(64));h.db.prepare("UPDATE local_batch_stages SET attempt=1,status='failed',input_hash=? WHERE id=?").run(oldHash,stage.id);assert.equal(S.inspectBatchSchema(h.db).ok,true);
   h.db.prepare("UPDATE local_batch_stages SET status='pending' WHERE id=?").run(stage.id);const newHash=persist(23.81,'b'.repeat(64));assert.notEqual(oldHash,newHash);assert.equal(S.inspectBatchSchema(h.db).ok,true);assert.equal(LB.createBackup({dbPath:h.file,outDir:join(h.dir,'retry-window')}).ok,true);
   h.db.prepare("UPDATE local_batch_stages SET status='succeeded',evidence_json=? WHERE id=?").run(S.canonicalJson({snapshotHash:oldHash,businessHash:'a'.repeat(64)}),stage.id);assert.equal(S.inspectBatchSchema(h.db).ok,true);downgrade(h);const rows=originalRows(h.db);await S.installBatchSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'historical-upgrade')});assert.equal(originalRows(h.db),rows);
   h.db.prepare('UPDATE local_batch_stages SET input_hash=? WHERE id=?').run('c'.repeat(64),stage.id);assert.equal(S.inspectBatchSchema(h.db).ok,false);assert.equal(LB.createBackup({dbPath:h.file,outDir:join(h.dir,'rejected')}).ok,false);
  }finally{h.close();}
 });
 await suite('release preserves real same-inode committed WAL and SHM after controlled child closes',async()=>{
  const dir=join(ROOT,randomUUID()),receipt=S.claimFreshDataDir(dir),file=join(dir,'workbench.db');
  const code="import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync("+JSON.stringify(file)+");db.exec('PRAGMA journal_mode=WAL;CREATE TABLE external_saved(amount REAL);INSERT INTO external_saved VALUES(12.39)');console.log('COMMITTED');setInterval(()=>{},1000);";
  const closed=await child(['--input-type=module','-e',code],{onOutput(text,p){if(text.includes('COMMITTED'))p.kill();}});assert.equal(closed.closed,true);assert.match(closed.out,/COMMITTED/);
  const before=Object.fromEntries(['','-wal','-shm'].map(x=>{assert.equal(fs.existsSync(file+x),true);return [x,hash(file+x)];})),identity=fs.statSync(file,{bigint:true});
  assert.equal(S.releaseFreshClaim(receipt),true);assert.equal(S.releaseFreshClaim(receipt),false);assert.equal(fs.existsSync(join(dir,S.FRESH_CLAIM_MARKER)),false);
  const after=Object.fromEntries(['','-wal','-shm'].map(x=>[x,hash(file+x)]));assert.deepEqual(after,before);assert.equal(fs.statSync(file,{bigint:true}).ino,identity.ino);assert.equal(fs.statSync(file,{bigint:true}).dev,identity.dev);console.log('same-inode sidecars before/after '+JSON.stringify({before,after}));
 });
 await suite('claim fsync-after-write EIO keeps seed bytes and closes both creation fds',async()=>{
  const target=join(ROOT,randomUUID()),code=
   "import fs from 'node:fs';import {createHash} from 'node:crypto';import {syncBuiltinESMExports} from 'node:module';"+
   "const target="+JSON.stringify(target)+";const path=target+'/workbench.db';const realOpen=fs.openSync,realSync=fs.fsyncSync,realStat=fs.fstatSync;const fds={};let seed=null;"+
   "fs.openSync=(p,flags,...a)=>{const fd=realOpen(p,flags,...a);if(flags==='wx'){if(String(p).endsWith('workbench.db'))fds.db=fd;else if(String(p).endsWith('.local-batch-create'))fds.marker=fd;}return fd;};"+
   "fs.fsyncSync=(fd,...a)=>{realSync(fd,...a);if(fd===fds.db){const st=realStat(fd);seed={sha256:createHash('sha256').update(fs.readFileSync(path)).digest('hex'),bytes:st.size,ino:String(st.ino),dev:String(st.dev)};throw Object.assign(new Error('after actual fsync'),{code:'EIO'});}};syncBuiltinESMExports();"+
   "const S=await import('./server/local-batch-storage.mjs');let error=null;try{S.claimFreshDataDir(target);}catch(e){error=e.code;}const closed={};for(const [name,fd] of Object.entries(fds)){try{realStat(fd);closed[name]='open';}catch(e){closed[name]=e.code;}}const st=fs.statSync(path);const after={sha256:createHash('sha256').update(fs.readFileSync(path)).digest('hex'),bytes:st.size,ino:String(st.ino),dev:String(st.dev)};console.log(JSON.stringify({error,seed,after,closed,marker:fs.existsSync(target+'/.local-batch-create'),wal:fs.existsSync(path+'-wal'),shm:fs.existsSync(path+'-shm')}));";
  const r=await child(['--input-type=module','-e',code]);assert.equal(r.code,0,r.err+r.out);const proof=JSON.parse(r.out.trim().split(/\r?\n/).at(-1));assert.equal(proof.error,'EIO');assert.equal(proof.seed.bytes,4096);assert.deepEqual(proof.after,proof.seed);assert.deepEqual(proof.closed,{marker:'EBADF',db:'EBADF'});assert.equal(proof.marker,false);assert.equal(proof.wal,false);assert.equal(proof.shm,false);console.log('fsync EIO preserved '+JSON.stringify(proof));
 });
 if(CASE_FILTER)assert.equal(selectedSuites,1,'selected test name must match exactly one case');
 console.log((CASE_FILTER?'selected case':'13 local-batch-install suites')+' passed; retained '+ROOT);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
