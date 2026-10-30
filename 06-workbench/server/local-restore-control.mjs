// 可选的恢复身份及准入合同；不提供默认连接或 ready 设置器。
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname, basename, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const RESTORE_CONTROL_TABLES=Object.freeze(['restore_control_component','restore_control_state']);
export const RESTORE_CONTROL_SQL=Object.freeze([
 `CREATE TABLE restore_control_component(component TEXT PRIMARY KEY CHECK(component='restore-control'),version INTEGER NOT NULL CHECK(version=1),installed_at TEXT NOT NULL)`,
 `CREATE TABLE restore_control_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),target_instance_id TEXT NOT NULL UNIQUE,restore_operation_id TEXT NOT NULL,source_backup_digest TEXT NOT NULL,ledger_binding_digest TEXT NOT NULL,target_binding_digest TEXT NOT NULL,write_state TEXT NOT NULL CHECK(write_state IN ('pending','ready')),created_at TEXT NOT NULL,released_at TEXT,CHECK((write_state='pending' AND released_at IS NULL) OR (write_state='ready' AND released_at IS NOT NULL)))`,
]);
export const restoreError=code=>Object.assign(new Error(code),{code});
export const isRestoreUuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const restoreDigest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const restoreTechId=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(v);
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export function restoreCanonical(value) {
 const seen=new Set();
 function encode(v){
  if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);
  if(typeof v==='number'&&Number.isSafeInteger(v))return JSON.stringify(v);
  if(!v||typeof v!=='object'||types.isProxy(v)||seen.has(v))throw restoreError('restore_contract_required');
  if(Array.isArray(v)?Object.getPrototypeOf(v)!==Array.prototype:![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw restoreError('restore_contract_required');
  const keys=Reflect.ownKeys(v),desc=Object.getOwnPropertyDescriptors(v);
  if(keys.some(k=>typeof k!=='string'||(!Array.isArray(v)||k!=='length')&&(!('value' in desc[k])||!desc[k].enumerable)))throw restoreError('restore_contract_required');
  seen.add(v);let result;
  if(Array.isArray(v)){if(keys.length!==v.length+1||Array.from({length:v.length},(_,i)=>String(i)).some(k=>!desc[k]))throw restoreError('restore_contract_required');result='['+Array.from({length:v.length},(_,i)=>encode(desc[String(i)].value)).join(',')+']';}
  else result='{'+keys.sort().map(k=>JSON.stringify(k)+':'+encode(desc[k].value)).join(',')+'}';
  seen.delete(v);return result;
 }return encode(value);
}
export const restoreHash=value=>createHash('sha256').update(restoreCanonical(value)).digest('hex');
// 保留 SQL 字符串字面量：SQLite CHECK 的 token 值区分大小写。
export const normalizeRestoreSql=s=>s.split(/('(?:''|[^'])*')/g).map((part,i)=>i%2?part:part.replace(/\s+/g,' ').toLowerCase()).join('').trim();
export function restoreControlFacts(db){return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE lower(name) GLOB 'restore_control_*' OR lower(tbl_name) GLOB 'restore_control_*' ORDER BY name").all().map(r=>({...r,sql:r.sql===null?null:normalizeRestoreSql(r.sql)}));}
let expectedFacts;
function contractFacts(){if(!expectedFacts){const db=new DatabaseSync(':memory:');try{for(const sql of RESTORE_CONTROL_SQL)db.exec(sql);expectedFacts=restoreControlFacts(db);}finally{db.close();}}return expectedFacts;}
export function inspectRestoreControl(db){
 const facts=restoreControlFacts(db);if(!facts.length)return {state:'not_installed',ok:false,present:[]};
 try {
  const meta=db.prepare('SELECT * FROM restore_control_component').all();
  if(meta.some(r=>r.version>1))return {state:'unsupported',ok:false,present:RESTORE_CONTROL_TABLES};
  if(restoreCanonical(facts)!==restoreCanonical(contractFacts())||meta.length!==1||meta[0].component!=='restore-control'||meta[0].version!==1||!iso(meta[0].installed_at))throw Error();
  const rows=db.prepare('SELECT * FROM restore_control_state').all(),r=rows[0];
  if(rows.length!==1||r.singleton!==1||!isRestoreUuid(r.target_instance_id)||!restoreTechId(r.restore_operation_id)||![r.source_backup_digest,r.ledger_binding_digest,r.target_binding_digest].every(restoreDigest)||!iso(r.created_at)||!['pending','ready'].includes(r.write_state)||(r.write_state==='pending'?r.released_at!==null:!iso(r.released_at)))throw Error();
  return {state:'ok',ok:true,version:1,present:RESTORE_CONTROL_TABLES,row:r};
 }catch{return {state:'invalid',ok:false,present:RESTORE_CONTROL_TABLES};}
}
export function assertRestoreControl(db){const s=inspectRestoreControl(db);if(s.state==='unsupported')throw restoreError('restore_control_future_version');if(!s.ok)throw restoreError('restore_control_invalid');return s;}
export function assertRestoreWritable(db){
 const s=inspectRestoreControl(db);if(s.state==='not_installed')return;
 if(!s.ok)throw restoreError(s.state==='unsupported'?'restore_control_future_version':'restore_control_invalid');
 if(s.row.write_state!=='ready')throw restoreError('restore_target_pending');
}
export const restorePathKey=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
export const RESTORE_ACTIVATION_FILE='restore-activation.json';
/** 本机数据只有绑定到仅追加的已完成操作时，才构成证据。 */
export function readRestoreActivation(db,{databaseFile}={}) {
 const state=assertRestoreControl(db).row;
 if(state.write_state!=='ready')throw restoreError('restore_target_pending');
 const file=databaseFile??db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file;
 plainRestorePath(file);
 const path=join(dirname(file),RESTORE_ACTIVATION_FILE);plainRestorePath(path);
 const a=JSON.parse(fs.readFileSync(path,'utf8'));restoreCanonical(a);
 const r=db.prepare("SELECT * FROM audit_operations WHERE operation_id=? AND attempt=1 AND action='restore.activate' AND state='succeeded'").all('activate:'+state.target_instance_id);
 if(a.version!==1||a.targetInstanceId!==state.target_instance_id||a.operationId!==state.restore_operation_id||r.length!==1||r[0].database_instance_id!==a.auditInstanceId||r[0].request_digest!==restoreHash(['audit-request-v1','restore.activate',a]))throw restoreError('restore_activation_invalid');
 return a;
}
export function plainRestorePath(file,{absent=false,directory=false}={}){
 if(typeof file!=='string'||!isAbsolute(file)||resolve(file)!==file)throw restoreError('restore_target_binding_mismatch');
 const path=resolve(file),start=absent?dirname(path):path;
 for(let p=start;;p=dirname(p)){const s=fs.lstatSync(p);if(s.isSymbolicLink()||restorePathKey(fs.realpathSync.native(p))!==restorePathKey(p))throw restoreError('restore_target_binding_mismatch');if(dirname(p)===p)break;}
 if(absent){if(fs.existsSync(path))throw restoreError('target_exists');return {path};}
 const s=fs.statSync(path,{bigint:true});
 if(directory?!s.isDirectory():!s.isFile()||s.nlink!==1n)throw restoreError('restore_target_binding_mismatch');
 return {path,dev:String(s.dev),ino:String(s.ino)};
}
export function assertRestoreOpenPath(file){
 const path=resolve(file),dir=dirname(path);
 // 尚不存在的目标目录仍继承全部已有祖先。经其扫描或打开任何对象前，
 // 或允许调用者创建缺失子目录前，先验证最近的已有目录
 // 及完整祖先链。
 for(let p=dir;;p=dirname(p)){
  try{fs.lstatSync(p);}catch(error){if(error.code==='ENOENT'&&dirname(p)!==p)continue;throw error;}
  plainRestorePath(p,{directory:true});break;
 }
 if(basename(path).startsWith('.partial-')||fs.existsSync(join(dir,'.restore-incomplete')))throw restoreError('restore_target_pending');
 // 标记丢失不释放恢复保留锁。只检查显式目标目录，
 // 绝不发现来源、台账或其他根目录。
 if(fs.existsSync(dir)){
  plainRestorePath(dir,{directory:true});
  const names=fs.readdirSync(dir);
  if(names.some(name=>name.startsWith('.partial-'))||!fs.existsSync(path)&&names.includes('restore.json'))throw restoreError('restore_target_pending');
 }
 if(!fs.existsSync(path))return;
 plainRestorePath(path);
 const db=new DatabaseSync(path,{readOnly:true});
 try{assertRestoreWritable(db);}finally{db.close();}
}
