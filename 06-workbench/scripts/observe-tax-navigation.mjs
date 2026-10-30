// 显式的本机管理操作：正常导航及被动的固定 schema 采集。
// 不释放、获取或修改读取租约，也不执行任何点击。
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openRegisteredBrowserDiagnostic,DEFAULT_REGISTRATION_ROOT} from '../server/tax-browser-diagnostic.mjs';
import {classifyObservedUrl,pageReference} from './inventory-tax-browser.mjs';
import {observedRecipe,collectionShape,businessProjection} from '../server/tax-collection-shape.mjs';
import {TaxCollectionStore,collectionLock} from '../server/tax-collection-local.mjs';
import {readLiveResource,assertLiveFrame} from '../server/tax-live-collection.mjs';
import {enterpriseOf,sameEnterprise,validEnterprise} from '../server/tax-history-contract.mjs';
import {validateCapture} from '../server/tax-collection-contract.mjs';
import {FULL_FRAME_URL_SEMANTICS,frameUrlDigest} from '../server/tax-frame-url.mjs';
const ORIGIN='https://etax.fujian.chinatax.gov.cn:8443';
const DESTINATIONS=Object.freeze({portal_home:ORIGIN+'/loginb/',portal_index:ORIGIN+'/mhzx/api/mh/mhsy/index'});
export async function observeTaxNavigation({registrationRef,registrationRoot,pageRef,destination,prepareOnly=false,persistSource=false,readerStoppedConfirmed=false}={},overrides={}){
  let transport,attached,lock;const remove=[],captures=[],localCaptures=[],work=new Set(),requests=new Map(),finished=[];
  let contextDestroyed=false,loaderObserved=false,navigationSent=false,phase='validation';
  let expectedFrame,expectedLoader,terminationConfirmed=true,finalResult,pendingSource;const navigatedFrames=[];
  let activeVerificationRequestCount=0;
  let acceptNetworkEvents=true,scopeGuardArmed=false,scopeRevision=0;
  let initialFrameConsumed=false,initialContextClearCount=0;
  const earlyScopeEvents=[],oldContextIds=new Set(),consumedOldContextIds=new Set();
  let navigationStartedAt=0,knownRequestOrdinal=0;
  let attachUnknown=false,lockAcquiring=false,detachRequested=false,connectionUnknown=false,verifiedFrame,cleanupFailureStep=null;
  const scopeTrace=[],requestHistory=[];
  let businessRequestOrdinal=0;const businessRequestHistory=[];
  const scopeDiagnostics=()=>{
    const firstIdentityRequestOrdinal=requestHistory.find(request=>request.resource==='identity'
      &&request.frameId===expectedFrame&&request.loaderId===expectedLoader)?.ordinal||0;
    return{revision:scopeRevision,firstIdentityRequestOrdinal,
    counts:Object.fromEntries(['initial_frame','context_clear','context_destroy','within_document','frame_detach'].map(kind=>
      [kind,scopeTrace.filter(event=>event.kind===kind).length])),
    events:scopeTrace.map(event=>({...event,afterFirstIdentityRequest:firstIdentityRequestOrdinal>0&&event.knownRequestOrdinal>=firstIdentityRequestOrdinal})),
    truncated:scopeTrace.length>=128};};
  const scopeEvent=event=>{
    if(!navigationSent)return;
    if(!Object.hasOwn(event,'businessRequestOrdinal'))event.businessRequestOrdinal=businessRequestOrdinal;
    if(!event.trace&&scopeTrace.length<128){
      event.trace={order:scopeTrace.length+1,
        kind:({frame:'initial_frame',contexts_cleared:'context_clear',context_destroyed:'context_destroy',within_document:'within_document',frame_detached:'frame_detach'})[event.kind],
        elapsedMs:Math.max(0,Date.now()-navigationStartedAt),afterNavigationReply:!!expectedFrame,
        knownRequestOrdinal,disposition:'pending'};
      scopeTrace.push(event.trace);
    }
    if(!expectedFrame||!expectedLoader){if(earlyScopeEvents.length>=128)scopeRevision++;else earlyScopeEvents.push(event);return;}
    const beforeRevision=scopeRevision;
    if(event.kind==='frame'){
      if(!initialFrameConsumed&&event.frameId===expectedFrame&&event.loaderId===expectedLoader)initialFrameConsumed=true;
      else scopeRevision++;
    }else if(event.kind==='contexts_cleared'){
      const businessStarted=businessRequestHistory.some(request=>request.frameId===expectedFrame&&request.loaderId===expectedLoader
        &&request.ordinal<=event.businessRequestOrdinal);
      // 实时浏览器证据确认，首次主框架事件之前恰好有两次清空。
      // 数据开始到达后，绝不复用此启动宽限。
      if(!initialFrameConsumed&&!businessStarted&&initialContextClearCount<2)initialContextClearCount++;else scopeRevision++;
    }else if(event.kind==='context_destroyed'){
      if(oldContextIds.has(event.contextId)&&!consumedOldContextIds.has(event.contextId))consumedOldContextIds.add(event.contextId);
      else scopeRevision++;
    }else if(event.frameId===expectedFrame)scopeRevision++;
    if(event.trace)event.trace.disposition=scopeRevision!==beforeRevision?'violation':
      ['frame','contexts_cleared'].includes(event.kind)?'initial_navigation':event.kind==='context_destroyed'?'known_old_context':'unrelated_frame';
  };
  const markers=()=>({phase,navigationSent,contextDestroyed,loaderObserved,leaseChanged:false,scopeVerified:false});
  try{
    if(!/^taxr_[a-f0-9]{48}$/.test(registrationRef||'')||!/^taxpage_[a-f0-9]{48}$/.test(pageRef||'')
      ||!Object.hasOwn(DESTINATIONS,destination)||typeof prepareOnly!=='boolean'||typeof persistSource!=='boolean')throw new Error('input');
    if(persistSource&&readerStoppedConfirmed!==true)throw new Error('confirmation');
    phase='open';transport=await(overrides.openDiagnostic||openRegisteredBrowserDiagnostic)({registrationRef,registrationRoot},
      registrationRoot?{registrationBase:dirname(resolve(registrationRoot))}:{});
    if(transport.localScope?.registrationState!=='quarantined'
      ||await transport.localScope.currentRegistrationState()!=='quarantined')throw new Error('handoff_state');
    const cdp=transport.cdp;phase='targets';const list=await cdp.send('Target.getTargets',{}, {timeoutMs:5000});
    if(!Array.isArray(list?.targetInfos)||list.targetInfos.length>10000)throw new Error('targets');
    const targets=list.targetInfos.filter(t=>t.type==='page'&&typeof t.targetId==='string'
      &&classifyObservedUrl(t.url)?.routeCode==='portal_home'&&pageReference(registrationRef,t.targetId)===pageRef);
    if(targets.length!==1)return finalResult={status:'page_unavailable',captures:[],...markers()};
    phase='lock';lockAcquiring=true;lock=await(overrides.acquireLock||collectionLock)(transport.localScope?.profilePath,
      {scope:{registrationRef,pageRef,operation:'authorized_navigation'}});lockAcquiring=false;
    phase='attach';attachUnknown=true;attached=await cdp.send('Target.attachToTarget',{targetId:targets[0].targetId,flatten:true},{timeoutMs:5000});
    if(typeof attached?.sessionId!=='string'||!attached.sessionId||attached.sessionId.length>256)throw new Error('attach');attachUnknown=false;
    const opts={sessionId:attached.sessionId,timeoutMs:5000};
    const listen=(name,handler)=>remove.push(cdp.on(name,(p,c)=>{if(c?.sessionId===attached.sessionId)handler(p)}));
    const lost=()=>{connectionUnknown=true;terminationConfirmed=false;pendingSource=null;};
    remove.push(cdp.on('closed',lost));
    remove.push(cdp.on('Target.detachedFromTarget',p=>{if(p.sessionId===attached.sessionId&&!detachRequested)lost();}));
    listen('Inspector.detached',()=>{if(!detachRequested)lost();});
    listen('Runtime.executionContextCreated',p=>{if(!navigationSent&&Number.isSafeInteger(p.context?.id)&&oldContextIds.size<1024)oldContextIds.add(p.context.id);});
    listen('Runtime.executionContextsCleared',()=>{contextDestroyed=true;scopeEvent({kind:'contexts_cleared'});});
    listen('Runtime.executionContextDestroyed',p=>scopeEvent({kind:'context_destroyed',contextId:p.executionContextId}));
    listen('Page.frameNavigated',p=>{if(!p.frame?.parentId&&typeof p.frame?.loaderId==='string'){
      navigatedFrames.push({id:p.frame.id,loaderId:p.frame.loaderId});scopeEvent({kind:'frame',frameId:p.frame.id,loaderId:p.frame.loaderId});}});
    listen('Page.navigatedWithinDocument',p=>scopeEvent({kind:'within_document',frameId:p.frameId}));
    listen('Page.frameDetached',p=>scopeEvent({kind:'frame_detached',frameId:p.frameId}));
    listen('Network.requestWillBeSent',p=>{
      if(!acceptNetworkEvents)return;
      const recipe=observedRecipe(p.request||{});
      if(recipe||['XHR','Fetch'].includes(p.type)){
        businessRequestOrdinal++;
        if(businessRequestHistory.length<256)businessRequestHistory.push({ordinal:businessRequestOrdinal,frameId:p.frameId,loaderId:p.loaderId});
        else scopeRevision++;
      }
      if(requests.size>=30||typeof p.requestId!=='string')return;
      if(recipe){knownRequestOrdinal++;if(requestHistory.length<256)requestHistory.push({ordinal:knownRequestOrdinal,
        resource:recipe.resource,frameId:p.frameId,loaderId:p.loaderId});}
      if(recipe)requests.set(p.requestId,{...recipe,localRecipe:recipe.localRecipe,frameId:p.frameId,loaderId:p.loaderId,
        requestTimestamp:p.timestamp,status:'request_observed',httpStatus:null});
      else requests.delete(p.requestId); // 重定向不能继承已获许可的操作配方。
    });
    listen('Network.responseReceived',p=>{
      if(!acceptNetworkEvents)return;
      const record=requests.get(p.requestId);if(!record)return;
      record.httpStatus=Number.isInteger(p.response?.status)&&p.response.status>=100&&p.response.status<=599?p.response.status:null;
    });
    const processFinished=p=>{
      if(!acceptNetworkEvents)return;
      const record=requests.get(p.requestId);if(!record||captures.length>=30||record.done)return;
      if(!expectedFrame||!expectedLoader){finished.push(p);return;}
      if(record.frameId!==expectedFrame||record.loaderId!==expectedLoader)return;
      record.done=true;
      const safeRecord={resource:record.resource,method:record.method,recipeMatches:record.recipeMatches,
        status:record.status,httpStatus:record.httpStatus,bodyStatus:record.bodyStatus,bodyFields:record.bodyFields,
        unknownBodyFieldCount:record.unknownBodyFieldCount,queryMatches:record.queryMatches};
      const task=(async()=>{
        if(!Number.isFinite(p.encodedDataLength)||p.encodedDataLength>1048576){captures.push({...safeRecord,status:'response_too_large'});return;}
        try{
          const response=await cdp.send('Network.getResponseBody',{requestId:p.requestId},opts);
          if(typeof response.body!=='string'||response.body.length>2097152)throw new Error('size');
          const text=response.base64Encoded?Buffer.from(response.body,'base64').toString('utf8'):response.body;
          if(Buffer.byteLength(text)>1048576)throw new Error('size');
          let body;try{body=JSON.parse(text)}catch{captures.push({...safeRecord,status:'invalid_json'});return;}
          captures.push({...safeRecord,status:'response_observed',...collectionShape(body)});
          const projection=businessProjection(body,record.resource);
          if(record.localRecipe&&projection&&record.httpStatus===200&&collectionShape(body).businessStatus!=='failed')localCaptures.push({resource:record.resource,
            recipe:record.localRecipe,projection,shape:collectionShape(body),requestTimestamp:record.requestTimestamp});
        }catch{captures.push({...safeRecord,status:'response_unavailable'});}
      })();work.add(task);task.finally(()=>work.delete(task));
    };
    listen('Network.loadingFinished',processFinished);
    phase='network_enable';await cdp.send('Network.enable',{maxTotalBufferSize:4194304,maxResourceBufferSize:1048576},opts);
    phase='page_enable';await cdp.send('Page.enable',{},opts);
    phase='runtime_enable';await cdp.send('Runtime.enable',{},opts);
    if(prepareOnly){phase='prepared';return finalResult={status:'prepared',captures:[],...markers()};}
    phase='navigate';contextDestroyed=false;navigationStartedAt=Date.now();navigationSent=true;terminationConfirmed=false;
    const nav=await cdp.send('Page.navigate',{url:DESTINATIONS[destination]},opts);
    if(nav.errorText)return finalResult={status:'navigation_failed',captures:[],...markers()};
    if(typeof nav.frameId!=='string'||typeof nav.loaderId!=='string')throw new Error('scope');
    expectedFrame=nav.frameId;expectedLoader=nav.loaderId;scopeGuardArmed=true;
    for(const event of earlyScopeEvents.splice(0))scopeEvent(event);
    if(scopeRevision!==0)throw new Error('scope');
    for(const item of finished.splice(0))processFinished(item);
    phase='wait';await(overrides.wait||((ms)=>new Promise(done=>setTimeout(done,ms))))(12000);
    acceptNetworkEvents=false;
    phase='drain';if((await Promise.allSettled([...work])).some(r=>r.status==='rejected'))throw new Error('work');
    phase='verify_scope';const frameTree=await cdp.send('Page.getFrameTree',{},opts);
    loaderObserved=navigatedFrames.some(frame=>frame.id===expectedFrame&&frame.loaderId===expectedLoader);
    if(frameTree?.frameTree?.frame?.id!==expectedFrame||frameTree.frameTree.frame.loaderId!==expectedLoader
      ||!contextDestroyed||!loaderObserved||scopeRevision!==0||connectionUnknown)throw new Error('scope');
    verifiedFrame={frameId:expectedFrame,loaderId:expectedLoader,
      documentUrlDigest:typeof frameTree.frameTree.frame.url==='string'?frameUrlDigest(frameTree.frameTree.frame):null};
    terminationConfirmed=true;
    if(persistSource){
      phase='source_projection';const ordered=localCaptures.filter(c=>Number.isFinite(c.requestTimestamp)).sort((a,b)=>a.requestTimestamp-b.requestTimestamp);
      const filing=ordered.filter(c=>c.resource==='current_filing').at(-1);
      const identity=ordered.filter(c=>c.resource==='identity'&&c.requestTimestamp<=filing?.requestTimestamp).at(-1);
      if(!identity||!filing)throw new Error('projection');
      const local=c=>({resource:c.resource,recipe:c.recipe,projection:c.projection});
      if(!validateCapture(local(identity),'identity')||!validateCapture(local(filing),'current_filing')
        ||!validEnterprise(enterpriseOf(identity.projection)))throw new Error('projection');
      const documentUrlDigest=frameUrlDigest(frameTree.frameTree.frame);
      const scope={version:2,documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,frameId:expectedFrame,loaderId:expectedLoader,documentUrlDigest};
      phase='identity_after';const expectedFullUrl=await assertLiveFrame(cdp,opts,scope);terminationConfirmed=false;
      activeVerificationRequestCount++;
      const after=await readLiveResource(cdp,opts,identity.recipe,'identity',expectedFullUrl);terminationConfirmed=true;
      await assertLiveFrame(cdp,opts,scope);
      if(scopeRevision!==0)throw new Error('scope');
      if(!sameEnterprise(enterpriseOf(identity.projection),enterpriseOf(after.capture.projection))){terminationConfirmed=false;throw new Error('enterprise_changed');}
      if(await transport.localScope.currentRegistrationState()!=='quarantined')throw new Error('handoff_state');
      pendingSource={version:2,documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,authorizedNavigation:true,handoffMode:'quarantined_reader_new_navigation',readerStoppedConfirmed:true,
        registrationRef,registrationRoot:resolve(registrationRoot||DEFAULT_REGISTRATION_ROOT),pageRef,targetId:targets[0].targetId,
        frameId:expectedFrame,loaderId:expectedLoader,documentUrlDigest,browserKey:transport.localScope?.browserKey,
        capturedAt:Date.now(),identity:local(identity),filing:local(filing)};
    }
    phase='complete';return finalResult={status:'observed',destination,captures,
      passiveObservedRequestCount:[...requests.values()].filter(r=>r.frameId===expectedFrame&&r.loaderId===expectedLoader).length,
      activeVerificationRequestCount,...markers()};
  }catch{return finalResult={status:'observation_failed',captures,activeVerificationRequestCount,...markers()};}
  finally{
    acceptNetworkEvents=false;
    const cleanupFailed=step=>{terminationConfirmed=false;pendingSource=null;cleanupFailureStep??=step;};
    if((await Promise.allSettled([...work])).some(r=>r.status==='rejected'))cleanupFailed('work_drain');
    if(attachUnknown)cleanupFailed('attach');
    if(attached?.sessionId){
      if(scopeGuardArmed)try{
        if(await transport.localScope.currentRegistrationState()!=='quarantined')throw new Error('registration');
        const frame=(await transport.cdp.send('Page.getFrameTree',{}, {sessionId:attached.sessionId,timeoutMs:5000}))?.frameTree?.frame;
        if(!frame||Object.hasOwn(frame,'parentId')||frame.id!==expectedFrame||frame.loaderId!==expectedLoader||scopeRevision!==0||connectionUnknown
          ||verifiedFrame?.documentUrlDigest&&frameUrlDigest(frame)!==verifiedFrame.documentUrlDigest)throw new Error('scope');
      }catch{cleanupFailed('final_scope');}
      // 自有会话分离时会移除其启用的域。Runtime.disable
      // 自身也可能发出 contextsCleared，因此绝不单独禁用各域。
      detachRequested=true;
      try{await transport.cdp.send('Target.detachFromTarget',{sessionId:attached.sessionId},{timeoutMs:5000});}
      catch{cleanupFailed('detach');}
    }
    for(const off of remove)try{off()}catch{cleanupFailed('listeners');}
    if(scopeGuardArmed&&scopeRevision!==0||connectionUnknown)cleanupFailed('scope_event');
    // 等待自有连接关闭后，才允许另一个采集器运行。
    try{if(transport)await transport.close();}catch{cleanupFailed('transport_close');}
    let lockRetained=lockAcquiring||attachUnknown;
    if(lock){if(terminationConfirmed&&!connectionUnknown&&scopeRevision===0)try{await lock.release()}catch{cleanupFailed('lock_release');lockRetained=true;}
      else lockRetained=true;
      if(lockRetained)try{lock.retain();}catch{cleanupFailed('lock_retain');}}
    if(finalResult){
      finalResult.scopeDiagnostics=scopeDiagnostics();finalResult.lockRetained=lockRetained;
      finalResult.cleanupConfirmed=terminationConfirmed&&!lockRetained&&!cleanupFailureStep;
      finalResult.cleanupFailureStep=cleanupFailureStep;
      if(cleanupFailureStep){finalResult.status='observation_failed';finalResult.phase=scopeGuardArmed&&scopeRevision!==0?'scope_cleanup':'cleanup';}
    }
    if(pendingSource&&finalResult?.status==='observed'&&!lockRetained){
      try{finalResult.sourceRef=await(overrides.store||new TaxCollectionStore()).save('source',pendingSource);
        finalResult.identityProjectionMatched=true;finalResult.enterpriseVerified=false;
      }catch{finalResult.status='observation_failed';finalResult.phase='persist';}
    }else if(pendingSource&&finalResult?.status==='observed'){
      finalResult.status='observation_failed';finalResult.phase='cleanup';
    }
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const a=process.argv.slice(2);
  const flags=a.slice(8);
  if(![8,9,10].includes(a.length)||a[0]!=='--registration-ref'||a[2]!=='--registration-root'||a[4]!=='--page-ref'||a[6]!=='--destination'
      ||new Set(flags).size!==flags.length||flags.some(flag=>!['--prepare-only','--persist-source','--confirm-reader-stopped'].includes(flag))){
    console.error('usage: node scripts/observe-tax-navigation.mjs --registration-ref <local-ref> --registration-root <local-directory> --page-ref <safe-ref> --destination portal_home|portal_index');process.exitCode=1;
  }else{const result=await observeTaxNavigation({registrationRef:a[1],registrationRoot:a[3],pageRef:a[5],destination:a[7],
    prepareOnly:flags.includes('--prepare-only'),persistSource:flags.includes('--persist-source'),readerStoppedConfirmed:flags.includes('--confirm-reader-stopped')});
    console.log(JSON.stringify(result));if(!['observed','prepared'].includes(result.status))process.exitCode=1;}
}
