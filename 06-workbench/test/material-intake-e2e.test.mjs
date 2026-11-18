// 独立宿主解析实际合成原件，正常 MCP 收观察并形成短基线，验证跨月沿用。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readFinanceCall,listFinanceCalls} from '../server/finance-call-chain.mjs';
import {readBaselineSection,saveFromActualSupports} from './helpers/business-baseline-test-inputs.mjs';
import {hashBaseline,readBaselineJson,writeBaselineJson} from './helpers/business-baseline-fixture.mjs';
import {createMaterialIntakeFixture,startMaterialIntakeMcp,publishMaterialIntakePacket,
  prepareMaterialObservations,materialTarget,materialReference,MATERIAL_INTAKE_EXPECTED as EXPECTED} from './helpers/material-intake-fixture.mjs';

const ok=response=>{assert.equal(response.isError,false,response.text);assert(response.data,response.text);return response.data;};
const rejected=(response,pattern)=>{assert.equal(response.isError,true,response.text);assert.match(response.text,pattern);};
function readDatabase(f,read){
  const db=new DatabaseSync(f.dbPath,{readOnly:true});
  try{return read(db);}finally{db.close();}
}
const rows=f=>readDatabase(f,db=>db.prepare("SELECT name FROM sqlite_master WHERE name='business_memory_versions'").get()
  ?db.prepare("SELECT * FROM business_memory_versions WHERE topic='business_baseline' ORDER BY revision").all():[]);
const voucherCount=f=>readDatabase(f,db=>db.prepare('SELECT COUNT(*) n FROM vouchers').get().n);
const safeCanaries=f=>[f.owner.companyName,f.owner.enterpriseKey,'MI-LEASE-JUL','MI-MAINT-JUL','SYNTHETIC-TAX-SELLER',
  '合成采购客户有限公司','合成供应服务有限公司',f.sourceRoot];
const request=(f,inputPath,period='2026-09')=>({target:materialTarget(f,period),inputPath,section:'overview',limit:50});

async function materialSnapshot(f,material){
  const call=await readFinanceCall({auditDir:f.auditDir,callId:material.materialRef});assert.equal(call.integrity,'verified');
  const artifact=call.end.metadata.businessBaselineMaterials,path=join(f.auditDir,material.materialRef,artifact.file),bytes=readFileSync(path);
  assert.equal(hashBaseline(bytes),artifact.sha256);
  const snapshot=JSON.parse(bytes);assert.equal(snapshot.snapshotDigest,material.snapshotDigest);
  return snapshot;
}

async function readMaterials(client,f,args,report){
  const material=await readBaselineSection(client,args);
  for(const response of material.responses){
    const output=JSON.stringify(response.raw);
    for(const canary of safeCanaries(f))assert(!output.includes(canary),'财税回执不应披露本机原值');
    report.maximumWholeMcpBytes=Math.max(report.maximumWholeMcpBytes,response.prettyBytes);
  }
  return material;
}

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

async function prebookConsumer(client,f,inputPath){
  const expectedBindings=readBaselineJson(inputPath).bindings;
  const response=ok(await client.call('finance_prebook_review',{inputPath}));
  assert.equal(response.status,'needs_inputs','仅两份发票不能声称资料齐全');
  const indexPath=join(dirname(response.evidence.reviewPath),'evidence-index.json'),evidence=readBaselineJson(indexPath);
  for(const binding of expectedBindings){
    const actual=evidence.bindings.find(row=>row.inputPointer===binding.inputPointer);
    assert(actual,'账前结果须保存实际原件位置');
    assert.deepEqual(actual.locator,binding.locator);
    assert.equal(actual.sourceType,'agent_observation');
    assert.equal(actual.sha256,f.originalHashes[binding.originalId]);
  }
  return{status:response.status,indexPath,indexSha256:hashBaseline(readFileSync(indexPath)),boundValues:expectedBindings.length};
}

test('宿主直接解析误标编码的旧 XLS，再由正常 MCP 生成和跨月沿用短基线',{timeout:360000},async()=>{
  const f=createMaterialIntakeFixture(process.env.MATERIAL_INTAKE_E2E_ROOT);
  const report={version:'material-intake-program-acceptance/2',root:f.root,status:'running',modelInvoked:false,
    hostExtractionByTestProgram:true,formalPostingInvoked:false,maximumWholeMcpBytes:0,checks:[],startedAt:new Date().toISOString()};
  const check=async(name,fn)=>{
    const started=Date.now();
    try{const value=await fn();report.checks.push({name,status:'passed',durationMs:Date.now()-started});return value;}
    catch(error){report.checks.push({name,status:'failed',durationMs:Date.now()-started,error:error.message});throw error;}
  };
  let client;
  try{
    assert.equal(voucherCount(f),0);assert.equal(rows(f).length,0);
    const host=await check('宿主用同一份旧 BIFF 原件字节对照默认编码与实际中文',()=>{
      for(const key of ['historyJuly','historyAugust'])assert.equal(readFileSync(f.files[key]).subarray(0,4).toString('hex'),'09000400');
      const result=prepareMaterialObservations(f,'history');
      for(const file of result.legacyFiles){
        assert.equal(file.declared,'cp1252');assert.equal(file.chosen,'gbk');assert.equal(file.firstReadMatched,false);
        assert(file.selectedRows.length>0&&file.selectedRows.length<file.availableRows);
      }
      assert.deepEqual(result.balanceHeaders.namedHeaders,['科目','期初','期末','折旧']);
      assert.equal(result.balanceHeaders.firstReadMatched,false);
      return result;
    });
    report.hostExtraction=host;
    client=await startMaterialIntakeMcp(f,{bound:true});
    await check('实际工具表只接受整理件路径，旧内置读取和适配参数退出',async()=>{
      const tools=(await client.rpc('tools/list')).result.tools;
      const material=tools.find(tool=>tool.name==='finance_baseline_materials').inputSchema.properties;
      assert(material.inputPath);
      for(const key of ['originals','selections','extractKnownFields','historicalRows','sourceCursor','adaptation'])assert.equal(material[key],undefined);
      assert(!material.section.enum.includes('structure'));
      const source=tools.find(tool=>tool.name==='finance_calculation_run').inputSchema.properties.sources;
      assert.equal(source.items.properties.originalRef,undefined);
      const contract=ok(await client.call('finance_record_contract',{recordType:'baseline'}));
      assert.equal(contract.inputSchema.properties.version.const,'finance-baseline-observations/1');
      const prebook=ok(await client.call('finance_record_contract',{recordType:'prebook'}));
      assert.equal(prebook.inputSchema.properties.version.const,'finance-prebook-input/2');
      rejected(await client.call('finance_baseline_materials',{target:materialTarget(f),extractKnownFields:true}),/invalid_arguments/);
      rejected(await client.call('finance_baseline_materials',{target:materialTarget(f),inputPath:f.files.historyJuly}),/finance_baseline_/);
      const obsolete=await client.call('finance_record_contract',{recordType:'baseline_adaptation'});
      assert(obsolete.isError||!obsolete.data?.outputSchema,'旧适配合同不得可用');
    });
    const taxAndBasis=await readMaterials(client,f,request(f,host.basisPath),report);
    assert.equal(taxAndBasis.coverage.taxHistory.vat.status,'included');
    const started=await check('仅有账套配置时如实标记历史未完成',async()=>{
      const material=await readMaterials(client,f,{target:materialTarget(f)},report);
      assert.equal(material.coverage.sourceCount,0);
      const saved=ok(await client.call('finance_baseline_save',saveFromActualSupports(materialTarget(f),material)));
      assert.equal(saved.status,'needs_review');assert.equal(saved.coverage.configurationOnly,true);
      assert(!saved.shortText.includes('归类及成本'));
      return saved;
    });
    const history=await check('有限历史观察需要独立同业务依据，实际保存已采用的口径和税负',async()=>{
      const alone=await readMaterials(client,f,request(f,host.artifactPath),report);
      assert(!alone.principleSupport.some(p=>['business_classification','revenue_period','expense_period'].includes(p.kind)));
      const merged=await readMaterials(client,f,{target:materialTarget(f),materialRefs:[materialReference(taxAndBasis),materialReference(alone)],limit:1},report);
      const material=await readMaterials(client,f,{target:materialTarget(f),materialRefs:[materialReference(merged),materialReference(alone)],limit:50},report);
      const snapshot=await materialSnapshot(f,material),observed=snapshot.facts.filter(fact=>fact.field==='historical_posting');
      const expectedMap=new Map(host.legacyFiles.flatMap(file=>file.selectedRows.map(row=>[f.files[file.key]+'#'+row,f.originalHashes[file.key]])));
      assert.equal(observed.length,expectedMap.size,'重叠引用不得双计同一原始行');
      const separateBasis=new Set(snapshot.facts.filter(fact=>fact.field==='business_reference'&&[f.files.oldLease,f.files.maintenance].includes(fact.source.path)).map(fact=>fact.factRef));
      for(const fact of observed){
        assert.equal(fact.verification,'agent_observation');
        assert.equal(fact.value.status,'observed_history');
        assert.equal(fact.source.sha256,expectedMap.get(fact.source.path+'#'+fact.source.locator.row));
        assert(fact.linkedBusinessRefs.some(ref=>separateBasis.has(ref)));
      }
      assert.equal(snapshot.taxBurden.summaries.find(s=>s.taxType==='vat').weightedRatio,EXPECTED.historicalVat.weightedRatio);
      for(const [kind,value,when]of [['business_classification','other_income','lease'],['business_classification','actual_use_expense','maintenance'],
        ['revenue_period','service_period','lease'],['expense_period','benefit_period','maintenance']]){
        const principle=material.principleSupport.find(p=>p.kind===kind&&p.value===value&&p.when===when);
        assert(principle,kind+'/'+when);
        assert.equal(principle.authority,'agent_history_inference');
      }
      const saved=ok(await client.call('finance_baseline_save',saveFromActualSupports(materialTarget(f),material,{expectedRevision:started.headRevision})));
      assert.equal(saved.status,'ready');assert(saved.shortText.includes('2.00%'));assert(Array.from(saved.shortText).length<=600);
      const definition=JSON.parse(rows(f).at(-1).content_json).definition;
      const retained=definition.facts.filter(fact=>fact.field==='historical_posting');
      assert(retained.length>0&&retained.every(fact=>observed.some(value=>value.factRef===fact.factRef)));
      assert.equal(voucherCount(f),0);
      const calls=await listFinanceCalls({auditDir:f.auditDir,limit:1000});
      assert(calls.calls.every(call=>call.tool!=='finance_calculation_run'),'提取阶段不调用财税脚本工具');
      report.historicalSelection={observations:observed.length,referencedByBaseline:retained.length,baselineRef:saved.baselineRef};
      return{material,saved};
    });
    const beforeSeptember=JSON.stringify(rows(f));
    publishMaterialIntakePacket(f,'september');
    await check('两种发票布局的宿主观察进入基线对象和账前来源索引',async()=>{
      const invoices=prepareMaterialObservations(f,'invoices');
      const material=await readMaterials(client,f,request(f,invoices.artifactPath),report);
      const snap=await materialSnapshot(f,material);
      for(const [key,role,amount]of [['saleInvoice','seller',60000],['purchaseInvoice','buyer',5000]]){
        const facts=snap.facts.filter(fact=>fact.source.path===f.files[key]);
        assert.equal(facts.find(fact=>fact.field==='amount_net').value,amount);
        assert(facts.every(fact=>fact.source.identity.role===role&&fact.verification==='agent_observation'));
      }
      const calculation=await readMaterials(client,f,{target:materialTarget(f),materialRefs:material.materialRefs,section:'calculation'},report);
      assert.equal(calculation.calculationSchema.objects.filter(object=>['amount_net','amount_tax','amount_gross','invoice_date'].every(field=>Object.hasOwn(object.fields,field))).length,2);
      report.prebook=await prebookConsumer(client,f,invoices.prebookPath);
    });
    const september=await check('9月用本期观察及既有短基线实际计算，保持版本',async()=>{
      const fresh=prepareMaterialObservations(f,'september');
      const calculation=await readMaterials(client,f,{...request(f,fresh.artifactPath),materialRefs:taxAndBasis.materialRefs,section:'calculation'},report);
      const baseline=ok(await client.call('finance_baseline_read',{target:materialTarget(f)}));
      assert.equal(baseline.baselineRef,history.saved.baselineRef);
      const result=await calculateMonth(client,f,calculation,baseline,'2026-09');
      assert.equal(JSON.stringify(rows(f)),beforeSeptember);
      return result;
    });
    report.september=september;
    publishMaterialIntakePacket(f,'confirmation');
    const future=await check('合成确认只追加10月生效版本，9月仍读原版',async()=>{
      const declared=prepareMaterialObservations(f,'confirmation');
      const merged=await readMaterials(client,f,{...request(f,declared.artifactPath),materialRefs:history.material.materialRefs},report);
      const oldRows=rows(f);
      const saved=ok(await client.call('finance_baseline_save',saveFromActualSupports(materialTarget(f),merged,{expectedRevision:history.saved.headRevision,effectiveFrom:'2026-10'})));
      assert.equal(saved.changed,true);assert.equal(saved.savedVersion.effectiveFrom,'2026-10');assert.equal(saved.savedVersion.applicableToTarget,false);
      assert.equal(saved.baselineRef,history.saved.baselineRef);assert.equal(rows(f).length,oldRows.length+1);
      assert.deepEqual(rows(f).slice(0,oldRows.length),oldRows);
      assert.equal(ok(await client.call('finance_baseline_read',{target:materialTarget(f)})).baselineRef,history.saved.baselineRef);
      return saved.savedVersion;
    });
    report.humanConfirmation={path:f.humanReplyPath,synthetic:true,futureVersion:future};
    publishMaterialIntakePacket(f,'october');
    const beforeOctober=JSON.stringify(rows(f));
    await client.close();client=await startMaterialIntakeMcp(f,{bound:true,period:'2026-10'});
    report.october=await check('10月全新会话读回新旧口径，承接9月结存并计算',async()=>{
      const baseline=ok(await client.call('finance_baseline_read',{target:materialTarget(f,'2026-10')}));
      assert.equal(baseline.baselineRef,future.baselineRef);assert(baseline.shortText.includes('先进先出'));
      const current=prepareMaterialObservations(f,'october','2026-10');
      const priorBasis=readBaselineJson(host.basisPath);
      priorBasis.target=materialTarget(f,'2026-10');
      priorBasis.originals=priorBasis.originals.filter(file=>file.id!=='tax');
      priorBasis.records=priorBasis.records.filter(record=>record.originalId!=='tax');
      const existingContracts=join(dirname(current.artifactPath),'carried-contracts.json');
      writeBaselineJson(existingContracts,priorBasis);
      const carry=await readMaterials(client,f,request(f,existingContracts,'2026-10'),report);
      const calculation=await readMaterials(client,f,{...request(f,current.artifactPath,'2026-10'),materialRefs:carry.materialRefs,section:'calculation'},report);
      const result=await calculateMonth(client,f,calculation,baseline,'2026-10');
      assert.equal(result.result.inventory.opening,september.result.inventory.closing);
      assert.equal(result.result.maintenanceCumulative,september.result.maintenanceCumulative+result.result.maintenanceExpense);
      assert.equal(JSON.stringify(rows(f)),beforeOctober);
      assert(!readBaselineJson(current.artifactPath).originals.some(original=>/history/i.test(original.id)));
      return result;
    });
    await check('来源变更使依赖的已存原则失效，现场原件可恢复',async()=>{
      const original=readFileSync(f.files.historyAugust);
      try{
        writeFileSync(f.files.historyAugust,Buffer.concat([original,Buffer.from('SYNTHETIC_SOURCE_CHANGED')]));
        const stale=ok(await client.call('finance_baseline_read',{target:materialTarget(f,'2026-10')}));
        assert.equal(stale.status,'stale');assert(stale.unresolved.some(item=>item.code==='source_changed'));
      }finally{writeFileSync(f.files.historyAugust,original);}
    });
    assert.equal(voucherCount(f),0);
    for(const [key,path]of Object.entries(f.files))assert.equal(hashBaseline(readFileSync(path)),f.originalHashes[key],key+' 原件保持原样');
    report.status='passed';
  }catch(error){report.status='failed';report.error=error.stack;throw error;}
  finally{
    await client?.close();report.finishedAt=new Date().toISOString();
    report.unverified=['本用例以测试编写的宿主脚本验证读取、接收及业务消费','真实账套、正式记账、申报及模型自主识别不在程序验收内'];
    const path=join(f.root,'材料接入综合验收结果.json');writeBaselineJson(path,report);
    console.log(JSON.stringify({report:path,status:report.status,checks:report.checks.length,modelInvoked:false}));
  }
});
