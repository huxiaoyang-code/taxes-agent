import {existsSync,statSync,realpathSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {isAbsolute,resolve,relative,sep,join,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createContext,writeBundle} from '../../hosts/shared/config.mjs';
import {toolsForProfile} from '../../mcp/finance-mcp/tool-profile.mjs';
import {readSurfaceBundle} from '../surface.mjs';

export const HOST_VERSIONS=Object.freeze({'claude-code':'2.1.309',dsh:'0.2.1-rc.2',zcode:'0.16.9'});
export const EXPERIMENT_TOOLS=Object.freeze(['harness_discover','harness_scope_discover','harness_init','harness_source_register','harness_facts_register','harness_plan','harness_run','harness_status','harness_receipt_read','skills_list','skills_read']);
export const RESEARCH_TOOLS=Object.freeze(EXPERIMENT_TOOLS.filter(name=>name!=='harness_init'));
export function fail(code){throw Object.assign(new Error(code),{code});}
export function absolute(value,label){if(typeof value!=='string'||!isAbsolute(value)||/[\0\r\n]/.test(value))fail('harness2_'+label+'_absolute_required');return resolve(value);}
export function inside(root,path,label){
  root=realpathSync(root);path=absolute(path,label);const rel=relative(root,path);if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))fail('harness2_'+label+'_outside_workspace');
  let ancestor=path;while(!existsSync(ancestor))ancestor=dirname(ancestor);
  const r=relative(root,realpathSync(ancestor));if(r==='..'||r.startsWith('..'+sep)||isAbsolute(r))fail('harness2_'+label+'_outside_workspace');return path;
}
export function nativeCommand(nodePath,cliPath){
  nodePath=absolute(nodePath,'node');cliPath=absolute(cliPath,'cli');
  for(const p of [nodePath,cliPath])if(!existsSync(p)||!statSync(p).isFile())fail('harness2_native_cli_missing');
  // npm 的 PowerShell/CMD 包装器会执行 shell 文本；应选择实际的包入口。
  const extension=extname(cliPath).toLowerCase();
  if(['.cmd','.bat','.ps1'].includes(extension))fail('harness2_native_entry_required_no_shell_wrapper');
  if(['.mjs','.cjs','.js'].includes(extension))return {command:realpathSync(nodePath),prefix:[realpathSync(cliPath)]};
  if(process.platform==='win32'&&extension!=='.exe')fail('harness2_native_entry_invalid');
  return {command:realpathSync(cliPath),prefix:[]};
}
export function systemEnv(){const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATHEXT','LANG','LC_ALL','TZ'])if(process.env[key])env[key]=process.env[key];return env;}
export function modelEndpoint(value,protocol){
  if(value===undefined)return protocol==='messages'?'https://api.deepseek.com/anthropic':'https://api.deepseek.com/v1';
  let u;try{u=new URL(value);}catch{fail('harness2_model_endpoint_invalid');}
  const official=u.protocol==='https:'&&u.hostname==='api.deepseek.com'&&u.pathname===(protocol==='messages'?'/anthropic':'/v1');
  const loopback=u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&u.port;
  if((!official&&!loopback)||u.username||u.password||u.search||u.hash)fail('harness2_model_endpoint_invalid');
  return u.href.replace(/\/$/,'');
}
export function requireGateway(endpoint,protocol){if(!endpoint.startsWith('http://'))fail('harness2_bounded_loopback_model_gateway_required');return protocol?new URL(endpoint).origin+(protocol==='messages'?'/anthropic':'/v1'):endpoint;}
export function prepare(options,host,buildConfig){
  if(!['check','run'].includes(options.mode))fail('harness2_host_mode_invalid');
  const workspace=absolute(options.workspace,'workspace');if(!existsSync(workspace)||!statSync(workspace).isDirectory())fail('harness2_workspace_missing');
  const native=nativeCommand(options.nodePath,options.cliPath);
  const configDir=inside(workspace,join(workspace,'.host-'+host),'host_config');
  const context=createContext({nodePath:options.nodePath,apiBase:options.apiBase,databasePath:options.databasePath,outputDir:configDir});
  let restricted=false;
  if(options.mcpServerPath!==undefined){
    const path=absolute(options.mcpServerPath,'mcp_server'),expected=resolve(dirname(fileURLToPath(import.meta.url)),'../restricted-mcp.mjs');
    if(!existsSync(path)||realpathSync(path)!==realpathSync(expected))fail('harness2_restricted_mcp_path_required');
    context.serverPath=path;context.mcp.args=[path];restricted=true;
  }
  if(options.mcpEnv!==undefined){
    if(!options.mcpEnv||typeof options.mcpEnv!=='object'||Object.keys(options.mcpEnv).some(key=>key!=='FINANCE_HARNESS2_SYNTHETIC_ROOT'))fail('harness2_mcp_environment_forbidden');
    context.mcpEnv.FINANCE_HARNESS2_SYNTHETIC_ROOT=inside(workspace,options.mcpEnv.FINANCE_HARNESS2_SYNTHETIC_ROOT,'synthetic_root');
  }
  // 桥接层负责目标身份和隔离；宿主辅助层还会拒绝工作区之外的数据库。
  inside(workspace,options.databasePath,'database');
  let task,candidateText='';
  if(options.mode==='run'){
    const path=inside(workspace,options.taskFile,'task');if(!statSync(path).isFile()||statSync(path).size>262144)fail('harness2_task_invalid');task=readFileSync(path,'utf8');
    if(!task.trim()||task.includes('\0'))fail('harness2_task_invalid');
  }
  if(options.candidateDir!==undefined){
    const candidate=inside(workspace,options.candidateDir,'candidate');
    candidateText=readSurfaceBundle(candidate).text;
  }else if(options.mode==='run')fail('harness2_candidate_required');
  const timeoutMs=options.timeoutMs??(options.mode==='run'?null:30000);if(timeoutMs!==null&&(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647))fail('harness2_host_timeout_invalid');
  const maxOutputTokens=options.maxOutputTokens;if(maxOutputTokens!==undefined&&(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1))fail('harness2_host_output_limit_invalid');
  writeBundle(context,buildConfig(context));
  const home=join(configDir,'home');mkdirSync(home);mkdirSync(join(home,'tmp'));
  const env={...systemEnv(),...context.mcpEnv,HOME:home,USERPROFILE:home,APPDATA:join(home,'appdata'),LOCALAPPDATA:join(home,'localappdata'),XDG_CONFIG_HOME:join(home,'config'),XDG_DATA_HOME:join(home,'data'),XDG_CACHE_HOME:join(home,'cache'),TMP:join(home,'tmp'),TEMP:join(home,'tmp'),TMPDIR:join(home,'tmp'),PATH:dirname(context.nodePath),NODE_NO_WARNINGS:'1'};
  if(process.env.FINANCE_HARNESS2_SUPERVISED==='1')env.FINANCE_HARNESS2_SUPERVISED='1';
  const expectedMcpTools=(restricted?RESEARCH_TOOLS:toolsForProfile('harness').map(tool=>tool.name)).slice().sort();
  const allowedToolNames=EXPERIMENT_TOOLS.filter(name=>expectedMcpTools.includes(name)).map(name=>'mcp__finance__'+name).sort();
  return {host,native,context,configDir,home,env,task,candidateText,timeoutMs,maxOutputTokens,expectedMcpTools,allowedToolNames};
}
export function runnerSpec(p,plan){
  const planPath=join(p.configDir,'native-plan.json');writeFileSync(planPath,JSON.stringify({schema:'harness2-native-plan/1',host:p.host,expectedVersion:HOST_VERSIONS[p.host],native:p.native,cwd:p.configDir,timeoutMs:p.timeoutMs,maxOutputTokens:p.maxOutputTokens,expectedMcpTools:p.expectedMcpTools,allowedToolNames:p.allowedToolNames,mcp:{serverPath:p.context.serverPath,env:p.context.mcpEnv},...plan}),{flag:'wx'});
  return {host:p.host,command:p.context.nodePath,args:[join(dirname(fileURLToPath(import.meta.url)),'native-runner.mjs'),planPath],cwd:p.configDir,env:p.env,modelInvoked:plan.mode==='run',expectedVersion:HOST_VERSIONS[p.host],protocol:'harness2-native-jsonl/1',planPath};
}
