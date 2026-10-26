// Period business adapter. Every write delegates to the existing audited accounting API.
// This module owns no execution journal; Harness and native audit receipts own recovery.
import { createHash } from 'node:crypto';
import { persistedVoucherFingerprint } from './import-storage.mjs';
import { auditCanonicalDigest, auditResultDigest } from './local-audit.mjs';
import { periodStateDigest, withPeriodAdmissionEvidence } from './period-business-evidence.mjs';
import { loadHarness } from './harness-store.mjs';
import { withReadSnapshot } from './local-batch-storage.mjs';
import { queryOperation } from './local-audit-operation.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const check=(v,code)=>{if(!v)throw Object.assign(new Error(code),{code});};
export const PERIOD_CAPABILITIES=['period.inspect','period.impact','period.carryforward','period.close','period.reopen','period.unpost-derived'];
export function createPeriodAdapter({db,A,C}) {
 const vouchers=(setId,from,to)=>db.prepare('SELECT * FROM vouchers WHERE account_set_id=? AND period>=? AND period<=? ORDER BY period,id').all(setId,from,to).map(v=>({...v,entries:db.prepare('SELECT code,summary,debit,credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no').all(v.id)}));
 const fingerprint=v=>({voucherId:v.id,period:v.period,status:v.status,kind:v.kind,fingerprint:persistedVoucherFingerprint(v,v.entries)});
 const inspect=(scope,period=scope.period)=>{
  const set=A.getAccountSet(scope.accountSetId),periods=A.listPeriods(scope.accountSetId),all=vouchers(scope.accountSetId,set.start_period,period),checkResult=A.periodEndCheck(scope.accountSetId,period);
  const state={period,status:A.periodStatus(scope.accountSetId,period),vouchers:all.map(fingerprint),periods:periods.filter(p=>p.period<=period)};
  return {status:'inspected',scope,period,stateDigest:periodStateDigest(db,scope),periodState:state.status,vouchers:all.filter(v=>v.period===period).map(fingerprint),check:checkResult,accountingConfirmation:'pending',periodComplete:false,submittable:false};
 };
 const impact=async(scope,request)=>{
  const from=request.fromPeriod??scope.period;check(/^20\d\d-(0[1-9]|1[0-2])$/.test(from)&&from===scope.period,'period_impact_scope_mismatch');
  const allPeriods=A.listPeriods(scope.accountSetId).filter(p=>p.period>=from),last=allPeriods.at(-1)?.period??from;
  const all=vouchers(scope.accountSetId,from,last),derived=all.filter(v=>v.kind==='carryforward'&&v.status==='posted');
  const closed=allPeriods.filter(p=>p.status==='closed'),reverse=[];
  for(const p of [...allPeriods].reverse()){
   if(p.status==='closed')reverse.push({capabilityId:'period.reopen',period:p.period});
   const carries=derived.filter(v=>v.period===p.period).sort((a,b)=>Number(a.entries.some(e=>db.prepare('SELECT category FROM accounts WHERE account_set_id=? AND code=?').get(scope.accountSetId,e.code)?.category==='损益'))-Number(b.entries.some(e=>db.prepare('SELECT category FROM accounts WHERE account_set_id=? AND code=?').get(scope.accountSetId,e.code)?.category==='损益'))||b.id-a.id);
   for(const v of carries)reverse.push({capabilityId:'period.unpost-derived',period:p.period,voucherId:v.id,expectedVoucherFingerprint:persistedVoucherFingerprint(v,v.entries)});
  }
  const affectedYears=[...new Set([from,...allPeriods.map(p=>p.period)].map(p=>p.slice(0,4)))];
  const affectedVersions=[];
  check(request.bindings===undefined||Array.isArray(request.bindings)&&request.bindings.length<=200,'period_impact_bindings_invalid');
  for(const ref of request.bindings??[]){
   const store=await loadHarness(ref.storePath);check(['enterpriseKey','accountSetId','databaseInstanceId','currency'].every(k=>store.meta.scope[k]===scope[k])&&store.meta.scope.period===ref.period,'period_impact_binding_scope_mismatch');
   const task=store.tasks.find(t=>t.taskId===ref.taskId);check(task,'period_impact_task_missing');
   const attempts=store.attempts.filter(a=>a.taskId===task.taskId&&a.result),last=attempts.at(-1),feedbacks=store.feedbacks.filter(f=>f.taskId===task.taskId);
   affectedVersions.push({storePath:ref.storePath,period:ref.period,taskId:task.taskId,capabilityId:task.capabilityId,targetVersion:last?.result.targetVersion??null,dependencyDigest:last?.result.dependencyDigest??null,lastRecordedExecutionState:last?.result.executionState??'not_started',knownInvalidated:!!last&&store.invalidatedResults.has(last.result.targetVersion),confirmationVersions:feedbacks.map(f=>({targetVersion:f.targetVersion,dependencyDigest:f.dependencyDigest,decision:f.decision,reviewer:f.reviewer})),bindingMatchesObservedVersion:ref.targetVersion===last?.result.targetVersion&&ref.dependencyDigest===last?.result.dependencyDigest,applicability:'requires_current_status_and_explicit_rebinding'});
  }
  const versionBlockers=affectedVersions.filter(v=>!v.bindingMatchesObservedVersion||v.knownInvalidated).map(v=>({code:v.knownInvalidated?'period_impact_observed_result_invalidated':'period_impact_binding_version_mismatch',storePath:v.storePath,taskId:v.taskId,period:v.period,observedTargetVersion:v.targetVersion,observedDependencyDigest:v.dependencyDigest}));
  const native={affectedVersions,fromPeriod:from,throughPeriod:last,closedPeriods:closed,derivedVouchers:derived.map(fingerprint),affectedVouchers:all.map(fingerprint),reverseSteps:reverse,forwardPeriods:allPeriods.map(p=>p.period),affectedYears};
  return {status:'impact_planned',scope,...native,planDigest:hash(native),affectedTasks:[...allPeriods.map(p=>({period:p.period,branches:['accounting','profit_carryforward','period_check','period_close','tax_calculation','accountant_confirmation']})),...affectedYears.map(year=>({period:year,branches:['annual_calculation','annual_inspection','accountant_confirmation']}))],blockers:affectedVersions.length?versionBlockers:[{code:'period_impact_version_bindings_not_provided',reason:'Supply actual explicit monthly/tax/annual/review Store task bindings; no global scan or inferred confirmation versions'}],nextSteps:[...versionBlockers.map(b=>({action:'query_current_status_and_explicitly_rebind',...b})),...reverse.map(s=>({...s,action:'execute_with_current_scope_authorization_and_state_digest'})),{action:'correct_original_business',requires:'explicit correction postingDate and native proposal-bound accountant feedback; retain originals'},{action:'recompute_and_rebind',periods:allPeriods.map(p=>p.period),requires:'actual current tax/month/year task versions; harness_plan replaces entire graph'},{action:'reclose_forward',periods:allPeriods.map(p=>p.period)},{action:'request_new_accountant_review',years:affectedYears}],accountingConfirmation:'pending',annualCalculation:'requires_recomputation',annualClose:'not_completed',periodComplete:false,submittable:false};
 };
 const binding=(scope,action,request)=>{
  check(request.month===undefined||request.month===scope.period,'harness_period_mismatch');
  if(action==='period.carryforward')return {action:'profit.carry_forward',args:[scope.accountSetId,scope.period,{yearEnd:request.yearEnd===true,retainHistory:true}]};
  if(action==='period.close'||action==='period.reopen')return {action:action==='period.close'?'period.close':'period.reopen',args:[scope.accountSetId,scope.period,action==='period.close'?'closed':'open']};
  const v=A.getVoucher(scope.accountSetId,request.voucherId);check(v.kind==='carryforward'&&v.period===scope.period,'period_derived_voucher_scope_mismatch');
  return {action:'voucher.unpost',args:[scope.accountSetId,request.voucherId]};
 };
 // Reusing an open/closed value does not revive an earlier control version.
 // Bind only this book/month's committed native close/reopen events, not future
 // months or unrelated books. The native audit owns the monotone event sequence.
 const periodControlVersion=scope=>{
  const digest=(action,status)=>auditCanonicalDigest(['audit-request-v1',action,{domainRequestDigest:auditResultDigest([scope.accountSetId,scope.period,status])}]);
  const latest=db.prepare("SELECT o.operation_id,o.attempt,o.action FROM audit_operations o JOIN audit_events e ON e.event_id=o.terminal_event_id AND e.database_instance_id=o.database_instance_id WHERE o.database_instance_id=? AND o.scope_kind='account_set' AND o.scope_token=? AND o.state IN ('succeeded','no_change') AND ((o.action='period.close' AND o.request_digest=?) OR (o.action='period.reopen' AND o.request_digest=?)) ORDER BY e.seq DESC LIMIT 1").get(scope.databaseInstanceId,auditCanonicalDigest(['audit-scope-v1','account_set',scope.accountSetId]),digest('period.close','closed'),digest('period.reopen','open'));
  check(latest,'period_control_version_unavailable');
  const proof=queryOperation(db,{databaseInstanceId:scope.databaseInstanceId,operationId:latest.operation_id,attempt:latest.attempt});
  check(proof.ok&&proof.durability==='committed','period_control_proof_unavailable');
  return {operationId:latest.operation_id,attempt:latest.attempt,action:latest.action,eventId:proof.receipt.eventId,eventSeq:proof.receipt.eventSeq};
 };
 const readProof=(scope,action,request,operationId)=>{
  const b=binding(scope,action,request),row=db.prepare('SELECT * FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=1').get(scope.databaseInstanceId,operationId);
  if(!row)return {status:'not_executed',applied:false};
  check(row.action===b.action&&row.request_digest===auditCanonicalDigest(['audit-request-v1',b.action,{domainRequestDigest:auditResultDigest(b.args)}])&&row.scope_token===auditCanonicalDigest(['audit-scope-v1','account_set',scope.accountSetId]),'harness_operation_conflict');
  const native=queryOperation(db,{databaseInstanceId:scope.databaseInstanceId,operationId});
  if(!native.ok)return {status:native.state==='unknown'?'unknown':'not_executed',applied:native.state==='unknown'?'unknown':false,proof:native};
  const refs=native.receipt.resultRefs??[],observed=refs.filter(r=>['voucher','year_end_voucher'].includes(r.type)).map(r=>fingerprint({...A.getVoucher(scope.accountSetId,r.id),entries:A.getVoucher(scope.accountSetId,r.id).entries}));
  const expectedStatus=action==='period.unpost-derived'?'draft':'posted',controlVersion=['period.close','period.reopen'].includes(action)?periodControlVersion(scope):null;
  const carryCheck=action==='period.carryforward'?A.periodEndCheck(scope.accountSetId,scope.period).steps.filter(s=>s.id==='profit_carry_forward'||request.yearEnd===true&&s.id==='year_end_carry_forward'):null;
  const current=(controlVersion===null||controlVersion.eventId===native.receipt.eventId)&&(carryCheck===null||carryCheck.every(s=>s.status!=='blocked'))&&(action==='period.close'||action==='period.reopen'?A.periodStatus(scope.accountSetId,scope.period)===(action==='period.close'?'closed':'open'):observed.every(v=>v.status===expectedStatus));
  return {status:'recovered',applied:true,scope,proof:native,current:{period:scope.period,...(['period.close','period.reopen'].includes(action)?{periodState:A.periodStatus(scope.accountSetId,scope.period)}:{}),vouchers:observed},businessProofCurrent:current,evidenceCurrent:current,carryCheck,periodControlVersion:controlVersion,proofDigest:hash({eventId:native.receipt.eventId,observed,carryCheck,periodControlVersion:controlVersion,...(['period.close','period.reopen'].includes(action)?{periodState:A.periodStatus(scope.accountSetId,scope.period)}:{})}),periodComplete:false,submittable:false};
 };
 const proof=(...args)=>db.isTransaction?readProof(...args):withReadSnapshot(db,()=>readProof(...args));
 const call=async({scope,action,phase,request,operationId})=>{
  if(action==='period.inspect')return inspect(scope);
  if(action==='period.impact')return impact(scope,request);
  const b=binding(scope,action,request),prior=proof(scope,action,request,operationId);
  if(phase==='query'||prior.applied===true||prior.applied==='unknown')return prior;
  if(phase==='prepare')return {status:'prepared',applied:false,scope,inspection:inspect(scope)};
  const authorization=request.authorization;
  check(authorization&&typeof authorization.actor==='string'&&authorization.actor.trim()&&typeof authorization.reason==='string'&&authorization.reason.trim()&&authorization.enterpriseKey===scope.enterpriseKey&&authorization.accountSetId===scope.accountSetId&&authorization.databaseInstanceId===scope.databaseInstanceId&&/^20\d\d-(0[1-9]|1[0-2])$/.test(authorization.fromPeriod)&&/^20\d\d-(0[1-9]|1[0-2])$/.test(authorization.throughPeriod)&&authorization.fromPeriod<=authorization.throughPeriod&&authorization.fromPeriod<=scope.period&&authorization.throughPeriod>=scope.period&&Array.isArray(authorization.actions)&&authorization.actions.includes(action),'period_effective_authorization_required');
  check(request.expectedStateDigest===inspect(scope).stateDigest,'period_state_changed');
  if(action==='period.unpost-derived'){
   const v=A.getVoucher(scope.accountSetId,request.voucherId);check(v.status==='posted'&&request.expectedVoucherFingerprint===persistedVoucherFingerprint(v,v.entries),'period_derived_voucher_changed');
  }
  withPeriodAdmissionEvidence(scope,request.expectedStateDigest,b.action,()=>C.withRequestMetadata({operationId,actor:'agent'},()=>action==='period.carryforward'?A.carryForwardProfit(...b.args):action==='period.unpost-derived'?A.unpostVoucher(...b.args):A.setPeriodStatus(...b.args)));
  return proof(scope,action,request,operationId);
 };
 return {call,inspect,impact};
}
