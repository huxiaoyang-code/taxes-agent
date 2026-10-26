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
const smallIdentity=value=>Object.fromEntries(['taskId','operationId','targetVersion','dependencyDigest','capabilityId','ruleVersion','codeDigest','executionState','reviewState','ruleState','resultRefs','recovery','failure','operationState','resultCurrent','confirmationCurrent','currentBinding','currentDependencyDigest','code','status','applied','proofDigest','evidenceCurrent','retryable'].filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
const moneyFields=['due','paid','difference','accountingAccrual','accountingAccruedCumulative','payableBalance','taxableBaseDerived','currentPayable','overpaymentForReview','amount','debit','credit','revenue','yearRevenue','expenses','yearExpenses','profitBeforeTax','yearProfitBeforeTax','netProfit','totalDebit','totalCredit'];
function keyNumbers(value,pointer='',out=[],context={}) {
 if(!value||typeof value!=='object')return out;
 if(Array.isArray(value)){if(pointer==='/tasks')value.forEach((t,i)=>{if(t.receipt)keyNumbers(t.receipt,`${pointer}/${i}/receipt`,out,{taskId:t.taskId,capabilityId:t.capabilityId,targetVersion:t.receipt.targetVersion,resultCurrent:t.resultCurrent,confirmationCurrent:t.confirmationCurrent});});else if(/\/(?:obligations|totals|summary)$/.test(pointer))value.forEach((v,i)=>keyNumbers(v,`${pointer}/${i}`,out,context));else if(/\/accounting\/vouchers$/.test(pointer))value.forEach((v,i)=>{if(v.factId?.startsWith('tax:'))(v.entries??[]).forEach((e,n)=>out.push({...context,pointer:`${pointer}/${i}/entries/${n}`,recordKind:'native_accounting_draft_entry',factId:v.factId,sourceVoucherId:v.sourceVoucherId,code:e.code,debit:e.debit,credit:e.credit,limitation:'Calculation draft entry; not proof of actual posting or payment.'}));});return out;}
 const amounts=Object.fromEntries(moneyFields.filter(k=>Object.hasOwn(value,k)&&['number','string'].includes(typeof value[k])).map(k=>[k,value[k]]));
 if(Object.keys(amounts).length)out.push({...context,pointer,...Object.fromEntries(['obligationId','status','paymentState','cumulative','filingDue','period','currency'].filter(k=>value[k]!==undefined).map(k=>[k,value[k]])),...amounts});
 for(const [k,v] of Object.entries(value))if(v&&typeof v==='object'&&!['historicalReceipt','originalReceipt','history','historicalVouchers','entries','records','sources','dependencies','traceReferences','sourceRefs'].includes(k))keyNumbers(v,`${pointer}/${k.replaceAll('~','~0').replaceAll('/','~1')}`,out,context);
 return out;
}
function issueGroups(value) {
 const rows=[],visit=(v,p='')=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach((x,i)=>visit(x,`${p}/${i}`));return;}for(const [k,x]of Object.entries(v)){if(['issues','blockers','errors','limitations','contractIssues','evidenceIssues'].includes(k)&&Array.isArray(x))x.forEach((i,n)=>rows.push({pointer:`${p}/${k}/${n}`,taskId:v.taskId??null,...(typeof i==='object'?i:{reason:i})}));else if(!['history','historicalReceipt','originalReceipt','sourceRefs','traceReferences'].includes(k))visit(x,`${p}/${k}`);}};visit(value);
 const groups=new Map();for(const row of rows){const key=JSON.stringify([row.code??null,row.reason??null,row.state??null,row.retryable??false]);const g=groups.get(key)??{...row,count:0};g.count++;groups.set(key,g);}return {total:rows.length,countUnit:'problem_occurrences',groupsBy:['code','reason','state','retryable'],groups:[...groups.values()]};
}
function taskSummary(t,index,ref){return {...smallIdentity(t),goal:t.goal,dependsOn:t.dependsOn,factIds:t.factIds,blockers:t.blockers,historicalReceipt:t.historicalReceipt?{...smallIdentity(t.historicalReceipt),details:presentRef(ref,`/tasks/${index}/historicalReceipt`)}:null,receipt:t.receipt?{...smallIdentity(t.receipt),details:presentRef(ref,`/tasks/${index}/receipt`)}:null,...(t.unresolvedIntent?{unresolvedIntent:t.unresolvedIntent}:{}),details:presentRef(ref,`/tasks/${index}`)};}
export async function saveHarnessReceipt(storePath,name,native) {
 const root=await safePath(storePath,true),meta=JSON.parse(await readFile(await safePath(join(root,'store.json')),'utf8'));check(meta.version==='finance-harness-store/1'&&typeof meta.storeId==='string','harness_receipt_store_invalid');
 const directory=join(root,'mcp-receipts');await mkdir(directory,{recursive:true,mode:0o700});await safePath(directory,true);
 const bytes=Buffer.from(JSON.stringify({version:'finance-native-receipt/1',storeId:meta.storeId,scope:meta.scope,tool:name,result:native})),id=digest(bytes),path=join(directory,id+'.json');
 try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;check((await readFile(await safePath(path))).equals(bytes),'harness_receipt_changed');}
 return {receiptRef:id,sha256:id,bytes:bytes.length,storePath:root,scope:meta.scope};
}
export async function summarizeHarnessReceipt(storePath,name,native) {
 const saved=await saveHarnessReceipt(storePath,name,native),ref={...saved},issues=issueGroups(native),numbers=keyNumbers(native);
 const result={...smallIdentity(native),scope:native.scope??saved.scope,version:native.version??'finance-harness-summary/1',presentation:{mode:'summary',completeNativeSaved:true,details:presentRef(ref),summaryMaxBytes:SUMMARY_MAX_BYTES,explicitFullCompatibility:'responseMode:full returns the original object',omittedSections:[]},...Object.fromEntries(['journalHead','taskIds','affectedTasks','invalidatedResults','nextSteps','changedFactIds','sourceVersion','decision','periodComplete','submittable','requestId','text','sent','outcome','legacyEvidence','evidenceIssues'].filter(k=>native[k]!==undefined).map(k=>[k,native[k]])),keyNumbers:numbers,issues,...(native.tasks?{tasks:native.tasks.map((t,i)=>taskSummary(t,i,ref))}:{}),...(native.receipt?{receipt:{...smallIdentity(native.receipt),actualImpact:{...smallIdentity(native.receipt.actualImpact),details:presentRef(ref,'/receipt/actualImpact')},details:presentRef(ref,'/receipt')}}:{}),...(native.originalReceipt?{originalReceipt:{...smallIdentity(native.originalReceipt),details:presentRef(ref,'/originalReceipt')}}:{}),...(native.observation?{observation:{...smallIdentity(native.observation),details:presentRef(ref,'/observation')}}:{})};
 if(native.sources)result.sources=native.sources.map(({sourceId,sourceVersion,classification,parsed,current,unrecognized})=>({sourceId,sourceVersion,classification,parsed,current,unrecognized}));
 if(native.receipt?.actualImpact?.proposal)result.nextSteps=[...(result.nextSteps??[]),{action:'read_prepared_proposal_before_human_confirmation',details:presentRef(ref,'/receipt/actualImpact/proposal'),requiredNativeFields:['identity','targetVersion','dependencyDigest','planDigest','plannedVouchers'],humanFeedback:'Use the native values and actual human decision/reviewer; Agent must not author acceptance.'}];
 if(native.facts)result.facts=native.facts.map(({factId,state,reason,sourceRefs,evidence})=>({factId,state,reason,sourceRefs,evidenceKind:evidence?.kind??'legacy_unverified'}));
 if(Array.isArray(native.details?.problems))result.details={problems:native.details.problems,completeDetails:presentRef(ref,'/details')};
 if(native.contractIssues)result.contractIssues=native.contractIssues;
 if(native.receipt){for(const key of ['operationState','resultCurrent','confirmationCurrent'])if(!Object.hasOwn(result,key))result[key]=key==='operationState'?native.receipt.executionState:null;result.stateObservation='Native receipt records this operation; null current fields were not established by this call. Inspect current task status.';}
 if(!result.nextSteps?.length)result.nextSteps=[{action:'inspect_current_task_state_before_continuing_or_reviewing',tool:'harness_status',storePath,...(native.receipt?.taskId?{taskId:native.receipt.taskId}:{})}];
 result.problemCountMeaning='Problem occurrences across native issues/blockers/contract/evidence sections; repeated representations may count more than once. This is not a count of distinct blocked business tasks.';
 result.blockers={count:issues.total,countUnit:'problem_occurrences',groups:issues.groups,details:presentRef(ref)};
 if(Buffer.byteLength(JSON.stringify(issues))>4096){result.issues={total:issues.total,distinctGroups:issues.groups.length,allErrorsListed:false,details:presentRef(ref),reason:'error_inventory_requires_paging'};result.blockers={count:issues.total,allErrorsListed:false,details:presentRef(ref)};result.presentation.omittedSections.push('issues.groups','blockers.groups');}
 // Never truncate strings or silently drop failures. Large sections become
 // explicit inventories with exact counts and a content-addressed read handle.
 for(const k of ['sources','facts','tasks','issues','blockers','taskIds','affectedTasks','invalidatedResults','text','legacyEvidence','evidenceIssues','contractIssues','details','nextSteps','keyNumbers']){
  if(Buffer.byteLength(JSON.stringify(result))<=SUMMARY_MAX_BYTES)break;
  if(result[k]!==undefined){const original=result[k];result.presentation.omittedSections.push(k);result[k]={count:Array.isArray(original)?original.length:typeof original==='string'?original.length:original.total??original.count??Object.keys(original).length,details:presentRef(ref,['keyNumbers','issues','blockers','nextSteps'].includes(k)?'':`/${k}`),reason:'section_exceeds_summary_budget',...(k==='issues'&&original.groups?{groups:original.groups.map(g=>({code:g.code??null,state:g.state??null,retryable:g.retryable??false,count:g.count,pointer:g.pointer}))}:{})};}
 }
 if(Buffer.byteLength(JSON.stringify(result))>SUMMARY_MAX_BYTES&&result.issues?.groups){result.presentation.omittedSections.push('issues.groups');result.issues={count:issues.total,distinctGroups:issues.groups.length,details:presentRef(ref),reason:'error_inventory_requires_paging',allErrorsListed:false};}
 check(Buffer.byteLength(JSON.stringify(result))<=SUMMARY_MAX_BYTES,'harness_summary_budget_exceeded');return result;
}
function pointerValue(root,pointer){check(typeof pointer==='string'&&(pointer===''||pointer.startsWith('/'))&&pointer.length<=2048,'harness_receipt_pointer_invalid');let v=root;for(const token of pointer===''?[]:pointer.slice(1).split('/')){const key=token.replaceAll('~1','/').replaceAll('~0','~');check(v!==null&&typeof v==='object'&&Object.hasOwn(v,key)&&!['__proto__','prototype','constructor'].includes(key),'harness_receipt_pointer_invalid');v=v[key];}return v;}
export async function readHarnessReceipt({storePath,receiptRef,pointer='',offset=0,maxBytes=8192}) {
 check(/^[a-f0-9]{64}$/.test(receiptRef??'')&&Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(maxBytes)&&maxBytes>=256&&maxBytes<=DETAIL_MAX_BYTES,'harness_receipt_read_invalid');
 const root=await safePath(storePath,true),meta=JSON.parse(await readFile(await safePath(join(root,'store.json')),'utf8'));check(meta.version==='finance-harness-store/1'&&typeof meta.storeId==='string','harness_receipt_store_invalid');
 const bytes=await readFile(await safePath(join(root,'mcp-receipts',receiptRef+'.json')));check(digest(bytes)===receiptRef,'harness_receipt_changed');
 const saved=JSON.parse(bytes);check(saved.version==='finance-native-receipt/1'&&saved.storeId===meta.storeId,'harness_receipt_store_mismatch');const value=pointerValue(saved.result,pointer),serialized=JSON.stringify(value);
 // UTF-16 offset is explicit and stable; advance by code points so no surrogate
 // pair or UTF-8 sequence can be split. JSON fragments are reconstructed first.
 check(offset<=serialized.length&&(offset===0||!(serialized.charCodeAt(offset)>=0xDC00&&serialized.charCodeAt(offset)<=0xDFFF)),'harness_receipt_offset_invalid');
 let fragment='',used=0,end=offset;for(const point of serialized.slice(offset)){const wireSize=Buffer.byteLength(JSON.stringify(point))-2;if(used+wireSize>maxBytes)break;fragment+=point;used+=wireSize;end+=point.length;}
 return {version:'finance-receipt-page/1',receiptRef,sha256:receiptRef,nativeBytes:bytes.length,pointer,valueSha256:digest(serialized),valueBytes:Buffer.byteLength(serialized),encoding:'json-string-fragment; concatenate fragments then JSON.parse',offsetUnit:'UTF-16 code units, code-point boundaries',offset,fragment,fragmentBytes:Buffer.byteLength(fragment),fragmentJsonBytes:used,maxFragmentJsonBytes:maxBytes,nextOffset:end<serialized.length?end:null,complete:end===serialized.length};
}
