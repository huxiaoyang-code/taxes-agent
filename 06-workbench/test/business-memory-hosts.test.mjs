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
import {parseBusinessArgs,loadBoundBusinessSession,BUSINESS_MEMORY_ROUTING} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
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
 assert.equal(prepared.status,'prepared');assert.equal(prepared.modelInvoked,false);assert.equal(prepared.scope.accountSetId,companyA);assert.equal(prepared.scope.period,'2026-02');
 const {session}=loadBoundBusinessSession(context.outputDir);assert.equal(session.scope.enterpriseKey,'SYNTHETIC-HOST-A');assert.equal(session.databasePath,dbPath);assert.equal(session.sourceRoot,sources);assert.equal(session.auditDir,context.auditDir);assert(session.scope.databaseInstanceId);
 const afterPrepare=sha(dbPath),check=ok(run(context.outputDir,['--check']));assert.equal(check.readOnly,true);assert.equal(check.context.version,'finance-company-context/1');assert.equal(sha(dbPath),afterPrepare,'只读检查不刷新索引');
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
assert.match(startup.hookSpecificOutput.additionalContext,/finance-company-context\/1/);assert.match(startup.hookSpecificOutput.additionalContext,/摘要→业务方法→相关案例/);assert.equal(sha(dbPath),beforeHook);
const metadataDir=join(claude,'.finance/claude-session-bindings'),metadataCount=readdirSync(metadataDir).length;
for(const source of ['resume','compact']){
 const value=ok(run(claude,['--claude-hook'],'business-memory-context.mjs',JSON.stringify(hookInput(source))));assert.equal(value.hookSpecificOutput.additionalContext,startup.hookSpecificOutput.additionalContext);assert.equal(readdirSync(metadataDir).length,metadataCount);assert.equal(sha(dbPath),beforeHook);
}
const clearId=randomUUID();assert(ok(run(claude,['--claude-hook'],'business-memory-context.mjs',JSON.stringify(hookInput('clear',clearId)))).hookSpecificOutput.additionalContext);assert.equal(readdirSync(metadataDir).length,metadataCount+1);
assert(ok(run(claude,['--claude-hook'],'business-memory-context.mjs',JSON.stringify(hookInput('resume',clearId)))).hookSpecificOutput.additionalContext,'clear后新ID也能跨进程恢复');
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
console.log(JSON.stringify({status:'passed',root,workspaces,otherWorkspace:otherContext.outputDir,targets,modelInvoked:false,realClaudeLifecycleInvoked:false,checks:['four generated configurations do not prepare ledgers','explicit actual scope binding and cross-process restart','check and context reads never write DB','startup resume clear compact subprocess hook outputs','resume rejects foreign scope and unknown IDs','database replacement rejected','process and project auto memory disabled; no global memory touched','CLI overrides rejected; synthetic CLI only']},null,2));
