import {buildConfig} from '../../hosts/claude-code/adapter.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {prepare,runnerSpec,modelEndpoint,requireGateway} from './common.mjs';
export const HOST_ID='claude-code';export const SUPPORTED_VERSION='2.1.309';
export function buildHostSpec(options){
  const p=prepare(options,HOST_ID,buildConfig);
  p.env.CLAUDE_CONFIG_DIR=p.home;p.env.DISABLE_AUTOUPDATER='1';p.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';
  p.env.ANTHROPIC_MAX_RETRIES='0';p.env.CLAUDE_CODE_MAX_RETRIES='0';if(p.timeoutMs!==null)p.env.API_TIMEOUT_MS=String(p.timeoutMs);
  const common=['--bare','--restricted','--setting-sources','','--strict-mcp-config','--mcp-config',p.configDir+'/.mcp.json','--settings',p.configDir+'/.claude/settings.json'];
  if(options.mode==='check')return runnerSpec(p,{mode:'check',setupArgs:['mcp','add-json','--scope','local','finance',JSON.stringify(p.context.mcp)],checkArgs:['--setting-sources','local','mcp','list'],probe:'native-mcp-list'});
  const model='deepseek-flash';
  Object.assign(p.env,{ANTHROPIC_BASE_URL:requireGateway(modelEndpoint(options.modelBaseUrl,'messages'),'messages'),ANTHROPIC_API_KEY:'synthetic-harness2-placeholder',ANTHROPIC_AUTH_TOKEN:'synthetic-harness2-placeholder',ANTHROPIC_MODEL:model,ANTHROPIC_DEFAULT_OPUS_MODEL:model,ANTHROPIC_DEFAULT_SONNET_MODEL:model,ANTHROPIC_DEFAULT_HAIKU_MODEL:model,ANTHROPIC_SMALL_FAST_MODEL:model,CLAUDE_CODE_SUBAGENT_MODEL:model});
  if(p.maxOutputTokens!==undefined)p.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS=String(p.maxOutputTokens);
  const allow=p.allowedToolNames,settingsPath=join(p.configDir,'.claude/settings.json'),settings=JSON.parse(readFileSync(settingsPath,'utf8'));
  settings.permissions.allow=allow;settings.permissions.ask=settings.permissions.ask.filter(x=>!allow.includes(x));writeFileSync(settingsPath,JSON.stringify(settings,null,2));
  return runnerSpec(p,{mode:'run',runArgs:[...common,'--print','--no-session-persistence','--tools','','--allowedTools',allow.join(','),'--permission-prompts','none','--model',model,'--output-format','stream-json','--verbose','--append-system-prompt',p.candidateText,p.task],probe:'native-stream-json'});
}
