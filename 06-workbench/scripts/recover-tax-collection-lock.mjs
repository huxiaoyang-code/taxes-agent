// 针对一个已遗弃的授权导航锁执行显式本机管理操作。
// 不修改旧读取器登记、声明或隔离状态，也不终止任何进程。
import {execFile} from 'node:child_process';
import {dirname,resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {open,lstat,readFile} from 'node:fs/promises';
import {openRegisteredBrowserDiagnostic,verifyPrivateFile} from '../server/tax-browser-diagnostic.mjs';
import {readCollectionLock,collectionRecoveryLock,TaxCollectionStore} from '../server/tax-collection-local.mjs';
import {acquireReadonlyAdminGuard} from '../server/tax-readonly-abandon.mjs';
import {fullFrameUrl} from '../server/tax-frame-url.mjs';
import {pageReference} from './inventory-tax-browser.mjs';

const PORTAL='https://etax.fujian.chinatax.gov.cn:8443/loginb/';
// 在已有保护且被 Git 忽略的证据根目录中保存不可变私有快照。
// 诊断模式绝不调用此写入器或创建其目录。
async function privateAudit(value){
  const store=new TaxCollectionStore();await store.ready();
  const file=join(store.root,'navigation_recovery_'+randomBytes(24).toString('hex')+'.json');
  const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>65536)throw Error('audit');
  const handle=await open(file,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  await verifyPrivateFile(file);const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||!(await readFile(file)).equals(bytes))throw Error('audit');
}

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
export async function recoverTaxCollectionLock(args={},overrides={}){
  const {registrationRef,registrationRoot,pageRef,execute=false}=args||{};
  const d={openDiagnostic:openRegisteredBrowserDiagnostic,readLock:readCollectionLock,acquireRecovery:collectionRecoveryLock,
    acquireAdminGuard:acquireReadonlyAdminGuard,audit:privateAudit,isOwnerAlive:processAlive,wait:ms=>new Promise(done=>setTimeout(done,ms)),...overrides};
  let transport,attached,recovery,guard,original,phase='validation',reloadSent=false,ownerDeadConfirmed=false,loaderChanged=false,
    contextDestroyed=false,cleanupConfirmed=true,finalResult,attachUnknown=false,recoveryAcquiring=false,recoveryRetained=false,
    oldLockReleased=false,guardClosed=false,adminGuardUnconfirmed=false,detachRequested=false,unexpected=false,sealed=false,revision=0,auditConfirmed=false,finalGuard;
  const remove=[],events=[],oldContexts=new Set(),destroyedContexts=new Set();
  const auditOperation=randomBytes(24).toString('hex');let startedAt=0,oldFrame,oldLoader,newDocument,latestPortal,oldFrameDetached=false;
  const fixed=()=>({phase,reloadSent,ownerDeadConfirmed,loaderChanged,contextDestroyed,oldLockReleased:false,
    registrationChanged:false,browserClosed:false,scopeVerified:false,events:events.map(e=>({...e}))});
  const record=(kind,extra={})=>{revision++;if(sealed)unexpected=true;
    if(events.length<128)events.push({order:events.length+1,kind,elapsedMs:Math.max(0,Date.now()-startedAt),...extra});else unexpected=true;};
  const audit=async state=>{auditConfirmed=false;await d.audit({version:1,operation:'authorized_navigation_recovery',auditOperation,state,
    registrationRef,pageRef,original,oldFrame,oldLoader,newDocument,events:events.map(e=>({...e})),oldLockReleased,recoveryRetained,
    requestTermination:'unknown',sourceCreated:false});auditConfirmed=true;};
  const closeGuard=async()=>{if(guard&&!guardClosed)try{await guard.close();guardClosed=true;}catch{adminGuardUnconfirmed=true;throw Error('guard');}};
  try{
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['registrationRef','registrationRoot','pageRef','execute'].includes(k))
      ||!/^taxr_[a-f0-9]{48}$/.test(registrationRef||'')||!/^taxpage_[a-f0-9]{48}$/.test(pageRef||'')||typeof execute!=='boolean')throw new Error('input');
    phase='open';transport=await d.openDiagnostic({registrationRef,registrationRoot},registrationRoot?{registrationBase:dirname(resolve(registrationRoot))}:{});
    const local=transport.localScope;
    if(local?.registrationState!=='quarantined'||await local.currentRegistrationState()!=='quarantined')throw new Error('state');
    phase='read_lock';original=await d.readLock(local.profilePath);
    const scope=original.scope;
    if(Object.keys(original).length!==4||original.version!==1||!/^[a-f0-9]{48}$/.test(original.nonce||'')
      ||!Number.isSafeInteger(original.ownerPid)||original.ownerPid<=0||original.ownerPid>2147483647
      ||!scope||typeof scope!=='object'||Array.isArray(scope)||Object.keys(scope).length!==3
      ||scope.operation!=='authorized_navigation'||scope.registrationRef!==registrationRef||scope.pageRef!==pageRef)throw new Error('unsupported_lock');
    phase='owner_check';if(await d.isOwnerAlive(original.ownerPid))return finalResult={status:'owner_alive',...fixed()};ownerDeadConfirmed=true;
    const cdp=transport.cdp;
    const targets=async()=>{
      const list=await cdp.send('Target.getTargets',{}, {timeoutMs:5000});
      if(!Array.isArray(list?.targetInfos)||list.targetInfos.length>10000)throw new Error('targets');
      const selected=list.targetInfos.filter(t=>t?.type==='page'&&typeof t.targetId==='string'&&pageReference(registrationRef,t.targetId)===pageRef);
      if(selected.length!==1||selected[0].url!==PORTAL)throw new Error('ambiguous');return selected[0];
    };
    phase='targets';const target=await targets();
    if(!execute)return finalResult={status:'diagnosed',diagnosticAvailable:false,lockScopeMatched:true,uniqueHome:true,...fixed()};
    phase='admin_guard';guard=await d.acquireAdminGuard(local.profilePath);guard.verify();
    phase='recovery_mutex';recoveryAcquiring=true;recovery=await d.acquireRecovery(local.profilePath,original);recoveryAcquiring=false;recoveryRetained=true;
    await recovery.verifyOriginal();if(await d.isOwnerAlive(original.ownerPid))throw new Error('owner_alive');
    await audit('exclusion_acquired');
    phase='attach';attachUnknown=true;attached=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true},{timeoutMs:5000});
    if(typeof attached?.sessionId!=='string'||!attached.sessionId||attached.sessionId.length>256)throw new Error('attach');attachUnknown=false;
    const opts={sessionId:attached.sessionId,timeoutMs:5000};
    const listen=(method,fn)=>remove.push(cdp.on(method,(p,c)=>{if(c?.sessionId===attached.sessionId)fn(p)}));
    listen('Runtime.executionContextCreated',p=>{if(!reloadSent){
      if(!Number.isSafeInteger(p.context?.id)||p.context.id<=0||oldContexts.size>=1024)unexpected=true;else oldContexts.add(p.context.id);}});
    listen('Runtime.executionContextsCleared',()=>{if(reloadSent){contextDestroyed=true;record('context_clear');}});
    listen('Runtime.executionContextDestroyed',p=>{if(reloadSent){record('context_destroy');
      if(oldContexts.has(p.executionContextId))destroyedContexts.add(p.executionContextId);
      if(oldContexts.size>0&&destroyedContexts.size===oldContexts.size)contextDestroyed=true;}});
    listen('Page.frameNavigated',p=>{if(!reloadSent||Object.hasOwn(p.frame||{},'parentId'))return;
      let portal=false;try{portal=fullFrameUrl(p.frame)===PORTAL;}catch{}
      record('main_frame',{portal,newLoader:typeof p.frame?.loaderId==='string'&&p.frame.loaderId!==oldLoader});
      latestPortal=portal?{frameId:p.frame.id,loaderId:p.frame.loaderId,fullUrl:PORTAL}:null;});
    listen('Page.navigatedWithinDocument',p=>{if(reloadSent&&(p.frameId===oldFrame||p.frameId===latestPortal?.frameId))record('within_document');});
    listen('Page.frameDetached',p=>{if(reloadSent&&(p.frameId===oldFrame||p.frameId===latestPortal?.frameId)){oldFrameDetached||=p.frameId===oldFrame;record('frame_detach');}});
    listen('Inspector.detached',()=>{if(!detachRequested)unexpected=true;});
    remove.push(cdp.on('Target.detachedFromTarget',p=>{if(p.sessionId===attached.sessionId&&!detachRequested)unexpected=true;}));
    remove.push(cdp.on('closed',()=>{unexpected=true;}));
    await cdp.send('Page.enable',{},opts);await cdp.send('Runtime.enable',{},opts);
    const before=await cdp.send('Page.getFrameTree',{},opts),frame=before?.frameTree?.frame;
    if(!frame||Object.hasOwn(frame,'parentId')||typeof frame.id!=='string'||!frame.id||frame.id.length>256
      ||typeof frame.loaderId!=='string'||!frame.loaderId||frame.loaderId.length>256||fullFrameUrl(frame)!==PORTAL)throw new Error('before_scope');
    oldFrame=frame.id;oldLoader=frame.loaderId;
    const verifiedDocument=async()=>{
      guard.verify();await recovery.verifyOriginal();
      if(unexpected||await local.currentRegistrationState()!=='quarantined'||(await targets()).targetId!==target.targetId)throw Error('scope');
      const value=(await cdp.send('Page.getFrameTree',{},opts))?.frameTree?.frame;
      if(!value||Object.hasOwn(value,'parentId')||typeof value.id!=='string'||!value.id||value.id.length>256
        ||typeof value.loaderId!=='string'||!value.loaderId||value.loaderId.length>256||value.loaderId===oldLoader
        ||value.id!==oldFrame&&!oldFrameDetached||fullFrameUrl(value)!==PORTAL||!contextDestroyed)throw Error('scope');
      const current={frameId:value.id,loaderId:value.loaderId,fullUrl:PORTAL};
      if(JSON.stringify(current)!==JSON.stringify(latestPortal))throw Error('unobserved_loader');
      guard.verify();return current;
    };
    phase='reload';startedAt=Date.now();reloadSent=true;
    await cdp.send('Page.reload',{},opts);
    // 封存前的文档只隔离，绝不消费。只有最终完全匹配的
    // 门户文档通过两次安静读取后才保留；之后发生作用域事件即失败。
    phase='wait';await d.wait(12000);
    phase='verify_scope';newDocument=await verifiedDocument();const settledRevision=revision;
    await d.wait(500);const second=await verifiedDocument();
    if(revision!==settledRevision||JSON.stringify(newDocument)!==JSON.stringify(second))throw Error('unstable');
    loaderChanged=true;sealed=true;await audit('final_portal_observed');
    // 捕获最终受保护的读取器供清理使用，不另开执行域。
    finalGuard=async()=>{
      if(revision!==settledRevision||JSON.stringify(await verifiedDocument())!==JSON.stringify(newDocument)||unexpected)throw Error('scope');
    };
    phase='cleanup';finalResult={status:'reload_verified',...fixed()};
  }catch{return finalResult={status:'recovery_failed',...fixed()};}
  finally{
    if(attachUnknown||unexpected)cleanupConfirmed=false;
    if(attached?.sessionId){
      if(finalResult?.status==='reload_verified')try{await finalGuard();}catch{cleanupConfirmed=false;}
      detachRequested=true;
      try{await transport.cdp.send('Target.detachFromTarget',{sessionId:attached.sessionId},{timeoutMs:5000})}catch{cleanupConfirmed=false}
    }
    for(const off of remove)try{off()}catch{cleanupConfirmed=false}
    try{if(transport)await transport.close()}catch{cleanupConfirmed=false}
    if(unexpected)cleanupConfirmed=false;
    if(finalResult?.status==='reload_verified'){
      try{
        if(!cleanupConfirmed||await d.isOwnerAlive(original.ownerPid))throw new Error('cleanup');
        guard.verify();await recovery.verifyOriginal();await audit('release_intent');
        guard.verify();await recovery.releaseOriginal();oldLockReleased=true;
        await recovery.close();recoveryRetained=false;
        await closeGuard();await audit('released');finalResult.status='recovered';finalResult.phase='complete';
      }catch{cleanupConfirmed=false;finalResult.status='recovery_failed';finalResult.phase='release_validation';}
    }
    // 操作状态未知时保留其持久恢复排他状态。
    // 操作系统保护是临时的，但会一直持有到精确恢复关闭/CAS 完成。
    try{await closeGuard();}catch{cleanupConfirmed=false;if(finalResult){finalResult.status='recovery_failed';finalResult.phase='admin_cleanup';}}
    if(recoveryRetained||recoveryAcquiring)try{await audit('retained');}catch{auditConfirmed=false;}
    if(finalResult){finalResult.cleanupConfirmed=cleanupConfirmed&&!adminGuardUnconfirmed;
      finalResult.oldLockReleased=oldLockReleased;finalResult.recoveryRetained=recoveryAcquiring?'unknown':recoveryRetained;
      finalResult.adminGuardUnconfirmed=adminGuardUnconfirmed;finalResult.auditConfirmed=auditConfirmed;
      finalResult.requestTermination='unknown';finalResult.sourceCreated=false;finalResult.events=events.map(e=>({...e}));}
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
