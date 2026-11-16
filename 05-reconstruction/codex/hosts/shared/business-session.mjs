// 宿主绑定与企业记忆装配。生成配置、显式准备、只读检查分开；不猜首个账套。
import {existsSync,lstatSync,realpathSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {isAbsolute,resolve,dirname,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolveDirectFinanceTarget} from '../../../../06-workbench/server/direct-finance-target.mjs';

export const SESSION_VERSION='finance-business-session/1';
export const HOST_VERSION='finance-business-host/1';
export const BUSINESS_MEMORY_ROUTING='企业历史口径按摘要→业务方法→相关案例/依据逐层读取。已绑定会话先读 finance_company_context({target:{accountSetId,period}})，按当前任务选 finance_method_read，再按需 finance_case_search；不把全部历史或原件塞入初始上下文。候选历史不是操作者决定，执行只引用实际保存的 methodRef；变更先建议并由本机操作者审阅。企业口径只存本机账库，不写入 CLAUDE.md、AGENTS.md 或宿主原生 MEMORY.md。';
const REPO_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&resolve(a).toLowerCase()===resolve(b).toLowerCase();
export const sessionPath=workspace=>join(resolve(workspace),'.finance/business-session.json');
export function readHostJson(path){
 let st;try{st=lstatSync(path);}catch{fail('host_business_file_missing');}
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>1024*1024)fail('host_business_file_invalid');
 try{return JSON.parse(readFileSync(path,'utf8'));}catch{fail('host_business_json_invalid');}
}
export function loadBusinessHost(workspace){
 const config=readHostJson(join(resolve(workspace),'.finance/host.json'));
 if(config.version!==HOST_VERSION||!['pi','claude-code','dsh','zcode'].includes(config.host)||!samePath(config.repoRoot,REPO_ROOT)||!samePath(realpathSync(config.workspace),realpathSync(workspace))||config.mcpEnv?.FINANCE_MCP_PROFILE!=='direct')fail('host_business_config_invalid');
 for(const path of [config.nodePath,config.databasePath,config.auditDir])if(typeof path!=='string'||!isAbsolute(path)||/[\0\r\n]/.test(path))fail('host_business_config_invalid');
 if(!samePath(config.mcpEnv.FINANCE_DATABASE_PATH,config.databasePath)||!samePath(config.mcpEnv.FINANCE_AUDIT_DIR,config.auditDir)||!samePath(config.mcpEnv.FINANCE_BUSINESS_SESSION,sessionPath(workspace)))fail('host_business_config_invalid');
 return config;
}
const actualOptions=config=>({dbPath:config.databasePath,auditDir:config.auditDir,sessionPath:sessionPath(config.workspace),...(config.mcpEnv.FINANCE_SOURCE_ROOT?{sourceRoot:config.mcpEnv.FINANCE_SOURCE_ROOT}:{})});
export function assertSameScope(expected,actual){
 if(!expected||!actual||['enterpriseKey','databaseInstanceId','accountSetId','period','currency'].some(key=>expected[key]!==actual[key]))fail('host_business_scope_mismatch');
}
export function loadBoundBusinessSession(workspace){
 const config=loadBusinessHost(workspace),path=sessionPath(workspace);
 if(!existsSync(path))fail('host_business_binding_required');
 const session=readHostJson(path);
 if(session.version!==SESSION_VERSION||session.host!==config.host||!samePath(session.workspace,realpathSync(workspace))||!samePath(session.databasePath,config.databasePath)||!samePath(session.auditDir,config.auditDir)||(session.sourceRoot??null)!==(config.mcpEnv.FINANCE_SOURCE_ROOT??null))fail('host_business_binding_mismatch');
 const target={accountSetId:session.scope?.accountSetId,period:session.scope?.period};
 const binding=resolveDirectFinanceTarget(target,config.databasePath);assertSameScope(session.scope,binding.scope);
 return {config,session,path,target,options:actualOptions(config)};
}
export async function readBoundBusinessContext(workspace){
 const bound=loadBoundBusinessSession(workspace),{readCompanyContext}=await import('../../../../06-workbench/server/business-memory.mjs');
 const context=await readCompanyContext({target:bound.target},bound.options);
 return {...bound,context};
}
export async function prepareBoundBusinessSession(workspace,target){
 const config=loadBusinessHost(workspace),path=sessionPath(workspace);let bound;
 if(existsSync(path)){
  bound=loadBoundBusinessSession(workspace);
  if(target&&(target.accountSetId!==bound.target.accountSetId||target.period!==bound.target.period))fail('host_business_binding_immutable');
 }else{
  if(!target)fail('host_business_binding_required');
  const binding=resolveDirectFinanceTarget(target,config.databasePath);
  bound={config,path,target,options:actualOptions(config),session:{version:SESSION_VERSION,host:config.host,workspace:realpathSync(workspace),databasePath:binding.dbPath,scope:binding.scope,sourceRoot:config.mcpEnv.FINANCE_SOURCE_ROOT??null,auditDir:config.auditDir}};
 }
 const {prepareBusinessMemory}=await import('../../../../06-workbench/server/business-memory.mjs');
 const prepared=await prepareBusinessMemory({target:bound.target},bound.options);
 // 模型投影不披露企业原值；准备完成后重新核实际DB，而不是依赖摘要回传scope。
 assertSameScope(bound.session.scope,resolveDirectFinanceTarget(bound.target,config.databasePath).scope);
 if(!existsSync(path))writeFileSync(path,JSON.stringify(bound.session,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
 return {...await readBoundBusinessContext(workspace),prepared};
}
export function renderBusinessContext(context){
 return '本机企业记忆摘要（只读固定投影；历史不等于政策正确或本期完成）：\n'+JSON.stringify(context)+'\n\n'+BUSINESS_MEMORY_ROUTING+'\n摘要来自当前只读快照；正常已授权MCP写入及已绑定计算由后台同步历史。缓存stale只表示索引差异，不等于方法失效；按具体方法生效期、本期对象匹配和来源状态处理。prepare仅用于初始化或主动维护，无需Agent维护技术刷新状态。\n判断口径连续性，先比较留存方法、实际脚本/执行版本与取数定义，再区分各期输入版本变化。历史凭证和科目路径只证明入账金额/科目；algorithm_unknown不能推出全额确认或方法不同。缺旧期对应版本原件/计算证据时，不用已变更的本期原件回算旧期作差异结论，缺口标未核。已证实同版本可说明沿用；证据不足既不推断不同也不硬称相同。交付解释须与实际方法版本及证据状态一致。';
}
export function businessSessionFiles(context){
 const runtime=pathToFileURL(join(context.repoRoot,'05-reconstruction/codex/hosts/shared/business-session.mjs')).href;
 const config={version:HOST_VERSION,host:context.host,workspace:context.outputDir,repoRoot:context.repoRoot,nodePath:context.nodePath,databasePath:context.databasePath,auditDir:context.auditDir,mcpEnv:context.mcpEnv};
 return [
  {path:'.finance/host.json',content:JSON.stringify(config,null,2)+'\n'},
  {path:'start-business-session.mjs',content:`#!/usr/bin/env node\nimport {runBusinessSession} from ${JSON.stringify(runtime)};\nawait runBusinessSession(new URL('.',import.meta.url),process.argv.slice(2));\n`},
  {path:'business-memory-context.mjs',content:`#!/usr/bin/env node\nimport {runBusinessContext} from ${JSON.stringify(runtime)};\nawait runBusinessContext(new URL('.',import.meta.url),process.argv.slice(2));\n`},
 ];
}
export function parseBusinessArgs(args){
 const out={hostArgs:[]};let rest=false;
 for(let i=0;i<args.length;i++){
  const name=args[i];if(rest){out.hostArgs.push(name);continue;}if(name==='--'){rest=true;continue;}
  if(['--help','--check','--prepare-only'].includes(name)){if(out[name])fail('host_business_arguments_invalid');out[name]=true;}
  else if(['--account-set-id','--period'].includes(name)){if(out[name]!==undefined||!args[i+1]||args[i+1].startsWith('--'))fail('host_business_arguments_invalid');out[name]=args[++i];}
  else fail('host_business_arguments_invalid');
 }
 if(out['--help'])return out;
 if(Boolean(out['--account-set-id'])!==Boolean(out['--period']))fail('host_business_explicit_target_required');
 if(out['--account-set-id']!==undefined){const id=Number(out['--account-set-id']);if(!/^[1-9]\d*$/.test(out['--account-set-id'])||!Number.isSafeInteger(id)||!/^202[67]-(0[1-9]|1[0-2])$/.test(out['--period']))fail('host_business_target_invalid');out.target={accountSetId:id,period:out['--period']};}
 if((out['--check']&&out['--prepare-only'])||((out['--check']||out['--prepare-only'])&&out.hostArgs.length))fail('host_business_check_cannot_launch');
 if(out.hostArgs.includes('--check'))fail('host_business_use_top_level_check');
 return out;
}
export async function runBusinessSession(workspaceUrl,args){
 const options=parseBusinessArgs(args),workspace=fileURLToPath(workspaceUrl);
 if(options['--help']){console.log('node start-business-session.mjs [--account-set-id <实际账套ID> --period YYYY-MM] [--prepare-only | --check | -- <宿主启动参数>]\n--prepare-only 显式绑定并更新索引，不启动模型；--check 仅只读检查已有绑定；正常启动自动prepare。一个工作区固定一家账套及本期，换企业/期间生成新工作区。');return;}
 if(options['--check']){
  const bound=await readBoundBusinessContext(workspace);
  if(options.target&&(options.target.accountSetId!==bound.target.accountSetId||options.target.period!==bound.target.period))fail('host_business_binding_mismatch');
  console.log(JSON.stringify({status:'checked',scope:bound.session.scope,context:bound.context,modelInvoked:false,readOnly:true},null,2));return;
 }
 const hostName=loadBusinessHost(workspace).host;
 if(!options['--prepare-only']&&hostName==='claude-code'){
  const {parseClaudeArgs,buildClaudeLaunchSpec}=await import('../claude-code/launcher.mjs'),nativeOptions=parseClaudeArgs(options.hostArgs);
  if(nativeOptions['--check'])fail('host_business_use_top_level_check');
  if(nativeOptions['--resume'])buildClaudeLaunchSpec(workspace,nativeOptions);
 }
 const bound=await prepareBoundBusinessSession(workspace,options.target);
 if(options['--prepare-only']){console.log(JSON.stringify({status:'prepared',scope:bound.session.scope,prepared:bound.prepared,context:bound.context,modelInvoked:false,readOnly:false},null,2));return;}
 const host=bound.config.host;
 if(host==='pi'){const {runPi}=await import('../pi/launcher.mjs');await runPi(pathToFileURL(join(workspace,'pi-host.json')),options.hostArgs,bound);}
 else if(host==='dsh'){const {runDsh}=await import('../dsh/launcher.mjs');await runDsh(bound.config.nodePath,workspaceUrl,options.hostArgs,bound);}
 else if(host==='claude-code'){const {runClaude}=await import('../claude-code/launcher.mjs');await runClaude(workspaceUrl,options.hostArgs,bound);}
 else {const {runZcode}=await import('../zcode/launcher.mjs');await runZcode(workspaceUrl,options.hostArgs,bound);}
}
export async function runBusinessContext(workspaceUrl,args){
 const workspace=fileURLToPath(workspaceUrl);
 if(args.length===1&&args[0]==='--check'){
  const {session,context}=await readBoundBusinessContext(workspace);console.log(JSON.stringify({status:'checked',scope:session.scope,context,readOnly:true,modelInvoked:false},null,2));return;
 }
 if(args.length===1&&['--claude-hook','--claude-guard'].includes(args[0])){
  const {runClaudeHook}=await import('../claude-code/business-memory-hook.mjs');await runClaudeHook(workspace,args[0]);return;
 }
 fail('host_business_context_arguments_invalid');
}
