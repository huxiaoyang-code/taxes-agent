// 真实 stdio → 合成 HTTP → Agent → 生产历史采集器及存储。
// 浏览器 CDP 和平台 ACL 检查只使用合成 fixtures。
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,readdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {McpStdioClient} from './mcp-stdio-client.mjs';
import {safe,PRIVATE} from '../../../../06-workbench/test/tax-history-fixture.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../../..');
const url=path=>JSON.stringify(pathToFileURL(join(root,path)).href);
async function withBackend(callback,mode='normal'){
  const parent=join(root,'06-workbench','.agent-runs','tax-history-mcp-temporary');await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(join(parent,'synthetic-'));let child,client,stopped,stderr='',stdout='';const events=[];
  try{
    const script=`
      const {makeFixture}=await import(${url('06-workbench/test/tax-history-fixture.mjs')});
      const {taxHistoryCollection}=await import(${url('06-workbench/server/agent-tools.mjs')});
      const f=await makeFixture(${JSON.stringify(directory)});
      const refreshed=await f.collector.refresh({artifactRef:f.artifactRef});
      if(refreshed.status!=='history_context_refreshed')throw Error('synthetic_refresh_failed');
      f.state.mode=${JSON.stringify(mode)};taxHistoryCollection.d=f.collector.d;
      process.send?.({type:'ready',contextRef:refreshed.contextRef});
      process.on('message',message=>{if(message?.type==='stats')process.send?.({type:'stats',requestCount:f.state.requests.length,
        historyRequestCount:f.state.requests.filter(r=>r.history).length,closeCount:f.state.closeCount});});
      await import(${url('06-workbench/server/server.mjs')});`;
    child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:join(root,'06-workbench'),
      env:{...process.env,WORKBENCH_DATA_DIR:join(directory,'database'),HOST:'127.0.0.1',PORT:'0'},stdio:['ignore','pipe','pipe','ipc']});
    stopped=new Promise(done=>{child.once('exit',done);child.once('error',done);});
    child.on('message',message=>events.push(message));child.stderr.on('data',chunk=>stderr+=chunk.toString());
    const base=await new Promise((yes,no)=>{
      const timer=setTimeout(()=>no(Error('synthetic_backend_start_timeout')),15000);
      child.once('error',e=>{clearTimeout(timer);no(e);});child.once('exit',code=>{clearTimeout(timer);no(Error('synthetic_backend_exit_'+code+': '+stderr));});
      child.stdout.on('data',chunk=>{stdout+=chunk.toString();const match=stdout.match(/127\.0\.0\.1:(\d+)\//);
        if(match){clearTimeout(timer);yes('http://127.0.0.1:'+match[1]);}});
    });
    const contextRef=events.find(e=>e.type==='ready')?.contextRef;assert.match(contextRef,/^taxhistorycontext_[a-f0-9]{48}$/);
    client=new McpStdioClient(join(here,'server.mjs'),{cwd:here,env:{FINANCE_API_BASE:base},timeoutMs:20000}).start();
    await client.initialize('synthetic-history');
    const stats=()=>new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('synthetic_stats_timeout')),3000);
      const handler=message=>{if(message?.type==='stats'){clearTimeout(timer);child.off('message',handler);yes(message);}};
      child.on('message',handler);child.send({type:'stats'});});
    await callback({client,contextRef,directory,stats});safe(stderr);safe(client.stderr);
  }finally{
    if(client)await client.close();if(child&&child.exitCode===null&&child.signalCode===null)child.kill();if(stopped)await stopped;
    assert.equal(dirname(resolve(directory)),resolve(parent));assert.match(directory.split(/[\\/]/).at(-1),/^synthetic-/);await rm(directory,{recursive:true,force:true});
  }
}
async function ok(client,name,args){const result=await client.call(name,args);safe(result);assert.equal(result.isError,false);return result.data;}
test('MCP history tools send two independent runs through HTTP/Agent and retain private duplicate rows',async()=>{
  await withBackend(async({client,contextRef,directory,stats})=>{
    const listed=await client.rpc('tools/list'),tools=listed.result.tools;
    for(const name of ['tax_history_collect','tax_history_compare'])assert.ok(tools.some(t=>t.name===name));
    assert.ok(!tools.some(t=>t.name==='tax_history_refresh'));assert.ok(!tools.some(t=>t.name==='tax_history_admin'));
    assert.deepEqual(Object.keys(tools.find(t=>t.name==='tax_history_collect').inputSchema.properties),['contextRef']);
    const a=await ok(client,'tax_history_collect',{contextRef}),b=await ok(client,'tax_history_collect',{contextRef});
    for(const result of [a,b]){assert.equal(result.status,'history_query_observed');assert.equal(result.requestPerformedCount,3);
      assert.equal(result.responseCompleteCount,3);assert.equal(result.rowCount,2);assert.equal(result.lockRetained,false);assert.equal(result.downstreamReady,false);}
    assert.notEqual(a.runRef,b.runRef);
    const compared=await ok(client,'tax_history_compare',{leftRef:a.runRef,rightRef:b.runRef});
    assert.equal(compared.status,'history_runs_compared');assert.equal(compared.contentMultisetEqual,true);assert.equal(compared.independentRequests,true);
    assert.equal(compared.recordIdentityVerified,false);assert.equal(compared.leftCoverage.allHistoryVerified,false);
    const counts=await stats();assert.equal(counts.historyRequestCount,2);assert.equal(counts.requestCount,8);
    assert.deepEqual(await readdir(join(directory,'profile')),[]);
    assert.equal((await ok(client,'tax_history_collect',{contextRef,body:{secret:PRIVATE}})).status,'input_invalid');
  });
});
test('MCP reports partial coverage without deriving another page or a complete history claim',async()=>{
  await withBackend(async({client,contextRef,stats})=>{
    const result=await ok(client,'tax_history_collect',{contextRef});assert.equal(result.status,'history_query_partial');
    assert.equal(result.capturedQueryCoverageComplete,false);assert.equal(result.consumable,false);assert.equal(result.allHistoryVerified,false);
    assert.equal((await stats()).historyRequestCount,1);
  },'partial');
});
test('MCP request unknown keeps the shared lock and emits no consumer ref or raw error',async()=>{
  await withBackend(async({client,contextRef,directory})=>{
    const result=await ok(client,'tax_history_collect',{contextRef});assert.equal(result.status,'history_collection_failed');
    assert.equal(result.runRef,undefined);assert.equal(result.lockRetained,true);assert.equal(result.requestPerformedUnknownCount,1);
    assert.deepEqual(await readdir(join(directory,'profile')),['YoushuCollectionLockV1.json']);
  },'cdp_timeout');
});
test('history backend transport errors remain fixed and use the bounded operation timeout',async()=>{
  const {callBackend}=await import('./backend.mjs');const originalFetch=globalThis.fetch,originalTimeout=AbortSignal.timeout;let timeout;
  AbortSignal.timeout=ms=>{timeout=ms;return originalTimeout(1000);};
  try{
    for(const bad of ['network','http','json','stream']){
      globalThis.fetch=async()=>{if(bad==='network')throw Error(PRIVATE);if(bad==='stream')return {async text(){throw Error(PRIVATE);}};
        return new Response(PRIVATE,{status:bad==='http'?500:200});};
      try{await callBackend('tax_history_collect',{contextRef:'synthetic'},{});assert.fail('must reject');}catch(error){safe({message:error.message,code:error.code,details:error.details});}
      assert.equal(timeout,180000);
    }
  }finally{globalThis.fetch=originalFetch;AbortSignal.timeout=originalTimeout;}
});
