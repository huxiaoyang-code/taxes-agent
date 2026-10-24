// Registration point for fixed implemented business functions. A declaration
// never loads a model-provided path, supplies a tax algorithm, or grants support.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scopeContainsMonth, validateCapabilityDeclaration, CAPABILITY_CONTRACT_VERSION } from './harness-contract.mjs';
import { captureHarnessCode } from './harness-code.mjs';
import { runOfflinePosting } from './offline-posting.mjs';
import { runOfflinePeriodPlan } from './offline-period-plan.mjs';
import { runOfflineVatQ2 } from './offline-vat-q2.mjs';
import { openOfflineActionInput } from './offline-action-input.mjs';
import { buildOfflineActionPlanFromFiles } from './offline-action-plan.mjs';
import { requireValue, hash } from './harness-store.mjs';
import * as materials from './offline-material-store.mjs';
import * as reviews from './accountant-review-store.mjs';
import { BOOKKEEPING_RULE_VERSION } from './offline-voucher-rules.mjs';
import { VAT_Q2_RULE_VERSION } from './tax-rule-registry.mjs';

const specs = [
  ['offline.action_plan','read','./offline-action-plan.mjs','buildOfflineActionPlanFromFiles',BOOKKEEPING_RULE_VERSION,'Existing supported candidate preparation, not whole-period completion'],
  ['offline.posting','write','./offline-posting.mjs','runOfflinePosting',BOOKKEEPING_RULE_VERSION,'Only the actual business keys/profile/conditions accepted by posting; query before retry'],
  ['offline.period_plan','read','./offline-period-plan.mjs','runOfflinePeriodPlan','offline-period-plan/1','Read-only executable eligibility and existing period controls'],
  ['offline.vat_q2','read','./offline-vat-q2.mjs','runOfflineVatQ2',VAT_Q2_RULE_VERSION,'Existing supported prior-quarter/target-quarter selected VAT fields only'],
  ['voucher.create','write','./harness-domain-worker.mjs','createVoucher','enterprise-treatment/1','Agent-authored evidence-backed draft; existing accounting module validates entries and actual effects'],
  ['voucher.post','write','./harness-domain-worker.mjs','postVoucher','enterprise-treatment/1','Existing draft voucher and actual accounting constraints'],
  ['voucher.unpost','write','./harness-domain-worker.mjs','unpostVoucher','enterprise-treatment/1','Explicit accountant correction, retains historical voucher; existing period/derived dependencies may block'],
  ...['init','receive','inspect','recover'].map(a=>['materials.'+a,a==='inspect'?'read':'write','./offline-material-store.mjs',({init:'initMaterialStore',receive:'receiveMaterials',inspect:'inspectMaterialStore',recover:'recoverMaterialStoreLock'})[a],'offline-material-store/1','Existing normalized material receipt journal; arbitrary originals are investigated by host before mapping']),
  ...['init','register','feedback','inspect'].map(a=>['review.'+a,a==='inspect'?'read':'write','./accountant-review-store.mjs',({init:'initReviewStore',register:'registerReview',feedback:'recordReviewFeedback',inspect:'inspectReviewStore'})[a],'offline-accountant-review-store/1','Existing selected tax field review store; its actual freshness and feedback rules remain authoritative']),
  ...['start','status','resume'].map(a=>['batch.'+a,a==='status'?'read':'write','./harness-batch-worker.mjs',({start:'createAndRun',status:'readJobStatus',resume:'resumeJob'})[a],'local-batch/3','Existing batch runner and audited stage recovery, explicit target and job scope; existing installation/backup rules apply']),
];
const rootsFor=s=>s[0].startsWith('voucher.')?['./harness-domain-worker.mjs']:[s[2]];
export function harnessCapabilities() {
  const captured=new Map();return new Map(specs.map(s=>{
    const key=rootsFor(s).join('|');if(!captured.has(key))captured.set(key,captureHarnessCode(rootsFor(s)));
    const input=s[0].startsWith('voucher.')?(s[0]==='voucher.create'?'target + voucher {period,voucher_date?,summary?,status:draft|posted,entries:[{code,debit,credit,summary?}]}':'target + voucherId positive integer; correctionOf {taskId,targetVersion} for rejection-linked correction'):s[0]==='offline.action_plan'?'inputPath absolute existing offline-action-input/1 JSON; source manifests and facts are prepared by host':s[0]==='offline.posting'?'version:offline-posting-input/1, inputPath, target, selected:{taskId,businessKey}; confirmNewSourceBinding optional boolean; do not supply confirmation/command':s[0]==='offline.period_plan'?'version:offline-period-plan-input/1, inputPath, target, month:YYYY-MM':s[0]==='offline.vat_q2'?'version:offline-vat-q2-request/1, priorInputPath, targetInputPath, target':s[0].startsWith('materials.')?'path absolute material Store; receive needs configPath absolute sources mapping; init uses Harness scope':s[0].startsWith('review.')?'path absolute review Store; register needs inputPath and options:{expectedJournalHead,supersedes}; feedback needs native feedback payload':'target,jobKey; start additionally manifestPath and outputDir absolute paths';
    const code=captured.get(key), declaration={version:CAPABILITY_CONTRACT_VERSION,capabilityId:s[0],description:s[5]+'; internal input guide: skills_read harness/references/adapters.md',availability:'limited',necessaryFacts:[{factId:'business_request',description:'First task fact value: '+input},...(input.includes('target')?[{factId:'target_binding',description:'target={dbPath:absolute existing workbench.db,databaseInstanceId,enterpriseKey,accountSetId}; identity must match Harness scope and actual database'}]:[])],supportConditions:[s[5],'Business module revalidates actual inputs; unknown/missing/conflicting evidence is never inferred from a callable declaration'],entrypoint:s[3],ruleVersion:s[4],codeDigest:code.digest,effect:s[1],resultSchema:{type:'object',description:'Actual domain return; Harness receipt contains executionState/reviewState/ruleState, version-bound actualImpact and actual business proof where provided',properties:{status:{type:'string'},applied:{description:'true/false/unknown for writes; unknown forbids blind retry'},code:{type:['string','null']}}},traceReferences:code.files.filter(f=>f.path===s[2].replace(/^\.\//,'')).map(f=>({kind:'code',locator:f.path,digest:f.digest})),...(s[1]==='write'?{recovery:{queryEntrypoint:s[0]+'.query',identityFields:['operationId','accountSetId','enterpriseKey','databaseInstanceId']}}:{})};
    return [s[0],validateCapabilityDeclaration(declaration)];
  }));
}
function validateTarget(scope,target) {requireValue(target&&target.accountSetId===scope.accountSetId&&target.enterpriseKey===scope.enterpriseKey&&target.databaseInstanceId===scope.databaseInstanceId,'harness_target_mismatch');}
export async function callHarnessAdapter({capabilityId,phase,scope,request,operationId,prepared,codeDigest,priorResult}) {
  const caps=harnessCapabilities(),cap=caps.get(capabilityId); requireValue(cap,'harness_capability_unknown');
  if(phase!=='query')requireValue(cap.codeDigest===codeDigest,'harness_code_changed');
  const businessScope={enterpriseKey:scope.enterpriseKey,accountSetId:String(scope.accountSetId),period:scope.period,currency:scope.currency,unit:'yuan'};
  const sameScope=result=>requireValue(result.scope?.enterpriseKey===scope.enterpriseKey&&String(result.scope?.accountSetId)===String(scope.accountSetId)&&result.scope?.period===scope.period&&result.scope?.currency===scope.currency,'harness_target_mismatch');
  if(capabilityId.startsWith('materials.')||capabilityId.startsWith('review.')) {
    const material=capabilityId.startsWith('materials.'),action=capabilityId.split('.')[1],inspect=material?materials.inspectMaterialStore:reviews.inspectReviewStore;
    if(action!=='init'){const current=await inspect(request.path);sameScope(current);}
    if(phase==='query'||action==='inspect'){
      const result=await inspect(request.path);sameScope(result);const current=!result.writerBlocked&&!['stale','blocked','blocked_origin_changed'].includes(result.status);
      let attribution=action==='inspect'?'observed_native_state':'matching_native_request_receipts',proven=action==='inspect';
      if(action==='init'){proven=true;attribution='observed_scoped_store_state_not_unique_operation';}
      else if(material&&action==='receive'){
        const ids=priorResult?.domain?.receiptIds;proven=Array.isArray(ids)&&ids.length>0&&ids.every(id=>result.receipts.some(receipt=>receipt.receiptId===id));
      } else if(!material&&action==='feedback')proven=result.feedbacks.some(f=>hash(f.payload)===hash(request.feedback));
      else if(!material&&action==='register'){
        const original=priorResult?.domain?.current;proven=!!original&&original.versionId===result.current?.versionId&&hash(original.binding)===hash(result.current.binding);
      }
      if(!proven)return {status:'needs_local_review',applied:'unknown',code:'harness_native_request_not_proven',attribution:'existing_store_is_not_proof_of_this_request',queryEntrypoint:material?'inspectMaterialStore':'inspectReviewStore',handlingPath:'Inspect the native Store receipts and original request/version locally; retain unknown and do not execute again until reconciled',domain:result};
      const proofDigest=action==='init'?hash((await materials.readLocalFile(join(request.path,'store.json'))).bytes):hash(result);
      return {status:current?'recovered':'blocked',applied:current,domain:result,proofDigest,attribution};
    }
    let result;
    if(material)result=action==='init'?await materials.initMaterialStore(request.path,businessScope):action==='receive'?await materials.receiveMaterials(request.path,request.configPath):await materials.recoverMaterialStoreLock(request.path);
    else result=action==='init'?await reviews.initReviewStore(request.path,businessScope):action==='register'?await reviews.registerReview(request.path,request.inputPath,request.options):await reviews.recordReviewFeedback(request.path,request.feedback);
    const current=await inspect(request.path);sameScope(current);return {status:'executed',applied:true,domain:result,proofDigest:action==='init'?hash((await materials.readLocalFile(join(request.path,'store.json'))).bytes):hash(current),attribution:'actual_function_return'};
  }
  if(capabilityId.startsWith('batch.')) {
    validateTarget(scope,request.target);const env={...process.env,NODE_NO_WARNINGS:'1'};for(const k of Object.keys(env))if(['NODE_OPTIONS','NODE_PATH','WORKBENCH_DATA_DIR'].includes(k.toUpperCase()))delete env[k];
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('./harness-batch-worker.mjs',import.meta.url))],{input:JSON.stringify({action:capabilityId,phase,scope,request,codeDigest:cap.codeDigest}),encoding:'utf8',env,windowsHide:true,timeout:120000,maxBuffer:16*1024*1024});
    if(child.error||child.signal||child.status!==0||child.stderr)return {status:'unknown',applied:'unknown',code:'harness_batch_worker_unavailable'};
    try{return JSON.parse(child.stdout);}catch{return {status:'unknown',applied:'unknown',code:'harness_batch_response_invalid'};}
  }
  if(capabilityId.startsWith('voucher.')) {
    validateTarget(scope,request.target);
    const env={...process.env,NODE_NO_WARNINGS:'1'};for(const k of Object.keys(env))if(['NODE_OPTIONS','NODE_PATH','WORKBENCH_DATA_DIR'].includes(k.toUpperCase()))delete env[k];
    const r=spawnSync(process.execPath,[fileURLToPath(new URL('./harness-domain-worker.mjs',import.meta.url))],{input:JSON.stringify({action:capabilityId,phase,scope,target:request.target,request,operationId,codeDigest:cap.codeDigest}),env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8*1024*1024});
    if(r.error||r.signal||r.status!==0||r.stderr)return {status:'unknown',applied:'unknown',code:'harness_worker_unavailable'};
    try{return JSON.parse(r.stdout);}catch{return {status:'unknown',applied:'unknown',code:'harness_worker_response_invalid'};}
  }
  if(capabilityId==='offline.posting') {
    validateTarget(scope,request.target);
    const {confirmNewSourceBinding,treatmentId,correctionOf,...businessRequest}=request;
    const candidate=runOfflinePosting({...businessRequest,command:phase==='query'?'query':'prepare'});
    if(candidate.candidate?.date)requireValue(scopeContainsMonth(scope,candidate.candidate.date.slice(0,7)),'harness_period_mismatch');
    else if(phase==='execute')return {...candidate,applied:candidate.applied??false};
    if(phase!=='execute')return candidate;
    requireValue(candidate.operationId===prepared?.operationId&&candidate.dependencyDigest===prepared?.dependencyDigest&&candidate.policyDigest===prepared?.policyDigest,'harness_posting_preparation_stale');
    const result=runOfflinePosting({...businessRequest,command:'execute',confirmation:{operationId:prepared.operationId,dependencyDigest:prepared.dependencyDigest,policyDigest:prepared.policyDigest,confirmNewSourceBinding:confirmNewSourceBinding===true}});
    return result;
  }
  requireValue(phase==='execute','harness_read_phase_invalid');
  if(capabilityId==='offline.action_plan') {const s=await openOfflineActionInput(request.inputPath);try{const result=await buildOfflineActionPlanFromFiles(s);requireValue(result.scope.enterpriseKey===scope.enterpriseKey&&String(result.scope.accountSetId)===String(scope.accountSetId)&&result.scope.period===scope.period&&result.scope.currency===scope.currency,'harness_target_mismatch');return result;}finally{s.close();}}
  if(capabilityId==='offline.period_plan') {validateTarget(scope,request.target);requireValue(scopeContainsMonth(scope,request.month),'harness_period_mismatch');return runOfflinePeriodPlan(request);}
  if(capabilityId==='offline.vat_q2') {validateTarget(scope,request.target);const doc=JSON.parse(readFileSync(request.targetInputPath,'utf8'));requireValue(doc.scope?.period===scope.period&&doc.scope?.enterpriseKey===scope.enterpriseKey&&String(doc.scope?.accountSetId)===String(scope.accountSetId)&&doc.scope?.currency===scope.currency,'harness_target_mismatch');return runOfflineVatQ2(request);}
  requireValue(false,'harness_capability_unknown');
}
