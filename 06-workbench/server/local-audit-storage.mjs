// Explicit-handle audit1/2 storage. No default database or import-time connection.
import { DatabaseSync, constants as SQL } from 'node:sqlite';
import fs from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AUDIT_ACTIONS,AUDIT_ACTORS,AUDIT_COMPONENT,AUDIT_OUTCOMES,AUDIT_RESULT_CODES,AUDIT_SCHEMA_VERSION,
 auditError as fail, auditEventDigest,auditEventDedupeKey,auditV2EventDigest,auditV2DedupeKey,
 normalizeAuditEvent,createOperationContext,serverEventFields,classifyFailure,isTechId,isAuditPeriod,isTechnicalRowId,
 canonicalAuditJson,auditCanonicalDigest,auditTargets,AUDIT_TARGET_FIELDS } from './local-audit.mjs';
const V1_TABLES=Object.freeze(['audit_components','audit_database_instances','audit_events']);
export const AUDIT_TABLES=Object.freeze([...V1_TABLES,'audit_operations']);
export const AUDIT_INSTANCE_NOTES = Object.freeze(["initial", "restore-new"]);

/**
 * append-only 触发器的规范定义。结构检查逐字比对（忽略空白 / 大小写），
 * 因此「同名但无效」的触发器不会被当成已保护。
 */
export const AUDIT_TRIGGER_SQL = Object.freeze({
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
export const AUDIT_TRIGGERS = Object.freeze(Object.keys(AUDIT_TRIGGER_SQL));

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

const OPERATION_SQL = `CREATE TABLE audit_operations (
 database_instance_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 1000000),
 binding_version INTEGER NOT NULL CHECK(binding_version=1), action TEXT NOT NULL, actor TEXT NOT NULL,
 scope_kind TEXT NOT NULL CHECK(scope_kind IN ('database','enterprise','account_set')),
 scope_token TEXT NOT NULL CHECK(length(scope_token)=64 AND scope_token NOT GLOB '*[^a-f0-9]*'),
 targets_json TEXT NOT NULL, parent_operation_id TEXT, parent_attempt INTEGER CHECK(parent_attempt BETWEEN 1 AND 1000000),
 request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
 binding_digest TEXT NOT NULL CHECK(length(binding_digest)=64 AND binding_digest NOT GLOB '*[^a-f0-9]*'),
 state TEXT NOT NULL CHECK(state IN ('pending','succeeded','no_change','failed','rejected')),
 terminal_event_id TEXT UNIQUE, receipt_json TEXT, prepared_at TEXT NOT NULL, finished_at TEXT,
 PRIMARY KEY(database_instance_id,operation_id,attempt),
 FOREIGN KEY(database_instance_id) REFERENCES audit_database_instances(instance_id) ON DELETE RESTRICT,
 FOREIGN KEY(terminal_event_id) REFERENCES audit_events(event_id) ON DELETE RESTRICT,
 CHECK((parent_operation_id IS NULL)=(parent_attempt IS NULL)),
 CHECK(parent_operation_id IS NULL OR parent_operation_id<>operation_id),
 CHECK((state='pending' AND terminal_event_id IS NULL AND receipt_json IS NULL AND finished_at IS NULL)
 OR (state<>'pending' AND terminal_event_id IS NOT NULL AND receipt_json IS NOT NULL AND finished_at IS NOT NULL))
)`;
const IMMUTABLE_OPERATION_COLUMNS = ['database_instance_id','operation_id','attempt','binding_version','action','actor','scope_kind','scope_token','targets_json','parent_operation_id','parent_attempt','request_digest','binding_digest','prepared_at'];
export const AUDIT_OPERATION_TRIGGER_SQL=Object.freeze({
 audit_operations_no_delete:`CREATE TRIGGER audit_operations_no_delete BEFORE DELETE ON audit_operations BEGIN SELECT RAISE(ABORT,'audit_operation_immutable'); END`,
 audit_operations_no_replace:`CREATE TRIGGER audit_operations_no_replace BEFORE INSERT ON audit_operations WHEN NEW.state<>'pending' OR EXISTS(SELECT 1 FROM audit_operations WHERE (database_instance_id=NEW.database_instance_id AND operation_id=NEW.operation_id AND attempt=NEW.attempt) OR (NEW.terminal_event_id IS NOT NULL AND terminal_event_id=NEW.terminal_event_id)) BEGIN SELECT RAISE(ABORT,'audit_operation_immutable'); END`,
 audit_operations_guard_update:`CREATE TRIGGER audit_operations_guard_update BEFORE UPDATE ON audit_operations WHEN OLD.state<>'pending' OR NEW.state NOT IN ('succeeded','no_change','failed','rejected') OR ${IMMUTABLE_OPERATION_COLUMNS.map(k=>`NEW.${k} IS NOT OLD.${k}`).join(' OR ')} BEGIN SELECT RAISE(ABORT,'audit_operation_immutable'); END`,
});
const V2_STEPS=Object.freeze([
 `ALTER TABLE audit_events ADD COLUMN event_format_version INTEGER NOT NULL DEFAULT 1 CHECK(event_format_version IN (1,2))`,
 OPERATION_SQL,...Object.values(AUDIT_OPERATION_TRIGGER_SQL),
]);
const tablesFor=v=>v===1?V1_TABLES:AUDIT_TABLES;
const normalizeSql=s=>String(s??'').replace(/\s+/g,' ').trim().replace(/;$/,'');
const quote=s=>'"'+s.replaceAll('"','""')+'"';
/** Complete actual facts, including implicit index collations, order, origin, FK and rowid. */
export function auditSchemaFacts(db,version) {
 const tables=tablesFor(version);
 const objects=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all().filter(r=>
   tables.includes(r.tbl_name)||r.name.startsWith('audit_')||r.name.startsWith('idx_audit_')||/\baudit_[a-z_]+\b/i.test(r.sql??''))
   .map(r=>({...r,sql:r.sql===null?null:normalizeSql(r.sql)}));
 const facts=tables.map(t=>({table:t,
  columns:db.prepare('SELECT * FROM pragma_table_xinfo(?) ORDER BY cid').all(t),
  attributes:db.prepare('SELECT type,ncol,wr,strict FROM pragma_table_list WHERE schema=\'main\' AND name=?').get(t)??null,
  indexes:db.prepare('SELECT * FROM pragma_index_list(?) ORDER BY name').all(t).map(i=>({...i,keys:db.prepare('SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno').all(i.name)})),
  foreignKeys:db.prepare('SELECT * FROM pragma_foreign_key_list(?) ORDER BY id,seq').all(t),
 }));
 return {version,objects,tables:facts};
}
const contracts=new Map();
export function auditComponentContract(version) {
 if(version!==1&&version!==2)throw fail('audit_schema_newer');
 if(!contracts.has(version)) {
  const ref=new DatabaseSync(':memory:');
  try {for(const sql of V1_STATEMENTS)ref.exec(sql);if(version===2)for(const sql of V2_STEPS)ref.exec(sql);
   contracts.set(version,canonicalAuditJson(auditSchemaFacts(ref,version)));
  }finally{ref.close();}
 }
 return {name:AUDIT_COMPONENT,version,tables:[...tablesFor(version)],facts:JSON.parse(contracts.get(version))};
}
const iso=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&!Number.isNaN(Date.parse(v))&&new Date(v).toISOString()===v;
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function eventFromRow(r) {
 return {databaseInstanceId:r.database_instance_id,occurredAt:r.occurred_at,action:r.action,outcome:r.outcome,resultCode:r.result_code,reasonCode:r.reason_code,actor:r.actor,operationId:r.operation_id,parentOperationId:r.parent_operation_id,attempt:r.attempt,
  accountSetId:r.account_set_id,voucherId:r.voucher_id,period:r.period,jobId:r.job_id,itemId:r.item_id,stageId:r.stage_id,correlation:r.correlation};
}
function validEvent(r) {
 try {
  const e=eventFromRow(r), raw=Object.fromEntries(Object.entries(e).filter(([k])=>!['databaseInstanceId','occurredAt'].includes(k)));
  normalizeAuditEvent(raw,null,{eventId:r.event_id,databaseInstanceId:r.database_instance_id,occurredAt:r.occurred_at});
  if(!isTechId(r.event_id)||!isTechId(r.database_instance_id)||!iso(r.occurred_at)||!Number.isSafeInteger(r.seq)||r.seq<1)return false;
  const v=r.event_format_version??1;
  return (v===1||v===2)&&r.content_digest===(v===1?auditEventDigest(e):auditV2EventDigest(e))&&r.dedupe_key===(v===1?auditEventDedupeKey(e):auditV2DedupeKey(e));
 }catch{return false;}
}
function parseCanonical(text) {const obj=JSON.parse(text);if(canonicalAuditJson(obj)!==text)throw fail('audit_schema_inconsistent');return obj;}
function targetsOfRow(r){return parseCanonical(r.targets_json);}
const bindingOf=r=>auditCanonicalDigest([1,r.action,r.scope_kind,r.scope_token,targetsOfRow(r),r.parent_operation_id,r.parent_attempt,r.request_digest]);
const opKey=r=>canonicalAuditJson([r.database_instance_id,r.operation_id,r.attempt]);
const successCodes=new Set(['ok','import_create_succeeded','import_append_succeeded','import_legacy_succeeded','voucher_post_succeeded','voucher_unpost_succeeded','period_close_succeeded','period_reopen_succeeded','batch_stage_succeeded','batch_job_succeeded','restore_new_succeeded']);
const terminalCodesValid=(state,code)=>state==='succeeded'?successCodes.has(code):state==='no_change'?code==='no_change':['failed','rejected'].includes(state)&&!successCodes.has(code)&&!['no_change','replayed','unknown','interrupted'].includes(code);
const receiptFor=(r,e,targets)=>({receiptVersion:1,databaseInstanceId:r.database_instance_id,operationId:r.operation_id,attempt:r.attempt,state:r.state,resultCode:e.result_code,reasonCode:e.reason_code,eventId:e.event_id,eventSeq:e.seq,targets});
function contentValid(db,version) {
 const components=db.prepare('SELECT * FROM audit_components').all();
 if(components.length!==1||components[0].component!==AUDIT_COMPONENT||components[0].version!==version||!iso(components[0].installed_at)||!(components[0].note===null||typeof components[0].note==='string'))return false;
 const instances=db.prepare('SELECT * FROM audit_database_instances').all(), ids=new Set(instances.map(r=>r.instance_id));
 if(instances.filter(r=>r.is_active===1).length!==1||instances.some(r=>!isTechId(r.instance_id)||!iso(r.created_at)||![0,1].includes(r.is_active)||!AUDIT_INSTANCE_NOTES.includes(r.note_code)||(r.parent_instance_id!==null&&(!ids.has(r.parent_instance_id)||r.parent_instance_id===r.instance_id))))return false;
 for(const instance of instances) {
  if((instance.note_code==='initial')!==(instance.parent_instance_id===null))return false;
  const seen=new Set();let cursor=instance;
  while(cursor){if(seen.has(cursor.instance_id))return false;seen.add(cursor.instance_id);cursor=cursor.parent_instance_id===null?null:instances.find(r=>r.instance_id===cursor.parent_instance_id);}
 }
 const events=db.prepare('SELECT * FROM audit_events ORDER BY seq').all();
 if(events.some(r=>!ids.has(r.database_instance_id)||!validEvent(r)))return false;
 if(version===1)return true;
 const ops=db.prepare('SELECT * FROM audit_operations ORDER BY database_instance_id,operation_id,attempt').all(), terminals=new Map();
 for(const r of ops) {
  if(!ids.has(r.database_instance_id)||!isTechId(r.operation_id)||r.binding_version!==1||!AUDIT_ACTIONS.includes(r.action)||!AUDIT_ACTORS.includes(r.actor)||!Number.isSafeInteger(r.attempt)||r.attempt<1||r.attempt>1000000||!['database','enterprise','account_set'].includes(r.scope_kind)||!digest(r.scope_token)||!digest(r.request_digest)||!digest(r.binding_digest)||!iso(r.prepared_at))return false;
  const targets=targetsOfRow(r);
  if(canonicalAuditJson(targets)!==canonicalAuditJson(auditTargets(targets))||r.binding_digest!==bindingOf(r))return false;
  if((r.parent_operation_id===null)!==(r.parent_attempt===null)||r.parent_operation_id!==null&&(!isTechId(r.parent_operation_id)||r.parent_operation_id===r.operation_id||!Number.isSafeInteger(r.parent_attempt)||r.parent_attempt<1||r.parent_attempt>1000000))return false;
  const prior=ops.find(p=>p.database_instance_id===r.database_instance_id&&p.operation_id===r.operation_id&&p.attempt===r.attempt-1);
  if(r.attempt>1&&(!prior||!['failed','rejected'].includes(prior.state)||prior.binding_digest!==r.binding_digest))return false;
  if(r.state==='pending') {if(r.terminal_event_id!==null||r.receipt_json!==null||r.finished_at!==null)return false;continue;}
  if(!['succeeded','no_change','failed','rejected'].includes(r.state)||!iso(r.finished_at))return false;
  const e=events.find(e=>e.event_id===r.terminal_event_id);
  if(!e||!terminalCodesValid(r.state,e.result_code)||e.event_format_version!==2||e.database_instance_id!==r.database_instance_id||e.operation_id!==r.operation_id||e.attempt!==r.attempt||e.action!==r.action||e.actor!==r.actor||e.parent_operation_id!==r.parent_operation_id||e.outcome!==r.state||e.occurred_at!==r.finished_at)return false;
  const finalTargets=auditTargets(eventFromRow(e));
  if(AUDIT_TARGET_FIELDS.some(k=>targets[k]!==null&&targets[k]!==finalTargets[k]))return false;
  if(canonicalAuditJson(receiptFor(r,e,finalTargets))!==r.receipt_json)return false;
  parseCanonical(r.receipt_json);if(terminals.has(e.event_id))return false;terminals.set(e.event_id,opKey(r));
 }
 return events.every(e=>e.event_format_version!==2||terminals.has(e.event_id));
}
export function inspectAuditSchema(db) {
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
 const present=AUDIT_TABLES.filter(t=>tables.includes(t));
 let version=0, activeInstanceId=null,activeInstanceCount=0,problems=[];
 const any=db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'audit_%' OR name LIKE 'idx_audit_%'").all().length>0;
 if(!any)return {tables,present:[],installed:false,version:0,target:2,activeInstanceId:null,activeInstanceCount:0,missingTables:[],missingColumns:{},missingTriggers:[],invalidTriggers:[],problems:[],state:'not_installed',ok:false};
 try {
  version=db.prepare('SELECT version FROM audit_components WHERE component=?').get(AUDIT_COMPONENT)?.version??0;
  if(version!==1&&version!==2)problems.push(version>2?'version_newer':'version_unknown');
  else {
   if(canonicalAuditJson(auditSchemaFacts(db,version))!==canonicalAuditJson(auditComponentContract(version).facts))problems.push('structure_mismatch');
   if(!problems.length&&!contentValid(db,version))problems.push('content_invalid');
  }
  const active=db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').all();activeInstanceCount=active.length;if(active.length===1)activeInstanceId=active[0].instance_id;
 }catch{problems.push('structure_or_content_invalid');}
 const missingTables=tablesFor(version===1?1:2).filter(t=>!tables.includes(t));
 return {tables,present,installed:missingTables.length===0,version,target:2,activeInstanceId,activeInstanceCount,missingTables,missingColumns:{},missingTriggers:[],invalidTriggers:[],problems,state:version>2?'unsupported':problems.length?'invalid':'ok',ok:problems.length===0};
}
function assertInstalledSchema(db){const s=inspectAuditSchema(db);if(!s.ok)throw fail(s.version>2?'audit_schema_newer':'audit_schema_inconsistent');return s;}
export const assertAuditSchema=assertInstalledSchema;
export function currentAuditInstanceId(db){return assertInstalledSchema(db).activeInstanceId;}
export function ensureAuditSchema(db) {
 const s=inspectAuditSchema(db);if(s.state==='not_installed')throw fail('audit_install_requires_verified_backup');
 assertInstalledSchema(db);return {installed:false,from:s.version,to:s.version,activeInstanceId:s.activeInstanceId};
}
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function plainFile(file) {
 try {
 if(typeof file!=='string'||!file)throw fail('audit_database_invalid');const full=resolve(file);
 for(let p=full;;p=dirname(p)){const stat=fs.lstatSync(p);if(stat.isSymbolicLink()||!samePath(fs.realpathSync.native(p),resolve(p)))throw fail('audit_database_invalid');if(dirname(p)===p)break;}
 const stat=fs.statSync(full,{bigint:true});if(!stat.isFile()||stat.nlink!==1n)throw fail('audit_database_invalid');
 return {path:full,dev:stat.dev,ino:stat.ino};
 }catch{throw fail('audit_database_invalid');}
}
function identity(db,explicit) {
 const main=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main');if(!main?.file)throw fail('audit_database_invalid');
 const id=plainFile(main.file);if(explicit&&!samePath(id.path,plainFile(explicit).path))throw fail('audit_backup_source_mismatch');return id;
}
const sameIdentity=(a,b)=>samePath(a.path,b.path)&&a.dev===b.dev&&a.ino===b.ino;
const quarantine=new WeakSet();
function connection(db){if(!db||typeof db.exec!=='function'||quarantine.has(db))throw fail('audit_unavailable');if(db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)throw fail('audit_database_invalid');}
function owner(db){connection(db);if(db.isTransaction)throw fail('audit_transaction_conflict');}
const busy=e=>e?.errcode===5||e?.errcode===6||e?.code==='SQLITE_BUSY'||e?.code==='SQLITE_LOCKED';
function rollback(db){try{if(!db.isTransaction)return false;db.exec('ROLLBACK');return !db.isTransaction;}catch{return false;}}
export async function installAuditSchema(db,{dbPath,outDir}={}) {
 owner(db);if(!dbPath||!outDir)throw fail('audit_install_requires_verified_backup');const before=identity(db,dbPath);
 let s=inspectAuditSchema(db);if(s.state!=='not_installed')assertInstalledSchema(db);
 const LB=await import('./local-backup.mjs');LB.assertSupportedDatabaseConnection(db);
 if(s.version===2)return {installed:false,from:2,to:2,activeInstanceId:s.activeInstanceId};
 try{db.exec('BEGIN IMMEDIATE');}catch(e){if(db.isTransaction){quarantine.add(db);throw fail('audit_commit_unknown');}throw fail(busy(e)?'audit_admission_busy':'audit_unavailable');}
 try {
  if(!sameIdentity(before,identity(db,dbPath)))throw fail('audit_backup_source_mismatch');
  s=inspectAuditSchema(db);if(s.state!=='not_installed')assertInstalledSchema(db);
  const created=LB.createBackup({dbPath:before.path,outDir});if(!created.ok)throw fail('audit_backup_invalid');
  const verified=LB.verifyBackup({backupDir:created.backupDir});
  if(!verified.ok||verified.status!=='ok'||verified.summary.snapshotBytes!==created.backupMeta.snapshotBytes||verified.summary.snapshotSha256!==created.backupMeta.snapshotSha256||verified.manifest.source.file!==basename(before.path)||canonicalAuditJson(verified.manifest)!==canonicalAuditJson(created.manifest))throw fail('audit_backup_invalid');
  try{LB.assertBackupSourceConnection(db,verified.manifest);}catch{throw fail('audit_backup_source_mismatch');}
  if(!sameIdentity(before,identity(db,dbPath)))throw fail('audit_backup_source_mismatch');
  if(s.state==='not_installed') {
   for(const sql of V1_STATEMENTS)db.exec(sql);
   db.prepare('INSERT INTO audit_components VALUES(?,?,?,?)').run(AUDIT_COMPONENT,1,new Date().toISOString(),'LOCAL-06');
   db.prepare('INSERT INTO audit_database_instances VALUES(?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),null,1,'initial');
  }
  for(const sql of V2_STEPS)db.exec(sql);
  db.prepare('UPDATE audit_components SET version=2 WHERE component=?').run(AUDIT_COMPONENT);
  assertInstalledSchema(db);if(!sameIdentity(before,identity(db,dbPath)))throw fail('audit_backup_source_mismatch');
  db.exec('COMMIT');return {installed:true,from:s.version,to:2,activeInstanceId:currentAuditInstanceId(db),backupDir:created.backupDir};
 }catch(e){if(!rollback(db)){quarantine.add(db);throw fail('audit_commit_unknown');}throw fail(e?.code?.startsWith('audit_')?e.code:'audit_schema_install_failed');}
}
export function openAuditDatabase(file,{readOnly=true}={}) {
 if(typeof file!=='string'||!file)throw fail('audit_operation_invalid');if(readOnly&&!fs.existsSync(file))throw fail('audit_database_missing');
 let db;try{db=new DatabaseSync(file,{readOnly});db.prepare('SELECT name FROM sqlite_master LIMIT 1').all();return db;}catch{try{db?.close();}catch{}throw fail('audit_database_invalid');}
}
const EVENT_COLUMNS='*';
const permissions=new WeakMap();
const selectOperation=(db,r)=>db.prepare('SELECT * FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=?').get(r.database_instance_id,r.operation_id,r.attempt);
function envelope(code,{state='rejected',replayed=false,durability='not_started',retryable=false,needsReview=false,receipt=null}={}){return {ok:state==='succeeded'||state==='no_change',code,state,replayed,durability,retryable,needsReview,receipt};}
function unknown(code='audit_commit_unknown'){return envelope(code,{state:'unknown',durability:'unknown',needsReview:true});}
function terminalEnvelope(r,replayed){const receipt=parseCanonical(r.receipt_json);return envelope(r.state==='succeeded'?'ok':r.state==='no_change'?'no_change':receipt.resultCode,{state:r.state,replayed,durability:'committed',receipt});}
function requireV2(db){const s=assertInstalledSchema(db);if(s.version!==2)throw fail('audit_operation_protocol_required');return s;}
function normalizeBinding(db,input) {
 input=JSON.parse(canonicalAuditJson(input));
 if(!input||typeof input!=='object'||Object.keys(input).sort().join(',')!=='context,request,scope')throw fail('audit_operation_invalid');
 const context=createOperationContext(input.context),scope=input.scope;
 if(!scope||typeof scope!=='object'||Object.keys(scope).sort().join(',')!=='kind,value')throw fail('audit_operation_invalid');
 let value=scope.value;
 if(scope.kind==='database'){if(value!==null||context.accountSetId!==undefined)throw fail('audit_operation_invalid');}
 else if(scope.kind==='account_set') {
  if(!isTechnicalRowId(value)||context.accountSetId!==value||!db.prepare('SELECT 1 FROM account_sets WHERE id=?').get(value))throw fail('audit_operation_invalid');
 }else if(scope.kind==='enterprise') {
  if(typeof value!=='string'||!value||value.length>128||/[\u0000-\u001f\u007f]/.test(value))throw fail('audit_operation_invalid');
  value=value.normalize('NFKC').trim();if(!value)throw fail('audit_operation_invalid');
  const binding=db.prepare('SELECT account_set_id FROM import_enterprise_account_sets WHERE enterprise_key=?').get(value);
  if(context.accountSetId!==undefined&&binding?.account_set_id!==context.accountSetId)throw fail('audit_operation_invalid');
 }else throw fail('audit_operation_invalid');
 const r={database_instance_id:requireV2(db).activeInstanceId,operation_id:context.operationId,attempt:context.attempt,binding_version:1,action:context.action,actor:context.actor,scope_kind:scope.kind,scope_token:auditCanonicalDigest(['audit-scope-v1',scope.kind,value]),targets_json:canonicalAuditJson(auditTargets(context)),parent_operation_id:context.parentOperationId??null,parent_attempt:context.parentAttempt??null,request_digest:auditCanonicalDigest(['audit-request-v1',context.action,input.request])};
 r.binding_digest=bindingOf(r);return r;
}
/** A receipt is a private, one-use object issued only after durable pending COMMIT. */
export function prepareOperation(db,input) {
 owner(db);const file=identity(db),r=normalizeBinding(db,input);
 try{db.exec('BEGIN IMMEDIATE');}catch(e){if(db.isTransaction){quarantine.add(db);return unknown();}return envelope(busy(e)?'audit_admission_busy':'audit_unavailable',{retryable:busy(e)});}
 let saved;
 try {
  if(!sameIdentity(file,identity(db))||requireV2(db).activeInstanceId!==r.database_instance_id)throw fail('audit_authorization_invalid');
  if(normalizeBinding(db,input).binding_digest!==r.binding_digest)throw fail('audit_operation_conflict');
  saved=selectOperation(db,r);
  if(saved){db.exec('ROLLBACK');if(saved.binding_digest!==r.binding_digest)return envelope('audit_operation_conflict');return saved.state==='pending'?unknown('audit_operation_pending'):terminalEnvelope(saved,true);}
  const prior=db.prepare('SELECT * FROM audit_operations WHERE database_instance_id=? AND operation_id=? ORDER BY attempt DESC LIMIT 1').get(r.database_instance_id,r.operation_id);
  if((!prior&&r.attempt!==1)||(prior&&(prior.attempt+1!==r.attempt||!['failed','rejected'].includes(prior.state)||prior.binding_digest!==r.binding_digest))){db.exec('ROLLBACK');return envelope('audit_operation_conflict');}
  r.prepared_at=new Date().toISOString();
  const columns=[...IMMUTABLE_OPERATION_COLUMNS,'state'];
  db.prepare(`INSERT INTO audit_operations (${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...IMMUTABLE_OPERATION_COLUMNS.map(k=>r[k]),'pending');
  db.exec('COMMIT');
 }catch(e){if(!rollback(db)){quarantine.add(db);return unknown();}throw fail(e?.code?.startsWith('audit_')?e.code:'audit_unavailable');}
 const authorization=Object.freeze(Object.create(null));permissions.set(authorization,{db,file,r,used:false});
 return {...envelope('prepared',{state:'pending',durability:'committed'}),authorization};
}
function resultSpec(value,r) {
 try {value=JSON.parse(canonicalAuditJson(value));}catch{throw fail('audit_result_invalid');}
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.then==='function')throw fail('audit_result_invalid');
 const keys=Object.keys(value);if(keys.some(k=>!['state','resultCode','reasonCode','targets'].includes(k))||!['succeeded','no_change','failed','rejected'].includes(value.state))throw fail('audit_result_invalid');
 const resultCode=value.resultCode??(value.state==='succeeded'?'ok':value.state),reasonCode=value.reasonCode??'none';
 const inputTargets=targetsOfRow(r),extra=value.targets??{};
 if(!extra||typeof extra!=='object'||Array.isArray(extra)||Object.keys(extra).some(k=>!AUDIT_TARGET_FIELDS.includes(k)))throw fail('audit_result_invalid');
 const targets=auditTargets({...inputTargets,...extra});if(AUDIT_TARGET_FIELDS.some(k=>inputTargets[k]!==null&&inputTargets[k]!==targets[k]))throw fail('audit_result_invalid');
 normalizeAuditEvent({...targets,outcome:value.state,resultCode,reasonCode,action:r.action,actor:r.actor,operationId:r.operation_id,parentOperationId:r.parent_operation_id,attempt:r.attempt});
 if(!terminalCodesValid(value.state,resultCode))throw fail('audit_result_invalid');
 return {state:value.state,resultCode,reasonCode,targets};
}
function finish(db,r,spec) {
 const e=normalizeAuditEvent({...spec.targets,action:r.action,actor:r.actor,operationId:r.operation_id,parentOperationId:r.parent_operation_id,attempt:r.attempt,outcome:spec.state,resultCode:spec.resultCode,reasonCode:spec.reasonCode},null,serverEventFields(r.database_instance_id));
 const columns=['event_id','dedupe_key','database_instance_id','occurred_at','action','outcome','result_code','reason_code','actor','operation_id','parent_operation_id','attempt','account_set_id','voucher_id','period','job_id','item_id','stage_id','correlation','content_digest','event_format_version'];
 db.prepare(`INSERT INTO audit_events(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(e.eventId,auditV2DedupeKey(e),e.databaseInstanceId,e.occurredAt,e.action,e.outcome,e.resultCode,e.reasonCode,e.actor,e.operationId,e.parentOperationId,e.attempt,...AUDIT_TARGET_FIELDS.map(k=>e[k]??null),auditV2EventDigest(e),2);
 const event=db.prepare('SELECT * FROM audit_events WHERE event_id=?').get(e.eventId);
 const updated={...r,state:spec.state};const receipt=receiptFor(updated,event,spec.targets);
 const changed=db.prepare("UPDATE audit_operations SET state=?,terminal_event_id=?,receipt_json=?,finished_at=? WHERE database_instance_id=? AND operation_id=? AND attempt=? AND state='pending'").run(spec.state,e.eventId,canonicalAuditJson(receipt),e.occurredAt,r.database_instance_id,r.operation_id,r.attempt);
 if(changed.changes!==1)throw fail('audit_operation_conflict');return {...updated,receipt_json:canonicalAuditJson(receipt)};
}
const CALLBACK_DENIED=new Set([SQL.SQLITE_TRANSACTION,SQL.SQLITE_SAVEPOINT,SQL.SQLITE_PRAGMA,SQL.SQLITE_ATTACH,SQL.SQLITE_DETACH,SQL.SQLITE_ALTER_TABLE,SQL.SQLITE_CREATE_TABLE,SQL.SQLITE_CREATE_INDEX,SQL.SQLITE_CREATE_TRIGGER,SQL.SQLITE_CREATE_VIEW,SQL.SQLITE_DROP_TABLE,SQL.SQLITE_DROP_INDEX,SQL.SQLITE_DROP_TRIGGER,SQL.SQLITE_DROP_VIEW,SQL.SQLITE_CREATE_TEMP_TABLE,SQL.SQLITE_CREATE_TEMP_TRIGGER,SQL.SQLITE_CREATE_TEMP_VIEW,SQL.SQLITE_CREATE_VTABLE,SQL.SQLITE_DROP_VTABLE]);
export function executePreparedOperation(db,authorization,fn) {
 owner(db);const p=authorization&&typeof authorization==='object'?permissions.get(authorization):null;
 if(!p||p.db!==db||p.used||typeof fn!=='function')throw fail('audit_authorization_invalid');
 if(!sameIdentity(p.file,identity(db))||requireV2(db).activeInstanceId!==p.r.database_instance_id)throw fail('audit_authorization_invalid');
 try{db.exec('BEGIN IMMEDIATE');}catch(e){if(db.isTransaction){p.used=true;quarantine.add(db);return unknown();}return envelope(busy(e)?'audit_admission_busy':'audit_unavailable',{retryable:busy(e)});}
 let spec, saved, controlledFailure=null;
 try {
  if(!sameIdentity(p.file,identity(db)))throw fail('audit_authorization_invalid');
  saved=selectOperation(db,p.r);if(!saved||saved.state!=='pending'||saved.binding_digest!==p.r.binding_digest)throw fail('audit_authorization_invalid');
  p.used=true;
  db.setAuthorizer((action,a)=>CALLBACK_DENIED.has(action)||[SQL.SQLITE_INSERT,SQL.SQLITE_UPDATE,SQL.SQLITE_DELETE].includes(action)&&String(a).startsWith('audit_')?SQL.SQLITE_DENY:SQL.SQLITE_OK);
  let result;
  try{result=fn();}finally{db.setAuthorizer(null);}
  if(!db.isTransaction)throw fail('audit_commit_unknown');
  spec=resultSpec(result,saved);
  if(spec.state==='failed'||spec.state==='rejected'){controlledFailure=spec;throw fail('audit_result_invalid');}
  saved=finish(db,saved,spec);
 }catch(e){
  try{db.setAuthorizer(null);}catch{}
  if(!rollback(db)){quarantine.add(db);return unknown();}
  if(!p.used)throw fail(e?.code?.startsWith('audit_')?e.code:'audit_unavailable');
  const mapped=controlledFailure??(e?.code==='audit_result_invalid'?{state:'rejected',resultCode:'rejected_validation',reasonCode:'audit_result_invalid',targets:targetsOfRow(p.r)}:{...classifyFailure(e),targets:targetsOfRow(p.r)});
  spec={...mapped,state:mapped.state??mapped.outcome};if(!['failed','rejected'].includes(spec.state))spec={state:'failed',resultCode:'internal_error',reasonCode:'internal_error',targets:targetsOfRow(p.r)};
  return persistFailure(db,p.r,spec);
 }
 try{db.exec('COMMIT');return terminalEnvelope(saved,false);}catch(e){
  if(busy(e)&&db.isTransaction&&rollback(db))return persistFailure(db,p.r,{state:'failed',resultCode:'audit_unavailable',reasonCode:'audit_write_failed',targets:targetsOfRow(p.r)});
  try{rollback(db);}catch{}quarantine.add(db);return unknown();
 }
}
function persistFailure(db,r,spec) {
 try{db.exec('BEGIN IMMEDIATE');const current=selectOperation(db,r);if(!current||current.state!=='pending') {db.exec('ROLLBACK');return current?.receipt_json?terminalEnvelope(current,true):unknown();}
  const saved=finish(db,current,spec);db.exec('COMMIT');return terminalEnvelope(saved,false);
 }catch{if(!rollback(db)){quarantine.add(db);return unknown();}return unknown('audit_unavailable');}
}
export function queryOperation(db,{databaseInstanceId,operationId,attempt=1}={}) {
 requireV2(db);if(!isTechId(databaseInstanceId)||!isTechId(operationId)||!Number.isSafeInteger(attempt)||attempt<1||attempt>1000000)throw fail('audit_operation_invalid');
 const r=selectOperation(db,{database_instance_id:databaseInstanceId,operation_id:operationId,attempt});
 if(!r)return envelope('not_found');return r.state==='pending'?unknown('audit_operation_pending'):terminalEnvelope(r,true);
}
const toEventDto = (row) => ({
  seq: Number(row.seq),
  eventId: row.event_id,
  databaseInstanceId: row.database_instance_id,
  occurredAt: row.occurred_at,
  action: row.action,
  outcome: row.outcome,
  resultCode: row.result_code,
  reasonCode: row.reason_code,
  actor: row.actor,
  operationId: row.operation_id,
  parentOperationId: row.parent_operation_id ?? null,
  attempt: Number(row.attempt),
  accountSetId: row.account_set_id === null ? null : Number(row.account_set_id),
  voucherId: row.voucher_id === null ? null : Number(row.voucher_id),
  period: row.period ?? null,
  jobId: row.job_id ?? null,
  itemId: row.item_id ?? null,
  stageId: row.stage_id ?? null,
  correlation: row.correlation ?? null,
  contentDigest: row.content_digest,
});


const FILTER_KEYS = Object.freeze([
  "action",
  "outcome",
  "resultCode",
  "actor",
  "operationId",
  "accountSetId",
  "voucherId",
  "period",
  "jobId",
  "itemId",
  "afterSeq",
  "limit",
]);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const requireTechIdFilter = (value, field) => {
  if (!isTechId(value)) throw fail("audit_filter_invalid", { field });
  return value;
};

/**
 * 只读分页查询（**只读**：不改库、不建库）。
 *
 * 过滤条件全部参数化；排序固定为 `seq ASC`，游标 `afterSeq` 稳定（无重复、无遗漏）。
 * 非法过滤值 → `audit_filter_invalid`（不回显原始值，避免注入串或敏感哨兵被回显）。
 *
 * @returns {{events:object[], nextCursor:number|null, hasMore:boolean}}
 */
export function queryAuditEvents(db, filter = {}) {
  if (!db || typeof db.prepare !== "function") throw fail("audit_operation_invalid", { field: "db" });
  assertInstalledSchema(db);
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw fail("audit_filter_invalid", { field: "filter" });
  }
  let unknown = 0;
  for (const key of Object.keys(filter)) if (!FILTER_KEYS.includes(key)) unknown += 1;
  if (unknown) throw fail("audit_filter_invalid", { field: "unknown", count: unknown });

  const where = [];
  const params = [];
  const eq = (column, value) => {
    where.push(`${column} = ?`);
    params.push(value);
  };

  if (filter.action !== undefined && filter.action !== null) {
    if (!ACTION_SET.has(filter.action)) throw fail("audit_filter_invalid", { field: "action" });
    eq("action", filter.action);
  }
  if (filter.outcome !== undefined && filter.outcome !== null) {
    if (!OUTCOME_SET.has(filter.outcome)) throw fail("audit_filter_invalid", { field: "outcome" });
    eq("outcome", filter.outcome);
  }
  if (filter.resultCode !== undefined && filter.resultCode !== null) {
    if (!RESULT_CODE_SET.has(filter.resultCode)) throw fail("audit_filter_invalid", { field: "resultCode" });
    eq("result_code", filter.resultCode);
  }
  if (filter.actor !== undefined && filter.actor !== null) {
    if (!ACTOR_SET.has(filter.actor)) throw fail("audit_filter_invalid", { field: "actor" });
    eq("actor", filter.actor);
  }
  if (filter.operationId !== undefined && filter.operationId !== null) {
    requireTechIdFilter(filter.operationId, "operationId");
    eq("operation_id", filter.operationId);
  }
  if (filter.accountSetId !== undefined && filter.accountSetId !== null) {
    if (!isTechnicalRowId(filter.accountSetId)) throw fail("audit_filter_invalid", { field: "accountSetId" });
    eq("account_set_id", filter.accountSetId);
  }
  if (filter.voucherId !== undefined && filter.voucherId !== null) {
    if (!isTechnicalRowId(filter.voucherId)) throw fail("audit_filter_invalid", { field: "voucherId" });
    eq("voucher_id", filter.voucherId);
  }
  if (filter.period !== undefined && filter.period !== null) {
    if (!isAuditPeriod(filter.period)) throw fail("audit_filter_invalid", { field: "period" });
    eq("period", filter.period);
  }
  for (const [field, column] of [["jobId", "job_id"], ["itemId", "item_id"]]) {
    if (filter[field] === undefined || filter[field] === null) continue;
    requireTechIdFilter(filter[field], field);
    eq(column, filter[field]);
  }

  let afterSeq = 0;
  if (filter.afterSeq !== undefined && filter.afterSeq !== null) {
    if (!Number.isSafeInteger(filter.afterSeq) || filter.afterSeq < 0) {
      throw fail("audit_filter_invalid", { field: "afterSeq" });
    }
    afterSeq = filter.afterSeq;
  }
  if (afterSeq > 0) {
    where.push("seq > ?");
    params.push(afterSeq);
  }

  let limit = DEFAULT_LIMIT;
  if (filter.limit !== undefined && filter.limit !== null) {
    if (!Number.isSafeInteger(filter.limit) || filter.limit < 1) {
      throw fail("audit_filter_invalid", { field: "limit" });
    }
    if (filter.limit > MAX_LIMIT) throw fail("audit_filter_invalid", { field: "limit", max: MAX_LIMIT });
    limit = filter.limit;
  }

  const sql = `SELECT ${EVENT_COLUMNS} FROM audit_events
               ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY seq ASC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit + 1);
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit).map(toEventDto);
  return {
    events,
    nextCursor: events.length ? events[events.length - 1].seq : null,
    hasMore,
  };
}

const ACTION_SET = new Set(AUDIT_ACTIONS);
const OUTCOME_SET = new Set(AUDIT_OUTCOMES);
const ACTOR_SET = new Set(AUDIT_ACTORS);
const RESULT_CODE_SET = new Set(AUDIT_RESULT_CODES);

/** 单条事件（只读）；不存在返回 null。 */
export function getAuditEvent(db, { eventId, seq } = {}) {
  assertInstalledSchema(db);
  if (typeof eventId === "string" && eventId) {
    const row = db.prepare(`SELECT ${EVENT_COLUMNS} FROM audit_events WHERE event_id=?`).get(eventId);
    return row ? toEventDto(row) : null;
  }
  if (Number.isSafeInteger(seq) && seq > 0) {
    const row = db.prepare(`SELECT ${EVENT_COLUMNS} FROM audit_events WHERE seq=?`).get(seq);
    return row ? toEventDto(row) : null;
  }
  throw fail("audit_filter_invalid", { field: "eventId" });
}

/** 只读计数（按 action / outcome 聚合；不含任何业务内容）。 */
export function auditEventStats(db) {
  assertInstalledSchema(db);
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM audit_events`).get()?.n ?? 0);
  const byAction = db.prepare(`SELECT action, COUNT(*) AS n FROM audit_events GROUP BY action ORDER BY action`)
    .all().map((r) => ({ action: r.action, count: Number(r.n) }));
  const byOutcome = db.prepare(`SELECT outcome, COUNT(*) AS n FROM audit_events GROUP BY outcome ORDER BY outcome`)
    .all().map((r) => ({ outcome: r.outcome, count: Number(r.n) }));
  return { total, byAction, byOutcome };
}


export function verifyAuditEvents(db) {
 assertInstalledSchema(db);const rows=db.prepare('SELECT * FROM audit_events ORDER BY seq').all();
 return {checked:rows.length,mismatched:rows.filter(r=>!validEvent(r)).map(r=>Number(r.seq))};
}
export function listAuditInstances(db) {assertInstalledSchema(db);return db.prepare('SELECT * FROM audit_database_instances ORDER BY created_at,instance_id').all().map(r=>({instanceId:r.instance_id,createdAt:r.created_at,parentInstanceId:r.parent_instance_id,isActive:r.is_active===1}));}
export function appendAuditEvent(){throw fail('audit_operation_protocol_required');}
export function appendDeferredFailure(){throw fail('audit_operation_protocol_required');}
export function runAuditedOperation(){throw fail('audit_operation_protocol_required');}
export function markAuditInstanceFork(){throw fail('audit_operation_protocol_required');}
