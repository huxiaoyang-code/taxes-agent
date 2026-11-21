// 宿主使用已核实的账套定位本机记忆文件，文件内容由宿主原生读写。
import {existsSync,lstatSync,realpathSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {isAbsolute,resolve,dirname,basename,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolveDirectFinanceTarget} from '../../../../06-workbench/server/direct-finance-target.mjs';
import {assertRestoreOpenPath} from '../../../../06-workbench/server/local-restore-control.mjs';

export const SESSION_VERSION='finance-business-session/1';
export const HOST_VERSION='finance-business-host/1';
export const BUSINESS_MEMORY_ROUTING='确认账套和月份后，使用 .finance/business-session.json 的 memoryPath 所指的 MEMORY.md，沿用本期适用的口径。首次建立、补充或变更口径、用户要求精简时，按 company-baseline/SKILL.md 核对依据，按统一格式保存并读回。';
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
function memoryLocation({dbPath,scope}){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(scope.databaseInstanceId??''))fail('host_business_instance_invalid');
 const root=join(dirname(dbPath),'.finance-memory'),ledger=join(root,basename(dbPath));
 const instance=join(ledger,scope.databaseInstanceId);
 const memoryDirectory=join(instance,String(scope.accountSetId)),memoryPath=join(memoryDirectory,'MEMORY.md');
 // 沿实际账库的目录定位，拒绝把记忆目录或文件链接到其他账套。
 for(const path of [root,ledger,instance,memoryDirectory]){
  const st=lstatSync(path,{throwIfNoEntry:false});
  if(st&&(st.isSymbolicLink()||!st.isDirectory()))fail('host_business_memory_path_invalid');
 }
 const file=lstatSync(memoryPath,{throwIfNoEntry:false});
 if(file&&(file.isSymbolicLink()||!file.isFile()||file.nlink!==1))fail('host_business_memory_path_invalid');
 return {memoryDirectory,memoryPath};
}
export function assertSameScope(expected,actual){
 if(!expected||!actual||['enterpriseKey','databaseInstanceId','accountSetId','period','currency'].some(key=>expected[key]!==actual[key]))fail('host_business_scope_mismatch');
}
function accountAuditDirectory(binding){
 return join(dirname(binding.dbPath),'.finance-call-records',basename(binding.dbPath),binding.scope.databaseInstanceId,String(binding.scope.accountSetId));
}
export function loadBoundBusinessSession(workspace){
 const config=loadBusinessHost(workspace),path=sessionPath(workspace);
 if(!existsSync(path))fail('host_business_binding_required');
 const session=readHostJson(path);
 if(session.version!==SESSION_VERSION||session.host!==config.host||!samePath(session.workspace,realpathSync(workspace))||!samePath(session.databasePath,config.databasePath)||(session.sourceRoot??null)!==(config.mcpEnv.FINANCE_SOURCE_ROOT??null))fail('host_business_binding_mismatch');
 const target={accountSetId:session.scope?.accountSetId,period:session.scope?.period};
 assertRestoreOpenPath(config.databasePath);
 const binding=resolveDirectFinanceTarget(target,config.databasePath);assertSameScope(session.scope,binding.scope);
 const memory=memoryLocation(binding);
 const expectedAudit=session.auditMode==='bound_account'&&config.mcpEnv.FINANCE_AUDIT_MODE==='bound_account'?accountAuditDirectory(binding):config.auditDir;
 if(!samePath(session.auditDir,expectedAudit))fail('host_business_binding_mismatch');
 if(session.memoryPath!==undefined&&session.memoryPath!==memory.memoryPath)fail('host_business_memory_path_mismatch');
 return {config,session,path,target,...memory};
}
export async function prepareBoundBusinessSession(workspace,target){
 const path=sessionPath(workspace);
 if(existsSync(path)){
  const bound=loadBoundBusinessSession(workspace);
  if(target&&(target.accountSetId!==bound.target.accountSetId||target.period!==bound.target.period))fail('host_business_binding_immutable');
  mkdirSync(bound.memoryDirectory,{recursive:true,mode:0o700});
  return bound;
 }
 if(!target)fail('host_business_binding_required');
 const config=loadBusinessHost(workspace);
 assertRestoreOpenPath(config.databasePath);
 const binding=resolveDirectFinanceTarget(target,config.databasePath),memory=memoryLocation(binding);
 // 未绑定工作区已有调用或整理件时继续使用原址，避免交接引用在首次绑定时失效。
 const useAccountAudit=config.mcpEnv.FINANCE_AUDIT_MODE==='bound_account'&&!existsSync(config.auditDir);
 const session={version:SESSION_VERSION,host:config.host,workspace:realpathSync(workspace),databasePath:binding.dbPath,scope:binding.scope,
  sourceRoot:config.mcpEnv.FINANCE_SOURCE_ROOT??null,auditDir:useAccountAudit?accountAuditDirectory(binding):config.auditDir,
  ...(useAccountAudit?{auditMode:'bound_account'}:{}),memoryPath:memory.memoryPath};
 mkdirSync(memory.memoryDirectory,{recursive:true,mode:0o700});
 writeFileSync(path,JSON.stringify(session,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
 return {config,session,path,target,...memory};
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
 if(options['--help']){console.log('node start-business-session.mjs [--account-set-id <实际账套ID> --period YYYY-MM] [--prepare-only | --check | -- <宿主启动参数>]\n--prepare-only 绑定账套并准备本机记忆目录；--check 只读核对已有绑定，显示 MEMORY.md 路径。一个工作区固定一家账套及本期，换企业或月份时使用新工作区。');return;}
 if(options['--check']){
  const bound=loadBoundBusinessSession(workspace);
  if(options.target&&(options.target.accountSetId!==bound.target.accountSetId||options.target.period!==bound.target.period))fail('host_business_binding_mismatch');
  console.log(JSON.stringify({status:'checked',scope:bound.session.scope,auditDir:bound.session.auditDir,memoryPath:bound.memoryPath,modelInvoked:false,readOnly:true},null,2));return;
 }
 const hostName=loadBusinessHost(workspace).host;
 if(!options['--prepare-only']&&hostName==='claude-code'){
  const {parseClaudeArgs,buildClaudeLaunchSpec}=await import('../claude-code/launcher.mjs'),nativeOptions=parseClaudeArgs(options.hostArgs);
  if(nativeOptions['--check'])fail('host_business_use_top_level_check');
  if(nativeOptions['--resume'])buildClaudeLaunchSpec(workspace,nativeOptions);
 }
 const bound=await prepareBoundBusinessSession(workspace,options.target);
 if(options['--prepare-only']){console.log(JSON.stringify({status:'prepared',scope:bound.session.scope,auditDir:bound.session.auditDir,memoryPath:bound.memoryPath,modelInvoked:false,readOnly:false},null,2));return;}
 const host=bound.config.host;
 if(host==='pi'){const {runPi}=await import('../pi/launcher.mjs');await runPi(pathToFileURL(join(workspace,'pi-host.json')),options.hostArgs,bound);}
 else if(host==='dsh'){const {runDsh}=await import('../dsh/launcher.mjs');await runDsh(bound.config.nodePath,workspaceUrl,options.hostArgs,bound);}
 else if(host==='claude-code'){const {runClaude}=await import('../claude-code/launcher.mjs');await runClaude(workspaceUrl,options.hostArgs,bound);}
 else {const {runZcode}=await import('../zcode/launcher.mjs');await runZcode(workspaceUrl,options.hostArgs,bound);}
}
export async function runBusinessContext(workspaceUrl,args){
 const workspace=fileURLToPath(workspaceUrl);
 if(args.length===1&&args[0]==='--check'){
  const {session,memoryPath}=loadBoundBusinessSession(workspace);console.log(JSON.stringify({status:'checked',scope:session.scope,memoryPath,readOnly:true,modelInvoked:false},null,2));return;
 }
 if(args.length===1&&['--claude-hook','--claude-guard'].includes(args[0])){
  const {runClaudeHook}=await import('../claude-code/business-memory-hook.mjs');await runClaudeHook(workspace,args[0]);return;
 }
 fail('host_business_context_arguments_invalid');
}
