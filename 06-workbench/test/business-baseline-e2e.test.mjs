// 独立合成测试覆盖真实 MCP 取材、计算、本机备份恢复和宿主账套隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync} from 'node:fs';
import {join,dirname,resolve,relative,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createContext,writeBundle} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../05-reconstruction/codex/hosts/claude-code/adapter.mjs';
import {prepareBoundBusinessSession} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {readBaselineMaterials,resolveBaselineCalculationFacts} from '../server/business-baseline.mjs';
import {prepareBusinessMemory} from '../server/business-memory.mjs';
import {createBackup,verifyBackup,restoreNew,activateRestoreTarget} from '../server/local-backup.mjs';
import {readFinanceCall} from '../server/finance-call-chain.mjs';
import {createBaselineFixture,assertColdBaselineFixture,baselineTarget,baselineOptions,baselineLogicalSnapshot,startBaselineMcp,readBaselineJson,writeBaselineJson,hashBaseline,INDEPENDENT_BASELINE_EXPECTATIONS as EXPECTED} from './helpers/business-baseline-fixture.mjs';
import {baselineMaterialRequest,readAllBaselineMaterials,discoverBaselineCalculationMaterials,readColdBaselineMaterials,readBaselineSection,callBaselineMaterials,materialReference,fixtureSourceArgs} from './helpers/business-baseline-test-inputs.mjs';
import {assertBaselineCalculationSchema,BASELINE_CURRENT_A_SCRIPT as currentScript,BASELINE_CURRENT_B_SCRIPT as currentBScript} from './helpers/business-baseline-calculation-contract.mjs';

const ok=response=>{assert.equal(response.isError,false,response.text);assert(response.data,response.text);return response.data;};
const rejected=(response,pattern=/finance_(baseline|memory|input)_/)=>{assert.equal(response.isError,true,response.text);assert.match(response.text,pattern);return response;};
const dbRead=(path,fn)=>{const db=new DatabaseSync(path,{readOnly:true});try{return fn(db);}finally{db.close();}};
async function observationMergeContract({auditInsideSource=false}={}){
  const f=createBaselineFixture(),target=baselineTarget(f),extra=[];
  if(auditInsideSource)f.auditDir=join(f.sourceRoot,'generated-finance-audit');
  // 分次提交观察，给未供的邻近原件和审计产物分别做隔离反例。
  for(let i=0;i<24;i++){const path=join(f.sourceRoot,'a',i===0?'baseline-materials.json':'跨批工单'+i+'.json');assert(!existsSync(path));writeBaselineJson(path,{enterpriseKey:f.scopeA.enterpriseKey,业务类别:'维修',工单:'CURSOR-DOCUMENT-'+i,提供方式:'一次完工',客户签收验收日:'2026-06-27',净价:523+i});f.originalPaths.push(path);extra.push(path);}
  const unverified=join(f.sourceRoot,'主体未提供的工单.json');writeBaselineJson(unverified,{业务类别:'维修',工单:'UNVERIFIED-CURSOR-DOCUMENT',净价:329487});f.originalPaths.push(unverified);assertColdBaselineFixture(f);
  const hashes=new Map(f.originalPaths.map(path=>[path,hashBaseline(readFileSync(path))])),report={version:'baseline-observation-merge-contract-e2e/1',root:f.root,auditInsideSource,modelInvoked:false,status:'running',payloads:[]},client=await startBaselineMcp(f);let readOnlyClient;
  const capture=result=>{for(const response of result.responses){assertSafeMaterials(response);report.payloads.push({section:response.data.section,prettyBytes:response.prettyBytes,coverage:response.data.coverage});}return result;};
  try{
    const dbBefore=baselineLogicalSnapshot(f.dbPath),first=capture(await readColdBaselineMaterials(client,target,{limit:1}));
    assert.equal(first.coverage.sourceCount,Object.keys(f.files.a).length);assert.equal(first.coverage.sourceOwners.unverified,0);
    const append=fixtureSourceArgs(client,{target,originals:extra.map((path,index)=>({id:'extra_'+index,path})),section:'overview'});
    const tail=extra.at(-1),original=readFileSync(tail);
    try{
      writeBaselineJson(tail,{...JSON.parse(original),备注:'整理后原件已修订'});
      rejected(await client.call('finance_baseline_materials',append),/finance_baseline_source_changed/);
    }finally{writeFileSync(tail,original);}
    const later=capture(await readBaselineSection(client,append));
    const mergeArgs={target,materialRefs:[...first.materialRefs,...later.materialRefs],section:'overview',limit:50};
    rejected(await client.call('finance_baseline_materials',{...mergeArgs,target:baselineTarget(f,'b')}),/finance_baseline_(?:scope_conflict|material_record_invalid)/);
    rejected(await client.call('finance_baseline_materials',{...mergeArgs,materialRefs:[{...materialReference(first),snapshotDigest:'0'.repeat(64)}]}),/finance_baseline_material_record_invalid/);
    if(auditInsideSource){
      const technicalPath=join(f.auditDir,first.materialRef,'baseline-materials.json');
      rejected(await client.call('finance_baseline_materials',fixtureSourceArgs(client,{target,originals:[{id:'audit',path:technicalPath}]})));
    }
    const merged=capture(await readBaselineSection(client,mergeArgs)),raw=await localMaterials(f,merged);
    assert.equal(merged.coverage.sourceCount,first.coverage.sourceCount+extra.length);assert.equal(merged.coverage.requestCount,2);assert.equal(merged.coverage.sourceOwners.unverified,0);
    assert.deepEqual(raw.files.map(file=>resolve(file.path)).sort(),[...Object.values(f.files.a),...extra].map(path=>resolve(path)).sort(),'显式合并保留合成原件；同名客户文件可用，内部审计不可混入');
    assert(!raw.files.some(file=>file.path===unverified||Object.values(f.files.b).includes(file.path)));
    assert.equal(raw.taxBurden.summaries.find(s=>s.taxType==='vat').weightedRatio,EXPECTED.vat.weightedRatio);assert.equal(raw.taxBurden.summaries.find(s=>s.taxType==='cit').weightedRatio,EXPECTED.cit.ratio);assert.equal(baselineLogicalSnapshot(f.dbPath),dbBefore);
    const earlySupport=first.principleSupport.find(p=>p.kind==='revenue_period');assert(earlySupport);
    assert(merged.principleSupport.some(p=>p.supportRef===earlySupport.supportRef&&p.allocationBasis==='monthly_equal'));
    assert.equal(merged.coverage.taxHistory.vat.status,'included');assert.equal(merged.coverage.taxHistory.cit.status,'included');
    readOnlyClient=await startBaselineMcp(f,{readOnly:true});
    const ro=capture(await readBaselineSection(readOnlyClient,{target,materialRefs:merged.materialRefs,section:'overview',limit:50}));
    assert.equal(ro.coverage.sourceCount,merged.coverage.sourceCount);
    assert.equal(baselineLogicalSnapshot(f.dbPath),dbBefore);
    report.status='passed';report.actual={auditInsideSource,submittedSources:merged.coverage.sourceCount,requestCount:merged.coverage.requestCount,maximumWholeMcpPrettyBytes:Math.max(...report.payloads.map(p=>p.prettyBytes))};
  }catch(error){report.status='failed';report.error=error.stack;throw error;}finally{await Promise.allSettled([client.close(),readOnlyClient?.close()]);for(const [path,sha]of hashes)assert.equal(hashBaseline(readFileSync(path)),sha);report.path=join(f.root,'宿主观察分次提交合并合同结果.json');writeBaselineJson(report.path,report);}
  return {root:f.root,path:report.path,status:report.status,actual:report.actual};
}
async function accountingStandardSourceContract(){
  const f=createBaselineFixture(),client=await startBaselineMcp(f),originalHashes=new Map(f.originalPaths.map(path=>[path,hashBaseline(readFileSync(path))])),report={version:'baseline-standard-value-authority-e2e/1',root:f.root,modelInvoked:false,status:'running',checks:[]};
  try{
    for(const name of ['a','b']){
      const actual=name==='a'?'enterprise':'small_enterprise',opposite=name==='a'?'small_enterprise':'enterprise',path=join(f.sourceRoot,name,'与当前账套相反的旧准则资料.json');writeBaselineJson(path,{enterpriseKey:f['scope'+name.toUpperCase()].enterpriseKey,会计准则:name==='a'?'小企业会计准则':'企业会计准则'});
      const target=baselineTarget(f,name),materials=await readBaselineSection(client,{target,originals:[{id:'older-standard',path}],section:'facts',limit:50});for(const response of materials.responses)assertSafeMaterials(response);const standards=materials.facts.filter(fact=>fact.field==='accounting_standard'),ledger=standards.find(fact=>fact.source.kind==='ledger_configuration'),file=standards.find(fact=>fact.source.kind==='file'&&fact.value===opposite);assert.equal(ledger?.value,actual);assert(file,'反向资料应真实进入同企业已读事实，不能靠测试漏读来拒绝');
      const before=baselineLogicalSnapshot(f.dbPath),overview=await readBaselineSection(client,{target,materialRefs:materials.materialRefs,section:'overview'});
      assert.deepEqual(overview.principleSupport.filter(item=>item.kind==='accounting_standard').map(item=>item.value),[actual]);
      assert.equal(baselineLogicalSnapshot(f.dbPath),before);
      report.checks.push({name,actual,opposite,materialRef:materials.materialRef});
    }
    report.status='passed';
  }catch(error){report.status='failed';report.error=error.stack;throw error;}finally{await client.close();for(const [path,sha]of originalHashes)assert.equal(hashBaseline(readFileSync(path)),sha);report.path=join(f.root,'准则实际值来源守卫结果.json');writeBaselineJson(report.path,report);}
  return {root:f.root,path:report.path,status:report.status,checks:report.checks};
}
async function localMaterials(f,materials){
  const record=await readFinanceCall({auditDir:f.auditDir,callId:materials.materialRef}),descriptor=record.end.metadata?.businessBaselineMaterials;
  assert.equal(record.integrity,'verified');assert.equal(descriptor?.file,'baseline-materials.json');
  const bytes=readFileSync(join(record.recordPath,descriptor.file));assert.equal(hashBaseline(bytes),descriptor.sha256);assert.equal(bytes.length,descriptor.bytes);
  const snapshot=JSON.parse(bytes);assert.equal(snapshot.snapshotDigest,materials.snapshotDigest);return snapshot;
}
function addTaxOriginal(f,request,id,rows){
  const path=join(f.sourceRoot,'a',id+'.json');writeBaselineJson(path,{enterpriseKey:f.scopeA.enterpriseKey,行:rows});
  const fields={tax_type:'税种',tax_measure:'税额口径',tax_stage:'税额阶段',period_basis:'期间口径',accumulation:'累计口径',period_start:'所属期起',period_end:'所属期止',tax_amount:'应纳税额',sales_ex_vat:'不含税应税销售额'};
  return {...request,originals:[...request.originals,{id,path}],selections:[...request.selections,...rows.flatMap((row,i)=>Object.entries(fields).map(([field,key])=>({id:id+i+'_'+field,originalId:id,group:id+i,field,locator:{jsonPointer:'/行/'+i+'/'+(field==='tax_amount'&&row.税额口径==='实缴'?'实缴税额':key)}})))]};
}
function addCitOriginal(f,request,id,rows){
  const path=join(f.sourceRoot,'a',id+'.json');writeBaselineJson(path,{enterpriseKey:f.scopeA.enterpriseKey,行:rows});
  const fields={tax_type:'税种',tax_measure:'税额口径',tax_stage:'税额阶段',period_basis:'期间口径',accumulation:'累计口径',period_start:'所属期起',period_end:'所属期止',revenue:'累计营业收入'};
  return {...request,originals:[...request.originals,{id,path}],selections:[...request.selections,...rows.flatMap((row,i)=>Object.entries({...fields,tax_amount:row.税额阶段==='优惠前应纳'?'优惠前应纳税额':row.税额阶段==='实缴'?'累计实际已预缴':'减免后累计应纳税额'}).map(([field,key])=>({id:id+i+'_'+field,originalId:id,group:id+i,field,locator:{jsonPointer:'/行/'+i+'/'+key}})))]};
}
function assertSafeMaterials(response){
  const modelPayload={wire:response.raw??response.data,parsedText:response.data},text=JSON.stringify(modelPayload),numbers=[];
  const walk=value=>{if(typeof value==='number')numbers.push(value);else if(value&&typeof value==='object')for(const v of Object.values(value))walk(v);};walk(modelPayload);
  for(const canary of [330000,600000,60000,80000,24000,12000,5960,300000,987653.21])assert(!numbers.includes(canary),'原始金额/税负分子分母不能进入模型投影：'+canary);
  for(const raw of ['A-LEASE-APR','A-MAINT-APR','2026-04-01','LOCAL_ONLY_SYNTHETIC_','"originalCost":','"denominator":','"taxAmount":','"debit":','"credit":'])assert(!text.includes(raw),'原始日期/业务编号/分录值只能留本机：'+raw);
}
test('B05/B11 安全计算对象结构经真实next到本机桥，区分日期月份且缺匹配不默零',{timeout:240000},async()=>{
  const f=createBaselineFixture(),client=await startBaselineMcp(f),report={version:'baseline-calculation-schema-bridge-e2e/1',root:f.root,modelInvoked:false,status:'running',payloads:[]};
  const hashes=new Map(f.originalPaths.map(path=>[path,hashBaseline(readFileSync(path))])),record=materials=>{for(const response of materials.allResponses??materials.responses??[materials]){assertSafeMaterials(response);report.payloads.push({section:response.data.section,prettyBytes:response.prettyBytes,pagination:response.data.pagination,sourceCount:response.data.coverage.sourceCount,materialRef:response.data.materialRef});}return materials;};
  try{
    assertColdBaselineFixture(f);const before=baselineLogicalSnapshot(f.dbPath),tools=(await client.rpc('tools/list')).result.tools;assert(tools.find(t=>t.name==='finance_baseline_materials').inputSchema.properties.section.enum.includes('calculation'));
    const plain=record(await callBaselineMaterials(client,{target:baselineTarget(f),limit:1}));assert.equal(plain.data.coverage.sourceCount,0);assert.equal(plain.data.calculationSchema,undefined);
    for(const section of ['facts','coverage','tax','calculation']){
      const actual=record(await callBaselineMaterials(client,{target:baselineTarget(f),section,limit:1})).data;
      assert.equal(actual.section,section);assert.equal(actual.coverage.sourceCount,0);
      assert(actual[section==='coverage'?'details':section==='tax'?'taxBurden':section==='calculation'?'calculationSchema':'facts']);
      if(section==='calculation')assert.equal(actual.calculationSchema.objectCount,0);
    }
    const a=record(await discoverBaselineCalculationMaterials(client,baselineTarget(f))),b=record(await discoverBaselineCalculationMaterials(client,baselineTarget(f,'b')));assert(a.pages.length>1&&b.pages.length>1,'对象结构必须真实续页，不能只核首对象');assert(a.allResponses.every(r=>r.data.section==='calculation'));assert(a.allResponses[0].request.inputPath,'首批源必须先由宿主准备');assert(a.allResponses.slice(1).every(r=>r.request.materialRefs?.length===1));
    const local=async(materials,target)=>resolveBaselineCalculationFacts({target,materialRefs:materials.materialRefs,expectedReaderSha256:materials.calculationReader.sha256},{...baselineOptions(f),readOnly:true}),aLocal=await local(a,baselineTarget(f)),bLocal=await local(b,baselineTarget(f,'b'));assertBaselineCalculationSchema(a.calculationSchema,aLocal);assertBaselineCalculationSchema(b.calculationSchema,bLocal);
    const maintenance=a.calculationSchema.objects.filter(o=>o.semanticValues.business_kind==='maintenance'&&Object.hasOwn(o.fields,'amount_net'));assert.equal(maintenance.length,1);assert.equal(maintenance[0].fields.service_end,'date');assert.equal(a.calculationSchema.fieldTypes.date.format,'YYYY-MM-DD');
    const stock=b.calculationSchema.objects.filter(o=>Object.hasOwn(o.fields,'issue_quantity'));assert.equal(stock.length,1);for(const name of ['period_start','period_end'])assert.equal(stock[0].fields[name],'period');assert.equal(b.calculationSchema.fieldTypes.period.format,'YYYY-MM');assert.equal(stock[0].fields.opening_unit_price,'unit_price');
    const runArgs=(materials,target,script)=>({title:'程序安全对象结构至本机桥，非真实模型自主计算',engine:'javascript',script,sources:[],parameters:{period:target.period,target,materialRefs:materials.materialRefs,reader:materials.calculationReader,calculationSchema:materials.calculationSchema}}),aRun=ok(await client.call('finance_calculation_run',runArgs(a,baselineTarget(f),currentScript))),bRun=ok(await client.call('finance_calculation_run',runArgs(b,baselineTarget(f,'b'),currentBScript)));
    const aResult=readBaselineJson(aRun.outputs.find(o=>o.path.endsWith('7月业务结果.json')).path),bResult=readBaselineJson(bRun.outputs.find(o=>o.path.endsWith('乙7月业务结果.json')).path);for(const [key,value]of Object.entries(EXPECTED.july.a))assert.equal(aResult[key],value,key);for(const [key,value]of Object.entries(EXPECTED.july.b))assert.equal(bResult[key],value,key);assert.deepEqual(aResult.schemaConsumption.maintenanceObjectRefs,maintenance.map(o=>o.objectRef));assert.deepEqual(bResult.schemaConsumption.inventoryObjectRefs,stock.map(o=>o.objectRef));assert.equal(bResult.schemaConsumption.periodComparison,'calendar_month');
    for(const ran of [aRun,bRun]){assert.equal(ran.status,'executed');assert(!JSON.stringify(ran).includes('financeContext'));const input=readBaselineJson(join(dirname(ran.recordPath),'input.json'));assert.equal(input.financeContext.dbPath,f.dbPath);assert.equal(input.sources.length,0);assert(input.parameters.calculationSchema.objects.length);}
    const noMaintenance=record(await readBaselineSection(client,{target:baselineTarget(f),originals:['lease','newLease','repairs'].map(id=>({id,path:f.files.a[id]})),section:'calculation',limit:1}));assert(!noMaintenance.calculationSchema.objects.some(o=>o.semanticValues.business_kind==='maintenance'));const missingBusiness=await client.call('finance_calculation_run',runArgs(noMaintenance,baselineTarget(f),currentScript));rejected(missingBusiness,/finance_calculation_execution_failed/);
    const aRaw=await localMaterials(f,a),maintenanceRefs=new Set(aLocal.objects.find(o=>o.objectRef===maintenance[0].objectRef).evidenceRefs),missingEnd=aRaw.facts.find(fact=>fact.field==='service_end'&&maintenanceRefs.has(fact.factRef));assert(missingEnd);const incompleteArgs=runArgs(a,baselineTarget(f),currentScript);incompleteArgs.parameters.factRefs=aLocal.objects.flatMap(o=>o.evidenceRefs).filter(ref=>ref!==missingEnd.factRef);rejected(await client.call('finance_calculation_run',incompleteArgs),/finance_calculation_execution_failed/);
    const augustTarget=baselineTarget(f,'b','2026-08'),august=record(await discoverBaselineCalculationMaterials(client,augustTarget)),unmatchedPeriod=await client.call('finance_calculation_run',runArgs(august,augustTarget,currentBScript));rejected(unmatchedPeriod,/finance_calculation_execution_failed/);
    assert.equal(baselineLogicalSnapshot(f.dbPath),before,'新结构入口/本机桥/计算不暗改账或创建基线');report.status='passed';report.actual={aObjectCount:a.calculationSchema.objectCount,bObjectCount:b.calculationSchema.objectCount,aSourceCount:a.coverage.sourceCount,aSchemaPages:a.pages.length,bSchemaPages:b.pages.length,maximumWholeMcpPrettyBytes:Math.max(...report.payloads.map(p=>p.prettyBytes)),aResult,bResult,negativeResults:{maintenanceUnmatched:missingBusiness.isError,missingServiceEndRejected:true,inventoryPeriodUnmatched:unmatchedPeriod.isError},databaseUnchanged:true,programmaticScriptsAuthoredByTest:true};
  }catch(error){report.status='failed';report.error=error.stack;throw error;}finally{await client.close();for(const [path,sha]of hashes)assert.equal(hashBaseline(readFileSync(path)),sha);writeBaselineJson(join(f.root,'安全计算结构至本机桥结果.json'),report);console.log(JSON.stringify({status:report.status,root:f.root,report:join(f.root,'安全计算结构至本机桥结果.json'),actual:report.actual,error:report.error}));}
});

test('B01/B04/B05 大批量完整MCP预算、正常续页与显式合并，不再丢早期支持和申报口径',{timeout:240000},async()=>{
  const f=createBaselineFixture(),client=await startBaselineMcp(f),target=baselineTarget(f),report={version:'baseline-overview-extract-merge-e2e/1',root:f.root,modelInvoked:false,status:'running',payloads:[]};let readOnlyClient;
  const record=materials=>{for(const r of materials.allResponses??materials.responses??[materials]){assertSafeMaterials(r);report.payloads.push({section:r.data.section,prettyBytes:r.prettyBytes,wholeMcpSha256:hashBaseline(JSON.stringify(r.raw,null,2)),materialRef:r.data.materialRef,coverage:r.data.coverage,pagination:r.data.pagination});}return materials;};
  try{
    assertColdBaselineFixture(f);const beforeDb=baselineLogicalSnapshot(f.dbPath),early=record(await readColdBaselineMaterials(client,target)),earlyRaw=await localMaterials(f,early);assert.equal(early.coverage.taxHistory.vat.status,'included');assert.equal(early.coverage.taxHistory.cit.status,'included');
    const earlySupport=early.principleSupport.find(p=>p.kind==='revenue_period'&&p.when==='lease');assert(earlySupport,'先前真实读取已给出窄范围租赁支持');
    const taxRequest=baselineMaterialRequest(f),partialTax=record(await readBaselineSection(client,{target,originals:taxRequest.originals.filter(o=>o.id==='a_vat'),selections:taxRequest.selections.filter(s=>s.id.startsWith('a_vat0_')),section:'overview',limit:50}));
    const partialRaw=await localMaterials(f,partialTax);
    assert.equal(partialRaw.taxBurden.summaries.find(s=>s.taxType==='vat').periodCount,1,'未提交的其余两行并不自动参与计算');
    const noArtifact=record(await callBaselineMaterials(client,{target,section:'coverage',limit:1})).data;
    assert.equal(noArtifact.coverage.sourceCount,0);assert.equal(noArtifact.coverage.valueVisibility,'local_only_not_missing');
    // 独立预算现场增加自然归档包：重复合同副本是实际文件内容，不预写核算方法或完整企业规则。
    const bulkPath=join(f.sourceRoot,'a','大批量合同自然归档包.json'),lease=readBaselineJson(f.files.a.lease),maintenance=readBaselineJson(f.files.a.maintenance);
    writeBaselineJson(bulkPath,{enterpriseKey:f.scopeA.enterpriseKey,归档合同:[...Array.from({length:6},()=>lease),...Array.from({length:5},()=>maintenance)]});
    const late=record(await readBaselineSection(client,{target,originals:[{id:'bulk',path:bulkPath}],section:'overview',limit:50}));
    assert.equal(late.coverage.taxHistory.vat.status,'not_in_supplied_materials');assert.equal(late.coverage.taxHistory.cit.status,'not_in_supplied_materials');
    const details=record(await readBaselineSection(client,{target,materialRefs:late.materialRefs,section:'facts',limit:7}));
    const observedFacts=details.facts.filter(x=>x.source.kind==='file'&&x.semanticAuthority==='agent_observation').length;
    assert(observedFacts>=109,'预算回归必须有至少109个实际文件观察');assert(details.pages.length>12,'正常详情页实际超过12次，不能误吃源闭包限制');
    const joined=record(await readBaselineSection(client,{target,materialRefs:[...early.materialRefs,...details.materialRefs],section:'overview',limit:50}));assert.equal(joined.materialRefs.length,1);assert.equal(joined.coverage.taxHistory.vat.status,'included');assert.equal(joined.coverage.taxHistory.cit.status,'included');assert(joined.principleSupport.some(p=>p.kind===earlySupport.kind&&p.value===earlySupport.value&&p.when===earlySupport.when),'后读大材料不能吞掉早期支持');
    const joinedRaw=await localMaterials(f,joined);assert.deepEqual(joinedRaw.taxBurden.summaries,earlyRaw.taxBurden.summaries,'overview摘要与保存全事实使用相同税源，不按展示页截断');
    const alias=record(await readBaselineSection(client,{target,originals:[{id:'same_vat_different_caller_id',path:f.files.a.vat}],section:'overview',limit:50}));
    const aliasRaw=await localMaterials(f,alias);
    assert.equal(aliasRaw.taxBurden.summaries.find(s=>s.taxType==='vat').periodCount,3);
    let duplicate=record(await readBaselineSection(client,{target,materialRefs:[...joined.materialRefs,...joined.materialRefs],section:'overview',limit:50}));const duplicateRaw=await localMaterials(f,duplicate);assert.equal(duplicate.coverage.sourceCount,joined.coverage.sourceCount);assert.equal(duplicate.coverage.factCount,joined.coverage.factCount);assert.deepEqual(duplicateRaw.taxBurden.summaries,joinedRaw.taxBurden.summaries,'重复merge不双算税额');
    const aliased=record(await readBaselineSection(client,{target,materialRefs:[...duplicate.materialRefs,...alias.materialRefs],section:'tax'}));
    assert.deepEqual((await localMaterials(f,aliased)).taxBurden.summaries,joinedRaw.taxBurden.summaries,'同原件别名不双算税额');
    const counts={facts:duplicate.coverage.factCount,sources:duplicate.coverage.sourceCount,requests:duplicate.coverage.requestCount},stableDigest=duplicate.snapshotDigest;
    for(let i=0;i<15;i++){
      const view=record(await callBaselineMaterials(client,{target,materialRefs:duplicate.materialRefs,section:i%2?'tax':'overview',limit:1})).data;assert.equal(view.snapshotDigest,stableDigest,'重看视图不能扩展或改变来源集合');assert.deepEqual({facts:view.coverage.factCount,sources:view.coverage.sourceCount,requests:view.coverage.requestCount},counts);duplicate={...view,materialRefs:[materialReference(view)]};
    }
    // 未提供税务原件时，应如实记录缺口。
    const omitted=record(await readBaselineSection(client,{target,originals:[{id:'only_cost',path:f.files.a.cost}],section:'overview',limit:50}));
    for(const taxType of ['vat','cit'])assert.equal(omitted.coverage.taxHistory[taxType].status,'not_in_supplied_materials');
    const final=record(await readBaselineSection(client,{target,materialRefs:duplicate.materialRefs,section:'overview',limit:50}));
    rejected(await client.call('finance_baseline_materials',{target:baselineTarget(f,'b'),materialRefs:final.materialRefs,section:'overview'}),/finance_baseline_(?:scope_conflict|material_record_invalid)/);
    const original=readFileSync(bulkPath);try{writeBaselineJson(bulkPath,{...JSON.parse(original),备注:'来源版本已修订'});rejected(await client.call('finance_baseline_materials',{target,materialRefs:final.materialRefs,section:'overview'}),/finance_baseline_(?:material_changed|source_changed)/);}finally{writeFileSync(bulkPath,original);}
    assert(final.principleSupport.some(p=>p.supportRef===earlySupport.supportRef));
    readOnlyClient=await startBaselineMcp(f,{readOnly:true});
    const readOnly=record(await readBaselineSection(readOnlyClient,{target,materialRefs:final.materialRefs,section:'overview',limit:50}));assert.equal(readOnly.snapshotDigest,final.snapshotDigest);
    // 真正不同的申报数不能为预算而择低/洗平；冲突资料只在这个独立现场中构造。
    const conflictPath=join(f.sourceRoot,'a','另一份实际不同的历史申报导出.json'),vat=readBaselineJson(f.files.a.vat);vat.行[0].应纳税额=1900;writeBaselineJson(conflictPath,vat);
    const conflict=record(await readBaselineSection(client,{target,originals:[{id:'conflict',path:conflictPath}],section:'overview',limit:50})),conflicted=record(await readBaselineSection(client,{target,materialRefs:[...final.materialRefs,...conflict.materialRefs],section:'overview',limit:50}));assert(conflicted.gaps.includes('historical_conflict'));
    const observationMerge=await observationMergeContract(),observationMergeAuditInside=await observationMergeContract({auditInsideSource:true});assert.equal(baselineLogicalSnapshot(f.dbPath),beforeDb,'材料查询与合并不写入账库');report.actual={observedFacts,factPages:details.pages.length,viewRereads:15,mergedLeafCount:counts.requests,maximumWholeMcpPrettyBytes:Math.max(...report.payloads.map(p=>p.prettyBytes)),taxWeightedRatio:duplicateRaw.taxBurden.summaries.find(s=>s.taxType==='vat').weightedRatio,omittedCoverage:omitted.coverage,observationMerge,observationMergeAuditInside};report.status='passed';
  }catch(error){report.status='failed';report.error=error.stack;throw error;}finally{await Promise.allSettled([client.close(),readOnlyClient?.close()]);writeBaselineJson(join(f.root,'大批量分页合并合同结果.json'),report);console.log(JSON.stringify({status:report.status,root:f.root,report:join(f.root,'大批量分页合并合同结果.json'),actual:report.actual,error:report.status==='failed'?report.error:undefined}));}
});

test('独立材料合同、两企业保护及本期计算',{timeout:600000},async()=>{
  const f=createBaselineFixture(process.env.BUSINESS_BASELINE_E2E_ROOT),report={version:'independent-business-baseline-program-e2e/3',root:f.root,startedAt:new Date().toISOString(),modelInvoked:false,realClaudeLifecycleInvoked:false,currentScriptsAuthoredByTest:true,humanApproval:false,checks:[],unverified:['程序使用合成材料和测试脚本；不证明真实模型自主生成或推理。','Node hook输入是程序模拟，不证明真实Claude lifecycle；真实模型另用干净阳性现场。','未提交正式凭证、申报或缴款；未读取真实业务资料。']};
  let client,readOnlyClient,scopedClient,materialsA,materialsB,workspaceA,workspaceB;
  const check=async(name,fn)=>{const start=Date.now();try{await fn();report.checks.push({name,status:'passed',durationMs:Date.now()-start});}catch(error){report.checks.push({name,status:'failed',error:error.message,durationMs:Date.now()-start});throw error;}};
  try{
    await check('B01/B06 冷启动材料不建表不改账',async()=>{
      report.cold=assertColdBaselineFixture(f);const before=baselineLogicalSnapshot(f.dbPath);
      client=await startBaselineMcp(f);const tools=(await client.rpc('tools/list')).result.tools;
      assert.equal(tools.find(tool=>tool.name==='finance_baseline_materials')?.annotations.readOnlyHint,true);
      const missing=(await callBaselineMaterials(client,{target:baselineTarget(f),limit:50})).data;assert.equal(missing.coverage.taxHistory.vat.status,'not_in_supplied_materials');assert.equal(missing.coverage.taxHistory.cit.status,'not_in_supplied_materials');
      assert.equal(baselineLogicalSnapshot(f.dbPath),before);
    });
    await check('B03/B04/B05 真实合同/关联历史和数期申报读入，模型无逐笔原值，本机独立核税负',async()=>{
      const before=baselineLogicalSnapshot(f.dbPath);materialsA=await readColdBaselineMaterials(client,baselineTarget(f));materialsB=await readColdBaselineMaterials(client,baselineTarget(f,'b'));for(const response of [...materialsA.allResponses,...materialsB.allResponses])assertSafeMaterials(response);
      assert.equal(materialsA.materialRefs.length,1);assert.equal(materialsA.coverage.taxHistory.vat.status,'included');assert.equal(materialsA.coverage.taxHistory.cit.status,'included');assert.equal(materialsA.coverage.valueVisibility,'local_only_not_missing');
      assert.deepEqual(materialsB.gaps,[],'宿主未观察到已发生验收不污染已有历史原则');const bCoverage=await readBaselineSection(client,{target:baselineTarget(f,'b'),materialRefs:materialsB.materialRefs,section:'coverage',limit:50});for(const response of bCoverage.responses)assertSafeMaterials(response);
      assert(bCoverage.details.some(d=>d.originalId==='b_repairs'&&d.sourceObservation==='agent_observation'));
      const raw=await localMaterials(f,materialsA),rawB=await localMaterials(f,materialsB);
      const support=materialsA.pages.flatMap(page=>page.principleSupport);for(const [kind,value,when]of [['revenue_period','service_period','lease'],['expense_period','benefit_period','maintenance']])assert.equal(support.find(p=>p.kind===kind&&p.value===value&&p.when===when)?.allocationBasis,'monthly_equal','真实材料须披露有历史支持的月等额基准');
      const vat=raw.taxBurden.summaries.find(x=>x.taxType==='vat'&&x.measure==='payable'&&x.periodBasis==='attribution'&&x.stage==='payable_after_relief'),cit=raw.taxBurden.summaries.find(x=>x.taxType==='cit'&&x.accumulation==='cumulative'&&x.stage==='payable_after_relief');
      assert(vat&&cit);assert.equal(vat.taxAmount,5960);assert.equal(vat.denominator,300000);assert.equal(vat.periodCount,3);assert.equal(vat.weightedRatio,EXPECTED.vat.weightedRatio);assert.equal(vat.minimumRatio,0.018);assert.equal(vat.maximumRatio,0.022);assert.notEqual(vat.weightedRatio,0.02);
      assert.equal(cit.taxAmount,3000);assert.equal(cit.denominator,600000);assert.equal(cit.weightedRatio,0.005);assert.notEqual(cit.taxAmount,2500);
      assert.equal(rawB.facts.find(x=>x.field==='accounting_standard').value,'small_enterprise');assert.equal(rawB.facts.find(x=>x.field==='inventory_cost').value,'fifo');
      assert.equal(baselineLogicalSnapshot(f.dbPath),before);report.materialRefs={a:materialsA.materialRef,b:materialsB.materialRef};report.independentTaxComparison={vat,cit};report.materialCoverage={a:materialsA.coverage,b:materialsB.coverage};report.mcpPayloads=[...materialsA.allResponses,...materialsB.allResponses].map(r=>({section:r.data.section,prettyBytes:r.prettyBytes,sourceCount:r.data.coverage.sourceCount}));
    });
    await check('B04 同口径税额按期别对照，缺件和冲突留缺口',async()=>{
      const edge=createBaselineFixture(),edgeClient=await startBaselineMcp(edge);report.taxEdgeRoot=edge.root;
      try{
        const row=readBaselineJson(edge.files.a.vat).行[0],base=baselineMaterialRequest(edge,'a');
        const conflict=await readAllBaselineMaterials(edgeClient,addTaxOriginal(edge,base,'conflict_vat',[{...row,应纳税额:1900}]));assert(conflict.taxBurden.gaps.includes('historical_conflict'));const taxNext=conflict.pages.map(page=>page.taxBurden?.pagination?.next).find(Boolean);if(taxNext){assert.equal(taxNext.tool,'finance_baseline_materials');assert.equal(taxNext.arguments.section,'tax');const continued=await readBaselineSection(edgeClient,taxNext.arguments);for(const response of continued.responses)assertSafeMaterials(response);assert(continued.pages.flatMap(page=>page.taxBurden?.summaries??[]).length,'概览容纳不下税负时，正常tax next必须可达');}
        const stage=await readAllBaselineMaterials(edgeClient,addTaxOriginal(edge,base,'paid_vat',[{...row,税额口径:'实缴',税额阶段:'实缴',期间口径:'缴款期',所属期起:'2026-05',所属期止:'2026-05',实缴税额:1700}])),raw=await localMaterials(edge,stage);
        assert.equal(raw.taxBurden.summaries.find(x=>x.taxType==='vat'&&x.stage==='payable_after_relief').weightedRatio,EXPECTED.vat.weightedRatio);assert.equal(raw.taxBurden.summaries.find(x=>x.taxType==='vat'&&x.stage==='paid').taxAmount,1700);
        const citBase=readBaselineJson(edge.files.a.cit),citMaterials=await readAllBaselineMaterials(edgeClient,addCitOriginal(edge,base,'cit_dimensions',[{...citBase,所属期止:'2026-03',累计营业收入:330000,减免后累计应纳税额:1200},{...citBase,税额阶段:'优惠前应纳',优惠前应纳税额:12000},{...citBase,税额口径:'实缴',税额阶段:'实缴',期间口径:'缴款期'}])),citRaw=await localMaterials(edge,citMaterials),cits=citRaw.taxBurden.summaries.filter(x=>x.taxType==='cit');
        assert.deepEqual(cits.filter(x=>x.stage==='payable_after_relief').map(x=>x.taxAmount),[1200,3000],'累计时点分别保留，不把两个累计值相加');assert.equal(cits.find(x=>x.stage==='payable_after_relief'&&x.through==='2026-06').weightedRatio,0.005);assert.equal(cits.find(x=>x.stage==='payable_before_relief').weightedRatio,0.02);assert.equal(cits.find(x=>x.stage==='paid').taxAmount,2500);
        const missing=await readAllBaselineMaterials(edgeClient,{target:baselineTarget(edge),limit:50});
        assert.equal(missing.taxBurden.missing,true);assert.deepEqual(missing.taxBurden.summaries,[]);
      }finally{await edgeClient.close();}
    });
    await check('B05 缺净应纳只记税务缺口，日期观察须为有效日期，源字段语义由宿主提供',async()=>{
      const request=baselineMaterialRequest(f,'a');
      request.selections=request.selections.filter(s=>s.id!=='a_cit0_tax_amount').map(s=>s.id==='a_maintenance_confirmation_date'?{...s,locator:{jsonPointer:'/合同编号'}}:s);
      const observed=ok(await client.call('finance_baseline_materials',fixtureSourceArgs(client,request)));
      const raw=await localMaterials(f,observed);
      assert(observed.gaps.includes('tax_basis_incomplete'));assert(observed.gaps.includes('unsupported_material'));
      assert(!raw.taxBurden.summaries.some(x=>x.taxType==='cit'),'实际预缴不能补入未供的净应纳');
      assert(!raw.facts.some(x=>x.field==='confirmation_date'&&x.source.originalId==='a_maintenance'));
      assert(raw.facts.some(x=>x.field==='invoice_date'&&x.source.originalId==='a_maintenance'&&x.semanticAuthority==='agent_observation'));
    });
    await check('B05 不合并独立税务观察，也不跨合同拼证据',async()=>{
      const tax=baselineMaterialRequest(f,'a');tax.selections=tax.selections.map(s=>s.id==='a_vat0_sales_ex_vat'?{...s,group:'separate-sale-observation',locator:{jsonPointer:'/行/1/不含税应税销售额'}}:s);
      const taxResponse=await client.call('finance_baseline_materials',fixtureSourceArgs(client,tax));
      if(taxResponse.isError)assert.match(taxResponse.text,/finance_baseline_/);else{
        const raw=await localMaterials(f,taxResponse.data);assert(taxResponse.data.gaps.length>0,'跨行拼税表必须未核');assert(!raw.taxBurden.rows.some(r=>r.taxType==='vat'&&r.from==='2026-04'&&r.taxAmount===1800&&r.denominator===120000),'不能拼出不存在的4月税负行');
      }
      const path=join(f.sourceRoot,'a','不同编号但同额的另一仓库合同.json');writeBaselineJson(path,{...readBaselineJson(f.files.a.lease),合同编号:'A-LEASE-OTHER-NO-RELATION'});
      const lease=baselineMaterialRequest(f,'a');lease.originals.push({id:'other_splice',path});lease.selections=lease.selections.map(s=>s.id==='a_lease_amount_net'?{...s,originalId:'other_splice'}:s);
      const leaseResponse=await client.call('finance_baseline_materials',fixtureSourceArgs(client,lease));
      if(leaseResponse.isError)assert.match(leaseResponse.text,/finance_baseline_/);else{
        const disclosed=await readAllBaselineMaterials(client,{target:baselineTarget(f),materialRefs:[materialReference(leaseResponse.data)],limit:50});assert(!disclosed.principleSupport.some(p=>p.kind==='revenue_period'&&p.value==='service_period'&&p.when==='lease'),'被拼接合同不得提供已核分期收入線索');
      }
      const preserved=join(f.reviewer,'跨合同拼接负例原件.json');for(const candidate of [path,preserved]){const part=relative(resolve(f.root),resolve(candidate));assert(part&&!isAbsolute(part)&&part!=='..'&&!part.startsWith('..\\')&&!part.startsWith('../'),'负例隔离源/目标必须都在本合成根内');}assert(!existsSync(preserved),'隔离不覆盖原资料');renameSync(path,preserved);report.negativeIsolation={source:resolve(path),preserved:resolve(preserved),meaning:'仅移出测试专门构造的拼接反例；产品没有按fixture名单忽略合同，真实新增合法合同仍应计入或核实'};
    });
    report.accountingStandardSource=await accountingStandardSourceContract();
    rejected(await client.call('finance_baseline_materials',fixtureSourceArgs(client,{...baselineMaterialRequest(f,'a'),target:baselineTarget(f,'b')})),/finance_baseline_source_scope_conflict/);
    await check('独立 Node 生命周期只校验账套和会话',async()=>{
      const memoryPaths={},before=baselineLogicalSnapshot(f.dbPath);
      for(const name of ['a','b']){
        const workspace=join(f.root,'program-claude-'+name),ctx=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:f.dbPath,sourceRoot:f.sourceRoot,auditDir:f.auditDir,outputDir:workspace});writeBundle(ctx,buildConfig(ctx));const bound=await prepareBoundBusinessSession(workspace,baselineTarget(f,name));memoryPaths[name]=bound.memoryPath;if(name==='a')workspaceA=workspace;else workspaceB=workspace;
      }
      assert.notEqual(memoryPaths.a,memoryPaths.b);assert.equal(baselineLogicalSnapshot(f.dbPath),before);
      const session='synthetic_baseline_'+randomUUID().replaceAll('-',''),sources=['startup','resume','clear','compact'];
      for(const source of sources){
        const run=spawnSync(process.execPath,[join(workspaceA,'business-memory-context.mjs'),'--claude-hook'],{cwd:workspaceA,input:JSON.stringify({hook_event_name:'SessionStart',source,cwd:workspaceA,session_id:session}),encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,FINANCE_CLAUDE_LAUNCH_ID:'',NODE_NO_WARNINGS:'1'}});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),{});assert.equal(baselineLogicalSnapshot(f.dbPath),before);
      }
      assert.equal(existsSync(memoryPaths.a),false);report.simulatedNodeHook={sources,additionalContext:false,realClaudeInvoked:false};
    });
    await check('B05/B11 安全计算对象结构→只读受信桥→实际计算器处理两企业7月，拒绝错身份与变源',async()=>{
      scopedClient=await startBaselineMcp(f,{sessionPath:join(workspaceA,'.finance/business-session.json')});
      rejected(await scopedClient.call('finance_baseline_materials',{target:baselineTarget(f,'b')}),/finance_memory_session_conflict/);
      const current=await discoverBaselineCalculationMaterials(scopedClient,baselineTarget(f));for(const response of current.responses)assertSafeMaterials(response);const reader=current.calculationReader;assert.equal(hashBaseline(readFileSync(fileURLToPath(reader.moduleUrl))),reader.sha256);
      const bridgeArgs={target:baselineTarget(f),materialRefs:current.materialRefs,expectedReaderSha256:reader.sha256},before=baselineLogicalSnapshot(f.dbPath),local=await resolveBaselineCalculationFacts(bridgeArgs,{...baselineOptions(f),readOnly:true});assert.equal(local.scopeVerified,true);assertBaselineCalculationSchema(current.calculationSchema,local);assert(local.objects.some(o=>o.values.amount_net===120000));assert(!JSON.stringify(local).includes('A-LEASE-APR'));assert.equal(baselineLogicalSnapshot(f.dbPath),before,'受信桥只读取，不安装/刷新/改账');
      await assert.rejects(resolveBaselineCalculationFacts({...bridgeArgs,target:baselineTarget(f,'b')},baselineOptions(f)),/finance_baseline_/);await assert.rejects(resolveBaselineCalculationFacts({...bridgeArgs,expectedReaderSha256:'0'.repeat(64)},baselineOptions(f)),/finance_baseline_reader_version_conflict/);await assert.rejects(resolveBaselineCalculationFacts({...bridgeArgs,factRefs:['bf:'+'0'.repeat(64)]},baselineOptions(f)),/finance_baseline_reader_fact_invalid/);
      const original=readFileSync(f.files.a.newLease);let changedReaderCode;try{writeBaselineJson(f.files.a.newLease,{...JSON.parse(original),净租金:239999});await assert.rejects(resolveBaselineCalculationFacts(bridgeArgs,baselineOptions(f)),error=>{changedReaderCode=error.code;assert.match(error.code,/^finance_baseline_(?:material_changed|source_changed|locator_missing)$/);return true;});}finally{writeFileSync(f.files.a.newLease,original);}report.bridge={reader,changedSourceRejection:changedReaderCode,readOnlyDatabaseUnchanged:true,scopeConflictRejected:true};
      const run=ok(await scopedClient.call('finance_calculation_run',{title:'程序经安全对象结构及opaque本机桥7月计算，不是模型推理验收',engine:'javascript',script:currentScript,parameters:{period:'2026-07',target:baselineTarget(f),materialRefs:current.materialRefs,reader,calculationSchema:current.calculationSchema},sources:[]}));assert.equal(run.status,'executed');assert(!JSON.stringify(run).includes('financeContext'));const result=readBaselineJson(run.outputs.find(x=>x.path.endsWith('7月业务结果.json')).path);for(const [key,value]of Object.entries(EXPECTED.july.a))assert.equal(result[key],value,key);const actualInput=readBaselineJson(join(dirname(run.recordPath),'input.json'));assert.equal(actualInput.financeContext.dbPath,f.dbPath);assert.equal(actualInput.sources.length,0,'本期计算不读取由测试方提供中文列名的raw快照');assert(actualInput.parameters.calculationSchema.objects.length);await scopedClient.close();scopedClient=undefined;
      const bClient=await startBaselineMcp(f,{sessionPath:join(workspaceB,'.finance/business-session.json')});try{const bCurrent=await discoverBaselineCalculationMaterials(bClient,baselineTarget(f,'b')),bFacts=await resolveBaselineCalculationFacts({target:baselineTarget(f,'b'),materialRefs:bCurrent.materialRefs,expectedReaderSha256:bCurrent.calculationReader.sha256},{...baselineOptions(f),readOnly:true}),wip=bFacts.objects.find(o=>o.values.business_kind==='repair'&&o.values.amount_net===60000);assertBaselineCalculationSchema(bCurrent.calculationSchema,bFacts);assert(wip,'原件中的未验收工单仍需完整取回');assert.equal(wip.values.delivery_date,undefined,'预计验收日不能冒充已发生验收日');const b=ok(await bClient.call('finance_calculation_run',{title:'程序乙企业安全对象结构及opaque桥维修与FIFO，不是模型推理验收',engine:'javascript',script:currentBScript,parameters:{period:'2026-07',target:baselineTarget(f,'b'),materialRefs:bCurrent.materialRefs,reader:bCurrent.calculationReader,calculationSchema:bCurrent.calculationSchema},sources:[]}));const actual=readBaselineJson(b.outputs.find(x=>x.path.endsWith('乙7月业务结果.json')).path);for(const [key,value]of Object.entries(EXPECTED.july.b))assert.equal(actual[key],value,key);report.current={a:result,b:actual,calculationRunRefs:{a:run.runId,b:b.runId},reader:result.reader,opaqueDiscovery:true,calculationFlow:'safe_object_schema_to_local_reader/1',rawInputSourceCount:0,unacceptedActualDeliveryDateProvided:false,origin:'test_authored_script_via_trusted_reader_not_model'};}finally{await bClient.close();}
    });
    await check('B05/B07/B11 只读进程读取材料并拒绝写入记忆目录',async()=>{
      const before=baselineLogicalSnapshot(f.dbPath);readOnlyClient=await startBaselineMcp(f,{readOnly:true});const readOnlyMaterials=await readColdBaselineMaterials(readOnlyClient,baselineTarget(f));assert.equal(readOnlyMaterials.coverage.taxHistory.vat.status,'included');
      rejected(await readOnlyClient.call('finance_memory_prepare',{target:baselineTarget(f)}),/finance_memory_readonly/);assert.equal(baselineLogicalSnapshot(f.dbPath),before);await readOnlyClient.close();readOnlyClient=undefined;
    });
    await check('B07/B11 激活恢复后的账套可取材，旧实例会话不可复用',async()=>{
      await client.close();client=undefined;const backup=createBackup({dbPath:f.dbPath,outDir:join(f.root,'official-backup')});assert.equal(backup.ok,true,JSON.stringify(backup));assert.equal(verifyBackup({backupDir:backup.backupDir}).ok,true);
      const ledger=join(f.root,'restore-ledger');mkdirSync(ledger);const args={backupDir:backup.backupDir,targetDir:join(f.root,'restored'),ledgerPath:join(ledger,'ledger.db'),operationId:randomUUID()},restored=restoreNew(args);assert.equal(restored.ok,true,JSON.stringify(restored));const restoredDb=join(args.targetDir,'workbench.db'),opts={...baselineOptions(f),dbPath:restoredDb};
      await assert.rejects(prepareBusinessMemory({target:baselineTarget(f)},opts),/restore_target_pending/);const active=await activateRestoreTarget({...args,outDir:join(f.root,'activation-protection'),plan:{version:1,targetInstanceId:restored.receipt.targetInstanceId,jobs:[]}});assert.equal(active.ok,true,JSON.stringify(active));
      await assert.rejects(readBaselineMaterials({target:baselineTarget(f)},{...opts,sessionPath:join(workspaceA,'.finance/business-session.json')}),/finance_memory_session_conflict/);
      const recovered=await readBaselineMaterials({target:baselineTarget(f)},opts);
      assert.equal(recovered.scopeVerified,true);assert.notEqual(restored.receipt.targetInstanceId,f.scopeA.databaseInstanceId);
      report.backup={backupDir:backup.backupDir,restoredDb,restoredInstance:restored.receipt.targetInstanceId,materialRef:recovered.materialRef};
    });
  }finally{
    await Promise.allSettled([client?.close(),readOnlyClient?.close(),scopedClient?.close()]);report.finishedAt=new Date().toISOString();report.status=report.checks.some(x=>x.status==='failed')?'failed':'passed';writeBaselineJson(join(f.root,'程序合同链结果.json'),report);console.log(JSON.stringify({status:report.status,root:f.root,report:join(f.root,'程序合同链结果.json'),checks:report.checks,modelInvoked:false},null,2));
  }
});

test('B05/B11 同企业无关同额分录与税额不能支持目标合同原则',{timeout:120000},async()=>{
  const f=createBaselineFixture(undefined,{collisionOnly:true}),client=await startBaselineMcp(f),report={version:'baseline-unrelated-history-e2e/1',root:f.root,modelInvoked:false,fixtureVariant:f.fixtureVariant,checks:[]};
  try{
    const materials=await readAllBaselineMaterials(client,baselineMaterialRequest(f,'a'));
    assert(!materials.principleSupport.some(p=>p.kind==='revenue_period'&&p.when==='lease'||p.kind==='expense_period'&&p.when==='maintenance'),'无关同额分录不能提供分期依据');
    const path=join(f.sourceRoot,'a','另一租赁发票合同.json'),lease={...readBaselineJson(f.files.a.lease),合同编号:'A-UNRELATED-LEASE-NO-POSTING'};writeBaselineJson(path,lease);
    const request=baselineMaterialRequest(f,'a'),other={...request,originals:request.originals.map(o=>o.id==='a_lease'?{...o,path}:o)},m2=await readAllBaselineMaterials(client,other);
    assert(!m2.principleSupport.some(p=>p.kind==='vat_output_period'&&p.when==='lease'),'另一个合同的同额税款不是目标租赁销项依据');
  }finally{await client.close();writeBaselineJson(join(f.root,'无关同额反例结果.json'),report);console.log(JSON.stringify(report));}
});

test('B05/B11 合并凭证仅预收行关联目标租赁，不得借另一维修收入推断归类或月等额收入',{timeout:120000},async()=>{
  const f=createBaselineFixture(undefined,{combinedVoucher:true}),client=await startBaselineMcp(f),report={version:'baseline-combined-entry-ownership-e2e/1',root:f.root,fixtureVariant:f.fixtureVariant,modelInvoked:false,status:'running'};
  try{
    const entries=dbRead(f.dbPath,db=>db.prepare('SELECT v.id voucherId,e.code,e.summary,e.debit,e.credit FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id WHERE v.id IN (?,?) ORDER BY v.id,e.line_no').all(...f.combined.voucherIds)),target=f.combined.targetBusinessReference;
    assert.equal(entries.filter(e=>e.summary===target&&(e.code.startsWith('6001')||e.code.startsWith('6051'))).reduce((n,e)=>n+e.credit-e.debit,0),0,'目标租赁真实收入为0');
    for(const id of f.combined.voucherIds){assert.equal(entries.filter(e=>e.voucherId===id&&e.summary==='COMBINED-UNRELATED-REPAIR'&&e.code==='600101').reduce((n,e)=>n+e.credit-e.debit,0),10000);assert.equal(entries.filter(e=>e.voucherId===id&&e.summary===target&&e.code==='2203').reduce((n,e)=>n+e.credit-e.debit,0),1);}
    const fields={business_reference:'合同编号',business_kind:'业务类别',service_pattern:'提供方式',service_start:'服务开始日',service_end:'服务结束日',amount_net:'净租金'},request={target:baselineTarget(f),originals:[{id:'target_lease',path:f.files.a.unearnedLease}],selections:Object.entries(fields).map(([field,key],i)=>({id:'f'+i,originalId:'target_lease',field,locator:{jsonPointer:'/'+key}})),limit:50},m=await readAllBaselineMaterials(client,request);
    const dangerous=m.pages.flatMap(page=>page.principleSupport).filter(p=>p.when==='lease'&&(p.kind==='revenue_period'||p.kind==='business_classification'&&['main_income','other_income'].includes(p.value)));
    assert.deepEqual(dangerous,[],'别的分录属于维修，不能为目标租赁收入背书');
    const genericPath=join(f.sourceRoot,'a','无分摊基准的泛费用政策记录.json');writeBaselineJson(genericPath,{enterpriseKey:f.scopeA.enterpriseKey,business_kind:'maintenance',expense_period:'benefit_period'});
    const generic=await readAllBaselineMaterials(client,{target:baselineTarget(f),originals:[{id:'policy',path:genericPath}],selections:[{id:'kind',field:'business_kind',originalId:'policy',locator:{jsonPointer:'/business_kind'}},{id:'expense',field:'expense_period',originalId:'policy',locator:{jsonPointer:'/expense_period'}}],limit:50}),genericSupport=generic.pages.flatMap(page=>page.principleSupport).find(p=>p.kind==='expense_period'&&p.value==='benefit_period'&&p.when==='maintenance');assert(genericSupport,'明确受益期政策本身可作为线索');assert.equal(genericSupport.allocationBasis,undefined,'泛受益期政策不能自动变成月等额');
    report.status='passed';report.actual={targetLeaseIncome:0,unrelatedRepairIncomePerVoucher:10000,targetPrepaymentPerVoucher:1};report.materialRefs=m.materialRefs;report.support=dangerous;
  }catch(error){report.status='failed';report.error=error.message;throw error;}finally{await client.close();writeBaselineJson(join(f.root,'合并凭证行归属反例结果.json'),report);console.log(JSON.stringify(report));}
});

test('B04/B11 仅有增值税累计导出，须独立保留累计口径或明确税负未核',{timeout:120000},async()=>{
  const f=createBaselineFixture(),vat=readBaselineJson(f.files.a.vat),expected=new Map([['2026-04',{sales:100000,tax:1800}],['2026-05',{sales:220000,tax:4200}],['2026-06',{sales:300000,tax:5960}]]);
  for(const row of vat.行){const totals=expected.get(row.所属期止);row.累计口径='累计';row.所属期起='2026-01';row.不含税应税销售额=totals.sales;row.应纳税额=totals.tax;}writeBaselineJson(f.files.a.vat,vat);
  const client=await startBaselineMcp(f),report={version:'baseline-vat-cumulative-only-e2e/1',root:f.root,modelInvoked:false,status:'running'};
  try{
    const full=baselineMaterialRequest(f),request={...full,originals:full.originals.filter(o=>o.id==='a_vat'),selections:full.selections.filter(s=>s.originalId==='a_vat')},m=await readAllBaselineMaterials(client,request),raw=await localMaterials(f,m),summaries=raw.taxBurden.summaries.filter(s=>s.taxType==='vat');
    if(summaries.length){
      for(const summary of summaries){const totals=expected.get(summary.through);assert(totals,'不能合成不存在的累计时点');assert.equal(summary.accumulation,'cumulative');assert.equal(summary.from,'2026-01');assert.equal(summary.taxAmount,totals.tax);assert.equal(summary.denominator,totals.sales);assert.equal(summary.weightedRatio,totals.tax/totals.sales);}
      assert(summaries.some(s=>s.through==='2026-06'),'不能悄悄省略最新累计时点');
    }else{
      assert(m.taxBurden.missing||m.taxBurden.gaps.length>0,'累计数据不能落成summaries空/gaps空/missing=false');
    }
    report.status='passed';report.materialTax=m.taxBurden;
  }catch(error){report.status='failed';report.error=error.message;throw error;}finally{await client.close();writeBaselineJson(join(f.root,'增值税仅累计口径结果.json'),report);console.log(JSON.stringify(report));}
});
