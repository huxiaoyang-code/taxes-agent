import {randomUUID} from 'node:crypto';

export const name='harness2-native-model-free-probe';
export const inject=['agents','sessions','tools','agentDefaultModel'];
export function apply(ctx,config){
  const ready=ctx.get('appReady'),exit=ctx.get('appExit');
  if(!ready||!exit)throw Error('harness2_dsh_native_lifecycle_missing');
  ready.onReady(()=>{void (async()=>{
    const {installModelSelection}=await import(config.agentModuleUrl);
    const selection=ctx.get('agentDefaultModel').currentSelection();
    if(selection.provider!=='deepseek-official'||selection.model!=='deepseek-flash')throw Error('harness2_dsh_model_selection_mismatch');
    const {agent}=await ctx.get('agents').create({sessionId:'harness2-probe-'+randomUUID(),meta:{cwd:process.cwd()},agentOptions:{provider:selection.provider,model:selection.model},setup:agentCtx=>{installModelSelection(agentCtx,{current:selection,assembled:undefined});}});
    await agent.whenIdle();
    const allowed=config.allowedToolNames.slice().sort(),visible=agent.ctx.tools.schemas(agent).map(tool=>tool.name).sort();
    if(JSON.stringify(visible)!==JSON.stringify(allowed))throw Error('harness2_dsh_native_tool_restriction_unproven');
    const expectedMcp=config.expectedMcpTools.map(name=>'mcp__finance__'+name).sort(),mcpTools=ctx.get('tools').schemas().map(tool=>tool.name).filter(name=>name.startsWith('mcp__finance__')).sort();
    if(JSON.stringify(mcpTools)!==JSON.stringify(expectedMcp))throw Error('harness2_dsh_native_mcp_set_unproven');
    const events=[];for(let n=0;n<agent.session.seq;n++){const event=agent.session.eventAt(n);if(event)events.push(event.type);}
    if(events.some(type=>type==='turn/start'||type==='assistant/message'))throw Error('harness2_dsh_unexpected_initial_model_activity');
    await ctx.get('sessions').flush(agent.session);
    process.stdout.write(JSON.stringify({type:'harness2_dsh_probe',status:'passed',provider:selection.provider,model:selection.model,visibleTools:visible,mcpToolNames:mcpTools,modelInvoked:false,turnCount:0})+'\n');
    exit(0);
  })().catch(error=>{process.stderr.write((error.stack??error.code??error.message??'harness2_dsh_probe_failed')+'\n');exit(1);});});
}
