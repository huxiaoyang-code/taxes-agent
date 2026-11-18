// 同时约束领域投影及MCP text/structured双份包装；明细只经正常工具续页，不要求宿主Read持久化副本。
import {businessMemoryDigest as digest} from './business-memory-storage.mjs';
import {BASELINE_FACT_VALUES,BASELINE_DATE_FIELDS,BASELINE_PERIOD_FIELDS,BASELINE_AMOUNT_FIELDS,BASELINE_QUANTITY_FIELDS,BASELINE_FIELDS,baselineHostObservationNext} from './business-baseline-contracts.mjs';

export const BASELINE_MATERIAL_PRETTY_MAX_BYTES=5000;
const list=value=>Array.isArray(value)?value:[];
const bytes=value=>Buffer.byteLength(JSON.stringify(value,null,2));
const fail=code=>{throw Object.assign(Error(code),{code});};
const wholeMcpBytes=(value,callId=value.materialRef)=>bytes({content:[{type:'text',text:JSON.stringify(value,null,2)}],structuredContent:value,_meta:{financeCall:{callId}}});
export const baselineSupportRef=(scope,p)=>'bp:'+digest({scope,kind:p.kind,value:p.value,when:p.when,allocationBasis:p.allocationBasis,evidenceRefs:[...p.evidenceRefs].sort()});
const taxView=({taxAmount,denominator,evidenceRefs,...value})=>value;
const supportView=({supportRef,kind,value,when,allocationBasis,authority})=>({supportRef,kind,value,when,...(allocationBasis?{allocationBasis}:{}),authority});
function factView(f){
 const {source}=f,agent=source.agentArtifact!==undefined;
 const authority=agent?'agent_observation':source.interpretation?'model_interpretation':
  source.adaptation?'script_history_observation_not_human_approval':
  f.field==='historical_posting'&&source.kind==='file'?'source_history_observation':f.semanticAuthority;
 return {factRef:f.factRef,field:f.field,...(f.group?{groupRef:'bg:'+digest(f.group)}:{}),
  ...(Object.hasOwn(BASELINE_FACT_VALUES,f.field)||f.field==='creates_asset'?{value:f.value}:{valueState:'local_only'}),
  ...(f.linkedBusinessRefs?{linkedBusinessRefs:f.linkedBusinessRefs}:{}),semanticAuthority:authority,
  source:{kind:source.kind,...(source.identity?{identity:source.identity}:{}),...(source.originalId?{originalId:source.originalId}:{})}};
}
const diagnosticCodes=new Set(['owner_unverified','unsupported_field','tax_basis_incomplete','historical_account_unmapped','historical_business_unlinked',
 'ambiguous_business_context','ambiguous_header','known_field_limit','formula_unverified','cell_error','value_not_provided','unsupported_alternative',
 'outside_selected_tax_basis','ambiguous_field']);
function diagnosticView(value){
 const code=diagnosticCodes.has(value?.code)||/^(?:finance_baseline_|material_document_|xlsx_|xls_|ocr_|adaptation_)[a-z0-9_]{1,80}$/.test(value?.code??'')?value.code:'material_diagnostic_unclassified';
 return {code,...(['observation','read','mapping','adaptation'].includes(value?.stage)?{stage:value.stage}:{}),
  ...(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value?.originalId??'')?{originalId:value.originalId}:{}),
  ...(BASELINE_FIELDS.includes(value?.field)?{field:value.field}:{}),
  ...(['warning','error'].includes(value?.severity)?{severity:value.severity}:{})};
}
const branchTuple=p=>({kind:p.kind,value:p.value,when:p.when??'account_set',...(p.allocationBasis?{allocationBasis:p.allocationBasis}:{})});
function branchKey(p){const tuple=branchTuple(p);if(tuple.allocationBasis==='monthly_equal'&&(tuple.kind==='expense_period'&&tuple.value==='benefit_period'||tuple.kind==='cost_treatment'&&tuple.value==='allocate_benefit_period'))return digest({...tuple,kind:'expense_period',value:'benefit_period'});return digest(tuple);}
export function baselineBranchSelection(supports,selected,{basis='checked_material_catalog',complete=true,limit=4}={}){
 const chosen=new Set(selected.map(branchKey)),remaining=new Map();
 for(const p of supports){const key=branchKey(p);if(!chosen.has(key)&&(!remaining.has(key)||p.kind==='expense_period'))remaining.set(key,branchTuple(p));}
 const all=[...remaining.values()];return {basis,complete,items:all.slice(0,limit),omittedCount:Math.max(0,all.length-limit)};
}
// 保存/回读的分支反馈不扩大短常驻；整包紧张时只缩该提示，准确保留省略计数。
export function fitBaselineBranchResponse(value,callId){
 const branch=value.coverage?.unselectedPrincipleBranches;if(!branch)return value;
 const result={...value,coverage:{...value.coverage,unselectedPrincipleBranches:{...branch,items:[...branch.items]}}},visible=result.coverage.unselectedPrincipleBranches;
 while(wholeMcpBytes(result,callId)>12288-128&&visible.items.length){visible.items.pop();visible.omittedCount++;}
 if(wholeMcpBytes(result,callId)>12288-128)fail('finance_baseline_projection_item_limit');return result;
}
function calculationFieldType(name){
 if(BASELINE_DATE_FIELDS.includes(name))return 'date';if(BASELINE_PERIOD_FIELDS.includes(name))return 'period';if(BASELINE_QUANTITY_FIELDS.includes(name))return 'quantity';if(['opening_unit_price','receipt_unit_price'].includes(name))return 'unit_price';if(BASELINE_AMOUNT_FIELDS.includes(name))return 'amount';if(name==='creates_asset')return 'boolean';if(Object.hasOwn(BASELINE_FACT_VALUES,name))return 'enum';fail('finance_baseline_calculation_field_invalid');
}
export function baselineCalculationSchema(objects){
 const counts=new Map(),semanticKeys=new Set(['business_kind','service_pattern','tax_type','tax_measure','tax_stage','period_basis','accumulation','creates_asset']);
 const items=objects.map(object=>{const kind=object.values.business_kind??null;counts.set(kind,(counts.get(kind)??0)+1);return {objectRef:object.objectRef,...(object.sourceIdentity?.length?{sourceIdentity:object.sourceIdentity}:{}),semanticValues:Object.fromEntries(Object.entries(object.values).filter(([key])=>semanticKeys.has(key))),fields:Object.fromEntries(Object.keys(object.values).sort().map(name=>[name,calculationFieldType(name)])),fieldPresence:'available',unlistedFieldState:'not_available_in_bound_object'};});
 return {version:'finance-baseline-calculation-schema/1',factSelection:'resolver_default',objectCount:objects.length,kindCounts:[...counts].map(([business_kind,count])=>({business_kind,count})),fieldTypes:{amount:{jsonType:'number'},quantity:{jsonType:'integer'},unit_price:{jsonType:'number'},date:{jsonType:'string',format:'YYYY-MM-DD',granularity:'day'},period:{jsonType:'string',format:'YYYY-MM',granularity:'month'},boolean:{jsonType:'boolean'},enum:{jsonType:'string'}},objects:items};
}
export function baselineCoverage(snapshot,supports=[],selected=[]){
 const {facts,files}=snapshot,kinds=[...new Set(supports.map(p=>p.kind))];
 const taxHistory=Object.fromEntries(['vat','cit'].map(kind=>[kind,{status:snapshot.taxBurden.summaries.some(s=>s.taxType===kind)?'included':facts.some(f=>f.field==='tax_type'&&f.value===kind)?'incomplete':'not_in_supplied_materials'}]));
 const historical=facts.filter(f=>f.field==='historical_posting'),agentFacts=facts.filter(f=>f.source.agentArtifact);
 const nativePaths=new Set(files.filter(f=>f.readState!=='agent_observation'&&f.owner).map(f=>f.path));
 for(const f of facts)if(f.source.kind==='file'&&!f.source.agentArtifact&&!f.source.adaptation)nativePaths.add(f.source.path);
 const hostPaths=new Set(agentFacts.filter(f=>!nativePaths.has(f.source.path)).map(f=>f.source.path));
 const actual=selected.length?selected:supports,businessPrinciplesMissing=!actual.some(p=>!['accounting_standard','enterprise_class'].includes(p.kind));
 const configurationOnly=businessPrinciplesMissing&&!snapshot.taxBurden.summaries.length;
 return {configurationOnly,businessPrinciplesMissing,generationBasis:configurationOnly?'configuration_only':businessPrinciplesMissing?'configuration_and_tax_reference':'sources_and_history',
  historyEvidence:{ledgerPostings:historical.filter(f=>f.source.kind==='ledger_voucher').length,
   sourceObservations:historical.filter(f=>f.source.kind==='file').length,
   agentObservations:historical.filter(f=>f.source.agentArtifact).length,
   modelInterpretations:facts.filter(f=>f.source.interpretation).length},
  scope:'actual_bound_scope',snapshotFacts:'accepted_observations_and_ledger_facts',valueVisibility:'local_only_not_missing',
  sourceCount:files.length,sourceOwners:{checked:nativePaths.size,agentIdentityMatched:hostPaths.size,unverified:files.length-nativePaths.size-hostPaths.size},
  factCount:facts.length,requestCount:list(snapshot.requests).length||1,diagnosticCount:list(snapshot.diagnostics).length,
  taxHistory,availablePrincipleKinds:kinds,
  ...(selected.length?{selectedPrincipleKinds:[...new Set(selected.map(p=>p.kind))],
   supportedKindsNotSelected:kinds.filter(k=>!selected.some(p=>p.kind===k)),
   unselectedPrincipleBranches:baselineBranchSelection(supports,selected,{basis:'material_catalog'})}:{})};
}

function materialNext(base,target,section,offset,limit){
 return {tool:'finance_baseline_materials',arguments:{target,
  materialRefs:[{materialRef:base.materialRef,snapshotDigest:base.snapshotDigest}],section,offset,limit}};
}
function coverageItems(snapshot){
 return snapshot.files.map(file=>({originalId:file.id,sourceObservation:file.readState==='agent_observation'?'agent_observation':'prior_material_record',
  ...(file.declaredCount===undefined?{}:{declaredCount:file.declaredCount}),
  acceptedCount:snapshot.facts.filter(f=>f.source.kind==='file'&&f.source.path===file.path).length}));
}

export function projectBaselineMaterials({base,snapshot,supports,args,calculationSchema}){
 const section=args.section??'overview',offset=args.offset??0,limit=args.limit??20;
 const diagnostics=list(snapshot.diagnostics).map(diagnosticView);
 const details=section==='coverage'?coverageItems(snapshot):[];
 const sections={overview:supports,facts:snapshot.facts,tax:snapshot.taxBurden.summaries,
  coverage:[...details,...diagnostics],calculation:calculationSchema?.objects};
 const items=sections[section],total=items.length;
 const fullCoverage=baselineCoverage(snapshot,supports);
 const coverage=section==='calculation'?Object.fromEntries(['scope','sourceCount','sourceOwners','factCount','requestCount','diagnosticCount'].map(key=>[key,fullCoverage[key]])):fullCoverage;
 const steps=[];
 if(section!=='calculation'){
  if(!snapshot.files.length||diagnostics.length)steps.push(baselineHostObservationNext());
  if(section==='overview'&&supports.length)steps.push({action:'choose_returned_support_refs'});
 }
 const {baseline,semanticAuthority,...calculationBase}=base;
 const visibleBase=section==='calculation'?calculationBase:base;
 if(section==='calculation'){
  // 计算页已声明原值留在本机，reader只需提供实际定位和版本。
  const {values,...reader}=calculationBase.calculationReader;
  calculationBase.calculationReader=reader;
 }
 const tax=snapshot.taxBurden;
 const taxMetadata={missing:tax.missing,gaps:tax.gaps,meaning:tax.meaning};
 const selectedDiagnostics=diagnostics.length&&section!=='coverage'?
  {total:diagnostics.length,items:diagnostics.slice(0,1),next:materialNext(base,args.target,'coverage',snapshot.files.length,limit)}:null;
 let count=Math.min(limit,Math.max(0,total-offset)),taxCount=Math.min(2,tax.summaries.length);
 let deferReader=false,deferDiagnostics=false;
 for(;;){
  const page=items.slice(offset,offset+count),nextOffset=offset+count<total?offset+count:null;
  const result={...visibleBase,section,coverage:{...coverage,detailPagePartial:nextOffset!==null},gaps:snapshot.gaps,
   nextSteps:steps,pagination:{section,offset,limit:count,total,nextOffset}};
  if(section!=='calculation')result.projectionBudget={domainPrettyMaxBytes:BASELINE_MATERIAL_PRETTY_MAX_BYTES,mcpPrettyMaxBytes:12288};
  if(nextOffset!==null)result.pagination.next=materialNext(base,args.target,section,nextOffset,limit);
  if(selectedDiagnostics){
   const {items,...summary}=selectedDiagnostics;
   result.sourceFailures=deferDiagnostics?summary:selectedDiagnostics;
  }
  if(section==='overview'){
   result.principleSupport=page.map(supportView);
   const summaries=tax.summaries.slice(0,taxCount),nextTaxOffset=summaries.length<tax.summaries.length?summaries.length:null;
   result.taxBurden={summaries:summaries.map(taxView),...taxMetadata,
    pagination:{offset:0,total:tax.summaries.length,nextOffset:nextTaxOffset,
     ...(nextTaxOffset===null?{}:{next:materialNext(base,args.target,'tax',nextTaxOffset,limit)})}};
  }else if(section==='facts')result.facts=page.map(factView);
  else if(section==='tax')result.taxBurden={summaries:page.map(taxView),...taxMetadata};
  else if(section==='calculation')result.calculationSchema={...calculationSchema,objects:page};
  else result.details=page;
  if(deferReader){delete result.calculationReader;result.calculationReaderDeferredTo='calculation';}
  if(bytes(result)<=BASELINE_MATERIAL_PRETTY_MAX_BYTES&&wholeMcpBytes(result)<=12288-128)return result;
  if(count>1){count--;continue;}
  // 有实际分页和诊断入口，单条事实及计算字段完整保留。
  if(section==='calculation'&&selectedDiagnostics&&!deferDiagnostics){deferDiagnostics=true;continue;}
  if(section==='overview'&&!deferReader){deferReader=true;continue;}
  if(section==='overview'&&taxCount>0){taxCount--;continue;}
  fail('finance_baseline_projection_item_limit');
 }
}
