// 独立程序合同链使用的计算脚本；模型任务不读取本文件，也不证明模型自行归纳了算法。
import assert from 'node:assert/strict';

const dates=new Set(['service_start','service_end','invoice_date','receipt_date','payment_date','contract_due_date','confirmation_date','delivery_date','choice_valid_from','choice_valid_through']);
const periods=new Set(['period_start','period_end']);
const amounts=new Set(['amount_net','amount_tax','amount_gross','tax_amount','sales_ex_vat','revenue']);
const quantities=new Set(['opening_quantity','receipt_quantity','issue_quantity']);
const prices=new Set(['opening_unit_price','receipt_unit_price']);

// 从独立约定核对每个对象；不能只证明“存在一个库存字段”，忽略对象边界及月份类型。
export function assertBaselineCalculationSchema(schema,local){
  assert.equal(schema?.version,'finance-baseline-calculation-schema/1');assert.equal(schema.factSelection,'resolver_default');assert.equal(schema.objectCount,schema.objects.length);
  assert.equal(schema.objects.length,local.objects.length);const canonical=new Map(local.objects.map(o=>[o.objectRef,o])),seen=new Set();
  const expectedCounts=new Map();for(const object of local.objects){const kind=object.values.business_kind??null;expectedCounts.set(kind,(expectedCounts.get(kind)??0)+1);}assert.deepEqual(schema.kindCounts.map(item=>[item.business_kind,item.count]).sort(),[...expectedCounts].sort());
  for(const object of schema.objects){
    assert.match(object.objectRef,/^bg:[a-f0-9]{64}$/);assert(!seen.has(object.objectRef));seen.add(object.objectRef);
    assert.equal(object.unlistedFieldState,'not_available_in_bound_object');const actual=canonical.get(object.objectRef);assert(actual,'schema对象必须属于同一真实bridge闭包');
    assert.equal(object.fieldPresence,'available');assert.deepEqual(Object.keys(object.fields).sort(),Object.keys(actual.values).sort(),'每个对象的字段集必须与默认resolver相同');
    for(const [name,type]of Object.entries(object.fields)){
      const value=actual.values[name],expected=dates.has(name)?'date':periods.has(name)?'period':amounts.has(name)?'amount':quantities.has(name)?'quantity':prices.has(name)?'unit_price':name==='creates_asset'?'boolean':'enum';
      assert.equal(type,expected,name);assert.equal(schema.fieldTypes[type].jsonType,type==='quantity'?'integer':['amount','unit_price'].includes(type)?'number':type==='boolean'?'boolean':'string');
      if(expected==='date'){assert.equal(schema.fieldTypes[type].format,'YYYY-MM-DD');assert.equal(schema.fieldTypes[type].granularity,'day');assert.match(value,/^\d{4}-\d{2}-\d{2}$/);}
      else if(expected==='period'){assert.equal(schema.fieldTypes[type].format,'YYYY-MM');assert.equal(schema.fieldTypes[type].granularity,'month');assert.match(value,/^\d{4}-\d{2}$/);}
      else if(expected==='quantity')assert(Number.isInteger(value));
      else if(['amount','unit_price'].includes(expected))assert.equal(typeof value,'number');
      else assert.equal(typeof value,expected==='boolean'?'boolean':'string');
    }
    for(const [name,value]of Object.entries(object.semanticValues)){
      assert(['business_kind','service_pattern','tax_type','tax_measure','tax_stage','period_basis','accumulation','creates_asset'].includes(name),'语义值只允许受限业务/税维度与资产布尔');
      assert(['string','boolean'].includes(typeof value));assert.equal(value,actual.values[name]);
      assert(['enum','boolean'].includes(object.fields[name]),'原始日期/金额不能伪装语义值');
    }
  }
}

const common=`import fs from 'node:fs';
const i=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),p=i.parameters.period,r=i.parameters.reader,schema=i.parameters.calculationSchema;
const stop=code=>{throw Error(code);};
if(!schema||!Array.isArray(schema.objects)||schema.objects.length!==schema.objectCount||p!==i.parameters.target.period||!/^\\d{4}-\\d{2}$/.test(p))stop('calculation_schema_or_period_required');
const facts=await(await import(r.moduleUrl))[r.exportName]({target:i.parameters.target,materialRefs:i.parameters.materialRefs,expectedReaderSha256:r.sha256,...(i.parameters.factRefs?{factRefs:i.parameters.factRefs}:{})},i.financeContext),bound=new Map(facts.objects.map(o=>[o.objectRef,o]));
const has=(o,name)=>Object.hasOwn(o.fields,name),get=(o,name,type)=>{
 const definition=schema.fieldTypes[type],value=bound.get(o.objectRef)?.values[name];
 if(objectFieldUnavailable(o,name,type)||value===undefined)stop('required_typed_calculation_field_missing');
 if(type==='date'&&(definition.format!=='YYYY-MM-DD'||typeof value!=='string'||!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)))stop('calculation_date_format_mismatch');
 if(type==='period'&&(definition.format!=='YYYY-MM'||typeof value!=='string'||!/^\\d{4}-\\d{2}$/.test(value)))stop('calculation_period_format_mismatch');
 if(['amount','quantity','unit_price'].includes(type)&&(!Number.isFinite(value)||value<0))stop('calculation_numeric_field_unavailable');
 return value;
};
const objectFieldUnavailable=(o,name,type)=>!has(o,name)||o.fieldPresence!=='available'||o.fields[name]!==type||!schema.fieldTypes[type];
for(const object of schema.objects){const values=bound.get(object.objectRef)?.values;if(!values||object.unlistedFieldState!=='not_available_in_bound_object'||object.fieldPresence!=='available'||JSON.stringify(Object.keys(values).sort())!==JSON.stringify(Object.keys(object.fields).sort()))stop('calculation_schema_bound_object_mismatch');for(const [name,value]of Object.entries(object.semanticValues))if(values[name]!==value)stop('calculation_semantic_value_mismatch');}
const branch=(kind)=>{const candidates=schema.objects.filter(o=>o.semanticValues.business_kind===kind&&has(o,'amount_net'));if(!candidates.length)stop('required_business_object_unmatched');return candidates;};
const sum=(a,fn)=>a.reduce((n,v)=>n+fn(v),0),origin='test_authored_schema_to_local_reader_not_autonomous_model';
`;

export const BASELINE_CURRENT_A_SCRIPT=common+`
const service=(o,kind)=>{if(get(o,'business_kind','enum')!==kind||get(o,'service_pattern','enum')!=='even_service')stop('outside_tested_even_service_branch');const start=get(o,'service_start','date'),end=get(o,'service_end','date'),lastDay=new Date(Date.UTC(Number(end.slice(0,4)),Number(end.slice(5,7)),0)).getUTCDate();if(!start.endsWith('-01')||Number(end.slice(8,10))!==lastDay||end<start)stop('outside_tested_whole_month_service');return {o,start,end,months:(Number(end.slice(0,4))-Number(start.slice(0,4)))*12+Number(end.slice(5,7))-Number(start.slice(5,7))+1,amount:get(o,'amount_net','amount')};};
const leases=branch('lease').map(o=>service(o,'lease')),maintenance=branch('maintenance').map(o=>{if(get(o,'creates_asset','boolean')!==false)stop('maintenance_asset_boundary_unverified');return service(o,'maintenance');}),inPeriod=v=>v.start.slice(0,7)<=p&&v.end.slice(0,7)>=p;
const old=leases.filter(v=>inPeriod(v)&&v.start.slice(0,7)<p),fresh=leases.filter(v=>inPeriod(v)&&v.start.slice(0,7)===p),currentMaintenance=maintenance.filter(inPeriod);
if(!old.length||!fresh.length||!currentMaintenance.length)stop('required_current_period_business_unmatched');
const vat=v=>{const invoice=get(v.o,'invoice_date','date'),receipt=get(v.o,'receipt_date','date');if(invoice>v.start||receipt>invoice)stop('outside_tested_advance_invoice_conditions');return invoice.slice(0,7)===p?v.amount:0;},revenue=v=>v.amount/v.months,oldLeaseRevenue=sum(old,revenue),newLeaseRevenue=sum(fresh,revenue);
fs.writeFileSync(i.outputDir+'/7月业务结果.json',JSON.stringify({period:p,oldLeaseRevenue,newLeaseRevenue,totalLeaseRevenue:oldLeaseRevenue+newLeaseRevenue,newLeaseVatSales:sum(fresh,vat),oldLeaseAdditionalVatSales:sum(old,vat),maintenanceExpense:sum(currentMaintenance,revenue),maintenanceAdditionalInputVat:sum(currentMaintenance,v=>get(v.o,'confirmation_date','date').slice(0,7)===p?get(v.o,'amount_tax','amount'):0),reader:facts.reader,sourceDigests:facts.sourceDigests,schemaConsumption:{version:schema.version,leaseObjectRefs:[...old,...fresh].map(v=>v.o.objectRef),maintenanceObjectRefs:currentMaintenance.map(v=>v.o.objectRef)},origin},null,2));`;

export const BASELINE_CURRENT_B_SCRIPT=common+`
const inventory=schema.objects.filter(o=>has(o,'issue_quantity')).filter(o=>get(o,'period_start','period')<=p&&get(o,'period_end','period')>=p);
if(!inventory.length)stop('required_inventory_period_unmatched');
const inventoryIssueCost=sum(inventory,o=>{const issued=get(o,'issue_quantity','quantity'),opening=get(o,'opening_quantity','quantity');if(issued>opening)stop('outside_tested_fifo_layer');return issued*get(o,'opening_unit_price','unit_price');});
const repairs=branch('repair').map(o=>({o,accepted:has(o,'delivery_date'),delivery:has(o,'delivery_date')?get(o,'delivery_date','date'):null,amount:get(o,'amount_net','amount')})),completed=repairs.filter(v=>v.accepted&&v.delivery.slice(0,7)===p),unaccepted=repairs.filter(v=>!v.accepted);
if(!completed.length||!unaccepted.length)stop('required_repair_task_branch_unmatched');
const recognized=v=>v.accepted&&v.delivery.slice(0,7)===p?v.amount:0;
fs.writeFileSync(i.outputDir+'/乙7月业务结果.json',JSON.stringify({period:p,completedRepairRevenue:sum(completed,recognized),unacceptedRepairRevenue:sum(unaccepted,recognized),inventoryIssueCost,reader:facts.reader,sourceDigests:facts.sourceDigests,schemaConsumption:{version:schema.version,inventoryObjectRefs:inventory.map(o=>o.objectRef),repairObjectRefs:[...completed,...unaccepted].map(v=>v.o.objectRef),periodComparison:'calendar_month'},origin},null,2));`;
