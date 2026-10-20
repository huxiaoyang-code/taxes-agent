// Active reads reuse the registered diagnostic, shared profile lock and identity projection.
import {dirname,resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {openRegisteredBrowserDiagnostic} from './tax-browser-diagnostic.mjs';
import {TaxCollectionStore,collectionLock} from './tax-collection-local.mjs';
import {requireActiveSource,validateRecipe,validateCapture} from './tax-collection-contract.mjs';
import {businessProjection,collectionShape} from './tax-collection-shape.mjs';
import {FULL_FRAME_URL_SEMANTICS,fullFrameUrl} from './tax-frame-url.mjs';
import {TaxHistoryStore} from './tax-history-store.mjs';
import {HISTORY_ORIGIN,exact,canonical,historyFail,historyRef,historyRecipeValid,historyDocumentValid,
  enterpriseOf,sameEnterprise,buildHistoryTemplate,historyProjection,historySummary,compareHistory} from './tax-history-contract.mjs';
const ref=p=>p+'_'+randomBytes(24).toString('hex');
const documentOf=(frame,targetId)=>{const fullUrl=fullFrameUrl(frame);return {targetId,frameId:frame.id,loaderId:frame.loaderId,fullUrl,
  documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,documentUrlDigest:createHash('sha256').update(fullUrl).digest('hex')};};
export function historyRequestScript(recipe,resource,requestRef,url){
  if(!(resource==='identity'?validateRecipe(recipe,'identity'):resource==='filing_history'&&historyRecipeValid(recipe))
    ||!/^taxreq_[a-f0-9]{48}$/.test(requestRef))throw historyFail('history_recipe_invalid');
  try{const u=new URL(url);if(u.href!==url||u.origin!==HISTORY_ORIGIN||u.username||u.password)throw 0;}catch{throw historyFail('history_scope_changed');}
  const address=JSON.stringify(HISTORY_ORIGIN+recipe.path)+(resource==='identity'&&recipe.queryTimestamp?"+'?t='+Date.now()":'');
  return `(async()=>{
    let dispatched=false,performed=false,complete=false;
    const finish=(status,settled,body)=>({status,settled,requestPerformed:dispatched&&!performed?null:performed,responseComplete:complete,
      requestRef:${JSON.stringify(requestRef)},...(status==='observed'?{body}:{})});
    if(location.href!==${JSON.stringify(url)}||location.origin!==${JSON.stringify(HISTORY_ORIGIN)}
      ||!Function.prototype.toString.call(window.fetch).includes('[native code]')
      ||!Function.prototype.toString.call(window.setTimeout).includes('[native code]'))return finish('scope_changed',true);
    const before=location.href,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{dispatched=true;const response=await fetch(${address},{method:${JSON.stringify(recipe.method)},credentials:'same-origin',redirect:'manual',
      cache:'no-store',signal:controller.signal,headers:{Accept:'application/json'${resource==='filing_history'?',"Content-Type":"application/json"':''}}
      ${resource==='filing_history'?',body:'+JSON.stringify(JSON.stringify(recipe.body)):''}});performed=true;
      if(response.type==='opaqueredirect'){if(response.body)await response.body.cancel();return finish('http_failed',true);}
      let text='';if(response.body){const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0;
        for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;
          if(bytes>1048576){await reader.cancel();return finish('oversized',true);}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
      complete=true;if(response.status!==200)return finish('http_failed',true);if(location.href!==before)return finish('scope_changed',true);
      let body;try{body=JSON.parse(text)}catch{return finish('invalid_json',true);}return finish('observed',true,body);
    }catch{return finish('request_unconfirmed',false);}finally{clearTimeout(timer);}
  })()`;
}
const SAFE=['history_template_invalid','history_recipe_missing','history_record_invalid','history_recipe_invalid','history_scope_changed',
  'history_context_expired','history_enterprise_changed','history_business_failed','history_shape_invalid','history_period_invalid',
  'history_request_unconfirmed','history_response_invalid','tax_collection_busy','history_deadline','history_storage_invalid','history_publication_unknown'];
export class TaxHistoryCollection{
  constructor(overrides={}){this.d={store:new TaxHistoryStore(),parentStore:new TaxCollectionStore(),openDiagnostic:openRegisteredBrowserDiagnostic,
    acquireLock:collectionLock,now:Date.now,clock:Date.now,...overrides};}
  async refresh(args={}){return this.#operate(args,true);}
  async collect(args={}){return this.#operate(args,false);}
  async #operate(args,refresh){
    if(!exact(args,[refresh?'artifactRef':'contextRef'])||(refresh?typeof args.artifactRef!=='string'||!/^taxquery_[a-f0-9]{48}$/.test(args.artifactRef):!historyRef(args.contextRef,'context')))
      return {status:'input_invalid'};
    if(this.d.enabled!==true&&process.env.TAX_HISTORY_COLLECTION_ENABLED!=='1')return {status:'not_enabled'};
    let transport,attached,lock,confirmed=true,template,context,templateRef,record,result,document,revision=0,detachRequested=false,
      phase='load',attempted=0,performed=0,complete=0,performedUnknown=0,completeUnknown=0,templatePublished=false,contextPublished=false,runPublished=false,publicationKind;
    const proof=[],remove=[],started=this.d.clock(),deadline=()=>{if(this.d.clock()-started>120000)throw historyFail('history_deadline');};
    const active=async()=>{deadline();await this.d.parentStore.assertNotAbandoned(template.parentSourceRef);deadline();};
    try{
      if(refresh){
        const manifest=await this.d.store.loadArtifact(args.artifactRef,deadline),parent=await this.d.parentStore.load(manifest.sourceRef);deadline();
        template=buildHistoryTemplate(manifest,parent,args.artifactRef);
        if(template.capturedAt>this.d.now())throw historyFail('history_template_invalid');
      }else{
        context=await this.d.store.load(args.contextRef,deadline);templateRef=context.templateRef;template=await this.d.store.load(templateRef,deadline);
        if(context.createdAt>this.d.now()||context.expiresAt<=this.d.now())throw historyFail('history_context_expired');
        if(!sameEnterprise(context.enterprise,template.enterprise)||context.replayDocument.targetId!==template.captureDocument.targetId)
          throw historyFail('history_scope_changed');
      }
      const parent=requireActiveSource(await this.d.parentStore.load(template.parentSourceRef));
      if(!sameEnterprise(enterpriseOf(parent.identity.projection),template.enterprise)||parent.registrationRef!==template.registrationRef
        ||parent.registrationRoot!==template.registrationRoot||parent.browserKey!==template.browserKey||parent.targetId!==template.captureDocument.targetId
        ||canonical(parent.identity.recipe)!==canonical(template.identityRecipe))throw historyFail('history_enterprise_changed');
      await active();phase='open';transport=await this.d.openDiagnostic({registrationRef:template.registrationRef,registrationRoot:template.registrationRoot},
        {registrationBase:dirname(resolve(template.registrationRoot))});deadline();
      if(transport.localScope?.browserKey!==template.browserKey||transport.localScope.registrationState!=='quarantined'
        ||await transport.localScope.currentRegistrationState()!=='quarantined')throw historyFail('history_scope_changed');
      phase='lock';lock=await this.d.acquireLock(transport.localScope.profilePath,{scope:{operation:refresh?'history_context_refresh':'history_collect',
        parentSourceRef:template.parentSourceRef,...refresh?{artifactRef:args.artifactRef}:{contextRef:args.contextRef}}});deadline();
      const cdp=transport.cdp,targetId=template.captureDocument.targetId;phase='attach';
      if((await cdp.send('Target.getTargetInfo',{targetId},{timeoutMs:5000}))?.targetInfo?.type!=='page')throw historyFail('history_scope_changed');
      confirmed=false;attached=await cdp.send('Target.attachToTarget',{targetId,flatten:true},{timeoutMs:5000});
      if(typeof attached?.sessionId!=='string'||typeof cdp.on!=='function')throw historyFail('history_scope_changed');
      confirmed=true;
      const opts={sessionId:attached.sessionId,timeoutMs:5000};
      const listen=(name,fn)=>remove.push(cdp.on(name,(p,c)=>{if(c?.sessionId===attached.sessionId)fn(p)}));
      listen('Page.frameNavigated',p=>{if(!p.frame?.parentId)revision++;});listen('Page.navigatedWithinDocument',()=>revision++);
      listen('Page.frameDetached',()=>revision++);
      for(const event of ['Runtime.executionContextsCleared','Runtime.executionContextDestroyed','Inspector.detached'])listen(event,()=>revision++);
      remove.push(cdp.on('Target.detachedFromTarget',p=>{if(p.sessionId===attached.sessionId&&!detachRequested)revision++;}));
      await cdp.send('Page.enable',{},opts);await cdp.send('Runtime.enable',{},opts);
      document=documentOf((await cdp.send('Page.getFrameTree',{},opts))?.frameTree?.frame,targetId);
      if(revision!==0||!historyDocumentValid(document)||!refresh&&canonical(document)!==canonical(context.replayDocument))throw historyFail('history_scope_changed');
      const guard=async()=>{
        await active();if(revision!==0||await transport.localScope.currentRegistrationState()!=='quarantined')throw historyFail('history_scope_changed');
        const current=documentOf((await cdp.send('Page.getFrameTree',{},opts))?.frameTree?.frame,targetId);
        if(canonical(current)!==canonical(document)||revision!==0)throw historyFail('history_scope_changed');
        if(!refresh&&context.expiresAt<=this.d.now())throw historyFail('history_context_expired');deadline();
      };
      const read=async resource=>{
        await guard();phase=resource;attempted++;confirmed=false;let counted=false;
        try{
          const recipe=resource==='identity'?template.identityRecipe:template.recipe,requestRef=ref('taxreq');
          const reply=await cdp.send('Runtime.evaluate',{expression:historyRequestScript(recipe,resource,requestRef,document.fullUrl),
            returnByValue:true,awaitPromise:true,timeout:10000},{...opts,timeoutMs:11000}),value=reply?.result?.value;
          const matched=!reply?.exceptionDetails&&value?.requestRef===requestRef;
          if(matched&&value.requestPerformed===true)performed++;else if(!matched||value.requestPerformed!==false)performedUnknown++;
          if(matched&&value.responseComplete===true)complete++;else if(!matched||value.responseComplete!==false)completeUnknown++;
          counted=true;
          if(matched&&value.settled===true&&typeof value.requestPerformed==='boolean'&&typeof value.responseComplete==='boolean')confirmed=true;
          if(!matched||value.status!=='observed'||value.settled!==true||value.requestPerformed!==true||value.responseComplete!==true)
            throw historyFail(matched&&value.status==='scope_changed'?'history_scope_changed':matched&&value.settled===true?'history_response_invalid':'history_request_unconfirmed');
          proof.push({requestRef,resource,requestPerformed:true,responseComplete:true});
          if(resource==='identity'){
            if(collectionShape(value.body).businessStatus==='failed')throw historyFail('history_business_failed');
            const projection=businessProjection(value.body,'identity');
            if(!validateCapture({resource:'identity',recipe,projection},'identity'))throw historyFail('history_shape_invalid');
            if(!sameEnterprise(enterpriseOf(projection),template.enterprise))throw historyFail('history_enterprise_changed');
            await guard();return;
          }
          const projection=historyProjection(value.body,recipe);await guard();return projection;
        }catch(error){if(!counted){performedUnknown++;completeUnknown++;}throw error;}
      };
      await read('identity');let projection;if(!refresh)projection=await read('filing_history');await read('identity');await guard();
      const createdAt=this.d.now();
      if(refresh){
        record={version:1,templateRef:null,createdAt,expiresAt:createdAt+1800000,replayDocument:document,enterprise:template.enterprise,operationRef:ref('taxop'),proof};
        result={status:'history_context_refreshed',captureDocumentRetained:true,replayDocumentBound:true};
      }else{
        record={version:1,contextRef:args.contextRef,templateRef,createdAt,enterprise:template.enterprise,operationRef:ref('taxop'),proof,recipe:template.recipe,projection};
        const summary=historySummary(projection);
        result={status:summary.capturedQueryCoverageComplete?'history_query_observed':'history_query_partial',...summary,
          consumable:summary.capturedQueryCoverageComplete,downstreamReady:false,captureComparison:compareHistory(template.captureProjection,projection),
          unverified:['record_identity','version_semantics','correction_relations','request_filter_semantics','all_history','form_dependencies','account_set_binding','project_confirmation','real_two_run_verification']};
      }
      result={...result,documentScopeVerified:true,identityProjectionMatched:true,sessionEnterpriseBound:true,parameterEnterpriseBound:false,responseEnterpriseBound:false,
        verificationTarget:'completed_period',currentPendingPeriodVerified:false,periodVerified:false,projectionComplete:false,obligationVerified:false};
    }catch(error){record=undefined;result={status:refresh?'history_refresh_failed':'history_collection_failed',phase,
      reason:SAFE.includes(error?.code||error?.message)?error.code||error.message:'history_operation_failed'};}
    finally{
      if(attached?.sessionId)for(const method of ['Runtime.disable','Page.disable'])try{await transport.cdp.send(method,{}, {sessionId:attached.sessionId,timeoutMs:5000});}catch{confirmed=false;}
      if(record)try{
        await active();if(revision!==0||await transport.localScope.currentRegistrationState()!=='quarantined')throw 0;
        const current=documentOf((await transport.cdp.send('Page.getFrameTree',{}, {sessionId:attached.sessionId,timeoutMs:5000}))?.frameTree?.frame,document.targetId);
        if(canonical(current)!==canonical(document))throw 0;
      }catch{record=undefined;result={status:refresh?'history_refresh_failed':'history_collection_failed',phase:'scope_cleanup',reason:'history_scope_changed'};}
      if(attached?.sessionId)try{detachRequested=true;await transport.cdp.send('Target.detachFromTarget',{sessionId:attached.sessionId},{timeoutMs:5000});}catch{confirmed=false;}
      if(record&&revision!==0){record=undefined;result={status:refresh?'history_refresh_failed':'history_collection_failed',phase:'scope_cleanup',reason:'history_scope_changed'};}
      for(const off of remove)try{off();}catch{confirmed=false;}
      try{await transport?.close();}catch{confirmed=false;}
      let lockRetained=false;if(lock){if(confirmed)try{await lock.release();}catch{lock.retain();lockRetained=true;}else{lock.retain();lockRetained=true;}}
      if(lockRetained){record=undefined;result={status:refresh?'history_refresh_failed':'history_collection_failed',phase:'cleanup',reason:'history_cleanup_unconfirmed'};}
      const counts={requestAttemptedCount:attempted,requestPerformedCount:performed,responseCompleteCount:complete,
        requestPerformedUnknownCount:performedUnknown,responseCompleteUnknownCount:completeUnknown,requestNotPerformedCount:attempted-performed-performedUnknown,lockRetained};
      result={...result,...counts};
      if(record)try{
        await active();
        if(refresh){publicationKind='template';templateRef=await this.d.store.save('template',template,deadline);templatePublished=true;record.templateRef=templateRef;
          await active();publicationKind='context';const published=await this.d.store.save('context',record,deadline);contextPublished=true;await active();result.contextRef=published;}
        else{publicationKind='run';const published=await this.d.store.save('run',record,deadline);runPublished=true;await active();result.runRef=published;}
      }catch(error){const unknown=error?.code==='history_publication_unknown';result={status:refresh?'history_refresh_failed':'history_collection_failed',phase:'publish',
        reason:unknown?'history_publication_unknown':'history_publish_failed',templatePublished:unknown&&publicationKind==='template'?null:templatePublished,
        contextPublished:unknown&&publicationKind==='context'?null:contextPublished,runPublished:unknown&&publicationKind==='run'?null:runPublished,...counts};}
    }
    return result;
  }
  async compare(args={}){
    if(!exact(args,['leftRef','rightRef'])||!historyRef(args.leftRef,'run')||!historyRef(args.rightRef,'run'))return {status:'input_invalid'};
    if(args.leftRef===args.rightRef)return {status:'not_comparable'};
    if(this.d.enabled!==true&&process.env.TAX_HISTORY_COLLECTION_ENABLED!=='1')return {status:'not_enabled'};
    const started=this.d.clock(),deadline=()=>{if(this.d.clock()-started>120000)throw historyFail('history_deadline');};
    try{
      const left=await this.d.store.load(args.leftRef,deadline),right=await this.d.store.load(args.rightRef,deadline);
      if(left.contextRef!==right.contextRef||left.templateRef!==right.templateRef||left.operationRef===right.operationRef
        ||left.proof.some(p=>right.proof.some(q=>q.requestRef===p.requestRef)))return {status:'not_comparable'};
      const context=await this.d.store.load(left.contextRef,deadline),template=await this.d.store.load(context.templateRef,deadline);
      if(left.templateRef!==context.templateRef||![left,right,context].every(v=>sameEnterprise(v.enterprise,template.enterprise))
        ||[left,right].some(v=>canonical(v.recipe)!==canonical(template.recipe)||v.createdAt<context.createdAt||v.createdAt>=context.expiresAt||v.createdAt>this.d.now()))return {status:'not_comparable'};
      const parent=requireActiveSource(await this.d.parentStore.load(template.parentSourceRef));
      if(!sameEnterprise(enterpriseOf(parent.identity.projection),template.enterprise))return {status:'not_comparable'};
      await this.d.parentStore.assertNotAbandoned(template.parentSourceRef);deadline();
      return {status:'history_runs_compared',independentRequests:true,enterpriseEqual:true,...compareHistory(left.projection,right.projection),
        leftCoverage:historySummary(left.projection),rightCoverage:historySummary(right.projection),
        captureComparisons:{left:compareHistory(template.captureProjection,left.projection),right:compareHistory(template.captureProjection,right.projection)},
        obligationVerified:false,periodVerified:false,currentPendingPeriodVerified:false,projectionComplete:false};
    }catch{return {status:'history_compare_failed'};}
  }
}
