// 仅合成原件/临时账库；真实 MCP 调用与独立固定预期，不启动模型或外部服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {skillMetadata} from '../../05-reconstruction/codex/mcp/finance-mcp/skill-metadata.mjs';
import {withFinanceCall,annotateFinanceCall,currentFinanceCall} from '../server/finance-call-chain.mjs';
import {reviewFinancePeriod} from '../server/finance-period-review.mjs';
import {writePrebookFixture,prebookFacts} from './helpers/prebook-fixture.mjs';
const root=mkdtempSync(join(tmpdir(),'period-review-synthetic-')),audit=join(root,'audit'),dbPath=join(root,'synthetic.db');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE audit_database_instances(instance_id TEXT,is_active INTEGER);CREATE TABLE account_sets(id INTEGER);CREATE TABLE import_enterprise_account_sets(account_set_id INTEGER,enterprise_key TEXT)');
db.prepare('INSERT INTO audit_database_instances VALUES(?,1)').run('SYNTHETIC-INSTANCE');
for(const id of [1,2]){db.prepare('INSERT INTO account_sets VALUES(?)').run(id);db.prepare('INSERT INTO import_enterprise_account_sets VALUES(?,?)').run(id,`PRIVATE-SUBJECT-${id}`);}db.close();
const before=sha(readFileSync(dbPath));
process.env.FINANCE_DATABASE_PATH=dbPath;process.env.FINANCE_AUDIT_DIR=audit;
const target={accountSetId:1,period:'2026-03'},scope={enterpriseKey:'PRIVATE-SUBJECT-1',databaseInstanceId:'SYNTHETIC-INSTANCE',...target,currency:'CNY'};
const server=fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url));
const client=(profile,recordsDir=audit)=>new McpStdioClient(server,{cwd:root,env:{FINANCE_MCP_PROFILE:profile??'direct',FINANCE_SOURCE_ROOT:root,FINANCE_AUDIT_DIR:recordsDir,FINANCE_DATABASE_PATH:dbPath,FINANCE_API_BASE:'http://127.0.0.1:1'}}).start();
function noSecrets(value){const text=JSON.stringify(value);for(const privateText of [root,dbPath,'PRIVATE-SUBJECT','SUPPLIER-A','PRIVATE-OWNER-TEXT','PRIVATE-CODE-PAYLOAD','987654321.12','stack','recordPath','inputPath'])assert(!text.includes(privateText),privateText);}
async function stored({recordScope=scope,issue=true,observed=true,sourcePath,output,tool='finance_workpaper'}={}){
 let callId;await withFinanceCall({tool,args:{...(sourcePath?{sourcePath}:{}),privateText:'PRIVATE-OWNER-TEXT'},auditDir:audit},()=>{
  callId=currentFinanceCall().callId;annotateFinanceCall({scope:recordScope,...(observed?{configuredTarget:{bindingOrigin:'existing_database_identity',accountSetId:recordScope.accountSetId,period:recordScope.period,databasePath:dbPath}}:{})});
  return output??{version:'finance-business-result/1',resultOrigin:'native_engine',status:issue?'partial':'calculated_draft',ledgerAmounts:{profitBeforeTax:987654321.12,coverageVerified:false},review:{issueCount:issue?2:0,issues:issue?[{code:'agency_inventory_shortage',request:'PRIVATE-OWNER-TEXT'},{code:'PRIVATE-CODE-PAYLOAD'}]:[]},calculationResults:{taxes:[]}};
 });return callId;
}
test('frontmatter解析实际标量与折叠文本，坏/恶意元数据固定拒绝、不回显正文',()=>{
 assert.deepEqual(skillMetadata('x/SKILL.md','---\nname: x\ndescription: 中文入口\n---\n# 正文'),{resource:'x/SKILL.md',name:'x',description:'中文入口',metadataState:'valid'});
 assert.equal(skillMetadata('x/SKILL.md','---\nname: x\ndescription: >-\n  第一行\n  第二行\n---\n正文').description,'第一行 第二行');
 const direct = flag => skillMetadata('x/SKILL.md', `---\nname: x\ndescription: 中文入口\n${flag}\n---\n正文`, {includeRole:true});
 assert.equal(direct('').role, 'primary');
 assert.equal(direct('user-invocable: true').role, 'primary');
 assert.equal(direct('user-invocable: false').role, 'reference');
 const invalidFlag = direct('user-invocable: PRIVATE-OWNER-TEXT');
 assert.equal(invalidFlag.metadataState, 'invalid');
 assert.equal(Object.hasOwn(invalidFlag,'role'), false);
 noSecrets(invalidFlag);
 for(const fm of ['name: x\nname: evil\ndescription: PRIVATE-OWNER-TEXT','name: x\ndescription: !!js/function PRIVATE-OWNER-TEXT','name: x\ndescription: &evil PRIVATE-OWNER-TEXT','name: x\ndescription: [PRIVATE-OWNER-TEXT]','name: x\ndescription: "unterminated']){
  const result=skillMetadata('x/SKILL.md',`---\n${fm}\n---\n正文`);assert.equal(result.metadataState,'invalid');assert.equal(result.description,null);noSecrets(result);
 }
 assert.equal(skillMetadata('x/SKILL.md','# 无元数据').metadataState,'missing');
});
test('真实MCP发现frontmatter入口与只读合同，新进程接续summary/prebook/calculation/native固定投影',{timeout:60000},async()=>{
 const first=client();let summaryId,prebookId,calculationId,nativeId,nativeMissingTaxCount;
 try{
  await first.initialize();const list=(await first.rpc('tools/list')).result.tools,spec=list.find(t=>t.name==='finance_period_review');assert(spec);assert.equal(spec.annotations.readOnlyHint,false);assert.equal(spec.annotations.destructiveHint,false);
  const skills=(await first.call('skills_list')).data;assert(skills.entries.some(e=>e.name==='prebook-review'&&e.description.includes('做账前')&&e.resource==='prebook-review/SKILL.md'));assert(skills.files.includes('tax-review/SKILL.md'));assert(skills.labels['tax-review/SKILL.md']);assert(skills.entries.every(e=>e.metadataState==='valid'));assert(!JSON.stringify(skills).includes('harness/SKILL.md'));
  const inputs={outputVat:20000,certifiedInputVat:10000,inputVatTransferOut:100,openingCarryCredit:300,prepaidVat:200},source=join(root,'summary-original.json');writeFileSync(source,JSON.stringify({scope,inputs,privateText:'PRIVATE-OWNER-TEXT'}));
  const summary=await first.call('finance_tax_summary_calculate',{target,kind:'vat_general',inputs,originals:[{id:'source',path:source}],bindings:[{inputPointer:'',originalId:'source',locator:{jsonPointer:'/inputs'}}]});assert.equal(summary.isError,false,summary.text);assert.equal(summary.data.amounts.due,9600);summaryId=summary.data.evidence.callRef;
  const facts=prebookFacts();facts.coverage.sales='missing';const fixture=writePrebookFixture(root,facts,'period');const prebook=await first.call('finance_prebook_review',{inputPath:fixture.inputPath});assert.equal(prebook.isError,false,prebook.text);prebookId=prebook.data.evidence.callRef;assert.equal(prebook.data.status,'needs_inputs');assert.deepEqual(prebook.data.nextSteps[0].arguments,{recordType:'prebook'});
  const badPrebook=await first.call('finance_prebook_review',{inputPath:'PRIVATE-OWNER-TEXT'});assert.equal(badPrebook.isError,true);assert.equal(badPrebook.data.details.nextSteps[0].tool,'finance_record_contract');noSecrets(badPrebook);
  const calculation=await first.call('finance_calculation_run',{title:'合成自主计算',engine:'javascript',script:'console.log("PRIVATE-OWNER-TEXT");',sources:[],notes:['PRIVATE-OWNER-TEXT']});assert.equal(calculation.isError,false,calculation.text);assert.equal(calculation.data.status,'executed');calculationId=JSON.parse(readFileSync(calculation.data.recordPath)).callId;
  const entity={kind:'company',industry:'trade',profileId:'small-2011-basic-v1',businessStartDate:'2026-03-01',vatStatus:'general',vatPeriod:'monthly',vatReliefWaived:false,incomeLevyMethod:'actual_accounts',bookkeepingMethod:'double_entry'};
  const record=(id,type,date,fields)=>({id,type,date,enterpriseKey:scope.enterpriseKey,originalRefs:[{originalId:'source',locator:'合成资料',extractionReason:'合成原件'}],...fields});
  const records=[record('E','entity','2026-03-01',{entity}),record('OV','opening_vat','2026-03-01',{asOfPeriod:'2026-03',declarationVerified:true,amount:'0.00'}),record('C','period_coverage','2026-03-31',{period:'2026-03',complete:true,accountsCovered:true,unbilledSalesCovered:true,bankCovered:true})],original=join(root,'native-original.json');writeFileSync(original,JSON.stringify({records}));
  const native=await first.call('finance_workpaper',{scope,records,originals:[{id:'source',path:original}]});assert.equal(native.isError,false,native.text);nativeId=native.data.evidence.callRef;
  assert.equal(native.data.calculationResults.taxes.find(t=>t.obligationId==='vat').status,'calculated');assert(native.data.calculationResults.taxes.some(t=>t.status==='not_applicable'));nativeMissingTaxCount=native.data.calculationResults.taxes.filter(t=>t.status==='missing').length;
 }finally{await first.close();}
 const second=client();try{
  await second.initialize();const response=await second.call('finance_period_review',{target,callIds:[summaryId]});assert.equal(response.isError,false,response.text);const result=response.data;assert.equal(result.mode,'bound_period_review');assert.equal(result.periodComplete,false);assert.equal(result.executionStatus,'reviewed');assert.equal(result.records[0].kind,'tax_summary');assert.equal(result.records[0].businessStatus,'conditional');assert.equal(result.records[0].versions.code,'unchanged');assert.equal(result.records[0].versions.rules,'unchanged');assert.equal(result.records[0].versions.environment,'unknown');assert.equal(result.records[0].artifactIntegrity,'verified');assert.equal(result.records[0].sources.state,'unchanged');noSecrets(result);
  const unbound=await second.call('finance_period_review',{unboundCalls:{callIds:[prebookId,calculationId,nativeId]}});assert.equal(unbound.isError,false,unbound.text);assert.equal(unbound.data.mode,'unbound_call_review');assert.equal(unbound.data.scopeVerified,false);assert(!('coverage' in unbound.data));assert.deepEqual(unbound.data.records.map(r=>r.kind),['prebook','calculation','native_workpaper']);assert(unbound.data.records.every(r=>r.scopeVerified===false));assert.equal(unbound.data.records[1].businessStatus,'unreviewed');noSecrets(unbound.data);
  assert.equal(unbound.data.records[2].evidence.needsInputCount,nativeMissingTaxCount);assert.equal(unbound.data.records[2].evidence.unrecognizedTaxStatusCount,0);
  const page1=(await second.call('finance_period_review',{target,limit:1})).data,page2=(await second.call('finance_period_review',{target,offset:page1.pagination.nextOffset,limit:1})).data;
  assert.equal(page1.pagination.totalDirectories,page2.pagination.totalDirectories);assert.equal(page2.pagination.excludedSelfCalls,page1.pagination.excludedSelfCalls+1);assert.equal(page2.pagination.offset,1);assert.equal(page2.pagination.snapshotStableAcrossPages,false);assert(!page2.records.some(r=>r.tool==='finance_period_review'));
  for(const id of [prebookId,nativeId]){const rejected=await second.call('finance_period_review',{target,callIds:[id]});assert.equal(rejected.isError,true);assert.match(rejected.text,/finance_period_review_scope_unverified/);noSecrets(rejected);}
  for(const args of [{target,unboundCalls:{callIds:[summaryId]}},{unboundCalls:{callIds:[summaryId]},limit:1},{target,callIds:[summaryId],offset:1},{target,auditDir:'PRIVATE-OWNER-TEXT'},{target,dbPath:'PRIVATE-OWNER-TEXT'},{target,callIds:['../../PRIVATE-OWNER-TEXT']}]){const r=await second.call('finance_period_review',args);assert.equal(r.isError,true);noSecrets(r);}
 }finally{await second.close();}
 const legacy=client('harness');try{await legacy.initialize();const skills=(await legacy.call('skills_list')).data;assert(skills.entries.some(e=>e.resource==='harness/SKILL.md'&&e.name==='finance-tools'));assert(!skills.entries.some(e=>e.name==='prebook-review'));assert(skills.entries.every(e=>!Object.hasOwn(e,'role')));}finally{await legacy.close();}
 assert.equal(sha(readFileSync(dbPath)),before);
});
test('同企业仍核实例/账套/期间；历史缺件不被后成功覆盖；不识别未知形状',async()=>{
 const older=await stored(),later=await stored({issue:false});
 const result=await reviewFinancePeriod({target,callIds:[older,later]});assert.equal(result.coverage.unresolvedCount,2);assert.equal(result.records[0].evidence.issueCodes.find(i=>i.code==='unrecognized_issue').count,1);assert.equal(result.records[1].businessStatus,'draft');assert.equal(result.periodComplete,false);noSecrets(result);
 for(const other of [{enterpriseKey:'PRIVATE-SUBJECT-2'},{databaseInstanceId:'OTHER-INSTANCE'},{accountSetId:2},{period:'2026-04'}]){const id=await stored({recordScope:{...scope,...other}});await assert.rejects(reviewFinancePeriod({target,callIds:[id]}),{code:'finance_period_review_scope_conflict'});}
 const unverified=await stored({observed:false});await assert.rejects(reviewFinancePeriod({target,callIds:[unverified]}),{code:'finance_period_review_scope_unverified'});
 const unknown=await stored({output:{version:'some-future-version',status:'executed',raw:'PRIVATE-OWNER-TEXT'}});const unknownResult=await reviewFinancePeriod({target,callIds:[unknown]});assert.equal(unknownResult.records[0].kind,'unrecognized');assert.equal(unknownResult.records[0].businessStatus,'unrecognized');noSecrets(unknownResult);
 const annual=await stored({tool:'finance_annual_workpaper',output:{version:'finance-annual-result/1',status:'annual_calculation_draft',raw:'PRIVATE-OWNER-TEXT'}});assert.equal((await reviewFinancePeriod({unboundCalls:{callIds:[annual]}})).records[0].kind,'unrecognized');
});
test('原件变化/丢失、工件篡改/丢失、损坏与未结束记录明确可见',async()=>{
 const source=join(root,'mutable-source.json');writeFileSync(source,'{"private":"PRIVATE-OWNER-TEXT"}');const changed=await stored({sourcePath:source});writeFileSync(source,'{"changed":true}');
 let result=await reviewFinancePeriod({target,callIds:[changed]});assert.equal(result.records[0].sources.state,'changed');assert.equal(result.records[0].flags.stale,true);assert(result.records[0].nextSteps.some(s=>s.code==='recompute_after_source_or_version_change'));noSecrets(result);
 unlinkSync(source);result=await reviewFinancePeriod({target,callIds:[changed]});assert.equal(result.records[0].sources.missing,1);assert.equal(result.records[0].flags.unverified,true);
 const originallyMissing=join(root,'originally-missing.json'),unknownBaseline=await stored({sourcePath:originallyMissing});writeFileSync(originallyMissing,'{}');result=await reviewFinancePeriod({target,callIds:[unknownBaseline]});assert.equal(result.records[0].sources.state,'unverified');assert.equal(result.records[0].sources.unverifiedBaselines,1);
 const ids=readdirSync(audit).filter(id=>/^\d/.test(id)),summaryId=ids.find(id=>{try{return JSON.parse(readFileSync(join(audit,id,'begin.json'))).tool==='finance_tax_summary_calculate';}catch{return false;}});const artifact=join(audit,'artifacts',summaryId,'summary.json');
 writeFileSync(artifact,'{"private":"PRIVATE-OWNER-TEXT"}');result=await reviewFinancePeriod({target,callIds:[summaryId]});assert.equal(result.records[0].artifactIntegrity,'changed');assert.equal(result.records[0].flags.stale,true);unlinkSync(artifact);assert.equal((await reviewFinancePeriod({target,callIds:[summaryId]})).records[0].artifactIntegrity,'missing');
 const endPath=join(audit,summaryId,'end.json'),end=JSON.parse(readFileSync(endPath));end.codeDigest='f'.repeat(64);end.ruleVersion='PRIVATE-OWNER-TEXT';writeFileSync(endPath,JSON.stringify(end));result=await reviewFinancePeriod({target,callIds:[summaryId]});assert.equal(result.records[0].versions.code,'changed');assert.equal(result.records[0].versions.rules,'changed');noSecrets(result);
 const incomplete=await stored();unlinkSync(join(audit,incomplete,'end.json'));const broken=await stored();writeFileSync(join(audit,broken,'end.json'),'{PRIVATE-OWNER-TEXT');
 result=await reviewFinancePeriod({unboundCalls:{callIds:[incomplete,broken]}});assert.equal(result.records[0].businessStatus,'incomplete');assert.equal(result.records[0].flags.incomplete,true);assert.equal(result.records[1].diagnostic,'record_unreadable');assert.equal(result.pagination.excluded.unreadable,1);noSecrets(result);
 const tamper=await stored();writeFileSync(join(audit,tamper,'result.json'),'{"status":"executed","private":"PRIVATE-OWNER-TEXT"}');result=await reviewFinancePeriod({unboundCalls:{callIds:[tamper]}});assert.equal(result.records[0].recordIntegrity,'changed');assert.equal(result.records[0].flags.unverified,true);noSecrets(result);
 const failed=await stored({output:{status:'failed'},tool:'finance_calculation_run'});assert.equal((await reviewFinancePeriod({unboundCalls:{callIds:[failed]}})).records[0].flags.failed,true);
});
test('超过100条的扫描按固定页前进，排除与剩余数量可见，不把空页当无历史',async()=>{
 const separate=join(root,'pagination-audit'),previous=process.env.FINANCE_AUDIT_DIR;process.env.FINANCE_AUDIT_DIR=separate;
 try{
  mkdirSync(separate);for(let i=0;i<101;i++){const id=`20260101T000000000Z_00000000-0000-0000-0000-${String(i).padStart(12,'0')}`;mkdirSync(join(separate,id));writeFileSync(join(separate,id,'begin.json'),'bad');}
  // 后面的真实目标记录不能被“最近100条”窗口吞掉。
  let finalId;await withFinanceCall({tool:'finance_workpaper',args:{},auditDir:separate},()=>{finalId=currentFinanceCall().callId;annotateFinanceCall({scope,configuredTarget:{bindingOrigin:'existing_database_identity',accountSetId:1,period:'2026-03'}});return {status:'calculated_draft'};});
  const first=await reviewFinancePeriod({target,limit:50});assert.equal(first.pagination.totalDirectories,102);assert.equal(first.pagination.remainingDirectories,52);assert.equal(first.pagination.nextOffset,50);assert.equal(first.pagination.coverage,'partial_scan');assert.equal(first.coverage.matchedRecords,0);assert.equal(first.businessStatus,'requires_goal_review');
  const last=await reviewFinancePeriod({target,offset:100,limit:50});assert.equal(last.pagination.remainingDirectories,0);assert.equal(last.pagination.coverage,'partial_scan');assert.equal(last.coverage.matchedRecords,1);assert(last.records.some(r=>r.callId===finalId));noSecrets(last);
 }finally{process.env.FINANCE_AUDIT_DIR=previous;}
});
test('上期规划在万条目录中先查最新，游标越过首个窗口并排除翻页后的新调用',{timeout:90000},async t=>{
 const separate=join(root,'long-period-history'),previous=process.env.FINANCE_AUDIT_DIR;
 const args={target:{...target,period:'2026-04'},precedingPlanPeriod:target.period,limit:1};
 const plan=()=>withFinanceCall({tool:'finance_vat_plan',args:{},auditDir:separate},()=>{
  const callRef=currentFinanceCall().callId;
  annotateFinanceCall({scope,configuredTarget:{bindingOrigin:'existing_database_identity',accountSetId:1,period:target.period}});
  return {version:'finance-vat-planning/1',status:'conditional_calculated',callRef,basis:'a'.repeat(64),asOf:'2026-03-31',start:target.period,through:'2026-12',invoices:[],pagination:{total:0},posted:false,submittable:false};
 });
 process.env.FINANCE_AUDIT_DIR=separate;
 try{
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,3,1)});
  const oldest=(await plan()).callRef;
  for(let i=0;i<10001;i++)mkdirSync(join(separate,'20260402T000000000Z_00000000-0000-0000-0000-'+String(i).padStart(12,'0')));
  t.mock.timers.setTime(Date.UTC(2026,3,3));
  const newest=(await plan()).callRef;
  const first=await reviewFinancePeriod(args);
  assert.equal(first.pagination.totalCandidateDirectories,10003);
  assert.equal(first.pagination.examined,1);assert.equal(first.pagination.directoryOrder,'call_id_descending');
  assert.equal(first.records[0].callId,newest);assert.equal(first.records[0].kind,'vat_planning');
  t.mock.timers.setTime(Date.UTC(2026,3,4));const added=(await plan()).callRef;
  const next=await reviewFinancePeriod({...args,beforeCallId:first.pagination.nextBeforeCallId});
  assert.equal(next.records[0].callId,'20260402T000000000Z_00000000-0000-0000-0000-000000010000');
  // 既有 offset 可在窗口内定位；到单次检查上限后，继续使用回执游标。
  const end=await reviewFinancePeriod({...args,offset:9999});
  assert.equal(end.pagination.examined,10000);assert.equal(end.pagination.nextOffset,null);
  const rest=await reviewFinancePeriod({...args,beforeCallId:end.pagination.nextBeforeCallId,limit:10});
  assert.equal(rest.records.at(-1).callId,oldest);assert.equal(rest.records.at(-1).scopeVerified,true);
  assert.equal(rest.pagination.nextBeforeCallId,null);assert.equal(rest.pagination.remainingDirectories,0);
  t.mock.timers.setTime(Date.UTC(2026,3,5));
  for(let i=0;i<53;i++)await withFinanceCall({tool:'finance_period_review',args:{},auditDir:separate},()=>({status:'reviewed'}));
  const onlyReviews=await reviewFinancePeriod(args);
  assert.equal(onlyReviews.records.length,0);assert.equal(onlyReviews.pagination.examined,51);
  assert(onlyReviews.pagination.nextBeforeCallId);assert.equal(onlyReviews.pagination.nextOffset,null);
  const resumed=await reviewFinancePeriod({...args,beforeCallId:onlyReviews.pagination.nextBeforeCallId});
  assert.equal(resumed.records[0].callId,added);
  for(const invalid of [{target,beforeCallId:newest},{...args,beforeCallId:newest,offset:0},{...args,beforeCallId:newest,callIds:[oldest]},{...args,beforeCallId:'../invalid'}]){
   await assert.rejects(reviewFinancePeriod(invalid),/finance_period_review_input_invalid/);
  }
 }finally{t.mock.timers.reset();process.env.FINANCE_AUDIT_DIR=previous;}
});
test('历史调用改名不能隐藏损坏或未结束记录，真实MCP仅排除已验证自身调用',{timeout:30000},async()=>{
 const separate=join(root,'self-integrity-audit');let renamed,incomplete;
 await withFinanceCall({tool:'finance_workpaper',args:{},auditDir:separate},()=>{renamed=currentFinanceCall().callId;annotateFinanceCall({scope,configuredTarget:{bindingOrigin:'existing_database_identity',accountSetId:1,period:'2026-03'}});return {status:'partial'};});
 const beginPath=join(separate,renamed,'begin.json'),begin=JSON.parse(readFileSync(beginPath));begin.tool='finance_period_review';writeFileSync(beginPath,JSON.stringify(begin));
 await withFinanceCall({tool:'finance_period_review',args:{},auditDir:separate},()=>{incomplete=currentFinanceCall().callId;return {status:'reviewed'};});unlinkSync(join(separate,incomplete,'end.json'));
 const c=client(undefined,separate);try{
  await c.initialize();const explicit=await c.call('finance_period_review',{unboundCalls:{callIds:[renamed,incomplete]}});assert.equal(explicit.isError,false,explicit.text);assert.equal(explicit.data.records[0].recordIntegrity,'changed');assert.equal(explicit.data.records[1].businessStatus,'incomplete');
  const scan=await c.call('finance_period_review',{target,limit:50});assert.equal(scan.isError,false,scan.text);assert.equal(scan.data.pagination.totalDirectories,2);assert.equal(scan.data.pagination.excludedSelfCalls,2,'仅当前MCP调用和上一条完整真实复查被排除');assert.equal(scan.data.pagination.scanned,2);assert.equal(scan.data.pagination.excluded.integrityUnverified,2);assert.equal(scan.data.pagination.excluded.incomplete,1);assert.equal(scan.data.periodComplete,false);noSecrets(scan.data);
 }finally{await c.close();}
});
test('真实失败脚本已有产物且原件变化时先核原执行，unknown/incomplete也不引导重算',{timeout:30000},async()=>{
 const source=join(root,'failure-source.json');writeFileSync(source,'{"version":1}');const c=client();let failed;
 try{
  await c.initialize();const response=await c.call('finance_calculation_run',{title:'先产出后失败',engine:'javascript',sources:[{path:source}],script:'import fs from "node:fs"; const input=JSON.parse(fs.readFileSync(process.argv[2],"utf8")); fs.writeFileSync(input.outputDir+"/started.txt","started"); throw Error("PRIVATE-OWNER-TEXT");'});
  assert.equal(response.isError,true);assert.equal(response.data.status,'failed');assert.equal(readFileSync(response.data.outputs.find(o=>o.path.endsWith('started.txt')).path,'utf8'),'started');failed=JSON.parse(readFileSync(response.data.recordPath)).callId;
  const unknown=await stored({sourcePath:source,tool:'finance_calculation_run',output:{status:'unknown'}}),incomplete=await stored({sourcePath:source,tool:'finance_calculation_run',output:{status:'executed'}});unlinkSync(join(audit,incomplete,'end.json'));writeFileSync(source,'{"version":2}');
  const review=await c.call('finance_period_review',{unboundCalls:{callIds:[failed,unknown,incomplete]}});assert.equal(review.isError,false,review.text);assert.deepEqual(review.data.records.map(r=>r.businessStatus),['failed','unknown','incomplete']);
  for(const record of review.data.records){assert.equal(record.flags.stale,true);assert.equal(record.nextSteps[0].code,'inspect_original_execution_locally_before_retry');assert(record.nextSteps.every(s=>!s.code.includes('recompute')&&s.tool!=='finance_calculation_run'));}noSecrets(review.data);
 }finally{await c.close();}
});
test('嵌套null旧结果逐条保持未识别，正常同批继续；未知税状态不被断言为企业缺件',{timeout:30000},async()=>{
 const output={version:'finance-business-result/1',resultOrigin:'native_engine',status:'calculated_draft',review:{issueCount:0,issues:[]},calculationResults:{taxes:[null]}};
 const bad=await stored({output}),good=await stored({issue:false}),unknown=await stored({output:{...output,calculationResults:{taxes:[{status:'PRIVATE-CODE-PAYLOAD'}]}}});
 const c=client();try{
  await c.initialize();const review=await c.call('finance_period_review',{target,callIds:[bad,good,unknown]});assert.equal(review.isError,false,review.text);assert.equal(review.data.records.length,3);
  assert.equal(review.data.records[0].kind,'unrecognized');assert.equal(review.data.records[0].diagnostic,'result_shape_unrecognized');assert.equal(review.data.records[0].flags.unverified,true);assert.equal(review.data.records[1].kind,'native_workpaper');assert.equal(review.data.records[1].businessStatus,'draft');
  assert.equal(review.data.records[2].businessStatus,'unverified');assert.equal(review.data.records[2].flags.unverified,true);assert.equal(review.data.records[2].evidence.needsInputCount,0);assert.equal(review.data.records[2].evidence.unrecognizedTaxStatusCount,1);noSecrets(review.data);
 }finally{await c.close();}
});
