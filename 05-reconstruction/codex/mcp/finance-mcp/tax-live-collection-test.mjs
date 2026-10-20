// Real MCP stdio -> HTTP -> Agent -> production collector and evidence store.
// Only CDP and OS-specific ACL checks are synthetic; no browser/registry is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readdir, rm} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {McpStdioClient} from './mcp-stdio-client.mjs';

const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../../..');
const temporaryParent=join(root,'06-workbench','.agent-runs','tax-live-mcp-temporary');
const moduleUrl=name=>JSON.stringify(pathToFileURL(join(root,'06-workbench','server',name)).href);
const PRIVATE='PRIVATE_SYNTHETIC_BUSINESS_TRIPWIRE';
const safe=value=>assert.doesNotMatch(JSON.stringify(value),/PRIVATE_SYNTHETIC|targetId|frameId|loaderId|registrationRoot|profilePath|webSocketDebuggerUrl|authorization|cookie/i);

async function withBackend(callback,{mode='normal'}={}){
  await mkdir(temporaryParent,{recursive:true});const directory=await mkdtemp(join(temporaryParent,'synthetic-'));
  let child,client,stopped,stderr='',stdout='';const events=[];
  try{
    const script=`
      import assert from 'node:assert/strict';
      import {createHash} from 'node:crypto';
      import {join} from 'node:path';
      import {mkdir,lstat} from 'node:fs/promises';
      const {TaxCollectionStore,collectionLock}=await import(${moduleUrl('tax-collection-local.mjs')});
      const {businessProjection}=await import(${moduleUrl('tax-collection-shape.mjs')});
      const {taxLiveCollection}=await import(${moduleUrl('agent-tools.mjs')});
      const directory=${JSON.stringify(directory)},privateValue=${JSON.stringify(PRIVATE)},mode=${JSON.stringify(mode)};
      const security={testStorage:true,async secureDirectory(){},async verifyDirectory(p){assert.ok((await lstat(p)).isDirectory())},
        async verifyFile(p){assert.ok((await lstat(p)).isFile())}};
      const store=new TaxCollectionStore({root:join(directory,'evidence'),security}),profile=join(directory,'synthetic-profile');
      await mkdir(profile);
      const identityBody={Response:{Data:{userinfo:{user_id:privateValue+'_USER',user_type:'2',reg_number:privateValue+'_REG',
        company_name:privateValue+'_COMPANY',enterprise_type:'synthetic',taxpayerStatusCode:'synthetic',relatedType:'synthetic'},
        [privateValue]:privateValue}}};
      const filingBody={Response:{Data:{wsbxxGrid:[{sbb:privateValue+'_FORM',sbqx:privateValue+'_DEADLINE',zt:privateValue+'_STATUS',
        ztBm:'synthetic',zsxmDm:'synthetic',cddz:'/synthetic/page?token='+privateValue,yyfwqdz:'',
        [privateValue]:privateValue}],dbt:'synthetic',tbsl:1,[privateValue]:privateValue}}};
      const identity={resource:'identity',recipe:{path:'/mhzx/api/mh/mhsy/getUserInfo',method:'GET',body:null,queryTimestamp:true},
        projection:businessProjection(identityBody,'identity')};
      const filing={resource:'current_filing',recipe:{path:'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx',method:'POST',body:{Csbz:'synthetic'},queryTimestamp:true},
        projection:businessProjection(filingBody,'current_filing')};
      const source={version:1,authorizedNavigation:true,handoffMode:'quarantined_reader_new_navigation',readerStoppedConfirmed:true,
        registrationRef:'taxr_'+'1'.repeat(48),
        registrationRoot:join(directory,'synthetic-checkout','.agent-runs','tax-browser-registry'),
        pageRef:'taxpage_'+'2'.repeat(48),targetId:privateValue+'_TARGET',frameId:privateValue+'_FRAME',loaderId:privateValue+'_LOADER',
        browserKey:'a'.repeat(64),documentUrlDigest:createHash('sha256').update('https://etax.fujian.chinatax.gov.cn:8443/loginb/').digest('hex'),
        capturedAt:1000,identity,filing};
      const sourceRef=await store.save('source',source);
      const otherSourceRef=mode==='other_source'?await store.save('source',{...source,pageRef:'taxpage_'+'3'.repeat(48)}):null;
      let requestCount=0,openCount=0,closeCount=0,detachCount=0;
      taxLiveCollection.d={store,enabled:true,now:()=>mode==='expired'?2000001:1001,
        acquireLock:(profilePath,options)=>collectionLock(profilePath,{...options,security}),
        openDiagnostic:async()=>{openCount++;const handlers=new Map();return {localScope:{profilePath:profile,browserKey:source.browserKey,
          registrationState:mode==='active_reader'?'active':'quarantined',
          currentRegistrationState:async()=>mode==='registry_changed'&&requestCount>0?'active':'quarantined'},
          close(){closeCount++},cdp:{on(name,handler){handlers.set(name,handler);return()=>handlers.delete(name)},async send(method,params){
            if(['Page.enable','Runtime.enable','Page.disable','Runtime.disable'].includes(method))return {};
            if(method==='Target.getTargetInfo')return {targetInfo:{type:'page'}};
            if(method==='Target.attachToTarget')return {sessionId:'synthetic-session'};
            if(method==='Page.getFrameTree')return {frameTree:{frame:{id:source.frameId,loaderId:source.loaderId,
              url:'https://etax.fujian.chinatax.gov.cn:8443/loginb/'}}};
            if(method==='Runtime.evaluate'){
              requestCount++;
              assert.ok(params.expression.includes("cache:'no-store'"));
              assert.ok(params.expression.includes("credentials:'same-origin'"));
              assert.ok(params.expression.includes("redirect:'manual'"));
              const resource=params.expression.includes('/mhzx/api/mh/mhsy/getUserInfo')?'identity':'current_filing';
              assert.ok(resource==='identity'||params.expression.includes('/mhzx/api/mh/wddb/v1/wddbquerybbsmxx'));
              process.send?.({type:'synthetic-request',ordinal:requestCount,resource});
              if(mode==='unconfirmed')return {result:{value:{status:'request_unconfirmed',settled:false}}};
              const requestRef=params.expression.match(/taxreq_[a-f0-9]{48}/)?.[0];assert.ok(requestRef);
              const body=structuredClone(resource==='identity'?identityBody:filingBody);
              if(mode==='enterprise_changed'&&requestCount===3)body.Response.Data.userinfo.reg_number=privateValue+'_OTHER';
              if(mode==='business_error')body.Response.Error={Code:'synthetic_error',Message:privateValue};
              if(mode==='data_error')body.Response.Data.Error={Code:'synthetic_error',Message:privateValue};
              if(mode==='spa_changed'&&requestCount===2)handlers.get('Page.navigatedWithinDocument')?.({frameId:source.frameId},{sessionId:'synthetic-session'});
              return {result:{value:{status:'observed',settled:true,requestRef:mode==='wrong_proof'?'taxreq_'+'f'.repeat(48):requestRef,
                requestPerformed:true,responseComplete:true,body}}};
            }
            if(method==='Target.detachFromTarget'){detachCount++;if(mode==='detach_failure')throw Error(privateValue);return {}};
            throw Error('synthetic_unexpected_cdp_method');
          }}};
        }};
      process.on('message',message=>{
        if(message?.type==='synthetic-stats')process.send?.({type:'synthetic-stats',requestCount,openCount,closeCount,detachCount});
      });
      process.send?.({type:'synthetic-source-ready',sourceRef,otherSourceRef});
      await import(${moduleUrl('server.mjs')});`;
    child=spawn(process.execPath,['--input-type=module','-e',script],{
      cwd:join(root,'06-workbench'),env:{...process.env,WORKBENCH_DATA_DIR:join(directory,'database'),HOST:'127.0.0.1',PORT:'0'},
      stdio:['ignore','pipe','pipe','ipc'],
    });
    stopped=new Promise(done=>{child.once('exit',done);child.once('error',done)});
    child.on('message',message=>events.push(message));child.stderr.on('data',chunk=>stderr+=chunk.toString());
    const base=await new Promise((yes,no)=>{
      const timer=setTimeout(()=>no(Error('synthetic_backend_start_timeout')),15000);
      child.once('error',error=>{clearTimeout(timer);no(error)});
      child.once('exit',code=>{clearTimeout(timer);no(Error('synthetic_backend_exit_'+code+': '+stderr))});
      child.stdout.on('data',chunk=>{stdout+=chunk.toString();const match=stdout.match(/127\.0\.0\.1:(\d+)\//);
        if(match){clearTimeout(timer);yes('http://127.0.0.1:'+match[1])}});
    });
    const {sourceRef,otherSourceRef}=events.find(event=>event.type==='synthetic-source-ready')||{};assert.match(sourceRef,/^taxsource_[a-f0-9]{48}$/);
    client=new McpStdioClient(join(here,'server.mjs'),{cwd:here,env:{FINANCE_API_BASE:base},timeoutMs:20000}).start();
    await client.initialize('synthetic-live-collection-integration');
    const stats=()=>new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('synthetic_stats_timeout')),3000);
      const handler=message=>{if(message?.type==='synthetic-stats'){clearTimeout(timer);child.off('message',handler);yes(message)}};
      child.on('message',handler);child.send({type:'synthetic-stats'});
    });
    await callback({client,base,sourceRef,otherSourceRef,directory,stats,events});safe(stderr);safe(stdout);safe(client.stderr);
  }finally{
    if(client)await client.close();if(child&&child.exitCode===null&&child.signalCode===null)child.kill();if(stopped)await stopped;
    assert.equal(dirname(resolve(directory)),resolve(temporaryParent));assert.match(directory.split(/[\\/]/).at(-1),/^synthetic-/);
    await rm(directory,{recursive:true,force:true});
  }
}
async function ok(client,name,args){const result=await client.call(name,args);safe(result);assert.equal(result.isError,false);return result.data;}

test('MCP invokes two independent fresh HTTP/Agent/CDP collections with the real private store',async()=>{
  await withBackend(async({client,sourceRef,directory,stats,events})=>{
    const listed=await client.rpc('tools/list');
    for(const name of ['tax_live_collect','tax_live_compare'])assert.ok(listed.result.tools.some(tool=>tool.name===name));
    const first=await ok(client,'tax_live_collect',{sourceRef});
    assert.equal(first.status,'partial_observed');assert.equal(first.requestCount,3);assert.equal(first.enterpriseVerified,false);
    assert.equal(first.documentScopeVerified,true);assert.equal(first.identityProjectionMatched,true);assert.equal(first.businessScopeVerified,false);
    assert.equal(first.periodVerified,false);assert.equal(first.projectionComplete,false);assert.equal(first.lockRetained,false);
    assert.match(first.runRef,/^taxrun_[a-f0-9]{48}$/);
    const second=await ok(client,'tax_live_collect',{sourceRef});assert.equal(second.status,'partial_observed');
    assert.notEqual(first.runRef,second.runRef);assert.equal(second.requestCount,3);
    const compared=await ok(client,'tax_live_compare',{leftRef:first.runRef,rightRef:second.runRef});
    assert.equal(compared.status,'compared');assert.equal(compared.enterpriseEqual,true);assert.equal(compared.filingProjectionEqual,true);
    assert.equal(compared.independentRequests,true);
    assert.equal((await ok(client,'tax_live_compare',{leftRef:first.runRef,rightRef:first.runRef})).status,'not_comparable');
    assert.equal(compared.periodVerified,false);assert.equal(compared.projectionComplete,false);
    const actual=await stats();assert.equal(actual.requestCount,6);assert.equal(actual.openCount,2);assert.equal(actual.closeCount,2);assert.equal(actual.detachCount,2);
    assert.deepEqual(events.filter(event=>event.type==='synthetic-request').map(event=>event.resource),
      ['identity','current_filing','identity','identity','current_filing','identity']);
    assert.equal((await readdir(join(directory,'evidence'))).length,3,'one source plus two separately published runs');
    assert.deepEqual(await readdir(join(directory,'synthetic-profile')),[],'confirmed requests release profile exclusion');
  });
});

test('MCP and direct HTTP cannot inject recipes, URLs, headers or identity selectors',async()=>{
  await withBackend(async({client,base,sourceRef,stats})=>{
    for(const extra of [{url:PRIVATE},{headers:{authorization:PRIVATE}},{body:{Csbz:PRIVATE}},{registrationRef:PRIVATE},{sourceRef:'../'+PRIVATE}]){
      const result=await client.call('tax_live_collect',{sourceRef,...extra});safe(result);assert.ok(result.isError||result.data?.status==='input_invalid');
    }
    const response=await fetch(base+'/agent/tools/tax_live_collect',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({sourceRef,url:PRIVATE})});
    const body=await response.json();safe(body);assert.ok(response.status>=400||body.error||body.ok===false||body.result?.status==='input_invalid'||body.status==='input_invalid');
    assert.equal((await stats()).requestCount,0);
  });
});

test('expired sources are rejected before opening a synthetic connection',async()=>{
  await withBackend(async({client,sourceRef,stats})=>{
    const result=await ok(client,'tax_live_collect',{sourceRef});assert.equal(result.status,'collection_failed');assert.equal(result.phase,'load');
    const actual=await stats();assert.equal(actual.requestCount,0);assert.equal(actual.openCount,0);
  },{mode:'expired'});
});

test('uncertain in-flight request retains cross-checkout exclusion and publishes no run',async()=>{
  await withBackend(async({client,sourceRef,stats,directory})=>{
    const first=await ok(client,'tax_live_collect',{sourceRef});assert.equal(first.status,'collection_failed');assert.equal(first.lockRetained,true);
    const second=await ok(client,'tax_live_collect',{sourceRef});assert.equal(second.status,'collection_failed');assert.equal(second.reason,'tax_collection_busy');
    assert.equal((await stats()).requestCount,1);assert.equal((await readdir(join(directory,'evidence'))).length,1);
    assert.equal((await readdir(join(directory,'synthetic-profile'))).length,1);
  },{mode:'unconfirmed'});
});

test('late enterprise change rejects the collected filing rather than publishing a mixed-company run',async()=>{
  await withBackend(async({client,sourceRef,stats,directory})=>{
    const result=await ok(client,'tax_live_collect',{sourceRef});assert.equal(result.status,'collection_failed');
    assert.equal(result.reason,'tax_collection_enterprise_changed');assert.equal(result.phase,'identity_after');
    assert.equal(result.lockRetained,false);assert.equal((await stats()).requestCount,3);
    assert.equal((await readdir(join(directory,'evidence'))).length,1);
  },{mode:'enterprise_changed'});
});

test('business error cannot be hidden behind a structurally valid identity payload',async()=>{
  await withBackend(async({client,sourceRef,stats,directory})=>{
    const result=await ok(client,'tax_live_collect',{sourceRef});assert.equal(result.status,'collection_failed');
    assert.equal(result.reason,'tax_collection_business_failed');assert.equal((await stats()).requestCount,1);
    assert.equal((await readdir(join(directory,'evidence'))).length,1);
  },{mode:'business_error'});
});

test('unmatched per-request proof is rejected and cannot publish a replayed response',async()=>{
  await withBackend(async({client,sourceRef,stats,directory})=>{
    const result=await ok(client,'tax_live_collect',{sourceRef});assert.equal(result.status,'collection_failed');
    assert.equal((await stats()).requestCount,1);assert.equal((await readdir(join(directory,'evidence'))).length,1);
  },{mode:'wrong_proof'});
});

test('same data from distinct source lineages is not claimed as an independent repeat',async()=>{
  await withBackend(async({client,sourceRef,otherSourceRef,stats})=>{
    const result=await ok(client,'tax_live_compare',{leftRef:sourceRef,rightRef:otherSourceRef});
    assert.equal(result.status,'not_comparable');assert.equal((await stats()).requestCount,0);
  },{mode:'other_source'});
});

test('same-document navigation during filing rejects a mixed-scope publication',async()=>{
  await withBackend(async({client,sourceRef,directory,stats})=>{
    const result=await ok(client,'tax_live_collect',{sourceRef});assert.equal(result.status,'collection_failed');
    assert.equal(result.reason,'tax_collection_scope_changed');assert.equal((await stats()).requestCount,2);
    assert.equal((await readdir(join(directory,'evidence'))).length,1);
  },{mode:'spa_changed'});
});

test('failed CDP detach retains exclusion and withholds an otherwise complete run',async()=>{
  await withBackend(async({client,sourceRef,directory,stats})=>{
    const result=await ok(client,'tax_live_collect',{sourceRef});assert.equal(result.status,'collection_failed');
    assert.equal(result.phase,'cleanup');assert.equal(result.lockRetained,true);assert.equal((await stats()).requestCount,3);
    assert.equal((await readdir(join(directory,'evidence'))).length,1);
  },{mode:'detach_failure'});
});

test('Data.Error is rejected even when all expected projection fields exist',async()=>{
  await withBackend(async({client,sourceRef,directory,stats})=>{
    const result=await ok(client,'tax_live_collect',{sourceRef});assert.equal(result.status,'collection_failed');
    assert.equal(result.reason,'tax_collection_business_failed');assert.equal((await stats()).requestCount,1);
    assert.equal((await readdir(join(directory,'evidence'))).length,1);
  },{mode:'data_error'});
});

test('an active former reader cannot be bypassed by a stored synthetic handoff claim',async()=>{
  await withBackend(async({client,sourceRef,directory,stats})=>{
    const result=await ok(client,'tax_live_collect',{sourceRef});assert.equal(result.status,'collection_failed');
    assert.equal(result.reason,'tax_collection_scope_changed');assert.equal((await stats()).requestCount,0);
    assert.equal((await readdir(join(directory,'evidence'))).length,1);
  },{mode:'active_reader'});
});

test('registry state is rechecked after fresh requests before publishing data',async()=>{
  await withBackend(async({client,sourceRef,directory,stats})=>{
    const result=await ok(client,'tax_live_collect',{sourceRef});assert.equal(result.status,'collection_failed');
    assert.equal(result.reason,'tax_collection_scope_changed');assert.equal((await stats()).requestCount,1);
    assert.equal((await readdir(join(directory,'evidence'))).length,1);
  },{mode:'registry_changed'});
});
