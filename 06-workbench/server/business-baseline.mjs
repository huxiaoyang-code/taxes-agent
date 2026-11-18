// 四宿主共用的短业务基线。模型提炼受限原则，后端核对实际来源及版本；不授予人审或写账权限。
import {DatabaseSync} from 'node:sqlite';
import {join,dirname,resolve,basename,extname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync,readFileSync,readdirSync,lstatSync} from 'node:fs';
import {validateSchemaValue} from './harness-schema-validation.mjs';
import {resolveBusinessMemoryTarget} from './business-memory.mjs';
import {currentFinanceCall,withFinanceCall,annotateFinanceCall,financeAuditDirectory,readFinanceCall,financeCallCreatedDirectory} from './finance-call-chain.mjs';
import * as storage from './business-memory-storage.mjs';
import {AGENT_MATERIALS_SUBDIRECTORY,baselineHostObservationNext,BASELINE_INTERFACE,BASELINE_TOPIC,BASELINE_VALUES,BASELINE_LABELS,BASELINE_FACT_VALUES,BASELINE_DATE_FIELDS,BASELINE_PERIOD_FIELDS,BASELINE_AMOUNT_FIELDS,BASELINE_QUANTITY_FIELDS,BUSINESS_BASELINE_SCHEMAS} from './business-baseline-contracts.mjs';
import {baselineBytes,baselineInside,baselineDirectoryAvailable,baselineDirectoryIdentity,captureBaselineMaterials,mergeBaselineMaterialSnapshots,baselineLedgerFact,buildBaselineTaxBurden,groupBaselineMaterialFacts,baselineScalarMaterialFacts,baselineSnapshotDigest,materialRegistryDigest} from './business-baseline-materials.mjs';
import {projectBaselineMaterials,baselineCoverage,baselineSupportRef,baselineBranchSelection,fitBaselineBranchResponse,baselineCalculationSchema} from './business-baseline-projection.mjs';
import {assertAuditSchema} from './local-audit-storage.mjs';
import {inspectRestoreControl,readRestoreActivation,assertRestoreOpenPath} from './local-restore-control.mjs';
import {registeredMaterialIdentity} from './material-identity.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const digest=storage.businessMemoryDigest;
const sha=b=>createHash('sha256').update(b).digest('hex');
const list=value=>Array.isArray(value)?value:[];
const unicode=value=>Array.from(value).length;
const same=(a,b)=>storage.canonicalBusinessMemory(a)===storage.canonicalBusinessMemory(b);
const owner=scope=>[scope.databaseInstanceId,scope.enterpriseKey,scope.accountSetId];
const BASELINE_READER_SHA256=sha(readFileSync(new URL(import.meta.url)));
const calculationReader=()=>({moduleUrl:import.meta.url,sha256:BASELINE_READER_SHA256,exportName:'resolveBaselineCalculationFacts',version:'finance-baseline-calculation-facts/1',values:'local_calculation_only_not_model_projection'});
function configured(options={}){return {...options,dbPath:options.dbPath??process.env.FINANCE_DATABASE_PATH,sourceRoot:options.sourceRoot??process.env.FINANCE_SOURCE_ROOT,auditDir:options.auditDir??currentFinanceCall()?.auditDir??financeAuditDirectory()};}
function validate(name,args){if(validateSchemaValue(BUSINESS_BASELINE_SCHEMAS[name],args).length)fail('finance_baseline_input_invalid');}
function writable(options){if(options.readOnly||process.env.WORKBENCH_DATABASE_MODE==='readonly')fail('finance_baseline_readonly');}
function scopeBinding(args,options){const binding=resolveBusinessMemoryTarget(args.target,options);assertRestoreOpenPath(binding.dbPath);annotateFinanceCall({scope:binding.scope,configuredTarget:{databasePath:binding.dbPath,accountSetId:binding.scope.accountSetId,period:binding.scope.period,bindingOrigin:binding.bindingOrigin}});return binding;}
function checkComponent(db){const state=storage.inspectBusinessMemorySchema(db);if(state.state==='not_installed')return false;if(!state.ok)fail('finance_memory_schema_inconsistent');return true;}
function baselineInstances(db,scope){
 const allowed=new Set([scope.databaseInstanceId]),active=db.prepare('SELECT * FROM audit_database_instances WHERE instance_id=? AND is_active=1').get(scope.databaseInstanceId);if(!active)fail('finance_baseline_scope_conflict');
 if(active.parent_instance_id!==null){
  assertAuditSchema(db);const state=inspectRestoreControl(db);if(!state.ok||state.row.write_state!=='ready')fail('finance_baseline_restore_unverified');const activation=readRestoreActivation(db);if(activation.auditInstanceId!==scope.databaseInstanceId)fail('finance_baseline_restore_unverified');
  let next=active;while(next.parent_instance_id!==null){if(next.note_code!=='restore-new'||allowed.has(next.parent_instance_id))fail('finance_baseline_restore_unverified');allowed.add(next.parent_instance_id);next=db.prepare('SELECT * FROM audit_database_instances WHERE instance_id=?').get(next.parent_instance_id);if(!next)fail('finance_baseline_restore_unverified');}
 }return allowed;
}
function versions(db,scope){if(!checkComponent(db))return [];const allowed=baselineInstances(db,scope);return db.prepare('SELECT content_json,database_instance_id FROM business_memory_versions WHERE account_set_id=? AND enterprise_key=? AND topic=? AND object_key=? ORDER BY revision DESC').all(scope.accountSetId,scope.enterpriseKey,BASELINE_TOPIC,'account-set').filter(r=>allowed.has(r.database_instance_id)).map(r=>JSON.parse(r.content_json));}
function selectedVersion(db,scope){const all=versions(db,scope);return {all,current:all.find(v=>v.effectiveFrom<=scope.period&&(!v.effectiveTo||v.effectiveTo>=scope.period))??null};}
const savedVersionView=(version,period)=>({baselineRef:version.methodRef,revision:version.revision,effectiveFrom:version.effectiveFrom,...(version.effectiveTo?{effectiveTo:version.effectiveTo}:{}),applicableToTarget:version.effectiveFrom<=period&&(!version.effectiveTo||version.effectiveTo>=period)});
const sourceKey=source=>digest(source);
function agentArtifactCurrent(artifact){
 return basename(artifact.root)===AGENT_MATERIALS_SUBDIRECTORY&&extname(artifact.path).toLowerCase()==='.json'&&
  sha(baselineBytes(artifact.path,artifact.root))===artifact.sha256;
}
function factStates(db,definition,opts){
 const cache=new Map(),artifacts=new Map(),roots=new Map(),out=new Map(),rootFacts=root=>{if(!roots.has(root))roots.set(root,{available:baselineDirectoryAvailable(root),identity:baselineDirectoryIdentity(root),created:financeCallCreatedDirectory(root)});return roots.get(root);};
 let registryDigest;
 // 目录身份只辅助区分ENOENT；已有文件仍按实际SHA核对，不把目录inode当作业务真实性。
 const missingState=(root,expected,error)=>{const current=rootFacts(root);return error.code==='ENOENT'&&current.available&&!current.created&&typeof expected==='string'&&expected===current.identity?'missing':'unavailable';};for(const f of list(definition.facts)){
  const s=f.source,key=sourceKey(s);let state=cache.get(key);
  if(!state){
   if(s.kind==='file'){
    if(!rootFacts(opts.sourceRoot).available||!baselineInside(opts.sourceRoot,s.path))state='unavailable';
    else try{state=sha(baselineBytes(s.path,opts.sourceRoot))===s.sha256?'current':'changed';}catch(error){state=missingState(opts.sourceRoot,s.rootIdentity,error);}
    if(state==='current'&&s.registryDigest){
     registryDigest??=materialRegistryDigest(registeredMaterialIdentity(db,definition.scope));
     if(registryDigest!==s.registryDigest)state='changed';
    }
    if(state==='current'&&s.agentArtifact){
     const artifact=s.agentArtifact,key=digest(artifact);let current=artifacts.get(key);
     if(!current){
      try{current=agentArtifactCurrent(artifact)?'current':'changed';}
      catch(error){current=missingState(artifact.root,artifact.rootIdentity,error);}
      artifacts.set(key,current);
     }
     state=current;
    }
    if(state==='current'&&s.adaptation)for(const file of s.adaptation.artifacts){
     const root=s.adaptation.recordRoot,key=digest([root,file]);let current=artifacts.get(key);
     if(!current){try{current=baselineInside(root,file.path)&&sha(baselineBytes(file.path,root,{max:20*1024*1024}))===file.sha256?'current':'changed';}catch(error){current=missingState(root,s.adaptation.recordRootIdentity,error);}artifacts.set(key,current);}
     if(current!=='current'){state=current;break;}
    }
    if(state==='current'&&s.adaptation)for(const file of s.adaptation.sourceDependencies){
     const key=digest([opts.sourceRoot,file]);let current=artifacts.get(key);
     if(!current){try{current=baselineInside(opts.sourceRoot,file.path)&&sha(baselineBytes(file.path,opts.sourceRoot))===file.sha256?'current':'changed';}catch(error){current=missingState(opts.sourceRoot,s.rootIdentity,error);}artifacts.set(key,current);}
     if(current!=='current'){state=current;break;}
    }
   }else {const actual=baselineLedgerFact(db,definition.scope,s);state=actual===null?'missing':actual===s.sha256?'current':'changed';
    if(state==='current')for(const relation of s.relations??[]){
     const op=db.prepare('SELECT state FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=?').get(definition.scope.databaseInstanceId,relation.operationId,relation.attempt);
     if(!['succeeded','no_change'].includes(op?.state)){state='changed';break;}
     const root=relation.recordRoot??join(dirname(opts.dbPath),'posting-attempts');
     if(!rootFacts(root).available){state='unavailable';break;}
     for(const file of relation.files){try{if(!baselineInside(root,file.path))fail('finance_baseline_record_invalid');if(sha(baselineBytes(file.path,root,{max:20*1024*1024}))!==file.sha256)state='changed';}catch(error){state=missingState(root,relation.recordRootIdentity,error);}}
    }
   }
   cache.set(key,state);
  }out.set(f.factRef,state);
 }return out;
}
function preserveRecordedInvalidation(definition,current,scope){
 if(![...current.values()].includes('unavailable'))return current;const observations=[];
 for(const root of list(definition.observationRoots)){try{
  if(lstatSync(root).isSymbolicLink())continue;const names=readdirSync(root).filter(n=>/^\d{8}T\d{9}Z_[a-f0-9-]{36}$/.test(n)).sort().reverse().slice(0,5000);
  for(const name of names){try{
   const dir=join(root,name),beginBytes=baselineBytes(join(dir,'begin.json'),root),endBytes=baselineBytes(join(dir,'end.json'),root),begin=JSON.parse(beginBytes),end=JSON.parse(endBytes),observation=end.metadata?.businessBaselineObservation;
   if(!['finance_baseline_read','finance_baseline_materials'].includes(begin.tool)||begin.callId!==name||end.callId!==name||end.status!=='returned'||end.beginSha256!==sha(beginBytes)||end.scopeState!=='observed'||observation?.baselineRef!==definition.baselineRef||end.scope.enterpriseKey!==scope.enterpriseKey||end.scope.accountSetId!==scope.accountSetId||!definition.instanceLineage.includes(end.scope.databaseInstanceId)||end.output?.file!=='result.json')continue;
   const outputBytes=baselineBytes(join(dir,'result.json'),root),output=JSON.parse(outputBytes);if(sha(outputBytes)!==end.output.sha256||(begin.tool==='finance_baseline_read'?output.baselineRef:output.baseline?.baselineRef)!==definition.baselineRef)continue;
   const input=baselineBytes(join(dir,'input.json'),root);if(sha(input)!==begin.input.sha256)continue;observations.push({finishedAt:end.finishedAt,states:observation.states});
  }catch{/* 不完整记录不作为已知失效的证据。 */}}
 }catch{/* 历史记录不可访问保持unavailable，不冒称重新核实。 */}}
 observations.sort((a,b)=>b.finishedAt.localeCompare(a.finishedAt));
 for(const [ref,state]of current)if(state==='unavailable'){const latest=observations.find(o=>Array.isArray(o.states)&&o.states.some(s=>s.factRef===ref));const old=latest?.states.find(s=>s.factRef===ref)?.state;if(['changed','missing'].includes(old))current.set(ref,old);}
 return current;
}
function choiceCurrent(p,facts,period){
 if(p.kind!=='tax_choice')return true;const fs=facts.filter(f=>!p.evidenceRefs||p.evidenceRefs.includes(f.factRef));
 return fs.filter(f=>f.field==='tax_choice'&&f.value===p.value).some(policy=>{const g=fs.filter(f=>f.group===policy.group),from=field(g,'choice_valid_from'),through=field(g,'choice_valid_through'),last=new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7)),0)).toISOString().slice(0,10);return from&&through&&from<=period+'-01'&&through>=last;});
}
const fixedGaps=(values)=>{const rank={source_changed:0,source_missing:1,historical_conflict:2};return [...new Map(values.map(v=>[v.code+':'+(v.kind??''),v])).values()].sort((a,b)=>(rank[a.code]??3)-(rank[b.code]??3)).slice(0,3);};
const taxStageLabel={payable_before_relief:'优惠前应纳',payable_after_relief:'减免后应纳',balance_due:'应补',paid:'实缴'};
const percent=n=>(n*100).toFixed(2)+'%';
function taxText(tax){
 const parts=[];for(const t of tax.summaries){
  const dimension=taxStageLabel[t.stage]+(t.periodBasis==='payment'?'缴款期':'所属期');
  if(t.taxType==='vat')parts.push(`增值税${t.from}至${t.through}${dimension}/可比销售额加权${percent(t.weightedRatio)}（${percent(t.minimumRatio)}～${percent(t.maximumRatio)}）`);
  else parts.push(`所得税截至${t.through}${t.accumulation==='cumulative'?'累计':'本期'}${dimension}/收入${percent(t.weightedRatio)}`);
 }return parts.length?parts.join('；')+'，仅作历史参考，不作倒挤目标':'';
}
// 只摘要本原则所选业务的关联费用行；同凭证其他业务及其他原则的证据不能补充归集角色。
function historicalExpenseText(p,facts){
 if(p.kind!=='business_classification'||p.value!=='actual_use_expense')return null;
 const fs=list(facts).filter(f=>list(p.evidenceRefs).includes(f.factRef)),labels={management_expense:'管理费用',sales_expense:'销售费用',finance_expense:'财务费用'},roles=new Set();
 for(const g of groupFacts(fs,p.when)){
  if(field(g,'creates_asset')!==false)continue;const refs=g.filter(f=>f.field==='business_reference').map(f=>f.factRef);
  for(const h of fs.filter(f=>usableHistoricalEvidence(f,fs,refs)&&f.linkedBusinessRefs?.some(ref=>refs.includes(ref))))for(const entry of businessEntries(h,refs))if(Object.hasOwn(labels,entry.role)&&entry.debit-entry.credit>0)roles.add(entry.role);
 }
 return roles.size===1?`沿${fs.some(f=>f.source.adaptation||f.source.agentArtifact)?'有出处历史':'已核历史'}${labels[[...roles][0]]}归集，用途变化另核`:null;
}
function ruleText(p,facts){const condition=p.when==='account_set'?'':BASELINE_LABELS[p.when]+'：',monthly=p.allocationBasis==='monthly_equal'?p.kind==='revenue_period'?'整月均匀服务按月等额确认':['expense_period','cost_treatment'].includes(p.kind)?'整月均匀受益的非资产服务按月等额分摊':null:null;return condition+(historicalExpenseText(p,facts)??monthly??BASELINE_LABELS[p.value]);}
export function renderBusinessBaseline(definition,scope,{principles=definition.principles,taxBurden=definition.taxBurden}={}){
 const groups=[['accounting_standard','enterprise_class','business_classification','inventory_cost'],['revenue_period'],['expense_period','cost_treatment'],['vat_output_period'],['vat_input_period'],['income_tax_period'],['tax_choice']];
 const names=['准则','收入','费用与资产边界','销项所属期','进项所属期','所得税计税收入所属期','有效税务选择'];
 const lines=[];groups.forEach((kinds,i)=>{const ps=principles.filter(p=>kinds.includes(p.kind));if(ps.length){const first=i===0?[ps.some(p=>p.kind==='accounting_standard')?'准则':null,ps.some(p=>p.kind==='enterprise_class')?'企业类型':null,ps.some(p=>p.kind==='business_classification')?'业务归类':null,ps.some(p=>p.kind==='inventory_cost')?'成本计价':null].filter(Boolean).join('、'):names[i];lines.push(first+'：'+ps.map(p=>ruleText(p,definition.facts)).join('；'));}});
 const history=taxText(taxBurden);if(history)lines.push('税负参考：'+history);
 const applicable=`账套${scope.accountSetId}；适用${definition.effectiveFrom}${definition.effectiveTo?'至'+definition.effectiveTo:'起'}。`;
 const shortText=lines.length?applicable+'\n'+lines.map((t,i)=>`${i+1}. ${t}。`).join('\n'):'';
 if(lines.length>8||unicode(shortText)>600)fail('finance_baseline_text_limit');return shortText;
}
function view(db,scope,target,opts){
 const base={version:'finance-business-baseline/1',target,scopeVerified:true,headRevision:0,revision:0,baselineRef:null,shortText:'',unresolved:[],authorizesPosting:false,modelBoundary:{mode:'fixed_business_projection',rawValues:'local_only'}};
 const {all,current}=selectedVersion(db,scope);if(!all.length)return {...base,status:'needs_generation',nextSteps:[baselineHostObservationNext()]};
 const latest=all[0];base.headRevision=latest.revision;if(!current)return {...base,status:'outside_effective_period',revision:latest.revision,baselineRef:latest.methodRef,unresolved:[{code:'outside_effective_period'}],nextSteps:[baselineHostObservationNext()]};
 const d=current.definition,instances=baselineInstances(db,scope);if(d.interfaceVersion!==BASELINE_INTERFACE||d.scope.enterpriseKey!==scope.enterpriseKey||d.scope.accountSetId!==scope.accountSetId||!instances.has(d.scope.databaseInstanceId))fail('finance_baseline_record_invalid');
 const states=preserveRecordedInvalidation({...d,baselineRef:current.methodRef,instanceLineage:[...instances]},factStates(db,d,opts),scope),bad=refs=>refs.some(ref=>states.get(ref)!=='current');
 annotateFinanceCall({businessBaselineObservation:{baselineRef:current.methodRef,states:[...states].map(([factRef,state])=>({factRef,state}))}});
 const proofCurrent=p=>{const fs=d.facts.filter(f=>p.evidenceRefs.includes(f.factRef));return (p.kind!=='accounting_standard'&&!['checked_historical_inference','source_history_inference','adapted_history_inference','agent_history_inference','agent_policy_observation'].includes(p.authority)||supportedPrinciple(p,fs,scope))&&(p.allocationBasis!=='monthly_equal'||monthlyEqualBasis(p,fs));};
 const affected=d.principles.filter(p=>bad(p.evidenceRefs)||!choiceCurrent(p,d.facts,scope.period)||!proofCurrent(p)),usable=d.principles.filter(p=>!bad(p.evidenceRefs)&&choiceCurrent(p,d.facts,scope.period)&&proofCurrent(p));
 const tax={...d.taxBurden,summaries:d.taxBurden.summaries.filter(t=>!bad(t.evidenceRefs))};
 const changed=[...states.values()].some(s=>s==='changed'||s==='missing'),unavailable=[...states.values()].some(s=>s==='unavailable');
 const businessPrinciplesMissing=!d.principles.some(p=>!['accounting_standard','enterprise_class'].includes(p.kind)),configurationOnly=businessPrinciplesMissing&&!d.taxBurden.summaries.length;
 const unresolved=fixedGaps([...d.unresolved,...(businessPrinciplesMissing?[{code:'historical_evidence_missing'}]:[]),...affected.map(p=>({code:!choiceCurrent(p,d.facts,scope.period)?'outside_effective_period':p.evidenceRefs.some(r=>states.get(r)==='changed')?'source_changed':p.evidenceRefs.some(r=>states.get(r)==='missing')?'source_missing':bad(p.evidenceRefs)?'source_unavailable':p.kind==='accounting_standard'?'policy_unverified':'historical_evidence_missing',kind:p.kind})),...(!affected.length&&changed?[{code:[...states.values()].includes('changed')?'source_changed':'source_missing'}]:unavailable&&!affected.length?[{code:'source_unavailable'}]:[])]);
 const status=changed?'stale':unavailable||unresolved.length?'needs_review':'ready';
 const storedBranches=d.coverage?.unselectedPrincipleBranches,branches=storedBranches?{...storedBranches,basis:'saved_material_catalog'}:baselineBranchSelection(principleSupport(d.facts.filter(f=>states.get(f.factRef)==='current'),scope),d.principles,{basis:'retained_current_evidence_subset',complete:false});
 const coverage={...(d.coverage??{}),configurationOnly,businessPrinciplesMissing,generationBasis:configurationOnly?'configuration_only':businessPrinciplesMissing?'configuration_and_tax_reference':'sources_and_history',...(d.coverage?.taxHistory?{taxHistory:Object.fromEntries(['vat','cit'].map(kind=>[kind,{status:tax.summaries.some(t=>t.taxType===kind)?'included':d.taxBurden.summaries.some(t=>t.taxType===kind)?'source_not_current':d.coverage.taxHistory[kind].status}]))}:{}),unselectedPrincipleBranches:branches};
 return fitBaselineBranchResponse({...base,status,revision:current.revision,baselineRef:current.methodRef,shortText:renderBusinessBaseline(d,scope,{principles:usable,taxBurden:tax}),unresolved,coverage,nextSteps:status==='ready'?[]:[baselineHostObservationNext()]},currentFinanceCall()?.callId);
}
export async function readBusinessBaseline(args,options={}){
 validate('finance_baseline_read',args);const opts=configured(options);
 // 已保存基线的安全观察沿固定受信记录根接续；换当前auditDir不能把后续changed记录到不可接续的另一根。
 let observationRoot=opts.auditDir;
 try{const binding=resolveBusinessMemoryTarget(args.target,opts),probe=new DatabaseSync(binding.dbPath,{readOnly:true});try{const selected=selectedVersion(probe,binding.scope).current,root=selected?.definition.observationRoots?.[0];if(typeof root==='string'&&lstatSync(root).isDirectory()&&!lstatSync(root).isSymbolicLink())observationRoot=root;}finally{probe.close();}}catch{/* 真实准入错误由下方已留痕的调用按原码拒绝。 */}
 if(!currentFinanceCall()||resolve(currentFinanceCall().auditDir)!==resolve(observationRoot))return withFinanceCall({tool:'finance_baseline_read',args,auditDir:observationRoot},()=>readBusinessBaseline(args,{...opts,auditDir:observationRoot}));
 const binding=scopeBinding(args,opts),db=new DatabaseSync(binding.dbPath,{readOnly:true});
 try{storage.assertBusinessMemoryScope(db,binding.scope);db.exec('BEGIN');const result=view(db,binding.scope,args.target,opts);db.exec('COMMIT');return result;}finally{db.close();}
}
export async function readBaselineMaterials(args,options={}){
 validate('finance_baseline_materials',args);const opts=configured(options);
 // 标准调用记录是唯一写入；账库、原件及企业索引始终只读，直接调用也取得可核的真实materialRef。
 if(!currentFinanceCall())return withFinanceCall({tool:'finance_baseline_materials',args,auditDir:opts.auditDir},()=>readBaselineMaterials(args,opts));
 const binding=scopeBinding(args,opts),db=new DatabaseSync(binding.dbPath,{readOnly:true});
 try{storage.assertBusinessMemoryScope(db,binding.scope);db.exec('BEGIN');
  const parents=[];
  for(const ref of args.materialRefs??[])parents.push(await materialSnapshot(ref,args,db,binding,opts));
  const request=args.inputPath||!parents.length?leafMaterialRequest(args):null;
  const fresh=request?{...captureBaselineMaterials(db,binding.scope,request,{...opts,dbPath:binding.dbPath}),requests:[request]}:null;
  const parts=fresh?[...parents,fresh]:parents;
  const snapshot=mergeBaselineMaterialSnapshots(parts);
  snapshot.requests=flatMaterialRequests(parts);
  db.exec('COMMIT');
  const catalog=principleSupport(snapshot.facts,binding.scope).map(p=>({...p,supportRef:baselineSupportRef(binding.scope,p)})),inherited=[];
  for(const parent of parents)for(const candidate of parent.supportSelections??[]){const p={...candidate,evidenceRefs:candidate.evidenceRefs.map(ref=>snapshot.factAliases[ref]??ref)},fs=p.evidenceRefs.map(ref=>snapshot.facts.find(f=>f.factRef===ref));if(fs.every(Boolean)&&supportedPrinciple(p,fs,binding.scope)&&(!p.allocationBasis||monthlyEqualBasis(p,fs)))inherited.push(p);}
  // 材料工具发现基线失效同样是可信观察；跨audit根时复用既有read在固定受信根留痕，材料ref仍留外层原调用根。
  const current=await readBusinessBaseline({target:args.target},opts),base={version:'finance-baseline-materials/1',target:args.target,scopeVerified:true,materialRef:currentFinanceCall().callId,snapshotDigest:snapshot.snapshotDigest,calculationReader:calculationReader(),baseline:{status:current.status,revision:current.revision,baselineRef:current.baselineRef},semanticAuthority:snapshot.artifacts.length?'agent_observation':'source_observation_not_human_approval',modelBoundary:{mode:'fixed_business_projection',rawValues:'local_only'}};
  const calculationSchema=args.section==='calculation'?baselineCalculationSchema(calculationObjects(snapshot.facts,binding.scope,{factAliases:snapshot.factAliases})):null;
  const projection=projectBaselineMaterials({base,snapshot,supports:catalog,args,calculationSchema}),returned=new Set((projection.principleSupport??[]).map(p=>p.supportRef));
  snapshot.supportSelections=[...new Map([...inherited,...catalog.filter(p=>returned.has(p.supportRef))].map(p=>[p.supportRef,p])).values()];snapshot.supportCatalog=catalog;
  annotateFinanceCall({sources:[
   ...snapshot.files.map(f=>({path:f.path,sha256:f.sha256,bytes:f.bytes,locator:'baseline_original_digest'})),
   ...snapshot.artifacts.map(f=>({path:f.path,sha256:f.sha256,bytes:f.bytes,locator:'baseline_host_observations'})),
  ]});
  const bytes=Buffer.from(JSON.stringify({version:'finance-baseline-materials-snapshot/2',...snapshot},null,2)+'\n');
  if(bytes.length>20*1024*1024)fail('finance_baseline_material_limit');
  const artifact={file:'baseline-materials.json',sha256:sha(bytes),bytes:bytes.length,snapshotDigest:snapshot.snapshotDigest};
  writeFileSync(join(currentFinanceCall().recordPath,artifact.file),bytes,{flag:'wx',mode:0o600});annotateFinanceCall({businessBaselineMaterials:artifact});
  return projection;
 }finally{db.close();}
}
function requireFactEvidence(principle,factMap){const fs=principle.evidenceRefs.map(ref=>factMap.get(ref));if(fs.some(f=>!f))fail('finance_baseline_evidence_missing');return fs;}
function groupFacts(fs,when){return [...groupBaselineMaterialFacts(fs).values()].filter(g=>{const scalars=baselineScalarMaterialFacts(g);return scalars.some(f=>f.field==='business_kind'&&f.value===when)&&!scalars.some((f,i)=>scalars.slice(0,i).some(other=>f.field===other.field&&!same(f.value,other.value)));});}
const field=(fs,key)=>fs.find(f=>f.field===key)?.value;
function interval(fs){const start=field(fs,'service_start'),end=field(fs,'service_end');if(!start||!end||start>end)return null;const last=new Date(Date.UTC(Number(end.slice(0,4)),Number(end.slice(5,7)),0)).toISOString().slice(0,10);if(!start.endsWith('-01')||end!==last)return null;const months=(Number(end.slice(0,4))-Number(start.slice(0,4)))*12+Number(end.slice(5,7))-Number(start.slice(5,7))+1;return {start,end,months};}
function businessEntries(posting,businessRefs){
 const indices=new Set(list(posting.source.relations).filter(r=>businessRefs.includes(r.businessRef)).flatMap(r=>list(r.entryIndices)).filter(i=>Number.isSafeInteger(i)&&i>=0));
 return posting.value.entries.filter((entry,index)=>indices.has(index));
}
function usableHistoricalEvidence(posting,facts,businessRefs){
 if(posting.field!=='historical_posting'||!['posted','observed_history'].includes(posting.value.status))return false;
 if(!posting.source.agentArtifact&&!posting.source.adaptation)return true;
 // 原件历史观察需要另一份独立业务原件的业务号作为共证。
 return facts.some(f=>f.field==='business_reference'&&f.source.kind==='file'&&!f.source.adaptation&&!f.source.agentHistoryPosition&&
  (f.verification==='source_value_bound'||posting.source.agentArtifact&&f.verification==='agent_observation')&&
  f.source.sha256!==posting.source.sha256&&businessRefs.includes(f.factRef)&&posting.linkedBusinessRefs?.includes(f.factRef));
}
function historySupports(fs,role,amount,{start,end,minimumPeriods=1,date:exactDate,businessRefs=[]}={}){
 const matches=fs.filter(f=>usableHistoricalEvidence(f,fs,businessRefs)&&(!start||f.value.period>=start.slice(0,7))&&(!end||f.value.period<=end.slice(0,7))&&(!exactDate||(f.value.date?.slice(0,7)??f.value.period)===exactDate.slice(0,7))).filter(f=>{
  if(!businessRefs.length||!f.linkedBusinessRefs?.some(ref=>businessRefs.includes(ref)))return false;
  const n=businessEntries(f,businessRefs).filter(e=>role==='income'?['main_income','other_income'].includes(e.role):e.role===role).reduce((n,e)=>n+(role==='income'||role==='main_income'||role==='tax_payable'?e.credit-e.debit:e.debit-e.credit),0);
  return Math.abs(n-amount)<0.011;
 });return new Set(matches.map(f=>f.value.period)).size>=minimumPeriods;
}
function monthlyEqualBasis(p,fs){
 const revenue=p.kind==='revenue_period'&&p.value==='service_period',expense=p.kind==='expense_period'&&p.value==='benefit_period'||p.kind==='cost_treatment'&&p.value==='allocate_benefit_period';if(!revenue&&!expense)return false;
 return groupFacts(fs,p.when).some(g=>{const span=interval(g),amount=field(g,'amount_net'),businessRefs=g.filter(f=>f.field==='business_reference').map(f=>f.factRef);return span?.months>1&&field(g,'service_pattern')==='even_service'&&(revenue||field(g,'creates_asset')===false)&&amount>0&&historySupports(fs,revenue?'income':'management_expense',amount/span.months,{...span,minimumPeriods:2,businessRefs});});
}
function supportedPrinciple(p,fs,scope){
 if(!BASELINE_VALUES[p.kind]?.includes(p.value))fail('finance_baseline_principle_invalid');
 if(p.kind==='accounting_standard'&&p.when!=='account_set'||p.kind==='enterprise_class'&&p.when!=='account_set'||p.kind==='inventory_cost'&&!['account_set','inventory'].includes(p.when))return false;
 if(!['accounting_standard','enterprise_class','inventory_cost'].includes(p.kind)&&fs.filter(f=>f.field===p.kind).some(f=>f.source.contextBusinessKinds?.length&&!f.source.contextBusinessKinds.includes(p.when)))return false;
 const direct=fs.some(f=>f.field===p.kind&&f.value===p.value&&!f.source.interpretation);
 if(p.kind==='accounting_standard')return fs.some(f=>f.field===p.kind&&f.value===p.value&&f.source.kind==='ledger_configuration');
 if(p.kind==='tax_choice'){
  if(!direct)return false;return choiceCurrent(p,fs,scope.period)&&(p.when==='account_set'||groupFacts(fs,p.when).some(g=>g.some(f=>f.field==='tax_choice'&&f.value===p.value)));
 }
 if(['inventory_cost','enterprise_class','income_tax_period'].includes(p.kind))return direct;
 // 会计准则采用权责发生原则；不从历史开票/收款分录自动编译现金或发票确认政策。
 if(p.kind==='revenue_period'&&['invoice_date','receipt_date'].includes(p.value))return false;
 if(direct&&p.when!=='account_set'&&!['vat_output_period','business_classification'].includes(p.kind))return groupFacts(fs,p.when).length>0;
 if(p.kind==='cost_treatment'&&p.value==='capitalize_then_depreciate'&&p.when==='fixed_asset')return fs.some(f=>f.field==='asset_configuration'&&f.value.kind==='fixed'&&f.value.originalCost>0&&f.value.usefulLifeMonths>0);
 if(p.kind==='cost_treatment'&&p.value==='capitalize_then_amortize'&&p.when==='intangible_asset')return fs.some(f=>f.field==='asset_configuration'&&f.value.kind==='intangible'&&f.value.originalCost>0&&f.value.usefulLifeMonths>0);
 for(const g of groupFacts(fs,p.when)){
  const span=interval(g),amount=field(g,'amount_net'),even=field(g,'service_pattern')==='even_service',businessRefs=g.filter(f=>f.field==='business_reference').map(f=>f.factRef);
  if(p.kind==='business_classification'&&p.when!=='account_set'){
   const linked=fs.filter(f=>usableHistoricalEvidence(f,fs,businessRefs)&&f.linkedBusinessRefs?.some(ref=>businessRefs.includes(ref)));
   if(['main_income','other_income'].includes(p.value)&&linked.some(f=>businessEntries(f,businessRefs).some(e=>e.role===p.value&&e.credit-e.debit>0))&&!linked.some(f=>businessEntries(f,businessRefs).some(e=>['main_income','other_income'].includes(e.role)&&e.role!==p.value&&e.credit-e.debit>0)))return true;
   if(p.value==='actual_use_expense'&&field(g,'creates_asset')===false&&linked.some(f=>businessEntries(f,businessRefs).some(e=>['management_expense','sales_expense','finance_expense'].includes(e.role)&&e.debit-e.credit>0)))return true;
  }
  if(p.kind==='revenue_period'&&p.value==='service_period'&&['lease','service','repair','maintenance'].includes(p.when)&&span?.months>1&&even&&amount>0&&historySupports(fs,'income',amount/span.months,{...span,minimumPeriods:2,businessRefs}))return true;
  if((p.kind==='expense_period'&&p.value==='benefit_period'||p.kind==='cost_treatment'&&p.value==='allocate_benefit_period')&&span?.months>1&&even&&field(g,'creates_asset')===false&&amount>0&&historySupports(fs,'management_expense',amount/span.months,{...span,minimumPeriods:2,businessRefs}))return true;
  if(p.kind==='revenue_period'&&p.value==='delivery_acceptance'&&field(g,'service_pattern')==='point_in_time'&&field(g,'delivery_date')&&amount>0&&historySupports(fs,'income',amount,{date:field(g,'delivery_date'),businessRefs}))return true;
  if(p.kind==='cost_treatment'&&p.value==='expense_current'&&field(g,'creates_asset')===false&&amount>0&&(span?.months===1&&historySupports(fs,'management_expense',amount,{...span,businessRefs})||field(g,'service_pattern')==='point_in_time'&&field(g,'delivery_date')&&historySupports(fs,'management_expense',amount,{date:field(g,'delivery_date'),businessRefs})))return true;
  if(p.kind==='vat_output_period'&&p.value==='advance_invoice_period'&&p.when==='lease'){
   const invoice=field(g,'invoice_date'),receipt=field(g,'receipt_date'),tax=field(g,'amount_tax');
   if(span?.months>1&&invoice&&receipt&&tax>0&&invoice<=span.start&&receipt<=invoice&&historySupports(fs,'tax_payable',tax,{date:invoice,businessRefs}))return true;
  }
  if(p.kind==='vat_input_period'&&p.value==='confirmation_period'){
   const confirmed=field(g,'confirmation_date'),tax=field(g,'amount_tax');
   if(confirmed&&tax>0&&fs.some(f=>usableHistoricalEvidence(f,fs,businessRefs)&&f.value.period===confirmed.slice(0,7)&&f.linkedBusinessRefs?.some(ref=>businessRefs.includes(ref))&&businessEntries(f,businessRefs).some(e=>e.role==='tax_payable'&&Math.abs(e.debit-e.credit-tax)<0.011)))return true;
  }
 }return false;
}
function principleAuthority(kind,value,facts){
 const direct=facts.find(f=>f.field===kind&&f.value===value&&!f.source.interpretation);
 if(direct)return direct.source.agentArtifact?'agent_policy_observation':'source_bound_policy';
 if(facts.some(f=>f.source.agentArtifact))return 'agent_history_inference';
 if(facts.some(f=>f.field==='historical_posting'&&f.source.adaptation))return 'adapted_history_inference';
 return facts.some(f=>f.field==='historical_posting'&&f.value.status==='observed_history')?'source_history_inference':'checked_historical_inference';
}
function principleSupport(facts,scope){
 const support=[],historical=facts.filter(f=>f.field==='historical_posting'),assets=facts.filter(f=>f.field==='asset_configuration');
 for(const [kind,values]of Object.entries(BASELINE_VALUES))for(const value of values){
  const direct=facts.filter(f=>f.field===kind&&f.value===value),groups=[...groupBaselineMaterialFacts(facts).values()];
  const candidates=[{when:'account_set',fs:[...direct,...facts.filter(f=>['choice_valid_from','choice_valid_through'].includes(f.field))]}];
  for(const fs of groups){const when=field(fs,'business_kind'),refs=fs.filter(f=>f.field==='business_reference').map(f=>f.factRef);if(when)candidates.push({when,fs:[...new Map([...fs,...historical.filter(h=>h.linkedBusinessRefs?.some(ref=>refs.includes(ref)))].map(f=>[f.factRef,f])).values()]});}
  for(const when of ['fixed_asset','intangible_asset'])candidates.push({when,fs:assets});
  for(const {when,fs}of candidates){if(!fs.length)continue;const p={kind,value,when};if(supportedPrinciple(p,fs,scope)&&!support.some(s=>s.kind===kind&&s.value===value&&s.when===when)){
   const monthly=monthlyEqualBasis(p,fs);let proof=[...fs];for(const f of fs){const reduced=proof.filter(v=>v.factRef!==f.factRef);if(supportedPrinciple(p,reduced,scope)&&(!monthly||monthlyEqualBasis(p,reduced)))proof=reduced;}
   if(proof.length<=40)support.push({...p,...(monthly?{allocationBasis:'monthly_equal'}:{}),evidenceRefs:proof.map(f=>f.factRef),authority:principleAuthority(kind,value,proof)});
  }}
 }return support.slice(0,24);
}
function validatePrinciples(principles,facts,scope){
 const map=new Map(facts.map(f=>[f.factRef,f])),out=[];
 for(const input of principles){const p={...input,when:input.when??'account_set',evidenceRefs:[...input.evidenceRefs].sort()},fs=requireFactEvidence(p,map);
  if(!supportedPrinciple(p,fs,scope))fail('finance_baseline_principle_unsupported');
  const monthly=monthlyEqualBasis(p,fs);if(p.allocationBasis==='monthly_equal'&&!monthly)fail('finance_baseline_principle_unsupported');if(monthly)p.allocationBasis='monthly_equal';
  if(out.some(prior=>prior.kind===p.kind&&prior.when===p.when&&prior.value!==p.value&&!(p.kind==='business_classification'&&[prior.value,p.value].includes('actual_use_expense'))))fail('finance_baseline_principle_conflict');
  if(!out.some(prior=>prior.kind===p.kind&&prior.when===p.when&&prior.value===p.value))out.push({...p,authority:principleAuthority(p.kind,p.value,fs)});
 }
 return out.sort((a,b)=>a.kind.localeCompare(b.kind)||a.when.localeCompare(b.when));
}
async function materialSnapshot(reference,args,db,binding,opts){
 let record;
 try{record=await readFinanceCall({auditDir:opts.auditDir,callId:reference.materialRef});}
 catch{fail('finance_baseline_material_record_invalid');}
 const verified=record.tool==='finance_baseline_materials'&&record.integrity==='verified'&&record.status==='returned'&&
  record.end?.scopeState==='observed'&&same(record.end.scope,binding.scope)&&record.output?.materialRef===reference.materialRef&&
  record.output?.snapshotDigest===reference.snapshotDigest;
 if(!verified)fail('finance_baseline_material_record_invalid');
 if(!same(record.input.target,args.target))fail('finance_baseline_scope_conflict');
 const artifact=record.end.metadata?.businessBaselineMaterials;
 if(artifact?.file!=='baseline-materials.json'||artifact.snapshotDigest!==reference.snapshotDigest||
    !Number.isSafeInteger(artifact.bytes)||artifact.bytes<=0||artifact.bytes>20*1024*1024)fail('finance_baseline_material_record_invalid');
 let stored;
 try{
  const bytes=baselineBytes(join(record.recordPath,artifact.file),opts.auditDir,{max:20*1024*1024});
  if(bytes.length!==artifact.bytes||sha(bytes)!==artifact.sha256)fail('finance_baseline_material_record_invalid');
  stored=JSON.parse(bytes);
 }catch{fail('finance_baseline_material_record_invalid');}
 if(!['finance-baseline-materials-snapshot/1','finance-baseline-materials-snapshot/2'].includes(stored.version)||
    stored.snapshotDigest!==reference.snapshotDigest||!same(stored.scope,binding.scope)||
    !Array.isArray(stored.facts)||!Array.isArray(stored.files)||baselineSnapshotDigest(stored)!==reference.snapshotDigest)fail('finance_baseline_material_record_invalid');
 const requests=stored.requests??[leafMaterialRequest(record.input)];
 if(!Array.isArray(requests)||!requests.length||requests.length>12||
    requests.some(request=>!request||request.materialRefs||request.sourceCursor||!same(request.target,args.target)))fail('finance_baseline_material_record_invalid');
 // 已留痕的旧快照和新产物快照均用当前字节及账库事实核对，接续时不重复解析原件。
 try{
  const changedAtEnd=new Set(list(record.end.sourceChanges).map(source=>source.path));
  for(const file of stored.files){
   if(changedAtEnd.has(file.path)||sha(baselineBytes(file.path,opts.sourceRoot))!==file.sha256)fail('finance_baseline_material_changed');
  }
  for(const source of list(stored.artifacts)){
   if(changedAtEnd.has(source.path)||!agentArtifactCurrent(source))fail('finance_baseline_material_changed');
  }
  if([...factStates(db,stored,opts).values()].some(state=>state!=='current'))fail('finance_baseline_material_changed');
 }catch{fail('finance_baseline_material_changed');}
 return {...stored,requests,supportSelections:list(stored.supportSelections)};
}
function leafMaterialRequest(args){
 return {target:args.target,...(args.inputPath?{inputPath:args.inputPath}:{}),
  ...(args.historyOffset!==undefined?{historyOffset:args.historyOffset}:{}),...(args.historyLimit!==undefined?{historyLimit:args.historyLimit}:{})};
}
function flatMaterialRequests(snapshots){const requests=[...new Map(snapshots.flatMap(s=>s.requests).map(r=>[digest(r),r])).values()];if(requests.length>12)fail('finance_baseline_material_merge_limit');return requests;}
// 规范对象只有一个分组器；模型侧结构与本机resolver默认事实集共用它，原值只留本机。
function calculationObjects(facts,scope,{factRefs,factAliases={}}={}){
 const scalarFiles=baselineScalarMaterialFacts(facts).filter(f=>f.source.kind==='file'&&f.field!=='business_reference'),requested=new Set((factRefs??scalarFiles.map(f=>f.factRef)).map(ref=>factAliases[ref]??ref));
 if([...requested].some(ref=>!scalarFiles.some(f=>f.factRef===ref)))fail('finance_baseline_reader_fact_invalid');
 const allowed=new Set([...Object.keys(BASELINE_FACT_VALUES),...BASELINE_DATE_FIELDS,...BASELINE_PERIOD_FIELDS,...BASELINE_AMOUNT_FIELDS,...BASELINE_QUANTITY_FIELDS,'creates_asset']),objects=[];
 for(const [key,fs]of groupBaselineMaterialFacts(facts)){const values={},evidenceRefs=[];for(const f of fs){if(!requested.has(f.factRef)||!allowed.has(f.field))continue;if(Object.hasOwn(values,f.field)&&!same(values[f.field],f.value))fail('finance_baseline_reader_fact_conflict');values[f.field]=f.value;evidenceRefs.push(f.factRef);}if(evidenceRefs.length)objects.push({objectRef:'bg:'+digest([owner(scope),key]),values,evidenceRefs,sourceIdentity:[...new Map(fs.filter(f=>f.source.identity).map(f=>[digest(f.source.identity),f.source.identity])).values()]});}
 return objects;
}
// 本机计算器取数桥：不注册MCP原值工具；业务脚本只能消费真实已读且当前仍一致的规范事实。
export async function resolveBaselineCalculationFacts(args,options={}){
 const schema={type:'object',additionalProperties:false,required:['target','materialRefs','expectedReaderSha256'],properties:{target:BUSINESS_BASELINE_SCHEMAS.finance_baseline_read.properties.target,materialRefs:BUSINESS_BASELINE_SCHEMAS.finance_baseline_save.properties.materialRefs,expectedReaderSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},factRefs:{type:'array',maxItems:400,uniqueItems:true,items:{type:'string',pattern:'^bf:[a-f0-9]{64}$'}}}};
 if(validateSchemaValue(schema,args).length)fail('finance_baseline_reader_input_invalid');const reader=calculationReader();if(reader.sha256!==args.expectedReaderSha256)fail('finance_baseline_reader_version_conflict');
 const opts=configured(options),binding=scopeBinding(args,opts),db=new DatabaseSync(binding.dbPath,{readOnly:true});
 try{
  storage.assertBusinessMemoryScope(db,binding.scope);const snapshots=[];for(const ref of args.materialRefs){baselineBytes(join(opts.auditDir,ref.materialRef,'begin.json'),opts.auditDir);snapshots.push(await materialSnapshot(ref,args,db,binding,opts));}
  flatMaterialRequests(snapshots);const merged=mergeBaselineMaterialSnapshots(snapshots),objects=calculationObjects(merged.facts,binding.scope,{factRefs:args.factRefs,factAliases:merged.factAliases});
  return {version:reader.version,scopeVerified:true,target:args.target,objects,reader,materialRefs:args.materialRefs,sourceDigests:[...new Map(snapshots.flatMap(s=>s.files).map(f=>[f.sha256,{sha256:f.sha256,format:f.format}])).values()],modelBoundary:'local_calculation_only'};
 }finally{db.close();}
}
export async function saveBusinessBaseline(args,options={}){
 writable(options);validate('finance_baseline_save',args);const opts=configured(options);
 if(!currentFinanceCall())return withFinanceCall({tool:'finance_baseline_save',args,auditDir:opts.auditDir},()=>saveBusinessBaseline(args,opts));
 if(args.effectiveTo&&args.effectiveTo<args.effectiveFrom)fail('finance_baseline_effective_period_invalid');
 const binding=scopeBinding(args,opts),db=new DatabaseSync(binding.dbPath);
 try{
  storage.assertBusinessMemoryScope(db,binding.scope);
  const snapshots=[];for(const ref of args.materialRefs)snapshots.push(await materialSnapshot(ref,args,db,binding,opts));
  const requests=flatMaterialRequests(snapshots),merged=mergeBaselineMaterialSnapshots(snapshots),facts=merged.facts,allowed=new Map(snapshots.flatMap(s=>s.supportSelections??[]).map(p=>[p.supportRef,p]));
  const requested=args.principles.map(p=>{if(p.supportRef){const selected=allowed.get(p.supportRef);if(!selected)fail('finance_baseline_support_not_returned');const {supportRef,authority,...value}=selected;return {...value,evidenceRefs:value.evidenceRefs.map(ref=>merged.factAliases[ref]??ref)};}return {...p,evidenceRefs:p.evidenceRefs.map(ref=>merged.factAliases[ref]??ref)};});
  const principles=validatePrinciples(requested,facts,binding.scope),taxBurden=buildBaselineTaxBurden(facts),coverage=baselineCoverage({...merged,requests},principleSupport(facts,binding.scope),principles);
  if(taxBurden.rows.some(r=>r.through>=binding.scope.period))fail('finance_baseline_tax_history_not_prior');
  const unresolved=fixedGaps([...(args.unresolved??[]),...(coverage.businessPrinciplesMissing?[{code:'historical_evidence_missing'}]:[]),...snapshots.flatMap(s=>s.gaps).map(code=>({code})),...taxBurden.gaps.map(code=>({code})),...(Object.values(coverage.taxHistory).some(t=>t.status==='incomplete')?[{code:'tax_basis_incomplete'}]:[]),...(taxBurden.missing?[{code:'tax_history_missing'}]:[])]);
  const used=new Set([...principles.flatMap(p=>p.evidenceRefs),...taxBurden.summaries.flatMap(t=>t.evidenceRefs)]);
  const definition={interfaceVersion:BASELINE_INTERFACE,scope:binding.scope,effectiveFrom:args.effectiveFrom,...(args.effectiveTo?{effectiveTo:args.effectiveTo}:{}),principles,taxBurden,unresolved,coverage,facts:facts.filter(f=>used.has(f.factRef)),materialRefs:args.materialRefs,observationRoots:[opts.auditDir],semanticAuthority:merged.artifacts.length?'agent_observation_and_ledger_evidence':'checked_sources_and_inferences_not_human_approval'};
  renderBusinessBaseline(definition,binding.scope);
  // 对实际原则/适用期/证据版本取摘要，调用ID或普通新增凭证不会无条件换版。
  const signature=digest({effectiveFrom:definition.effectiveFrom,effectiveTo:definition.effectiveTo,principles,taxBurden,unresolved,facts:definition.facts});definition.signature=signature;
  await storage.ensureBusinessMemorySchema(db,{dbPath:binding.dbPath,outDir:join(dirname(binding.dbPath),'baseline-install-'+randomUUID())});
  const all=versions(db,binding.scope),latest=all[0],previousRevision=latest?.revision??0;
  if(args.expectedRevision!==previousRevision)fail('finance_baseline_revision_conflict');
  if(latest?.definition.signature===signature){const result=view(db,binding.scope,args.target,opts);if(result.baselineRef===latest.methodRef)result.coverage={...result.coverage,unselectedPrincipleBranches:coverage.unselectedPrincipleBranches};return fitBaselineBranchResponse({...result,changed:false,savedVersion:savedVersionView(latest,binding.scope.period)},currentFinanceCall()?.callId);}
  // appendVersion 自己持有写事务并再次检查revision；来源在事务两侧核实。
  const states=factStates(db,definition,opts);if([...states.values()].some(s=>s!=='current'))fail('finance_baseline_material_changed');
  const saved=storage.appendBusinessMemoryMethodVersion(db,binding.scope,{topic:BASELINE_TOPIC,objectKey:'account-set',effectiveFrom:args.effectiveFrom,...(args.effectiveTo?{effectiveTo:args.effectiveTo}:{}),authority:'candidate',definition,evidenceRefs:definition.facts.map(f=>({ref:f.factRef,sha256:f.source.sha256})),expectedRevision:previousRevision},{verify:()=>{if([...factStates(db,definition,opts).values()].some(s=>s!=='current'))fail('finance_baseline_material_changed');}});
  const result=view(db,binding.scope,args.target,opts);if(result.baselineRef!==saved.methodRef&&args.effectiveFrom<=binding.scope.period&&(!args.effectiveTo||args.effectiveTo>=binding.scope.period))fail('finance_baseline_commit_unknown');
  if(result.baselineRef===saved.methodRef)result.coverage={...result.coverage,unselectedPrincipleBranches:coverage.unselectedPrincipleBranches};return fitBaselineBranchResponse({...result,changed:true,savedVersion:savedVersionView(saved,binding.scope.period)},currentFinanceCall()?.callId);
 }finally{db.close();}
}
