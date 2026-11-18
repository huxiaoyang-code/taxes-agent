// 真实 HTTP 与 XLSX/CSV 安全结构发现；原件、账库和端口全部临时合成。
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {readXlsxStructure,readInvoiceXlsx} from '../server/offline-invoice-xlsx.mjs';
import {resolveBaselineCalculationFacts,readBusinessBaseline} from '../server/business-baseline.mjs';
import {withFinanceCall,annotateFinanceCall} from '../server/finance-call-chain.mjs';
import {createHash} from 'node:crypto';
import {readBackendBaselinePages as readBaselineMaterials} from './helpers/business-baseline-backend-pages.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';

test('基线 XLSX/CSV 结构发现不泄漏表名或原值，原解析器继续拒绝缓存公式',{timeout:60000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'baseline-adapters-')),data=join(root,'data'),sourceRoot=join(root,'sources'),auditDir=join(root,'calls');mkdirSync(data);mkdirSync(sourceRoot);
 Object.assign(process.env,{WORKBENCH_DATA_DIR:data,FINANCE_DATABASE_PATH:join(data,'workbench.db'),FINANCE_SOURCE_ROOT:sourceRoot,FINANCE_AUDIT_DIR:auditDir,FINANCE_BUSINESS_SESSION:''});delete process.env.WORKBENCH_DATABASE_MODE;
 const {db}=await import('../server/db.mjs'),A=await import('../server/accounting.mjs'),id=A.createAccountSet({name:'PRIVATE_适配企业',profileId:'small-2011-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:'PRIVATE-ADAPTER'}}).id;
 const options={dbPath:process.env.FINANCE_DATABASE_PATH,sourceRoot,auditDir,sessionPath:''},target={accountSetId:id,period:'2026-07'};
 const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('PRIVATE_人员姓名和原始表名');sheet.addRow(['enterpriseKey','costMethod','amount_net']);sheet.addRow(['PRIVATE-ADAPTER','先进先出法',12345.67]);
 const bytes=Buffer.from(await workbook.xlsx.writeBuffer()),path=join(sourceRoot,'private.xlsx');writeFileSync(path,bytes);
 let child;
 try{
  await t.test('安全解析复用及编号定位',async()=>{
   const local=readXlsxStructure(bytes);assert.equal(local.rows[1].cells[2],'12345.67');assert.equal(readInvoiceXlsx(bytes,{sheet:sheet.name,headerRow:1,columns:{net:'amount_net'}}).rows[0].cells[2],'12345.67');
   const discovered=await readBaselineMaterials({target,originals:[{id:'x',path}]},options);assert.equal(discovered.fields[0].sheetIndex,0);assert(discovered.fields.some(h=>h.column===2&&h.suggestedFields.includes('inventory_cost')));
   const safe=JSON.stringify(discovered);for(const marker of [sheet.name,'PRIVATE-ADAPTER','12345.67','先进先出法',sourceRoot])assert(!safe.includes(marker),marker);
   const selected=await readBaselineMaterials({target,originals:[{id:'x',path}],selections:[{id:'cost',field:'inventory_cost',originalId:'x',locator:{sheetIndex:0,row:2,column:2}}]},options);assert.equal(selected.facts.find(f=>f.id==='cost').value,'fifo');
   const csv=join(sourceRoot,'cost.csv');writeFileSync(csv,'enterpriseKey,costMethod,PRIVATE_PERSON\nPRIVATE-ADAPTER,先进先出法,LOCAL_ONLY\n');const parsed=await readBaselineMaterials({target,originals:[{id:'c',path:csv}],selections:[{id:'cost',field:'inventory_cost',originalId:'c',locator:{row:2,column:2}}]},options);assert.equal(parsed.facts.find(f=>f.id==='cost').value,'fifo');assert(!JSON.stringify(parsed).includes('PRIVATE_PERSON'));
  });
  await t.test('通用结构保留未核公式位置，普通单元格可用且不能采信公式缓存',async()=>{
   sheet.getCell('C2').value={formula:'12345+0.67',result:12345.67};const formula=Buffer.from(await workbook.xlsx.writeBuffer()),formulaPath=join(sourceRoot,'formula.xlsx');writeFileSync(formulaPath,formula);
   assert.throws(()=>readXlsxStructure(formula),{code:'xlsx_formula_unsupported'});assert.throws(()=>readInvoiceXlsx(formula,{sheet:sheet.name,headerRow:1,columns:{net:'amount_net'}}),{code:'xlsx_formula_unsupported'});
   const structure=await readBaselineMaterials({target,originals:[{id:'f',path:formulaPath}]},options);assert(structure.fields.some(field=>field.valueState==='formula_unverified'&&field.position?.row===2&&field.position.column===3));
   const ordinary=await readBaselineMaterials({target,originals:[{id:'f',path:formulaPath}],selections:[{id:'ordinary_cost',originalId:'f',field:'inventory_cost',locator:{sheetIndex:0,row:2,column:2}}]},options);assert.equal(ordinary.facts.find(fact=>fact.id==='ordinary_cost').value,'fifo');
   await assert.rejects(readBaselineMaterials({target,originals:[{id:'f',path:formulaPath}],selections:[{id:'unverified_amount',originalId:'f',field:'amount_net',locator:{sheetIndex:0,row:2,column:3}}]},options),{code:'xlsx_formula_unsupported'});
  });
  await t.test('真实 HTTP 共享固定投影、材料记录及保存保护',async()=>{
   const base=await new Promise((resolve,reject)=>{
    let out='',error='';child=spawn(process.execPath,[fileURLToPath(new URL('../server/server.mjs',import.meta.url))],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',NODE_NO_WARNINGS:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
    const timer=setTimeout(()=>{child.kill();reject(Error('synthetic_http_start_timeout'));},20000);child.stderr.on('data',b=>error+=b);child.once('exit',code=>{clearTimeout(timer);reject(Error('synthetic_http_exit_'+code+':'+error));});child.stdout.on('data',b=>{out+=b;const found=/127\.0\.0\.1:(\d+)\//.exec(out);if(found){clearTimeout(timer);resolve('http://127.0.0.1:'+found[1]);}});
   });
   const post=async(action,args)=>{const response=await fetch(base+'/api/business-baseline/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)});return {status:response.status,data:await response.json()};};
   const read=await post('read',{target});assert.equal(read.status,200);assert.equal(read.data.status,'needs_generation');
   const materials=await post('materials',{target,originals:[{id:'x',path}],selections:[{id:'cost',field:'inventory_cost',originalId:'x',locator:{sheetIndex:0,row:2,column:2}}]});assert.equal(materials.status,200);
   const m=materials.data,principles=m.principleSupport.filter(p=>['accounting_standard','inventory_cost'].includes(p.kind)).map(p=>({supportRef:p.supportRef}));
   const saved=await post('save',{target,materialRefs:[{materialRef:m.materialRef,snapshotDigest:m.snapshotDigest}],expectedRevision:0,effectiveFrom:'2026-07',principles});assert.equal(saved.status,200);assert.equal(saved.data.status,'needs_review');assert(saved.data.unresolved.some(g=>g.code==='tax_history_missing'));
   const rejected=await post('save',{target,shortText:'PRIVATE_伪造常驻正文'});assert.equal(rejected.status,400);assert.equal(rejected.data.error,'finance_baseline_input_invalid');
   const safe=JSON.stringify([read,materials,saved,rejected]);assert(!safe.includes('PRIVATE_'));assert(!safe.includes('12345.67'));assert(!safe.includes(sourceRoot));
  });
  await t.test('仅目录的真实MCP inventory→安全定位→计算器取数桥，不需要原JSON键或子进程凭据环境',async()=>{
   const client=new McpStdioClient(fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url)),{cwd:root,env:{...process.env,FINANCE_MCP_PROFILE:'direct',FINANCE_API_BASE:'http://127.0.0.1:1',NODE_NO_WARNINGS:'1'},timeoutMs:30000}).start();
   try{
    await client.initialize();const call=async(name,args)=>{const result=await client.call(name,args);assert.equal(result.isError,false,result.text);return result.data;};
    let inventory=await call('finance_baseline_materials',{target,limit:50}),item=inventory.sourceInventory.items.find(i=>i.format==='xlsx'&&i.status==='inspectable');
    for(let page=0;!item&&inventory.pagination.next;page++){assert(page<50,'inventory续页必须有界');assert.equal(inventory.pagination.next.tool,'finance_baseline_materials');inventory=await call(inventory.pagination.next.tool,inventory.pagination.next.arguments);item=inventory.sourceInventory.items.find(i=>i.format==='xlsx'&&i.status==='inspectable');}
    assert(item?.originalRef);assert(!JSON.stringify(inventory.sourceInventory).includes('private.xlsx'));
    const discovered=await call('finance_baseline_materials',{target,originals:[{id:'selected',originalRef:item.originalRef}]});const header=discovered.fields.find(h=>h.suggestedFields.includes('amount_net'));
    const materials=await call('finance_baseline_materials',{target,originals:[{id:'selected',originalRef:item.originalRef}],selections:[{id:'amount',field:'amount_net',originalId:'selected',locator:{sheetIndex:0,row:header.row+1,column:header.column}}]});
    const args={target,materialRefs:[{materialRef:materials.materialRef,snapshotDigest:materials.snapshotDigest}],expectedReaderSha256:materials.calculationReader.sha256};
    const local=await resolveBaselineCalculationFacts(args,{...options,readOnly:true});assert(local.objects.some(o=>o.values.amount_net===12345.67));assert(!local.objects.some(o=>o.values.business_reference));
    const script="import fs from 'node:fs';const i=JSON.parse(fs.readFileSync(process.argv[2]));if(i.financeContext.dbPath===i.parameters.financeContext.dbPath)throw Error('caller_context_override');const r=await import(i.parameters.reader.moduleUrl);const data=await r.resolveBaselineCalculationFacts(i.parameters.request,i.financeContext);fs.writeFileSync(i.outputDir+'/bridge-result.json',JSON.stringify(data));";
    const ran=await call('finance_calculation_run',{title:'合成取数桥实际子进程',engine:'javascript',sources:[],parameters:{reader:materials.calculationReader,request:args,financeContext:{dbPath:'UNTRUSTED_CALLER_VALUE'}},script});assert.equal(ran.status,'executed');const output=JSON.parse(readFileSync(ran.outputs.find(o=>o.path.endsWith('bridge-result.json')).path));assert.equal(output.objects[0].values.amount_net,12345.67);assert(output.reader.sha256&&output.sourceDigests.length);assert(!JSON.stringify(ran).includes('12345.67'));
    await assert.rejects(resolveBaselineCalculationFacts({...args,expectedReaderSha256:'0'.repeat(64)},options),{code:'finance_baseline_reader_version_conflict'});
    const other=A.createAccountSet({name:'合成桥乙',profileId:'small-2011-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:'BRIDGE-OTHER'}}).id;await assert.rejects(resolveBaselineCalculationFacts({...args,target:{...target,accountSetId:other}},options),{code:'finance_baseline_material_record_invalid'});
    writeFileSync(path,Buffer.from('changed'));await assert.rejects(resolveBaselineCalculationFacts(args,options));writeFileSync(path,bytes);
   }finally{await client.close();}
  });
  await t.test('JSON与CSV三行同名税字段按真实位置计覆盖，显式合并不把一行冒认全部已读',async()=>{
   const rows=[
    {taxType:'增值税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'本期',periodStart:'2026-04',periodEnd:'2026-04',taxAmount:1800,sales:100000},
    {taxType:'增值税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'本期',periodStart:'2026-05',periodEnd:'2026-05',taxAmount:2400,sales:120000},
    {taxType:'增值税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'本期',periodStart:'2026-06',periodEnd:'2026-06',taxAmount:1760,sales:80000},
   ],fields=['tax_type','tax_measure','tax_stage','period_basis','accumulation','period_start','period_end','tax_amount','sales_ex_vat'],columns=Object.keys(rows[0]);
   const {readBaselineMaterials:read}=await import('../server/business-baseline.mjs');
   for(const format of ['json','csv']){
    const path=join(sourceRoot,'coverage-three-rows.'+format);writeFileSync(path,format==='json'?JSON.stringify({enterpriseKey:'PRIVATE-ADAPTER',rows}):['enterpriseKey,'+columns.join(','),...rows.map(r=>'PRIVATE-ADAPTER,'+Object.values(r).join(','))].join('\n'));
    const original={id:'threeRows',path},select=(row,alias)=>fields.map((field,column)=>({id:'row'+row+'_'+column,field,originalId:alias,locator:format==='json'?{jsonPointer:`/rows/${row}/${columns[column]}`}:{row:row+2,column:column+2}})),refs=m=>({materialRef:m.materialRef,snapshotDigest:m.snapshotDigest});
    const first=await read({target,originals:[original],selections:select(0,original.id)},options);assert.equal(first.coverage.unselectedLocationCount,18);assert(first.coverage.knownFieldsNotSelected.includes('tax_amount'));assert(first.coverage.knownFieldsNotSelected.includes('period_start'));assert.equal(first.coverage.taxHistory.vat.status,'included');
    const second=await read({target,originals:[{...original,id:'secondAlias'}],selections:select(1,'secondAlias')},options),partial=await read({target,materialRefs:[refs(first),refs(second)]},options);assert.equal(partial.coverage.unselectedLocationCount,9);assert(partial.coverage.knownFieldsNotSelected.includes('tax_amount'));
    const third=await read({target,originals:[{...original,id:'thirdAlias'}],selections:select(2,'thirdAlias')},options),merged=await read({target,materialRefs:[refs(partial),refs(third)]},options);assert.equal(merged.coverage.unselectedLocationCount,0);assert.deepEqual(merged.coverage.knownFieldsNotSelected,[]);
    const auto=await read({target,originals:[original],extractKnownFields:true},options);assert.equal(auto.coverage.unselectedLocationCount,0);assert.deepEqual(auto.coverage.knownFieldsNotSelected,[]);
   }
  });
  await t.test('高层真实MCP按已核主体取材，跨批游标继承早期证据且不接受跨根/跨主体/变源',{timeout:90000},async()=>{
   const key='SYNTHETIC-DISCOVERY',id=A.createAccountSet({name:'合成目录直接取材',profileId:'small-2011-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:key}}).id,target={accountSetId:id,period:'2026-07'},autoRoot=join(root,'auto-sources'),otherRoot=join(root,'auto-other-root');mkdirSync(autoRoot);mkdirSync(otherRoot);
   const json=(name,value)=>writeFileSync(join(autoRoot,name),JSON.stringify(value));json('a-cost.json',{enterpriseKey:key,costMethod:'先进先出法'});writeFileSync(join(autoRoot,'b-cost.csv'),'enterpriseKey,costMethod\n'+key+',先进先出法\n');const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('LOCAL_ONLY_DISCOVERY_SHEET');sheet.addRow(['enterpriseKey','costMethod']);sheet.addRow([key,'先进先出法']);writeFileSync(join(autoRoot,'c-cost.xlsx'),Buffer.from(await workbook.xlsx.writeBuffer()));
   for(let i=0;i<12;i++)json('d-business-'+String(i).padStart(2,'0')+'.json',{enterpriseKey:key,业务编号:'AUTO-WORK-'+i,业务类别:'维修',提供方式:'一次完工',客户签收验收日:'2026-06-25',净价:100+i});
   const taxPath=join(autoRoot,'z-tax.json'),tax={enterpriseKey:key,returns:[{taxType:'增值税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'本期',periodStart:'2026-04',periodEnd:'2026-04',taxAmount:1800,sales:100000}]};json('z-tax.json',tax);json('no-owner.json',{costMethod:'先进先出法'});json('no-field.json',{enterpriseKey:key,本机备注:'LOCAL_ONLY_UNRECOGNIZED'});json('opaque-note.json',{本机备注:'LOCAL_ONLY_UNRECOGNIZED'});json('other-company.json',{enterpriseKey:'SYNTHETIC-OTHER-COMPANY',costMethod:'先进先出法'});
   const start=sourceRoot=>new McpStdioClient(fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url)),{cwd:root,env:{...process.env,FINANCE_MCP_PROFILE:'direct',FINANCE_SOURCE_ROOT:sourceRoot,FINANCE_API_BASE:'http://127.0.0.1:1',NODE_NO_WARNINGS:'1'},timeoutMs:30000}).start(),client=start(autoRoot),sizes=[];
   try{
    await client.initialize('synthetic-source-discovery');const call=async args=>{const rpc=await client.rpc('tools/call',{name:'finance_baseline_materials',arguments:args});assert(!rpc.error);assert(!rpc.result.isError,JSON.stringify(rpc.result));const bytes=Buffer.byteLength(JSON.stringify(rpc.result,null,2));assert(bytes<=12288);sizes.push(bytes);return rpc.result.structuredContent;},ref=m=>({materialRef:m.materialRef,snapshotDigest:m.snapshotDigest});
    let first=await call({target,extractKnownFields:true}),support=[];assert.equal(first.coverage.sourceCount,12);assert.deepEqual(first.coverage.sourceOwners,{checked:12,unverified:0});assert.equal(first.sourceDiscovery.eligibleCount,16);assert.equal(first.sourceDiscovery.remainingCount,4);assert.equal(first.sourceDiscovery.bypassed.owner_unverified,1);assert.equal(first.sourceDiscovery.bypassed.other_scope,1);assert.equal(first.sourceDiscovery.bypassed.no_known_fields,2);assert.equal(first.sourceDiscovery.scanLimited,false);assert.deepEqual(first.gaps,[]);
    for(let i=0;;i++){assert(i<24);support.push(...first.principleSupport);if(!first.pagination.next)break;first=await call(first.pagination.next.arguments);assert.deepEqual(first.sourceDiscovery.next.arguments.sourceCursor,ref(first),'本批展示续页的源游标绑定当前完整call，保留已返回支持');}
    const early=support.find(p=>p.kind==='inventory_cost');assert(early);const next=first.sourceDiscovery.next;assert(next);assert.equal(next.arguments.offset,undefined);assert.equal(next.arguments.originals,undefined);
    const cross=await client.call('finance_baseline_materials',{...next.arguments,target:{...target,accountSetId:target.accountSetId+1000}});assert(cross.isError);
    const other=start(otherRoot);try{await other.initialize('synthetic-wrong-root');assert((await other.call('finance_baseline_materials',next.arguments)).isError);}finally{await other.close();}
    const forged=await client.call('finance_baseline_materials',{...next.arguments,sourceCursor:{...next.arguments.sourceCursor,snapshotDigest:'0'.repeat(64)}});assert(forged.isError);
    let last=await call(next.arguments);assert.equal(last.coverage.sourceCount,16);assert.equal(last.coverage.requestCount,2);assert.deepEqual(last.coverage.sourceOwners,{checked:16,unverified:0});assert.equal(last.sourceDiscovery.remainingCount,0);assert.equal(last.sourceDiscovery.next,undefined);assert.equal(last.coverage.taxHistory.vat.status,'included');assert.deepEqual(last.gaps,[]);
    for(let i=0;last.pagination.next;i++){assert(i<24);last=await call(last.pagination.next.arguments);}
    const result=await client.call('finance_baseline_save',{target,materialRefs:[ref(last)],expectedRevision:0,effectiveFrom:'2026-07',principles:[{supportRef:early.supportRef}]});assert(!result.isError,result.text);assert.equal(result.data.status,'ready');assert.match(result.data.shortText,/先进先出/);assert.equal(result.data.coverage.sourceCount,16,'只保存末批ref仍含早批实际证据');
    const end=JSON.parse(readFileSync(join(auditDir,last.materialRef,'end.json'))),snapshot=JSON.parse(readFileSync(join(auditDir,last.materialRef,end.metadata.businessBaselineMaterials.file)));assert.equal(snapshot.requests.length,2);assert(snapshot.requests.every(r=>r.originals?.length&&!r.sourceCursor&&!r.materialRefs));
    writeFileSync(taxPath,JSON.stringify({...tax,returns:tax.returns.map(r=>({...r,taxAmount:1900}))}));assert((await client.call('finance_baseline_materials',next.arguments)).isError,'未选下一批的原件变SHA也不能沿旧发现游标继续');writeFileSync(taxPath,JSON.stringify(tax));
    const limited=join(root,'auto-limited');mkdirSync(limited);for(let i=0;i<130;i++)writeFileSync(join(limited,String(i).padStart(3,'0')+'.json'),JSON.stringify({enterpriseKey:key,本机备注:'NO_FIELDS'}));const limitedClient=start(limited);try{await limitedClient.initialize();const r=await limitedClient.call('finance_baseline_materials',{target,extractKnownFields:true});assert(!r.isError,r.text);assert.equal(r.data.sourceDiscovery.scanLimited,true);assert.equal(r.data.sourceDiscovery.uninspectedCount,2);assert.equal(r.data.coverage.sourceCount,0);}finally{await limitedClient.close();}
    assert(!JSON.stringify(last).includes('LOCAL_ONLY_'));t.diagnostic('高层跨批完整MCP最大 '+Math.max(...sizes)+' 字节');
   }finally{await client.close();}
  });
  await t.test('33小源可完成；审计在资料子目录或同根时自写记录不使游标失效，也不成为业务原件',{timeout:90000},async()=>{
   for(const [mode,count]of [['capacity',33],['audit-child',13],['audit-root',13]]){
    const key='SYNTHETIC-CURSOR-'+mode,id=A.createAccountSet({name:'合成游标边界'+mode,profileId:'small-2011-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:key}}).id,target={accountSetId:id,period:'2026-07'},sources=join(root,mode+'-sources'),audit=mode==='capacity'?join(root,mode+'-calls'):mode==='audit-child'?join(sources,'audit'):sources;mkdirSync(sources);
    const paths=[];for(let i=0;i<count;i++){const path=join(sources,i===0?'baseline-materials.json':'original-'+String(i).padStart(3,'0')+'.json');paths.push(path);writeFileSync(path,JSON.stringify({enterpriseKey:key,costMethod:'先进先出法',...(i===count-1?{tax:{taxType:'企业所得税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'累计',periodStart:'2026-01',periodEnd:'2026-06',taxAmount:3000,revenue:600000}}:{})}));}
    const before=paths.map(path=>readFileSync(path)),client=new McpStdioClient(fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url)),{cwd:root,env:{...process.env,FINANCE_MCP_PROFILE:'direct',FINANCE_SOURCE_ROOT:sources,FINANCE_AUDIT_DIR:audit,FINANCE_API_BASE:'http://127.0.0.1:1',NODE_NO_WARNINGS:'1'},timeoutMs:30000}).start();
    try{
     await client.initialize('synthetic-cursor-boundary');let wholeMax=0;const call=async args=>{const r=await client.rpc('tools/call',{name:'finance_baseline_materials',arguments:args});assert(!r.error);assert(!r.result.isError,JSON.stringify(r.result));wholeMax=Math.max(wholeMax,Buffer.byteLength(JSON.stringify(r.result,null,2)));assert(wholeMax<=12288);return r.result.structuredContent;};
     let m=await call({target,extractKnownFields:true}),steps=[];for(let i=0;;i++){assert(i<30);steps.push(m.coverage.sourceCount);const next=m.pagination.next??m.sourceDiscovery.next;if(!next)break;m=await call(next.arguments);}
     assert.equal(m.coverage.sourceCount,count);assert.equal(m.sourceDiscovery.eligibleCount,count);assert.equal(m.sourceDiscovery.remainingCount,0);assert.equal(m.coverage.requestCount,Math.ceil(count/12));assert.deepEqual(m.coverage.sourceOwners,{checked:count,unverified:0});assert.equal(m.coverage.taxHistory.cit.status,'included');assert(steps.includes(count));
     if(mode!=='capacity'){
      const end=JSON.parse(readFileSync(join(audit,m.materialRef,'end.json'))),artifact=JSON.parse(readFileSync(join(audit,m.materialRef,end.metadata.businessBaselineMaterials.file)));assert.equal(artifact.version,'finance-baseline-materials-snapshot/1');
      delete artifact.version;const legacy=join(sources,'legacy-generated.json');writeFileSync(legacy,JSON.stringify(artifact));
      let fresh=await call({target,extractKnownFields:true});for(let i=0;;i++){assert(i<30);const next=fresh.pagination.next??fresh.sourceDiscovery.next;if(!next)break;fresh=await call(next.arguments);}
      assert.equal(fresh.coverage.sourceCount,count,'旧/新生成快照及审计结果不得进入新鲜发现的业务源');assert.equal(fresh.sourceDiscovery.eligibleCount,count);assert.deepEqual(fresh.gaps,[]);assert.deepEqual(fresh.coverage.sourceOwners,{checked:count,unverified:0});
      const freshEnd=JSON.parse(readFileSync(join(audit,fresh.materialRef,'end.json'))),snapshot=JSON.parse(readFileSync(join(audit,fresh.materialRef,freshEnd.metadata.businessBaselineMaterials.file)));assert(snapshot.files.some(f=>f.path===paths[0]),'同名真实客户文件不能按文件名被粗排除');assert(!snapshot.files.some(f=>f.path===legacy));
     }
     for(let i=0;i<paths.length;i++)assert.deepEqual(readFileSync(paths[i]),before[i]);t.diagnostic(mode+' '+count+'来源完成，whole最大 '+wholeMax+'字节');
    }finally{await client.close();}
   }
  });
  await t.test('大量真实读取审计不占业务扫描额度，失效记录与同call客户文件不被粗排除',{timeout:120000},async()=>{
   for(const [mode,reads]of [['audit-child-many',520],['audit-root-many',100]]){
    const key='SYNTHETIC-'+mode,id=A.createAccountSet({name:'合成审计与业务扫描隔离'+mode,profileId:'small-2011-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:key}}).id,target={accountSetId:id,period:'2026-07'},sources=join(root,mode),audit=mode==='audit-child-many'?join(sources,'audit'):sources;mkdirSync(sources);
    for(let i=0;i<13;i++)writeFileSync(join(sources,i===0?'baseline-materials.json':'original-'+i+'.json'),JSON.stringify({enterpriseKey:key,costMethod:'先进先出法'}));
    const opts={...options,sourceRoot:sources,auditDir:audit};for(let i=0;i<reads;i++)assert.equal((await readBusinessBaseline({target},opts)).status,'needs_generation');
    const {readdirSync}=await import('node:fs'),directories=readdirSync(audit,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^\d{8}T\d{9}Z_[a-f0-9-]{36}$/.test(e.name)).map(e=>join(audit,e.name));assert.equal(directories.length,reads);
    // 真客户文件可与技术记录同目录，文件名也可以相同；只有实际已绑定的技术路径才排除。
    const customer=join(directories[0],'baseline-materials.json'),traversal=join(audit,'customer-extra.json'),body=JSON.stringify({enterpriseKey:key,costMethod:'先进先出法'});writeFileSync(customer,body);writeFileSync(traversal,body);
    await withFinanceCall({tool:'finance_baseline_read',args:{target},auditDir:audit},async()=>{const view=await readBusinessBaseline({target},opts);annotateFinanceCall({businessBaselineMaterials:{file:'../customer-extra.json',bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex'),snapshotDigest:'0'.repeat(64)}});return view;});
    // 实际输出摘要失效时，不能连同未知文件一起凭目录名认作可信技术文件。
    const changed=join(directories[1],'result.json');writeFileSync(changed,readFileSync(changed,'utf8')+'\n');
    const client=new McpStdioClient(fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url)),{cwd:root,env:{...process.env,FINANCE_MCP_PROFILE:'direct',FINANCE_SOURCE_ROOT:sources,FINANCE_AUDIT_DIR:audit,FINANCE_API_BASE:'http://127.0.0.1:1',NODE_NO_WARNINGS:'1'},timeoutMs:30000}).start();
    try{
     await client.initialize('synthetic-generated-discovery-budget');let maxBytes=0;const call=async args=>{const r=await client.rpc('tools/call',{name:'finance_baseline_materials',arguments:args});assert(!r.error);assert(!r.result.isError,JSON.stringify(r.result));const bytes=Buffer.byteLength(JSON.stringify(r.result,null,2));maxBytes=Math.max(maxBytes,bytes);assert(bytes<=12288);return r.result.structuredContent;};
     let m=await call({target,extractKnownFields:true});for(let i=0;;i++){assert(i<24);assert.equal(m.sourceDiscovery.scanLimited,false);assert.equal(m.sourceDiscovery.technicalScanLimited,false);assert.equal(m.sourceDiscovery.scannedCount,17);assert.equal(m.sourceDiscovery.eligibleCount,15);assert.equal(m.sourceDiscovery.bypassed.unsupported,2);assert(m.sourceDiscovery.generatedFilesExcluded>=reads*4);const next=m.pagination.next??m.sourceDiscovery.next;if(!next)break;m=await call(next.arguments);}
     assert.equal(m.coverage.sourceCount,15);const end=JSON.parse(readFileSync(join(audit,m.materialRef,'end.json'))),snapshot=JSON.parse(readFileSync(join(audit,m.materialRef,end.metadata.businessBaselineMaterials.file)));assert(snapshot.files.some(f=>f.path===customer));assert(snapshot.files.some(f=>f.path===traversal));assert(snapshot.files.some(f=>f.path===join(sources,'baseline-materials.json')));assert.equal(readFileSync(customer,'utf8'),body);assert.equal(readFileSync(traversal,'utf8'),body);t.diagnostic(mode+' '+reads+'真实审计后仍17候选/15业务源，whole最大 '+maxBytes+'字节');
    }finally{await client.close();}
   }
  });
  await t.test('真实MCP大材料分披露、显式合并及短支持引用保持完整证据与有界整包',{timeout:120000},async()=>{
   const key='PRIVATE-PROGRESSIVE',id=A.createAccountSet({name:'合成渐进披露',profileId:'small-2011-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:key}}).id,target={accountSetId:id,period:'2026-07'},path=join(sourceRoot,'progressive.json');
   const raw={enterpriseKey:key,企业类型:'服务业',costMethod:'先进先出法',业务单据:Array.from({length:18},(_,i)=>({工单:'PRIVATE-ORDER-'+i,业务类别:'客户未标准化表述',业务性质:'维修',提供方式:'一次完工',验收日:'2026-06-01',净价:12345.67,是否形成资产:false})),returns:[
    {taxType:'增值税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'本期',periodStart:'2026-04',periodEnd:'2026-04',taxAmount:1800,sales:100000},
    {taxType:'增值税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'本期',periodStart:'2026-05',periodEnd:'2026-05',taxAmount:2400,sales:120000},
    {taxType:'增值税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'本期',periodStart:'2026-06',periodEnd:'2026-06',taxAmount:1760,sales:80000},
   ],cit:{taxType:'企业所得税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'累计',periodStart:'2026-01',periodEnd:'2026-06',减免后累计应纳税额:3000,累计实际已预缴:2500,累计营业收入:600000}};
   writeFileSync(path,JSON.stringify(raw));const client=new McpStdioClient(fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url)),{cwd:root,env:{...process.env,FINANCE_MCP_PROFILE:'direct',FINANCE_API_BASE:'http://127.0.0.1:1',NODE_NO_WARNINGS:'1'},timeoutMs:30000}).start();
   const sizes=[],reference=m=>({materialRef:m.materialRef,snapshotDigest:m.snapshotDigest});
   try{
    await client.initialize('synthetic-progressive');
    const rpc=async(name,args)=>{const r=await client.rpc('tools/call',{name,arguments:args});assert(!r.error,JSON.stringify(r.error));assert(!r.result.isError,JSON.stringify(r.result));const bytes=Buffer.byteLength(JSON.stringify(r.result,null,2));if(name==='finance_baseline_materials'){sizes.push(bytes);assert(bytes<=12288,'完整MCP结果字节数 '+bytes);}return r.result.structuredContent;};
    let inventory=await rpc('finance_baseline_materials',{target,limit:50}),item;for(;;){item=inventory.sourceInventory.items.find(i=>i.ownerStatus==='verified'&&i.availableFields?.includes('tax_type'));if(item||!inventory.pagination.next)break;inventory=await rpc('finance_baseline_materials',inventory.pagination.next.arguments);}
    // 只使用目录实际返回的opaque引用，未知文件不会由显示名或调用者目标冒认归属。
    if(!item){let page=await rpc('finance_baseline_materials',{target,limit:50});for(;;){for(const candidate of page.sourceInventory.items.filter(i=>i.status==='inspectable')){const found=await rpc('finance_baseline_materials',{target,originals:[{id:'discovered',originalRef:candidate.originalRef}],extractKnownFields:true,limit:1});if(found.coverage.taxHistory.cit.status==='included'){item=candidate;break;}}if(item||!page.pagination.next)break;page=await rpc('finance_baseline_materials',page.pagination.next.arguments);}}
    assert(item?.originalRef);
    const full=await rpc('finance_baseline_materials',{target,originals:[{id:'defaultSize',originalRef:item.originalRef}],extractKnownFields:true});assert(full.coverage.diagnosticCount>=18,'不认识的备选业务类别保留诊断，唯一可规范化值可用');
    const first=await rpc('finance_baseline_materials',{target,originals:[{id:'first',originalRef:item.originalRef}],extractKnownFields:true,limit:1});assert(first.coverage.factCount>109);assert.equal(first.coverage.taxHistory.vat.status,'included');assert.equal(first.coverage.taxHistory.cit.status,'included');assert(first.pagination.next);assert.equal(first.principleSupport.length,1);
    const hidden=await rpc('finance_baseline_materials',first.pagination.next.arguments);assert(hidden.principleSupport.length);await assert.rejects((async()=>{const r=await client.call('finance_baseline_save',{target,materialRefs:[reference(first)],expectedRevision:0,effectiveFrom:'2026-07',principles:[{supportRef:hidden.principleSupport[0].supportRef}]});assert(!r.isError,r.text);})());
    const alias=await rpc('finance_baseline_materials',{target,originals:[{id:'differentCallerAlias',originalRef:item.originalRef}],extractKnownFields:true,limit:1});
    let merged=await rpc('finance_baseline_materials',{target,materialRefs:[reference(first),reference(alias)],section:'overview',limit:1}),supports=[...merged.principleSupport];assert.equal(merged.coverage.requestCount,2);assert.equal(merged.coverage.factCount,first.coverage.factCount,'同原件换caller别名不重复事实和税额');
    for(let i=0;merged.pagination.next;i++){assert(i<24);merged=await rpc('finance_baseline_materials',merged.pagination.next.arguments);supports.push(...merged.principleSupport);assert.equal(merged.coverage.requestCount,2);}
    assert(supports.some(p=>p.kind==='inventory_cost'));let detail=await rpc('finance_baseline_materials',{target,materialRefs:[reference(merged)],section:'facts',limit:1});
    for(let i=0;i<21;i++){assert(detail.pagination.next);detail=await rpc('finance_baseline_materials',detail.pagination.next.arguments);assert.equal(detail.coverage.requestCount,2);assert.equal(detail.snapshotDigest,merged.snapshotDigest);}
    const saved=await rpc('finance_baseline_save',{target,materialRefs:[reference(detail)],expectedRevision:0,effectiveFrom:'2026-07',principles:supports.filter(p=>['accounting_standard','inventory_cost'].includes(p.kind)).map(p=>({supportRef:p.supportRef}))});assert.equal(saved.status,'ready');assert.match(saved.shortText,/1\.99%/);assert.match(saved.shortText,/0\.50%/);assert.equal(saved.coverage.taxHistory.cit.status,'included');
    const omitted=await rpc('finance_baseline_materials',{target,originals:[{id:'narrow',path}],selections:[{id:'cost',field:'inventory_cost',originalId:'narrow',locator:{jsonPointer:'/costMethod'}}],limit:1});assert(omitted.coverage.knownFieldsNotSelected.includes('business_reference'));assert.equal(omitted.coverage.taxHistory.vat.status,'not_in_supplied_materials');
    const narrow=await rpc('finance_baseline_save',{target,materialRefs:[reference(omitted)],expectedRevision:1,effectiveFrom:'2026-07',principles:[{supportRef:omitted.principleSupport[0].supportRef}],unresolved:[{code:'policy_unverified',kind:'revenue_period'},{code:'policy_unverified',kind:'expense_period'},{code:'policy_unverified',kind:'tax_choice'}]});assert.equal(narrow.status,'needs_review');assert.equal(narrow.coverage.taxHistory.vat.status,'not_in_supplied_materials');assert.equal(narrow.coverage.taxHistory.cit.status,'not_in_supplied_materials');
    const other=A.createAccountSet({name:'合成渐进披露乙',profileId:'small-2011-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:'PROGRESSIVE-OTHER'}}).id,cross=await client.call('finance_baseline_materials',{target:{...target,accountSetId:other},materialRefs:[reference(detail)]});assert(cross.isError);
    const forged=await client.call('finance_baseline_save',{target,materialRefs:[reference(detail)],expectedRevision:2,effectiveFrom:'2026-07',principles:[{supportRef:'bp:'+'0'.repeat(64)}]});assert(forged.isError);
    writeFileSync(path,JSON.stringify({...raw,costMethod:'月末一次加权平均法'}));const stale=await client.call('finance_baseline_materials',{target,materialRefs:[reference(detail)]});assert(stale.isError);writeFileSync(path,JSON.stringify(raw));
    const ambiguousPath=join(sourceRoot,'ambiguous.json');writeFileSync(ambiguousPath,JSON.stringify({enterpriseKey:key,业务类别:'租赁',业务性质:'维修',tax:{taxType:'企业所得税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'累计',periodStart:'2026-01',periodEnd:'2026-06',减免后累计应纳税额:3000,应纳税额:3200,累计实际已预缴:2500,累计营业收入:600000}}));
    const ambiguous=await rpc('finance_baseline_materials',{target,originals:[{id:'ambiguous',path:ambiguousPath}],extractKnownFields:true});assert(ambiguous.gaps.includes('historical_conflict'));assert(ambiguous.gaps.includes('tax_basis_incomplete'));assert.equal(ambiguous.coverage.taxHistory.cit.status,'incomplete');assert(!ambiguous.taxBurden.summaries.length,'同口径多可用税值冲突不猜最小税额或已缴值');
    const smallPath=join(sourceRoot,'bound.json');writeFileSync(smallPath,JSON.stringify({enterpriseKey:key,costMethod:'先进先出法'}));const leaves=[];
    for(let i=0;i<13;i++)leaves.push(await rpc('finance_baseline_materials',{target,originals:[{id:'leaf'+i,path:smallPath}],extractKnownFields:true}));
    const twelve=await rpc('finance_baseline_materials',{target,materialRefs:leaves.slice(0,12).map(reference)});assert.equal(twelve.coverage.requestCount,12);
    const overflow=await client.call('finance_baseline_materials',{target,materialRefs:[reference(twelve),reference(leaves[12])]});assert(overflow.isError,'扁平闭包超过12次实际源读取须拒绝，不能借合并引用规避');
    assert(sizes.length>25);t.diagnostic('完整MCP材料投影最大 '+Math.max(...sizes)+' 字节，调用 '+sizes.length+' 次');
   }finally{await client.close();}
  });
 }finally{if(child){child.kill();await new Promise(resolve=>child.once('exit',resolve));}db.close();}
});
