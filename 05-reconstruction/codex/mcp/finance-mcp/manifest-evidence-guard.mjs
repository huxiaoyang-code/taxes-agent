import {requestFactIdForTask} from '../../../../06-workbench/server/harness-contract.mjs';
import {validateCapabilityRequest} from '../../../../06-workbench/server/harness-input-contracts.mjs';
import {dirname,resolve,isAbsolute} from 'node:path';
import {readLocalFile} from '../../../../06-workbench/server/offline-material-store.mjs';
import {locatedBinding,evidencePointer,validateRegisteredFactEvidence} from '../../../../06-workbench/server/harness-fact-evidence.mjs';
import {loadHarness,sameBusinessRequest,stable} from '../../../../06-workbench/server/harness-store.mjs';
const json=async path=>JSON.parse((await readLocalFile(path,5*1024*1024)).bytes.toString('utf8').replace(/^\uFEFF/,''));
const fail=(code,issues)=>{throw Object.assign(new Error(code),{code,details:{evidenceIssues:issues}});};
const shapeIssue=(sourceLocator,inputPointer,expected,nativeCode)=>({code:'harness_agency_input_contract_invalid',layer:'input_contract',state:'invalid',field:inputPointer,inputPointer,valuePath:inputPointer,sourceLocator,expected,handlingPath:'Repair only the native input structure. Keep unavailable facts in separate missing/conflict branches; never invent original values to satisfy this contract.'});
const rejectShape=problems=>{if(problems.length)throw Object.assign(new Error('harness_agency_input_contract_invalid'),{code:'harness_agency_input_contract_invalid',details:{contractIssues:problems,problems}});};
const recordObject=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fieldsFor=r=>r.type==='tax_location'?['classification']:r.type==='tax_payment'?['type','date','amount','obligationId',...['assessmentPeriod','assessmentYear','paymentReference','bankAccountId','receiptIssuer','taxReceiptNumber','taxReceiptVerified','prepaymentReceiptNumber','taxPaymentKind','projectId','localityKey'].filter(k=>r[k]!==undefined)]:[];
function inputContractIssues(record,sourceLocator,recordIndex,enterpriseKey,originalIds){
 const safeLabel=value=>typeof value==='string'&&value.length<=160&&!/[\0\r\n]/.test(value)?value:null;
 const recordPointer=`/records/${recordIndex}`,issues=[],add=(field,expected,state='invalid',nativeCode)=>issues.push({code:state==='invalid'?'harness_agency_input_contract_invalid':'harness_agency_input_missing',layer:'input_contract',state,factId:safeLabel(record?.id),recordType:safeLabel(record?.type),recordIndex,inputPointer:recordPointer+field,valuePath:field,field,sourceLocator,expected,...(nativeCode?{nativeCode}:{}),handlingPath:state==='invalid'?'Repair the declared input structure using the selected capability native input guide. Missing actual facts stay in a separate missing/conflict branch; never invent values or copy an inner date automatically.':'Keep the missing/conflict Harness branch and request the specific original evidence. Do not insert placeholders; independently ready records/tasks may continue. Native read may report this record missing.'});
 if(!record||typeof record!=='object'||Array.isArray(record)){add('','Each records item must be a JSON record object.','invalid','agency_raw_record_invalid');return issues;}
 if(typeof record.id!=='string')add('/id','Top-level record.id must be a string.','invalid','agency_raw_record_invalid');
 if(typeof record.type!=='string')add('/type','Top-level record.type is required; an entity object alone is not a complete entity record.');
 if(record.enterpriseKey!==enterpriseKey)add('/enterpriseKey','Top-level record.enterpriseKey must match manifest.scope.enterpriseKey.','invalid','agency_raw_record_invalid');
 if(Object.hasOwn(record,'sourceRefs'))add('/sourceRefs','Do not supply sourceRefs on raw records. Use originalRefs; the native loader generates sourceRefs.','invalid','agency_raw_record_invalid');
 if(typeof record.date!=='string')add('/date','Every raw record, including type=entity, needs a top-level original-supported actual date YYYY-MM-DD. entity.businessStartDate does not supply this field. Missing date stays a missing branch; never fill month-start/month-end or copy an inner date without source support.','invalid','agency_raw_record_invalid');
 else {const value=record.date,format=/^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value),valid=format&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;if(!valid)add('/date','Original-supported complete actual calendar date YYYY-MM-DD. A valid format does not prove source support; never fill the first/last day as a placeholder.');}
 if(!Array.isArray(record.originalRefs)||!record.originalRefs.length)add('/originalRefs','Nonempty [{originalId,locator,extractionReason}] referencing manifest.originals.','invalid','agency_original_record_reference_required');
 else record.originalRefs.forEach((ref,index)=>{if(!ref||typeof ref!=='object'||Array.isArray(ref)){add(`/originalRefs/${index}`,'Original reference must be an object {originalId,locator,extractionReason}.','invalid','agency_original_record_reference_required');return;}if(!originalIds.has(ref.originalId))add(`/originalRefs/${index}/originalId`,'Reference a manifest.originals descriptor ID; do not invent an original ID.','invalid','agency_original_record_reference_required');for(const key of ['locator','extractionReason'])if(typeof ref[key]!=='string'||!ref[key].length)add(`/originalRefs/${index}/${key}`,'Original reference locator/extractionReason must be a nonempty string.','invalid','agency_original_record_reference_required');});
 if(Array.isArray(record.originalRefs))record.originalRefs.forEach((ref,index)=>{if(recordObject(ref)&&Object.hasOwn(ref,'bindings')){if(!Array.isArray(ref.bindings))add(`/originalRefs/${index}/bindings`,'Optional MCP value bindings must be an array of binding objects, not an object or string.');else ref.bindings.forEach((binding,bindingIndex)=>{if(!recordObject(binding))add(`/originalRefs/${index}/bindings/${bindingIndex}`,'Each MCP value binding must be an object containing valuePath and locator.');});}});
 if(record.type==='entity'&&(!record.entity||typeof record.entity!=='object'||Array.isArray(record.entity)))add('/entity','The complete entity record must contain its entity object as well as the top-level record fields.');
 if(record.type==='entity'&&record.entity&&typeof record.entity==='object')for(const [key,values]of [['vatStatus',['small','general']],['vatPeriod',['monthly','quarterly']]])if(Object.hasOwn(record.entity,key)&&!values.includes(record.entity[key]))add('/entity/'+key,values.join(' | '));
 if(Object.hasOwn(record,'businessIdentity')){const identity=record.businessIdentity;if(!identity||typeof identity!=='object'||Array.isArray(identity))add('/businessIdentity','Object {issuerKey,documentNumber,event}, each original-supported nonempty string.');else for(const key of ['issuerKey','documentNumber','event']){if(!Object.hasOwn(identity,key))add('/businessIdentity/'+key,'Original-supported nonempty string.','missing');else if(typeof identity[key]!=='string'||!identity[key].trim())add('/businessIdentity/'+key,'Original-supported nonempty string.');}}
 else if(['expense','service_complete'].includes(record.type))add('/businessIdentity','Original issuerKey/documentNumber/event for a record that generates accounting entries.','missing');
 if(record.type==='service_complete'){if(record.accepted!==true)add('/accepted','Original acceptance evidence, true only when supported.','missing');if(record.collectionRight!==true)add('/collectionRight','Original collection-right evidence, true only when supported.','missing');if(!Array.isArray(record.work)||!record.work.length)add('/work','Nonempty [{units,unitPrice,priceIncludesVat}] from supported original work quantities; unresolved conflicting quantities remain a separate Harness branch.','missing');else for(const [i,work]of record.work.entries())for(const key of ['units','unitPrice','priceIncludesVat'])if(!work||!Object.hasOwn(work,key))add(`/work/${i}/${key}`,'Original-supported quantity/price and explicit tax inclusion.','missing');}
 return issues;
}
export async function inspectManifestEvidence(request) {
 const issues=[];
 for(const manifestPath of request?.manifestPaths??(request?.manifestPath?[request.manifestPath]:[])){
  const manifest=await json(manifestPath),manifestProblems=[];
  if(!recordObject(manifest))rejectShape([shapeIssue(manifestPath,'','Expected agency-business-materials/1 manifest object.','agency_manifest_invalid')]);
  if(manifest.version!=='agency-business-materials/1')manifestProblems.push(shapeIssue(manifestPath,'/version','Use the declared agency-business-materials/1 native manifest version.','agency_manifest_invalid'));
  if(!recordObject(manifest.scope))manifestProblems.push(shapeIssue(manifestPath,'/scope','Manifest scope object is required; use discovered enterprise/account-set/instance and actual period/currency.','agency_scope_invalid'));
  for(const key of ['sources','originals'])if(!Array.isArray(manifest[key])||!manifest[key].length||manifest[key].length>1000)manifestProblems.push(shapeIssue(manifestPath,'/'+key,'A nonempty array of at most 1000 native descriptors is required.','agency_manifest_invalid'));
  if(Object.keys(manifest).some(key=>!['version','scope','sources','originals'].includes(key)))manifestProblems.push(shapeIssue(manifestPath,'','Manifest fields are only version/scope/sources/originals.','agency_manifest_fields_invalid'));
  rejectShape(manifestProblems);
  const originalIds=new Set();manifest.originals.forEach((d,i)=>{if(!recordObject(d)||typeof d.id!=='string'||!d.id.length||originalIds.has(d.id)||typeof d.path!=='string'||Object.keys(d).some(k=>!['id','path','sha256'].includes(k)))manifestProblems.push(shapeIssue(manifestPath,`/originals/${i}`,'Original descriptor is {id:unique nonempty string,path:string,sha256?:actual digest}.','agency_original_descriptor_invalid'));else originalIds.add(d.id);});
  manifest.sources.forEach((d,i)=>{if(!recordObject(d)||typeof d.path!=='string'||Object.keys(d).some(k=>!['path','sha256'].includes(k)))manifestProblems.push(shapeIssue(manifestPath,`/sources/${i}/path`,'Source descriptor is {path:string,sha256?:actual digest}; supply the raw-facts file path.','agency_source_descriptor_invalid'));});
  rejectShape(manifestProblems);
  const originals=new Map((manifest.originals??[]).map(d=>[d.id,isAbsolute(d.path)?d.path:resolve(dirname(manifestPath),d.path)]));
  for(const source of manifest.sources??[]){const sourcePath=isAbsolute(source.path)?source.path:resolve(dirname(manifestPath),source.path),raw=await json(sourcePath);
   const rawProblems=[];
   if(!recordObject(raw))rejectShape([shapeIssue(sourcePath,'','Expected agency-raw-facts/1 object containing scope and records.','agency_source_scope_mismatch')]);
   if(raw.version!=='agency-raw-facts/1')rawProblems.push(shapeIssue(sourcePath,'/version','Use the declared agency-raw-facts/1 source version.','agency_source_scope_mismatch'));
   if(!recordObject(raw.scope))rawProblems.push(shapeIssue(sourcePath,'/scope','Raw source scope object is required.','agency_source_scope_mismatch'));
   if(!Array.isArray(raw.records))rawProblems.push(shapeIssue(sourcePath,'/records','Raw records must be an array of complete record objects, including a complete outer entity record.','agency_source_scope_mismatch'));
   if(Object.keys(raw).some(key=>!['version','scope','records'].includes(key)))rawProblems.push(shapeIssue(sourcePath,'','Raw source fields are only version/scope/records.','agency_source_fields_invalid'));
   rejectShape(rawProblems);
   for(const [index,r] of (raw.records??[]).entries()){
    const recordIssues=inputContractIssues(r,`${sourcePath}#/records/${index}`,index,manifest.scope?.enterpriseKey,originals);issues.push(...recordIssues);
    if(!recordObject(r)||recordIssues.some(i=>i.state==='invalid'))continue;
    if(r.type==='tax_payment'&&![r.paymentReference,r.taxReceiptNumber,r.prepaymentReceiptNumber].some(v=>typeof v==='string'&&v.trim()))issues.push({code:'harness_payment_identity_missing',state:'unverified',factId:r.id,sourceLocator:`${sourcePath}#/records/${index}`,reason:'A tax amount and period alone do not identify actual payment evidence.'});
    for(const key of fieldsFor(r)){
    let supported=false,reason='critical_value_original_support_missing';
    for(const ref of r.originalRefs??[]){if(!originals.has(ref.originalId))continue;const file=await readLocalFile(originals.get(ref.originalId),5*1024*1024);
     const bindings=(ref.bindings??[]).filter(b=>b.valuePath===`/${key}`);
     // Compatible structured originals: a precise pointer selects an original
     // object containing this field. A free-form locator or sourceId is not proof.
     if(!bindings.length&&typeof ref.locator==='string'&&ref.locator.startsWith('/'))bindings.push({valuePath:`/${key}`,locator:{jsonPointer:ref.locator.replace(/\/$/,'')+'/'+key},...(key==='amount'?{format:'decimal'}:{})});
     for(const b of bindings)try{await locatedBinding(file.bytes,b,evidencePointer(r,b.valuePath));supported=true;}catch(e){reason=e.code??'critical_value_original_support_invalid';}
    }
    if(!supported)issues.push({code:'harness_critical_fact_unverified',state:'unverified',factId:r.id,recordType:r.type,valuePath:`/${key}`,sourceLocator:`${sourcePath}#/records/${index}/${key}`,manifestPath,reason,handlingPath:'Locate the exact original field and bind its value; retain missing/unknown or conflict instead of guessing. No payment record may be inferred from a tax calculation.'});
   }}
  }
 }
 return issues;
}
export async function guardHarnessBoundary(name,args){
 if(name==='harness_request_materials'){
  const request=args.request,problems=[];
  if(typeof request?.text!=='string'||!request.text.trim())problems.push({code:'harness_request_invalid',field:'request.text',hint:'Provide nonblank forwardable text in request.text. questions/reason are not substitutes. Shape: request:{taskIds:[existing task IDs],text:"specific supplement request"}; this saves locally and sends nothing.'});
  if(!Array.isArray(request?.taskIds))problems.push({code:'harness_request_invalid',field:'request.taskIds',hint:'Provide an array of taskId strings from the current plan/status, or [] for an unassigned request.'});
  else request.taskIds.forEach((id,index)=>{if(typeof id!=='string')problems.push({code:'harness_request_invalid',field:`request.taskIds[${index}]`,hint:'Each item must be an existing taskId string, not an object or a question.'});});
  if(!problems.length&&request.taskIds.length){const current=await loadHarness(args.storePath);request.taskIds.forEach((id,index)=>{if(!current.tasks.some(t=>t.taskId===id))problems.push({code:'harness_request_invalid',field:`request.taskIds[${index}]`,hint:'This task reference is not in the current plan. Read harness_status and use an existing taskId; a request does not create a task.'});});}
  if(problems.length)throw Object.assign(new Error('harness_request_invalid'),{code:'harness_request_invalid',details:{problems}});
  return [];
 }
 if(name==='harness_source_register'){
  const source=args.source,problems=[];
  for(const key of ['sourceId','path','locator','classification'])if(typeof source?.[key]!=='string')problems.push({code:'harness_source_invalid',field:'source.'+key,hint:key==='path'?'Use source.path as one absolute original file path. originals/code/validation are returned inventories, not inputs. Parser/validation inputs are codePaths/validationPaths.':'Provide the required source field using the public harness_source_register input schema.'});
  if(!Array.isArray(source?.unrecognized))problems.push({code:'harness_source_invalid',field:'source.unrecognized',hint:'Provide the array of preserved unrecognized items; use [] when none.'});
  if(!problems.length&&!isAbsolute(source.path))problems.push({code:'harness_evidence_invalid',field:'source.path',hint:'source.path must be one absolute file path; do not use a relative path or the returned originals array.'});
  if(problems.length)throw Object.assign(new Error(problems[0].code),{code:problems[0].code,details:{problems}});
  return [];
 }
 if(name==='harness_facts_register'&&args.factEvidencePolicy==='require'&&args.facts.some(f=>f.state==='provided'&&!f.evidence))fail('harness_fact_evidence_required',[]);
 if(!['harness_run','harness_plan'].includes(name))return [];
 const s=await loadHarness(args.storePath);
 if(name==='harness_plan'){
  for(const task of args.tasks)for(const id of task.factIds){const f=s.facts.get(id);for(const input of f?.evidence?.inputs??[])if(!task.factIds.includes(input.factId))fail('harness_derived_plan_input_missing',[{taskId:task.taskId,factId:id,inputFactId:input.factId}]);}return [];
 }
 const task=s.tasks.find(t=>t.taskId===args.taskId);if(!task)return [];
 // Recovery must reach the original native query even if CURRENT materials are
 // missing, changed or unreadable. An identical completed execute is a query-only
 // replay in #121; its safety decision remains in the native runtime.
 if(args.phase==='query'||(args.phase??'execute')==='execute'&&s.attempts.some(a=>a.effect==='write'&&a.capabilityId===task.capabilityId&&a.result?.executionState==='executed'&&sameBusinessRequest(task.capabilityId,a.request,s.facts.get(requestFactIdForTask(task))?.value)))return [];
 if(task.capabilityId==='agency.posting'&&s.attempts.some(a=>a.effect==='write'&&a.capabilityId===task.capabilityId&&a.operationId===`agency-${s.facts.get(requestFactIdForTask(task))?.value?.batchId}`&&stable(a.request)!==stable(s.facts.get(requestFactIdForTask(task))?.value)))return []; // Native identity-conflict refusal has precedence over new-request evidence checks.
 const requestFact=s.facts.get(requestFactIdForTask(task));
 // Missing/conflicting/unknown facts are business blockers, not malformed requests.
 // not_applicable still reaches the runtime request-fact requirement. No manifest is read.
 if(requestFact?.state!=='provided')return [];
 validateCapabilityRequest(task.capabilityId,requestFact.value,args.phase??'execute');
 if(args.phase!=='query')for(const id of task.factIds){const f=s.facts.get(id);if(f?.evidence)await validateRegisteredFactEvidence(f,s.sources,s.facts);}
 if(!task.capabilityId.startsWith('agency.'))return [];
 const issues=await inspectManifestEvidence(s.facts.get(requestFactIdForTask(task))?.value);
 const invalid=issues.filter(i=>i.layer==='input_contract'&&i.state==='invalid');
 if(invalid.length)throw Object.assign(new Error('harness_agency_input_contract_invalid'),{code:'harness_agency_input_contract_invalid',details:{contractIssues:invalid,problems:invalid}});
 if(issues.some(i=>i.layer!=='input_contract')&&task.capabilityId==='agency.posting'&&args.phase!=='query')fail('harness_critical_fact_unverified',issues.filter(i=>i.layer!=='input_contract'));
 return issues;
}
