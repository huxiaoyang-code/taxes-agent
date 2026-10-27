import { captureHarnessCode } from './harness-code.mjs';
// Native Harness task bridge used by existing persisted batch stages. No new queue.
import { readFileSync } from 'node:fs';
import { inspectHarness,runHarnessTask } from './harness-runtime.mjs';
const check=(v,code)=>{if(!v)throw Object.assign(new Error(code),{code});};
const allowed=new Set(['agency.workpaper','agency.posting','agency.annual-calculation','annual.inspect','period.inspect','period.impact','period.carryforward','period.close','period.reopen','period.unpost-derived']);
let requestContext;
try{
 const r=JSON.parse(readFileSync(0,'utf8')),spec=r.spec;requestContext=r;
 check(captureHarnessCode(['./local-batch-harness-worker.mjs']).digest===r.bridgeCodeDigest,'harness_code_changed');
 let view=await inspectHarness(spec.storePath);
 check(['enterpriseKey','accountSetId','databaseInstanceId','currency'].every(k=>view.scope[k]===r.scope[k])&&(view.scope.period===r.period||view.scope.period===r.period.slice(0,4)&&r.period.endsWith('-12')),'batch_harness_scope_mismatch');
 let task=view.tasks.find(t=>t.taskId===spec.taskId);check(task&&allowed.has(task.capabilityId)&&task.capabilityId===spec.capabilityId,'batch_harness_capability_invalid');
 const writeCapability=['agency.posting','period.carryforward','period.close','period.reopen','period.unpost-derived'].includes(task.capabilityId);
 let observation=null;
 // Query the original write before deciding if any execution remains. A known
 // historical success never permits another financial write.
 if(writeCapability&&(task.operationState==='executed'||task.operationState==='unknown')){
  try{observation=await runHarnessTask(spec.storePath,{taskId:task.taskId,phase:'query'});}catch(e){if(e.code!=='harness_attempt_missing')throw e;}
  view=await inspectHarness(spec.storePath);task=view.tasks.find(t=>t.taskId===spec.taskId);
 }
 if(r.phase==='execute'&&(!writeCapability||task.operationState!=='executed'&&task.operationState!=='unknown')&&task.executionState!=='executed'){
  check(task.dependencyDigest===spec.dependencyDigest,'batch_harness_version_changed');
  observation=await runHarnessTask(spec.storePath,{taskId:task.taskId,dependencyDigest:spec.dependencyDigest});
  view=await inspectHarness(spec.storePath);task=view.tasks.find(t=>t.taskId===spec.taskId);
  if(writeCapability&&task.operationState==='executed')try{observation=await runHarnessTask(spec.storePath,{taskId:task.taskId,phase:'query'});view=await inspectHarness(spec.storePath);task=view.tasks.find(t=>t.taskId===spec.taskId);}catch(e){if(e.code!=='harness_attempt_missing')throw e;}
 }
 const native=observation?.observation,original=observation?.originalReceipt??observation?.receipt;
 const operationCompleted=writeCapability&&task.operationState==='executed'&&original?.dependencyDigest===spec.dependencyDigest&&original?.capabilityId===spec.capabilityId&&native?.applied===true&&native?.evidenceCurrent!==false&&native?.evidenceCurrent!==null&&native?.confirmationCurrent!==false&&native?.businessProofCurrent!==false;
 const current=task.dependencyDigest===spec.dependencyDigest&&task.executionState==='executed'&&task.resultCurrent===true&&!task.blockers.length;
 const receipt=task.receipt??task.historicalReceipt;
 process.stdout.write(JSON.stringify({status:current||operationCompleted?'succeeded':'needs_review',code:current||operationCompleted?null:task.operationState==='unknown'?'batch_harness_outcome_unknown':'batch_harness_result_not_current',taskIdentity:{...spec,period:r.period},completionBasis:current?'current_result':operationCompleted?'original_committed_operation':'unresolved',operationState:task.operationState,resultCurrent:task.resultCurrent,confirmationCurrent:task.confirmationCurrent,targetVersion:receipt?.targetVersion??null,operationId:receipt?.operationId??null,historicalReceipt:task.historicalReceipt,blockers:task.blockers,nextSteps:current||operationCompleted?[]:[{action:task.dependencyDigest===spec.dependencyDigest?'retry_only_unfinished_stage_after_resolving_blocker':'create_new_job_for_only_unfinished_or_affected_tasks',reason:task.dependencyDigest===spec.dependencyDigest?'Original manifest version retained':'Immutable original job cannot adopt new task facts/graph versions',storePath:spec.storePath,taskId:spec.taskId,currentDependencyDigest:task.dependencyDigest,preserveOriginalOperation:true}],observation,periodComplete:false,submittable:false}));
 }catch(e){
 // Re-read retained task state after an error. A failed call or unavailable Store
 // alone cannot establish zero writes; only an actual matching task observation can.
 let retained={};
 if(requestContext?.spec)try{
  const r=requestContext,view=await inspectHarness(r.spec.storePath),task=view.tasks.find(t=>t.taskId===r.spec.taskId);
  if(task&&(task.dependencyDigest===r.spec.dependencyDigest||[task.receipt,task.historicalReceipt].some(receipt=>receipt?.dependencyDigest===r.spec.dependencyDigest))&&task.capabilityId===r.spec.capabilityId&&['enterpriseKey','accountSetId','databaseInstanceId','currency'].every(k=>view.scope[k]===r.scope[k])&&(view.scope.period===r.period||view.scope.period===r.period.slice(0,4)&&r.period.endsWith('-12')))retained={operationState:task.operationState,resultCurrent:task.resultCurrent,confirmationCurrent:task.confirmationCurrent,historicalReceipt:task.historicalReceipt,operationId:task.historicalReceipt?.operationId??task.receipt?.operationId??null};
 }catch{}
 process.stdout.write(JSON.stringify({status:'needs_review',...retained,code:e.code??'batch_harness_bridge_failed',...(requestContext?.spec?{taskIdentity:{...requestContext.spec,period:requestContext.period}}:{}),nextSteps:[{action:e.code==='batch_harness_version_changed'?'create_new_job_for_only_unfinished_or_affected_tasks':'inspect_original_task_and_resolve_blocker',reason:e.code==='batch_harness_version_changed'?'Immutable original manifest cannot adopt changed task bindings':'No new financial execution is implied by this diagnostic',preserveOriginalOperation:true}],periodComplete:false,submittable:false}));}
