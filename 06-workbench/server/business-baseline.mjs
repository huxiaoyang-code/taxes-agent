// 材料观察、按需税负和本机计算的取数入口。
import {DatabaseSync} from 'node:sqlite';
import {join,dirname,basename,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {writeFileSync,readFileSync} from 'node:fs';
import {validateSchemaValue} from './harness-schema-validation.mjs';
import {resolveBusinessMemoryTarget} from './business-memory.mjs';
import {currentFinanceCall,withFinanceCall,annotateFinanceCall,financeAuditDirectory,readFinanceCall} from './finance-call-chain.mjs';
import * as storage from './business-memory-storage.mjs';
import {AGENT_MATERIALS_SUBDIRECTORY,BASELINE_MATERIAL_REFS_SCHEMA,BASELINE_VALUES,BASELINE_FACT_VALUES,BASELINE_DATE_FIELDS,BASELINE_PERIOD_FIELDS,BASELINE_AMOUNT_FIELDS,BASELINE_QUANTITY_FIELDS,BUSINESS_BASELINE_SCHEMAS} from './business-baseline-contracts.mjs';
import {baselineBytes,baselineDirectoryAvailable,captureBaselineMaterials,mergeBaselineMaterialSnapshots,baselineLedgerFact,groupBaselineMaterialFacts,baselineScalarMaterialFacts,baselineSnapshotDigest,materialRegistryDigest} from './business-baseline-materials.mjs';
import {projectBaselineMaterials,baselineSupportRef,baselineCalculationSchema} from './business-baseline-projection.mjs';
import {assertRestoreOpenPath} from './local-restore-control.mjs';
import {registeredMaterialIdentity} from './material-identity.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const digest=storage.businessMemoryDigest;
const sha=b=>createHash('sha256').update(b).digest('hex');
const list=value=>Array.isArray(value)?value:[];
const same=(a,b)=>storage.canonicalBusinessMemory(a)===storage.canonicalBusinessMemory(b);
const owner=scope=>[scope.databaseInstanceId,scope.enterpriseKey,scope.accountSetId];
const BASELINE_READER_SHA256=sha(readFileSync(new URL(import.meta.url)));
const calculationReader=()=>({moduleUrl:import.meta.url,sha256:BASELINE_READER_SHA256,exportName:'resolveBaselineCalculationFacts',version:'finance-baseline-calculation-facts/1',values:'local_calculation_only_not_model_projection'});
function configured(options={}){return {...options,dbPath:options.dbPath??process.env.FINANCE_DATABASE_PATH,sourceRoot:options.sourceRoot??process.env.FINANCE_SOURCE_ROOT,auditDir:options.auditDir??currentFinanceCall()?.auditDir??financeAuditDirectory()};}
function validate(name,args){if(validateSchemaValue(BUSINESS_BASELINE_SCHEMAS[name],args).length)fail('finance_baseline_input_invalid');}
function scopeBinding(args,options){const binding=resolveBusinessMemoryTarget(args.target,options);assertRestoreOpenPath(binding.dbPath);annotateFinanceCall({scope:binding.scope,configuredTarget:{databasePath:binding.dbPath,accountSetId:binding.scope.accountSetId,period:binding.scope.period,bindingOrigin:binding.bindingOrigin}});return binding;}
function agentArtifactCurrent(artifact){
 return basename(artifact.root)===AGENT_MATERIALS_SUBDIRECTORY&&extname(artifact.path).toLowerCase()==='.json'&&
  sha(baselineBytes(artifact.path,artifact.root))===artifact.sha256;
}
function assertMaterialFactsCurrent(db,snapshot,opts){
 const checkedSources=new Set(),checkedFiles=new Set(),checkedRoots=new Set();
 const checkRoot=root=>{
  if(checkedRoots.has(root))return;
  if(!baselineDirectoryAvailable(root))fail('finance_baseline_material_changed');
  checkedRoots.add(root);
 };
 const checkFile=(file,root,max)=>{
  const key=digest({root,path:file.path,sha256:file.sha256,max});
  if(checkedFiles.has(key))return;
  if(sha(baselineBytes(file.path,root,{max}))!==file.sha256)fail('finance_baseline_material_changed');
  checkedFiles.add(key);
 };
 let registryDigest;
 for(const {source} of snapshot.facts){
  const key=digest(source);
  if(checkedSources.has(key))continue;
  if(source.kind==='file'){
   checkRoot(opts.sourceRoot);
   checkFile(source,opts.sourceRoot);
   if(source.registryDigest){
    registryDigest??=materialRegistryDigest(registeredMaterialIdentity(db,snapshot.scope));
    if(registryDigest!==source.registryDigest)fail('finance_baseline_material_changed');
   }
   const artifact=source.agentArtifact;
   if(artifact){
    if(basename(artifact.root)!==AGENT_MATERIALS_SUBDIRECTORY||extname(artifact.path).toLowerCase()!=='.json')fail('finance_baseline_material_changed');
    checkFile(artifact,artifact.root);
   }
   if(source.adaptation){
    for(const file of source.adaptation.artifacts)checkFile(file,source.adaptation.recordRoot,20*1024*1024);
    for(const file of source.adaptation.sourceDependencies)checkFile(file,opts.sourceRoot);
   }
  }else{
   const actual=baselineLedgerFact(db,snapshot.scope,source);
   if(actual===null||actual!==source.sha256)fail('finance_baseline_material_changed');
   for(const relation of source.relations??[]){
    const op=db.prepare('SELECT state FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=?').get(snapshot.scope.databaseInstanceId,relation.operationId,relation.attempt);
    if(!['succeeded','no_change'].includes(op?.state))fail('finance_baseline_material_changed');
    const root=relation.recordRoot??join(dirname(opts.dbPath),'posting-attempts');
    checkRoot(root);
    for(const file of relation.files)checkFile(file,root,20*1024*1024);
   }
  }
  checkedSources.add(key);
 }
}
function choiceCurrent(p,facts,period){
 if(p.kind!=='tax_choice')return true;const fs=facts.filter(f=>!p.evidenceRefs||p.evidenceRefs.includes(f.factRef));
 return fs.filter(f=>f.field==='tax_choice'&&f.value===p.value).some(policy=>{const g=fs.filter(f=>f.group===policy.group),from=field(g,'choice_valid_from'),through=field(g,'choice_valid_through'),last=new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7)),0)).toISOString().slice(0,10);return from&&through&&from<=period+'-01'&&through>=last;});
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
  const catalog=principleSupport(snapshot.facts,binding.scope).map(p=>({...p,supportRef:baselineSupportRef(binding.scope,p)}));
  const base={version:'finance-baseline-materials/1',target:args.target,scopeVerified:true,materialRef:currentFinanceCall().callId,snapshotDigest:snapshot.snapshotDigest,calculationReader:calculationReader(),semanticAuthority:snapshot.artifacts.length?'agent_observation':'source_observation_not_human_approval',modelBoundary:{mode:'fixed_business_projection',rawValues:'local_only'}};
  const calculationSchema=args.section==='calculation'?baselineCalculationSchema(calculationObjects(snapshot.facts,binding.scope,{factAliases:snapshot.factAliases})):null;
  const projection=projectBaselineMaterials({base,snapshot,supports:catalog,args,calculationSchema});
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
  assertMaterialFactsCurrent(db,stored,opts);
 }catch{fail('finance_baseline_material_changed');}
 return {...stored,requests};
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
 const schema={type:'object',additionalProperties:false,required:['target','materialRefs','expectedReaderSha256'],properties:{target:BUSINESS_BASELINE_SCHEMAS.finance_baseline_materials.properties.target,materialRefs:BASELINE_MATERIAL_REFS_SCHEMA,expectedReaderSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},factRefs:{type:'array',maxItems:400,uniqueItems:true,items:{type:'string',pattern:'^bf:[a-f0-9]{64}$'}}}};
 if(validateSchemaValue(schema,args).length)fail('finance_baseline_reader_input_invalid');const reader=calculationReader();if(reader.sha256!==args.expectedReaderSha256)fail('finance_baseline_reader_version_conflict');
 const opts=configured(options),binding=scopeBinding(args,opts),db=new DatabaseSync(binding.dbPath,{readOnly:true});
 try{
  storage.assertBusinessMemoryScope(db,binding.scope);const snapshots=[];for(const ref of args.materialRefs){baselineBytes(join(opts.auditDir,ref.materialRef,'begin.json'),opts.auditDir);snapshots.push(await materialSnapshot(ref,args,db,binding,opts));}
  flatMaterialRequests(snapshots);const merged=mergeBaselineMaterialSnapshots(snapshots),objects=calculationObjects(merged.facts,binding.scope,{factRefs:args.factRefs,factAliases:merged.factAliases});
  return {version:reader.version,scopeVerified:true,target:args.target,objects,reader,materialRefs:args.materialRefs,sourceDigests:[...new Map(snapshots.flatMap(s=>s.files).map(f=>[f.sha256,{sha256:f.sha256,format:f.format}])).values()],modelBoundary:'local_calculation_only'};
 }finally{db.close();}
}
