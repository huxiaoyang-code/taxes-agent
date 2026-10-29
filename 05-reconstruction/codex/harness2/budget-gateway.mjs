// Executor-only DeepSeek relay. Limits are opt-in operator configuration.
// The optimizer uses Codex independently and never passes through this relay.
import {createServer} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {writeFileSync,existsSync,renameSync,readFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {decodeAnthropicRequest,encodeAnthropicResponse} from './hosts/anthropic-codec.mjs';

function validMessages(messages,tools){
  if(!Array.isArray(messages)||!messages.length)return false;
  for(const message of messages){
    if(!message||typeof message!=='object'||!['system','user','assistant','tool'].includes(message.role)||Object.keys(message).some(k=>!['role','content','tool_calls','tool_call_id','name','reasoning_content'].includes(k)))return false;
    if(message.content!==null&&typeof message.content!=='string'&&(!Array.isArray(message.content)||message.content.some(block=>!block||block.type!=='text'||typeof block.text!=='string'||Object.keys(block).some(k=>!['type','text'].includes(k)))))return false;
    for(const field of ['tool_call_id','name','reasoning_content'])if(message[field]!==undefined&&typeof message[field]!=='string')return false;
    if(message.tool_calls!==undefined){
      if(message.role!=='assistant'||!Array.isArray(message.tool_calls))return false;
      for(const call of message.tool_calls)if(call?.type!=='function'||typeof call.id!=='string'||!call.function||typeof call.function.name!=='string'||!/^[A-Za-z0-9_:-]+$/.test(call.function.name)||typeof call.function.arguments!=='string'||Object.keys(call).some(k=>!['id','type','function'].includes(k))||Object.keys(call.function).some(k=>!['name','arguments'].includes(k)))return false;
    }
  }
  if(tools!==undefined&&(!Array.isArray(tools)||tools.some(tool=>tool?.type!=='function'||Object.keys(tool).some(k=>!['type','function'].includes(k))||!tool.function||typeof tool.function.name!=='string'||!/^[A-Za-z0-9_:-]+$/.test(tool.function.name)||Object.keys(tool.function).some(k=>!['name','description','parameters','strict'].includes(k)))))return false;
  return true;
}
const finitePositive=value=>Number.isFinite(value)&&value>0;
const integerPositive=value=>Number.isSafeInteger(value)&&value>0;
const knownUsage=usage=>usage&&Number.isSafeInteger(usage.prompt_tokens)&&usage.prompt_tokens>=0&&Number.isSafeInteger(usage.completion_tokens)&&usage.completion_tokens>=0;
export function createBudgetGateway({socketPath,ledgerPath,apiKey,model='deepseek-flash',maxCalls,maxInputBytes,maxOutputTokens,maxUsd,inputUsdPerMillion,outputUsdPerMillion,maxWallMs,transport}){
  for(const value of [maxCalls,maxInputBytes,maxOutputTokens,maxWallMs])if(value!==undefined&&!integerPositive(value))throw Error('harness2_budget_integer_required');
  for(const value of [maxUsd,inputUsdPerMillion,outputUsdPerMillion])if(value!==undefined&&!finitePositive(value))throw Error('harness2_budget_price_required');
  if(maxUsd!==undefined&&(!finitePositive(inputUsdPerMillion)||!finitePositive(outputUsdPerMillion)))throw Error('harness2_explicit_budget_prices_required');
  if(typeof socketPath!=='string'||typeof ledgerPath!=='string'||model!=='deepseek-flash'||typeof apiKey!=='string'||!apiKey||existsSync(socketPath))throw Error('harness2_gateway_config_invalid');
  const fixed={version:'finance-harness2-executor-relay/2',socketPath,model,maxCalls:maxCalls??null,maxInputBytes:maxInputBytes??null,maxOutputTokens:maxOutputTokens??null,maxUsd:maxUsd??null,inputUsdPerMillion:inputUsdPerMillion??null,outputUsdPerMillion:outputUsdPerMillion??null,maxWallMs:maxWallMs??null};
  const ledger=existsSync(ledgerPath)?JSON.parse(readFileSync(ledgerPath,'utf8')):{...fixed,role:'executor',mode:maxUsd===undefined&&maxCalls===undefined&&maxInputBytes===undefined&&maxOutputTokens===undefined&&maxWallMs===undefined?'audit':'explicit_limits',calls:0,reservedUsd:maxUsd===undefined?null:0,estimatedUsd:inputUsdPerMillion!==undefined&&outputUsdPerMillion!==undefined?0:null,actualCostUsd:null,actualBilledUsd:null,stopped:null,started:Date.now(),events:[]};
  if(Object.keys(fixed).some(key=>ledger[key]!==fixed[key])||ledger.role!=='executor'||!Number.isSafeInteger(ledger.calls)||ledger.calls!==ledger.events.length||(maxCalls!==undefined&&ledger.calls>maxCalls)||!Number.isFinite(ledger.started)||(maxUsd!==undefined&&(!Number.isFinite(ledger.reservedUsd)||ledger.reservedUsd<0||ledger.reservedUsd>maxUsd)))throw Error('harness2_budget_resume_binding_changed');
  if(ledger.events.some(event=>event.status==='reserved')){ledger.usageUnknown=true;if(maxUsd!==undefined)ledger.stopped='prior_usage_unknown';}
  const lockPath=ledgerPath+'.lock';let lock;
  try{lock=openSync(lockPath,'wx',0o600);writeFileSync(lock,JSON.stringify({pid:process.pid,socketPath}));}catch{throw Error('harness2_budget_ledger_in_use');}
  const save=()=>{const temp=ledgerPath+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(ledger,null,2),{flag:'wx',mode:0o600});renameSync(temp,ledgerPath);};save();
  const send=(res,status,value)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  const publicError=value=>{
    const source=value?.error??value;
    const redact=text=>String(text).split(apiKey).join('[REDACTED]').replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g,'[REDACTED]');
    const out={};if(source&&typeof source==='object'){for(const field of ['code','type','message'])if(['string','number'].includes(typeof source[field]))out[field]=redact(source[field]);}
    else if(typeof source==='string')out.message=redact(source);
    return Object.keys(out).length?out:{code:'upstream_error',message:'Upstream returned a non-success response.'};
  };
  const active=new Set();
  const upstream=transport??((body,signal)=>new Promise((ok,no)=>{
    const req=httpsRequest({hostname:'api.deepseek.com',port:443,path:'/chat/completions',method:'POST',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},signal},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>{try{ok({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{no(Error('invalid_response'));}});
      res.on('error',no);
    });
    req.on('error',no);req.end(JSON.stringify(body));
  }));
  const server=createServer(async(req,res)=>{
    const anthropic=['/anthropic/v1/messages','/v1/messages'].includes(req.url);
    if(req.method!=='POST'||(!anthropic&&req.url!=='/v1/chat/completions'))return send(res,404,{error:'route_not_allowed'});
    let bytes=0;const chunks=[];
    try{for await(const chunk of req){bytes+=chunk.length;if(maxInputBytes!==undefined&&bytes>maxInputBytes)return send(res,413,{error:'input_budget_exceeded'});chunks.push(chunk);}}catch{return;}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send(res,400,{error:'invalid_json'});}
    if(anthropic){try{body=decodeAnthropicRequest(body);}catch{return send(res,400,{error:'anthropic_protocol_unsupported'});}}
    if(body.model!==model||!validMessages(body.messages,body.tools))return send(res,400,{error:'fixed_model_and_text_message_limits_required'});
    const streaming=body.stream===true;
    if(ledger.stopped||(maxWallMs!==undefined&&Date.now()-ledger.started>maxWallMs)||(maxCalls!==undefined&&ledger.calls>=maxCalls))return send(res,429,{error:'experiment_stopped'});
    if(Object.keys(body).some(k=>!['model','messages','tools','tool_choice','temperature','top_p','max_tokens','max_completion_tokens','stream','stream_options','response_format','reasoning_effort','thinking'].includes(k)))return send(res,400,{error:'request_field_forbidden'});
    if(body.reasoning_effort!==undefined&&!['none','low','high','max'].includes(body.reasoning_effort))return send(res,400,{error:'reasoning_level_forbidden'});
    if(body.thinking!==undefined&&(!body.thinking||!['enabled','disabled'].includes(body.thinking.type)||Object.keys(body.thinking).some(key=>key!=='type')))return send(res,400,{error:'thinking_configuration_forbidden'});
    const desired=body.max_tokens??body.max_completion_tokens;
    if(desired!==undefined&&!integerPositive(desired))return send(res,400,{error:'output_budget_invalid'});
    const requested=maxOutputTokens===undefined?desired:Math.min(desired??maxOutputTokens,maxOutputTokens);
    if(requested!==undefined)body.max_tokens=requested;else delete body.max_tokens;
    delete body.max_completion_tokens;delete body.stream_options;body.stream=false;
    const normalizedBytes=Buffer.byteLength(JSON.stringify(body));
    if(maxInputBytes!==undefined&&normalizedBytes>maxInputBytes)return send(res,413,{error:'normalized_input_budget_exceeded'});
    if(maxUsd!==undefined&&requested===undefined)return send(res,400,{error:'explicit_output_limit_required_for_cost_budget'});
    const inputBound=maxUsd===undefined?null:Math.max(bytes,normalizedBytes)+4096;
    const reserved=maxUsd===undefined?null:(inputBound*inputUsdPerMillion+requested*outputUsdPerMillion)/1e6;
    if(maxUsd!==undefined&&ledger.reservedUsd+reserved>maxUsd)return send(res,429,{error:'cost_budget_exceeded'});
    const event={call:++ledger.calls,inputBytes:bytes,normalizedInputBytes:normalizedBytes,inputTokenBound:inputBound,outputTokenBound:requested??null,reservedUsd:reserved,status:'reserved',usage:null};
    if(reserved!==null)ledger.reservedUsd+=reserved;ledger.events.push(event);save();
    const abort=new AbortController();active.add(abort);
    const clientClosed=()=>{if(!res.writableEnded)abort.abort();};
    res.once('close',clientClosed);if(res.destroyed)clientClosed();
    let onAbort;
    const timer=maxWallMs===undefined?null:setTimeout(()=>abort.abort(),Math.max(1,maxWallMs-(Date.now()-ledger.started)));
    try{
      if(abort.signal.aborted)throw Error('upstream_aborted');
      const interrupted=new Promise((_,reject)=>{onAbort=()=>reject(Error('upstream_aborted'));abort.signal.addEventListener('abort',onAbort,{once:true});});
      const result=await Promise.race([upstream(body,abort.signal),interrupted]);
      const usage=result.body?.usage;event.status=result.status===200?'completed':'upstream_error';
      event.responseModel=typeof result.body?.model==='string'&&/^[a-zA-Z0-9_./:-]+$/.test(result.body.model)?result.body.model:null;
      const choice=result.body?.choices?.[0],message=choice?.message;
      event.finishReason=typeof choice?.finish_reason==='string'?choice.finish_reason:null;
      event.contentBytes=typeof message?.content==='string'?Buffer.byteLength(message.content):null;
      event.reasoningBytes=typeof message?.reasoning_content==='string'?Buffer.byteLength(message.reasoning_content):null;
      if(!knownUsage(usage)){event.usageStatus='unknown';ledger.usageUnknown=true;if(maxUsd!==undefined)ledger.stopped='usage_unknown';}
      else{
        event.usage={inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens};
        const exceeds=(inputBound!==null&&usage.prompt_tokens>inputBound)||(requested!==undefined&&usage.completion_tokens>requested);
        event.usageStatus=exceeds?'exceeds_bound':'known';if(exceeds&&maxUsd!==undefined)ledger.stopped='usage_exceeds_conservative_bound';
        if(ledger.estimatedUsd!==null)ledger.estimatedUsd+=(usage.prompt_tokens*inputUsdPerMillion+usage.completion_tokens*outputUsdPerMillion)/1e6;
      }
      if(result.status!==200){event.error=publicError(result.body);if(maxUsd!==undefined)ledger.stopped='upstream_error';}save();
      if(result.status!==200){send(res,result.status,{error:event.error});return;}
      if(anthropic){const encoded=encodeAnthropicResponse(result.body,{stream:streaming});res.writeHead(200,{'content-type':encoded.contentType});res.end(encoded.body);}
      else if(streaming){
        const r=result.body,delta={...(r.choices?.[0]?.message??{})};if(delta.tool_calls)delta.tool_calls=delta.tool_calls.map((value,index)=>({...value,index}));
        const base={id:r.id,object:'chat.completion.chunk',created:r.created,model:r.model};
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
        res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:r.choices?.[0]?.finish_reason??'stop'}],usage:r.usage})+'\n\n');
        res.end('data: [DONE]\n\n');
      }else send(res,200,result.body);
    }catch{event.status='transport_unknown';event.usageStatus='unknown';ledger.usageUnknown=true;if(maxUsd!==undefined)ledger.stopped='usage_unknown';save();send(res,502,{error:{code:'upstream_usage_unknown',message:'Upstream transport failed; usage is unknown.'}});}
    finally{if(timer!==null)clearTimeout(timer);res.removeListener('close',clientClosed);if(onAbort)abort.signal.removeEventListener('abort',onAbort);active.delete(abort);}
  });
  return {server,ledger,listen:()=>new Promise((ok,no)=>{server.once('error',no);server.listen(socketPath,()=>ok());}),close:()=>{for(const controller of active)controller.abort();return new Promise(ok=>server.close(()=>{closeSync(lock);unlinkSync(lockPath);ok();}));}};
}
