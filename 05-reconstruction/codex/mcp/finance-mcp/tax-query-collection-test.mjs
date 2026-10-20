// Real stdio -> HTTP -> Agent -> production query collector, synthetic CDP/ACL.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readdir,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {McpStdioClient} from './mcp-stdio-client.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../../..'),temp=join(root,'06-workbench','.agent-runs','query-mcp-tests');
const PRIVATE='SYNTHETIC_QUERY_BUSINESS_TRIPWIRE';
const safe=v=>assert.doesNotMatch(JSON.stringify(v),/SYNTHETIC_QUERY|targetId|frameId|loaderId|registrationRoot|profilePath|expression|fullUrl|authorization|cookie/i);
const url=p=>JSON.stringify(pathToFileURL(join(root,p)).href);
async function withBackend(callback){
  await mkdir(temp,{recursive:true});const directory=await mkdtemp(join(temp,'synthetic-'));let child,client,stopped,stderr='',stdout='';const events=[];
  try{
    const script=`const {taxQueryCollection}=await import(${url('06-workbench/server/agent-tools.mjs')});
      const {queryFixture}=await import(${url('06-workbench/test/tax-query-fixture.mjs')});
      const fixture=await queryFixture(${JSON.stringify(directory)},{collector:taxQueryCollection});
      const refreshed=await taxQueryCollection.refresh({artifactRef:fixture.artifactRef});
      process.send?.({type:'ready',result:refreshed});
      process.on('message',message=>{
        if(message?.type==='stats')process.send?.({type:'stats',requests:fixture.state.requests.length,
          resources:fixture.state.requests.map(r=>r.resource)});
        if(message?.type==='mode'){fixture.state.mode=message.mode;process.send?.({type:'mode-set'});}
      });
      await import(${url('06-workbench/server/server.mjs')});`;
    child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:join(root,'06-workbench'),
      env:{...process.env,WORKBENCH_DATA_DIR:join(directory,'database'),HOST:'127.0.0.1',PORT:'0'},stdio:['ignore','pipe','pipe','ipc']});
    stopped=new Promise(done=>{child.once('exit',done);child.once('error',done)});
    child.on('message',message=>events.push(message));child.stderr.on('data',chunk=>stderr+=chunk);
    const base=await new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('synthetic_backend_timeout')),15000);
      child.once('error',()=>{clearTimeout(timer);no(Error('synthetic_backend_spawn_failed'))});
      child.once('exit',()=>{clearTimeout(timer);no(Error('synthetic_backend_exited'))});
      child.stdout.on('data',chunk=>{stdout+=chunk;const match=stdout.match(/127\.0\.0\.1:(\d+)\//);if(match){clearTimeout(timer);yes('http://127.0.0.1:'+match[1]);}});
    });
    const ready=events.find(e=>e.type==='ready')?.result;safe(ready);assert.equal(ready?.status,'query_context_refreshed');
    client=new McpStdioClient(join(here,'server.mjs'),{cwd:here,env:{FINANCE_API_BASE:base},timeoutMs:20000}).start();await client.initialize('query-integration');
    const ipc=(type,payload={})=>new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('synthetic_ipc_timeout')),3000);
      const handler=message=>{if(message?.type===(type==='mode'?'mode-set':type)){clearTimeout(timer);child.off('message',handler);yes(message)}};
      child.on('message',handler);child.send({type,...payload});});
    await callback({client,contextRef:ready.contextRef,base,directory,stats:()=>ipc('stats'),mode:mode=>ipc('mode',{mode})});
    safe(stderr);safe(stdout);safe(client.stderr);
  }finally{if(client)await client.close();if(child&&child.exitCode===null&&child.signalCode===null)child.kill();if(stopped)await stopped;
    assert.equal(dirname(resolve(directory)),resolve(temp));await rm(directory,{recursive:true,force:true});}
}
async function call(client,name,args){const result=await client.call(name,args);safe(result);assert.equal(result.isError,false);return result.data;}
test('two MCP collections issue seven independent fresh requests each and compare only the same context',async()=>withBackend(async f=>{
  const list=await f.client.rpc('tools/list');assert.ok(list.result.tools.some(t=>t.name==='tax_query_collect'));
  assert.ok(!list.result.tools.some(t=>/query_refresh/.test(t.name)));
  const first=await call(f.client,'tax_query_collect',{contextRef:f.contextRef}),second=await call(f.client,'tax_query_collect',{contextRef:f.contextRef});
  assert.equal(first.status,'query_resources_observed');assert.equal(first.requestPerformedCount,7);assert.equal(first.responseCompleteCount,7);
  assert.equal(second.requestPerformedCount,7);assert.notEqual(first.runRef,second.runRef);assert.equal(first.periodVerified,false);
  assert.equal(first.resources.income_assessment.responseEnterpriseBound,false);assert.equal(first.resources.income_assessment.obligationVerified,false);
  const compared=await call(f.client,'tax_query_compare',{leftRef:first.runRef,rightRef:second.runRef});
  assert.equal(compared.status,'query_runs_compared');assert.equal(compared.independentRequests,true);assert.equal(compared.enterpriseEqual,true);
  assert.equal(compared.enterpriseProfileEqual,true);assert.equal(compared.incomeRowsCompared,false);
  assert.equal((await call(f.client,'tax_query_compare',{leftRef:first.runRef,rightRef:first.runRef})).status,'not_comparable');
  const stats=await f.stats();assert.equal(stats.requests,17);assert.deepEqual(stats.resources.slice(3,10),
    ['identity','getUserMsg','basic_profile','enterprise_profile','income_assessment','getUserMsg','identity']);
  assert.equal((await readdir(join(f.directory,'query-evidence'))).length,4);assert.deepEqual(await readdir(join(f.directory,'profile')),[]);
}));
test('MCP and HTTP reject caller URLs/parameters/headers and portal source refs before CDP requests',async()=>withBackend(async f=>{
  for(const args of [{contextRef:f.contextRef,url:PRIVATE},{contextRef:f.contextRef,body:PRIVATE},{contextRef:f.contextRef,headers:{token:PRIVATE}},
    {contextRef:'taxsource_'+'1'.repeat(48)}]){
    const result=await f.client.call('tax_query_collect',args);safe(result);assert.ok(result.isError||result.data?.status==='input_invalid');
  }
  const response=await fetch(f.base+'/agent/tools/tax_query_collect',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({contextRef:f.contextRef,url:PRIVATE})});const result=await response.json();safe(result);
  assert.ok(response.status>=400||result.status==='input_invalid'||result.result?.status==='input_invalid');assert.equal((await f.stats()).requests,3);
}));
test('MCP unknown active request retains lock and never publishes/retries a run',async()=>withBackend(async f=>{
  await f.mode('unknown');const first=await call(f.client,'tax_query_collect',{contextRef:f.contextRef});assert.equal(first.lockRetained,true);
  const second=await call(f.client,'tax_query_collect',{contextRef:f.contextRef});assert.equal(second.reason,'tax_collection_busy');
  assert.equal((await f.stats()).requests,4);assert.equal((await readdir(join(f.directory,'query-evidence'))).length,2);
}));
test('MCP never returns private non-JSON/backend error bodies for the fixed query tools',async()=>{
  const server=createServer((_req,res)=>{res.writeHead(503,{'content-type':'text/plain'});res.end(PRIVATE);});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));let client;
  try{client=new McpStdioClient(join(here,'server.mjs'),{cwd:here,env:{FINANCE_API_BASE:'http://127.0.0.1:'+server.address().port}}).start();
    await client.initialize('query-error-privacy');const result=await client.call('tax_query_collect',{contextRef:'taxquerycontext_'+'1'.repeat(48)});
    safe(result);assert.equal(result.isError,true);assert.equal(result.data.error,'query_backend_rejected');
  }finally{if(client)await client.close();await new Promise(done=>server.close(done));}
});
