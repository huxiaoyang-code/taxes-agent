import { hasActiveAuditExecution, withAuditSavepoint } from './local-audit-storage.mjs';
// Optional aux1 component. Importing this module never opens or initializes a database.
import fs from 'node:fs';
import { storedCents } from './money.mjs';
import { resolve, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const AUX_SCHEMA_VERSION = 1;
export const AUX_TABLES = Object.freeze(['aux_component_migrations','aux_entities','aux_allocations','aux_receipts','aux_operations','aux_requirements'].sort());
export function auxError(code) { const error = new Error(code); error.code = code; return error; }
const quarantined = new WeakSet();
export function assertAuxiliaryConnection(db) { if (quarantined.has(db)) throw auxError('aux_connection_quarantined'); }
function unknown(db) { quarantined.add(db); return auxError('aux_commit_unknown'); }
const fail = (condition, code) => { if (condition) throw auxError(code); };
const dimensions = [['project_id','project'],['department_id','department'],['party_id','party']];
const mutableSql = (ref) => `
 SELECT CASE WHEN EXISTS (SELECT 1 FROM periods p WHERE p.account_set_id=${ref}.account_set_id AND p.status='closed'
 AND p.period >= COALESCE((SELECT v.period FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE e.id=${ref}.entry_id),
 (SELECT start_period FROM account_sets WHERE id=${ref}.account_set_id))) THEN RAISE(ABORT,'aux_period_closed') END;`;
const allocationValidation = `
 SELECT CASE WHEN NEW.entry_id IS NOT NULL AND NOT EXISTS
 (SELECT 1 FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE e.id=NEW.entry_id AND v.account_set_id=NEW.account_set_id AND e.code=NEW.code)
 THEN RAISE(ABORT,'aux_entry_owner_mismatch') END;
 ${dimensions.map(([column,kind]) => `SELECT CASE WHEN NEW.${column} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aux_entities d WHERE d.id=NEW.${column} AND d.account_set_id=NEW.account_set_id AND d.kind='${kind}' AND d.active=1) THEN RAISE(ABORT,'aux_dimension_invalid') END;`).join('\n')}
 SELECT CASE WHEN NEW.entry_id IS NOT NULL AND (
 NEW.debit_cents+COALESCE((SELECT SUM(debit_cents) FROM aux_allocations WHERE entry_id=NEW.entry_id),0) > (SELECT ROUND(debit*100) FROM voucher_entries WHERE id=NEW.entry_id)
 OR NEW.credit_cents+COALESCE((SELECT SUM(credit_cents) FROM aux_allocations WHERE entry_id=NEW.entry_id),0) > (SELECT ROUND(credit*100) FROM voucher_entries WHERE id=NEW.entry_id))
 THEN RAISE(ABORT,'aux_allocation_exceeds_entry') END;
 ${mutableSql('NEW')}`;
const definitions = [
 `CREATE TABLE aux_component_migrations (version INTEGER PRIMARY KEY CHECK(version=1), applied_at TEXT NOT NULL, backup_sha256 TEXT NOT NULL, backup_bytes INTEGER NOT NULL CHECK(backup_bytes>0))`,
 `CREATE TABLE aux_entities (id INTEGER PRIMARY KEY AUTOINCREMENT, account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE RESTRICT, kind TEXT NOT NULL CHECK(kind IN ('project','department','party')), code TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), UNIQUE(account_set_id,kind,code))`,
 `CREATE TABLE aux_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE RESTRICT, code TEXT NOT NULL, entry_id INTEGER REFERENCES voucher_entries(id) ON DELETE RESTRICT, opening_code TEXT, project_id INTEGER REFERENCES aux_entities(id) ON DELETE RESTRICT, department_id INTEGER REFERENCES aux_entities(id) ON DELETE RESTRICT, party_id INTEGER REFERENCES aux_entities(id) ON DELETE RESTRICT, debit_cents INTEGER NOT NULL CHECK(typeof(debit_cents)='integer' AND debit_cents>=0 AND debit_cents<=99999999999999), credit_cents INTEGER NOT NULL CHECK(typeof(credit_cents)='integer' AND credit_cents>=0 AND credit_cents<=99999999999999), CHECK((entry_id IS NOT NULL AND opening_code IS NULL) OR (entry_id IS NULL AND opening_code IS NOT NULL AND opening_code=code)), CHECK((debit_cents>0 AND credit_cents=0) OR (credit_cents>0 AND debit_cents=0)), CHECK(project_id IS NOT NULL OR department_id IS NOT NULL OR party_id IS NOT NULL), FOREIGN KEY(account_set_id,code) REFERENCES accounts(account_set_id,code) ON DELETE RESTRICT, FOREIGN KEY(account_set_id,opening_code) REFERENCES opening_balances(account_set_id,code) ON DELETE RESTRICT)`,
 `CREATE INDEX idx_aux_entry ON aux_allocations(entry_id)`,
 `CREATE INDEX idx_aux_opening ON aux_allocations(account_set_id,opening_code)`,
 `CREATE TABLE aux_receipts (account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE RESTRICT, request_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version=1), fingerprint TEXT NOT NULL, target_json TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(account_set_id,request_id))`,
 `CREATE TABLE aux_operations (id INTEGER PRIMARY KEY AUTOINCREMENT, account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE RESTRICT, request_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
 `CREATE TABLE aux_requirements (account_set_id INTEGER NOT NULL, code TEXT NOT NULL, project INTEGER NOT NULL DEFAULT 0 CHECK(project IN (0,1)), department INTEGER NOT NULL DEFAULT 0 CHECK(department IN (0,1)), party INTEGER NOT NULL DEFAULT 0 CHECK(party IN (0,1)), PRIMARY KEY(account_set_id,code), FOREIGN KEY(account_set_id,code) REFERENCES accounts(account_set_id,code) ON DELETE RESTRICT)`,
 `CREATE TRIGGER aux_allocation_insert BEFORE INSERT ON aux_allocations BEGIN ${allocationValidation} END`,
 `CREATE TRIGGER aux_allocation_update BEFORE UPDATE ON aux_allocations BEGIN SELECT RAISE(ABORT,'aux_replace_required'); END`,
 `CREATE TRIGGER aux_allocation_delete BEFORE DELETE ON aux_allocations BEGIN ${mutableSql('OLD')} END`,
 `CREATE TRIGGER aux_entity_identity BEFORE UPDATE OF id,account_set_id,kind,code ON aux_entities WHEN NEW.id IS NOT OLD.id OR NEW.account_set_id IS NOT OLD.account_set_id OR NEW.kind IS NOT OLD.kind OR NEW.code IS NOT OLD.code BEGIN SELECT RAISE(ABORT,'aux_entity_identity_immutable'); END`,
 `CREATE TRIGGER aux_entry_update BEFORE UPDATE OF id,voucher_id,line_no,code,debit,credit ON voucher_entries WHEN EXISTS(SELECT 1 FROM aux_allocations WHERE entry_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.voucher_id IS NOT OLD.voucher_id OR NEW.line_no IS NOT OLD.line_no OR NEW.code IS NOT OLD.code OR NEW.debit IS NOT OLD.debit OR NEW.credit IS NOT OLD.credit) BEGIN SELECT RAISE(ABORT,'aux_entry_reallocation_required'); END`,
 `CREATE TRIGGER aux_entry_delete BEFORE DELETE ON voucher_entries WHEN EXISTS(SELECT 1 FROM aux_allocations WHERE entry_id=OLD.id) BEGIN SELECT RAISE(ABORT,'aux_entry_reallocation_required'); END`,
 `CREATE TRIGGER aux_voucher_update BEFORE UPDATE OF id,account_set_id,period ON vouchers WHEN EXISTS(SELECT 1 FROM aux_allocations a JOIN voucher_entries e ON e.id=a.entry_id WHERE e.voucher_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.account_set_id IS NOT OLD.account_set_id OR NEW.period IS NOT OLD.period) BEGIN SELECT RAISE(ABORT,'aux_entry_reallocation_required'); END`,
 `CREATE TRIGGER aux_voucher_delete BEFORE DELETE ON vouchers WHEN EXISTS(SELECT 1 FROM aux_allocations a JOIN voucher_entries e ON e.id=a.entry_id WHERE e.voucher_id=OLD.id) BEGIN SELECT RAISE(ABORT,'aux_entry_reallocation_required'); END`,
 `CREATE TRIGGER aux_opening_update BEFORE UPDATE ON opening_balances WHEN EXISTS(SELECT 1 FROM aux_allocations WHERE account_set_id=OLD.account_set_id AND opening_code=OLD.code) AND (NEW.account_set_id IS NOT OLD.account_set_id OR NEW.code IS NOT OLD.code OR NEW.debit IS NOT OLD.debit OR NEW.credit IS NOT OLD.credit) BEGIN SELECT RAISE(ABORT,'aux_opening_reallocation_required'); END`,
 `CREATE TRIGGER aux_opening_delete BEFORE DELETE ON opening_balances WHEN EXISTS(SELECT 1 FROM aux_allocations WHERE account_set_id=OLD.account_set_id AND opening_code=OLD.code) BEGIN SELECT RAISE(ABORT,'aux_opening_reallocation_required'); END`,
 `CREATE TRIGGER aux_account_update BEFORE UPDATE OF account_set_id,code,id ON accounts WHEN EXISTS(SELECT 1 FROM aux_allocations WHERE account_set_id=OLD.account_set_id AND code=OLD.code) AND (NEW.account_set_id IS NOT OLD.account_set_id OR NEW.code IS NOT OLD.code OR NEW.id IS NOT OLD.id) BEGIN SELECT RAISE(ABORT,'aux_account_reallocation_required'); END`,
 `CREATE TRIGGER aux_set_start_update BEFORE UPDATE OF start_period ON account_sets WHEN NEW.start_period IS NOT OLD.start_period AND EXISTS(SELECT 1 FROM aux_allocations WHERE account_set_id=OLD.id) BEGIN SELECT RAISE(ABORT,'aux_period_reallocation_required'); END`,
 `CREATE TRIGGER aux_receipts_insert BEFORE INSERT ON aux_receipts WHEN EXISTS(SELECT 1 FROM aux_receipts WHERE account_set_id=NEW.account_set_id AND request_id=NEW.request_id) BEGIN SELECT RAISE(ABORT,'aux_history_immutable'); END`,
 `CREATE TRIGGER aux_operations_insert BEFORE INSERT ON aux_operations WHEN EXISTS(SELECT 1 FROM aux_operations WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'aux_history_immutable'); END`,
 ...['aux_receipts','aux_operations'].flatMap(table => ['UPDATE','DELETE'].map(action => `CREATE TRIGGER ${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'aux_history_immutable'); END`)),
];
export const AUX_DDL = Object.freeze(definitions);
const normalize = sql => String(sql).replace(/\s+/g,' ').trim().replace(/;$/,'');
const expectedObjects = definitions.map(sql => ({name: /^CREATE (?:TABLE|INDEX|TRIGGER) (\w+)/.exec(sql)[1], sql:normalize(sql)})).sort((a,b)=>a.name.localeCompare(b.name));
export const AUX_COMPONENT_STRUCTURE = Object.freeze({name:'auxiliary',version:1, ddl:expectedObjects});
export function auxiliarySchemaFacts(db) {
 assertAuxiliaryConnection(db); return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all().filter(r => r.name.startsWith('aux_') || r.name.startsWith('idx_aux_') || AUX_TABLES.includes(r.tbl_name) || /\baux_[a-z_]+\b/i.test(r.sql??''));
}
export function inspectAuxiliarySchema(db, coreVersion=5) {
 const objects=auxiliarySchemaFacts(db); if(!objects.length) return {present:false,problems:[],tables:[]};
 const explicit=objects.filter(o=>o.sql!==null).map(o=>({name:o.name,sql:normalize(o.sql)})).sort((a,b)=>a.name.localeCompare(b.name));
 const problems=[];
 if(coreVersion!==5) problems.push({kind:'aux_core_unsupported'});
 if(JSON.stringify(explicit)!==JSON.stringify(expectedObjects)) problems.push({kind:'aux_structure_mismatch'});
 // Exact DDL fixes columns, defaults, PK/rowid, CHECK, FK actions and all index keys/collations/order.
 // Automatic indexes must also have the exact names/table ownership (no extra UNIQUE structures).
 const auto=objects.filter(o=>o.sql===null).map(o=>o.name).sort();
 const wantAuto=['sqlite_autoindex_aux_entities_1','sqlite_autoindex_aux_receipts_1','sqlite_autoindex_aux_requirements_1'].sort();
 if(JSON.stringify(auto)!==JSON.stringify(wantAuto)) problems.push({kind:'aux_indexes_mismatch'});
 if(!problems.length) {
  const rows=db.prepare('SELECT * FROM aux_component_migrations').all();
  if(rows.length!==1 || rows[0].version!==1 || !/^[a-f0-9]{64}$/.test(rows[0].backup_sha256) || !Number.isSafeInteger(rows[0].backup_bytes) || rows[0].backup_bytes<=0 || Number.isNaN(Date.parse(rows[0].applied_at))) problems.push({kind:'aux_version_invalid'});
  const invalid=db.prepare(`SELECT COUNT(*) n FROM aux_allocations a LEFT JOIN voucher_entries e ON e.id=a.entry_id LEFT JOIN vouchers v ON v.id=e.voucher_id WHERE
    (a.entry_id IS NOT NULL AND (v.account_set_id IS NOT a.account_set_id OR e.code IS NOT a.code))
    OR EXISTS(SELECT 1 FROM aux_entities d WHERE (d.id=a.project_id AND (d.kind!='project' OR d.account_set_id!=a.account_set_id)) OR (d.id=a.department_id AND (d.kind!='department' OR d.account_set_id!=a.account_set_id)) OR (d.id=a.party_id AND (d.kind!='party' OR d.account_set_id!=a.account_set_id)))`).get().n;
  const over=db.prepare(`SELECT a.entry_id FROM aux_allocations a JOIN voucher_entries e ON e.id=a.entry_id GROUP BY a.entry_id HAVING SUM(a.debit_cents)>ROUND(e.debit*100) OR SUM(a.credit_cents)>ROUND(e.credit*100)`).all();
  if(invalid||over.length)problems.push({kind:'aux_allocation_invalid'});

 }
 return {present:true,version:1,name:'auxiliary',problems,tables:AUX_TABLES,objects};
}
export function assertAuxiliaryReady(db) { assertAuxiliaryConnection(db); const check=inspectAuxiliarySchema(db, db.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v); fail(!check.present,'aux_not_installed'); fail(check.problems.length,'aux_structure_invalid'); }
export function assertPlainPath(file) {
 const full=resolve(file); let p=full;
 while(true) { const s=fs.lstatSync(p); fail(s.isSymbolicLink(),'aux_path_alias'); const real=fs.realpathSync.native(p); fail(real.toLowerCase()!==resolve(p).toLowerCase(),'aux_path_alias'); const parent=dirname(p); if(parent===p)break; p=parent; }
 fail(fs.statSync(full).nlink!==1,'aux_path_alias'); return full;
}
export async function ensureAuxiliarySchema(db,{dbPath,outDir}={}) {
 assertAuxiliaryConnection(db); fail(!dbPath || !outDir,'aux_install_paths_required'); fail(db.isTransaction,'aux_install_transaction_active');
 const path=assertPlainPath(dbPath), main=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main');
 fail(!main?.file || resolve(main.file).toLowerCase()!==path.toLowerCase(),'aux_database_handle_mismatch');
 const before=fs.statSync(path,{bigint:true});
 const version=db.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v;
 fail(version!==5,'aux_core_unsupported');
 const state=inspectAuxiliarySchema(db,version);
 const LB=await import('./local-backup.mjs');
 if(state.present&&state.problems.length)throw auxError('aux_structure_invalid');
 await (await import('./local-batch-storage.mjs')).installBatchSchema(db,{dbPath:path,outDir:resolve(dirname(path),'batch-'+randomUUID())});
 if(state.present) { fail(state.problems.length,'aux_structure_invalid'); LB.assertSupportedDatabaseConnection(db); return {status:'already_installed',version:1}; }
 try { db.exec('BEGIN IMMEDIATE'); } catch(error) { if(db.isTransaction)throw unknown(db); throw error; }
 try {
  try{LB.assertSupportedDatabaseConnection(db);}catch{fail(true,'aux_backup_failed');}
  (await import('./local-batch-storage.mjs')).assertBatchMaintenanceReady(db);
  // The write reservation prevents committed source changes between the verified backup and DDL.
  const backup=await LB.createBackup({dbPath:path,outDir}); fail(!backup.ok,'aux_backup_failed');
  const verified=await LB.verifyBackup({backupDir:backup.backupDir});
  fail(!verified.ok || verified.status!=='ok' || verified.summary.snapshotSha256!==backup.backupMeta.snapshotSha256 || verified.manifest.source.file!==basename(path) || verified.manifest.structure.schemaVersion!==5,'aux_backup_invalid');
  try {LB.assertInstallableComponentSet(verified.manifest,'auxiliary');} catch {fail(true,'aux_component_unsupported');}
  LB.assertBackupSourceConnection(db,verified.manifest);
  const after=fs.statSync(assertPlainPath(path),{bigint:true}); fail(before.dev!==after.dev||before.ino!==after.ino,'aux_database_replaced');
  for(const sql of AUX_DDL) db.exec(sql);
  db.prepare('INSERT INTO aux_component_migrations VALUES(1,?,?,?)').run(new Date().toISOString(),backup.backupMeta.snapshotSha256,backup.backupMeta.snapshotBytes);
  assertAuxiliaryReady(db); db.exec('COMMIT'); return {status:'installed',version:1,backupDir:backup.backupDir};
 } catch(error) {
  try { if(db.isTransaction) db.exec('ROLLBACK'); else throw unknown(db); } catch { throw unknown(db); }
  throw error;
 }
}
export function auxTransaction(db,fn) {
 assertAuxiliaryConnection(db);
 if(hasActiveAuditExecution(db)) {const result=withAuditSavepoint(db,fn);return result&&typeof result==='object'?{...result,durability:'committed'}:result;}
 if(db.isTransaction)throw auxError('audit_transaction_conflict');
 const nested=db.isTransaction, name=`aux_${randomUUID().replaceAll('-','')}`;
 try { db.exec(nested?`SAVEPOINT ${name}`:'BEGIN IMMEDIATE'); } catch(error) { if(nested||db.isTransaction)throw unknown(db); throw error; }
 try { const result=fn(); db.exec(nested?`RELEASE ${name}`:'COMMIT'); return result && typeof result==='object' ? {...result, ...(nested && result.status==='applied'?{status:'staged'}:{}), durability:nested?'pending_outer_commit':'committed'} : result; }
 catch(error) { try { if(nested) db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); else if(db.isTransaction) db.exec('ROLLBACK'); else throw unknown(db); } catch { throw unknown(db); } throw error; }
}
export const auxFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Only explicitly configured auxiliary requirements can block a period close. */
export function auxiliaryCompletenessStep(db,setId,period) {
 assertAuxiliaryConnection(db); if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='aux_requirements'").get()) return null;
 assertAuxiliaryReady(db);
 const requirements=db.prepare('SELECT * FROM aux_requirements WHERE account_set_id=?').all(setId); if(!requirements.length)return null;
 let missing=0, inactive=0;
 for(const req of requirements) {
  const wanted=['project','department','party'].filter(d=>req[d]===1); if(!wanted.length)continue;
  const entries=db.prepare("SELECT e.* FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? AND v.period<=? AND v.status='posted' AND e.code=?").all(setId,period,req.code);
  for(const entry of entries) {
   const parts=db.prepare('SELECT * FROM aux_allocations WHERE entry_id=?').all(entry.id);
   for(const dim of wanted) {
    const assigned=parts.filter(p=>p[dim+'_id']!==null).reduce((s,p)=>s+BigInt(p.debit_cents)+BigInt(p.credit_cents),0n);
    if(assigned!==storedCents(entry.debit)+storedCents(entry.credit))missing++;
   }
  }
  const opening=db.prepare('SELECT * FROM opening_balances WHERE account_set_id=? AND code=?').get(setId,req.code);
  if(opening) { const parts=db.prepare('SELECT * FROM aux_allocations WHERE account_set_id=? AND opening_code=?').all(setId,req.code);
   for(const dim of wanted) { const assigned=parts.filter(p=>p[dim+'_id']!==null).reduce((s,p)=>s+BigInt(p.debit_cents)-BigInt(p.credit_cents),0n); if(assigned!==storedCents(opening.debit)-storedCents(opening.credit)||parts.some(p=>p[dim+'_id']===null))missing++; }
  }
  for(const dim of wanted) inactive+=db.prepare(`SELECT COUNT(*) n FROM aux_allocations a JOIN aux_entities d ON d.id=a.${dim}_id LEFT JOIN voucher_entries e ON e.id=a.entry_id LEFT JOIN vouchers v ON v.id=e.voucher_id WHERE a.account_set_id=? AND a.code=? AND d.active=0 AND (a.entry_id IS NULL OR (v.status='posted' AND v.period<=?))`).get(setId,req.code,period).n;
 }
 const blocking=missing||inactive?[{code:'auxiliary_incomplete',message:'必需辅助维度存在未分配或停用引用',details:{missing,inactive}}]:[];
 return {id:'auxiliary',title:'辅助核算完整性',status:blocking.length?'blocked':'ok',blocking};
}
