// 合成宿主先读取原件。真实 HTTP 和 MCP 只接收已整理的观察与引用。
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readXlsxStructure,readInvoiceXlsx} from '../server/offline-invoice-xlsx.mjs';
import {resolveBaselineCalculationFacts} from '../server/business-baseline.mjs';
import {writeFixtureObservations} from './helpers/business-baseline-test-inputs.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';

const materialTool='finance_baseline_materials';
const reference=result=>({materialRef:result.materialRef,snapshotDigest:result.snapshotDigest});
const tableValue=(value,row,column)=>({value,locator:{sheetIndex:0,row,column}});
const jsonValue=(value,jsonPointer)=>({value,locator:{jsonPointer}});
const tableOwner=(value,row,column)=>({role:'enterprise',enterpriseKey:tableValue(value,row,column)});
const jsonOwner=value=>({role:'enterprise',enterpriseKey:jsonValue(value,'/enterpriseKey')});

function startMcp(cwd,env={}){
 return new McpStdioClient(fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url)),{
  cwd,env:{...process.env,FINANCE_MCP_PROFILE:'direct',FINANCE_API_BASE:'http://127.0.0.1:1',NODE_NO_WARNINGS:'1',...env},timeoutMs:30000,
 }).start();
}
async function call(client,name,args){
 const rpc=await client.rpc('tools/call',{name,arguments:args});
 assert(!rpc.error,JSON.stringify(rpc.error));assert(!rpc.result.isError,JSON.stringify(rpc.result));
 if(name===materialTool)assert(Buffer.byteLength(JSON.stringify(rpc.result,null,2))<=12288);
 return rpc.result.structuredContent;
}
async function rejectCall(client,name,args,code){
 const result=await client.call(name,args);assert(result.isError,result.text);
 if(code)assert.equal(result.data.error,code);
 return result.data;
}

test('宿主观察经真实HTTP/MCP接收、取数与渐进保存',{timeout:120000},async t=>{
 const root=mkdtempSync(join(process.env.BASELINE_ADAPTER_TEST_PARENT??tmpdir(),'baseline-host-adapters-'));
 const data=join(root,'data'),sourceRoot=join(root,'sources'),auditDir=join(root,'calls');
 mkdirSync(data);mkdirSync(sourceRoot);
 const dbPath=join(data,'workbench.db'),enterpriseKey='PRIVATE-ADAPTER',sheetName='PRIVATE_原始表名';
 Object.assign(process.env,{WORKBENCH_DATA_DIR:data,FINANCE_DATABASE_PATH:dbPath,FINANCE_SOURCE_ROOT:sourceRoot,FINANCE_AUDIT_DIR:auditDir,FINANCE_BUSINESS_SESSION:''});
 delete process.env.WORKBENCH_DATABASE_MODE;
 const {db}=await import('../server/db.mjs'),accounting=await import('../server/accounting.mjs');
 const account=key=>accounting.createAccountSet({name:'合成基线 '+key,profileId:'small-2011-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:key}}).id;
 const target={accountSetId:account(enterpriseKey),period:'2026-07'},opts={dbPath,sourceRoot,auditDir,sessionPath:''};
 const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet(sheetName);
 sheet.addRow(['企业标识','成本方法','净额']);sheet.addRow([enterpriseKey,'先进先出法',12345.67]);
 const bytes=Buffer.from(await workbook.xlsx.writeBuffer()),path=join(sourceRoot,'private.xlsx');writeFileSync(path,bytes);
 const hostWorkbook=await new ExcelJS.Workbook().xlsx.load(readFileSync(path));
 const hostSheet=hostWorkbook.getWorksheet(sheetName);
 const artifact=(view={},originalPath=path)=>writeFixtureObservations(auditDir,{target,
  originals:[{id:'workbook',path:originalPath,owner:tableOwner(hostSheet.getCell('A2').value,2,1)}],
  records:[{id:'asset',originalId:'workbook',fields:[
   {field:'inventory_cost',...tableValue(hostSheet.getCell('B2').value,2,2)},
   {field:'amount_net',...tableValue(hostSheet.getCell('C2').value,2,3)},
  ]}],
 },view);
 const safe=value=>{
  const packet=JSON.stringify(value);
  for(const marker of [sheetName,enterpriseKey,'12345.67','先进先出法',sourceRoot])assert(!packet.includes(marker),marker);
 };
 try{
  await t.test('既有显式发票导入仍保留类型与公式保护',async()=>{
   assert.equal(readXlsxStructure(bytes).rows[1].cells[2],'12345.67');
   assert.equal(readInvoiceXlsx(bytes,{sheet:sheetName,headerRow:1,columns:{net:'净额'}}).rows[0].cells[2],'12345.67');
   sheet.getCell('C2').value={formula:'12345+0.67',result:12345.67};
   const formula=Buffer.from(await workbook.xlsx.writeBuffer());
   assert.throws(()=>readXlsxStructure(formula),{code:'xlsx_formula_unsupported'});
   assert.throws(()=>readInvoiceXlsx(formula,{sheet:sheetName,headerRow:1,columns:{net:'净额'}}),{code:'xlsx_formula_unsupported'});
  });
  await t.test('实际HTTP共享同一观察入口、授权与保存边界',async()=>{
   const child=spawn(process.execPath,[fileURLToPath(new URL('../server/server.mjs',import.meta.url))],{
    env:{...process.env,PORT:'0',HOST:'127.0.0.1',NODE_NO_WARNINGS:'1'},windowsHide:true,stdio:['ignore','pipe','pipe'],
   });
   const exited=once(child,'exit');
   try{
    const base=await new Promise((resolve,reject)=>{
     let output='',errors='';
     const timer=setTimeout(()=>reject(Error('synthetic_http_start_timeout')),20000);
     child.stderr.on('data',chunk=>{errors+=chunk;});
     child.once('exit',code=>{clearTimeout(timer);reject(Error('synthetic_http_exit_'+code+':'+errors));});
     child.stdout.on('data',chunk=>{
      output+=chunk;
      const port=/127\.0\.0\.1:(\d+)\//.exec(output)?.[1];
      if(port){clearTimeout(timer);resolve('http://127.0.0.1:'+port);}
     });
    });
    const post=async(action,args)=>{
     const response=await fetch(base+'/api/business-baseline/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)});
     return {status:response.status,data:await response.json()};
    };
    const initial=await post('read',{target});assert.equal(initial.status,200);assert.equal(initial.data.status,'needs_generation');
    const outside=await post('materials',{target,inputPath:path});assert.equal(outside.status,400);assert.equal(outside.data.error,'finance_baseline_observations_path_invalid');
    const material=await post('materials',artifact());assert.equal(material.status,200);assert.equal(material.data.semanticAuthority,'agent_observation');safe(material);
    const inventory=material.data.principleSupport.find(p=>p.kind==='inventory_cost');assert.equal(inventory.value,'fifo');
    const saved=await post('save',{target,materialRefs:[reference(material.data)],expectedRevision:0,effectiveFrom:target.period,principles:[{supportRef:inventory.supportRef}]});
    assert.equal(saved.status,200);assert.equal(saved.data.status,'needs_review');assert(saved.data.unresolved.some(g=>g.code==='tax_history_missing'));
    const rejected=await post('save',{target,shortText:'PRIVATE_伪造常驻正文'});
    assert.equal(rejected.status,400);assert.equal(rejected.data.error,'finance_baseline_input_invalid');safe(rejected);
   }finally{child.kill();await exited;}
  });
  await t.test('MCP仍可从真实材料引用取本机规范对象，拒绝旧读取和篡改',async()=>{
   const client=startMcp(root);
   try{
    await client.initialize('synthetic-host-calculation');
    const tools=(await client.rpc('tools/list')).result.tools;
    const properties=tools.find(t=>t.name===materialTool).inputSchema.properties;
    assert(properties.inputPath);for(const field of ['originals','sourceCursor','extractKnownFields','selections','adaptation','businessEvidence'])assert(!Object.hasOwn(properties,field));
    const ledger=await call(client,materialTool,{target});assert.equal(ledger.coverage.sourceCount,0);assert(!Object.hasOwn(ledger,'sourceInventory'));
    const old=await rejectCall(client,materialTool,{target,originals:[{id:'workbook',path}],extractKnownFields:true},'invalid_arguments');
    assert.deepEqual(old.details.nextSteps[0].arguments,{recordType:'baseline'});
    const request=artifact({section:'calculation'}),material=await call(client,materialTool,request);
    assert.equal(material.calculationSchema.objectCount,1);assert.equal(material.calculationSchema.objects[0].fields.amount_net,'amount');safe(material);
    const readerArgs={target,materialRefs:[reference(material)],expectedReaderSha256:material.calculationReader.sha256};
    const local=await resolveBaselineCalculationFacts(readerArgs,{...opts,readOnly:true});
    assert.equal(local.objects[0].values.amount_net,12345.67);
    const script="import fs from 'node:fs';const i=JSON.parse(fs.readFileSync(process.argv[2]));if(i.financeContext.dbPath===i.parameters.fakeDb)throw Error('caller_override');const r=await import(i.parameters.reader.moduleUrl);const data=await r.resolveBaselineCalculationFacts(i.parameters.request,i.financeContext);fs.writeFileSync(i.outputDir+'/bridge.json',JSON.stringify(data));";
    const calculated=await call(client,'finance_calculation_run',{title:'合成取数桥',engine:'javascript',sources:[],parameters:{reader:material.calculationReader,request:readerArgs,fakeDb:'PRIVATE_OVERRIDE'},script});
    assert.equal(calculated.status,'executed');assert(!JSON.stringify(calculated).includes('12345.67'));
    const result=JSON.parse(readFileSync(calculated.outputs.find(item=>item.path.endsWith('bridge.json')).path,'utf8'));assert.equal(result.objects[0].values.amount_net,12345.67);
    await assert.rejects(resolveBaselineCalculationFacts({...readerArgs,expectedReaderSha256:'0'.repeat(64)},opts),{code:'finance_baseline_reader_version_conflict'});
    const other={...target,accountSetId:account('BRIDGE-OTHER')};
    await rejectCall(client,materialTool,{...request,target:other},'finance_baseline_observations_scope_conflict');
    const external=join(root,'outside.xlsx');writeFileSync(external,bytes);
    await rejectCall(client,materialTool,artifact({},external),'finance_baseline_source_forbidden');
    const originalPacket=readFileSync(request.inputPath);writeFileSync(request.inputPath,Buffer.concat([originalPacket,Buffer.from('\n')]));
    await rejectCall(client,materialTool,{target,materialRefs:[reference(material)]},'finance_baseline_material_changed');writeFileSync(request.inputPath,originalPacket);
    writeFileSync(path,'changed');await rejectCall(client,materialTool,{target,materialRefs:[reference(material)]},'finance_baseline_material_changed');writeFileSync(path,bytes);
   }finally{await client.close();}
  });
  await t.test('同根原件与派生产物隔离，显式选证的跨页闭包可保存',async()=>{
   const key='SYNTHETIC-OBSERVATION-CLOSURE',scopeTarget={accountSetId:account(key),period:'2026-07'},sameRoot=join(root,'same-root');
   mkdirSync(sameRoot);
   // 普通客户文件可以恰好叫 baseline-materials.json。
   const originalPath=join(sameRoot,'baseline-materials.json'),taxRow=(from,amount,sales)=>({tax_type:'vat',tax_measure:'payable',tax_stage:'payable_after_relief',period_basis:'attribution',accumulation:'current',period_start:from,period_end:from,tax_amount:amount,sales_ex_vat:sales});
   const original={enterpriseKey:key,inventory_cost:'fifo',enterprise_class:'services',rows:[
    taxRow('2026-04',1800,100000),taxRow('2026-05',2400,120000),taxRow('2026-06',1760,80000),
    {tax_type:'cit',tax_measure:'payable',tax_stage:'payable_after_relief',period_basis:'attribution',accumulation:'cumulative',period_start:'2026-01',period_end:'2026-06',tax_amount:3000,revenue:600000},
   ]};
   writeFileSync(originalPath,JSON.stringify(original));
   const observed=JSON.parse(readFileSync(originalPath,'utf8'));
   const packet=(id,indices,view={})=>{
    const records=indices.map(index=>({id:'row_'+index,originalId:id,fields:Object.entries(observed.rows[index]).map(([field,value])=>({field,...jsonValue(value,'/rows/'+index+'/'+field)}))}));
    records.unshift({id:'policy',originalId:id,fields:['inventory_cost','enterprise_class'].map(field=>({field,...jsonValue(observed[field],'/'+field)}))});
    return writeFixtureObservations(sameRoot,{target:scopeTarget,originals:[{id,path:originalPath,owner:jsonOwner(observed.enterpriseKey)}],records},view);
   };
   const client=startMcp(root,{FINANCE_SOURCE_ROOT:sameRoot,FINANCE_AUDIT_DIR:sameRoot});
   try{
    await client.initialize('synthetic-explicit-selected-closure');
    const first=await call(client,materialTool,packet('first',[0],{limit:1}));
    const tail=await call(client,materialTool,packet('tail',[1,2,3],{limit:1}));
    assert.equal(first.coverage.sourceCount,1);assert.equal(first.coverage.sourceOwners.agentIdentityMatched,1);
    assert.equal(first.coverage.taxHistory.cit.status,'not_in_supplied_materials');
    const detail=await call(client,materialTool,{target:scopeTarget,materialRefs:[reference(first)],section:'coverage'});
    assert.equal(detail.details[0].declaredCount,11);assert.equal(detail.details[0].acceptedCount,11);
    let merged=await call(client,materialTool,{target:scopeTarget,materialRefs:[reference(first),reference(tail)],limit:1}),supports=[];
    const snapshotDigest=merged.snapshotDigest;
    for(let i=0;;i++){
     assert(i<24);assert.equal(merged.snapshotDigest,snapshotDigest);assert.equal(merged.coverage.requestCount,2);
     supports.push(...merged.principleSupport);
     if(!merged.pagination.next)break;
     merged=await call(client,materialTool,merged.pagination.next.arguments);
    }
    assert.equal(merged.coverage.sourceCount,1);assert.equal(merged.coverage.taxHistory.vat.status,'included');assert.equal(merged.coverage.taxHistory.cit.status,'included');
    assert.equal(merged.coverage.factCount,tail.coverage.factCount+Object.keys(observed.rows[0]).length,'两张观察产物只补齐缺少的税行');
    const inventory=supports.find(s=>s.kind==='inventory_cost');assert(inventory);
    let facts=await call(client,materialTool,{target:scopeTarget,materialRefs:[reference(merged)],section:'facts',limit:1});
    for(let i=0;i<5;i++){
     assert(facts.pagination.next);facts=await call(client,materialTool,facts.pagination.next.arguments);assert.equal(facts.snapshotDigest,snapshotDigest);
    }
    const save={target:scopeTarget,materialRefs:[reference(facts)],expectedRevision:0,effectiveFrom:scopeTarget.period,principles:[{supportRef:inventory.supportRef}]};
    await rejectCall(client,'finance_baseline_save',{...save,principles:[{supportRef:'bp:'+'0'.repeat(64)}]},'finance_baseline_support_not_returned');
    const saved=await call(client,'finance_baseline_save',save);
    assert.equal(saved.status,'ready');assert.match(saved.shortText,/先进先出/);assert.match(saved.shortText,/1\.99%/);assert.match(saved.shortText,/0\.50%/);
    const copied=writeFixtureObservations(sameRoot,{target:scopeTarget,originals:[{id:'generated',path:packet('other',[]).inputPath,owner:jsonOwner(key)}]});
    await rejectCall(client,materialTool,copied,'finance_baseline_generated_not_original');
    assert.equal(readFileSync(originalPath,'utf8'),JSON.stringify(original));
   }finally{await client.close();}
  });
 }finally{db.close();}
});
