// Explicit local administration for one abandoned authorized-navigation lock.
// Does not alter the legacy reader registration, claim or quarantine, or kill anything.
import {execFile} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openRegisteredBrowserDiagnostic} from '../server/tax-browser-diagnostic.mjs';
import {readCollectionLock,collectionRecoveryLock} from '../server/tax-collection-local.mjs';
import {classifyObservedUrl,pageReference} from './inventory-tax-browser.mjs';

async function processAlive(pid){
  if(!Number.isSafeInteger(pid)||pid<=0||process.platform!=='win32')throw new Error('invalid');
  const script=`$ErrorActionPreference='Stop'
$item=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:TAX_COLLECTION_CHECK_PID)
if($null -eq $item){[Console]::Write('dead')}else{[Console]::Write('alive')}`;
  const answer=await new Promise((yes,no)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {shell:false,windowsHide:true,timeout:10000,maxBuffer:1024,env:{...process.env,TAX_COLLECTION_CHECK_PID:String(pid)}},
    (error,stdout)=>error?no(new Error('failed')):yes(String(stdout))));
  if(!['dead','alive'].includes(answer))throw new Error('failed');return answer==='alive';
}
export async function recoverTaxCollectionLock({registrationRef,registrationRoot,pageRef,execute=false}={},overrides={}){
  const d={openDiagnostic:openRegisteredBrowserDiagnostic,readLock:readCollectionLock,acquireRecovery:collectionRecoveryLock,
    isOwnerAlive:processAlive,wait:ms=>new Promise(done=>setTimeout(done,ms)),...overrides};
  let transport,attached,recovery,original,phase='validation',reloadSent=false,ownerDeadConfirmed=false,loaderChanged=false,
    contextDestroyed=false,cleanupConfirmed=true,finalResult,readyResolve;
  const remove=[],events=[];let startedAt=0,oldFrame,oldLoader,newLoader;
  const fixed=()=>({phase,reloadSent,ownerDeadConfirmed,loaderChanged,contextDestroyed,oldLockReleased:false,
    registrationChanged:false,browserClosed:false,scopeVerified:false,events:events.map(e=>({...e}))});
  const record=(kind,extra={})=>{if(events.length<128)events.push({order:events.length+1,kind,
    elapsedMs:Math.max(0,Date.now()-startedAt),...extra})};
  const ready=()=>{if(contextDestroyed&&newLoader)readyResolve?.()};
  try{
    if(!/^taxr_[a-f0-9]{48}$/.test(registrationRef||'')||!/^taxpage_[a-f0-9]{48}$/.test(pageRef||'')||typeof execute!=='boolean')throw new Error('input');
    phase='open';transport=await d.openDiagnostic({registrationRef,registrationRoot},registrationRoot?{registrationBase:dirname(resolve(registrationRoot))}:{});
    const local=transport.localScope;
    if(local?.registrationState!=='quarantined'||await local.currentRegistrationState()!=='quarantined')throw new Error('state');
    phase='read_lock';original=await d.readLock(local.profilePath);
    const scope=original.scope;
    if(Object.keys(scope).length!==3||scope.operation!=='authorized_navigation'||scope.registrationRef!==registrationRef||scope.pageRef!==pageRef)throw new Error('unsupported_lock');
    phase='owner_check';if(await d.isOwnerAlive(original.ownerPid))return finalResult={status:'owner_alive',...fixed()};ownerDeadConfirmed=true;
    const cdp=transport.cdp;
    const targets=async()=>{
      const list=await cdp.send('Target.getTargets',{}, {timeoutMs:5000});
      if(!Array.isArray(list?.targetInfos)||list.targetInfos.length>10000)throw new Error('targets');
      const official=list.targetInfos.filter(t=>t.type==='page'&&classifyObservedUrl(t.url));
      const selected=official.filter(t=>typeof t.targetId==='string'&&classifyObservedUrl(t.url)?.routeCode==='portal_home'
        &&pageReference(registrationRef,t.targetId)===pageRef);
      if(official.length!==1||selected.length!==1)throw new Error('ambiguous');return selected[0];
    };
    phase='targets';const target=await targets();
    if(!execute)return finalResult={status:'diagnosed',diagnosticAvailable:false,lockScopeMatched:true,uniqueHome:true,...fixed()};
    phase='recovery_mutex';recovery=await d.acquireRecovery(local.profilePath,original);
    await recovery.verifyOriginal();if(await d.isOwnerAlive(original.ownerPid))throw new Error('owner_alive');
    phase='attach';attached=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true},{timeoutMs:5000});
    if(typeof attached?.sessionId!=='string')throw new Error('attach');
    const opts={sessionId:attached.sessionId,timeoutMs:5000};
    const listen=(method,fn)=>remove.push(cdp.on(method,(p,c)=>{if(c?.sessionId===attached.sessionId)fn(p)}));
    listen('Runtime.executionContextsCleared',()=>{if(!reloadSent)return;contextDestroyed=true;record('context_clear');ready()});
    listen('Runtime.executionContextDestroyed',()=>{if(reloadSent)record('context_destroy')});
    listen('Page.frameNavigated',p=>{if(!reloadSent||p.frame?.parentId)return;
      const matched=p.frame?.id===oldFrame&&typeof p.frame?.loaderId==='string'&&p.frame.loaderId!==oldLoader
        &&classifyObservedUrl(p.frame.url)?.routeCode==='portal_home';
      record('initial_frame',{newLoader:matched});if(matched){newLoader=p.frame.loaderId;ready()}});
    listen('Page.navigatedWithinDocument',p=>{if(reloadSent&&p.frameId===oldFrame)record('within_document')});
    listen('Page.frameDetached',p=>{if(reloadSent&&p.frameId===oldFrame)record('frame_detach')});
    await cdp.send('Page.enable',{},opts);await cdp.send('Runtime.enable',{},opts);
    const before=await cdp.send('Page.getFrameTree',{},opts),frame=before?.frameTree?.frame;
    if(typeof frame?.id!=='string'||typeof frame?.loaderId!=='string'||classifyObservedUrl(frame.url)?.routeCode!=='portal_home')throw new Error('before_scope');
    oldFrame=frame.id;oldLoader=frame.loaderId;
    phase='reload';startedAt=Date.now();reloadSent=true;
    const signal=new Promise(done=>{readyResolve=done});
    await cdp.send('Page.reload',{},opts);
    phase='wait';await Promise.race([signal,d.wait(12000)]);
    phase='verify_scope';const after=await cdp.send('Page.getFrameTree',{},opts),current=after?.frameTree?.frame;
    if(!contextDestroyed||!newLoader||current?.id!==oldFrame||current?.loaderId!==newLoader
      ||classifyObservedUrl(current.url)?.routeCode!=='portal_home'||(await targets()).targetId!==target.targetId)throw new Error('after_scope');
    loaderChanged=true;
    if(await local.currentRegistrationState()!=='quarantined')throw new Error('state');
    phase='cleanup';finalResult={status:'reload_verified',...fixed()};
  }catch{return finalResult={status:'recovery_failed',...fixed()};}
  finally{
    if(attached?.sessionId){
      for(const method of ['Runtime.disable','Page.disable'])try{await transport.cdp.send(method,{}, {sessionId:attached.sessionId,timeoutMs:5000})}catch{cleanupConfirmed=false}
      try{await transport.cdp.send('Target.detachFromTarget',{sessionId:attached.sessionId},{timeoutMs:5000})}catch{cleanupConfirmed=false}
    }
    for(const off of remove)try{off()}catch{cleanupConfirmed=false}
    try{transport?.close()}catch{cleanupConfirmed=false}
    if(finalResult?.status==='reload_verified'){
      try{
        if(!cleanupConfirmed||await d.isOwnerAlive(original.ownerPid))throw new Error('cleanup');
        await recovery.verifyOriginal();await recovery.releaseOriginal();finalResult.status='recovered';finalResult.oldLockReleased=true;finalResult.phase='complete';
      }catch{finalResult.status='recovery_failed';finalResult.phase='release_validation';}
    }
    if(recovery)try{await recovery.close()}catch{if(finalResult){finalResult.status='recovery_failed';finalResult.phase='mutex_cleanup';}}
    if(finalResult){finalResult.cleanupConfirmed=cleanupConfirmed;finalResult.events=events.map(e=>({...e}));}
  }
  return finalResult;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const a=process.argv.slice(2);
  if(![6,7].includes(a.length)||a[0]!=='--registration-ref'||a[2]!=='--registration-root'||a[4]!=='--page-ref'
    ||a.length===7&&a[6]!=='--reload-and-release'){
    console.error('usage: node scripts/recover-tax-collection-lock.mjs --registration-ref <local-ref> --registration-root <local-directory> --page-ref <safe-ref> [--reload-and-release]');process.exitCode=1;
  }else{const result=await recoverTaxCollectionLock({registrationRef:a[1],registrationRoot:a[3],pageRef:a[5],execute:a.length===7});
    console.log(JSON.stringify(result));if(!['diagnosed','recovered'].includes(result.status))process.exitCode=1;}
}
