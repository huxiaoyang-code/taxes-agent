// 仅供本机管理员被动观察，不是 HTTP/Agent/MCP 工具。
import {dirname,resolve} from 'node:path';
import {TaxDownloadPageStore} from './tax-download-page.mjs';
import {TaxCollectionStore,collectionLock} from './tax-collection-local.mjs';
import {openRegisteredBrowserDiagnostic} from './tax-browser-diagnostic.mjs';
import {acquireReadonlyAdminGuard} from './tax-readonly-abandon.mjs';
import {fullFrameUrl} from './tax-frame-url.mjs';
const MODE='invoice_manual_query_passive_v1',LIMIT=2097152,TOTAL=8388608;
const fail=()=>Error('invoice_observer_failed'),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const ref=(v,p)=>typeof v==='string'&&new RegExp('^'+p+'_[a-f0-9]{48}$').test(v);
const credential=k=>/auth|token|ticket|nonce|password|passwd|cookie|session|secret|credential|sso|oauth|^(?:code|sign)$/i.test(k);
function address(raw){try{const u=new URL(raw);return u.href===raw&&u.protocol==='https:'&&!u.username&&!u.password
  &&['dppt.fujian.chinatax.gov.cn','dppt.chinatax.gov.cn'].includes(u.hostname)&&['','443','8443'].includes(u.port)?u:null;}catch{return null;}}
function classification(raw){const u=address(raw);if(!u)return 'external';let path;try{path=decodeURIComponent(u.pathname);}catch{return 'invalid';}
  if(/auth|token|ticket|nonce|login|logout|session|credential|cookie|password|passport|sso|publickey|privatekey/i.test(path)
    ||[...u.searchParams.keys()].some(credential))return 'authentication';
  if(/submit|save|delete|remove|update|modify|correct|cancel|revoke|void|commit|payment|makeout|issue|apply|register|开具|作废|红冲|保存|提交|缴款|更正|报送|注销|注册|删除|修改|支付/i.test(path))return 'write';
  return 'candidate';
}
function requestSchema(raw,u){let bodyKind=raw===undefined?'absent':'unstructured',bodyFields=[];
  if(typeof raw==='string'&&raw.length<=65536)try{const v=JSON.parse(raw);bodyKind=v===null?'null':Array.isArray(v)?'array':typeof v;
    if(bodyKind==='object')bodyFields=Object.keys(v).slice(0,64);}catch{}
  return{queryKeys:[...u.searchParams.keys()].slice(0,64),bodyKind,bodyFields,postDataOmitted:typeof raw==='string'&&raw.length>65536};
}
export class TaxDownloadInvoiceObserver{
  constructor(overrides={}){this.d={enabled:false,durationMs:120000,evidence:new TaxDownloadPageStore(),store:new TaxCollectionStore(),
    openDiagnostic:openRegisteredBrowserDiagnostic,acquireAdminGuard:acquireReadonlyAdminGuard,acquireLock:collectionLock,
    now:Date.now,clock:Date.now,wait:ms=>new Promise(done=>setTimeout(done,ms)),onArmed:async()=>{},...overrides};}
  async observe(args={}){
    const counts={requestEvents:0,metadata:0,external:0,authentication:0,write:0,subframe:0,redirects:0,bodyReads:0,bodyUnavailable:0,bodyDiscarded:0,bodiesSaved:0,bytesSaved:0,distinctOfficialOriginCount:0,crossOrigin:0};
    const out={mode:MODE,status:'invoice_observation_failed',evidence:'quarantined_unverified',enterpriseBinding:false,consumable:false,requestAuthorized:false,
      runtimeEvaluated:false,navigationPerformed:false,directApiRequests:0,sourceDocumentReused:false,downloadPerformed:false,
      armed:false,scopeStable:false,cleanupConfirmed:false,lockRetained:false,adminGuardUnconfirmed:false,truncated:false,counts,safeAssetRefs:[]};
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).sort().join(',')!=='navigationArtifactRef,snapshotRef'
      ||!ref(args.snapshotRef,'taxdownloadpage')||!ref(args.navigationArtifactRef,'taxdownloadpage'))return{...out,status:'input_invalid'};
    if(this.d.enabled!==true)return{...out,status:'not_enabled'};
    if(!Number.isSafeInteger(this.d.durationMs)||this.d.durationMs<1||this.d.durationMs>180000)return{...out,status:'input_invalid'};
    const off=[],requests=new Map(),records=[],retained=[],origins=new Set();let nav,snapshot,source,document,transport,session,admin,lock,prepared,
      revision=0,invalid=false,capturing=false,detaching=false,closing=false,attachUnknown=false,lockAcquiring=false,cleanupBad=false,phase='validation',readBytes=0;
    const bounded=async(fn,ms)=>{let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,no)=>{timer=setTimeout(()=>no(fail()),ms);})]);}finally{clearTimeout(timer);}};
    const send=(method,params={},ms=4000)=>bounded(()=>transport.cdp.send(method,params,{...session&&!method.startsWith('Target.')?{sessionId:session}:{},timeoutMs:ms}),ms+100);
    const invalidate=()=>{revision++;invalid=true;};
    const verifyAdmin=()=>{try{admin.verify();}catch{out.adminGuardUnconfirmed=true;cleanupBad=true;invalidate();throw fail();}};
    const registered=async()=>{try{if(transport.localScope?.browserKey!==source.browserKey||transport.localScope.registrationState!=='quarantined'
      ||await bounded(()=>transport.localScope.currentRegistrationState(),5000)!=='quarantined')throw fail();await this.d.store.assertNotAbandoned(nav.sourceRef);}catch{invalidate();throw fail();}};
    const current=async()=>{const f=(await send('Page.getFrameTree'))?.frameTree?.frame;
      if(!f||Object.hasOwn(f,'parentId')||!['id','loaderId'].every(k=>typeof f[k]==='string'&&f[k].length>0&&f[k].length<=256))throw fail();
      return{frameId:f.id,loaderId:f.loaderId,fullUrl:fullFrameUrl(f)};};
    const guard=async()=>{try{verifyAdmin();const before=revision;await registered();const t=(await send('Target.getTargetInfo',{targetId:source.targetId}))?.targetInfo;
      if(t?.targetId!==source.targetId||t.type!=='page'||t.url!==document.fullUrl||!same(await current(),document)||invalid||before!==revision)throw fail();verifyAdmin();}
      catch{invalidate();throw fail();}};
    const listen=(name,fn)=>off.push(transport.cdp.on(name,(p,c)=>{if(c?.sessionId===session)fn(p);}));
    const discard=r=>{if(r&&Object.hasOwn(r,'body')){counts.bodyDiscarded++;delete r.body;delete r.bytes;delete r.bodyResponse;delete r.bodyFinish;}if(r)r.invalidated=true;};
    const read=async r=>{
      if(r.attempted||r.invalidated||!r.finish||r.response?.status!==200||r.response.url!==r.url||!r.response.json)return;
      r.attempted=true;if(!Number.isFinite(r.finish.size)||r.finish.size<0||r.finish.size>LIMIT||counts.bodyReads>=12||readBytes>=TOTAL){out.truncated=true;counts.bodyUnavailable++;return;}
      await guard();if(requests.get(r.id)!==r)return;const response=r.response,finish=r.finish,before=revision;let body;counts.bodyReads++;
      try{body=await send('Network.getResponseBody',{requestId:r.id},3000);}catch{counts.bodyUnavailable++;return;}
      await guard();if(requests.get(r.id)!==r||r.invalidated||r.response!==response||r.finish!==finish||before!==revision){counts.bodyDiscarded++;return;}
      let text=typeof body?.body==='string'?body.body:null;if(text===null||text.length>LIMIT*2){counts.bodyUnavailable++;out.truncated=true;return;}
      if(body.base64Encoded===true){if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)){counts.bodyUnavailable++;return;}text=Buffer.from(text,'base64').toString('utf8');}
      else if(body.base64Encoded!==false){counts.bodyUnavailable++;return;}
      const bytes=Buffer.byteLength(text);if(bytes>LIMIT||readBytes+bytes>TOTAL){counts.bodyUnavailable++;out.truncated=true;return;}
      readBytes+=bytes;try{r.body=JSON.parse(text);r.bytes=bytes;r.bodyResponse=response;r.bodyFinish=finish;}catch{counts.bodyUnavailable++;}
    };
    try{
      nav=await this.d.evidence.load(args.navigationArtifactRef);snapshot=await this.d.evidence.load(args.snapshotRef);
      if(nav?.version!==1||nav.target!=='invoice'||nav.evidence!=='quarantined_unverified'||nav.consumable!==false
        ||nav.navigation?.commandConfirmed!==true||nav.navigation.normalNavigationOnly!==true||!ref(nav.sourceRef,'taxsource')
        ||snapshot?.version!==1||snapshot.target!=='invoice'||snapshot.evidence!=='quarantined_unverified'||snapshot.consumable!==false||snapshot.scopeStable!==true
        ||snapshot.sourceRef!==nav.sourceRef||snapshot.snapshot?.mode!=='loaded_v8_script_snapshot_v1'||snapshot.snapshot.parentArtifactRef!==args.navigationArtifactRef)throw fail();
      document=snapshot.snapshot.document;const start=address(document?.fullUrl);
      if(!start||classification(document.fullUrl)!=='candidate'||!['frameId','loaderId'].every(k=>typeof document[k]==='string'&&document[k].length>0&&document[k].length<=256))throw fail();
      const allowedOrigins=new Set([start.origin,'https://dppt.chinatax.gov.cn:8443','https://dppt.chinatax.gov.cn']);
      source=await this.d.store.load(nav.sourceRef);await this.d.store.assertNotAbandoned(nav.sourceRef);
      if(!ref(source?.registrationRef,'taxr')||typeof source.registrationRoot!=='string'||!source.registrationRoot||!/^[a-f0-9]{64}$/.test(source.browserKey||'')
        ||typeof source.targetId!=='string'||!source.targetId||source.targetId.length>256)throw fail();
      phase='open';transport=await this.d.openDiagnostic({registrationRef:source.registrationRef,registrationRoot:source.registrationRoot},{registrationBase:dirname(resolve(source.registrationRoot))});await registered();
      phase='exclusion';admin=await this.d.acquireAdminGuard(transport.localScope.profilePath);verifyAdmin();lockAcquiring=true;
      lock=await this.d.acquireLock(transport.localScope.profilePath,{scope:{sourceRef:nav.sourceRef,operation:'invoice_passive_observer',snapshotRef:args.snapshotRef}});lockAcquiring=false;
      phase='attach';attachUnknown=true;session=(await send('Target.attachToTarget',{targetId:source.targetId,flatten:true}))?.sessionId;
      if(typeof session!=='string'||!session||typeof transport.cdp.on!=='function')throw fail();attachUnknown=false;
      listen('Page.frameNavigated',p=>{if(!p.frame?.parentId)invalidate();});
      listen('Page.navigatedWithinDocument',p=>{if(p.frameId===document.frameId)invalidate();});
      listen('Page.frameDetached',p=>{if(p.frameId===document.frameId)invalidate();});
      listen('Inspector.detached',()=>{if(!detaching)invalidate();});
      off.push(transport.cdp.on('Target.detachedFromTarget',p=>{if(p.sessionId===session&&!detaching)invalidate();}));
      off.push(transport.cdp.on('closed',()=>{if(!closing)invalidate();}));
      listen('Network.requestWillBeSent',p=>{
        const old=requests.get(p.requestId);if(old){discard(old);requests.delete(p.requestId);}if(p.redirectResponse)counts.redirects++;
        if(!capturing||invalid)return;if(++counts.requestEvents>2048){out.truncated=true;return;}
        if(p.frameId!==document.frameId||p.loaderId!==document.loaderId){counts.subframe++;return;}
        if(!['XHR','Fetch'].includes(p.type))return;const r=p.request,u=address(r?.url),kind=classification(r?.url);
        if(!u||!allowedOrigins.has(u.origin)){counts.external++;return;}if(kind==='authentication'){counts.authentication++;return;}
        if(kind==='write'||!['GET','POST'].includes(r.method)){counts.write++;return;}if(kind!=='candidate'||u.hash)return;
        if(records.length>=48){out.truncated=true;return;}if(typeof p.requestId!=='string'||!p.requestId||p.requestId.length>256||r.url.length>8192)return;
        const record={id:p.requestId,url:u.href,method:r.method,frameId:p.frameId,loaderId:p.loaderId,
          bodyText:typeof r.postData==='string'&&r.postData.length<=65536?r.postData:null,requestSchema:requestSchema(r.postData,u),response:null};
        requests.set(p.requestId,record);records.push(record);counts.metadata++;origins.add(u.origin);counts.distinctOfficialOriginCount=origins.size;if(u.origin!==start.origin)counts.crossOrigin++;
      });
      listen('Network.responseReceived',p=>{const r=requests.get(p.requestId);if(!r)return;
        if(p.frameId!==r.frameId||p.loaderId!==r.loaderId||p.response?.url!==r.url){discard(r);requests.delete(p.requestId);return;}
        r.response={url:p.response.url,status:p.response.status,json:/^(?:application\/(?:[a-z0-9.+-]*\+)?json|text\/plain)(?:;|$)/i.test(p.response.mimeType||'')};});
      listen('Network.loadingFinished',p=>{const r=requests.get(p.requestId);if(r)r.finish={size:p.encodedDataLength};});
      listen('Network.loadingFailed',p=>{const r=requests.get(p.requestId);if(r){discard(r);requests.delete(p.requestId);}});
      await send('Page.enable');await send('Network.enable',{maxTotalBufferSize:16777216,maxResourceBufferSize:LIMIT});await guard();
      phase='observe';out.armed=true;capturing=true;await bounded(()=>this.d.onArmed(Object.freeze({status:'invoice_observer_armed',observationSeconds:this.d.durationMs/1000})),3000);
      const until=this.d.clock()+this.d.durationMs;
      while(this.d.clock()<until){await guard();for(const r of requests.values())await read(r);await this.d.wait(Math.max(0,Math.min(500,until-this.d.clock())));}
      capturing=false;phase='final_scope';await guard();for(const r of requests.values())await read(r);await guard();
      const privateRequests=records.map(r=>{
        const valid=requests.get(r.id)===r&&!r.invalidated&&Object.hasOwn(r,'body')&&r.bodyResponse===r.response&&r.bodyFinish===r.finish;
        if(valid){retained.push(r);counts.bodiesSaved++;counts.bytesSaved+=r.bytes;}
        return{url:r.url,method:r.method,bodyText:r.bodyText,requestSchema:r.requestSchema,frameId:r.frameId,loaderId:r.loaderId,
          status:Number.isInteger(r.response?.status)?r.response.status:null,response:valid?r.body:null,evidence:'observed',readOnlyVerified:false,enterpriseBinding:false,consumable:false};
      });
      prepared={version:1,sourceRef:nav.sourceRef,target:'invoice',capturedAt:this.d.now(),evidence:'quarantined_unverified',consumable:false,enterpriseBinding:false,
        sourceScopeUnverified:true,sourceReuseAuthorized:false,scopeStable:true,requests:privateRequests,assets:[],
        observer:{mode:MODE,snapshotRef:args.snapshotRef,navigationArtifactRef:args.navigationArtifactRef,document,sourceDocumentReused:false,
          runtimeEvaluated:false,navigationPerformed:false,directApiRequests:0,observationMs:this.d.durationMs}};out.scopeStable=true;
    }catch{out.failureStep=phase;prepared=null;}
    finally{
      capturing=false;
      if(session)try{detaching=true;await send('Target.detachFromTarget',{sessionId:session});}catch{cleanupBad=true;}
      for(const remove of off)try{remove();}catch{cleanupBad=true;}
      if(transport)try{closing=true;const ws=transport.cdp.ws;if(!ws||typeof ws.addEventListener!=='function'||typeof ws.removeEventListener!=='function')throw fail();
        let closed=ws.readyState===3,done,timer;const ended=new Promise(resolve=>{done=resolve;}),onClose=()=>{closed=true;done();};ws.addEventListener('close',onClose);
        try{await Promise.race([(async()=>{await transport.close();if(!closed)await ended;if(ws.readyState!==3)throw fail();})(),new Promise((_,no)=>{timer=setTimeout(()=>no(fail()),5000);})]);}
        finally{clearTimeout(timer);ws.removeEventListener('close',onClose);}
      }catch{cleanupBad=true;}
      if(admin)try{verifyAdmin();}catch{cleanupBad=true;}
      if(lock){if(attachUnknown||cleanupBad){lock.retain();out.lockRetained=true;}else try{await lock.release();}catch{lock.retain();out.lockRetained=true;cleanupBad=true;}}
      else if(lockAcquiring)out.lockRetained=true;
      if(admin)try{await admin.close();}catch{cleanupBad=true;out.adminGuardUnconfirmed=true;}
      out.cleanupConfirmed=!attachUnknown&&!lockAcquiring&&!cleanupBad;out.ownOperationUnknown=attachUnknown;
    }
    if(retained.some(r=>requests.get(r.id)!==r||r.invalidated||!Object.hasOwn(r,'body')||r.bodyResponse!==r.response||r.bodyFinish!==r.finish))prepared=null;
    if(!prepared||invalid||!out.cleanupConfirmed||out.lockRetained){out.scopeStable=false;counts.bodiesSaved=0;counts.bytesSaved=0;return out;}
    try{await this.d.store.assertNotAbandoned(nav.sourceRef);const saved=await bounded(()=>this.d.evidence.save(prepared),15000);
      if(!ref(saved?.artifactRef,'taxdownloadpage'))throw fail();return{...out,status:'invoice_observation_quarantined',artifactRef:saved.artifactRef,bodyGap:counts.bodiesSaved===0?'no_completed_matching_json_body':null};
    }catch{return{...out,status:'invoice_observation_failed',failureStep:'private_storage'};}
  }
}
