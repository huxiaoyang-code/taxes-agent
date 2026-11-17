import {existsSync,statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {prepareBoundBusinessSession,readBoundBusinessContext} from '../shared/business-session.mjs';
export async function runZcode(workspaceUrl,args,bound){
 const workspace=fileURLToPath(workspaceUrl),options={};
 for(let i=0;i<args.length;i++){
  if(['--help','--check'].includes(args[i]))options[args[i]]=true;
  else if(args[i]==='--zcode-cli'&&!options['--zcode-cli']&&args[i+1])options['--zcode-cli']=args[++i];
  else throw Error('zcode_launch_arguments_invalid');
 }
 if(options['--help']){console.log('node start-zcode.mjs --zcode-cli <已安装ZCode exe或JS绝对路径> [--check]\n启动准备已绑定企业目录，AGENTS.md要求先读finance_baseline_read；目录准备不等于业务基线ready。未声明未经验证的ZCode生命周期hook。');return;}
 const cli=options['--zcode-cli'];if(!cli||!isAbsolute(cli)||!existsSync(cli)||!statSync(cli).isFile()||!/\.(?:exe|js|mjs|cjs)$/i.test(cli))throw Error('explicit_zcode_executable_or_js_required');
 if(options['--check']){const value=await readBoundBusinessContext(workspace);console.log(JSON.stringify({status:'checked',scope:value.session.scope,context:value.context,readOnly:true,modelInvoked:false}));return;}
 const value=bound??await prepareBoundBusinessSession(workspace),native=['--cwd',workspace,'--mode','build'];
 const command=/\.exe$/i.test(cli)?cli:value.config.nodePath,argsOut=/\.exe$/i.test(cli)?native:[cli,...native];
 const child=spawn(command,argsOut,{cwd:workspace,env:{...process.env,...value.config.mcpEnv},windowsHide:true,shell:false,stdio:'inherit'});
 process.exitCode=await new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>ok(signal?1:code??1));});
}
