#!/usr/bin/env node
// 干净阳性现场：prepare不保存基线/方法、不运行计算或负例；真实Claude由验收者另外启动并审查轨迹。
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join,isAbsolute,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createContext,writeBundle} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../05-reconstruction/codex/hosts/claude-code/adapter.mjs';
import {prepareBoundBusinessSession,readBoundBusinessContext,renderBusinessContext,BUSINESS_MEMORY_ROUTING} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {listFinanceCalls,readFinanceCall} from '../server/finance-call-chain.mjs';
import {BASELINE_REPO_ROOT,BASELINE_WORKBENCH_ROOT,BASELINE_FIXTURE_VERSION,createBaselineFixture,assertColdBaselineFixture,baselineTarget,baselineLogicalSnapshot,hashBaseline,readBaselineJson,writeBaselineJson} from '../test/helpers/business-baseline-fixture.mjs';

const SOURCE_FILES=[
  '06-workbench/server/business-baseline.mjs','06-workbench/server/business-baseline-contracts.mjs','06-workbench/server/business-baseline-materials.mjs',
  '06-workbench/server/business-baseline-projection.mjs','06-workbench/server/material-identity.mjs',
  '06-workbench/server/business-memory-storage.mjs','06-workbench/server/business-memory.mjs','06-workbench/server/business-memory-bootstrap.mjs',
  '06-workbench/server/direct-finance.mjs','06-workbench/server/direct-finance-target.mjs','06-workbench/server/finance-calculation.mjs','06-workbench/server/finance-call-chain.mjs','06-workbench/server/business-evidence.mjs','06-workbench/server/offline-invoice-xlsx.mjs','06-workbench/server/server.mjs','06-workbench/server/local-backup.mjs',
  '05-reconstruction/codex/mcp/finance-mcp/server.mjs','05-reconstruction/codex/mcp/finance-mcp/direct-tools.mjs',
  '05-reconstruction/codex/hosts/shared/business-session.mjs','05-reconstruction/codex/hosts/shared/task-routing.mjs','05-reconstruction/codex/hosts/shared/config.mjs',
  '05-reconstruction/codex/hosts/claude-code/business-memory-hook.mjs','05-reconstruction/codex/hosts/claude-code/launcher.mjs','05-reconstruction/codex/hosts/claude-code/adapter.mjs',
  'plugins/finance/skills/company-baseline/SKILL.md','plugins/finance/skills/company-baseline/references/materials-and-save.md','plugins/finance/skills/company-baseline/references/material-adaptation.md','plugins/finance/skills/shared/references/business-memory.md','06-workbench/test/helpers/business-baseline-fixture.mjs',
  '06-workbench/test/helpers/business-baseline-test-inputs.mjs','06-workbench/test/helpers/business-baseline-calculation-contract.mjs','06-workbench/test/business-baseline-e2e.test.mjs','06-workbench/scripts/business-baseline-acceptance.mjs',
];
export const baselineSourceHashes=()=>Object.fromEntries(SOURCE_FILES.map(path=>[path,hashBaseline(readFileSync(join(BASELINE_REPO_ROOT,path)))]));
const gitHead=()=>{const r=spawnSync('git',['rev-parse','HEAD'],{cwd:BASELINE_REPO_ROOT,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const unicodeLength=text=>Array.from(text).length;
const outputKeys=['oldLeaseRevenue','newLeaseRevenue','totalLeaseRevenue','newLeaseVatSales','oldLeaseAdditionalVatSales','maintenanceExpense','maintenanceAdditionalInputVat'];
const bOutputKeys=['recognizedRepairRevenue','unacceptedRevenue','partsIssueCost'];
const materialRoute='按 Skill 使用已授权的宿主文件或脚本能力读取原件，先把有原件定位的必要观察写入审计根的 agent-materials，再交财税工具。';
function selectedDefinition(databasePath,baselineRef,target){
  const db=new DatabaseSync(databasePath,{readOnly:true});try{const row=db.prepare('SELECT content_json FROM business_memory_versions WHERE version_id=? AND account_set_id=?').get(baselineRef,target.accountSetId);assert(row,'缺实际已选不可变基线版本');const definition=JSON.parse(row.content_json).definition;assert.equal(definition.interfaceVersion,'business-baseline/1');assert.equal(definition.scope.accountSetId,target.accountSetId);return definition;}finally{db.close();}
}
// 仅在本机产物验收时核独立业务口径；这些要求不参与模型任务文本或材料候选选择。
function assertSelectedPrinciples(definition,name,expected){
  const ps=definition.principles,has=(kind,value,when)=>ps.some(p=>p.kind===kind&&p.value===value&&(Array.isArray(when)?when.includes(p.when):p.when===when));
  assert(has('accounting_standard',name==='a'?'enterprise':'small_enterprise','account_set'));assert(has('inventory_cost',expected.inventoryMethods[name],['account_set','inventory']));
  if(name==='b'){assert(has('revenue_period','delivery_acceptance','repair'));assert(!ps.some(p=>p.when==='lease'));assert(!definition.taxBurden.summaries.some(t=>t.taxType==='cit'),'不能捏造未提供的乙所得税参考');return;}
  for(const [kind,value,when]of [['business_classification','main_income','repair'],['business_classification','other_income','lease'],['business_classification','actual_use_expense','repair'],['revenue_period','service_period','lease'],['cost_treatment','expense_current','repair'],['cost_treatment','capitalize_then_depreciate','fixed_asset'],['vat_output_period','advance_invoice_period','lease'],['vat_input_period','confirmation_period','maintenance'],['income_tax_period','contract_due','lease'],['tax_choice','vat_standard','lease']])assert(has(kind,value,when),'甲缺有据关键原则或条件：'+[kind,value,when].join('/'));
  assert(ps.some(p=>p.when==='maintenance'&&(p.kind==='expense_period'&&p.value==='benefit_period'||p.kind==='cost_treatment'&&p.value==='allocate_benefit_period')&&p.allocationBasis==='monthly_equal'),'维保须有按月等额受益分摊结论');assert.equal(ps.find(p=>p.kind==='revenue_period'&&p.when==='lease')?.allocationBasis,'monthly_equal');
  const vat=definition.taxBurden.summaries.find(t=>t.taxType==='vat'&&t.stage==='payable_after_relief'&&t.measure==='payable'&&t.periodBasis==='attribution'&&t.accumulation==='current'),cit=definition.taxBurden.summaries.find(t=>t.taxType==='cit'&&t.stage==='payable_after_relief'&&t.measure==='payable'&&t.periodBasis==='attribution'&&t.accumulation==='cumulative');assert(vat&&cit,'甲须分别保存实际可比VAT及累计CIT口径');assert.equal(vat.taxAmount,expected.vat.sumPayable);assert.equal(vat.denominator,expected.vat.sumSales);assert.equal(vat.weightedRatio,expected.vat.weightedRatio);assert.equal(vat.periodCount,expected.vat.periods.length);assert.equal(vat.minimumRatio,Math.min(...expected.vat.rates));assert.equal(vat.maximumRatio,Math.max(...expected.vat.rates));assert.equal(cit.taxAmount,expected.cit.cumulativePayableAfterReductions);assert.equal(cit.denominator,expected.cit.cumulativeRevenue);assert.equal(cit.weightedRatio,expected.cit.ratio);assert.equal(cit.through,expected.cit.through);
}

export async function prepareBaselineModelFixture(root){
  if(!isAbsolute(root)||existsSync(root))throw Error('baseline_model_fixture_requires_new_absolute_directory');
  const sourceHashes=baselineSourceHashes();mkdirSync(root);const f=createBaselineFixture(root),cold=assertColdBaselineFixture(f),workspaces={},targets={};
  for(const name of ['a','b']){
    const workspace=join(root,name==='a'?'claude-july-a':'claude-july-b');
    const context=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:f.dbPath,sourceRoot:f.sourceRoot,auditDir:f.auditDir,outputDir:workspace});writeBundle(context,buildConfig(context));
    const prepared=await prepareBoundBusinessSession(workspace,baselineTarget(f,name));
    assert.equal(prepared.context.status,'needs_generation','历史目录准备不能宣称已生成业务基线');
    assert.equal(prepared.context.shortText,'');targets[name]=baselineTarget(f,name);workspaces[name]=workspace;
  }
  const db=new DatabaseSync(f.dbPath,{readOnly:true});let initialDirectoryState;
  try{
    const versions=db.prepare('SELECT topic,authority,content_json FROM business_memory_versions').all();
    assert.equal(versions.filter(v=>v.topic==='business_baseline').length,0);assert.equal(versions.filter(v=>v.authority==='operator_decision').length,0);
    for(const version of versions){const execution=JSON.parse(version.content_json).definition?.execution;assert(!['script','calculation_record'].includes(execution?.kind));assert.equal(execution?.script,undefined);}
    initialDirectoryState={businessBaselineCount:0,operatorDecisionCount:0,prewrittenScriptCount:0,automaticallyObservedVersionCount:versions.length,origin:'normal_prepare_from_existing_database_not_preselected_method'};
  }finally{db.close();}
  const originalHashes=Object.fromEntries(f.originalPaths.map(path=>[path,hashBaseline(readFileSync(path))]));
  const manifest={version:'positive-business-baseline-cold-start/5',materialFlow:'host_observations_material_refs/1',calculationFlow:'safe_object_schema_to_local_reader/1',root,motherFixture:{version:f.version,constructorSha256:sourceHashes['06-workbench/test/helpers/business-baseline-fixture.mjs'],fixtureSha256:hashBaseline(readFileSync(join(root,'fixture.json')))},databasePath:f.dbPath,targets,workspaces,sourceRoot:f.sourceRoot,auditDir:f.auditDir,originalHashes,sourceHashes,readerSourceSha256:sourceHashes['06-workbench/server/business-baseline.mjs'],readerDependencyHashes:Object.fromEntries(Object.entries(sourceHashes).filter(([path])=>path.startsWith('06-workbench/server/business-baseline'))),gitHead:gitHead(),expectedPath:f.expectedPath,independentExpectationsSha256:hashBaseline(readFileSync(f.expectedPath)),coldBeforeTechnicalPrepare:cold,initialDirectoryState,negativeCasesRun:false,baselineSavedDuringPrepare:false,methodSelectedDuringPrepare:false,currentMonthExecuted:false,modelInvoked:false,humanApproval:false};
  writeBaselineJson(join(root,'positive-fixture.json'),manifest);
  // 任务文本不含独立预期、测试定位、已选方法、识别结论或计算脚本。
  writeFileSync(join(root,'模型任务-1生成甲基线.txt'),`本次只处理已绑定的合成甲企业账套 ${f.a}、2026-07，实际临时账库和工具连接已配置。首次接手，请按企业基线生成入口先调查已有账套、代表性历史分录，以及获准原件目录 ${join(f.sourceRoot,'a')} 下的合同、发票、成本底稿和历史申报导出，核实并提炼少量可执行做账原则，实际保存并回读短基线。${materialRoute}资料不足或冲突时如实保留，仅完成有依据的分支。先交付短原则、历史税负的来源口径、保存/回读引用和重要待核事项；本任务完成后停止，当前期业务另给下一任务。不得读取reviewer-only、独立预期、测试源码、验收脚本或其他验收日志，不预填企业方案、不自行批准候选、不提交正式凭证。仅本机合成资料；整理件中的原值留在本机，口径保存无需正式凭证授权。\n`);
  writeFileSync(join(root,'模型任务-2重启后处理甲7月.txt'),`本次继续已绑定的合成甲企业账套 ${f.a}、2026-07。请先读取企业短基线，再按需查阅获准原件目录 ${join(f.sourceRoot,'a')} 内当前及历史合同、维保资料和原账，实际处理本期房屋仓库经营出租及年度维保，分别计算会计确认、增值税销售额与进项所属期，并核已处理历史是否重复。${materialRoute}生成独立可核计算底稿，不提交正式凭证。请通过现有计算工具留下名为“7月业务结果.json”的结构化结果，字段为 period、${outputKeys.join('、')}；字段金额应来自实际计算，另附reader、sourceDigests和notes说明实际取数版本、适用条件及未决事项。不得读取reviewer-only、独立预期、测试源码、验收脚本或其他验收日志；无需把每次业务处理追加为长期原则。\n`);
  writeFileSync(join(root,'模型任务-乙独立冷启动.txt'),`本次只处理已绑定的合成乙企业账套 ${f.b}、2026-07。首次接手，请实际按企业基线生成技能调查现库准则、代表性历史分录和获准原件目录 ${join(f.sourceRoot,'b')} 内成本底稿、维修合同验收及历史申报导出，保存并回读简短适用原则；资料缺失保持缺口。${materialRoute}再依据本期资料实际处理维修工单和配件领用，区分已验收与未验收，不沿用其他企业的业务口径。请通过现有计算工具生成“7月乙业务结果.json”，字段为period、${bOutputKeys.join('、')}、reader、sourceDigests和notes，分别记录本期确认收入、未验收工单本期计入损益的收入、本期配件领用成本、实际取数版本及适用条件；unacceptedRevenue指未验收工单本期计入损益的收入，不是未验收工单总额。交付实际计算、基线及产物引用，不提交正式凭证。不得读取reviewer-only、独立预期、测试源码、验收脚本或其他验收日志，不预填方案或自行批准候选。\n`);
  assert.deepEqual(baselineSourceHashes(),sourceHashes,'准备时源码发生变化，必须换全新阳性目录');
  return checkBaselineModelFixture(root);
}

export async function checkBaselineModelFixture(root){
  if(!isAbsolute(root))throw Error('baseline_model_fixture_absolute_directory_required');
  const manifest=readBaselineJson(join(root,'positive-fixture.json'));
  assert.equal(manifest.version,'positive-business-baseline-cold-start/5','旧模型失败现场不能作为本轮新接口阳性');assert.equal(manifest.materialFlow,'host_observations_material_refs/1');assert.equal(manifest.calculationFlow,'safe_object_schema_to_local_reader/1');assert.deepEqual(baselineSourceHashes(),manifest.sourceHashes,'源码变化后须生成全新阳性现场');
  assert.equal(manifest.motherFixture?.version,BASELINE_FIXTURE_VERSION);assert.equal(manifest.motherFixture?.constructorSha256,manifest.sourceHashes['06-workbench/test/helpers/business-baseline-fixture.mjs']);assert.equal(hashBaseline(readFileSync(join(root,'fixture.json'))),manifest.motherFixture?.fixtureSha256,'母夹具manifest须同版且保持原始内容');
  assert.equal(hashBaseline(readFileSync(manifest.expectedPath)),manifest.independentExpectationsSha256,'验收者独立预期不可在现场生成后改写');
  assert.deepEqual(manifest.readerDependencyHashes,Object.fromEntries(Object.entries(manifest.sourceHashes).filter(([path])=>path.startsWith('06-workbench/server/business-baseline'))),'必须记录取数/合并/投影完整实现版本');
  for(const [path,expected]of Object.entries(manifest.originalHashes))assert.equal(hashBaseline(readFileSync(path)),expected,'阳性原件不允许负例篡改或补写答案');
  const before=baselineLogicalSnapshot(manifest.databasePath),contexts={};
  for(const name of ['a','b']){
    const bound=await readBoundBusinessContext(manifest.workspaces[name]);assert.deepEqual(bound.target,manifest.targets[name]);
    const context=bound.context,text=renderBusinessContext(context);
    assert(unicodeLength(context.shortText)<=600);assert(context.unresolved.length<=3);assert(unicodeLength(text+'\n\n'+BUSINESS_MEMORY_ROUTING)<=1000);
    contexts[name]={status:context.status,revision:context.revision,baselineRef:context.baselineRef,shortText:context.shortText,shortTextUnicode:unicodeLength(context.shortText),initialEnterpriseContextUnicode:unicodeLength(text+'\n\n'+BUSINESS_MEMORY_ROUTING),unresolved:context.unresolved,coverage:context.coverage};
  }
  assert.equal(baselineLogicalSnapshot(manifest.databasePath),before,'check只读，不刷新索引或改账');
  return {status:'positive_fixture_checked',manifestVersion:manifest.version,materialFlow:manifest.materialFlow,calculationFlow:manifest.calculationFlow,root,targets:manifest.targets,workspaces:manifest.workspaces,sourceRoot:manifest.sourceRoot,contexts,readOnlyCheck:true,negativeCasesRun:false,baselineSavedDuringPrepare:false,methodSelectedDuringPrepare:false,modelInvokedByThisScript:false,humanApproval:false};
}

export async function assessBaselineModelFixture(root){
  const checked=await checkBaselineModelFixture(root),manifest=readBaselineJson(join(root,'positive-fixture.json')),expected=readBaselineJson(manifest.expectedPath),calls=await listFinanceCalls({auditDir:manifest.auditDir,limit:1000}),trace=[];
  assert.equal(calls.omitted,0,'实际记录分页未完整，不能声称验收完成');
  for(const item of calls.calls)trace.push(await readFinanceCall({auditDir:manifest.auditDir,callId:item.callId}));
  trace.sort((a,b)=>a.begin.startedAt.localeCompare(b.begin.startedAt));
  const own=call=>call.end?.scope?.accountSetId===manifest.targets.a.accountSetId&&call.end?.scope?.enterpriseKey;
  const business=trace.filter(own),toolNames=business.map(c=>c.tool),outputCandidates=[];
  assert.equal(checked.contexts.a.status,'ready','当前短基线仍未就绪');
  assert.equal(checked.contexts.a.coverage?.taxHistory?.vat?.status,'included');assert.equal(checked.contexts.a.coverage?.taxHistory?.cit?.status,'included');assertSelectedPrinciples(selectedDefinition(manifest.databasePath,checked.contexts.a.baselineRef,manifest.targets.a),'a',expected);
  for(const tool of ['finance_baseline_materials','finance_baseline_save','finance_baseline_read','finance_calculation_run'])assert(toolNames.includes(tool),'缺实际调用轨迹：'+tool);
  assert(trace.some(c=>c.tool==='skills_read'&&JSON.stringify(c.input).includes('company-baseline/SKILL.md')),'缺生成Skill实际读取记录');
  for(const call of business.filter(c=>c.tool==='finance_calculation_run'&&c.output?.status==='executed')){
    for(const output of call.output.outputs??[])if(typeof output.path==='string'&&basename(output.path)==='7月业务结果.json')outputCandidates.push({callId:call.callId,path:output.path,result:readBaselineJson(output.path)});
  }
  assert(outputCandidates.length,'缺实际计算工具生成的7月业务结果.json');
  const latest=outputCandidates.at(-1);assert.equal(latest.result.period,'2026-07');
  assert.equal(latest.result.reader?.sha256,manifest.readerSourceSha256,'实际取数桥源码版本须与阳性现场一致');assert(Array.isArray(latest.result.sourceDigests)&&latest.result.sourceDigests.length,'须留下实际原件版本摘要');
  const originalDigests=new Set(Object.values(manifest.originalHashes));for(const source of latest.result.sourceDigests)assert(originalDigests.has(source.sha256),'甲计算来源须来自本现场实际原件');
  for(const key of outputKeys)assert.equal(latest.result[key],expected.july.a[key],'独立手算不符：'+key);
  assert.match(checked.contexts.a.shortText,/1\.99%/,'VAT须显示5960/300000的加权参考');
  assert.match(checked.contexts.a.shortText,/0\.50%/,'所得税须保持减免后累计应纳/累计收入单列');
  const bCalls=trace.filter(call=>call.end?.scope?.accountSetId===manifest.targets.b.accountSetId&&call.end?.scope?.enterpriseKey),bCandidates=[];
  assert.equal(checked.contexts.b.status,'ready','乙须完成已核范围且当前来源有效，stale/needs_review不能冒充产物匹配');assert.equal(checked.contexts.b.coverage?.taxHistory?.vat?.status,'included');assert.equal(checked.contexts.b.coverage?.taxHistory?.cit?.status,'not_in_supplied_materials');assertSelectedPrinciples(selectedDefinition(manifest.databasePath,checked.contexts.b.baselineRef,manifest.targets.b),'b',expected);assert.match(checked.contexts.b.shortText,/小企业会计准则/);assert.match(checked.contexts.b.shortText,/先进先出/);assert(!checked.contexts.b.shortText.includes('月末一次加权平均'));assert(!checked.contexts.b.shortText.includes('所得税截至'));assert(!checked.contexts.b.shortText.includes('0.00%'));assert(!checked.contexts.b.shortText.includes('小型微利'));
  for(const tool of ['finance_baseline_materials','finance_baseline_save','finance_baseline_read','finance_calculation_run'])assert(bCalls.some(c=>c.tool===tool),'乙缺实际调用轨迹：'+tool);
  for(const call of bCalls.filter(c=>c.tool==='finance_calculation_run'&&c.output?.status==='executed'))for(const output of call.output.outputs??[])if(typeof output.path==='string'&&basename(output.path)==='7月乙业务结果.json')bCandidates.push({callId:call.callId,path:output.path,result:readBaselineJson(output.path)});
  assert(bCandidates.length,'缺实际计算工具生成的7月乙业务结果.json');const bLatest=bCandidates.at(-1);assert.equal(bLatest.result.period,'2026-07');assert.equal(bLatest.result.reader?.sha256,manifest.readerSourceSha256);assert(Array.isArray(bLatest.result.sourceDigests)&&bLatest.result.sourceDigests.length);for(const source of bLatest.result.sourceDigests)assert(originalDigests.has(source.sha256),'乙计算来源须来自本现场实际原件');
  const bExpected={recognizedRepairRevenue:expected.july.b.completedRepairRevenue,unacceptedRevenue:expected.july.b.unacceptedRepairRevenue,partsIssueCost:expected.july.b.inventoryIssueCost};for(const key of bOutputKeys)assert.equal(bLatest.result[key],bExpected[key],'乙独立手算不符：'+key);
  const bindingDir=join(manifest.workspaces.a,'.finance/claude-session-bindings'),bindingCount=existsSync(bindingDir)?readdirSync(bindingDir).filter(name=>name.endsWith('.json')).length:0;
  const calculationSchemaReads=[...business,...bCalls].filter(c=>c.tool==='finance_baseline_materials'&&c.output?.calculationSchema).map(c=>({callId:c.callId,accountSetId:c.end.scope.accountSetId,version:c.output.calculationSchema.version,objectCount:c.output.calculationSchema.objectCount,pagination:c.output.pagination}));
  const result={version:'business-baseline-positive-artifact-assessment/3',status:'business_artifacts_match_independent_expectations',root,gitHead:manifest.gitHead,sourceHashes:manifest.sourceHashes,motherFixture:manifest.motherFixture,materialFlow:manifest.materialFlow,calculationFlow:manifest.calculationFlow,readerDependencyHashes:manifest.readerDependencyHashes,calculationSchemaReads,baseline:checked.contexts.a,currentResult:latest,companyB:{baseline:checked.contexts.b,currentResult:bLatest},actualCalls:[...business,...bCalls].map(c=>({callId:c.callId,tool:c.tool,status:c.status,integrity:c.integrity,scope:c.end?.scope})),negativeCasesRun:false,modelInvokedByThisScript:false,claudeSessionIdentityCount:bindingCount,realClaudeLifecycleVerified:false,unverified:['本脚本核实际调用和金额，不证明调用者就是获准真实模型。','官方deepseek-flash/high、Claude版本、生成/重启/compact顺序和additionalContext须由验收者审查真实Claude轨迹。','字段绑定不等于财税政策或真人批准；未实际提交凭证、申报或缴款。']};
  writeBaselineJson(join(root,'reviewer-only','阳性产物核对结果.json'),result);return result;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,root,...rest]=process.argv.slice(2);if(rest.length||!root||!['prepare','check','assess'].includes(command))throw Error('用法：node scripts/business-baseline-acceptance.mjs prepare|check|assess <合成绝对目录>；prepare要求全新目录，不运行模型。');
  const action={prepare:prepareBaselineModelFixture,check:checkBaselineModelFixture,assess:assessBaselineModelFixture}[command];console.log(JSON.stringify(await action(root),null,2));
}
