// 程序合同链专用。测试宿主先生成有来源的本机观察，再走真实 MCP。
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BASELINE_FIELDS} from '../../server/business-baseline-contracts.mjs';
import {baselineTarget,hashBaseline,readBaselineJson,writeBaselineJson} from './business-baseline-fixture.mjs';

// 旧会计断言的合成 JSON 由测试侧明确提取，产品入口只见整理件路径。
const fixtureFieldNames={
  accountingStandard:'accounting_standard',会计准则:'accounting_standard',enterpriseClass:'enterprise_class',企业类型:'enterprise_class',
  costMethod:'inventory_cost',method:'inventory_cost',存货计价方法:'inventory_cost',既有计价设置:'inventory_cost',
  业务类别:'business_kind',业务类型:'business_kind',业务性质:'business_kind',businessKind:'business_kind',
  提供方式:'service_pattern',servicePattern:'service_pattern',服务方式:'service_pattern',是否形成或改良资产:'creates_asset',
  是否形成承租人资产:'creates_asset',是否形成资产:'creates_asset',合同编号:'business_reference',业务编号:'business_reference',采购编号:'business_reference',工单:'business_reference',
  服务开始日:'service_start',服务结束日:'service_end',开票日:'invoice_date',付款日:'payment_date',收款日:'receipt_date',
  合同约定付款日:'contract_due_date',用途确认日:'confirmation_date',完工验收日:'delivery_date',劳务日期:'delivery_date',
  验收可用日:'delivery_date',客户签收验收日:'delivery_date',净租金:'amount_net',净价:'amount_net',不含税金额:'amount_net',不含税购置价:'amount_net',发票税额:'amount_tax',含税金额:'amount_gross',
  税种:'tax_type',taxType:'tax_type',税额口径:'tax_measure',税款口径:'tax_measure',measure:'tax_measure',税额阶段:'tax_stage',stage:'tax_stage',
  期间口径:'period_basis',basis:'period_basis',累计口径:'accumulation',所属期起:'period_start',所属期止:'period_end',periodStart:'period_start',periodEnd:'period_end',
  不含税应税销售额:'sales_ex_vat',不含税销售额:'sales_ex_vat',sales:'sales_ex_vat',累计营业收入:'revenue',累计收入:'revenue',
  应纳税额:'tax_amount',减免后应纳税额:'tax_amount',减免后累计应纳税额:'tax_amount',优惠前应纳税额:'tax_amount',本期应纳税额:'tax_amount',
  实缴税额:'tax_amount',已缴税额:'tax_amount',累计实际已预缴:'tax_amount',应补税额:'tax_amount',taxAmount:'tax_amount',
  所得税租金口径:'income_tax_period',租赁税务计税选择:'tax_choice',有效开始日:'choice_valid_from',有效终止日:'choice_valid_through',
  期初数量:'opening_quantity',期初单价:'opening_unit_price',本月购入数量:'receipt_quantity',本月购入单价:'receipt_unit_price',本月领用数量:'issue_quantity',
  期初件数:'opening_quantity',入库件数:'receipt_quantity',入库单价:'receipt_unit_price',耗用件数:'issue_quantity',
};
const pointerKey=key=>key.replaceAll('~','~0').replaceAll('/','~1');
const fixturePointer=(value,path)=>path===''?value:path.slice(1).split('/').reduce((node,key)=>node?.[key.replaceAll('~1','/').replaceAll('~0','~')],value);
const fixtureCapture=(value,jsonPointer)=>({value,locator:{jsonPointer}});
export function writeFixtureObservations(auditDir,{target,originals,records=[],historicalRows=[]},view={}){
  const directory=join(auditDir,'agent-materials');
  mkdirSync(directory,{recursive:true});
  const inputPath=join(directory,'fixture-'+randomUUID()+'.json');
  writeBaselineJson(inputPath,{version:'finance-baseline-observations/1',target,originals:originals.map(original=>({
    ...original,sha256:original.sha256??hashBaseline(readFileSync(original.path))
  })),records,historicalRows});
  return {target,inputPath,...view};
}

function readFixtureRecords(data){
  const records=[];
  const visit=(node,path,shared=[])=>{
    if(typeof node!=='object'||!node)return;
    const byField=new Map();
    for(const [key,value]of Object.entries(node)){
      if(value===null||typeof value==='object')continue;
      const field=BASELINE_FIELDS.includes(key)?key:fixtureFieldNames[key];
      if(!field)continue;
      const observed={field,...fixtureCapture(value,path+'/'+pointerKey(key))};
      if(!byField.has(field)||key==='业务类别'||key.startsWith('减免后'))byField.set(field,observed);
    }
    if(byField.has('business_reference')){
      for(const f of shared)if(!byField.has(f.field))byField.set(f.field,f);
    }
    if(byField.size>0)records.push([...byField.values()]);
    const localShared=['business_kind','service_pattern'].flatMap(k=>byField.has(k)?[byField.get(k)]:shared.filter(f=>f.field===k));
    for(const [key,value]of Object.entries(node))if(value&&typeof value==='object')visit(value,path+'/'+pointerKey(key),localShared);
  };
  visit(data,'');
  return records;
}

export function fixtureObservationRequest(args,{auditDir}){
  const {target,originals,selections,historicalRows,section,...view}=args;
  assert(!historicalRows?.length,'旧二进制 XLS 测试须走实际合成宿主解析');
  if(!originals?.length)return {target,...(section?{section}:{}),...view};
  const payload={target,originals:[],records:[]};
  for(const original of originals){
    const sourceBytes=readFileSync(original.path),data=JSON.parse(sourceBytes);
    const ownerKey=['companyName','企业名称','公司名称'].find(key=>typeof data[key]==='string');
    const hasEnterpriseKey=typeof data.enterpriseKey==='string';
    const owner=ownerKey||hasEnterpriseKey?{role:'enterprise',
      ...(ownerKey?{name:fixtureCapture(data[ownerKey],'/'+pointerKey(ownerKey))}:{}),
      ...(hasEnterpriseKey?{enterpriseKey:fixtureCapture(data.enterpriseKey,'/enterpriseKey')}:{})}:undefined;
    payload.originals.push({id:original.id,path:original.path,sha256:hashBaseline(sourceBytes),...(owner?{owner}:{})});
    let groups;
    if(selections){
      groups=new Map();
      for(const selection of selections.filter(s=>s.originalId===original.id)){
        const {jsonPointer}=selection.locator;
        assert.equal(typeof jsonPointer,'string','合成 JSON 提取须定位实际指针');
        const group=selection.group??jsonPointer.slice(0,jsonPointer.lastIndexOf('/'));
        const value=fixturePointer(data,jsonPointer);
        if(value===undefined)continue;
        const field={field:selection.field,...fixtureCapture(value,jsonPointer),...(selection.interpretation?{interpretation:selection.interpretation}:{})};
        if(groups.has(group))groups.get(group).push(field);
        else groups.set(group,[field]);
      }
    }else groups=new Map(readFixtureRecords(data).map((fields,index)=>[index,fields]));
    for(const [index,fields] of [...groups.values()].entries()){
      payload.records.push({id:'record_'+payload.originals.length+'_'+index,originalId:original.id,fields});
    }
  }
  return writeFixtureObservations(auditDir,payload,{...(section?{section}:{}),...view});
}

export function fixtureSourceArgs(client,args){
  return fixtureObservationRequest(args,{auditDir:client.env.FINANCE_AUDIT_DIR});
}

export function baselineMaterialRequest(f,name='a',{includeTax=true}={}){
  const originals=[],selections=[],files=f.files[name];
  const original=(key)=>{const id=name+'_'+key;originals.push({id,path:files[key]});return id;};
  const add=(originalId,id,field,jsonPointer,group=originalId)=>selections.push({id:name+'_'+id,field,originalId,group,locator:{jsonPointer}});
  const tax=(key)=>{
    const id=original(key),rows=key==='vat'?3:1;
    for(let i=0;i<rows;i++){
      const path=key==='vat'?'/行/'+i:'',group=name+'_'+key+i;
      const fields={tax_type:'税种',tax_measure:'税额口径',tax_stage:'税额阶段',period_basis:'期间口径',accumulation:'累计口径',period_start:'所属期起',period_end:'所属期止',tax_amount:key==='vat'?'应纳税额':'减免后累计应纳税额',[key==='vat'?'sales_ex_vat':'revenue']:key==='vat'?'不含税应税销售额':'累计营业收入'};
      for(const [field,label]of Object.entries(fields))add(id,key+i+'_'+field,field,path+'/'+label,group);
    }
  };
  const cost=original('cost');add(cost,'inventory_cost','inventory_cost','/既有计价设置');
  if(name==='a'){
    const lease=original('lease');
    for(const [field,label]of Object.entries({business_reference:'合同编号',business_kind:'业务类别',service_pattern:'提供方式',service_start:'服务开始日',service_end:'服务结束日',invoice_date:'开票日',receipt_date:'收款日',contract_due_date:'合同约定付款日',amount_net:'净租金',amount_tax:'发票税额'}))add(lease,'lease_'+field,field,'/'+label);
    const maintenance=original('maintenance');
    for(const [field,label]of Object.entries({business_reference:'合同编号',business_kind:'业务类别',service_pattern:'提供方式',service_start:'服务开始日',service_end:'服务结束日',invoice_date:'开票日',payment_date:'付款日',confirmation_date:'用途确认日',amount_net:'净价',amount_tax:'发票税额',amount_gross:'含税金额',creates_asset:'是否形成或改良资产'}))add(maintenance,'maintenance_'+field,field,'/'+label);
    const asset=original('asset');
    for(const [field,label]of Object.entries({business_reference:'采购编号',business_kind:'业务类别',amount_net:'不含税购置价',delivery_date:'验收可用日',creates_asset:'是否形成或改良资产'}))add(asset,'asset_'+field,field,'/'+label);
    const daily=original('daily');
    for(const [field,label]of Object.entries({business_reference:'业务编号',business_kind:'业务类别',service_pattern:'提供方式',amount_net:'净价',delivery_date:'劳务日期',creates_asset:'是否形成或改良资产'}))add(daily,'daily_'+field,field,'/'+label);
    const repairs=original('repairs');
    for(let i=0;i<3;i++)for(const [field,label]of Object.entries({business_reference:'工单',business_kind:'业务类别',service_pattern:'提供方式',delivery_date:'完工验收日',amount_net:'净价'}))add(repairs,'repair'+i+'_'+field,field,'/行/'+i+'/'+label,'a_repairs'+i);
    const choice=original('taxChoice');
    for(const [field,label]of Object.entries({business_kind:'业务类别',tax_choice:'租赁税务计税选择',income_tax_period:'所得税租金口径',choice_valid_from:'有效开始日',choice_valid_through:'有效终止日'}))add(choice,'choice_'+field,field,'/'+label);
    if(includeTax){tax('vat');tax('cit');}
  }else{
    const repair=original('repairs');
    for(let i=0;i<3;i++){
      const group='b_repairs'+i;
      add(repair,'repair'+i+'_business_kind','business_kind','/业务类别',group);add(repair,'repair'+i+'_service_pattern','service_pattern','/提供方式',group);
      add(repair,'repair'+i+'_business_reference','business_reference','/行/'+i+'/工单',group);
      add(repair,'repair'+i+'_delivery_date','delivery_date','/行/'+i+'/完工验收日',group);add(repair,'repair'+i+'_amount_net','amount_net','/行/'+i+'/净价',group);
    }
    if(includeTax)tax('vat');
  }
  return {target:baselineTarget(f,name),originals,selections,limit:50};
}

export function manualBaselineSave(f,materials,name='a',{expectedRevision=0,effectiveFrom='2026-07',effectiveTo='2026-12'}={}){
  assert(materials.materialRef&&materials.snapshotDigest,'必须来自一次真实materials调用');
  const facts=materials.facts;
  const originalByTemplate={inventory_cost:'cost',repair:'repairs',lease_:'lease',daily_:'daily',maintenance_:'maintenance',asset_:'asset',vat0_:'vat',choice_:'taxChoice'};
  const refs=template=>facts.filter(fact=>fact.source.originalId===name+'_'+originalByTemplate[template]).map(fact=>fact.factRef);
  const standard=facts.filter(fact=>fact.field==='accounting_standard'&&fact.source.kind==='ledger_configuration').map(fact=>fact.factRef);
  const principle=(kind,value,when,keys=[],history=false)=>{const sourceRefs=keys.flatMap(refs),ledger=history?facts.filter(x=>x.field==='historical_posting'&&x.linkedBusinessRefs?.some(ref=>sourceRefs.includes(ref))).map(x=>x.factRef):[];return {kind,value,when,evidenceRefs:[...new Set([...sourceRefs,...ledger])]};};
  const principles=[{kind:'accounting_standard',value:name==='a'?'enterprise':'small_enterprise',when:'account_set',evidenceRefs:standard},principle('inventory_cost',name==='a'?'periodic_weighted_average':'fifo','inventory',['inventory_cost'])];
  if(name==='a')principles.push(
    principle('business_classification','main_income','repair',['repair'],true),
    principle('business_classification','other_income','lease',['lease_'],true),
    principle('business_classification','actual_use_expense','repair',['daily_'],true),
    principle('revenue_period','service_period','lease',['lease_'],true),
    principle('expense_period','benefit_period','maintenance',['maintenance_'],true),
    principle('cost_treatment','expense_current','repair',['daily_'],true),
    {...principle('cost_treatment','capitalize_then_depreciate','fixed_asset',['asset_'],true),evidenceRefs:[...refs('asset_'),...facts.filter(x=>x.field==='asset_configuration').map(x=>x.factRef)]},
    principle('vat_output_period','advance_invoice_period','lease',['lease_','vat0_'],true),
    principle('vat_input_period','confirmation_period','maintenance',['maintenance_','vat0_'],true),
    principle('income_tax_period','contract_due','lease',['choice_','lease_'],true),
    principle('tax_choice','vat_standard','lease',['choice_']),
  );
  else principles.push(principle('revenue_period','delivery_acceptance','repair',['repair'],true));
  return {target:baselineTarget(f,name),materialRefs:materials.materialRefs??[{materialRef:materials.materialRef,snapshotDigest:materials.snapshotDigest}],expectedRevision,effectiveFrom,effectiveTo,principles,...(name==='b'?{unresolved:[{code:'tax_history_missing',kind:'income_tax_period'}]}:{})};
}

export const materialReference=value=>({materialRef:value.materialRef,snapshotDigest:value.snapshotDigest});

// 量测真实MCP双份包装及元数据，不能仅量领域对象或principleSupport的一部分。
export async function callBaselineMaterials(client,args){
  if(args.originals)args=fixtureSourceArgs(client,args);
  const rpc=await client.rpc('tools/call',{name:'finance_baseline_materials',arguments:args});
  assert.equal(rpc.error,undefined,JSON.stringify(rpc.error));const raw=rpc.result,text=raw?.content?.find(c=>c.type==='text')?.text;
  let data;try{data=JSON.parse(text);}catch{assert.fail('材料工具必须返回正常JSON：'+text);}
  const prettyBytes=Buffer.byteLength(JSON.stringify(raw,null,2),'utf8');
  const response={isError:raw?.isError===true,text,data,structured:raw?.structuredContent??null,raw,prettyBytes,request:args};
  assert.equal(response.isError,false,text);assert(prettyBytes<=12288,'完整MCP材料返回超预算：'+prettyBytes+' bytes');
  const taxPage=data.taxBurden?.pagination;if(taxPage?.nextOffset!==undefined&&taxPage.nextOffset!==null){assert.equal(taxPage.next?.tool,'finance_baseline_materials');assert.equal(taxPage.next.arguments.section,'tax');assert.equal(taxPage.next.arguments.offset,taxPage.nextOffset);assert.deepEqual(taxPage.next.arguments.target,args.target);assert.deepEqual(taxPage.next.arguments.materialRefs,[materialReference(data)]);}
  return response;
}

// 严格跟随工具给出的续页，不自行重做selection，也不把展示页误当成新的源读取leaf。
export async function readBaselineSection(client,args){
  const responses=[],pages=[],seen=new Set();let next=args;
  while(next){
    const key=JSON.stringify(next);assert(!seen.has(key),'材料next不得循环');seen.add(key);
    const response=await callBaselineMaterials(client,next),page=response.data;responses.push(response);pages.push(page);
    const continuation=page.pagination?.next;assert.equal(page.pagination?.nextOffset===null,continuation===undefined,'有后页时必须给可直接调用的next');
    if(continuation){assert.equal(continuation.tool,'finance_baseline_materials');assert.deepEqual(continuation.arguments.target,args.target);assert(page.pagination.limit>0,'每页必须实际推进');assert.equal(continuation.arguments.offset,page.pagination.nextOffset);assert(page.pagination.nextOffset>page.pagination.offset,'next必须前进，不能靠新callId掩饰循环');}
    next=continuation?.arguments;assert(pages.length<=500,'正常材料续页应有界');
  }
  const last=pages.at(-1);return {...last,...(last.calculationSchema?{calculationSchema:{...last.calculationSchema,objects:pages.flatMap(p=>p.calculationSchema?.objects??[])}}:{}),pages,responses,materialRefs:[materialReference(last)],principleSupport:pages.flatMap(p=>p.principleSupport??[]),facts:pages.flatMap(p=>p.facts??[]),details:pages.flatMap(p=>p.details??[])};
}

// 旧typed/evidenceRefs合同的测试适配；所有事实通过正常facts分页实披露，保存只用最后一个闭包ref。
export async function readAllBaselineMaterials(client,request){
  const overview=await readBaselineSection(client,{...request,section:'overview'}),facts=await readBaselineSection(client,{target:request.target,materialRefs:overview.materialRefs,section:'facts',limit:50});
  const tax=await readBaselineSection(client,{target:request.target,materialRefs:facts.materialRefs,section:'tax',limit:50});
  return {...tax,principleSupport:overview.principleSupport,facts:facts.facts,pages:overview.pages,factPages:facts.pages,taxBurden:{...tax.taxBurden,summaries:tax.pages.flatMap(p=>p.taxBurden?.summaries??[])},responses:[...overview.responses,...facts.responses,...tax.responses]};
}

// 冷启动只装载试验夹具公开的合成原件。真实业务边界是产物文件，不靠 MCP 找原件。
export async function readColdBaselineMaterials(client,target,{section='overview',limit=50}={}){
  const fixture=readBaselineJson(join(dirname(client.env.FINANCE_SOURCE_ROOT),'fixture.json'));
  const name=target.accountSetId===fixture.a?'a':'b';
  assert.equal(fixture[name],target.accountSetId);
  const originals=Object.entries(fixture.files[name]).map(([id,path])=>({id:name+'_'+id,path}));
  const observed=await readBaselineSection(client,fixtureSourceArgs(client,{target,originals,section,limit}));
  assert.equal(observed.coverage.sourceOwners.agentIdentityMatched,originals.length);
  assert.equal(observed.coverage.sourceOwners.unverified,0);
  return {...observed,allResponses:observed.responses,generationPath:'host_extraction_material_reference_actual_support_refs'};
}

// 这是程序选取器而非模型推理：只依据实际返回的候选去重，不从独立预期制造typed答案。
export function saveFromActualSupports(target,materials,{expectedRevision=0,effectiveFrom=target.period,effectiveTo='2026-12',unresolved}={}){
  const supports=[...new Map(materials.principleSupport.map(p=>[[p.kind,p.value,p.when,p.allocationBasis??''].join(':'),p])).values()];
  // 同时返回的费用受益期与cost_treatment分摊候选重复表达相同条件，保留费用所属期原则。
  const selected=supports.filter(p=>!(p.kind==='cost_treatment'&&p.value==='allocate_benefit_period'&&p.allocationBasis==='monthly_equal'&&supports.some(s=>s.kind==='expense_period'&&s.value==='benefit_period'&&s.when===p.when&&s.allocationBasis==='monthly_equal')));
  for(const p of selected){assert.match(p.supportRef,/^bp:[a-f0-9]{64}$/);assert(!selected.some(q=>q!==p&&q.kind===p.kind&&q.when===p.when&&q.value!==p.value&&p.kind!=='business_classification'),'冲突候选须先调查，不能机械全选');}
  assert(selected.length&&selected.length<=24);
  return {target,materialRefs:materials.materialRefs??[materialReference(materials)],expectedRevision,effectiveFrom,effectiveTo,principles:selected.map(p=>({supportRef:p.supportRef})),...(unresolved?{unresolved}:{})};
}

export async function discoverBaselineCalculationMaterials(client,target){return readColdBaselineMaterials(client,target,{section:'calculation',limit:3});}
