import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createBudgetGateway} from '../../05-reconstruction/codex/harness2/budget-gateway.mjs';
import {createSandboxRelay} from '../scripts/harness2-sandbox-supervisor.mjs';
mkdirSync(resolve('.agent-runs'),{recursive:true});const root=mkdtempSync(resolve('.agent-runs/harness2-budget-'));
let upstreamCalls=0;
const success=async body=>{upstreamCalls++;assert.equal(body.model,'deepseek-flash');assert.equal(body.stream,false);return {status:200,body:{id:'synthetic-response',model:'deepseek-flash',choices:[{index:0,message:{role:'assistant',content:'Synthetic response'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}}};};
const config=name=>({socketPath:process.platform==='win32'?'\\\\.\\pipe\\harness2-'+randomUUID():join(root,name+'.sock'),ledgerPath:join(root,name+'.json'),apiKey:'SYNTHETIC-SECRET-DO-NOT-LOG',maxCalls:2,maxInputBytes:65536,maxOutputTokens:2048,maxUsd:3,inputUsdPerMillion:1,outputUsdPerMillion:4,maxWallMs:900000,transport:success});
const call=(socket,body,path='/v1/chat/completions')=>new Promise((ok,no)=>{const req=request({socketPath:socket,path,method:'POST',agent:false,headers:{'content-type':'application/json'}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>ok({status:res.statusCode,text}));});req.on('error',no);req.end(JSON.stringify(body));});
const body={model:'deepseek-flash',messages:[{role:'user',content:'Synthetic only'}],max_tokens:100};

// Explicit legacy/operator limits still work and cannot be reset on resume.
const c=config('resume'),gateway=createBudgetGateway(c);assert.throws(()=>createBudgetGateway(c),/ledger_in_use/);await gateway.listen();
assert.equal((await call(c.socketPath,{...body,model:'other'})).status,400);assert.equal((await call(c.socketPath,body,'/evil')).status,404);
assert.equal((await call(c.socketPath,{...body,max_tokens:-1})).status,400);
for(const bad of [[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.invalid/private'}}]}],[{role:'user',content:{file_id:'file'}}],[{role:'developer',content:'x'}]])assert.equal((await call(c.socketPath,{...body,messages:bad})).status,400);
assert.equal((await call(c.socketPath,body)).status,200);assert.equal(gateway.ledger.calls,1);await gateway.close();
const resumed=createBudgetGateway(c);await resumed.listen();assert.equal(resumed.ledger.calls,1);
const streamed=await call(c.socketPath,{...body,stream:true,stream_options:{include_usage:true}});assert.equal(streamed.status,200);assert.match(streamed.text,/data: \[DONE\]/);assert.match(streamed.text,/"completion_tokens":5/);
assert.equal((await call(c.socketPath,body)).status,429);assert.equal(upstreamCalls,2);await resumed.close();
assert.ok(!readFileSync(c.ledgerPath,'utf8').includes(c.apiKey));
assert.throws(()=>createBudgetGateway({...c,maxCalls:3}),/resume_binding_changed/);
const small=config('bytes');small.maxInputBytes=64;const bytesGate=createBudgetGateway(small);await bytesGate.listen();assert.equal((await call(small.socketPath,body)).status,413);assert.equal(bytesGate.ledger.calls,0);await bytesGate.close();
const u=config('unknown');u.transport=async()=>({status:200,body:{choices:[]}});const unknown=createBudgetGateway(u);await unknown.listen();await call(u.socketPath,body);assert.equal(unknown.ledger.stopped,'usage_unknown');assert.equal((await call(u.socketPath,body)).status,429);await unknown.close();
const b=config('cost');b.maxUsd=0.000001;const budget=createBudgetGateway(b);await budget.listen();assert.equal((await call(b.socketPath,body)).status,429);assert.equal(budget.ledger.calls,0);await budget.close();
const e=config('transport');e.transport=async()=>{throw Error('SYNTHETIC-SECRET-ERROR');};const failed=createBudgetGateway(e);await failed.listen();const error=await call(e.socketPath,body);assert.equal(error.status,502);assert.ok(!error.text.includes('SYNTHETIC-SECRET'));assert.equal(failed.ledger.stopped,'usage_unknown');await failed.close();
const n=config('negative');n.transport=async()=>({status:200,body:{usage:{prompt_tokens:-1,completion_tokens:0}}});const negative=createBudgetGateway(n);await negative.listen();await call(n.socketPath,body);assert.equal(negative.ledger.stopped,'usage_unknown');await negative.close();
const a=config('anthropic');const protocols=createBudgetGateway(a);await protocols.listen();await call(a.socketPath,body);
const message=await call(a.socketPath,{model:'deepseek-flash',system:[{type:'text',text:'Synthetic only'}],messages:[{role:'user',content:[{type:'text',text:'Synthetic task'}]}],max_tokens:5000,stream:true},'/anthropic/v1/messages');
assert.equal(message.status,200);assert.match(message.text,/event: message_start/);assert.match(message.text,/"output_tokens":5/);assert.equal(protocols.ledger.events[1].outputTokenBound,2048);assert.equal((await call(a.socketPath,body)).status,429);await protocols.close();

// Default relay is executor audit, not an implicit 64KiB/2K/call/cost gate.
const source=config('audit'),auditConfig={socketPath:source.socketPath,ledgerPath:source.ledgerPath,apiKey:source.apiKey};
const seen=[];const large='合成 only '.repeat(16000),largeReply='synthetic response '.repeat(10000);
const audit=createBudgetGateway({...auditConfig,transport:async value=>{seen.push(value);return {status:200,body:{id:'large-audit',model:'deepseek-flash',choices:[{index:0,message:{role:'assistant',content:largeReply,reasoning_content:large},finish_reason:'stop'}],usage:{prompt_tokens:200000,completion_tokens:50000}}};}});
await audit.listen();
const full={model:'deepseek-flash',messages:[{role:'system',content:large},...Array.from({length:101},()=>({role:'user',content:'synthetic'})),{role:'assistant',content:null,reasoning_content:large,tool_calls:[{id:'synthetic-call',type:'function',function:{name:'harness_status',arguments:JSON.stringify({synthetic:large})}}]},{role:'tool',content:large,tool_call_id:'synthetic-call'}],tools:Array.from({length:33},(_,i)=>({type:'function',function:{name:'synthetic_'+i,description:large,parameters:{type:'object'}}}))};
const accepted=await call(auditConfig.socketPath,full);assert.equal(accepted.status,200);assert.equal(JSON.parse(accepted.text).choices[0].message.content,largeReply);
assert.equal(Object.hasOwn(seen[0],'max_tokens'),false);assert.equal(Object.hasOwn(seen[0],'thinking'),false);assert.equal(Object.hasOwn(seen[0],'reasoning_effort'),false);
assert.equal(seen[0].messages[0].content,large);assert.equal(seen[0].messages[102].reasoning_content,large);assert.equal(seen[0].tools.length,33);
const high=await call(auditConfig.socketPath,{...body,max_tokens:131072,thinking:{type:'enabled'},reasoning_effort:'high'});assert.equal(high.status,200);assert.equal(seen[1].max_tokens,131072);assert.equal(seen[1].thinking.type,'enabled');assert.equal(seen[1].reasoning_effort,'high');
const noArtificialEffort=await call(auditConfig.socketPath,{model:'deepseek-flash',messages:[{role:'user',content:'synthetic'}],max_tokens:65536,thinking:{type:'adaptive'},output_config:{effort:'high'}},'/v1/messages');assert.equal(noArtificialEffort.status,200);assert.equal(seen[2].max_tokens,65536);assert.equal(seen[2].thinking.type,'enabled');assert.equal(seen[2].reasoning_effort,'high');
assert.equal(audit.ledger.mode,'audit');assert.equal(audit.ledger.role,'executor');assert.equal(audit.ledger.maxCalls,null);assert.equal(audit.ledger.maxInputBytes,null);assert.equal(audit.ledger.maxOutputTokens,null);assert.equal(audit.ledger.reservedUsd,null);assert.equal(audit.ledger.estimatedUsd,null);assert.equal(audit.ledger.actualBilledUsd,null);assert.equal(audit.ledger.stopped,null);
assert.ok(audit.ledger.events[0].inputBytes>65536);assert.equal(audit.ledger.events[0].inputTokenBound,null);assert.equal(audit.ledger.events[0].finishReason,'stop');assert.ok(audit.ledger.events[0].contentBytes>65536);assert.equal(audit.ledger.events[0].usage.inputTokens,200000);assert.equal(audit.ledger.events[0].outputTokenBound,null);
await audit.close();assert.ok(!readFileSync(auditConfig.ledgerPath,'utf8').includes(source.apiKey));
const errConfig=config('audit-error'),safe={socketPath:errConfig.socketPath,ledgerPath:errConfig.ledgerPath,apiKey:errConfig.apiKey};let errorCalls=0;
const auditErrors=createBudgetGateway({...safe,transport:async value=>{
  errorCalls++;if(errorCalls===1)return {status:429,body:{error:{code:'rate_limit',type:'provider_error',message:'Retry later; key '+safe.apiKey,authorization:'never-forward-this-header'}}};
  if(errorCalls===2)throw Error(safe.apiKey+' private transport detail');
  return success(value);
}});await auditErrors.listen();
const originalError=await call(safe.socketPath,body);assert.equal(originalError.status,429);assert.equal(JSON.parse(originalError.text).error.code,'rate_limit');assert.match(JSON.parse(originalError.text).error.message,/Retry later/);assert.ok(!originalError.text.includes(safe.apiKey));assert.ok(!originalError.text.includes('never-forward'));assert.equal(auditErrors.ledger.stopped,null);
const transient=await call(safe.socketPath,body);assert.equal(transient.status,502);assert.equal(auditErrors.ledger.stopped,null);assert.equal(auditErrors.ledger.usageUnknown,true);assert.ok(!transient.text.includes(safe.apiKey));
assert.equal((await call(safe.socketPath,body)).status,200);assert.equal(auditErrors.ledger.calls,3);assert.equal(auditErrors.ledger.events[2].usageStatus,'known');await auditErrors.close();
const resumedAudit=createBudgetGateway({...safe,transport:success});await resumedAudit.listen();assert.equal((await call(safe.socketPath,body)).status,200);assert.equal(resumedAudit.ledger.calls,4);await resumedAudit.close();assert.ok(!readFileSync(safe.ledgerPath,'utf8').includes(safe.apiKey));

// A disconnected model client cancels the admitted upstream, including through
// the sandbox forwarding handler. Test listeners use local Unix/pipe endpoints
// so the fixture requires no TCP permission. Completed requests stay intact.
const within=(promise,label)=>new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('synthetic_cancel_timeout:'+label)),3000);promise.then(value=>{clearTimeout(timer);ok(value);},error=>{clearTimeout(timer);no(error);});});
for(const loopback of [false,true]){
  const source=config(loopback?'cancel-loopback':'cancel-direct');let entered,observedAbort,completedSignal,calls=0;
  const started=new Promise(ok=>{entered=ok;}),aborted=new Promise(ok=>{observedAbort=ok;});
  const cancelGate=createBudgetGateway({socketPath:source.socketPath,ledgerPath:source.ledgerPath,apiKey:source.apiKey,transport:async(value,signal)=>{
    if(++calls===1){entered(signal);return new Promise((_,reject)=>signal.addEventListener('abort',()=>{observedAbort(signal);reject(Error('synthetic_client_cancelled'));},{once:true}));}
    completedSignal=signal;return success(value);
  }});
  let proxy,client;
  try{
    await cancelGate.listen();
    const proxySocket=loopback?config('cancel-proxy').socketPath:null;
    if(loopback){proxy=createSandboxRelay(source.socketPath);await new Promise(ok=>proxy.listen(proxySocket,ok));}
    const options={socketPath:proxySocket??source.socketPath,path:'/v1/chat/completions',method:'POST',agent:false,headers:{'content-type':'application/json'}};
    client=request(options);client.on('error',()=>{});client.end(JSON.stringify(body));
    const pendingSignal=await within(started,'started:'+loopback);assert.equal(pendingSignal.aborted,false);
    client.destroy();assert.equal((await within(aborted,'aborted:'+loopback)).aborted,true);
    const subsequent=await within(new Promise((ok,no)=>{const req=request(options,res=>{res.resume();res.on('end',()=>ok(res.statusCode));});req.on('error',no);req.end(JSON.stringify(body));}),'subsequent:'+loopback);
    assert.equal(subsequent,200);assert.equal(completedSignal.aborted,false);
    assert.equal(cancelGate.ledger.events[0].status,'transport_unknown');assert.equal(cancelGate.ledger.events[0].usageStatus,'unknown');assert.equal(cancelGate.ledger.usageUnknown,true);
    assert.equal(cancelGate.ledger.actualBilledUsd,null);assert.equal(cancelGate.ledger.stopped,null);assert.equal(cancelGate.ledger.events[1].usageStatus,'known');
  }finally{client?.destroy();if(proxy){proxy.closeAllConnections();await new Promise(ok=>proxy.close(ok));}await cancelGate.close();}
}
console.log('harness2-executor-relay: audit-only defaults, complete large messages/reasoning/tools/output, native request options, optional explicit limits, persisted ledger, SSE/Anthropic, client cancellation through sandbox relay and unknown/error handling passed; zero external model calls');
