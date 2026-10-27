// Fixed reject-only period admission fence. No callbacks, financial writes or journal.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { scopedAccountingTargetSnapshot } from './agency-business-evidence.mjs';
const context=new AsyncLocalStorage();
const check=(v,code)=>{if(!v)throw Object.assign(new Error(code),{code});};
export function periodStateDigest(db,scope){
 const auxiliary={};
 for(const table of ['aux_entities','aux_allocations','aux_requirements'])if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))auxiliary[table]=db.prepare(`SELECT * FROM ${table} WHERE account_set_id=? ORDER BY rowid`).all(scope.accountSetId);
 return createHash('sha256').update(JSON.stringify({targetSnapshot:scopedAccountingTargetSnapshot(db,scope),auxiliary})).digest('hex');
}
export function withPeriodAdmissionEvidence(scope,expectedStateDigest,nativeAction,fn){
 check(typeof expectedStateDigest==='string'&&/^[a-f0-9]{64}$/.test(expectedStateDigest),'period_state_digest_required');
 return context.run({scope:Object.freeze({...scope}),expectedStateDigest,nativeAction,admitted:false},fn);
}
const identity=(db,c)=>{
 check(db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get()?.instance_id===c.scope.databaseInstanceId&&db.prepare('SELECT enterprise_key FROM import_enterprise_account_sets WHERE account_set_id=?').get(c.scope.accountSetId)?.enterprise_key===c.scope.enterpriseKey,'period_scope_changed');
};
export function assertPeriodAdmissionEvidence(db,options){
 const c=context.getStore();if(!c)return;
 identity(db,c);check(options.action===c.nativeAction&&options.scope.kind==='account_set'&&options.scope.value===c.scope.accountSetId,'period_authorization_action_mismatch');
 check(periodStateDigest(db,c.scope)===c.expectedStateDigest,'period_state_changed');c.admitted=true;
}
export function assertPeriodCommitEvidence(db){
 const c=context.getStore();if(!c)return;check(c.admitted,'period_admission_not_verified');identity(db,c);
 // The held accounting resources exclude other native writers. The authorized
 // operation itself changes its snapshot; it must not be compared to the old one.
}
