// 同时约束领域投影及MCP text/structured双份包装；明细只经正常工具续页，不要求宿主Read持久化副本。
import {businessMemoryDigest as digest} from './business-memory-storage.mjs';
import {BASELINE_FACT_VALUES,BASELINE_DATE_FIELDS,BASELINE_PERIOD_FIELDS,BASELINE_AMOUNT_FIELDS,BASELINE_QUANTITY_FIELDS} from './business-baseline-contracts.mjs';

export const BASELINE_MATERIAL_PRETTY_MAX_BYTES=5000;
const list=value=>Array.isArray(value)?value:[];
const bytes=value=>Buffer.byteLength(JSON.stringify(value,null,2));
const fail=code=>{throw Object.assign(Error(code),{code});};
const wholeMcpBytes=(value,callId=value.materialRef)=>bytes({content:[{type:'text',text:JSON.stringify(value,null,2)}],structuredContent:value,_meta:{financeCall:{callId}}});
export const baselineSupportRef=(scope,p)=>'bp:'+digest({scope,kind:p.kind,value:p.value,when:p.when,allocationBasis:p.allocationBasis,evidenceRefs:[...p.evidenceRefs].sort()});
const taxView=({taxAmount,denominator,evidenceRefs,...value})=>value;
const supportView=({supportRef,kind,value,when,allocationBasis,authority})=>({supportRef,kind,value,when,...(allocationBasis?{allocationBasis}:{}),authority});
const factView=f=>({factRef:f.factRef,field:f.field,...(f.id?{id:f.id}:{}),...(f.group?{groupRef:'bg:'+digest(f.group)}:{}),...(Object.hasOwn(BASELINE_FACT_VALUES,f.field)||f.field==='creates_asset'?{value:f.value}:{valueState:'local_only'}),...(f.linkedBusinessRefs?{linkedBusinessRefs:f.linkedBusinessRefs}:{}),source:{kind:f.source.kind,...(f.source.originalId?{originalId:f.source.originalId}:{})}});
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
 const items=objects.map(object=>{const kind=object.values.business_kind??null;counts.set(kind,(counts.get(kind)??0)+1);return {objectRef:object.objectRef,semanticValues:Object.fromEntries(Object.entries(object.values).filter(([key])=>semanticKeys.has(key))),fields:Object.fromEntries(Object.keys(object.values).sort().map(name=>[name,calculationFieldType(name)])),fieldPresence:'available',unlistedFieldState:'not_available_in_bound_object'};});
 return {version:'finance-baseline-calculation-schema/1',factSelection:'resolver_default',objectCount:objects.length,kindCounts:[...counts].map(([business_kind,count])=>({business_kind,count})),fieldTypes:{amount:{jsonType:'number'},quantity:{jsonType:'integer'},unit_price:{jsonType:'number'},date:{jsonType:'string',format:'YYYY-MM-DD',granularity:'day'},period:{jsonType:'string',format:'YYYY-MM',granularity:'month'},boolean:{jsonType:'boolean'},enum:{jsonType:'string'}},objects:items};
}
export function baselineCoverage(snapshot,supports=[],selected=[]){
 const unselected=[...new Set(list(snapshot.coverage).flatMap(c=>c.knownFieldsNotSelected))],important=['business_reference','inventory_cost',...unselected],fields=[...new Set(important.filter(f=>unselected.includes(f)))],kinds=[...new Set(supports.map(p=>p.kind))];
 const taxHistory=Object.fromEntries(['vat','cit'].map(kind=>[kind,{status:snapshot.taxBurden.summaries.some(s=>s.taxType===kind)?'included':snapshot.facts.some(f=>f.field==='tax_type'&&f.value===kind)?'incomplete':'not_in_supplied_materials'}]));
 const checked=snapshot.files.filter(file=>file.owner||snapshot.facts.some(f=>f.source.kind==='file'&&f.source.path===file.path)).length;
 return {scope:'actual_bound_scope',snapshotFacts:'all_read_facts_bound',valueVisibility:'local_only_not_missing',sourceCount:snapshot.files.length,sourceOwners:{checked,unverified:snapshot.files.length-checked},factCount:snapshot.facts.length,requestCount:list(snapshot.requests).length||1,knownFieldsNotSelected:fields.slice(0,12),otherUnselectedFieldCount:Math.max(0,fields.length-12),unselectedLocationCount:list(snapshot.coverage).reduce((n,c)=>n+(c.unselectedLocationCount??0),0),diagnosticCount:list(snapshot.diagnostics).length,taxHistory,availablePrincipleKinds:kinds,...(selected.length?{selectedPrincipleKinds:[...new Set(selected.map(p=>p.kind))],supportedKindsNotSelected:kinds.filter(k=>!selected.some(p=>p.kind===k)),unselectedPrincipleBranches:baselineBranchSelection(supports,selected)}:{})};
}
function structures(snapshot){return list(snapshot.structures).flatMap(s=>[
 ...list(s.fields).map(field=>({originalId:s.originalId,format:s.format,ownerStatus:s.ownerStatus,sha256:s.sha256,...field})),
 ...list(s.columns).map(column=>({originalId:s.originalId,format:s.format,ownerStatus:s.ownerStatus,...column,rowCount:s.rowCount})),
 ...list(s.sheets).flatMap(sheet=>sheet.headers.map(header=>({originalId:s.originalId,format:s.format,ownerStatus:s.ownerStatus,sheetIndex:sheet.sheetIndex,rowCount:sheet.rowCount,...header}))),
 ]);}
export function projectBaselineMaterials({base,snapshot,supports,args,inventory,discovery,calculationSchema}){
 const section=args.section??((args.materialRefs?.length||args.extractKnownFields||args.selections?.length)?'overview':args.originals?.length?'structure':'overview'),offset=args.offset??0,limit=args.limit??20;
 const sourceItems=inventory?.projection.items,items=sourceItems??(section==='overview'?supports:section==='structure'?structures(snapshot):section==='facts'?snapshot.facts:section==='tax'?snapshot.taxBurden.summaries:section==='calculation'?calculationSchema.objects:list(snapshot.coverage).map(c=>({originalId:c.originalId,availableCount:c.availableCount,readCount:c.readCount,unselectedLocationCount:c.unselectedLocationCount,knownFieldsNotSelected:c.knownFieldsNotSelected})).concat(list(snapshot.diagnostics)));
 const total=sourceItems?inventory.projection.pagination.total:items.length,start=sourceItems?0:offset;
 const fullCoverage=baselineCoverage(snapshot,supports),coverage=section==='calculation'?Object.fromEntries(['scope','sourceCount','sourceOwners','factCount','requestCount','knownFieldsNotSelected','otherUnselectedFieldCount','unselectedLocationCount','diagnosticCount'].map(key=>[key,fullCoverage[key]])):fullCoverage,steps=[];
 if(section==='calculation')for(const key of ['knownFieldsNotSelected','otherUnselectedFieldCount','unselectedLocationCount','diagnosticCount'])if(Array.isArray(coverage[key])?!coverage[key].length:coverage[key]===0)delete coverage[key];
 if(section!=='calculation'){
  if(sourceItems||coverage.knownFieldsNotSelected.length||coverage.otherUnselectedFieldCount)steps.push({tool:'finance_baseline_materials',action:'extract_known_fields_for_explicit_originals'});
  if(Object.values(coverage.taxHistory).some(t=>t.status==='not_in_supplied_materials'))steps.push({tool:'finance_baseline_materials',action:'merge_explicit_successful_material_refs_for_tax_history'});
  if(!sourceItems&&section==='overview'&&supports.length)steps.push({tool:'finance_baseline_save',action:'choose_returned_support_refs'});
 }
 const {baseline,semanticAuthority,...calculationBase}=base,visibleBase=section==='calculation'?calculationBase:base;
 if(section==='calculation'){const {values,...reader}=calculationBase.calculationReader;calculationBase.calculationReader=reader;}
 let count=Math.min(limit,Math.max(0,items.length-start)),taxCount=Math.min(2,snapshot.taxBurden.summaries.length),result;
 while(count>=0){
  const page=items.slice(start,start+count),nextOffset=offset+count<total?offset+count:null;
  result={...visibleBase,section,coverage,...(section!=='calculation'||snapshot.gaps.length?{gaps:snapshot.gaps}:{}),nextSteps:steps,pagination:{section,offset,limit:count,total,nextOffset},...(section!=='calculation'?{projectionBudget:{domainPrettyMaxBytes:BASELINE_MATERIAL_PRETTY_MAX_BYTES,mcpPrettyMaxBytes:12288}}:{})};
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
  }else if(section==='structure')result.fields=page;
  else if(section==='facts')result.facts=page.map(factView);
  else if(section==='tax')result.taxBurden={summaries:page.map(taxView),missing:snapshot.taxBurden.missing,gaps:snapshot.taxBurden.gaps,meaning:snapshot.taxBurden.meaning};
  else if(section==='calculation')result.calculationSchema={...calculationSchema,objects:page};
  else result.details=page;
  result.coverage.detailPagePartial=nextOffset!==null;
  if(nextOffset!==null)result.pagination.next={tool:'finance_baseline_materials',arguments:{target:args.target,...(!sourceItems?{materialRefs:[{materialRef:base.materialRef,snapshotDigest:base.snapshotDigest}]}:{}),section,offset:nextOffset,limit}};
  // 当前对象页读完才给下一批来源；每一步只重复一个可执行next，不裁字段或放宽整包预算。
  if(section==='calculation')result.nextSteps=result.pagination.next||result.sourceDiscovery?.next?[]:[{tool:'finance_calculation_run',action:'consume_reader_locally_by_actual_schema'}];
  if(bytes(result)<=BASELINE_MATERIAL_PRETTY_MAX_BYTES&&wholeMcpBytes(result)<=12288-128)break;
  // coverage及冲突反馈不能被预算吞掉。概览至少保留一个候选，税负摘要可独立正常续页。
  if(count<=1){if(!sourceItems&&section==='overview'&&taxCount>0){taxCount--;continue;}fail('finance_baseline_projection_item_limit');}count--;
 }
 return result;
}
