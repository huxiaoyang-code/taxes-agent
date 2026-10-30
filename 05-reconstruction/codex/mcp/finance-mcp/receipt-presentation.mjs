import {createHash} from 'node:crypto';
import {mkdir,writeFile,lstat,realpath,readFile} from 'node:fs/promises';
import {join,resolve,isAbsolute,parse,relative} from 'node:path';

export const SUMMARY_MAX_BYTES=24576, DETAIL_MAX_BYTES=12288;
const digest=s=>createHash('sha256').update(s).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const check=(v,c)=>{if(!v)fail(c);};
async function safePath(path,directory=false) {
 check(typeof path==='string'&&isAbsolute(path),'harness_receipt_path_invalid');
 const absolute=resolve(path);let p=parse(absolute).root;
 for(const part of relative(p,absolute).split(/[\\/]/).filter(Boolean)){p=join(p,part);const s=await lstat(p);check(!s.isSymbolicLink()&&(p===absolute?directory?s.isDirectory():s.isFile()&&s.nlink===1:s.isDirectory()),'harness_receipt_path_invalid');}
 check((await realpath(absolute)).toLowerCase()===absolute.toLowerCase(),'harness_receipt_path_invalid');return absolute;
}
const presentRef=(ref,pointer='')=>({...ref,pointer,tool:'harness_receipt_read'});
const smallIdentity=value=>Object.fromEntries(['taskId','operationId','targetVersion','dependencyDigest','capabilityId','ruleVersion','codeDigest','executionState','reviewState','ruleState','resultRefs','recovery','failure','operationState','resultCurrent','confirmationCurrent','currentBinding','currentDependencyDigest','code','status','applied','partialEffects','partialEffectsMeaning','proofDigest','evidenceCurrent','retryable'].filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
const moneyFields=['due','paid','difference','accountingAccrual','accountingAccruedCumulative','payableBalance','taxableBaseDerived','currentPayable','overpaymentForReview','amount','debit','credit','revenue','yearRevenue','expenses','yearExpenses','profitBeforeTax','yearProfitBeforeTax','netProfit','totalDebit','totalCredit'];
const obligationFields=['due','accountingAccrual','paid','difference'];
function taxNumber(value,pointer,context){
 const amounts=Object.fromEntries(moneyFields.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));
 if(!Object.keys(amounts).length&&!['vat','corporate_income'].includes(value.obligationId))return null;
 return {...context,pointer,recordKind:'native_obligation_result',unit:'yuan',...Object.fromEntries(['obligationId','status','paymentState','cumulative','filingDue'].filter(k=>value[k]!==undefined).map(k=>[k,value[k]])),...amounts,amountState:Object.fromEntries(obligationFields.map(k=>[k,{present:Object.hasOwn(value,k),...(Object.hasOwn(value,k)?{value:value[k]}:{})}]))};
}
function keyNumbers(value,pointer='',out=[],context={}) {
 if(!value||typeof value!=='object')return out;
 if(Array.isArray(value)){
  if(pointer==='/tasks')value.forEach((t,i)=>{if(t.receipt)keyNumbers(t.receipt,`${pointer}/${i}/receipt`,out,{...context,taskId:t.taskId,capabilityId:t.capabilityId,targetVersion:t.receipt.targetVersion,resultCurrent:t.resultCurrent,confirmationCurrent:t.confirmationCurrent});});
  else if(/\/obligations$/.test(pointer)){let omittedWithoutAmounts=0;value.forEach((v,i)=>{const row=taxNumber(v,`${pointer}/${i}`,context);if(row)out.push(row);else omittedWithoutAmounts++;});if(omittedWithoutAmounts)out.push({...context,pointer,recordKind:'obligation_coverage',omittedWithoutAmounts,reason:'Other obligations without reported amounts remain in complete native states; missing VAT/CIT are retained above.'});}
  else if(/\/accounting\/vatTransactions$/.test(pointer))value.forEach((v,i)=>{if(Object.hasOwn(v,'tax'))out.push({...context,pointer:`${pointer}/${i}`,recordKind:'transaction_tax',unit:'yuan',factId:v.factId,date:v.date,tax:v.tax,limitation:'Transaction tax only; not statutory due, accounting accrual, actual payment or unpaid tax.'});});
  else if(/\/(?:totals|summary)$/.test(pointer))value.forEach((v,i)=>keyNumbers(v,`${pointer}/${i}`,out,context));
  else if(/\/accounting\/vouchers$/.test(pointer))value.forEach((v,i)=>{if(v.factId?.startsWith('tax:'))(v.entries??[]).forEach((e,n)=>out.push({...context,pointer:`${pointer}/${i}/entries/${n}`,recordKind:'native_accounting_draft_entry',unit:'yuan',factId:v.factId,sourceVoucherId:v.sourceVoucherId,code:e.code,debit:e.debit,credit:e.credit,limitation:'Draft entry only; not statutory due, explicit accountingAccrual, actual posting or payment.'}));});
  return out;
 }
 if(value.scope)context={...context,...Object.fromEntries(['period','currency'].filter(k=>value.scope[k]!==undefined).map(k=>[k,value.scope[k]]))};
 if(/\/accounting$/.test(pointer))context={...context,unit:'yuan'};
 if(/\/accounting\/reports\/[^/]+$/.test(pointer))context={...context,unit:'minor'};
 const amounts=Object.fromEntries(moneyFields.filter(k=>Object.hasOwn(value,k)&&['number','string'].includes(typeof value[k])).map(k=>[k,value[k]]));
 if(Object.keys(amounts).length)out.push({...context,pointer,...Object.fromEntries(['obligationId','status','paymentState','cumulative','filingDue','period','currency'].filter(k=>value[k]!==undefined).map(k=>[k,value[k]])),...amounts});
 for(const [k,v] of Object.entries(value))if(v&&typeof v==='object'&&!['historicalReceipt','originalReceipt','history','historicalVouchers','entries','records','sources','dependencies','traceReferences','sourceRefs'].includes(k))keyNumbers(v,`${pointer}/${k.replaceAll('~','~0').replaceAll('/','~1')}`,out,context);
 return out;
}
function issueGroups(value) {
 const rows=[],visit=(v,p='')=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach((x,i)=>visit(x,`${p}/${i}`));return;}if(v.failure?.code==='agency_evidence_directory_overlap')rows.push({pointer:`${p}/failure`,taskId:v.taskId??null,code:v.failure.code,field:'evidenceDir'});for(const [k,x]of Object.entries(v)){if(['issues','blockers','errors','limitations','contractIssues','evidenceIssues'].includes(k)&&Array.isArray(x))x.forEach((i,n)=>rows.push({pointer:`${p}/${k}/${n}`,taskId:v.taskId??null,...(typeof i==='object'?i:{reason:i})}));else if(!['history','historicalReceipt','originalReceipt','sourceRefs','traceReferences'].includes(k))visit(x,`${p}/${k}`);}};visit(value);
 const groups=new Map();for(const row of rows){const key=JSON.stringify([row.code??null,row.reason??null,row.state??null,row.retryable??false]);const g=groups.get(key)??{...row,count:0};g.count++;groups.set(key,g);}return {total:rows.length,countUnit:'problem_occurrences',groupsBy:['code','reason','state','retryable'],groups:[...groups.values()]};
}
function taskSummary(t,index,ref){const requestFactId=typeof t.requestFactId==='string'?t.requestFactId:Array.isArray(t.factIds)&&typeof t.factIds[0]==='string'?t.factIds[0]:undefined;return {...smallIdentity(t),goal:t.goal,dependsOn:t.dependsOn,factIds:t.factIds,...(requestFactId===undefined?{}:{requestFactId}),blockers:t.blockers,historicalReceipt:t.historicalReceipt?{...smallIdentity(t.historicalReceipt),...(t.historicalReceipt.actualImpact&&Object.hasOwn(t.historicalReceipt.actualImpact,'partialEffects')?{actualImpact:{applied:t.historicalReceipt.actualImpact.applied,partialEffects:t.historicalReceipt.actualImpact.partialEffects,details:presentRef(ref,`/tasks/${index}/historicalReceipt/actualImpact`)}}:{}),details:presentRef(ref,`/tasks/${index}/historicalReceipt`)}:null,receipt:t.receipt?{...smallIdentity(t.receipt),...(t.receipt.actualImpact&&Object.hasOwn(t.receipt.actualImpact,'partialEffects')?{actualImpact:{applied:t.receipt.actualImpact.applied,partialEffects:t.receipt.actualImpact.partialEffects,details:presentRef(ref,`/tasks/${index}/receipt/actualImpact`)}}:{}),details:presentRef(ref,`/tasks/${index}/receipt`)}:null,...(t.unresolvedIntent?{unresolvedIntent:t.unresolvedIntent}:{}),details:presentRef(ref,`/tasks/${index}`)};}
export async function saveHarnessReceipt(storePath,name,native) {
 const root=await safePath(storePath,true),meta=JSON.parse(await readFile(await safePath(join(root,'store.json')),'utf8'));check(meta.version==='finance-harness-store/1'&&typeof meta.storeId==='string','harness_receipt_store_invalid');
 const directory=join(root,'mcp-receipts');await mkdir(directory,{recursive:true,mode:0o700});await safePath(directory,true);
 const bytes=Buffer.from(JSON.stringify({version:'finance-native-receipt/1',storeId:meta.storeId,scope:meta.scope,tool:name,result:native})),id=digest(bytes),path=join(directory,id+'.json');
 try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;check((await readFile(await safePath(path))).equals(bytes),'harness_receipt_changed');}
 return {receiptRef:id,sha256:id,bytes:bytes.length,storePath:root,scope:meta.scope};
}
export async function summarizeHarnessReceipt(storePath,name,native) {
 const saved=await saveHarnessReceipt(storePath,name,native),ref={...saved},issues=issueGroups(native),numbers=keyNumbers(native);
 for(const row of numbers)if(row.recordKind==='obligation_coverage')row.details=presentRef(ref,row.pointer);
 const result={...smallIdentity(native),scope:native.scope??saved.scope,version:native.version??'finance-harness-summary/1',presentation:{mode:'summary',completeNativeSaved:true,details:presentRef(ref),summaryMaxBytes:SUMMARY_MAX_BYTES,explicitFullCompatibility:'responseMode:full returns the original object',omittedSections:[]},...Object.fromEntries(['journalHead','taskIds','affectedTasks','invalidatedResults','nextSteps','changedFactIds','sourceId','sourceVersion','factBindings','decision','periodComplete','submittable','requestId','text','sent','outcome','legacyEvidence','evidenceIssues'].filter(k=>native[k]!==undefined).map(k=>[k,native[k]])),keyNumbers:numbers,issues,...(native.tasks?{tasks:native.tasks.map((t,i)=>taskSummary(t,i,ref))}:{}),...(native.receipt?{receipt:{...smallIdentity(native.receipt),actualImpact:{...smallIdentity(native.receipt.actualImpact),details:presentRef(ref,'/receipt/actualImpact')},details:presentRef(ref,'/receipt')}}:{}),...(native.originalReceipt?{originalReceipt:{...smallIdentity(native.originalReceipt),details:presentRef(ref,'/originalReceipt')}}:{}),...(native.observation?{observation:{...smallIdentity(native.observation),details:presentRef(ref,'/observation')}}:{})};
 if(native.sources)result.sources=native.sources.map(({sourceId,sourceVersion,classification,parsed,current,unrecognized})=>({sourceId,sourceVersion,classification,parsed,current,unrecognized}));
 if(native.receipt?.actualImpact?.proposal)result.nextSteps=[...(result.nextSteps??[]),{action:'read_prepared_proposal_before_human_confirmation',details:presentRef(ref,'/receipt/actualImpact/proposal'),requiredNativeFields:['identity','targetVersion','dependencyDigest','planDigest','plannedVouchers'],humanFeedback:'Use the native values and actual human decision/reviewer; Agent must not author acceptance.'}];
 if(issues.groups.some(g=>g.code==='agency_evidence_directory_overlap'))result.nextSteps=[...(result.nextSteps??[]),{action:'resolve_evidence_directory_overlap',code:'agency_evidence_directory_overlap',field:'evidenceDir',contract:{tool:'harness_discover',arguments:{capabilityId:'agency.posting'}},required:'Existing absolute archive directory, neither equal to, ancestor of, nor descendant of database/manifest/original/derived-source directories. Separate sibling directories are suitable; a work/evidence child is not.',handlingPath:'Inspect the original prepare receipt. Only if blocked, applied:false and no proposal exists, correct the request evidenceDir and prepare again with the same batch identity. An existing proposal or unknown write still requires original-identity query; do not replace the batch or bypass confirmation.',details:presentRef(ref)}];
 if(native.facts)result.facts=native.facts.map(({factId,state,reason,sourceRefs,evidence})=>({factId,state,reason,sourceRefs,evidenceKind:evidence?.kind??'legacy_unverified'}));
 if(native.details)result.details={...native.details,...(Array.isArray(native.details.problems)?{problems:native.details.problems.slice(0,64)}:{}),completeDetails:presentRef(ref,'/details')};
 if(Array.isArray(native.details?.problems)){delete result.details.errorInventory;result.errorInventory={total:native.details.problems.length,shown:Math.min(64,native.details.problems.length),omitted:Math.max(0,native.details.problems.length-64),details:presentRef(ref,'/details/problems'),nextStep:'Read complete saved problems by pointer or repair shown fields and validate again; no input errors were discarded.'};}
 if(native.contractIssues)result.contractIssues=native.contractIssues;
 if(numbers.some(row=>['native_obligation_result','transaction_tax','native_accounting_draft_entry'].includes(row.recordKind)))result.taxAmountSemantics={due:'Only native obligation.due; missing is undetermined, not zero.',accountingAccrual:'Only an explicit native accountingAccrual field; a voucher or transaction tax is not this field.',paid:'Preserve native paid verbatim, including zero/null, as a program result. Only when absent, never invent zero. Missing evidence proves neither real-world payment nor nonpayment; report evidence unverified/tool not registered.',difference:'Only the native difference; never invent unpaid tax from a voucher.',coverage:'Numeric/null obligation results and missing VAT/CIT are selected; obligation_coverage gives other omitted-without-amount counts and their native details pointer.'};
 if(native.receipt){for(const key of ['operationState','resultCurrent','confirmationCurrent'])if(!Object.hasOwn(result,key))result[key]=key==='operationState'?native.receipt.executionState:null;result.stateObservation='Native receipt records this operation; null current fields were not established by this call. Inspect current task status.';}
 if(!result.nextSteps?.length)result.nextSteps=[{action:'inspect_current_task_state_before_continuing_or_reviewing',tool:'harness_status',storePath,...(native.receipt?.taskId?{taskId:native.receipt.taskId}:{})}];
 result.problemCountMeaning='Problem occurrences across native issues/blockers/contract/evidence sections; repeated representations may count more than once. This is not a count of distinct blocked business tasks.';
 result.blockers={count:issues.total,countUnit:'problem_occurrences',groups:issues.groups,details:presentRef(ref)};
 if(Buffer.byteLength(JSON.stringify(issues))>4096){result.issues={total:issues.total,distinctGroups:issues.groups.length,allErrorsListed:false,details:presentRef(ref),reason:'error_inventory_requires_paging'};result.blockers={count:issues.total,allErrorsListed:false,details:presentRef(ref)};result.presentation.omittedSections.push('issues.groups','blockers.groups');}
 // 不截断字符串或静默丢弃失败。超大段落改为明确的清单，
 // 提供精确计数及按内容寻址的读取引用。
 for(const k of ['sources','facts','factBindings','nextSteps','tasks','issues','blockers','taskIds','affectedTasks','invalidatedResults','text','legacyEvidence','evidenceIssues','contractIssues','details','keyNumbers']){
  if(Buffer.byteLength(JSON.stringify(result))<=SUMMARY_MAX_BYTES)break;
  if(result[k]!==undefined){const original=result[k];result.presentation.omittedSections.push(k);
   if(k==='keyNumbers'&&Array.isArray(original)){const critical=original.filter(row=>row.recordKind==='transaction_tax'||row.recordKind==='native_obligation_result'&&['vat','corporate_income'].includes(row.obligationId)).sort((a,b)=>Number(a.recordKind==='transaction_tax')-Number(b.recordKind==='transaction_tax')),ordered=[...critical,...original.filter(row=>!critical.includes(row))],selected=[];for(const row of ordered)if(Buffer.byteLength(JSON.stringify([...selected,row]))<=8192)selected.push(row);result.keyNumbers=selected;result.keyNumbersCoverage={totalProjectedRows:original.length,shown:selected.length,omitted:original.length-selected.length,reason:'bounded_key_numbers_with_VAT_CIT_before_transaction_tax',details:presentRef(ref)};continue;}
   result[k]={count:Array.isArray(original)?original.length:typeof original==='string'?original.length:original.total??original.count??Object.keys(original).length,details:presentRef(ref,['issues','blockers','nextSteps'].includes(k)?'':`/${k}`),reason:'section_exceeds_summary_budget',...(k==='issues'&&original.groups?{groups:original.groups.map(g=>({code:g.code??null,state:g.state??null,retryable:g.retryable??false,count:g.count,pointer:g.pointer}))}:{})};}
 }
 if(Buffer.byteLength(JSON.stringify(result))>SUMMARY_MAX_BYTES&&result.issues?.groups){result.presentation.omittedSections.push('issues.groups');result.issues={count:issues.total,distinctGroups:issues.groups.length,details:presentRef(ref),reason:'error_inventory_requires_paging',allErrorsListed:false};}
 if(result.errorInventory){const shown=Array.isArray(result.details?.problems)?result.details.problems.length:0;result.errorInventory.shown=shown;result.errorInventory.omitted=result.errorInventory.total-shown;}
 check(Buffer.byteLength(JSON.stringify(result))<=SUMMARY_MAX_BYTES,'harness_summary_budget_exceeded');return result;
}
function pointerValue(root,pointer){check(typeof pointer==='string'&&(pointer===''||pointer.startsWith('/'))&&pointer.length<=2048,'harness_receipt_pointer_invalid');let v=root;for(const token of pointer===''?[]:pointer.slice(1).split('/')){const key=token.replaceAll('~1','/').replaceAll('~0','~');check(v!==null&&typeof v==='object'&&Object.hasOwn(v,key)&&!['__proto__','prototype','constructor'].includes(key),'harness_receipt_pointer_invalid');v=v[key];}return v;}
const valueType=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
function childNavigation(value,pointer,childOffset){
 const keys=value&&typeof value==='object'?Object.keys(value):[];check(childOffset<=keys.length,'harness_receipt_child_offset_invalid');
 const navigation={valueType:valueType(value),childCount:keys.length,childOffset,children:[],nextChildOffset:null,maximumChildren:16};let index=childOffset;
 for(;index<keys.length&&navigation.children.length<16;index++){
  const key=keys[index],child={key,type:valueType(value[key]),pointer:pointer+'/'+key.replaceAll('~','~0').replaceAll('/','~1')};
  if(Buffer.byteLength(JSON.stringify({...navigation,children:[...navigation.children,child],nextChildOffset:index+1}))>1024){if(!navigation.children.length){navigation.oversizedChild={index,descriptorBytes:Buffer.byteLength(JSON.stringify(child)),reason:'descriptor_exceeds_navigation_budget'};index++;}break;}
  navigation.children.push(child);
 }
 navigation.nextChildOffset=index<keys.length?index:null;return navigation;
}
export async function readHarnessReceipt({storePath,receiptRef,pointer='',offset=0,maxBytes=8192,childOffset=0}) {
 check(/^[a-f0-9]{64}$/.test(receiptRef??'')&&Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(childOffset)&&childOffset>=0&&Number.isSafeInteger(maxBytes)&&maxBytes>=256&&maxBytes<=DETAIL_MAX_BYTES,'harness_receipt_read_invalid');
 const root=await safePath(storePath,true),meta=JSON.parse(await readFile(await safePath(join(root,'store.json')),'utf8'));check(meta.version==='finance-harness-store/1'&&typeof meta.storeId==='string','harness_receipt_store_invalid');
 const bytes=await readFile(await safePath(join(root,'mcp-receipts',receiptRef+'.json')));check(digest(bytes)===receiptRef,'harness_receipt_changed');
 const saved=JSON.parse(bytes);check(saved.version==='finance-native-receipt/1'&&saved.storeId===meta.storeId,'harness_receipt_store_mismatch');const value=pointerValue(saved.result,pointer),serialized=JSON.stringify(value);
 // 明确采用稳定的 UTF-16 偏移；按码点前进，避免拆开代理对
 // 或 UTF-8 序列。读取后先重组 JSON 片段。
 check(offset<=serialized.length&&(offset===0||!(serialized.charCodeAt(offset)>=0xDC00&&serialized.charCodeAt(offset)<=0xDFFF)),'harness_receipt_offset_invalid');
 let fragment='',used=0,end=offset;for(const point of serialized.slice(offset)){const wireSize=Buffer.byteLength(JSON.stringify(point))-2;if(used+wireSize>maxBytes)break;fragment+=point;used+=wireSize;end+=point.length;}
 return {version:'finance-receipt-page/1',receiptRef,sha256:receiptRef,nativeBytes:bytes.length,pointer,valueSha256:digest(serialized),valueBytes:Buffer.byteLength(serialized),navigation:childNavigation(value,pointer,childOffset),encoding:'json-string-fragment; concatenate fragments then JSON.parse',offsetUnit:'UTF-16 code units, code-point boundaries',offset,fragment,fragmentBytes:Buffer.byteLength(fragment),fragmentJsonBytes:used,maxFragmentJsonBytes:maxBytes,nextOffset:end<serialized.length?end:null,complete:end===serialized.length};
}
