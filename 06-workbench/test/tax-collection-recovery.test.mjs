// 仅显式恢复合成的遗弃锁。不打开或修改真实浏览器、进程、
// 注册表、旧声明或隔离状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,lstat,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectionLock,readCollectionLock,collectionRecoveryLock} from '../server/tax-collection-local.mjs';
import {recoverTaxCollectionLock} from '../scripts/recover-tax-collection-lock.mjs';
import {pageReference} from '../scripts/inventory-tax-browser.mjs';

const parent=fileURLToPath(new URL('../.agent-runs/tax-recovery-test-temporary/',import.meta.url));
const PRIVATE='PRIVATE_SYNTHETIC_RECOVERY_TRIPWIRE';
const security={async verifyDirectory(path){assert.ok((await lstat(path)).isDirectory())},
  async verifyFile(path){assert.ok((await lstat(path)).isFile())}};
const safe=value=>assert.doesNotMatch(JSON.stringify(value),/PRIVATE_SYNTHETIC|nonce|ownerPid|profilePath|targetId|registrationRoot|cookie|authorization/);
async function fixture(callback){
  await mkdir(parent,{recursive:true});const directory=await mkdtemp(join(parent,'synthetic-'));
  try{
    const profile=join(directory,'profile');await mkdir(profile);
    const registrationRef='taxr_'+'1'.repeat(48),targetId=PRIVATE+'_TARGET',pageRef=pageReference(registrationRef,targetId);
    const scope={registrationRef,pageRef,operation:'authorized_navigation'};
    const lock=await collectionLock(profile,{scope,security});lock.retain();
    const lockPath=join(profile,'YoushuCollectionLockV1.json'),original=await readFile(lockPath,'utf8');
    const claimPath=join(profile,'legacy-reader-claim.synthetic.json'),registryPath=join(profile,'legacy-registry.synthetic.json');
    const legacyClaim=JSON.stringify({state:'quarantined',synthetic:PRIVATE});
    await writeFile(claimPath,legacyClaim);await writeFile(registryPath,legacyClaim);
    await callback({directory,profile,registrationRef,targetId,pageRef,scope,lockPath,original,claimPath,registryPath});
    assert.equal(await readFile(claimPath,'utf8'),legacyClaim,'legacy claim must never be rewritten');
    assert.equal(await readFile(registryPath,'utf8'),legacyClaim,'legacy quarantine must never be rewritten');
  }finally{
    assert.equal(dirname(resolve(directory)),resolve(parent));assert.match(directory.split(/[\\/]/).at(-1),/^synthetic-/);
    await rm(directory,{recursive:true,force:true});
  }
}
async function recovery(f,{mode='normal',execute,ownerAlive=false}={}){
  const origin='https://etax.fujian.chinatax.gov.cn:8443',handlers=new Map(),calls=[];let reloaded=false,ownerChecks=0;
  const emit=(name,params)=>handlers.get(name)?.(params,{sessionId:'synthetic-session'});
  const overrides={
    acquireAdminGuard:async()=>({verify(){},async close(){}}),audit:async()=>{},
    readLock:path=>readCollectionLock(path,{security}),
    acquireRecovery:(path,expected)=>collectionRecoveryLock(path,expected,{security}),
    async isOwnerAlive(){ownerChecks++;return ownerAlive||(mode==='late_owner_alive'&&ownerChecks>=3);},
    async wait(){
      if(mode==='nonce_changed'){
        const value=JSON.parse(await readFile(f.lockPath,'utf8'));value.nonce='f'.repeat(48);await writeFile(f.lockPath,JSON.stringify(value));
      }
    },
    async openDiagnostic(){return {localScope:{profilePath:f.profile,registrationState:'quarantined',
      async currentRegistrationState(){return mode==='registry_changed'&&reloaded?'active':'quarantined';}},
      close(){calls.push('close');if(mode==='close_failed')throw Error(PRIVATE);},cdp:{
        on(name,handler){handlers.set(name,handler);return()=>handlers.delete(name);},
        async send(method){
          calls.push(method);
          if(method==='Target.getTargets')return {targetInfos:[{type:'page',targetId:f.targetId,url:origin+'/loginb/'}]};
          if(method==='Target.attachToTarget')return {sessionId:'synthetic-session'};
          if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'synthetic-frame',loaderId:reloaded&&mode!=='no_new_loader'?'new-loader':'old-loader',url:origin+'/loginb/'}}};
          if(method==='Page.reload'){
            reloaded=true;
            if(mode!=='no_context')emit('Runtime.executionContextsCleared',{});
            emit('Page.frameNavigated',{frame:{id:'synthetic-frame',loaderId:mode==='no_new_loader'?'old-loader':'new-loader',url:origin+'/loginb/'}});
            return {};
          }
          if(method==='Runtime.disable'&&mode==='disable_failed'||method==='Target.detachFromTarget'&&mode==='detach_failed')throw Error(PRIVATE);
          if(['Page.enable','Runtime.enable','Runtime.disable','Page.disable','Target.detachFromTarget'].includes(method))return {};
          throw Error('synthetic_unexpected_method');
        },
      }};},
  };
  const args={registrationRef:f.registrationRef,registrationRoot:join(f.directory,'synthetic-checkout','.agent-runs','tax-browser-registry'),pageRef:f.pageRef};
  if(execute!==undefined)args.execute=execute;
  const result=await recoverTaxCollectionLock(args,overrides);safe(result);return {result,calls,ownerChecks};
}
async function assertOriginal(f){assert.equal(await readFile(f.lockPath,'utf8'),f.original);}
async function assertNoRecoveryMutex(f){assert.equal((await readdir(f.profile)).includes('YoushuCollectionRecoveryV1.json'),false);}
async function assertRecoveryRetained(f){assert.equal((await readdir(f.profile)).includes('YoushuCollectionRecoveryV1.json'),true);}

test('default recovery is diagnostic only and cannot reload, create a mutex, or delete a lock',async()=>{
  await fixture(async f=>{
    const {result,calls}=await recovery(f);assert.equal(result.status,'diagnosed');assert.equal(result.reloadSent,false);
    assert.equal(result.oldLockReleased,false);assert.equal(result.registrationChanged,false);assert.equal(result.browserClosed,false);
    assert.equal(calls.includes('Page.reload'),false);assert.equal(calls.includes('Target.attachToTarget'),false);
    await assertOriginal(f);await assertNoRecoveryMutex(f);
  });
});

test('a live synthetic owner is rejected before attaching or reloading',async()=>{
  await fixture(async f=>{
    const {result,calls}=await recovery(f,{execute:true,ownerAlive:true});assert.equal(result.status,'owner_alive');
    assert.equal(result.oldLockReleased,false);assert.equal(calls.includes('Page.reload'),false);
    await assertOriginal(f);await assertNoRecoveryMutex(f);
  });
});

test('legacy or unrelated lock operations are never converted into recovery authority',async()=>{
  await fixture(async f=>{
    for(const operation of ['active_replay','legacy_reader','unknown']){
      const value=JSON.parse(f.original);value.scope.operation=operation;const changed=JSON.stringify(value);await writeFile(f.lockPath,changed);
      const {result,calls,ownerChecks}=await recovery(f,{execute:true});assert.equal(result.status,'recovery_failed');
      assert.equal(result.oldLockReleased,false);assert.equal(calls.includes('Page.reload'),false);assert.equal(ownerChecks,0);
      assert.equal(await readFile(f.lockPath,'utf8'),changed);await assertNoRecoveryMutex(f);
    }
  });
});

test('mismatched safe registration or page refs cannot recover another navigation lock',async()=>{
  await fixture(async f=>{
    const value=JSON.parse(f.original);value.scope.pageRef='taxpage_'+'f'.repeat(48);const changed=JSON.stringify(value);await writeFile(f.lockPath,changed);
    const {result,calls}=await recovery(f,{execute:true});assert.equal(result.status,'recovery_failed');assert.equal(result.oldLockReleased,false);
    assert.equal(calls.includes('Page.reload'),false);assert.equal(await readFile(f.lockPath,'utf8'),changed);await assertNoRecoveryMutex(f);
  });
});

test('nonce changes after reload cannot authorize deletion of a replacement lock',async()=>{
  await fixture(async f=>{
    const {result}=await recovery(f,{execute:true,mode:'nonce_changed'});assert.equal(result.status,'recovery_failed');assert.equal(result.oldLockReleased,false);
    assert.equal(JSON.parse(await readFile(f.lockPath,'utf8')).nonce,'f'.repeat(48));await assertRecoveryRetained(f);
  });
});

for(const mode of ['no_new_loader','no_context','detach_failed','close_failed','registry_changed','late_owner_alive']){
  test(`recovery preserves the original lock on ${mode}`,async()=>{
    await fixture(async f=>{
      const {result}=await recovery(f,{execute:true,mode});assert.equal(result.status,'recovery_failed');assert.equal(result.oldLockReleased,false);
      await assertOriginal(f);await assertRecoveryRetained(f);
    });
  });
}

test('recovery detaches its session without domain-disable commands or their synthetic failure',async()=>{
  await fixture(async f=>{
    const {result,calls}=await recovery(f,{execute:true,mode:'disable_failed'});
    assert.equal(result.status,'recovered');assert.equal(calls.some(method=>method.endsWith('.disable')),false);await assertNoRecoveryMutex(f);
  });
});

test('explicit verified reload with dead owner releases only the matching collection lock',async()=>{
  await fixture(async f=>{
    const {result,calls,ownerChecks}=await recovery(f,{execute:true});assert.equal(result.status,'recovered');
    assert.equal(result.oldLockReleased,true);assert.equal(result.loaderChanged,true);assert.equal(result.contextDestroyed,true);
    assert.equal(result.cleanupConfirmed,true);assert.equal(result.registrationChanged,false);assert.equal(result.browserClosed,false);
    assert.equal(ownerChecks,3);assert.ok(calls.indexOf('Target.detachFromTarget')<calls.indexOf('close'));
    assert.deepEqual((await readdir(f.profile)).sort(),['legacy-reader-claim.synthetic.json','legacy-registry.synthetic.json']);
  });
});
