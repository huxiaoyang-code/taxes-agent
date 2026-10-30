import { harnessCapabilities, callHarnessAdapter } from './harness-adapters.mjs';
import { withHarness, appendHarness, harnessView, hash, stable, requireValue, operationWasRejected, sameBusinessRequest, initHarness, registerHarnessSource as registerSource, registerHarnessFacts as registerFacts, saveHarnessPlan, recordHarnessFeedback, requestHarnessMaterials, registerHarnessTreatment, recoverHarnessLock } from './harness-store.mjs';
import { validateExecutionReceipt, HARNESS_STATE_AXES, requestFactIdForTask } from './harness-contract.mjs';
import {validateCapabilityRequest} from './harness-input-contracts.mjs';
import { discoverHarnessTarget } from './harness-target.mjs';
import { readLocalFile, checkedPath } from './offline-material-store.mjs';
export { initHarness, requestHarnessMaterials, registerHarnessTreatment, recoverHarnessLock };
export const registerHarnessSource = (path,source) => registerSource(path,source,currentHarnessView);
export const registerHarnessFacts = (path,facts) => registerFacts(path,facts,currentHarnessView);
export const discoverHarness = () => ({version:'finance-harness/1',stateAxes:HARNESS_STATE_AXES,capabilities:[...harnessCapabilities().values()],parsing:{formats:'host_investigates_without_extension_whitelist',execution:'host_tools_and_optional_subagents',requiredEvidence:['original_location','parser_code','validation','unrecognized_content']},onlineTaxConnected:false});
export const planHarness = (path,tasks) => saveHarnessPlan(path,tasks,harnessCapabilities());
export const feedbackHarness = (path,feedback) => recordHarnessFeedback(path,feedback,harnessCapabilities(),currentHarnessView);
// 只有在成功读取和比较后发出的错误，才能证明发生变化。
// 读取/传输失败、被捕获的 schema 检查错误及 result_unverified
// 都不进入此集合，它们仍需重试或查询。
const proofChangedCodes=new Set([
  'harness_target_mismatch','harness_period_mismatch','harness_code_changed','harness_path_changed',
  'harness_instance_mismatch','harness_enterprise_mismatch','harness_schema_unsupported',
  'harness_agency_scope_mismatch','harness_agency_identity_missing_or_changed','harness_annual_scope_mismatch',
  'harness_operation_conflict','harness_result_missing','harness_result_changed',
  'agency_query_archive_scope_mismatch','agency_recovery_binding_mismatch',
  'agency_annual_native_asset_context_changed','agency_native_asset_changed','agency_target_changed',
  'agency_existing_posting_changed','agency_existing_source_changed','agency_prepared_result_changed','agency_confirmation_changed',
  'annual_evidence_changed_during_read','ledger_source_replaced','ledger_binding_mismatch','ledger_scope_missing',
  'posting_db_changed','posting_enterprise_binding_mismatch','posting_source_binding_mismatch','posting_scope_mismatch',
  'posting_policy_changed','posting_state_changed','posting_schema_unsupported',
  'posting_semantic_conflict','posting_receipt_inconsistent','posting_stored_entries_inconsistent',
  'posting_ledger_evidence_inconsistent','posting_batch_fingerprint_inconsistent',
]);
const unverifiable = result => result.businessProofCurrent!==false&&result.evidenceCurrent!==false&&!proofChangedCodes.has(result.code)&&(result.evidenceCurrent===null||['unknown','blocked','needs_local_review','restart_required'].includes(result.status)||result.applied==='unknown');
const applicability = (task,result,currentBinding) => currentBinding?true:unverifiable(result)&&task.executionState==='executed'&&task.blockers.every(b=>b.retryable)?null:false;
async function refreshBusinessProofs(s) {
  const observations=new Map(),unverified=(a,code)=>observations.set(a.taskId,{state:'unverified',reason:'business_proof_temporarily_unverifiable',code,retryable:true});
  for(const t of s.tasks) {
    const a=s.attempts.filter(a=>a.taskId===t.taskId&&a.result?.executionState==='executed').at(-1);
    if(!a||s.invalidatedResults.has(a.result.targetVersion))continue;
    try {
      const current=await callHarnessAdapter({...a,phase:a.effect==='write'?'query':'execute',scope:s.meta.scope,priorResult:a.result.actualImpact});
      if(unverifiable(current)){unverified(a,current.code??current.status);continue;}
      const prior=a.result.actualImpact;
      const nativeProof=value=>{if(a.capabilityId!=='voucher.create'||a.request.voucher.status==='posted')return value;const {status,...creation}=value??{};return creation;};
      const applied=current.applied===true||a.capabilityId==='agency.posting'&&current.status==='no_change'&&current.applied===false;
      const valid=a.effect==='read'?stable(current)===stable(prior):applied&&current.evidenceCurrent!==false&&current.confirmationCurrent!==false&&(a.capabilityId.startsWith('voucher.')?stable(nativeProof(current.current))===stable(nativeProof(prior.current)):a.capabilityId==='offline.posting'?current.dependencyDigest===prior.dependencyDigest&&current.policyDigest===prior.policyDigest&&current.status==='recovered':current.proofDigest===prior.proofDigest);
      if(!valid)await appendHarness(s,'invalidate_result',{taskId:a.taskId,targetVersion:a.result.targetVersion,reason:'actual_business_proof_changed'});
    }catch(e){if(proofChangedCodes.has(e.code))await appendHarness(s,'invalidate_result',{taskId:a.taskId,targetVersion:a.result.targetVersion,reason:'actual_business_binding_changed',code:e.code});else unverified(a,e.code??'harness_business_proof_unavailable');}
  }
  return observations;
}
async function inspectCurrent(path, ancestors = []) {
  const canonical = await checkedPath(path,true);
  requireValue(!ancestors.includes(canonical),'harness_external_dependency_cycle');
  return withHarness(canonical,s=>currentHarnessView(s,[...ancestors,canonical]));
}
async function currentHarnessView(s, ancestors = [s.info.root]) {
  const proofObservations=await refreshBusinessProofs(s);
  const externalByTask = new Map();
  for (const task of s.tasks) {
    if (!task.externalDependencies?.length) continue;
    const observations = [];
    for (const ref of task.externalDependencies) {
      const observation = {...ref,current:false,reason:'harness_external_dependency_unavailable'};
      try {
        // 重新检查当前 Store 和业务证明；单独的导出回执文件
        // 不能证明前期结果目前仍有效。
        const view = await inspectCurrent(ref.storePath,ancestors);
        requireValue(['enterpriseKey','accountSetId','databaseInstanceId','currency'].every(k=>view.scope[k]===s.meta.scope[k])&&view.scope.period===ref.period,'harness_external_scope_mismatch');
        const child = view.tasks.find(t=>t.taskId===ref.taskId);
        requireValue(child,'harness_external_task_missing');
        if(child.blockers.length&&child.blockers.every(b=>b.retryable)){
          Object.assign(observation,{reason:'harness_external_dependency_unverifiable',retryable:true});observations.push(observation);continue;
        }
        Object.assign(observation,{observedDependencyDigest:child.dependencyDigest,observedTargetVersion:child.receipt?.targetVersion??null,executionState:child.executionState,reviewState:child.reviewState});
        observation.reason = child.blockers.some(b=>b.reason==='harness_external_dependency_cycle') ? 'harness_external_dependency_cycle'
          : child.executionState==='unknown' ? 'harness_external_dependency_unknown'
          : child.reviewState==='rejected' ? 'harness_external_dependency_rejected'
          : child.receipt?.targetVersion!==ref.targetVersion||child.dependencyDigest!==ref.dependencyDigest ? 'harness_external_version_changed'
          : child.executionState!=='executed'||child.blockers.length ? 'harness_external_dependency_blocked' : null;
        observation.current = observation.reason===null;
      } catch (e) { observation.reason = e.code ?? 'harness_external_dependency_unavailable';observation.retryable=!['harness_external_dependency_cycle','harness_external_scope_mismatch','harness_external_task_missing','harness_journal_invalid'].includes(e.code); }
      observations.push(observation);
    }
    externalByTask.set(task.taskId,observations);
    if (observations.some(ref=>!ref.current&&!ref.retryable)) {
      const old=s.attempts.filter(a=>a.taskId===task.taskId&&a.result?.executionState==='executed').at(-1);
      if(old&&!s.invalidatedResults.has(old.result.targetVersion))await appendHarness(s,'invalidate_result',{taskId:task.taskId,targetVersion:old.result.targetVersion,reason:'external_dependency_no_longer_current'});
    }
  }
  return harnessView(s,harnessCapabilities(),externalByTask,proofObservations);
}
export const inspectHarness = path => inspectCurrent(path);

function receiptFor(intent,result,executionState) {
  const r={taskId:intent.taskId,operationId:intent.operationId,dependencyDigest:intent.dependencyDigest,capabilityId:intent.capabilityId,ruleVersion:intent.ruleVersion,codeDigest:intent.codeDigest,executionState,reviewState:executionState==='stale'?'stale':'pending',ruleState:'uncovered',resultRefs:[],actualImpact:result};
  const observation=intent.phase==='query'||intent.effect==='read';
  r.targetVersion=hash(observation?{receipt:r,observationIntentDigest:intent.intentDigest}:r); r.resultRefs=[`harness-result:${r.targetVersion}`,...(observation?[`harness-observation-intent:${intent.intentDigest}`]:[])];
  if(executionState==='unknown')r.recovery={queryEntrypoint:intent.capabilityId+'.query',identity:{operationId:intent.operationId,intentDigest:intent.intentDigest??null}};
  if(['failed','unknown'].includes(executionState)) {
    const code=typeof result?.code==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(result.code)?result.code:'business_result_not_executable';
    const layer=/worker|process|unavailable|restart|response|^E(?:PERM|ACCES|NOENT|CONN)/.test(code)?'environment':/target|scope|instance|capability|prepare|confirmation/.test(code)?'capability':/source|parse|evidence/.test(code)?'parser':'business_rule';
    r.failure={layer,code,reproductionRefs:[`harness-intent:${intent.intentDigest??intent.operationId}`]};
  }
  validateExecutionReceipt(r);return r;
}
const stateFor = (cap,result,phase) => result?.applied==='unknown'||result?.status==='unknown'?'unknown':phase==='prepare'?(result?.applied===false&&result.status!=='prepared'?'failed':'prepared'):cap.effect==='write'?(result?.applied===true||cap.capabilityId==='agency.posting'&&result?.status==='no_change'&&result?.applied===false?'executed':'failed'):['blocked','needs_local_review','restart_required'].includes(result?.status)?'failed':'executed';

async function recordQueryObservation(s,task,attempt,result,cap) {
  const intent={...attempt,taskId:task.taskId,dependencyDigest:task.dependencyDigest,phase:'query',codeDigest:cap.codeDigest,ruleVersion:cap.ruleVersion,reconcilesIntentDigest:attempt.intentDigest};
  delete intent.intentDigest;delete intent.result;
  const event=await appendHarness(s,'intent',intent);
  const receipt=receiptFor({...intent,intentDigest:event.digest},result,stateFor(cap,result,'execute'));
  await appendHarness(s,'result',{intentDigest:event.digest,receipt});return receipt;
}

/** 业务请求来自版本化事实。外部调用者不能登记伪造执行回执，也不能选择可执行模块或 SQL 语句。 */
export async function runHarnessTask(path,{taskId,phase='execute',dependencyDigest,treatmentId}) {
  requireValue(['prepare','execute','query'].includes(phase),'harness_phase_invalid');
  return withHarness(path,async s=>{
    const caps=harnessCapabilities(),view=await currentHarnessView(s),task=view.tasks.find(t=>t.taskId===taskId);
    requireValue(task,'harness_task_missing');const cap=caps.get(task.capabilityId);
    const requestValue=s.facts.get(requestFactIdForTask(task))?.value;
    const sameRequest=s.attempts.filter(a=>a.effect==='write'&&a.capabilityId===task.capabilityId&&sameBusinessRequest(task.capabilityId,a.request,requestValue));
    if(task.capabilityId==='agency.posting'){
      const identityAttempts=s.attempts.filter(a=>a.effect==='write'&&a.capabilityId===task.capabilityId&&a.operationId===`agency-${requestValue?.batchId}`);
      requireValue(identityAttempts.every(a=>stable(a.request)===stable(requestValue)),'harness_agency_identity_changed');
    }
    // 判断是否可发起新执行前，先恢复原始已提交操作；
    // 该操作自己的账簿影响也可能使上游读取或批准失效。
    // 返回历史不再次写入，也不把历史复核提升为当前有效。
    const completed=sameRequest.filter(a=>a.result?.executionState==='executed').at(-1);
    if(phase==='execute'&&completed){
      if(task.capabilityId==='agency.posting')requireValue(stable(completed.request)===stable(requestValue),'harness_agency_identity_changed');
      let result;
      try{result=await callHarnessAdapter({...completed,phase:'query',scope:s.meta.scope,priorResult:completed.result.actualImpact});}
      catch(e){result={status:'unknown',applied:'unknown',code:e.code??'harness_business_proof_unavailable',retryable:true};}
      const currentBinding=stateFor(cap,result,'execute')==='executed'&&result.evidenceCurrent!==false&&result.evidenceCurrent!==null&&result.confirmationCurrent!==false&&!operationWasRejected(s,completed.operationId)&&!task.blockers.length&&(completed.dependencyDigest===task.dependencyDigest||completed.taskId!==taskId);
      const receipt=currentBinding&&completed.taskId!==taskId?await recordQueryObservation(s,task,completed,result,cap):completed.result;
      const resultCurrent=applicability(task,result,currentBinding);
      return {status:'replayed',receipt,originalTaskId:completed.taskId,currentBinding,operationState:'executed',resultCurrent,confirmationCurrent:task.reviewState==='accepted'?resultCurrent:false,observation:{...result,...(unverifiable(result)?{retryable:true}:{})},...(!currentBinding?{code:'harness_query_historical_only'}:{})};
    }
    if(phase==='query') {
      const attempt=sameRequest.find(a=>!a.result||a.result.executionState==='unknown')??s.attempts.filter(a=>a.taskId===taskId&&a.effect==='write').at(-1)??sameRequest.at(-1);requireValue(attempt,'harness_attempt_missing');
      let result;
      try{result=await callHarnessAdapter({...attempt,phase:'query',scope:s.meta.scope,priorResult:attempt.result?.actualImpact});}
      catch(e){result={status:'unknown',applied:'unknown',code:e.code??'harness_business_proof_unavailable',retryable:true};}
      const state=stateFor(cap,result,'execute'),known=attempt.result?.executionState==='executed',receipt=known&&unverifiable(result)?attempt.result:receiptFor(attempt,result,state);
      // 解决中断的原始意图，不替换已完成的历史回执；
      // 当前观察是一次显式新查询，
      // 绝不是再次执行业务，也不是复制旧确认。
      if(!attempt.result||attempt.result.executionState==='unknown')await appendHarness(s,'reconcile',{intentDigest:attempt.intentDigest,receipt});
      const currentBinding=state==='executed'&&result.evidenceCurrent!==false&&result.evidenceCurrent!==null&&result.confirmationCurrent!==false&&stable(attempt.request)===stable(requestValue)&&(task.capabilityId!=='agency.posting'||attempt.dependencyDigest===task.dependencyDigest)&&!operationWasRejected(s,attempt.operationId)&&!task.blockers.some(b=>!['write_outcome_unknown','existing_write_requires_review_before_new_execution'].includes(b.reason));
      const linked=currentBinding?await recordQueryObservation(s,task,attempt,result,cap):receipt;
      const resultCurrent=applicability(task,result,currentBinding);
      return {status:'queried',receipt:linked,currentBinding,operationState:known?'executed':state,resultCurrent,confirmationCurrent:known&&unverifiable(result)&&task.reviewState==='accepted'?resultCurrent:false,originalReceipt:attempt.result,observation:{...result,...(unverifiable(result)?{retryable:true}:{})},...(!currentBinding?{code:'harness_query_historical_only'}:{}),currentDependencyDigest:task.dependencyDigest};
    }
    if(task.blockers.length)throw Object.assign(new Error('harness_task_blocked'),{code:'harness_task_blocked',details:{taskId,requestFactId:requestFactIdForTask(task),blockers:task.blockers,contract:{tool:'harness_discover',arguments:{capabilityId:task.capabilityId}},hint:'Resolve the indicated facts or dependencies; independent unblocked tasks may continue. Query an unknown original write before any retry.'}});
    requireValue(!dependencyDigest||dependencyDigest===task.dependencyDigest,'harness_dependency_stale');
    const last=s.attempts.filter(a=>a.taskId===taskId&&a.dependencyDigest===task.dependencyDigest).at(-1);
    const fact=s.facts.get(requestFactIdForTask(task));requireValue(fact?.state==='provided'&&fact.value&&typeof fact.value==='object','harness_request_fact_required');
    const request=structuredClone(fact.value);
    validateCapabilityRequest(task.capabilityId,request,phase);
    requireValue(treatmentId===undefined||treatmentId===request.treatmentId,'harness_treatment_binding_mismatch');
    if(last?.result?.executionState==='executed'&&task.executionState==='executed')return {status:'replayed',receipt:last.result};
    const existing=sameRequest.filter(a=>a.result?.executionState==='executed').at(-1);
    if(existing&&existing.taskId!==taskId){
      if(task.capabilityId==='agency.posting')requireValue(stable(existing.request)===stable(request),'harness_agency_identity_changed');
      const result=await callHarnessAdapter({...existing,phase:'query',scope:s.meta.scope,priorResult:existing.result.actualImpact});
      const receipt=await recordQueryObservation(s,task,existing,result,cap);
      return {status:receipt.executionState==='executed'?'replayed':receipt.executionState,receipt,originalTaskId:existing.taskId};
    }
    const boundTreatment=request.treatmentId?s.treatments.find(t=>t.treatmentId===request.treatmentId):null;
    if(request.treatmentId){requireValue(boundTreatment,'harness_treatment_missing');if(task.capabilityId==='voucher.create'){const draft=s.sources.get(boundTreatment.draftSourceId),actual=JSON.parse((await readLocalFile(draft.originals[0].path)).bytes.toString());requireValue(stable(actual)===stable(request.voucher),'harness_treatment_draft_mismatch');}}
    if(task.capabilityId==='voucher.create'&&s.attempts.some(a=>a.taskId===taskId&&a.effect==='write'&&a.result?.executionState==='executed'))requireValue(false,'harness_create_requires_distinct_correction_task');
    if(request.correctionOf)requireValue(request.correctionOf.taskId!==taskId&&s.attempts.some(a=>a.taskId===request.correctionOf.taskId&&a.result?.targetVersion===request.correctionOf.targetVersion&&a.result.executionState==='executed'),'harness_correction_reference_invalid');
    const operationId=task.capabilityId==='agency.posting'?`agency-${request.batchId}`:hash(['harness-operation/2',s.meta.scope,task.capabilityId,request]);
    const preparation=task.capabilityId==='agency.posting'?s.attempts.filter(a=>a.taskId===taskId&&a.phase==='prepare'&&a.dependencyDigest===task.dependencyDigest&&a.result?.executionState==='prepared').at(-1):null;
    if(cap.effect==='write'&&phase==='execute') {
      requireValue(dependencyDigest===task.dependencyDigest,'harness_dependency_confirmation_required');
      if(task.capabilityId==='offline.posting')requireValue(last?.result?.executionState==='prepared','harness_prepare_required');
      if(task.capabilityId==='agency.posting')requireValue(preparation,'harness_prepare_required');
    }
    const intent={taskId,capabilityId:cap.capabilityId,effect:phase==='prepare'?'read':cap.effect,phase,dependencyDigest:task.dependencyDigest,operationId,ruleVersion:cap.ruleVersion,codeDigest:cap.codeDigest,request,prepared:(preparation??last)?.result?.actualImpact??null,...(boundTreatment?{treatmentId:boundTreatment.treatmentId,treatmentVersion:boundTreatment.treatmentVersion}:{})};
    // 直接凭证 API 的 prepare 仅处理元数据；权威业务模块
    // 在实际执行时完成真正校验。
    const event=await appendHarness(s,'intent',intent);intent.intentDigest=event.digest;
    let result;
    try {result=phase==='prepare'&&task.capabilityId.startsWith('voucher.')?{status:'prepared',applied:false,validation:'domain_validation_at_execute'}:await callHarnessAdapter({...intent,scope:s.meta.scope});}
    catch(e){const notStarted=['harness_target_mismatch','harness_code_changed','harness_period_mismatch','harness_posting_preparation_stale'].includes(e?.code),unknown=cap.effect==='write'&&phase==='execute'&&!notStarted;result={status:unknown?'unknown':'blocked',applied:unknown?'unknown':false,code:e?.code??'harness_adapter_failed'};}
    const receipt=receiptFor(intent,result,stateFor(cap,result,phase));await appendHarness(s,'result',{intentDigest:event.digest,receipt});
    return {status:receipt.executionState,receipt};
  });
}

export async function callHarnessTool(name,args) {
  if(name==='harness_discover')return discoverHarness();
  if(name==='harness_scope_discover')return discoverHarnessTarget(args.dbPath);
  const path=args.storePath;requireValue(typeof path==='string'&&path.length>0,'harness_store_path_required');
  const handlers={harness_init:()=>initHarness(path,args.scope),harness_source_register:()=>registerHarnessSource(path,args.source),harness_facts_register:()=>registerHarnessFacts(path,args.facts),harness_plan:()=>planHarness(path,args.tasks),harness_status:()=>inspectHarness(path),harness_run:()=>runHarnessTask(path,args),harness_feedback:()=>feedbackHarness(path,args.feedback),harness_request_materials:()=>requestHarnessMaterials(path,args.request),harness_treatment_register:()=>registerHarnessTreatment(path,args.treatment),harness_recover_lock:()=>recoverHarnessLock(path)};
  requireValue(Object.hasOwn(handlers,name),'harness_tool_unknown');return handlers[name]();
}
