// 完全合成的存储/CDP/套接字。不使用私有文件或真实浏览器。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TaxDownloadInvoiceObserver} from '../server/tax-download-invoice-observer.mjs';
import {observeTaxInvoicePage} from '../scripts/observe-tax-invoice-page.mjs';
const SECRET='SENTINEL_INVOICE_PRIVATE_913501123456789012',ORIGIN='https://dppt.fujian.chinatax.gov.cn:8443';
const snapshotRef='taxdownloadpage_'+'1'.repeat(48),navigationArtifactRef='taxdownloadpage_'+'2'.repeat(48),sourceRef='taxsource_'+'3'.repeat(48),newRef='taxdownloadpage_'+'4'.repeat(48);
async function run(mode='normal',extra={}){
  const calls=[],saved=[],handlers=new Map(),socketHandlers=new Set();let elapsed=0,released=0,retained=0,closed=false,adminClosed=0,adminLost=false,registrationLost=false,reads=0,notified=0;
  const frame={id:SECRET+'_FRAME',loaderId:SECRET+'_LOADER',url:ORIGIN+'/kpfw/query/index.html',urlFragment:'#/list'};
  const full=()=>frame.url+frame.urlFragment,document={frameId:frame.id,loaderId:frame.loaderId,fullUrl:full()};
  const nav={version:1,sourceRef,target:'invoice',evidence:'quarantined_unverified',consumable:false,navigation:{normalNavigationOnly:true,commandConfirmed:true}};
  const snapshot={version:1,sourceRef,target:'invoice',evidence:'quarantined_unverified',consumable:false,scopeStable:true,
    snapshot:{mode:'loaded_v8_script_snapshot_v1',parentArtifactRef:navigationArtifactRef,document}};
  if(mode==='wrong_parent')snapshot.snapshot.parentArtifactRef=snapshotRef;
  if(mode==='wrong_source')snapshot.sourceRef='taxsource_'+'5'.repeat(48);
  if(mode==='wrong_target')nav.target='financial_report';
  if(mode==='no_ack')nav.navigation.commandConfirmed=false;
  if(mode==='wrong_host')document.fullUrl='https://etax.fujian.chinatax.gov.cn:8443/kpfw/query/index.html#/list';
  if(mode==='stale_document')frame.loaderId='NEW';
  const emit=(name,p={},sessionId='own')=>handlers.get(name)?.(p,{sessionId});
  const req=(id,path='/api/observed/queryInvoices',changes={})=>emit('Network.requestWillBeSent',{requestId:id,frameId:frame.id,loaderId:frame.loaderId,type:'XHR',
    request:{url:ORIGIN+path,method:'POST',postData:JSON.stringify({[SECRET]:SECRET,page:1})},...changes});
  const res=(id,path='/api/observed/queryInvoices',changes={})=>{
    emit('Network.responseReceived',{requestId:id,frameId:frame.id,loaderId:frame.loaderId,response:{url:ORIGIN+path,status:200,mimeType:'application/json'},...changes});
    emit('Network.loadingFinished',{requestId:id,encodedDataLength:100});};
  const batch=()=>{
    if(mode==='empty')return;req('query');res('query');
    if(mode==='filters'){
      req('auth','/api/getPublicKey');res('auth','/api/getPublicKey');req('write','/api/SaveInvoice');res('write','/api/SaveInvoice');
      req('external','/api/query',{request:{url:'https://external.invalid/api/query',method:'GET'}});
      req('sub','/api/query',{frameId:'SUB'});req('other_loader','/api/query',{loaderId:'OTHER'});
      req('put','/api/query',{request:{url:ORIGIN+'/api/query',method:'PUT'}});
      req('token','/api/query?token='+SECRET);res('token','/api/query?token='+SECRET);
      req('wrong_url');res('wrong_url','/other');
      req('404');res('404',undefined,{response:{url:ORIGIN+'/api/observed/queryInvoices',status:404,mimeType:'application/json'}});
      req('unfinished');emit('Network.responseReceived',{requestId:'unfinished',frameId:frame.id,loaderId:frame.loaderId,response:{url:ORIGIN+'/api/observed/queryInvoices',status:200,mimeType:'application/json'}});
      req('failed');res('failed');emit('Network.loadingFailed',{requestId:'failed'});
    }
    if(mode==='official_cross_origin'){
      for(const [id,origin] of [['national','https://dppt.chinatax.gov.cn:8443'],['national443','https://dppt.chinatax.gov.cn']]){
        req(id,undefined,{request:{url:origin+'/observed/queryInvoices',method:'POST',postData:'{}'}});
        res(id,undefined,{response:{url:origin+'/observed/queryInvoices',status:200,mimeType:'application/json'}});
      }
      req('unlisted',undefined,{request:{url:'https://unknown.chinatax.gov.cn/query',method:'GET'}});
    }
    if(mode==='metadata_limit'||mode==='body_limit'||mode==='total_limit')for(let i=0;i<60;i++){req('extra'+i);res('extra'+i);}
  };
  const ws={readyState:1,addEventListener(name,fn){socketHandlers.add(fn);},removeEventListener(name,fn){socketHandlers.delete(fn);}};
  const d={enabled:true,durationMs:1000,clock:()=>elapsed,now:()=>1800000000000,
    wait:async ms=>{elapsed+=ms;assert.ok(ms>=0);if(mode==='scope_wait')emit('Page.navigatedWithinDocument',{frameId:frame.id});},
    onArmed:async value=>{notified++;assert.deepEqual(value,{status:'invoice_observer_armed',observationSeconds:1});assert.ok(calls.includes('Page.enable')&&calls.includes('Network.enable'));
      if(mode==='armed_failure')throw Error(SECRET);batch();},
    store:{async load(id){assert.equal(id,sourceRef);return{registrationRef:'taxr_'+'6'.repeat(48),registrationRoot:'D:/synthetic/.agent-runs/registry',browserKey:'a'.repeat(64),targetId:SECRET+'_TARGET',
      get identity(){throw Error('old identity forbidden');},get document(){throw Error('old document forbidden');}};},
      async assertNotAbandoned(id){assert.equal(id,sourceRef);if(mode==='abandoned')throw Error(SECRET);}},
    evidence:{async load(id){return id===snapshotRef?snapshot:nav;},async save(record){calls.push('save');assert.equal(released,1);assert.equal(adminClosed,1);assert.equal(closed,true);assert.equal(handlers.size,0);
      if(mode==='storage_failure')throw Error(SECRET);saved.push(structuredClone(record));return{artifactRef:newRef,safeAssetRefs:[SECRET]};}},
    acquireAdminGuard:async()=>({verify(){if(adminLost)throw Error(SECRET);},async close(){adminClosed++;if(mode==='admin_close_failure')throw Error(SECRET);}}),
    acquireLock:async()=>{calls.push('lock');if(mode==='lock_busy')throw Error(SECRET);return{async release(){calls.push('release');assert.equal(closed,true);assert.equal(adminClosed,0);assert.equal(handlers.size,0);
      if(mode==='release_failure')throw Error(SECRET);released++;},retain(){retained++;}};},
    openDiagnostic:async()=>({localScope:{browserKey:mode==='wrong_browser'?'b'.repeat(64):'a'.repeat(64),registrationState:'quarantined',profilePath:SECRET+'_PROFILE',
      currentRegistrationState:async()=>registrationLost?'released':'quarantined'},
      async close(){calls.push('close');if(mode==='socket_no_close')return;await new Promise(done=>setImmediate(done));if(mode==='close_failure')throw Error(SECRET);
        ws.readyState=3;closed=true;for(const fn of socketHandlers)fn();},
      cdp:{ws,on(name,fn){handlers.set(name,fn);return()=>{if(mode==='off_failure'&&name==='Page.frameNavigated')throw Error(SECRET);handlers.delete(name);};},
        async send(method,params,opts){calls.push(method);if(method.startsWith('Target.'))assert.equal(opts.sessionId,undefined);else assert.equal(opts.sessionId,'own');
          assert.ok(!/Runtime\.|Debugger\.|Page\.(?:navigate|reload)|getResource|replayXHR|loadNetworkResource|Fetch\.|DOM\.|disable|click/.test(method));
          if(method==='Target.getTargetInfo')return{targetInfo:{targetId:SECRET+'_TARGET',type:'page',url:full()}};
          if(method==='Target.attachToTarget'){if(mode==='attach_unknown')throw Error(SECRET);return{sessionId:'own'};}
          if(method==='Page.getFrameTree')return{frameTree:{frame:{...frame}}};
          if(method==='Page.enable'||method==='Network.enable')return{};
          if(method==='Network.getResponseBody'){
            reads++;if(mode==='body_unavailable')throw Error(SECRET);
            if(mode==='scope_read')emit('Page.frameNavigated',{frame:{...frame,loaderId:'CHANGED'}});
            if(mode==='frame_aba'){frame.urlFragment='#/other';emit('Page.navigatedWithinDocument',{frameId:frame.id});frame.urlFragment='#/list';emit('Page.navigatedWithinDocument',{frameId:frame.id});}
            if(mode==='registration_lost')registrationLost=true;if(mode==='admin_lost')adminLost=true;
            if(mode==='redirect_read')req(params.requestId,undefined,{redirectResponse:{status:302}});
            if(mode==='finish_replaced')emit('Network.loadingFinished',{requestId:params.requestId,encodedDataLength:100});
            if(mode==='response_replaced')emit('Network.responseReceived',{requestId:params.requestId,frameId:frame.id,loaderId:frame.loaderId,response:{url:ORIGIN+'/api/observed/queryInvoices',status:200,mimeType:'application/json'}});
            if(mode==='body_invalid')return{body:'<html>'+SECRET,base64Encoded:false};
            if(mode==='bad_base64')return{body:'!!!'+SECRET,base64Encoded:true};
            const text=JSON.stringify({data:{rows:[{[SECRET]:SECRET,amount:123}]},success:false});
            if(mode==='base64')return{body:Buffer.from(text).toString('base64'),base64Encoded:true};
            if(mode==='oversize')return{body:SECRET.repeat(60000),base64Encoded:false};
            if(mode==='total_limit')return{body:JSON.stringify({data:'s'.repeat(1500000)}),base64Encoded:false};
            return{body:text,base64Encoded:false};
          }
          if(method==='Target.detachFromTarget'){assert.deepEqual(params,{sessionId:'own'});if(mode==='detach_failure')throw Error(SECRET);
            if(mode==='scope_detach')emit('Page.navigatedWithinDocument',{frameId:frame.id});
            if(mode==='late_redirect')req('query',undefined,{redirectResponse:{status:302}});return{};}
          throw Error('unexpected '+method);
        }}}),...extra};
  const result=await new TaxDownloadInvoiceObserver(d).observe({snapshotRef,navigationArtifactRef});
  assert.ok(!JSON.stringify(result).includes(SECRET));assert.ok(!JSON.stringify(result).includes(ORIGIN));assert.equal(socketHandlers.size,0);
  assert.equal(result.enterpriseBinding,false);assert.equal(result.requestAuthorized,false);assert.equal(result.consumable,false);assert.equal(result.runtimeEvaluated,false);assert.equal(result.navigationPerformed,false);
  return{result,calls,saved,released,retained,reads,notified};
}
test('manual-query observation arms only after guards, stores raw JSON privately and returns counts only',async()=>{
  const r=await run();assert.equal(r.result.status,'invoice_observation_quarantined');assert.equal(r.result.artifactRef,newRef);assert.equal(r.notified,1);
  assert.equal(r.result.counts.bodiesSaved,1);assert.equal(r.result.cleanupConfirmed,true);assert.equal(r.saved[0].requests.length,1);assert.ok(JSON.stringify(r.saved[0]).includes(SECRET));
  assert.deepEqual(r.result.safeAssetRefs,[]);assert.equal(Object.hasOwn(r.result,'responseShapes'),false);assert.equal(r.saved[0].requests[0].readOnlyVerified,false);
  assert.ok(r.calls.indexOf('Target.detachFromTarget')<r.calls.indexOf('close'));assert.ok(r.calls.indexOf('close')<r.calls.indexOf('release'));assert.ok(r.calls.indexOf('release')<r.calls.indexOf('save'));
});
test('disabled and malformed API are inert; observation duration is bounded in trusted dependencies',async()=>{
  assert.equal((await observeTaxInvoicePage({snapshotRef,navigationArtifactRef})).status,'not_enabled');
  for(const args of [{},{snapshotRef,navigationArtifactRef,url:ORIGIN}])assert.equal((await new TaxDownloadInvoiceObserver().observe(args)).status,'input_invalid');
  for(const durationMs of [0,180001,Infinity])assert.equal((await run('normal',{durationMs})).result.status,'input_invalid');
});
for(const mode of ['wrong_parent','wrong_source','wrong_target','no_ack','wrong_host','abandoned','wrong_browser','stale_document','lock_busy'])test(mode+' cannot arm or consume stale scope',async()=>{
  const r=await run(mode);assert.equal(r.result.status,'invoice_observation_failed');assert.equal(r.notified,0);assert.equal(r.reads,0);assert.equal(r.saved.length,0);
});
test('same origin main frame/loader read candidates exclude auth/write/external/subframe and incomplete responses',async()=>{
  const r=await run('filters');assert.equal(r.result.counts.bodiesSaved,1);assert.equal(r.reads,1);assert.equal(r.result.counts.authentication,2);assert.equal(r.result.counts.write,2);
  assert.equal(r.result.counts.external,1);assert.equal(r.result.counts.subframe,2);
});
for(const mode of ['scope_wait','scope_read','frame_aba','registration_lost','scope_detach','late_redirect'])test(mode+' discards contents and releases precisely cleaned own exclusion',async()=>{
  const r=await run(mode);assert.equal(r.result.status,'invoice_observation_failed');assert.equal(r.saved.length,0);assert.equal(r.result.counts.bodiesSaved,0);assert.equal(r.released,1);assert.equal(r.retained,0);
});
for(const mode of ['attach_unknown','detach_failure','off_failure','close_failure','socket_no_close','release_failure','admin_lost'])test(mode+' retains on own cleanup uncertainty',async()=>{
  const r=await run(mode);assert.equal(r.result.status,'invoice_observation_failed');assert.equal(r.result.cleanupConfirmed,false);assert.equal(r.retained,1);assert.equal(r.saved.length,0);
});
for(const mode of ['empty','body_unavailable','body_invalid','bad_base64','oversize','redirect_read','finish_replaced','response_replaced'])test(mode+' records a truthful response gap without replay',async()=>{
  const r=await run(mode);assert.equal(r.result.status,'invoice_observation_quarantined');assert.equal(r.result.counts.bodiesSaved,0);assert.equal(r.result.bodyGap,'no_completed_matching_json_body');assert.equal(r.result.cleanupConfirmed,true);
});
test('base64 JSON remains private',async()=>{const r=await run('base64');assert.equal(r.result.counts.bodiesSaved,1);});
test('only the current and two fixed national official origins may be passively captured in current scope',async()=>{
  const r=await run('official_cross_origin');assert.equal(r.result.counts.bodiesSaved,3);assert.equal(r.result.counts.distinctOfficialOriginCount,3);
  assert.equal(r.result.counts.crossOrigin,2);assert.equal(r.result.counts.external,1);assert.equal(r.saved[0].requests.length,3);
  assert.equal(JSON.stringify(r.saved[0]).includes('unknown.chinatax.gov.cn'),false);assert.equal(JSON.stringify(r.result).includes('dppt.chinatax.gov.cn'),false);
});
test('metadata/body and aggregate byte limits are explicit partial',async()=>{
  const a=await run('metadata_limit');assert.equal(a.result.counts.metadata,48);assert.ok(a.result.counts.bodiesSaved<=12);assert.ok(a.reads<=12);assert.equal(a.result.truncated,true);
  const b=await run('total_limit');assert.ok(b.result.counts.bytesSaved<=8388608);assert.equal(b.result.truncated,true);
});
test('callback/storage/admin close errors expose no incomplete reference',async()=>{
  for(const mode of ['armed_failure','storage_failure','admin_close_failure']){const r=await run(mode);assert.equal(r.result.status,'invoice_observation_failed');assert.equal(r.result.artifactRef,undefined);}
});
