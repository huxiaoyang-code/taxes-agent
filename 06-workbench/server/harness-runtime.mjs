import { harnessCapabilities, callHarnessAdapter } from './harness-adapters.mjs';
import { withHarness, appendHarness, harnessView, hash, stable, requireValue, initHarness, registerHarnessSource, registerHarnessFacts, saveHarnessPlan, recordHarnessFeedback, requestHarnessMaterials, registerHarnessTreatment, recoverHarnessLock } from './harness-store.mjs';
import { validateExecutionReceipt } from './harness-contract.mjs';
import { discoverHarnessTarget } from './harness-target.mjs';
import { readLocalFile, checkedPath } from './offline-material-store.mjs';
export { initHarness, registerHarnessSource, registerHarnessFacts, requestHarnessMaterials, registerHarnessTreatment, recoverHarnessLock };
export const discoverHarness = () => ({version:'finance-harness/1',capabilities:[...harnessCapabilities().values()],parsing:{formats:'host_investigates_without_extension_whitelist',execution:'host_tools_and_optional_subagents',requiredEvidence:['original_location','parser_code','validation','unrecognized_content']},onlineTaxConnected:false});
export const planHarness = (path,tasks) => saveHarnessPlan(path,tasks,harnessCapabilities());
export const feedbackHarness = (path,feedback) => recordHarnessFeedback(path,feedback,harnessCapabilities(),currentHarnessView);
async function refreshBusinessProofs(s) {
  for(const t of s.tasks) {
    const a=s.attempts.filter(a=>a.taskId===t.taskId&&a.result?.executionState==='executed').at(-1);
    if(!a||s.invalidatedResults.has(a.result.targetVersion))continue;
    try {
      const current=await callHarnessAdapter({...a,phase:a.effect==='write'?'query':'execute',scope:s.meta.scope,priorResult:a.result.actualImpact});
      const prior=a.result.actualImpact;
      const valid=a.effect==='read'?stable(current)===stable(prior):current.applied===true&&(a.capabilityId.startsWith('voucher.')?stable(current.current)===stable(prior.current):a.capabilityId==='offline.posting'?current.dependencyDigest===prior.dependencyDigest&&current.policyDigest===prior.policyDigest&&current.status==='recovered':current.proofDigest===prior.proofDigest);
      if(!valid)await appendHarness(s,'invalidate_result',{taskId:a.taskId,targetVersion:a.result.targetVersion,reason:'actual_business_proof_changed_or_unavailable'});
    }catch{await appendHarness(s,'invalidate_result',{taskId:a.taskId,targetVersion:a.result.targetVersion,reason:'actual_business_proof_unavailable'});}
  }
}
async function inspectCurrent(path, ancestors = []) {
  const canonical = await checkedPath(path,true);
  requireValue(!ancestors.includes(canonical),'harness_external_dependency_cycle');
  return withHarness(canonical,s=>currentHarnessView(s,[...ancestors,canonical]));
}
async function currentHarnessView(s, ancestors = [s.info.root]) {
  await refreshBusinessProofs(s);
  const externalByTask = new Map();
  for (const task of s.tasks) {
    if (!task.externalDependencies?.length) continue;
    const observations = [];
    for (const ref of task.externalDependencies) {
      const observation = {...ref,current:false,reason:'harness_external_dependency_unavailable'};
      try {
        // Reinspect the live Store and business proof; an exported receipt file
        // alone cannot establish that a previous period is still current.
        const view = await inspectCurrent(ref.storePath,ancestors);
        requireValue(['enterpriseKey','accountSetId','databaseInstanceId','currency'].every(k=>view.scope[k]===s.meta.scope[k])&&view.scope.period===ref.period,'harness_external_scope_mismatch');
        const child = view.tasks.find(t=>t.taskId===ref.taskId);
        requireValue(child,'harness_external_task_missing');
        Object.assign(observation,{observedDependencyDigest:child.dependencyDigest,observedTargetVersion:child.receipt?.targetVersion??null,executionState:child.executionState,reviewState:child.reviewState});
        observation.reason = child.blockers.some(b=>b.reason==='harness_external_dependency_cycle') ? 'harness_external_dependency_cycle'
          : child.executionState==='unknown' ? 'harness_external_dependency_unknown'
          : child.reviewState==='rejected' ? 'harness_external_dependency_rejected'
          : child.receipt?.targetVersion!==ref.targetVersion||child.dependencyDigest!==ref.dependencyDigest ? 'harness_external_version_changed'
          : child.executionState!=='executed'||child.blockers.length ? 'harness_external_dependency_blocked' : null;
        observation.current = observation.reason===null;
      } catch (e) { observation.reason = e.code ?? 'harness_external_dependency_unavailable'; }
      observations.push(observation);
    }
    externalByTask.set(task.taskId,observations);
    if (observations.some(ref=>!ref.current)) {
      const old=s.attempts.filter(a=>a.taskId===task.taskId&&a.result?.executionState==='executed').at(-1);
      if(old&&!s.invalidatedResults.has(old.result.targetVersion))await appendHarness(s,'invalidate_result',{taskId:task.taskId,targetVersion:old.result.targetVersion,reason:'external_dependency_no_longer_current'});
    }
  }
  return harnessView(s,harnessCapabilities(),externalByTask);
}
export const inspectHarness = path => inspectCurrent(path);

function receiptFor(intent,result,executionState) {
  const r={taskId:intent.taskId,operationId:intent.operationId,dependencyDigest:intent.dependencyDigest,capabilityId:intent.capabilityId,ruleVersion:intent.ruleVersion,codeDigest:intent.codeDigest,executionState,reviewState:executionState==='stale'?'stale':'pending',ruleState:'uncovered',resultRefs:[],actualImpact:result};
  r.targetVersion=hash(r); r.resultRefs=[`harness-result:${r.targetVersion}`];
  if(executionState==='unknown')r.recovery={queryEntrypoint:intent.capabilityId+'.query',identity:{operationId:intent.operationId,intentDigest:intent.intentDigest??null}};
  if(['failed','unknown'].includes(executionState)) {
    const code=typeof result?.code==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(result.code)?result.code:'business_result_not_executable';
    const layer=/worker|process|unavailable|restart|response|^E(?:PERM|ACCES|NOENT|CONN)/.test(code)?'environment':/target|scope|instance|capability|prepare|confirmation/.test(code)?'capability':/source|parse|evidence/.test(code)?'parser':'business_rule';
    r.failure={layer,code,reproductionRefs:[`harness-intent:${intent.intentDigest??intent.operationId}`]};
  }
  validateExecutionReceipt(r);return r;
}
const stateFor = (cap,result,phase) => result?.applied==='unknown'||result?.status==='unknown'?'unknown':phase==='prepare'?(result?.applied===false&&result.status!=='prepared'?'failed':'prepared'):cap.effect==='write'?(result?.applied===true?'executed':'failed'):['blocked','needs_local_review','restart_required'].includes(result?.status)?'failed':'executed';

async function recordQueryAlias(s,task,attempt,result,cap) {
  const intent={...attempt,taskId:task.taskId,dependencyDigest:task.dependencyDigest,phase:'query'};
  delete intent.intentDigest;delete intent.result;
  const event=await appendHarness(s,'intent',intent);
  const receipt=receiptFor({...intent,intentDigest:event.digest},result,stateFor(cap,result,'execute'));
  await appendHarness(s,'result',{intentDigest:event.digest,receipt});return receipt;
}

/** A business request comes from versioned facts. No external caller can register
 * a fabricated execution receipt or select an executable module/SQL statement.
 */
export async function runHarnessTask(path,{taskId,phase='execute',dependencyDigest,treatmentId}) {
  requireValue(['prepare','execute','query'].includes(phase),'harness_phase_invalid');
  return withHarness(path,async s=>{
    const caps=harnessCapabilities(),view=await currentHarnessView(s),task=view.tasks.find(t=>t.taskId===taskId);
    requireValue(task,'harness_task_missing');const cap=caps.get(task.capabilityId);
    const requestValue=s.facts.get(task.factIds[0])?.value;
    const sameRequest=s.attempts.filter(a=>a.effect==='write'&&a.capabilityId===task.capabilityId&&stable(a.request)===stable(requestValue));
    if(phase==='query') {
      const attempt=sameRequest.find(a=>!a.result||a.result.executionState==='unknown')??s.attempts.filter(a=>a.taskId===taskId&&a.effect==='write').at(-1)??sameRequest.at(-1);requireValue(attempt,'harness_attempt_missing');
      const result=await callHarnessAdapter({...attempt,phase:'query',scope:s.meta.scope,priorResult:attempt.result?.actualImpact}),state=stateFor(cap,result,'execute'),receipt=receiptFor(attempt,result,state);
      // Recovery keeps the original dependency/version identity, even when fresh
      // facts or policies now make the historical execution stale.
      await appendHarness(s,'reconcile',{intentDigest:attempt.intentDigest,receipt});
      const linked=attempt.taskId===taskId?receipt:await recordQueryAlias(s,task,attempt,result,cap);
      return {status:'queried',receipt:linked,currentDependencyDigest:task.dependencyDigest};
    }
    requireValue(!task.blockers.length,'harness_task_blocked');
    requireValue(!dependencyDigest||dependencyDigest===task.dependencyDigest,'harness_dependency_stale');
    const last=s.attempts.filter(a=>a.taskId===taskId&&a.dependencyDigest===task.dependencyDigest).at(-1);
    const fact=s.facts.get(task.factIds[0]);requireValue(fact?.state==='provided'&&fact.value&&typeof fact.value==='object','harness_request_fact_required');
    const request=structuredClone(fact.value);
    requireValue(treatmentId===undefined||treatmentId===request.treatmentId,'harness_treatment_binding_mismatch');
    if(last?.result?.executionState==='executed')return {status:'replayed',receipt:last.result};
    const existing=sameRequest.filter(a=>a.result?.executionState==='executed').at(-1);
    if(existing&&existing.taskId!==taskId){
      const result=await callHarnessAdapter({...existing,phase:'query',scope:s.meta.scope,priorResult:existing.result.actualImpact});
      const receipt=await recordQueryAlias(s,task,existing,result,cap);
      return {status:receipt.executionState==='executed'?'replayed':receipt.executionState,receipt,originalTaskId:existing.taskId};
    }
    const boundTreatment=request.treatmentId?s.treatments.find(t=>t.treatmentId===request.treatmentId):null;
    if(request.treatmentId){requireValue(boundTreatment,'harness_treatment_missing');if(task.capabilityId==='voucher.create'){const draft=s.sources.get(boundTreatment.draftSourceId),actual=JSON.parse((await readLocalFile(draft.originals[0].path)).bytes.toString());requireValue(stable(actual)===stable(request.voucher),'harness_treatment_draft_mismatch');}}
    if(task.capabilityId==='voucher.create'&&s.attempts.some(a=>a.taskId===taskId&&a.effect==='write'&&a.result?.executionState==='executed'))requireValue(false,'harness_create_requires_distinct_correction_task');
    if(request.correctionOf)requireValue(request.correctionOf.taskId!==taskId&&s.attempts.some(a=>a.taskId===request.correctionOf.taskId&&a.result?.targetVersion===request.correctionOf.targetVersion&&a.result.executionState==='executed'),'harness_correction_reference_invalid');
    const operationId=hash(['harness-operation/2',s.meta.scope,task.capabilityId,request]);
    if(cap.effect==='write'&&phase==='execute') {
      requireValue(dependencyDigest===task.dependencyDigest,'harness_dependency_confirmation_required');
      if(task.capabilityId==='offline.posting')requireValue(last?.result?.executionState==='prepared','harness_prepare_required');
    }
    const intent={taskId,capabilityId:cap.capabilityId,effect:phase==='prepare'?'read':cap.effect,phase,dependencyDigest:task.dependencyDigest,operationId,ruleVersion:cap.ruleVersion,codeDigest:cap.codeDigest,request,prepared:last?.result?.actualImpact??null,...(boundTreatment?{treatmentId:boundTreatment.treatmentId,treatmentVersion:boundTreatment.treatmentVersion}:{})};
    // Prepare for direct voucher APIs is metadata only; their actual validation
    // runs in the authoritative module during execution.
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
