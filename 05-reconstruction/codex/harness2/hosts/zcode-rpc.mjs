import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export async function runZcode(plan,{env,emit,timeoutMs,killTree,inspectEvent}){
  const ownGroup=process.platform!=='win32'&&env?.FINANCE_HARNESS2_SUPERVISED!=='1';
  const child=spawn(plan.native.command,[...plan.native.prefix,'app-server','--stdio','--cwd',plan.cwd],{cwd:plan.cwd,env,windowsHide:true,shell:false,detached:ownGroup,stdio:['pipe','pipe','pipe']});child.harness2OwnGroup=ownGroup;
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  let nextId=1,sessionId,buffer='',bytes=0,reason=null,innerErrors=0,approvals=0;
  const pending=new Map(),completion=Promise.withResolvers();completion.promise.catch(()=>{});
  const workspace={workspacePath:plan.cwd,workspaceKey:'harness2-synthetic-'+randomUUID()};
  const closed=new Promise(resolve=>child.once('close',(exitCode,signal)=>resolve({exitCode,signal})));
  const send=message=>{if(!child.stdin.destroyed)child.stdin.write(JSON.stringify(message)+'\n');};
  const stop=why=>{reason??=why;completion.reject(Error('harness2_zcode_'+why));killTree(child);child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();};
  const timer=timeoutMs==null?null:setTimeout(()=>stop('timeout'),timeoutMs),cancel=()=>stop('cancelled');
  process.once('SIGTERM',cancel);process.once('SIGINT',cancel);const exit=()=>killTree(child);process.once('exit',exit);
  function rpc(method,params={}){return new Promise((ok,no)=>{const id=nextId++,limit=method==='session/send'&&plan.mode==='run'?timeoutMs:Math.min(timeoutMs??15000,15000),t=limit==null?null:setTimeout(()=>{pending.delete(id);no(Error('harness2_zcode_rpc_timeout'));},limit);pending.set(id,{ok,no,t});send({id,method,params});});}
  child.stdout.on('data',chunk=>{
    bytes+=Buffer.byteLength(chunk);if(plan.outputLimit!==undefined&&bytes>plan.outputLimit){stop('output_limit');return;}buffer+=chunk;
    let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line.trim())continue;
      let frame;try{frame=JSON.parse(line);}catch{stop('invalid_protocol');return;}
      const errors=inspectEvent(frame);innerErrors+=errors.length;emit({type:'native_event',host:'zcode',event:frame,innerErrors:errors});
      if(frame.id!==undefined&&!frame.method){const request=pending.get(frame.id);if(request){pending.delete(frame.id);clearTimeout(request.t);frame.error?request.no(Error('harness2_zcode_rpc_error:'+JSON.stringify(frame.error))):request.ok(frame.result);}continue;}
      if(frame.id!==undefined&&frame.method){
        if(frame.method==='interaction/requestPermission'){approvals++;send({id:frame.id,result:{decision:'deny',reason:'Outside the explicitly allowlisted synthetic metadata tools; human approval unavailable.'}});}
        else send({id:frame.id,error:{code:-32601,message:'Harness2 synthetic client does not authorize this request'}});
        continue;
      }
      const event=frame.params?.event??frame.params;
      if(event?.type==='turn.completed')completion.resolve(event);
      if(event?.type==='turn.failed')completion.reject(Error('harness2_zcode_turn_failed'));
    }
  });
  child.stderr.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(plan.outputLimit!==undefined&&bytes>plan.outputLimit)stop('output_limit');else process.stderr.write(chunk);});
  child.on('error',error=>{completion.reject(error);for(const r of pending.values()){clearTimeout(r.t);r.no(error);}pending.clear();});
  child.on('close',()=>{completion.reject(Error('harness2_zcode_closed'));for(const r of pending.values()){clearTimeout(r.t);r.no(Error('harness2_zcode_closed'));}pending.clear();});
  try{
    const created=await rpc('session/create',{workspace,mode:'build',model:{providerId:plan.providerId,modelId:'deepseek-flash',options:{}},titleGenerationEnabled:false,toolAllowlist:plan.allowedTools,dynamicWorkflowEnabled:false});
    sessionId=created.session?.sessionId??created.session?.id??created.sessionId;if(!sessionId)throw Error('harness2_zcode_session_missing');
    const selected=created.settings?.model?.current,available=created.settings?.model?.available;
    if(selected?.providerId!==plan.providerId||selected?.modelId!=='deepseek-flash'||created.settings?.mode?.current!=='build'||available?.length!==1||(plan.maxOutputTokens!==undefined&&available[0].maxOutputTokens!==plan.maxOutputTokens))throw Error('harness2_zcode_model_preselection_unproven');
    if(created.projection?.turnCount!==0||created.projection?.totalTokenCount!==0)throw Error('harness2_zcode_unexpected_initial_model_activity');
    emit({type:'model_preselection',host:'zcode',providerId:selected.providerId,modelId:selected.modelId,reasoningLevel:selected.options?.reasoningLevel??null,thoughtLevel:created.settings?.thoughtLevel?.current??null,maxOutputTokens:available[0].maxOutputTokens??null,outputLimitExplicit:plan.maxOutputTokens!==undefined,turnCount:0,totalTokenCount:0,modelInvoked:false});
    await rpc('session/subscribe',{sessionId,deliveryKind:'desktop-continuous',includeSnapshot:true});
    if(plan.mode==='run'){
      await rpc('session/send',{sessionId,content:plan.task});await completion.promise;
      await rpc('session/read',{sessionId});
    }else{
      const mcp=await rpc('mcp/list',{workspace});
      emit({type:'native_probe',host:'zcode',probe:plan.probe,mcp,modelInvoked:false});
      if(mcp?.statuses?.finance?.status!=='connected'||mcp.statuses.finance.transport!=='stdio'||mcp.statuses.finance.toolCount!==plan.expectedMcpTools.length)throw Error('harness2_zcode_mcp_unproven');
    }
    await rpc('session/close',{sessionId});child.stdin.end();
    const closeTimer=setTimeout(()=>stop('eof_close_timeout'),3000);const result=await closed;clearTimeout(closeTimer);
    const status=reason??(result.exitCode!==0?'process_failed':approvals?'permission_denied':innerErrors?'completed_with_tool_errors':'completed');
    emit({type:'host_result',host:'zcode',status,exitCode:result.exitCode,innerErrorCount:innerErrors,approvalRequests:approvals,modelInvoked:plan.mode==='run',probe:plan.probe});return {status,exitCode:result.exitCode,innerErrorCount:innerErrors};
  }finally{
    clearTimeout(timer);for(const request of pending.values()){clearTimeout(request.t);request.no(Error('harness2_zcode_stopped'));}pending.clear();process.removeListener('SIGTERM',cancel);process.removeListener('SIGINT',cancel);process.removeListener('exit',exit);killTree(child);
  }
}
