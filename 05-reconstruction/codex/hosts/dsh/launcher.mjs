import {readFileSync,existsSync,statSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {PERIOD_TASK_ROUTING} from '../shared/task-routing.mjs';
import {BUSINESS_MEMORY_ROUTING,renderBusinessContext,sessionPath,prepareBoundBusinessSession} from '../shared/business-session.mjs';

const HELP='node start-dsh.mjs --dsh-cli <已安装dsh包的JS bin绝对路径> (--task <明确任务> | --task-file <UTF-8任务绝对路径>) [--model-patch <已有模型覆盖层绝对路径>]\n不安装宿主，不读取凭据；仅显式开始任务时调用所选CLI。';
export function parseArgs(args){
 const options={};
 for(let i=0;i<args.length;i++){
  const name=args[i];
  if(name==='--help'){if(options[name])throw Error('dsh_arguments_invalid');options[name]=true;}
  else if(['--dsh-cli','--task','--task-file','--model-patch'].includes(name)){
   if(options[name]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error('dsh_arguments_invalid');options[name]=args[++i];
  }else throw Error('dsh_arguments_invalid');
 }
 if(options['--help'])return options;
 if(!options['--dsh-cli']||!isAbsolute(options['--dsh-cli']))throw Error('explicit_dsh_cli_required');
 if(Boolean(options['--task'])===Boolean(options['--task-file']))throw Error('explicit_dsh_task_required');
 for(const key of ['--task-file','--model-patch'])if(options[key]&&!isAbsolute(options[key]))throw Error('dsh_path_absolute_required');
 return options;
}
export function buildLaunchSpec(nodePath,workspace,options,businessContext){
 const cli=options['--dsh-cli'],model=options['--model-patch']??join(workspace,'model.cordis.patch.yml'),finance=join(workspace,'finance.cordis.patch.yml');
 for(const path of [nodePath,cli,model,finance])if(!isAbsolute(path)||!existsSync(path)||!statSync(path).isFile())throw Error('dsh_launch_file_missing');
 if(!/\.(?:js|mjs|cjs)$/i.test(cli))throw Error('dsh_js_cli_required');
 const task=options['--task-file']?readFileSync(options['--task-file'],'utf8'):options['--task'];
 if(typeof task!=='string'||!task.trim())throw Error('explicit_dsh_task_required');
 // 只包装已验证的 CLI 任务参数，不添加未经核实的宿主 prompt 配置字段。
 return {command:nodePath,args:[cli,'--profile','headless','--patch',finance,'--patch',model,PERIOD_TASK_ROUTING+'\n\n'+BUSINESS_MEMORY_ROUTING+(businessContext?'\n\n'+renderBusinessContext(businessContext):'\n尚未绑定企业记忆；有账套的任务先用start-business-session.mjs绑定。')+'\n\n本次任务：\n'+task],cwd:workspace,modelInvoked:'only after explicit task launch'};
}
export async function runDsh(nodePath,workspaceUrl,args,bound){
 const options=parseArgs(args);if(options['--help']){console.log(HELP);return;}
 const workspace=fileURLToPath(workspaceUrl);
 if(!bound&&existsSync(sessionPath(workspace)))bound=await prepareBoundBusinessSession(workspace);
 const spec=buildLaunchSpec(nodePath,workspace,options,bound?.context);
 const child=spawn(spec.command,spec.args,{cwd:spec.cwd,env:bound?{...process.env,...bound.config.mcpEnv}:process.env,windowsHide:true,shell:false,stdio:'inherit'});
 process.exitCode=await new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>ok(signal?1:code??1));});
}
