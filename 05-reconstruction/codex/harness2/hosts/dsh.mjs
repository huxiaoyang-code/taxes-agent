import {writeFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildConfig} from '../../hosts/dsh/adapter.mjs';
import {prepare,runnerSpec,modelEndpoint,requireGateway} from './common.mjs';
export const HOST_ID='dsh';export const SUPPORTED_VERSION='0.2.1-rc.2';
export function buildHostSpec(options){
  const p=prepare(options,HOST_ID,buildConfig);
  Object.assign(p.env,{DSH_HOME:p.home,DSH_TELEMETRY_DISABLED:'1',DSH_PERMISSION_MODE:'workspace-write'});
  const patch=join(p.configDir,'model.cordis.patch.yml');
  let endpoint=modelEndpoint(options.modelBaseUrl??(options.mode==='check'?'http://127.0.0.1:9/anthropic':undefined),'messages');if(options.mode==='run')endpoint=requireGateway(endpoint,'messages');
  const disabled=['session-title-llm','plugin-package-inventory-deepseek','llm-pi-ai','llm-deepseek-account','llm-retry','tool-subagent','tool-subagent-fork','tool-subagent-control','tool-subagent-list-agents','tool-workflow','tool-plugin-manager','tool-bash','tool-pwsh','tool-fs','tool-fs-search','tool-jobs','tool-web','tool-todo','tool-goal','tool-skill','tool-working-directory'];
  writeFileSync(patch,JSON.stringify([
    ...disabled.map(id=>({id,disabled:true})),
    {id:'agent-default-model',config:{provider:'deepseek-official',model:'deepseek-flash'}},
    {id:'llm-deepseek',config:{apiKeyEnv:'DEEPSEEK_API_KEY',baseURL:endpoint,...p.maxOutputTokens===undefined?{}:{maxTokens:p.maxOutputTokens},retryPolicy:{mode:'normal',maxRetries:0}}},
    {id:'system-prompt',config:{personaPrefix:'Authorized synthetic research only. Execute only the requested period.inspect capability; never fabricate approval. '+p.candidateText}},
    {insert:[{id:'harness2-metadata-restriction',name:pathToFileURL(fileURLToPath(new URL('./dsh-restrict.mjs',import.meta.url))).href,config:{allowedToolNames:p.allowedToolNames}}]},
  ],null,2),{flag:'wx'});
  const args=['--profile','headless','--patch',join(p.configDir,'finance.cordis.patch.yml'),'--patch',patch];
  p.env.DEEPSEEK_API_KEY='synthetic-harness2-placeholder';
  if(options.mode==='check'){
    const probePatch=join(p.configDir,'probe.cordis.patch.yml'),probeUrl=new URL('./dsh-probe.mjs',import.meta.url).href;
    writeFileSync(probePatch,JSON.stringify([{id:'headless-runner',disabled:true},{id:'headless-startup',disabled:true},{insert:[{id:'harness2-native-probe',name:probeUrl,config:{agentModuleUrl:pathToFileURL(resolve(dirname(options.cliPath),'../../dsh-agent/lib/index.js')).href,allowedToolNames:p.allowedToolNames,expectedMcpTools:p.expectedMcpTools}}]}]),{flag:'wx'});
    return runnerSpec(p,{mode:'check',checkArgs:[...args,'--dump-config'],mountArgs:[...args,'--patch',probePatch],probe:'native-config-and-agent-mount'});
  }
  return runnerSpec(p,{mode:'run',runArgs:[...args,'--json',p.task],probe:'native-json'});
}
