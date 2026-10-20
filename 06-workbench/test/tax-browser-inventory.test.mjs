import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {classifyObservedUrl,inventoryRegisteredBrowser,pageReference,OBSERVED_ROUTES} from '../scripts/inventory-tax-browser.mjs';
import {inspectRegisteredPage,PAGE_INSPECTION_SCRIPT} from '../scripts/inspect-tax-page.mjs';
const registrationRef='taxr_'+'1'.repeat(48), targetId='synthetic-private-target';
const official='https://etax.fujian.chinatax.gov.cn:8443';
const pageRef=pageReference(registrationRef,targetId);

test('only exact observed paths are named; auth fields and unknown names never leave inventory',async()=>{
  assert.equal(classifyObservedUrl(official+'.evil.invalid/loginb/'),null);
  assert.equal(classifyObservedUrl('https://secret@etax.fujian.chinatax.gov.cn:8443/loginb/'),null);
  const calls=[];let closed=false;
  const result=await inventoryRegisteredBrowser({registrationRef},{openDiagnostic:async()=>({close(){closed=true},cdp:{async send(method){
    calls.push(method);return {targetInfos:[
      {type:'page',targetId,url:official+'/mhzx/api/mh/mhsy/index?secret=REAL_PRIVATE#private'},
      {type:'page',targetId:'unknown',url:official+'/private-enterprise-name'},
      {type:'page',targetId:'alien',url:'https://unrelated.invalid/private'},
    ]};}}})});
  assert.deepEqual(calls,['Target.getTargets']);assert.equal(closed,true);
  assert.equal(result.pages.length,2);assert.equal(result.pages[0].routeCode,'portal_index');
  assert.equal(result.pages[1].routeCode,'unknown');assert.equal(result.leaseChanged,false);
  assert.doesNotMatch(JSON.stringify(result),/REAL_PRIVATE|private|enterprise|synthetic/);
});
test('invalid references fail without opening browser',async()=>{
  let opened=false;
  assert.equal((await inventoryRegisteredBrowser({registrationRef:'bad'},{openDiagnostic:async()=>{opened=true}})).status,'inventory_failed');
  assert.equal(opened,false);
});
test('page expression projects finite route counts; unknown performance resource stays private',()=>{
  const result=vm.runInNewContext(PAGE_INSPECTION_SCRIPT,{
    URL,location:{href:official+'/mhzx/api/mh/mhsy/index?SECRET'},document:{readyState:'complete'},
    window:{fetch,setTimeout}, performance:{getEntriesByType(){return [
      {name:official+'/mhzx/api/mh/mhsy/getUserInfo?t=SECRET',initiatorType:'fetch'},
      {name:official+'/private-data/PRIVATE?token=PRIVATE',initiatorType:'script'},
    ]}},
  });
  assert.equal(result.resourceCount,2);assert.equal(result.scriptCount,1);
  assert.equal(result.observedResources.find(r=>r.routeCode==='identity').count,1);
  assert.doesNotMatch(JSON.stringify(result),/SECRET|PRIVATE|token|private/);
});
function fakeInspection(value,{changed=false}={}) {
  const calls=[];
  return {calls,openDiagnostic:async()=>({close(){calls.push('close')},cdp:{async send(method){
    calls.push(method);
    if(method==='Target.getTargets')return{targetInfos:[{type:'page',targetId,url:official+'/mhzx/api/mh/mhsy/index'}]};
    if(method==='Target.attachToTarget')return{sessionId:'session'};
    if(method==='Runtime.evaluate')return{result:{value}};
    if(method==='Target.getTargetInfo')return{targetInfo:{url:official+(changed?'/loginb/':'/mhzx/api/mh/mhsy/index')}};
    return{};
  }}})};
}
const clean=()=>({readyState:'complete',fetchNative:true,timerNative:true,resourceCount:2,scriptCount:1,
  observedResources:[...new Set(Object.values(OBSERVED_ROUTES))].map(routeCode=>({routeCode,count:0}))});
test('explicit page binding projects response and never emits injected fields',async()=>{
  const fake=fakeInspection({...clean(),privateField:'PRIVATE',observedResources:clean().observedResources.map(r=>({...r,private:'PRIVATE'}))});
  const result=await inspectRegisteredPage({registrationRef,pageRef},fake);
  assert.equal(result.status,'observed');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|privateField/);
  assert.equal(fake.calls.includes('Target.detachFromTarget'),true);
  assert.equal(fake.calls.some(c=>/navigate|reload|closeTarget|fetch/i.test(c)),false);
});
test('malformed projection and navigation discard all inspection results',async()=>{
  const fake=fakeInspection({...clean(),observedResources:[...clean().observedResources,{routeCode:'PRIVATE',count:1}]});
  assert.equal((await inspectRegisteredPage({registrationRef,pageRef},fake)).status,'inspection_failed');
  assert.equal((await inspectRegisteredPage({registrationRef,pageRef},fakeInspection(clean(),{changed:true}))).status,'page_changed');
});
