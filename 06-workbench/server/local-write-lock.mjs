import { assertRestoreWritable } from './local-restore-control.mjs';
// Local domain lock capabilities. Tokens/owners in JSON and ALS never authorize inheritance.
// No default db and no user callbacks are stored across an await.
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { acquireLock, releaseLock, renewLock, assertFence, batchError, validResourceKey } from './local-batch-storage.mjs';
import { hasActiveAuditExecution } from './local-audit-storage.mjs';
import { normalizeEnterpriseIdentity } from './enterprise-identity.mjs';
const groups=new WeakMap(), active=new WeakMap(), pendingCleanup=new WeakMap(), cleanupTimers=new WeakMap();
const fail=code=>{throw batchError(code);};
export function resourceOrder(a,b) {
 const kind=k=>k.startsWith('job:')?0:k.startsWith('book:')?1:2;
 return kind(a)-kind(b)||(kind(a)===2?Number(a.slice(12))-Number(b.slice(12)):a<b?-1:a>b?1:0);
}
function fileIdentity(db) {
 const file=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file;
 if(!file)fail('lock_database_invalid');const path=resolve(file);
 for(let p=path;;p=dirname(p)){if(lstatSync(p).isSymbolicLink()||resolve(realpathSync.native(p)).toLowerCase()!==p.toLowerCase())fail('lock_database_invalid');if(dirname(p)===p)break;}
 const st=statSync(path,{bigint:true});if(!st.isFile()||st.nlink!==1n)fail('lock_database_invalid');
 return {path,dev:st.dev,ino:st.ino};
}
function instance(db) {
 assertRestoreWritable(db);
 if(db.prepare("SELECT version FROM local_batch_component WHERE component='local-batch'").get()?.version!==3)fail('migration_requires_backup');
 const rows=db.prepare('SELECT instance_id,write_state FROM local_batch_database_instances WHERE is_active=1').all();
 if(rows.length!==1||rows[0].write_state!=='ready')fail('batch_not_ready');return rows[0].instance_id;
}
function assertGroup(db,g) {
 if(!g||g.db!==db||g.revoked||g.instanceId!==instance(db))fail('fence_lost');
 for(let p=g.file.path;;p=dirname(p)){if(lstatSync(p).isSymbolicLink()||resolve(realpathSync.native(p)).toLowerCase()!==p.toLowerCase())fail('fence_lost');if(dirname(p)===p)break;}
 const st=statSync(g.file.path,{bigint:true});if(st.dev!==g.file.dev||st.ino!==g.file.ino||st.nlink!==1n)fail('fence_lost');
 if(!hasActiveAuditExecution(db)){const f=fileIdentity(db);if(f.path!==g.file.path||f.dev!==g.file.dev||f.ino!==g.file.ino)fail('fence_lost');}
 if(g.parent)assertGroup(db,g.parent);
 for(const lock of g.locks)assertFence(db,lock);
 if(g.stage){const row=db.prepare('SELECT owner_instance,fencing_token,attempt FROM local_batch_stages WHERE id=?').get(g.stage.stageId);if(!row||row.owner_instance!==g.stage.instance||row.fencing_token!==g.stage.token||row.attempt!==g.stage.attempt)fail('fence_lost');}
}
export function acquireWriteResources(db,keys,{instance:owner=`write:${process.pid}:${randomUUID()}`,pid=process.pid,parent=null}={}) {
 assertRestoreWritable(db);
 if(db.isTransaction)fail('audit_transaction_conflict');
 cleanupWriteResources(db);
 const ordered=[...new Set(keys)].sort(resourceOrder);if(ordered.some(k=>!validResourceKey(k)))fail('lock_request_invalid');
 const inherited=parent?groups.get(parent):null;if(parent)assertGroup(db,inherited);
 const g={db,file:fileIdentity(db),instanceId:instance(db),locks:[],revoked:false,parent:inherited};
 try {for(const resourceKey of ordered){const lock=acquireLock(db,{resourceKey,instance:owner,pid});g.locks.push({resourceKey,instance:owner,token:lock.token});}}
 catch(e){g.revoked=true;queueCleanup(db,g);cleanupGroup(db,g);throw e;}
 const handle=Object.freeze(Object.create(null));groups.set(handle,g);return handle;
}
export function writeResourceLocks(db,handle) {const g=groups.get(handle);assertGroup(db,g);return [...(g.parent?.locks??[]),...g.locks].map(l=>({...l}));}
export function renewWriteResources(db,handle) {const g=groups.get(handle);assertGroup(db,g);for(const lock of g.locks)renewLock(db,lock,handle);}
function scheduleCleanup(db){
 if(cleanupTimers.has(db)||!(pendingCleanup.get(db)?.size))return;
 const timer=setTimeout(()=>{cleanupTimers.delete(db);try{cleanupWriteResources(db);}catch(error){if(error?.code==='ERR_INVALID_STATE'){pendingCleanup.delete(db);return;}}if(pendingCleanup.get(db)?.size)scheduleCleanup(db);},100);
 timer.unref();cleanupTimers.set(db,timer);
}
function queueCleanup(db,g){const pending=pendingCleanup.get(db)??new Set();pending.add(g);pendingCleanup.set(db,pending);scheduleCleanup(db);}
function cleanupGroup(db,g){
 if(db.isTransaction)return false;
 const current=fileIdentity(db);if(current.path!==g.file.path||current.dev!==g.file.dev||current.ino!==g.file.ino)fail('fence_lost');
 let busy=false;
 for(const lock of [...g.locks].reverse())try{releaseLock(db,lock);}catch(error){if(error?.errcode===5||error?.errcode===6||['SQLITE_BUSY','SQLITE_LOCKED'].includes(error?.code))busy=true;else throw error;}
 if(!busy){g.cleaned=true;pendingCleanup.get(db)?.delete(g);if(!pendingCleanup.get(db)?.size){const timer=cleanupTimers.get(db);if(timer)clearTimeout(timer);cleanupTimers.delete(db);}}return !busy;
}
export function cleanupWriteResources(db){for(const g of pendingCleanup.get(db)??[])if(!cleanupGroup(db,g))return {pending:true};return {pending:false};}
export function releaseWriteResources(db,handle) {
 const g=groups.get(handle);if(!g||g.db!==db)fail('lock_capability_invalid');
 // A revoked handle may only retry exact owner/token cleanup after real BUSY.
 g.revoked=true;if(g.cleaned)return {released:true,pending:false};queueCleanup(db,g);
 return {released:cleanupGroup(db,g),pending:!g.cleaned};
}

export function withWriteResources(db,handle,fn) {
 const g=groups.get(handle);assertGroup(db,g);const old=active.get(db);
 if(old&&old!==g)fail('lock_capability_invalid');
 active.set(db,g);
 try {const value=fn();if(value&&typeof value.then==='function')fail('lock_async_transaction');assertGroup(db,g);return value;}
 finally {if(old)active.set(db,old);else active.delete(db);}
}
export function assertWriteCommitFence(db) {const g=active.get(db);if(g)assertGroup(db,g);}
function boundKey(db,setId) {if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='import_enterprise_account_sets'").get())return null;return db.prepare('SELECT enterprise_key FROM import_enterprise_account_sets WHERE account_set_id=?').get(setId)?.enterprise_key??null;}
export function domainResources(db,options) {
 const keys=[],request=options.request;
 if(options.scope.kind==='account_set') {
  const id=options.scope.value;if(!Number.isSafeInteger(id)||id<1)fail('lock_request_invalid');keys.push(`account-set:${id}`);
  const key=boundKey(db,id);if(key)keys.push(`book:${key}`);
 }
 let raw;
 if(options.action==='account_set.create')raw=request[0]?.enterprise;
 else if(options.action==='account_set.bind')raw=request[1];
 else if(['import.create','import.append'].includes(options.action))raw=request.source;
 else if(options.action==='import.legacy')raw=request[1]?.enterprise??request[0]?.enterprise??request[0]?.meta?.enterprise;
 if(raw!==undefined){const key=normalizeEnterpriseIdentity(raw).enterpriseKey;keys.push(`book:${key}`);
  const bound=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='import_enterprise_account_sets'").get()?db.prepare('SELECT account_set_id FROM import_enterprise_account_sets WHERE enterprise_key=?').get(key):null;if(bound)keys.push(`account-set:${bound.account_set_id}`);
 }
 return [...new Set(keys)].sort(resourceOrder);
}
// Called only from server-derived coordinator options AFTER strict input validation.
export function withDomainWrite(db,options,fn) {
 const keys=domainResources(db,options),g=active.get(db);
 if(g) {
  if(!hasActiveAuditExecution(db))fail('lock_capability_invalid');assertGroup(db,g);
  if(keys.some(k=>![...(g.parent?.locks??[]),...g.locks].some(l=>l.resourceKey===k)))fail('lock_resource_missing');
  return fn();
 }
 // Ordinary domain admission stopped by a writer reservation has not begun
 // an audit callback. Preserve that existing rejection code at this boundary.
 // Low-level locking and post-admission COMMIT failures keep their own errors.
 let handle;try{handle=acquireWriteResources(db,keys);}catch(error){if(error?.errcode===5)fail('audit_admission_busy');throw error;}
 try{return withWriteResources(db,handle,()=>{if(JSON.stringify(domainResources(db,options))!==JSON.stringify(keys))fail('lock_binding_changed');return fn();});}
 finally{releaseWriteResources(db,handle);}
}
// Newly inserted sets can extend the same live audited outer; no second BEGIN/COMMIT.
export function lockCreatedAccountSet(db,id) {
 const g=active.get(db);if(!g||!hasActiveAuditExecution(db)||!Number.isSafeInteger(id)||id<1)fail('lock_capability_invalid');assertGroup(db,g);
 const key=boundKey(db,id),setKey=`account-set:${id}`;
 if(key&&!g.locks.some(l=>l.resourceKey===`book:${key}`))fail('lock_resource_missing');
 if(g.locks.some(l=>l.resourceKey===setKey))return;
 const owner=g.locks[0]?.instance;if(!owner)fail('lock_resource_missing');
 const lock=acquireLock(db,{resourceKey:setKey,instance:owner,pid:process.pid});g.locks.push({resourceKey:setKey,instance:owner,token:lock.token});
}

export function authorizesResourceRenewal(db,handle,lock) {
 const g=handle&&typeof handle==='object'?groups.get(handle):null;
 if(!g||g.db!==db||g.revoked)return false;
 assertGroup(db,g);return g.locks.some(l=>l.resourceKey===lock.resourceKey&&l.instance===lock.instance&&l.token===lock.token);
}

export function withWriteStageFence(db,stage,fn) {
 const g=active.get(db);if(!g)fail('lock_capability_invalid');const old=g.stage;g.stage={stageId:stage.stageId,instance:stage.instance,token:stage.token,attempt:stage.attempt};
 try{assertGroup(db,g);return fn();}finally{g.stage=old;}
}

export function withBatchStageResources(db,options,children,fn) {
 const keys=[...new Set([domainResources(db,options),...children.map(child=>domainResources(db,child))].flat())].sort(resourceOrder),g=active.get(db);
 if(g){assertGroup(db,g);if(keys.some(key=>![...(g.parent?.locks??[]),...g.locks].some(l=>l.resourceKey===key)))fail('lock_resource_missing');return fn();}
 const handle=acquireWriteResources(db,keys);try{return withWriteResources(db,handle,()=>{const current=[...new Set([domainResources(db,options),...children.map(child=>domainResources(db,child))].flat())].sort(resourceOrder);if(JSON.stringify(current)!==JSON.stringify(keys))fail('lock_binding_changed');return fn();});}finally{releaseWriteResources(db,handle);}
}
