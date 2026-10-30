import {readFileSync,existsSync,statSync,mkdirSync} from 'node:fs';
import {isAbsolute,resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const HELP='node start-pi.mjs --pi-root <absolute @earendil-works/pi-coding-agent package> [--check | --task-file <absolute task.txt> [--json] [--tools <explicit subset>]]\n默认启动官方 deepseek/deepseek-flash 交互主 Agent；--check 不调用模型。';
export const MAIN_TOOLS=['read','write','edit',process.platform==='win32'?'powershell':'bash','tool_search','mcp__finance__finance_rules','mcp__finance__skills_read'];
export function parseArgs(args){
  const options={};
  for(let i=0;i<args.length;i++){
    const name=args[i];
    if(['--help','--check','--json'].includes(name)){if(options[name])throw Error('pi_arguments_invalid');options[name]=true;}
    else if(['--pi-root','--task-file','--tools'].includes(name)){if(options[name]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error('pi_arguments_invalid');options[name]=args[++i];}
    else throw Error('pi_arguments_invalid');
  }
  if(options['--help'])return options;
  if(!options['--pi-root']||!isAbsolute(options['--pi-root']))throw Error('explicit_pi_package_root_required');
  if(options['--check']&&(options['--task-file']||options['--json']||options['--tools']))throw Error('pi_check_cannot_run_task');
  if(options['--task-file']&&!isAbsolute(options['--task-file']))throw Error('pi_task_absolute_required');
  if((options['--json']||options['--tools'])&&!options['--task-file'])throw Error('pi_task_file_required');
  if(options['--tools'])for(const tool of options['--tools'].split(','))if(!MAIN_TOOLS.includes(tool)&&!/^mcp__finance__(?!harness_)[a-z][a-z0-9_]*$/.test(tool))throw Error('pi_tool_subset_invalid');
  return options;
}
export function buildLaunchSpec(config,workspace,options){
  for(const path of [config.repoRoot,config.nodePath,config.extensionPath,config.skillsDir])if(!isAbsolute(path)||!existsSync(path))throw Error('pi_generated_path_missing');
  if(config.version!=='finance-pi-host/1'||config.provider!=='deepseek'||config.model!=='deepseek-flash'||config.mcpEnv?.FINANCE_MCP_PROFILE!=='direct')throw Error('pi_host_config_invalid');
  const piRoot=resolve(options['--pi-root']),pkg=JSON.parse(readFileSync(join(piRoot,'package.json'),'utf8')),cli=join(piRoot,'dist/bundle/cli.js');
  if(pkg.name!=='@earendil-works/pi-coding-agent'||pkg.version!=='1.1.0'||!existsSync(cli))throw Error('verified_pi_1_1_0_package_required');
  const agentDir=join(workspace,options['--check']?'.pi-check-'+randomUUID():'.pi-agent');
  const env={...process.env,...config.mcpEnv,PI_CODING_AGENT_DIR:agentDir,PI_OFFLINE:'1'};
  if(options['--check'])return {command:config.nodePath,args:[join(config.repoRoot,'06-workbench/scripts/direct-pi-probe.mjs'),piRoot,'--agent-dir',agentDir],cwd:workspace,env,modelInvoked:false};
  const args=[cli,'--offline','--no-session','--no-context-files','--no-extensions','--no-skills','--no-prompt-templates','-e','builtin:mcp','-e','builtin:tool-search','-e',config.extensionPath,'--skill',config.skillsDir,'--provider',config.provider,'--model',config.model,'--thinking','low','--tools',options['--tools']??MAIN_TOOLS.join(','),'--append-system-prompt',`你是本机财税主 Agent。按业务目标自主选择相关Skill和工具；用tool_search按需加载工具合同。核实企业、账套、期间与原件，直接调用财税业务工具，不维护Harness登记或DAG。工具后台自动记录调用。交付按账本金额→凭证/计算结果→规则依据→工具调用→输入与原件，日常前三项，异常再深查。未知不填零，不得编造会计批准、申报或付款。模型固定官方deepseek/deepseek-flash，不跨服务回退。`];
  if(options['--task-file']){if(!statSync(options['--task-file']).isFile())throw Error('pi_task_file_required');if(options['--json'])args.push('--mode','json');args.push('--print',readFileSync(options['--task-file'],'utf8'));}
  return {command:config.nodePath,args,cwd:workspace,env,modelInvoked:'only after an explicit task or interactive input'};
}
export async function runPi(configUrl,args){
  const options=parseArgs(args);if(options['--help']){console.log(HELP);return;}
  const configPath=fileURLToPath(configUrl),workspace=dirname(configPath),config=JSON.parse(readFileSync(configPath,'utf8')),spec=buildLaunchSpec(config,workspace,options);
  // 此隔离目录从空目录开始：禁止预置凭据、会话或用户设置。
  if(!options['--check'])mkdirSync(spec.env.PI_CODING_AGENT_DIR,{recursive:true});
  const child=spawn(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,windowsHide:true,shell:false,stdio:'inherit'});
  const code=await new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>ok(signal?1:code??1));});process.exitCode=code;
}
