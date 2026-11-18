// 混合原件→正常MCP显式适配→短基线/账前复用→跨月计算。程序映射不代表模型自主准确率。
// 显式验收：node --test test/material-intake-e2e.test.mjs；需Python的xlrd/xlwt/openpyxl/PyMuPDF/python-docx/Pillow及本机Windows OCR。
// 不挂入仅Node即可运行的默认套件；缺运行时明确失败，不能skip后称OCR已验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readFinanceCall} from '../server/finance-call-chain.mjs';
import {readMaterialDocument,readMaterialValue} from '../server/material-document.mjs';
import {callBaselineMaterials,readBaselineSection,saveFromActualSupports} from './helpers/business-baseline-test-inputs.mjs';
import {hashBaseline,writeBaselineJson} from './helpers/business-baseline-fixture.mjs';
import {createMaterialIntakeFixture,startMaterialIntakeMcp,publishMaterialIntakePacket,historicalMaterialRequest,currentMaterialRequest,choiceMaterialRequest,invoiceMaterialRequests,materialTarget,materialReference,MATERIAL_INTAKE_EXPECTED as EXPECTED} from './helpers/material-intake-fixture.mjs';

const ok=response=>{assert.equal(response.isError,false,response.text);assert(response.data,response.text);return response.data;};
const rejected=(response,pattern)=>{assert.equal(response.isError,true,response.text);assert.match(response.text,pattern);};
const rows=f=>{const db=new DatabaseSync(f.dbPath,{readOnly:true});try{return db.prepare("SELECT name FROM sqlite_master WHERE name='business_memory_versions'").get()?db.prepare("SELECT * FROM business_memory_versions WHERE topic='business_baseline' ORDER BY revision").all():[];}finally{db.close();}};
const voucherCount=f=>{const db=new DatabaseSync(f.dbPath,{readOnly:true});try{return db.prepare('SELECT COUNT(*) n FROM vouchers').get().n;}finally{db.close();}};
const safeCanaries=f=>[f.owner.companyName,f.owner.enterpriseKey,'SYNTHETIC-TAX-SELLER','SYNTHETIC-TAX-CUSTOMER','SYNTHETIC-TAX-VENDOR','SYNTHETIC-TAX-BUYER','合成采购客户有限公司','合成供应服务有限公司','纯中文合成测试有限公司','张三','李四','91350100123456789X','LOCAL_ONLY_PRIVATE_SENTINEL','53791.26','AMOUNT 6300.00'];
const pdfStructureLabels=['Entity','Contract','Activity','Pattern','Service From','Service Through'];

function checkProjection(f,material,report){
  for(const response of material.responses){const output=JSON.stringify(response.raw);for(const canary of safeCanaries(f))assert(!output.includes(canary),'正常材料投影泄露原件值：'+canary);report.maximumWholeMcpBytes=Math.max(report.maximumWholeMcpBytes,response.prettyBytes);}
  return material;
}
async function materialSnapshot(f,material){
  const call=await readFinanceCall({auditDir:f.auditDir,callId:material.materialRef});assert.equal(call.integrity,'verified');
  const artifact=call.end.metadata.businessBaselineMaterials,path=join(f.auditDir,material.materialRef,artifact.file),bytes=readFileSync(path);assert.equal(hashBaseline(bytes),artifact.sha256);const snapshot=JSON.parse(bytes);assert.equal(snapshot.snapshotDigest,material.snapshotDigest);return snapshot;
}
async function readMaterials(client,f,args,report){return checkProjection(f,await readBaselineSection(client,args),report);}

// 结构调查只翻到本次需要的位置；不把未读数据位置称为已审，也不反复投影所有数据单元格。
async function readStructurePreview(client,f,args,report,enough=fields=>fields.length>0){
  const pages=[],responses=[],seen=new Set();let next=args;
  while(next){const key=JSON.stringify(next);assert(!seen.has(key),'结构next不得循环');seen.add(key);const response=await callBaselineMaterials(client,next);checkProjection(f,{responses:[response]},report);responses.push(response);pages.push(response.data);if(enough(pages.flatMap(page=>page.fields??[])))break;next=response.data.pagination?.next?.arguments;assert(pages.length<=100,'结构调查须按实际next有界推进');}
  const last=pages.at(-1);return{...last,pages,responses,fields:pages.flatMap(page=>page.fields??[]),documents:pages.flatMap(page=>page.documents??[]),allPositionsRead:last.pagination.nextOffset===null};
}

async function discoverOriginals(client,f,report){
  const discovery=await readMaterials(client,f,{target:materialTarget(f),extractKnownFields:true,section:'overview',limit:50},report),step=discovery.nextSteps.find(item=>item.arguments?.section==='structure');
  assert(step,'发现入口须为未知表头/主体未核原件给出可执行的结构调查路径');
  const inventory=await readMaterials(client,f,step.arguments,report),references=new Map(),previews=[],formats=[];
  for(const item of inventory.items){assert.equal(item.next?.tool,'finance_baseline_materials');assert.equal(item.next.arguments.originals[0].originalRef,item.originalRef);const enough=fields=>['xls','xlsx'].includes(item.format)?fields.some(field=>field.position?.row>=2):item.format==='pdf'?pdfStructureLabels.every(label=>fields.some(field=>field.label===label&&field.locator?.fieldRef)):fields.length>0,structure=await readStructurePreview(client,f,item.next.arguments,report,enough),snapshot=await materialSnapshot(f,structure);assert.equal(snapshot.files.length,1);references.set(resolve(snapshot.files[0].path),item.originalRef);previews.push(structure);formats.push(item.format);}
  assert(formats.includes('xls')&&formats.includes('pdf')&&formats.includes('xlsx'),'正常发现必须覆盖混合原件，而非预先转换JSON');return{references,previews};
}
function fromDiscovered(args,references){return{...args,originals:args.originals.map(({path,...original})=>{const originalRef=references.get(resolve(path));assert(originalRef,'原件须先经正常结构入口发现：'+path);return{...original,originalRef};})};}

const currentCalculationScript=`import fs from 'node:fs';
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),p=input.parameters,reader=p.reader;
const local=await(await import(reader.moduleUrl))[reader.exportName]({target:p.target,materialRefs:p.materialRefs,expectedReaderSha256:reader.sha256},input.financeContext);
if(!local.scopeVerified||local.version!==reader.version)throw Error('material_scope_not_verified');
const baseline=p.baseline,period=p.target.period;
if(!baseline.shortText.includes('其他业务')||!baseline.shortText.includes('管理费用')||!baseline.shortText.includes('按月等额'))throw Error('baseline_not_applied');
const idx=s=>Number(s.slice(0,4))*12+Number(s.slice(5,7))-1,pi=idx(period),round=n=>Math.round(n*100)/100,objects=local.objects.map(o=>({...o,...o.values}));
const allocated=o=>{const first=idx(o.service_start),last=idx(o.service_end),months=last-first+1,elapsed=Math.max(0,Math.min(months,pi-first+1));return{period:pi>=first&&pi<=last?round(o.amount_net/months):0,cumulative:round(o.amount_net*elapsed/months),remaining:round(o.amount_net*(months-elapsed)/months)};};
const contracts=objects.filter(o=>o.business_kind==='lease'&&Number.isFinite(o.amount_net)).map(o=>({ref:o.objectRef,start:o.service_start,end:o.service_end,...allocated(o),vatSales:o.invoice_date?.slice(0,7)===period?o.amount_net:0}));
const maintenance=objects.filter(o=>o.business_kind==='maintenance'&&Number.isFinite(o.amount_net)).map(o=>({...allocated(o),inputVat:o.confirmation_date?.slice(0,7)===period?o.amount_tax:0}));
const currentStock=objects.filter(o=>o.business_kind==='inventory'&&o.period_start===period&&Number.isFinite(o.issue_quantity));if(currentStock.length!==1)throw Error('current_stock_unmatched');
const stock=currentStock[0],fifo=baseline.shortText.includes('先进先出');if(stock.issue_quantity>0&&!fifo)throw Error('inventory_policy_not_recalled');
const issueCost=stock.issue_quantity===0?0:Math.min(stock.issue_quantity,stock.opening_quantity)*stock.opening_unit_price+Math.max(0,stock.issue_quantity-stock.opening_quantity)*stock.receipt_unit_price;
const inventory={opening:stock.opening_quantity,receipt:stock.receipt_quantity,issue:stock.issue_quantity,issueCost,closing:stock.opening_quantity+stock.receipt_quantity-stock.issue_quantity,closingAmount:stock.opening_quantity*stock.opening_unit_price+stock.receipt_quantity*stock.receipt_unit_price-issueCost,method:fifo?'fifo':null};
const sum=(list,key)=>list.reduce((n,o)=>n+o[key],0),result={period,baselineRef:baseline.baselineRef,classifications:{lease:'other_income',maintenance:'management_expense'},contracts,leaseRevenue:sum(contracts,'period'),cumulativeLeaseRevenue:sum(contracts,'cumulative'),remainingLeaseRevenue:sum(contracts,'remaining'),vatSales:sum(contracts,'vatSales'),maintenanceExpense:sum(maintenance,'period'),maintenanceCumulative:sum(maintenance,'cumulative'),maintenanceRemaining:sum(maintenance,'remaining'),inputVat:sum(maintenance,'inputVat'),inventory,taxReference:{fromBaseline:baseline.shortText.includes('2.00%'),target:false},reader:local.reader,sourceDigests:local.sourceDigests,origin:'test_authored_adapter_not_autonomous_model'};
fs.writeFileSync(input.outputDir+'/本月材料计算结果.json',JSON.stringify(result,null,2));`;

async function calculateMonth(client,f,materials,baseline,period){
  const called=ok(await client.call('finance_calculation_run',{title:period+'合成材料连续处理',engine:'javascript',sources:[],script:currentCalculationScript,parameters:{target:materialTarget(f,period),materialRefs:materials.materialRefs,reader:materials.calculationReader,baseline},notes:['本脚本由验收者编写，仅验证材料接口、基线消费及连续计算，不证明模型自主归纳。']}));
  assert.equal(called.status,'executed');const path=join(f.auditDir,'calculations',called.runId,'outputs','本月材料计算结果.json'),result=JSON.parse(readFileSync(path));
  const expected=period==='2026-09'?EXPECTED.september:EXPECTED.october;
  for(const key of ['leaseRevenue','cumulativeLeaseRevenue','remainingLeaseRevenue','vatSales','maintenanceExpense','maintenanceCumulative','maintenanceRemaining','inputVat'])assert.equal(result[key],expected[key],period+':'+key);
  for(const[key,name]of Object.entries({opening:'stockOpening',receipt:'stockReceipt',issue:'stockIssue',closing:'stockClosing',closingAmount:'stockClosingAmount'}))assert.equal(result.inventory[key],expected[name],period+':inventory.'+key);
  if(period==='2026-10'){assert.equal(result.inventory.issueCost,expected.stockIssueCost);assert.equal(result.inventory.method,'fifo');assert.equal(result.contracts.find(c=>c.start==='2026-07-01').period,0,'到期旧合同不继续确认');}
  else assert.equal(result.inventory.method,null,'9月不能提前选10月的计价政策');
  assert.equal(result.taxReference.fromBaseline,true);assert.equal(result.taxReference.target,false);return{runId:called.runId,path,sha256:hashBaseline(readFileSync(path)),result};
}

async function prebookConsumer(client,f){
  const facts={scope:{enterpriseKey:f.owner.enterpriseKey,period:'2026-09',periodType:'monthly',currency:'CNY'},taxpayer:{vatStatus:'general'},coverage:Object.fromEntries(['sales','invoices','purchases','receipts','bankTransactions','inventory'].map(key=>[key,'partial'])),invoices:[{id:'sale',businessId:'MI-LEASE-SEP',invoiceNumber:'MI-SALES-SEP',direction:'sale',date:'2026-09-01',counterpartyId:'合成采购客户有限公司',netAmount:'60000.00',taxAmount:'5400.00',grossAmount:'65400.00',status:'valid'},{id:'purchase',invoiceNumber:'MI-PURCHASE-SEP',direction:'purchase',date:'2026-09-13',counterpartyId:'合成供应服务有限公司',netAmount:'5000.00',taxAmount:'300.00',grossAmount:'5300.00',status:'valid'}]};
  const originals=[{id:'sale',path:f.files.saleInvoice,scope:{enterpriseKey:f.owner.enterpriseKey,from:'2026-09-01',through:'2026-09-30'}},{id:'purchase',path:f.files.purchaseInvoice,scope:{enterpriseKey:f.owner.enterpriseKey,from:'2026-09-01',through:'2026-09-30'}}],bindings=[];
  const add=(index,field,locator,transform='identity')=>bindings.push({inputPointer:'/invoices/'+index+'/'+field,originalId:index?'purchase':'sale',locator,transform});
  for(const[field,column]of Object.entries({invoiceNumber:5,date:6,counterpartyId:3,netAmount:7,taxAmount:8,grossAmount:9}))add(0,field,{sheetIndex:0,row:2,column,headerRows:[1]},/Amount$/.test(field)?'decimal':'identity');
  for(const[field,row]of Object.entries({invoiceNumber:5,date:6,counterpartyId:1,netAmount:7,taxAmount:8,grossAmount:9}))add(1,field,{sheetIndex:0,row,column:2},/Amount$/.test(field)?'decimal':'identity');
  const input={version:'finance-prebook-input/1',facts,originals,bindings},inputPath=join(f.sourceRoot,'账前适配输入.json');writeBaselineJson(inputPath,input);
  const response=ok(await client.call('finance_prebook_review',{inputPath}));assert.equal(response.status,'needs_inputs','仅两份发票不能声称资料完整或已可正式做账');
  const indexPath=join(dirname(response.evidence.reviewPath),'evidence-index.json'),evidence=JSON.parse(readFileSync(indexPath));
  for(const binding of bindings){const actual=evidence.bindings.find(row=>row.inputPointer===binding.inputPointer);assert(actual,'账前消费者须实际采用该原件位置：'+binding.inputPointer);assert(actual.extractor,'保留真实提取器');assert(actual.locator,'保留位置');}
  return{status:response.status,indexPath,indexSha256:hashBaseline(readFileSync(indexPath)),boundValues:bindings.length};
}

test('混合原件真实接入、历史提炼与9→人工确认→10月连续复用',{timeout:360000},async()=>{
  const f=createMaterialIntakeFixture(process.env.MATERIAL_INTAKE_E2E_ROOT),report={version:'material-intake-program-acceptance/1',root:f.root,status:'running',modelInvoked:false,programAuthoredMappings:true,formalPostingInvoked:false,maximumWholeMcpBytes:0,checks:[],startedAt:new Date().toISOString()},check=async(name,fn)=>{const started=Date.now();try{const value=await fn();report.checks.push({name,status:'passed',durationMs:Date.now()-started});return value;}catch(error){report.checks.push({name,status:'failed',durationMs:Date.now()-started,error:error.message});throw error;}};
  let client;
  try{
    assert.equal(voucherCount(f),0);assert.equal(rows(f).length,0);assert.equal(readFileSync(f.files.historicalEntries).subarray(0,8).toString('hex'),'d0cf11e0a1b11ae1','历史文件必须是真实BIFF XLS');
    client=await startMaterialIntakeMcp(f);const tools=(await client.rpc('tools/list')).result.tools,materialTool=tools.find(t=>t.name==='finance_baseline_materials');assert(materialTool.inputSchema.properties.historicalRows);assert(materialTool.inputSchema.properties.selections.items.properties.interpretation);assert(materialTool.inputSchema.properties.originals.items.properties.ownerIdentity);assert(ok(await client.call('finance_record_contract',{recordType:'prebook'})).inputSchema.properties.bindings.items.properties.locator);
    const discovered=await check('正常发现→工具next→originalRef→结构调查，不依赖预知文件路径',()=>discoverOriginals(client,f,report)),references=discovered.references;
    const request=fromDiscovered(historicalMaterialRequest(f),references);
    const selectedHistoryRows=[...new Set(f.relevantHistoricalRows)].sort((a,b)=>a-b);assert(selectedHistoryRows.length>0&&selectedHistoryRows.length<f.historicalRowCount);
    request.historicalRows=request.historicalRows.filter(row=>selectedHistoryRows.includes(row.businessReference.row));assert.equal(request.historicalRows.length,selectedHistoryRows.length);
    const configured=await check('只有账套配置时如实标记未完成，不显示虚假归类成本',async()=>{
      const material=await readMaterials(client,f,{target:materialTarget(f),originals:[{id:'configuration',path:f.files.configurationNote}],section:'overview'},report),saved=ok(await client.call('finance_baseline_save',saveFromActualSupports(materialTarget(f),material)));
      assert.equal(saved.status,'needs_review');assert.equal(saved.coverage.configurationOnly,true);assert(!saved.shortText.includes('归类及成本'));assert(saved.unresolved.some(g=>g.code==='historical_evidence_missing'));
      const taxOnly=await readMaterials(client,f,{...request,originals:request.originals.filter(original=>original.id==='tax'),selections:request.selections.filter(selection=>selection.originalId==='tax'),historicalRows:[]},report),withTax=ok(await client.call('finance_baseline_save',saveFromActualSupports(materialTarget(f),taxOnly,{expectedRevision:saved.headRevision})));assert.equal(withTax.status,'needs_review');assert.equal(withTax.coverage.businessPrinciplesMissing,true);assert.equal(withTax.coverage.generationBasis,'configuration_and_tax_reference');assert(withTax.shortText.includes('2.00%'),'真实税负参考仍应保留可用');assert(!withTax.shortText.includes('归类及成本'));return withTax;
    });
    await check('未知表头/原件页行先可见，完整原值留本机',async()=>{
      const fields=discovered.previews.flatMap(preview=>preview.fields),documents=discovered.previews.flatMap(preview=>preview.documents);
      for(const format of['xls','pdf','xlsx'])assert(documents.some(document=>document.format===format&&document.readState==='read'),'实际MCP文档须已读取：'+format);
      const xlsDocument=documents.find(document=>document.format==='xls'),xlsWarning=xlsDocument.diagnostics.find(item=>item.code==='xls_parser_warning');assert.deepEqual(xlsWarning,{code:'xls_parser_warning',severity:'warning'});report.xlsWarning={...xlsWarning,readState:xlsDocument.readState};
      for(const preview of discovered.previews.filter(item=>item.documents.some(document=>document.format==='pdf')))for(const label of pdfStructureLabels)assert(preview.fields.some(field=>field.label===label&&field.locator?.fieldRef&&Number.isInteger(field.position?.page)&&Number.isInteger(field.position?.line)&&Number.isInteger(field.position?.start)&&field.position.end>field.position.start),'每份PDF须公开安全字段标签及对应值定位：'+label);
      for(const label of['核算单位','发生月份','入账日','关联单号','账目编码','账目名称','借记数','贷记数'])assert(fields.some(field=>field.label===label),'供Agent映射的实际原列名应可见：'+label);assert(fields.some(field=>field.locator||field.fieldRef));report.structureInspection=discovered.previews.map(preview=>({formats:[...new Set(preview.documents.map(document=>document.format))],readStates:[...new Set(preview.documents.map(document=>document.readState))],positionsReturned:preview.fields.length,allPositionsRead:preview.allPositionsRead}));
    });
    const history=await check('BIFF历史分录与PDF合同形成真实处理依据，WMF税表形成税负参考',async()=>{
      const material=await readMaterials(client,f,request,report),snapshot=await materialSnapshot(f,material),observed=snapshot.facts.filter(fact=>fact.field==='historical_posting');
      assert.equal(observed.length,selectedHistoryRows.length);assert.deepEqual(observed.map(fact=>fact.source.locator.row).sort((a,b)=>a-b),selectedHistoryRows,'历史观察必须精确来自所选原件行，不能附带未选行');assert(observed.every(fact=>fact.source.kind==='file'&&resolve(fact.source.path)===resolve(f.files.historicalEntries)&&fact.source.sha256===f.originalHashes.historicalEntries&&fact.value.status==='observed_history'));assert(observed.every(fact=>fact.source.extractor&&fact.source.locator&&fact.source.entryLocators&&Object.values(fact.source.entryLocators).every(locator=>locator.row===fact.source.locator.row&&(locator.sheetIndex??0)===(fact.source.locator.sheetIndex??0))));
      const contractReferences=new Set(snapshot.facts.filter(fact=>fact.field==='business_reference'&&fact.source.kind==='file'&&[f.files.oldLease,f.files.maintenance].some(path=>resolve(path)===resolve(fact.source.path))).map(fact=>fact.factRef));assert(observed.every(fact=>fact.linkedBusinessRefs?.some(ref=>contractReferences.has(ref))),'所选历史行必须关联实际合同原件');report.historicalSelection={availableRows:f.historicalRowCount,selectedRows:selectedHistoryRows,observedRows:observed.map(fact=>fact.source.locator.row)};assert(snapshot.facts.some(fact=>fact.source.interpretation?.kind==='model_interpretation'),'业务解释须与原件观察区分');
      const vat=snapshot.taxBurden.summaries.find(row=>row.taxType==='vat');assert.equal(vat.weightedRatio,EXPECTED.historicalVat.weightedRatio);assert(vat.evidenceRefs.every(ref=>snapshot.facts.find(fact=>fact.factRef===ref)?.source.path===f.files.tax));
      for(const[kind,value,when]of [['business_classification','other_income','lease'],['business_classification','actual_use_expense','maintenance'],['revenue_period','service_period','lease'],['expense_period','benefit_period','maintenance']])assert(material.principleSupport.some(p=>p.kind===kind&&p.value===value&&p.when===when),kind+':'+value+'须有原件历史支持');
      const save=saveFromActualSupports(materialTarget(f),material,{expectedRevision:configured.headRevision}),saved=ok(await client.call('finance_baseline_save',save));assert.equal(saved.status,'ready');assert(saved.shortText.includes('管理费用'));assert(saved.shortText.includes('按月等额'));assert(saved.shortText.includes('2.00%'));assert(Array.from(saved.shortText).length<=600);assert(saved.shortText.split('\n').filter(line=>/^\d+\./.test(line)).length<=8);assert.equal(saved.coverage.historyEvidence.ledgerPostings,0);assert.equal(saved.coverage.historyEvidence.sourceObservations,selectedHistoryRows.length);return{material,saved,snapshot};
    });
    const beforeSeptember=JSON.stringify(rows(f));publishMaterialIntakePacket(f,'september');
    await check('两种发票布局按购销角色归属，同一原件可供账前复用',async()=>{
      for(const[index,args]of invoiceMaterialRequests(f).entries()){
        const structure=await readStructurePreview(client,f,{target:args.target,originals:args.originals,section:'structure',limit:50},report,fields=>fields.some(field=>index?field.position?.row===10&&field.position.column===1:field.position?.row===2&&field.position.column>=4));
        for(const[row,column,label]of index?[[9,1,'含税总计'],[10,1,'业务说明']]:[[1,1,'销货人称谓'],[1,3,'购买方称谓']])assert(structure.fields.some(field=>field.position?.sheetIndex===0&&field.position.row===row&&field.position.column===column&&field.label===label&&field.locator?.fieldRef),'发票字段须经正常next公开安全原标签：'+label);
        const material=await readMaterials(client,f,args,report),snapshot=await materialSnapshot(f,material),facts=snapshot.facts.filter(row=>row.source.path===args.originals[0].path);assert(facts.length>=4);assert(facts.every(row=>row.source.identity.role===(index?'buyer':'seller')));assert(facts.every(row=>row.source.identity.taxIdAvailability==='not_registered'),'无登记税号时必须如实说明名称匹配');assert.equal(facts.find(row=>row.field==='amount_net').value,index?5000:60000);assert.equal(material.coverage.sourceOwners.unverified,0);
        const calculation=await readMaterials(client,f,{target:args.target,materialRefs:[materialReference(material)],section:'calculation',limit:50},report);assert(calculation.calculationSchema.objects.some(object=>['amount_net','amount_tax','amount_gross','invoice_date'].every(field=>Object.hasOwn(object.fields,field))),'发票字段须形成同一可消费对象，不能只证明零散值能解析');
      }
      report.prebook=await prebookConsumer(client,f);
    });
    const september=await check('9月新材料真实取数并消费短基线，不新增普通月份版本',async()=>{
      const fresh=await readMaterials(client,f,currentMaterialRequest(f,'2026-09'),report),merged=await readMaterials(client,f,{target:materialTarget(f),materialRefs:[materialReference(history.material),materialReference(fresh)],section:'calculation',limit:50},report),baseline=ok(await client.call('finance_baseline_read',{target:materialTarget(f)}));assert.equal(baseline.baselineRef,history.saved.baselineRef);const result=await calculateMonth(client,f,merged,baseline,'2026-09');assert.equal(JSON.stringify(rows(f)),beforeSeptember);return result;
    });report.september=september;
    publishMaterialIntakePacket(f,'confirmation');const oldRows=rows(f);const future=await check('标记合成人工确认后只追加10月生效版本，9月视图不变',async()=>{
      const choice=await readMaterials(client,f,choiceMaterialRequest(f),report),merged=await readMaterials(client,f,{target:materialTarget(f),materialRefs:[materialReference(history.material),materialReference(choice)],section:'overview',limit:50},report),save=saveFromActualSupports(materialTarget(f),merged,{expectedRevision:history.saved.headRevision,effectiveFrom:'2026-10'}),saved=ok(await client.call('finance_baseline_save',save));
      assert.equal(saved.changed,true);assert.equal(saved.savedVersion.effectiveFrom,'2026-10');assert.equal(saved.savedVersion.applicableToTarget,false);assert.equal(saved.baselineRef,history.saved.baselineRef);assert.equal(rows(f).length,oldRows.length+1);assert.deepEqual(rows(f).slice(0,oldRows.length),oldRows);assert.equal(ok(await client.call('finance_baseline_read',{target:materialTarget(f)})).baselineRef,history.saved.baselineRef);return saved.savedVersion;
    });report.humanConfirmation={path:f.humanReplyPath,synthetic:true,futureVersion:future};
    publishMaterialIntakePacket(f,'october');const beforeOctober=JSON.stringify(rows(f));await client.close();client=await startMaterialIntakeMcp(f);
    report.october=await check('全新MCP连接10月召回新旧原则并连续计算',async()=>{
      const baseline=ok(await client.call('finance_baseline_read',{target:materialTarget(f,'2026-10')}));assert.equal(baseline.baselineRef,future.baselineRef);assert(baseline.shortText.includes('先进先出'));const currentHistory=await readMaterials(client,f,{...request,target:materialTarget(f,'2026-10')},report),fresh=await readMaterials(client,f,currentMaterialRequest(f,'2026-10'),report),merged=await readMaterials(client,f,{target:materialTarget(f,'2026-10'),materialRefs:[materialReference(currentHistory),materialReference(fresh)],section:'calculation',limit:50},report),result=await calculateMonth(client,f,merged,baseline,'2026-10');assert.equal(result.result.inventory.opening,september.result.inventory.closing);assert.equal(result.result.maintenanceCumulative,september.result.maintenanceCumulative+result.result.maintenanceExpense);assert.equal(JSON.stringify(rows(f)),beforeOctober);return result;
    });
    publishMaterialIntakePacket(f,'auxiliary');await check('实际图片与扫描PDF OCR，DOCX/文本及未知格式如实披露',async()=>{
      const files=['image','scannedPdf','docx','text','markdown','unknownWorkbook','dynamicJson'],previews=[];for(const id of files){const args={target:materialTarget(f,'2026-10'),originals:[{id,path:f.files[id]}],section:'structure',limit:50};previews.push(id==='dynamicJson'?await readMaterials(client,f,args,report):await readStructurePreview(client,f,args,report,id==='unknownWorkbook'?fields=>fields.some(field=>field.position?.sheetIndex===1&&field.position.row===1&&field.position.column===2):undefined));}const fields=previews.flatMap(preview=>preview.fields);assert(fields.some(field=>field.originalId==='unknownWorkbook'&&(field.locator||field.fieldRef)),'未知字段不能在结构发现前被白名单挡掉');
      const documents=previews.flatMap(preview=>preview.pages.flatMap(page=>page.documents??[])),ocr=[];
      for(const key of['image','scannedPdf']){
        const doc=readMaterialDocument({path:f.files[key],sourceRoot:f.sourceRoot,pythonPath:f.pythonPath});assert.equal(doc.status,'read');assert(/ocr/.test(doc.extractor.mode));assert.equal(doc.extractor.ocr?.id,'windows-media-ocr');assert(doc.extractor.ocr.version);assert(doc.extractor.ocr.language);
        const observations={};
        for(const[label,expectedDigits]of[['AMOUNT','630000'],['DATE','20260831']]){
          const matches=doc.blocks.filter(block=>block.text.startsWith(label+' '));assert.equal(matches.length,1,'实际OCR须保留唯一标签行：'+label);const block=matches[0],locator={page:block.page,line:block.line};
          assert.equal((block.text.slice(label.length).match(/[0-9]/g)??[]).join(''),expectedDigits,'实际OCR须保留完整数字序列（含末尾00）：'+label);
          assert(Number.isInteger(block.page)&&block.page>0&&Number.isInteger(block.line)&&block.line>0);assert(Array.isArray(block.bbox)&&block.bbox.length===4&&block.bbox.every(value=>Number.isFinite(value)&&value>=0)&&block.bbox[2]>block.bbox[0]&&block.bbox[3]>block.bbox[1],'OCR须保留有效原件BBox');
          assert.equal(block.origin,'ocr');assert.equal(block.verification,'ocr_extraction_unreviewed');assert(doc.diagnostics.some(item=>item.code==='ocr_text_requires_review'&&item.page===block.page));assert.equal(readMaterialValue(doc,locator).value,block.text,'本机定位必须逐字重放真实OCR文本，不替换标点或恢复金额');
          observations[label]={text:block.text,digits:expectedDigits,locator,bbox:block.bbox,valueVerified:false};
        }
        assert(documents.some(item=>item.originalId===key&&/ocr/.test(item.extractor?.mode??'')));ocr.push({kind:key,extractor:doc.extractor,observations,numericRecoveryApplied:false,canUseAsCalculationValue:false,limitation:'保留真实OCR标点差异；金额及日期尚未核准，不能声称6300.00可直接计算。'});
      }
      report.ocr=ocr;
      const inventory=await readMaterials(client,f,{target:materialTarget(f,'2026-10')},report);assert((inventory.sourceInventory?.unsupportedFormats?.other??0)>0||inventory.pages.some(page=>(page.sourceInventory?.unsupportedFormats?.other??0)>0),'不支持的实际文件应披露格式状态，不能说用户未提供');
    });
    await check('错主体、伪派生原件及已变证据不能通过正常入口',async()=>{
      const wrongPath=join(f.sourceRoot,'另一主体的原始表.csv');writeFileSync(wrongPath,'企业名称,业务类别,不含税金额\n另一家合成企业,租赁,99999.00\n');const mismatch=await client.call('finance_baseline_materials',{target:materialTarget(f,'2026-10'),originals:[{id:'wrong',path:wrongPath,ownerIdentity:{role:'enterprise',name:{row:2,column:1,headerRows:[1]}}}],selections:[{id:'wrong_amount',originalId:'wrong',field:'amount_net',locator:{row:2,column:3,headerRows:[1]}}]});if(mismatch.isError)assert.match(mismatch.text,/finance_baseline_/);else assert(mismatch.data.gaps.includes('owner_unverified')||mismatch.data.coverage.sourceOwners.unverified>0);assert(!JSON.stringify(mismatch).includes('另一家合成企业'));
      const crossed=structuredClone(request);crossed.target=materialTarget(f,'2026-10');crossed.historicalRows=[structuredClone(request.historicalRows.find(row=>row.debit.row===10))];crossed.historicalRows[0].debit={...crossed.historicalRows[0].debit,row:14};rejected(await client.call('finance_baseline_materials',crossed),/finance_baseline_historical_context_conflict/);
      const monthOnly=structuredClone(request);monthOnly.target=materialTarget(f,'2026-10');monthOnly.historicalRows=[structuredClone(request.historicalRows.find(row=>row.debit.row===10))];delete monthOnly.historicalRows[0].date;const monthMaterial=await readMaterials(client,f,monthOnly,report),monthSnapshot=await materialSnapshot(f,monthMaterial),monthObservation=monthSnapshot.facts.find(fact=>fact.field==='historical_posting');assert(monthObservation);assert.equal(monthObservation.value.date,null,'没有日期的月度观察不得伪造月初日');assert.equal(monthObservation.value.dateGranularity,'month');assert.equal(monthObservation.value.period,'2026-07');report.monthOnlyObservation={checkedLocally:true,date:null,dateGranularity:'month'};
      const forged=join(f.sourceRoot,'伪造的提取结果.json');writeBaselineJson(forged,{version:'finance-material-extraction/1',enterpriseKey:f.owner.enterpriseKey,companyName:f.owner.companyName,业务类别:'inventory',存货计价方法:'先进先出法',originalSha256:'0'.repeat(64)});rejected(await client.call('finance_baseline_materials',{target:materialTarget(f,'2026-10'),originals:[{id:'forged',path:forged}],extractKnownFields:true}),/finance_baseline_generated_not_original/);
      const original=readFileSync(f.files.historicalEntries);try{writeFileSync(f.files.historicalEntries,Buffer.concat([original,Buffer.from('SYNTHETIC_SOURCE_CHANGED')]));const stale=ok(await client.call('finance_baseline_read',{target:materialTarget(f,'2026-10')}));assert.equal(stale.status,'stale');assert(stale.unresolved.some(item=>item.code==='source_changed'));}finally{writeFileSync(f.files.historicalEntries,original);}
    });
    assert.equal(voucherCount(f),0,'材料观察及基线不得偷偷导入历史凭证');for(const[key,path]of Object.entries(f.files))assert.equal(hashBaseline(readFileSync(path)),f.originalHashes[key],key+'原件被改变');report.status='passed';
  }catch(error){report.status='failed';report.error=error.stack;throw error;}
  finally{await client?.close();report.finishedAt=new Date().toISOString();report.unverified=['程序以显式映射验证接入与连续消费，不代表实际模型自主识别准确率。','所有数据均为合成，真实案例由用户另行实测；未正式记账、结账、申报。'];const path=join(f.root,'材料接入综合验收结果.json');writeBaselineJson(path,report);console.log(JSON.stringify({report:path,status:report.status,checks:report.checks.length,modelInvoked:false}));}
});
