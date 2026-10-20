// Fixed enterprise-query collection. No navigation, actions, arbitrary URLs or
// parameter input. Admin refresh is intentionally absent from Agent/MCP tools.
import {randomBytes,createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {TaxCollectionStore,collectionLock} from './tax-collection-local.mjs';
import {openRegisteredBrowserDiagnostic} from './tax-browser-diagnostic.mjs';
import {validateCapture,requireActiveSource,validateRecipe} from './tax-collection-contract.mjs';
import {businessProjection,collectionShape} from './tax-collection-shape.mjs';
import {fullFrameUrl,FULL_FRAME_URL_SEMANTICS} from './tax-frame-url.mjs';
import {TaxQueryStore} from './tax-query-store.mjs';
import {QUERY_ORIGIN,QUERY_PATHS,exact,queryRef,queryFail,enterpriseOf,sameQueryEnterprise,queryDocumentValid,
  queryRecipeValid,buildQueryTemplate,queryProjection,compareCapturedProjections} from './tax-query-contract.mjs';
const ref=prefix=>prefix+'_'+randomBytes(24).toString('hex');
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
function documentOf(frame,targetId){const fullUrl=fullFrameUrl(frame);return{targetId,frameId:frame.id,loaderId:frame.loaderId,fullUrl,
  documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,documentUrlDigest:createHash('sha256').update(fullUrl).digest('hex')};}
export function queryRequestScript(recipe,resource,requestRef,url){
  if(!(resource==='identity'?validateRecipe(recipe,'identity'):queryRecipeValid(recipe,resource))||!/^taxreq_[a-f0-9]{48}$/.test(requestRef))throw queryFail('query_recipe_invalid');
  const address=resource==='identity'?JSON.stringify(QUERY_ORIGIN+recipe.path)+(recipe.queryTimestamp?"+'?t='+Date.now()":''):
    JSON.stringify(QUERY_ORIGIN+recipe.path+(recipe.query.length?'?'+recipe.query.map(p=>encodeURIComponent(p.key)+'='+encodeURIComponent(p.value)).join('&'):''));
  return `(async()=>{
    let dispatchStarted=false,requestPerformed=false,responseComplete=false;
    const finish=(status,settled,body)=>({status,settled,requestPerformed:dispatchStarted&&!requestPerformed?null:requestPerformed,
      responseComplete,requestRef:${JSON.stringify(requestRef)},...(status==='observed'?{body}:{})});
    if(location.href!==${JSON.stringify(url)}||location.origin!==${JSON.stringify(QUERY_ORIGIN)}
      ||!Function.prototype.toString.call(window.fetch).includes('[native code]')
      ||!Function.prototype.toString.call(window.setTimeout).includes('[native code]'))return finish('scope_changed',true);
    const before=location.href,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{dispatchStarted=true;const response=await fetch(${address},{method:${JSON.stringify(recipe.method)},credentials:'same-origin',
      redirect:'manual',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json'}});
      requestPerformed=true;
      if(response.type==='opaqueredirect'){if(response.body)await response.body.cancel();return finish('http_failed',true);}
      let text='';if(response.body){const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0;
        for(;;){const p=await reader.read();if(p.done)break;bytes+=p.value.byteLength;
          if(bytes>1048576){await reader.cancel();return finish('oversized',true);}text+=decoder.decode(p.value,{stream:true});}text+=decoder.decode();}
      responseComplete=true;if(response.status!==200)return finish('http_failed',true);
      if(location.href!==before)return finish('scope_changed',true);
      let body;try{body=JSON.parse(text)}catch{return finish('invalid_json',true);}
      return finish('observed',true,body);
    }catch{return finish('request_unconfirmed',false);}finally{clearTimeout(timer);}
  })()`;
}
const SAFE=['query_template_invalid','query_recipe_missing','query_record_invalid','query_recipe_invalid','query_scope_changed',
  'query_context_expired','query_enterprise_changed','query_business_failed','query_shape_invalid','query_request_unconfirmed',
  'query_response_invalid','tax_collection_busy','query_deadline','query_storage_invalid','query_publication_unknown'];
export class TaxQueryCollection{
  constructor(overrides={}){this.d={store:new TaxQueryStore(),parentStore:new TaxCollectionStore(),openDiagnostic:openRegisteredBrowserDiagnostic,
    acquireLock:collectionLock,now:Date.now,clock:Date.now,...overrides};}
  async refresh(args={}){return this.#operation(args,true);}
  async collect(args={}){return this.#operation(args,false);}
  async #operation(args,refresh){
    if(!exact(args,[refresh?'artifactRef':'contextRef'])||(refresh?typeof args.artifactRef!=='string'||!/^taxquery_[a-f0-9]{48}$/.test(args.artifactRef):!queryRef(args.contextRef,'context')))
      return{status:'input_invalid'};
    if(this.d.enabled!==true&&process.env.TAX_QUERY_COLLECTION_ENABLED!=='1')return{status:'not_enabled'};
    let transport,attached,lock,confirmed=true,template,context,templateRef,record,result,document,revision=0,detachRequested=false,
      phase='load',attempted=0,performed=0,complete=0,performedUnknown=0,completeUnknown=0,templatePublished=false,publicationKind=null;const proof=[],remove=[],started=this.d.clock();
    const deadline=()=>{if(this.d.clock()-started>120000)throw queryFail('query_deadline');};
    try{
      if(refresh){
        const manifest=await this.d.store.loadArtifact(args.artifactRef,deadline);deadline();const parent=await this.d.parentStore.load(manifest.sourceRef);deadline();
        await this.d.parentStore.assertNotAbandoned(manifest.sourceRef);
        template=buildQueryTemplate(manifest,parent,manifest.sourceRef,args.artifactRef);
        if(template.capturedAt>this.d.now())throw queryFail('query_template_invalid');
      }else{
        context=await this.d.store.load(args.contextRef,deadline);templateRef=context.templateRef;template=await this.d.store.load(templateRef,deadline);
        if(context.createdAt>this.d.now()||context.expiresAt<=this.d.now())throw queryFail('query_context_expired');
        if(!sameQueryEnterprise(context.enterprise,template.enterprise)||context.replayDocument.targetId!==template.captureDocument.targetId)throw queryFail('query_scope_changed');
      }
      const parent=requireActiveSource(await this.d.parentStore.load(template.parentSourceRef));
      if(!sameQueryEnterprise(enterpriseOf(parent.identity.projection),template.enterprise))throw queryFail('query_enterprise_changed');
      await this.d.parentStore.assertNotAbandoned(template.parentSourceRef);phase='open';deadline();
      transport=await this.d.openDiagnostic({registrationRef:template.registrationRef,registrationRoot:template.registrationRoot},
        {registrationBase:dirname(resolve(template.registrationRoot))});
      deadline();
      if(transport.localScope?.browserKey!==template.browserKey||transport.localScope.registrationState!=='quarantined'
        ||await transport.localScope.currentRegistrationState()!=='quarantined')throw queryFail('query_scope_changed');
      phase='lock';lock=await this.d.acquireLock(transport.localScope.profilePath,{scope:{operation:refresh?'query_context_refresh':'query_collect',
        parentSourceRef:template.parentSourceRef,...refresh?{artifactRef:args.artifactRef}:{contextRef:args.contextRef}}});
      deadline();
      const cdp=transport.cdp, targetId=template.captureDocument.targetId;phase='attach';
      if((await cdp.send('Target.getTargetInfo',{targetId},{timeoutMs:5000}))?.targetInfo?.type!=='page')throw queryFail('query_scope_changed');
      attached=await cdp.send('Target.attachToTarget',{targetId,flatten:true},{timeoutMs:5000});
      if(typeof attached?.sessionId!=='string'||typeof cdp.on!=='function')throw queryFail('query_scope_changed');
      const opts={sessionId:attached.sessionId,timeoutMs:5000};
      const listen=(name,fn)=>remove.push(cdp.on(name,(p,c)=>{if(c?.sessionId===attached.sessionId)fn(p)}));
      listen('Page.frameNavigated',p=>{if(!p.frame?.parentId)revision++;});
      listen('Page.navigatedWithinDocument',()=>revision++);listen('Page.frameDetached',()=>revision++);
      for(const event of ['Runtime.executionContextsCleared','Runtime.executionContextDestroyed','Inspector.detached'])listen(event,()=>revision++);
      remove.push(cdp.on('Target.detachedFromTarget',p=>{if(p.sessionId===attached.sessionId&&!detachRequested)revision++;}));
      await cdp.send('Page.enable',{},opts);await cdp.send('Runtime.enable',{},opts);
      document=documentOf((await cdp.send('Page.getFrameTree',{},opts))?.frameTree?.frame,targetId);
      if(revision!==0||!queryDocumentValid(document)||!refresh&&canonical(document)!==canonical(context.replayDocument))throw queryFail('query_scope_changed');
      const guard=async()=>{
        deadline();if(revision!==0||await transport.localScope.currentRegistrationState()!=='quarantined')throw queryFail('query_scope_changed');
        const current=documentOf((await cdp.send('Page.getFrameTree',{},opts))?.frameTree?.frame,targetId);
        if(canonical(current)!==canonical(document)||revision!==0)throw queryFail('query_scope_changed');
        await this.d.parentStore.assertNotAbandoned(template.parentSourceRef);
        if(!refresh&&context.expiresAt<=this.d.now())throw queryFail('query_context_expired');deadline();
      };
      const read=async resource=>{
        await guard();phase=resource;attempted++;confirmed=false;
        let replyCounted=false;
        try{
          const recipe=resource==='identity'?template.identityRecipe:resource==='getUserMsg'?template.getUserMsgRecipe:template.recipes[resource],requestRef=ref('taxreq');
          const reply=await cdp.send('Runtime.evaluate',{expression:queryRequestScript(recipe,resource,requestRef,document.fullUrl),
            returnByValue:true,awaitPromise:true,timeout:10000},{...opts,timeoutMs:11000}),value=reply?.result?.value;
          const matched=!reply?.exceptionDetails&&value?.requestRef===requestRef;
          if(matched&&value.requestPerformed===true)performed++;else if(!matched||value.requestPerformed!==false)performedUnknown++;
          if(matched&&value.responseComplete===true)complete++;else if(!matched||value.responseComplete!==false)completeUnknown++;
          replyCounted=true;
          if(matched&&value?.settled===true&&typeof value.requestPerformed==='boolean'&&typeof value.responseComplete==='boolean')confirmed=true;
          if(reply?.exceptionDetails||value?.status!=='observed'||value.settled!==true||value.requestPerformed!==true
            ||value.responseComplete!==true||value.requestRef!==requestRef)throw queryFail(matched&&value?.status==='scope_changed'?'query_scope_changed':value?.settled===true?'query_response_invalid':'query_request_unconfirmed');
          proof.push({requestRef,resource,requestPerformed:true,responseComplete:true});
          if(resource==='identity'){
            if(collectionShape(value.body).businessStatus==='failed')throw queryFail('query_business_failed');
            const projection=businessProjection(value.body,'identity');
            if(!validateCapture({resource:'identity',recipe,projection},'identity'))throw queryFail('query_shape_invalid');
            const enterprise=enterpriseOf(projection);if(!sameQueryEnterprise(enterprise,template.enterprise))throw queryFail('query_enterprise_changed');
            await guard();return enterprise;
          }
          const projection=queryProjection(value.body,resource,template.enterprise,template.recipes.enterprise_profile.query[0].value);
          if(resource==='income_assessment'&&(projection.PageNumber!==Number(recipe.query[0].value)||projection.PageSize!==Number(recipe.query[1].value)))throw queryFail('query_shape_invalid');
          await guard();return projection;
        }catch(error){if(!replyCounted){performedUnknown++;completeUnknown++;}if(error.settled===true)confirmed=true;throw error;}
      };
      await read('identity');await read('getUserMsg');
      if(refresh){
        await read('identity');await guard();const createdAt=this.d.now();
        record={version:1,templateRef:null,createdAt,expiresAt:createdAt+1800000,replayDocument:document,enterprise:template.enterprise,
          operationRef:ref('taxop'),proof};
        result={status:'query_context_refreshed',captureDocumentRetained:true,replayDocumentBound:true,documentScopeVerified:true,
          identityProjectionMatched:true,djxhMatched:true,businessScopeVerified:false,periodVerified:false,projectionComplete:false};
      }else{
        const projections={};for(const resource of ['basic_profile','enterprise_profile','income_assessment'])projections[resource]=await read(resource);
        await read('getUserMsg');await read('identity');await guard();
        const captureComparison=compareCapturedProjections(template.captureProjections,projections);
        record={version:1,contextRef:args.contextRef,templateRef,createdAt:this.d.now(),enterprise:template.enterprise,operationRef:ref('taxop'),proof,projections,captureDiff:captureComparison.diff};
        result={status:'query_resources_observed',documentScopeVerified:true,identityProjectionMatched:true,djxhMatched:true,
          businessRequestCount:3,verificationRequestCount:4,businessScopeVerified:false,enterpriseVerified:false,periodVerified:false,projectionComplete:false,
          resources:{basic_profile:{responseEnterpriseBound:true,fieldCount:Object.keys(projections.basic_profile).length},
            enterprise_profile:{responseEnterpriseBound:true,fieldCount:Object.keys(projections.enterprise_profile).length},
            income_assessment:projections.income_assessment},captureComparison:captureComparison.summary,missing:['business_period','complete_business_coverage']};
      }
    }catch(error){record=undefined;result={status:refresh?'query_refresh_failed':'query_collection_failed',phase,
      reason:SAFE.includes(error?.code||error?.message)?error.code||error.message:'query_operation_failed'};}
    finally{
      if(attached?.sessionId)for(const method of ['Runtime.disable','Page.disable'])try{
        await transport.cdp.send(method,{}, {sessionId:attached.sessionId,timeoutMs:5000});
      }catch{confirmed=false;}
      if(record)try{if(revision!==0||await transport.localScope.currentRegistrationState()!=='quarantined')throw 0;
        const current=documentOf((await transport.cdp.send('Page.getFrameTree',{}, {sessionId:attached.sessionId,timeoutMs:5000}))?.frameTree?.frame,document.targetId);
        if(canonical(current)!==canonical(document))throw 0;
      }catch{record=undefined;result={status:refresh?'query_refresh_failed':'query_collection_failed',phase:'scope_cleanup',reason:'query_scope_changed'};}
      if(attached?.sessionId)try{detachRequested=true;await transport.cdp.send('Target.detachFromTarget',{sessionId:attached.sessionId},{timeoutMs:5000})}catch{confirmed=false;}
      if(record&&revision!==0){record=undefined;result={status:refresh?'query_refresh_failed':'query_collection_failed',phase:'scope_cleanup',reason:'query_scope_changed'};}
      for(const off of remove)try{off()}catch{confirmed=false;}
      try{await transport?.close()}catch{confirmed=false;}
      let lockRetained=false;
      if(lock){if(confirmed)try{await lock.release()}catch{lock.retain();lockRetained=true;}else{lock.retain();lockRetained=true;}}
      if(lockRetained){record=undefined;result={status:refresh?'query_refresh_failed':'query_collection_failed',phase:'cleanup',reason:'query_cleanup_unconfirmed'};}
      result={...result,requestAttemptedCount:attempted,requestPerformedCount:performed,responseCompleteCount:complete,
        requestPerformedUnknownCount:performedUnknown,responseCompleteUnknownCount:completeUnknown,
        requestNotPerformedCount:attempted-performed-performedUnknown,lockRetained};
      if(record)try{
        await this.d.parentStore.assertNotAbandoned(template.parentSourceRef);
        if(refresh){publicationKind='template';templateRef=await this.d.store.save('template',template,deadline);templatePublished=true;record.templateRef=templateRef;
          publicationKind='context';result.contextRef=await this.d.store.save('context',record,deadline);result.templatePublished=true;result.contextPublished=true;}
        else{publicationKind='run';result.runRef=await this.d.store.save('run',record,deadline);}
      }catch(error){const unknown=error?.code==='query_publication_unknown';
        result={status:refresh?'query_refresh_failed':'query_collection_failed',phase:'publish',reason:unknown?'query_publication_unknown':'query_publish_failed',
        templatePublished:unknown&&publicationKind==='template'?null:templatePublished,
        contextPublished:unknown&&publicationKind==='context'?null:false,runPublished:unknown&&publicationKind==='run'?null:false,requestAttemptedCount:attempted,
        requestPerformedCount:performed,responseCompleteCount:complete,requestPerformedUnknownCount:performedUnknown,
        responseCompleteUnknownCount:completeUnknown,lockRetained:false};}
    }
    return result;
  }
  async compare(args={}){
    if(!exact(args,['leftRef','rightRef'])||!queryRef(args.leftRef,'run')||!queryRef(args.rightRef,'run'))return{status:'input_invalid'};
    if(args.leftRef===args.rightRef)return{status:'not_comparable'};
    const started=this.d.clock(),deadline=()=>{if(this.d.clock()-started>120000)throw queryFail('query_deadline');};
    try{
      const left=await this.d.store.load(args.leftRef,deadline),right=await this.d.store.load(args.rightRef,deadline);
      if(left.contextRef!==right.contextRef||left.templateRef!==right.templateRef||left.operationRef===right.operationRef
        ||left.proof.some(p=>right.proof.some(q=>q.requestRef===p.requestRef)))return{status:'not_comparable'};
      const context=await this.d.store.load(left.contextRef,deadline),template=await this.d.store.load(context.templateRef,deadline);
      if(left.templateRef!==context.templateRef||!sameQueryEnterprise(left.enterprise,context.enterprise)||!sameQueryEnterprise(right.enterprise,context.enterprise)
        ||!sameQueryEnterprise(context.enterprise,template.enterprise))return{status:'not_comparable'};
      if([left,right].some(run=>run.projections.income_assessment.PageNumber!==Number(template.recipes.income_assessment.query[0].value)
        ||run.projections.income_assessment.PageSize!==Number(template.recipes.income_assessment.query[1].value)))return{status:'not_comparable'};
      await this.d.parentStore.assertNotAbandoned(template.parentSourceRef);
      if(left.createdAt<context.createdAt||right.createdAt<context.createdAt||left.createdAt>context.expiresAt||right.createdAt>context.expiresAt
        ||left.createdAt>this.d.now()||right.createdAt>this.d.now())return{status:'not_comparable'};
      const leftCapture=compareCapturedProjections(template.captureProjections,left.projections),rightCapture=compareCapturedProjections(template.captureProjections,right.projections);
      if(canonical(left.captureDiff)!==canonical(leftCapture.diff)||canonical(right.captureDiff)!==canonical(rightCapture.diff))return{status:'not_comparable'};
      const basicComparable=leftCapture.summary.basic_profile.comparable&&rightCapture.summary.basic_profile.comparable,
        enterpriseComparable=leftCapture.summary.enterprise_profile.comparable&&rightCapture.summary.enterprise_profile.comparable;
      return{status:'query_runs_compared',independentRequests:true,enterpriseEqual:sameQueryEnterprise(left.enterprise,right.enterprise),
        basicProfileComparable:basicComparable,basicProfileEqual:basicComparable&&canonical(left.projections.basic_profile)===canonical(right.projections.basic_profile),
        enterpriseProfileComparable:enterpriseComparable,enterpriseProfileEqual:enterpriseComparable&&canonical(left.projections.enterprise_profile)===canonical(right.projections.enterprise_profile),
        captureComparisons:{left:leftCapture.summary,right:rightCapture.summary},
        incomePaginationEqual:canonical(left.projections.income_assessment)===canonical(right.projections.income_assessment),
        incomeRowsCompared:false,obligationVerified:false,periodVerified:false,projectionComplete:false};
    }catch{return{status:'query_compare_failed'};}
  }
}
