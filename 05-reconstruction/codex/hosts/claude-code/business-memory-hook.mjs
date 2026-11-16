// SessionStart 的企业内容读取严格只读；仅另存最小宿主会话身份，绝不读 transcript 或原生 memory。
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {readBoundBusinessContext,loadBoundBusinessSession,readHostJson,assertSameScope,renderBusinessContext} from '../shared/business-session.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function claudeBusinessHooks(nodePath,workspace){
 const command=mode=>({type:'command',command:nodePath,args:[join(workspace,'business-memory-context.mjs'),mode],timeout:20});
 return {SessionStart:[{matcher:'startup|resume|clear|compact|fork',hooks:[command('--claude-hook')]}],UserPromptSubmit:[{hooks:[{...command('--claude-guard'),onFailure:'block'}]}]};
}
const validSessionId=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
function bindingPath(workspace,id){if(!validSessionId(id))fail('claude_business_session_id_invalid');return join(workspace,'.finance/claude-session-bindings',createHash('sha256').update(id).digest('hex')+'.json');}
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
 mkdirSync(join(workspace,'.finance/claude-session-bindings'),{recursive:true});
 try{writeFileSync(path,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;assertClaudeSessionBinding(workspace,id,session);}
 return value;
}
function validateInput(workspace,input,event){
 if(input.hook_event_name!==event||typeof input.cwd!=='string'||resolve(input.cwd).toLowerCase()!==resolve(workspace).toLowerCase()||!validSessionId(input.session_id))fail('claude_business_hook_input_invalid');
}
export async function handleClaudeHook(workspace,input,mode='--claude-hook'){
 const guard=mode==='--claude-guard';validateInput(workspace,input,guard?'UserPromptSubmit':'SessionStart');
 const {session}=loadBoundBusinessSession(workspace);
 if(guard){assertClaudeSessionBinding(workspace,input.session_id,session);return {};}
 if(!['startup','resume','clear','compact','fork'].includes(input.source))fail('claude_business_hook_source_invalid');
 if(['resume','compact','fork'].includes(input.source))assertClaudeSessionBinding(workspace,input.session_id,session);
 else if(input.source==='startup'&&process.env.FINANCE_CLAUDE_LAUNCH_ID&&input.session_id!==process.env.FINANCE_CLAUDE_LAUNCH_ID)fail('claude_business_launch_id_mismatch');
 const {context}=await readBoundBusinessContext(workspace);
 // 唯一宿主侧写入：不含方法/案例内容，只把生命周期新ID绑定实际scope供下次resume核对。
 if(['startup','clear'].includes(input.source))rememberClaudeSession(workspace,input.session_id,session);
 return {hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:renderBusinessContext(context)}};
}
export async function runClaudeHook(workspace,mode){
 try{
  let body='';for await(const chunk of process.stdin){body+=chunk;if(Buffer.byteLength(body)>65536)fail('claude_business_hook_input_too_large');}
  let input;try{input=JSON.parse(body);}catch{fail('claude_business_hook_input_invalid');}
  console.log(JSON.stringify(await handleClaudeHook(workspace,input,mode)));
 }catch(error){
  const code=/^(?:host_business_|claude_business_|finance_target_|finance_memory_|business_memory_)[A-Za-z0-9_]+$/.test(error.code??'')?error.code:'claude_business_context_unavailable';
  // SessionStart本身不能靠退出码阻止会话；UserPromptSubmit守卫在模型请求前另作同样验证并exit2。
  console.log(JSON.stringify({continue:false,stopReason:'企业记忆绑定校验失败：'+code,systemMessage:'先在本工作区核对实际账库、账套和期间；禁止沿用其他企业会话。',...(mode==='--claude-hook'?{hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'企业记忆加载失败；当前企业上下文未获核实。禁止使用旧会话中的企业口径；请停止本次业务并核对绑定。错误码：'+code}}:{})}));
  if(mode==='--claude-guard')process.exitCode=2;
 }
}
