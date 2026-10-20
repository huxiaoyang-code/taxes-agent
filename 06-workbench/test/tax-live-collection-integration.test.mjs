// Synthetic local persistence and cross-checkout lock integration. No real registry,
// browser profile, account data, credentials, or tax endpoints are accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, writeFile, rm, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {TaxCollectionStore, collectionLock} from '../server/tax-collection-local.mjs';
import {validateRecipe, validateCapture, validateEvidence,requireActiveSource} from '../server/tax-collection-contract.mjs';
import {businessProjection, collectionShape, observedRecipe} from '../server/tax-collection-shape.mjs';
import {observeTaxNavigation} from '../scripts/observe-tax-navigation.mjs';
import {pageReference} from '../scripts/inventory-tax-browser.mjs';
import {FULL_FRAME_URL_SEMANTICS,fullFrameUrl,frameUrlDigest} from '../server/tax-frame-url.mjs';
import {TaxLiveCollection,assertLiveFrame,readLiveResource,liveRequestScript} from '../server/tax-live-collection.mjs';

const PRIVATE='PRIVATE_SYNTHETIC_BUSINESS_TRIPWIRE';
const temporaryParent=fileURLToPath(new URL('../.agent-runs/tax-live-test-temporary/',import.meta.url));
const ref=(prefix,digit='1')=>prefix+digit.repeat(48);
const navigation=()=>({present:1,missing:1,sameOrigin:1,externalOrigin:0,hasQuery:0,hasAuthMaterial:0,invalid:0});
function captures(){
  return {
    identity:{resource:'identity',recipe:{path:'/mhzx/api/mh/mhsy/getUserInfo',method:'GET',body:null,queryTimestamp:true},
      projection:{userinfo:{reg_number:PRIVATE+'_REG',company_name:PRIVATE+'_COMPANY',user_id:PRIVATE+'_USER',user_type:'2'}}},
    filing:{resource:'current_filing',recipe:{path:'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx',method:'POST',body:{Csbz:'synthetic'},queryTimestamp:true},
      projection:{wsbxxGrid:[{sbb:PRIVATE+'_FORM',sbqx:PRIVATE+'_DEADLINE',zt:PRIVATE+'_STATUS',ztBm:'synthetic',zsxmDm:'synthetic'}],
        rowCount:1,projectionComplete:false,periodVerified:false,navigation:navigation()}},
  };
}
function source(){return {version:2,documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,authorizedNavigation:true,handoffMode:'quarantined_reader_new_navigation',readerStoppedConfirmed:true,registrationRef:ref('taxr_'),
  registrationRoot:join(tmpdir(),'synthetic-checkout','.agent-runs','tax-browser-registry'),
  pageRef:ref('taxpage_'),targetId:PRIVATE+'_TARGET',frameId:PRIVATE+'_FRAME',loaderId:PRIVATE+'_LOADER',
  browserKey:'a'.repeat(64),documentUrlDigest:'b'.repeat(64),capturedAt:1,...captures()};}
function run(){return {version:1,sourceRef:ref('taxsource_'),capturedAt:2,...captures(),operationRef:ref('taxop_'),
  requestProof:['1','2','3'].map((digit,index)=>({requestRef:ref('taxreq_',digit),resource:index===1?'current_filing':'identity',
    requestPerformed:true,responseComplete:true}))};}
async function fixture(callback){
  await mkdir(temporaryParent,{recursive:true});
  const temporary=await mkdtemp(join(temporaryParent,'tax-live-integration-'));
  try{await callback(temporary);}finally{
    assert.equal(dirname(resolve(temporary)),resolve(temporaryParent));
    assert.match(temporary.split(/[\\/]/).at(-1),/^tax-live-integration-/);
    await rm(temporary,{recursive:true,force:true});
  }
}
function security(calls=[]){return {testStorage:true,
  async secureDirectory(path){calls.push(['secureDirectory',path]);assert.ok((await lstat(path)).isDirectory());},
  async verifyDirectory(path){calls.push(['verifyDirectory',path]);assert.ok((await lstat(path)).isDirectory());},
  async verifyFile(path){calls.push(['verifyFile',path]);assert.ok((await lstat(path)).isFile());},
};}
const safe=value=>assert.doesNotMatch(JSON.stringify(value),/PRIVATE_SYNTHETIC|tax-browser-registry|targetId|frameId|loaderId/);

test('full frame URL binds the actual CDP split fragment byte for byte, including a lone #',()=>{
  const url='https://etax.fujian.chinatax.gov.cn:8443/loginb/';
  for(const fragment of ['', '#', '#/a', '#/a%2Fb', '#/a%2fb', '#/a?token='+PRIVATE]){
    assert.equal(fullFrameUrl({url,urlFragment:fragment}),url+fragment);
  }
  assert.equal(fullFrameUrl({url}),url);
  assert.notEqual(frameUrlDigest({url}),frameUrlDigest({url,urlFragment:'#'}));
  assert.notEqual(frameUrlDigest({url,urlFragment:'#/a%2Fb'}),frameUrlDigest({url,urlFragment:'#/a%2fb'}));
  for(const frame of [null,{}, {url:4},{url:'invalid'}, {url:url+'#'}, {url:url+'#/a',urlFragment:'#/a'},
    {url,urlFragment:null},{url,urlFragment:undefined},{url,urlFragment:42},{url,urlFragment:'/a'},
    {url,urlFragment:'#/a\nPRIVATE'},{url:'HTTPS://etax.fujian.chinatax.gov.cn:8443/loginb/'}]){
    assert.throws(()=>fullFrameUrl(frame),/^Error: tax_collection_scope_changed$/);
  }
});

test('real frame assertion rejects a different split fragment even with unchanged frame, loader and base URL',async()=>{
  const frame={id:'synthetic-frame',loaderId:'synthetic-loader',url:'https://etax.fujian.chinatax.gov.cn:8443/loginb/',urlFragment:'#/a?token='+PRIVATE};
  const scope={version:2,documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,frameId:frame.id,loaderId:frame.loaderId,documentUrlDigest:frameUrlDigest(frame)};
  const cdp={async send(){return {frameTree:{frame:{...frame}}}}};
  assert.equal(await assertLiveFrame(cdp,{},scope),fullFrameUrl(frame));
  frame.urlFragment='#/b?token='+PRIVATE;
  await assert.rejects(assertLiveFrame(cdp,{},scope),/^Error: tax_collection_scope_changed$/);
  for(const incomplete of [{...scope,version:1},{...scope,documentUrlSemantics:'frame_url_only'},
    {...scope,documentUrlDigest:undefined},{frameId:frame.id,loaderId:frame.loaderId}]){
    await assert.rejects(assertLiveFrame(cdp,{},incomplete),/^Error: tax_collection_scope_changed$/);
  }
});

test('missing expected full URL cannot generate or evaluate an active request',async()=>{
  let calls=0;const cdp={async send(){calls++;throw Error('must_not_evaluate')}};
  const recipe=captures().identity.recipe;
  assert.throws(()=>liveRequestScript(recipe,'identity',ref('taxreq_')),/^Error: tax_collection_scope_changed$/);
  await assert.rejects(readLiveResource(cdp,{},recipe,'identity'),/^Error: tax_collection_scope_changed$/);
  assert.equal(calls,0);
});

test('legacy sources remain exact read-only history and cannot acquire locks or be silently republished',async()=>{
  await fixture(async directory=>{
    const store=new TaxCollectionStore({root:join(directory,'evidence'),security:security()});
    const current=source(),sourceRef=await store.save('source',current),legacy={...current,version:1};delete legacy.documentUrlSemantics;
    const sourceFile=join(store.root,sourceRef+'.json'),legacyText=JSON.stringify(legacy);
    await writeFile(sourceFile,legacyText);assert.deepEqual(await store.load(sourceRef),legacy);
    assert.equal(validateEvidence('source',legacy),legacy);
    assert.throws(()=>requireActiveSource(legacy),/^Error: tax_collection_source_reobservation_required$/);
    await assert.rejects(store.save('source',legacy),/^Error: tax_collection_source_reobservation_required$/);
    const runRef=await store.save('run',{...run(),sourceRef});
    const profile=join(directory,'profile');await mkdir(profile);
    const lock=await collectionLock(profile,{security:security(),scope:{sourceRef,operation:'business_page_prepare'}});lock.retain();
    const lockFile=join(profile,'YoushuCollectionLockV1.json'),originalLock=await readFile(lockFile,'utf8');
    let opened=0,locked=0;
    const collector=new TaxLiveCollection({enabled:true,store,now:()=>3,
      async openDiagnostic(){opened++;throw Error(PRIVATE)},async acquireLock(){locked++;throw Error(PRIVATE)}});
    const output=await collector.collect({sourceRef});safe(output);
    assert.equal(output.status,'collection_failed');assert.equal(output.phase,'load');
    assert.equal(output.reason,'tax_collection_source_reobservation_required');assert.equal(opened,0);assert.equal(locked,0);
    const compared=await collector.compare({leftRef:sourceRef,rightRef:runRef});safe(compared);
    assert.equal(compared.status,'compared');assert.equal(compared.identityProjectionEqual,true);
    assert.equal(await readFile(sourceFile,'utf8'),legacyText);assert.equal(await readFile(lockFile,'utf8'),originalLock);
    assert.equal((await readdir(store.root)).length,2);
  });
});

// Execute the real generated browser expression in a synthetic JS context. The
// mock response uses streams, so URL checks surround the same read path as CDP.
async function activeScopeFixture(directory,mode){
  const origin='https://etax.fujian.chinatax.gov.cn:8443',frame={id:'synthetic-frame',loaderId:'synthetic-loader',url:origin+'/loginb/',urlFragment:'#/a?token='+PRIVATE};
  const initialUrl=fullFrameUrl(frame),sourceRecord={...source(),frameId:frame.id,loaderId:frame.loaderId,documentUrlDigest:frameUrlDigest(frame)};
  const store=new TaxCollectionStore({root:join(directory,'evidence'),security:security()}),sourceRef=await store.save('source',sourceRecord);
  const profile=join(directory,'profile');await mkdir(profile);
  if(mode==='changed_before_listener')frame.urlFragment='#/b?token='+PRIVATE;
  let fetchCount=0,evaluations=0;const handlers=new Map();
  const emit=()=>handlers.get('Page.navigatedWithinDocument')?.({frameId:frame.id},{sessionId:'synthetic-session'});
  const identityBody={Response:{Data:{userinfo:sourceRecord.identity.projection.userinfo}}};
  const filingBody={Response:{Data:{wsbxxGrid:sourceRecord.filing.projection.wsbxxGrid}}};
  const collector=new TaxLiveCollection({enabled:true,store,now:()=>3,
    acquireLock:(path,options)=>collectionLock(path,{...options,security:security()}),
    async openDiagnostic(){return {localScope:{profilePath:profile,browserKey:sourceRecord.browserKey,registrationState:'quarantined',
      async currentRegistrationState(){return 'quarantined'}},close(){},cdp:{
      on(name,handler){handlers.set(name,handler);return()=>handlers.delete(name)},
      async send(method,params){
        if(method==='Target.getTargetInfo')return {targetInfo:{type:'page'}};
        if(method==='Target.attachToTarget')return {sessionId:'synthetic-session'};
        if(method==='Page.getFrameTree')return {frameTree:{frame:{...frame}}};
        if(method==='Runtime.evaluate'){
          evaluations++;
          if(mode==='changed_before_evaluate')frame.urlFragment='#/b?token='+PRIVATE;
          const location={href:fullFrameUrl(frame)};
          const result=await runInNewContext(params.expression,{location,URL,AbortController,TextDecoder,
            window:{fetch:Array.prototype.push,setTimeout:Array.prototype.push},setTimeout:()=>0,clearTimeout:()=>{},
            async fetch(){
              fetchCount++;
              if(mode==='aba_during_fetch'&&fetchCount===2){
                frame.urlFragment='#/b';location.href=fullFrameUrl(frame);emit();
                frame.urlFragment='#/a?token='+PRIVATE;location.href=initialUrl;emit();
              }
              return new Response(JSON.stringify(fetchCount===2?filingBody:identityBody),{status:200});
            }});
          return {result:{value:result}};
        }
        if(['Page.enable','Runtime.enable','Page.disable','Runtime.disable','Target.detachFromTarget'].includes(method))return {};
        throw Error('synthetic_unexpected_cdp_method');
      },
    }}}
  });
  const output=await collector.collect({sourceRef});safe(output);
  return {output,fetchCount,evaluations,store,profile};
}

test('split-fragment source accepts the matching live URL and never leaks its sensitive fragment',async()=>{
  await fixture(async directory=>{
    const {output,fetchCount}=await activeScopeFixture(directory,'matching');
    assert.equal(output.status,'partial_observed');assert.equal(output.documentScopeVerified,true);assert.equal(fetchCount,3);
    assert.match(output.runRef,/^taxrun_[a-f0-9]{48}$/);
  });
});
test('hash change before collection listeners start rejects before any evaluate or fetch',async()=>{
  await fixture(async directory=>{
    const {output,fetchCount,evaluations,store,profile}=await activeScopeFixture(directory,'changed_before_listener');
    assert.equal(output.status,'collection_failed');assert.equal(output.reason,'tax_collection_scope_changed');
    assert.equal(evaluations,0);assert.equal(fetchCount,0);assert.equal((await readdir(store.root)).length,1);
    assert.deepEqual(await readdir(profile),[]);
  });
});
test('hash change between host assertion and Runtime.evaluate cannot start a fetch',async()=>{
  await fixture(async directory=>{
    const {output,fetchCount,evaluations,store}=await activeScopeFixture(directory,'changed_before_evaluate');
    assert.equal(output.status,'collection_failed');assert.equal(output.reason,'tax_collection_scope_changed');
    assert.equal(evaluations,1);assert.equal(fetchCount,0);assert.equal((await readdir(store.root)).length,1);
    assert.equal(output.lockRetained,false);
  });
});
test('live listener detects split-fragment A to B to A even when the request expression finishes at A',async()=>{
  await fixture(async directory=>{
    const {output,fetchCount,store}=await activeScopeFixture(directory,'aba_during_fetch');
    assert.equal(output.status,'collection_failed');assert.equal(output.reason,'tax_collection_scope_changed');
    assert.equal(fetchCount,2);assert.equal((await readdir(store.root)).length,1);
  });
});

test('real evidence store validates, stages, publishes and reloads exact source/run schemas',async()=>{
  await fixture(async directory=>{
    const checks=[],store=new TaxCollectionStore({root:join(directory,'evidence'),security:security(checks)});
    const original=source(),sourceRef=await store.save('source',original);
    assert.match(sourceRef,/^taxsource_[a-f0-9]{48}$/);
    assert.deepEqual(await store.load(sourceRef),original);
    const second={...run(),sourceRef},runRef=await store.save('run',second);
    assert.match(runRef,/^taxrun_[a-f0-9]{48}$/);
    assert.deepEqual(await store.load(runRef),second);
    assert.deepEqual((await readdir(store.root)).sort(),[sourceRef+'.json',runRef+'.json'].sort());
    assert.ok(checks.some(([kind,path])=>kind==='verifyFile'&&path.endsWith('.tmp')),'staging verification was not bypassed');
    assert.ok(checks.some(([kind,path])=>kind==='verifyFile'&&path.endsWith(sourceRef+'.json')),'published-file verification was not bypassed');
    assert.ok(checks.some(([kind])=>kind==='secureDirectory'));
    // Synthetic business values stay in the private store; only random refs leave it.
    safe({sourceRef,runRef});
  });
});

test('schema validation rejects extra business/auth fields, incomplete scopes and unjustified completeness',()=>{
  const mutations=[
    v=>{v.authorization=PRIVATE;},v=>{v.authorizedNavigation=false;},
    v=>{v.registrationRef='file:///private';},v=>{v.pageRef=PRIVATE;},
    v=>{v.handoffMode='synthetic_unconfirmed';},v=>{v.readerStoppedConfirmed=false;},
    v=>{delete v.documentUrlDigest;},v=>{v.documentUrlDigest=PRIVATE;},
    v=>{delete v.documentUrlSemantics;},v=>{v.documentUrlSemantics='frame_url_only';},v=>{v.version=1;},
    v=>{v.identity.projection.userinfo.token=PRIVATE;},v=>{v.identity.projection.userinfo.company_name='';},
    v=>{v.filing.projection.wsbxxGrid[0].unknown=PRIVATE;},v=>{v.filing.projection.rowCount=2;},
    v=>{v.filing.projection.projectionComplete=true;},v=>{v.filing.projection.periodVerified=true;},
    v=>{v.filing.projection.navigation.extra=PRIVATE;},v=>{v.filing.projection.navigation.present=-1;},
    v=>{v.filing.recipe.path='/hidden/'+PRIVATE;},v=>{v.filing.recipe.body.cookie=PRIVATE;},
  ];
  for(const change of mutations){const value=source();change(value);assert.throws(()=>validateEvidence('source',value),/^Error: tax_collection_evidence_invalid$/);}
  const extra=run();extra.pageRef=PRIVATE;assert.throws(()=>validateEvidence('run',extra),/tax_collection_evidence_invalid/);
  for(const change of [v=>{v.requestProof[1].requestRef=v.requestProof[0].requestRef;},v=>{v.requestProof[1].requestPerformed=false;},
    v=>{v.requestProof[2].responseComplete=false;},v=>{v.requestProof[0].resource='current_filing';},v=>{delete v.operationRef;}]){
    const value=run();change(value);assert.throws(()=>validateEvidence('run',value),/tax_collection_evidence_invalid/);
  }
});

test('illegal recipes and captures cannot cross the real store publication boundary',async()=>{
  await fixture(async directory=>{
    const store=new TaxCollectionStore({root:join(directory,'evidence'),security:security()});
    for(const recipe of [
      {path:'https://external.invalid/'+PRIVATE,method:'GET',body:null,queryTimestamp:true},
      {path:'/mhzx/api/mh/mhsy/getUserInfo',method:'POST',body:null,queryTimestamp:true},
      {path:'/mhzx/api/mh/mhsy/getUserInfo',method:'GET',body:{cookie:PRIVATE},queryTimestamp:true},
      {path:'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx',method:'POST',body:{Csbz:'a',Jsqd:'01'},queryTimestamp:true},
      {path:'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx',method:'POST',body:{Csbz:'a?token='+PRIVATE},queryTimestamp:true},
      {path:'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx',method:'POST',body:{csbz:'synthetic'},queryTimestamp:true},
      {path:'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx',method:'POST',body:{Request:{Data:{Csbz:'synthetic'}}},queryTimestamp:true},
    ]){
      assert.equal(validateRecipe(recipe,recipe.path.includes('getUserInfo')?'identity':'current_filing'),false);
      const value=source();value.filing.recipe=recipe;
      await assert.rejects(store.save('source',value),/^Error: tax_collection_evidence_invalid$/);
    }
    assert.equal(validateCapture({...captures().identity,resource:'current_filing'},'identity'),false);
    for(const value of ['../'+PRIVATE,ref('taxsource_')+'/../x','taxsource_'+PRIVATE,null])
      await assert.rejects(store.load(value),/^Error: tax_collection_local_failed$/);
    assert.deepEqual(await readdir(directory),[],'invalid evidence must not create storage or publish files');
  });
});

test('private storage reload revalidates contents and detects an externally corrupted exact schema',async()=>{
  await fixture(async directory=>{
    const store=new TaxCollectionStore({root:join(directory,'evidence'),security:security()});
    const sourceRef=await store.save('source',source());
    const file=join(store.root,sourceRef+'.json'),value=JSON.parse(await readFile(file,'utf8'));
    value.filing.projection.periodVerified=true;await writeFile(file,JSON.stringify(value));
    await assert.rejects(store.load(sourceRef),/^Error: tax_collection_evidence_invalid$/);
    await writeFile(file,'{invalid-json');await assert.rejects(store.load(sourceRef));
  });
});

test('failed staging verification publishes no source and removes staging data',async()=>{
  await fixture(async directory=>{
    const hooks=security(),store=new TaxCollectionStore({root:join(directory,'evidence'),security:{...hooks,
      async verifyFile(path){await hooks.verifyFile(path);throw Error('synthetic_acl_rejection');},
    }});
    await assert.rejects(store.save('source',source()),/synthetic_acl_rejection/);
    assert.deepEqual(await readdir(store.root),[]);
  });
});

test('arbitrary raw response keys/values stay out of model-facing shape and recipes',()=>{
  const body={Response:{Data:{userinfo:{reg_number:PRIVATE,company_name:PRIVATE,[PRIVATE]:PRIVATE},
    wsbxxGrid:[{sbb:PRIVATE,sbqx:PRIVATE,zt:PRIVATE,token:PRIVATE,[PRIVATE]:PRIVATE,
      cddz:'/synthetic/page?token='+PRIVATE,yyfwqdz:'https://external.invalid/'+PRIVATE}],
    [PRIVATE]:PRIVATE}}};
  const shape=collectionShape(body);safe(shape);assert.equal(shape.filingShape,true);assert.equal(shape.periodVerified,false);
  const projected=businessProjection(body,'current_filing');
  assert.equal(Object.hasOwn(projected.wsbxxGrid[0],'token'),false);
  assert.equal(Object.hasOwn(projected.wsbxxGrid[0],PRIVATE),false);
  assert.equal(Object.hasOwn(projected.wsbxxGrid[0],'cddz'),false);
  assert.equal(projected.projectionComplete,false);assert.equal(projected.navigation.hasAuthMaterial,1);
  const observed=observedRecipe({url:'https://etax.fujian.chinatax.gov.cn:8443/mhzx/api/mh/wddb/v1/wddbquerybbsmxx?t='+PRIVATE,
    method:'POST',postData:JSON.stringify({Csbz:'synthetic'})});
  safe(observed);assert.equal(observed.recipeMatches,false);assert.equal(observed.localRecipe.body.Csbz,'synthetic');
  assert.equal(Object.keys(observed).includes('localRecipe'),false);
});

test('separate checkout/module instances exclude concurrent use of the same canonical profile',async()=>{
  await fixture(async directory=>{
    const profile=join(directory,'synthetic-profile');await mkdir(profile);
    const other=await import('../server/tax-collection-local.mjs?syntheticOtherCheckout=1');
    const first=await collectionLock(profile,{security:security(),scope:'synthetic-checkout-a'});
    await assert.rejects(other.collectionLock(profile,{security:security(),scope:'synthetic-checkout-b'}),/^Error: tax_collection_busy$/);
    await first.release();
    const second=await other.collectionLock(profile,{security:security(),scope:'synthetic-checkout-b'});
    await second.release();await second.release();
    assert.deepEqual(await readdir(profile),[]);
  });
});

test('retained or unverifiable profile locks remain exclusive rather than silently releasing ownership',async()=>{
  await fixture(async directory=>{
    const profile=join(directory,'synthetic-profile');await mkdir(profile);
    const lock=await collectionLock(profile,{security:security(),scope:'synthetic-owner'});
    const files=await readdir(profile);assert.equal(files.length,1);
    const file=join(profile,files[0]),stored=JSON.parse(await readFile(file,'utf8'));
    stored.nonce='synthetic-ownership-changed';await writeFile(file,JSON.stringify(stored));
    await assert.rejects(lock.release(),/^Error: tax_collection_local_failed$/);
    await assert.rejects(collectionLock(profile,{security:security(),scope:'synthetic-other'}),/^Error: tax_collection_busy$/);
    lock.retain();await lock.release();assert.equal((await readdir(profile)).length,1);
  });
});

test('ACL failure after exclusive profile creation retains the lock for recovery',async()=>{
  await fixture(async directory=>{
    const profile=join(directory,'synthetic-profile');await mkdir(profile);
    await assert.rejects(collectionLock(profile,{security:{...security(),async verifyFile(){throw Error('synthetic_acl_failure');}},scope:'synthetic-owner'}),/synthetic_acl_failure/);
    await assert.rejects(collectionLock(profile,{security:security(),scope:'synthetic-other'}),/^Error: tax_collection_busy$/);
    assert.equal((await readdir(profile)).length,1);
  });
});

async function observedSourceFixture(directory,{changeDuringWait=false,clearBeforeFrame=1,clearAfterFrame=false,
  businessBeforeClears=false,hashBeforeReply=false,fragmentChangeAt=null}={}){
  const store=new TaxCollectionStore({root:join(directory,'evidence'),security:security()});
  const profile=join(directory,'synthetic-profile');await mkdir(profile);
  const origin='https://etax.fujian.chinatax.gov.cn:8443',registrationRef=ref('taxr_'),targetId=PRIVATE+'_TARGET';
  const handlers=new Map(),calls=[];
  const emit=(name,params)=>handlers.get(name)?.(params,{sessionId:'synthetic-session'});
  const identityBody={Response:{Data:{userinfo:{reg_number:PRIVATE+'_REG',company_name:PRIVATE+'_COMPANY',creditCode:PRIVATE+'_CREDIT',taxpayer_id:PRIVATE+'_TAX',user_id:PRIVATE+'_USER',user_type:'2'}}}};
  const filingBody={Response:{Data:{wsbxxGrid:[{sbb:PRIVATE+'_FORM',sbqx:PRIVATE+'_DEADLINE',zt:PRIVATE+'_STATUS'}],dbt:'synthetic',tbsl:1}}};
  const frame={id:'synthetic-frame',loaderId:'synthetic-loader',url:origin+'/loginb/',urlFragment:'#/a?token='+PRIVATE};
  let frameReads=0;
  const output=await observeTaxNavigation({registrationRef,
    registrationRoot:join(directory,'synthetic-checkout','.agent-runs','tax-browser-registry'),
    pageRef:pageReference(registrationRef,targetId),destination:'portal_index',persistSource:true,readerStoppedConfirmed:true},{
      store,acquireLock:(path,options)=>collectionLock(path,{...options,security:security()}),
      async wait(){
        if(changeDuringWait){
          // Same frame/loader and final URL A, but data may cross an intermediate B.
          emit('Page.navigatedWithinDocument',{frameId:frame.id,url:origin+'/loginb/#/b'});
          emit('Page.navigatedWithinDocument',{frameId:frame.id,url:frame.url+frame.urlFragment});
        }
      },
      async openDiagnostic(){return {localScope:{profilePath:profile,browserKey:'a'.repeat(64),registrationState:'quarantined',
        async currentRegistrationState(){return 'quarantined';}},close(){calls.push('close');},cdp:{
          on(name,handler){handlers.set(name,handler);return()=>handlers.delete(name);},
          async send(method,params){
            calls.push(method);
            if(method==='Target.getTargets')return {targetInfos:[{type:'page',targetId,url:origin+'/loginb/'}]};
            if(method==='Target.attachToTarget')return {sessionId:'synthetic-session'};
            if(method==='Page.navigate'){
              if(businessBeforeClears)emit('Network.requestWillBeSent',{requestId:'early-filing',frameId:frame.id,loaderId:frame.loaderId,
                timestamp:0.5,type:'XHR',request:{url:origin+'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx?t=1',method:'POST',postData:JSON.stringify({Csbz:'synthetic'})}});
              for(let index=0;index<clearBeforeFrame;index++)emit('Runtime.executionContextsCleared',{});
              emit('Page.frameNavigated',{frame:{...frame}});
              if(clearAfterFrame)emit('Runtime.executionContextsCleared',{});
              if(hashBeforeReply){
                emit('Page.navigatedWithinDocument',{frameId:frame.id,url:origin+'/loginb/#/b'});
                emit('Page.navigatedWithinDocument',{frameId:frame.id,url:frame.url+frame.urlFragment});
              }
              for(const [requestId,path,method,postData,timestamp] of [
                ['identity','/mhzx/api/mh/mhsy/getUserInfo','GET',undefined,1],
                ['filing','/mhzx/api/mh/wddb/v1/wddbquerybbsmxx','POST',JSON.stringify({Csbz:'synthetic'}),2],
              ]){
                emit('Network.requestWillBeSent',{requestId,frameId:frame.id,loaderId:frame.loaderId,timestamp,type:'XHR',
                  request:{url:origin+path+'?t=1',method,postData}});
                emit('Network.responseReceived',{requestId,response:{status:200}});
                emit('Network.loadingFinished',{requestId,encodedDataLength:512});
              }
              return {frameId:frame.id,loaderId:frame.loaderId};
            }
            if(method==='Network.getResponseBody')return {body:JSON.stringify(params.requestId==='identity'?identityBody:filingBody)};
            if(method==='Page.getFrameTree'){
              frameReads++;
              if(fragmentChangeAt==='before_identity'&&frameReads===2)frame.urlFragment='#/b?token='+PRIVATE;
              return {frameTree:{frame:{...frame}}};
            }
            if(method==='Runtime.evaluate'){
              const requestRef=params.expression.match(/taxreq_[a-f0-9]{48}/)?.[0];assert.ok(requestRef);
              assert.ok(params.expression.includes(JSON.stringify(frame.url+frame.urlFragment)));
              if(fragmentChangeAt==='after_identity')frame.urlFragment='#/b?token='+PRIVATE;
              return {result:{value:{status:'observed',settled:true,requestPerformed:true,responseComplete:true,requestRef,body:identityBody}}};
            }
            if(['Network.enable','Page.enable','Runtime.enable','Network.disable','Page.disable','Runtime.disable','Target.detachFromTarget'].includes(method))return {};
            throw Error('synthetic_unexpected_cdp_method');
          },
        }};},
    });
  safe(output);return {output,store,profile,calls};
}

test('normal observation persists and reloads an exact source through the real store only after cleanup',async()=>{
  await fixture(async directory=>{
    const {output,store,profile,calls}=await observedSourceFixture(directory);
    assert.equal(output.status,'observed');assert.match(output.sourceRef,/^taxsource_[a-f0-9]{48}$/);
    const saved=await store.load(output.sourceRef);assert.equal(saved.handoffMode,'quarantined_reader_new_navigation');
    assert.equal(saved.version,2);assert.equal(saved.documentUrlSemantics,FULL_FRAME_URL_SEMANTICS);
    assert.equal(saved.documentUrlDigest,frameUrlDigest({url:'https://etax.fujian.chinatax.gov.cn:8443/loginb/',urlFragment:'#/a?token='+PRIVATE}));
    assert.equal(saved.readerStoppedConfirmed,true);assert.equal(saved.filing.projection.rowCount,1);
    assert.equal(saved.identity.projection.userinfo.reg_number,PRIVATE+'_REG');
    assert.equal(saved.filing.projection.periodVerified,false);assert.equal(saved.filing.projection.projectionComplete,false);
    assert.equal((await readdir(store.root)).length,1);assert.deepEqual(await readdir(profile),[]);
    assert.ok(calls.includes('Target.detachFromTarget'));assert.ok(calls.includes('Runtime.evaluate'));
  });
});

test('same-loader hash B then A during passive wait must not publish a source even with identity A after',async()=>{
  await fixture(async directory=>{
    const {output,store}=await observedSourceFixture(directory,{changeDuringWait:true});
    assert.equal(output.status,'observation_failed');assert.equal(Object.hasOwn(output,'sourceRef'),false);
    const files=await readdir(store.root).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    assert.deepEqual(files,[],'temporary scope reversal must invalidate captured data before publication');
  });
});

for(const fragmentChangeAt of ['before_identity','after_identity']){
  test(`observation refuses a split-fragment change ${fragmentChangeAt} without relying on event delivery`,async()=>{
    await fixture(async directory=>{
      const {output,store,calls}=await observedSourceFixture(directory,{fragmentChangeAt});
      assert.equal(output.status,'observation_failed');assert.equal(Object.hasOwn(output,'sourceRef'),false);
      assert.equal(calls.filter(method=>method==='Runtime.evaluate').length,fragmentChangeAt==='before_identity'?0:1);
      const files=await readdir(store.root).catch(error=>{if(error.code==='ENOENT')return [];throw error;});assert.deepEqual(files,[]);
    });
  });
}

test('two initial context clears before the first new main frame still produce a reloadable real source',async()=>{
  await fixture(async directory=>{
    const {output,store,profile}=await observedSourceFixture(directory,{clearBeforeFrame:2});
    assert.equal(output.status,'observed');assert.match(output.sourceRef,/^taxsource_[a-f0-9]{48}$/);
    const saved=await store.load(output.sourceRef);assert.equal(saved.filing.projection.rowCount,1);
    assert.equal(saved.identity.projection.userinfo.reg_number,PRIVATE+'_REG');
    assert.equal(saved.filing.projection.periodVerified,false);assert.deepEqual(await readdir(profile),[]);
  });
});

test('a repeated context clear after initial main-frame commit invalidates the source',async()=>{
  await fixture(async directory=>{
    const {output,store}=await observedSourceFixture(directory,{clearBeforeFrame:2,clearAfterFrame:true});
    assert.equal(output.status,'observation_failed');assert.equal(Object.hasOwn(output,'sourceRef'),false);
    const files=await readdir(store.root).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    assert.deepEqual(files,[],'bootstrap clear allowance must end at initial main-frame commit');
  });
});

test('a non-identity business request before context clear and initial frame ends bootstrap allowance before navigation reply',async()=>{
  await fixture(async directory=>{
    const {output,store}=await observedSourceFixture(directory,{businessBeforeClears:true,clearBeforeFrame:2});
    assert.equal(output.status,'observation_failed');assert.equal(Object.hasOwn(output,'sourceRef'),false);
    const files=await readdir(store.root).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    assert.deepEqual(files,[],'earlier current-filing traffic must block clear exemption as strictly as identity traffic');
  });
});

test('same-loader hash B then A before navigation reply cannot be promoted to a persisted source',async()=>{
  await fixture(async directory=>{
    const {output,store}=await observedSourceFixture(directory,{clearBeforeFrame:2,hashBeforeReply:true});
    assert.equal(output.status,'observation_failed');assert.equal(Object.hasOwn(output,'sourceRef'),false);
    const files=await readdir(store.root).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    assert.deepEqual(files,[],'navigation-reply buffering must preserve hash-change causality');
  });
});
