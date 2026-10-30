// 所有锁、进程观测、CDP 事件和私有审计均为合成数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverTaxCollectionLock } from '../scripts/recover-tax-collection-lock.mjs';
import { pageReference } from '../scripts/inventory-tax-browser.mjs';

const PORTAL='https://etax.fujian.chinatax.gov.cn:8443/loginb/',PRIVATE='SENTINEL_RECOVERY_CHAIN';
async function run(mode='normal',execute=true,extra={}){
  const registrationRef='taxr_'+'1'.repeat(48),targetId=PRIVATE+'_TARGET',pageRef=pageReference(registrationRef,targetId);
  const original={version:1,nonce:'a'.repeat(48),ownerPid:2147483000,scope:{operation:'authorized_navigation',registrationRef,pageRef}};
  const expected=JSON.stringify(original),handlers=new Map(),calls=[],audits=[];
  let lock=structuredClone(original),recovery=false,held=false,released=false,reloaded=false,closed=false,ownerChecks=0;
  let frame={id:PRIVATE+'_FRAME',loaderId:PRIVATE+'_OLD',url:PORTAL};
  const emit=(name,p={})=>handlers.get(name)?.(p,{sessionId:'synthetic-session'});
  const doc=(loader,url=PORTAL,id=frame.id)=>({id,loaderId:loader,url});
  const overrides={
    readLock:async()=>structuredClone(lock),isOwnerAlive:async()=>{ownerChecks++;return mode==='live_owner'||mode==='late_owner'&&ownerChecks>=3;},
    acquireAdminGuard:async()=>{calls.push('guard_acquire');assert.equal(held,false);held=true;return{
      verify(){assert.equal(held,true);},async close(){calls.push('guard_close');if(mode==='guard_close_failure')throw Error(PRIVATE);held=false;}};},
    acquireRecovery:async()=>{assert.equal(held,true);calls.push('recovery_acquire');assert.equal(recovery,false);recovery=true;
      const verify=async()=>{assert.equal(held,true);assert.equal(recovery,true);assert.equal(JSON.stringify(lock),expected);};
      return{verifyOriginal:verify,async releaseOriginal(){calls.push('release_original');await verify();assert.equal(closed,true);assert.equal(handlers.size,0);lock=null;released=true;},
        async close(){calls.push('recovery_close');assert.equal(held,true);assert.equal(released,true);if(mode==='recovery_close_failure')throw Error(PRIVATE);recovery=false;}};},
    audit:async record=>{calls.push('audit:'+record.state);audits.push(structuredClone(record));
      if(mode==='audit_failure'&&record.state==='exclusion_acquired')throw Error(PRIVATE);
      if(mode==='late_scope'&&record.state==='final_portal_observed')emit('Runtime.executionContextsCleared');},
    wait:async ms=>{
      calls.push('wait:'+ms);
      if(ms===500&&mode==='quiet_aba'){
        emit('Page.navigatedWithinDocument',{frameId:frame.id});emit('Page.navigatedWithinDocument',{frameId:frame.id});
      }
      if(ms===12000&&mode==='nonce_replacement')lock={...lock,nonce:'b'.repeat(48)};
    },
    openDiagnostic:async()=>({localScope:{registrationState:'quarantined',profilePath:PRIVATE+'_PROFILE',
      currentRegistrationState:async()=>mode==='registry_changed'&&reloaded?'active':'quarantined'},
      async close(){calls.push('close_start');await new Promise(done=>setImmediate(done));if(mode==='close_failure')throw Error(PRIVATE);closed=true;calls.push('close_done');},
      cdp:{on(name,fn){handlers.set(name,fn);return()=>{calls.push('off:'+name);if(mode==='off_failure'&&name==='Page.frameNavigated')throw Error(PRIVATE);handlers.delete(name);};},
        async send(method,params){calls.push(method);
          if(method==='Target.getTargets'){
            const selected={type:'page',targetId,url:reloaded&&mode==='target_changed'?PORTAL+'?SENTINEL':PORTAL};
            return{targetInfos:[selected,{type:'page',targetId:PRIVATE+'_AUTH',url:'https://tpass.fujian.chinatax.gov.cn:8443/'},
              ...(mode==='duplicate_target'?[selected]:[])]};
          }
          if(method==='Target.attachToTarget'){assert.equal(params.targetId,targetId);if(mode==='attach_unknown')throw Error(PRIVATE);return{sessionId:'synthetic-session'};}
          if(method==='Runtime.enable'){emit('Runtime.executionContextCreated',{context:{id:101}});return{};}
          if(method==='Page.enable')return{};
          if(method==='Page.getFrameTree')return{frameTree:{frame:{...frame}}};
          if(method==='Page.reload'){
            assert.deepEqual(params,{});reloaded=true;
            // 观测结构：六次清空、三份主文档、两次文档内
            // 事件及一次 frame 分离。不消费任何封存前文档。
            if(mode!=='no_destroy')for(let i=0;i<6;i++)emit('Runtime.executionContextsCleared');
            if(mode==='known_destroy')emit('Runtime.executionContextDestroyed',{executionContextId:101});
            if(mode==='unknown_destroy')emit('Runtime.executionContextDestroyed',{executionContextId:202});
            emit('Page.frameNavigated',{frame:doc(PRIVATE+'_MIDDLE1','https://tpass.fujian.chinatax.gov.cn:8443/')});
            emit('Page.navigatedWithinDocument',{frameId:frame.id});emit('Page.navigatedWithinDocument',{frameId:frame.id});
            emit('Page.frameDetached',{frameId:frame.id});
            emit('Page.frameNavigated',{frame:doc(PRIVATE+'_MIDDLE2','https://etax.fujian.chinatax.gov.cn:8443/szzh/')});
            frame=doc(mode==='same_loader'?PRIVATE+'_OLD':PRIVATE+'_NEW',mode==='wrong_full_url'?PORTAL+'?SENTINEL':PORTAL);
            if(mode!=='unobserved_final')emit('Page.frameNavigated',{frame:{...frame}});
            if(mode==='session_lost')emit('Target.detachedFromTarget',{sessionId:'synthetic-session'});
            return{};
          }
          if(method==='Target.detachFromTarget'){
            if(mode==='detach_failure')throw Error(PRIVATE);
            if(mode==='scope_during_detach')emit('Page.navigatedWithinDocument',{frameId:frame.id});
            emit('Target.detachedFromTarget',{sessionId:'synthetic-session'});return{};
          }
          throw Error('unexpected synthetic CDP method');
        }},
    }),
  };
  // 销毁上下文的替代路径不再同时依赖 contextsCleared 证明。
  if(['known_destroy','unknown_destroy'].includes(mode)){
    const open=overrides.openDiagnostic;overrides.openDiagnostic=async()=>{const t=await open(),on=t.cdp.on;t.cdp.on=(name,fn)=>on(name,name==='Runtime.executionContextsCleared'?()=>{}:fn);return t;};
  }
  const out=await recoverTaxCollectionLock({registrationRef,pageRef,execute,...extra},overrides);
  assert.doesNotMatch(JSON.stringify(out),/SENTINEL|https?:|nonce|ownerPid|targetId|frameId|loaderId|profilePath|registrationRoot/);
  assert.ok(!calls.some(c=>/\.disable$|^Network\.|^Runtime\.evaluate$|^Page\.navigate$/.test(c)));
  return{out,calls,audits,lock,recovery,held,released};
}

test('default diagnosis ignores other auth targets and does not create exclusion/audits or reload',async()=>{
  const {out,calls,audits,lock,recovery}=await run('normal',false);
  assert.equal(out.status,'diagnosed');assert.equal(out.oldLockReleased,false);assert.ok(lock);assert.equal(recovery,false);assert.deepEqual(audits,[]);
  for(const method of ['guard_acquire','recovery_acquire','Target.attachToTarget','Page.reload'])assert.ok(!calls.includes(method));
});

test('multi-document bootstrap proves only final stable portal and releases exact old lock after full cleanup',async()=>{
  const {out,calls,audits,recovery,lock}=await run();assert.equal(out.status,'recovered');assert.equal(out.oldLockReleased,true);
  assert.equal(out.contextDestroyed,true);assert.equal(out.loaderChanged,true);assert.equal(out.cleanupConfirmed,true);
  assert.equal(out.sourceCreated,false);assert.equal(out.requestTermination,'unknown');assert.equal(recovery,false);assert.equal(lock,null);
  assert.equal(out.events.filter(e=>e.kind==='main_frame').length,3);assert.equal(out.events.filter(e=>e.kind==='context_clear').length,6);
  assert.ok(calls.lastIndexOf('Page.getFrameTree')<calls.indexOf('Target.detachFromTarget'));
  assert.ok(calls.indexOf('Target.detachFromTarget')<calls.findIndex(c=>c.startsWith('off:')));
  assert.ok(calls.findLastIndex(c=>c.startsWith('off:'))<calls.indexOf('close_start'));
  assert.ok(calls.indexOf('close_done')<calls.indexOf('release_original'));
  assert.ok(calls.indexOf('recovery_close')<calls.indexOf('guard_close'));
  assert.deepEqual(audits.map(a=>a.state),['exclusion_acquired','final_portal_observed','release_intent','released']);
});

for(const mode of ['no_destroy','unknown_destroy','same_loader','wrong_full_url','unobserved_final','quiet_aba','late_scope','scope_during_detach',
  'session_lost','target_changed','nonce_replacement','registry_changed','late_owner','attach_unknown','detach_failure','off_failure','close_failure','audit_failure']){
  test(mode+' retains original/recovery exclusion without consuming pre-seal documents',async()=>{
    const {out,recovery,lock,released}=await run(mode);assert.equal(out.status,'recovery_failed');assert.equal(out.oldLockReleased,false);
    assert.equal(out.recoveryRetained,true);assert.equal(recovery,true);assert.ok(lock);assert.equal(released,false);
  });
}

test('known old context destruction is accepted while unrelated context destruction cannot prove old realm loss',async()=>{
  assert.equal((await run('known_destroy')).out.status,'recovered');
});

test('duplicate selected target refuses before administrator exclusion',async()=>{
  const {out,calls,audits}=await run('duplicate_target');assert.equal(out.status,'recovery_failed');assert.ok(!calls.includes('guard_acquire'));assert.deepEqual(audits,[]);
});

test('fixed input contract rejects manual URL, nonce or PID authority',async()=>{
  for(const extra of [{url:PORTAL},{nonce:'a'.repeat(48)},{ownerPid:1}]){
    const {out,calls,audits}=await run('normal',true,extra);assert.equal(out.status,'recovery_failed');assert.equal(calls.length,0);assert.deepEqual(audits,[]);
  }
});

test('guard/recovery close failures report exact partial exclusion after original release',async()=>{
  const guard=await run('guard_close_failure');assert.equal(guard.out.status,'recovery_failed');assert.equal(guard.out.oldLockReleased,true);
  assert.equal(guard.out.recoveryRetained,false);assert.equal(guard.out.adminGuardUnconfirmed,true);assert.equal(guard.out.cleanupConfirmed,false);
  const mutex=await run('recovery_close_failure');assert.equal(mutex.out.status,'recovery_failed');assert.equal(mutex.out.oldLockReleased,true);
  assert.equal(mutex.out.recoveryRetained,true);assert.equal(mutex.out.cleanupConfirmed,false);
});
