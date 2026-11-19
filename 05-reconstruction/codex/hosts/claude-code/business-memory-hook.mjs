// 保留 Claude 会话与实际账套的绑定校验，记忆由原生 Auto Memory 加载。
import {existsSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadBoundBusinessSession,loadBusinessHost,readHostJson,sessionPath,assertSameScope} from '../shared/business-session.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function claudeBusinessHooks(nodePath,workspace){
 const command=mode=>({type:'command',command:nodePath,args:[join(workspace,'business-memory-context.mjs'),mode],timeout:20});
 return {SessionStart:[{matcher:'startup|resume|clear|compact|fork',hooks:[command('--claude-hook')]}],UserPromptSubmit:[{hooks:[{...command('--claude-guard'),onFailure:'block'}]}]};
}
const validSessionId=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
const bindingsDirectory=workspace=>join(workspace,'.finance/claude-session-bindings');
function bindingPath(workspace,id){if(!validSessionId(id))fail('claude_business_session_id_invalid');return join(bindingsDirectory(workspace),createHash('sha256').update(id).digest('hex')+'.json');}
export function assertClaudeSessionBinding(workspace,id,session){
 const path=bindingPath(workspace,id);if(!existsSync(path))fail('claude_business_resume_unbound');
 const prior=readHostJson(path);
 if(prior.version!=='finance-claude-session-binding/1'||prior.sessionId!==id||resolve(prior.workspace).toLowerCase()!==resolve(workspace).toLowerCase())fail('claude_business_resume_scope_mismatch');
 try{assertSameScope(prior.scope,session.scope);}catch{fail('claude_business_resume_scope_mismatch');}
 if(prior.databasePath!==session.databasePath||prior.sourceRoot!==session.sourceRoot||prior.auditDir!==session.auditDir)fail('claude_business_resume_scope_mismatch');
 return prior;
}
function rememberClaudeSession(workspace,id,session){
 const path=bindingPath(workspace,id);
 if(existsSync(path))return assertClaudeSessionBinding(workspace,id,session);
 const value={version:'finance-claude-session-binding/1',sessionId:id,workspace:resolve(workspace),databasePath:session.databasePath,scope:session.scope,sourceRoot:session.sourceRoot,auditDir:session.auditDir};
 mkdirSync(bindingsDirectory(workspace),{recursive:true});
 try{writeFileSync(path,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;assertClaudeSessionBinding(workspace,id,session);}
 return value;
}
function validateInput(workspace,input,event){
 if(input.hook_event_name!==event||typeof input.cwd!=='string'||resolve(input.cwd).toLowerCase()!==resolve(workspace).toLowerCase()||!validSessionId(input.session_id))fail('claude_business_hook_input_invalid');
}
export async function handleClaudeHook(workspace,input,mode='--claude-hook'){
 const guard=mode==='--claude-guard';validateInput(workspace,input,guard?'UserPromptSubmit':'SessionStart');
 if(!guard&&!['startup','resume','clear','compact','fork'].includes(input.source))fail('claude_business_hook_source_invalid');
 // 原生未绑定工作区支持账前核对；受控启动及已有账套会话继续校验绑定。
 if(!process.env.FINANCE_CLAUDE_LAUNCH_ID&&!lstatSync(sessionPath(workspace),{throwIfNoEntry:false})&&!lstatSync(bindingsDirectory(workspace),{throwIfNoEntry:false})){
  if(loadBusinessHost(workspace).host!=='claude-code')fail('host_business_config_invalid');
  return {};
 }
 const {session}=loadBoundBusinessSession(workspace);
 if(guard){assertClaudeSessionBinding(workspace,input.session_id,session);return {};}
 if(['resume','compact','fork'].includes(input.source))assertClaudeSessionBinding(workspace,input.session_id,session);
 else if(input.source==='startup'&&process.env.FINANCE_CLAUDE_LAUNCH_ID&&input.session_id!==process.env.FINANCE_CLAUDE_LAUNCH_ID)fail('claude_business_launch_id_mismatch');
 if(['startup','clear'].includes(input.source))rememberClaudeSession(workspace,input.session_id,session);
 return {};
}
export async function runClaudeHook(workspace,mode){
 try{
  let body='';for await(const chunk of process.stdin){body+=chunk;if(Buffer.byteLength(body)>65536)fail('claude_business_hook_input_too_large');}
  let input;try{input=JSON.parse(body);}catch{fail('claude_business_hook_input_invalid');}
  console.log(JSON.stringify(await handleClaudeHook(workspace,input,mode)));
 }catch(error){
  const code=/^(?:host_business_|claude_business_|finance_target_)[A-Za-z0-9_]+$/.test(error.code??'')?error.code:'claude_business_context_unavailable';
  // SessionStart本身不能靠退出码阻止会话；UserPromptSubmit守卫在模型请求前另作同样验证并exit2。
  console.log(JSON.stringify({continue:false,stopReason:'账套会话绑定校验失败：'+code,systemMessage:'先在本工作区核对实际账库、账套和期间。'}));
  if(mode==='--claude-guard')process.exitCode=2;
 }
}
