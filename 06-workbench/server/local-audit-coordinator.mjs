import { withDomainWrite, assertWriteCommitFence, withBatchStageResources } from './local-write-lock.mjs';
// Trusted synchronous domain coordinator. ALS carries correlation only, never authority.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { auditError, auditCanonicalDigest, auditResultDigest, auditResultSnapshot, normalizeAuditResultRefs, isTechId } from './local-audit.mjs';
import { prepareOperation, executePreparedOperation, executePreparedChild, bindPreparedChildren } from './local-audit-operation.mjs';
const bankInvalidationListeners=new Set();
export function onBankInvalidation(listener){bankInvalidationListeners.add(listener);return ()=>bankInvalidationListeners.delete(listener);}
function bankInvalidationCount(db,options){if(!options.action.startsWith('bank.'))return null;return db.prepare("SELECT COUNT(*) n FROM bank_audit_events WHERE account_set_id=? AND event_type='match_invalidated'").get(options.scope.value).n;}
const metadata=new AsyncLocalStorage(), frames=new WeakMap(), evidence=new WeakMap(), snapshots=new Map();
export function withRequestMetadata(value,fn) {
 const operationId=value?.operationId??randomUUID(),actor=value?.actor??'domain';
 if(!isTechId(operationId)||!['http','agent','mcp','cli','domain','batch','system'].includes(actor))throw auditError('audit_operation_invalid');
 const inherited=metadata.getStore();if(inherited?.explicit!==false&&inherited?.operationId&&value?.operationId&&inherited.operationId!==operationId)throw auditError('audit_operation_conflict');
 return metadata.run(Object.freeze({operationId,actor,explicit:value?.explicit??true}),fn);
}
export function extractOperationMetadata(input,{operationId,actor='domain'}={}) {
 auditResultSnapshot(input);
 // Hash serialization intentionally omits undefined object values. Entry payloads
 // keep their original data keys so strict domain allowlists can still reject them.
 const copy=cloneDomainData(input);
 if(!copy||typeof copy!=='object'||Array.isArray(copy))throw auditError('audit_operation_invalid');
 const embedded=copy.operationId;
 if(operationId!==undefined&&embedded!==undefined&&operationId!==embedded)throw auditError('audit_operation_conflict');
 const inherited=metadata.getStore()?.operationId;
 if(inherited&&metadata.getStore()?.explicit!==false&&embedded!==undefined&&inherited!==embedded)throw auditError('audit_operation_conflict');
 const id=operationId??embedded??inherited??randomUUID();if(!isTechId(id))throw auditError('audit_operation_invalid');
 const payload={...copy};delete payload.operationId;
 return {payload,metadata:{operationId:id,actor,explicit:embedded!==undefined||operationId!==undefined||metadata.getStore()?.explicit===true}};
}
// Validate original descriptors before reading any domain option. Only the bank's
// two existing top-level cents projections may differ from strict S_result input.
// Keep undefined keys and array holes in the execution copy: serialization is not
// a substitute for the domain's own field validation.
export function copyDomainRequest(input,{bankStatementCents=false}={}) {
 if(!input||typeof input!=='object'||nodeTypes.isProxy(input)||Array.isArray(input))throw auditError('audit_result_invalid');
 const proto=Object.getPrototypeOf(input);
 if(proto!==Object.prototype&&proto!==null)throw auditError('audit_result_invalid');
 const descriptors=Object.getOwnPropertyDescriptors(input),projected=Object.create(null);
 for(const key of Reflect.ownKeys(descriptors)) {
  const descriptor=descriptors[key];
  if(typeof key!=='string'||!Object.hasOwn(descriptor,'value'))throw auditError('audit_result_invalid');
  const value=descriptor.value;
  Object.defineProperty(projected,key,{value:bankStatementCents&&['statementOpenCents','statementCloseCents'].includes(key)&&typeof value==='bigint'?value.toString():value,enumerable:true});
 }
 auditResultSnapshot(projected);
 return cloneDomainData(input);
}
// Caller must validate the full original graph before using this descriptor copy.
function cloneDomainData(value) {
  if(value===null||typeof value!=='object')return value;
  const descriptors=Object.getOwnPropertyDescriptors(value),array=Array.isArray(value),out=array?new Array(descriptors.length.value):Object.create(null);
  for(const key of Object.keys(descriptors)) {
   if(array&&key==='length')continue;
   Object.defineProperty(out,key,{value:cloneDomainData(descriptors[key].value),enumerable:true,writable:true,configurable:true});
  }
  return out;
}
export function readDomainOperationBinding(db) {
 if(frames.has(db))return null;
 const request=metadata.getStore();if(!request)return null;
 const row=db.prepare("SELECT action,scope_kind,targets_json FROM audit_operations WHERE database_instance_id=(SELECT instance_id FROM audit_database_instances WHERE is_active=1) AND operation_id=? AND attempt=1").get(request.operationId);
 if(!row||!['database','account_set'].includes(row.scope_kind))return null;
 return {action:row.action,scope:{kind:row.scope_kind,value:row.scope_kind==='database'?null:JSON.parse(row.targets_json).accountSetId}};
}
export function currentRequestMetadata() {return metadata.getStore()??null;}
export function operationErrorEvidence(error) { return evidence.get(error)??null; }
// Fixed bank transport projection; it cannot fabricate or accept proof metadata.
export function bankOperationFailure(error) {
 const safe=new Error('bank_local_operation_failed');safe.code='bank_local_operation_failed';
 const proof=evidence.get(error);if(proof)evidence.set(safe,proof);return safe;
}

function envelopeError(result) {
 const error=auditError(result.code);evidence.set(error,Object.freeze({operationId:result.receipt?.operationId??metadata.getStore()?.operationId,applied:result.durability==='committed'&&['succeeded','no_change'].includes(result.state)?true:result.state==='unknown'?'unknown':false,durability:result.durability,needsLocalReview:result.needsReview===true,receipt:result.receipt??null}));return error;
}
function restore(snapshot) {return snapshot.rootKind==='undefined'?undefined:JSON.parse(JSON.stringify(snapshot.value));}
const combinations={
 'import.create':new Set(['account_set.create','account_set.bind','account.create','opening.replace','voucher.create','voucher.create_posted','aux.entity.create','aux.allocations.replace']),
 'import.append':new Set(['account_set.bind','account.create','opening.replace','voucher.create','voucher.create_posted','aux.entity.create','aux.allocations.replace']),
};
function defaultState(value) {
 if(value?.ok===false||value?.validation?.ok===false||['rejected','conflict','failed'].includes(value?.status))return 'rejected';
 if(value?.dryRun===true)return 'no_change';
 if(['no_change','replayed','idempotent_replay'].includes(value?.status)||value?.created===false)return 'no_change';
 return 'succeeded';
}
function specification(options,value) {
 const state=options.classify?.(value)??defaultState(value);
 return {state,resultCode:state==='succeeded'?'ok':state==='no_change'?'no_change':'rejected_validation',reasonCode:state==='rejected'?'validation_failed':'none',targets:typeof options.targets==='function'?options.targets(value):options.targets??{},resultRefs:normalizeAuditResultRefs(options.refs?.(value)??[]),resultDigest:auditResultDigest(value)};
}
export function runDomainOperation(db,options,fn) {
 auditResultDigest(options.request);
 assertImmutableDomainBinding(db,options);
 return withDomainWrite(db,options,()=>runDomainOperationBody(db,options,fn));
}
// Admission reads which select an import target run under the same resources as execution.
export function runDomainAdmission(db,options,admit) {
 auditResultDigest(options.request);
 assertImmutableDomainBinding(db,options);
 return withDomainWrite(db,options,()=>{
  const result=admit();if(!result.operation)return result.value;
  return runDomainOperationBody(db,result.operation,result.execute);
 });
}
function assertImmutableDomainBinding(db,options) {
 // Existing immutable technical bindings may reject a conflict before *any* new
 // lock/epoch write. A match grants nothing: ordinary lock and audit admission follow.
 if(frames.has(db))return;const operationId=metadata.getStore()?.operationId;if(!operationId)return;
 const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_operations'").get();if(!exists)return;
 const row=db.prepare('SELECT action,scope_kind,scope_token,request_digest FROM audit_operations WHERE database_instance_id=(SELECT instance_id FROM audit_database_instances WHERE is_active=1) AND operation_id=? AND attempt=1').get(operationId);if(!row)return;
 const requestDigest=auditCanonicalDigest(['audit-request-v1',options.action,{domainRequestDigest:auditResultDigest(options.request)}]);
 const scopeToken=auditCanonicalDigest(['audit-scope-v1',options.scope.kind,options.scope.value]);
 if(row.action!==options.action||row.scope_kind!==options.scope.kind||row.scope_token!==scopeToken||row.request_digest!==requestDigest)throw envelopeError({code:'audit_operation_conflict',state:'rejected',durability:'not_started',needsReview:false});
}
function runDomainOperationBody(db,options,fn) {
 const outer=frames.get(db);
 if(outer) {
  if(outer.children) {
   const child=outer.children.find(c=>!c.used&&c.options.action===options.action&&auditResultDigest(c.options.request)===auditResultDigest(options.request));
   if(!child)throw auditError('audit_authorization_invalid');child.used=true;
   let result;const terminal=executePreparedChild(db,child.authorization,()=>{frames.set(db,{action:options.action,scope:options.scope});try{result=fn();return specification(options,result);}finally{frames.set(db,outer);}});
   if(!terminal.ok)throw envelopeError(terminal);return result;
  }
  if(!combinations[outer.action]?.has(options.action))throw auditError('audit_transaction_conflict');
  if(outer.scope.kind==='account_set'&&options.scope.kind==='account_set'&&options.scope.value!==outer.scope.value)throw auditError('audit_operation_conflict');
  return fn();
 }
 const request=metadata.getStore()??{operationId:randomUUID(),actor:'domain'};
 const context={operationId:request.operationId,actor:request.actor,action:options.action,attempt:1,...(options.context??{}),...(options.scope.kind==='account_set'?{accountSetId:options.scope.value}:{})};
 let prepared;try{prepared=prepareOperation(db,{context,scope:options.scope,request:{domainRequestDigest:auditResultDigest(options.request)}});}catch(error){throw envelopeError({code:error?.code??'audit_unavailable',state:'rejected',durability:'not_started',needsReview:false});}
 const key=prepared.receipt?`${prepared.receipt.databaseInstanceId}:${context.operationId}:1`:null;
 if(!prepared.authorization) {
  if(!prepared.ok)throw envelopeError(prepared);
  const receipt=prepared.receipt;if(receipt?.receiptVersion!==2)throw envelopeError({...prepared,code:'audit_result_unavailable',needsReview:true});
  const saved=snapshots.get(key);
  let value;
  if(saved)value=restore(saved);else if(options.rebuild)value=options.rebuild(receipt);else throw envelopeError({...prepared,code:'audit_result_unavailable',needsReview:true});
  if(auditResultDigest(value)!==receipt.resultDigest)throw envelopeError({...prepared,code:'audit_result_unavailable',needsReview:true});
  return value;
 }
 const invalidationsBefore=bankInvalidationCount(db,options);
 let value,businessError,snapshot;
 const terminal=executePreparedOperation(db,prepared.authorization,()=>{
  frames.set(db,{action:options.action,scope:options.scope});
  try {value=fn();assertWriteCommitFence(db);snapshot=auditResultSnapshot(value);return specification(options,value);}
  catch(error){businessError=error;throw error;}
  finally{frames.delete(db);}
 });
 if(!terminal.ok) {
  if(businessError&&terminal.durability==='committed'&&['failed','rejected'].includes(terminal.state)){evidence.set(businessError,Object.freeze({operationId:context.operationId,applied:false,durability:'committed',needsLocalReview:false,receipt:terminal.receipt}));throw businessError;}
  if(!businessError&&terminal.durability==='committed'&&terminal.state==='rejected'&&value!==undefined&&specification(options,value).state==='rejected')return value;
  throw envelopeError(terminal);
 }
 snapshots.set(`${terminal.receipt.databaseInstanceId}:${context.operationId}:1`,snapshot);
 if(invalidationsBefore!==null&&bankInvalidationCount(db,options)>invalidationsBefore)for(const listener of bankInvalidationListeners){try{listener(options.scope.value);}catch{/* publication failure cannot undo the committed domain fact */}}
 return value;
}
// A fixed stage plan is prepared before the outer transaction. No dynamic child tree.
export function runAuditedBatchStage(db,options,children,fn) {
 auditResultDigest(options.request);for(const child of children)auditResultDigest(child.request);
 return withBatchStageResources(db,options,children,()=>runAuditedBatchStageBody(db,options,children,fn));
}
function runAuditedBatchStageBody(db,options,children,fn) {
 const operationId=options.operationId,actor='batch';
 const context={operationId,actor,action:'batch.stage',attempt:1,...options.context,...(options.scope.kind==='account_set'?{accountSetId:options.scope.value}:{})};
 let prepared;try{prepared=prepareOperation(db,{context,scope:options.scope,request:{domainRequestDigest:auditResultDigest(options.request)}});}catch(error){throw envelopeError({code:error?.code??'audit_unavailable',state:'rejected',durability:'not_started',needsReview:false});}
 if(!prepared.authorization) {
  if(!prepared.ok)throw envelopeError(prepared);
  const saved=snapshots.get(`${prepared.receipt.databaseInstanceId}:${operationId}:1`);
  if(!saved||auditResultDigest(restore(saved))!==prepared.receipt.resultDigest)throw envelopeError({...prepared,code:'audit_result_unavailable',needsReview:true});
  return restore(saved);
 }
 const preparedChildren=children.map((c,i)=>{const preparedChild=prepareOperation(db,{context:{operationId:`${operationId}.c${i+1}`,actor,action:c.action,parentOperationId:operationId,parentAttempt:1,attempt:1,...(c.scope.kind==='account_set'?{accountSetId:c.scope.value}:{})},scope:c.scope,request:{domainRequestDigest:auditResultDigest(c.request)}});if(!preparedChild.authorization)throw envelopeError(preparedChild);return {options:c,authorization:preparedChild.authorization,used:false};});
 bindPreparedChildren(db,prepared.authorization,preparedChildren.map(c=>c.authorization));
 let value,error;
 const terminal=executePreparedOperation(db,prepared.authorization,()=>{
  frames.set(db,{action:'batch.stage',scope:options.scope,children:preparedChildren});
  try {value=fn();assertWriteCommitFence(db);if(preparedChildren.some(c=>!c.used))throw auditError('audit_authorization_invalid');return specification(options,value);}
  catch(e){error=e;throw e;}finally{frames.delete(db);}
 });
 if(!terminal.ok) {if(error&&terminal.durability==='committed'){evidence.set(error,{operationId,applied:false,durability:'committed',needsLocalReview:false,receipt:terminal.receipt});throw error;}throw envelopeError(terminal);}
 snapshots.set(`${terminal.receipt.databaseInstanceId}:${operationId}:1`,auditResultSnapshot(value));return value;
}
