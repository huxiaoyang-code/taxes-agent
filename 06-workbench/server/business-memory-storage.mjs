// 企业业务记忆组件；连接与企业范围由调用方显式传入，本模块不打开全局账库。
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { assertRestoreWritable } from './local-restore-control.mjs';
import { assertPlainPath } from './auxiliary-storage.mjs';
import { sqlReferencesNamespace } from './local-audit-storage.mjs';

export const BUSINESS_MEMORY_COMPONENT = 'business-memory';
export const BUSINESS_MEMORY_SCHEMA_VERSION = 1;
export const BUSINESS_MEMORY_TABLES = Object.freeze(['business_memory_component_migrations','business_memory_topics','business_memory_versions','business_memory_cases','business_memory_state','business_memory_runs'].sort());
export const businessMemoryError = code => Object.assign(new Error(code), { code });
const fail = (condition, code) => { if (condition) throw businessMemoryError(code); };
const sha = value => createHash('sha256').update(value).digest('hex');
export function canonicalBusinessMemory(value) {
 const seen = new Set();
 const encode = v => {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  fail(!v || typeof v !== 'object' || seen.has(v), 'finance_memory_json_invalid');
  fail(Array.isArray(v) ? Object.getPrototypeOf(v) !== Array.prototype : ![Object.prototype,null].includes(Object.getPrototypeOf(v)), 'finance_memory_json_invalid');
  seen.add(v);
  const descriptors = Object.getOwnPropertyDescriptors(v), ownKeys = Object.keys(v);
  fail(ownKeys.some(k => !('value' in descriptors[k])), 'finance_memory_json_invalid');
  const keys = ownKeys.filter(k => descriptors[k].value !== undefined);
  const result = Array.isArray(v) ? '[' + v.map(encode).join(',') + ']' : '{' + keys.sort().map(k => JSON.stringify(k) + ':' + encode(descriptors[k].value)).join(',') + '}';
  seen.delete(v); return result;
 };
 return encode(value);
}
export const businessMemoryDigest = value => sha(canonicalBusinessMemory(value));
const normalize = sql => String(sql).replace(/\s+/g, ' ').trim().replace(/;$/, '');
const immutable = (table, {owned=false}={}) => [
 `CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'finance_memory_history_immutable'); END`,
 `CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table}${owned ? ' WHEN EXISTS(SELECT 1 FROM account_sets WHERE id=OLD.account_set_id)' : ''} BEGIN SELECT RAISE(ABORT,'finance_memory_history_immutable'); END`,
];
export const BUSINESS_MEMORY_DDL = Object.freeze([
 `CREATE TABLE business_memory_component_migrations(version INTEGER PRIMARY KEY CHECK(version=1),applied_at TEXT NOT NULL,backup_sha256 TEXT NOT NULL,backup_bytes INTEGER NOT NULL CHECK(backup_bytes>0))`,
 `CREATE TABLE business_memory_topics(account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,enterprise_key TEXT NOT NULL,topic TEXT NOT NULL,object_key TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),updated_at TEXT NOT NULL,PRIMARY KEY(account_set_id,topic,object_key))`,
 `CREATE TABLE business_memory_versions(version_id TEXT PRIMARY KEY,account_set_id INTEGER NOT NULL,enterprise_key TEXT NOT NULL,database_instance_id TEXT NOT NULL,topic TEXT NOT NULL,object_key TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),effective_from TEXT NOT NULL,effective_to TEXT,authority TEXT NOT NULL CHECK(authority IN ('ledger_fact','observed_history','candidate','operator_decision')),content_json TEXT NOT NULL,content_digest TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(account_set_id,topic,object_key,revision),FOREIGN KEY(account_set_id,topic,object_key) REFERENCES business_memory_topics(account_set_id,topic,object_key) ON DELETE CASCADE)`,
 `CREATE TABLE business_memory_cases(case_ref TEXT PRIMARY KEY,account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,enterprise_key TEXT NOT NULL,source_key TEXT NOT NULL,topic TEXT NOT NULL,object_key TEXT NOT NULL,period TEXT NOT NULL,status TEXT NOT NULL,authority TEXT NOT NULL CHECK(authority IN ('ledger_fact','observed_history')),priority INTEGER NOT NULL,content_json TEXT NOT NULL,content_digest TEXT NOT NULL,UNIQUE(account_set_id,source_key))`,
 `CREATE INDEX business_memory_cases_search ON business_memory_cases(account_set_id,topic,object_key,priority DESC,period DESC,case_ref)`,
 `CREATE TABLE business_memory_state(account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,enterprise_key TEXT NOT NULL,period TEXT NOT NULL,fingerprint TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),indexed_at TEXT NOT NULL,summary_json TEXT NOT NULL,source_state_json TEXT NOT NULL,PRIMARY KEY(account_set_id,period))`,
 `CREATE TABLE business_memory_runs(run_id TEXT PRIMARY KEY,account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,enterprise_key TEXT NOT NULL,database_instance_id TEXT NOT NULL,version_id TEXT NOT NULL REFERENCES business_memory_versions(version_id) ON DELETE CASCADE,period TEXT NOT NULL,status TEXT NOT NULL,content_json TEXT NOT NULL,content_digest TEXT NOT NULL,created_at TEXT NOT NULL)`,
 `CREATE TRIGGER business_memory_versions_replace BEFORE INSERT ON business_memory_versions WHEN EXISTS(SELECT 1 FROM business_memory_versions WHERE version_id=NEW.version_id OR (account_set_id=NEW.account_set_id AND topic=NEW.topic AND object_key=NEW.object_key AND revision=NEW.revision)) BEGIN SELECT RAISE(ABORT,'finance_memory_history_immutable'); END`,
 `CREATE TRIGGER business_memory_runs_replace BEFORE INSERT ON business_memory_runs WHEN EXISTS(SELECT 1 FROM business_memory_runs WHERE run_id=NEW.run_id) BEGIN SELECT RAISE(ABORT,'finance_memory_history_immutable'); END`,
 // SQLite先移除父账套，再执行外键级联；只有整账删除可清理其记忆。
 // 账套仍存在时，独立删除主题/版本/执行记录（含REPLACE隐式级联）均不得改写历史。
 ...['business_memory_versions','business_memory_runs'].flatMap(table => immutable(table,{owned:true})),
 ...immutable('business_memory_component_migrations'),
]);
const quarantined = new WeakSet();
const assertConnection = db => fail(quarantined.has(db), 'finance_memory_connection_quarantined');
const unknown = db => { quarantined.add(db); return businessMemoryError('finance_memory_commit_unknown'); };
export function businessMemorySchemaFacts(db) {
 assertConnection(db);
 return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all().filter(r => r.name.toLowerCase().startsWith('business_memory_') || r.tbl_name.toLowerCase().startsWith('business_memory_') || sqlReferencesNamespace(r.sql,'business_memory_')).map(r => ({...r,sql:r.sql === null ? null : normalize(r.sql)}));
}
let expectedFacts;
function contractFacts() {
 if (!expectedFacts) { const conn = new DatabaseSync(':memory:'); try { for (const sql of BUSINESS_MEMORY_DDL) conn.exec(sql); expectedFacts = businessMemorySchemaFacts(conn); } finally { conn.close(); } }
 return expectedFacts;
}
export const businessMemoryComponentContract = version => {
 fail(version !== 1,'finance_memory_schema_newer');
 return {name:BUSINESS_MEMORY_COMPONENT,version:1,tables:BUSINESS_MEMORY_TABLES,structure:{ddl:BUSINESS_MEMORY_DDL}};
};
const parse = text => { const value = JSON.parse(text); fail(canonicalBusinessMemory(value) !== text,'finance_memory_schema_inconsistent'); return value; };
const digest = value => /^[a-f0-9]{64}$/.test(value ?? '');
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const period = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
export function inspectBusinessMemorySchema(db, coreVersion) {
 const objects = businessMemorySchemaFacts(db);
 if (!objects.length) return {state:'not_installed',ok:false,present:[],problems:[],objects};
 const problems = [];
 try {
  if (coreVersion === undefined) coreVersion = db.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v;
  fail(coreVersion !== 5,'finance_memory_core_unsupported');
  fail(canonicalBusinessMemory(objects) !== canonicalBusinessMemory(contractFacts()),'finance_memory_structure_invalid');
  const migrations = db.prepare('SELECT * FROM business_memory_component_migrations').all();
  fail(migrations.length !== 1 || migrations[0].version !== 1 || !iso(migrations[0].applied_at) || !digest(migrations[0].backup_sha256) || !Number.isSafeInteger(migrations[0].backup_bytes) || migrations[0].backup_bytes <= 0,'finance_memory_migration_invalid');
  for (const table of BUSINESS_MEMORY_TABLES.filter(t => t !== 'business_memory_component_migrations')) {
   fail(db.prepare(`SELECT COUNT(*) n FROM ${table} m LEFT JOIN import_enterprise_account_sets b ON b.account_set_id=m.account_set_id WHERE b.enterprise_key IS NOT m.enterprise_key`).get().n > 0,'finance_memory_owner_invalid');
  }
  // 审计组件独立核对其SQL命名空间；跨组件实例关系在内容契约中核实，避免外部FK污染其精确DDL。
  for (const table of ['business_memory_versions','business_memory_runs']) fail(db.prepare(`SELECT COUNT(*) n FROM ${table} m LEFT JOIN audit_database_instances a ON a.instance_id=m.database_instance_id WHERE a.instance_id IS NULL`).get().n > 0,'finance_memory_instance_invalid');
  for (const r of db.prepare('SELECT * FROM business_memory_versions').all()) {
   const v = parse(r.content_json);
   fail(sha(r.content_json) !== r.content_digest || v.methodRef !== r.version_id || v.versionRef !== r.version_id || v.topic !== r.topic || v.objectKey !== r.object_key || v.revision !== r.revision || v.authority !== r.authority || v.effectiveFrom !== r.effective_from || (v.effectiveTo ?? null) !== r.effective_to || !period(v.effectiveFrom) || v.effectiveTo !== undefined && (!period(v.effectiveTo) || v.effectiveTo < v.effectiveFrom) || !iso(r.created_at) || !v.definition || !Array.isArray(v.evidenceRefs),'finance_memory_version_invalid');
  }
  for (const r of db.prepare('SELECT t.*,COUNT(v.version_id) n,MAX(v.revision) latest FROM business_memory_topics t LEFT JOIN business_memory_versions v ON v.account_set_id=t.account_set_id AND v.topic=t.topic AND v.object_key=t.object_key GROUP BY t.account_set_id,t.topic,t.object_key').all()) fail(r.n !== r.revision || r.latest !== r.revision || !iso(r.updated_at),'finance_memory_revision_invalid');
  for (const r of db.prepare('SELECT * FROM business_memory_cases').all()) {
   const c = parse(r.content_json);
   fail(sha(r.content_json) !== r.content_digest || c.caseRef !== r.case_ref || c.topic !== r.topic || c.objectKey !== r.object_key || c.period !== r.period || c.status !== r.status || c.authority !== r.authority || !digest(c.fingerprint) || !period(c.period),'finance_memory_case_invalid');
  }
  for (const r of db.prepare('SELECT * FROM business_memory_state').all()) { parse(r.summary_json); parse(r.source_state_json); fail(!digest(r.fingerprint) || !iso(r.indexed_at) || !period(r.period),'finance_memory_state_invalid'); }
  for (const r of db.prepare('SELECT * FROM business_memory_runs').all()) {
   const run = parse(r.content_json), v = db.prepare('SELECT account_set_id,enterprise_key FROM business_memory_versions WHERE version_id=?').get(r.version_id);
   fail(sha(r.content_json) !== r.content_digest || !v || v.account_set_id !== r.account_set_id || v.enterprise_key !== r.enterprise_key || run.methodRef !== r.version_id || run.runId !== r.run_id || !period(r.period) || !iso(r.created_at),'finance_memory_run_invalid');
  }
 } catch (error) { problems.push({kind:error.code?.startsWith('finance_memory_') ? error.code : 'finance_memory_structure_invalid'}); }
 return {state:problems.length ? 'invalid' : 'ok',ok:!problems.length,version:1,present:BUSINESS_MEMORY_TABLES,tables:BUSINESS_MEMORY_TABLES,objects,problems};
}
export function assertBusinessMemoryReady(db) {
 const state = inspectBusinessMemorySchema(db); fail(state.state === 'not_installed','finance_memory_not_prepared'); fail(!state.ok,'finance_memory_schema_inconsistent'); return state;
}
export function assertBusinessMemoryScope(db, scope) {
 assertConnection(db);
 fail(!scope || !Number.isSafeInteger(scope.accountSetId) || scope.accountSetId <= 0 || typeof scope.enterpriseKey !== 'string' || typeof scope.databaseInstanceId !== 'string' || !period(scope.period),'finance_memory_scope_invalid');
 const rows = db.prepare('SELECT a.id,b.enterprise_key FROM account_sets a JOIN import_enterprise_account_sets b ON b.account_set_id=a.id WHERE a.id=?').all(scope.accountSetId);
 const instances = db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').all();
 fail(rows.length !== 1 || rows[0].enterprise_key !== scope.enterpriseKey || instances.length !== 1 || instances[0].instance_id !== scope.databaseInstanceId,'finance_memory_scope_mismatch');
 return scope;
}
export async function ensureBusinessMemorySchema(db, {dbPath,outDir} = {}) {
 assertRestoreWritable(db); assertConnection(db);
 fail(!dbPath || !outDir,'finance_memory_install_paths_required'); fail(db.isTransaction,'finance_memory_transaction_active');
 const path = assertPlainPath(dbPath), main = db.prepare('PRAGMA database_list').all().find(r => r.name === 'main');
 fail(!main?.file || resolve(main.file).toLowerCase() !== path.toLowerCase(),'finance_memory_database_handle_mismatch');
 fail(db.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v !== 5,'finance_memory_core_unsupported');
 const LB = await import('./local-backup.mjs'), state = inspectBusinessMemorySchema(db);
 if (state.state !== 'not_installed') { fail(!state.ok,'finance_memory_schema_inconsistent'); LB.assertSupportedDatabaseConnection(db); return {status:'already_installed',version:1}; }
 const before = statSync(path,{bigint:true});
 try { db.exec('BEGIN IMMEDIATE'); } catch (e) { if (db.isTransaction) throw unknown(db); throw e; }
 try {
  LB.assertSupportedDatabaseConnection(db);
  (await import('./local-batch-storage.mjs')).assertBatchMaintenanceReady(db);
  const backup = LB.createBackup({dbPath:path,outDir}); fail(!backup.ok,'finance_memory_backup_failed');
  const checked = LB.verifyBackup({backupDir:backup.backupDir});
  fail(!checked.ok || checked.manifest.snapshot.sha256 !== backup.backupMeta.snapshotSha256 || checked.manifest.source.file !== basename(path),'finance_memory_backup_invalid');
  LB.assertInstallableComponentSet(checked.manifest,BUSINESS_MEMORY_COMPONENT); LB.assertBackupSourceConnection(db,checked.manifest);
  const after = statSync(assertPlainPath(path),{bigint:true}); fail(before.dev !== after.dev || before.ino !== after.ino,'finance_memory_database_replaced');
  for (const sql of BUSINESS_MEMORY_DDL) db.exec(sql);
  db.prepare('INSERT INTO business_memory_component_migrations VALUES(1,?,?,?)').run(new Date().toISOString(),backup.backupMeta.snapshotSha256,backup.backupMeta.snapshotBytes);
  assertBusinessMemoryReady(db); db.exec('COMMIT');
  return {status:'installed',version:1,backupDir:backup.backupDir};
 } catch (e) { try { if (!db.isTransaction) throw unknown(db); db.exec('ROLLBACK'); } catch { throw unknown(db); } throw e; }
}
function transaction(db, scope, fn, verify) {
 assertRestoreWritable(db); assertBusinessMemoryScope(db,scope); assertBusinessMemoryReady(db); fail(db.isTransaction,'finance_memory_transaction_active');
 try { db.exec('BEGIN IMMEDIATE'); } catch (e) { if (db.isTransaction) throw unknown(db); throw e; }
 try { assertBusinessMemoryScope(db,scope); verify?.(); const result = fn(); verify?.(); db.exec('COMMIT'); return result; }
 catch (e) { try { if (!db.isTransaction) throw unknown(db); db.exec('ROLLBACK'); } catch { throw unknown(db); } throw e; }
}
function readAdmission(db,scope) { assertBusinessMemoryScope(db,scope); assertBusinessMemoryReady(db); }
export function readBusinessMemoryState(db,scope) {
 readAdmission(db,scope);
 const r = db.prepare('SELECT * FROM business_memory_state WHERE account_set_id=? AND enterprise_key=? AND period=?').get(scope.accountSetId,scope.enterpriseKey,scope.period);
 return r ? {fingerprint:r.fingerprint,revision:r.revision,indexedAt:r.indexed_at,period:r.period,summary:parse(r.summary_json),sourceState:parse(r.source_state_json)} : null;
}
export function getBusinessMemoryMethod(db,scope,methodRef) {
 readAdmission(db,scope);
 const r = db.prepare('SELECT content_json FROM business_memory_versions WHERE version_id=? AND account_set_id=? AND enterprise_key=?').get(methodRef,scope.accountSetId,scope.enterpriseKey);
 return r ? parse(r.content_json) : null;
}
export function getBusinessMemoryCase(db,scope,caseRef) {
 readAdmission(db,scope); const r = db.prepare('SELECT content_json FROM business_memory_cases WHERE case_ref=? AND account_set_id=? AND enterprise_key=?').get(caseRef,scope.accountSetId,scope.enterpriseKey);
 return r ? parse(r.content_json) : null;
}
function paged(db,scope,options,table,order) {
 readAdmission(db,scope);
 const {topic,objectKey,limit=20,offset=0} = options ?? {};
 fail(!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0,'finance_memory_pagination_invalid');
 const filters = ['account_set_id=?','enterprise_key=?'], args = [scope.accountSetId,scope.enterpriseKey];
 if (table === 'business_memory_cases') { filters.push('period<?'); args.push(scope.period); }
 for (const [key,value] of [['topic',topic],['object_key',objectKey]]) if (value !== undefined) { fail(typeof value !== 'string','finance_memory_filter_invalid'); filters.push(key+'=?'); args.push(value); }
 const where = filters.join(' AND '), total = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...args).n;
 return {items:db.prepare(`SELECT content_json FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args,limit,offset).map(r => parse(r.content_json)),total,limit,offset};
}
export const listBusinessMemoryMethods = (db,scope,options) => paged(db,scope,options,'business_memory_versions','topic,object_key,revision DESC');
export const searchBusinessMemoryCases = (db,scope,options) => paged(db,scope,options,'business_memory_cases','priority DESC,period DESC,case_ref');
function appendVersion(db,scope,input) {
 const {topic,objectKey='',effectiveFrom,effectiveTo,authority,definition,evidenceRefs=[],expectedRevision} = input;
 fail(typeof topic !== 'string' || !topic.trim() || topic.length > 128 || typeof objectKey !== 'string' || objectKey.length > 256 || !period(effectiveFrom) || effectiveTo !== undefined && (!period(effectiveTo) || effectiveTo < effectiveFrom) || !['ledger_fact','observed_history','candidate','operator_decision'].includes(authority) || !definition || typeof definition !== 'object' || !Array.isArray(evidenceRefs),'finance_memory_method_invalid');
 const previous = db.prepare('SELECT revision FROM business_memory_topics WHERE account_set_id=? AND topic=? AND object_key=?').get(scope.accountSetId,topic,objectKey)?.revision ?? 0;
 fail(expectedRevision !== undefined && expectedRevision !== previous,'finance_memory_revision_conflict');
 const revision = previous+1, createdAt = new Date().toISOString(), methodRef = 'bm:'+randomUUID();
 if (previous) db.prepare('UPDATE business_memory_topics SET revision=?,updated_at=? WHERE account_set_id=? AND topic=? AND object_key=?').run(revision,createdAt,scope.accountSetId,topic,objectKey);
 else db.prepare('INSERT INTO business_memory_topics VALUES(?,?,?,?,?,?)').run(scope.accountSetId,scope.enterpriseKey,topic,objectKey,revision,createdAt);
 const content = {...input,topic,objectKey,effectiveFrom,authority,definition,evidenceRefs,methodRef,versionRef:methodRef,version:revision,revision,createdAt}; delete content.expectedRevision;
 const encoded = canonicalBusinessMemory(content);
 db.prepare('INSERT INTO business_memory_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(methodRef,scope.accountSetId,scope.enterpriseKey,scope.databaseInstanceId,topic,objectKey,revision,effectiveFrom,effectiveTo ?? null,authority,encoded,sha(encoded),createdAt);
 return content;
}
export const appendBusinessMemoryMethodVersion = (db,scope,input,{verify}={}) => transaction(db,scope,() => appendVersion(db,scope,input),verify);
export function replaceBusinessMemoryIndex(db,scope,{fingerprint,cases,methods=[],summary,sourceState},{verify}={}) {
 fail(!digest(fingerprint) || !Array.isArray(cases),'finance_memory_index_invalid');
 return transaction(db,scope,() => {
  const before = db.prepare('SELECT revision,fingerprint FROM business_memory_state WHERE account_set_id=? AND period=?').get(scope.accountSetId,scope.period);
  db.prepare('DELETE FROM business_memory_cases WHERE account_set_id=? AND enterprise_key=?').run(scope.accountSetId,scope.enterpriseKey);
  for (const c of cases) {
   fail(typeof c.sourceKey !== 'string' || typeof c.caseRef !== 'string' || !digest(c.fingerprint) || !period(c.period),'finance_memory_case_invalid');
   const encoded = canonicalBusinessMemory(c);
   db.prepare('INSERT INTO business_memory_cases VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(c.caseRef,scope.accountSetId,scope.enterpriseKey,c.sourceKey,c.topic,c.objectKey ?? '',c.period,c.status,c.authority,c.priority ?? 0,encoded,sha(encoded));
  }
  let methodCount = 0;
  for (const m of methods) {
   const latest = db.prepare('SELECT content_json FROM business_memory_versions WHERE account_set_id=? AND topic=? AND object_key=? AND authority=? ORDER BY revision DESC LIMIT 1').get(scope.accountSetId,m.topic,m.objectKey ?? '',m.authority);
   const signature = value => businessMemoryDigest({definition:value.definition,evidenceRefs:value.evidenceRefs,effectiveFrom:value.effectiveFrom});
   if (!latest || signature(parse(latest.content_json)) !== signature(m)) { appendVersion(db,scope,m); methodCount++; }
  }
  const indexedAt = new Date().toISOString(), revision = (before?.revision ?? 0)+1;
  db.prepare('INSERT INTO business_memory_state VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_set_id,period) DO UPDATE SET enterprise_key=excluded.enterprise_key,fingerprint=excluded.fingerprint,revision=excluded.revision,indexed_at=excluded.indexed_at,summary_json=excluded.summary_json,source_state_json=excluded.source_state_json').run(scope.accountSetId,scope.enterpriseKey,scope.period,fingerprint,revision,indexedAt,canonicalBusinessMemory(summary),canonicalBusinessMemory(sourceState));
  return {fingerprint,revision,indexedAt,summary,caseCount:cases.length,methodCount:db.prepare('SELECT COUNT(*) n FROM business_memory_versions WHERE account_set_id=? AND enterprise_key=?').get(scope.accountSetId,scope.enterpriseKey).n,newMethodCount:methodCount,changed:before?.fingerprint !== fingerprint};
 },verify);
}
export function recordBusinessMemoryRun(db,scope,input) {
 return transaction(db,scope,() => {
  const method = getBusinessMemoryMethod(db,scope,input.methodRef); fail(!method,'finance_memory_method_missing');
  const runId = 'bmr:'+randomUUID(), createdAt = new Date().toISOString(), content = {...input,runId,createdAt,methodRef:method.methodRef,methodVersion:method.version,period:input.period ?? scope.period};
  fail(!period(content.period) || typeof content.status !== 'string','finance_memory_run_invalid');
  const encoded = canonicalBusinessMemory(content);
  db.prepare('INSERT INTO business_memory_runs VALUES(?,?,?,?,?,?,?,?,?,?)').run(runId,scope.accountSetId,scope.enterpriseKey,scope.databaseInstanceId,method.methodRef,content.period,content.status,encoded,sha(encoded),createdAt);
  return content;
 });
}
