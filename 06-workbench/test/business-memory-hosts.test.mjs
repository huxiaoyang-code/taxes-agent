// 真实SQLite、生成器和独立Node hook进程；只用合成账套，不把此测试冒称真实Claude生命周期。
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,readFileSync,writeFileSync,readdirSync,copyFileSync,renameSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {createContext,writeBundle,repoRoot} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import {parseBusinessArgs,loadBoundBusinessSession,BUSINESS_MEMORY_ROUTING,renderBusinessContext} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {parseClaudeArgs,buildClaudeLaunchSpec} from '../../05-reconstruction/codex/hosts/claude-code/launcher.mjs';
const scratchArg=process.argv[2]==='--prepare'?process.argv[3]:undefined;
if(scratchArg&&(!isAbsolute(scratchArg)||existsSync(scratchArg)))throw Error('new_absolute_synthetic_root_required');
const root=scratchArg??mkdtempSync(join(tmpdir(),'business-memory-hosts-'));if(scratchArg)mkdirSync(root);
const data=join(root,'data'),sources=join(root,'sources');mkdirSync(sources);
process.env.WORKBENCH_DATA_DIR=data;process.env.FINANCE_SOURCE_ROOT=sources;process.env.FINANCE_AUDIT_DIR=join(root,'audit');delete process.env.FINANCE_BUSINESS_SESSION;
// 通过真实生产建账获得实例/企业绑定；不读取默认业务目录。
const A=await import('../server/accounting.mjs'),{db}=await import('../server/db.mjs');
const companyA=A.createAccountSet({enterprise:{enterpriseKey:'SYNTHETIC-HOST-A'},name:'合成甲公司',start_period:'2026-01'}).id;
const companyB=A.createAccountSet({enterprise:{enterpriseKey:'SYNTHETIC-HOST-B'},name:'合成乙公司',start_period:'2026-01'}).id;
const dbPath=join(data,'workbench.db');db.close();
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const run=(workspace,args,script='start-business-session.mjs',input)=>spawnSync(process.execPath,[join(workspace,script),...args],{cwd:workspace,input,encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,FINANCE_BUSINESS_SESSION:undefined,FINANCE_CLAUDE_LAUNCH_ID:undefined,NODE_NO_WARNINGS:'1'}});
const ok=result=>{assert.equal(result.status,0,result.stderr+'\n'+result.stdout);return JSON.parse(result.stdout);};
const targets={a:{accountSetId:companyA,period:'2026-02'},b:{accountSetId:companyB,period:'2026-03'}};
const workspaces={};
for(const host of ['pi','claude-code','dsh','zcode']){
 const context=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:dbPath,outputDir:join(root,host),sourceRoot:sources,auditDir:join(root,'audit-'+host)});
 const {buildConfig}=await import(`../../05-reconstruction/codex/hosts/${host}/adapter.mjs`);
 const before=sha(dbPath);writeBundle(context,buildConfig(context));assert.equal(sha(dbPath),before,'生成器不能初始化账库');
 workspaces[host]=context.outputDir;
 assert.equal(existsSync(join(context.outputDir,'.finance/business-session.json')),false);
 const unbound=run(context.outputDir,['--check']);assert.notEqual(unbound.status,0);assert.match(unbound.stderr,/host_business_binding_required/);assert.equal(sha(dbPath),before);
 const missing=run(context.outputDir,['--prepare-only']);assert.notEqual(missing.status,0);assert.match(missing.stderr,/host_business_binding_required/);assert.equal(sha(dbPath),before);
 const prepared=ok(run(context.outputDir,['--account-set-id',String(companyA),'--period','2026-02','--prepare-only']));
 assert.equal(prepared.status,'prepared');assert.equal(prepared.modelInvoked,false);assert.equal(prepared.scope.accountSetId,companyA);assert.equal(prepared.scope.period,'2026-02');assert.equal(prepared.baselineStatus,'needs_generation','目录prepared不能伪装业务基线ready');
 const {session}=loadBoundBusinessSession(context.outputDir);assert.equal(session.scope.enterpriseKey,'SYNTHETIC-HOST-A');assert.equal(session.databasePath,dbPath);assert.equal(session.sourceRoot,sources);assert.equal(session.auditDir,context.auditDir);assert(session.scope.databaseInstanceId);
 const afterPrepare=sha(dbPath),check=ok(run(context.outputDir,['--check']));assert.equal(check.readOnly,true);assert.equal(check.context.version,'finance-business-baseline/1');assert.equal(check.baselineStatus,'needs_generation');assert.equal(sha(dbPath),afterPrepare,'只读检查不刷新索引');
 const restart=ok(run(context.outputDir,['--prepare-only']));assert.deepEqual(restart.scope,prepared.scope,'新Node进程仍用同一实际账套');
 const wrong=run(context.outputDir,['--account-set-id',String(companyB),'--period','2026-02','--prepare-only']);assert.notEqual(wrong.status,0);assert.match(wrong.stderr,/host_business_binding_immutable/);
 const next=run(context.outputDir,['--account-set-id',String(companyA),'--period','2026-03','--prepare-only']);assert.notEqual(next.status,0);assert.match(next.stderr,/host_business_binding_immutable/);
 assert.equal(ok(run(context.outputDir,['--check'],'business-memory-context.mjs')).readOnly,true);
 const text=readFileSync(join(context.outputDir,host==='claude-code'?'CLAUDE.md':'AGENTS.md'),'utf8');assert(text.includes(BUSINESS_MEMORY_ROUTING));assert(!text.includes('SYNTHETIC-HOST-A'),'项目指引不复制企业口径');
}
const claude=workspaces['claude-code'],contextScript=join(claude,'business-memory-context.mjs');
const settings=JSON.parse(readFileSync(join(claude,'.claude/settings.json')));assert.equal(settings.autoMemoryEnabled,false);assert.equal(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,'1');
const command=settings.hooks.SessionStart[0].hooks[0];assert.equal(command.command,process.execPath);assert.deepEqual(command.args,[contextScript,'--claude-hook']);
assert.equal(settings.hooks.SessionStart[0].matcher,'startup|resume|clear|compact|fork');assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].onFailure,'block');
const id=randomUUID(),hookInput=(source,sessionId=id)=>({hook_event_name:'SessionStart',source,session_id:sessionId,cwd:claude,transcript_path:join(root,'NEVER-OPEN-TRANSCRIPT.jsonl')});
// hook忽略不存在transcript路径，不读取任何原生记忆。上下文读取不改DB；仅新ID写身份sidecar。
const beforeHook=sha(dbPath),startup=ok(run(claude,['--claude-hook'],'business-memory-context.mjs',JSON.stringify(hookInput('startup'))));
assert.match(startup.hookSpecificOutput.additionalContext,/企业短业务基线/);assert.match(startup.hookSpecificOutput.additionalContext,/待生成/);assert.match(startup.hookSpecificOutput.additionalContext,/company-baseline\/SKILL.md/);assert.equal(sha(dbPath),beforeHook);
assert(Array.from(startup.hookSpecificOutput.additionalContext+'\n\n'+BUSINESS_MEMORY_ROUTING).length<=1000);
const syntheticProjection={version:'finance-business-baseline/1',status:'ready',shortText:'仅合成：'+String.fromCodePoint(0x20000).repeat(595),unresolved:[{code:'tax_history_missing'}],methods:[{privateText:'DO-NOT-INJECT-METHOD-CATALOG'}],oldVersions:['DO-NOT-INJECT-OLD-VERSION']};
const bounded=renderBusinessContext(syntheticProjection);assert(Array.from(bounded+'\n\n'+BUSINESS_MEMORY_ROUTING).length<=1000);assert(!bounded.includes('DO-NOT-INJECT'));assert(!bounded.includes('methods'));assert(bounded.includes(syntheticProjection.shortText),'Unicode字符不能按UTF-16单位截断');
assert(bounded.includes('历史税费资料待补'),'重要待核要提供短业务含义，不能只注入数量');
assert(!renderBusinessContext({...syntheticProjection,unresolved:[{code:'PRIVATE-GAP-TEXT',kind:'constructor'}]}).includes('PRIVATE-'),'未决字段只能投影固定标签');
assert.throws(()=>renderBusinessContext({...syntheticProjection,shortText:syntheticProjection.shortText+'超过'}),/host_business_baseline_projection_invalid/);
assert.throws(()=>renderBusinessContext({...syntheticProjection,unresolved:Array.from({length:4},()=>({code:'tax_history_missing'}))}),/host_business_baseline_projection_invalid/);
assert.throws(()=>renderBusinessContext({...syntheticProjection,version:'finance-company-context/1'}),/host_business_baseline_projection_invalid/);
const metadataDir=join(claude,'.finance/claude-session-bindings'),metadataCount=readdirSync(metadataDir).length;
for(const source of ['resume','compact']){
 const value=ok(run(claude,['--claude-hook'],'business-memory-context.mjs',JSON.stringify(hookInput(source))));assert.equal(value.hookSpecificOutput.additionalContext,startup.hookSpecificOutput.additionalContext);assert.equal(readdirSync(metadataDir).length,metadataCount);assert.equal(sha(dbPath),beforeHook);
}
const clearId=randomUUID();assert(ok(run(claude,['--claude-hook'],'business-memory-context.mjs',JSON.stringify(hookInput('clear',clearId)))).hookSpecificOutput.additionalContext);assert.equal(readdirSync(metadataDir).length,metadataCount+1);
assert(ok(run(claude,['--claude-hook'],'business-memory-context.mjs',JSON.stringify(hookInput('resume',clearId)))).hookSpecificOutput.additionalContext,'clear后新ID也能跨进程恢复');
// 这里只验宿主持久读取，不把这个窄范围合成短版当成完整企业冷启动或财税批准。
const baselineOriginal=join(sources,'synthetic-host-policy.json');
writeFileSync(baselineOriginal,JSON.stringify({enterpriseKey:'SYNTHETIC-HOST-A',enterpriseClass:'商贸',costMethod:'先进先出法',taxHistory:[{taxType:'企业所得税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'累计',periodStart:'2026-01',periodEnd:'2026-01',taxAmount:'300.00',revenue:'30000.00'}]}));
writeFileSync(join(sources,'other-enterprise-policy.json'),JSON.stringify({enterpriseKey:'SYNTHETIC-HOST-B',costMethod:'个别计价法'}));
writeFileSync(join(sources,'unbound-policy.json'),JSON.stringify({costMethod:'个别计价法'}));
const {readBaselineMaterials,saveBusinessBaseline}=await import('../server/business-baseline.mjs'),baselineOptions={dbPath,sourceRoot:sources,auditDir:join(root,'baseline-records')};
const material=await readBaselineMaterials({target:targets.a,extractKnownFields:true},baselineOptions);
assert.equal(material.coverage.sourceCount,1);assert.deepEqual(material.coverage.sourceOwners,{checked:1,unverified:0});assert.deepEqual(material.gaps,[]);
assert(material.sourceDiscovery.bypassed.other_scope>=1);assert(material.sourceDiscovery.bypassed.owner_unverified>=1,'目录旁路主体未核不能污染所选快照');
assert.equal(material.sourceDiscovery.remainingCount,0);
let merged=await readBaselineMaterials({target:targets.a,materialRefs:[{materialRef:material.materialRef,snapshotDigest:material.snapshotDigest}],section:'overview',limit:1},baselineOptions);
const returnedSupports=new Map();let supportPages=0;
while(true){
 assert(Buffer.byteLength(JSON.stringify(merged,null,2),'utf8')<=12*1024,'默认overview应可直接进入模型上下文');
 for(const support of merged.principleSupport)returnedSupports.set(support.supportRef,support);
 if(merged.pagination.nextOffset===null)break;
 assert(++supportPages<=24,'正常候选续页必须前进且有界');assert.equal(merged.pagination.next.tool,'finance_baseline_materials');
 merged=await readBaselineMaterials(merged.pagination.next.arguments,baselineOptions);
}
const selected=[...returnedSupports.values()].filter(s=>['accounting_standard','enterprise_class','inventory_cost'].includes(s.kind));
assert.equal(selected.length,3);assert(selected.every(s=>/^bp:[a-f0-9]{64}$/.test(s.supportRef)));
const savedBaseline=await saveBusinessBaseline({target:targets.a,materialRefs:[{materialRef:merged.materialRef,snapshotDigest:merged.snapshotDigest}],expectedRevision:0,effectiveFrom:'2026-02',principles:selected.map(s=>({supportRef:s.supportRef}))},baselineOptions);
assert.equal(savedBaseline.status,'ready');assert.equal(savedBaseline.revision,1);assert(savedBaseline.shortText);
assert.equal(savedBaseline.coverage.taxHistory.cit.status,'included');assert.equal(savedBaseline.coverage.taxHistory.vat.status,'not_in_supplied_materials');
for(const field of ['applicable','exempt','due','taxAmount'])assert.equal(Object.hasOwn(savedBaseline.coverage.taxHistory.vat,field),false,'未纳入VAT不推断适用/免税/零税额');
assert(!savedBaseline.shortText.includes('增值税'),'CIT-only短文不能生成VAT参考或零值');
const afterBaseline=sha(dbPath);
// 已有短版直接读取同一范围的安全计算结构，不把目录页误认成业务字段。
let calculationView=await readBaselineMaterials({target:targets.a,section:'calculation'},baselineOptions),calculationPages=0;
const calculationObjects=[];
while(true){
 assert.equal(calculationView.section,'calculation');assert.equal(Object.hasOwn(calculationView,'sourceInventory'),false);
 assert.equal(calculationView.calculationSchema.factSelection,'resolver_default');
 for(const object of calculationView.calculationSchema.objects){
  assert.equal(typeof object.objectRef,'string');assert.equal(Object.hasOwn(object,'values'),false);
  assert.equal(object.unlistedFieldState,'not_available_in_bound_object');
  assert.equal(object.fieldPresence,'available');
  for(const type of Object.values(object.fields))assert.equal(Object.hasOwn(calculationView.calculationSchema.fieldTypes,type),true,'字段只映射到已披露语义类型，不返回原值');
  for(const field of ['tax_amount','revenue','period_start','period_end'])assert.equal(Object.hasOwn(object.semanticValues,field),false,'金额和月份原值不能进入结构投影');
  calculationObjects.push(object);
 }
 if(!calculationView.pagination.next)break;
 assert(++calculationPages<=32,'计算结构续页必须前进且有界');
 calculationView=await readBaselineMaterials(calculationView.pagination.next.arguments,baselineOptions);
}
assert.equal(calculationObjects.length,calculationView.calculationSchema.objectCount);
assert(calculationObjects.some(object=>object.fields.period_start==='period'),'当前对象须真实具有月份字段');
assert.equal(calculationView.calculationSchema.fieldTypes.period.format,'YYYY-MM','月份字段须保留真实期间粒度');
assert.equal(calculationView.calculationSchema.fieldTypes.period.granularity,'month');
assert.equal(sha(dbPath),afterBaseline,'本期结构读取不写账库');
for(const source of ['resume','compact']){
 const current=ok(run(claude,['--claude-hook'],'business-memory-context.mjs',JSON.stringify(hookInput(source)))).hookSpecificOutput.additionalContext;
 assert(current.includes(savedBaseline.shortText),'生命周期重新读取真实保存的新短版');assert.notEqual(current,startup.hookSpecificOutput.additionalContext);assert.equal(sha(dbPath),afterBaseline,'重读短版不写账库');assert.equal(readdirSync(metadataDir).length,metadataCount+1);
}
for(const host of ['pi','dsh','zcode']){
 const current=ok(run(workspaces[host],['--check'])).context;
 assert.equal(current.shortText,savedBaseline.shortText,host+'同实际账套读同一短服务');assert.equal(current.status,'ready');
 assert.equal(current.coverage.taxHistory.cit.status,'included');assert.equal(current.coverage.taxHistory.vat.status,'not_in_supplied_materials');
}
const unknown=randomUUID(),rejected=ok(run(claude,['--claude-hook'],'business-memory-context.mjs',JSON.stringify(hookInput('resume',unknown))));assert.equal(rejected.continue,false);assert.match(rejected.stopReason,/claude_business_resume_unbound/);
const guard=run(claude,['--claude-guard'],'business-memory-context.mjs',JSON.stringify({hook_event_name:'UserPromptSubmit',cwd:claude,session_id:unknown}));assert.equal(guard.status,2);assert.equal(JSON.parse(guard.stdout).continue,false);
assert.deepEqual(ok(run(claude,['--claude-guard'],'business-memory-context.mjs',JSON.stringify({hook_event_name:'UserPromptSubmit',cwd:claude,session_id:id}))),{});
const cli=join(root,'synthetic-claude.mjs');writeFileSync(cli,'console.log(JSON.stringify({argv:process.argv.slice(2),disableAutoMemory:process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,session:process.env.FINANCE_BUSINESS_SESSION,cwd:process.cwd()}));');
const spec=buildClaudeLaunchSpec(claude,parseClaudeArgs(['--claude-cli',cli,'--resume',id]));assert.equal(spec.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,'1');assert(spec.args.includes('--strict-mcp-config'));assert.equal(spec.args[spec.args.indexOf('--setting-sources')+1],'project');
const launch=ok(run(claude,['--claude-cli',cli,'--resume',id],'start-claude.mjs'));assert.equal(launch.disableAutoMemory,'1');assert.equal(launch.cwd,claude);assert.equal(launch.session,join(claude,'.finance/business-session.json'));
for(const override of ['--settings','--setting-sources','--mcp-config','--strict-mcp-config','--cwd','--resume','--continue','--session-id','--dangerously-skip-permissions','--plugin-dir'])assert.throws(()=>parseClaudeArgs(['--claude-cli',cli,'--',override,'elsewhere']),/claude_launch_override_rejected/);
assert.throws(()=>buildClaudeLaunchSpec(claude,parseClaudeArgs(['--claude-cli',cli,'--resume',unknown])),/claude_business_resume_unbound/);
// 用另一个真实企业工作区恢复旧ID；复制sidecar也不能改变它原始scope。
const otherContext=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:dbPath,outputDir:join(root,'claude-other'),sourceRoot:sources});
const {buildConfig}=await import('../../05-reconstruction/codex/hosts/claude-code/adapter.mjs');writeBundle(otherContext,buildConfig(otherContext));ok(run(otherContext.outputDir,['--account-set-id',String(companyB),'--period','2026-03','--prepare-only']));
const metadataFile=readdirSync(metadataDir)[0];mkdirSync(join(otherContext.outputDir,'.finance/claude-session-bindings'));writeFileSync(join(otherContext.outputDir,'.finance/claude-session-bindings',metadataFile),readFileSync(join(metadataDir,metadataFile)));
const prior=JSON.parse(readFileSync(join(metadataDir,metadataFile))),wrongResume=ok(run(otherContext.outputDir,['--claude-hook'],'business-memory-context.mjs',JSON.stringify({...hookInput('resume',prior.sessionId),cwd:otherContext.outputDir})));assert.equal(wrongResume.continue,false);assert.match(wrongResume.stopReason,/claude_business_resume_scope_mismatch/);
// 用生产建账生成另一有效实例，在所有连接关闭后换入同路径；不改主键或放宽审计外键。
const replacementDir=join(root,'replacement-instance'),replacementScript=`const A=await import(${JSON.stringify(new URL('../server/accounting.mjs',import.meta.url).href)});const {db}=await import(${JSON.stringify(new URL('../server/db.mjs',import.meta.url).href)});try{const made=A.createAccountSet({enterprise:{enterpriseKey:'SYNTHETIC-HOST-A'},name:'合成甲公司',start_period:'2026-01'});console.log(JSON.stringify({accountSetId:made.id,instance:db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get().instance_id}));}finally{db.close();}`;
const replacement=ok(spawnSync(process.execPath,['--input-type=module','-e',replacementScript],{encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,WORKBENCH_DATA_DIR:replacementDir,FINANCE_BUSINESS_SESSION:undefined,NODE_NO_WARNINGS:'1'}}));
assert.equal(replacement.accountSetId,companyA,'另一真实实例复用相同账套数字，身份必须仍不同');
const originalIdentity=new DatabaseSync(dbPath,{readOnly:true});let oldInstance;
try{oldInstance=originalIdentity.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get().instance_id;}finally{originalIdentity.close();}
assert.notEqual(replacement.instance,oldInstance);
const checkpoint=new DatabaseSync(dbPath);try{assert.equal(checkpoint.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy,0,'合成库换入前完成checkpoint且无活动写连接');}finally{checkpoint.close();}
const preservedDb=join(data,'original-instance-preserved.db'),suffixes=['','-wal','-shm'];
for(const suffix of suffixes)if(existsSync(dbPath+suffix))renameSync(dbPath+suffix,preservedDb+suffix);
try{
 copyFileSync(join(replacementDir,'workbench.db'),dbPath);
 const wrongDatabase=run(claude,['--check']);assert.notEqual(wrongDatabase.status,0);assert.match(wrongDatabase.stderr,/host_business_scope_mismatch/);
}finally{
 for(const suffix of suffixes)if(existsSync(dbPath+suffix))renameSync(dbPath+suffix,join(data,'replacement-instance-observed.db')+suffix);
 for(const suffix of suffixes)if(existsSync(preservedDb+suffix))renameSync(preservedDb+suffix,dbPath+suffix);
}
assert.equal(ok(run(claude,['--check'])).scope.databaseInstanceId,oldInstance,'还原后原工作区可继续读取同一实例');
for(const args of [['--period','2026-03'],['--account-set-id','1'],['--account-set-id','1','--period','2026-99'],['--check','--prepare-only'],['--check','--','--model','x']])assert.throws(()=>parseBusinessArgs(args));
console.log(JSON.stringify({status:'passed',root,workspaces,otherWorkspace:otherContext.outputDir,targets,modelInvoked:false,realClaudeLifecycleInvoked:false,checks:['four generated configurations do not prepare ledgers','explicit actual scope binding and cross-process restart','directory prepare does not create a business baseline','check and context reads never write DB','startup resume clear compact subprocess hook outputs','saved short baseline reloaded across lifecycle processes and four hosts','Unicode budget and fixed labels without method catalogs or old versions','resume rejects foreign scope and unknown IDs','database replacement rejected','process and project auto memory disabled; no global memory touched','CLI overrides rejected; synthetic CLI only']},null,2));
