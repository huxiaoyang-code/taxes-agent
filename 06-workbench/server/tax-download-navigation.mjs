// Local administrator only: a single fixed normal navigation, never an Agent/MCP tool.
import {dirname,resolve} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {openRegisteredBrowserDiagnostic} from './tax-browser-diagnostic.mjs';
import {TaxCollectionStore,collectionLock} from './tax-collection-local.mjs';
import {requireActiveSource,validateCapture} from './tax-collection-contract.mjs';
import {TaxHistoryStore} from './tax-history-store.mjs';
import {canonical,exact,historyRef,validateHistoryRecord,enterpriseOf,sameEnterprise,HISTORY_ORIGIN} from './tax-history-contract.mjs';
import {FULL_FRAME_URL_SEMANTICS,fullFrameUrl} from './tax-frame-url.mjs';
import {liveRequestScript} from './tax-live-collection.mjs';
import {businessProjection,collectionShape} from './tax-collection-shape.mjs';

const PORTAL=HISTORY_ORIGIN+'/loginb/';
const fail=code=>Object.assign(new Error(code),{code});
function documentOf(frame,targetId){
  const fullUrl=fullFrameUrl(frame);
  if(frame.parentId||!['id','loaderId'].every(k=>typeof frame[k]==='string'&&frame[k].length>0&&frame[k].length<=256))throw fail('document_changed');
  return {targetId,frameId:frame.id,loaderId:frame.loaderId,fullUrl,documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,
    documentUrlDigest:createHash('sha256').update(fullUrl).digest('hex')};
}
const REASONS=new Set(['context_expired','binding_invalid','source_inactive','registration_changed','document_changed','identity_changed',
  'identity_business_failed','identity_shape_invalid','identity_response_failed','identity_unknown','navigation_failed','navigation_unknown',
  'event_unknown','operation_timeout','budget_insufficient','tax_collection_busy']);

export class TaxDownloadNavigation{
  constructor(overrides={}){this.d={store:new TaxHistoryStore(),parentStore:new TaxCollectionStore(),openDiagnostic:openRegisteredBrowserDiagnostic,
    acquireLock:collectionLock,now:Date.now,clock:Date.now,...overrides};}
  async returnToPortal(args={}){
    if(!exact(args,['contextRef'])||!historyRef(args.contextRef,'context'))return {status:'input_invalid'};
    let transport,lock,attached,context,template,document,finalDocument,phase='load',unknown=false,unexpected=false,
      detachRequested=false,navigating=false,navEvent=null,navEvents=0,lockAcquiring=false,identityMatches=0,
      attempted=0,performed=0,complete=0,requestUnknown=0,notPerformed=0,navigationAttempted=0,navigationConfirmed=0;
    const remove=[],oldContextIds=new Set(),consumedOldContextIds=new Set(),started=this.d.clock();
    let initialContextClearCount=0,unexpectedEventKind=null,cleanupStep='not_started',cleanupFailureStep=null,cleanupFailureKind=null;
    const eventUnknown=kind=>{unexpected=true;unknown=true;unexpectedEventKind??=kind;};
    const cleanupFailed=(step,error)=>{unknown=true;cleanupFailureStep??=step;
      cleanupFailureKind??=error?.code==='operation_timeout'?'timeout':REASONS.has(error?.code)?error.code:'unconfirmed';};
    // ACL checks invoke bounded Windows helpers. Reserve thirty seconds for
    // final ACL/frame verification, session detach, socket close and lock CAS.
    const bounded=async(action,ms,cleanup=false)=>{
      const remaining=(cleanup?90000:60000)-(this.d.clock()-started);
      if(remaining<=0){unknown=true;throw fail('operation_timeout');}
      let timer;try{return await Promise.race([Promise.resolve().then(action),new Promise((_,reject)=>{
        timer=setTimeout(()=>{unknown=true;reject(fail('operation_timeout'));},Math.min(ms,remaining));
      })]);}finally{clearTimeout(timer);}
    };
    const active=async(cleanup=false)=>{
      if(context.createdAt>this.d.now()||context.expiresAt<=this.d.now())throw fail('context_expired');
      // This check is a private lstat, without an ACL helper subprocess.
      try{await bounded(()=>this.d.parentStore.assertNotAbandoned(template.parentSourceRef),2000,cleanup);}catch(e){if(e.code==='operation_timeout')throw e;throw fail('source_inactive');}
    };
    const send=async(method,params={},ms=3000,cleanup=false)=>{
      try{return await bounded(()=>transport.cdp.send(method,params,
        {...attached?.sessionId?{sessionId:attached.sessionId}:{},timeoutMs:ms}),ms,cleanup);}
      catch(error){unknown=true;throw error;}
    };
    const registered=async(cleanup=false)=>{
      if(transport.localScope?.browserKey!==template.browserKey||transport.localScope.registrationState!=='quarantined'
        ||await bounded(()=>transport.localScope.currentRegistrationState(),7000,cleanup)!=='quarantined')throw fail('registration_changed');
    };
    const currentDocument=async(cleanup=false)=>documentOf((await send('Page.getFrameTree',{},3000,cleanup))?.frameTree?.frame,template.captureDocument.targetId);
    const guard=async()=>{
      await active();await registered();if(unexpected)throw fail('event_unknown');
      if(canonical(await currentDocument())!==canonical(document)||unexpected)throw fail('document_changed');
    };
    const identity=async()=>{
      await guard();attempted++;const requestRef='taxreq_'+randomBytes(24).toString('hex');
      let reply;try{reply=await send('Runtime.evaluate',{expression:liveRequestScript(template.identityRecipe,'identity',requestRef,document.fullUrl),
        returnByValue:true,awaitPromise:true,timeout:13000},14000);}catch(e){requestUnknown++;unknown=true;throw e;}
      const value=reply?.result?.value,matched=!reply?.exceptionDetails&&value?.requestRef===requestRef;
      // Only the audited native-fetch preflight failure proves no dispatch.
      // scope_changed is also returned after a response: it remains unknown.
      const knownNoDispatch=!reply?.exceptionDetails&&exact(value,['status','settled'])&&value.status==='scope_invalid'&&value.settled===true;
      if(matched&&value.requestPerformed===true)performed++;else if(knownNoDispatch)notPerformed++;else requestUnknown++;
      if(matched&&value.responseComplete===true)complete++;
      if(reply?.exceptionDetails||value?.settled!==true){unknown=true;throw fail('identity_unknown');}
      if(!matched&&(value.status==='observed'||!['scope_invalid','scope_changed','request_failed','invalid_json','response_too_large'].includes(value.status))){unknown=true;throw fail('identity_unknown');}
      if(!matched||value.status!=='observed'||value.requestPerformed!==true||value.responseComplete!==true)throw fail('identity_response_failed');
      if(collectionShape(value.body).businessStatus==='failed')throw fail('identity_business_failed');
      const projection=businessProjection(value.body,'identity');
      if(!validateCapture({resource:'identity',recipe:template.identityRecipe,projection},'identity'))throw fail('identity_shape_invalid');
      if(!sameEnterprise(enterpriseOf(projection),template.enterprise))throw fail('identity_changed');
      await guard();identityMatches++;
    };
    let result;
    try{
      context=validateHistoryRecord('context',await bounded(()=>this.d.store.load(args.contextRef),5000));
      template=validateHistoryRecord('template',await bounded(()=>this.d.store.load(context.templateRef),5000));
      if(template.capturedAt>context.createdAt||!sameEnterprise(context.enterprise,template.enterprise)
        ||context.replayDocument.targetId!==template.captureDocument.targetId)throw fail('binding_invalid');
      await active();const parent=requireActiveSource(await bounded(()=>this.d.parentStore.load(template.parentSourceRef),5000));
      if(parent.capturedAt>template.capturedAt||!sameEnterprise(enterpriseOf(parent.identity.projection),template.enterprise)
        ||parent.registrationRef!==template.registrationRef||parent.registrationRoot!==template.registrationRoot||parent.browserKey!==template.browserKey
        ||parent.targetId!==template.captureDocument.targetId||canonical(parent.identity.recipe)!==canonical(template.identityRecipe))throw fail('binding_invalid');
      phase='open';let openingEnded=false;
      try{transport=await bounded(async()=>{
        const opened=await this.d.openDiagnostic({registrationRef:template.registrationRef,registrationRoot:template.registrationRoot},
          {registrationBase:dirname(resolve(template.registrationRoot))});
        // A diagnostic that finishes after our deadline must not leak its CDP socket.
        if(openingEnded){try{await opened.close();}catch{}throw fail('operation_timeout');}return opened;
      },30000);}finally{openingEnded=true;}
      await registered();await active();
      // Do not begin an administrator browser operation when the remaining
      // work budget cannot even cover the two read deadlines and navigation.
      if(60000-(this.d.clock()-started)<40000)throw fail('budget_insufficient');
      phase='lock';lockAcquiring=true;lock=await bounded(()=>this.d.acquireLock(transport.localScope.profilePath,
        {scope:{operation:'download_return_to_portal',parentSourceRef:template.parentSourceRef,contextRef:args.contextRef}}),5000);lockAcquiring=false;
      phase='attach';const targetId=template.captureDocument.targetId;
      if((await send('Target.getTargetInfo',{targetId}))?.targetInfo?.type!=='page')throw fail('document_changed');
      unknown=true;attached=await send('Target.attachToTarget',{targetId,flatten:true});
      if(typeof attached?.sessionId!=='string'||!attached.sessionId||typeof transport.cdp.on!=='function')throw fail('document_changed');unknown=false;
      const listen=(name,fn)=>remove.push(transport.cdp.on(name,(p,c)=>{if(c?.sessionId===attached.sessionId)fn(p);}));
      listen('Page.frameNavigated',p=>{if(p.frame?.parentId)return;
        if(!navigating){eventUnknown('main_frame');return;}
        navEvents++;try{navEvent=documentOf(p.frame,targetId);}catch{eventUnknown('main_frame');}
        if(navEvents!==1||navEvent?.frameId!==context.replayDocument.frameId||navEvent?.loaderId===context.replayDocument.loaderId||navEvent?.fullUrl!==PORTAL)eventUnknown('main_frame');
      });
      for(const [name,kind] of [['Page.navigatedWithinDocument','within_document'],['Page.frameDetached','frame_detached'],['Inspector.detached','inspector_detached']])listen(name,()=>eventUnknown(kind));
      listen('Runtime.executionContextCreated',p=>{
        // Runtime.enable enumerates existing contexts before the first identity read.
        if(navigationAttempted===0&&Number.isSafeInteger(p.context?.id)&&p.context.id>0){
          if(oldContextIds.size>=1024)eventUnknown('context_limit');else oldContextIds.add(p.context.id);
        }
      });
      listen('Runtime.executionContextsCleared',()=>{
        // Match the observed portal bootstrap: at most two clears before its
        // unique initial main-frame event. Never carry this allowance into reads.
        if(navigating&&navEvents===0&&initialContextClearCount<2)initialContextClearCount++;
        else eventUnknown('contexts_cleared');
      });
      listen('Runtime.executionContextDestroyed',p=>{
        if(navigating&&oldContextIds.has(p.executionContextId)&&!consumedOldContextIds.has(p.executionContextId))consumedOldContextIds.add(p.executionContextId);
        else eventUnknown('context_destroyed');
      });
      remove.push(transport.cdp.on('Target.detachedFromTarget',p=>{if(p.sessionId===attached.sessionId&&!detachRequested)eventUnknown('target_detached');}));
      await send('Page.enable');await send('Runtime.enable');document=await currentDocument();
      if(canonical(document)!==canonical(context.replayDocument)||unexpected)throw fail('document_changed');
      phase='identity_before';await identity();await guard();
      phase='navigate';navigating=true;navigationAttempted++;unknown=true;
      const navigation=await send('Page.navigate',{url:PORTAL,frameId:document.frameId},12000);
      if(navigation?.errorText){
        if(navEvents===0&&canonical(await currentDocument())===canonical(document)){unknown=false;navigating=false;throw fail('navigation_failed');}
        throw fail('navigation_unknown');
      }
      if(navigation?.isDownload===true||navigation?.frameId!==document.frameId||typeof navigation.loaderId!=='string'
        ||!navigation.loaderId||navigation.loaderId===document.loaderId)throw fail('navigation_unknown');
      const navigationStarted=this.d.clock();
      for(;;){
        await active();await registered();if(unexpected)throw fail('event_unknown');
        const next=await currentDocument();
        if(navEvents===1&&navEvent.loaderId===navigation.loaderId&&canonical(next)===canonical(navEvent)){
          document=next;break;
        }
        if(this.d.clock()-navigationStarted>=12000)throw fail('navigation_unknown');
        await bounded(()=>new Promise(resolve=>setTimeout(resolve,50)),1000);
      }
      navigating=false;unknown=false;navigationConfirmed++;await guard();
      phase='identity_after';await identity();await guard();finalDocument=document;
      result={status:'portal_returned'};
    }catch(error){result={status:'portal_return_failed',phase,reason:REASONS.has(error?.code||error?.message)?error.code||error.message:'operation_failed'};}
    finally{
      const operationSettled=!!finalDocument&&identityMatches===2&&performed===2&&complete===2&&requestUnknown===0&&navigationConfirmed===1&&!unknown&&!unexpected;
      const operationFailurePhase=result?.status==='portal_return_failed'?result.phase:null,operationFailureReason=result?.status==='portal_return_failed'?result.reason:null;
      // Cleanup failure never grants another collector permission to reuse an uncertain browser.
      if(attached?.sessionId){
        try{
          cleanupStep='source_verify';await active(true);cleanupStep='registration_verify';await registered(true);cleanupStep='document_verify';
          if(canonical(await currentDocument(true))!==canonical(document))throw fail('document_changed');
          if(unexpected)throw fail('event_unknown');
        }catch(error){cleanupFailed(cleanupStep,error);finalDocument=null;}
        // Detaching the owned CDP session tears down its enabled domains. A
        // preceding Runtime.disable can itself emit contextsCleared, which must
        // not be confused with an application document change.
        cleanupStep='detach';try{detachRequested=true;await bounded(()=>transport.cdp.send('Target.detachFromTarget',{sessionId:attached.sessionId},{timeoutMs:3000}),3000,true);}
        catch(error){cleanupFailed(cleanupStep,error);}
      }
      cleanupStep='listeners';for(const off of remove)try{off();}catch(error){cleanupFailed(cleanupStep,error);}
      cleanupStep='transport_close';try{if(transport)await bounded(()=>transport.close(),3000,true);}catch(error){cleanupFailed(cleanupStep,error);}
      let lockRetained=lockAcquiring&&unknown;
      if(lock){if(unknown||unexpected){lock.retain();lockRetained=true;}
        else try{cleanupStep='lock_release';await bounded(()=>lock.release(),12000,true);}catch(error){cleanupFailed(cleanupStep,error);lock.retain();lockRetained=true;}}
      if(unexpected&&!cleanupFailureStep){cleanupFailureStep='scope_event';cleanupFailureKind='event_unknown';}
      if(unknown||unexpected){finalDocument=null;result={status:'portal_return_failed',phase:'cleanup',reason:'cleanup_unconfirmed'};}
      result={...result,lockRetained,requestAttemptedCount:attempted,requestPerformedCount:performed,responseCompleteCount:complete,
        requestPerformedUnknownCount:requestUnknown,requestNotPerformedCount:notPerformed,navigationAttemptedCount:navigationAttempted,navigationConfirmedCount:navigationConfirmed,
        operationSettled,operationFailurePhase,operationFailureReason,cleanupFailureStep,cleanupFailureKind,unexpectedEventKind,cleanupConfirmed:!unknown&&!unexpected,
        bootstrapContextClearCount:initialContextClearCount,knownOldContextDestroyCount:consumedOldContextIds.size,
        identityProjectionMatched:identityMatches===2,documentScopeVerified:!!finalDocument,navigationVerified:!!finalDocument&&navigationConfirmed===1,
        downloadPerformed:false,downstreamReady:false};
    }
    return result;
  }
}
