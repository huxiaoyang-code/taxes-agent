// 完全内存中的合成浏览器/存储。不读取私有目录或真实服务。
import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {TaxDownloadNavigation} from '../server/tax-download-navigation.mjs';
import {buildHistoryTemplate,enterpriseOf,HISTORY_ORIGIN,HISTORY_PATH} from '../server/tax-history-contract.mjs';
import {businessProjection} from '../server/tax-collection-shape.mjs';
import {FULL_FRAME_URL_SEMANTICS} from '../server/tax-frame-url.mjs';
const PRIVATE='PRIVATE_SYNTHETIC_DOWNLOAD_TRIPWIRE',PORTAL=HISTORY_ORIGIN+'/loginb/';
const ref=(p,c='1')=>p+'_'+c.repeat(48);
const safe=value=>assert.doesNotMatch(JSON.stringify(value),/PRIVATE_SYNTHETIC|https?:|targetId|frameId|loaderId|registrationRoot|profilePath|userinfo|taxpayer_id/);
function fixture(mode='normal'){
  const body={Response:{Error:null,Data:{userinfo:{reg_number:PRIVATE+'_REG',company_name:PRIVATE+'_CO',creditCode:PRIVATE+'_CC',taxpayer_id:PRIVATE+'_TAX'}}}};
  const parent={version:2,documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,authorizedNavigation:true,handoffMode:'quarantined_reader_new_navigation',readerStoppedConfirmed:true,
    registrationRef:ref('taxr'),registrationRoot:'D:/synthetic/.agent-runs/tax-browser-registry',pageRef:ref('taxpage'),targetId:PRIVATE+'_TARGET',frameId:PRIVATE+'_OLD_FRAME',
    loaderId:PRIVATE+'_OLD_LOADER',browserKey:'a'.repeat(64),documentUrlDigest:'b'.repeat(64),capturedAt:1000,
    identity:{resource:'identity',recipe:{path:'/mhzx/api/mh/mhsy/getUserInfo',method:'GET',body:null,queryTimestamp:true},projection:businessProjection(body,'identity')},
    filing:{resource:'current_filing',recipe:{path:'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx',method:'POST',body:{Csbz:''},queryTimestamp:true},
      projection:businessProjection({Response:{Data:{wsbxxGrid:[]}}},'current_filing')}};
  const sourceRef=ref('taxsource'),templateRef=ref('taxhistorytemplate'),contextRef=ref('taxhistorycontext');
  const manifest={version:1,sourceRef,target:'filing_query',capturedAt:1001,assets:[],document:{targetId:parent.targetId,frameId:PRIVATE+'_QUERY_FRAME',loaderId:PRIVATE+'_QUERY_LOADER',
    url:HISTORY_ORIGIN+'/szzh/zhcx/sbxx/sbxxcx?ruuid='+PRIVATE},identityProjection:parent.identity.projection,
    requests:[{url:HISTORY_ORIGIN+HISTORY_PATH,method:'POST',body:{gzlx:['a','b'],pageNum:1,pageSize:10,sbrqq:'',sbrqz:'',skssqq:'',skssqz:'',zfbz:'',yzpzzlDm:''},
      response:{Response:{Error:null,Data:{PageNumber:1,PageSize:10,Total:0,List:[]}}}}]};
  const template=buildHistoryTemplate(manifest,parent,ref('taxquery'));
  const context={version:1,templateRef,createdAt:1002,expiresAt:1801002,replayDocument:structuredClone(template.captureDocument),enterprise:enterpriseOf(parent.identity.projection),
    operationRef:ref('taxop'),proof:['1','2'].map(c=>({requestRef:ref('taxreq',c),resource:'identity',requestPerformed:true,responseComplete:true}))};
  let frame={id:manifest.document.frameId,loaderId:manifest.document.loaderId,url:manifest.document.url};
  const state={mode,now:1003,clock:0,calls:[],requests:[],events:new Map(),opens:0,release:0,retain:0,close:0,nav:0,identity:0,abandoned:false,scopeReads:0};
  const emit=(name,p,sessionId='synthetic_session')=>{for(const fn of state.events.get(name)||[])fn(p,{sessionId});};
  const cdp={on(name,fn){if(!state.events.has(name))state.events.set(name,new Set());state.events.get(name).add(fn);
    return()=>{state.events.get(name).delete(fn);if(mode==='off_failure')throw Error(PRIVATE);};},
    async send(method,params,opts){state.calls.push({method,params,opts});assert.ok(opts.timeoutMs>0&&opts.timeoutMs<=14000);
      if(method==='Target.getTargetInfo')return {targetInfo:{type:mode==='wrong_target'?'worker':'page'}};
      if(method==='Target.attachToTarget'){if(mode==='attach_unknown')throw Error(PRIVATE);return {sessionId:'synthetic_session'};}
      if(method==='Target.detachFromTarget'){if(mode==='detach_failure')throw Error(PRIVATE);return {};}
      if(['Page.enable','Runtime.enable','Page.disable','Runtime.disable'].includes(method)){
        if(method==='Runtime.enable')emit('Runtime.executionContextCreated',{context:{id:101,auxData:{frameId:frame.id}}});
        if(mode==='disable_clears'&&method==='Runtime.disable')emit('Runtime.executionContextsCleared',{});
        if(mode==='disable_failure'&&method==='Page.disable')throw Error(PRIVATE);return {};
      }
      if(method==='Page.getFrameTree'){
        if(mode==='document_query_before'&&state.identity===0&&!frame.url.endsWith('&changed=1'))frame.url+='&changed=1';
        if(mode==='document_fragment_before'&&state.identity===0)frame.urlFragment='#';
        if(mode==='loader_before'&&state.identity===0)frame.loaderId=PRIVATE+'_OTHER';
        if(['missing_event','reply_loader_mismatch'].includes(mode)&&state.nav)state.clock+=12001;
        if(mode==='deadline')state.clock=76000;
        if(mode==='cleanup_document_changed'&&state.identity===2)frame.urlFragment='#late';
        return {frameTree:{frame:{...frame}}};
      }
      if(method==='Page.navigate'){
        assert.deepEqual(params,{url:PORTAL,frameId:context.replayDocument.frameId});state.nav++;
        if(mode==='navigation_timeout')throw Error(PRIVATE);
        if(mode==='navigation_error')return {errorText:PRIVATE};
        if(mode==='navigation_error_moved'){frame.loaderId=PRIVATE+'_UNCONFIRMED';return {errorText:PRIVATE};}
        frame={id:context.replayDocument.frameId,loaderId:PRIVATE+'_NEW_LOADER',url:PORTAL};
        if(mode==='portal_query')frame.url+='?x=1';if(mode==='portal_fragment')frame.urlFragment='#';
        if(mode==='portal_wrong_path')frame.url=HISTORY_ORIGIN+'/loginb';
        if(mode==='portal_external')frame.url='https://example.invalid/loginb/';
        if(mode==='portal_new_frame')frame.id=PRIVATE+'_NEW_FRAME';
        if(mode==='portal_old_loader')frame.loaderId=context.replayDocument.loaderId;
        if(mode==='bootstrap_old_destroy'||mode==='bootstrap_duplicate_destroy')emit('Runtime.executionContextDestroyed',{executionContextId:101});
        if(mode==='bootstrap_unknown_destroy')emit('Runtime.executionContextDestroyed',{executionContextId:999});
        emit('Runtime.executionContextsCleared',{});emit('Runtime.executionContextsCleared',{});
        if(mode==='bootstrap_third_clear')emit('Runtime.executionContextsCleared',{});
        if(mode!=='missing_event')emit('Page.frameNavigated',{frame:{...frame}});
        if(mode==='bootstrap_old_destroy_after_frame'||mode==='bootstrap_duplicate_destroy')emit('Runtime.executionContextDestroyed',{executionContextId:101});
        if(mode==='bootstrap_clear_after_frame')emit('Runtime.executionContextsCleared',{});
        if(mode==='navigation_aba')emit('Page.frameNavigated',{frame:{...frame}});
        if(mode==='same_document_nav')emit('Page.navigatedWithinDocument',{});
        if(mode==='source_retired_after_nav')state.abandoned=true;
        if(mode==='context_expires_after_nav')state.now=context.expiresAt;
        return {frameId:frame.id,loaderId:mode==='reply_loader_mismatch'?PRIVATE+'_BAD_REPLY':frame.loaderId,...mode==='download_reply'?{isDownload:true}:{}};
      }
      if(method==='Runtime.evaluate'){
        state.identity++;
        if(mode==='hung_identity')return new Promise(()=>{});
        if(mode==='identity_timeout')throw Error(PRIVATE);
        const location={href:frame.url+(frame.urlFragment||''),origin:HISTORY_ORIGIN};
        if(mode==='scope_changed_before_dispatch')location.href+='&changed=1';
        const value=await runInNewContext(params.expression,{location,URL,AbortController,TextDecoder,
          window:{fetch:mode==='nonnative_fetch'?()=>{}:Array.prototype.push,setTimeout:Array.prototype.push},setTimeout:()=>1,clearTimeout:()=>{},
          async fetch(address,init){
            state.requests.push({address,init});assert.match(address,/^https:\/\/etax\.fujian\.chinatax\.gov\.cn:8443\/mhzx\/api\/mh\/mhsy\/getUserInfo\?t=\d+$/);
            if(mode==='scope_changed_after_response')location.href+='&changed=1';
            assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');
            if(mode==='request_unknown')throw Error(PRIVATE);
            if(mode==='identity_event')emit('Runtime.executionContextsCleared',{});
            if(mode==='old_destroy_after_stable'&&state.identity===2)emit('Runtime.executionContextDestroyed',{executionContextId:101});
            if(mode==='other_session_event')emit('Page.navigatedWithinDocument',{},'other_session');
            if(mode==='identity_aba')emit('Page.navigatedWithinDocument',{});
            if(mode==='unexpected_detach')emit('Target.detachedFromTarget',{sessionId:'synthetic_session'});
            if(mode==='frame_detach')emit('Page.frameDetached',{frameId:frame.id});
            if(mode==='source_retired_identity')state.abandoned=true;
            let response=structuredClone(body);
            if(mode==='enterprise_before'||mode==='enterprise_after'&&state.identity===2)response.Response.Data.userinfo.creditCode=PRIVATE+'_OTHER';
            if(mode==='missing_enterprise')delete response.Response.Data.userinfo.taxpayer_id;
            if(mode==='business_failed')response.Response.Error={Message:PRIVATE};
            if(mode==='shape_failed')response={Response:{Error:null,Data:{}}};
            return new Response(mode==='invalid_json'?PRIVATE:JSON.stringify(response),{status:mode==='http_failed'?500:200});
          }});
        if(mode==='wrong_proof')value.requestRef=ref('taxreq','f');
        if(mode==='exception_details')return {exceptionDetails:{text:PRIVATE}};
        if(mode==='unknown_status')return {result:{value:{status:PRIVATE,settled:true}}};
        return {result:{value}};
      }
      throw Error(PRIVATE);
    }};
  const admin=new TaxDownloadNavigation({now:()=>state.now,clock:()=>state.clock,
    store:{async load(id){if(id===contextRef)return structuredClone(context);if(id===templateRef)return structuredClone(template);throw Error(PRIVATE);}},
    parentStore:{async load(id){assert.equal(id,sourceRef);return structuredClone(parent);},async assertNotAbandoned(){if(state.abandoned)throw Error(PRIVATE);}},
    async acquireLock(_path,options){assert.equal(options.scope.operation,'download_return_to_portal');if(mode==='busy')throw Error('tax_collection_busy');
      return {async release(){state.release++;if(mode==='release_failure')throw Error(PRIVATE);},retain(){state.retain++;}};},
    async openDiagnostic(input,overrides){state.opens++;if(mode==='slow_preflight')state.clock=21000;
      assert.deepEqual(Object.keys(input).sort(),['registrationRef','registrationRoot']);assert.equal(Object.keys(overrides).join(','),'registrationBase');
      return {cdp,localScope:{browserKey:mode==='browser_mismatch'?'c'.repeat(64):parent.browserKey,profilePath:'D:/synthetic/profile',registrationState:'quarantined',
        async currentRegistrationState(){state.scopeReads++;if(state.identity===2)state.registryAfter=(state.registryAfter||0)+1;
          if(mode==='registry_hung_cleanup'&&state.registryAfter===3)return new Promise(()=>{});
          return mode==='registry_after'&&state.nav?'active':'quarantined';}},
        async close(){state.close++;if(mode==='close_failure')throw Error(PRIVATE);}};}});
  return {admin,state,context,template,parent,contextRef,emit};
}

test('fixed portal normal navigation brackets two fresh identity reads and releases shared lock',async()=>{
  const f=fixture(),result=await f.admin.returnToPortal({contextRef:f.contextRef});safe(result);
  assert.equal(result.status,'portal_returned');assert.equal(result.identityProjectionMatched,true);assert.equal(result.documentScopeVerified,true);
  assert.equal(result.navigationVerified,true);assert.equal(result.lockRetained,false);assert.equal(result.downloadPerformed,false);assert.equal(result.downstreamReady,false);
  assert.equal(result.operationSettled,true);assert.equal(result.cleanupConfirmed,true);assert.equal(result.cleanupFailureStep,null);
  assert.equal(result.requestPerformedCount,2);assert.equal(result.responseCompleteCount,2);assert.equal(result.navigationConfirmedCount,1);
  assert.equal(result.bootstrapContextClearCount,2);assert.equal(result.knownOldContextDestroyCount,0);
  assert.equal(f.state.nav,1);assert.equal(f.state.release,1);assert.equal(f.state.close,1);
  assert.deepEqual(f.state.calls.filter(c=>['Runtime.evaluate','Page.navigate'].includes(c.method)).map(c=>c.method),['Runtime.evaluate','Page.navigate','Runtime.evaluate']);
  for(const request of f.state.requests)assert.equal(request.init.credentials,'same-origin');
  assert.notEqual(f.state.calls.filter(c=>c.method==='Runtime.evaluate')[0].params.expression,f.state.calls.filter(c=>c.method==='Runtime.evaluate')[1].params.expression);
});

for(const input of [null,{},[],{contextRef:'bad'}, {contextRef:ref('taxhistorycontext'),url:PORTAL},{contextRef:ref('taxhistorycontext'),body:{}},
  {contextRef:ref('taxhistorycontext'),targetId:'a'},{contextRef:ref('taxhistorycontext'),path:'D:/private'}])test('rejects arbitrary input '+JSON.stringify(input),async()=>{
  const f=fixture(),result=await f.admin.returnToPortal(input);assert.equal(result.status,'input_invalid');assert.equal(f.state.opens,0);safe(result);
});

for(const mode of ['expired','future','wrong_enterprise','wrong_target_binding','bad_ttl','retired','bad_parent','bad_recipe'])test('preflight rejects '+mode,async()=>{
  const f=fixture();
  if(mode==='expired')f.state.now=f.context.expiresAt;
  if(mode==='future')f.state.now=f.context.createdAt-1;
  if(mode==='wrong_enterprise')f.context.enterprise.creditCode=PRIVATE+'_OTHER';
  if(mode==='wrong_target_binding')f.context.replayDocument.targetId=PRIVATE+'_OTHER';
  if(mode==='bad_ttl')f.context.expiresAt++;
  if(mode==='retired')f.state.abandoned=true;
  if(mode==='bad_parent')f.parent.browserKey='c'.repeat(64);
  if(mode==='bad_recipe')f.template.identityRecipe.path='/unknown';
  const r=await f.admin.returnToPortal({contextRef:f.contextRef});safe(r);assert.equal(r.status,'portal_return_failed');assert.equal(f.state.opens,0);assert.equal(f.state.nav,0);
});

for(const mode of ['enterprise_before','enterprise_after','missing_enterprise','business_failed','shape_failed','http_failed','invalid_json','nonnative_fetch',
  'document_query_before','document_fragment_before','loader_before','browser_mismatch','wrong_target','navigation_error'])test('settled failure remains safe and releases lock '+mode,async()=>{
  const f=fixture(mode),r=await f.admin.returnToPortal({contextRef:f.contextRef});safe(r);assert.equal(r.status,'portal_return_failed');
  assert.equal(r.navigationVerified,false);assert.equal(r.documentScopeVerified,false);assert.equal(r.lockRetained,false);
  assert.equal(f.state.identity,mode==='enterprise_after'?2:mode.startsWith('document_')||['loader_before','browser_mismatch','wrong_target'].includes(mode)?0:1);
  if(!['enterprise_after','navigation_error'].includes(mode))assert.equal(f.state.nav,0);
});

for(const mode of ['identity_timeout','request_unknown','wrong_proof','exception_details','unknown_status','identity_event','identity_aba','unexpected_detach','frame_detach',
  'attach_unknown','navigation_timeout','navigation_error_moved','portal_query','portal_fragment','portal_wrong_path','portal_external','portal_new_frame','portal_old_loader',
  'reply_loader_mismatch','download_reply','navigation_aba','same_document_nav','missing_event','detach_failure','off_failure','close_failure','release_failure',
  'cleanup_document_changed','source_retired_after_nav','context_expires_after_nav','registry_after','source_retired_identity','deadline',
  'bootstrap_third_clear','bootstrap_clear_after_frame','bootstrap_unknown_destroy','bootstrap_duplicate_destroy','old_destroy_after_stable'])test('uncertain state retains lock '+mode,async()=>{
  const f=fixture(mode),r=await f.admin.returnToPortal({contextRef:f.contextRef});safe(r);assert.equal(r.status,'portal_return_failed');
  assert.equal(r.navigationVerified,false);assert.equal(r.documentScopeVerified,false);assert.equal(r.lockRetained,true);assert.equal(f.state.retain,1);
});

test('events in another attached session do not corrupt local navigation proof',async()=>{
  const f=fixture('other_session_event'),r=await f.admin.returnToPortal({contextRef:f.contextRef});safe(r);assert.equal(r.status,'portal_returned');assert.equal(r.lockRetained,false);
});
for(const mode of ['bootstrap_old_destroy','bootstrap_old_destroy_after_frame'])test('bounded known old-context teardown with two bootstrap clears '+mode,async()=>{
  const f=fixture(mode),r=await f.admin.returnToPortal({contextRef:f.contextRef});safe(r);assert.equal(r.status,'portal_returned');
  assert.equal(r.lockRetained,false);assert.equal(r.navigationVerified,true);assert.equal(r.identityProjectionMatched,true);assert.equal(f.state.requests.length,2);
  assert.equal(r.bootstrapContextClearCount,2);assert.equal(r.knownOldContextDestroyCount,1);
});
test('busy shared lock prevents attach or navigation and closes diagnostic only',async()=>{
  const f=fixture('busy'),r=await f.admin.returnToPortal({contextRef:f.contextRef});safe(r);assert.equal(r.reason,'tax_collection_busy');assert.equal(f.state.calls.length,0);assert.equal(f.state.nav,0);assert.equal(f.state.close,1);
});
test('no Runtime.disable is dispatched, so its context-clear teardown cannot invalidate settled navigation',async()=>{
  const f=fixture('disable_clears'),r=await f.admin.returnToPortal({contextRef:f.contextRef});safe(r);assert.equal(r.status,'portal_returned');
  assert.equal(f.state.calls.some(c=>['Runtime.disable','Page.disable'].includes(c.method)),false);assert.equal(r.operationSettled,true);assert.equal(r.cleanupConfirmed,true);
});
test('native-fetch preflight invalid proves known not-performed; scope_changed remains ambiguous before and after fetch',async()=>{
  const f=fixture('nonnative_fetch'),r=await f.admin.returnToPortal({contextRef:f.contextRef});safe(r);
  assert.equal(r.requestAttemptedCount,1);assert.equal(r.requestNotPerformedCount,1);assert.equal(r.requestPerformedCount,0);assert.equal(r.requestPerformedUnknownCount,0);assert.equal(f.state.requests.length,0);
  for(const mode of ['scope_changed_before_dispatch','scope_changed_after_response']){
    const g=fixture(mode),v=await g.admin.returnToPortal({contextRef:g.contextRef});safe(v);assert.equal(v.requestNotPerformedCount,0);
    assert.equal(v.requestPerformedUnknownCount,1);assert.equal(g.state.requests.length,mode==='scope_changed_before_dispatch'?0:1);
  }
});
for(const [mode,step] of [['detach_failure','detach'],['off_failure','listeners'],['close_failure','transport_close'],['release_failure','lock_release']])test('fixed cleanup diagnosis '+mode,async()=>{
  const f=fixture(mode),r=await f.admin.returnToPortal({contextRef:f.contextRef});safe(r);assert.equal(r.operationSettled,true);
  assert.equal(r.cleanupConfirmed,false);assert.equal(r.cleanupFailureStep,step);assert.equal(r.cleanupFailureKind,'unconfirmed');assert.equal(r.lockRetained,true);
});
test('preflight refuses a depleted budget before lock, attach or active request',async()=>{
  const f=fixture('slow_preflight'),r=await f.admin.returnToPortal({contextRef:f.contextRef});safe(r);assert.equal(r.reason,'budget_insufficient');
  assert.equal(f.state.calls.length,0);assert.equal(f.state.requests.length,0);assert.equal(f.state.release,0);assert.equal(r.lockRetained,false);assert.equal(f.state.close,1);
});
test('cleanup ACL timeout is diagnosed without losing the settled operation evidence',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture('registry_hung_cleanup'),pending=f.admin.returnToPortal({contextRef:f.contextRef});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.state.registryAfter,3);f.state.clock=7001;t.mock.timers.tick(7001);
  const r=await pending;safe(r);assert.equal(r.operationSettled,true);assert.equal(r.requestPerformedCount,2);assert.equal(r.responseCompleteCount,2);
  assert.equal(r.requestPerformedUnknownCount,0);assert.equal(r.cleanupFailureStep,'registration_verify');assert.equal(r.cleanupFailureKind,'timeout');assert.equal(r.lockRetained,true);
});
test('a genuinely unresolved CDP promise returns at its explicit timeout and retains the lock',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture('hung_identity'),pending=f.admin.returnToPortal({contextRef:f.contextRef});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.state.identity,1);
  f.state.clock=14001;t.mock.timers.tick(14001);
  const r=await pending;safe(r);assert.equal(r.status,'portal_return_failed');assert.equal(r.lockRetained,true);
  assert.equal(f.state.nav,0);assert.equal(f.state.retain,1);assert.equal(f.state.close,1);assert.equal(r.requestPerformedUnknownCount,1);
});
