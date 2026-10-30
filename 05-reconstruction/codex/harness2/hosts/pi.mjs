import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {createContext} from '../../hosts/shared/config.mjs';
import {buildConfig} from '../../hosts/pi/adapter.mjs';
import {buildLaunchSpec} from '../../hosts/pi/launcher.mjs';
import {cleanEnvironment,fail,readSurfaceBundle} from '../surface.mjs';
import {inside} from './common.mjs';
export const HOST_ID='pi',SUPPORTED_VERSION='1.1.0';
export function buildHostSpec({workspace,nodePath,packageRoot,apiBase,databasePath,taskFile,mode='check',candidateDir,modelBaseUrl,maxOutputTokens,contextWindow=1048576,modelMaxTokens=393216}){
  const pkg=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'));
  if(pkg.name!=='@earendil-works/pi-coding-agent'||pkg.version!==SUPPORTED_VERSION)fail('verified_pi_1_1_0_package_required');
  if(mode==='run'){
    for(const name of ['pi-agent-core','pi-ai','pi-tui','pi-coding-agent','pi-codemode','pi-mcp','pi-telemetry','chord','typebox']){
      const id=name==='typebox'?name:'@earendil-works/'+name;let directory=packageRoot;let found=false;
      for(let i=0;i<8;i++,directory=dirname(directory)){const p=name==='pi-coding-agent'?join(packageRoot,'package.json'):join(directory,'node_modules',id,'package.json');if(existsSync(p)){const entry=JSON.parse(readFileSync(p,'utf8'));if(entry.name===id){if(entry.version!==(name==='typebox'?'1.3.27':'1.1.0'))fail('harness2_pi_toolchain_version_unverified');found=true;break;}}}
      if(!found)fail('harness2_pi_toolchain_version_unverified');
    }
  }
  if(mode==='run'&&!candidateDir)fail('harness2_candidate_required');
  const candidateText=candidateDir===undefined?'':readSurfaceBundle(inside(workspace,candidateDir,'candidate')).text;
  const dir=join(workspace,'.host-pi');mkdirSync(dir);
  const context=createContext({nodePath,apiBase,databasePath,outputDir:join(dir,'config')});
  const bundle=buildConfig(context);mkdirSync(context.outputDir);
  for(const f of bundle.files)writeFileSync(join(context.outputDir,f.path),f.content,{flag:'wx'});
  const config=JSON.parse(bundle.files.find(f=>f.path==='pi-host.json').content);
  if(mode==='run')config.extensionPath=join(config.repoRoot,'05-reconstruction/codex/harness2/pi-extension.mjs');
  const options={'--pi-root':packageRoot,...(mode!=='run'?{'--check':true}:{'--task-file':taskFile,'--json':true,'--tools':'read,tool_search,mcp__finance__harness_*,mcp__finance__skills_read,mcp__finance__skills_list'})};
  const spec=buildLaunchSpec(config,dir,options),home=join(dir,'home');mkdirSync(home);
  spec.env={...cleanEnvironment(home),...config.mcpEnv,FINANCE_HARNESS2_SYNTHETIC_ROOT:dirname(dirname(databasePath)),PI_CODING_AGENT_DIR:spec.env.PI_CODING_AGENT_DIR};
  if(mode==='check')spec.args[0]=join(config.repoRoot,'06-workbench/scripts/harness2-pi-probe.mjs');
  if(mode==='synthetic-native')spec.args[0]=join(config.repoRoot,'06-workbench/scripts/harness2-pi-task.mjs');
  if(mode==='run'){
    if(!candidateDir)fail('harness2_candidate_required');
    if(!modelBaseUrl?.startsWith('http://127.0.0.1:'))fail('harness2_budget_relay_required');
    mkdirSync(spec.env.PI_CODING_AGENT_DIR);
    writeFileSync(join(spec.env.PI_CODING_AGENT_DIR,'settings.json'),JSON.stringify({retry:{enabled:false,maxRetries:0}}),{flag:'wx'});
    for(const value of [contextWindow,modelMaxTokens,...maxOutputTokens===undefined?[]:[maxOutputTokens]])if(!Number.isSafeInteger(value)||value<1)fail('harness2_model_capability_invalid');
    // 容量元数据遵循官方模型说明，并非代理准入限制；
    // 实际请求选项由 Pi 自己的 provider 决定。
    writeFileSync(join(spec.env.PI_CODING_AGENT_DIR,'models.json'),JSON.stringify({providers:{deepseek:{baseUrl:modelBaseUrl,api:'openai-completions',apiKey:'sandbox-budget-relay',models:[{id:'deepseek-flash',name:'Official DeepSeek Flash via executor relay',reasoning:true,input:['text'],contextWindow,maxTokens:maxOutputTokens??modelMaxTokens}]}}}),{flag:'wx'});
    const promptAt=spec.args.indexOf('--append-system-prompt');
    if(promptAt===-1)spec.args.push('--append-system-prompt',candidateText);
    else spec.args[promptAt+1]+='\n\n'+candidateText;
  }
  return {...spec,host:HOST_ID,expectedVersion:SUPPORTED_VERSION,protocol:'jsonl',modelInvoked:mode==='run'};
}
