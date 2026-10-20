// Active replay is restricted to a fresh, privately stored authorized navigation.
import {dirname,resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {openRegisteredBrowserDiagnostic} from './tax-browser-diagnostic.mjs';
import {TaxCollectionStore,collectionLock} from './tax-collection-local.mjs';
import {validateCapture,requireActiveSource,validateRecipe} from './tax-collection-contract.mjs';
import {businessProjection,collectionShape} from './tax-collection-shape.mjs';
import {FULL_FRAME_URL_SEMANTICS,fullFrameUrl} from './tax-frame-url.mjs';
const ORIGIN='https://etax.fujian.chinatax.gov.cn:8443';
const fail=code=>{const e=new Error(code);e.code=code;return e};
export const sameEnterprise=(a,b)=>typeof a?.userinfo?.reg_number==='string'&&a.userinfo.reg_number.trim().length>0
  &&typeof a.userinfo.company_name==='string'&&a.userinfo.company_name.trim().length>0
  &&a.userinfo.reg_number===b?.userinfo?.reg_number&&a.userinfo.company_name===b.userinfo.company_name;
export function liveRequestScript(recipe,resource,requestRef,expectedFullUrl){
  if(!validateRecipe(recipe,resource))throw fail('tax_collection_recipe_invalid');
  if(!/^taxreq_[a-f0-9]{48}$/.test(requestRef||''))throw fail('tax_collection_recipe_invalid');
  try{const expected=new URL(expectedFullUrl);if(typeof expectedFullUrl!=='string'||expected.href!==expectedFullUrl
    ||expected.origin!==ORIGIN||expected.username||expected.password)throw 0;}catch{throw fail('tax_collection_scope_changed');}
  return `(async()=>{
    const current=new URL(location.href);
    if(current.origin!==${JSON.stringify(ORIGIN)}||current.username||current.password
      ||!Function.prototype.toString.call(window.fetch).includes('[native code]')
      ||!Function.prototype.toString.call(window.setTimeout).includes('[native code]'))return{status:'scope_invalid',settled:true};
    if(location.href!==${JSON.stringify(expectedFullUrl)})return{status:'scope_changed',settled:true};
    const before=location.href,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await fetch(${JSON.stringify(ORIGIN+recipe.path)}${recipe.queryTimestamp?"+'?t='+Date.now()":''},
        {method:${JSON.stringify(recipe.method)},credentials:'same-origin',redirect:'manual',cache:'no-store',signal:controller.signal,
          headers:{Accept:'application/json'${recipe.method==='POST'?',"Content-Type":"application/json"':''}}
          ${recipe.method==='POST'?',body:'+JSON.stringify(JSON.stringify(recipe.body)):''}});
      if(response.status!==200||response.type==='opaqueredirect'){if(response.body)await response.body.cancel();return{status:'request_failed',settled:true};}
      if(!response.body)return{status:'invalid_json',settled:true};
      const reader=response.body.getReader(),decoder=new TextDecoder();let text='',bytes=0;
      for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;
        if(bytes>1048576){await reader.cancel();return{status:'response_too_large',settled:true};}text+=decoder.decode(part.value,{stream:true});}
      text+=decoder.decode();if(location.href!==before)return{status:'scope_changed',settled:true};
      let body;try{body=JSON.parse(text)}catch{return{status:'invalid_json',settled:true};}
      return{status:'observed',settled:true,requestPerformed:true,responseComplete:true,requestRef:${JSON.stringify(requestRef)},body};
    }catch{return{status:'request_unconfirmed',settled:false};}finally{clearTimeout(timer);}
  })()`;
}
export async function readLiveResource(cdp,opts,recipe,resource,expectedFullUrl){
  const requestRef='taxreq_'+randomBytes(24).toString('hex');
  const result=await cdp.send('Runtime.evaluate',{expression:liveRequestScript(recipe,resource,requestRef,expectedFullUrl),returnByValue:true,awaitPromise:true,timeout:15000},
    {...opts,timeoutMs:16000});
  const value=result?.result?.value;
  if(result?.exceptionDetails||value?.status!=='observed'||value.settled!==true||value.requestPerformed!==true
    ||value.responseComplete!==true||value.requestRef!==requestRef){
    const error=fail(value?.settled===true&&['scope_invalid','scope_changed'].includes(value.status)?'tax_collection_scope_changed'
      :value?.settled===true?'tax_collection_response_invalid':'tax_collection_request_unconfirmed');error.settled=value?.settled===true;throw error;}
  const shape=collectionShape(value.body);
  if(shape.businessStatus==='failed'){const error=fail('tax_collection_business_failed');error.settled=true;throw error;}
  const projection=businessProjection(value.body,resource),capture={resource,recipe,projection};
  if(!validateCapture(capture,resource)){const error=fail('tax_collection_projection_invalid');error.settled=true;throw error;}
  return{capture,shape,proof:{requestRef,resource,requestPerformed:true,responseComplete:true}};
}
export async function assertLiveFrame(cdp,opts,source){
  if(source?.version!==2||source.documentUrlSemantics!==FULL_FRAME_URL_SEMANTICS
    ||! /^[a-f0-9]{64}$/.test(source.documentUrlDigest||''))throw fail('tax_collection_scope_changed');
  const tree=await cdp.send('Page.getFrameTree',{},opts),frame=tree?.frameTree?.frame;
  if(frame?.id!==source.frameId||frame?.loaderId!==source.loaderId)throw fail('tax_collection_scope_changed');
  let full;try{full=fullFrameUrl(frame);const u=new URL(full);if(u.origin!==ORIGIN||u.username||u.password)throw 0;}catch{throw fail('tax_collection_scope_changed')}
  if(createHash('sha256').update(full).digest('hex')!==source.documentUrlDigest)throw fail('tax_collection_scope_changed');
  return full;
}
const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)
  ?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v);
export function compareProjections(left,right){
  return{enterpriseEqual:sameEnterprise(left.identity.projection,right.identity.projection),
    identityProjectionEqual:canonical(left.identity.projection)===canonical(right.identity.projection),
    filingProjectionEqual:canonical(left.filing.projection.wsbxxGrid)===canonical(right.filing.projection.wsbxxGrid),
    leftRowCount:left.filing.projection.rowCount,rightRowCount:right.filing.projection.rowCount,
    projectionComplete:false,periodVerified:false};
}
export class TaxLiveCollection{
  constructor(overrides={}){this.d={store:new TaxCollectionStore(),openDiagnostic:openRegisteredBrowserDiagnostic,
    acquireLock:collectionLock,now:Date.now,...overrides};}
  async collect(args={}){
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>k!=='sourceRef')
      ||!/^taxsource_[a-f0-9]{48}$/.test(args.sourceRef||''))return{status:'input_invalid'};
    if(!this.d.enabled&&process.env.TAX_LIVE_COLLECTION_ENABLED!=='1')return{status:'not_enabled'};
    let transport,attached,lock,confirmed=true,record,result,phase='load';const remove=[];
    try{
      const source=requireActiveSource(await this.d.store.load(args.sourceRef));
      if(this.d.now()-source.capturedAt>1800000||source.capturedAt>this.d.now())throw fail('tax_collection_source_expired');
      phase='open';transport=await this.d.openDiagnostic({registrationRef:source.registrationRef,registrationRoot:source.registrationRoot},
        {registrationBase:dirname(resolve(source.registrationRoot))});
      if(transport.localScope?.browserKey!==source.browserKey||transport.localScope.registrationState!=='quarantined'
        ||await transport.localScope.currentRegistrationState()!=='quarantined')throw fail('tax_collection_scope_changed');
      phase='lock';lock=await this.d.acquireLock(transport.localScope.profilePath,{scope:{sourceRef:args.sourceRef,operation:'active_replay'}});
      const cdp=transport.cdp;
      phase='attach';const info=await cdp.send('Target.getTargetInfo',{targetId:source.targetId},{timeoutMs:5000});
      if(info?.targetInfo?.type!=='page')throw fail('tax_collection_scope_changed');
      attached=await cdp.send('Target.attachToTarget',{targetId:source.targetId,flatten:true},{timeoutMs:5000});
      if(typeof attached?.sessionId!=='string')throw fail('tax_collection_scope_changed');
      const opts={sessionId:attached.sessionId,timeoutMs:5000};
      let revision=0;
      if(typeof cdp.on!=='function')throw fail('tax_collection_scope_changed');
      const listen=(name,handler)=>remove.push(cdp.on(name,(p,c)=>{if(c?.sessionId===attached.sessionId)handler(p)}));
      listen('Page.frameNavigated',p=>{if(p.frame?.id===source.frameId)revision++});
      listen('Page.navigatedWithinDocument',p=>{if(p.frameId===source.frameId)revision++});
      listen('Page.frameDetached',p=>{if(p.frameId===source.frameId)revision++});
      listen('Runtime.executionContextsCleared',()=>revision++);
      listen('Runtime.executionContextDestroyed',()=>revision++);
      listen('Inspector.detached',()=>revision++);
      remove.push(cdp.on('Target.detachedFromTarget',p=>{if(p.sessionId===attached.sessionId)revision++}));
      await cdp.send('Page.enable',{},opts);await cdp.send('Runtime.enable',{},opts);
      await assertLiveFrame(cdp,opts,source);const baselineRevision=revision;
      const read=async(resource,recipe)=>{
        if(await transport.localScope.currentRegistrationState()!=='quarantined')throw fail('tax_collection_scope_changed');
        if(revision!==baselineRevision)throw fail('tax_collection_scope_changed');
        const expectedFullUrl=await assertLiveFrame(cdp,opts,source);confirmed=false;
        let value;try{value=await readLiveResource(cdp,opts,recipe,resource,expectedFullUrl);confirmed=true;}catch(error){if(error.settled===true)confirmed=true;throw error;}
        await assertLiveFrame(cdp,opts,source);
        if(await transport.localScope.currentRegistrationState()!=='quarantined'||revision!==baselineRevision)throw fail('tax_collection_scope_changed');return value;
      };
      phase='identity_before';const before=await read('identity',source.identity.recipe);
      if(!sameEnterprise(source.identity.projection,before.capture.projection))throw fail('tax_collection_enterprise_changed');
      phase='current_filing';const filing=await read('current_filing',source.filing.recipe);
      phase='identity_after';const after=await read('identity',source.identity.recipe);
      if(!sameEnterprise(before.capture.projection,after.capture.projection))throw fail('tax_collection_enterprise_changed');
      record={version:1,sourceRef:args.sourceRef,capturedAt:this.d.now(),identity:after.capture,filing:filing.capture,
        operationRef:'taxop_'+randomBytes(24).toString('hex'),requestProof:[before.proof,filing.proof,after.proof]};
      result={status:'partial_observed',documentScopeVerified:true,identityProjectionMatched:true,businessScopeVerified:false,
        scopeVerified:false,enterpriseVerified:false,periodVerified:false,requestPerformedCount:3,responseCompleteCount:3,
        projectionComplete:false,requestCount:3,comparison:compareProjections(source,record),
        filingShape:filing.shape,identityShape:after.shape,missing:['business_period','full_enterprise_profile','full_business_fields']};
    }catch(error){result={status:'collection_failed',phase,
      reason:['tax_collection_scope_changed','tax_collection_source_expired','tax_collection_source_reobservation_required','tax_collection_enterprise_changed','tax_collection_busy',
        'tax_collection_request_unconfirmed','tax_collection_projection_invalid','tax_collection_business_failed'].includes(error?.code||error?.message)?error.code||error.message:'tax_collection_failed',
      scopeVerified:false,periodVerified:false};}
    finally{
      for(const off of remove)try{off()}catch{confirmed=false;}
      if(attached?.sessionId)for(const method of ['Runtime.disable','Page.disable'])
        try{await transport.cdp.send(method,{}, {sessionId:attached.sessionId,timeoutMs:5000})}catch{confirmed=false;}
      if(attached?.sessionId)try{await transport.cdp.send('Target.detachFromTarget',{sessionId:attached.sessionId},{timeoutMs:5000})}catch{confirmed=false;}
      try{transport?.close()}catch{confirmed=false;}
      let lockRetained=false;
      if(lock){if(confirmed)try{await lock.release()}catch{lock.retain();lockRetained=true}else{lock.retain();lockRetained=true}}
      if(result)result.lockRetained=lockRetained;
      if(record&&!lockRetained){try{result.runRef=await this.d.store.save('run',record)}catch{result={status:'collection_failed',phase:'persist',scopeVerified:false,periodVerified:false,lockRetained:false}}}
      else if(record)result={status:'collection_failed',phase:'cleanup',scopeVerified:false,periodVerified:false,lockRetained};
    }
    return result;
  }
  async compare(args={}){
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['leftRef','rightRef'].includes(k))
      ||!/^tax(?:source|run)_[a-f0-9]{48}$/.test(args.leftRef||'')||!/^tax(?:source|run)_[a-f0-9]{48}$/.test(args.rightRef||''))return{status:'input_invalid'};
    if(args.leftRef===args.rightRef)return{status:'not_comparable'};
    try{const left=await this.d.store.load(args.leftRef),right=await this.d.store.load(args.rightRef);
      const leftSource=args.leftRef.startsWith('taxsource_')?args.leftRef:left.sourceRef;
      const rightSource=args.rightRef.startsWith('taxsource_')?args.rightRef:right.sourceRef;
      if(leftSource!==rightSource||left.operationRef&&left.operationRef===right.operationRef)return{status:'not_comparable'};
      const source=await this.d.store.load(leftSource);
      if([left,right].some(record=>record.capturedAt<source.capturedAt||record.capturedAt>this.d.now()))return{status:'not_comparable'};
      return{status:'compared',independentRequests:true,...compareProjections(left,right)};
    }catch{return{status:'comparison_failed'}}
  }
}
