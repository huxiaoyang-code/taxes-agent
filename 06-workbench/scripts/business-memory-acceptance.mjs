#!/usr/bin/env node
// 为根验收者生成独立阳性现场；不运行模型、不读取凭据或原生memory、不执行负例。
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createContext,writeBundle} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../05-reconstruction/codex/hosts/claude-code/adapter.mjs';
import {prepareBoundBusinessSession,loadBoundBusinessSession} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {readBusinessMethod,readCompanyContext} from '../server/business-memory.mjs';
import {createSyntheticFixture,completeHistoricalFixture,startMcp,selectSyntheticMethod,rentalDefinition,logicalSnapshot,readJson,hash,DAILY_RENT_SCRIPT,DUE_RENT_SCRIPT,REPO_ROOT} from '../test/helpers/business-memory-e2e-fixture.mjs';

const sourceFiles=['06-workbench/server/business-memory.mjs','06-workbench/server/business-memory-storage.mjs','06-workbench/server/business-memory-bootstrap.mjs','06-workbench/server/business-memory-contracts.mjs','06-workbench/server/local-backup.mjs','06-workbench/server/finance-calculation.mjs','06-workbench/server/direct-finance.mjs','06-workbench/server/finance-direct-method-result.mjs','05-reconstruction/codex/mcp/finance-mcp/server.mjs','05-reconstruction/codex/hosts/shared/business-session.mjs','05-reconstruction/codex/hosts/claude-code/business-memory-hook.mjs','05-reconstruction/codex/hosts/claude-code/launcher.mjs'];
const sourceHashes=()=>Object.fromEntries(sourceFiles.map(path=>[path,hash(readFileSync(join(REPO_ROOT,path)))]));
const ok=response=>{assert.equal(response.isError,false,response.text);return response.data;};
const save=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');

export async function prepareModelFixture(root){
 if(!isAbsolute(root)||existsSync(root))throw Error('model_fixture_requires_new_absolute_directory');
 const beforeCode=sourceHashes();mkdirSync(root);const f=createSyntheticFixture(root,{includeNegativeHistory:false});await completeHistoricalFixture(f,{includeNegativeHistory:false});const targets={a:{accountSetId:f.a,period:'2026-10'},b:{accountSetId:f.b,period:'2026-10'}},selected={};
 let client=await startMcp(f);
 try{
  for(const [name,id,history,kind] of [['a',f.a,f.historyA,'daily'],['b',f.b,f.historyB,'due']]){
   const target={accountSetId:id,period:'2026-10'};ok(await client.call('finance_memory_prepare',{target}));
   const historyCase=ok(await client.call('finance_case_search',{target,objectKey:history.runId})).cases[0],voucherId=name==='a'?f.voucherA:f.voucherB,posted=ok(await client.call('finance_case_search',{target,topic:'rental_income'})).cases.find(c=>c.voucher?.voucherId===voucherId);assert(historyCase&&posted);
   const candidate=ok(await client.call('finance_memory_propose',{target,topic:'rental_income',objectKey:name==='a'?'SYNTHETIC-DAILY-LEASE':'SYNTHETIC-DUE-LEASE',effectiveFrom:'2026-09',definition:rentalDefinition(history.runId,kind),evidenceRefs:[{caseRef:posted.caseRef},{caseRef:historyCase.caseRef}],expectedRevision:0}));
   const choice=await selectSyntheticMethod({target,methodRef:candidate.methodRef},{dbPath:f.dbPath,auditDir:f.auditA,sourceRoot:f.sourceA,sessionPath:''},{effectiveFrom:'2026-09'});selected[name]=choice.selected;writeFileSync(join(root,'合成TTY选择-'+name+'.txt'),choice.transcript);
  }
  await client.close();client=await startMcp(f,{sourceRoot:f.sourceB,auditDir:f.auditB});
  // 切换新月原件与记录根后只准备目录；本期脚本留给真实模型实际调用。
  for(const target of Object.values(targets))ok(await client.call('finance_memory_prepare',{target}));
 }finally{await client.close();}
 const workspaces={};
 for(const name of ['a','b']){
  const workspace=join(root,name==='a'?'claude-october':'claude-october-b'),context=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:f.dbPath,sourceRoot:f.sourceB,auditDir:f.auditB,outputDir:workspace});writeBundle(context,buildConfig(context));await prepareBoundBusinessSession(workspace,targets[name]);workspaces[name]=workspace;
 }
 const manifest={version:'positive-business-memory-model-fixture/1',root,databasePath:f.dbPath,targets,workspaces,methods:{a:selected.a.methodRef,b:selected.b.methodRef},currentSources:{a:f.currentA,b:f.currentB},sourceRoot:f.sourceB,auditDir:f.auditB,currentSourceHashes:{a:hash(readFileSync(f.currentA)),b:hash(readFileSync(f.currentB))},scriptHashes:{a:hash(DAILY_RENT_SCRIPT),b:hash(DUE_RENT_SCRIPT)},sourceHashes:beforeCode,history:{a:f.historyA.runId,b:f.historyB.runId},historyScopeOrigin:f.historyScopeOrigin,historySessions:f.historySessions,negativeCasesRun:false,currentMonthMethodExecuted:false,modelInvoked:false,humanApproval:false,selectionMeaning:'合成TTY夹具模拟了本机版本选择，不是真人财税批准。',expectedPath:join(root,'独立预期.json')};
 save(join(root,'model-fixture.json'),manifest);
 writeFileSync(join(root,'模型任务.txt'),`本次仅处理合成企业甲账套 ${f.a} 的2026-10租赁收入。当前工作区已绑定真实临时账库，本期获准原件根 ${f.sourceB}，原件 ${f.currentA}。本现场验证已给定方法的接续。请按需调用finance_company_context发现已选租金方法，再读取方法和相关历史案例；用已保存methodRef与本期原件实际计算，交付本期金额、取数/去重口径、实际调用和产物引用及未核实事项。禁止自行批准候选、沿用上期金额或提交正式凭证。此为纯合成测试，方法选择来自合成TTY模拟，不代表真人财税批准。不要读取验收答案/独立预期或其他验收日志。\n`);
 assert.deepEqual(sourceHashes(),beforeCode,'准备过程中实现源码变化，需要全新目录重跑');return checkModelFixture(root);
}

export async function checkModelFixture(root){
 if(!isAbsolute(root))throw Error('model_fixture_absolute_directory_required');
 const manifest=readJson(join(root,'model-fixture.json'));assert.equal(manifest.version,'positive-business-memory-model-fixture/1');assert.deepEqual(sourceHashes(),manifest.sourceHashes,'源码已变化，须生成新阳性现场');const before=logicalSnapshot(manifest.databasePath),contexts={},methods={},memoryPaths={};
 for(const name of ['a','b']){
  assert.equal(hash(readFileSync(manifest.currentSources[name])),manifest.currentSourceHashes[name],'当前原件字节应保持准备时版本');const bound=loadBoundBusinessSession(manifest.workspaces[name]);assert.deepEqual(bound.target,manifest.targets[name]);assert.equal(existsSync(bound.memoryPath),false,'准备现场时由原生宿主按需创建记忆');memoryPaths[name]=bound.memoryPath;const directory=await readCompanyContext({target:manifest.targets[name]},bound.options);assert.equal(directory.status,'ready');contexts[name]=directory;
  const method=await readBusinessMethod({target:manifest.targets[name],methodRef:manifest.methods[name]},bound.options);assert.equal(method.executable,true,JSON.stringify(method));assert.equal(method.status,'available');assert.equal(method.authority,'operator_decision');assert.equal(method.execution.scriptSha256,manifest.scriptHashes[name]);assert(!method.evidence.some(e=>['changed','missing'].includes(e.status)));methods[name]=method;
 }
 assert.equal(logicalSnapshot(manifest.databasePath),before,'检查不得刷新索引或写账');return {status:'prepared_positive_fixture',meaning:'验证已给定方法接续及实际账套绑定',root,targets:manifest.targets,workspaces:manifest.workspaces,methods:manifest.methods,currentSources:manifest.currentSources,memoryPaths,readOnlyCheck:true,contextsCurrent:true,methodsExecutable:true,evidenceAvailability:Object.fromEntries(Object.entries(methods).map(([name,value])=>[name,value.evidenceCurrentlyAvailable])),sourceHashes:manifest.sourceHashes,negativeCasesRun:false,currentMonthMethodExecuted:manifest.currentMonthMethodExecuted,modelInvoked:false,humanApproval:false};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,root,...rest]=process.argv.slice(2);if(rest.length||!root||!['prepare','--prepare','check','--check'].includes(command))throw Error('用法：node scripts/business-memory-acceptance.mjs prepare|check <全新合成绝对目录>');
 console.log(JSON.stringify(command.includes('prepare')?await prepareModelFixture(root):await checkModelFixture(root),null,2));
}
