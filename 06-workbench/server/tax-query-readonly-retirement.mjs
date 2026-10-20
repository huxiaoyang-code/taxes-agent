// Explicit local administration for one audited, dead-host query refresh.
// No HTTP/Agent/MCP export. Navigation does not prove server-side termination.
import {createHash,randomBytes} from 'node:crypto';
import {open,lstat,realpath,link,unlink,readdir} from 'node:fs/promises';
import {dirname,basename,join,resolve} from 'node:path';
import {TaxQueryStore} from './tax-query-store.mjs';
import {TaxCollectionStore,readCollectionLock,collectionRecoveryLock} from './tax-collection-local.mjs';
import {openRegisteredBrowserDiagnostic} from './tax-browser-diagnostic.mjs';
import {acquireReadonlyAdminGuard} from './tax-readonly-abandon.mjs';
import {buildQueryTemplate,QUERY_ORIGIN,queryDocumentValid,exact} from './tax-query-contract.mjs';
import {fullFrameUrl,FULL_FRAME_URL_SEMANTICS} from './tax-frame-url.mjs';
export const QUERY_RETIREMENT_AUDIT_VERSION='query_refresh_identity_only_v1';
export const QUERY_RETIREMENT_AUDIT=Object.freeze({version:1,operatorAttested:true,loadedBytesProof:false,
  controllerSha256:'50127b74e46ed53ef50fc8eaac131312920279e361ec3cafd2d51a67b842f796',
  generatorSha256:'4e245e8254b8ff21aa2cf8908ca23a965f19e1c6e8cadaaf467fd2e69b7a310d',
  wrapperSha256:'a7577eeafb16985294e1ea6d0e8a8049d8ebd88d6e607ae6af485c043c0e9d2d',
  executionCommit:'002ea21df7e8e5836f79afb88a959f87d4af7913',controllerBlob:'f065eea657ab5f3027a110fbbfe44650d227a94e',identityGetOnly:true,hostResultConsumerExited:true,
  browserScriptHasNoHostFollowup:true,performedCounterProvesNoRequest:false,terminationProven:false});
const LOCK='YoushuCollectionLockV1.json',MUTEX='YoushuCollectionRecoveryV1.json';
const HOME=QUERY_ORIGIN+'/loginb/';
const hash=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const fail=()=>{throw Error('query_retirement_failed')};
const ref=(v,prefix)=>typeof v==='string'&&new RegExp('^'+prefix+'_[a-f0-9]{48}$').test(v);
const mutexValid=v=>exact(v,['version','nonce','ownerPid'])&&v.version===1&&/^[a-f0-9]{48}$/.test(v.nonce)
  &&Number.isSafeInteger(v.ownerPid)&&v.ownerPid>0&&v.ownerPid<=2147483647;
async function alive(pid){try{process.kill(pid,0);return true}catch(e){if(e.code==='ESRCH')return false;throw e;}}
function surface(raw){
  try{const u=new URL(raw);if(u.username||u.password||u.hash)return null;
    if(u.origin==='https://tpass.fujian.chinatax.gov.cn:8443'&&u.pathname==='/api/v1.0/auth/oauth2/login')return'auth';
    if(u.origin===QUERY_ORIGIN&&!u.search&&['/loginb/','/loginb','/mhzx/api/mh/mhsy/index'].includes(u.pathname))return'portal';
  }catch{}return null;
}
function documentOf(frame,targetId){const fullUrl=fullFrameUrl(frame);return{targetId,frameId:frame.id,loaderId:frame.loaderId,fullUrl,
  documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,documentUrlDigest:hash(fullUrl)};}
async function existingDirectory(path,security){
  let cursor=resolve(path);for(;;){const s=await lstat(cursor);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(cursor)!==cursor)fail();
    const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}await security.verifyDirectory(path);
}
async function privateBytes(path,security,limit=131072,links=1){
  let cursor=resolve(dirname(path));for(;;){const s=await lstat(cursor);if(s.isSymbolicLink()||await realpath(cursor)!==cursor)fail();const p=dirname(cursor);if(p===cursor)break;cursor=p;}
  await security.verifyDirectory(dirname(path));const before=await lstat(path);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==links||await realpath(path)!==path||before.size>limit)fail();
  await security.verifyFile(path);const h=await open(path,'r');
  try{const s=await h.stat();if(s.ino!==before.ino||s.dev!==before.dev||s.size!==before.size||s.nlink!==links)fail();
    const bytes=await h.readFile(),after=await h.stat(),current=await lstat(path);
    if(bytes.length>limit||after.mtimeMs!==s.mtimeMs||after.size!==s.size||current.ino!==s.ino||current.dev!==s.dev||current.nlink!==links||current.isSymbolicLink())fail();
    await security.verifyFile(path);return bytes;
  }finally{await h.close();}
}
async function maybe(path,security){try{return await privateBytes(path,security)}catch(e){if(e.code==='ENOENT')return null;throw e;}}
// Only the exact known final path and its publisher's strict staging syntax are
// eligible. Unknown aliases and additional links remain blocked. Called under
// the OS guard, after dead-host and exact original-scope verification.
async function ownPublication(path,security,{repair=false,mutex=false}={}){
  let info;try{info=await lstat(path)}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(info.nlink===1)return privateBytes(path,security);
  if(info.nlink!==2)fail();const names=await readdir(dirname(path));if(names.length>10000)fail();
  const prefix=basename(path)+'.',width=mutex?48:32,candidates=names.filter(name=>name.startsWith(prefix)
    &&new RegExp('^[a-f0-9]{'+width+'}\\.tmp$').test(name.slice(prefix.length)));
  let staging;for(const name of candidates){const candidate=join(dirname(path),name),s=await lstat(candidate);
    if(s.ino===info.ino&&s.dev===info.dev){if(staging||s.nlink!==2)fail();staging=candidate;}}
  if(!staging)fail();const bytes=await privateBytes(path,security,131072,2),staged=await privateBytes(staging,security,131072,2);
  if(!bytes.equals(staged))fail();
  if(repair){const current=await lstat(path),other=await lstat(staging);if(current.ino!==info.ino||current.dev!==info.dev||current.nlink!==2
      ||other.ino!==info.ino||other.dev!==info.dev||other.nlink!==2)fail();await unlink(staging);
    if(!(await privateBytes(path,security)).equals(bytes))fail();}
  return bytes;
}
async function publish(path,value,security){
  const bytes=Buffer.from(canonical(value)),staging=path+'.'+randomBytes(16).toString('hex')+'.tmp';
  try{const h=await open(staging,'wx',0o600);try{await h.writeFile(bytes);await h.sync()}finally{await h.close()}
    await security.verifyFile(staging);await link(staging,path);await unlink(staging);
    const durable=await open(path,'r+');try{await durable.sync()}finally{await durable.close()}
    if(!(await privateBytes(path,security)).equals(bytes))fail();
  }finally{await unlink(staging).catch(()=>{});}
}
const safe=(status,phase,extra={})=>({status,phase,requestTermination:'unknown_abandoned',lateSessionEffectsPossible:true,
  loadedBytesProof:false,oldResultConsumption:'permanently_forbidden',newSourceRequired:true,newDocumentScopeRequired:true,
  newIdentityVerificationRequired:true,lockRetired:false,realmDestructionProven:false,browserClosed:false,registrationChanged:false,...extra});
export async function retireQueryReadonly(args={},overrides={}){
  const d={store:new TaxQueryStore(),parentStore:new TaxCollectionStore(),openDiagnostic:openRegisteredBrowserDiagnostic,
    readLock:readCollectionLock,acquireRecovery:collectionRecoveryLock,acquireAdminGuard:acquireReadonlyAdminGuard,isOwnerAlive:alive,
    wait:ms=>new Promise(done=>setTimeout(done,ms)),checkpoint:async()=>{},...overrides};
  let phase='validation',transport,guard,attached,original,originalBytes,mutex,prepare,paths,marker,committed=false,finished=false,
    result,revisionInvalid=false,navigationSent=false,contextDestroyed=false,newFrame,oldDocument,detachRequested=false,cleanup=true,existingProof,recoveryPath;
  const removers=[],events=[];let contextClears=0,started=0;
  const record=kind=>{if(events.length<32)events.push({order:events.length+1,kind,elapsedMs:Math.max(0,Date.now()-started)});else revisionInvalid=true;};
  const security=d.store.security;
  try{
    if(!args||typeof args!=='object'||Array.isArray(args)||!ref(args.artifactRef,'taxquery')
      ||Object.keys(args).some(k=>!['artifactRef','auditVersion','execute','resume'].includes(k))
      ||args.execute!==undefined&&typeof args.execute!=='boolean'||args.resume!==undefined&&typeof args.resume!=='boolean'
      ||args.execute===true&&args.auditVersion!==QUERY_RETIREMENT_AUDIT_VERSION||args.resume===true&&args.execute!==true
      ||args.auditVersion!==undefined&&args.auditVersion!==QUERY_RETIREMENT_AUDIT_VERSION)fail();
    if(args.execute===true&&!/^[a-f0-9]{64}$/.test(QUERY_RETIREMENT_AUDIT.wrapperSha256))fail();
    phase='evidence';await existingDirectory(d.store.root,security);await existingDirectory(d.store.captureRoot,security);
    await existingDirectory(d.parentStore.root,d.parentStore.security);
    const artifact=await d.store.loadArtifact(args.artifactRef),parent=await d.parentStore.load(artifact.sourceRef);
    if(parent.version!==2)fail();const template=buildQueryTemplate(artifact,parent,artifact.sourceRef,args.artifactRef);
    await d.parentStore.ready();await d.store.ready();
    const base=join(d.store.root,'retire_'+args.artifactRef);paths={prepare:base+'.prepare.json',proof:base+'.realm.json',finish:base+'.finished.json',
      commit:join(d.parentStore.root,'abandon_'+artifact.sourceRef+'.commit.json')};
    phase='registration';transport=await d.openDiagnostic({registrationRef:parent.registrationRef,registrationRoot:parent.registrationRoot},
      {registrationBase:dirname(resolve(parent.registrationRoot))});
    const local=transport.localScope;
    if(local?.browserKey!==parent.browserKey||local.registrationState!=='quarantined'||await local.currentRegistrationState()!=='quarantined')fail();
    const profile=resolve(local.profilePath),lockPath=join(profile,LOCK),mutexPath=join(profile,MUTEX);recoveryPath=mutexPath;
    const registration=async()=>{guard?.verify();if(await local.currentRegistrationState()!=='quarantined'||local.browserKey!==parent.browserKey||resolve(local.profilePath)!==profile)fail();guard?.verify();};
    if(args.execute===true){phase='admin_guard';guard=await d.acquireAdminGuard(profile);guard.verify();}
    if(args.execute===true){
      const lock=await maybe(lockPath,security),prepared=await ownPublication(paths.prepare,security),candidate=lock?JSON.parse(lock):
        prepared?JSON.parse(Buffer.from(JSON.parse(prepared).originalBase64,'base64')):null;
      if(!exact(candidate,['version','nonce','ownerPid','scope'])||candidate.version!==1
        ||!mutexValid({version:candidate.version,nonce:candidate.nonce,ownerPid:candidate.ownerPid})
        ||!exact(candidate.scope,['operation','parentSourceRef','artifactRef'])||candidate.scope.operation!=='query_context_refresh'
        ||candidate.scope.parentSourceRef!==artifact.sourceRef||candidate.scope.artifactRef!==args.artifactRef)fail();
      if(await d.isOwnerAlive(candidate.ownerPid))return result=safe('owner_alive','owner');
      const recovery=await ownPublication(mutexPath,security,{mutex:true});
      if(recovery){const v=JSON.parse(recovery);if(!mutexValid(v)||await d.isOwnerAlive(v.ownerPid))fail();}
      if(prepared){const v=JSON.parse(prepared);
        if(!exact(v,['version','artifactRef','parentSourceRef','artifactSha256','parentSha256','profile','browserKey','originalBase64','mutex','audit'])||v.version!==1
          ||v.artifactRef!==args.artifactRef||v.parentSourceRef!==artifact.sourceRef||v.artifactSha256!==hash(canonical(artifact))
          ||v.parentSha256!==hash(canonical(parent))||v.profile!==profile||v.browserKey!==parent.browserKey
          ||canonical(v.audit)!==canonical(QUERY_RETIREMENT_AUDIT)||!mutexValid(v.mutex)
          ||typeof v.originalBase64!=='string'||lock&&!Buffer.from(v.originalBase64,'base64').equals(lock))fail();
      }
      if((prepared||recovery)&&args.resume!==true)return result=safe('resume_required','journal');
      for(const p of Object.values(paths))await ownPublication(p,security,{repair:true});
      await ownPublication(mutexPath,security,{repair:true,mutex:true});await registration();
    }
    const preparedBytes=await maybe(paths.prepare,security),finishBytes=await maybe(paths.finish,security);
    if(preparedBytes){
      phase='resume';if(args.resume!==true)return result=safe('resume_required',phase);
      prepare=JSON.parse(preparedBytes);
      if(!exact(prepare,['version','artifactRef','parentSourceRef','artifactSha256','parentSha256','profile','browserKey','originalBase64','mutex','audit'])||prepare.version!==1
        ||prepare.artifactRef!==args.artifactRef||prepare.parentSourceRef!==artifact.sourceRef||prepare.artifactSha256!==hash(canonical(artifact))
        ||prepare.parentSha256!==hash(canonical(parent))||prepare.profile!==profile||prepare.browserKey!==parent.browserKey
        ||canonical(prepare.audit)!==canonical(QUERY_RETIREMENT_AUDIT)||!mutexValid(prepare.mutex)||typeof prepare.originalBase64!=='string')fail();
      originalBytes=Buffer.from(prepare.originalBase64,'base64');if(originalBytes.toString('base64')!==prepare.originalBase64||originalBytes.length>4096)fail();
      original=JSON.parse(originalBytes);mutex=prepare.mutex;
    }else{
      if(finishBytes)fail();await d.parentStore.assertNotAbandoned(artifact.sourceRef);
      original=await d.readLock(profile);originalBytes=await privateBytes(lockPath,security,4096);
      if(canonical(original)!==canonical(JSON.parse(originalBytes)))fail();
    }
    if(!exact(original,['version','nonce','ownerPid','scope'])||original.version!==1||!mutexValid({version:original.version,nonce:original.nonce,ownerPid:original.ownerPid})
      ||!exact(original.scope,['operation','parentSourceRef','artifactRef'])||original.scope.operation!=='query_context_refresh'
      ||original.scope.parentSourceRef!==artifact.sourceRef||original.scope.artifactRef!==args.artifactRef)fail();
    marker={version:1,state:'query_readonly_retired',artifactRef:args.artifactRef,prepareSha256:preparedBytes?hash(preparedBytes):null,
      requestTermination:'unknown_abandoned',oldResultConsumption:'permanently_forbidden'};
    const commitBytes=await maybe(paths.commit,security);
    if(commitBytes){if(!preparedBytes||canonical(JSON.parse(commitBytes))!==canonical(marker))fail();committed=true;}
    const proofBytes=await maybe(paths.proof,security);
    if(proofBytes){existingProof=JSON.parse(proofBytes);
      if(!committed||!exact(existingProof,['version','oldDocumentDigest','newDocumentDigest','oldFrame','oldLoader','newFrame','newLoader','contextDestroyed','finalSurface','events'])
        ||existingProof.version!==1||existingProof.contextDestroyed!==true||!['portal','auth'].includes(existingProof.finalSurface)
        ||!['oldDocumentDigest','newDocumentDigest'].every(k=>/^[a-f0-9]{64}$/.test(existingProof[k]))
        ||!['oldFrame','oldLoader','newFrame','newLoader'].every(k=>typeof existingProof[k]==='string'&&existingProof[k].length>0&&existingProof[k].length<=256)
        ||existingProof.oldFrame!==existingProof.newFrame||existingProof.oldLoader===existingProof.newLoader
        ||!Array.isArray(existingProof.events)||existingProof.events.length>32
        ||existingProof.events.some((e,i)=>!exact(e,['order','kind','elapsedMs'])||e.order!==i+1
          ||!['context_clear','context_destroy','main_frame'].includes(e.kind)||!Number.isSafeInteger(e.elapsedMs)||e.elapsedMs<0))fail();
      const clears=existingProof.events.filter(e=>e.kind==='context_clear'),frames=existingProof.events.filter(e=>e.kind==='main_frame');
      if(clears.length<1||clears.length>2||frames.length!==1||clears.some(e=>e.order>frames[0].order))fail();
    }
    if(finishBytes){const finish=JSON.parse(finishBytes);
      if(!existingProof||!exact(finish,['version','commitSha256','realmSha256'])||finish.version!==1
        ||finish.commitSha256!==hash(commitBytes)||finish.realmSha256!==hash(proofBytes))fail();finished=true;
      if(await maybe(mutexPath,security)===null){if(await maybe(lockPath,security)!==null)fail();
        return result=safe('historical_retirement_confirmed','finished',{lockRetired:true,retirementCommitted:true,
          historicalRealmDestructionProven:true,currentRealmVerified:false,resumed:true});}
    }
    phase='owner';if(await d.isOwnerAlive(original.ownerPid))return result=safe('owner_alive',phase);
    const verifyMutex=async()=>{const current=JSON.parse(await privateBytes(mutexPath,security,4096));
      if(!mutexValid(current)||canonical(current)!==canonical(mutex)||current.ownerPid!==process.pid&&await d.isOwnerAlive(current.ownerPid))fail();guard.verify();};
    const verifyOriginal=async(absentAllowed=false)=>{await registration();await verifyMutex();if(await d.isOwnerAlive(original.ownerPid))fail();
      const actual=await maybe(lockPath,security);if(actual===null){if(!absentAllowed)fail();return false;}if(!actual.equals(originalBytes))fail();return true;};
    phase='target';const cdp=transport.cdp,targetId=template.captureDocument.targetId;
    const target=await cdp.send('Target.getTargetInfo',{targetId},{timeoutMs:5000});
    if(target?.targetInfo?.type!=='page'||target.targetInfo.targetId!==targetId)fail();
    if(args.execute!==true)return result=safe('diagnosed',phase,{ownerDeadConfirmed:true,lockScopeMatched:true,retirementCommitted:false});
    if(!mutex){
      const orphan=await maybe(mutexPath,security);
      if(orphan){if(args.resume!==true) return result=safe('resume_required','mutex');mutex=JSON.parse(orphan);if(!mutexValid(mutex)||await d.isOwnerAlive(mutex.ownerPid))fail();}
      else{if(args.resume===true)fail();await d.acquireRecovery(profile,original);mutex=JSON.parse(await privateBytes(mutexPath,security,4096));}
    }
    await verifyOriginal(Boolean(existingProof));await d.checkpoint('mutex_created');
    if(!prepare){
      prepare={version:1,artifactRef:args.artifactRef,parentSourceRef:artifact.sourceRef,artifactSha256:hash(canonical(artifact)),parentSha256:hash(canonical(parent)),
        profile,browserKey:parent.browserKey,originalBase64:originalBytes.toString('base64'),mutex,audit:QUERY_RETIREMENT_AUDIT};
      await publish(paths.prepare,prepare,security);await d.checkpoint('prepare_durable');
    }
    marker.prepareSha256=hash(await privateBytes(paths.prepare,security));
    if(!committed){await verifyOriginal();await publish(paths.commit,marker,security);committed=true;await d.checkpoint('commit_durable');}
    // Tombstone is permanent before any realm reset. Failure never re-enables old evidence.
    await verifyOriginal(Boolean(existingProof));phase='attach';attached=await cdp.send('Target.attachToTarget',{targetId,flatten:true},{timeoutMs:5000});
    if(typeof attached?.sessionId!=='string'||typeof cdp.on!=='function')fail();const opts={sessionId:attached.sessionId,timeoutMs:5000};
    const listen=(name,fn)=>removers.push(cdp.on(name,(p,c)=>{if(c?.sessionId===attached.sessionId)fn(p)}));
    listen('Runtime.executionContextsCleared',()=>{if(existingProof){revisionInvalid=true;return;}if(!navigationSent)return;record('context_clear');if(newFrame||++contextClears>2)revisionInvalid=true;contextDestroyed=true;});
    listen('Runtime.executionContextDestroyed',()=>{if(existingProof||newFrame)revisionInvalid=true;if(navigationSent)record('context_destroy');});
    listen('Page.frameNavigated',p=>{if(p.frame?.parentId)return;if(existingProof){revisionInvalid=true;return;}if(!navigationSent)return;record('main_frame');
      try{const frame=documentOf(p.frame,targetId);if(newFrame||frame.frameId!==oldDocument.frameId||frame.loaderId===oldDocument.loaderId||!surface(frame.fullUrl))fail();newFrame=frame;}
      catch{revisionInvalid=true;}});
    for(const event of ['Page.navigatedWithinDocument','Page.frameDetached','Inspector.detached'])listen(event,()=>{record(event==='Page.navigatedWithinDocument'?'within_document':'detach');revisionInvalid=true;});
    removers.push(cdp.on('Target.detachedFromTarget',p=>{if(p.sessionId===attached.sessionId&&!detachRequested){record('target_detach');revisionInvalid=true;}}));
    await cdp.send('Page.enable',{},opts);await cdp.send('Runtime.enable',{},opts);
    oldDocument=documentOf((await cdp.send('Page.getFrameTree',{},opts))?.frameTree?.frame,targetId);
    if(existingProof){
      phase='resume_scope';
      if(revisionInvalid||oldDocument.frameId!==existingProof.newFrame||oldDocument.loaderId!==existingProof.newLoader
        ||oldDocument.documentUrlDigest!==existingProof.newDocumentDigest||surface(oldDocument.fullUrl)!==existingProof.finalSurface)fail();
      newFrame=oldDocument;oldDocument={targetId,frameId:existingProof.oldFrame,loaderId:existingProof.oldLoader,documentUrlDigest:existingProof.oldDocumentDigest};
      result=safe('realm_reset_verified','resume_scope',{realmDestructionProven:true,finalSurface:existingProof.finalSurface,retirementCommitted:true,resumed:true});
      return result;
    }
    if(revisionInvalid||!queryDocumentValid(oldDocument)&&!surface(oldDocument.fullUrl))fail();
    await verifyOriginal();phase='navigate';started=Date.now();navigationSent=true;
    const nav=await cdp.send('Page.navigate',{url:HOME},opts);
    if(nav?.errorText||nav?.frameId!==oldDocument.frameId)fail();
    phase='wait';await d.wait(12000);phase='scope';
    const current=documentOf((await cdp.send('Page.getFrameTree',{},opts))?.frameTree?.frame,targetId);
    if(revisionInvalid||!contextDestroyed||!newFrame||canonical(current)!==canonical(newFrame)||!surface(current.fullUrl))fail();
    await verifyOriginal();
    result=safe('realm_reset_verified',phase,{realmDestructionProven:true,finalSurface:surface(current.fullUrl),retirementCommitted:true});
  }catch{result=safe('retirement_failed',phase,phase==='resume_scope'?{resumeBlocked:true,manualReviewRequired:true}:{});}
  finally{
    if(attached?.sessionId){
      for(const method of ['Runtime.disable','Page.disable'])try{await transport.cdp.send(method,{}, {sessionId:attached.sessionId,timeoutMs:5000})}catch{cleanup=false;}
      if(result?.status==='realm_reset_verified')try{
        const current=documentOf((await transport.cdp.send('Page.getFrameTree',{}, {sessionId:attached.sessionId,timeoutMs:5000}))?.frameTree?.frame,oldDocument.targetId);
        if(revisionInvalid||canonical(current)!==canonical(newFrame))fail();
      }catch{cleanup=false;}
      try{detachRequested=true;await transport.cdp.send('Target.detachFromTarget',{sessionId:attached.sessionId},{timeoutMs:5000})}catch{cleanup=false;}
    }
    for(const off of removers)try{off()}catch{cleanup=false;}
    try{await transport?.close()}catch{cleanup=false;}
    if(revisionInvalid)cleanup=false;
    if(result?.status==='realm_reset_verified')try{
      phase='retire';if(!cleanup)fail();guard.verify();
      if(await d.isOwnerAlive(original.ownerPid)||await transport.localScope.currentRegistrationState()!=='quarantined')fail();
      const profile=prepare.profile,current=await maybe(join(profile,LOCK),security),actualMutex=JSON.parse(await privateBytes(join(profile,MUTEX),security,4096));
      if(current===null&&!existingProof||current!==null&&!current.equals(originalBytes)||canonical(actualMutex)!==canonical(mutex))fail();
      const proof={version:1,oldDocumentDigest:oldDocument.documentUrlDigest,newDocumentDigest:newFrame.documentUrlDigest,
        oldFrame:oldDocument.frameId,oldLoader:oldDocument.loaderId,newFrame:newFrame.frameId,newLoader:newFrame.loaderId,
        contextDestroyed:true,finalSurface:result.finalSurface,events};
      if(!existingProof){await publish(paths.proof,proof,security);await d.checkpoint('realm_durable');}
      // All old work remains permanently blocked even if the following host crashes.
      const finish={version:1,commitSha256:hash(await privateBytes(paths.commit,security)),realmSha256:hash(await privateBytes(paths.proof,security))};
      if(!finished)await publish(paths.finish,finish,security);finished=true;await d.checkpoint('finished_durable');
      if(await d.isOwnerAlive(original.ownerPid)||await transport.localScope.currentRegistrationState()!=='quarantined')fail();guard.verify();
      const finalLock=await maybe(join(profile,LOCK),security);
      if(finalLock===null&&!existingProof||finalLock!==null&&!finalLock.equals(originalBytes)
        ||canonical(JSON.parse(await privateBytes(join(profile,MUTEX),security,4096)))!==canonical(mutex))fail();
      if(finalLock!==null)await unlink(join(profile,LOCK));result.lockRetired=true;await d.checkpoint('lock_retired');
      await unlink(join(profile,MUTEX));result.status='retired_readonly';result.phase='finished';result.lockRetired=true;
    }catch{result.status='retirement_failed';result.phase=phase;}
    if(paths){try{const bytes=await maybe(paths.commit,security);result.retirementCommitted=bytes===null?false:marker&&canonical(JSON.parse(bytes))===canonical(marker)?true:'unknown';}catch{result.retirementCommitted='unknown';}}
    result??=safe('retirement_failed',phase);result.cleanupConfirmed=cleanup;result.events=events;
    if(finished)result.resumeRequired=!['retired_readonly','historical_retirement_confirmed'].includes(result.status);
    else if(prepare||mutex)result.resumeRequired=true;
    else if(recoveryPath)try{result.resumeRequired=await maybe(recoveryPath,security)!==null}catch{result.resumeRequired='unknown';}
    try{await guard?.close()}catch{result.cleanupConfirmed=false;result.status='retirement_cleanup_failed';}
  }
  return result;
}
