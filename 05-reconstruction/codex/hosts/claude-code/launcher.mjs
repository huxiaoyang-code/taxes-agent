// 固定工作区配置和真实账套；不允许额外参数替换 MCP、设置、cwd 或恢复目标。
import {existsSync,statSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {loadBoundBusinessSession,prepareBoundBusinessSession,readHostJson,sessionPath} from '../shared/business-session.mjs';
import {assertClaudeSessionBinding,claudeBusinessHooks} from './business-memory-hook.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const FLAGS=new Set(['-p','--print','--verbose','--include-hook-events','--no-session-persistence','--init-only']);
const VALUES=new Set(['--model','--effort','--output-format','--input-format','--max-turns','--max-budget-usd','--tools','--allowedTools','--disallowedTools','--debug-file']);
export function parseClaudeArgs(args){
 const options={extra:[]};let rest=false,positionalOnly=false;
 for(let i=0;i<args.length;i++){
  const name=args[i];
  if(rest){
   if(name==='--'&&!positionalOnly){positionalOnly=true;continue;}
   if(positionalOnly){if(options.prompt!==undefined)fail('claude_launch_arguments_invalid');options.prompt=name;continue;}
   if(FLAGS.has(name)){options.extra.push(name);continue;}
   if(VALUES.has(name)){if(args[i+1]===undefined)fail('claude_launch_arguments_invalid');if(args[i+1].startsWith('-'))fail('claude_launch_override_rejected');options.extra.push(name,args[++i]);continue;}
   if(name.startsWith('-'))fail('claude_launch_override_rejected');
   if(options.prompt!==undefined)fail('claude_launch_arguments_invalid');options.prompt=name;continue;
  }
  if(name==='--'){rest=true;continue;}
  if(['--help','--check'].includes(name)){if(options[name])fail('claude_launch_arguments_invalid');options[name]=true;}
  else if(['--claude-cli','--resume'].includes(name)){if(options[name]!==undefined||!args[i+1]||args[i+1].startsWith('--'))fail('claude_launch_arguments_invalid');options[name]=args[++i];}
  else fail('claude_launch_arguments_invalid');
 }
 if(options['--help'])return options;
 if(!options['--claude-cli']||!isAbsolute(options['--claude-cli']))fail('explicit_claude_cli_required');
 if(options['--resume']&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(options['--resume']))fail('claude_resume_uuid_required');
 if(options['--check']&&(options.extra.length||options.prompt!==undefined))fail('claude_check_cannot_run_task');
 return options;
}
export function buildClaudeLaunchSpec(workspace,options){
 const {config,session}=loadBoundBusinessSession(workspace),cli=options['--claude-cli'];
 if(!existsSync(cli)||!statSync(cli).isFile()||!/\.(?:exe|mjs|cjs|js)$/i.test(cli))fail('claude_executable_or_js_required');
 const settings=join(workspace,'.claude/settings.json'),mcp=join(workspace,'.mcp.json'),native=readHostJson(settings);
 if(native.autoMemoryEnabled!==false||native.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY!=='1'||JSON.stringify(native.hooks)!==JSON.stringify(claudeBusinessHooks(config.nodePath,workspace)))fail('claude_business_hooks_required');
 const sessionId=options['--resume']??randomUUID();
 if(options['--resume'])assertClaudeSessionBinding(workspace,sessionId,session);
 // 原生--allowedTools等选项是variadic，提示词必须在明确的选项终止符之后。
 const args=['--strict-mcp-config','--mcp-config',mcp,'--settings',settings,'--setting-sources','project',...(options['--resume']?['--resume',sessionId]:['--session-id',sessionId]),...options.extra,...(options.prompt===undefined?[]:['--',options.prompt])];
 const env={...process.env,...config.mcpEnv,FINANCE_BUSINESS_SESSION:sessionPath(workspace),FINANCE_CLAUDE_LAUNCH_ID:sessionId,CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1'};
 return {command:/\.exe$/i.test(cli)?cli:config.nodePath,args:/\.exe$/i.test(cli)?args:[cli,...args],cwd:workspace,env,scope:session.scope,sessionId,modelInvoked:options['--check']?false:'only after an explicit task or interactive input'};
}
export async function runClaude(workspaceUrl,args,bound){
 const options=parseClaudeArgs(args),workspace=fileURLToPath(workspaceUrl);
 if(options['--help']){console.log('node start-claude.mjs --claude-cli <Claude 2.1.309 exe或JS绝对路径> [--resume <本工作区已绑定UUID>] [--check | -- <受支持Claude参数>]\n先用start-business-session绑定账户；常规启动自动prepare，--check只读。MCP、settings、工作目录和auto memory隔离不能从额外参数覆盖。');return;}
 // 先拒绝不受支持的参数和错误恢复目标，避免为拒绝的任务更新记忆。
 let spec=buildClaudeLaunchSpec(workspace,options);
 if(options['--check']){console.log(JSON.stringify({status:'checked',scope:spec.scope,sessionId:spec.sessionId,autoMemoryEnabled:false,modelInvoked:false,readOnly:true},null,2));return;}
 if(!bound)await prepareBoundBusinessSession(workspace);
 spec=buildClaudeLaunchSpec(workspace,options);
 const child=spawn(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,windowsHide:true,shell:false,stdio:'inherit'});
 process.exitCode=await new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>ok(signal?1:code??1));});
}
