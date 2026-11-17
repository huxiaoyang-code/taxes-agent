// 程序合同链专用。主阳性走安全目录→自动抽取→显式合并→实际supportRef；人工定位只用于兼容及攻击回归。
import assert from 'node:assert/strict';
import {baselineTarget} from './business-baseline-fixture.mjs';

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
  const facts=materials.facts,refs=(prefix)=>facts.filter(x=>x.id?.startsWith(name+'_'+prefix)).map(x=>x.factRef),standard=facts.filter(x=>x.field==='accounting_standard').map(x=>x.factRef);
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
  const rpc=await client.rpc('tools/call',{name:'finance_baseline_materials',arguments:args});
  assert.equal(rpc.error,undefined,JSON.stringify(rpc.error));const raw=rpc.result,text=raw?.content?.find(c=>c.type==='text')?.text;
  let data;try{data=JSON.parse(text);}catch{assert.fail('材料工具必须返回正常JSON：'+text);}
  const prettyBytes=Buffer.byteLength(JSON.stringify(raw,null,2),'utf8');
  const response={isError:raw?.isError===true,text,data,structured:raw?.structuredContent??null,raw,prettyBytes,request:args};
  assert.equal(response.isError,false,text);assert(prettyBytes<=12288,'完整MCP材料返回超预算：'+prettyBytes+' bytes');
  const taxPage=data.taxBurden?.pagination;if(taxPage?.nextOffset!==undefined&&taxPage.nextOffset!==null){assert.equal(taxPage.next?.tool,'finance_baseline_materials');assert.equal(taxPage.next.arguments.section,'tax');assert.equal(taxPage.next.arguments.offset,taxPage.nextOffset);assert.deepEqual(taxPage.next.arguments.target,args.target);assert.deepEqual(taxPage.next.arguments.materialRefs,[materialReference(data)]);}
  if(data.sourceDiscovery?.remainingCount>0){
    if(data.section==='calculation'&&data.pagination?.next)assert.equal(data.sourceDiscovery.next,undefined,'计算结构尚有本批续页时，跨来源next应延后到批末');
    else{const next=data.sourceDiscovery.next;assert.equal(next?.tool,'finance_baseline_materials');assert.equal(next.arguments.extractKnownFields,true);assert.deepEqual(next.arguments.target,args.target);assert.deepEqual(next.arguments.sourceCursor,materialReference(data));assert.equal(next.arguments.originals,undefined);assert.equal(next.arguments.materialRefs,undefined);assert.equal(next.arguments.section??'overview',args.section??'overview','跨来源批次必须保留请求的真实视图');}
  }else if(data.sourceDiscovery)assert.equal(data.sourceDiscovery.next,undefined,'来源全部纳入后不能继续给跨来源next');
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
  const last=pages.at(-1);return {...last,...(last.calculationSchema?{calculationSchema:{...last.calculationSchema,objects:pages.flatMap(p=>p.calculationSchema?.objects??[])}}:{}),pages,responses,materialRefs:[materialReference(last)],principleSupport:pages.flatMap(p=>p.principleSupport??[]),facts:pages.flatMap(p=>p.facts??[]),fields:pages.flatMap(p=>p.fields??[]),details:pages.flatMap(p=>p.details??[]),items:pages.flatMap(p=>p.sourceInventory?.items??[])};
}

// 旧typed/evidenceRefs合同的测试适配；所有事实通过正常facts分页实披露，保存只用最后一个闭包ref。
export async function readAllBaselineMaterials(client,request){
  const overview=await readBaselineSection(client,{...request,section:'overview'}),facts=await readBaselineSection(client,{target:request.target,materialRefs:overview.materialRefs,section:'facts',limit:50});
  const tax=await readBaselineSection(client,{target:request.target,materialRefs:facts.materialRefs,section:'tax',limit:50});
  return {...tax,principleSupport:overview.principleSupport,facts:facts.facts,pages:overview.pages,factPages:facts.pages,taxBurden:{...tax.taxBurden,summaries:tax.pages.flatMap(p=>p.taxBurden?.summaries??[])},responses:[...overview.responses,...facts.responses,...tax.responses]};
}

// 主阳性及本期取数共同走当前主体的高层发现→抽取→sourceCursor；不手抄目录refs、偏移或中文列。
export async function readColdBaselineMaterials(client,target,{section='overview',explicitExtract=true,limit=50}={}){
  const extractions=[],cursors=new Set();let request={target,...(explicitExtract?{extractKnownFields:true}:{}),section,limit};
  while(request){
    // 先完整查看当前批候选，才取最后一个真实页面提供的跨批next，保留已返回支持的闭包。
    const batch=await readBaselineSection(client,request),discovery=batch.sourceDiscovery;assert(discovery,'高层自动取材必须给真实发现覆盖');assert.equal(discovery.mode,'authorized_scope_known_fields');assert.equal(discovery.scanLimited,false,'本合成现场不应触发扫描容量截断');assert.equal(discovery.uninspectedCount,0);assert.equal(batch.coverage.sourceOwners.unverified,0);assert.equal(batch.coverage.sourceOwners.checked,batch.coverage.sourceCount);assert.equal(batch.coverage.sourceCount+discovery.remainingCount,discovery.eligibleCount);extractions.push(batch);
    const next=discovery.next;if(discovery.remainingCount){assert(next,'尚有相关来源必须提供sourceCursor继续');const key=JSON.stringify(next.arguments.sourceCursor);assert(!cursors.has(key),'高层来源游标不能循环');cursors.add(key);request=next.arguments;}else{assert.equal(next,undefined);request=null;}
    assert(extractions.length<=12,'来源批次受真实读取闭包上限约束');
  }
  const complete=extractions.at(-1);assert(complete.coverage.sourceCount,'应真实选择本企业有已知语义的来源');
  // cursor已继承此前读取闭包；末尾显式合并单ref，继续按最终overview实际候选保存。
  const merged=await readBaselineSection(client,{target,materialRefs:complete.materialRefs,section,limit});assert.equal(merged.sourceDiscovery.remainingCount,0);
  return {...merged,inventoryPages:[],discoveryPages:extractions.flatMap(x=>x.responses),extractions,allResponses:[...extractions.flatMap(x=>x.responses),...merged.responses],generationPath:section==='calculation'?'authorized_scope_discovery_calculation_schema_source_cursor_explicit_merge':'authorized_scope_discovery_extract_source_cursor_explicit_merge_actual_support_refs'};
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

export async function discoverBaselineCalculationMaterials(client,target){return readColdBaselineMaterials(client,target,{section:'calculation',explicitExtract:false,limit:3});}
