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
    const state={mode:'normal',ownerAlive:false,registry:'quarantined',crash:null,crashed:false,guardHeld:false,after:false,navCount:0},calls=[];
    const frame=()=>({id:'query-frame',loaderId:state.after?'new-loader':'query-loader',url:state.after?
      state.mode==='auth'?'https://tpass.fujian.chinatax.gov.cn:8443/api/v1.0/auth/oauth2/login?opaque=PRIVATE':
      state.mode==='external'?'https://example.invalid/':QUERY_ORIGIN+'/loginb/':QUERY_ORIGIN+'/szzh/zhcx/sbxx/sbxxcx'});
    const d={store:f.store,parentStore:f.parentStore,
      readLock:p=>readCollectionLock(p,{security:f.security}),acquireRecovery:(p,e)=>collectionRecoveryLock(p,e,{security:f.security}),
      isOwnerAlive:async()=>state.ownerAlive,
      async acquireAdminGuard(){if(state.guardHeld)throw Error(PRIVATE);state.guardHeld=true;return{verify(){assert.equal(state.guardHeld,true)},async close(){state.guardHeld=false}};},
      async checkpoint(stage){
        if(state.mutate===stage){const value=JSON.parse(await readFile(lockPath,'utf8'));value.nonce='e'.repeat(48);await writeFile(lockPath,JSON.stringify(value));}
        if(state.crash===stage&&!state.crashed){state.crashed=true;throw Error(PRIVATE);}
      },async wait(){if(state.mode==='late_owner')state.ownerAlive=true;if(state.mode==='registry_changed')state.registry='active';},
      async openDiagnostic(){const handlers=new Map(),emit=(method,p)=>{for(const h of handlers.get(method)||[])h(p,{sessionId:'retire-session'});};
        return{localScope:{profilePath:f.profile,browserKey:originalParent.browserKey,registrationState:'quarantined',currentRegistrationState:async()=>state.registry},
          async close(){calls.push('close');if(state.mode==='close_failed')throw Error(PRIVATE);},cdp:{
            on(method,h){if(!handlers.has(method))handlers.set(method,new Set());handlers.get(method).add(h);return()=>handlers.get(method).delete(h);},
            async send(method,params){calls.push(method);
              if(['Runtime.evaluate','Browser.close','Target.closeTarget','Storage.clearDataForOrigin'].includes(method))throw Error('forbidden_action');
              if(['Runtime.disable','Page.disable','Target.detachFromTarget'].includes(method)&&state.mode==='cleanup_failed')throw Error(PRIVATE);
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
for(const mode of ['no_context','no_loader','external','aba','three_clear','clear_after_frame','cleanup_failed','close_failed','registry_changed','late_owner'])
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
