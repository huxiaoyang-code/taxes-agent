import test from 'node:test';
import assert from 'node:assert/strict';
import {observedRecipe,collectionShape} from '../server/tax-collection-shape.mjs';
import {observeTaxNavigation} from '../scripts/observe-tax-navigation.mjs';
import {pageReference} from '../scripts/inventory-tax-browser.mjs';
const origin='https://etax.fujian.chinatax.gov.cn:8443',registrationRef='taxr_'+'1'.repeat(48),targetId='private';
test('recipes require exact method, query keys and known fixed body',()=>{
  const url=origin+'/xxzx/api/nsrxxzx/txzx/dbrw/v1/listNsrDbxx?t=PRIVATE';
  assert.equal(observedRecipe({url,method:'POST',postData:'{"Jsqd":"01"}'}).recipeMatches,true);
  assert.equal(observedRecipe({url,method:'POST',postData:'{"Jsqd":"01","secret":"PRIVATE"}'}).recipeMatches,false);
  assert.equal(observedRecipe({url:url+'&token=PRIVATE',method:'POST',postData:'{"Jsqd":"01"}'}).recipeMatches,false);
  assert.equal(observedRecipe({url:origin+'/getDbrwtstx',method:'POST'}),null);
  const filing=origin+'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx';
  assert.equal(observedRecipe({url:filing,method:'POST',postData:'{"Csbz":""}'}).recipeMatches,true);
  assert.equal(observedRecipe({url:filing,method:'POST',postData:'{"Request":{"Data":{"Csbz":""}}}'}).recipeMatches,false);
});
test('schema drops arbitrary key names and every scalar business value',()=>{
  const result=collectionShape({returnCode:'1',data:{userinfo:{reg_number:'PRIVATE',PRIVATE_COMPANY:'PRIVATE'},
    ysbList:[{ssqq:'PRIVATE',PRIVATE_INVOICE:'PRIVATE'}],dqswsList:[],qtList:[],fxydList:[]}});
  assert.equal(result.todoShape,true);assert.equal(result.businessStatus,'success');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
  assert.equal(result.schema.find(r=>r.path==='$.data.userinfo').unknownFieldCount,1);
});
test('normal navigation observes only permitted resources and cannot rearm leases',async()=>{
  const handlers=new Map(),calls=[],emit=(name,p)=>handlers.get(name)?.(p,{sessionId:'s'});
  const result=await observeTaxNavigation({registrationRef,pageRef:pageReference(registrationRef,targetId),destination:'portal_index'},
    {acquireLock:async()=>({async release(){},retain(){}}),wait:async()=>{},openDiagnostic:async()=>({localScope:{registrationState:'quarantined',async currentRegistrationState(){return'quarantined'}},close(){calls.push('close')},cdp:{on(name,fn){handlers.set(name,fn);return()=>handlers.delete(name)},
      async send(method,params){calls.push(method);
        if(method==='Target.getTargets')return{targetInfos:[{type:'page',targetId,url:origin+'/loginb/'}]};
        if(method==='Target.attachToTarget')return{sessionId:'s'};
        if(method==='Page.navigate'){
          assert.equal(params.url,origin+'/mhzx/api/mh/mhsy/index');
          emit('Runtime.executionContextsCleared',{});emit('Page.frameNavigated',{frame:{id:'frame',loaderId:'loader'}});
          emit('Network.requestWillBeSent',{requestId:'r',frameId:'frame',loaderId:'loader',request:{url:origin+'/mhzx/api/mh/mhsy/getUserInfo?t=PRIVATE',method:'GET'}});
          emit('Network.responseReceived',{requestId:'r',response:{status:200}});
          emit('Network.loadingFinished',{requestId:'r',encodedDataLength:80});
          emit('Network.requestWillBeSent',{requestId:'x',request:{url:origin+'/private/PRIVATE',method:'GET'}});
          emit('Network.loadingFinished',{requestId:'x',encodedDataLength:80});
          return{frameId:'frame',loaderId:'loader'};
        }
        if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'frame',loaderId:'loader'}}};
        if(method==='Network.getResponseBody')return{body:'{"Response":{"Data":{"userinfo":{"reg_number":"PRIVATE"}}}}'};
        return{};
      }}})});
  assert.equal(result.status,'observed');assert.equal(result.contextDestroyed,true);assert.equal(result.loaderObserved,true);
  assert.equal(result.captures.length,1);assert.equal(result.captures[0].identityShape,true);
  assert.equal(result.leaseChanged,false);assert.equal(result.scopeVerified,false);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
  assert.equal(calls.includes('Target.detachFromTarget'),true);
});
test('prepare-only cannot send navigation, and failures expose only fixed phase markers',async()=>{
  const calls=[];
  const fake={acquireLock:async()=>({async release(){},retain(){}}),wait:async()=>{},openDiagnostic:async()=>({localScope:{registrationState:'quarantined',async currentRegistrationState(){return'quarantined'}},close(){},cdp:{on(){return()=>{}},async send(method){
    calls.push(method);
    if(method==='Target.getTargets')return{targetInfos:[{type:'page',targetId,url:origin+'/loginb/'}]};
    if(method==='Target.attachToTarget')return{sessionId:'s'};
    return{};
  }}})};
  const args={registrationRef,pageRef:pageReference(registrationRef,targetId),destination:'portal_home',prepareOnly:true};
  const prepared=await observeTaxNavigation(args,fake);
  assert.equal(prepared.status,'prepared');assert.equal(prepared.navigationSent,false);assert.equal(calls.includes('Page.navigate'),false);
  const failed=await observeTaxNavigation(args,{openDiagnostic:async()=>{throw new Error('PRIVATE')}});
  assert.equal(failed.phase,'open');assert.equal(failed.navigationSent,false);assert.doesNotMatch(JSON.stringify(failed),/PRIVATE/);
});
test('initial navigation events may arrive late but same-loader ABA before navigation reply is rejected',async()=>{
  async function scenario({earlyAba=false,duplicateClear=false}={}){
    const handlers=new Map(),emit=(name,p)=>handlers.get(name)?.(p,{sessionId:'s'});
    const bootstrap=()=>{emit('Runtime.executionContextsCleared',{});emit('Page.frameNavigated',{frame:{id:'frame',loaderId:'loader'}})};
    return observeTaxNavigation({registrationRef,pageRef:pageReference(registrationRef,targetId),destination:'portal_index'},{
      acquireLock:async()=>({async release(){},retain(){}}),
      wait:async()=>{if(!earlyAba)bootstrap();if(duplicateClear)emit('Runtime.executionContextsCleared',{})},
      openDiagnostic:async()=>({localScope:{registrationState:'quarantined',async currentRegistrationState(){return'quarantined'}},close(){},
        cdp:{on(name,fn){handlers.set(name,fn);return()=>handlers.delete(name)},async send(method){
          if(method==='Target.getTargets')return{targetInfos:[{type:'page',targetId,url:origin+'/loginb/'}]};
          if(method==='Target.attachToTarget')return{sessionId:'s'};
          if(method==='Page.navigate'){
            if(earlyAba){bootstrap();emit('Page.navigatedWithinDocument',{frameId:'frame'});emit('Page.navigatedWithinDocument',{frameId:'frame'})}
            return{frameId:'frame',loaderId:'loader'};
          }
          if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'frame',loaderId:'loader'}}};
          return{};
        }}}),
    });
  }
  assert.equal((await scenario()).status,'observed','one late bootstrap should remain a valid authorized navigation');
  const beforeReply=await scenario({earlyAba:true});
  assert.equal(beforeReply.status,'observation_failed');assert.equal(beforeReply.navigationSent,true);
  assert.deepEqual(beforeReply.scopeDiagnostics.events.map(e=>e.kind),['context_clear','initial_frame','within_document','within_document']);
  assert.equal(beforeReply.scopeDiagnostics.events.filter(e=>e.disposition==='violation').length,2);
  assert.deepEqual(beforeReply.scopeDiagnostics.events.map(e=>e.order),[1,2,3,4]);
  assert.doesNotMatch(JSON.stringify(beforeReply.scopeDiagnostics),/frameId|loaderId|targetId|PRIVATE|https:|private/);
  assert.equal((await scenario({duplicateClear:true})).status,'observation_failed','bootstrap exemption cannot be reused');
});
test('bounded double-clear bootstrap closes on any new-document business request, including before reply',async()=>{
  async function scenario({clearCount=2,businessBeforeClear=false,unknownXhr=false}={}){
    const handlers=new Map(),emit=(name,p)=>handlers.get(name)?.(p,{sessionId:'s'});
    return observeTaxNavigation({registrationRef,pageRef:pageReference(registrationRef,targetId),destination:'portal_index'},{
      acquireLock:async()=>({async release(){},retain(){}}),wait:async()=>{},
      openDiagnostic:async()=>({localScope:{registrationState:'quarantined',async currentRegistrationState(){return'quarantined'}},close(){},
        cdp:{on(name,fn){handlers.set(name,fn);return()=>handlers.delete(name)},async send(method){
          if(method==='Target.getTargets')return{targetInfos:[{type:'page',targetId,url:origin+'/loginb/'}]};
          if(method==='Target.attachToTarget')return{sessionId:'s'};
          if(method==='Page.navigate'){
            emit('Runtime.executionContextsCleared',{});
            if(businessBeforeClear)emit('Network.requestWillBeSent',{requestId:'r',frameId:'frame',loaderId:'loader',type:'XHR',
              request:{url:origin+(unknownXhr?'/synthetic-read':'/mhzx/api/mh/mhsy/getUserInfo'),method:'GET'}});
            for(let i=1;i<clearCount;i++)emit('Runtime.executionContextsCleared',{});
            emit('Page.frameNavigated',{frame:{id:'frame',loaderId:'loader'}});
            return{frameId:'frame',loaderId:'loader'};
          }
          if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'frame',loaderId:'loader'}}};
          return{};
        }}}),
    });
  }
  assert.equal((await scenario()).status,'observed');
  assert.equal((await scenario({clearCount:3})).status,'observation_failed','initial allowance is bounded to observed two clears');
  assert.equal((await scenario({businessBeforeClear:true})).status,'observation_failed','reply-before-business cannot be mistaken for pre-business bootstrap');
  assert.equal((await scenario({businessBeforeClear:true,unknownXhr:true})).status,'observation_failed','a new-document XHR closes the allowance conservatively');
});
