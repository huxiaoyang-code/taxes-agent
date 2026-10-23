import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
export {assert,fs,join,resolve,DatabaseSync,pathToFileURL,spawn};
export const WORKBENCH=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const ROOT=join(WORKBENCH,'..','.agent-runs','audit2-test-'+randomUUID());
export function plain(p){for(let x=resolve(p);;x=dirname(x)){assert.equal(fs.lstatSync(x).isSymbolicLink(),false);assert.equal(fs.realpathSync.native(x).toLowerCase(),x.toLowerCase());if(dirname(x)===x)break;}}
fs.mkdirSync(ROOT,{recursive:true});plain(ROOT);
fs.mkdirSync(join(ROOT,'seed'));plain(join(ROOT,'seed'));
process.env.TEMP=ROOT;process.env.TMP=ROOT;process.env.WORKBENCH_DATA_DIR=join(ROOT,'seed');process.env.KEEP_FIXTURES='1';process.env.WORKBENCH_TEST_KEEP_FIXTURES='1';
export const LS=await import('../server/local-audit-storage.mjs'),LA=await import('../server/local-audit.mjs'),LB=await import('../server/local-backup.mjs'),OP=await import('../server/local-audit-operation.mjs');
let init;
export async function fresh({version=5,audit=2,bank=false,aux=false,journal='delete'}={}) {
 if(!init)init=(async()=>{const {db}=await import('../server/db.mjs');try{const A=await import('../server/accounting.mjs');
  for(const [suffix,amount] of [['one',9.79],['two',28.63]]){const id=A.createAccountSet({name:'Synthetic '+suffix,start_period:'2026-01',profileId:'small-2011-basic-v1',enterprise:{enterpriseKey:'AUDIT-SYNTH-'+suffix,enterpriseName:'Synthetic '+suffix}}).id;A.setOpeningBalances(id,[{code:'1002',debit:amount},{code:'3001',credit:amount}]);}
  return db.prepare('SELECT path FROM schema_backups ORDER BY id LIMIT 1').get().path;}finally{db.close();}})();
 const initial=await init,dir=join(ROOT,randomUUID());fs.mkdirSync(dir);plain(dir);const file=join(dir,'workbench.db');
 if(version===5)fs.copyFileSync(join(ROOT,'seed','workbench.db'),file);else {fs.copyFileSync(initial,file);const S=await import('../server/import-storage.mjs'),d=new DatabaseSync(file);try{S.ensureImportSchema(d,{dataDir:dir,targetVersion:version});}finally{d.close();}}
 const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');db.exec('PRAGMA journal_mode='+journal);
 const h={db,file,dir,closed:false,close(){if(!this.closed){db.close();this.closed=true;console.log('DB actualclose '+file);}}};
 try {
  if(bank){const B=await import('../server/bank-storage.mjs');await B.ensureBankSchema(db,{dbPath:file,dataDir:dir,backupService:LB});}
  if(aux){const A=await import('../server/auxiliary-storage.mjs');await A.ensureAuxiliarySchema(db,{dbPath:file,outDir:join(dir,'before-aux')});}
  if(audit===1)legacy(db);else if(audit===2)await LS.installAuditSchema(db,{dbPath:file,outDir:join(dir,'before-audit')});
  return h;
 }catch(e){h.close();throw e;}
}
export const input=(operationId='op-1',over={})=>({context:{operationId,actor:'domain',action:'voucher.post',attempt:1,...over},scope:{kind:'database',value:null},request:{amountCents:137}});
export function historyEvent(db,{operationId='historic-1',...over}={}) {
 const e=LA.normalizeAuditEvent({operationId,actor:'domain',action:'voucher.post',attempt:1,outcome:'succeeded',resultCode:'voucher_post_succeeded',...over},null,{eventId:randomUUID(),databaseInstanceId:LS.currentAuditInstanceId(db),occurredAt:'2026-10-22T00:00:00.000Z'});
 db.prepare(`INSERT INTO audit_events(event_id,dedupe_key,database_instance_id,occurred_at,action,outcome,result_code,reason_code,actor,operation_id,parent_operation_id,attempt,account_set_id,voucher_id,period,job_id,item_id,stage_id,correlation,content_digest) VALUES(${Array(20).fill('?')})`).run(e.eventId,LA.auditEventDedupeKey(e),e.databaseInstanceId,e.occurredAt,e.action,e.outcome,e.resultCode,e.reasonCode,e.actor,e.operationId,e.parentOperationId,e.attempt,...LA.AUDIT_TARGET_FIELDS.map(k=>e[k]??null),LA.auditEventDigest(e));
 return db.prepare('SELECT * FROM audit_events WHERE event_id=?').get(e.eventId);
}
export const logical=db=>JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all().concat(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>({name,rows:db.prepare('SELECT * FROM "'+name+'"').all()}))));
export const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function child(args,{env={},cwd=WORKBENCH,onOutput}={}) {
 return await new Promise((resolve,reject)=>{const c=spawn(process.execPath,args,{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>{out+=b;if(onOutput)onOutput(String(b),c);});c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('close',(code,signal)=>{console.log('child actualclose '+code+'/'+signal);resolve({code,signal,out,err,closed:true});});});
}
export async function suite(name,fn){try{await fn();console.log('PASS '+name);}catch(e){console.error('FAIL '+name,e);process.exitCode=1;throw e;}}const AUDIT_TRIGGER_SQL = Object.freeze({
  audit_events_no_update: `CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
     BEGIN SELECT RAISE(ABORT, 'audit_events_append_only'); END`,
  audit_events_no_delete: `CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
     BEGIN SELECT RAISE(ABORT, 'audit_events_append_only'); END`,
  // SQLite 默认 recursive_triggers=0：INSERT OR REPLACE 触发的隐式删除**不会**触发 DELETE 触发器，
  // 于是「读原行 → 改 event_id → 按原 seq/dedupe_key 插回」可以悄悄替换历史。
  // 这里在 BEFORE INSERT 阶段（早于冲突行的隐式删除）拒绝任何与既有行冲突的插入，
  // 覆盖默认连接下的 INSERT OR REPLACE / REPLACE INTO / UPSERT；合法幂等仍由
  // appendAuditEvent 在写入前返回已有事件，正常 AUTOINCREMENT 插入（NEW.seq = NULL）不受影响。
  audit_events_no_replace: `CREATE TRIGGER audit_events_no_replace BEFORE INSERT ON audit_events
     WHEN EXISTS (SELECT 1 FROM audit_events
                  WHERE seq = NEW.seq OR event_id = NEW.event_id OR dedupe_key = NEW.dedupe_key)
     BEGIN SELECT RAISE(ABORT, 'audit_events_append_only'); END`,
});
const AUDIT_TRIGGERS = Object.freeze(Object.keys(AUDIT_TRIGGER_SQL));

/** 结构检查的必需列；缺列时先给固定结构化拒绝，再去查询（避免原始 SQLite 报错）。 */
const AUDIT_REQUIRED_COLUMNS = Object.freeze({
  audit_components: Object.freeze(["component", "version", "installed_at", "note"]),
  audit_database_instances: Object.freeze([
    "instance_id", "created_at", "parent_instance_id", "is_active", "note_code",
  ]),
  audit_events: Object.freeze([
    "seq", "event_id", "dedupe_key", "database_instance_id", "occurred_at", "action", "outcome",
    "result_code", "reason_code", "actor", "operation_id", "parent_operation_id", "attempt",
    "account_set_id", "voucher_id", "period", "job_id", "item_id", "stage_id", "correlation",
    "content_digest",
  ]),
});

const OUTCOME_CHECK = `('succeeded','rejected','failed','no_change','replayed','interrupted','unknown')`;

const V1_STATEMENTS = Object.freeze([
  `CREATE TABLE audit_components (
     component TEXT PRIMARY KEY,
     version INTEGER NOT NULL,
     installed_at TEXT NOT NULL,
     note TEXT
   )`,
  `CREATE TABLE audit_database_instances (
     instance_id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     parent_instance_id TEXT,
     is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
     note_code TEXT NOT NULL DEFAULT 'initial' CHECK (note_code IN ('initial','restore-new'))
   )`,
  `CREATE UNIQUE INDEX idx_audit_instances_active
     ON audit_database_instances (is_active) WHERE is_active = 1`,
  `CREATE TABLE audit_events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id TEXT NOT NULL UNIQUE,
     dedupe_key TEXT NOT NULL UNIQUE,
     database_instance_id TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     action TEXT NOT NULL,
     outcome TEXT NOT NULL CHECK (outcome IN ${OUTCOME_CHECK}),
     result_code TEXT NOT NULL,
     reason_code TEXT NOT NULL DEFAULT 'none',
     actor TEXT NOT NULL,
     operation_id TEXT NOT NULL,
     parent_operation_id TEXT,
     attempt INTEGER NOT NULL CHECK (attempt >= 1),
     account_set_id INTEGER,
     voucher_id INTEGER,
     period TEXT CHECK (period IS NULL OR period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
     job_id TEXT,
     item_id TEXT,
     stage_id TEXT,
     correlation TEXT,
     content_digest TEXT NOT NULL
   )`,
  `CREATE INDEX idx_audit_events_scope ON audit_events (account_set_id, seq)`,
  `CREATE INDEX idx_audit_events_operation ON audit_events (operation_id, attempt, seq)`,
  `CREATE INDEX idx_audit_events_action ON audit_events (action, seq)`,
  `CREATE INDEX idx_audit_events_period ON audit_events (period, seq)`,
  // append-only：审计行不允许被改写 / 删除（业务对象删除不影响这些行，因为事件本身没有外键）。
  // 三个触发器覆盖 UPDATE / DELETE / INSERT OR REPLACE（默认 recursive_triggers=0 也成立）。
  ...Object.values(AUDIT_TRIGGER_SQL),
]);

// Frozen audit1 historical fixture only; production has no legacy/fresh write switch.
export function legacy(db){for(const sql of V1_STATEMENTS)db.exec(sql);db.prepare('INSERT INTO audit_components VALUES(?,?,?,?)').run('business-audit',1,'2026-10-22T00:00:00.000Z','LOCAL-06');db.prepare('INSERT INTO audit_database_instances VALUES(?,?,?,?,?)').run(randomUUID(),'2026-10-22T00:00:00.000Z',null,1,'initial');}
if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)) {
 await suite('supported core/optional component/audit versions + protected upgrade preserve historical bytes',async()=>{
  let count=0;
  for(const version of [3,4,5])for(const bank of [false,true])for(const aux of version===5?[false,true]:[false])for(const audit of [0,1,2]) {
   const h=await fresh({version,bank,aux,audit});try {
    const before=LS.inspectAuditSchema(h.db);let oldEvent;
    if(audit===1)oldEvent=historyEvent(h.db);
    const history=audit===1?h.db.prepare('SELECT * FROM audit_events').all():[];
    const instance=before.activeInstanceId;
    const b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'matrix-backup')});assert.equal(b.ok,true,JSON.stringify(b));assert.equal(LB.verifyBackup({backupDir:b.backupDir}).ok,true);
    const r=await LS.installAuditSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'upgrade')});assert.equal(LS.assertAuditSchema(h.db).version,2);assert.equal(r.to,2);
    if(instance)assert.equal(r.activeInstanceId,instance);
    if(oldEvent){const after=h.db.prepare('SELECT * FROM audit_events').all();for(let i=0;i<history.length;i++){const {event_format_version,...rest}=after[i];assert.equal(event_format_version,1);assert.equal(LA.canonicalAuditJson(rest),LA.canonicalAuditJson(history[i]));}}
    assert.equal(h.db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,version);count++;
   }finally{h.close();}
  }console.log('matrix actual combinations '+count);
 });
 await suite('audit2 first: bank / aux / bank-aux / aux-bank official held-source gates',async()=>{
  const B=await import('../server/bank-storage.mjs'),A=await import('../server/auxiliary-storage.mjs');
  for(const order of [['bank'],['aux'],['bank','aux'],['aux','bank']]) {
   const h=await fresh();try {for(const part of order){const r=part==='bank'?await B.ensureBankSchema(h.db,{dbPath:h.file,dataDir:h.dir,backupService:LB}):await A.ensureAuxiliarySchema(h.db,{dbPath:h.file,outDir:join(h.dir,'aux-install')});assert.ok(r);}
    const b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'combined')});assert.equal(b.ok,true,JSON.stringify(b));const target=join(h.dir,'restored');assert.equal(LB.restoreNew({backupDir:b.backupDir,targetDir:target}).ok,true);assert.equal(LB.createBackup({dbPath:join(target,LB.TARGET_DATABASE_FILE),outDir:join(h.dir,'again')}).ok,true);
   }finally{h.close();}
  }
 });
 await suite('actual official verify failure keeps source unchanged and holds write reservation',async()=>{
  const h=await fresh({audit:0}),other=new DatabaseSync(h.file),read=fs.readFileSync;let corrupted=false,heldBusy=0;
  try {const before=logical(h.db);fs.readFileSync=function(file,...args){if(!corrupted&&String(file).endsWith(LB.MANIFEST_FILE)&&String(file).includes('verify-fault')){corrupted=true;try{other.exec('BEGIN IMMEDIATE');assert.fail('source reservation missing');}catch(e){assert.equal(e.errcode,5);heldBusy++;}const manifest=JSON.parse(read.call(fs,file,'utf8'));manifest.product='synthetic-corrupt-product';fs.writeFileSync(file,JSON.stringify(manifest));}return read.call(fs,file,...args);};
   await assert.rejects(LS.installAuditSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'verify-fault')}),/audit_backup_invalid/);assert.equal(corrupted,true);assert.equal(heldBusy,1);assert.equal(h.db.isTransaction,false);assert.equal(logical(h.db),before);
  }finally{fs.readFileSync=read;if(other.isTransaction)other.exec('ROLLBACK');other.close();h.close();}
 });
 await suite('caller transactions, wrong path/handle/links, stale snapshot and DDL faults preserve source',async()=>{
  const h=await fresh({audit:0}),other=await fresh({audit:0});try {
   let before=logical(h.db);h.db.exec('BEGIN');await assert.rejects(LS.installAuditSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'outer')}),/audit_transaction_conflict/);assert.equal(h.db.isTransaction,true);h.db.exec('ROLLBACK');assert.equal(logical(h.db),before);
   await assert.rejects(LS.installAuditSchema(h.db,{dbPath:other.file,outDir:join(h.dir,'wrong')}),/audit_backup_source_mismatch/);assert.equal(logical(h.db),before);
   const privateMarker='SYNTH-PRIVATE-MISSING-137';let missingError;try{await LS.installAuditSchema(h.db,{dbPath:join(h.dir,privateMarker+'.db'),outDir:join(h.dir,'missing')});assert.fail('missing rejected');}catch(e){missingError=e;}
   assert.match(missingError.code,/^audit_/);assert.equal(String(missingError).includes(privateMarker),false);assert.equal(JSON.stringify(missingError).includes(privateMarker),false);assert.equal(logical(h.db),before);
   const link=join(h.dir,'hardlink.db');fs.linkSync(h.file,link);try{await assert.rejects(LS.installAuditSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'link')}),/audit_database_invalid/);}finally{fs.unlinkSync(link);}
   const junction=join(h.dir,'alias');fs.symlinkSync(h.dir,junction,'junction');try{await assert.rejects(LS.installAuditSchema(h.db,{dbPath:join(junction,'workbench.db'),outDir:join(h.dir,'junction-out')}),/audit_database_invalid/);}finally{fs.rmdirSync(junction);}
   const exec=h.db.exec.bind(h.db);h.db.exec=sql=>{if(sql.startsWith('ALTER TABLE audit_events'))throw Error('synthetic DDL fault');return exec(sql);};await assert.rejects(LS.installAuditSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'ddl')}),/audit_schema_install_failed/);h.db.exec=exec;assert.equal(logical(h.db),before);assert.equal(h.db.isTransaction,false);
   const lock=new DatabaseSync(h.file);try{lock.exec('BEGIN IMMEDIATE');await assert.rejects(LS.installAuditSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'busy')}),/audit_admission_busy/);assert.equal(logical(h.db),before);}finally{lock.exec('ROLLBACK');lock.close();}
   // A stale same-basename manifest cannot bind the actual held source.
   const b=LB.createBackup({dbPath:h.file,outDir:join(h.dir,'stale')});assert.equal(b.ok,true);h.db.exec("UPDATE schema_backups SET integrity='changed-synthetic'");assert.throws(()=>LB.assertBackupSourceConnection(h.db,b.manifest));
   // Physical object replacement is rejected on the next identity check.
   const alternate=join(h.dir,'replacement.db');fs.copyFileSync(other.file,alternate);let replaced=false;try{fs.renameSync(h.file,join(h.dir,'old.db'));replaced=true;}catch(e){assert.equal(process.platform,'win32');assert.equal(e.code,'EBUSY');console.log('Windows actual EBUSY prevents replacement of an open SQLite source');}
   if(replaced){fs.renameSync(alternate,h.file);await assert.rejects(LS.installAuditSchema(h.db,{dbPath:h.file,outDir:join(h.dir,'replace')}));}
   else {assert.equal(LS.inspectAuditSchema(h.db).state,'not_installed');assert.equal(h.db.isTransaction,false);}
  }finally{h.close();other.close();}
 });
}
