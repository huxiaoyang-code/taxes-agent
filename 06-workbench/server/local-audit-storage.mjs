import { assertPrivateRestoreCapability } from './local-backup.mjs';
import { assertRestoreWritable } from './local-restore-control.mjs';
import { assertWriteCommitFence } from './local-write-lock.mjs';
import { assertAgencyCommitEvidence } from './agency-business-evidence.mjs';
import { markBatchFailed as persistIncrementalImportFailure } from './import-storage.mjs';
import { markBatchFailed as persistBankImportFailure } from './bank-storage.mjs';
// Explicit-handle audit1/2 storage. No default database or import-time connection.
import { DatabaseSync, constants as SQL } from 'node:sqlite';
import fs from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AUDIT_ACTIONS,AUDIT_ACTORS,AUDIT_COMPONENT,AUDIT_OUTCOMES,AUDIT_RESULT_CODES,AUDIT_SCHEMA_VERSION,
 auditError as fail, auditEventDigest,auditEventDedupeKey,auditV2EventDigest,auditV2DedupeKey,
 normalizeAuditEvent,createOperationContext,serverEventFields,classifyFailure,isTechId,isAuditPeriod,isTechnicalRowId,
 canonicalAuditJson,auditCanonicalDigest,auditTargets,AUDIT_TARGET_FIELDS,normalizeAuditResultRefs,auditResultDigest } from './local-audit.mjs';
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
/** SQL identifiers only: comments/literals and ordinary column names are not dependencies. */
export function sqlReferencesNamespace(sql,prefix) {
 const raw=String(sql??'').match(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:\]\]|[^\]])*\]|[A-Za-z_][A-Za-z_0-9]*|[(),.;]/g)??[];
 const tokens=raw.filter(t=>!t.startsWith('--')&&!t.startsWith('/*')).map(t=>{
  const quoted=['"',"'",'\x60','['].includes(t[0]);
  return {quoted,value:(quoted?t.slice(1,-1).replaceAll(t[0]==='['?']]':t[0]+t[0],t[0]==='['?']':t[0]):t).toLowerCase()};
 });
 let expect=false,from=false;const stack=[];
 for(let i=0;i<tokens.length;i++) {
  const {value:t,quoted}=tokens[i];
  if(!quoted&&t==='('){stack.push(from);from=expect||false;continue;}
  if(!quoted&&t===')'){from=stack.pop()??false;expect=false;continue;}
  if(!quoted&&['from','join','update','into','references'].includes(t)){expect=true;if(t==='from')from=true;continue;}
  if(!quoted&&['select','where','group','order','having','limit','union','except','intersect','set','values','begin','end',';'].includes(t)){from=false;expect=false;continue;}
  if(!quoted&&t===','&&from){expect=true;continue;}
  if(expect){if(!quoted&&['only','or','replace','ignore','abort','fail','rollback'].includes(t))continue;
   const name=tokens[i+1]?.value==='.'?tokens[i+2]?.value:t;
   if(name?.startsWith(prefix))return true;expect=false;
  }
 }
 return false;
}
export function auditSchemaFacts(db,version) {
 const tables=tablesFor(version);
 const objects=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all().filter(r=>
   tables.includes(r.tbl_name.toLowerCase())||r.name.toLowerCase().startsWith('audit_')||r.name.toLowerCase().startsWith('idx_audit_')||sqlReferencesNamespace(r.sql,'audit_'))
   .map(r=>({...r,sql:r.sql===null?null:normalizeSql(r.sql)}));
 const facts=tables.map(t=>({table:t,
  columns:readAuditMetadata(db,'table_xinfo',t).sort((a,b)=>a.cid-b.cid),
  attributes:readAuditMetadata(db,'table_list',t)[0]??null,
  indexes:readAuditMetadata(db,'index_list',t).sort((a,b)=>a.name.localeCompare(b.name)).map(i=>({...i,keys:readAuditMetadata(db,'index_xinfo',i.name).sort((a,b)=>a.seqno-b.seqno)})),
  foreignKeys:readAuditMetadata(db,'foreign_key_list',t).sort((a,b)=>a.id-b.id||a.seq-b.seq),
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
const receiptFor=(r,e,targets,extra=null)=>({receiptVersion:extra?2:1,databaseInstanceId:r.database_instance_id,operationId:r.operation_id,attempt:r.attempt,state:r.state,resultCode:e.result_code,reasonCode:e.reason_code,eventId:e.event_id,eventSeq:e.seq,targets,...(extra?{resultRefs:extra.resultRefs,resultDigest:extra.resultDigest}:{})});
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
 const eventById=new Map(events.map(e=>[e.event_id,e])),operationByKey=new Map(ops.map(r=>[opKey(r),r]));
 if(eventById.size!==events.length||operationByKey.size!==ops.length)return false;
 for(const r of ops) {
  if(!ids.has(r.database_instance_id)||!isTechId(r.operation_id)||r.binding_version!==1||!AUDIT_ACTIONS.includes(r.action)||!AUDIT_ACTORS.includes(r.actor)||!Number.isSafeInteger(r.attempt)||r.attempt<1||r.attempt>1000000||!['database','enterprise','account_set'].includes(r.scope_kind)||!digest(r.scope_token)||!digest(r.request_digest)||!digest(r.binding_digest)||!iso(r.prepared_at))return false;
  const targets=targetsOfRow(r);
  if(canonicalAuditJson(targets)!==canonicalAuditJson(auditTargets(targets))||r.binding_digest!==bindingOf(r))return false;
  if((r.parent_operation_id===null)!==(r.parent_attempt===null)||r.parent_operation_id!==null&&(!isTechId(r.parent_operation_id)||r.parent_operation_id===r.operation_id||!Number.isSafeInteger(r.parent_attempt)||r.parent_attempt<1||r.parent_attempt>1000000))return false;
  const prior=operationByKey.get(canonicalAuditJson([r.database_instance_id,r.operation_id,r.attempt-1]));
  if(r.attempt>1&&(!prior||!['failed','rejected'].includes(prior.state)||prior.binding_digest!==r.binding_digest))return false;
  if(r.state==='pending') {if(r.terminal_event_id!==null||r.receipt_json!==null||r.finished_at!==null)return false;continue;}
  if(!['succeeded','no_change','failed','rejected'].includes(r.state)||!iso(r.finished_at))return false;
  const e=eventById.get(r.terminal_event_id);
  if(!e||!terminalCodesValid(r.state,e.result_code)||e.event_format_version!==2||e.database_instance_id!==r.database_instance_id||e.operation_id!==r.operation_id||e.attempt!==r.attempt||e.action!==r.action||e.actor!==r.actor||e.parent_operation_id!==r.parent_operation_id||e.outcome!==r.state||e.occurred_at!==r.finished_at)return false;
  const finalTargets=auditTargets(eventFromRow(e));
  if(AUDIT_TARGET_FIELDS.some(k=>targets[k]!==null&&targets[k]!==finalTargets[k]))return false;
  const actual=parseCanonical(r.receipt_json);
  let extra=null; if(actual.receiptVersion===2) {try{extra={resultRefs:normalizeAuditResultRefs(actual.resultRefs),resultDigest:actual.resultDigest};if(!digest(extra.resultDigest))return false;}catch{return false;}}else if(actual.receiptVersion!==1)return false;
  if(canonicalAuditJson(receiptFor(r,e,finalTargets,extra))!==r.receipt_json)return false;
  parseCanonical(r.receipt_json);if(terminals.has(e.event_id))return false;terminals.set(e.event_id,opKey(r));
 }
 return events.every(e=>e.event_format_version!==2||terminals.has(e.event_id));
}
export function inspectAuditSchema(db) {
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
 const present=AUDIT_TABLES.filter(t=>tables.includes(t));
 let version=0, activeInstanceId=null,activeInstanceCount=0,problems=[];
 const any=db.prepare("SELECT name FROM sqlite_master WHERE lower(name) GLOB 'audit_*' OR lower(name) GLOB 'idx_audit_*'").all().length>0;
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
const quarantine=new WeakSet(),admissionUnknowns=new WeakMap();
export function auditConnectionQuarantined(db){return quarantine.has(db);}
export function recoverBankAuditAdmission(db){
 const record=admissionUnknowns.get(db);if(!quarantine.has(db))return false;
 if(!record||record.phase!=='pending_commit_busy'||record.authorizationIssued!==false||db.isTransaction||!sameIdentity(record.file,identity(db)))throw fail('audit_unavailable');
 const state=assertInstalledSchema(db);if(state.version!==2||state.activeInstanceId!==record.r.database_instance_id||selectOperation(db,record.r))throw fail('audit_unavailable');
 admissionUnknowns.delete(db);quarantine.delete(db);return true;
}
function connection(db){if(!db||typeof db.exec!=='function'||quarantine.has(db))throw fail('audit_unavailable');if(db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)throw fail('audit_database_invalid');}
function owner(db){assertRestoreWritable(db);connection(db);if(db.isTransaction)throw fail('audit_transaction_conflict');}
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
  LB.assertSupportedDatabaseConnection(db);
  const Batch=await import('./local-batch-storage.mjs');Batch.assertBatchMaintenanceReady(db);
  const created=LB.createBackup({dbPath:before.path,outDir});if(!created.ok)throw fail('audit_backup_invalid');
  const verified=LB.verifyBackup({backupDir:created.backupDir});
  if(!verified.ok||verified.status!=='ok'||verified.summary.snapshotBytes!==created.backupMeta.snapshotBytes||verified.summary.snapshotSha256!==created.backupMeta.snapshotSha256||verified.manifest.source.file!==basename(before.path)||canonicalAuditJson(verified.manifest)!==canonicalAuditJson(created.manifest))throw fail('audit_backup_invalid');
  if(s.state==='not_installed')LB.assertInstallableComponentSet(verified.manifest,AUDIT_COMPONENT);
  try{LB.assertBackupSourceConnection(db,verified.manifest);}catch{throw fail('audit_backup_source_mismatch');}
  if(!sameIdentity(before,identity(db,dbPath)))throw fail('audit_backup_source_mismatch');
  const batchBefore=Batch.inspectBatchSchema(db);
  if(batchBefore.state!=='not_installed')Batch.assertBatchSchema(db);
  const batchActive=[2,3].includes(batchBefore.version)?Batch.readBatchInstance(db):null;
  if(s.state==='not_installed') {
   for(const sql of V1_STATEMENTS)db.exec(sql);
   db.prepare('INSERT INTO audit_components VALUES(?,?,?,?)').run(AUDIT_COMPONENT,1,new Date().toISOString(),'LOCAL-06');
   db.prepare('INSERT INTO audit_database_instances VALUES(?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),null,1,'initial');
  }
  for(const sql of V2_STEPS)db.exec(sql);
  db.prepare('UPDATE audit_components SET version=2 WHERE component=?').run(AUDIT_COMPONENT);
  // The active NULL captured under the verified source reservation is the only writable mapping.
  if(batchActive?.audit_instance_id===null) {
   const changed=db.prepare('UPDATE local_batch_database_instances SET audit_instance_id=? WHERE instance_id=? AND is_active=1 AND audit_instance_id IS NULL').run(currentAuditInstanceId(db),batchActive.instance_id);
   if(changed.changes!==1)throw fail('audit_schema_inconsistent');
  }
  if(batchBefore.state!=='not_installed')Batch.assertBatchSchema(db);
  assertInstalledSchema(db);if(!sameIdentity(before,identity(db,dbPath)))throw fail('audit_backup_source_mismatch');
  db.exec('COMMIT');return {installed:true,from:s.version,to:2,activeInstanceId:currentAuditInstanceId(db),backupDir:created.backupDir};
 }catch(e){if(!rollback(db)){quarantine.add(db);throw fail('audit_commit_unknown');}throw fail(e?.code?.startsWith('audit_')?e.code:'audit_schema_install_failed');}
}
export function openAuditDatabase(file,{readOnly=true}={}) {
 if(typeof file!=='string'||!file)throw fail('audit_operation_invalid');if(readOnly&&!fs.existsSync(file))throw fail('audit_database_missing');
 let db;try{db=new DatabaseSync(file,{readOnly});db.prepare('SELECT name FROM sqlite_master LIMIT 1').all();return db;}catch{try{db?.close();}catch{}throw fail('audit_database_invalid');}
}

/** Restore's fixed protected upgrade; no callback or general SQL authority. */
export function upgradeRestoreAuditSchema(db,{capability}={}) {
 assertPrivateRestoreCapability(db,capability);
 const s=inspectAuditSchema(db);if(s.state!=='not_installed')assertInstalledSchema(db);
 if(s.version===2)return;
 if(s.state==='not_installed'){
  for(const sql of V1_STATEMENTS)db.exec(sql);
  db.prepare('INSERT INTO audit_components VALUES(?,?,?,?)').run(AUDIT_COMPONENT,1,new Date().toISOString(),'LOCAL-06');
  db.prepare('INSERT INTO audit_database_instances VALUES(?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),null,1,'initial');
 }
 for(const sql of V2_STEPS)db.exec(sql);
 db.prepare('UPDATE audit_components SET version=2 WHERE component=?').run(AUDIT_COMPONENT);
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_batch_database_instances'").get())db.prepare('UPDATE local_batch_database_instances SET audit_instance_id=? WHERE is_active=1 AND audit_instance_id IS NULL').run(currentAuditInstanceId(db));
 assertInstalledSchema(db);
}

/** Append-only activation anchor. Paths/plan contents stay in the local file;
 * only fixed technical IDs and digests enter audit storage. */
export function recordRestoreActivation(db,{capability,request}={}) {
 assertPrivateRestoreCapability(db,capability);
 const r=normalizeBinding(db,{context:{action:'restore.activate',actor:'cli',operationId:'activate:'+request.targetInstanceId,attempt:1},scope:{kind:'database',value:null},request},{restoreCapability:capability});
 if(selectOperation(db,r))throw fail('audit_operation_conflict');
 r.prepared_at=new Date().toISOString();
 const cols=[...IMMUTABLE_OPERATION_COLUMNS,'state'];
 db.prepare(`INSERT INTO audit_operations (${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...IMMUTABLE_OPERATION_COLUMNS.map(k=>r[k]),'pending');
 finish(db,r,{state:'succeeded',resultCode:'ok',reasonCode:'none',targets:targetsOfRow(r)});
 assertInstalledSchema(db);
}
const EVENT_COLUMNS='*';
const permissions=new WeakMap();
const selectOperation=(db,r)=>db.prepare('SELECT * FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=?').get(r.database_instance_id,r.operation_id,r.attempt);
function envelope(code,{state='rejected',replayed=false,durability='not_started',retryable=false,needsReview=false,receipt=null}={}){return {ok:state==='succeeded'||state==='no_change',code,state,replayed,durability,retryable,needsReview,receipt};}
function unknown(code='audit_commit_unknown'){return envelope(code,{state:'unknown',durability:'unknown',needsReview:true});}
function terminalEnvelope(r,replayed){const receipt=parseCanonical(r.receipt_json);return envelope(r.state==='succeeded'?'ok':r.state==='no_change'?'no_change':receipt.resultCode,{state:r.state,replayed,durability:'committed',receipt});}
function requireV2(db){assertRestoreWritable(db);const s=assertInstalledSchema(db);if(s.version!==2)throw fail('audit_operation_protocol_required');return s;}
function normalizeBinding(db,input,{requireScope=true,restoreCapability}={}) {
 input=JSON.parse(canonicalAuditJson(input));
 if(!input||typeof input!=='object'||Object.keys(input).sort().join(',')!=='context,request,scope')throw fail('audit_operation_invalid');
 const context=createOperationContext(input.context),scope=input.scope;
 // This internal path is reachable only from the fixed activation recorder.
 if(restoreCapability!==undefined)assertPrivateRestoreCapability(db,restoreCapability);
 if(!scope||typeof scope!=='object'||Object.keys(scope).sort().join(',')!=='kind,value')throw fail('audit_operation_invalid');
 let value=scope.value;
 if(scope.kind==='database'){if(value!==null||context.accountSetId!==undefined)throw fail('audit_operation_invalid');}
 else if(scope.kind==='account_set') {
  if(!isTechnicalRowId(value)||context.accountSetId!==value||(requireScope&&!db.prepare('SELECT 1 FROM account_sets WHERE id=?').get(value)))throw fail('audit_operation_invalid');
 }else if(scope.kind==='enterprise') {
  if(typeof value!=='string'||!value||value.length>128||/[\u0000-\u001f\u007f]/.test(value))throw fail('audit_operation_invalid');
  value=value.normalize('NFKC').trim();if(!value)throw fail('audit_operation_invalid');
  const binding=db.prepare('SELECT account_set_id FROM import_enterprise_account_sets WHERE enterprise_key=?').get(value);
  if(requireScope&&context.accountSetId!==undefined&&binding?.account_set_id!==context.accountSetId)throw fail('audit_operation_invalid');
 }else throw fail('audit_operation_invalid');
 const r={database_instance_id:(restoreCapability!==undefined?assertInstalledSchema(db):requireV2(db)).activeInstanceId,operation_id:context.operationId,attempt:context.attempt,binding_version:1,action:context.action,actor:context.actor,scope_kind:scope.kind,scope_token:auditCanonicalDigest(['audit-scope-v1',scope.kind,value]),targets_json:canonicalAuditJson(auditTargets(context)),parent_operation_id:context.parentOperationId??null,parent_attempt:context.parentAttempt??null,request_digest:auditCanonicalDigest(['audit-request-v1',context.action,input.request])};
 r.binding_digest=bindingOf(r);return r;
}
/** A receipt is a private, one-use object issued only after durable pending COMMIT. */
export function prepareOperation(db,input) {
 owner(db);const file=identity(db),r=normalizeBinding(db,input,{requireScope:false});
 try{db.exec('BEGIN IMMEDIATE');}catch(e){if(db.isTransaction){quarantine.add(db);return unknown();}return envelope(busy(e)?'audit_admission_busy':'audit_unavailable',{retryable:busy(e)});}
 let saved,phase='admission';
 try {
  if(!sameIdentity(file,identity(db))||requireV2(db).activeInstanceId!==r.database_instance_id)throw fail('audit_authorization_invalid');
  if(normalizeBinding(db,input,{requireScope:false}).binding_digest!==r.binding_digest)throw fail('audit_operation_conflict');
  saved=selectOperation(db,r);
  if(saved){db.exec('ROLLBACK');if(saved.binding_digest!==r.binding_digest)return envelope('audit_operation_conflict');return saved.state==='pending'?unknown('audit_operation_pending'):terminalEnvelope(saved,true);}
  normalizeBinding(db,input);
  const prior=db.prepare('SELECT * FROM audit_operations WHERE database_instance_id=? AND operation_id=? ORDER BY attempt DESC LIMIT 1').get(r.database_instance_id,r.operation_id);
  if((!prior&&r.attempt!==1)||(prior&&(prior.attempt+1!==r.attempt||!['failed','rejected'].includes(prior.state)||prior.binding_digest!==r.binding_digest))){db.exec('ROLLBACK');return envelope('audit_operation_conflict');}
  r.prepared_at=new Date().toISOString();
  const columns=[...IMMUTABLE_OPERATION_COLUMNS,'state'];
  db.prepare(`INSERT INTO audit_operations (${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...IMMUTABLE_OPERATION_COLUMNS.map(k=>r[k]),'pending');
  phase='pending_commit';db.exec('COMMIT');
 }catch(e){const pendingBusy=phase==='pending_commit'&&busy(e)&&db.isTransaction;if(!rollback(db)){if(pendingBusy)admissionUnknowns.set(db,{phase:'pending_commit_busy',authorizationIssued:false,file,r});quarantine.add(db);return unknown();}throw fail(e?.code?.startsWith('audit_')?e.code:'audit_unavailable');}
 const authorization=Object.freeze(Object.create(null));permissions.set(authorization,{db,file,r,used:false});
 return {...envelope('prepared',{state:'pending',durability:'committed'}),authorization};
}
function resultSpec(value,r,claims=new Map()) {
 try {value=JSON.parse(canonicalAuditJson(value));}catch{throw fail('audit_result_invalid');}
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.then==='function')throw fail('audit_result_invalid');
 const keys=Object.keys(value);if(keys.some(k=>!['state','resultCode','reasonCode','targets','resultRefs','resultDigest'].includes(k))||!['succeeded','no_change','failed','rejected'].includes(value.state))throw fail('audit_result_invalid');
 const resultCode=value.resultCode??(value.state==='succeeded'?'ok':value.state),reasonCode=value.reasonCode??'none';
 const inputTargets=targetsOfRow(r),extra=value.targets??{};
 if(!extra||typeof extra!=='object'||Array.isArray(extra)||Object.keys(extra).some(k=>!AUDIT_TARGET_FIELDS.includes(k)))throw fail('audit_result_invalid');
 const targets=auditTargets({...inputTargets,...extra});if(AUDIT_TARGET_FIELDS.some(k=>inputTargets[k]!==null&&inputTargets[k]!==targets[k]))throw fail('audit_result_invalid');
 normalizeAuditEvent({...targets,outcome:value.state,resultCode,reasonCode,action:r.action,actor:r.actor,operationId:r.operation_id,parentOperationId:r.parent_operation_id,attempt:r.attempt});
 if(!terminalCodesValid(value.state,resultCode))throw fail('audit_result_invalid');
 const hasResult=Object.hasOwn(value,'resultRefs')||Object.hasOwn(value,'resultDigest');
 if(hasResult&&(!Object.hasOwn(value,'resultRefs')||!digest(value.resultDigest)))throw fail('audit_result_invalid');
 const resultRefs=hasResult?normalizeAuditResultRefs(value.resultRefs):[];
 for(const ref of resultRefs){if(ref.keyDigest)continue;const owner=referenceOwner(dbForResult.get(r),ref)??claims.get(`${ref.type}:${ref.id}`);if(!owner||(targets.accountSetId!==null&&owner!==targets.accountSetId))throw fail('audit_result_invalid');}
 return {state:value.state,resultCode,reasonCode,targets,...(hasResult?{resultRefs,resultDigest:value.resultDigest}:{})};
}
const dbForResult=new WeakMap();
const REF_SQL=Object.freeze({superseded_voucher:"SELECT account_set_id owner FROM vouchers WHERE id=? AND kind='carryforward' AND status='superseded'",account_set:'SELECT id owner FROM account_sets WHERE id=?',voucher:'SELECT account_set_id owner FROM vouchers WHERE id=?',year_end_voucher:'SELECT account_set_id owner FROM vouchers WHERE id=?',asset_card:'SELECT account_set_id owner FROM asset_cards WHERE id=?',aux_entity:'SELECT account_set_id owner FROM aux_entities WHERE id=?',voucher_entry:'SELECT v.account_set_id owner FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE e.id=?',bank_transaction:'SELECT account_set_id owner FROM bank_transactions WHERE id=?',bank_match:'SELECT account_set_id owner FROM bank_matches WHERE id=?',bank_ambiguity:'SELECT account_set_id owner FROM bank_ambiguities WHERE id=?',bank_reconcile_run:'SELECT account_set_id owner FROM bank_reconcile_runs WHERE id=?'});
function referenceOwner(db,ref){if(!db)return null;try{return db.prepare(REF_SQL[ref.type]).get(ref.id)?.owner??null;}catch{return null;}}
function referenceClaims(db,r){const claims=new Map(),set=targetsOfRow(r).accountSetId;dbForResult.set(r,db);if(!set)return claims;
 for(const [type,sql] of Object.entries(REF_SQL)){if(!r.action.endsWith('.delete'))continue;try {const table=type==='account_set'?'account_sets':type==='asset_card'?'asset_cards':type==='voucher'?'vouchers':null;if(table){const rows=db.prepare(type==='account_set'?'SELECT id FROM account_sets WHERE id=?':`SELECT id FROM ${table} WHERE account_set_id=?`).all(set);for(const row of rows)claims.set(`${type}:${row.id}`,set);}}catch{}}
 return claims;}
function finish(db,r,spec) {
 const e=normalizeAuditEvent({...spec.targets,action:r.action,actor:r.actor,operationId:r.operation_id,parentOperationId:r.parent_operation_id,attempt:r.attempt,outcome:spec.state,resultCode:spec.resultCode,reasonCode:spec.reasonCode},null,serverEventFields(r.database_instance_id));
 const columns=['event_id','dedupe_key','database_instance_id','occurred_at','action','outcome','result_code','reason_code','actor','operation_id','parent_operation_id','attempt','account_set_id','voucher_id','period','job_id','item_id','stage_id','correlation','content_digest','event_format_version'];
 db.prepare(`INSERT INTO audit_events(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(e.eventId,auditV2DedupeKey(e),e.databaseInstanceId,e.occurredAt,e.action,e.outcome,e.resultCode,e.reasonCode,e.actor,e.operationId,e.parentOperationId,e.attempt,...AUDIT_TARGET_FIELDS.map(k=>e[k]??null),auditV2EventDigest(e),2);
 const event=db.prepare('SELECT * FROM audit_events WHERE event_id=?').get(e.eventId);
 const updated={...r,state:spec.state};const receipt=receiptFor(updated,event,spec.targets,Object.hasOwn(spec,'resultDigest')?spec:{resultRefs:[],resultDigest:auditResultDigest(undefined)});
 const changed=db.prepare("UPDATE audit_operations SET state=?,terminal_event_id=?,receipt_json=?,finished_at=? WHERE database_instance_id=? AND operation_id=? AND attempt=? AND state='pending'").run(spec.state,e.eventId,canonicalAuditJson(receipt),e.occurredAt,r.database_instance_id,r.operation_id,r.attempt);
 if(changed.changes!==1)throw fail('audit_operation_conflict');return {...updated,receipt_json:canonicalAuditJson(receipt)};
}
const CALLBACK_DENIED=new Set([SQL.SQLITE_TRANSACTION,SQL.SQLITE_SAVEPOINT,SQL.SQLITE_PRAGMA,SQL.SQLITE_ATTACH,SQL.SQLITE_DETACH,SQL.SQLITE_ALTER_TABLE,SQL.SQLITE_CREATE_TABLE,SQL.SQLITE_CREATE_INDEX,SQL.SQLITE_CREATE_TRIGGER,SQL.SQLITE_CREATE_VIEW,SQL.SQLITE_DROP_TABLE,SQL.SQLITE_DROP_INDEX,SQL.SQLITE_DROP_TRIGGER,SQL.SQLITE_DROP_VIEW,SQL.SQLITE_CREATE_TEMP_TABLE,SQL.SQLITE_CREATE_TEMP_TRIGGER,SQL.SQLITE_CREATE_TEMP_VIEW,SQL.SQLITE_CREATE_VTABLE,SQL.SQLITE_DROP_VTABLE]);
const activeOperations=new WeakMap();
export function hasActiveAuditExecution(db) { return activeOperations.has(db); }
function permittedSql(db,predicate,run) {
 const live=activeOperations.get(db); if(!live)return run();
 if(live.permit)throw fail('audit_authorization_invalid');
 live.permit=predicate;try{return run();}finally{live.permit=null;}
}
let savepointSequence=0;
export function withAuditSavepoint(db,fn) {
 const live=activeOperations.get(db);
 if(!live&&db.isTransaction)throw fail('audit_transaction_conflict');
 const name=`audit_body_${++savepointSequence}`;
 const command=(action,sql)=>permittedSql(db,(a,b,c)=>a===SQL.SQLITE_SAVEPOINT&&b===action&&c===name,()=>db.exec(sql));
 command('BEGIN',`SAVEPOINT ${name}`);
 try {const out=fn();if(out&&typeof out.then==='function')throw fail('audit_result_invalid');command('RELEASE',`RELEASE ${name}`);return out;}
 catch(error) {try{command('ROLLBACK',`ROLLBACK TO ${name}`);command('RELEASE',`RELEASE ${name}`);}catch{if(live)live.poisoned=true;throw fail('audit_commit_unknown');}throw error;}
}
const METADATA_TABLES=new Set(['account_sets','accounts','opening_balances','periods','vouchers','voucher_entries','asset_cards','depreciation_runs','schema_migrations','schema_backups','import_batches','import_voucher_sources','import_enterprise_account_sets','audit_components','audit_database_instances','audit_events','audit_operations','bank_component_migrations','bank_component_backups','bank_accounts','bank_batches','bank_transactions','bank_batch_rows','bank_ambiguities','bank_matches','bank_audit_events','bank_reconcile_runs']);
export function readAuditMetadata(db,kind,target) {
 if(!['table_info','table_xinfo','index_list','index_xinfo','foreign_key_list','table_list'].includes(kind))throw fail('audit_authorization_invalid');
 if(kind==='index_xinfo') {const row=db.prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?").get(target);if(!row||!METADATA_TABLES.has(row.tbl_name))throw fail('audit_authorization_invalid');}
 else if(!METADATA_TABLES.has(target))throw fail('audit_authorization_invalid');
 return permittedSql(db,(a,b,c)=>a===SQL.SQLITE_PRAGMA&&b===kind&&(c===target||c===null),()=>kind==='table_list'?db.prepare("SELECT type,ncol,wr,strict FROM pragma_table_list WHERE schema='main' AND name=?").all(target):db.prepare(`SELECT * FROM pragma_${kind}(?)`).all(target));
}
export function bindPreparedChildren(db,parentAuthorization,children) {
 owner(db);const parent=permissions.get(parentAuthorization);
 if(!parent||parent.db!==db||parent.used||parent.children||!Array.isArray(children))throw fail('audit_authorization_invalid');
 const seen=new Set();parent.children=children.map(auth=>{const child=permissions.get(auth);if(!child||child.db!==db||child.used||!sameIdentity(child.file,parent.file)||child.r.database_instance_id!==parent.r.database_instance_id||child.r.parent_operation_id!==parent.r.operation_id||child.r.parent_attempt!==parent.r.attempt||seen.has(auth))throw fail('audit_authorization_invalid');seen.add(auth);return child;});
}
export function executePreparedChild(db,authorization,fn) {
 const live=activeOperations.get(db),p=permissions.get(authorization);
 if(!live||!p||p.db!==db||p.used||!live.p.children?.includes(p)||!sameIdentity(p.file,live.p.file)||!sameIdentity(p.file,identityFromLive(db,live))||p.r.parent_operation_id!==live.p.r.operation_id||p.r.parent_attempt!==live.p.r.attempt||p.r.database_instance_id!==live.p.r.database_instance_id)throw fail('audit_authorization_invalid');
 const saved=selectOperation(db,p.r);if(!saved||saved.state!=='pending'||saved.binding_digest!==p.r.binding_digest)throw fail('audit_authorization_invalid');
 p.used=true;const claims=referenceClaims(db,saved);let out,spec,businessError;const previousCurrent=live.current;live.current=p;
 try{try{out=withAuditSavepoint(db,fn);spec=resultSpec(out,saved,claims);}catch(error){businessError=error;const mapped=classifyFailure(error);spec={state:mapped.outcome,resultCode:mapped.resultCode,reasonCode:mapped.reasonCode,targets:targetsOfRow(saved)};if(!['failed','rejected'].includes(spec.state))spec={state:'failed',resultCode:'internal_error',reasonCode:'internal_error',targets:targetsOfRow(saved)};}
 }finally{live.current=previousCurrent;}
 if(!businessError&&!['succeeded','no_change'].includes(spec.state))throw fail('audit_result_invalid');
 // Only the storage's fixed terminal writes are privileged, never the child callback.
 const result=permittedSql(db,(a,b)=>[SQL.SQLITE_INSERT,SQL.SQLITE_UPDATE].includes(a)&&['audit_events','audit_operations'].includes(b),()=>finish(db,saved,spec));
 if(businessError)throw businessError;return terminalEnvelope(result,false);
}
function identityFromLive(db,live){return permittedSql(db,(a,b)=>a===SQL.SQLITE_PRAGMA&&b==='database_list',()=>identity(db));}
/** Fixed connection metadata read, including inside an audited body. No callback. */
export function readAuditDatabasePath(db){return identityFromLive(db,activeOperations.get(db)).path;}
export function executePreparedOperation(db,authorization,fn) {
 owner(db);const p=authorization&&typeof authorization==='object'?permissions.get(authorization):null;
 if(!p||p.db!==db||p.used||typeof fn!=='function')throw fail('audit_authorization_invalid');
 if(!sameIdentity(p.file,identity(db))||requireV2(db).activeInstanceId!==p.r.database_instance_id)throw fail('audit_authorization_invalid');
 try{db.exec('BEGIN IMMEDIATE');}catch(e){if(db.isTransaction){p.used=true;quarantine.add(db);return unknown();}return envelope(busy(e)?'audit_admission_busy':'audit_unavailable',{retryable:busy(e)});}
 let spec, saved, controlledFailure=null;
 try {
  if(!sameIdentity(p.file,identity(db)))throw fail('audit_authorization_invalid');
  saved=selectOperation(db,p.r);if(!saved||saved.state!=='pending'||saved.binding_digest!==p.r.binding_digest)throw fail('audit_authorization_invalid');
  const claims=referenceClaims(db,saved);p.refClaims=claims;
  p.used=true;
  const live={authorization,p,permit:null,poisoned:false};activeOperations.set(db,live);
  db.setAuthorizer((action,a,b)=>{const permit=live.permit;if(permit&&permit(action,a,b))return SQL.SQLITE_OK;return CALLBACK_DENIED.has(action)||[SQL.SQLITE_INSERT,SQL.SQLITE_UPDATE,SQL.SQLITE_DELETE].includes(action)&&String(a).startsWith('audit_')?SQL.SQLITE_DENY:SQL.SQLITE_OK;});
  let result;
  try{result=fn();if(live.poisoned)throw fail('audit_commit_unknown');}finally{activeOperations.delete(db);db.setAuthorizer(null);}
  if(!db.isTransaction)throw fail('audit_commit_unknown');
  spec=resultSpec(result,saved,p.refClaims);
  if(spec.state==='failed'||spec.state==='rejected'){controlledFailure=spec;throw fail('audit_result_invalid');}
  saved=finish(db,saved,spec);
  assertAgencyCommitEvidence(db);
  assertWriteCommitFence(db);
 }catch(e){
  activeOperations.delete(db);try{db.setAuthorizer(null);}catch{}
  if(!rollback(db)){p.bankFailure=null;p.incrementalFailure=null;for(const child of p.children??[]){child.bankFailure=null;child.incrementalFailure=null;}quarantine.add(db);return unknown();}
  if(!p.used)throw fail(e?.code?.startsWith('audit_')?e.code:'audit_unavailable');
  const mapped=controlledFailure??(e?.code==='audit_result_invalid'?{state:'rejected',resultCode:'rejected_validation',reasonCode:'audit_result_invalid',targets:targetsOfRow(p.r)}:{...classifyFailure(e),targets:targetsOfRow(p.r)});
  spec={...mapped,state:mapped.state??mapped.outcome};if(!['failed','rejected'].includes(spec.state))spec={state:'failed',resultCode:'internal_error',reasonCode:'internal_error',targets:targetsOfRow(p.r)};
  const deferred=p.bankFailure,incremental=p.incrementalFailure;p.bankFailure=null;p.incrementalFailure=null;return persistFailure(db,p.r,spec,deferred,p.children??[],incremental);
 }
 try{db.exec('COMMIT');return terminalEnvelope(saved,false);}catch(e){
  if(busy(e)&&db.isTransaction&&rollback(db))return persistFailure(db,p.r,{state:'failed',resultCode:'audit_unavailable',reasonCode:'audit_write_failed',targets:targetsOfRow(p.r)});
  try{rollback(db);}catch{}quarantine.add(db);return unknown();
 }
}
export function deferIncrementalImportFailure(db,error,failure) {
 const live=activeOperations.get(db),owner=live?.current??live?.p;
 if(!owner||!['import.create','import.append'].includes(owner.r.action)||owner.incrementalFailure||(owner.r.action==='import.append'&&failure.accountSetId!==targetsOfRow(owner.r).accountSetId)||(owner.r.action==='import.create'&&failure.accountSetId!==null))throw fail('audit_authorization_invalid');
 const keys=['batchId','sourceSystem','enterpriseKey','mode','accountSetId','contentFingerprint','errorCode','errorMessage'];if(!failure||Object.keys(failure).some(k=>!keys.includes(k)))throw fail('audit_result_invalid');
 owner.incrementalFailure={db,file:owner.file,instance:owner.r.database_instance_id,data:{...failure}};
}
function writeIncrementalFailure(db,r,record){if(!record)return;if(record.db!==db||record.instance!==r.database_instance_id||!sameIdentity(record.file,identity(db))||!['import.create','import.append'].includes(r.action)||(r.action==='import.append'&&record.data.accountSetId!==targetsOfRow(r).accountSetId))throw fail('audit_authorization_invalid');persistIncrementalImportFailure(db,record.data);}
export function deferBankImportFailure(db,error,failure) {
 const live=activeOperations.get(db);
 if(!live||live.p.r.action!=='bank.import'||failure.accountSetId!==targetsOfRow(live.p.r).accountSetId||live.p.bankFailure)throw fail('audit_authorization_invalid');
 const keys=['accountSetId','bankAccountId','batchId','sourceId','currency','period','contentSha256','mappingFingerprint','normalizationVersion','errorCode','errorMessage'];
 if(!failure||Object.keys(failure).some(k=>!keys.includes(k)))throw fail('audit_result_invalid');
 live.p.bankFailure={db,file:live.p.file,data:{...failure},error};
}
function persistFailure(db,r,spec,bankFailure=null,children=[],incrementalFailure=null) {
 try{db.exec('BEGIN IMMEDIATE');const current=selectOperation(db,r);if(!current||current.state!=='pending') {db.exec('ROLLBACK');return current?.receipt_json?terminalEnvelope(current,true):unknown();}
  if(bankFailure){if(bankFailure.db!==db||!sameIdentity(bankFailure.file,identity(db))||r.action!=='bank.import'||bankFailure.data.accountSetId!==targetsOfRow(r).accountSetId||db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get()?.instance_id!==r.database_instance_id)throw fail('audit_authorization_invalid');persistBankImportFailure(db,bankFailure.data);}
  writeIncrementalFailure(db,r,incrementalFailure);
  for(const child of children){child.used=true;writeIncrementalFailure(db,child.r,child.incrementalFailure);child.incrementalFailure=null;const row=selectOperation(db,child.r);if(!row||row.state!=='pending'||row.binding_digest!==child.r.binding_digest)throw fail('audit_authorization_invalid');finish(db,row,{state:'failed',resultCode:'failed',reasonCode:'internal_error',targets:targetsOfRow(row)});}
  const saved=finish(db,current,spec);db.exec('COMMIT');if(bankFailure)bankFailure.error.auditRecorded=true;return terminalEnvelope(saved,false);
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
export function markAuditInstanceFork(db,{capability,createdAt=new Date().toISOString()}={}){
 assertPrivateRestoreCapability(db,capability);const parent=assertInstalledSchema(db).activeInstanceId,id=randomUUID();
 db.exec('UPDATE audit_database_instances SET is_active=0 WHERE is_active=1');
 db.prepare('INSERT INTO audit_database_instances VALUES(?,?,?,?,?)').run(id,createdAt,parent,1,'restore-new');assertInstalledSchema(db);return id;
}
