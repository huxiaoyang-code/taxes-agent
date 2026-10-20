// Fully synthetic CDP/store: never opens a browser or private file.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TaxDownloadFinancialPassive} from '../server/tax-download-financial-passive.mjs';
import {observeTaxFinancialPage} from '../scripts/observe-tax-financial-page.mjs';
const SECRET='SENTINEL_PRIVATE_FINANCIAL_913501123456789012',ORIGIN='https://etax.fujian.chinatax.gov.cn:8443';
const snapshotRef='taxdownloadpage_'+'1'.repeat(48),navigationArtifactRef='taxdownloadpage_'+'2'.repeat(48),newRef='taxdownloadpage_'+'3'.repeat(48),sourceRef='taxsource_'+'4'.repeat(48);
const getPath='/observed/exact/prefix/getCwbbzlList',postPath='/observed/exact/other/queryZlbscjb';
async function run(mode='normal',extra={}){
  const calls=[],saved=[],handlers=new Map(),socketHandlers=new Set();let elapsed=0,closed=false,released=0,retained=0,adminClosed=0,adminLost=false,
    navigated=false,finalIssued=false,quiet=false,sourceReads=0,registrationLost=false;
  const frameId=SECRET+'_FRAME',oldLoader=SECRET+'_OLD',base=ORIGIN+'/szzh/zhcx/financial';
  let frame={id:frameId,loaderId:oldLoader,url:base,urlFragment:'#/list'},lastBodyId;
  const full=()=>frame.url+(frame.urlFragment||'');
  const initial={frameId,loaderId:oldLoader,fullUrl:full()};
  if(mode==='initial_token')initial.fullUrl+='?token='+SECRET;
  if(mode==='initial_query_token')initial.fullUrl=base+'?token='+SECRET+'#/list';
  if(mode==='initial_auth')initial.fullUrl=ORIGIN+'/loginb/#/list';
  const nav={version:1,sourceRef,target:'financial_report',evidence:'quarantined_unverified',consumable:false,
    navigation:{commandConfirmed:true,normalNavigationOnly:true},requests:[{url:ORIGIN+getPath,method:'GET',status:200},{url:ORIGIN+postPath,method:'POST',status:200}]};
  const snapshot={version:1,sourceRef,target:'financial_report',evidence:'quarantined_unverified',consumable:false,scopeStable:true,
    snapshot:{mode:'loaded_v8_script_snapshot_v1',parentArtifactRef:navigationArtifactRef,document:initial}};
  if(mode==='wrong_parent')snapshot.snapshot.parentArtifactRef=snapshotRef;
  if(mode==='wrong_source')snapshot.sourceRef='taxsource_'+'5'.repeat(48);
  if(mode==='wrong_target')snapshot.target='invoice';
  if(mode==='no_nav_ack')nav.navigation.commandConfirmed=false;
  if(mode==='ambiguous_endpoint')nav.requests.push({url:ORIGIN+'/different/getCwbbzlList',method:'GET',status:200});
  if(mode==='ambiguous_one_name')nav.requests=[nav.requests[0],{url:ORIGIN+'/different/getCwbbzlList',method:'GET',status:200}];
  if(mode==='no_endpoint')nav.requests=[];
  const emit=(name,p={},sessionId='own')=>handlers.get(name)?.(p,{sessionId});
  const request=(id,path,method,changes={})=>emit('Network.requestWillBeSent',{requestId:id,frameId,loaderId:frame.loaderId,type:'XHR',
    request:{url:ORIGIN+path,method,postData:method==='POST'?JSON.stringify({Skssqq:SECRET,Skssqz:SECRET,PageNum:1,PageSize:20}):undefined},...changes});
  const response=(id,path,changes={})=>{
    emit('Network.responseReceived',{requestId:id,frameId,loaderId:frame.loaderId,response:{url:ORIGIN+path,status:200,mimeType:'application/json'},...changes});
    emit('Network.loadingFinished',{requestId:id,encodedDataLength:100});
  };
  const batch=()=>{
    if(mode==='no_auto_requests')return;
    request('get',getPath,'GET');response('get',getPath);
    request('post',postPath,'POST');response('post',postPath);
    if(mode==='bad_bindings'){
      request('sub',getPath,'GET',{frameId:'SUB'});response('sub',getPath,{frameId:'SUB'});
      request('old',getPath,'GET',{loaderId:oldLoader});response('old',getPath,{loaderId:oldLoader});
      request('prefix','/guessed/getCwbbzlList','GET');response('prefix','/guessed/getCwbbzlList');
      request('method',getPath,'POST');response('method',getPath);
      request('mismatch',getPath,'GET');response('mismatch',getPath,{response:{url:ORIGIN+'/other',status:200,mimeType:'application/json'}});
      request('404',getPath,'GET');response('404',getPath,{response:{url:ORIGIN+getPath,status:404,mimeType:'application/json'}});
      request('mime',getPath,'GET');response('mime',getPath,{response:{url:ORIGIN+getPath,status:200,mimeType:'text/html'}});
      request('unfinished',getPath,'GET');emit('Network.responseReceived',{requestId:'unfinished',frameId,loaderId:frame.loaderId,response:{url:ORIGIN+getPath,status:200,mimeType:'application/json'}});
      request('failed',getPath,'GET');response('failed',getPath);emit('Network.loadingFailed',{requestId:'failed'});
    }
    if(mode==='many_bodies'||mode==='total_limit')for(let i=0;i<18;i++){request('extra'+i,getPath,'GET');response('extra'+i,getPath);}
    if(mode==='oversize')emit('Network.loadingFinished',{requestId:'get',encodedDataLength:2097153});
  };
  const newDocument=(loader='FINAL',fragment='#/list')=>{frame={...frame,loaderId:SECRET+'_'+loader,urlFragment:fragment};emit('Page.frameNavigated',{frame:{...frame}});};
  const ws={readyState:1,addEventListener(name,fn){assert.equal(name,'close');socketHandlers.add(fn);},removeEventListener(name,fn){socketHandlers.delete(fn);}};
  const d={enabled:true,clock:()=>elapsed,now:()=>1800000000000,
    wait:async ms=>{elapsed+=ms;calls.push('wait:'+ms);if(ms===100&&!finalIssued){finalIssued=true;
      if(!['same_document','nav_error'].includes(mode)){newDocument('FINAL',mode==='fragment_change'?'#/list?page=2':'#/list');batch();}
      if(mode==='redirect_limit')for(let i=0;i<17;i++)request('r'+i,getPath,'GET',{redirectResponse:{status:302}});
      if(mode==='main_limit')for(let i=0;i<9;i++)newDocument('EXTRA'+i);
    }if(ms===500){quiet=true;if(mode==='quiet_aba'){emit('Page.navigatedWithinDocument',{frameId});emit('Page.navigatedWithinDocument',{frameId});}}},
    store:{async load(id){assert.equal(id,sourceRef);return{registrationRef:'taxr_'+'6'.repeat(48),registrationRoot:'D:/synthetic/.agent-runs/registry',browserKey:'a'.repeat(64),targetId:SECRET+'_TARGET',
      get identity(){throw Error('old identity forbidden');},get document(){throw Error('old document forbidden');}};},
      async assertNotAbandoned(id){assert.equal(id,sourceRef);if(mode==='abandoned')throw Error(SECRET);}},
    evidence:{async load(id){return id===snapshotRef?snapshot:nav;},async save(record){assert.equal(released,1);assert.equal(adminClosed,1);assert.equal(closed,true);assert.equal(handlers.size,0);
      if(mode==='storage_failure')throw Error(SECRET);saved.push(structuredClone(record));return{artifactRef:newRef,safeAssetRefs:[SECRET]};}},
    acquireAdminGuard:async()=>({verify(){if(adminLost)throw Error(SECRET);},async close(){adminClosed++;if(mode==='admin_close_failure')throw Error(SECRET);}}),
    acquireLock:async()=>({async release(){assert.equal(adminClosed,0);assert.equal(closed,true);assert.equal(handlers.size,0);if(mode==='release_failure')throw Error(SECRET);released++;},retain(){retained++;}}),
    openDiagnostic:async()=>({localScope:{browserKey:'a'.repeat(64),registrationState:'quarantined',profilePath:SECRET+'_PROFILE',currentRegistrationState:async()=>registrationLost?'released':'quarantined'},
      async close(){calls.push('close');await new Promise(done=>setImmediate(done));if(mode==='close_failure')throw Error(SECRET);ws.readyState=3;closed=true;for(const fn of socketHandlers)fn();},
      cdp:{ws,on(name,fn){handlers.set(name,fn);return()=>{if(mode==='off_failure'&&name==='Page.frameNavigated')throw Error(SECRET);handlers.delete(name);};},
        async send(method,params,options){calls.push(method);
          if(method.startsWith('Target.'))assert.equal(options.sessionId,undefined);else assert.equal(options.sessionId,'own');
          assert.ok(!/Runtime\.|Debugger\.|getResource|replayXHR|loadNetworkResource|Fetch\.|DOM\.|disable|click|Page\.navigate/.test(method));
          if(method==='Target.getTargetInfo')return{targetInfo:{targetId:SECRET+'_TARGET',type:'page',url:full()}};
          if(method==='Target.attachToTarget'){if(mode==='attach_unknown')throw Error(SECRET);return{sessionId:'own'};}
          if(method==='Page.getFrameTree')return{frameTree:{frame:{...frame}}};
          if(method==='Page.enable'||method==='Network.enable')return{};
          if(method==='Page.reload'){
            assert.equal(navigated,false);assert.deepEqual(params,{});assert.ok(calls.includes('Network.enable'));navigated=true;
            if(mode==='nav_unknown')throw Error(SECRET);
            if(mode==='nav_error'||mode==='same_document')return{};
            newDocument('EARLY');request('early',getPath,'GET');response('early',getPath);
            return{};
          }
          if(method==='Network.getResponseBody'){
            sourceReads++;lastBodyId=params.requestId;if(mode==='body_unavailable')throw Error(SECRET);
            if(mode==='admin_lost')adminLost=true;
            if(mode==='registration_lost')registrationLost=true;
            if(mode==='read_redirect'){request(params.requestId,getPath,'GET',{redirectResponse:{status:302}});}
            if(mode==='read_finish_replaced')emit('Network.loadingFinished',{requestId:params.requestId,encodedDataLength:100});
            if(mode==='read_response_replaced')emit('Network.responseReceived',{requestId:params.requestId,frameId,loaderId:frame.loaderId,response:{url:ORIGIN+getPath,status:200,mimeType:'application/json'}});
            if(mode==='body_invalid')return{body:'<html>'+SECRET,base64Encoded:false};
            if(mode==='body_base64')return{body:Buffer.from(JSON.stringify({data:{rows:[{[SECRET]:SECRET,amount:123}]}})).toString('base64'),base64Encoded:true};
            if(mode==='bad_base64')return{body:'!!!!'+SECRET,base64Encoded:true};
            if(mode==='body_too_large')return{body:JSON.stringify({data:SECRET.repeat(60000)}),base64Encoded:false};
            if(mode==='total_limit')return{body:JSON.stringify({data:'s'.repeat(1500000)}),base64Encoded:false};
            return{body:JSON.stringify({data:{rows:[{[SECRET]:SECRET,amount:123,success:true}],total:1},success:false}),base64Encoded:false};
          }
          if(method==='Target.detachFromTarget'){
            assert.deepEqual(params,{sessionId:'own'});if(mode==='detach_failure')throw Error(SECRET);
            if(mode==='late_redirect')request(lastBodyId,getPath,'GET',{redirectResponse:{status:302}});
            if(mode==='late_response')emit('Network.responseReceived',{requestId:lastBodyId,frameId,loaderId:frame.loaderId,response:{url:ORIGIN+getPath,status:200,mimeType:'application/json'}});
            if(mode==='sealed_scope')emit('Page.navigatedWithinDocument',{frameId});return{};
          }
          throw Error('unexpected '+method);
        }}}),...extra};
  const result=await new TaxDownloadFinancialPassive(d).capture({snapshotRef,navigationArtifactRef});
  assert.ok(!JSON.stringify(result).includes(SECRET));assert.ok(!JSON.stringify(result).includes(ORIGIN));assert.ok(!JSON.stringify(result).includes(getPath));
  assert.equal(result.enterpriseBinding,false);assert.equal(result.consumable,false);assert.equal(result.requestAuthorized,false);assert.equal(result.runtimeEvaluated,false);
  return{result,calls,saved,released,retained,sourceReads,quiet};
}
test('one exact current navigation captures final-document auto responses privately',async()=>{
  const r=await run();assert.equal(r.result.status,'financial_passive_quarantined');assert.equal(r.result.counts.retainedBodies,2);assert.equal(r.result.cleanupConfirmed,true);
  assert.equal(r.result.artifactRef,newRef);assert.deepEqual(r.result.safeAssetRefs,[]);assert.equal(r.calls.filter(x=>x==='Page.reload').length,1);
  assert.equal(r.saved[0].requests.length,2);assert.equal(r.saved[0].requests.every(x=>x.loaderId.endsWith('_FINAL')),true);
  assert.ok(JSON.stringify(r.saved[0]).includes(SECRET));assert.equal(r.saved[0].assets.length,0);assert.equal(r.saved[0].passive.navigation.action,'Page.reload');assert.equal(r.result.responseShapes[0].businessStatus,'unverified');
  assert.ok(r.result.responseShapes[0].typeCounts.maxArrayLength>=1);assert.ok(r.result.responseShapes[0].schema.some(x=>x.path==='$.data.rows'));
});
test('default and invalid API are inert',async()=>{
  assert.equal((await observeTaxFinancialPage({snapshotRef,navigationArtifactRef})).status,'not_enabled');
  for(const args of [{},{snapshotRef,navigationArtifactRef,url:ORIGIN},{snapshotRef:'bad',navigationArtifactRef}])assert.equal((await new TaxDownloadFinancialPassive().capture(args)).status,'input_invalid');
});
for(const mode of ['wrong_parent','wrong_source','wrong_target','no_nav_ack','ambiguous_endpoint','ambiguous_one_name','no_endpoint','initial_token','initial_query_token','initial_auth','abandoned'])test(mode+' rejects before navigation',async()=>{
  const r=await run(mode);assert.equal(r.result.status,'financial_passive_failed');assert.equal(r.calls.includes('Page.reload'),false);assert.equal(r.sourceReads,0);
});
test('real same-origin fragment change before seal remains a final scope candidate',async()=>{const r=await run('fragment_change');assert.equal(r.result.counts.retainedBodies,2);assert.equal(r.result.status,'financial_passive_quarantined');});
for(const mode of ['quiet_aba','sealed_scope','redirect_limit','main_limit','late_redirect','late_response'])test(mode+' discards all but releases confirmed owned cleanup',async()=>{
  const r=await run(mode);assert.equal(r.result.status,'financial_passive_failed');assert.equal(r.saved.length,0);assert.equal(r.result.counts.retainedBodies,0);assert.equal(r.released,1);assert.equal(r.retained,0);
});
for(const mode of ['attach_unknown','nav_unknown','detach_failure','off_failure','close_failure','release_failure','admin_lost'])test(mode+' retains on own uncertainty',async()=>{
  const r=await run(mode);assert.equal(r.result.status,'financial_passive_failed');assert.equal(r.result.cleanupConfirmed,false);assert.equal(r.retained,1);assert.equal(r.saved.length,0);
});
for(const mode of ['same_document','nav_error'])test(mode+' gives no body without falsely calling a settled reload unknown',async()=>{
  const r=await run(mode);assert.equal(r.saved.length,0);assert.equal(r.released,1);assert.equal(r.result.ownOperationUnknown,false);assert.equal(r.result.navigationConfirmed,true);assert.equal(r.result.failureStep,'seal');assert.equal(r.result.counts.retainedBodies,0);
});
for(const mode of ['body_unavailable','body_invalid','bad_base64','read_redirect','read_finish_replaced','read_response_replaced','body_too_large','no_auto_requests'])test(mode+' never invents missing response data',async()=>{
  const r=await run(mode);assert.equal(r.result.status,'financial_passive_quarantined');assert.equal(r.result.counts.retainedBodies,0);assert.equal(r.result.bodyGap,'no_completed_matching_json_body');assert.equal(r.result.cleanupConfirmed,true);
});
test('request origin/path/method/frame/loader/response binding and completion are enforced',async()=>{
  const r=await run('bad_bindings');assert.equal(r.result.counts.retainedBodies,2);assert.equal(r.result.responseShapes.length,2);assert.equal(r.saved[0].requests.length,2);
});
test('valid base64 JSON goes private and dynamic map keys never enter shape',async()=>{const r=await run('body_base64');assert.equal(r.result.counts.retainedBodies,2);assert.equal(r.result.responseShapes[0].businessStatus,'unverified');});
test('registration loss during a passive read permanently prevents publication without inventing own request unknown',async()=>{
  const r=await run('registration_lost');assert.equal(r.result.status,'financial_passive_failed');assert.equal(r.saved.length,0);assert.equal(r.released,1);assert.equal(r.result.ownOperationUnknown,false);
});
test('per-response and aggregate budgets stay bounded and explicit',async()=>{
  const a=await run('oversize');assert.equal(a.result.counts.retainedBodies,1);
  const b=await run('many_bodies');assert.equal(b.result.counts.retainedBodies,12);assert.equal(b.result.truncated,true);assert.ok(b.result.counts.bodyReads<=24);
  const c=await run('total_limit');assert.ok(c.result.counts.retainedBytes<=8388608);assert.equal(c.result.truncated,true);
});
test('storage/OS guard close failure cannot publish any reference',async()=>{
  for(const mode of ['storage_failure','admin_close_failure']){const r=await run(mode);assert.equal(r.result.status,'financial_passive_failed');assert.equal(r.result.artifactRef,undefined);}
});
