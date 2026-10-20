// Local administrator discovery only; never an HTTP/Agent/MCP capability.
import {dirname,resolve} from 'node:path';
import {TaxDownloadPageStore} from './tax-download-page.mjs';
import {TaxCollectionStore,collectionLock} from './tax-collection-local.mjs';
import {openRegisteredBrowserDiagnostic} from './tax-browser-diagnostic.mjs';
import {acquireReadonlyAdminGuard} from './tax-readonly-abandon.mjs';
import {fullFrameUrl} from './tax-frame-url.mjs';
const MODE='financial_normal_navigation_passive_v1',LIMIT=2097152,TOTAL=8388608;
const METHODS=Object.freeze({getCwbbzlList:'GET',queryZlbscjb:'POST'});
const fail=()=>Error('financial_passive_failed'),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const ref=(v,p)=>typeof v==='string'&&new RegExp('^'+p+'_[a-f0-9]{48}$').test(v);
const credential=k=>/auth|token|ticket|nonce|password|passwd|cookie|session|secret|credential|sso|oauth|^(?:code|sign)$/i.test(k);
function address(raw){try{const u=new URL(raw);return u.href===raw&&u.protocol==='https:'&&!u.username&&!u.password
  &&u.hostname.endsWith('.chinatax.gov.cn')&&!u.hostname.startsWith('tpass.')&&['','443','8443'].includes(u.port)?u:null;}catch{return null;}}
function documentAddress(raw){const u=address(raw);if(!u)return null;
  let hash;try{hash=decodeURIComponent(u.hash);}catch{return null;}
  if(/login|passport|callback|oauth|(?:^|\/)sso(?:\/|$)|(?:submit|save|delete|remove|update|modify|correct|cancel|revoke|void|commit|payment|makeout|issue|register|logout)/i.test(u.pathname+hash.split('?')[0])
    ||[...u.searchParams.keys()].some(credential)||/(?:^|[?&#])(?:[^=&#]*?(?:auth|token|ticket|nonce|password|cookie|session|secret|credential|oauth|sso)|code|sign)=/i.test(hash)
    ||/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(hash))return null;
  return u;
}
function shape(value){
  const containers=new Set(['Response','Data','data','result','rows','records','list','content','success','total','totalCount','count','code','returnCode']);
  const schema=[],paths=new Set(),counts={arrays:0,maxArrayLength:0,objects:0,maxFieldCount:0,strings:0,numbers:0,booleans:0,nulls:0};let nodes=0,namedNodes=0,truncated=false;
  const walk=(v,depth)=>{if(++nodes>10000||depth>6){truncated=true;return;}if(v===null){counts.nulls++;return;}
    if(Array.isArray(v)){counts.arrays++;counts.maxArrayLength=Math.max(counts.maxArrayLength,v.length);for(const item of v.slice(0,1000))walk(item,depth+1);if(v.length>1000)truncated=true;}
    else if(typeof v==='object'){counts.objects++;const values=Object.values(v);counts.maxFieldCount=Math.max(counts.maxFieldCount,values.length);for(const item of values.slice(0,1000))walk(item,depth+1);if(values.length>1000)truncated=true;}
    else if(typeof v==='string')counts.strings++;else if(typeof v==='number')counts.numbers++;else if(typeof v==='boolean')counts.booleans++;
  };
  const named=(v,path,depth)=>{if(++namedNodes>10000||depth>6||schema.length>=64){truncated=true;return;}
    const kind=v===null?'null':Array.isArray(v)?'array':typeof v;
    if(!paths.has(path)){paths.add(path);schema.push({path,kind,fieldCount:kind==='object'?Object.keys(v).length:null,arrayCount:kind==='array'?v.length:null,
      unknownFieldCount:kind==='object'?Object.keys(v).filter(k=>!containers.has(k)).length:null});}
    if(kind==='array')for(const item of v.slice(0,20))named(item,path+'[]',depth+1);
    else if(kind==='object')for(const key of Object.keys(v))if(containers.has(key))named(v[key],path+'.'+key,depth+1);
  };
  walk(value,0);named(value,'$',0);return{schema,schemaTruncated:truncated,typeCounts:counts,businessStatus:'unverified',rowCountVerified:false};
}
export class TaxDownloadFinancialPassive{
  constructor(overrides={}){this.d={enabled:false,evidence:new TaxDownloadPageStore(),store:new TaxCollectionStore(),openDiagnostic:openRegisteredBrowserDiagnostic,
    acquireAdminGuard:acquireReadonlyAdminGuard,acquireLock:collectionLock,now:Date.now,clock:Date.now,wait:ms=>new Promise(done=>setTimeout(done,ms)),...overrides};}
  async capture(args={}){
    const counts={requestEvents:0,mainDocuments:0,redirects:0,matchedRequests:0,bodyReads:0,bodyUnavailable:0,bodyDiscarded:0,retainedBodies:0,retainedBytes:0};
    const out={mode:MODE,status:'financial_passive_failed',evidence:'quarantined_unverified',enterpriseBinding:false,consumable:false,requestAuthorized:false,
      sourceDocumentReused:false,runtimeEvaluated:false,directApiRequests:0,downloadPerformed:false,navigationAttempted:false,navigationConfirmed:false,
      cleanupConfirmed:false,lockRetained:false,adminGuardUnconfirmed:false,scopeSealed:false,truncated:false,counts,responseShapes:[],safeAssetRefs:[]};
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).sort().join(',')!=='navigationArtifactRef,snapshotRef'
      ||!ref(args.snapshotRef,'taxdownloadpage')||!ref(args.navigationArtifactRef,'taxdownloadpage'))return{...out,status:'input_invalid'};
    if(this.d.enabled!==true)return{...out,status:'not_enabled'};
    const started=this.d.clock(),off=[],requests=new Map(),endpoints=new Map(),observedDocuments=new Set(),retainedRefs=[];
    let nav,snapshot,source,transport,session,admin,lock,initial,final,revision=0,sealed=false,invalid=false,detaching=false,closing=false,
      attachUnknown=false,navUnknown=false,lockAcquiring=false,cleanupBad=false,phase='validation',prepared,readBytes=0;
    const bounded=async(fn,ms)=>{let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,no)=>{timer=setTimeout(()=>no(fail()),ms);})]);}finally{clearTimeout(timer);}};
    const send=(method,params={},ms=4000)=>bounded(()=>transport.cdp.send(method,params,
      {...session&&!method.startsWith('Target.')?{sessionId:session}:{},timeoutMs:ms}),ms+100);
    const verifyAdmin=()=>{try{admin.verify();}catch{out.adminGuardUnconfirmed=true;cleanupBad=true;invalid=true;throw fail();}};
    const registered=async()=>{try{if(transport.localScope?.browserKey!==source.browserKey||transport.localScope.registrationState!=='quarantined'
      ||await transport.localScope.currentRegistrationState()!=='quarantined')throw fail();await this.d.store.assertNotAbandoned(nav.sourceRef);}
      catch{invalid=true;throw fail();}};
    const current=async()=>{const f=(await send('Page.getFrameTree'))?.frameTree?.frame;
      if(!f||Object.hasOwn(f,'parentId')||!['id','loaderId'].every(k=>typeof f[k]==='string'&&f[k].length>0&&f[k].length<=256))throw fail();
      return{frameId:f.id,loaderId:f.loaderId,fullUrl:fullFrameUrl(f)};};
    const guard=async(expected)=>{verifyAdmin();const r=revision;await registered();const t=(await send('Target.getTargetInfo',{targetId:source.targetId}))?.targetInfo;
      if(t?.type!=='page'||t.targetId!==source.targetId||t.url!==expected.fullUrl||!same(await current(),expected)||invalid||r!==revision)throw fail();verifyAdmin();};
    const changed=()=>{revision++;if(sealed)invalid=true;};
    const listen=(name,fn)=>off.push(transport.cdp.on(name,(p,c)=>{if(c?.sessionId===session)fn(p);}));
    const discard=r=>{if(r&&Object.hasOwn(r,'body')){counts.bodyDiscarded++;delete r.body;delete r.bytes;delete r.bodyResponse;delete r.bodyFinish;}};
    const read=async(r,doc)=>{
      if(r.attempted||!r.finished||r.response?.status!==200||r.response.url!==r.url||!r.response.json||!Number.isFinite(r.size)||r.size<0||r.size>LIMIT)return;
      if(counts.bodyReads>=24||readBytes>=TOTAL||this.d.clock()-started>30000){out.truncated=true;return;}
      r.attempted=true;await guard(doc);if(requests.get(r.id)!==r||r.frameId!==doc.frameId||r.loaderId!==doc.loaderId)return;
      const before=revision,response=r.response,finish=r.finish;let body;counts.bodyReads++;
      try{body=await send('Network.getResponseBody',{requestId:r.id},3000);}catch{counts.bodyUnavailable++;return;}
      await guard(doc);if(requests.get(r.id)!==r||before!==revision||r.response!==response||r.finish!==finish||r.response?.url!==r.url){counts.bodyDiscarded++;return;}
      let text=typeof body?.body==='string'?body.body:null;
      if(text===null||text.length>LIMIT*2){counts.bodyUnavailable++;out.truncated=true;return;}
      if(body.base64Encoded===true){if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)){counts.bodyUnavailable++;return;}text=Buffer.from(text,'base64').toString('utf8');}
      else if(body.base64Encoded!==false){counts.bodyUnavailable++;return;}
      const bytes=Buffer.byteLength(text);if(bytes>LIMIT||readBytes+bytes>TOTAL){counts.bodyUnavailable++;out.truncated=true;return;}
      readBytes+=bytes;try{r.body=JSON.parse(text);r.bytes=bytes;r.bodyResponse=response;r.bodyFinish=finish;}catch{counts.bodyUnavailable++;}
    };
    try{
      nav=await this.d.evidence.load(args.navigationArtifactRef);snapshot=await this.d.evidence.load(args.snapshotRef);
      if(nav?.version!==1||nav.target!=='financial_report'||nav.evidence!=='quarantined_unverified'||nav.consumable!==false
        ||nav.navigation?.normalNavigationOnly!==true||nav.navigation.commandConfirmed!==true||!ref(nav.sourceRef,'taxsource')||!Array.isArray(nav.requests)||nav.requests.length>96
        ||snapshot?.version!==1||snapshot.target!=='financial_report'||snapshot.evidence!=='quarantined_unverified'||snapshot.consumable!==false||snapshot.scopeStable!==true
        ||snapshot.sourceRef!==nav.sourceRef||snapshot.snapshot?.mode!=='loaded_v8_script_snapshot_v1'||snapshot.snapshot.parentArtifactRef!==args.navigationArtifactRef)throw fail();
      initial=snapshot.snapshot.document;const startUrl=documentAddress(initial?.fullUrl);
      if(!startUrl||!['frameId','loaderId'].every(k=>typeof initial?.[k]==='string'&&initial[k].length>0&&initial[k].length<=256))throw fail();
      const endpointNames=new Map();for(const r of nav.requests){const u=address(r?.url),name=u?.pathname.split('/').at(-1);
        if(u&&u.origin===startUrl.origin&&Object.hasOwn(METHODS,name)&&METHODS[name]===r.method&&r.status===200&&!u.hash
          &&![...u.searchParams.keys()].some(credential)){const key=r.method+' '+u.origin+u.pathname;
          if(endpointNames.has(name)&&endpointNames.get(name)!==key)throw fail();endpointNames.set(name,key);
          endpoints.set(key,{name,origin:u.origin,path:u.pathname,method:r.method});}}
      if(!endpoints.size||endpoints.size>2)throw fail();
      source=await this.d.store.load(nav.sourceRef);await this.d.store.assertNotAbandoned(nav.sourceRef);
      if(!ref(source?.registrationRef,'taxr')||typeof source.registrationRoot!=='string'||!source.registrationRoot||!/^[a-f0-9]{64}$/.test(source.browserKey||'')
        ||typeof source.targetId!=='string'||!source.targetId||source.targetId.length>256)throw fail();
      phase='open';transport=await this.d.openDiagnostic({registrationRef:source.registrationRef,registrationRoot:source.registrationRoot},
        {registrationBase:dirname(resolve(source.registrationRoot))});await registered();
      phase='exclusion';admin=await this.d.acquireAdminGuard(transport.localScope.profilePath);verifyAdmin();lockAcquiring=true;
      lock=await this.d.acquireLock(transport.localScope.profilePath,{scope:{sourceRef:nav.sourceRef,operation:'financial_passive_refresh',snapshotRef:args.snapshotRef}});lockAcquiring=false;
      phase='attach';attachUnknown=true;session=(await send('Target.attachToTarget',{targetId:source.targetId,flatten:true}))?.sessionId;
      if(typeof session!=='string'||!session||typeof transport.cdp.on!=='function')throw fail();attachUnknown=false;
      listen('Page.frameNavigated',p=>{if(p.frame?.parentId)return;changed();counts.mainDocuments++;
        if(counts.mainDocuments>8){invalid=true;out.truncated=true;}if(typeof p.frame?.id!=='string'||typeof p.frame.loaderId!=='string')invalid=true;
        else if(observedDocuments.size<8)observedDocuments.add(JSON.stringify([p.frame.id,p.frame.loaderId]));});
      listen('Page.navigatedWithinDocument',p=>{if(p.frameId===initial.frameId)changed();});
      listen('Page.frameDetached',p=>{if(p.frameId===initial.frameId){changed();invalid=true;}});
      listen('Inspector.detached',()=>{if(!detaching)invalid=true;});
      off.push(transport.cdp.on('Target.detachedFromTarget',p=>{if(p.sessionId===session&&!detaching)invalid=true;}));
      off.push(transport.cdp.on('closed',()=>{if(!closing)invalid=true;}));
      listen('Network.requestWillBeSent',p=>{
        const old=requests.get(p.requestId);if(old){discard(old);requests.delete(p.requestId);}if(p.redirectResponse){counts.redirects++;if(counts.redirects>16)invalid=true;}
        if(!out.navigationAttempted)return;if(++counts.requestEvents>2048){out.truncated=true;return;}
        const r=p.request,u=address(r?.url),endpoint=u&&endpoints.get(r.method+' '+u.origin+u.pathname);
        if(!endpoint||p.frameId!==initial.frameId||!['XHR','Fetch'].includes(p.type)||u.hash||[...u.searchParams.keys()].some(credential)
          ||typeof p.requestId!=='string'||p.requestId.length>256||typeof p.loaderId!=='string'||p.loaderId===initial.loaderId)return;
        if(requests.size>=48){out.truncated=true;return;}counts.matchedRequests++;
        requests.set(p.requestId,{id:p.requestId,name:endpoint.name,url:u.href,method:r.method,frameId:p.frameId,loaderId:p.loaderId,
          bodyText:typeof r.postData==='string'&&r.postData.length<=65536?r.postData:null,finished:false,response:null});
      });
      listen('Network.responseReceived',p=>{const r=requests.get(p.requestId);if(!r)return;
        if(p.frameId!==r.frameId||p.loaderId!==r.loaderId||p.response?.url!==r.url){discard(r);requests.delete(p.requestId);return;}
        r.response={url:p.response.url,status:p.response.status,json:/^(?:application\/(?:[a-z0-9.+-]*\+)?json|text\/plain)(?:;|$)/i.test(p.response.mimeType||'')};});
      listen('Network.loadingFinished',p=>{const r=requests.get(p.requestId);if(r){r.finished=true;r.size=p.encodedDataLength;r.finish={size:r.size};}});
      listen('Network.loadingFailed',p=>{const r=requests.get(p.requestId);if(r){discard(r);requests.delete(p.requestId);}});
      await send('Page.enable');await send('Network.enable',{maxTotalBufferSize:16777216,maxResourceBufferSize:LIMIT});await guard(initial);
      phase='navigate';out.navigationAttempted=true;navUnknown=true;await send('Page.reload',{},12000);
      out.navigationConfirmed=true;navUnknown=false;
      phase='observe';const until=this.d.clock()+8000;
      while(this.d.clock()<until){if(invalid)throw fail();await registered();verifyAdmin();const doc=await current();
        if(doc.frameId===initial.frameId&&doc.loaderId!==initial.loaderId&&documentAddress(doc.fullUrl)?.origin===startUrl.origin)
          for(const r of requests.values())if(r.loaderId===doc.loaderId&&r.frameId===doc.frameId)try{await read(r,doc);}catch{discard(r);if(invalid)throw fail();}
        await this.d.wait(100);}
      phase='seal';const before=revision;final=await current();await guard(final);await this.d.wait(500);
      if(before!==revision||!same(await current(),final)||final.frameId!==initial.frameId||final.loaderId===initial.loaderId
        ||!documentAddress(final.fullUrl)||new URL(final.fullUrl).origin!==startUrl.origin
        ||!observedDocuments.has(JSON.stringify([final.frameId,final.loaderId])))throw fail();
      sealed=true;out.scopeSealed=true;await guard(final);
      for(const r of requests.values())if(r.loaderId===final.loaderId&&r.frameId===final.frameId)await read(r,final);else discard(r);
      await guard(final);const retained=[];
      for(const r of requests.values())if(Object.hasOwn(r,'body')&&r.bodyResponse===r.response&&r.bodyFinish===r.finish&&r.finished&&r.frameId===final.frameId&&r.loaderId===final.loaderId&&r.response?.url===r.url&&r.response.status===200){
        if(retained.length>=12||counts.retainedBytes+r.bytes>TOTAL){out.truncated=true;continue;}
        retained.push({url:r.url,method:r.method,bodyText:r.bodyText,frameId:r.frameId,loaderId:r.loaderId,status:200,response:r.body,
          evidence:'observed',enterpriseBinding:false,consumable:false,readOnlyVerified:false});
        counts.retainedBodies++;counts.retainedBytes+=r.bytes;out.responseShapes.push({endpoint:r.name,...shape(r.body)});
        retainedRefs.push(r);
      }
      prepared={version:1,sourceRef:nav.sourceRef,target:'financial_report',capturedAt:this.d.now(),evidence:'quarantined_unverified',consumable:false,
        enterpriseBinding:false,sourceScopeUnverified:true,sourceReuseAuthorized:false,scopeStable:true,requests:retained,assets:[],
        passive:{mode:MODE,snapshotRef:args.snapshotRef,navigationArtifactRef:args.navigationArtifactRef,document:final,sourceDocumentReused:false,
          directApiRequests:0,runtimeEvaluated:false,navigation:{action:'Page.reload',url:initial.fullUrl,commandConfirmed:true,normalNavigationOnly:true}}};
      phase='final_scope';await guard(final);
    }catch{out.failureStep=phase;prepared=null;}
    finally{
      if(session)try{detaching=true;await send('Target.detachFromTarget',{sessionId:session});}catch{cleanupBad=true;}
      for(const remove of off)try{remove();}catch{cleanupBad=true;}
      if(transport)try{closing=true;const ws=transport.cdp.ws;if(!ws||typeof ws.addEventListener!=='function'||typeof ws.removeEventListener!=='function')throw fail();
        let closed=ws.readyState===3,done;const ended=new Promise(resolve=>{done=resolve;}),onClose=()=>{closed=true;done();};ws.addEventListener('close',onClose);
        try{await bounded(()=>transport.close(),5000);if(!closed)await bounded(()=>ended,5000);if(ws.readyState!==3)throw fail();}finally{ws.removeEventListener('close',onClose);}
      }catch{cleanupBad=true;}
      if(admin)try{verifyAdmin();}catch{cleanupBad=true;}
      if(lock){if(attachUnknown||navUnknown||cleanupBad){lock.retain();out.lockRetained=true;}
        else try{await lock.release();}catch{lock.retain();out.lockRetained=true;cleanupBad=true;}}
      else if(lockAcquiring)out.lockRetained=true;
      if(admin)try{await admin.close();}catch{cleanupBad=true;out.adminGuardUnconfirmed=true;}
      out.cleanupConfirmed=!attachUnknown&&!navUnknown&&!lockAcquiring&&!cleanupBad;out.ownOperationUnknown=attachUnknown||navUnknown;
    }
    if(retainedRefs.some(r=>requests.get(r.id)!==r||!Object.hasOwn(r,'body')||r.bodyResponse!==r.response||r.bodyFinish!==r.finish))prepared=null;
    if(!prepared||invalid||!out.cleanupConfirmed||out.lockRetained){out.responseShapes=[];counts.retainedBodies=0;counts.retainedBytes=0;return out;}
    try{await this.d.store.assertNotAbandoned(nav.sourceRef);const saved=await bounded(()=>this.d.evidence.save(prepared),15000);
      if(!ref(saved?.artifactRef,'taxdownloadpage'))throw fail();return{...out,status:'financial_passive_quarantined',artifactRef:saved.artifactRef,
        bodyGap:counts.retainedBodies===0?'no_completed_matching_json_body':null};
    }catch{return{...out,status:'financial_passive_failed',failureStep:'private_storage',responseShapes:[]};}
  }
}
