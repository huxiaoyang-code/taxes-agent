// 仅使用合成临时文件及注入的 CDP/进程观测。不读取真实
// 登记、浏览器配置目录、证据存储、数据库或网络。
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat,link,unlink} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {TaxDownloadRetirement,SETTLED_NAVIGATION_HELPER_SHA256} from '../server/tax-download-retirement.mjs';
import {readCollectionLock,collectionRecoveryLock,TaxCollectionStore} from '../server/tax-collection-local.mjs';
import {buildHistoryTemplate,enterpriseOf,HISTORY_ORIGIN,HISTORY_PATH} from '../server/tax-history-contract.mjs';
import {businessProjection} from '../server/tax-collection-shape.mjs';
import {FULL_FRAME_URL_SEMANTICS} from '../server/tax-frame-url.mjs';
const PRIVATE='PRIVATE_SYNTHETIC_RETIREMENT',PORTAL=HISTORY_ORIGIN+'/loginb/';
const ref=(prefix,char='1')=>prefix+'_'+char.repeat(48);
const security={verifyDirectory:async p=>assert.ok((await lstat(p)).isDirectory()),verifyFile:async p=>assert.ok((await lstat(p)).isFile())};
const safe=value=>assert.doesNotMatch(JSON.stringify(value),/PRIVATE_SYNTHETIC|https?:|targetId|frameId|loaderId|registrationRoot|profilePath|userinfo|taxpayer_id|nonce|ownerPid|Sha256/);
const exists=async p=>{try{await lstat(p);return true}catch(e){if(e.code==='ENOENT')return false;throw e}};
async function fixture(callback,options={}){
  const temporaryParent=dirname(fileURLToPath(import.meta.url));
  const root=await mkdtemp(join(temporaryParent,'tax-retirement-synthetic-'));
  try{
    const profile=join(root,'profile'),parentRoot=join(root,'parent');await mkdir(profile);await mkdir(parentRoot);
    const sourceRef=ref('taxsource'),templateRef=ref('taxhistorytemplate'),contextRef=ref('taxhistorycontext');
    const identity={resource:'identity',recipe:{path:'/mhzx/api/mh/mhsy/getUserInfo',method:'GET',body:null,queryTimestamp:true},
      projection:businessProjection({Response:{Error:null,Data:{userinfo:{reg_number:PRIVATE+'_REG',company_name:PRIVATE+'_CO',creditCode:PRIVATE+'_CC',taxpayer_id:PRIVATE+'_TAX'}}}},'identity')};
    const parent={version:2,documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,authorizedNavigation:true,handoffMode:'quarantined_reader_new_navigation',readerStoppedConfirmed:true,
      registrationRef:ref('taxr'),registrationRoot:join(root,'.agent-runs','tax-browser-registry'),pageRef:ref('taxpage'),targetId:PRIVATE+'_TARGET',frameId:PRIVATE+'_OLD',
      loaderId:PRIVATE+'_OLD_LOADER',browserKey:'a'.repeat(64),documentUrlDigest:'b'.repeat(64),capturedAt:1000,identity,
      filing:{resource:'current_filing',recipe:{path:'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx',method:'POST',body:{Csbz:''},queryTimestamp:true},
        projection:businessProjection({Response:{Data:{wsbxxGrid:[]}}},'current_filing')}};
    const manifest={version:1,sourceRef,target:'filing_query',capturedAt:1001,assets:[],document:{targetId:parent.targetId,frameId:PRIVATE+'_FRAME',loaderId:PRIVATE+'_QUERY',
      url:HISTORY_ORIGIN+'/szzh/zhcx/sbxx/sbxxcx?ruuid='+PRIVATE},identityProjection:identity.projection,
      requests:[{url:HISTORY_ORIGIN+HISTORY_PATH,method:'POST',body:{gzlx:['a','b'],pageNum:1,pageSize:10,sbrqq:'',sbrqz:'',skssqq:'',skssqz:'',zfbz:'',yzpzzlDm:''},
        response:{Response:{Error:null,Data:{PageNumber:1,PageSize:10,Total:0,List:[]}}}}]};
    const template=buildHistoryTemplate(manifest,parent,ref('taxquery'));
    const context={version:1,templateRef,createdAt:1002,expiresAt:1801002,replayDocument:structuredClone(template.captureDocument),enterprise:enterpriseOf(identity.projection),
      operationRef:ref('taxop'),proof:['1','2'].map(c=>({requestRef:ref('taxreq',c),resource:'identity',requestPerformed:true,responseComplete:true}))};
    const expected={version:1,nonce:'c'.repeat(48),ownerPid:2147483000,scope:{operation:'download_return_to_portal',parentSourceRef:sourceRef,contextRef}};
    const lockPath=join(profile,'YoushuCollectionLockV1.json'),recoveryPath=join(profile,'YoushuCollectionRecoveryV1.json');await writeFile(lockPath,JSON.stringify(expected));
    const paths={prepare:join(parentRoot,'abandon_'+sourceRef+'.download.prepare.json'),commit:join(parentRoot,'abandon_'+sourceRef+'.commit.json'),
      archive:join(parentRoot,'abandon_'+sourceRef+'.download.lock.bin'),finished:join(parentRoot,'abandon_'+sourceRef+'.download.finished.json')};
    const proof={version:1,operatorAttested:true,loadedBytesProof:false,helperSha256:SETTLED_NAVIGATION_HELPER_SHA256,
      contextRef,templateRef,parentSourceRef:sourceRef,ownerPid:expected.ownerPid,
      originalLockSha256:createHash('sha256').update(JSON.stringify(expected)).digest('hex'),
      result:{status:'portal_return_failed',phase:'cleanup',reason:'cleanup_unconfirmed',operationSettled:true,
        requestAttemptedCount:2,requestPerformedCount:2,responseCompleteCount:2,requestPerformedUnknownCount:0,requestNotPerformedCount:0,
        navigationAttemptedCount:1,navigationConfirmedCount:1,identityProjectionMatched:true,bootstrapContextClearCount:2}};
    const state={calls:[],reads:0,close:0,guards:0,guardClose:0,guardHeld:false,alive:false,registration:'quarantined',mode:options.mode,checkpoint:options.checkpoint,failed:false};
    let frame={id:context.replayDocument.frameId,loaderId:PRIVATE+'_PORTAL_LOADER',url:PORTAL};
    const parentStore={root:parentRoot,ready:async()=>{},load:async r=>{assert.equal(r,sourceRef);return structuredClone(parent)},
      assertNotAbandoned:TaxCollectionStore.prototype.assertNotAbandoned};
    const overrides={store:{load:async r=>structuredClone(r===contextRef?context:r===templateRef?template:null)},parentStore,
      trustedAttestation:proof,...security,isOwnerAlive:async pid=>pid===expected.ownerPid?state.alive:false,
      readLock:p=>readCollectionLock(p,{security}),acquireRecovery:(p,e)=>collectionRecoveryLock(p,e,{security}),
      acquireAdminGuard:async()=>{state.guards++;if(options.enforceMutex&&state.guardHeld)throw Error(PRIVATE);state.guardHeld=true;
        let closed=false;return {verify(){assert.equal(closed,false)},async close(){
        state.guardClose++;if(state.mode==='guard_close_failure')throw Error(PRIVATE);closed=true;state.guardHeld=false;
        if(options.onGuardClose)await options.onGuardClose({state,lockPath,recoveryPath,expected,paths});}}},
      checkpoint:async stage=>{
        if(state.checkpoint===stage&&!state.failed){state.failed=true;throw Error(PRIVATE)}
        if(options.onCheckpoint)await options.onCheckpoint(stage,{state,lockPath,recoveryPath,expected,paths});
      },
      openDiagnostic:async()=>({localScope:{browserKey:parent.browserKey,registrationState:'quarantined',profilePath:profile,
        currentRegistrationState:async()=>state.registration},async close(){state.close++;if(state.mode==='close_failure')throw Error(PRIVATE)},
        cdp:{async send(method,params,opts){state.calls.push(method);assert.ok(opts.timeoutMs>0);
          if(method==='Target.getTargets')return {targetInfos:[{targetId:parent.targetId,type:state.mode==='worker'?'worker':'page',url:state.mode==='target_query'?PORTAL+'?private=1':PORTAL}]};
          if(method==='Target.attachToTarget')return {sessionId:'synthetic_session'};
          if(method==='Target.detachFromTarget'){if(state.mode==='detach_failure')throw Error(PRIVATE);return {}};
          if(method==='Page.getFrameTree'){
            state.reads++;
            if(state.mode==='loader_changes'&&state.reads===2)frame.loaderId+='CHANGED';
            if(state.mode==='fragment')frame.urlFragment='#';if(state.mode==='query')frame.url=PORTAL+'?private=1';
            if(state.mode==='subframe')frame.parentId='parent';if(state.mode==='different_frame')frame.id+='OTHER';
            if(state.mode==='old_loader')frame.loaderId=context.replayDocument.loaderId;
            return {frameTree:{frame:structuredClone(frame)}};
          }
          throw Error('unexpected_cdp');
        }}})};
    const f={root,profile,parentStore,sourceRef,templateRef,contextRef,parent,context,template,proof,expected,lockPath,recoveryPath,paths,state,overrides,
      retire:args=>new TaxDownloadRetirement(overrides).retire({contextRef,...args})};
    await callback(f);
    assert.ok(state.calls.every(x=>['Target.getTargets','Target.attachToTarget','Page.getFrameTree','Target.detachFromTarget'].includes(x)));
  }finally{
    assert.equal(dirname(resolve(root)),resolve(temporaryParent));assert.match(root.split(/[\\/]/).at(-1),/^tax-retirement-synthetic-/);await rm(root,{recursive:true,force:true});
  }
}

test('diagnose verifies only two stable portal reads and does not create exclusion or journals',async()=>fixture(async f=>{
  const out=await f.retire();safe(out);assert.equal(out.status,'portal_retirement_diagnosed',JSON.stringify(out));assert.equal(f.state.reads,2);
  assert.equal(f.state.guards,0);assert.equal(await exists(f.lockPath),true);assert.equal(await exists(f.recoveryPath),false);assert.equal(await exists(f.paths.commit),false);
}));
test('settled local retirement permanently blocks old source before releasing exact lock',async()=>fixture(async f=>{
  const out=await f.retire({execute:true});safe(out);assert.equal(out.status,'portal_retired_locally');assert.equal(out.cleanupConfirmed,true);
  assert.equal(out.requestTermination,'unknown');assert.equal(out.realmDestructionProven,false);assert.equal(out.downstreamReady,false);
  assert.equal(await exists(f.lockPath),false);assert.equal(await exists(f.recoveryPath),false);await assert.rejects(f.parentStore.assertNotAbandoned(f.sourceRef));
  assert.equal(f.state.reads,2);assert.equal(f.state.close,1);assert.equal(f.state.guardClose,1);
  const audit=JSON.parse(await readFile(f.paths.prepare,'utf8'));assert.equal(audit.attestation.helperSha256,SETTLED_NAVIGATION_HELPER_SHA256);
  assert.equal(audit.binding.contextRef,f.contextRef);assert.equal((await lstat(f.paths.prepare)).nlink,1);
}));
for(const [name,mutate] of [
  ['missing proof',f=>{f.overrides.trustedAttestation=null}],['wrong helper',f=>{f.proof.helperSha256='F'.repeat(64)}],
  ['loaded proof claim',f=>{f.proof.loadedBytesProof=true}],['unknown request',f=>{f.proof.result.requestPerformedUnknownCount=1}],
  ['not settled',f=>{f.proof.result.operationSettled=false}],['wrong proof context',f=>{f.proof.contextRef=ref('taxhistorycontext','2')}],
  ['wrong enterprise',f=>{f.context.enterprise.taxpayer_id+='OTHER'}],['wrong registration',f=>{f.template.registrationRef=ref('taxr','2')}],
  ['host alive',f=>{f.state.alive=true}],['registration changed',f=>{f.state.registration='active'}],
])test('rejects '+name,async()=>fixture(async f=>{mutate(f);const out=await f.retire({execute:true});safe(out);
  assert.equal(out.status,'portal_retirement_refused');assert.equal(await exists(f.lockPath),true);assert.equal(await exists(f.paths.commit),false);
}));
for(const mode of ['worker','target_query','loader_changes','fragment','query','subframe','different_frame','old_loader'])
  test('rejects portal evidence '+mode+' while retaining exclusion',async()=>fixture(async f=>{
    const out=await f.retire({execute:true});safe(out);assert.equal(out.status,'portal_retirement_partial');
    assert.equal(await exists(f.lockPath),true);assert.equal(await exists(f.recoveryPath),true);assert.equal(await exists(f.paths.commit),false);
  },{mode}));
test('fixed ref input rejects arbitrary proof/path/url/body and invalid resume',async()=>fixture(async f=>{
  for(const args of [{url:PORTAL},{path:f.root},{body:{}},{proof:f.proof},{execute:'yes'},{resume:true}]){
    const out=await f.retire(args);safe(out);assert.equal(out.status,'portal_retirement_refused');
  }assert.equal(f.state.calls.length,0);assert.equal(await exists(f.recoveryPath),false);
}));
for(const change of ['nonce','ownerPid','scope_extra','scope_context','operation','version'])test('refuses changed original '+change,async()=>fixture(async f=>{
  const changed=structuredClone(f.expected);
  if(change==='nonce')changed.nonce='d'.repeat(48);if(change==='ownerPid')changed.ownerPid--;
  if(change==='scope_extra')changed.scope.other=true;if(change==='scope_context')changed.scope.contextRef=ref('taxhistorycontext','2');
  if(change==='operation')changed.scope.operation='other';if(change==='version')changed.version=2;
  await writeFile(f.lockPath,JSON.stringify(changed));const out=await f.retire({execute:true});safe(out);assert.equal(out.status,'portal_retirement_refused');
  assert.deepEqual(JSON.parse(await readFile(f.lockPath,'utf8')),changed);assert.equal(await exists(f.paths.commit),false);
}));
test('second snapshot boundary rechecks host liveness',async()=>fixture(async f=>{
  const out=await f.retire({execute:true});safe(out);assert.equal(out.status,'portal_retirement_partial');assert.equal(f.state.reads,1);assert.equal(await exists(f.paths.commit),false);
},{onCheckpoint:async(stage,{state})=>{if(stage==='portal_read_once')state.alive=true}}));
test('second snapshot boundary rejects lock CAS change without deleting replacement',async()=>fixture(async f=>{
  const out=await f.retire({execute:true});safe(out);assert.equal(out.status,'portal_retirement_partial');assert.equal(f.state.reads,1);
  assert.equal(JSON.parse(await readFile(f.lockPath,'utf8')).nonce,'e'.repeat(48));assert.equal(await exists(f.paths.commit),false);
},{onCheckpoint:async(stage,{lockPath,expected})=>{if(stage==='portal_read_once')await writeFile(lockPath,JSON.stringify({...expected,nonce:'e'.repeat(48)}))}}));
for(const checkpoint of ['prepare_durable','commit_durable','transport_closed','before_retire','lock_retired','finished_durable','before_recovery_retire','recovery_retired','guard_closed'])
  test('resumes persistent stage '+checkpoint+' without blind unlink',async()=>fixture(async f=>{
    const interrupted=await f.retire({execute:true});safe(interrupted);assert.equal(interrupted.status,'portal_retirement_partial');
    const recoveryRemaining=!['recovery_retired','guard_closed'].includes(checkpoint);
    assert.equal(await exists(f.recoveryPath),recoveryRemaining);assert.equal(interrupted.recoveryRetained,recoveryRemaining);
    const refused=await f.retire({execute:true});safe(refused);assert.notEqual(refused.status,'portal_retired_locally');
    const resumed=await f.retire({execute:true,resume:true});safe(resumed);assert.equal(resumed.status,'portal_retired_locally');
    assert.equal(await exists(f.recoveryPath),false);assert.equal(await exists(f.lockPath),false);
  },{checkpoint}));
for(const checkpoint of ['recovery_created','archive_durable'])test('refuses unbound orphan recovery after '+checkpoint,async()=>fixture(async f=>{
  const first=await f.retire({execute:true});safe(first);assert.equal(first.status,'portal_retirement_partial');
  const oldRecovery=await readFile(f.recoveryPath),oldLock=await readFile(f.lockPath);
  const resumed=await f.retire({execute:true,resume:true});safe(resumed);assert.equal(resumed.status,'portal_retirement_partial');
  assert.equal(resumed.manualRecoveryEvidenceRequired,true);assert.equal(resumed.recoveryBindingVerified,false);
  assert.deepEqual(await readFile(f.recoveryPath),oldRecovery);assert.deepEqual(await readFile(f.lockPath),oldLock);assert.equal(await exists(f.paths.commit),false);
},{checkpoint}));
for(const mode of ['detach_failure','close_failure','guard_close_failure'])test(mode+' accurately reports exclusion and partial cleanup',async()=>fixture(async f=>{
  const out=await f.retire({execute:true});safe(out);assert.equal(out.status,'portal_retirement_partial');assert.equal(out.cleanupConfirmed,false);
  assert.equal(out.abandonedStateCommitted,true);assert.equal(await exists(f.recoveryPath),mode!=='guard_close_failure');
  assert.equal(out.recoveryRetained,mode!=='guard_close_failure');assert.equal(out.adminGuardUnconfirmed,mode==='guard_close_failure');
  if(mode==='guard_close_failure'){assert.equal(out.phase,'admin_cleanup');assert.equal(out.resumeRequired,true);}
  assert.equal(await exists(f.lockPath),mode==='guard_close_failure'?false:true);
  f.state.mode='normal';const resumed=await f.retire({execute:true,resume:true});safe(resumed);assert.equal(resumed.status,'portal_retired_locally');
},{mode}));
test('finished retry never deletes or consumes a new collector lock',async()=>fixture(async f=>{
  assert.equal((await f.retire({execute:true})).status,'portal_retired_locally');
  const replacement={version:1,nonce:'f'.repeat(48),ownerPid:process.pid,scope:{operation:'another_collector'}};
  await writeFile(f.lockPath,JSON.stringify(replacement));const reads=f.state.reads;
  const out=await f.retire({execute:true,resume:true});safe(out);assert.equal(out.alreadyFinished,true);assert.equal(f.state.reads,reads);
  assert.deepEqual(JSON.parse(await readFile(f.lockPath,'utf8')),replacement);
}));
test('tampered prepared audit refuses resume and retains all exclusions',async()=>fixture(async f=>{
  await f.retire({execute:true});const audit=JSON.parse(await readFile(f.paths.prepare,'utf8'));audit.binding.contextDigest='0'.repeat(64);
  await writeFile(f.paths.prepare,JSON.stringify(audit));const out=await f.retire({execute:true,resume:true});safe(out);
  assert.notEqual(out.status,'portal_retired_locally');assert.equal(await exists(f.lockPath),true);assert.equal(await exists(f.recoveryPath),true);
},{checkpoint:'prepare_durable'}));
test('refuses hardlinked lock and pre-existing conflicting permanent marker',async()=>fixture(async f=>{
  const other=join(f.root,'linked');await link(f.lockPath,other);let out=await f.retire({execute:true});safe(out);assert.equal(out.status,'portal_retirement_refused');
  await unlink(other);await writeFile(f.paths.commit,'{}');out=await f.retire({execute:true});safe(out);assert.equal(out.status,'portal_retirement_refused');
  assert.equal(await exists(f.lockPath),true);assert.equal(await readFile(f.paths.commit,'utf8'),'{}');
}));
test('recovery creator publication followed by throw remains explicitly partial',async()=>fixture(async f=>{
  const create=f.overrides.acquireRecovery;f.overrides.acquireRecovery=async(...args)=>{await create(...args);throw Error(PRIVATE)};
  const out=await f.retire({execute:true});safe(out);assert.equal(out.status,'portal_retirement_partial');assert.equal(out.recoveryRetained,true);
  assert.equal(await exists(f.lockPath),true);assert.equal(await exists(f.recoveryPath),true);assert.equal(await exists(f.paths.commit),false);
}));
test('unknown attach never reports confirmed cleanup and retains exclusion',async()=>fixture(async f=>{
  const open=f.overrides.openDiagnostic;f.overrides.openDiagnostic=async(...args)=>{
    const transport=await open(...args),send=transport.cdp.send;transport.cdp.send=async(method,...rest)=>{
      if(method==='Target.attachToTarget')throw Error(PRIVATE);return send(method,...rest);
    };return transport;
  };
  const out=await f.retire({execute:true});safe(out);assert.equal(out.status,'portal_retirement_partial');assert.equal(out.cleanupConfirmed,false);
  assert.equal(await exists(f.recoveryPath),true);assert.equal(f.state.close,1);assert.equal(await exists(f.paths.commit),false);
}));
test('marker replacement after durable commit prevents original lock deletion',async()=>fixture(async f=>{
  const out=await f.retire({execute:true});safe(out);assert.equal(out.status,'portal_retirement_partial');assert.equal(out.abandonedStateCommitted,'unknown');
  assert.equal(await exists(f.lockPath),true);assert.equal(await exists(f.recoveryPath),true);assert.equal(await readFile(f.paths.commit,'utf8'),'{}');
},{onCheckpoint:async(stage,{paths})=>{if(stage==='before_retire')await writeFile(paths.commit,'{}')}}));
test('published marker with failed ACL verification stays unknown and can only resume from valid private stage',async()=>fixture(async f=>{
  let reject=true;f.overrides.verifyFile=async path=>{if(path===f.paths.commit&&reject)throw Error(PRIVATE);return security.verifyFile(path)};
  const out=await f.retire({execute:true});safe(out);assert.equal(out.status,'portal_retirement_partial');assert.equal(out.abandonedStateCommitted,'unknown');
  assert.equal(await exists(f.paths.commit),true);assert.equal(await exists(f.lockPath),true);assert.equal(await exists(f.recoveryPath),true);
  await assert.rejects(f.parentStore.assertNotAbandoned(f.sourceRef));reject=false;
  const resumed=await f.retire({execute:true,resume:true});safe(resumed);assert.equal(resumed.status,'portal_retired_locally');
}));
test('resume refuses replacement recovery mutex even when original source lock still matches',async()=>fixture(async f=>{
  await f.retire({execute:true});const mutex=JSON.parse(await readFile(f.recoveryPath,'utf8'));mutex.nonce='0'.repeat(48);
  await writeFile(f.recoveryPath,JSON.stringify(mutex));const out=await f.retire({execute:true,resume:true});safe(out);
  assert.equal(out.status,'portal_retirement_partial');assert.equal(await exists(f.lockPath),true);assert.equal(await exists(f.paths.commit),false);
  assert.deepEqual(JSON.parse(await readFile(f.recoveryPath,'utf8')),mutex);
},{checkpoint:'prepare_durable'}));

test('OS guard excludes concurrent resume until exact recovery unlink, then later replacements survive',async()=>{
  let competing,created=false;
  const replacementLock={version:1,nonce:'e'.repeat(48),ownerPid:process.pid,scope:{operation:'new_collector'}};
  const replacementRecovery={version:1,nonce:'f'.repeat(48),ownerPid:process.pid};
  await fixture(async f=>{
    const checkpoint=f.overrides.checkpoint;
    f.overrides.checkpoint=async stage=>{
      await checkpoint(stage);
      if(stage==='before_recovery_retire'){
        assert.equal(f.state.guardHeld,true);
        const original=await readFile(f.recoveryPath);
        competing=await f.retire({execute:true,resume:true});safe(competing);
        assert.equal(competing.status,'portal_retirement_refused');assert.equal(competing.phase,'registration');
        assert.equal(f.state.guardHeld,true);
        assert.deepEqual(await readFile(f.recoveryPath),original);
      }
    };
    const out=await f.retire({execute:true});safe(out);assert.equal(out.status,'portal_retired_locally');
    assert.ok(competing);assert.equal(created,true);
    assert.deepEqual(JSON.parse(await readFile(f.lockPath,'utf8')),replacementLock);
    assert.deepEqual(JSON.parse(await readFile(f.recoveryPath,'utf8')),replacementRecovery);
  },{enforceMutex:true,onGuardClose:async({state,lockPath,recoveryPath})=>{
    assert.equal(state.guardHeld,false);
    assert.equal(await exists(recoveryPath),false,'original recovery must be gone before OS exclusion is released');
    await writeFile(lockPath,JSON.stringify(replacementLock));await writeFile(recoveryPath,JSON.stringify(replacementRecovery));created=true;
  }});
});

test('guard close failure after exact recovery deletion never reports a replacement as retained original',async()=>{
  const replacement={version:1,nonce:'f'.repeat(48),ownerPid:process.pid};
  await fixture(async f=>{
    const acquire=f.overrides.acquireAdminGuard;
    f.overrides.acquireAdminGuard=async(...args)=>{
      const guard=await acquire(...args);
      guard.close=async()=>{
        assert.equal(await exists(f.recoveryPath),false);
        await writeFile(f.recoveryPath,JSON.stringify(replacement));
        throw Error(PRIVATE);
      };
      return guard;
    };
    const out=await f.retire({execute:true});safe(out);
    assert.equal(out.status,'portal_retirement_partial');assert.equal(out.phase,'admin_cleanup');
    assert.equal(out.recoveryRetained,false);assert.equal(out.adminGuardUnconfirmed,true);assert.equal(out.cleanupConfirmed,false);
    assert.deepEqual(JSON.parse(await readFile(f.recoveryPath,'utf8')),replacement);
  });
});

test('completed retry guard close failure stays partial without claiming the original recovery remains',async()=>fixture(async f=>{
  assert.equal((await f.retire({execute:true})).status,'portal_retired_locally');
  const replacement={version:1,nonce:'f'.repeat(48),ownerPid:process.pid,scope:{operation:'new_collector'}};
  await writeFile(f.lockPath,JSON.stringify(replacement));const reads=f.state.reads;f.state.mode='guard_close_failure';
  const out=await f.retire({execute:true,resume:true});safe(out);
  assert.equal(out.status,'portal_retirement_partial');assert.equal(out.phase,'admin_cleanup');
  assert.equal(out.lockRetired,true);assert.equal(out.recoveryRetained,false);assert.equal(out.adminGuardUnconfirmed,true);
  assert.equal(out.cleanupConfirmed,false);assert.equal(f.state.reads,reads);
  assert.deepEqual(JSON.parse(await readFile(f.lockPath,'utf8')),replacement);
}));
