// A single experiment admission gate; all roles must use this same instance.
// Credentials stay here, outside the candidate namespace. Reservations are never
// refunded, so unknown usage cannot silently create additional spend capacity.
import {createServer} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {writeFileSync,existsSync,renameSync,readFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {decodeAnthropicRequest,encodeAnthropicResponse} from './hosts/anthropic-codec.mjs';
function validMessages(messages,tools){
  if(!Array.isArray(messages)||!messages.length||messages.length>100)return false;
  let calls=0;
  for(const message of messages){
    if(!message||typeof message!=='object'||!['system','user','assistant','tool'].includes(message.role)||Object.keys(message).some(k=>!['role','content','tool_calls','tool_call_id','name','reasoning_content'].includes(k)))return false;
    if(message.content!==null&&typeof message.content!=='string'&&(!Array.isArray(message.content)||message.content.length>32||message.content.some(block=>!block||block.type!=='text'||typeof block.text!=='string'||Object.keys(block).some(k=>!['type','text'].includes(k)))))return false;
    if(typeof message.content==='string'&&Buffer.byteLength(message.content)>65536)return false;
    for(const field of ['tool_call_id','name'])if(message[field]!==undefined&&(typeof message[field]!=='string'||message[field].length>200))return false;
    if(message.reasoning_content!==undefined&&(typeof message.reasoning_content!=='string'||message.reasoning_content.length>65536))return false;
    if(message.tool_calls!==undefined){
      if(message.role!=='assistant'||!Array.isArray(message.tool_calls)||message.tool_calls.length>16)return false;
      for(const call of message.tool_calls){calls++;if(calls>64||call?.type!=='function'||typeof call.id!=='string'||call.id.length>200||!call.function||typeof call.function.name!=='string'||!/^[A-Za-z0-9_:-]{1,200}$/.test(call.function.name)||typeof call.function.arguments!=='string'||call.function.arguments.length>32768||Object.keys(call).some(k=>!['id','type','function'].includes(k))||Object.keys(call.function).some(k=>!['name','arguments'].includes(k)))return false;}
    }
  }
  if(tools!==undefined&&(!Array.isArray(tools)||tools.length>32||tools.some(tool=>tool?.type!=='function'||Object.keys(tool).some(k=>!['type','function'].includes(k))||!tool.function||typeof tool.function.name!=='string'||!/^[A-Za-z0-9_:-]{1,200}$/.test(tool.function.name)||Object.keys(tool.function).some(k=>!['name','description','parameters','strict'].includes(k)))))return false;
  return true;
}
export function createBudgetGateway({socketPath,ledgerPath,apiKey,model='deepseek-flash',maxCalls,maxInputBytes,maxOutputTokens,maxUsd,inputUsdPerMillion,outputUsdPerMillion,maxWallMs,transport}){
  for(const value of [maxCalls,maxInputBytes,maxOutputTokens,maxWallMs])if(!Number.isSafeInteger(value)||value<1)throw Error('harness2_budget_integer_required');
  for(const value of [maxUsd,inputUsdPerMillion,outputUsdPerMillion])if(!Number.isFinite(value)||value<=0)throw Error('harness2_budget_price_required');
  if(model!=='deepseek-flash'||typeof apiKey!=='string'||!apiKey||existsSync(socketPath))throw Error('harness2_gateway_config_invalid');
  const fixed={version:'finance-harness2-budget/1',socketPath,model,maxCalls,maxInputBytes,maxOutputTokens,maxUsd,inputUsdPerMillion,outputUsdPerMillion,maxWallMs};
  const ledger=existsSync(ledgerPath)?JSON.parse(readFileSync(ledgerPath,'utf8')):{...fixed,calls:0,reservedUsd:0,actualTokens:null,actualCostUsd:null,stopped:null,started:Date.now(),events:[]};
  if(Object.keys(fixed).some(key=>ledger[key]!==fixed[key])||!Number.isSafeInteger(ledger.calls)||ledger.calls!==ledger.events.length||ledger.calls>maxCalls||!Number.isFinite(ledger.reservedUsd)||ledger.reservedUsd<0||ledger.reservedUsd>maxUsd||!Number.isFinite(ledger.started))throw Error('harness2_budget_resume_binding_changed');
  if(ledger.events.some(event=>event.status==='reserved'))ledger.stopped='prior_usage_unknown';
  const lockPath=ledgerPath+'.lock';let lock;
  try{lock=openSync(lockPath,'wx',0o600);writeFileSync(lock,JSON.stringify({pid:process.pid,socketPath}));}catch{throw Error('harness2_budget_ledger_in_use');}
  const save=()=>{const temp=ledgerPath+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(ledger,null,2),{flag:'wx',mode:0o600});renameSync(temp,ledgerPath);};save();
  const send=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  const active=new Set();
  const upstream=transport??((body,signal)=>new Promise((ok,no)=>{const req=httpsRequest({hostname:'api.deepseek.com',port:443,path:'/chat/completions',method:'POST',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},signal,timeout:Math.min(120000,maxWallMs)},res=>{let chunks=[],bytes=0;res.on('data',chunk=>{bytes+=chunk.length;if(bytes>8*1024*1024){req.destroy(Error('response_limit'));return;}chunks.push(chunk);});res.on('end',()=>{try{ok({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{no(Error('invalid_response'));}});});req.on('timeout',()=>req.destroy(Error('upstream_timeout')));req.on('error',no);req.end(JSON.stringify(body));}));
  const server=createServer(async(req,res)=>{
    const anthropic=['/anthropic/v1/messages','/v1/messages'].includes(req.url);
    if(req.method!=='POST'||(!anthropic&&req.url!=='/v1/chat/completions'))return send(res,404,{error:'route_not_allowed'});
    let bytes=0,chunks=[];
    for await(const chunk of req){bytes+=chunk.length;if(bytes>maxInputBytes)return send(res,413,{error:'input_budget_exceeded'});chunks.push(chunk);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send(res,400,{error:'invalid_json'});}
    if(anthropic){try{body=decodeAnthropicRequest(body);}catch{return send(res,400,{error:'anthropic_protocol_unsupported'});}}
    if(body.model!==model||!validMessages(body.messages,body.tools))return send(res,400,{error:'fixed_model_and_text_message_limits_required'});
    const streaming=body.stream===true;
    if(ledger.stopped||Date.now()-ledger.started>maxWallMs||ledger.calls>=maxCalls)return send(res,429,{error:'experiment_stopped'});
    // JSON UTF-8 bytes bound tokenizer text bytes conservatively, plus 4096
    // wrapper tokens. Refuse optional raw prompt/file/remote data surfaces.
    if(Object.keys(body).some(k=>!['model','messages','tools','tool_choice','temperature','top_p','max_tokens','max_completion_tokens','stream','stream_options','response_format','reasoning_effort','thinking'].includes(k)))return send(res,400,{error:'request_field_forbidden'});
    if(body.reasoning_effort!==undefined&&body.reasoning_effort!=='low')return send(res,400,{error:'reasoning_level_forbidden'});
    if(body.thinking!==undefined&&(!body.thinking||!['enabled','disabled'].includes(body.thinking.type)||Object.keys(body.thinking).some(key=>key!=='type')))return send(res,400,{error:'thinking_configuration_forbidden'});
    const desired=body.max_tokens??body.max_completion_tokens??maxOutputTokens;
    if(!Number.isSafeInteger(desired)||desired<1)return send(res,400,{error:'output_budget_invalid'});
    const requested=Math.min(desired,maxOutputTokens);
    delete body.max_completion_tokens;delete body.stream_options;body.max_tokens=requested;body.stream=false;
    const normalizedBytes=Buffer.byteLength(JSON.stringify(body));if(normalizedBytes>maxInputBytes)return send(res,413,{error:'normalized_input_budget_exceeded'});
    const inputBound=Math.max(bytes,normalizedBytes)+4096,reserved=(inputBound*inputUsdPerMillion+requested*outputUsdPerMillion)/1e6;
    if(ledger.reservedUsd+reserved>maxUsd)return send(res,429,{error:'cost_budget_exceeded'});
    const event={call:++ledger.calls,reservedUsd:reserved,inputTokenBound:inputBound,outputTokenBound:requested,status:'reserved',usage:null};
    ledger.reservedUsd+=reserved;ledger.events.push(event);save();
    const abort=new AbortController();active.add(abort);
    const timer=setTimeout(()=>abort.abort(),Math.min(120000,Math.max(1,maxWallMs-(Date.now()-ledger.started))));
    try{const result=await Promise.race([upstream(body,abort.signal),new Promise((_,reject)=>abort.signal.addEventListener('abort',()=>reject(Error('budget_timeout')),{once:true}))]);const usage=result.body?.usage;
      event.status=result.status===200?'completed':'upstream_error';
      event.responseModel=typeof result.body?.model==='string'&&/^[a-zA-Z0-9_./:-]{1,120}$/.test(result.body.model)?result.body.model:null;
      if(!usage||!Number.isSafeInteger(usage.prompt_tokens)||usage.prompt_tokens<0||!Number.isSafeInteger(usage.completion_tokens)||usage.completion_tokens<0)ledger.stopped='usage_unknown';
      else if(usage.prompt_tokens>inputBound||usage.completion_tokens>requested)ledger.stopped='usage_exceeds_conservative_bound';
      else event.usage={inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens};
      if(result.status!==200)ledger.stopped='upstream_error';save();
      if(result.status!==200){send(res,result.status,{error:'upstream_error'});return;}
      if(anthropic&&result.status===200){const encoded=encodeAnthropicResponse(result.body,{stream:streaming});res.writeHead(200,{'content-type':encoded.contentType});res.end(encoded.body);}
      else if(streaming&&result.status===200){
        const r=result.body,message=r.choices?.[0]?.message??{},delta={...message};
        if(delta.tool_calls)delta.tool_calls=delta.tool_calls.map((value,index)=>({...value,index}));
        const base={id:r.id,object:'chat.completion.chunk',created:r.created,model:r.model};
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
        res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:r.choices?.[0]?.finish_reason??'stop'}],usage:r.usage})+'\n\n');
        res.end('data: [DONE]\n\n');
      }else send(res,result.status,result.body);
    }catch{event.status='transport_unknown';ledger.stopped='usage_unknown';save();send(res,502,{error:'upstream_usage_unknown'});}
    finally{clearTimeout(timer);active.delete(abort);}
  });
  return {server,ledger,listen:()=>new Promise((ok,no)=>{server.once('error',no);server.listen(socketPath,()=>ok());}),close:()=>{for(const controller of active)controller.abort();return new Promise(ok=>server.close(()=>{closeSync(lock);unlinkSync(lockPath);ok();}));}};
}
