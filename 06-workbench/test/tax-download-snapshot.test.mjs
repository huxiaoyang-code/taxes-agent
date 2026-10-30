// 仅用合成数据：不使用私有文件、真实浏览器、网络或渲染器代码。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TaxDownloadSnapshot} from '../server/tax-download-snapshot.mjs';
import {snapshotTaxDownloadPage} from '../scripts/snapshot-tax-download-page.mjs';

const SECRET='SENTINEL_PRIVATE_SCRIPT_BUSINESS_913501123456789012',ORIGIN='https://etax.fujian.chinatax.gov.cn:8443';
const artifactRef='taxdownloadpage_'+'1'.repeat(48),sourceRef='taxsource_'+'2'.repeat(48),newRef='taxdownloadpage_'+'3'.repeat(48);
const registrationRef='taxr_'+'4'.repeat(48),browserKey='5'.repeat(64);
const script='const businessValue='+JSON.stringify(SECRET)+';';
async function run(mode='normal',extra={}){
  const calls=[],handlers=new Map(),saved=[],socketHandlers=new Set();let released=0,retained=0,adminClosed=0,closed=false,sourceReads=0,elapsed=0,adminLost=false;
  const source={registrationRef,registrationRoot:'D:/synthetic/.agent-runs/registry',browserKey,targetId:SECRET+'_TARGET',
    document:{fullUrl:'https://obsolete.invalid/'},capturedAt:1,identity:{recipe:{forbidden:true}}};
  const parent={version:1,sourceRef,target:'financial_report',evidence:'quarantined_unverified',consumable:false,
    navigation:{normalNavigationOnly:true,commandConfirmed:true}};
  const document={id:SECRET+'_FRAME',loaderId:SECRET+'_LOADER',url:ORIGIN+'/szzh/zhcx/page',urlFragment:'#'+SECRET};
  const fullUrl=document.url+document.urlFragment;
  const ws={readyState:1,addEventListener(name,fn){assert.equal(name,'close');socketHandlers.add(fn);},
    removeEventListener(name,fn){assert.equal(name,'close');socketHandlers.delete(fn);}};
  const emit=(name,p={},sessionId='own-session')=>handlers.get(name)?.(p,{sessionId});
  const parsed=(id,url=ORIGIN+'/assets/app.'+SECRET+'.js',changes={})=>emit('Debugger.scriptParsed',{
    scriptId:id,url,executionContextId:10,executionContextAuxData:{frameId:document.id,isDefault:true,type:'default'},
    startLine:0,startColumn:0,length:mode==='total_limit'?2097152:mode==='utf8_limit'?750000:script.length,scriptLanguage:'JavaScript',hasSourceURL:false,...changes});
  const opts={enabled:true,clock:()=>elapsed,now:()=>1800000000000,
    store:{async load(ref){assert.equal(ref,sourceRef);calls.push('source_load');return source;},
      async assertNotAbandoned(ref){assert.equal(ref,sourceRef);calls.push('active');if(mode==='abandoned')throw Error(SECRET);}},
    evidence:{async load(ref){assert.equal(ref,artifactRef);if(mode==='unconfirmed')return {...parent,navigation:{...parent.navigation,commandConfirmed:false}};
      if(mode==='nonquarantine')return {...parent,evidence:'observed'};return parent;},
      async save(record){calls.push('save');assert.equal(released,1);assert.equal(adminClosed,1);assert.equal(closed,true);assert.equal(handlers.size,0);
        if(mode==='storage_failure')throw Error(SECRET);saved.push(structuredClone(record));return{artifactRef:newRef,safeAssetRefs:[SECRET]};}},
    acquireAdminGuard:async()=>{calls.push('admin_acquire');if(mode==='admin_busy')throw Error(SECRET);return{
      verify(){calls.push('admin_verify');if(adminLost||mode==='admin_initial_loss')throw Error(SECRET);},
      async close(){calls.push('admin_close');adminClosed++;if(mode==='admin_close_failure')throw Error(SECRET);}};},
    acquireLock:async()=>{calls.push('lock_acquire');if(mode==='lock_busy')throw Error(SECRET);return{async release(){calls.push('release');assert.equal(closed,true);assert.equal(adminClosed,0);assert.equal(handlers.size,0);
      if(mode==='release_failure')throw Error(SECRET);released++;},retain(){retained++;calls.push('retain');}};},
    openDiagnostic:async()=>{calls.push('open');return{
      localScope:{browserKey:mode==='wrong_browser'?'0'.repeat(64):browserKey,registrationState:'quarantined',profilePath:SECRET+'_PROFILE',
        async currentRegistrationState(){return mode==='registration_changed'?'released':'quarantined';}},
      async close(){calls.push('close');await new Promise(done=>setImmediate(done));if(mode==='close_failure')throw Error(SECRET);
        if(mode==='socket_unconfirmed')return;ws.readyState=3;closed=true;for(const fn of socketHandlers)fn();},
      cdp:{ws,on(name,fn){assert.equal(handlers.has(name),false);handlers.set(name,fn);return()=>{calls.push('off:'+name);
        if(mode==='off_failure'&&name==='Page.frameNavigated')throw Error(SECRET);handlers.delete(name);};},
        async send(method,params,options){calls.push(method);
          if(/^(Browser|Target)\./.test(method))assert.equal(options.sessionId,undefined);else assert.equal(options.sessionId,'own-session');
          assert.ok(!/evaluate|callFunction|ResourceContent|ResourceTree|navigate|reload|Network\.|DOM\.|disable|Breakpoint|resume|pause$/.test(method));
          if(method==='Browser.getVersion')return{product:mode==='wrong_version'?'Edg/1.0':'Edg/155.0.4283.62',protocolVersion:'1.3',jsVersion:'15.5.9.7'};
          if(method==='Target.getTargetInfo')return{targetInfo:{targetId:source.targetId,type:'page',url:mode==='external_target'?'https://evil.invalid/':fullUrl}};
          if(method==='Target.attachToTarget'){if(mode==='attach_unknown')throw Error(SECRET);return{sessionId:'own-session'};}
          if(method==='Page.getFrameTree')return{frameTree:{frame:{...document}}};
          if(method==='Page.enable')return{};
          if(method==='Runtime.enable'){
            emit('Runtime.executionContextCreated',{context:{id:10,uniqueId:SECRET+'_CONTEXT',auxData:{frameId:document.id,isDefault:true,type:'default'}}});
            emit('Runtime.executionContextCreated',{context:{id:11,auxData:{frameId:SECRET+'_SUB',isDefault:true,type:'default'}}});return{};
          }
          if(method==='Debugger.setSkipAllPauses'){assert.deepEqual(params,{skip:true});assert.ok(!calls.includes('Debugger.enable'));return{};}
          if(method==='Debugger.enable'){
            assert.ok(calls.includes('Debugger.setSkipAllPauses'));assert.deepEqual(params,{maxScriptsCacheSize:16777216});
            if(['many_scripts','total_limit','deadline'].includes(mode))for(let i=0;i<25;i++)parsed('vendor'+i,ORIGIN+'/assets/vendor.'+i+'.js');
            parsed('app');
            if(mode==='many_scripts')parsed('cwbb',ORIGIN+'/assets/cwbb.'+SECRET+'.js');
            if(mode==='oversize')parsed('large',ORIGIN+'/assets/large.js',{length:2097153});
            if(mode==='bad_bindings'){
              parsed('sub',ORIGIN+'/sub.js',{executionContextId:11});parsed('missing',ORIGIN+'/missing.js',{executionContextId:99});
              parsed('mismatch',ORIGIN+'/mismatch.js',{executionContextAuxData:{frameId:'SUB',isDefault:true,type:'default'}});
              parsed('inline',ORIGIN+'/page');parsed('external','https://evil.invalid/app.js');parsed('data','data:text/javascript,evil');
              parsed('wasm',ORIGIN+'/fake.js',{scriptLanguage:'WebAssembly'});parsed('sourceurl',ORIGIN+'/fake.js',{hasSourceURL:true});
              parsed('missing_sourceurl',ORIGIN+'/fake.js',{hasSourceURL:undefined});
              parsed('offset',ORIGIN+'/fake.js',{startLine:4});parsed('live',ORIGIN+'/fake.js',{isLiveEdit:true});
            }
            if(mode==='metadata_limit')for(let i=0;i<2050;i++)parsed('extra'+i);
            if(mode==='paused')emit('Debugger.paused',{callFrames:[{forbidden:SECRET}]});
            if(mode==='scope_metadata')emit('Page.navigatedWithinDocument',{frameId:document.id});
            return{};
          }
          if(method==='Debugger.getScriptSource'){
            sourceReads++;assert.ok(['app','cwbb'].includes(params.scriptId)||params.scriptId.startsWith('vendor')||params.scriptId.startsWith('extra'));
            if(mode==='source_unavailable')throw Error(SECRET);
            if(mode==='scope_source')emit('Page.frameNavigated',{frame:{...document,loaderId:'CHANGED'}});
            if(mode==='context_destroyed')emit('Runtime.executionContextDestroyed',{executionContextId:10});
            if(mode==='clear')emit('Runtime.executionContextsCleared');
            if(mode==='admin_source_loss')adminLost=true;
            if(mode==='frame_changed')document.loaderId='CHANGED_WITHOUT_EVENT';
            if(mode==='fragment_changed')document.urlFragment='#CHANGED_WITHOUT_EVENT';
            if(mode==='foreign_event')emit('Page.navigatedWithinDocument',{frameId:document.id},'another-session');
            if(mode==='utf8_limit')return{scriptSource:'中'.repeat(750000)};
            if(mode==='total_limit')return{scriptSource:'s'.repeat(2097152)};
            if(mode==='deadline')elapsed=31001;
            return{scriptSource:mode==='length_mismatch'?script+'extra':script};
          }
          if(method==='Target.detachFromTarget'){
            assert.deepEqual(params,{sessionId:'own-session'});if(mode==='detach_failure')throw Error(SECRET);
            if(mode==='admin_cleanup_loss')adminLost=true;
            if(mode==='scope_detach')emit('Page.navigatedWithinDocument',{frameId:document.id});return{};
          }
          throw Error('unexpected synthetic method');
        }}};},...extra};
  const result=await new TaxDownloadSnapshot(opts).capture({artifactRef});
  assert.ok(!JSON.stringify(result).includes(SECRET));assert.ok(!JSON.stringify(result).includes(ORIGIN));
  assert.equal(result.enterpriseBinding,false);assert.equal(result.requestAuthorized,false);assert.equal(result.runtimeEvaluated,false);
  return{result,calls,saved,released,retained,adminClosed,sourceReads,handlers};
}

test('local capture stores only private sources after detach/off/socket close and guarded exact release',async()=>{
  const r=await run();assert.equal(r.result.status,'snapshot_quarantined');assert.equal(r.result.artifactRef,newRef);
  assert.equal(r.result.cleanupConfirmed,true);assert.equal(r.result.scopeStable,true);assert.equal(r.result.counts.captured,1);
  assert.deepEqual(r.result.safeAssetRefs,[]);assert.equal(r.saved.length,1);assert.ok(r.saved[0].assets[0].text.includes(SECRET));
  assert.equal(r.saved[0].snapshot.sourceDocumentReused,false);assert.equal(r.saved[0].requests.length,0);
  assert.ok(r.calls.indexOf('Target.detachFromTarget')<r.calls.indexOf('close'));assert.ok(r.calls.indexOf('close')<r.calls.indexOf('release'));
  assert.ok(r.calls.indexOf('release')<r.calls.indexOf('admin_close'));assert.ok(r.calls.indexOf('admin_close')<r.calls.indexOf('save'));
});
test('default and invalid API do no work',async()=>{
  assert.equal((await snapshotTaxDownloadPage({artifactRef})).status,'not_enabled');
  for(const input of [{},{artifactRef,sourceRef},{artifactRef:'bad'},{artifactRef,url:ORIGIN}])assert.equal((await new TaxDownloadSnapshot().capture(input)).status,'input_invalid');
});
for(const mode of ['unconfirmed','nonquarantine','abandoned','wrong_browser','registration_changed','wrong_version','external_target','admin_busy','admin_initial_loss','lock_busy'])test(mode+' fails closed before source reads',async()=>{
  const r=await run(mode);assert.equal(r.result.status,'snapshot_failed');assert.equal(r.sourceReads,0);assert.equal(r.saved.length,0);assert.equal(r.calls.includes('Debugger.enable'),false);
});
for(const mode of ['scope_metadata','paused','scope_source','context_destroyed','clear','scope_detach','frame_changed','fragment_changed'])test(mode+' discards all and releases only own confirmed-cleaned exclusion',async()=>{
  const r=await run(mode);assert.equal(r.result.status,'snapshot_failed');assert.equal(r.saved.length,0);assert.equal(r.result.counts.captured,0);
  assert.equal(r.released,1);assert.equal(r.retained,0);assert.equal(r.result.cleanupConfirmed,true);assert.equal(r.result.scopeStable,false);
  assert.equal(r.calls.some(m=>m==='Debugger.resume'),false);
});
for(const mode of ['attach_unknown','detach_failure','off_failure','close_failure','socket_unconfirmed','release_failure','admin_source_loss','admin_cleanup_loss'])test(mode+' retains on own cleanup uncertainty',async()=>{
  const r=await run(mode);assert.equal(r.result.status,'snapshot_failed');assert.equal(r.result.lockRetained,true);assert.equal(r.retained,1);
  assert.equal(r.saved.length,0);assert.equal(r.result.cleanupConfirmed,false);
});
test('OS guard close failure cannot publish despite already released collection exclusion',async()=>{
  const r=await run('admin_close_failure');assert.equal(r.released,1);assert.equal(r.result.cleanupConfirmed,false);assert.equal(r.saved.length,0);
});
test('source unavailable is bounded cache miss, no fallback loader/request',async()=>{
  const r=await run('source_unavailable');assert.equal(r.result.status,'snapshot_quarantined');assert.equal(r.result.counts.unavailable,1);assert.equal(r.result.counts.captured,0);
});
test('only current default main context and genuine official JS metadata are selected',async()=>{
  const r=await run('bad_bindings');assert.equal(r.result.counts.rejected,11);assert.equal(r.sourceReads,1);assert.equal(r.result.counts.captured,1);
});
test('foreign session scope events have no effect',async()=>{assert.equal((await run('foreign_event')).result.status,'snapshot_quarantined');});
test('app/cwbb chosen before vendors with finite twelve-script cap',async()=>{
  const r=await run('many_scripts');assert.equal(r.result.counts.captured,12);assert.equal(r.result.truncated,true);assert.equal(r.saved[0].assets[0].sourceUrl.includes('app.'),true);
  assert.equal(r.saved[0].assets[1].sourceUrl.includes('cwbb.'),true);
});
test('UTF8 byte and metadata length budgets reject oversized sources',async()=>{
  const a=await run('oversize');assert.equal(a.result.counts.captured,1);assert.equal(a.result.counts.budgetSkipped,1);
  const b=await run('utf8_limit');assert.equal(b.result.counts.captured,0);assert.equal(b.result.counts.budgetSkipped,1);
});
test('metadata cap is explicit partial',async()=>{const r=await run('metadata_limit');assert.equal(r.result.truncated,true);assert.equal(r.result.counts.eligible,2048);assert.equal(r.sourceReads,12);});
test('total byte limit and work deadline produce bounded partial snapshots',async()=>{
  const a=await run('total_limit');assert.equal(a.result.counts.captured,8);assert.equal(a.result.counts.bytes,16777216);assert.equal(a.result.truncated,true);
  const b=await run('deadline');assert.equal(b.sourceReads,1);assert.equal(b.result.truncated,true);assert.equal(b.result.cleanupConfirmed,true);
});
test('source length must match the observed compiled script metadata',async()=>{const r=await run('length_mismatch');assert.equal(r.result.counts.captured,0);assert.equal(r.result.counts.unavailable,1);});
test('private store failure exposes neither source nor incomplete reference',async()=>{const r=await run('storage_failure');assert.equal(r.result.status,'snapshot_failed');assert.equal(r.result.artifactRef,undefined);});
