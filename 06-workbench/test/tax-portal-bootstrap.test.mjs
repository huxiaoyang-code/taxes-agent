// 纯合成 CDP 和内存私有存储/审计。不使用真实数据或文件。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootstrapTaxPortalSource } from '../scripts/bootstrap-tax-portal-source.mjs';
import { pageReference } from '../scripts/inventory-tax-browser.mjs';
import { validateEvidence } from '../server/tax-collection-contract.mjs';
const ORIGIN='https://etax.fujian.chinatax.gov.cn:8443',PORTAL=ORIGIN+'/loginb/',PRIVATE='SENTINEL_BOOTSTRAP_PRIVATE';
const identityPath='/mhzx/api/mh/mhsy/getUserInfo',filingPath='/mhzx/api/mh/wddb/v1/wddbquerybbsmxx';

async function run(mode='normal',execute=true,extra={}){
  const registrationRef='taxr_'+'1'.repeat(48),targetId=PRIVATE+'_TARGET',pageRef=pageReference(registrationRef,targetId);
  const handlers=new Map(),calls=[],stored=[],audits=[],resources=[];
  const socketListeners=new Set(),ws={readyState:1,addEventListener(name,fn){assert.equal(name,'close');socketListeners.add(fn);},
    removeEventListener(name,fn){assert.equal(name,'close');socketListeners.delete(fn);}};
  const closeSocket=()=>{ws.readyState=3;for(const fn of socketListeners)fn();};
  let frame={id:PRIVATE+'_FRAME',loaderId:PRIVATE+'_OLD',url:PORTAL},released=0,retained=0,closed=false,attempts=0,reloaded=false;
  if(extra.openPortal===true||mode==='away')frame={...frame,url:ORIGIN+'/szzh/zhcx/financial',urlFragment:'#/list'};
  if(mode==='initial_auth')frame.url=ORIGIN+'/oauth/callback';
  if(mode==='initial_write')frame.url=ORIGIN+'/szzh/save';
  if(mode==='initial_external')frame.url='https://dppt.fujian.chinatax.gov.cn:8443/kpfw/list';
  if(mode==='initial_credential')frame.urlFragment='#/list?token=PRIVATE';
  const identity={Response:{Data:{userinfo:{reg_number:PRIVATE+'_REG',company_name:PRIVATE+'_CO',creditCode:PRIVATE+'_CC',taxpayer_id:PRIVATE+'_TAX'}}}};
  const filing={Response:{Data:{wsbxxGrid:[{sbb:PRIVATE+'_FRESH_FORM'}]}}};
  const emit=(name,p={})=>handlers.get(name)?.(p,{sessionId:'synthetic-session'});
  const request=(resource,loader=frame.loaderId,body={Csbz:''},query='?t=PRIVATE')=>{
    emit('Network.requestWillBeSent',{frameId:frame.id,loaderId:loader,request:{url:ORIGIN+(resource==='identity'?identityPath:filingPath)+query,
      method:resource==='identity'?'GET':'POST',...resource==='identity'?{}:{postData:JSON.stringify(body)}}});
  };
  const out=await bootstrapTaxPortalSource({registrationRef,registrationRoot:'D:/synthetic/.agent-runs/tax-browser-registry',pageRef,execute,readerStoppedConfirmed:execute,...extra},{
    now:()=>1800000000000,
    acquireLock:async()=>{calls.push('lock_acquire');return{async release(){calls.push('lock_release');assert.equal(closed,true);assert.equal(handlers.size,0);
      if(mode==='release_failure')throw Error(PRIVATE);released++;},retain(){calls.push('lock_retain');retained++;}};},
    store:{async save(kind,value){calls.push('save:'+kind);assert.equal(released,1);validateEvidence(kind,value);
      if(mode==='run_save_failure'&&kind==='run')throw Error(PRIVATE);stored.push({kind,value:structuredClone(value)});
      return 'tax'+kind+'_'+(kind==='source'?'2':'3').repeat(48);}},
    audit:async value=>{calls.push('audit:'+value.state);audits.push(structuredClone(value));
      if(mode==='publish_audit_failure'&&value.state==='published')throw Error(PRIVATE);
      if(mode==='late_scope_audit'&&value.state==='fresh_verified')emit('Page.navigatedWithinDocument',{frameId:frame.id});},
    wait:async ms=>{calls.push('wait:'+ms);if(ms===500&&mode==='quiet_aba'){
      emit('Page.navigatedWithinDocument',{frameId:frame.id});emit('Page.navigatedWithinDocument',{frameId:frame.id});}},
    openDiagnostic:async()=>({localScope:{registrationState:'quarantined',browserKey:'a'.repeat(64),profilePath:PRIVATE+'_PROFILE',
      currentRegistrationState:async()=>'quarantined'},
      async close(){calls.push('close_start');
        if(mode==='socket_no_close')return;
        if(mode==='socket_event_early'){closeSocket();closed=true;calls.push('close_done');return;}
        if(mode==='socket_event_without_closed'){for(const fn of socketListeners)fn();return;}
        await new Promise(done=>setImmediate(done));if(mode==='close_failure')throw Error(PRIVATE);closeSocket();closed=true;calls.push('close_done');},
      cdp:{ws,on(name,fn){handlers.set(name,fn);return()=>{calls.push('off:'+name);if(mode==='off_failure'&&name==='Page.frameNavigated')throw Error(PRIVATE);handlers.delete(name);};},
        async send(method,params,opts){calls.push(method);
          if(method.startsWith('Target.'))assert.equal(opts.sessionId,undefined,'Target commands belong to the browser connection');
          else assert.equal(opts.sessionId,'synthetic-session');
          if(method==='Target.getTargets')return{targetInfos:[{type:'page',targetId:mode==='target_mismatch'?targetId+'_OTHER':targetId,url:frame.url+(frame.urlFragment||'')},{type:'page',targetId:PRIVATE+'_AUTH',url:'https://tpass.fujian.chinatax.gov.cn:8443/'}]};
          if(method==='Target.attachToTarget'){if(mode==='attach_unknown')throw Error(PRIVATE);return{sessionId:'synthetic-session'};}
          if(['Network.enable','Page.enable','Runtime.enable'].includes(method))return{};
          if(method==='Page.getFrameTree')return{frameTree:{frame:{...frame}}};
          if(method==='Page.reload'||method==='Page.navigate'){
            if(method==='Page.reload'){assert.equal(extra.openPortal===true,false);assert.deepEqual(params,{});}
            else{assert.equal(extra.openPortal,true);assert.deepEqual(params,{url:PORTAL,frameId:frame.id});}
            reloaded=true;if(mode==='reload_unknown'||mode==='navigate_unknown')throw Error(PRIVATE);
            for(let i=0;i<6;i++)emit('Runtime.executionContextsCleared');
            for(const loader of [PRIVATE+'_EARLY1',PRIVATE+'_EARLY2']){
              emit('Page.frameNavigated',{frame:{...frame,loaderId:loader,url:ORIGIN+'/szzh/'}});
              request('identity',loader);request('current_filing',loader);
            }
            frame={...frame,loaderId:PRIVATE+'_FINAL',url:PORTAL};delete frame.urlFragment;
            if(mode!=='unobserved_final')emit('Page.frameNavigated',{frame:{...frame}});
            if(mode==='mainframe_limit')for(let i=0;i<9;i++)emit('Page.frameNavigated',{frame:{...frame}});
            if(mode==='wrong_full_url')frame.urlFragment='#PRIVATE';
            if(mode!=='missing_final_identity')request('identity');
            if(mode!=='missing_final_filing'){
              const body=mode==='wrong_body'?{Csbz:'synthetic'}:mode==='extra_body'?{Csbz:'',extra:PRIVATE}:{Csbz:''};
              const query=mode==='duplicate_query'?'?t=1&t=2':mode==='extra_query'?'?token=PRIVATE':'?t=PRIVATE';
              request('current_filing',frame.loaderId,body,query);
              if(mode==='ambiguous_recipe')request('current_filing',frame.loaderId,{Csbz:''},'');
            }
            if(mode==='metadata_limit')for(let i=0;i<70;i++)request('identity');
            if(method==='Page.navigate'){
              if(mode==='nav_void_ack')return{};
              if(mode==='nav_bad_frame')return{frameId:'OTHER',loaderId:frame.loaderId};
              if(mode==='nav_old_loader')return{frameId:frame.id,loaderId:PRIVATE+'_OLD'};
              if(mode==='nav_download')return{frameId:frame.id,loaderId:frame.loaderId,isDownload:true};
              if(mode==='nav_error')return{frameId:frame.id,loaderId:frame.loaderId,errorText:PRIVATE};
              return{frameId:frame.id,loaderId:frame.loaderId};
            }return{};
          }
          if(method==='Runtime.evaluate'){
            attempts++;const requestRef=params.expression.match(/taxreq_[a-f0-9]{48}/)?.[0];assert.ok(requestRef);
            const resource=params.expression.includes(filingPath)?'current_filing':'identity';resources.push(resource);
            assert.equal(reloaded,true);assert.equal(frame.loaderId,PRIVATE+'_FINAL');assert.ok(params.expression.includes(JSON.stringify(PORTAL)));
            if(mode==='request_unknown'||mode==='unknown_last'&&attempts===3)throw Error(PRIVATE);
            if(mode==='wrong_request_ref')return{result:{value:{status:'observed',settled:true,requestRef:'wrong'}}};
            if(mode==='terminal_scope_changed')return{result:{value:{status:'scope_changed',settled:true}}};
            if(mode==='scope_after_settled')emit('Page.navigatedWithinDocument',{frameId:frame.id});
            if(mode==='scope_and_unknown'){emit('Page.navigatedWithinDocument',{frameId:frame.id});return{result:{value:{status:'request_unconfirmed',settled:false}}};}
            const body=structuredClone(resource==='identity'?identity:filing);
            if(mode==='credit_changed'&&attempts===3)body.Response.Data.userinfo.creditCode+='_CHANGED';
            if(mode==='taxpayer_changed'&&attempts===3)body.Response.Data.userinfo.taxpayer_id+='_CHANGED';
            if(mode==='missing_credit'&&resource==='identity')delete body.Response.Data.userinfo.creditCode;
            if(mode==='business_failed'&&resource==='current_filing')body.Response.Error={message:PRIVATE};
            const value={status:'observed',settled:true,requestRef,requestPerformed:true,responseComplete:true,body};
            if(mode==='performed_false')value.requestPerformed=false;if(mode==='performed_missing')delete value.requestPerformed;
            if(mode==='complete_false')value.responseComplete=false;if(mode==='complete_missing')delete value.responseComplete;
            return{result:{value}};
          }
          if(method==='Target.detachFromTarget'){
            if(mode==='detach_failure')throw Error(PRIVATE);
            if(mode==='scope_during_detach')emit('Page.navigatedWithinDocument',{frameId:frame.id});
            emit('Target.detachedFromTarget',{sessionId:'synthetic-session'});return{};
          }
          throw Error('unexpected synthetic CDP method');
        }},
    }),
  });
  assert.doesNotMatch(JSON.stringify(out),/SENTINEL|PRIVATE|https?:|frameId|loaderId|browserKey|reg_number|creditCode|taxpayer_id/);
  assert.ok(!calls.some(c=>c.endsWith('.disable')||c==='Network.getResponseBody'||extra.openPortal!==true&&c==='Page.navigate'));
  assert.equal(socketListeners.size,0);
  return{out,calls,stored,audits,resources,released,retained};
}

test('diagnosis has no browser action, active request, lock or audit write',async()=>{
  const {out,calls,stored,audits}=await run('normal',false);assert.equal(out.status,'portal_bootstrap_diagnosed');
  assert.ok(!calls.includes('Page.reload'));assert.ok(!calls.includes('Runtime.evaluate'));assert.ok(!calls.includes('lock_acquire'));
  assert.deepEqual(stored,[]);assert.deepEqual(audits,[]);
});

test('quarantined multi-document bootstrap publishes compatible source plus fully fresh run and binding audit',async()=>{
  const {out,calls,stored,audits,resources,released}=await run();assert.equal(out.status,'portal_source_created');
  assert.equal(out.mode,'full_fresh_portal_bootstrap_v1');assert.equal(out.fullFreshThree,true);assert.equal(out.earlyProjectionUsed,false);
  assert.equal(out.identityProjectionMatched,true);assert.equal(out.phase,'complete');
  assert.equal(out.bootstrapMainFrameCount,3);assert.equal(out.discardedRecipeCount,4);assert.equal(out.finalScopeSealed,true);
  assert.equal(out.requestAttemptedCount,3);assert.equal(out.requestSettledCount,3);assert.equal(out.responseCompleteCount,3);
  assert.deepEqual(resources,['identity','current_filing','identity']);assert.equal(released,1);assert.equal(stored.length,2);
  assert.equal(stored[0].value.filing.projection.wsbxxGrid[0].sbb,PRIVATE+'_FRESH_FORM');
  assert.equal(stored[1].value.sourceRef,out.sourceRef);assert.equal(stored[1].value.requestProof.length,3);
  assert.equal(audits.at(-1).sourceRef,out.sourceRef);assert.equal(audits.at(-1).runRef,out.runRef);
  assert.ok(calls.indexOf('Target.detachFromTarget')<calls.findIndex(c=>c.startsWith('off:')));
  assert.ok(calls.indexOf('close_done')<calls.indexOf('lock_release'));assert.ok(calls.indexOf('lock_release')<calls.indexOf('save:source'));
});

for(const mode of ['missing_final_identity','missing_final_filing','wrong_body','extra_body','duplicate_query','extra_query','ambiguous_recipe','metadata_limit',
  'mainframe_limit','quiet_aba','wrong_full_url','unobserved_final'])test(mode+' discards candidates without guessing a recipe or leaving settled owned work locked',async()=>{
    const {out,stored,resources,released,retained}=await run(mode);assert.equal(out.status,'portal_bootstrap_failed');assert.equal(out.sourcePublished,false);
    assert.equal(stored.length,0);assert.deepEqual(resources,[]);assert.equal(released,1);assert.equal(retained,0);assert.equal(out.lockRetained,false);
  });

for(const mode of ['scope_after_settled','terminal_scope_changed','credit_changed','taxpayer_changed','missing_credit','business_failed','late_scope_audit','scope_during_detach'])
  test(mode+' forbids all source publication but releases precisely settled owned work after confirmed cleanup',async()=>{
    const {out,stored,released,retained}=await run(mode);assert.equal(out.status,'portal_bootstrap_failed');assert.equal(stored.length,0);
    assert.equal(out.lockRetained,false);assert.equal(released,1);assert.equal(retained,0);assert.equal(out.requestAttemptedCount,out.requestSettledCount);
    assert.equal(Object.hasOwn(out,'sourceRef'),false);
  });

for(const mode of ['attach_unknown','reload_unknown','request_unknown','unknown_last','wrong_request_ref','performed_false','performed_missing','complete_false','complete_missing',
  'scope_and_unknown','detach_failure','off_failure','close_failure','release_failure'])
  test(mode+' retains exclusion on unknown owned execution or cleanup',async()=>{
    const {out,stored,released,retained}=await run(mode);assert.equal(out.status,'portal_bootstrap_failed');assert.equal(stored.length,0);
    assert.equal(out.lockRetained,true);assert.equal(released,0);assert.equal(retained,1);assert.equal(out.cleanupConfirmed,false);
  });

for(const mode of ['run_save_failure','publish_audit_failure'])test(mode+' keeps orphan evidence private and returns no incomplete association refs',async()=>{
  const {out,audits}=await run(mode);assert.equal(out.status,'portal_bootstrap_failed');assert.equal(out.orphanedPublicationPossible,true);
  assert.equal(Object.hasOwn(out,'sourceRef'),false);assert.equal(Object.hasOwn(out,'runRef'),false);assert.equal(out.sourcePublished,false);
  assert.equal(audits.at(-1).state,'publication_partial');assert.ok(audits.at(-1).sourceRef);
});

test('arbitrary URL/body and unconfirmed reader ownership cannot invoke opt-in bootstrap',async()=>{
  for(const extra of [{url:PORTAL},{body:{Csbz:''}},{readerStoppedConfirmed:false},{openPortal:'true'},{openPortal:true,readerStoppedConfirmed:false}]){
    const {out,calls}=await run('normal',true,extra);assert.equal(out.status,'portal_bootstrap_failed');assert.deepEqual(calls,[]);
  }
});

test('openPortal defaults off and cannot act on a nonportal document without explicit opt-in',async()=>{
  const r=await run('away');assert.equal(r.out.status,'portal_bootstrap_failed');assert.equal(r.calls.includes('lock_acquire'),false);
  assert.equal(r.calls.includes('Page.navigate'),false);assert.equal(r.calls.includes('Page.reload'),false);
});
test('openPortal diagnosis remains action-free',async()=>{
  const r=await run('normal',false,{openPortal:true});assert.equal(r.out.status,'portal_bootstrap_diagnosed');
  assert.ok(!r.calls.includes('Page.navigate')&&!r.calls.includes('Page.reload')&&!r.calls.includes('lock_acquire'));assert.deepEqual(r.audits,[]);
});
test('openPortal returns the same precise target to only fixed portal then creates three-fresh source',async()=>{
  const r=await run('normal',true,{openPortal:true});assert.equal(r.out.status,'portal_source_created');assert.equal(r.out.fullFreshThree,true);
  assert.equal(r.calls.filter(c=>c==='Page.navigate').length,1);assert.equal(r.calls.includes('Page.reload'),false);
  assert.deepEqual(r.resources,['identity','current_filing','identity']);assert.equal(r.stored.length,2);
  for(const audit of r.audits){assert.equal(audit.normalFixedPortalReturn,true);assert.equal(audit.navigationAction,'Page.navigate');}
  assert.equal(Object.hasOwn(r.audits[0].oldDocument,'fullUrl'),false);assert.equal(r.released,1);
});
for(const mode of ['initial_auth','initial_write','initial_external','initial_credential','target_mismatch'])test('openPortal rejects '+mode+' before lock/action',async()=>{
  const r=await run(mode,true,{openPortal:true});assert.equal(r.out.status,'portal_bootstrap_failed');assert.equal(r.calls.includes('lock_acquire'),false);
  assert.equal(r.calls.includes('Page.navigate'),false);assert.equal(r.stored.length,0);
});
for(const mode of ['wrong_full_url','quiet_aba','unobserved_final','missing_final_identity','missing_final_filing','wrong_body','scope_after_settled'])test('openPortal preserves strict final guard for '+mode,async()=>{
  const r=await run(mode,true,{openPortal:true});assert.equal(r.out.status,'portal_bootstrap_failed');assert.equal(r.stored.length,0);assert.equal(r.released,1);assert.equal(r.retained,0);
});
for(const mode of ['navigate_unknown','nav_void_ack','nav_bad_frame','nav_old_loader','nav_download','nav_error'])test('openPortal '+mode+' retains unknown owned navigation',async()=>{
  const r=await run(mode,true,{openPortal:true});assert.equal(r.out.status,'portal_bootstrap_failed');assert.equal(r.stored.length,0);assert.equal(r.released,0);
  assert.equal(r.retained,1);assert.equal(r.out.cleanupConfirmed,false);assert.equal(r.out.requestUnknown,true);
});
for(const mode of ['socket_no_close','socket_event_without_closed'])test(mode+' prevents source publication and retains exclusion',async()=>{
  const r=await run(mode,true,{openPortal:true});assert.equal(r.out.status,'portal_bootstrap_failed');assert.equal(r.out.cleanupFailureStep,'transport_close');
  assert.equal(r.out.cleanupConfirmed,false);assert.equal(r.out.lockRetained,true);assert.equal(r.released,0);assert.equal(r.retained,1);assert.equal(r.stored.length,0);
});
test('socket close event before close promise returns is observed before exact release',async()=>{
  const r=await run('socket_event_early',true,{openPortal:true});assert.equal(r.out.status,'portal_source_created');assert.equal(r.out.cleanupConfirmed,true);assert.equal(r.released,1);
});
