// 聚焦材料分页与计算结构；只用新建合成现场，模型侧仅消费正常MCP安全投影。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createBaselineFixture,startBaselineMcp,baselineTarget} from './helpers/business-baseline-fixture.mjs';
import {readBaselineSection,fixtureSourceArgs,materialReference} from './helpers/business-baseline-test-inputs.mjs';
import {resolveBaselineCalculationFacts} from '../server/business-baseline.mjs';
import {BASELINE_DATE_FIELDS,BASELINE_PERIOD_FIELDS,BASELINE_AMOUNT_FIELDS,BASELINE_QUANTITY_FIELDS,BASELINE_FACT_VALUES} from '../server/business-baseline-contracts.mjs';

test('实际MCP材料分页与同一取数桥计算结构',{timeout:180000},async t=>{
 const f=createBaselineFixture(),target=baselineTarget(f),client=await startBaselineMcp(f),options={dbPath:f.dbPath,sourceRoot:f.sourceRoot,auditDir:f.auditDir,sessionPath:''};
 const wireSizes=[];
 const call=async(name,args)=>{const rpc=await client.rpc('tools/call',{name,arguments:name==='finance_baseline_materials'&&args.originals?fixtureSourceArgs(client,args):args});assert(!rpc.error);assert(!rpc.result.isError,JSON.stringify(rpc.result));const size=Buffer.byteLength(JSON.stringify(rpc.result,null,2));assert(size<=12288,'完整MCP结果 '+size);wireSizes.push(size);return rpc.result.structuredContent;};
 try{
  await t.test('无引用明细只投影账库，工具不会提取旁边的原件',async()=>{
   for(const section of ['facts','coverage','calculation']){
    const result=await call('finance_baseline_materials',{target,section,limit:1});
    assert.equal(result.section,section);assert.equal(result.coverage.sourceCount,0);
    assert(result[section==='facts'?'facts':section==='coverage'?'details':'calculationSchema']);
    if(section==='calculation')assert.equal(result.calculationSchema.objectCount,0);
   }
   const rejected=await client.call('finance_baseline_materials',{target,section:'calculation',extractKnownFields:false});
   assert(rejected.isError);assert.match(rejected.text,/invalid_arguments/);
   const overview=await call('finance_baseline_materials',{target});assert.equal(overview.coverage.sourceCount,0);assert.equal(overview.section,'overview');assert(!Object.hasOwn(overview,'baseline'));
  });
  await t.test('A/B每个objectRef与resolver默认字段集/语义类型一致，无原值、period不伪装date',async()=>{
   const zeroPath=join(f.sourceRoot,'zero-fields.json');writeFileSync(zeroPath,JSON.stringify({enterpriseKey:f.scopeB.enterpriseKey,业务类别:'存货',期初数量:0,期初单价:0,本月领用数量:0,所属期起:'2026-07',所属期止:'2026-07',验收日:null}));
   for(const name of ['a','b']){
    const target=baselineTarget(f,name),originals=Object.entries(f.files[name]).map(([id,path])=>({id,path}));
    if(name==='b')originals.push({id:'zero',path:zeroPath});
    const schema=await readBaselineSection(client,{target,originals,section:'calculation',limit:50});
    for(const response of schema.responses){wireSizes.push(response.prettyBytes);assert(response.prettyBytes<=12288);assert(!response.data.nextSteps.some(s=>s.action?.includes('tax_history')));}
    assert.equal(schema.calculationSchema.version,'finance-baseline-calculation-schema/1');assert.equal(schema.calculationSchema.factSelection,'resolver_default');const local=await resolveBaselineCalculationFacts({target,materialRefs:schema.materialRefs,expectedReaderSha256:schema.calculationReader.sha256},options);assert.equal(schema.calculationSchema.objectCount,local.objects.length);assert.equal(schema.calculationSchema.objects.length,local.objects.length);
    const byRef=new Map(local.objects.map(o=>[o.objectRef,o]));for(const object of schema.calculationSchema.objects){const actual=byRef.get(object.objectRef);assert(actual);assert.deepEqual(Object.keys(object.fields).sort(),Object.keys(actual.values).sort());assert.equal(object.fieldPresence,'available');assert.equal(object.unlistedFieldState,'not_available_in_bound_object');assert.equal(object.values,undefined);assert.equal(object.evidenceRefs,undefined);assert.equal(object.source,undefined);
     for(const [field,type]of Object.entries(object.fields)){const expected=BASELINE_DATE_FIELDS.includes(field)?'date':BASELINE_PERIOD_FIELDS.includes(field)?'period':BASELINE_QUANTITY_FIELDS.includes(field)?'quantity':['opening_unit_price','receipt_unit_price'].includes(field)?'unit_price':BASELINE_AMOUNT_FIELDS.includes(field)?'amount':field==='creates_asset'?'boolean':'enum';assert.equal(type,expected);const definition=schema.calculationSchema.fieldTypes[type];assert(definition);if(type==='date')assert.equal(definition.format,'YYYY-MM-DD');if(type==='period')assert.equal(definition.format,'YYYY-MM');if(type==='quantity')assert.equal(definition.jsonType,'integer');}
     for(const [field,value]of Object.entries(object.semanticValues)){assert.equal(value,actual.values[field]);assert(field==='creates_asset'?typeof value==='boolean':BASELINE_FACT_VALUES[field].includes(value));}
    }
    if(name==='a'){const maintenance=local.objects.find(o=>o.values.business_kind==='maintenance');assert(maintenance);const shape=schema.calculationSchema.objects.find(o=>o.objectRef===maintenance.objectRef);assert.equal(shape.fields.service_start,'date');assert.equal(shape.fields.service_end,'date');assert.equal(shape.fields.amount_net,'amount');const repair=local.objects.find(o=>o.values.business_kind==='repair'&&o.values.amount_net===80000);assert(repair);assert.equal(schema.calculationSchema.objects.find(o=>o.objectRef===repair.objectRef).fields.service_start,undefined);}
    else {const stock=local.objects.find(o=>o.values.issue_quantity===65);assert(stock);const shape=schema.calculationSchema.objects.find(o=>o.objectRef===stock.objectRef);assert.equal(shape.fields.period_start,'period');assert.equal(shape.fields.period_end,'period');assert.equal(shape.fields.issue_quantity,'quantity');assert.equal(shape.fields.opening_unit_price,'unit_price');const zero=local.objects.find(o=>o.values.issue_quantity===0);assert(zero);const zeroShape=schema.calculationSchema.objects.find(o=>o.objectRef===zero.objectRef);assert.equal(zeroShape.fields.issue_quantity,'quantity');assert.equal(zeroShape.fields.delivery_date,undefined);}
   }
  });
  await t.test('宽规范对象完整字段仍可单对象分页，默认scalar子集与schema不互相冒认',async()=>{
   const dir=join(f.sourceRoot,'wide'),path=join(dir,'wide.json');mkdirSync(dir);const data={enterpriseKey:f.scopeA.enterpriseKey};for(const [key,values]of Object.entries(BASELINE_FACT_VALUES))data[key]=values[0];Object.assign(data,{business_kind:'lease',service_pattern:'even_service',creates_asset:false});for(const key of BASELINE_DATE_FIELDS)data[key]=key==='service_end'?'2026-12-31':'2026-04-01';for(const key of BASELINE_PERIOD_FIELDS)data[key]='2026-04';for(const key of BASELINE_AMOUNT_FIELDS)data[key]=123.45;for(const key of BASELINE_QUANTITY_FIELDS)data[key]=7;writeFileSync(path,JSON.stringify(data));
   const result=await call('finance_baseline_materials',{target,originals:[{id:'wide',path}],section:'calculation'});assert.equal(result.calculationSchema.objectCount,1);assert.equal(Object.keys(result.calculationSchema.objects[0].fields).length,Object.keys(data).length-1);const local=await resolveBaselineCalculationFacts({target,materialRefs:[materialReference(result)],expectedReaderSha256:result.calculationReader.sha256},options);assert.deepEqual(Object.keys(result.calculationSchema.objects[0].fields).sort(),Object.keys(local.objects[0].values).sort());
   const originals=[{id:'wide',path}];
   for(let i=1;i<13;i++){
    const item={id:'wide_'+i,path:join(dir,'wide-'+i+'.json')};
    writeFileSync(item.path,JSON.stringify({...data,amount_net:123.45+i,issue_quantity:i===12?0:7}));originals.push(item);
   }
   writeFileSync(join(dir,'unverified.json'),JSON.stringify({inventory_cost:'fifo'}));writeFileSync(join(dir,'unread.pdf'),'%PDF-synthetic-only');
   const wideClient=await startBaselineMcp(f,{sourceRoot:dir}),objects=new Map();let args=fixtureSourceArgs(wideClient,{target,originals,section:'calculation'}),last,pages=0;
   try{
    while(args){assert(++pages<100);const rpc=await wideClient.rpc('tools/call',{name:'finance_baseline_materials',arguments:args});assert(!rpc.error);assert(!rpc.result.isError,JSON.stringify(rpc.result));const prettyBytes=Buffer.byteLength(JSON.stringify(rpc.result,null,2));wireSizes.push(prettyBytes);assert(prettyBytes<=12288);last=rpc.result.structuredContent;assert.equal(last.calculationSchema.fieldTypes.date.format,'YYYY-MM-DD');assert.equal(last.calculationSchema.fieldTypes.period.format,'YYYY-MM');for(const shape of last.calculationSchema.objects){assert.equal(Object.keys(shape.fields).length,Object.keys(data).length-1);objects.set(shape.objectRef,shape);}
     args=last.pagination.next?.arguments;
    }
    assert(pages>1);assert.equal(last.coverage.sourceCount,13);assert.equal(last.coverage.sourceOwners.agentIdentityMatched,13);assert.equal(objects.size,13);const actual=await resolveBaselineCalculationFacts({target,materialRefs:[materialReference(last)],expectedReaderSha256:last.calculationReader.sha256},{...options,sourceRoot:dir});assert.equal(actual.objects.length,13);for(const object of actual.objects)assert.deepEqual(Object.keys(objects.get(object.objectRef).fields).sort(),Object.keys(object.values).sort());assert(actual.objects.some(o=>o.values.issue_quantity===0));
   }finally{await wideClient.close();}
  });
  t.diagnostic('完整MCP材料结构最大 '+Math.max(...wireSizes)+' 字节');
 }finally{await client.close();}
});
