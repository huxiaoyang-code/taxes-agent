import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {buildConfig} from '../../hosts/zcode/adapter.mjs';
import {prepare,runnerSpec,modelEndpoint,requireGateway,fail} from './common.mjs';
export const HOST_ID='zcode';export const SUPPORTED_VERSION='0.16.9';
export function buildHostSpec(options){
  const p=prepare(options,HOST_ID,buildConfig),configPath=join(p.configDir,'.zcode/config.json');
  const config=JSON.parse(readFileSync(configPath,'utf8'));
  Object.assign(config,{features:{...config.features,subagent:false,memory:false},memory:{use:false},plugins:{enabled:false},hooks:{enabled:false}});writeFileSync(configPath,JSON.stringify(config,null,2));
  Object.assign(p.env,{ZCODE_DATA_BASE_DIR:p.home,ZCODE_STORAGE_DIR:join(p.home,'storage'),ZCODE_SESSION_DB_PATH:join(p.home,'sessions.db'),ZCODE_LOG_DIR:join(p.home,'logs'),OTEL_SDK_DISABLED:'true'});
  const builtin=resolve(dirname(options.cliPath),'../config/provider/zcode-builtin.json');
  if(!existsSync(builtin)||!statSync(builtin).isFile())fail('harness2_zcode_builtin_provider_missing');
  p.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=builtin;
  // 应用原生编解码器将 API 密钥存于 provider 文件。操作者凭据由执行中继持有，
  // 因此此文件只写入占位值。
  let endpoint=modelEndpoint(options.modelBaseUrl??(options.mode==='check'?'http://127.0.0.1:9/v1':undefined),'chat');
  if(options.mode==='run')endpoint=requireGateway(endpoint,'chat');
  const providerPath=join(p.home,'provider.json'),providerId='harness2-deepseek-local';
  // 匹配固定版本原生编解码器的稳定字段顺序，否则它会持锁重写文件，
  // 并可能在锁失败后恢复为空注册表。
  writeFileSync(providerPath,JSON.stringify({schemaVersion:1,config:{providerConfigRules:{providerRules:[{providerId,providerName:'Harness2 synthetic executor relay',enabled:true,config:{group:'standard-personal',access:{type:'api-key',apiKey:'synthetic-harness2-placeholder'},api:{type:'openai-chat-completions',baseUrl:endpoint},personalModelIds:['deepseek-flash']}}]},modelConfigRules:{providerModelRules:[{modelId:'deepseek-flash',config:{enabled:true,...p.maxOutputTokens===undefined?{}:{optionSpecs:{maxOutputTokens:{max:p.maxOutputTokens,map:'{"max_tokens":maxOutputTokens}'}}}},providerId}],manualProviderModelRules:[]},defaultModelSelection:{providerId,modelId:'deepseek-flash',options:{}}}}),{flag:'wx'});
  p.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=providerPath;
  return runnerSpec(p,{mode:options.mode,protocol:'zcode-app-server',providerId,allowedTools:p.allowedToolNames,task:options.mode==='run'?p.candidateText+'\n'+p.task:undefined,probe:'native-app-server-session-mcp'});
}
