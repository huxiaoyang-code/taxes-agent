// 显式启用的本机管理操作：固定门户重载、隔离启动，
// 随后执行三次完全全新的读取；绝不注册为 Agent/HTTP/MCP 工具。
import {dirname,resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {open,lstat,readFile} from 'node:fs/promises';
import {openRegisteredBrowserDiagnostic,DEFAULT_REGISTRATION_ROOT,verifyPrivateFile} from '../server/tax-browser-diagnostic.mjs';
import {TaxCollectionStore,collectionLock} from '../server/tax-collection-local.mjs';
import {PASSIVE_RECIPES,observedRecipe,businessProjection,collectionShape} from '../server/tax-collection-shape.mjs';
import {validateCapture,validateEvidence} from '../server/tax-collection-contract.mjs';
import {enterpriseOf,sameEnterprise,validEnterprise,canonical} from '../server/tax-history-contract.mjs';
import {liveRequestScript} from '../server/tax-live-collection.mjs';
import {FULL_FRAME_URL_SEMANTICS,fullFrameUrl,frameUrlDigest} from '../server/tax-frame-url.mjs';
import {pageReference} from './inventory-tax-browser.mjs';

const PORTAL='https://etax.fujian.chinatax.gov.cn:8443/loginb/',MODE='full_fresh_portal_bootstrap_v1';
const fixedFailure=()=>Error('portal_bootstrap_failed');
const safeRef=p=>p+'_'+randomBytes(24).toString('hex');
function ordinaryStart(raw){
  if(raw===PORTAL)return true;
  try{const u=new URL(raw),decoded=decodeURIComponent(u.pathname+u.hash);
    return u.href===raw&&u.origin===new URL(PORTAL).origin&&!u.username&&!u.password&&!/[\\\u0000-\u001f]/.test(decoded)
      &&!/(?:login|passport|callback|oauth|sso|auth|submit|save|delete|remove|update|modify|correct|cancel|revoke|void|commit|payment|makeout|issue|register|logout)/i.test(decoded.split('?')[0])
      &&![...u.searchParams.keys()].some(k=>/auth|token|ticket|nonce|password|cookie|session|secret|credential|sso|oauth|^(?:code|sign)$/i.test(k))
      &&!/(?:^|[?&#])(?:[^=&#]*?(?:auth|token|ticket|nonce|password|cookie|session|secret|credential|oauth|sso)|code|sign)=/i.test(decoded)
      &&!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(u.hash);
  }catch{return false;}
}
const strictRecipe=(r,resource)=>{
  const known=PASSIVE_RECIPES[r?.path];
  return known?.resource===resource&&known.method===r.method&&typeof r.queryTimestamp==='boolean'
    &&(resource==='identity'?r.body===null:resource==='current_filing'&&canonical(r.body)===canonical({Csbz:''}));
};
async function privateAudit(value){
  const store=new TaxCollectionStore();await store.ready();
  const file=join(store.root,'portal_bootstrap_'+randomBytes(24).toString('hex')+'.json'),bytes=Buffer.from(JSON.stringify(value));
  if(bytes.length>65536)throw fixedFailure();const handle=await open(file,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  await verifyPrivateFile(file);const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||!(await readFile(file)).equals(bytes))throw fixedFailure();
}

export async function bootstrapTaxPortalSource(args={},overrides={}){
  const d={openDiagnostic:openRegisteredBrowserDiagnostic,acquireLock:collectionLock,store:new TaxCollectionStore(),audit:privateAudit,
    wait:ms=>new Promise(done=>setTimeout(done,ms)),now:Date.now,...overrides};
  const {registrationRef,registrationRoot,pageRef,execute=false,readerStoppedConfirmed=false,openPortal=false}=args||{};
  const navigationAudit={normalFixedPortalReturn:openPortal,navigationAction:openPortal?'Page.navigate':'Page.reload'};
  let transport,lock,session,target,oldDocument,sealedDocument,lastMainDocument,phase='validation',result,sourceDraft,runDraft;
  let lockAcquiring=false,attachUnknown=false,reloadAttempted=false,reloadAcknowledged=false,ownUnknown=false,sessionLost=false,
    detachRequested=false,closing=false,scopeValid=true,sealed=false,revision=0,cleanupFailureStep=null,lockRetained=false;
  let mainFrames=0,clears=0,within=0,detaches=0,metadataDiscarded=0,metadataOverflow=false,sourceRef,runRef,publishAttempted=false;
  const remove=[],metadata=[],proof=[],operationRef=safeRef('taxop');
  let attempted=0,settled=0,performed=0,complete=0,publicationAuditUnconfirmed=false,identityProjectionMatched=false;
  const out=()=>({mode:MODE,phase,fullFreshThree:complete===3&&proof.length===3,earlyProjectionUsed:false,sourcePublished:false,
    finalScopeSealed:sealed,sourceScopeValid:scopeValid,identityProjectionMatched,requestAttemptedCount:attempted,requestSettledCount:settled,
    requestPerformedCount:performed,responseCompleteCount:complete,requestUnknown:ownUnknown,bootstrapMainFrameCount:mainFrames,
    bootstrapContextClearCount:clears,bootstrapWithinDocumentCount:within,bootstrapFrameDetachCount:detaches,
    discardedRecipeCount:metadataDiscarded,lockRetained,cleanupFailureStep,downstreamReady:false});
  const failed=step=>{cleanupFailureStep??=step;};
  const send=(method,params={},timeoutMs=5000)=>transport.cdp.send(method,params,
    {...session&&!method.startsWith('Target.')?{sessionId:session}:{},timeoutMs});
  const closeTransport=async()=>{
    const ws=transport.cdp.ws;
    if(!ws||typeof ws.addEventListener!=='function'||typeof ws.removeEventListener!=='function')throw fixedFailure();
    let closed=ws.readyState===3,done,timer;
    const ended=new Promise(resolve=>{done=resolve;}),onClose=()=>{closed=true;done();};
    ws.addEventListener('close',onClose);
    try{
      await Promise.race([(async()=>{await transport.close();if(!closed)await ended;if(ws.readyState!==3)throw fixedFailure();})(),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(fixedFailure()),5000);})]);
    }finally{clearTimeout(timer);ws.removeEventListener('close',onClose);}
  };
  const record=kind=>{
    revision++;
    if(kind==='main')mainFrames++;if(kind==='clear')clears++;if(kind==='within')within++;if(kind==='detach')detaches++;
    if(sealed||mainFrames>8||clears>16||within>32||detaches>32)scopeValid=false;
  };
  const current=async(pre=false)=>{
    const frame=(await send('Page.getFrameTree'))?.frameTree?.frame;
    if(!frame||Object.hasOwn(frame,'parentId')||!['id','loaderId'].every(k=>typeof frame[k]==='string'&&frame[k].length>0&&frame[k].length<=256)
      ||!(pre&&openPortal?ordinaryStart(fullFrameUrl(frame)):fullFrameUrl(frame)===PORTAL))throw fixedFailure();
    return{frameId:frame.id,loaderId:frame.loaderId,fullUrl:fullFrameUrl(frame),documentUrlDigest:frameUrlDigest(frame)};
  };
  const registered=async()=>{
    if(transport.localScope.registrationState!=='quarantined'||await transport.localScope.currentRegistrationState()!=='quarantined')throw fixedFailure();
  };
  const inventory=async(pre=false)=>{
    const targets=(await send('Target.getTargets'))?.targetInfos;
    if(!Array.isArray(targets)||targets.length>10000)throw fixedFailure();
    const selected=targets.filter(t=>t?.type==='page'&&typeof t.targetId==='string'&&pageReference(registrationRef,t.targetId)===pageRef);
    if(selected.length!==1||!(pre&&openPortal?ordinaryStart(selected[0].url):selected[0].url===PORTAL)||target&&selected[0].targetId!==target.targetId)throw fixedFailure();return selected[0];
  };
  const guard=async()=>{
    try{await registered();await inventory();
      if(!scopeValid||sessionLost||canonical(await current())!==canonical(sealedDocument)||!scopeValid)throw fixedFailure();
    }catch{scopeValid=false;throw fixedFailure();}
  };
  const readFresh=async(resource,recipe)=>{
    await guard();const requestRef=safeRef('taxreq');attempted++;
    let reply;
    try{reply=await send('Runtime.evaluate',{expression:liveRequestScript(recipe,resource,requestRef,PORTAL),returnByValue:true,awaitPromise:true,timeout:15000},16000);}
    catch{ownUnknown=true;throw fixedFailure();}
    const value=reply?.result?.value,matched=value?.requestRef===requestRef;
    const knownTerminal=['scope_invalid','scope_changed','request_failed','invalid_json','response_too_large'].includes(value?.status);
    if(reply?.exceptionDetails||value?.settled!==true||!matched&&!knownTerminal){ownUnknown=true;throw fixedFailure();}
    if(matched&&value.status==='observed'&&(value.requestPerformed!==true||value.responseComplete!==true)){ownUnknown=true;throw fixedFailure();}
    settled++;
    if(matched&&value.requestPerformed===true)performed++;
    if(matched&&value.responseComplete===true)complete++;
    if(!matched||value.status!=='observed'||value.requestPerformed!==true||value.responseComplete!==true)throw fixedFailure();
    const capture={resource,recipe,projection:businessProjection(value.body,resource)};
    if(collectionShape(value.body).businessStatus==='failed'||!validateCapture(capture,resource))throw fixedFailure();
    if(resource==='identity'&&!validEnterprise(enterpriseOf(capture.projection)))throw fixedFailure();
    proof.push({requestRef,resource,requestPerformed:true,responseComplete:true});
    await guard();return capture;
  };
  try{
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['registrationRef','registrationRoot','pageRef','execute','readerStoppedConfirmed','openPortal'].includes(k))
      ||!/^taxr_[a-f0-9]{48}$/.test(registrationRef||'')||!/^taxpage_[a-f0-9]{48}$/.test(pageRef||'')
      ||typeof execute!=='boolean'||typeof readerStoppedConfirmed!=='boolean'||typeof openPortal!=='boolean'||execute&&!readerStoppedConfirmed)throw fixedFailure();
    phase='open';transport=await d.openDiagnostic({registrationRef,registrationRoot},registrationRoot?{registrationBase:dirname(resolve(registrationRoot))}:{});
    await registered();target=await inventory(true);
    if(!execute){result={status:'portal_bootstrap_diagnosed'};}
    else{
      phase='lock';lockAcquiring=true;lock=await d.acquireLock(transport.localScope.profilePath,{scope:{operation:'authorized_navigation',registrationRef,pageRef}});lockAcquiring=false;
      phase='attach';attachUnknown=true;const attached=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
      if(typeof attached?.sessionId!=='string'||!attached.sessionId||attached.sessionId.length>256)throw fixedFailure();session=attached.sessionId;attachUnknown=false;
      const listen=(name,fn)=>remove.push(transport.cdp.on(name,(p,c)=>{if(c?.sessionId===session)fn(p);}));
      listen('Page.frameNavigated',p=>{if(reloadAttempted&&!Object.hasOwn(p.frame||{},'parentId')){
        record('main');try{lastMainDocument={frameId:p.frame.id,loaderId:p.frame.loaderId,fullUrl:fullFrameUrl(p.frame),documentUrlDigest:frameUrlDigest(p.frame)};}
        catch{lastMainDocument=null;}}});
      listen('Runtime.executionContextsCleared',()=>{if(reloadAttempted)record('clear');});
      listen('Runtime.executionContextDestroyed',()=>{if(reloadAttempted&&sealed)record('destroy');});
      listen('Page.navigatedWithinDocument',p=>{if(reloadAttempted&&[oldDocument?.frameId,sealedDocument?.frameId].includes(p.frameId))record('within');});
      listen('Page.frameDetached',p=>{if(reloadAttempted&&[oldDocument?.frameId,sealedDocument?.frameId].includes(p.frameId))record('detach');});
      listen('Inspector.detached',()=>{if(!detachRequested)sessionLost=true;});
      remove.push(transport.cdp.on('Target.detachedFromTarget',p=>{if(p.sessionId===session&&!detachRequested)sessionLost=true;}));
      remove.push(transport.cdp.on('closed',()=>{if(!closing)sessionLost=true;}));
      listen('Network.requestWillBeSent',p=>{
        if(!reloadAttempted||sealed)return;
        const found=observedRecipe(p.request||{}),recipe=found?.localRecipe;
        if(found?.recipeMatches!==true||!['identity','current_filing'].includes(found.resource)||!strictRecipe(recipe,found.resource))return;
        const keys=[...new URL(p.request.url).searchParams.keys()];if(keys.length>1||keys.some(k=>k!=='t'))return;
        if(metadata.length>=64){metadataOverflow=true;return;}
        metadata.push({resource:found.resource,recipe,frameId:p.frameId,loaderId:p.loaderId});
      });
      await send('Network.enable');await send('Page.enable');await send('Runtime.enable');oldDocument=await current(true);
      if(openPortal&&(await inventory(true)).url!==oldDocument.fullUrl)throw fixedFailure();
      const auditDocument=openPortal?{frameId:oldDocument.frameId,loaderId:oldDocument.loaderId,documentUrlDigest:oldDocument.documentUrlDigest}:oldDocument;
      await d.audit({version:1,mode:MODE,state:'started',operationRef,registrationRef,pageRef,oldDocument:auditDocument,earlyProjectionUsed:false,...navigationAudit});
      phase=openPortal?'bootstrap_open_portal':'bootstrap_reload';reloadAttempted=true;
      try{
        if(openPortal){const ack=await send('Page.navigate',{url:PORTAL,frameId:oldDocument.frameId});
          if(ack?.errorText||ack?.isDownload===true||ack?.frameId!==oldDocument.frameId||typeof ack.loaderId!=='string'||!ack.loaderId||ack.loaderId.length>256||ack.loaderId===oldDocument.loaderId)throw fixedFailure();}
        else await send('Page.reload');reloadAcknowledged=true;
      }catch{ownUnknown=true;throw fixedFailure();}
      await d.wait(12000);
      phase='seal';await registered();await inventory();const first=await current(),atRevision=revision;
      if(!scopeValid||sessionLost||metadataOverflow||first.frameId!==oldDocument.frameId||first.loaderId===oldDocument.loaderId
        ||canonical(first)!==canonical(lastMainDocument))throw fixedFailure();
      await d.wait(500);const second=await current();await registered();await inventory();
      if(revision!==atRevision||canonical(first)!==canonical(second)||!scopeValid||sessionLost)throw fixedFailure();
      sealedDocument=second;sealed=true;
      const final=metadata.filter(m=>m.frameId===second.frameId&&m.loaderId===second.loaderId);metadataDiscarded=metadata.length-final.length;
      const recipeOf=resource=>{
        const choices=final.filter(m=>m.resource===resource);if(!choices.length)throw fixedFailure();
        const recipe=choices[0].recipe;if(choices.some(m=>canonical(m.recipe)!==canonical(recipe)))throw fixedFailure();return recipe;
      };
      const identityRecipe=recipeOf('identity'),filingRecipe=recipeOf('current_filing');metadata.length=0;
      phase='identity_before';const before=await readFresh('identity',identityRecipe);
      phase='filing';const filing=await readFresh('current_filing',filingRecipe);
      phase='identity_after';const after=await readFresh('identity',identityRecipe);
      if(!sameEnterprise(enterpriseOf(before.projection),enterpriseOf(after.projection))){scopeValid=false;throw fixedFailure();}
      identityProjectionMatched=true;
      await guard();
      sourceDraft={version:2,documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,authorizedNavigation:true,handoffMode:'quarantined_reader_new_navigation',readerStoppedConfirmed:true,
        registrationRef,registrationRoot:resolve(registrationRoot||DEFAULT_REGISTRATION_ROOT),pageRef,targetId:target.targetId,frameId:second.frameId,loaderId:second.loaderId,
        documentUrlDigest:second.documentUrlDigest,browserKey:transport.localScope.browserKey,capturedAt:d.now(),identity:after,filing};
      validateEvidence('source',sourceDraft);
      runDraft={version:1,capturedAt:d.now(),identity:after,filing,operationRef,requestProof:proof};
      await d.audit({version:1,mode:MODE,state:'fresh_verified',operationRef,sourceDraftDigest:createHash('sha256').update(canonical(sourceDraft)).digest('hex'),requestProof:proof,earlyProjectionUsed:false,...navigationAudit});
      result={status:'portal_bootstrap_verified'};
    }
  }catch{result={status:'portal_bootstrap_failed'};}
  finally{
    if(session){
      if(result?.status==='portal_bootstrap_verified')try{await guard();}catch{sourceDraft=null;result={status:'portal_bootstrap_failed'};}
      detachRequested=true;try{await send('Target.detachFromTarget',{sessionId:session});}catch{failed('detach');}
    }
    for(const off of remove)try{off();}catch{failed('listeners');}
    closing=true;try{if(transport)await closeTransport();}catch{failed('transport_close');}
    // 应用作用域发生变化时禁止消费结果；但在确认清理完成后，
    // 这不表示已明确结束的自有操作仍在执行。
    const settledOwnWork=!attachUnknown&&!ownUnknown&&!sessionLost&&(!reloadAttempted||reloadAcknowledged)&&attempted===settled;
    lockRetained=lockAcquiring||attachUnknown;
    if(lock){
      if(settledOwnWork&&!cleanupFailureStep)try{await lock.release();}catch{failed('lock_release');lockRetained=true;}
      else lockRetained=true;
      if(lockRetained)try{lock.retain();}catch{failed('lock_retain');}
    }
    if(cleanupFailureStep||lockRetained||!scopeValid||sessionLost){sourceDraft=null;if(execute)result={status:'portal_bootstrap_failed'};}
    if(sourceDraft&&result?.status==='portal_bootstrap_verified'){
      phase='publish';publishAttempted=true;
      try{
        sourceRef=await d.store.save('source',sourceDraft);runRef=await d.store.save('run',{...runDraft,sourceRef});
        await d.audit({version:1,mode:MODE,state:'published',operationRef,sourceRef,runRef,requestProof:proof,earlyProjectionUsed:false,...navigationAudit});
        phase='complete';result={status:'portal_source_created',sourceRef,runRef,sourcePublished:true};
      }catch{
        result={status:'portal_bootstrap_failed'};
        try{await d.audit({version:1,mode:MODE,state:'publication_partial',operationRef,sourceRef,runRef,earlyProjectionUsed:false,...navigationAudit});}catch{publicationAuditUnconfirmed=true;}
      }
    }
  }
  return{...out(),...result,cleanupConfirmed:!cleanupFailureStep&&!lockRetained&&!attachUnknown,
    orphanedPublicationPossible:publishAttempted&&result.status!=='portal_source_created',publicationAuditUnconfirmed};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const a=process.argv.slice(2),flags=a.slice(6);
  if(![6,8,9].includes(a.length)||a[0]!=='--registration-ref'||a[2]!=='--registration-root'||a[4]!=='--page-ref'
    ||a.length>=8&&(flags[0]!=='--bootstrap-and-persist'||flags[1]!=='--confirm-reader-stopped')||a.length===9&&flags[2]!=='--open-portal'){
    console.error('usage: node scripts/bootstrap-tax-portal-source.mjs --registration-ref <local-ref> --registration-root <local-root> --page-ref <safe-ref> [--bootstrap-and-persist --confirm-reader-stopped [--open-portal]]');process.exitCode=1;
  }else{const result=await bootstrapTaxPortalSource({registrationRef:a[1],registrationRoot:a[3],pageRef:a[5],execute:a.length>=8,readerStoppedConfirmed:a.length>=8,openPortal:a.length===9});
    console.log(JSON.stringify(result));if(!['portal_bootstrap_diagnosed','portal_source_created'].includes(result.status))process.exitCode=1;}
}
