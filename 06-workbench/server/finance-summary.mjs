// 汇总条件试算的只读目标、逐值来源、独立产物及受限模型投影。
import {readFileSync,writeFileSync,mkdirSync,lstatSync,realpathSync,openSync,closeSync,fstatSync} from 'node:fs';
import {resolve,dirname,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {FINANCE_SUMMARY_INPUT_SCHEMA,isFinanceSummaryAmountPointer} from './finance-summary-contracts.mjs';
import {calculateFinanceSummary,FINANCE_SUMMARY_RULE_VERSION} from './finance-summary-engine.mjs';
import {validateSchemaValue} from './harness-schema-validation.mjs';
import {resolveDirectFinanceTarget} from './direct-finance-target.mjs';
import {currentFinanceCall,withFinanceCall,annotateFinanceCall} from './finance-call-chain.mjs';
import {PROJECTION_NUMBER_LIMIT} from './finance-output-policy.mjs';
import {cents,money} from './agency-tax-rules.mjs';
import {centsToNumber} from './money.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const stable=v=>Array.isArray(v)?`[${v.map(stable).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`:JSON.stringify(v);
const encode=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const diagnosticErrors=new WeakMap();
const fail=(code,problems)=>{const error=Object.assign(Error(code),{code});if(problems?.length){const safe={version:'finance-summary-diagnostics/1',problems:problems.slice(0,20),omittedCount:Math.max(0,problems.length-20)};diagnosticErrors.set(error,safe);error.details={safeDiagnostics:structuredClone(safe)};}throw error;};
// 只有本模块在已校验合同路径上构造的错误可透传；调用者伪造同名属性无效。
export function getFinanceSummarySafeDiagnostics(error){const value=error&&typeof error==='object'?diagnosticErrors.get(error):undefined;return value?structuredClone(value):undefined;}
const ownedSummaries=new Map();
const escape=s=>s.replaceAll('~','~0').replaceAll('/','~1');
function pointer(value,path){if(path==='')return value;if(typeof path!=='string'||!path.startsWith('/')||/~[^01]/.test(path))fail('finance_summary_pointer_invalid');let current=value;for(const raw of path.slice(1).split('/')){const key=raw.replaceAll('~1','/').replaceAll('~0','~');if(!current||typeof current!=='object'||!Object.hasOwn(current,key))fail('finance_summary_pointer_missing');current=current[key];}return current;}
function leaves(value,path=''){if(value&&typeof value==='object')return Object.entries(value).flatMap(([key,child])=>leaves(child,`${path}/${escape(key)}`));return [{path,value}];}
function secureFile(path){
 try{if(typeof path!=='string'||!isAbsolute(path))fail('finance_summary_source_path_invalid');const full=resolve(path);for(let p=full;;p=dirname(p)){const s=lstatSync(p);if(s.isSymbolicLink())fail('finance_summary_source_path_invalid');if(dirname(p)===p)break;}
  const before=lstatSync(full);if(!before.isFile()||before.nlink!==1||before.size>5*1024*1024||realpathSync(full).toLowerCase()!==full.toLowerCase())fail('finance_summary_source_path_invalid');
  const fd=openSync(full,'r');let bytes;try{const opened=fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino||opened.nlink!==1)fail('finance_summary_source_changed');bytes=readFileSync(fd);const after=fstatSync(fd);if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ino!==opened.ino||bytes.length!==opened.size)fail('finance_summary_source_changed');}finally{closeSync(fd);}return {path:full,bytes,sha256:sha(bytes)};
 }catch(error){if(error.code?.startsWith('finance_summary_'))throw error;fail('finance_summary_source_unavailable');}
}
function transformed(value,transform='identity'){
 if(transform==='identity')return value;
 if(transform==='decimal')return money(strictDecimalCents(value));
 if(transform==='period_type'){if(['month','monthly'].includes(value))return 'monthly';if(['quarter','quarterly'].includes(value))return 'quarterly';}
 if(transform==='boolean_eligibility'&&typeof value==='boolean')return value?'eligible':'ineligible';
 fail('finance_summary_binding_transform_invalid');
}
function strictDecimalCents(value){
 if(typeof value!=='number'&&typeof value!=='string'||! /^-?\d+(\.\d{1,2})?$/.test(String(value))||typeof value==='number'&&!Number.isFinite(value))fail('finance_summary_binding_transform_invalid');
 let result;try{result=cents(String(value));if(typeof value==='number'&&(!Number.isSafeInteger(Number(result))||centsToNumber(result)!==value))fail('finance_summary_binding_transform_invalid');}catch{fail('finance_summary_binding_transform_invalid');}return result;
}
const codeFiles=['finance-summary.mjs','finance-summary-contracts.mjs','finance-summary-engine.mjs','agency-tax-rules.mjs','agency-rule-catalog.mjs','money.mjs','direct-finance-target.mjs','finance-call-chain.mjs'];
function codeSnapshot(){return codeFiles.map(name=>({kind:'code',...secureFile(fileURLToPath(new URL(`./${name}`,import.meta.url)))}));}
const loadedCode=codeSnapshot();
function assertScope(raw,scope){let found=false;for(const key of ['enterpriseKey','accountSetId','databaseInstanceId']){const actual=raw?.scope?.[key]??raw?.[key];if(actual!==undefined){found=true;if(actual!==scope[key])fail('finance_summary_source_scope_conflict');}}return found;}
function assertPeriod(raw,scope,kind,inputPointer,inputs){
 if(!raw||typeof raw!=='object')return;
 const historical=/^\/(openingCarryCredit|validPriorYearLossOffset|sixTaxRelief|reliefValidFrom|reliefValidThrough)(\/|$)/.test(inputPointer);
 if(historical)return;
 for(const period of [raw.scope?.period,raw.period])if(typeof period==='string'&&/^20\d\d-\d\d$/.test(period)){
  const cumulative=['cit_prepayment','salary_pit_cumulative'].includes(kind),quarterly=inputs.periodType==='quarterly',from=cumulative?`${scope.period.slice(0,4)}-01`:quarterly?`${scope.period.slice(0,4)}-${String(Math.floor((Number(scope.period.slice(5))-1)/3)*3+1).padStart(2,'0')}`:scope.period;
  if(period<from||period>scope.period)fail('finance_summary_source_period_conflict');
 }
 if(Number.isInteger(raw.year)&&raw.year!==Number(scope.period.slice(0,4)))fail('finance_summary_source_period_conflict');
 if(kind==='cit_prepayment'&&Number.isInteger(raw.quarter)&&!inputPointer.startsWith('/quarterProfiles/')&&raw.quarter!==Math.ceil(Number(scope.period.slice(5))/3))fail('finance_summary_source_period_conflict');
}
function modelAmount(value){try{const n=centsToNumber(cents(value));return Math.abs(n)<=PROJECTION_NUMBER_LIMIT?n:null;}catch{return null;}}
const projectedAmounts=values=>Object.fromEntries(Object.entries(values??{}).map(([key,value])=>[key,modelAmount(value)]));
const projectedSteps=steps=>steps.map(({id,formula,result})=>({id,formula,result:typeof result==='string'&&/^-?\d+(\.\d{1,2})?$/.test(result)?modelAmount(result):typeof result==='number'||typeof result==='boolean'?result:null}));
function project(native,artifact,result){return {version:'finance-tax-summary-result/1',resultOrigin:'conditional_summary_engine',status:native.status,kind:native.kind,period:native.scope.period,currency:'CNY',unit:'yuan',amounts:projectedAmounts(native.amounts),steps:projectedSteps(native.steps),scenarios:native.scenarios.map(s=>({scenario:s.scenario,conditions:s.conditions,amounts:projectedAmounts(s.amounts),steps:projectedSteps(s.steps)})),conditions:native.conditions,needsInputs:native.needsInputs,...(native.unsupportedReason?{unsupportedReason:native.unsupportedReason}:{}),rules:{ruleVersion:FINANCE_SUMMARY_RULE_VERSION,codeDigest:native.codeDigest,sources:native.rules},review:native.review,modelBoundary:{mode:'fixed_summary_projection',rawValues:'local_only',numberLimit:PROJECTION_NUMBER_LIMIT,unknownAmounts:'null_or_absent'},evidence:{callRef:artifact.id,result,indexRef:`${artifact.ref}/evidence-index.json`,humanReviewRef:`${artifact.ref}/review.md`,sourceSemantics:'逐值匹配及字节快照可核；不证明真实业务、资格审定、完整账务或已缴申报。'}};}
function humanReview(native){const out=['# 税费汇总条件试算','','## 账本金额','本调用未核总账，不生成或写入凭证，不登记支付，不提交申报。',`- 期间：${native.scope.period}；状态：${native.status}`,`- 账套：${native.scope.accountSetId}；主体：${native.scope.enterpriseKey}`,'','## 计算结果与公式','```json',JSON.stringify({amounts:native.amounts,steps:native.steps,scenarios:native.scenarios},null,2),'```','','## 规则依据'];for(const r of native.rules)out.push(`- ${r.title}：${r.locator}；生效 ${r.from}，${r.through?`截至 ${r.through}`:'本工具支持至2027-12-31'}。[官方原文](${r.url})`);out.push('','## 未核条件与缺件','```json',JSON.stringify({conditions:native.conditions,needsInputs:native.needsInputs,unsupportedReason:native.unsupportedReason??null},null,2),'```','','## 工具调用、输入与原件',`- 调用：${native.callId}`,'- 完整结果：[summary.json](summary.json)','- 字节快照：[evidence-index.json](evidence-index.json)','- 每个输入叶字段的精确原件位置、实读摘要、实际值及固定变换保存在summary.json的input.sourceRefs。','- 哈希与逐值匹配不证明原件真实性、字段映射正确、条件已经审定。');return out.join('\n')+'\n';}
export async function callFinanceTaxSummaryCalculate(args,options={}){
 if(!currentFinanceCall())return withFinanceCall({tool:'finance_tax_summary_calculate',args,...(options.auditDir?{auditDir:options.auditDir}:{})},()=>callFinanceTaxSummaryCalculate(args));
 if(validateSchemaValue(FINANCE_SUMMARY_INPUT_SCHEMA,args).length)fail('finance_summary_input_invalid');
 const binding=resolveDirectFinanceTarget(args.target,args.dbPath),scope=binding.scope,code=codeSnapshot();if(code.some((file,index)=>file.sha256!==loadedCode[index].sha256))fail('finance_summary_runtime_code_changed');const codeDigest=sha(stable(code.map(f=>({path:f.path,sha256:f.sha256})))),originals=new Map(),allFiles=[...code];let totalBytes=0;
 const sourceConditions=[];
 for(const o of args.originals){if(originals.has(o.id))fail('finance_summary_original_duplicate');const file=secureFile(o.path);totalBytes+=file.bytes.length;if(totalBytes>20*1024*1024)fail('finance_summary_source_limit');if(o.sha256&&o.sha256!==file.sha256)fail('finance_summary_source_digest_mismatch');let raw;try{raw=JSON.parse(file.bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{fail('finance_summary_original_json_invalid');}if(typeof raw?.version==='string'&&/^(finance-|agency-)/.test(raw.version)||['native_engine','conditional_summary_engine'].includes(raw?.resultOrigin))fail('finance_summary_generated_result_not_original');const scoped=assertScope(raw,scope);if(!scoped)sourceConditions.push({code:'original_subject_association_unverified',state:'unverified',meaning:'原件未含可与现库核对的主体/账套标识；目标只读绑定不证明该资料属于目标企业。'});const entry={kind:'original',originalId:o.id,...file,raw};originals.set(o.id,entry);allFiles.push(entry);}
 const sourceRefs=[],inheritedConditions=[],inputLeaves=leaves(args.inputs),coverage=new Map();
 const validInputPointers=new Set(['']);for(const leaf of inputLeaves){const parts=leaf.path.split('/');for(let i=2;i<=parts.length;i++)validInputPointers.add(parts.slice(0,i).join('/'));}
 const problem=(inputPointer,reason,repairHint)=>({inputPointer,reason,repairHint});
 for(const [bindingIndex,b]of args.bindings.entries()){
  if(!validInputPointers.has(b.inputPointer))fail('finance_summary_pointer_missing',[problem(`/bindings/${bindingIndex}/inputPointer`,'input_pointer_not_in_contract','use_declared_input_pointer')]);
  const inputValue=pointer(args.inputs,b.inputPointer);let actualValue,file,jsonPointer,sourceType='original',parent;
  const readSourcePointer=(raw,path)=>{try{return pointer(raw,path);}catch(error){if(error.code==='finance_summary_pointer_missing'||error.code==='finance_summary_pointer_invalid')fail(error.code,[problem(b.inputPointer,'source_pointer_missing','locate_actual_source_field')]);throw error;}};
  if(b.originalId){file=originals.get(b.originalId);if(!file)fail('finance_summary_original_unknown');jsonPointer=b.locator.jsonPointer;actualValue=readSourcePointer(file.raw,jsonPointer);assertPeriod(file.raw,scope,args.kind,b.inputPointer,args.inputs);
   const parts=jsonPointer.split('/');for(let i=1;i<parts.length;i++){const parentValue=pointer(file.raw,parts.slice(0,i).join('/'));if(parentValue&&typeof parentValue==='object'){assertScope(parentValue,scope);assertPeriod(parentValue,scope,args.kind,b.inputPointer,args.inputs);}}
  }else{
   const known=ownedSummaries.get(b.artifactRef);if(!known||Date.now()-known.createdAt>60*60*1000)fail('finance_summary_derived_reference_untrusted');
   if(['enterpriseKey','accountSetId','databaseInstanceId','period'].some(k=>known.scope[k]!==scope[k]))fail('finance_summary_derived_scope_conflict');
   if(known.codeDigest!==codeDigest)fail('finance_summary_derived_code_changed');file=secureFile(known.path);if(file.sha256!==known.sha256)fail('finance_summary_derived_digest_mismatch');parent=JSON.parse(file.bytes.toString('utf8'));if(parent.status!=='conditional_calculated')fail('finance_summary_derived_status_invalid');
   if(!/^\/amounts\/[A-Za-z][A-Za-z0-9]*$|^\/scenarios\/\d+\/amounts\/[A-Za-z][A-Za-z0-9]*$/.test(b.resultPointer))fail('finance_summary_derived_value_rejected');jsonPointer=b.resultPointer;actualValue=readSourcePointer(parent,jsonPointer);sourceType='engine_derived';
   inheritedConditions.push(...parent.conditions,{code:'derived_summary_conditions_inherited',state:'unverified',meaning:'基数来自已核字节版本的条件试算，继承其全部未核条件；不升级为原始事实或已实缴。'});
   const scenarioMatch=/^\/scenarios\/(\d+)\//.exec(b.resultPointer);if(scenarioMatch){const scenario=parent.scenarios[Number(scenarioMatch[1])];inheritedConditions.push(...scenario.conditions.map(code=>({code:`inherited_scenario_${code}`,state:'unverified',meaning:`所用基数只在上游情景条件 ${code} 成立时有效，未升级为已审定事实。`})));}
   allFiles.push({kind:'derived_summary',...file});
   for(const original of known.originals){const current=secureFile(original.path);if(current.sha256!==original.sha256)fail('finance_summary_derived_source_changed');allFiles.push({kind:'inherited_original',...current});}
  }
  const matched=inputLeaves.filter(leaf=>b.inputPointer===''||leaf.path===b.inputPointer||leaf.path.startsWith(b.inputPointer+'/'));
  if(!matched.length)fail('finance_summary_binding_empty',[problem(b.inputPointer,'source_binding_empty','bind_source_object_or_each_leaf')]);
  const effectiveTransform=b.transform??(sourceType==='engine_derived'&&matched.some(leaf=>leaf.path===b.inputPointer)&&isFinanceSummaryAmountPointer(args.kind,b.inputPointer)?'decimal':'identity');
  if(effectiveTransform!=='identity'&&(matched.length!==1||matched[0].path!==b.inputPointer))fail('finance_summary_binding_transform_invalid',[problem(b.inputPointer,'scalar_transform_required','bind_each_scalar_field')]);
  let equal;try{equal=effectiveTransform==='decimal'?strictDecimalCents(actualValue)===strictDecimalCents(inputValue):stable(transformed(actualValue,effectiveTransform))===stable(inputValue);}catch(error){if(error.code==='finance_summary_binding_transform_invalid')fail(error.code,[problem(b.inputPointer,effectiveTransform==='decimal'?'strict_decimal_required':'declared_transform_required',effectiveTransform==='decimal'?'use_exact_decimal_number_or_string':'bind_supported_transform_from_source')]);throw error;}
  if(!equal){let targetPointer=b.inputPointer;if(effectiveTransform==='identity')for(const leaf of matched){try{const value=pointer(actualValue,leaf.path.slice(b.inputPointer.length));if(stable(value)!==stable(leaf.value)){targetPointer=leaf.path;break;}}catch{targetPointer=leaf.path;break;}}fail('finance_summary_binding_value_mismatch',[problem(targetPointer,effectiveTransform==='decimal'?'exact_decimal_value_mismatch':'source_value_mismatch','bind_actual_source_value')]);}
  for(const leaf of matched){if(coverage.has(leaf.path))fail('finance_summary_binding_ambiguous',[problem(leaf.path,'one_binding_per_input_required','use_one_unambiguous_source_binding')]);coverage.set(leaf.path,bindingIndex);const suffix=leaf.path.slice(b.inputPointer.length),sourcePointer=jsonPointer+suffix,observed=suffix?pointer(actualValue,suffix):actualValue;
   sourceRefs.push({sourceType,inputPointer:leaf.path,originalId:b.originalId??null,originalPath:file.path,path:file.path,sha256:file.sha256,jsonPointer:sourcePointer,locator:{jsonPointer:sourcePointer},actualValue:observed,inputValue:leaf.value,transform:effectiveTransform,...(parent?{artifactRef:b.artifactRef,derivedFrom:parent.input.sourceRefs}:{} )});
  }
 }
 const missing=inputLeaves.filter(leaf=>!coverage.has(leaf.path));if(missing.length)fail('finance_summary_input_source_missing',missing.map(leaf=>problem(leaf.path,'source_binding_required','bind_source_value_or_source_amount_array')));
 const native=calculateFinanceSummary(args.kind,args.inputs,scope),call=currentFinanceCall(),dir=join(call.auditDir,'artifacts',call.callId),artifact={id:call.callId,dir,ref:`finance-summary:${call.callId}`};
 const conditions=[...native.conditions,...sourceConditions,...inheritedConditions];native.conditions=[...new Map(conditions.map(c=>[c.code,c])).values()];
 for(const p of [join(call.auditDir,'artifacts'),dir]){try{if(lstatSync(p).isSymbolicLink())fail('finance_summary_artifact_path_invalid');}catch(error){if(error.code!=='ENOENT')throw error;}mkdirSync(p,{recursive:true,mode:0o700});}
 const savedFiles=[];mkdirSync(join(dir,'evidence'),{mode:0o700});
 for(const [index,file]of [...new Map(allFiles.map(f=>[f.path+'#'+f.sha256,f])).values()].entries()){const snapshot=`evidence/${index}.blob`;writeFileSync(join(dir,snapshot),file.bytes,{flag:'wx',mode:0o600});savedFiles.push({kind:file.kind,...(file.originalId?{originalId:file.originalId}:{}),originalPath:file.path,path:file.path,snapshot,sha256:file.sha256,bytes:file.bytes.length});}
 native.callId=call.callId;native.codeDigest=codeDigest;native.input={inputs:args.inputs,sourceRefs};native.sourceRefs=sourceRefs;native.contentDigest=sha(stable(native));
 const bytes=encode(native),result={artifactRef:`${artifact.ref}/summary.json`,sha256:sha(bytes),bytes:bytes.length};writeFileSync(join(dir,'summary.json'),bytes,{flag:'wx',mode:0o600});writeFileSync(join(dir,'evidence-index.json'),encode({version:'finance-summary-evidence-index/1',files:savedFiles}),{flag:'wx',mode:0o600});writeFileSync(join(dir,'review.md'),humanReview(native),{flag:'wx',mode:0o600});
 const observations=savedFiles.filter(f=>f.kind!=='code').map(f=>({path:f.path,sha256:f.sha256,bytes:f.bytes,locator:f.originalId??f.kind}));
 annotateFinanceCall({scope,ruleVersion:FINANCE_SUMMARY_RULE_VERSION,codeDigest,configuredTarget:{databasePath:binding.dbPath,accountSetId:scope.accountSetId,period:scope.period,bindingOrigin:binding.bindingOrigin},sources:observations,artifactRefs:[result.artifactRef,`${artifact.ref}/review.md`,`${artifact.ref}/evidence-index.json`]});
 ownedSummaries.set(result.artifactRef,{path:join(dir,'summary.json'),sha256:result.sha256,scope,codeDigest,createdAt:Date.now(),originals:savedFiles.filter(f=>['original','inherited_original'].includes(f.kind)).map(f=>({path:f.path,sha256:f.sha256}))});while(ownedSummaries.size>256)ownedSummaries.delete(ownedSummaries.keys().next().value);
 return project(native,artifact,result);
}
