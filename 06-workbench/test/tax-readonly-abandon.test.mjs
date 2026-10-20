// Synthetic private files and a fake CDP only. Never open real registry/profile,
// checkpoint, business evidence, browser, service or endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,readdir,rm} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {CdpConnection,TaxBrowserError} from '../server/tax-browser-transport.mjs';
import {TaxCollectionStore,collectionLock,readCollectionLock,collectionRecoveryLock} from '../server/tax-collection-local.mjs';
import {abandonReadonlyOperation,READONLY_AUDIT_VERSION} from '../server/tax-readonly-abandon.mjs';
import {parseAbandonArguments} from '../scripts/abandon-tax-readonly-operation.mjs';
import {pageReference} from '../scripts/inventory-tax-browser.mjs';
import {TaxLiveCollection} from '../server/tax-live-collection.mjs';

const PRIVATE='PRIVATE_SYNTHETIC_ABANDON_TRIPWIRE',parent=fileURLToPath(new URL('../.agent-runs/abandon-test-temporary/',import.meta.url));
const sourceRef='taxsource_'+'1'.repeat(48),LOCK='YoushuCollectionLockV1.json',MUTEX='YoushuCollectionRecoveryV1.json';
const security={testStorage:true,async secureDirectory(){},async verifyDirectory(path){assert.ok((await lstat(path)).isDirectory())},
  async verifyFile(path){assert.ok((await lstat(path)).isFile())}};
const safe=value=>assert.doesNotMatch(JSON.stringify(value),/PRIVATE_SYNTHETIC|nonce|ownerPid|profilePath|targetId|registrationRoot|cookie|authorization|8FD7E4AFDACE/i);
const digest=b=>createHash('sha256').update(b).digest('hex');
async function fixture(run){
  await mkdir(parent,{recursive:true});const directory=await mkdtemp(join(parent,'synthetic-'));
  try{
    const profile=join(directory,'profile');await mkdir(profile);
    const store=new TaxCollectionStore({root:join(directory,'evidence'),security});await store.ready();
    const registrationRef='taxr_'+'2'.repeat(48),targetId=PRIVATE+'_TARGET';
    const source={version:1,authorizedNavigation:true,handoffMode:'quarantined_reader_new_navigation',readerStoppedConfirmed:true,
      registrationRef,registrationRoot:join(directory,'.agent-runs','tax-browser-registry'),targetId,
      pageRef:pageReference(registrationRef,targetId),frameId:PRIVATE+'_FRAME',loaderId:PRIVATE+'_LOADER',browserKey:'a'.repeat(64),
      documentUrlDigest:'b'.repeat(64),capturedAt:1,
      identity:{resource:'identity',recipe:{path:'/mhzx/api/mh/mhsy/getUserInfo',method:'GET',body:null,queryTimestamp:true},
        projection:{userinfo:{reg_number:PRIVATE,company_name:PRIVATE}}},
      filing:{resource:'current_filing',recipe:{path:'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx',method:'POST',body:{Csbz:'synthetic'},queryTimestamp:true},
        projection:{wsbxxGrid:[],rowCount:0,projectionComplete:false,periodVerified:false,
          navigation:{present:0,missing:0,sameOrigin:0,externalOrigin:0,hasQuery:0,hasAuthMaterial:0,invalid:0}}}};
    await writeFile(join(store.root,sourceRef+'.json'),JSON.stringify(source));
    const lockPath=join(profile,LOCK),mutexPath=join(profile,MUTEX);
    // Deliberately unusual formatting proves the archive preserves exact bytes.
    const old={version:1,nonce:'c'.repeat(48),ownerPid:2147483000,scope:{sourceRef,operation:'business_page_prepare'}};
    const original=Buffer.from(JSON.stringify(old,null,2)+'\r\n');await writeFile(lockPath,original);
    const claimPath=join(profile,'legacy-claim.synthetic'),claim=PRIVATE+'_QUARANTINED';await writeFile(claimPath,claim);
    const calls=[],state={ownerAlive:false,registry:'quarantined',mode:'normal',crash:null,once:false,adminHeld:false};
    const d={store,...security,
      async acquireAdminGuard(){if(state.adminHeld)throw Error('admin_busy');state.adminHeld=true;
        return{verify(){assert.equal(state.adminHeld,true)},async close(){state.adminHeld=false}};},
      readLock:path=>readCollectionLock(path,{security}),acquireRecovery:(path,expected)=>collectionRecoveryLock(path,expected,{security}),
      async isOwnerAlive(){return state.ownerAlive},
      async checkpoint(stage){
        if(state.mutate===stage){const changed=JSON.parse(await readFile(lockPath));changed.nonce='f'.repeat(48);await writeFile(lockPath,JSON.stringify(changed));}
        if(stage===state.crash&&!state.once){state.once=true;throw Error(PRIVATE);}
      },
      async openDiagnostic(){return {localScope:{profilePath:profile,browserKey:state.browserMismatch?'f'.repeat(64):source.browserKey,registrationState:'quarantined',
        async currentRegistrationState(){return state.registry;}},close(){calls.push('close')},cdp:{async send(method,params){
          calls.push({method,params});
          if(method==='Target.getTargetInfo'){
            if(state.mode==='found')return {targetInfo:{targetId}};
            if(state.mode==='generic')throw new TaxBrowserError('tax_browser_cdp_error');
            if(state.mode==='timeout')throw new TaxBrowserError('tax_browser_cdp_timeout');
            if(state.mode==='closed')throw new TaxBrowserError('tax_browser_cdp_closed');
            if(state.mode==='forged')throw {code:'tax_browser_target_not_found',message:PRIVATE};
            throw new TaxBrowserError('tax_browser_target_not_found');
          }
          if(method==='Target.getTargets'){
            assert.deepEqual(params,{filter:[{}]});
            return {targetInfos:state.mode==='list_found'?[{targetId,type:'page'}]:[{targetId:'synthetic-other',type:'other'}]};
          }
          throw Error('unexpected_browser_action');
        }}};},
    };
    const f={directory,profile,store,source,original,old,lockPath,mutexPath,calls,state,d,
      base:join(store.root,`abandon_${sourceRef}`),args:{sourceRef,execute:true,auditVersion:READONLY_AUDIT_VERSION}};
    await run(f);assert.equal(await readFile(claimPath,'utf8'),claim);
    assert.equal(await readFile(join(store.root,sourceRef+'.json'),'utf8'),JSON.stringify(source));
  }finally{assert.equal(dirname(resolve(directory)),resolve(parent));await rm(directory,{recursive:true,force:true});}
}
async function invoke(f,args=f.args){const r=await abandonReadonlyOperation(args,f.d);safe(r);return r;}
async function originalIntact(f){assert.deepEqual(await readFile(f.lockPath),f.original);}
async function absent(path){await assert.rejects(lstat(path),{code:'ENOENT'});}

test('diagnostic default requires no attestation and never creates a mutex or retires the lock',async()=>{
  await fixture(async f=>{const r=await invoke(f,{sourceRef});assert.equal(r.status,'diagnosed');assert.equal(r.lockRetired,false);
    assert.equal(r.realmDestructionProven,false);await originalIntact(f);await absent(f.mutexPath);
    assert.deepEqual(f.calls.filter(c=>typeof c==='object').map(c=>c.method),['Target.getTargetInfo','Target.getTargets']);});
});
test('explicit known audit version is mandatory; arbitrary inputs do not open a browser',async()=>{
  await fixture(async f=>{for(const args of [null,[],{}, {sourceRef,execute:true}, {...f.args,auditVersion:'unknown'},
    {...f.args,phase:'identity_after'},{...f.args,url:PRIVATE},{...f.args,headers:{}},{sourceRef,resume:true}]){
    assert.equal((await invoke(f,args)).status,'abandon_failed');}
    assert.equal(f.calls.length,0);await originalIntact(f);await absent(f.mutexPath);});
  assert.deepEqual(parseAbandonArguments(['--source-ref',sourceRef]),{sourceRef,execute:false,resume:false});
  assert.throws(()=>parseAbandonArguments(['--source-ref',sourceRef,'--resume']));
  assert.throws(()=>parseAbandonArguments(['--source-ref',sourceRef,'--execute','--confirm-audit=unknown']));
});
for(const mode of ['generic','timeout','closed','forged','found','list_found'])test(`not-found authority rejects ${mode}`,async()=>{
  await fixture(async f=>{f.state.mode=mode;assert.equal((await invoke(f)).status,'abandon_failed');await originalIntact(f);await absent(f.mutexPath);});
});
test('alive or reused owner PID is rejected; quarantine and browser/page bindings remain mandatory',async()=>{
  await fixture(async f=>{f.state.ownerAlive=true;assert.equal((await invoke(f)).status,'owner_alive');assert.equal(f.calls.some(c=>c.method),false);
    f.state.ownerAlive=false;f.state.registry='released';assert.equal((await invoke(f)).status,'abandon_failed');await originalIntact(f);});
  await fixture(async f=>{f.source.pageRef='taxpage_'+'f'.repeat(48);await writeFile(join(f.store.root,sourceRef+'.json'),JSON.stringify(f.source));
    assert.equal((await invoke(f)).status,'abandon_failed');assert.equal(f.calls.length,0);await originalIntact(f);});
});
test('only exact legacy business_page_prepare lock schema can be abandoned',async()=>{
  await fixture(async f=>{for(const changed of [{...f.old,scope:{sourceRef,operation:'active_replay'}},
    {...f.old,scope:{sourceRef,operation:'business_page_prepare',phase:'identity_before'}},{...f.old,extra:1},
    {...f.old,scope:{sourceRef:'taxsource_'+'f'.repeat(48),operation:'business_page_prepare'}}]){
    await writeFile(f.lockPath,JSON.stringify(changed));assert.equal((await invoke(f)).status,'abandon_failed');
    assert.deepEqual(JSON.parse(await readFile(f.lockPath)),changed);await absent(f.mutexPath);}
    await writeFile(f.lockPath,f.original);});
});
test('v2 sources and different browser registrations are outside this legacy admin capability',async()=>{
  await fixture(async f=>{f.source.version=2;f.source.documentUrlSemantics='cdp_frame_url_plus_fragment_v1';
    await writeFile(join(f.store.root,sourceRef+'.json'),JSON.stringify(f.source));
    assert.equal((await invoke(f)).status,'abandon_failed');assert.equal(f.calls.length,0);await originalIntact(f);});
  await fixture(async f=>{f.state.browserMismatch=true;assert.equal((await invoke(f)).status,'abandon_failed');
    assert.equal(f.calls.some(c=>c.method),false);await originalIntact(f);await absent(f.mutexPath);});
});
test('durable commit precedes original lock retirement and preserves its exact private bytes',async()=>{
  await fixture(async f=>{
    const seen=[];f.d.checkpoint=async stage=>{seen.push(stage);if(stage==='commit_durable'){
      await originalIntact(f);assert.equal(JSON.parse(await readFile(f.base+'.commit.json')).state,'abandoned_readonly');}};
    const r=await invoke(f);assert.equal(r.status,'abandoned_readonly');assert.equal(r.requestTermination,'unknown_abandoned');
    assert.equal(r.lateSessionEffectsPossible,true);assert.equal(r.businessScopeVerified,false);assert.equal(r.oldResultConsumption,'permanently_forbidden');
    assert.ok(seen.indexOf('commit_durable')<seen.indexOf('lock_retired'));await absent(f.lockPath);await absent(f.mutexPath);
    assert.deepEqual(await readFile(f.base+'.lock.bin'),f.original);
    const p=JSON.parse(await readFile(f.base+'.prepare.json'));assert.equal(p.originalSha256,digest(f.original));
    assert.equal(p.attestation.operatorAttested,true);assert.equal(p.attestation.loadedBytesProof,false);assert.equal(p.attestation.prototypeBytesRecovered,false);
    assert.equal(p.attestation.terminationProven,false);
    // New work continues through the very same canonical lock name.
    const fresh=await collectionLock(f.profile,{scope:{sourceRef:'taxsource_'+'2'.repeat(48),operation:'active_replay'},security});
    assert.equal((await readCollectionLock(f.profile,{security})).scope.sourceRef,'taxsource_'+'2'.repeat(48));await fresh.release();
  });
});
for(const crash of ['mutex_created','archive_durable','prepare_durable','commit_durable','before_retire','lock_retired','finished_durable','mutex_retired']){
  test(`crash at ${crash} retains exclusion until explicit deterministic resume`,async()=>{
    await fixture(async f=>{f.state.crash=crash;assert.equal((await invoke(f)).status,'abandon_failed');
      if(!['lock_retired','finished_durable','mutex_retired'].includes(crash))await originalIntact(f);
      if(crash!=='mutex_retired')await assert.rejects(collectionLock(f.profile,{scope:{operation:'fresh'},security}),/tax_collection_busy/);
      const snapshot=await readdir(f.store.root);const defaultResult=await invoke(f,{sourceRef});
      assert.equal(defaultResult.status,'resume_required');assert.deepEqual(await readdir(f.store.root),snapshot);
      const r=await invoke(f,{...f.args,resume:true});assert.equal(r.status,'abandoned_readonly');await absent(f.lockPath);await absent(f.mutexPath);
      assert.deepEqual(await readFile(f.base+'.lock.bin'),f.original);
    });
  });
}
test('nonce replacement at retirement fails closed and never deletes a replacement',async()=>{
  await fixture(async f=>{f.state.mutate='before_retire';const r=await invoke(f);assert.equal(r.status,'abandon_failed');
    assert.equal(r.abandonedStateCommitted,true);assert.equal(JSON.parse(await readFile(f.lockPath)).nonce,'f'.repeat(48));
    assert.equal((await invoke(f,{...f.args,resume:true})).status,'abandon_failed');await lstat(f.mutexPath);});
});
for(const mutation of ['owner','registry','scope'])test(`late ${mutation} change cannot retire the canonical lock`,async()=>{
  await fixture(async f=>{f.d.checkpoint=async stage=>{if(stage!=='before_retire')return;
    if(mutation==='owner')f.state.ownerAlive=true;
    else if(mutation==='registry')f.state.registry='released';
    else{const v=JSON.parse(await readFile(f.lockPath));v.scope.operation='unrelated';await writeFile(f.lockPath,JSON.stringify(v));}
  };
    assert.equal((await invoke(f)).status,'abandon_failed');await lstat(f.lockPath);await lstat(f.mutexPath);
    if(mutation!=='scope')await originalIntact(f);
    else assert.equal(JSON.parse(await readFile(f.lockPath)).scope.operation,'unrelated');
  });
});
test('private staging verification failure publishes no partial prepare or commit marker',async()=>{
  await fixture(async f=>{
    f.d.verifyFile=async path=>{await security.verifyFile(path);if(path.endsWith('.tmp'))throw Error(PRIVATE)};
    assert.equal((await invoke(f)).status,'abandon_failed');await originalIntact(f);
    await absent(f.base+'.prepare.json');await absent(f.base+'.commit.json');
    f.d.verifyFile=security.verifyFile;assert.equal((await invoke(f,{...f.args,resume:true})).status,'abandoned_readonly');
  });
});
test('commit published before readback failure is reported from disk, never as uncommitted',async()=>{
  await fixture(async f=>{let rejected=false;
    f.d.verifyFile=async path=>{await security.verifyFile(path);if(path===f.base+'.commit.json'&&!rejected){rejected=true;throw Error(PRIVATE)}};
    const r=await invoke(f);assert.equal(r.status,'abandon_failed');assert.equal(r.abandonedStateCommitted,true);
    assert.equal(r.requestTermination,'unknown_abandoned');assert.equal(r.resumeRequired,true);
    assert.equal(JSON.parse(await readFile(f.base+'.commit.json')).state,'abandoned_readonly');await originalIntact(f);await lstat(f.mutexPath);
  });
});
test('recovery mutex published before acquisition rejects is reported as requiring resume',async()=>{
  await fixture(async f=>{const acquire=f.d.acquireRecovery;
    f.d.acquireRecovery=async(...args)=>{await acquire(...args);throw Error(PRIVATE)};
    const r=await invoke(f);assert.equal(r.status,'abandon_failed');assert.equal(r.resumeRequired,true);
    assert.equal(r.abandonedStateCommitted,false);await lstat(f.mutexPath);await originalIntact(f);
  });
});
test('unreadable commit or recovery state is explicit unknown, never a negative memory-only conclusion',async()=>{
  await fixture(async f=>{
    f.d.verifyFile=async path=>{await security.verifyFile(path);if(path===f.base+'.commit.json')throw Error(PRIVATE)};
    const r=await invoke(f);assert.equal(r.status,'abandon_failed');assert.equal(r.abandonedStateCommitted,'unknown');
    assert.equal(r.resumeRequired,true);await lstat(f.base+'.commit.json');await originalIntact(f);
  });
  await fixture(async f=>{const acquire=f.d.acquireRecovery;
    f.d.acquireRecovery=async(...args)=>{await acquire(...args);throw Error(PRIVATE)};
    f.d.verifyFile=async path=>{await security.verifyFile(path);if(path===f.mutexPath)throw Error(PRIVATE)};
    const r=await invoke(f);assert.equal(r.status,'abandon_failed');assert.equal(r.resumeRequired,'unknown');
    await lstat(f.mutexPath);await originalIntact(f);
  });
});
for(const kind of ['transport','guard'])test(`${kind} cleanup failure cannot mask a committed abandonment as clean success`,async()=>{
  await fixture(async f=>{
    if(kind==='transport'){const open=f.d.openDiagnostic;f.d.openDiagnostic=async(...args)=>{
      const transport=await open(...args);transport.close=async()=>{throw Error(PRIVATE)};return transport;
    };}else{const acquire=f.d.acquireAdminGuard;f.d.acquireAdminGuard=async(...args)=>{
      const guard=await acquire(...args),close=guard.close;guard.close=async()=>{await close();throw Error(PRIVATE)};return guard;
    };}
    const r=await invoke(f);assert.equal(r.status,'abandon_cleanup_failed');assert.equal(r.operationStatus,'abandoned_readonly');
    assert.equal(r.cleanupConfirmed,false);assert.equal(r.abandonedStateCommitted,true);assert.equal(r.requestTermination,'unknown_abandoned');
    assert.equal(r.transportCleanupConfirmed,kind!=='transport');assert.equal(r.adminGuardCleanupConfirmed,kind!=='guard');
    await absent(f.lockPath);await absent(f.mutexPath);await lstat(f.base+'.commit.json');
  });
});
test('resume rejects changed journal bytes, source, owner and registration',async()=>{
  for(const mutation of ['archive','prepare','commit','owner','registration'])await fixture(async f=>{
    f.state.crash='commit_durable';await invoke(f);
    if(mutation==='owner')f.state.ownerAlive=true;
    else if(mutation==='registration')f.state.registry='released';
    else await writeFile(f.base+({archive:'.lock.bin',prepare:'.prepare.json',commit:'.commit.json'})[mutation],PRIVATE);
    assert.equal((await invoke(f,{...f.args,resume:true})).status,'abandon_failed');await originalIntact(f);await lstat(f.mutexPath);
  });
});
test('finished resume never retires a new canonical lock',async()=>{
  await fixture(async f=>{await invoke(f);const fresh=await collectionLock(f.profile,{scope:{operation:'new'},security});
    const bytes=await readFile(f.lockPath);assert.equal((await invoke(f,{...f.args,resume:true})).status,'abandoned_readonly');
    assert.deepEqual(await readFile(f.lockPath),bytes);await fresh.release();});
});
test('concurrent administrators cannot adopt the same dead recovery owner',async()=>{
  await fixture(async f=>{
    f.state.crash='commit_durable';await invoke(f);
    let continueFirst,entered;const blocked=new Promise(done=>{entered=done}),release=new Promise(done=>{continueFirst=done});
    f.d.checkpoint=async stage=>{if(stage==='before_retire'){entered();await release}};
    const first=invoke(f,{...f.args,resume:true});await blocked;
    const second=await invoke(f,{...f.args,resume:true});assert.equal(second.status,'abandon_failed');assert.equal(second.phase,'admin_exclusion');
    await originalIntact(f);continueFirst();assert.equal((await first).status,'abandoned_readonly');await absent(f.mutexPath);
  });
});
test('historical sources/runs stay readable; active legacy replay and late run publication are refused',async()=>{
  await fixture(async f=>{
    const run={version:1,sourceRef,capturedAt:2,identity:f.source.identity,filing:f.source.filing,operationRef:'taxop_'+'2'.repeat(48),
      requestProof:['1','2','3'].map((x,i)=>({requestRef:'taxreq_'+x.repeat(48),resource:i===1?'current_filing':'identity',requestPerformed:true,responseComplete:true}))};
    const runRef=await f.store.save('run',run);await invoke(f);
    await assert.rejects(f.store.save('run',run));assert.deepEqual(await f.store.load(runRef),run);
    assert.equal((await f.store.load(sourceRef)).version,1);
    let opened=0;const c=new TaxLiveCollection({enabled:true,store:f.store,openDiagnostic:async()=>{opened++;throw Error(PRIVATE)}});
    assert.equal((await c.collect({sourceRef})).status,'collection_failed');assert.equal(opened,0);
  });
});
test('normal collection post-create mutex check withdraws only its own nonce',async()=>{
  await fixture(async f=>{await rm(f.lockPath);let changed=false;
    const raceSecurity={...security,async verifyFile(path){await security.verifyFile(path);if(path===f.lockPath&&!changed){changed=true;
      await writeFile(f.mutexPath,JSON.stringify({version:1,nonce:'d'.repeat(48),ownerPid:process.pid}));}}};
    await assert.rejects(collectionLock(f.profile,{scope:{operation:'fresh'},security:raceSecurity}),/tax_collection_busy/);await absent(f.lockPath);await lstat(f.mutexPath);
  });
  await fixture(async f=>{await rm(f.lockPath);let changed=false;
    const raceSecurity={...security,async verifyFile(path){await security.verifyFile(path);if(path===f.lockPath&&!changed){changed=true;
      const lock=JSON.parse(await readFile(path));lock.nonce='f'.repeat(48);await writeFile(path,JSON.stringify(lock));
      await writeFile(f.mutexPath,JSON.stringify({version:1,nonce:'d'.repeat(48),ownerPid:process.pid}));}}};
    await assert.rejects(collectionLock(f.profile,{scope:{operation:'fresh'},security:raceSecurity}));
    assert.equal(JSON.parse(await readFile(f.lockPath)).nonce,'f'.repeat(48));
  });
});

function socket(error){return class extends EventTarget{
  constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
  send(text){const msg=JSON.parse(text);queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:msg.id,error})})))}close(){}
};}
test('typed target-not-found mapping is bound to exact original method and protocol code/message',async()=>{
  for(const method of ['Target.getTargetInfo','Target.attachToTarget','Target.getTargets','Runtime.evaluate']){
    for(const error of [{code:-32602,message:'No target with given id found'}, {code:-32000,message:'No target with given id found'},
      {code:-32602,message:'No target with given id found '+PRIVATE},{code:-32602,message:'No target with given id found.'},
      {code:'-32602',message:'No target with given id found'}]){
      const cdp=new CdpConnection('ws://127.0.0.1:12345/devtools/browser/synthetic',{WebSocketImpl:socket(error)});await cdp.open();
      const expected=method==='Target.getTargetInfo'&&error.code===-32602&&error.message==='No target with given id found'?'tax_browser_target_not_found':'tax_browser_cdp_error';
      await assert.rejects(cdp.send(method,{targetId:PRIVATE}),e=>{assert.equal(e.code,expected);assert.doesNotMatch(e.stack,/PRIVATE_SYNTHETIC/);return true});cdp.close();
    }
  }
});
