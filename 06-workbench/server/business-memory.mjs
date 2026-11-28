// 持久企业方法的业务入口。读取只读现库；初始化、候选和执行各自显式留痕。
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname } from 'node:path';
import { resolveDirectFinanceTarget } from './direct-finance-target.mjs';
import { validateSchemaValue } from './schema-validation.mjs';
import { annotateFinanceCall, currentFinanceCall, financeAuditDirectory, withFinanceCall } from './finance-call-chain.mjs';
import { PROJECTION_NUMBER_LIMIT } from './finance-output-policy.mjs';
import { getAccountingRoles } from './accounting-profiles.mjs';
import { runFinanceCalculation } from './finance-calculation.mjs';
import {readDirectMethodProjection} from './finance-direct-method-result.mjs';
import { isModelEnvelope, validateModelEnvelope } from '../../05-reconstruction/codex/mcp/finance-mcp/finance-model-transport.mjs';
import { BUSINESS_MEMORY_SCHEMAS, MEMORY_DEFINITION_SCHEMA, NATIVE_METHOD_TOOLS, MEMORY_TOPICS, MEMORY_DATE_FIELDS, MEMORY_AMOUNT_BASES, MEMORY_DEDUPLICATION, MEMORY_ALLOCATION, MEMORY_ACCOUNT_ROLES, MEMORY_INPUT_MEANINGS, MEMORY_INPUT_FIELDS, MEMORY_SOURCE_ROLES, MEMORY_TRANSFORMATIONS, MEMORY_CONDITIONS, MEMORY_GAPS } from './business-memory-contracts.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const sha=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const period=value=>typeof value==='string'&&/^202[67]-(0[1-9]|1[0-2])$/.test(value)?value:null;
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=PROJECTION_NUMBER_LIMIT?value:null;
const known=(value,choices,fallback='unknown')=>choices.includes(value)?value:fallback;
const list=value=>Array.isArray(value)?value:[];
const methodRef=value=>typeof value==='string'&&/^bm:[a-f0-9-]{36}$/.test(value)?value:null;
const caseRef=value=>typeof value==='string'&&/^bc:[a-f0-9]{64}$/.test(value)?value:null;
const inside=(root,path)=>{const rel=relative(root,path);return !!rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\');};
function safeBytes(path,max=8*1024*1024){
 if(typeof path!=='string'||!isAbsolute(path))fail('finance_memory_file_invalid');
 const full=resolve(path);for(let p=full;;p=dirname(p)){if(lstatSync(p).isSymbolicLink())fail('finance_memory_file_invalid');if(p===dirname(p))break;}
 const stat=lstatSync(full);if(!stat.isFile()||stat.nlink!==1||stat.size>max||realpathSync(full).toLowerCase()!==full.toLowerCase())fail('finance_memory_file_invalid');
 return readFileSync(full);
}
function configured(options={}){return {...options,dbPath:options.dbPath??process.env.FINANCE_DATABASE_PATH,auditDir:options.auditDir??currentFinanceCall()?.auditDir??financeAuditDirectory(),sourceRoot:options.sourceRoot??process.env.FINANCE_SOURCE_ROOT};}
function assertWritableProcess(options={}){if(options.readOnly||process.env.WORKBENCH_DATABASE_MODE==='readonly')fail('finance_memory_readonly');}
function validate(name,args){if(validateSchemaValue(BUSINESS_MEMORY_SCHEMAS[name],args).length)fail('finance_memory_input_invalid');}
export function resolveBusinessMemoryTarget(target,options={}){
 const opts=configured(options),binding=resolveDirectFinanceTarget(target,opts.dbPath),sessionPath=opts.sessionPath??process.env.FINANCE_BUSINESS_SESSION;
 // 生成器可先生成未绑定工作区；一旦存在绑定，记忆不能在同一上下文中切企业或期间。
 if(sessionPath&&existsSync(sessionPath)){
  let session;try{session=JSON.parse(safeBytes(sessionPath,64*1024));}catch{fail('finance_memory_session_invalid');}
  if(session.version!=='finance-business-session/1'||typeof session.databasePath!=='string'||resolve(session.databasePath)!==binding.dbPath||['databaseInstanceId','enterpriseKey','accountSetId','period'].some(k=>session.scope?.[k]!==binding.scope[k]))fail('finance_memory_session_conflict');
 }
 return binding;
}
export function resolveBusinessSessionBinding(options={}){
 const sessionPath=options.sessionPath??process.env.FINANCE_BUSINESS_SESSION;if(!sessionPath||!existsSync(sessionPath))return null;
 let session;try{session=JSON.parse(safeBytes(sessionPath,64*1024));}catch{fail('finance_memory_session_invalid');}
 return resolveBusinessMemoryTarget({accountSetId:session.scope?.accountSetId,period:session.scope?.period},{...options,dbPath:options.dbPath??process.env.FINANCE_DATABASE_PATH??session.databasePath,sessionPath});
}
export function assertBusinessSessionToolTarget(name,args,options={}){
 const sessionPath=options.sessionPath??process.env.FINANCE_BUSINESS_SESSION;
 if(!sessionPath||!existsSync(sessionPath)){
  if(process.env.FINANCE_REQUIRE_BOUND_READS==='1'&&['finance_query','account_list'].includes(name))fail('finance_memory_session_required');
  return;
 }
 if(['account_context','finance_query_catalog','skills_list','skills_read','finance_rules','finance_record_contract'].includes(name))return;
 let session;try{session=JSON.parse(safeBytes(sessionPath,64*1024));}catch{fail('finance_memory_session_invalid');}
 const expected=resolveBusinessMemoryTarget({accountSetId:session.scope?.accountSetId,period:session.scope?.period},{...options,dbPath:options.dbPath??process.env.FINANCE_DATABASE_PATH??session.databasePath,sessionPath}).scope;
 // 全局企业发现可继续；只查已登记工具的顶层范围，不扫描计算脚本的自由参数或比较期间。
 const scopes=[args?.target,args?.scope,args].filter(value=>value&&typeof value==='object');
 for(const scope of scopes){
  const historicalRead=options.allowHistoricalPeriod===true&&period(scope.period)&&scope.period<expected.period;
  // 旧工具允许十进制字符串ID；只规范化比较值，不改调用参数或会话绑定。
  const accountSetId=typeof scope.accountSetId==='string'&&/^\d+$/.test(scope.accountSetId)?Number(scope.accountSetId):scope.accountSetId;
  if(scope.accountSetId!==undefined&&(!Number.isSafeInteger(accountSetId)||accountSetId<=0||accountSetId!==expected.accountSetId)||scope.enterpriseKey!==undefined&&scope.enterpriseKey!==expected.enterpriseKey||scope.databaseInstanceId!==undefined&&scope.databaseInstanceId!==expected.databaseInstanceId||scope.period!==undefined&&scope.period!==expected.period&&!historicalRead)fail('finance_memory_session_conflict');
 }
 if(['voucher_post','voucher_unpost','voucher_delete'].includes(name)&&args.voucherId!==undefined){
  const connection=new DatabaseSync(options.dbPath??process.env.FINANCE_DATABASE_PATH??session.databasePath,{readOnly:true});
  try{const actual=connection.prepare('SELECT account_set_id,period FROM vouchers WHERE id=?').get(args.voucherId);if(actual&&(actual.account_set_id!==expected.accountSetId||actual.period!==expected.period))fail('finance_memory_session_conflict');}finally{connection.close();}
 }
}
export async function refreshBusinessMemoryAfterNativeWrite(args,options={}){
 assertWritableProcess(options);
 const opts=configured(options);if(!Number.isSafeInteger(args.accountSetId)||!opts.dbPath)return;
 const periods=new Set(),connection=new DatabaseSync(opts.dbPath,{readOnly:true});
 try{
  if(period(args.period))periods.add(args.period);
  if(args.voucherId!==undefined){const actual=connection.prepare('SELECT period FROM vouchers WHERE id=? AND account_set_id=?').get(args.voucherId,args.accountSetId);if(period(actual?.period))periods.add(actual.period);}
  // 没有顶层期间的卡片/科目维护只刷新已经存在的目录；不猜一个新业务期间。
  if(!periods.size&&connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='business_memory_state'").get())for(const row of connection.prepare('SELECT period FROM business_memory_state WHERE account_set_id=?').all(args.accountSetId))if(period(row.period))periods.add(row.period);
 }finally{connection.close();}
 const sessionPath=opts.sessionPath??process.env.FINANCE_BUSINESS_SESSION;
 if(sessionPath&&existsSync(sessionPath)){const session=JSON.parse(safeBytes(sessionPath,64*1024));if(session.scope?.accountSetId===args.accountSetId&&period(session.scope.period))periods.add(session.scope.period);}
 const {prepareBusinessMemory:prepare}=await import('./business-memory-bootstrap.mjs');
 for(const p of periods)await prepare({target:{accountSetId:args.accountSetId,period:p}},opts);
 return {status:periods.size?'refreshed':'no_known_period',periodCount:periods.size};
}
async function withMemory(args,options,write,action){
 if(write)assertWritableProcess(options);
 const opts={...configured(options),matchSources:args.sources??[],matchSourceCache:new Map(),matchSourceVersions:new Map()},binding=resolveBusinessMemoryTarget(args.target,opts),storage=await import('./business-memory-storage.mjs');
 opts.scope=binding.scope;
 const connection=new DatabaseSync(binding.dbPath,{readOnly:!write});
 try{
  storage.assertBusinessMemoryScope(connection,binding.scope);
  annotateFinanceCall({scope:binding.scope,configuredTarget:{databasePath:binding.dbPath,accountSetId:binding.scope.accountSetId,period:binding.scope.period,bindingOrigin:binding.bindingOrigin}});
  return await action(connection,binding,storage,opts);
 }finally{connection.close();}
}
async function observed(args,options){const {observeBusinessMemory}=await import('./business-memory-bootstrap.mjs');return observeBusinessMemory({target:args.target},options);}
function sourceMap(observation){const refs=observation?.sourceState?.references;if(Array.isArray(refs))return new Map(refs.map(r=>[r.ref,r.sha256??r.fingerprint]));return new Map(Object.entries(refs??{}).map(([key,value])=>[key,typeof value==='string'?value:value?.sha256??value?.fingerprint]));}
function evidenceState(method,observation,opts){
 const cases=new Map(list(observation?.cases).map(c=>[c.caseRef,c])),refs=sourceMap(observation);
 return list(method.evidenceRefs).map((e,index)=>{
  let status='unverified';
  if(e.caseRef){const current=cases.get(e.caseRef),cached=observation.cachedEvidenceCases?.get(e.caseRef);status=!current?(cached?.sourceKey?.startsWith('voucher:')?'missing':'unavailable_current_context'):e.sha256&&(current.fingerprint??current.contentDigest)!==e.sha256?'changed':'current';}
  else if(e.ref){const value=refs.get(e.ref);status=!value?e.ref.startsWith('ledger:')||e.ref.startsWith('code:')?'missing':'unavailable_current_context':value!==e.sha256?'changed':'current';}
  else if(e.path){
   try{if(!opts.sourceRoot||!isAbsolute(opts.sourceRoot)||!inside(resolve(opts.sourceRoot),resolve(e.path)))status='unavailable_current_context';else status=sha(safeBytes(e.path))===e.sha256?'current':'changed';}catch{status='missing';}
  }
  const observedState=observation.sourceState?.referenceStates?.[e.caseRef??e.ref];
  if(observedState==='changed'||observedState==='missing')status=observedState;else if(observedState==='unavailable'&&status!=='changed')status='unavailable_current_context';
  return {evidenceRef:`e${index}`,kind:e.caseRef?'historical_case':e.ref?'ledger_configuration':'source_file',status,...(caseRef(e.caseRef)?{caseRef:e.caseRef}:{})};
 });
}
function executionView(execution){
 if(execution?.kind==='native'&&Object.hasOwn(NATIVE_METHOD_TOOLS,execution.tool))return {kind:'native',tool:execution.tool,versionDigest:sha(execution)};
 if(execution?.kind==='script'&&['python','javascript'].includes(execution.engine)&&typeof execution.script==='string')return {kind:'script',engine:execution.engine,scriptSha256:sha(execution.script),versionDigest:sha(execution)};
 if(execution?.kind==='calculation_record')return {kind:'calculation_record',versionDigest:sha(execution)};
 return {kind:'unavailable'};
}
function businessObjectRef(scope,key=''){return 'bo:'+sha([scope.databaseInstanceId,scope.enterpriseKey,scope.accountSetId,key||'account-set']);}
function matchingState(method,opts){
 const definition=method.definition?.applicability??{},conditions=list(definition.matchConditions),freeConditions=typeof definition.scope==='string'&&definition.scope.trim()||list(definition.conditions).some(c=>typeof c==='string'&&c.trim());
 const deterministic=method.authority==='ledger_fact'&&method.objectKey==='account-set'&&method.definition?.execution?.kind==='native';
 const resolution=deterministic?'account_set':freeConditions?'unresolved':conditions.length?definition.objectScope==='business_object'?'business_object':'unresolved':definition.objectScope==='account_set'?'account_set':'unresolved';
 if(resolution==='unresolved')return {objectScope:'unresolved',resolution,matchStatus:'unresolved',conditions:[],reason:'structured_applicability_required'};
 if(resolution==='account_set')return {objectScope:'account_set',resolution,matchStatus:'matched',conditions:[]};
 const states=conditions.map((condition,index)=>{
  let matchStatus='unresolved',reason='current_source_required';
  const source=opts.matchSources?.[condition.sourceIndex];
  try{
   if(!source||!opts.sourceRoot||!isAbsolute(opts.sourceRoot)||!isAbsolute(source.path)||!inside(resolve(opts.sourceRoot),resolve(source.path)))reason='current_source_not_authorized';
   else{
    const path=resolve(source.path);let captured=opts.matchSourceCache.get(path);
    if(!captured){const raw=safeBytes(path);captured={value:JSON.parse(raw),sha256:sha(raw)};opts.matchSourceCache.set(path,captured);}
    opts.matchSourceVersions.set(condition.sourceIndex,{sourceIndex:condition.sourceIndex,path,sha256:captured.sha256});
    let value=captured.value;
    if(typeof condition.jsonPointer!=='string'||!condition.jsonPointer.startsWith('/')||/~[^01]/.test(condition.jsonPointer))throw Error('invalid_pointer');
    for(const segment of condition.jsonPointer.slice(1).split('/')){const key=segment.replaceAll('~1','/').replaceAll('~0','~');if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))throw Error('field_missing');value=value[key];}
    if(!['string','number','boolean'].includes(typeof value)||condition.operator!=='equals')throw Error('unsupported_match');
    matchStatus=value===condition.expected?'matched':'not_matched';reason=matchStatus==='matched'?'current_source_value_matched':'current_source_value_different';
   }
  }catch{reason='current_source_field_unavailable';}
  return {conditionRef:`mc${index}`,sourceIndex:condition.sourceIndex,field:known(condition.field,MEMORY_INPUT_FIELDS),operator:'equals',matchStatus,reason};
 });
 return {objectScope:'business_object',resolution,matchStatus:states.some(c=>c.matchStatus==='not_matched')?'not_matched':states.every(c=>c.matchStatus==='matched')?'matched':'unresolved',conditions:states};
}
function methodState(method,observation,opts,targetPeriod){
 const evidence=evidenceState(method,observation,opts),execution=executionView(method.definition?.execution),authority=known(method.authority,['ledger_fact','observed_history','operator_decision','candidate'],'candidate'),applicability=matchingState(method,opts);
 const stale=evidence.some(e=>['changed','missing','forbidden'].includes(e.status)),unavailable=evidence.some(e=>e.status!=='current'),applicable=(!method.effectiveFrom||method.effectiveFrom<=targetPeriod)&&(!method.effectiveTo||method.effectiveTo>=targetPeriod);
 const currentSelection=list(observation?.storedMethods).filter(m=>m.topic===method.topic&&m.objectKey===method.objectKey&&m.authority==='operator_decision'&&m.effectiveFrom<=targetPeriod&&(!m.effectiveTo||m.effectiveTo>=targetPeriod)).sort((a,b)=>b.revision-a.revision)[0];
 const superseded=!!currentSelection&&currentSelection.methodRef!==method.methodRef;
 const trusted=authority==='operator_decision'||authority==='ledger_fact',constantValueMissing=list(method.definition?.inputs).some(input=>input.source==='constant'&&!Object.hasOwn(input,'default'));
 const nativeObjectBinding=execution.kind!=='native'||applicability.objectScope!=='business_object'?'not_required':execution.tool==='finance_tax_summary_calculate'?'matching_originals_and_digests':'not_supported';
 const executable=execution.kind!=='unavailable'&&execution.kind!=='calculation_record'&&trusted&&!stale&&(!unavailable||authority==='operator_decision')&&applicable&&!superseded&&applicability.matchStatus==='matched'&&!constantValueMissing&&nativeObjectBinding!=='not_supported';
 return {authority,evidence,execution,applicability,constantValueMissing,nativeObjectBinding,status:stale?'stale':!applicable?'outside_effective_period':superseded?'superseded':applicability.resolution==='unresolved'||constantValueMissing?'needs_local_selection':authority==='candidate'?'candidate':nativeObjectBinding==='not_supported'?'not_supported':trusted?applicability.matchStatus==='not_matched'?'not_applicable':applicability.matchStatus==='unresolved'?'needs_business_object':'available':'historical_reference',executable,evidenceCurrentlyAvailable:!unavailable,supersededBy:superseded?currentSelection.methodRef:null};
}
function methodIndex(method,observation,opts,targetPeriod){const state=methodState(method,observation,opts,targetPeriod);return {methodRef:methodRef(method.methodRef),objectRef:businessObjectRef(opts.scope,method.objectKey),version:finite(method.version),revision:finite(method.revision),topic:known(method.topic,MEMORY_TOPICS,'other'),effectiveFrom:period(method.effectiveFrom),effectiveTo:period(method.effectiveTo),authority:state.authority,status:state.status,executable:state.executable,applicability:state.applicability,nativeObjectBinding:state.nativeObjectBinding,supersededBy:state.supersededBy,evidenceCurrentlyAvailable:state.evidenceCurrentlyAvailable,gapCount:list(method.definition?.gaps).length+(state.constantValueMissing?1:0)};}
function definitionView(definition={}){
 const applicability=definition.applicability??{},transformation=definition.transformation??{};
 return {applicability:{dateField:known(applicability.dateField,MEMORY_DATE_FIELDS),amountBasis:known(applicability.amountBasis,MEMORY_AMOUNT_BASES),deduplicateBy:known(applicability.deduplicateBy,MEMORY_DEDUPLICATION),businessView:known(applicability.businessView,['accounting','vat','income_tax','cash']),objectScope:known(applicability.objectScope,['account_set','business_object'],'unresolved'),matchConditions:list(applicability.matchConditions).map((condition,index)=>({conditionRef:`mc${index}`,sourceIndex:condition.sourceIndex,field:known(condition.field,MEMORY_INPUT_FIELDS),operator:'equals',expectedValue:'local_only'})),requiredConditions:list(applicability.requiredConditions).map(c=>known(c,MEMORY_CONDITIONS)),unstructuredConditionCount:list(applicability.conditions).length,unstructuredScopePresent:typeof applicability.scope==='string'&&!!applicability.scope.trim()},
  inputs:list(definition.inputs).slice(0,64).map((input,index)=>({inputRef:`p${index}`,...(definition.interfaceVersion==='business-method/1'&&/^[a-z][a-z0-9_]{0,63}$/.test(input.key)?{parameterKey:input.key}:{}),meaning:known(input.meaning,MEMORY_INPUT_MEANINGS),field:known(input.field,MEMORY_INPUT_FIELDS),sourceRole:known(input.sourceRole,MEMORY_SOURCE_ROLES),type:known(input.type,['number','integer','string','boolean','object','array','null']),required:input.required===true,source:known(input.source,['current_parameters','ledger','source_snapshot','constant']),...(input.source==='constant'?{constantState:Object.hasOwn(input,'default')?'saved':'missing_saved_value'}:{}),dateField:known(input.dateField,MEMORY_DATE_FIELDS),amountBasis:known(input.amountBasis,MEMORY_AMOUNT_BASES),...(Number.isInteger(input.sourceIndex)?{sourceIndex:input.sourceIndex}:{}),...(input.source==='constant'&&(typeof input.default==='number'||typeof input.default==='boolean')?{default:typeof input.default==='number'?finite(input.default):input.default}:{})})),
  transformation:{kind:known(transformation.kind,MEMORY_TRANSFORMATIONS),allocationBasis:known(transformation.allocationBasis,MEMORY_ALLOCATION),deduplicateBy:known(transformation.deduplicateBy,MEMORY_DEDUPLICATION),rounding:known(transformation.rounding,['half_up_cent','half_even_cent','native','script_defined']),missingValues:known(transformation.missingValues,['preserve_unknown','reject','native']),steps:list(transformation.steps).slice(0,64).filter(s=>!validateSchemaValue(MEMORY_DEFINITION_SCHEMA.properties.transformation.properties.steps.items,s).length).map(s=>structuredClone(s)),unstructuredFormulaPresent:typeof transformation.formula==='string',assetConfiguration:list(transformation.configuration).slice(0,100).map((c,index)=>({assetRef:`asset${index}`,kind:known(c.kind,['fixed','intangible']),originalCost:finite(c.originalCost),residualRate:finite(c.residualRate),usefulLifeMonths:finite(c.usefulLifeMonths),startPeriod:period(c.startPeriod),acquiredPeriod:period(c.acquiredPeriod),openingAccumulated:finite(c.openingAccumulated),ledgerStatus:known(c.ledgerStatus,['booked','pending_purchase_voucher'])}))},
  accounts:list(definition.accounts).slice(0,100).map((account,index)=>({accountRef:`a${index}`,role:known(account.role,MEMORY_ACCOUNT_ROLES),side:known(account.side,['debit','credit','both'])})),
  gaps:[...new Set([...list(definition.gaps).slice(0,40).map(gap=>known(typeof gap==='string'?gap:gap?.code,MEMORY_GAPS,'unrecognized_detail')),...(list(definition.inputs).some(input=>input.source==='constant'&&!Object.hasOwn(input,'default'))?['constant_value_missing']:[])])]};
}
async function currentObservation(args,opts,connection,binding,storage){
 const observation=await observed(args,opts);
 // 所有不可变版本都参与生效期覆盖判断；读取分页不改变选择语义。
 const methods=[];let page;do{page=storage.listBusinessMemoryMethods(connection,binding.scope,{limit:100,offset:methods.length});methods.push(...page.items);}while(methods.length<page.total);
 observation.storedMethods=methods.filter(m=>m.topic!=='business_baseline');observation.cachedEvidenceCases=new Map();
 for(const method of methods)for(const e of list(method.evidenceRefs))if(e.caseRef&&!observation.cachedEvidenceCases.has(e.caseRef))observation.cachedEvidenceCases.set(e.caseRef,storage.getBusinessMemoryCase(connection,binding.scope,e.caseRef));
 return observation;
}
export async function prepareBusinessMemory(args,options={}){
 assertWritableProcess(options);
 if(!currentFinanceCall())return withFinanceCall({tool:'finance_memory_prepare',args,auditDir:configured(options).auditDir},()=>prepareBusinessMemory(args,options));
 validate('finance_memory_prepare',args);const opts=configured(options),binding=resolveBusinessMemoryTarget(args.target,opts),{prepareBusinessMemory:prepare}=await import('./business-memory-bootstrap.mjs');
 const result=await prepare(args,opts);annotateFinanceCall({scope:binding.scope});
 return {version:'finance-memory-preparation/1',status:'prepared',target:args.target,scopeVerified:true,memory:{revision:finite(result.revision),caseCount:finite(result.caseCount),methodCount:finite(result.methodCount),changed:result.changed===true},nextSteps:[{tool:'finance_company_context'}]};
}
export async function readCompanyContext(args,options={}){
 validate('finance_company_context',args);
 return withMemory(args,options,false,async(connection,binding,storage,opts)=>{
  let state,installed=true;try{state=storage.readBusinessMemoryState(connection,binding.scope);}catch(error){if(error.code!=='finance_memory_not_prepared')throw error;installed=false;}
  const base={version:'finance-company-context/1',target:args.target,scopeVerified:true,periodComplete:false,authorizesPosting:false};
  if(!installed)return {...base,status:'unprepared',memory:{revision:0,freshness:'unprepared',caseCounts:{}},methods:[],pagination:{offset:0,limit:args.limit??20,total:0,nextOffset:null},nextSteps:[{tool:'finance_memory_prepare'}]};
  const observation=await currentObservation(args,opts,connection,binding,storage),fresh=!!state&&state.fingerprint===observation.fingerprint;
  const filtered=observation.storedMethods.filter(m=>(!args.topics||args.topics.includes(m.topic))&&(!args.objectRef||args.objectRef===businessObjectRef(binding.scope,m.objectKey))),offset=args.offset??0,limit=args.limit??20;
  // 可用操作者选择优先，其次现库配置；草稿和历史观察保持独立。
  filtered.sort((a,b)=>{const rank=m=>{const state=methodState(m,observation,opts,args.target.period);return (state.executable?0:state.status==='historical_reference'?10:state.status==='candidate'?20:30)+({operator_decision:0,ledger_fact:1,observed_history:2,candidate:3}[m.authority]??4);};return rank(a)-rank(b)||(b.revision??0)-(a.revision??0)||(b.effectiveFrom??'').localeCompare(a.effectiveFrom??'')||String(a.methodRef).localeCompare(String(b.methodRef));});
  const counts={};for(const c of list(observation.cases).filter(c=>c.period<args.target.period)){const status=known(c.status,['posted','closed','closed_posted','draft','failed','executed','executed_unreviewed','unknown'],'unknown');counts[status]=(counts[status]??0)+1;}
  return {...base,status:!state||fresh?'ready':'stale',snapshot:'live_readonly',memory:{revision:state?finite(state.revision):0,freshness:!state?'period_not_indexed':fresh?'current':'refresh_required',caseCounts:counts},methods:filtered.slice(offset,offset+limit).map(m=>methodIndex(m,observation,opts,args.target.period)),pagination:{offset,limit,total:filtered.length,nextOffset:offset+limit<filtered.length?offset+limit:null},nextSteps:!state||fresh?[{tool:'finance_method_read'},{tool:'finance_case_search'}]:[{tool:'finance_memory_prepare'},{tool:'finance_method_read'},{tool:'finance_case_search'}]};
 });
}
export async function readBusinessMethod(args,options={}){
 validate('finance_method_read',args);
 return withMemory(args,options,false,async(connection,binding,storage,opts)=>{
  const method=storage.getBusinessMemoryMethod(connection,binding.scope,args.methodRef);if(!method||method.topic==='business_baseline')fail('finance_memory_method_missing');
  if(args.objectRef&&args.objectRef!==businessObjectRef(binding.scope,method.objectKey))fail('finance_memory_object_conflict');
  const observation=await currentObservation(args,opts,connection,binding,storage),state=methodState(method,observation,opts,args.target.period);
  const recordedRun=method.definition?.calculationOrigin?.runId??(method.topic==='calculation'?method.objectKey:null);
  return {version:'finance-business-method/1',target:args.target,...methodIndex(method,observation,opts,args.target.period),definition:definitionView({...method.definition,...(method.configuration?{transformation:{...method.definition.transformation,configuration:method.configuration}}:{})}),execution:{...state.execution,...(typeof recordedRun==='string'&&/^[a-f0-9-]{36}$/.test(recordedRun)?{recordedRunId:recordedRun}:{})},evidence:state.evidence,supersedes:methodRef(method.supersedes),replacementPolicy:method.replacementPolicy==='latest_selected_revision_in_effective_period'?method.replacementPolicy:null,replaces:list(method.replaces).map(methodRef).filter(Boolean),modelBoundary:{mode:'fixed_business_projection',rawValues:'local_only'},nextSteps:state.executable?[{tool:'finance_method_run'}]:[{tool:'finance_case_search'}]};
 });
}
function caseSourceState(item,observation){
 const states=[];
 const visit=(source,depth=0)=>{if(!source||typeof source!=='object'||depth>8)return;if(source.state==='changed'||source.unchanged===false)states.push('changed');else if(source.state==='missing')states.push('missing');else if(source.state==='unknown'||source.observationStatus==='unavailable')states.push('unavailable');else if(source.state==='unchanged')states.push('current');for(const child of [...list(source.sources),...list(source.dependencies)])visit(child,depth+1);};
 for(const source of list(item.sourceRefs))visit(source);
 const indexed=observation.sourceState?.referenceStates?.[item.caseRef];if(indexed)states.push(indexed);
 if(item.observationStatus)states.push(item.observationStatus);
 if(list(item.gaps).includes('posting_source_evidence_unknown'))states.push('unverified');
 const status=states.includes('changed')?'changed':states.includes('missing')?'missing':states.includes('unavailable')?'unavailable':states.includes('unverified')?'unverified':states.length?'current':'unverified';
 return {status,changedCount:states.filter(s=>s==='changed').length,missingCount:states.filter(s=>s==='missing').length,unavailableCount:states.filter(s=>s==='unavailable').length,meaning:'source_version_observation_not_business_truth'};
}
function caseView(item,connection,binding,observation,relatedObjectRefs=[]){
 let entries=list(item.entries??item.definition?.entries??item.summary?.entries),voucher=null,roles={};
 const id=/^voucher:(\d+)$/.exec(item.sourceKey??'');
 if(id){
  voucher=connection.prepare('SELECT id,period,word,number FROM vouchers WHERE id=? AND account_set_id=?').get(Number(id[1]),binding.scope.accountSetId);
  if(voucher)entries=connection.prepare('SELECT code,debit,credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no,id').all(voucher.id);
  try{roles=getAccountingRoles(connection.prepare('SELECT accounting_profile_id FROM account_sets WHERE id=?').get(binding.scope.accountSetId).accounting_profile_id);}catch{}
 }
 const roleNames={mainRevenue:'main_income',otherRevenue:'main_income',mainCost:'main_cost',otherCost:'main_cost',adminExpense:'management_expense',defaultDepreciationExpense:'management_expense',fixedAsset:'fixed_asset',accumulatedDepreciation:'accumulated_depreciation',intangibleAsset:'intangible_asset',accumulatedAmortization:'accumulated_amortization',currentYearProfit:'current_profit',profitDistribution:'retained_profit'};
 const roleFor=e=>{if(MEMORY_ACCOUNT_ROLES.includes(e.role))return e.role;if(typeof e.code!=='string')return 'unknown';for(const [name,value]of Object.entries(roles))if(roleNames[name]&&typeof value==='string'&&e.code.startsWith(value))return roleNames[name];if(list(roles.cashRoots).some(code=>e.code.startsWith(code)))return 'bank';return 'unknown';};
 const sourceEvidence=caseSourceState(item,observation);
 return {caseRef:caseRef(item.caseRef),objectRef:businessObjectRef(binding.scope,item.objectKey),relatedObjectRefs,topic:known(item.topic,MEMORY_TOPICS,'other'),period:period(item.period),status:known(item.status,['posted','closed','closed_posted','draft','failed','executed','executed_unreviewed','unknown']),authority:known(item.authority,['ledger_fact','observed_history'],'observed_history'),ledgerFact:{status:known(item.status,['posted','closed','closed_posted','draft','failed','executed','executed_unreviewed','unknown']),meaning:'recorded_ledger_or_execution_state'},sourceEvidence,freshness:sourceEvidence.status,preferred:['posted','closed','closed_posted'].includes(item.status)&&sourceEvidence.status==='current',
  procedure:definitionView(item.definition??item.method??{}),...(voucher?{voucher:{voucherId:voucher.id,period:period(voucher.period),word:({记:'general',收:'receipt',付:'payment',转:'transfer'})[voucher.word]??'other',number:finite(voucher.number)}}:{}),entries:entries.slice(0,50).map((entry,index)=>({entryRef:`v${index}`,role:roleFor(entry),debit:finite(typeof entry.debit==='number'?entry.debit:Number(entry.debit)),credit:finite(typeof entry.credit==='number'?entry.credit:Number(entry.credit))})),entryCount:entries.length,sourceCount:list(item.sourceRefs??item.evidenceRefs).length,gaps:list(item.gaps).map(gap=>known(typeof gap==='string'?gap:gap?.code,MEMORY_GAPS,'unrecognized_detail')),methodRef:methodRef(item.methodRef),...(typeof item.summary?.runId==='string'&&/^[a-f0-9-]{36}$/.test(item.summary.runId)?{recordedRunId:item.summary.runId}:{}),executionAvailable:!!item.execution||typeof item.summary?.runId==='string'&&/^[a-f0-9-]{36}$/.test(item.summary.runId)};
}
export async function searchBusinessCases(args,options={}){
 validate('finance_case_search',args);
 return withMemory(args,options,false,async(connection,binding,storage,opts)=>{
  let state,installed=true;try{state=storage.readBusinessMemoryState(connection,binding.scope);}catch(error){if(error.code!=='finance_memory_not_prepared')throw error;installed=false;}
  const observation=installed?await currentObservation(args,opts,connection,binding,storage):await observed(args,opts),related=new Map();
  for(const method of list(observation.storedMethods))for(const evidence of list(method.evidenceRefs))if(evidence.caseRef){const refs=related.get(evidence.caseRef)??new Set();refs.add(businessObjectRef(binding.scope,method.objectKey));related.set(evidence.caseRef,refs);}
  // 外部更正立即显示最新只读快照；持久索引由显式prepare或成功原生写入同步。
  const cases=list(observation.cases).filter(c=>c.period<args.target.period&&(!args.topic||c.topic===args.topic)&&(args.objectKey===undefined||c.objectKey===args.objectKey)&&(!args.objectRef||businessObjectRef(binding.scope,c.objectKey)===args.objectRef||related.get(c.caseRef)?.has(args.objectRef))).sort((a,b)=>(b.priority??0)-(a.priority??0)||b.period.localeCompare(a.period)||String(a.caseRef).localeCompare(String(b.caseRef))),offset=args.offset??0,limit=args.limit??20;
  return {version:'finance-business-cases/1',target:args.target,snapshot:'live_readonly',cacheState:!state?'unprepared':state.fingerprint===observation.fingerprint?'current':'stale',cases:cases.slice(offset,offset+limit).map(c=>caseView(c,connection,binding,observation,[...(related.get(c.caseRef)??[])].slice(0,50))),pagination:{offset,limit,total:cases.length,nextOffset:offset+limit<cases.length?offset+limit:null},modelBoundary:{mode:'fixed_business_projection',rawValues:'local_only'}};
 });
}
function calculationSnapshot(runId,opts){
 const dir=join(opts.auditDir,'calculations',runId);let record;
 try{record=JSON.parse(safeBytes(join(dir,'record.json')));}catch{fail('finance_memory_calculation_missing');}
 if(record.version!=='finance-calculation/1'||record.runId!==runId||!['python','javascript'].includes(record.engine)||record.status!=='executed'||record.execution?.exitCode!==0||record.executionFileChecks?.some(c=>c.unchanged!==true)||record.sourceChecks?.some(c=>c.sourceUnchanged!==true||c.snapshotUnchanged!==true))fail('finance_memory_calculation_unverified');
 const script=safeBytes(join(dir,record.engine==='python'?'script.py':'script.mjs'),200000),request=safeBytes(join(dir,'request.json'));
 if(sha(script)!==record.script?.sha256||sha(request)!==record.request?.sha256||record.input&&sha(safeBytes(join(dir,'input.json')))!==record.input.sha256)fail('finance_memory_calculation_changed');
 const evidenceRefs=list(record.sources).map(s=>{
  if(!opts.sourceRoot||!isAbsolute(opts.sourceRoot)||typeof s.path!=='string'||!inside(resolve(opts.sourceRoot),resolve(s.path))||sha(safeBytes(s.path))!==s.sha256)fail('finance_memory_calculation_source_stale');return {path:resolve(s.path),sha256:s.sha256};
 });
 return {execution:{kind:'script',engine:record.engine,script:script.toString('utf8')},origin:{runId,recordSha256:sha(safeBytes(join(dir,'record.json'))),scriptSha256:sha(script)},evidenceRefs};
}
function normalizeDefinition(definition,opts){
 const copy=structuredClone(definition);copy.interfaceVersion='business-method/1';
 if(copy.execution?.kind==='calculation_record'){const snapshot=calculationSnapshot(copy.execution.runId,opts);copy.execution=snapshot.execution;copy.calculationOrigin=snapshot.origin;copy.executionEvidence=snapshot.evidenceRefs;}
 const keys=list(copy.inputs).map(i=>i.key);if(new Set(keys).size!==keys.length||keys.some(k=>['__proto__','prototype','constructor'].includes(k)||/^p\d+$/.test(k)))fail('finance_memory_input_contract_invalid');
 return copy;
}
function bindEvidence(evidenceRefs,observation,opts){
 const refs=sourceMap(observation),cases=new Map(list(observation.cases).map(c=>[c.caseRef,c]));
 return evidenceRefs.map(e=>{
  if(e.caseRef){const current=cases.get(e.caseRef),digest=current?.fingerprint??current?.contentDigest;if(!current||!digest||e.sha256&&e.sha256!==digest)fail('finance_memory_evidence_stale');return {caseRef:e.caseRef,sha256:digest};}
  if(e.ref){if(refs.get(e.ref)!==e.sha256)fail('finance_memory_evidence_stale');return {...e};}
  if(e.path){if(!opts.sourceRoot||!isAbsolute(opts.sourceRoot)||!inside(resolve(opts.sourceRoot),resolve(e.path))||sha(safeBytes(e.path))!==e.sha256)fail('finance_memory_evidence_stale');return {path:resolve(e.path),sha256:e.sha256};}
  fail('finance_memory_evidence_invalid');
 });
}
export async function proposeBusinessMethod(args,options={}){
 assertWritableProcess(options);
 if(!currentFinanceCall())return withFinanceCall({tool:'finance_memory_propose',args,auditDir:configured(options).auditDir},()=>proposeBusinessMethod(args,options));
 validate('finance_memory_propose',args);if(args.effectiveTo&&args.effectiveTo<args.effectiveFrom)fail('finance_memory_effective_period_invalid');
 return withMemory(args,options,true,async(connection,binding,storage,opts)=>{
  if(!storage.readBusinessMemoryState(connection,binding.scope))fail('finance_memory_unprepared');
  const observation=await observed(args,opts),definition=normalizeDefinition(args.definition,opts),evidenceRefs=bindEvidence([...args.evidenceRefs,...list(definition.executionEvidence)],observation,opts);delete definition.executionEvidence;
  const saved=storage.appendBusinessMemoryMethodVersion(connection,binding.scope,{topic:args.topic,objectKey:args.objectKey??'',effectiveFrom:args.effectiveFrom,...(args.effectiveTo?{effectiveTo:args.effectiveTo}:{}),authority:'candidate',definition,evidenceRefs,reason:args.reason??'model_proposal',expectedRevision:args.expectedRevision,sourceFingerprint:observation.fingerprint});
  return {version:'finance-method-proposal/1',status:'candidate_saved',methodRef:saved.methodRef,objectRef:businessObjectRef(binding.scope,saved.objectKey),revision:finite(saved.revision),authority:'candidate',executable:false,requiresLocalSelection:true,nextSteps:[{tool:'finance_method_read'}]};
 });
}
function parametersFor(method,args,targetPeriod){
 const allDefinitions=list(method.definition?.inputs);
 for(const definition of allDefinitions)if(definition.source==='source_snapshot'&&definition.required&&Number.isInteger(definition.sourceIndex)&&!args.sources?.[definition.sourceIndex])fail('finance_memory_current_source_required');
 const input=args.parameters??{},definitions=allDefinitions.map((definition,index)=>({definition,index})).filter(({definition:d})=>d.source!=='ledger'&&d.type!=='ledger_asset_cards'&&!(d.source==='source_snapshot'&&Number.isInteger(d.sourceIndex))),out={};
 if(definitions.length){
  const allowed=new Set(definitions.flatMap(({definition:d,index})=>[d.key,`p${index}`]));if(Object.keys(input).some(k=>!allowed.has(k)))fail('finance_memory_parameter_unknown');
  definitions.forEach(({definition,index})=>{
   const slot=`p${index}`;if(Object.hasOwn(input,slot)&&Object.hasOwn(input,definition.key)&&slot!==definition.key)fail('finance_memory_parameter_duplicate');
   let value=Object.hasOwn(input,slot)?input[slot]:input[definition.key];
   if(definition.source==='constant'){
    if(!Object.hasOwn(definition,'default'))fail('finance_memory_constant_value_missing');
    if(value!==undefined&&value!==definition.default)fail('finance_memory_constant_conflict');
    value=definition.default;
   }else if(value===undefined&&Object.hasOwn(definition,'default')&&definition.meaning!=='period')fail('finance_memory_current_input_required');
   if(definition.meaning==='period'){
    if(value!==undefined&&value!==targetPeriod)fail('finance_memory_parameter_period_conflict');value=targetPeriod;
   }
   if(value===undefined){if(definition.required)fail('finance_memory_parameter_missing');return;}
   const actual=value===null?'null':Array.isArray(value)?'array':typeof value;if(!(definition.type==='integer'?Number.isSafeInteger(value):actual===definition.type))fail('finance_memory_parameter_type_invalid');
   Object.defineProperty(out,definition.key,{value,enumerable:true,writable:true,configurable:true});
  });
 }else{
  // 没有保存输入合同的脚本不能用任意旧参数代替本期事实；明确无参数的脚本只接受空对象。
  if(Object.keys(input).length)fail('finance_memory_parameter_unknown');
 }
 return out;
}
function resolveTemplate(value,parameters,target,depth=0){
 if(depth>20)fail('finance_memory_template_invalid');
 if(value===null||['number','boolean','string'].includes(typeof value))return value;
 if(Array.isArray(value))return value.map(v=>resolveTemplate(v,parameters,target,depth+1));
 if(!value||typeof value!=='object')fail('finance_memory_template_invalid');
 const keys=Object.keys(value);
 if(keys.length===1&&keys[0]==='$parameter'){if(typeof value.$parameter!=='string'||!Object.hasOwn(parameters,value.$parameter))fail('finance_memory_parameter_missing');return structuredClone(parameters[value.$parameter]);}
 if(keys.length===1&&keys[0]==='$target'){if(!['accountSetId','period'].includes(value.$target))fail('finance_memory_template_invalid');return target[value.$target];}
 const out={};for(const key of keys){if(['__proto__','prototype','constructor'].includes(key))fail('finance_memory_template_invalid');out[key]=resolveTemplate(value[key],parameters,target,depth+1);}return out;
}
function nativeArguments(execution,parameters,target){
 const shape=NATIVE_METHOD_TOOLS[execution.tool];if(!shape)fail('finance_memory_executor_forbidden');
 const args=resolveTemplate(execution.argsTemplate??{},parameters,target);
 if(shape==='target'){
  if(args.target&&(args.target.accountSetId!==target.accountSetId||args.target.period!==target.period||Object.keys(args.target).some(k=>!['accountSetId','period'].includes(k))))fail('finance_memory_executor_scope_conflict');args.target={...target};
  if(args.scope||args.dbPath||args.manifestPath)fail('finance_memory_executor_scope_conflict');
 }else{
  if(args.accountSetId!==undefined&&args.accountSetId!==target.accountSetId||args.period!==undefined&&args.period!==target.period)fail('finance_memory_executor_scope_conflict');
  args.accountSetId=target.accountSetId;if(shape==='period')args.period=target.period;
 }
 return args;
}
function bindNativeObjectSources(execution,args,matchedSources){
 if(execution.tool!=='finance_tax_summary_calculate')fail('finance_memory_native_object_binding_unsupported');
 const matched=new Map(matchedSources.map(source=>[source.path,source]));
 if(!matched.size||!Array.isArray(args.originals)||!args.originals.length||!Array.isArray(args.bindings)||!args.bindings.length||args.bindings.some(binding=>typeof binding.originalId!=='string'||binding.artifactRef!==undefined))fail('finance_memory_native_object_binding_unsupported');
 // 每个实际原件都须来自已判定对象的同一字节版本；未使用的A1不能替A2实际取数背书。
 args.originals=args.originals.map(original=>{
  const source=typeof original.path==='string'&&isAbsolute(original.path)?matched.get(resolve(original.path)):null;
  if(!source||original.sha256!==undefined&&original.sha256!==source.sha256)fail('finance_memory_native_object_source_mismatch');
  return {...original,sha256:source.sha256};
 });
 const ids=new Set(args.originals.map(original=>original.id));if(args.bindings.some(binding=>!ids.has(binding.originalId)))fail('finance_memory_native_object_source_mismatch');
 return args;
}
function verifyMatchedSourceVersions(sources){for(const source of sources)if(sha(safeBytes(source.path))!==source.sha256)fail('finance_memory_match_source_changed');}
function executionResultView(execution,result){
 if(!result)return null;
 if(execution.kind==='script'){
  // 此处沿用通用计算器已开放的派生产物索引；不输出其原始输入、stdout或任意结果JSON。
  return {kind:'derived_calculation',status:known(result.status,['executed','failed']),runId:result.runId,reviewPath:result.reviewPath,recordPath:result.recordPath,
   outputs:list(result.outputs).map(o=>({path:o.path,sha256:o.sha256,bytes:o.bytes,kind:'derived_calculation'})),businessStatus:'unreviewed',...(result.error?{error:{code:result.error.code}}:{})};
 }
 const directProjection=readDirectMethodProjection(execution.tool,result);
 if(directProjection)return {...directProjection,executionKind:'native',tool:execution.tool};
 if(isModelEnvelope(result)){const checked=validateModelEnvelope(result);return checked.ok?{kind:'native',modelResult:checked.envelope}:{kind:'native',status:'unknown'};}
 return {kind:'native',status:'unknown'};
}
export async function runBusinessMethod(args,options={}){
 assertWritableProcess(options);
 if(!currentFinanceCall())return withFinanceCall({tool:'finance_method_run',args,auditDir:configured(options).auditDir},()=>runBusinessMethod(args,options));
 validate('finance_method_run',args);
 return withMemory(args,options,true,async(connection,binding,storage,opts)=>{
  const method=storage.getBusinessMemoryMethod(connection,binding.scope,args.methodRef);if(!method||method.topic==='business_baseline')fail('finance_memory_method_missing');
  if(args.objectRef&&args.objectRef!==businessObjectRef(binding.scope,method.objectKey))fail('finance_memory_object_conflict');
  const observation=await currentObservation(args,opts,connection,binding,storage),state=methodState(method,observation,opts,args.target.period);
  if(!state.executable)fail(state.status==='stale'?'finance_memory_method_stale':state.status==='candidate'?'finance_memory_local_selection_required':state.constantValueMissing?'finance_memory_constant_value_missing':state.nativeObjectBinding==='not_supported'?'finance_memory_native_object_binding_unsupported':state.applicability.matchStatus==='not_matched'?'finance_memory_object_mismatch':state.applicability.matchStatus==='unresolved'?'finance_memory_applicability_unresolved':'finance_memory_method_not_executable');
  const execution=method.definition.execution,parameters=parametersFor(method,args,args.target.period),matchedSources=[...opts.matchSourceVersions.values()].map(value=>({...value})),runId=randomUUID(),dir=join(opts.auditDir,'methods',runId);mkdirSync(dir,{recursive:true});
  const begin={version:'finance-method-run/1',runId,scope:binding.scope,methodRef:method.methodRef,methodVersion:method.version,methodRevision:method.revision,definitionSha256:sha(method.definition),execution:state.execution,parameters,sources:args.sources??[],matchedSources,startedAt:new Date().toISOString(),status:'running'};
  writeFileSync(join(dir,'begin.json'),json(begin),{flag:'wx',mode:0o600});
  storage.recordBusinessMemoryRun(connection,binding.scope,{methodRef:method.methodRef,executionRunId:runId,period:args.target.period,status:'running',resultRef:join(dir,'begin.json'),definitionSha256:begin.definitionSha256});
  let result,status='unknown',errorCode;
  try{
   // 方法包装不获得写账权：原生仍经过原工具合同、模型通道和所有原有写入守卫。
   if(execution.kind==='native'){
    if(typeof opts.invokeNativeTool!=='function')fail('finance_memory_native_executor_required');
    if(list(args.sources).length&&state.applicability.objectScope!=='business_object')fail('finance_memory_native_sources_in_parameters_required');
    let nativeArgs=nativeArguments(execution,parameters,args.target);
    if(state.applicability.objectScope==='business_object')nativeArgs=bindNativeObjectSources(execution,nativeArgs,matchedSources);
    verifyMatchedSourceVersions(matchedSources);
    result=await opts.invokeNativeTool(execution.tool,nativeArgs,binding.scope);
    if(isModelEnvelope(result)){if(!validateModelEnvelope(result).ok)fail('finance_memory_native_result_unconfirmed');}
    else if(!readDirectMethodProjection(execution.tool,result))fail('finance_memory_native_result_unconfirmed');
    status=result?.applied==='unknown'||result?.status==='unknown'?'unknown':result?.ok===false||result?.status==='failed'?'failed':'executed';
   }else{
    result=await runFinanceCalculation({title:method.definition.title??'企业已选方法',engine:execution.engine,script:execution.script,sources:args.sources??[],parameters:{...parameters,period:args.target.period},notes:method.definition.notes??[],...(execution.timeoutMs?{timeoutMs:execution.timeoutMs}:{})},{...opts,expectedSourceVersions:matchedSources});
    status=result.status==='executed'?'executed':'failed';
   }
   // 同一版本在执行过程中被更正/替换不能仍宣称完整验证通过；保留已发生的结果。
   storage.assertBusinessMemoryScope(connection,binding.scope);
   opts.matchSourceCache.clear();opts.matchSourceVersions.clear();
   const after=storage.getBusinessMemoryMethod(connection,binding.scope,args.methodRef),afterObservation=await currentObservation(args,opts,connection,binding,storage),afterState=after?methodState(after,afterObservation,opts,args.target.period):null;
   if(!after||sha(after.definition)!==begin.definitionSha256||!afterState.executable){status='unknown';errorCode='finance_memory_method_changed_during_run';}
  }catch(error){errorCode=/^(finance|model|posting|asset|period|voucher|audit)_[a-z0-9_]+$/.test(error?.code)?error.code:'finance_memory_execution_unconfirmed';status='unknown';}
  const record={...begin,status,finishedAt:new Date().toISOString(),result:result??null,...(errorCode?{error:{code:errorCode}}:{})};
  writeFileSync(join(dir,'result.json'),json(record),{flag:'wx',mode:0o600});
  storage.recordBusinessMemoryRun(connection,binding.scope,{methodRef:method.methodRef,executionRunId:runId,period:args.target.period,status,resultRef:join(dir,'result.json'),definitionSha256:begin.definitionSha256});
  annotateFinanceCall({artifactRefs:[join(dir,'begin.json'),join(dir,'result.json')],methodExecution:{methodRef:method.methodRef,version:method.version,runId,status}});
  // 原生 callback 已使用原有模型投影；本方法只返回固定执行摘要，不转发脚本输出/原始路径。
  return {version:'finance-method-execution/1',target:args.target,methodRef:method.methodRef,objectRef:businessObjectRef(binding.scope,method.objectKey),methodVersion:finite(method.version),runRef:`mr:${runId}`,status,execution:state.execution,result:executionResultView(execution,result),...(errorCode?{error:{code:errorCode},retryBlockedBy:'inspect_original_execution_locally'}:{}),businessStatus:'unreviewed',postedVerified:false,modelBoundary:{mode:'fixed_business_projection',rawValues:'local_only',calculationArtifacts:'existing_calculator_output_index'}};
 });
}

// 仅本机交互审阅模块使用；不是 MCP 工具，不将原值放入模型返回。
export async function readBusinessMethodLocally(args,options={}){
 validate('finance_method_read',args);
 return withMemory(args,options,false,async(connection,binding,storage,opts)=>{
  const method=storage.getBusinessMemoryMethod(connection,binding.scope,args.methodRef);if(!method||method.topic==='business_baseline')fail('finance_memory_method_missing');
  const observation=await currentObservation(args,opts,connection,binding,storage),topicVersions=observation.storedMethods.filter(m=>m.topic===method.topic&&m.objectKey===method.objectKey),topicRevision=Math.max(...topicVersions.map(m=>m.revision));return {scope:binding.scope,method,state:methodState(method,observation,opts,args.target.period),reviewDigest:sha(method),topicRevision,selections:topicVersions.filter(m=>m.authority==='operator_decision')};
 });
}
export async function selectBusinessMethodInteractively(args,options={},terminal={input:process.stdin,output:process.stdout}){
 assertWritableProcess(options);
 if(!terminal.input?.isTTY||!terminal.output?.isTTY)fail('finance_memory_interactive_required');
 if(!currentFinanceCall())return withFinanceCall({tool:'finance_local_method_selection',args,auditDir:configured(options).auditDir},()=>selectBusinessMethodInteractively(args,options,terminal));
 const {createInterface}=await import('node:readline/promises'),review=await readBusinessMethodLocally(args,options),rl=createInterface(terminal);
 terminal.output.write(json({账库身份:review.scope,方法版本:review.method,当前依据:review.state.evidence,说明:'确认仅保存企业方法选择；每次执行仍需原有来源、期间、写账人审及幂等保护。'}));
 try{
  const operator=(await rl.question('操作者姓名（声明）：')).trim(),reason=(await rl.question('核对依据与选择/变更理由：')).trim(),effectiveFrom=(await rl.question(`生效期间（回车使用 ${args.target.period}）：`)).trim()||args.target.period,effectiveTo=(await rl.question('终止期间（可留空，跨期延续）：')).trim();
  if(!operator||!reason||!period(effectiveFrom)||effectiveTo&&(!period(effectiveTo)||effectiveTo<effectiveFrom))fail('finance_memory_review_invalid');
  const localPlan=await readBusinessMethodLocally(args,options);
  const overlapping=localPlan.selections.filter(m=>(!m.effectiveTo||m.effectiveTo>=effectiveFrom)&&(!effectiveTo||m.effectiveFrom<=effectiveTo));
  terminal.output.write(json({生效冲突处理:'在当前期间重叠的选择中，仅最新选择revision生效；区间之外保留旧版适用性',受影响版本:overlapping.map(m=>({methodRef:m.methodRef,revision:m.revision,effectiveFrom:m.effectiveFrom,effectiveTo:m.effectiveTo??null}))}));
  const confirmation=await rl.question(`仅确认上述版本请输入「选择 ${args.methodRef}」，否则回车退出：`);if(confirmation!==`选择 ${args.methodRef}`)return {status:'cancelled'};
  return withMemory(args,options,true,async(connection,binding,storage,opts)=>{
   const current=storage.getBusinessMemoryMethod(connection,binding.scope,args.methodRef);if(!current||sha(current)!==review.reviewDigest)fail('finance_memory_review_changed');
   const observation=await currentObservation(args,opts,connection,binding,storage),state=methodState(current,observation,opts,args.target.period);if(state.evidence.some(e=>e.status!=='current'))fail('finance_memory_evidence_stale');
   if(executionView(current.definition?.execution).kind==='unavailable')fail('finance_memory_execution_missing');
   const prior=observation.storedMethods.filter(m=>m.topic===current.topic&&m.objectKey===current.objectKey&&m.authority==='operator_decision'&&m.effectiveFrom<=effectiveFrom&&(!m.effectiveTo||m.effectiveTo>=effectiveFrom)).sort((a,b)=>b.version-a.version)[0];
   const result=storage.appendBusinessMemoryMethodVersion(connection,binding.scope,{topic:current.topic,objectKey:current.objectKey,effectiveFrom,...(effectiveTo?{effectiveTo}:{}),authority:'operator_decision',definition:current.definition,...(current.configuration?{configuration:current.configuration}:{}),evidenceRefs:current.evidenceRefs,reason:json({operator,reason,selectedVersion:current.methodRef}),supersedes:prior?.methodRef??overlapping.sort((a,b)=>b.revision-a.revision)[0]?.methodRef??current.methodRef,replacementPolicy:'latest_selected_revision_in_effective_period',replaces:overlapping.map(m=>m.methodRef),expectedRevision:review.topicRevision,sourceFingerprint:observation.fingerprint});
   return {status:'selected',methodRef:result.methodRef,selectedVersion:current.methodRef,supersedes:result.supersedes,revision:result.revision,effectiveFrom,effectiveTo:effectiveTo||null};
  });
 }finally{rl.close();}
}
