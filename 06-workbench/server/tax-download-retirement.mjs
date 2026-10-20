// Explicit local administrator capability. Never register in HTTP, Agent or MCP.
// Retires only the audited, settled return-to-portal operation. No renderer code,
// identity requests, navigation, domain enable/disable, or browser lifecycle calls.
import {createHash,randomBytes} from 'node:crypto';
import {open,lstat,realpath,link,unlink} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {TaxCollectionStore,readCollectionLock,collectionRecoveryLock} from './tax-collection-local.mjs';
import {TaxHistoryStore} from './tax-history-store.mjs';
import {verifyPrivateFile,verifyPrivateDirectory,openRegisteredBrowserDiagnostic} from './tax-browser-diagnostic.mjs';
import {acquireReadonlyAdminGuard} from './tax-readonly-abandon.mjs';
import {requireActiveSource} from './tax-collection-contract.mjs';
import {canonical,exact,historyRef,validateHistoryRecord,enterpriseOf,sameEnterprise,HISTORY_ORIGIN} from './tax-history-contract.mjs';
import {fullFrameUrl} from './tax-frame-url.mjs';

export const SETTLED_NAVIGATION_HELPER_SHA256='E28F8EC721876B42B5ECEA27AE505114E3F6DC1943AD2AC9A9FE9DBADD16F8AA';
const PORTAL=HISTORY_ORIGIN+'/loginb/',LOCK='YoushuCollectionLockV1.json',RECOVERY='YoushuCollectionRecoveryV1.json';
const fail=()=>new Error('tax_download_retirement_refused');
const hash=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>hash(canonical(value));
const validPid=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const mutexShape=v=>{
  if(!exact(v,['version','nonce','ownerPid'])||v.version!==1||!validPid(v.ownerPid)||!/^[a-f0-9]{48}$/.test(v.nonce||''))throw fail();return v;
};
function lockShape(v,parentSourceRef,contextRef){
  if(!exact(v,['version','nonce','ownerPid','scope'])||v.version!==1||!validPid(v.ownerPid)||!/^[a-f0-9]{48}$/.test(v.nonce||'')
    ||!exact(v.scope,['operation','parentSourceRef','contextRef'])||v.scope.operation!=='download_return_to_portal'
    ||v.scope.parentSourceRef!==parentSourceRef||v.scope.contextRef!==contextRef)throw fail();return v;
}
async function ownerAlive(pid){try{process.kill(pid,0);return true}catch(e){if(e.code==='ESRCH')return false;throw fail();}}
async function directory(path,d){
  let cursor=resolve(path);
  for(;;){const s=await lstat(cursor);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(cursor)!==cursor)throw fail();
    const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
  await d.verifyDirectory(path);
}
async function read(path,d,max=65536){
  await directory(dirname(path),d);const before=await lstat(path);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>max||await realpath(path)!==resolve(path))throw fail();
  await d.verifyFile(path);const handle=await open(path,'r');
  try{
    const info=await handle.stat();if(info.ino!==before.ino||info.dev!==before.dev||info.nlink!==1||info.size>max)throw fail();
    const bytes=Buffer.alloc(max+1),{bytesRead}=await handle.read(bytes,0,bytes.length,0),after=await handle.stat(),current=await lstat(path);
    if(bytesRead>max||bytesRead!==info.size||after.size!==info.size||after.nlink!==1||after.mtimeMs!==info.mtimeMs||after.ctimeMs!==info.ctimeMs
      ||after.ino!==current.ino||after.dev!==current.dev||!current.isFile()||current.nlink!==1||current.isSymbolicLink())throw fail();
    await d.verifyFile(path);return bytes.subarray(0,bytesRead);
  }finally{await handle.close();}
}
async function maybe(path,d){try{return await read(path,d)}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function durable(path,bytes,d){
  bytes=Buffer.from(bytes);if(bytes.length>65536)throw fail();await directory(dirname(path),d);
  const staging=path+'.'+randomBytes(16).toString('hex')+'.tmp';
  try{
    const h=await open(staging,'wx',0o600);try{await h.writeFile(bytes);await h.sync()}finally{await h.close()}
    if(!(await read(staging,d)).equals(bytes))throw fail();
    await link(staging,path);await unlink(staging);
    // Both private read and nlink=1 verification run after unlinking staging.
    const published=await open(path,'r+');try{await published.sync()}finally{await published.close()}
    if(!(await read(path,d)).equals(bytes))throw fail();
  }finally{await unlink(staging).catch(()=>{});}
}
function attestation(value,contextRef,templateRef,parentSourceRef){
  if(!exact(value,['version','operatorAttested','loadedBytesProof','helperSha256','contextRef','templateRef','parentSourceRef','ownerPid','originalLockSha256','result'])
    ||value.version!==1||value.operatorAttested!==true||value.loadedBytesProof!==false||value.helperSha256!==SETTLED_NAVIGATION_HELPER_SHA256
    ||value.contextRef!==contextRef||value.templateRef!==templateRef||value.parentSourceRef!==parentSourceRef||!validPid(value.ownerPid)
    ||!/^[a-f0-9]{64}$/.test(value.originalLockSha256||''))throw fail();
  const expected={status:'portal_return_failed',phase:'cleanup',reason:'cleanup_unconfirmed',operationSettled:true,
    requestAttemptedCount:2,requestPerformedCount:2,responseCompleteCount:2,requestPerformedUnknownCount:0,requestNotPerformedCount:0,
    navigationAttemptedCount:1,navigationConfirmedCount:1,identityProjectionMatched:true,bootstrapContextClearCount:2};
  if(canonical(value.result)!==canonical(expected))throw fail();return structuredClone(value);
}
const result=(status,phase,extra={})=>({status,phase,lockRetired:false,abandonedStateCommitted:false,cleanupConfirmed:false,
  adminGuardUnconfirmed:false,
  auditTrust:'operator_attested_not_loaded_bytes_proof',requestTermination:'unknown',realmDestructionProven:false,
  lateSessionEffectsPossible:true,oldResultConsumption:'not_retired',newSourceRequired:true,newDocumentScopeRequired:true,
  newIdentityVerificationRequired:true,downstreamReady:false,...extra});

export class TaxDownloadRetirement{
  constructor(overrides={}){
    this.d={store:new TaxHistoryStore(),parentStore:new TaxCollectionStore(),openDiagnostic:openRegisteredBrowserDiagnostic,
      readLock:readCollectionLock,acquireRecovery:collectionRecoveryLock,acquireAdminGuard:acquireReadonlyAdminGuard,
      isOwnerAlive:ownerAlive,verifyFile:verifyPrivateFile,verifyDirectory:verifyPrivateDirectory,
      // Only trusted local administrator configuration supplies this record.
      // No proof, URL, path, PID or request body is accepted from action args.
      trustedAttestation:null,checkpoint:async()=>{},...overrides};
  }
  async retire(args={}){
    const d=this.d;let phase='validation',transport,guard,attached,mutex,original,expected,paths,prepare,proof,recoveryPath,marker;
    let committed=false,retired=false,finished=false,recoveryPresent=false,recoveryBindingVerified=false,detachConfirmed=true,transportClosed=false,guardClosed=false;
    let recoveryRetired=false,adminGuardUnconfirmed=false;
    let output;
    const cleanupTransport=async()=>{
      let failed=false;
      if(attached){try{detachConfirmed=false;await transport.cdp.send('Target.detachFromTarget',{sessionId:attached},{timeoutMs:5000});attached=null;detachConfirmed=true;}catch{failed=true;}}
      if(transport&&!transportClosed){try{await transport.close();transportClosed=true;}catch{failed=true;}}
      if(failed)throw fail();
    };
    const cleanupGuard=async()=>{if(guard&&!guardClosed){try{await guard.close();guardClosed=true;}catch{adminGuardUnconfirmed=true;throw fail();}}};
    try{
      if(!args||typeof args!=='object'||Array.isArray(args)||!Object.hasOwn(args,'contextRef')||!historyRef(args.contextRef,'context')
        ||Object.keys(args).some(k=>!['contextRef','execute','resume'].includes(k))
        ||args.execute!==undefined&&typeof args.execute!=='boolean'||args.resume!==undefined&&typeof args.resume!=='boolean'
        ||args.resume===true&&args.execute!==true)throw fail();
      phase='binding';
      const context=validateHistoryRecord('context',await d.store.load(args.contextRef));
      const template=validateHistoryRecord('template',await d.store.load(context.templateRef));
      const parent=requireActiveSource(await d.parentStore.load(template.parentSourceRef));
      if(template.capturedAt>context.createdAt||parent.capturedAt>template.capturedAt||!sameEnterprise(context.enterprise,template.enterprise)
        ||!sameEnterprise(enterpriseOf(parent.identity.projection),template.enterprise)||context.replayDocument.targetId!==template.captureDocument.targetId
        ||parent.targetId!==template.captureDocument.targetId||parent.registrationRef!==template.registrationRef
        ||parent.registrationRoot!==template.registrationRoot||parent.browserKey!==template.browserKey
        ||canonical(parent.identity.recipe)!==canonical(template.identityRecipe))throw fail();
      phase='attestation';proof=attestation(d.trustedAttestation,args.contextRef,context.templateRef,template.parentSourceRef);
      await d.parentStore.ready();await directory(d.parentStore.root,d);
      const base=join(d.parentStore.root,'abandon_'+template.parentSourceRef);
      paths={archive:base+'.download.lock.bin',prepare:base+'.download.prepare.json',commit:base+'.commit.json',finished:base+'.download.finished.json'};
      const binding={contextRef:args.contextRef,templateRef:context.templateRef,parentSourceRef:template.parentSourceRef,
        contextDigest:digest(context),templateDigest:digest(template),parentDigest:digest(parent)};
      phase='registration';
      transport=await d.openDiagnostic({registrationRef:template.registrationRef,registrationRoot:template.registrationRoot},
        {registrationBase:dirname(resolve(template.registrationRoot))});
      const local=transport.localScope;
      if(local?.registrationState!=='quarantined'||local.browserKey!==template.browserKey)throw fail();
      const profile=local.profilePath;await directory(profile,d);
      if(args.execute===true){guard=await d.acquireAdminGuard(profile);guard.verify();}
      const verifyRegistration=async()=>{
        guard?.verify();if(local.browserKey!==template.browserKey||local.registrationState!=='quarantined'
          ||await local.currentRegistrationState()!=='quarantined')throw fail();guard?.verify();
      };
      await verifyRegistration();
      const lockPath=join(profile,LOCK);recoveryPath=join(profile,RECOVERY);
      phase='journal';const prepareBytes=await maybe(paths.prepare,d),commitBytes=await maybe(paths.commit,d),finishedBytes=await maybe(paths.finished,d);
      if(prepareBytes){
        if(args.resume!==true)throw fail();prepare=JSON.parse(prepareBytes);
        if(!exact(prepare,['version','state','binding','browserKey','profilePath','originalSha256','mutex','attestation'])
          ||prepare.version!==1||prepare.state!=='prepared_settled_portal_retirement'||canonical(prepare.binding)!==canonical(binding)
          ||prepare.browserKey!==template.browserKey||prepare.profilePath!==profile||canonical(prepare.attestation)!==canonical(proof))throw fail();
        mutex=mutexShape(prepare.mutex);original=await read(paths.archive,d);if(hash(original)!==prepare.originalSha256)throw fail();
        expected=lockShape(JSON.parse(original),template.parentSourceRef,args.contextRef);
        marker={version:1,state:'abandoned_settled_portal',prepareSha256:hash(prepareBytes),oldResultConsumption:'permanently_forbidden',
          forbiddenScope:'parent_context_template_and_runs',requestTermination:'unknown',realmDestructionProven:false};
        if(commitBytes){if(canonical(JSON.parse(commitBytes))!==canonical(marker))throw fail();committed=true;}
        if(finishedBytes){if(!committed||canonical(JSON.parse(finishedBytes))!==canonical({version:1,state:'finished',commitSha256:hash(commitBytes)}))throw fail();finished=true;}
      }else if(commitBytes||finishedBytes)throw fail();
      const recoveryBytes=await maybe(recoveryPath,d);recoveryPresent=recoveryBytes!==null;
      if(finished&&!recoveryPresent){
        // A later collector may have a new lock: completed retries never inspect,
        // remove, or adopt it. This immutable journal is the only completed claim.
        recoveryRetired=true;retired=true;await cleanupTransport();phase='admin_cleanup';await cleanupGuard();
        return result('portal_retired_locally','finished',{lockRetired:true,abandonedStateCommitted:true,cleanupConfirmed:true,
          oldResultConsumption:'permanently_forbidden',resumed:true,alreadyFinished:true});
      }
      phase='lock';
      if(!expected){expected=lockShape(await d.readLock(profile),template.parentSourceRef,args.contextRef);
        original=await read(lockPath,d);if(canonical(JSON.parse(original))!==canonical(expected))throw fail();}
      if(expected.ownerPid!==proof.ownerPid||hash(original)!==proof.originalLockSha256||await d.isOwnerAlive(expected.ownerPid))throw fail();
      if(recoveryBytes){
        // The generic recovery creator publishes its random nonce before it
        // returns. A crash before our prepare is durable leaves no trustworthy
        // binding to that nonce. Refuse this gap; never adopt an unknown orphan.
        if(args.resume!==true||!prepare)throw fail();const actual=mutexShape(JSON.parse(recoveryBytes));
        if(mutex&&canonical(actual)!==canonical(mutex)||actual.ownerPid!==process.pid&&await d.isOwnerAlive(actual.ownerPid))throw fail();mutex=actual;recoveryBindingVerified=true;
      }else if(prepare||args.resume===true)throw fail();
      const verifyMutex=async()=>{
        if(!mutex)throw fail();const actual=mutexShape(JSON.parse(await read(recoveryPath,d)));
        if(canonical(actual)!==canonical(mutex)||actual.ownerPid!==process.pid&&await d.isOwnerAlive(actual.ownerPid))throw fail();guard?.verify();
      };
      const verifyOriginal=async(absentAllowed=false)=>{
        await verifyRegistration();if(await d.isOwnerAlive(expected.ownerPid))throw fail();if(mutex)await verifyMutex();
        const bytes=await maybe(lockPath,d);if(bytes===null){if(!absentAllowed)throw fail();return false;}
        lockShape(JSON.parse(bytes),template.parentSourceRef,args.contextRef);if(!bytes.equals(original))throw fail();return true;
      };
      await verifyOriginal(committed);
      if(args.execute===true&&!mutex){
        phase='recovery';await d.acquireRecovery(profile,expected);recoveryPresent=true;
        mutex=mutexShape(JSON.parse(await read(recoveryPath,d)));if(mutex.ownerPid!==process.pid)throw fail();
        await d.checkpoint('recovery_created');await verifyOriginal();
      }
      phase='portal';const targetId=template.captureDocument.targetId;
      const inventory=async()=>{
        const list=await transport.cdp.send('Target.getTargets',{filter:[{}]},{timeoutMs:5000});
        if(!Array.isArray(list?.targetInfos)||list.targetInfos.length>10000)throw fail();
        const matches=list.targetInfos.filter(t=>t?.targetId===targetId);
        if(matches.length!==1||matches[0].type!=='page'||matches[0].url!==PORTAL)throw fail();
      };
      await inventory();detachConfirmed=false;const session=await transport.cdp.send('Target.attachToTarget',{targetId,flatten:true},{timeoutMs:5000});
      if(typeof session?.sessionId!=='string'||!session.sessionId||session.sessionId.length>256)throw fail();attached=session.sessionId;
      const document=async()=>{
        const response=await transport.cdp.send('Page.getFrameTree',{}, {sessionId:attached,timeoutMs:5000}),frame=response?.frameTree?.frame;
        if(!frame||Object.hasOwn(frame,'parentId')||!['id','loaderId'].every(k=>typeof frame[k]==='string'&&frame[k].length>0&&frame[k].length<=256)
          ||frame.id!==context.replayDocument.frameId||frame.loaderId===context.replayDocument.loaderId||fullFrameUrl(frame)!==PORTAL)throw fail();
        return {targetId,frameId:frame.id,loaderId:frame.loaderId,fullUrl:fullFrameUrl(frame)};
      };
      const before=await document();await d.checkpoint('portal_read_once');await verifyOriginal(committed);await inventory();
      if(canonical(before)!==canonical(await document()))throw fail();await verifyOriginal(committed);
      if(args.execute!==true){await cleanupTransport();return result('portal_retirement_diagnosed',phase,{cleanupConfirmed:true,
        portalReadCount:2,operatorAttestationRequired:true,executionRequired:true});}
      if(!prepare){
        phase='prepare';const archive=await maybe(paths.archive,d);
        if(archive){if(!archive.equals(original))throw fail()}else await durable(paths.archive,original,d);
        await d.checkpoint('archive_durable');await verifyOriginal();
        prepare={version:1,state:'prepared_settled_portal_retirement',binding,browserKey:template.browserKey,profilePath:profile,
          originalSha256:hash(original),mutex,attestation:proof};
        await durable(paths.prepare,JSON.stringify(prepare),d);recoveryBindingVerified=true;await d.checkpoint('prepare_durable');
      }
      phase='commit';const actualPrepare=await read(paths.prepare,d);if(canonical(JSON.parse(actualPrepare))!==canonical(prepare))throw fail();
      if(!committed){
        await verifyOriginal();marker={version:1,state:'abandoned_settled_portal',prepareSha256:hash(actualPrepare),oldResultConsumption:'permanently_forbidden',
          forbiddenScope:'parent_context_template_and_runs',requestTermination:'unknown',realmDestructionProven:false};
        await durable(paths.commit,JSON.stringify(marker),d);committed=true;await d.checkpoint('commit_durable');
      }
      // Prove the permanent guard is consumed by the actual parent store.
      const verifyCommitted=async()=>{const bytes=await read(paths.commit,d);if(canonical(JSON.parse(bytes))!==canonical(marker))throw fail();return bytes;};
      await verifyCommitted();let blocked=false;try{await d.parentStore.assertNotAbandoned(template.parentSourceRef)}catch{blocked=true}if(!blocked)throw fail();
      phase='transport_cleanup';await cleanupTransport();await d.checkpoint('transport_closed');
      phase='retire';if(await verifyOriginal(true)){await d.checkpoint('before_retire');await verifyCommitted();await verifyOriginal();await unlink(lockPath);}
      retired=true;await d.checkpoint('lock_retired');
      const actualCommit=await verifyCommitted();
      if(!finished){await durable(paths.finished,JSON.stringify({version:1,state:'finished',commitSha256:hash(actualCommit)}),d);finished=true;}
      await d.checkpoint('finished_durable');await verifyMutex();await verifyRegistration();
      // Keep OS administrator exclusion through exact recovery retirement. A
      // later resume/collector must never replace this path between read/unlink.
      phase='recovery_cleanup';
      const actual=await read(recoveryPath,d);if(canonical(JSON.parse(actual))!==canonical(mutex)||await maybe(lockPath,d)!==null)throw fail();
      await d.checkpoint('before_recovery_retire');await verifyMutex();guard.verify();
      await unlink(recoveryPath);recoveryPresent=false;recoveryRetired=true;
      await d.checkpoint('recovery_retired');
      phase='admin_cleanup';await cleanupGuard();await d.checkpoint('guard_closed');
      return result('portal_retired_locally','finished',{lockRetired:true,abandonedStateCommitted:true,cleanupConfirmed:true,
        oldResultConsumption:'permanently_forbidden',portalReadCount:2,resumed:args.resume===true});
    }catch{
      // A publish may have succeeded before its readback/ACL await failed.
      // Do not infer absence or success from in-memory stage flags alone.
      let commitState=committed?true:'unknown';if(paths)try{
        const bytes=await maybe(paths.commit,d);commitState=bytes===null?false:marker&&canonical(JSON.parse(bytes))===canonical(marker)?true:'unknown';
      }catch{commitState='unknown'}
      // Once our exact recovery was removed, a later path occupant belongs to
      // another operation. Do not inspect/adopt it or claim our exclusion remains.
      if(recoveryPath&&!recoveryRetired)try{recoveryPresent=await maybe(recoveryPath,d)!==null}catch{recoveryPresent='unknown'}
      output=result(recoveryPresent||committed?'portal_retirement_partial':'portal_retirement_refused',phase,
        {lockRetired:retired,abandonedStateCommitted:commitState,recoveryRetained:recoveryPresent,resumeRequired:recoveryPresent||adminGuardUnconfirmed,
          adminGuardUnconfirmed,
          recoveryBindingVerified,manualRecoveryEvidenceRequired:recoveryPresent!==false&&!recoveryBindingVerified,
          oldResultConsumption:commitState===true?'permanently_forbidden':'unknown'});
      return output;
    }finally{
      let cleaned=true;
      try{await cleanupTransport()}catch{cleaned=false}
      try{await cleanupGuard()}catch{cleaned=false}
      if(output){output.adminGuardUnconfirmed=adminGuardUnconfirmed;output.cleanupConfirmed=cleaned&&detachConfirmed&&!adminGuardUnconfirmed;output.recoveryRetained=recoveryPresent;}
    }
  }
}
