// 同时约束领域投影及MCP text/structured双份包装；明细只经正常工具续页，不要求宿主Read持久化副本。
import {businessMemoryDigest as digest} from './business-memory-storage.mjs';
import {BASELINE_FACT_VALUES,BASELINE_DATE_FIELDS,BASELINE_PERIOD_FIELDS,BASELINE_AMOUNT_FIELDS,BASELINE_QUANTITY_FIELDS,BASELINE_FIELDS} from './business-baseline-contracts.mjs';

export const BASELINE_MATERIAL_PRETTY_MAX_BYTES=5000;
const list=value=>Array.isArray(value)?value:[];
const bytes=value=>Buffer.byteLength(JSON.stringify(value,null,2));
const fail=code=>{throw Object.assign(Error(code),{code});};
const wholeMcpBytes=(value,callId=value.materialRef)=>bytes({content:[{type:'text',text:JSON.stringify(value,null,2)}],structuredContent:value,_meta:{financeCall:{callId}}});
export const baselineSupportRef=(scope,p)=>'bp:'+digest({scope,kind:p.kind,value:p.value,when:p.when,allocationBasis:p.allocationBasis,evidenceRefs:[...p.evidenceRefs].sort()});
const taxView=({taxAmount,denominator,evidenceRefs,...value})=>value;
const supportView=({supportRef,kind,value,when,allocationBasis,authority})=>({supportRef,kind,value,when,...(allocationBasis?{allocationBasis}:{}),authority});
const factView=f=>({factRef:f.factRef,field:f.field,...(f.source.adaptation?{observationRef:'ao:'+(/^[a-f0-9]{64}$/.test(f.source.adaptation.physicalKey??'')?f.source.adaptation.physicalKey:digest(f.factRef))}:f.id?{id:f.id}:{}),...(f.group?{groupRef:'bg:'+digest(f.group)}:{}),...(Object.hasOwn(BASELINE_FACT_VALUES,f.field)||f.field==='creates_asset'?{value:f.value}:{valueState:'local_only'}),...(f.linkedBusinessRefs?{linkedBusinessRefs:f.linkedBusinessRefs}:{}),semanticAuthority:f.source.interpretation?'model_interpretation':f.source.adaptation?'script_history_observation_not_human_approval':f.field==='historical_posting'&&f.source.kind==='file'?'source_history_observation':f.semanticAuthority,source:{kind:f.source.kind,...(f.source.identity?{identity:f.source.identity}:{}),...(f.source.originalId?{originalId:f.source.originalId}:{})}});
const diagnosticCodes=new Set(['ambiguous_business_context','ambiguous_header','known_field_limit','formula_unverified','cell_error','value_not_provided','unsupported_alternative','outside_selected_tax_basis','ambiguous_field','unsupported_field','historical_account_unmapped']);
function diagnosticView(value){
 const code=diagnosticCodes.has(value?.code)||/^(?:finance_baseline_|material_document_|xlsx_|xls_|ocr_|adaptation_)[a-z0-9_]{1,80}$/.test(value?.code??'')?value.code:'material_diagnostic_unclassified';
 return {code,...(['read','mapping','adaptation'].includes(value?.stage)?{stage:value.stage}:{}),...(typeof value?.recoverable==='boolean'?{recoverable:value.recoverable}:{}),...(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value?.originalId??'')?{originalId:value.originalId}:{}),...(/^bs:[a-f0-9]{64}$/.test(value?.originalRef??'')?{originalRef:value.originalRef}:{}),...(/^ao:[a-f0-9]{64}$/.test(value?.observationRef??'')?{observationRef:value.observationRef}:{}),...(BASELINE_FIELDS.includes(value?.field)?{field:value.field}:{}),...(['warning','error'].includes(value?.severity)?{severity:value.severity}:{})};
}
const materialContractStep={tool:'finance_record_contract',arguments:{recordType:'baseline'},action:'inspect_mapping_and_local_adaptation_contract'};
const adaptationContractStep={tool:'finance_record_contract',arguments:{recordType:'baseline_adaptation'},action:'inspect_local_history_adaptation_contract'};
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
 const unselected=[...new Set(list(snapshot.coverage).flatMap(c=>c.knownFieldsNotSelected))],important=['business_reference','inventory_cost',...unselected],fields=[...new Set(important.filter(f=>unselected.includes(f)))],kinds=[...new Set(supports.map(p=>p.kind))];
 const taxHistory=Object.fromEntries(['vat','cit'].map(kind=>[kind,{status:snapshot.taxBurden.summaries.some(s=>s.taxType===kind)?'included':snapshot.facts.some(f=>f.field==='tax_type'&&f.value===kind)?'incomplete':'not_in_supplied_materials'}]));
 const adapted=snapshot.facts.filter(f=>f.source.adaptation),checked=snapshot.files.filter(file=>file.owner||snapshot.facts.some(f=>f.source.kind==='file'&&!f.source.adaptation&&f.source.path===file.path)).length,adaptedOnly=snapshot.files.filter(file=>!file.owner&&!snapshot.facts.some(f=>f.source.kind==='file'&&!f.source.adaptation&&f.source.path===file.path)&&adapted.some(f=>f.source.path===file.path)).length;
 const actual=selected.length?selected:supports,businessPrinciplesMissing=!actual.some(p=>!['accounting_standard','enterprise_class'].includes(p.kind)),configurationOnly=businessPrinciplesMissing&&!snapshot.taxBurden.summaries.length;
 return {configurationOnly,businessPrinciplesMissing,generationBasis:configurationOnly?'configuration_only':businessPrinciplesMissing?'configuration_and_tax_reference':'sources_and_history',historyEvidence:{ledgerPostings:snapshot.facts.filter(f=>f.field==='historical_posting'&&f.source.kind==='ledger_voucher').length,sourceObservations:snapshot.facts.filter(f=>f.field==='historical_posting'&&f.source.kind==='file').length,...(adapted.length?{adaptedObservations:adapted.filter(f=>f.field==='historical_posting').length}:{}),modelInterpretations:snapshot.facts.filter(f=>f.source.interpretation).length},scope:'actual_bound_scope',snapshotFacts:'all_read_facts_bound',valueVisibility:'local_only_not_missing',sourceCount:snapshot.files.length,sourceOwners:{checked,unverified:snapshot.files.length-checked,...(adaptedOnly?{scriptObservationMatched:adaptedOnly}:{})},factCount:snapshot.facts.length,requestCount:list(snapshot.requests).length||1,knownFieldsNotSelected:fields.slice(0,12),otherUnselectedFieldCount:Math.max(0,fields.length-12),unselectedLocationCount:list(snapshot.coverage).reduce((n,c)=>n+(c.unselectedLocationCount??0),0),diagnosticCount:list(snapshot.diagnostics).length,taxHistory,availablePrincipleKinds:kinds,...(selected.length?{selectedPrincipleKinds:[...new Set(selected.map(p=>p.kind))],supportedKindsNotSelected:kinds.filter(k=>!selected.some(p=>p.kind===k)),unselectedPrincipleBranches:baselineBranchSelection(supports,selected)}:{})};
}
function structures(snapshot){return list(snapshot.structures).flatMap(s=>[
 ...list(s.fields).map(field=>({originalId:s.originalId,format:s.format,ownerStatus:s.ownerStatus,sha256:s.sha256,...field})),
 ...list(s.columns).map(column=>({originalId:s.originalId,format:s.format,ownerStatus:s.ownerStatus,...column,rowCount:s.rowCount})),
 ...list(s.sheets).flatMap(sheet=>sheet.headers.map(header=>({originalId:s.originalId,format:s.format,ownerStatus:s.ownerStatus,sheetIndex:sheet.sheetIndex,rowCount:sheet.rowCount,...header}))),
 ...list(s.documentFields).map(field=>({originalId:s.originalId,locator:{fieldRef:field.fieldRef??field.locator?.fieldRef},type:field.type,suggestedFields:[],...(field.label?{label:field.label}:{}),...(field.semanticLabels?.length?{semanticLabels:field.semanticLabels}:{}),...(field.valueState&&field.valueState!=='source_extracted'?{valueState:field.valueState}:{}),...(field.position?{position:field.position}:{})})),
 ]);}

export function projectBaselineMaterials({base,snapshot,supports,args,inventory,discovery,calculationSchema}){
 const section=args.section??((args.materialRefs?.length||args.extractKnownFields||args.selections?.length)?'overview':args.originals?.length?'structure':'overview'),offset=args.offset??0,limit=args.limit??20;
 const adaptedRefs=new Set(snapshot.facts.filter(f=>f.source.adaptation).map(f=>f.source.originalRef).filter(Boolean));
 const diagnostics=list(snapshot.diagnostics).map(d=>{const value=diagnosticView(d);return value.stage==='read'&&adaptedRefs.has(value.originalRef)?{...value,recoveryState:'script_observation_available'}:value;}),failures=diagnostics.filter(d=>d.stage),sourceItems=inventory?.projection.items.map(item=>({...item,...(item.diagnostics?{diagnostics:item.diagnostics.map(diagnosticView)}:{})})),items=sourceItems??(section==='overview'?supports:section==='structure'?structures(snapshot):section==='facts'?snapshot.facts:section==='tax'?snapshot.taxBurden.summaries:section==='calculation'?calculationSchema.objects:list(snapshot.coverage).map(c=>({originalId:c.originalId,availableCount:c.availableCount,readCount:c.readCount,unselectedLocationCount:c.unselectedLocationCount,knownFieldsNotSelected:c.knownFieldsNotSelected})).concat(diagnostics));
 const total=sourceItems?inventory.projection.pagination.total:items.length,start=sourceItems?0:offset;
 const fullCoverage=baselineCoverage(snapshot,supports),coverage=section==='structure'?Object.fromEntries(['scope','sourceCount','sourceOwners','factCount','requestCount'].map(key=>[key,fullCoverage[key]])):section==='calculation'?Object.fromEntries(['scope','sourceCount','sourceOwners','factCount','requestCount','knownFieldsNotSelected','otherUnselectedFieldCount','unselectedLocationCount','diagnosticCount'].map(key=>[key,fullCoverage[key]])):fullCoverage,steps=[];
 if(section==='calculation')for(const key of ['knownFieldsNotSelected','otherUnselectedFieldCount','unselectedLocationCount','diagnosticCount'])if(Array.isArray(coverage[key])?!coverage[key].length:coverage[key]===0)delete coverage[key];
 if(section!=='calculation'&&section!=='structure'){
  if(discovery&&Object.entries(discovery.bypassed??{}).some(([k,n])=>['owner_unverified','no_known_fields','unsupported','runtime_unavailable'].includes(k)&&n>0))steps.push({tool:'finance_baseline_materials',action:'inspect_original_structure_and_supply_located_mapping',arguments:{target:args.target,section:'structure'}});
  if(sourceItems||coverage.knownFieldsNotSelected.length||coverage.otherUnselectedFieldCount)steps.push({...materialContractStep});
  if(Object.values(coverage.taxHistory).some(t=>t.status==='not_in_supplied_materials'))steps.push({action:'merge_explicit_successful_material_refs_for_tax_history'});
  if(!sourceItems&&section==='overview'&&supports.length)steps.push({action:'choose_returned_support_refs'});
 }
 if(failures.some(d=>d.recoverable&&(d.stage==='read'&&!d.recoveryState||d.stage==='adaptation'&&!['adaptation_business_unverified','adaptation_duplicate_observation'].includes(d.code))))steps.push({...adaptationContractStep,hint:'读取障碍可本机适配；位置失配补实际映射。主体、权限或原件变化须先核实，不以适配绕过。'});
 if(failures.some(d=>d.code==='adaptation_business_unverified')&&section!=='calculation')steps.push({tool:'finance_baseline_materials',arguments:{target:args.target,section:'structure'},action:'inspect_independent_originals_for_business_corroboration',hint:'查不同原件SHA中已核实的同一实际业务号及业务条件；重跑同脚本不能补足共证。'});
 const {baseline,semanticAuthority,...calculationBase}=base,visibleBase=section==='calculation'?calculationBase:section==='structure'?{version:base.version,target:base.target,scopeVerified:base.scopeVerified,materialRef:base.materialRef,snapshotDigest:base.snapshotDigest,modelBoundary:{rawValues:'local_only'}}:base;
 if(section==='calculation'){const {values,...reader}=calculationBase.calculationReader;calculationBase.calculationReader=reader;}
 let count=Math.min(limit,Math.max(0,items.length-start)),taxCount=Math.min(2,snapshot.taxBurden.summaries.length),deferCalculationReader=false,deferCalculationDiagnostics=false,result;
 while(count>=0){
  const page=items.slice(start,start+count),nextOffset=offset+count<total?offset+count:null;
  result={...visibleBase,section,coverage,...(!['calculation','structure'].includes(section)||snapshot.gaps.length?{gaps:snapshot.gaps}:{}),nextSteps:steps,pagination:{section,offset,limit:count,total,nextOffset},...(section!=='calculation'?{projectionBudget:{domainPrettyMaxBytes:BASELINE_MATERIAL_PRETTY_MAX_BYTES,mcpPrettyMaxBytes:12288}}:{})};
  // 失败按源保留且不抛弃成功分支；摘要只列首项，其余沿既有 coverage 页定向调查。
  if(failures.length&&section!=='coverage')result.sourceFailures={total:failures.length,items:failures.slice(0,1),next:{tool:'finance_baseline_materials',arguments:{target:args.target,materialRefs:[{materialRef:base.materialRef,snapshotDigest:base.snapshotDigest}],section:'coverage',offset:list(snapshot.coverage).length+diagnostics.findIndex(d=>d.stage),limit}}};
  if(discovery){
   const {scanLimits,unsupportedFormats,generatedFilesExcluded,...calculationDiscovery}=discovery;
   // 计算页保留真实覆盖及非零警示；零项技术统计不挤占规范对象的字段结构。
   if(!calculationDiscovery.depthTruncated)delete calculationDiscovery.depthTruncated;if(!calculationDiscovery.technicalScanLimited)delete calculationDiscovery.technicalScanLimited;
   calculationDiscovery.bypassed=Object.fromEntries(Object.entries(calculationDiscovery.bypassed).filter(([,n])=>n>0));if(!Object.keys(calculationDiscovery.bypassed).length)delete calculationDiscovery.bypassed;
   if(Object.values(unsupportedFormats??{}).some(n=>n>0))calculationDiscovery.unsupportedFormats=unsupportedFormats;if(generatedFilesExcluded>0)calculationDiscovery.generatedFilesExcluded=generatedFilesExcluded;
   result.sourceDiscovery={...(section==='calculation'?calculationDiscovery:discovery),...(discovery.remainingCount&&(section!=='calculation'||nextOffset===null)?{next:{tool:'finance_baseline_materials',arguments:{target:args.target,extractKnownFields:true,...(args.section?{section:args.section}:{}),sourceCursor:{materialRef:base.materialRef,snapshotDigest:base.snapshotDigest}}}}:{})};
  }
  if(sourceItems)result.sourceInventory={...inventory.projection,items:page,pagination:{...inventory.projection.pagination,limit:count,nextOffset}};
  else if(section==='overview'){
   result.principleSupport=page.map(supportView);
   const summaries=snapshot.taxBurden.summaries.slice(0,taxCount),nextTaxOffset=summaries.length<snapshot.taxBurden.summaries.length?summaries.length:null;
   result.taxBurden={summaries:summaries.map(taxView),missing:snapshot.taxBurden.missing,gaps:snapshot.taxBurden.gaps,meaning:snapshot.taxBurden.meaning,pagination:{offset:0,total:snapshot.taxBurden.summaries.length,nextOffset:nextTaxOffset,...(nextTaxOffset!==null?{next:{tool:'finance_baseline_materials',arguments:{target:args.target,materialRefs:[{materialRef:base.materialRef,snapshotDigest:base.snapshotDigest}],section:'tax',offset:nextTaxOffset,limit}}}:{})}};
  }else if(section==='structure'){
   result.fields=page;const ids=new Set(page.map(f=>f.originalId));
   const previouslySeen=new Set(items.slice(0,start).map(f=>f.originalId));
   result.documents=list(snapshot.structures).filter((s,i)=>ids.has(s.originalId)&&!previouslySeen.has(s.originalId)||offset===0&&!page.length&&i===0).map(s=>({originalId:s.originalId,format:s.format,readState:s.readState,ownerStatus:s.ownerStatus,identity:s.identity,extractor:s.extractor?{id:s.extractor.id,version:s.extractor.version,mode:s.extractor.mode,readerSha256:s.extractor.readerSha256}:undefined,pagination:s.documentPagination,...(s.structureNext?{structureNext:s.structureNext}:{}),...(s.pageNext?{pageNext:s.pageNext}:{}),diagnostics:list(s.readDiagnostics).map(diagnosticView)}));
  }
  else if(section==='facts')result.facts=page.map(factView);
  else if(section==='tax')result.taxBurden={summaries:page.map(taxView),missing:snapshot.taxBurden.missing,gaps:snapshot.taxBurden.gaps,meaning:snapshot.taxBurden.meaning};
  else if(section==='calculation')result.calculationSchema={...calculationSchema,objects:page};
  else result.details=page;
  result.coverage.detailPagePartial=nextOffset!==null;
  if(nextOffset!==null)result.pagination.next={tool:'finance_baseline_materials',arguments:{target:args.target,...(!sourceItems?{materialRefs:[{materialRef:base.materialRef,snapshotDigest:base.snapshotDigest}]}:{}),section,offset:nextOffset,limit}};
  // 当前对象页读完才给下一批来源；每一步只重复一个可执行next，不裁字段或放宽整包预算。
  if(section==='calculation'&&!failures.length)result.nextSteps=result.pagination.next||result.sourceDiscovery?.next?[]:[{action:'consume_reader_locally_by_actual_schema',hint:'按当前结构编写获授权的 script/title，再调用 finance_calculation_run。'}];
  if(deferCalculationReader){delete result.calculationReader;result.calculationReaderDeferredTo='calculation';}
  if(deferCalculationDiagnostics){delete result.sourceFailures.items;result.nextSteps=[];}
  if(bytes(result)<=BASELINE_MATERIAL_PRETTY_MAX_BYTES&&wholeMcpBytes(result)<=12288-128)break;
  // coverage及冲突反馈不能被预算吞掉。概览至少保留一个候选，税负摘要可独立正常续页。
  if(count<=1){
   // 最小计算对象仍超限时，重复诊断沿原 coverage 指针读；读取器、完整字段及分页留在本页。
   if(!sourceItems&&section==='calculation'&&count===1&&!deferCalculationDiagnostics&&result.sourceFailures?.next){deferCalculationDiagnostics=true;continue;}
   // 先延迟只供计算使用的读取器，保留候选、来源反馈和真实税负续页；计算页仍返回完整合同。
   if(!sourceItems&&section==='overview'&&!deferCalculationReader&&result.calculationReader){deferCalculationReader=true;continue;}
   if(!sourceItems&&section==='overview'&&taxCount>0){taxCount--;continue;}fail('finance_baseline_projection_item_limit');
  }count--;
 }
 return result;
}
