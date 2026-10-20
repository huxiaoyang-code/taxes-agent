// Explicit local administrator capability, never an HTTP/Agent/MCP tool.
// Sources go directly to the guarded private page store, never the public result.
import {dirname,resolve} from 'node:path';
import {TaxDownloadPageStore} from './tax-download-page.mjs';
import {TaxCollectionStore,collectionLock} from './tax-collection-local.mjs';
import {openRegisteredBrowserDiagnostic} from './tax-browser-diagnostic.mjs';
import {acquireReadonlyAdminGuard} from './tax-readonly-abandon.mjs';
import {fullFrameUrl} from './tax-frame-url.mjs';

const MODE='loaded_v8_script_snapshot_v1',MAX_ASSET=2097152,MAX_TOTAL=16777216;
const fail=()=>Error('snapshot_failed');
const ref=(v,p)=>typeof v==='string'&&new RegExp('^'+p+'_[a-f0-9]{48}$').test(v);
function official(raw){try{const u=new URL(raw);return u.href===raw&&u.protocol==='https:'&&!u.username&&!u.password
  &&u.hostname.endsWith('.chinatax.gov.cn')&&['','443','8443'].includes(u.port)&&!u.hostname.startsWith('tpass.');}catch{return false;}}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const priority=url=>/vendor|chunk-vendors|polyfill|runtime|jquery|lodash|vue/i.test(new URL(url).pathname)?2:
  /cwbb|cwbbsb|financial|entry|app[.-]|main[.-]/i.test(new URL(url).pathname)?0:1;

// CDP source proof: V8 v8-debugger-agent-impl.cc getScriptSource reads m_scripts /
// m_cachedScripts; V8DebuggerScript::source reads retained JavaScriptCode(). This
// deliberately never calls Page.getResourceContent (its loader may fetch).
// Own setSkipAllPauses precedes enable; no breakpoint changes, pause or resume.
export class TaxDownloadSnapshot{
  constructor(overrides={}){this.d={enabled:false,evidence:new TaxDownloadPageStore(),store:new TaxCollectionStore(),
    openDiagnostic:openRegisteredBrowserDiagnostic,acquireAdminGuard:acquireReadonlyAdminGuard,acquireLock:collectionLock,
    now:Date.now,clock:Date.now,...overrides};}
  async capture(args={}){
    const counts={scriptEvents:0,eligible:0,captured:0,unavailable:0,rejected:0,budgetSkipped:0,bytes:0};
    const output={mode:MODE,status:'snapshot_failed',evidence:'quarantined_unverified',consumable:false,enterpriseBinding:false,
      requestAuthorized:false,sourceDocumentReused:false,runtimeEvaluated:false,httpRequestsInitiated:0,
      downloadPerformed:false,scopeStable:false,cleanupConfirmed:false,lockRetained:false,adminGuardUnconfirmed:false,truncated:false,counts,safeAssetRefs:[]};
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).join(',')!=='artifactRef'||!ref(args.artifactRef,'taxdownloadpage'))return {...output,status:'input_invalid'};
    if(this.d.enabled!==true)return {...output,status:'not_enabled'};
    const started=this.d.clock(),off=[],contexts=new Map(),scripts=new Map(),assets=[];
    let parent,source,transport,session,admin,lock,document,revision=0,invalid=false,detaching=false,closing=false,attachUnknown=false,
      lockAcquiring=false,cleanupBad=false,version,ready=false,phase='validation';
    const invalidate=()=>{revision++;invalid=true;};
    const verifyAdmin=()=>{try{admin.verify();}catch{output.adminGuardUnconfirmed=true;throw fail();}};
    const bounded=async(fn,ms)=>{let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,no)=>{timer=setTimeout(()=>no(fail()),ms);})]);}finally{clearTimeout(timer);}};
    const send=(method,params={},ms=4000)=>bounded(()=>transport.cdp.send(method,params,
      {...session&&!/^(Target|Browser)\./.test(method)?{sessionId:session}:{},timeoutMs:ms}),ms+100);
    const registration=async()=>{
      if(transport.localScope?.browserKey!==source.browserKey||transport.localScope.registrationState!=='quarantined'
        ||await bounded(()=>transport.localScope.currentRegistrationState(),5000)!=='quarantined')throw fail();
      await this.d.store.assertNotAbandoned(parent.sourceRef);
    };
    const frame=async()=>{
      const f=(await send('Page.getFrameTree'))?.frameTree?.frame;
      if(!f||Object.hasOwn(f,'parentId')||!['id','loaderId'].every(k=>typeof f[k]==='string'&&f[k].length>0&&f[k].length<=256)||!official(fullFrameUrl(f)))throw fail();
      return {frameId:f.id,loaderId:f.loaderId,fullUrl:fullFrameUrl(f)};
    };
    const guard=async()=>{
      verifyAdmin();const r=revision;await registration();const target=(await send('Target.getTargetInfo',{targetId:source.targetId}))?.targetInfo;
      if(target?.targetId!==source.targetId||target.type!=='page'||target.url!==document.fullUrl||invalid||!same(await frame(),document)||invalid||r!==revision)throw fail();
      verifyAdmin();
    };
    const listen=(name,fn)=>off.push(transport.cdp.on(name,(p,c)=>{if(c?.sessionId===session)fn(p);}));
    try{
      parent=await this.d.evidence.load(args.artifactRef);
      if(parent?.version!==1||!ref(parent.sourceRef,'taxsource')||!['invoice','financial_report'].includes(parent.target)
        ||parent.evidence!=='quarantined_unverified'||parent.consumable!==false||parent.navigation?.commandConfirmed!==true||parent.navigation?.normalNavigationOnly!==true)throw fail();
      // Only registration/browser/target are used. No old source identity, recipe,
      // document, TTL or menu value is a current-page permission.
      source=await this.d.store.load(parent.sourceRef);await this.d.store.assertNotAbandoned(parent.sourceRef);
      if(!ref(source?.registrationRef,'taxr')||typeof source.registrationRoot!=='string'||!source.registrationRoot||!/^[a-f0-9]{64}$/.test(source.browserKey||'')
        ||typeof source.targetId!=='string'||!source.targetId||source.targetId.length>256)throw fail();
      phase='open';transport=await this.d.openDiagnostic({registrationRef:source.registrationRef,registrationRoot:source.registrationRoot},
        {registrationBase:dirname(resolve(source.registrationRoot))});await registration();
      version=await send('Browser.getVersion');
      // Current independently checked browser build; unknown versions fail closed
      // pending a new local protocol/source review, never an automatic fallback.
      if(version?.product!=='Edg/155.0.4283.62'||version.protocolVersion!=='1.3'||version.jsVersion!=='15.5.9.7')throw fail();
      const target=(await send('Target.getTargetInfo',{targetId:source.targetId}))?.targetInfo;
      if(target?.targetId!==source.targetId||target.type!=='page'||!official(target.url))throw fail();
      phase='exclusion';admin=await this.d.acquireAdminGuard(transport.localScope.profilePath);verifyAdmin();
      lockAcquiring=true;lock=await this.d.acquireLock(transport.localScope.profilePath,
        {scope:{sourceRef:parent.sourceRef,operation:'loaded_script_snapshot',artifactRef:args.artifactRef}});lockAcquiring=false;
      phase='attach';attachUnknown=true;session=(await send('Target.attachToTarget',{targetId:source.targetId,flatten:true}))?.sessionId;
      if(typeof session!=='string'||!session||typeof transport.cdp.on!=='function')throw fail();attachUnknown=false;
      listen('Page.frameNavigated',p=>{if(!p.frame?.parentId)invalidate();});
      listen('Page.navigatedWithinDocument',p=>{if(!document||p.frameId===document.frameId)invalidate();});
      listen('Page.frameDetached',p=>{if(!document||p.frameId===document.frameId)invalidate();});
      listen('Runtime.executionContextsCleared',invalidate);
      listen('Runtime.executionContextDestroyed',p=>{if(contexts.has(p.executionContextId)){contexts.delete(p.executionContextId);invalidate();}});
      listen('Inspector.detached',()=>{if(!detaching)invalidate();});
      listen('Debugger.paused',invalidate); // Never resume or inspect call frames.
      off.push(transport.cdp.on('Target.detachedFromTarget',p=>{if(p.sessionId===session&&!detaching)invalidate();}));
      off.push(transport.cdp.on('closed',()=>{if(!closing)invalidate();}));
      await send('Page.enable');document=await frame();await guard();
      listen('Runtime.executionContextCreated',p=>{const c=p.context,a=c?.auxData;
        if(!Number.isSafeInteger(c?.id)||c.id<=0||a?.frameId!==document.frameId||a.isDefault!==true||a.type!=='default')return;
        if(contexts.size>=1024){invalidate();return;}contexts.set(c.id,{frameId:a.frameId,uniqueId:c.uniqueId});});
      listen('Debugger.scriptParsed',p=>{
        if(++counts.scriptEvents>2048){output.truncated=true;return;}
        const c=contexts.get(p.executionContextId),a=p.executionContextAuxData;
        if(!c||!official(p.url)||!new URL(p.url).pathname.endsWith('.js')||p.hasSourceURL!==false||p.isLiveEdit===true
          ||p.scriptLanguage!=='JavaScript'||p.startLine!==0||p.startColumn!==0||typeof p.scriptId!=='string'||!p.scriptId||p.scriptId.length>128
          ||!Number.isSafeInteger(p.length)||p.length<0||a&&(a.frameId!==document.frameId||a.isDefault!==true||a.type!=='default')){counts.rejected++;return;}
        scripts.set(p.scriptId,{scriptId:p.scriptId,url:p.url,contextId:p.executionContextId,length:p.length});
      });
      phase='metadata';await send('Runtime.enable');await guard();
      await send('Debugger.setSkipAllPauses',{skip:true});await send('Debugger.enable',{maxScriptsCacheSize:MAX_TOTAL});await guard();
      const selected=[...scripts.values()].sort((a,b)=>priority(a.url)-priority(b.url));counts.eligible=selected.length;
      phase='sources';
      for(const s of selected){
        if(assets.length>=12||this.d.clock()-started>30000){output.truncated=true;counts.budgetSkipped++;continue;}
        if(s.length>MAX_ASSET||counts.bytes+s.length>MAX_TOTAL){output.truncated=true;counts.budgetSkipped++;continue;}
        await guard();if(!contexts.has(s.contextId))throw fail();let response;
        try{response=await send('Debugger.getScriptSource',{scriptId:s.scriptId});}catch{counts.unavailable++;await guard();continue;}
        await guard();if(typeof response?.scriptSource!=='string'||response.bytecode!==undefined||response.scriptSource.length!==s.length){counts.unavailable++;continue;}
        const size=Buffer.byteLength(response.scriptSource);
        if(size>MAX_ASSET||counts.bytes+size>MAX_TOTAL){output.truncated=true;counts.budgetSkipped++;continue;}
        assets.push({text:response.scriptSource,sourceUrl:s.url,requestOrdinal:null});counts.bytes+=size;counts.captured++;
      }
      phase='final_scope';await guard();ready=true;output.scopeStable=true;
    }catch{output.failureStep=phase;ready=false;assets.length=0;counts.captured=0;counts.bytes=0;}
    finally{
      // No domain.disable: detach our session while listeners remain armed,
      // then remove listeners, await the actual socket close, then exact CAS.
      if(session)try{detaching=true;await send('Target.detachFromTarget',{sessionId:session});}catch{cleanupBad=true;}
      for(const remove of off)try{remove();}catch{cleanupBad=true;}
      if(transport)try{
        closing=true;const ws=transport.cdp.ws;
        if(!ws||typeof ws.addEventListener!=='function'||typeof ws.removeEventListener!=='function')throw fail();
        let closed=ws.readyState===3,done;const ended=new Promise(resolve=>{done=resolve;});
        const onClose=()=>{closed=true;done();};ws.addEventListener('close',onClose);
        try{await bounded(()=>transport.close(),5000);if(!closed)await bounded(()=>ended,5000);if(ws.readyState!==3)throw fail();}
        finally{ws.removeEventListener('close',onClose);}
      }catch{cleanupBad=true;}
      if(admin)try{verifyAdmin();}catch{cleanupBad=true;}
      if(lock){if(attachUnknown||cleanupBad){lock.retain();output.lockRetained=true;}
        else try{await lock.release();}catch{lock.retain();output.lockRetained=true;cleanupBad=true;}}
      else if(lockAcquiring)output.lockRetained=true;
      if(admin)try{await admin.close();}catch{cleanupBad=true;output.adminGuardUnconfirmed=true;}
      output.cleanupConfirmed=!cleanupBad&&!attachUnknown&&!lockAcquiring;
    }
    if(invalid){ready=false;output.scopeStable=false;output.failureStep??='scope_changed';}
    if(!ready||!output.cleanupConfirmed||output.lockRetained){assets.length=0;counts.captured=0;counts.bytes=0;return output;}
    try{
      await this.d.store.assertNotAbandoned(parent.sourceRef);
      const saved=await bounded(()=>this.d.evidence.save({version:1,sourceRef:parent.sourceRef,target:parent.target,capturedAt:this.d.now(),
        evidence:'quarantined_unverified',consumable:false,enterpriseBinding:false,sourceScopeUnverified:true,sourceReuseAuthorized:false,
        scopeStable:true,requests:[],assets,snapshot:{mode:MODE,parentArtifactRef:args.artifactRef,sourceBinding:'registration_browser_target_only',
          sourceDocumentReused:false,runtimeEvaluated:false,httpRequestsInitiated:0,normalNavigationPerformed:false,
          parentNavigationCommandConfirmed:true,document,runtime:{product:version.product,protocolVersion:version.protocolVersion,jsVersion:version.jsVersion}}}),15000);
      if(!ref(saved?.artifactRef,'taxdownloadpage'))throw fail();
      return {...output,status:'snapshot_quarantined',artifactRef:saved.artifactRef};
    }catch{return {...output,status:'snapshot_failed',failureStep:'private_storage'};}
  }
}
