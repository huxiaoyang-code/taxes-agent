// Synthetic filesystem/CDP only. Never read a real checkpoint, manifest or browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,lstat,readdir,link} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {queryFixture,PRIVATE} from './tax-query-fixture.mjs';
import {collectionLock,readCollectionLock,collectionRecoveryLock} from '../server/tax-collection-local.mjs';
import {TaxLiveCollection} from '../server/tax-live-collection.mjs';
import {retireQueryReadonly,QUERY_RETIREMENT_AUDIT_VERSION} from '../server/tax-query-readonly-retirement.mjs';
import {parseQueryRetirementArguments} from '../scripts/retire-tax-query-readonly.mjs';
import {QUERY_ORIGIN} from '../server/tax-query-contract.mjs';
const ROOT=fileURLToPath(new URL('../.agent-runs/query-retirement-tests/',import.meta.url)),LOCK='YoushuCollectionLockV1.json',MUTEX='YoushuCollectionRecoveryV1.json';
const safe=v=>assert.doesNotMatch(JSON.stringify(v),/SYNTHETIC_QUERY|nonce|ownerPid|profilePath|targetId|frameId|loaderId|fullUrl|cookie|authorization|originalBase64/);
async function fixture(run){
  await mkdir(ROOT,{recursive:true});const directory=await mkdtemp(join(ROOT,'synthetic-'));
  try{const f=await queryFixture(directory),originalParent=await f.parentStore.load(f.parentSourceRef);await f.store.ready();
    await collectionLock(f.profile,{security:f.security,scope:{operation:'query_context_refresh',parentSourceRef:f.parentSourceRef,artifactRef:f.artifactRef}});
    const lockPath=join(f.profile,LOCK),originalLock=JSON.parse(await readFile(lockPath,'utf8'));originalLock.ownerPid=2147483000;
    const originalBytes=Buffer.from(JSON.stringify(originalLock,null,2)+'\r\n');await writeFile(lockPath,originalBytes);
    const legacyPath=join(f.profile,'legacy-quarantine.synthetic');await writeFile(legacyPath,PRIVATE);
    const state={mode:'normal',ownerAlive:false,registry:'quarantined',crash:null,crashed:false,guardHeld:false,after:false,navCount:0,inventories:0},calls=[];
    const frame=()=>({id:'query-frame',loaderId:state.after?'new-loader':'query-loader',url:state.after?
      state.mode==='auth'?'https://tpass.fujian.chinatax.gov.cn:8443/api/v1.0/auth/oauth2/login?opaque=PRIVATE':
      state.mode==='external'?'https://example.invalid/':state.mode==='unconfirmed_index'?QUERY_ORIGIN+'/mhzx/api/mh/mhsy/index':
      state.mode==='portal_bare_query'?QUERY_ORIGIN+'/loginb/?':QUERY_ORIGIN+'/loginb/':QUERY_ORIGIN+'/szzh/zhcx/sbxx/sbxxcx',
      ...state.after&&['portal_bare_hash','auth_bare_hash'].includes(state.mode)?{url:state.mode==='auth_bare_hash'?
        'https://tpass.fujian.chinatax.gov.cn:8443/api/v1.0/auth/oauth2/login?opaque=PRIVATE':QUERY_ORIGIN+'/loginb/',urlFragment:'#'}:{}});
    const d={store:f.store,parentStore:f.parentStore,
      readLock:p=>readCollectionLock(p,{security:f.security}),acquireRecovery:(p,e)=>collectionRecoveryLock(p,e,{security:f.security}),
      isOwnerAlive:async()=>state.ownerAlive,
      async acquireAdminGuard(){if(state.guardHeld)throw Error(PRIVATE);state.guardHeld=true;return{verify(){assert.equal(state.guardHeld,true)},async close(){state.guardHeld=false}};},
      async checkpoint(stage){
        if(state.mutate===stage){const value=JSON.parse(await readFile(lockPath,'utf8'));value.nonce='e'.repeat(48);await writeFile(lockPath,JSON.stringify(value));}
        if(state.changeMutex===stage){const path=join(f.profile,MUTEX),value=JSON.parse(await readFile(path,'utf8'));value.nonce='d'.repeat(48);await writeFile(path,JSON.stringify(value));}
        if(state.registryStage===stage)state.registry='active';
        if(state.ownerStage===stage)state.ownerAlive=true;
        if(state.crash===stage&&!state.crashed){state.crashed=true;throw Error(PRIVATE);}
      },async wait(){if(state.mode==='late_owner')state.ownerAlive=true;if(state.mode==='registry_changed')state.registry='active';},
      async openDiagnostic(){const handlers=new Map(),emit=(method,p)=>{for(const h of handlers.get(method)||[])h(p,{sessionId:'retire-session'});};
        const localScope={profilePath:f.profile,browserKey:originalParent.browserKey,registrationState:'quarantined',currentRegistrationState:async()=>state.registry};
        return{localScope,
          async close(){calls.push('close');if(state.onClose)await state.onClose({emit,localScope});if(state.mode==='close_failed')throw Error(PRIVATE);},cdp:{
            on(method,h){if(!handlers.has(method))handlers.set(method,new Set());handlers.get(method).add(h);return()=>handlers.get(method).delete(h);},
            async send(method,params,opts){calls.push(method);
              if(['Runtime.evaluate','Browser.close','Target.closeTarget','Storage.clearDataForOrigin'].includes(method))throw Error('forbidden_action');
              if(['Runtime.disable','Page.disable','Target.detachFromTarget'].includes(method)&&state.mode==='cleanup_failed')throw Error(PRIVATE);
              if(method==='Target.getTargets'){
                state.inventories++;assert.deepEqual(params,{});assert.deepEqual(opts,{timeoutMs:5000});
                const old={targetId:originalParent.targetId,type:'page',title:'SYNTHETIC_QUERY',url:QUERY_ORIGIN+'/szzh/zhcx/sbxx/sbxxcx',attached:false},
                  portal={targetId:'synthetic-new-portal',type:'page',title:'SYNTHETIC_NEW_PORTAL',url:QUERY_ORIGIN+'/loginb/',attached:false};
                if(state.inventoryReply){const reply=state.inventoryReply(state.inventories,{old,portal,emit});if(reply instanceof Error)throw reply;return reply;}
                return{targetInfos:state.targetAbsent?[portal]:[old,portal]};
              }
              if(method==='Target.getTargetInfo')return{targetInfo:{type:'page',targetId:originalParent.targetId}};
              if(method==='Target.attachToTarget')return{sessionId:'retire-session'};
              if(method==='Page.getFrameTree')return{frameTree:{frame:frame()}};
              if(method==='Page.navigate'){
                assert.deepEqual(params,{url:QUERY_ORIGIN+'/loginb/'});state.navCount++;
                if(state.mode==='aba')emit('Page.navigatedWithinDocument',{frameId:'query-frame'});
                if(state.mode!=='no_context')emit('Runtime.executionContextsCleared',{});
                if(state.mode==='two_clear')emit('Runtime.executionContextsCleared',{});
                if(state.mode==='three_clear'){emit('Runtime.executionContextsCleared',{});emit('Runtime.executionContextsCleared',{});}
                if(state.mode!=='no_loader'){state.after=true;emit('Page.frameNavigated',{frame:frame()});}
                if(state.mode==='clear_after_frame')emit('Runtime.executionContextsCleared',{});
                return{frameId:'query-frame',loaderId:'new-loader'};
              }return{};
            }}};}
    };
    const args={artifactRef:f.artifactRef,auditVersion:QUERY_RETIREMENT_AUDIT_VERSION,execute:true};
    const base=join(f.store.root,'retire_'+f.artifactRef),commit=join(f.parentStore.root,'abandon_'+f.parentSourceRef+'.commit.json');
    await run({...f,directory,originalParent,queryState:f.state,args,d,calls,state,lockPath,originalBytes,base,commit});
    assert.equal(await readFile(legacyPath,'utf8'),PRIVATE);assert.deepEqual(await f.parentStore.load(f.parentSourceRef),originalParent);
    assert.equal(calls.includes('Runtime.evaluate'),false);assert.equal(calls.includes('Browser.close'),false);assert.equal(calls.includes('Target.closeTarget'),false);
  }finally{assert.equal(dirname(resolve(directory)),resolve(ROOT));await rm(directory,{recursive:true,force:true});}
}
async function invoke(f,args=f.args){const result=await retireQueryReadonly(args,f.d);safe(result);return result;}
async function absent(p){await assert.rejects(lstat(p),{code:'ENOENT'});}
test('CLI has only fixed artifact/audit switches and defaults to diagnose',()=>{
  const base=['--artifact-ref','taxquery_'+'a'.repeat(48)];assert.equal(parseQueryRetirementArguments(base).execute,false);
  assert.equal(parseQueryRetirementArguments([...base,'--execute','--attest-identity-only']).auditVersion,QUERY_RETIREMENT_AUDIT_VERSION);
  for(const tail of [['--execute'],['--resume'],['--url',PRIVATE],['--execute','--attest-identity-only','--execute']])assert.throws(()=>parseQueryRetirementArguments([...base,...tail]));
});
test('default diagnose does not attach/navigate/write/mutate old lock',async()=>fixture(async f=>{
  const r=await invoke(f,{artifactRef:f.artifactRef});assert.equal(r.status,'diagnosed');assert.equal(f.state.navCount,0);
  assert.equal(f.calls.includes('Target.attachToTarget'),false);assert.deepEqual(await readFile(f.lockPath),f.originalBytes);
  await absent(join(f.profile,MUTEX));await absent(f.commit);
}));
for(const root of ['query','parent','capture'])test('missing fixed '+root+' root is refused before any ready can create it',async()=>fixture(async f=>{
  const path=root==='query'?f.store.root:root==='parent'?f.parentStore.root:f.store.captureRoot;
  await rm(path,{recursive:true,force:true});const r=await invoke(f,{artifactRef:f.artifactRef});assert.equal(r.status,'retirement_failed');
  await absent(path);assert.equal(f.calls.length,0);await absent(join(f.profile,MUTEX));
  // Restore synthetic parent bytes solely for fixture's preservation assertion.
  if(root==='parent'){await mkdir(path);await writeFile(join(path,f.parentSourceRef+'.json'),JSON.stringify(f.originalParent));}
}));
for(const mode of ['normal','two_clear','auth'])test('strict realm reset retires only matching lock and permanently tombstones its parent: '+mode,async()=>fixture(async f=>{
  f.state.mode=mode;const r=await invoke(f);assert.equal(r.status,'retired_readonly',JSON.stringify(r));assert.equal(r.lockRetired,true);
  assert.equal(r.realmDestructionProven,true);assert.equal(r.cleanupConfirmed,true);assert.equal(r.lateSessionEffectsPossible,true);
  assert.equal(r.finalSurface,mode==='auth'?'auth':'portal');assert.equal(f.state.navCount,1);await absent(f.lockPath);await absent(join(f.profile,MUTEX));
  await assert.rejects(f.parentStore.assertNotAbandoned(f.parentSourceRef));assert.ok((await readdir(f.store.root)).some(n=>n.endsWith('.finished.json')));
  const before=f.calls.length,again=await invoke(f,{...f.args,resume:true});assert.equal(again.status,'historical_retirement_confirmed');
  assert.equal(again.currentRealmVerified,false);assert.equal(Object.hasOwn(again,'finalSurface'),false);
  assert.equal(f.state.navCount,1);assert.equal(f.calls.slice(before).includes('Target.attachToTarget'),false);
}));
for(const mode of ['no_context','no_loader','external','unconfirmed_index','portal_bare_hash','portal_bare_query','auth_bare_hash','aba','three_clear','clear_after_frame','cleanup_failed','close_failed','registry_changed','late_owner'])
test('unconfirmed realm/cleanup/owner/registration retains persistent blockers: '+mode,async()=>fixture(async f=>{
  f.state.mode=mode;const r=await invoke(f);assert.equal(r.status,'retirement_failed');assert.equal(r.lockRetired,false);
  assert.deepEqual(await readFile(f.lockPath),f.originalBytes);assert.ok(await lstat(join(f.profile,MUTEX)));await assert.rejects(f.parentStore.assertNotAbandoned(f.parentSourceRef));
}));
test('live owner is rejected before mutex or navigation',async()=>fixture(async f=>{
  f.state.ownerAlive=true;const r=await invoke(f);assert.equal(r.status,'owner_alive');await absent(join(f.profile,MUTEX));assert.equal(f.state.navCount,0);
}));
for(const mode of ['operation','artifact','parent','extra'])test('only exact audited refresh scope accepted: '+mode,async()=>fixture(async f=>{
  const lock=JSON.parse(f.originalBytes);if(mode==='operation')lock.scope.operation='query_collect';if(mode==='artifact')lock.scope.artifactRef='taxquery_'+'f'.repeat(48);
  if(mode==='parent')lock.scope.parentSourceRef='taxsource_'+'f'.repeat(48);if(mode==='extra')lock.scope.extra=true;
  const bytes=JSON.stringify(lock);await writeFile(f.lockPath,bytes);const r=await invoke(f);assert.equal(r.status,'retirement_failed');assert.equal(f.state.navCount,0);
  assert.equal(await readFile(f.lockPath,'utf8'),bytes);await absent(join(f.profile,MUTEX));
}));
for(const stage of ['mutex_created','prepare_durable','commit_durable','realm_durable','finished_durable','lock_retired'])
test('durable crash stage resumes only its immutable matching journal: '+stage,async()=>fixture(async f=>{
  f.state.crash=stage;const first=await invoke(f);assert.equal(first.status,'retirement_failed');assert.equal(first.resumeRequired,true);
  const count=f.state.navCount,second=await invoke(f,{...f.args,resume:true});assert.equal(second.status,'retired_readonly',JSON.stringify(second));
  assert.equal(second.lockRetired,true);await absent(f.lockPath);await absent(join(f.profile,MUTEX));
  if(['realm_durable','finished_durable','lock_retired'].includes(stage))assert.equal(f.state.navCount,count);
}));
test('nonce replacement never removes a replacement lock',async()=>fixture(async f=>{
  f.state.mutate='realm_durable';const first=await invoke(f);assert.equal(first.status,'retirement_failed');const replacement=await readFile(f.lockPath);
  const second=await invoke(f,{...f.args,resume:true});assert.equal(second.status,'retirement_failed');assert.deepEqual(await readFile(f.lockPath),replacement);
}));
for(const [kind,stage,suffix] of [['prepare','prepare_durable','.prepare.json'],['commit','commit_durable',null],['realm','realm_durable','.realm.json'],['finish','finished_durable','.finished.json']])
test('actual final-plus-staging hardlink crash state is recoverable only for its own '+kind+' journal',async()=>fixture(async f=>{
  f.state.crash=stage;await invoke(f);const final=kind==='commit'?f.commit:f.base+suffix,staging=final+'.'+'a'.repeat(32)+'.tmp';
  await link(final,staging);assert.equal((await lstat(final)).nlink,2);
  const result=await invoke(f,{...f.args,resume:true});assert.equal(result.status,'retired_readonly',JSON.stringify(result));
  await absent(staging);assert.equal((await lstat(final)).nlink,1);await absent(f.lockPath);
}));
test('actual mutex final-plus-own-staging hardlink crash state is recoverable under OS guard',async()=>fixture(async f=>{
  f.state.crash='mutex_created';await invoke(f);const final=join(f.profile,MUTEX),staging=final+'.'+'a'.repeat(48)+'.tmp';await link(final,staging);
  const r=await invoke(f,{...f.args,resume:true});assert.equal(r.status,'retired_readonly');await absent(staging);await absent(final);
}));
test('unknown hardlink alias cannot be reclaimed as a publisher staging file',async()=>fixture(async f=>{
  f.state.crash='prepare_durable';await invoke(f);const final=f.base+'.prepare.json',unknown=final+'.unknown.tmp';await link(final,unknown);
  const r=await invoke(f,{...f.args,resume:true});assert.equal(r.status,'retirement_failed');assert.ok(await lstat(unknown));assert.equal((await lstat(final)).nlink,2);
  assert.deepEqual(await readFile(f.lockPath),f.originalBytes);
}));
test('realm proof resume refuses changed current document scope',async()=>fixture(async f=>{
  f.state.crash='realm_durable';await invoke(f);f.state.after=false;
  const r=await invoke(f,{...f.args,resume:true});assert.equal(r.status,'retirement_failed');assert.equal(r.resumeBlocked,true);
  assert.equal(r.manualReviewRequired,true);assert.deepEqual(await readFile(f.lockPath),f.originalBytes);
}));
test('hardlinked private evidence cannot authorize retirement',async()=>fixture(async f=>{
  await link(f.manifestPath,join(f.directory,'linked.json'));const r=await invoke(f);assert.equal(r.status,'retirement_failed');assert.equal(f.state.navCount,0);
}));
test('published commit verification failure remains committed and keeps blocking old chain',async()=>fixture(async f=>{
  const verify=f.store.security.verifyFile;f.store.security.verifyFile=async p=>{if(p===f.commit)throw Error(PRIVATE);return verify(p);};
  const r=await invoke(f);assert.equal(r.status,'retirement_failed');assert.equal(r.retirementCommitted,'unknown');
  assert.deepEqual(await readFile(f.lockPath),f.originalBytes);await assert.rejects(f.parentStore.assertNotAbandoned(f.parentSourceRef));
}));
test('retired parent cannot drive legacy/query requests or comparisons while historical records stay readable',async()=>fixture(async f=>{
  const refreshed=await f.collector.refresh({artifactRef:f.artifactRef});assert.equal(refreshed.reason,'tax_collection_busy');
  // Reuse a synthetic previously published run record to test comparison guards.
  const oldLock=await readFile(f.lockPath);await rm(f.lockPath);const ctx=await f.collector.refresh({artifactRef:f.artifactRef}),one=await f.collector.collect({contextRef:ctx.contextRef}),two=await f.collector.collect({contextRef:ctx.contextRef});
  await writeFile(f.lockPath,oldLock);const before=f.queryState.requests.length;assert.equal((await invoke(f)).status,'retired_readonly');
  assert.equal((await f.collector.collect({contextRef:ctx.contextRef})).status,'query_collection_failed');assert.equal(f.queryState.requests.length,before);
  assert.equal((await f.collector.compare({leftRef:one.runRef,rightRef:two.runRef})).status,'query_compare_failed');
  const portal=new TaxLiveCollection({store:f.parentStore,enabled:true,now:()=>3000,openDiagnostic:()=>{throw Error('must_not_open')}});
  assert.equal((await portal.collect({sourceRef:f.parentSourceRef})).status,'collection_failed');
  const source=await f.parentStore.load(f.parentSourceRef),record={version:1,sourceRef:f.parentSourceRef,capturedAt:3000,identity:source.identity,filing:source.filing,
    operationRef:'taxop_'+'b'.repeat(48),requestProof:['identity','current_filing','identity'].map((resource,i)=>({requestRef:'taxreq_'+String(i+1).repeat(48),resource,requestPerformed:true,responseComplete:true}))};
  const runRef='taxrun_'+'c'.repeat(48);await writeFile(join(f.parentStore.root,runRef+'.json'),JSON.stringify(record));
  assert.equal((await portal.compare({leftRef:f.parentSourceRef,rightRef:runRef})).status,'comparison_failed');
  assert.ok(await f.parentStore.load(runRef));assert.ok(await f.store.load(one.runRef));
}));

function noTargetActions(f){
  assert.equal(f.state.navCount,0);
  assert.deepEqual(f.calls.filter(c=>c!=='close'),Array(f.state.inventories).fill('Target.getTargets'));
}
test('two bounded inventories retire a missing exact old target without operating on the new portal',async()=>fixture(async f=>{
  f.state.targetAbsent=true;const r=await invoke(f);assert.equal(r.status,'retired_readonly',JSON.stringify(r));
  assert.equal(r.proofKind,'target_absent');assert.equal(r.oldContextUnavailableProven,true);assert.equal(r.realmDestructionProven,false);
  assert.equal(r.requestTermination,'unknown_abandoned');assert.equal(r.lateSessionEffectsPossible,true);assert.equal(Object.hasOwn(r,'finalSurface'),false);
  assert.equal(f.state.inventories,2);noTargetActions(f);await absent(f.lockPath);await absent(join(f.profile,MUTEX));
  await absent(f.base+'.realm.json');const proof=JSON.parse(await readFile(f.base+'.absent.json','utf8'));
  assert.deepEqual(Object.keys(proof).sort(),['checks','commitSha256','kind','oldTargetDigest','prepareSha256','version']);
  assert.equal(proof.version,2);assert.equal(proof.kind,'target_absent');assert.equal(proof.checks.length,2);
  assert.equal(proof.checks.every(c=>c.targetCount===1),true);safe(proof);
  const finish=JSON.parse(await readFile(f.base+'.finished.json','utf8'));assert.equal(finish.version,2);assert.equal(finish.kind,'target_absent');
  await assert.rejects(f.parentStore.assertNotAbandoned(f.parentSourceRef));
  const count=f.state.inventories,historical=await invoke(f,{...f.args,resume:true});
  assert.equal(historical.status,'historical_retirement_confirmed');assert.equal(historical.historicalOldContextUnavailableProven,true);
  assert.equal(historical.currentOldContextVerified,false);assert.equal(historical.currentRealmVerified,false);
  assert.equal(historical.realmDestructionProven,false);assert.equal(Object.hasOwn(historical,'oldContextUnavailableProven'),false);
  assert.equal(f.state.inventories,count);noTargetActions(f);
}));

test('absent diagnose writes no journals and does not claim a verified context',async()=>fixture(async f=>{
  f.state.targetAbsent=true;const r=await invoke(f,{artifactRef:f.artifactRef});assert.equal(r.status,'diagnosed');
  assert.equal(Object.hasOwn(r,'oldContextUnavailableProven'),false);assert.equal(f.state.inventories,1);noTargetActions(f);
  await absent(f.commit);await absent(f.base+'.prepare.json');await absent(join(f.profile,MUTEX));assert.deepEqual(await readFile(f.lockPath),f.originalBytes);
}));

for(const invalid of ['error','missing','null','extra','not_array','malformed','duplicate','oversize','unknown_field','invalid_optional','invalid_type'])
for(const scan of [1,2])test('unknown or malformed inventory is never absence: '+invalid+' scan '+scan,async()=>fixture(async f=>{
  f.state.inventoryReply=(n,{portal})=>{
    if(n!==scan)return{targetInfos:[portal]};
    if(invalid==='error')return Error(PRIVATE);if(invalid==='missing')return{};if(invalid==='null')return null;
    if(invalid==='extra')return{targetInfos:[portal],unknown:true};if(invalid==='not_array')return{targetInfos:{}};
    if(invalid==='malformed')return{targetInfos:[{targetId:'only-id'}]};if(invalid==='duplicate')return{targetInfos:[portal,{...portal}]};
    if(invalid==='oversize')return{targetInfos:Array.from({length:257},(_,i)=>({...portal,targetId:'synthetic-'+i}))};
    if(invalid==='unknown_field')return{targetInfos:[{...portal,unknown:true}]};
    if(invalid==='invalid_optional')return{targetInfos:[{...portal,canAccessOpener:'unknown'}]};
    return{targetInfos:[{...portal,attached:null}]};
  };
  const r=await invoke(f);assert.equal(r.status,'retirement_failed');assert.equal(r.lockRetired,false);noTargetActions(f);
  assert.deepEqual(await readFile(f.lockPath),f.originalBytes);await absent(f.base+'.absent.json');await absent(f.base+'.finished.json');
  await assert.rejects(f.parentStore.assertNotAbandoned(f.parentSourceRef));
}));

for(const mode of ['second_scan','created_event','changed_event'])test('old target reappearing between inventories blocks retirement: '+mode,async()=>fixture(async f=>{
  f.state.inventoryReply=(n,{old,portal,emit})=>{
    if(n===2&&mode!=='second_scan')emit(mode==='created_event'?'Target.targetCreated':'Target.targetInfoChanged',{targetInfo:old});
    return{targetInfos:n===2&&mode==='second_scan'?[old,portal]:[portal]};
  };
  const r=await invoke(f);assert.equal(r.status,'retirement_failed');noTargetActions(f);assert.deepEqual(await readFile(f.lockPath),f.originalBytes);
  await absent(f.base+'.absent.json');await absent(f.base+'.finished.json');
}));

for(const [key,stage] of [['mutate','target_absent_first'],['changeMutex','target_absent_first'],['registryStage','target_absent_first'],
  ['ownerStage','target_absent_first'],['mutate','target_absent_durable'],['changeMutex','target_absent_durable'],
  ['registryStage','target_absent_durable'],['ownerStage','target_absent_durable'],['mutate','finished_durable'],
  ['changeMutex','finished_durable'],['registryStage','finished_durable'],['ownerStage','finished_durable']])
test('missing-target retirement rechecks exact lock, mutex, registration and dead host: '+key+' '+stage,async()=>fixture(async f=>{
  f.state.targetAbsent=true;f.state[key]=stage;const r=await invoke(f);assert.equal(r.status,'retirement_failed');assert.equal(r.lockRetired,false);
  assert.ok(await lstat(f.lockPath));assert.ok(await lstat(join(f.profile,MUTEX)));noTargetActions(f);
  if(key!=='mutate')assert.deepEqual(await readFile(f.lockPath),f.originalBytes);
}));

for(const mode of ['close_failed','registry_changed','late_owner'])test('missing-target cleanup or late ownership failure keeps lock: '+mode,async()=>fixture(async f=>{
  f.state.targetAbsent=true;f.state.mode=mode;const r=await invoke(f);assert.equal(r.status,'retirement_failed');assert.equal(r.lockRetired,false);
  assert.deepEqual(await readFile(f.lockPath),f.originalBytes);await absent(f.base+'.absent.json');await absent(f.base+'.finished.json');noTargetActions(f);
}));

for(const stage of ['mutex_created','prepare_durable','commit_durable','target_absent_first','target_absent_durable','finished_durable','lock_retired'])
test('missing-target crash journal resumes with fresh inventories: '+stage,async()=>fixture(async f=>{
  f.state.targetAbsent=true;f.state.crash=stage;const first=await invoke(f);assert.equal(first.status,'retirement_failed');assert.equal(first.resumeRequired,true);
  const count=f.state.inventories,second=await invoke(f,{...f.args,resume:true});assert.equal(second.status,'retired_readonly',JSON.stringify(second));
  assert.equal(f.state.inventories,count+2);assert.equal(second.realmDestructionProven,false);noTargetActions(f);await absent(f.lockPath);await absent(join(f.profile,MUTEX));
}));

test('legacy prepared committed operation can resume via absent target without a fake realm proof',async()=>fixture(async f=>{
  f.state.mode='no_context';const first=await invoke(f);assert.equal(first.status,'retirement_failed');assert.equal(f.state.navCount,1);
  await absent(f.base+'.realm.json');await absent(f.base+'.finished.json');f.state.targetAbsent=true;
  const before=f.calls.length,second=await invoke(f,{...f.args,resume:true});assert.equal(second.status,'retired_readonly');assert.equal(second.realmDestructionProven,false);
  assert.deepEqual(f.calls.slice(before),['Target.getTargets','Target.getTargets','close']);assert.equal(f.state.navCount,1);await absent(f.base+'.realm.json');
}));

test('existing realm proof cannot convert to target-absent proof',async()=>fixture(async f=>{
  f.state.crash='realm_durable';await invoke(f);f.state.targetAbsent=true;
  const count=f.state.navCount,r=await invoke(f,{...f.args,resume:true});assert.equal(r.status,'retirement_failed');assert.equal(f.state.navCount,count);
  await absent(f.base+'.absent.json');assert.deepEqual(await readFile(f.lockPath),f.originalBytes);
}));

test('existing absent proof refuses an old target that is present again',async()=>fixture(async f=>{
  f.state.targetAbsent=true;f.state.crash='target_absent_durable';await invoke(f);f.state.targetAbsent=false;
  const r=await invoke(f,{...f.args,resume:true});assert.equal(r.status,'retirement_failed');noTargetActions(f);
  assert.deepEqual(await readFile(f.lockPath),f.originalBytes);await absent(f.base+'.finished.json');
}));

test('absent proof resume does not overwrite its immutable prior inventory evidence',async()=>fixture(async f=>{
  f.state.targetAbsent=true;f.state.crash='target_absent_durable';await invoke(f);const proof=await readFile(f.base+'.absent.json');
  f.state.inventoryReply=()=>({targetInfos:[]});const r=await invoke(f,{...f.args,resume:true});assert.equal(r.status,'retired_readonly');
  assert.deepEqual(await readFile(f.base+'.absent.json'),proof);noTargetActions(f);
}));

for(const field of ['kind','oldTargetDigest','prepareSha256','commitSha256','checks','extra'])test('malformed or foreign absent journal never authorizes resume: '+field,async()=>fixture(async f=>{
  f.state.targetAbsent=true;f.state.crash='target_absent_durable';await invoke(f);const path=f.base+'.absent.json',proof=JSON.parse(await readFile(path,'utf8'));
  if(field==='checks')proof.checks[1].order=1;else proof[field]=field==='extra'?true:field==='kind'?'realm_reset':'f'.repeat(64);
  await writeFile(path,JSON.stringify(proof));const r=await invoke(f,{...f.args,resume:true});assert.equal(r.status,'retirement_failed');
  assert.deepEqual(await readFile(f.lockPath),f.originalBytes);await absent(f.base+'.finished.json');noTargetActions(f);
}));

for(const [kind,stage,suffix] of [['absent','target_absent_durable','.absent.json'],['finish','finished_durable','.finished.json']])
test('missing-target proof hardlink publication crash resumes safely: '+kind,async()=>fixture(async f=>{
  f.state.targetAbsent=true;f.state.crash=stage;await invoke(f);const final=f.base+suffix,staging=final+'.'+'b'.repeat(32)+'.tmp';await link(final,staging);
  const r=await invoke(f,{...f.args,resume:true});assert.equal(r.status,'retired_readonly');await absent(staging);assert.equal((await lstat(final)).nlink,1);noTargetActions(f);
}));

for(const mode of ['reappeared','registry','browser','profile','owner','guard','lock','mutex'])
test('connection cleanup window remains guarded before absent proof publication: '+mode,async()=>fixture(async f=>{
  f.state.targetAbsent=true;f.state.onClose=async({emit,localScope})=>{
    if(mode==='reappeared')emit('Target.targetCreated',{targetInfo:{targetId:f.originalParent.targetId}});
    if(mode==='registry')f.state.registry='active';if(mode==='browser')localScope.browserKey='f'.repeat(64);
    if(mode==='profile')localScope.profilePath=join(f.profile,'different');if(mode==='owner')f.state.ownerAlive=true;
    if(mode==='guard')f.state.guardHeld=false;
    if(mode==='lock'||mode==='mutex'){const path=mode==='lock'?f.lockPath:join(f.profile,MUTEX),value=JSON.parse(await readFile(path,'utf8'));
      value.nonce='c'.repeat(48);await writeFile(path,JSON.stringify(value));}
  };
  const r=await invoke(f);assert.equal(r.status,'retirement_failed');assert.equal(r.lockRetired,false);noTargetActions(f);
  assert.ok(await lstat(f.lockPath));await absent(f.base+'.absent.json');await absent(f.base+'.finished.json');
}));

for(const field of ['kind','commitSha256','proofSha256','extra'])test('absent finished journal binds its exact proof kind and hashes: '+field,async()=>fixture(async f=>{
  f.state.targetAbsent=true;f.state.crash='finished_durable';await invoke(f);const path=f.base+'.finished.json',finish=JSON.parse(await readFile(path,'utf8'));
  finish[field]=field==='extra'?true:field==='kind'?'realm_reset':'f'.repeat(64);await writeFile(path,JSON.stringify(finish));
  const r=await invoke(f,{...f.args,resume:true});assert.equal(r.status,'retirement_failed');assert.deepEqual(await readFile(f.lockPath),f.originalBytes);noTargetActions(f);
}));

test('realm and absent proof journals are mutually exclusive',async()=>fixture(async f=>{
  f.state.crash='realm_durable';await invoke(f);await writeFile(f.base+'.absent.json',JSON.stringify({version:2,kind:'target_absent'}));
  const r=await invoke(f,{...f.args,resume:true});assert.equal(r.status,'retirement_failed');assert.deepEqual(await readFile(f.lockPath),f.originalBytes);
}));

test('unknown hardlink alias on absent proof is never repaired or retired',async()=>fixture(async f=>{
  f.state.targetAbsent=true;f.state.crash='target_absent_durable';await invoke(f);const final=f.base+'.absent.json',alias=final+'.unknown.tmp';await link(final,alias);
  const r=await invoke(f,{...f.args,resume:true});assert.equal(r.status,'retirement_failed');assert.equal((await lstat(alias)).nlink,2);
  assert.deepEqual(await readFile(f.lockPath),f.originalBytes);await absent(f.base+'.finished.json');noTargetActions(f);
}));

for(const pid of [0,1,2147483647])test('observed Edge parent and process metadata is accepted only as protocol structure: '+pid,async()=>fixture(async f=>{
  f.state.inventoryReply=(_n,{portal})=>({targetInfos:[{...portal,parentFrameId:'a'.repeat(32),parentId:'b'.repeat(32),pid}]});
  const r=await invoke(f);assert.equal(r.status,'retired_readonly');assert.equal(r.proofKind,'target_absent');
  assert.equal(r.realmDestructionProven,false);assert.equal(f.state.inventories,2);noTargetActions(f);
}));

for(const [label,pid] of [['negative',-1],['fractional',0.5],['too_large',2147483648],['unsafe',Number.MAX_SAFE_INTEGER+1],['string','0']])
test('Edge pid metadata rejects '+label,async()=>fixture(async f=>{
  f.state.inventoryReply=(_n,{portal})=>({targetInfos:[{...portal,pid}]});const r=await invoke(f);
  assert.equal(r.status,'retirement_failed');assert.equal(r.lockRetired,false);assert.deepEqual(await readFile(f.lockPath),f.originalBytes);
  await absent(f.base+'.absent.json');noTargetActions(f);
}));

for(const field of ['parentFrameId','parentId'])for(const [label,value] of [['empty',''],['number',1],['null',null],['too_long','p'.repeat(257)]])
test('Edge '+field+' metadata rejects '+label,async()=>fixture(async f=>{
  f.state.inventoryReply=(_n,{portal})=>({targetInfos:[{...portal,[field]:value}]});const r=await invoke(f);
  assert.equal(r.status,'retirement_failed');assert.equal(r.lockRetired,false);assert.deepEqual(await readFile(f.lockPath),f.originalBytes);
  await absent(f.base+'.absent.json');noTargetActions(f);
}));
