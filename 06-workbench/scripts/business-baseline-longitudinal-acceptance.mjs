#!/usr/bin/env node
// 纵向原生验收的资料/工作区管理；不启动模型、不代选原则、不生成业务算法或正式凭证。
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createContext,writeBundle} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../05-reconstruction/codex/hosts/claude-code/adapter.mjs';
import {prepareBoundBusinessSession,readBoundBusinessContext,renderBusinessContext,BUSINESS_MEMORY_ROUTING} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {readBusinessBaseline} from '../server/business-baseline.mjs';
import {baselineLogicalSnapshot,startBaselineMcp} from '../test/helpers/business-baseline-fixture.mjs';
import {readBaselineSection} from '../test/helpers/business-baseline-test-inputs.mjs';
import {LONGITUDINAL_VERSION,BASELINE_REPO_ROOT,createLongitudinalFixture,assertLongitudinalCold,publishLongitudinalPacket,hashBaseline,readBaselineJson,writeBaselineJson} from '../test/helpers/business-baseline-longitudinal-fixture.mjs';

const VERSION='native-business-baseline-longitudinal/1';
const RUNTIME_FILES=['06-workbench/test/helpers/business-baseline-longitudinal-fixture.mjs','06-workbench/scripts/business-baseline-longitudinal-acceptance.mjs'];
const unicode=text=>Array.from(text).length;
const inside=(root,path)=>{const r=relative(resolve(root),resolve(path));assert(r&&!isAbsolute(r)&&r!=='..'&&!r.startsWith('..\\')&&!r.startsWith('../'),'longitudinal_path_must_remain_in_synthetic_root');return resolve(path);};
const manifestOf=root=>readBaselineJson(join(root,'longitudinal-fixture.json'));
const stateOf=m=>readBaselineJson(m.statePath);
const fixtureOf=m=>readBaselineJson(m.fixturePath);
const options=m=>({dbPath:m.databasePath,sourceRoot:m.sourceRoot,auditDir:m.auditDir,sessionPath:''});
const baselineVersions=m=>{const db=new DatabaseSync(m.databasePath,{readOnly:true});try{return db.prepare("SELECT name FROM sqlite_master WHERE name='business_memory_versions'").get()?db.prepare("SELECT version_id,revision,content_json,content_digest FROM business_memory_versions WHERE account_set_id=? AND topic='business_baseline' ORDER BY revision").all(m.accountSetId).map(row=>({...row,content:JSON.parse(row.content_json)})):[];}finally{db.close();}};
const baselineSnapshot=versions=>versions.map(row=>({baselineRef:row.version_id,revision:row.revision,contentDigest:row.content_digest,contentSha256:hashBaseline(row.content_json),effectiveFrom:row.content.effectiveFrom,effectiveTo:row.content.effectiveTo??null}));
const assertBaselineSnapshot=(versions,snapshot,message)=>assert.deepEqual(baselineSnapshot(versions),snapshot,message);
function sourceHashes(files){return Object.fromEntries(files.map(path=>[path,hashBaseline(readFileSync(join(BASELINE_REPO_ROOT,path)))]));}
function assertIntegrity(m){
  assert.equal(m.version,VERSION);assert.equal(m.fixtureVersion,LONGITUDINAL_VERSION);assert.deepEqual(sourceHashes(Object.keys(m.sourceHashes)),m.sourceHashes,'运行源码变化，不可混用已有原生现场');
  for(const [path,sha]of Object.entries(m.frozenFiles))assert.equal(hashBaseline(readFileSync(path)),sha,'原始包/任务/预期/分母准备后不得更改：'+path);
  const state=stateOf(m);for(const record of Object.values(state.published))for(const file of record.files)assert.equal(hashBaseline(readFileSync(file.path)),file.sha256,'已发布原件不可修改或搬走');return state;
}
function taskTexts(f){
  const scope=`合成企业账套 ${f.a}`;
  const boundary='只处理本机合成资料，不正式记账、结账或申报。不得读取reviewer-only、driver、独立预期、测试源码或其他验收轨迹，不预填企业规则或脚本。';
  const recall=period=>`这是独立的新会话，接续${scope}、${period}。请仅从真实账库的企业短基线召回本期适用的已知原则，说明适用条件、版本、生效期间与重要缺口。先完成这一步并停止，不取原件、不重新调查历史，不做本期计算。${boundary}\n`;
  const work=period=>`继续本会话处理${scope}、${period}已发布的本期资料与仍在行合同。先沿用从账库召回的适用知识，再按需用正常业务工具核本期事实，不重翻7、8月历史去重新生成已知结论。核租赁、维保及库存本期金额、期间累计与剩余；区别已结束合同、已处理税额及未发生业务，不把缺匹配写成默认零。涉及需要企业选择而尚未确定的长期口径时，先明确询问并暂停，先交付可核部分，不自行作默认选择。请用工具留下“${period.slice(5)}月业务结果.json”及可核底稿，结果包含period、baselineRef、accountingStandard、classifications、contracts、maintenance、inventory、taxReference、reader/sourceDigests或等效实际取数引用。contracts逐合同给serviceStart/serviceEnd、periodRevenue/cumulativeRevenue/remainingRevenue/periodVatSales；maintenance给periodExpense/cumulativeExpense/remainingPrepayment/periodInputVat；inventory给期初、购入、领用、结存的数量和金额；说明实际采用的科目归集及适用原则。字段值来自实际处理，不限定计算工具或脚本。${boundary}\n`;
  return {history:`首次接手${scope}，当前绑定2026-09。现仅有7、8月原账及已发布历史原件，请按现有企业基线入口调查代表性分录、合同和申报资料，提炼并实际保存从本期起适用的短原则，回读核实版本、范围与缺口。不要处理尚未发布的本期或未来业务，完成后停止。${boundary}\n`,septemberRecall:recall('2026-09'),septemberWork:work('2026-09'),septemberReply:readFileSync(f.replyPath,'utf8').trim()+'\n请将新增口径按明确的生效期间持久保存，保留其他已核知识，不污染已处理期间。继续完成9月能核的底稿，实际保存后回读并说明本期与未来适用版本；本次口径确认不等于正式凭证审批。\n'+boundary+'\n',octoberRecall:recall('2026-10'),octoberWork:work('2026-10')};
}

export async function prepareLongitudinalFixture(root,sourceManifestPath,{technicalOnly=false}={}){
  assert(isAbsolute(root)&&!existsSync(root),'longitudinal_prepare_requires_new_absolute_directory');
  const frozen=readBaselineJson(sourceManifestPath);assert(frozen&&typeof frozen==='object'&&!Array.isArray(frozen),'冻结源清单格式错误');assert.match(frozen.aggregateSha256??'',/^[a-f0-9]{64}$/,'冻结源聚合摘要格式错误');assert(Array.isArray(frozen.files));assert.equal(frozen.files.length,50);
  for(const entry of frozen.files){assert(Array.isArray(entry)&&entry.length===2);const [path,sha]=entry;assert(typeof path==='string'&&path&&!isAbsolute(path)&&!path.includes('\\')&&path.split('/').every(part=>part&&part!=='.'&&part!=='..'),'冻结源路径必须是规范相对路径');inside(BASELINE_REPO_ROOT,join(BASELINE_REPO_ROOT,path));assert.match(sha,/^[a-f0-9]{64}$/,'冻结源文件摘要格式错误');}
  assert.equal(new Set(frozen.files.map(([path])=>path.toLowerCase())).size,50,'冻结源路径不能重复');assert.equal(hashBaseline(JSON.stringify(frozen.files)),frozen.aggregateSha256,'冻结源聚合摘要必须可从实际清单重算');const protectedHashes=Object.fromEntries(frozen.files);assert.deepEqual(sourceHashes(Object.keys(protectedHashes)),protectedHashes,'当前50文件与所提供冻结清单不一致，不可复用旧现场');
  const runtime=sourceHashes(RUNTIME_FILES),allSources={...protectedHashes,...runtime};mkdirSync(root);const f=createLongitudinalFixture(root),cold=assertLongitudinalCold(f),workspaces={},targets={};
  for(const [stage,period]of [['history','2026-09'],['september','2026-09'],['october','2026-10']]){const workspace=join(root,'workspace-'+stage),context=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:f.dbPath,sourceRoot:f.sourceRoot,auditDir:f.auditDir,outputDir:workspace});writeBundle(context,buildConfig(context));const target={accountSetId:f.a,period};const prepared=await prepareBoundBusinessSession(workspace,target);assert.equal(prepared.context.status,'needs_generation');workspaces[stage]=workspace;targets[stage]=target;}
  const taskDir=join(f.driver,'tasks');mkdirSync(taskDir);const taskPaths={};for(const [stage,text]of Object.entries(taskTexts(f))){const path=join(taskDir,stage+'.txt');writeFileSync(path,text);taskPaths[stage]=path;}
  const statePath=join(f.driver,'lifecycle.json'),historyFiles=f.originalPaths.map(path=>({path,sha256:hashBaseline(readFileSync(path))}));writeBaselineJson(statePath,{version:'longitudinal-lifecycle/1',purpose:technicalOnly?'technical_structure_only':'native_longitudinal_acceptance',published:{history:{at:new Date().toISOString(),files:historyFiles}},human:null,modelInvoked:false});
  const frozenPaths=[join(root,'fixture.json'),f.expectedPath,f.replyPath,...Object.values(f.packetPaths),...Object.values(taskPaths)];
  const manifest={version:VERSION,fixtureVersion:f.version,root,databasePath:f.dbPath,sourceRoot:f.sourceRoot,auditDir:f.auditDir,accountSetId:f.a,workspaces,targets,taskPaths,driverDirectory:f.driver,fixturePath:join(root,'fixture.json'),expectedPath:f.expectedPath,replyPath:f.replyPath,statePath,sourceHashes:allSources,sourceFreeze:{aggregateSha256:frozen.aggregateSha256,manifestPath:resolve(sourceManifestPath),protectedFileCount:50,runtimeFiles:RUNTIME_FILES},frozenFiles:Object.fromEntries(frozenPaths.map(path=>[path,hashBaseline(readFileSync(path))])),initialCold:cold,technicalOnly,modelEligible:!technicalOnly,modelInvokedByThisScript:false,humanApproval:false,bookkeepingMode:'calculation_workpapers_only_no_formal_posting',assessmentRuntime:'separate_read_only_assessor_not_part_of_initial_model_runtime'};
  assert.equal(baselineVersions(manifest).length,0);writeBaselineJson(join(root,'longitudinal-fixture.json'),manifest);return checkLongitudinalFixture(root);
}

export async function checkLongitudinalFixture(root){
  const m=manifestOf(root),state=assertIntegrity(m),before=baselineLogicalSnapshot(m.databasePath),contexts={};
  if(state.baselineSnapshots?.afterConfirmation)assertBaselineSnapshot(baselineVersions(m),state.baselineSnapshots.afterConfirmation.versions,'10月接续不得增加或改写基线');
  else if(state.baselineSnapshots?.initial&&!state.published.confirmation)assertBaselineSnapshot(baselineVersions(m),state.baselineSnapshots.initial.versions,'普通9月业务不得增加或改写已完成的基线');
  for(const stage of Object.keys(m.workspaces)){const bound=await readBoundBusinessContext(m.workspaces[stage]);assert.deepEqual(bound.target,m.targets[stage]);const context=bound.context;assert(unicode(context.shortText)<=600);assert(context.unresolved.length<=3);assert(unicode(renderBusinessContext(context)+'\n\n'+BUSINESS_MEMORY_ROUTING)<=1000);contexts[stage]={status:context.status,baselineRef:context.baselineRef,revision:context.revision,shortText:context.shortText,residentUnicode:unicode(renderBusinessContext(context)+'\n\n'+BUSINESS_MEMORY_ROUTING)};}
  assert.equal(baselineLogicalSnapshot(m.databasePath),before);for(const stage of ['september','confirmation','october'])assert.equal(existsSync(join(m.sourceRoot,stage)),!!state.published[stage],'阶段发布状态与实际授权目录必须一致');
  return {status:'longitudinal_fixture_checked',root,version:m.version,sourceFreeze:m.sourceFreeze,sourceFileCount:Object.keys(m.sourceHashes).length,workspaces:m.workspaces,taskPaths:m.taskPaths,targets:m.targets,sourceRoot:m.sourceRoot,published:Object.keys(state.published),contexts,technicalOnly:m.technicalOnly,modelInvokedByThisScript:false};
}

export async function publishSeptember(root){
  const m=manifestOf(root),state=assertIntegrity(m);assert(!state.published.september);if(!m.technicalOnly){const view=await readBusinessBaseline({target:m.targets.september},options(m));assert.equal(view.status,'ready','先完成历史生成再发布9月资料');const versions=baselineVersions(m);assert(versions.length>0);assert(versions.every(row=>row.content.effectiveFrom==='2026-09'&&!row.content.definition.principles.some(p=>p.kind==='inventory_cost')),'初始生成允许纠正，但须均为9月口径且未预选库存方法');assert(versions.some(row=>row.version_id===view.baselineRef));state.baselineSnapshots={initial:{at:new Date().toISOString(),selectedSeptemberRef:view.baselineRef,versions:baselineSnapshot(versions)}};}
  state.published.september={at:new Date().toISOString(),files:publishLongitudinalPacket(fixtureOf(m),'september')};writeBaselineJson(m.statePath,state);return checkLongitudinalFixture(root);
}

export async function publishConfirmation(root,questionRunDirectory){
  const m=manifestOf(root),state=assertIntegrity(m);assert(!m.technicalOnly,'技术自测不得伪造原生人工问询通过');assert(state.published.september&&!state.published.confirmation);const runDir=inside(root,questionRunDirectory),invocation=readBaselineJson(join(runDir,'invocation.json')),summary=readBaselineJson(join(runDir,'summary.json')),raw=readFileSync(join(runDir,'stream.jsonl'),'utf8');assert.equal(resolve(invocation.workspace),resolve(m.workspaces.september));assert.equal(summary.exitCode,0);assert(summary.sessionId);const events=raw.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)),final=readFileSync(join(runDir,'final.txt'),'utf8');
  assert(state.baselineSnapshots?.initial,'缺历史生成完成时的基线快照');assertBaselineSnapshot(baselineVersions(m),state.baselineSnapshots.initial.versions,'普通9月处理至问询暂停不得增加或改写基线');
  assert(events.some(e=>e.type==='result'),'必须先实际停止等待答复');assert(/存货|计价|发出成本/.test(final)&&/？|\?|请.{0,20}(?:确认|选择|告知)/.test(final),'必须有关于未确定口径的实际问询');assert(baselineVersions(m).every(v=>!v.content.definition.principles.some(p=>p.kind==='inventory_cost')),'人工答复前不得自行持久选择计价方法');
  const now=new Date().toISOString();assert(Date.parse(summary.endedAt)<=Date.parse(now));state.human={questionRunDirectory:runDir,questionStreamSha256:hashBaseline(raw),questionTextSha256:hashBaseline(final),questionEndedAt:summary.endedAt,septemberSessionId:summary.sessionId,confirmationPublishedAt:now,replyPromptPath:m.taskPaths.septemberReply,replyPromptSha256:m.frozenFiles[m.taskPaths.septemberReply],replyKind:'explicitly_marked_synthetic_human_reply',replyDeliveredByThisScript:false};state.published.confirmation={at:now,files:publishLongitudinalPacket(fixtureOf(m),'confirmation')};writeBaselineJson(m.statePath,state);return {status:'confirmation_published_after_actual_question',human:state.human,nextUserMessagePath:m.taskPaths.septemberReply,requiredResumeId:summary.sessionId,modelInvokedByThisScript:false};
}

export async function publishOctober(root){
  const m=manifestOf(root),state=assertIntegrity(m);assert(state.published.september&&!state.published.october);
  if(!m.technicalOnly){assert(state.human&&state.published.confirmation,'先实际问询并发布标记人工回复来源');const versions=baselineVersions(m),initial=state.baselineSnapshots?.initial;assert(initial,'缺初始阶段快照');const initialRefs=new Set(initial.versions.map(row=>row.baselineRef)),oldRows=versions.filter(row=>initialRefs.has(row.version_id)),added=versions.filter(row=>!initialRefs.has(row.version_id));assertBaselineSnapshot(oldRows,initial.versions,'人工更新不得改写初始基线字节');assert.equal(added.length,1,'人工回复后仅新增一个10月口径版');assert.equal(added[0].content.effectiveFrom,'2026-10');assert(added[0].content.definition.principles.some(p=>p.kind==='inventory_cost'&&p.value==='fifo'));const old=await readBusinessBaseline({target:m.targets.september},options(m)),current=await readBusinessBaseline({target:m.targets.october},options(m));assert.equal(old.baselineRef,initial.selectedSeptemberRef,'未来版不得污染9月');assert.equal(current.baselineRef,added[0].version_id);assert.equal(current.status,'ready');state.baselineSnapshots.afterConfirmation={at:new Date().toISOString(),selectedSeptemberRef:old.baselineRef,selectedOctoberRef:current.baselineRef,addedBaselineRef:added[0].version_id,versions:baselineSnapshot(versions)};}
  state.published.october={at:new Date().toISOString(),files:publishLongitudinalPacket(fixtureOf(m),'october')};writeBaselineJson(m.statePath,state);return checkLongitudinalFixture(root);
}

// 唯一技术准备链；不生成/保存基线、不伪造人工对话，不代表原生业务验收。
export async function selfCheckLongitudinal(root,sourceManifestPath){
  const report={version:'longitudinal-technical-preparation-check/1',root,startedAt:new Date().toISOString(),modelInvoked:false,baselineConstructedByTest:false,syntheticHumanQuestionFabricated:false,status:'running',checks:[]};let client;
  try{
    await prepareLongitudinalFixture(root,sourceManifestPath,{technicalOnly:true});report.checks.push('prepare');let m=manifestOf(root);const f=fixtureOf(m),before=baselineLogicalSnapshot(m.databasePath);client=await startBaselineMcp(f);
    const history=await readBaselineSection(client,{target:m.targets.history,extractKnownFields:true,section:'overview',limit:50});assert.equal(history.sourceDiscovery.remainingCount,0);assert(history.principleSupport.some(p=>p.kind==='revenue_period'&&p.when==='lease'&&p.allocationBasis==='monthly_equal'));assert(history.principleSupport.some(p=>p.kind==='expense_period'&&p.when==='maintenance'&&p.allocationBasis==='monthly_equal'));assert(!history.principleSupport.some(p=>p.kind==='inventory_cost'));assert.equal(history.taxBurden.summaries.find(s=>s.taxType==='vat').weightedRatio,0.02);report.checks.push('history_actual_materials_no_future_policy');
    await publishSeptember(root);const september=await readBaselineSection(client,{target:m.targets.september,section:'calculation',limit:50});assert.equal(september.sourceDiscovery.remainingCount,0);assert(september.calculationSchema.objects.some(o=>o.fields.issue_quantity==='quantity'));assert(!existsSync(join(m.sourceRoot,'october')));report.checks.push('september_publication_and_binding');
    await publishOctober(root);const october=await readBaselineSection(client,{target:m.targets.october,section:'calculation',limit:50});assert.equal(october.sourceDiscovery.remainingCount,0);assert.equal(baselineVersions(m).length,0);assert.equal(baselineLogicalSnapshot(m.databasePath),before);report.checks.push('october_publication_no_baseline_or_human_forgery');await checkLongitudinalFixture(root);report.status='passed';report.unverified=['真实问询/暂停/用户回复、实际保存及新会话召回由独立原生整链验，不由此技术检查替代。'];
  }catch(error){report.status='failed';report.error=error.stack;throw error;}finally{await client?.close();report.finishedAt=new Date().toISOString();if(existsSync(root))writeBaselineJson(join(root,'技术准备链结果.json'),report);console.log(JSON.stringify(report));}return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,root,arg]=process.argv.slice(2);assert(root&&isAbsolute(root),'用法: node scripts/business-baseline-longitudinal-acceptance.mjs prepare|check|publish-september|publish-confirmation|publish-october|self-check <全新或既有合成绝对目录> [冻结源manifest或实际问询run目录]');
  const action={prepare:()=>prepareLongitudinalFixture(root,arg),check:()=>checkLongitudinalFixture(root),'publish-september':()=>publishSeptember(root),'publish-confirmation':()=>publishConfirmation(root,arg),'publish-october':()=>publishOctober(root),'self-check':()=>selfCheckLongitudinal(root,arg)}[command];assert(action);console.log(JSON.stringify(await action(),null,2));
}
