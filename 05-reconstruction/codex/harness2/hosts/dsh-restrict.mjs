import {EXPERIMENT_TOOLS} from './common.mjs';
const maximum=new Set(EXPERIMENT_TOOLS.map(name=>'mcp__finance__'+name));
// dsh's native agent-scoped tool filter, matching the pinned 0.2.1-rc.2 API.
function restrict(ctx,config){
  const allowed=config.allowedToolNames;if(!Array.isArray(allowed)||!allowed.length||new Set(allowed).size!==allowed.length||allowed.some(name=>!maximum.has(name)))throw Error('harness2_dsh_tool_scope_required');const allow=new Set(allowed);
  ctx.tools.guard(exec=>allow.has(exec.name)?undefined:'Harness2 synthetic experiment scope denies this tool.');
  ctx.on('agent/created',({agent})=>{
    agent.ctx.tools.restrict({allow:allowed});
    if(agent.ctx.tools.schemas(agent).some(tool=>!allow.has(tool.name)))throw Error('harness2_dsh_unexpected_visible_tool');
  });
  ctx.on('tools/result',(exec,result)=>process.stdout.write(JSON.stringify({type:'harness2_tool_result',toolName:exec.name,callId:exec.callId,result})+'\n'));
}
restrict.inject=['tools'];export default restrict;
