// Local administrator exploration only. No HTTP/Agent/MCP registration or arbitrary address input.
import {randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdir,lstat,realpath,open,readFile,link,unlink} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TaxCollectionStore,collectionLock} from './tax-collection-local.mjs';
import {openRegisteredBrowserDiagnostic,verifyPrivateDirectory,verifyPrivateFile} from './tax-browser-diagnostic.mjs';
import {requireActiveSource,validateCapture} from './tax-collection-contract.mjs';
import {FULL_FRAME_URL_SEMANTICS,fullFrameUrl} from './tax-frame-url.mjs';
import {liveRequestScript} from './tax-live-collection.mjs';
import {businessProjection,collectionShape} from './tax-collection-shape.mjs';
import {canonical,exact,enterpriseOf,sameEnterprise,HISTORY_ORIGIN} from './tax-history-contract.mjs';

const PORTAL=HISTORY_ORIGIN+'/loginb/',ROOT=fileURLToPath(new URL('../../.agent-runs/tax-download-page-evidence/',import.meta.url));
const WORKSPACE=fileURLToPath(new URL('../../',import.meta.url));
// Exact query labels verified in the current menu by the local root operator.
const TARGETS=Object.freeze({invoice:'全量发票查询',financial_report:'财务报表申报信息查询'});
const LABELS=Object.freeze({invoice_query:'发票查询',financial_filing_query:'财务报表申报信息查询',all_invoice_query:'全量发票查询',invoice_comprehensive_query:'发票综合查询',financial_report_query:'财务报表查询'});
const ORIGINS=new Set([HISTORY_ORIGIN,'https://etax.fujian.chinatax.gov.cn','https://dppt.fujian.chinatax.gov.cn','https://dppt.fujian.chinatax.gov.cn:8443']);
const credential=key=>/(?:auth|token|ticket|nonce|password|passwd|cookie|session|secret|credential|privatekey|accesskey|sso|oauth)/i.test(key);
const writes=/(?:submit|save|delete|remove|update|modify|correct|cancel|revoke|void|commit|payment|makeout|issue|apply|register|logout)/i;
const fail=code=>Object.assign(new Error(code),{code});
const ref=prefix=>prefix+'_'+randomBytes(24).toString('hex');
const digest=v=>createHash('sha256').update(v).digest('hex');
const sourceRef=v=>typeof v==='string'&&/^taxsource_[a-f0-9]{48}$/.test(v);
const artifactRef=v=>typeof v==='string'&&/^taxdownloadpage_[a-f0-9]{48}$/.test(v);
function address(raw){try{const u=new URL(raw);if(u.href!==raw||u.username||u.password)return null;return u;}catch{return null;}}
function routeClass(raw){
  const u=address(raw);if(!u)return 'invalid';
  if(u.hostname==='tpass.fujian.chinatax.gov.cn'||credential(u.pathname)||/(?:login|passport|callback)/i.test(u.pathname)
    ||[...u.searchParams.keys()].some(k=>credential(k)||k==='code'))return 'authentication';
  if(!ORIGINS.has(u.origin))return 'external';
  if(writes.test(u.pathname))return 'side_effect';
  return /\.js$/i.test(u.pathname)?'script':'read_candidate';
}
function redact(value,depth=0){
  if(depth>12)return '[depth omitted]';
  if(Array.isArray(value))return value.slice(0,10000).map(v=>redact(v,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,credential(k)?'[credential omitted]':redact(v,depth+1)]));
  return value;
}
function requestRecord(request){
  const u=new URL(request.url);for(const k of [...u.searchParams.keys()])if(credential(k)||k==='code')u.searchParams.set(k,'[credential omitted]');
  let body=null;if(typeof request.postData==='string')try{body=redact(JSON.parse(request.postData));}catch{body='[unstructured body omitted]';}
  return {url:u.href,method:request.method,body};
}
function documentOf(frame,targetId){
  if(!frame||frame.parentId||!['id','loaderId'].every(k=>typeof frame[k]==='string'&&frame[k].length>0&&frame[k].length<=256))throw fail('document_changed');
  const fullUrl=fullFrameUrl(frame);return {targetId,frameId:frame.id,loaderId:frame.loaderId,fullUrl,
    documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,documentUrlDigest:digest(fullUrl)};
}

// Fixed native known-key read. Actual matched addresses remain local, never model output.
export function downloadPageMenuScript(){return `(()=>{
  if(location.href!==${JSON.stringify(PORTAL)})return {status:'scope_changed',settled:true};
  const getter=Object.getOwnPropertyDescriptor(Storage.prototype,'getItem')?.value;
  if(typeof getter!=='function'||!Function.prototype.toString.call(getter).includes('[native code]'))return {status:'native_guard_rejected',settled:true};
  try{
    const raw=Reflect.apply(getter,sessionStorage,['mhNavDataAfter_mh']);
    if(typeof raw!=='string'||raw.length>524288)return {status:'menu_unavailable',settled:true};
    const envelope=JSON.parse(raw),targets=${JSON.stringify(TARGETS)},labels=${JSON.stringify(LABELS)},labelMatchCounts=Object.fromEntries(Object.keys(labels).map(k=>[k,0])),entries=[];let nodes=0;
    if(!envelope||Object.keys(envelope).sort().join(',')!=='exp,val'||!Number.isFinite(envelope.exp)||!Array.isArray(envelope.val))throw 0;
    const expiryClass=envelope.exp===0?'zero':envelope.exp<0?'negative':envelope.exp<100000000?'positive_small':envelope.exp<100000000000?'epoch_seconds_like':envelope.exp<100000000000000?'epoch_milliseconds_like':'positive_large';
    // The site's setter/getter protocol has not been proved. A clock comparison
    // is diagnostic, never a login, authorization or cache-validity decision.
    const expiryComparison=expiryClass==='epoch_milliseconds_like'?(Date.now()-1>envelope.exp?'past':'future'):'unknown';
    const walk=(items,depth)=>{
      if(depth>12||!Array.isArray(items))throw 0;
      for(const item of items){if(++nodes>5000||!item||typeof item!=='object'||Array.isArray(item)||item.arr!==undefined&&!Array.isArray(item.arr))throw 0;
        if(item.arr?.length){walk(item.arr,depth+1);continue;}
        for(const [key,label] of Object.entries(labels))if(item.gnmc===label)labelMatchCounts[key]++;
        const target=Object.keys(targets).find(k=>item.gnmc===targets[k]);
        if(target)entries.push({target,yyfwqdz:item.yyfwqdz??'',cddz:item.cddz,specialBranch:item.gndm==='GN00000410000001'});
      }
    };walk(envelope.val,0);
    if(location.href!==${JSON.stringify(PORTAL)})return {status:'scope_changed',settled:true};
    return {status:'menu_observed',settled:true,expiresAt:envelope.exp,nodes,entries,labelMatchCounts,
      expiryDiagnostic:{classification:expiryClass,comparison:expiryComparison,semanticsVerified:false}};
  }catch{return {status:'menu_invalid',settled:true};}
})()`;}

function selectMenu(value,target,now,userinfo){
  if(value?.status!=='menu_observed'||value.settled!==true||!Array.isArray(value.entries)||value.entries.length>5000
    ||!Number.isFinite(value.expiresAt))throw fail('menu_unavailable');
  const matches=value.entries.filter(e=>e?.target===target),valid=[];
  const rejectionCounts=Object.fromEntries(['entry_shape','special_branch','address_shape','address_characters','invalid_url','origin','credentials','fragment',
    'path_root','path_encoding_or_traversal','authentication_route','side_effect_route','non_read_route','query_keys','destination_shape'].map(k=>[k,0]));
  const reject=kind=>{rejectionCounts[kind]++;};
  for(const e of matches){
    if(!exact(e,['target','yyfwqdz','cddz','specialBranch'])){reject('entry_shape');continue;}
    if(e.specialBranch!==false){reject('special_branch');continue;}
    if(typeof e.yyfwqdz!=='string'||typeof e.cddz!=='string'||!e.cddz||e.yyfwqdz.length>2048||e.cddz.length>4096){reject('address_shape');continue;}
    const combined=e.yyfwqdz+e.cddz;if(/[\s\\\u0000-\u001f]/.test(combined)){reject('address_characters');continue;}
    let u;try{u=new URL(combined,PORTAL);}catch{reject('invalid_url');continue;}
    if(!ORIGINS.has(u.origin)){reject('origin');continue;}
    if(u.username||u.password){reject('credentials');continue;}
    if(u.href.includes('#')){reject('fragment');continue;}
    const keys=[...u.searchParams.keys()];
    const invoiceMenuHandler=target==='invoice'&&u.pathname.split('/').at(-1)==='spHandler'&&keys.length===1&&keys[0]==='cdlj';
    if(!/^\/(?:szzh|szc|kpfw|dppt)\//.test(u.pathname)&&!invoiceMenuHandler){reject('path_root');continue;}
    if(/%|(?:^|\/)\.\.(?:\/|$)/.test(combined.split(/[?#]/)[0])){reject('path_encoding_or_traversal');continue;}
    // An official menu's query label can route through its login gateway.
    // This authorizes normal navigation only; response sampling below retains
    // the stricter authentication exclusion and never invokes a gateway API.
    const classification=routeClass(u.href),financialMenuGateway=target==='financial_report'&&classification==='authentication'&&keys.length===0;
    if(writes.test(u.pathname)){reject('side_effect_route');continue;}
    if(classification!=='read_candidate'&&!financialMenuGateway){reject(classification==='authentication'?'authentication_route':classification==='side_effect'?'side_effect_route':'non_read_route');continue;}
    if(keys.some(k=>k!=='cdlj')||keys.length>1){reject('query_keys');continue;}
    if(keys.length){const destination=u.searchParams.get('cdlj');
      // cdlj is an opaque menu value in some official entries, not a path to rebuild.
      if(!destination||destination.length>2048||/[\s\\?#:\u0000-\u001f]/.test(destination)||/(?:^|\/)\.\.(?:\/|$)/.test(destination)){reject('destination_shape');continue;}
    }
    valid.push(u.href);
  }
  const difference={exactMatchCount:matches.length,validRouteCount:valid.length,distinctRouteCount:new Set(valid).size,
    distinctOriginCount:new Set(valid.map(u=>new URL(u).origin)).size,rejectionCounts};
  if(matches.length!==1||valid.length!==1){const e=fail(matches.length===0?'menu_target_missing':matches.length>1?'menu_target_ambiguous':'menu_route_rejected');e.menuDifference=difference;throw e;}
  if(typeof userinfo?.relatedType!=='string'||!userinfo.relatedType.trim()||userinfo.relatedType==='09')throw fail('menu_branch_unverified');
  return {url:valid[0],expiresAt:value.expiresAt,difference,expirySemanticsVerified:false,
    historicalEntryUsed:value.expiryDiagnostic?.comparison!=='future'};
}

async function ancestors(path){for(let p=resolve(path);;){const s=await lstat(p);if(s.isSymbolicLink()||await realpath(p)!==p)throw fail('storage_failed');const parent=dirname(p);if(parent===p)return;p=parent;}}
async function secureDirectory(path){
  const script=`$ErrorActionPreference='Stop'
$path=$env:TAX_DOWNLOAD_PAGE_PRIVATE_PATH
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
foreach($allowed in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($allowed,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
[IO.Directory]::SetAccessControl($path,$acl)
[Console]::Write('secured')`;
  if(process.platform!=='win32')throw fail('storage_failed');
  const output=await new Promise((yes,no)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {shell:false,windowsHide:true,timeout:10000,maxBuffer:1024,env:{...process.env,TAX_DOWNLOAD_PAGE_PRIVATE_PATH:path}},(e,out)=>e?no(fail('storage_failed')):yes(String(out))));
  if(output!=='secured')throw fail('storage_failed');
}
export class TaxDownloadPageStore{
  constructor({root=ROOT,security={}}={}){this.root=resolve(root);this.security={verifyDirectory:verifyPrivateDirectory,verifyFile:verifyPrivateFile,secureDirectory,...security};}
  async ready(){
    if(this.security.testStorage!==true){if(this.root!==resolve(ROOT))throw fail('storage_failed');
      await new Promise((yes,no)=>execFile('git',['check-ignore','--quiet','--',this.root],{cwd:WORKSPACE,shell:false,windowsHide:true,timeout:5000,maxBuffer:1024},e=>e?no(fail('storage_failed')):yes()));}
    await ancestors(dirname(this.root));let created=false;try{await mkdir(this.root);created=true;}catch(e){if(e.code!=='EEXIST')throw fail('storage_failed');}
    await ancestors(this.root);if(created)await this.security.secureDirectory(this.root);await this.security.verifyDirectory(this.root);
  }
  async save(record){
    if(record?.version!==1||!sourceRef(record.sourceRef)||!Object.hasOwn(TARGETS,record.target)||!['observed','quarantined_unverified'].includes(record.evidence)
      ||record.consumable!==false||!Array.isArray(record.requests)||record.requests.length>96||!Array.isArray(record.assets)||record.assets.length>12)throw fail('storage_failed');
    await this.ready();const id=ref('taxdownloadpage'),folder=join(this.root,id);await mkdir(folder);await this.security.secureDirectory(folder);await this.security.verifyDirectory(folder);
    // A manifest is published last. Incomplete directories remain private and
    // cannot be loaded as evidence; never overwrite an older artifact.
    const assets=[];
    for(const asset of record.assets){if(typeof asset.text!=='string'||Buffer.byteLength(asset.text)>2097152)throw fail('storage_failed');
      const name=ref('taxasset')+'.quarantined.js';await this.write(folder,name,asset.text);assets.push({file:name,sha256:digest(asset.text),modelReadable:false,evidence:'static_candidate',
        sourceUrl:asset.sourceUrl,requestOrdinal:asset.requestOrdinal});}
    const manifest={...record,assets},text=JSON.stringify(manifest);if(Buffer.byteLength(text)>16777216)throw fail('storage_failed');
    await this.write(folder,'manifest.json',text);return {artifactRef:id,safeAssetRefs:[]};
  }
  async write(folder,name,text){
    if(!/^(?:manifest\.json|taxasset_[a-f0-9]{48}\.quarantined\.js)$/.test(name))throw fail('storage_failed');
    await ancestors(folder);await this.security.verifyDirectory(folder);const path=join(folder,name),staging=path+'.tmp';
    const handle=await open(staging,'wx',0o600);try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
    try{await this.security.verifyFile(staging);if((await lstat(staging)).nlink!==1||await readFile(staging,'utf8')!==text)throw fail('storage_failed');await link(staging,path);await unlink(staging);await this.security.verifyFile(path);
      const published=await lstat(path);if(!published.isFile()||published.isSymbolicLink()||published.nlink!==1||await realpath(path)!==path||await readFile(path,'utf8')!==text)throw fail('storage_failed');}
    finally{await unlink(staging).catch(()=>{});}
  }
  async load(id){
    if(!artifactRef(id))throw fail('storage_failed');await this.ready();const folder=join(this.root,id);await ancestors(folder);await this.security.verifyDirectory(folder);
    const path=join(folder,'manifest.json'),before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>16777216||await realpath(path)!==path)throw fail('storage_failed');
    await this.security.verifyFile(path);const handle=await open(path,'r');try{const s=await handle.stat();if(s.ino!==before.ino||s.dev!==before.dev||s.size!==before.size||s.nlink!==1)throw fail('storage_failed');
      const text=await handle.readFile('utf8'),after=await handle.stat(),current=await lstat(path);if(Buffer.byteLength(text)>16777216||after.mtimeMs!==s.mtimeMs||after.size!==s.size||current.ino!==s.ino||current.dev!==s.dev||current.nlink!==1||current.isSymbolicLink())throw fail('storage_failed');return JSON.parse(text);
    }finally{await handle.close();}
  }
}

const SAFE=new Set(['source_expired','source_inactive','document_changed','registration_changed','identity_changed','identity_failed','identity_unknown',
  'menu_expired','menu_unavailable','menu_target_missing','menu_target_ambiguous','menu_route_rejected','menu_branch_unverified','menu_changed',
  'event_unknown','navigation_failed','navigation_unknown','deadline','budget_insufficient','tax_collection_busy','storage_failed']);
export class TaxDownloadPage{
  constructor(overrides={}){this.d={enabled:false,store:new TaxCollectionStore(),evidence:new TaxDownloadPageStore(),openDiagnostic:openRegisteredBrowserDiagnostic,
    acquireLock:collectionLock,now:Date.now,clock:Date.now,pause:ms=>new Promise(resolve=>setTimeout(resolve,ms)),...overrides};}
  async navigate(args={}){
    if(!exact(args,['sourceRef','target'])||!sourceRef(args.sourceRef)||!Object.hasOwn(TARGETS,args.target))return {status:'input_invalid'};
    if(this.d.enabled!==true)return {status:'not_enabled'};
    const started=this.d.clock(),remove=[],oldContexts=new Set(),destroyed=new Set(),requests=new Map(),mainLoaders=new Set(),capturedIds=new Set(),captured=[],assets=[];
    const counts={requestEvents:0,selectedRequests:0,responseBodies:0,scripts:0,bodyUnavailable:0,bodyBudgetSkipped:0,subframeUnverified:0,truncated:0,authentication:0,external:0,sideEffect:0,redirects:0};
    let source,transport,attached,lock,lockAcquiring=false,document,landing,record,phase='load',mode='original',unexpected=false,unknown=false,detachRequested=false,
      navEvent=null,navEvents=0,clearCount=0,navAttempted=0,navConfirmed=0,identityAttempted=0,identityPerformed=0,identityComplete=0,identityUnknown=0,identityNotPerformed=0,
      passive=false,menuDifference=null,labelMatchCounts=null,expiryDiagnostic=null,cleanupFailureStep=null,cleanupFailureKind=null,scopeVerificationFailureStep=null,
      beforeProjection=null,afterProjection=null,selectedMenu=null,navigationAcknowledged=false,sourceState='unverified',sourceRetired=null,step='none',output;
    // A normal website redirect is a scope change, not an unfinished owned
    // command. Only unconfirmed owned operations can retain this operation's lock.
    const eventUnknown=()=>{unexpected=true;};
    const timed=async(fn,ms,kind='work',owned=false)=>{
      const remaining=({work:90000,cleanup:120000,publish:180000}[kind])-(this.d.clock()-started);if(remaining<=0)throw Object.assign(fail('deadline'),{notDispatched:true});
      let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,no)=>{timer=setTimeout(()=>{if(owned)unknown=true;no(fail('deadline'));},Math.min(ms,remaining));})]);}finally{clearTimeout(timer);}
    };
    const send=async(method,params={},ms=5000,kind='work')=>{const owned=['Runtime.evaluate','Page.navigate','Page.createIsolatedWorld','Target.attachToTarget'].includes(method);
      try{return await timed(()=>transport.cdp.send(method,params,{...attached?{sessionId:attached}:{},timeoutMs:ms}),ms,kind,owned);}catch(e){if(owned&&!e?.notDispatched)unknown=true;throw e;}};
    const active=async(kind='work')=>{if(source.capturedAt>this.d.now()||this.d.now()-source.capturedAt>1800000){sourceState='expired';sourceRetired=null;throw fail('source_expired');}
      try{await timed(()=>this.d.store.assertNotAbandoned(args.sourceRef),2000,kind);sourceState='active_at_last_check';sourceRetired=false;}
      catch(e){sourceRetired=null;sourceState=e.code==='deadline'?'unverified':'retired_or_unavailable';if(e.code==='deadline')throw e;throw fail('source_inactive');}};
    const registered=async(kind='work')=>{if(transport.localScope?.browserKey!==source.browserKey||transport.localScope.registrationState!=='quarantined'
      ||await timed(()=>transport.localScope.currentRegistrationState(),7000,kind)!=='quarantined')throw fail('registration_changed');};
    const frame=async(kind='work')=>documentOf((await send('Page.getFrameTree',{},5000,kind))?.frameTree?.frame,source.targetId);
    const guard=async()=>{await active();await registered();if(unexpected)throw fail('event_unknown');if(canonical(await frame())!==canonical(document)||unexpected)throw fail('document_changed');};
    const identity=async()=>{
      await guard();identityAttempted++;const proof=ref('taxreq');let reply;
      try{reply=await send('Runtime.evaluate',{expression:liveRequestScript(source.identity.recipe,'identity',proof,document.fullUrl),returnByValue:true,awaitPromise:true,timeout:13000},14000);}catch(e){if(e?.notDispatched)identityNotPerformed++;else identityUnknown++;throw e;}
      const v=reply?.result?.value,matched=!reply?.exceptionDetails&&v?.requestRef===proof;
      if(matched&&v.requestPerformed===true)identityPerformed++;else if(!reply?.exceptionDetails&&exact(v,['status','settled'])&&v.status==='scope_invalid'&&v.settled===true)identityNotPerformed++;else identityUnknown++;
      if(matched&&v.responseComplete===true)identityComplete++;
      if(reply?.exceptionDetails||v?.settled!==true||v?.status==='observed'&&!matched){unknown=true;throw fail('identity_unknown');}
      if(!matched&&(!exact(v,['status','settled'])||!['scope_invalid','scope_changed','request_failed','invalid_json','response_too_large'].includes(v.status))){unknown=true;throw fail('identity_unknown');}
      if(matched&&v.status==='observed'&&(v.requestPerformed!==true||v.responseComplete!==true)){unknown=true;throw fail('identity_unknown');}
      if(!matched||v.status!=='observed'||v.requestPerformed!==true||v.responseComplete!==true)throw fail('identity_failed');
      const projection=businessProjection(v.body,'identity');if(collectionShape(v.body).businessStatus==='failed'||!validateCapture({resource:'identity',recipe:source.identity.recipe,projection},'identity'))throw fail('identity_failed');
      if(!sameEnterprise(enterpriseOf(projection),enterpriseOf(source.identity.projection)))throw fail('identity_changed');await guard();return projection;
    };
    const menu=async()=>{await guard();const world=await send('Page.createIsolatedWorld',{frameId:document.frameId,worldName:'youshu-download-menu',grantUniveralAccess:false});
      if(!Number.isSafeInteger(world?.executionContextId)||world.executionContextId<=0){unknown=true;throw fail('menu_unavailable');}
      await guard();const reply=await send('Runtime.evaluate',{expression:downloadPageMenuScript(),contextId:world.executionContextId,returnByValue:true,timeout:3000},4000);
      if(reply?.exceptionDetails||reply?.result?.value?.settled!==true){unknown=true;throw fail('menu_unavailable');}
      const value=reply.result.value;
      if(exact(value.labelMatchCounts,Object.keys(LABELS))&&Object.values(value.labelMatchCounts).every(v=>Number.isSafeInteger(v)&&v>=0&&v<=5000))labelMatchCounts={...value.labelMatchCounts};
      if(exact(value.expiryDiagnostic,['classification','comparison','semanticsVerified'])
        &&['zero','negative','positive_small','epoch_seconds_like','epoch_milliseconds_like','positive_large'].includes(value.expiryDiagnostic.classification)
        &&['past','future','unknown'].includes(value.expiryDiagnostic.comparison)&&value.expiryDiagnostic.semanticsVerified===false)expiryDiagnostic={...value.expiryDiagnostic};
      await guard();return value;};
    const metadata=()=>{
      for(const [id,r] of requests){if(capturedIds.has(id)||r.frameId!==source.frameId||!mainLoaders.has(r.loaderId)||r.loaderId===source.loaderId)continue;
        capturedIds.add(id);counts.selectedRequests++;captured.push({...requestRecord(r.request),frameId:r.frameId,loaderId:r.loaderId,evidence:'observed',readOnlyVerified:false,
          enterpriseBinding:false,consumable:false,status:Number.isInteger(r.response?.status)?r.response.status:null,response:null});}
    };
    const makeRecord=(quarantine,reason)=>{
      if(quarantine)metadata();const klass=document?.loaderId!==source.loaderId?routeClass(document?.fullUrl):'invalid';
      return {version:1,sourceRef:args.sourceRef,target:args.target,capturedAt:this.d.now(),evidence:quarantine?'quarantined_unverified':'observed',consumable:false,enterpriseBinding:false,
        sourceState,sourceRetired,sourceScopeUnverified:quarantine,sourceReuseAuthorized:false,
        expirySemanticsVerified:false,historicalEntryUsed:selectedMenu.historicalEntryUsed,
        scopeStable:!quarantine,captureComplete:counts.bodyUnavailable===0&&counts.bodyBudgetSkipped===0&&counts.truncated===0,
        navigation:{sourceKind:'known_key_menu_cache',url:selectedMenu.url,normalNavigationOnly:true,commandConfirmed:navigationAcknowledged},
        document:['read_candidate','script'].includes(klass)?document:null,landingStatus:reason,
        identityBeforeProjection:beforeProjection,identityAfterProjection:quarantine?null:afterProjection,requests:captured,assets};
    };
    const quarantineResult=reason=>({status:'page_quarantined_unverified',landingStatus:reason,identityProjectionMatched:false,documentScopeVerified:false,
      evidence:'quarantined_unverified',requestAuthorized:false,readOnlyResourcesVerified:false,enterpriseBinding:false});
    try{
      source=requireActiveSource(await timed(()=>this.d.store.load(args.sourceRef),15000));await active();
      phase='open';let openingEnded=false;
      try{transport=await timed(async()=>{const opened=await this.d.openDiagnostic({registrationRef:source.registrationRef,registrationRoot:source.registrationRoot},{registrationBase:dirname(resolve(source.registrationRoot))});
        if(openingEnded){try{await opened.close();}catch{}throw fail('deadline');}return opened;},30000);}finally{openingEnded=true;}
      await registered();if(90000-(this.d.clock()-started)<50000)throw fail('budget_insufficient');
      phase='lock';lockAcquiring=true;lock=await timed(()=>this.d.acquireLock(transport.localScope.profilePath,{scope:{sourceRef:args.sourceRef,operation:'download_page_exploration',target:args.target}}),12000,'work',true);lockAcquiring=false;
      phase='attach';if((await send('Target.getTargetInfo',{targetId:source.targetId}))?.targetInfo?.type!=='page')throw fail('document_changed');
      unknown=true;attached=(await send('Target.attachToTarget',{targetId:source.targetId,flatten:true}))?.sessionId;
      if(typeof attached!=='string'||!attached||typeof transport.cdp.on!=='function')throw fail('document_changed');unknown=false;
      const listen=(name,fn)=>remove.push(transport.cdp.on(name,(p,c)=>{if(c?.sessionId===attached)fn(p);}));
      listen('Page.frameNavigated',p=>{
        if(p.frame?.parentId){counts.subframeUnverified++;return;}
        if(typeof p.frame?.loaderId==='string'&&p.frame.id===source.frameId&&p.frame.loaderId!==source.loaderId)mainLoaders.add(p.frame.loaderId);
        if(mode!=='navigation'){eventUnknown();return;}
        navEvents++;try{navEvent=documentOf(p.frame,source.targetId);}catch{eventUnknown();}
        if(navEvents!==1||navEvent?.frameId!==source.frameId||navEvent?.loaderId===source.loaderId)eventUnknown();
      });
      listen('Runtime.executionContextCreated',p=>{if(mode==='original'&&Number.isSafeInteger(p.context?.id)){if(oldContexts.size>=1024)eventUnknown();else oldContexts.add(p.context.id);}});
      listen('Runtime.executionContextsCleared',()=>{if(mode==='navigation'&&navEvents===0&&clearCount<2)clearCount++;else eventUnknown();});
      listen('Runtime.executionContextDestroyed',p=>{if(mode==='navigation'&&oldContexts.has(p.executionContextId)&&!destroyed.has(p.executionContextId))destroyed.add(p.executionContextId);else eventUnknown();});
      for(const name of ['Page.navigatedWithinDocument','Inspector.detached'])listen(name,eventUnknown);
      listen('Page.frameDetached',p=>{if(p.frameId===source.frameId)eventUnknown();});
      remove.push(transport.cdp.on('Target.detachedFromTarget',p=>{if(p.sessionId===attached&&!detachRequested)eventUnknown();}));
      listen('Network.requestWillBeSent',p=>{
        // The request id identifies a redirect chain, not an immutable hop.
        // Even after sampling ends, a later hop invalidates its old provenance.
        const tracked=requests.has(p.requestId);if(tracked)requests.delete(p.requestId);
        if(p.redirectResponse&&(passive||tracked))counts.redirects++;
        if(!passive)return;if(++counts.requestEvents>2048){counts.truncated++;return;}
        if(p.frameId!==source.frameId){counts.subframeUnverified++;return;}
        const r=p.request;if(typeof p.requestId!=='string'||!r||!['GET','POST','HEAD'].includes(r.method)||typeof r.url!=='string'||r.url.length>8192)return;
        const type=routeClass(r.url);if(['authentication','external','side_effect'].includes(type)){counts[type==='side_effect'?'sideEffect':type]++;return;}
        const bucket=p.type==='Script'&&type==='script'?'script':p.type==='Document'&&type==='read_candidate'?'document':['XHR','Fetch'].includes(p.type)&&type==='read_candidate'?'business':null;
        if(!bucket)return;const limit={script:12,document:8,business:76}[bucket];
        if([...requests.values()].filter(v=>v.bucket===bucket).length>=limit){counts.truncated++;return;}
        requests.set(p.requestId,{request:{url:r.url,method:r.method,postData:typeof r.postData==='string'&&r.postData.length<=1048576?r.postData:undefined},frameId:p.frameId,loaderId:p.loaderId,bucket,response:null,finished:false,size:null});
      });
      listen('Network.responseReceived',p=>{const r=requests.get(p.requestId);if(!r)return;
        if(typeof p.response?.url==='string'&&p.response.url!==r.request.url){requests.delete(p.requestId);return;}
        r.response={status:p.response?.status,mimeType:p.response?.mimeType,url:p.response?.url,urlVerified:p.response?.url===r.request.url};});
      listen('Network.loadingFinished',p=>{const r=requests.get(p.requestId);if(r){r.finished=true;r.size=p.encodedDataLength;}});
      await send('Page.enable');await send('Runtime.enable');await send('Network.enable',{maxTotalBufferSize:16777216,maxResourceBufferSize:2097152});
      document=await frame();if(document.frameId!==source.frameId||document.loaderId!==source.loaderId||document.documentUrlDigest!==source.documentUrlDigest||document.fullUrl!==PORTAL||unexpected)throw fail('document_changed');
      phase='identity_before';const before=await identity();beforeProjection=before;phase='menu';const selected=selectMenu(await menu(),args.target,this.d.now(),before.userinfo);selectedMenu=selected;menuDifference=selected.difference;
      const second=selectMenu(await menu(),args.target,this.d.now(),before.userinfo);if(selected.url!==second.url)throw fail('menu_changed');await guard();
      selectedMenu.historicalEntryUsed=selected.historicalEntryUsed||second.historicalEntryUsed;
      phase='navigate';mode='navigation';passive=true;navAttempted++;unknown=true;
      const nav=await send('Page.navigate',{url:selected.url,frameId:source.frameId},15000);
      if(nav?.errorText&&navEvents===0&&canonical(await frame())===canonical(document)){unknown=false;mode='original';throw fail('navigation_failed');}
      if(nav?.errorText||nav?.isDownload===true||nav?.frameId!==source.frameId||typeof nav.loaderId!=='string'||nav.loaderId===source.loaderId)throw fail('navigation_unknown');
      navigationAcknowledged=true;unknown=false;
      phase='observe';await timed(()=>this.d.pause(8000),9000);passive=false;await active();await registered();
      landing=await frame();document=landing;if(unexpected||navEvents!==1||navEvent.loaderId!==nav.loaderId||canonical(landing)!==canonical(navEvent))throw fail('document_changed');
      document=landing;mode='stable';unknown=false;navConfirmed++;await guard();
      const landingClass=routeClass(document.fullUrl),sameOrigin=new URL(document.fullUrl).origin===HISTORY_ORIGIN;
      const stableSameOrigin=landingClass==='read_candidate'&&sameOrigin;
      // Unknown expiry semantics authorize this exact normal menu navigation
      // only. Every resulting discovery remains quarantined, even after identity.
      const quarantine=true;
      phase='capture';let capturedBytes=0;
      // Passive response reads are diagnostic. Stop them early instead of
      // consuming the deadline reserved for a stable post-identity and teardown.
      const captureDeadline=Math.min(this.d.clock()+10000,started+45000);
      for(const [id,r] of requests){
        if(requests.get(id)!==r||r.frameId!==source.frameId||r.loaderId!==document.loaderId)continue;
        capturedIds.add(id);counts.selectedRequests++;const item={...requestRecord(r.request),frameId:r.frameId,loaderId:r.loaderId,evidence:'observed',readOnlyVerified:false,enterpriseBinding:false,consumable:false,status:Number.isInteger(r.response?.status)?r.response.status:null,response:null};
        captured.push(item);
        if(r.bucket!=='document'&&r.finished&&r.response?.status===200&&r.response.urlVerified===true&&r.response.url===r.request.url&&Number.isFinite(r.size)&&r.size>=0&&r.size<=2097152&&(r.bucket==='script'||/json/i.test(r.response.mimeType||''))){
          if(unexpected)throw fail('event_unknown');
          if(captureDeadline-this.d.clock()<1000){counts.bodyBudgetSkipped++;continue;}
          let body;try{body=await send('Network.getResponseBody',{requestId:id},Math.min(3000,captureDeadline-this.d.clock()));}catch{counts.bodyUnavailable++;continue;}
          if(requests.get(id)!==r||r.response.urlVerified!==true||r.response.url!==r.request.url){counts.bodyUnavailable++;item.provenance='redirect_invalidated';continue;}
          if(unexpected)throw fail('event_unknown');
          let text=typeof body?.body==='string'?body.body:null;if(text!==null&&body.base64Encoded)text=Buffer.from(text,'base64').toString('utf8');
          const bytes=text===null?0:Buffer.byteLength(text);
          if(text===null||bytes>2097152||capturedBytes+bytes>8388608){counts.bodyUnavailable++;counts.truncated++;}
          else if(r.bucket==='script'){item.assetOrdinal=assets.length;assets.push({text,sourceUrl:r.request.url,requestOrdinal:captured.length-1,modelReadable:false,evidence:'static_candidate'});counts.scripts++;}
          else try{item.response=redact(JSON.parse(text));counts.responseBodies++;}catch{counts.bodyUnavailable++;}
          if(text!==null&&bytes<=2097152)capturedBytes+=bytes;
        }else counts.bodyUnavailable++;
      }
      let after=null;
      const identityBudgetAvailable=90000-(this.d.clock()-started)>=45000;
      if(stableSameOrigin&&identityBudgetAvailable){phase='identity_after';after=await identity();afterProjection=after;}
      record=makeRecord(quarantine,landingClass==='authentication'?'authentication_redirect':!stableSameOrigin?'cross_origin_or_unverified':!identityBudgetAvailable?'identity_budget_unavailable':'menu_expiry_unverified');
      output=quarantineResult(record.landingStatus);
    }catch(error){record=null;if(error?.menuDifference)menuDifference=error.menuDifference;
      if(navigationAcknowledged&&beforeProjection&&!unknown){record=makeRecord(true,'scope_changed');output=quarantineResult('scope_changed');}
      else output={status:'page_exploration_failed',phase,reason:SAFE.has(error?.code||error?.message)?error.code||error.message:'exploration_failed'};}
    finally{
      passive=false;const cleanupFailed=(where,e)=>{unknown=true;cleanupFailureStep??=where;cleanupFailureKind??=e?.code==='deadline'?'timeout':'unconfirmed';};
      if(attached){try{step='source_verify';await active('cleanup');step='registration_verify';await registered('cleanup');step='document_verify';if(canonical(await frame('cleanup'))!==canonical(document)||unexpected)throw fail('document_changed');}
        catch{scopeVerificationFailureStep=step;unexpected=true;if(navigationAcknowledged&&beforeProjection&&!unknown){record=makeRecord(true,'scope_changed');output=quarantineResult('scope_changed');}}
        try{step='detach';detachRequested=true;await timed(()=>transport.cdp.send('Target.detachFromTarget',{sessionId:attached},{timeoutMs:5000}),5000,'cleanup',true);}catch(e){cleanupFailed(step,e);}}
      for(const off of remove)try{off();}catch(e){cleanupFailed('listeners',e);}
      try{if(transport)await timed(()=>transport.close(),3000,'cleanup',true);}catch(e){cleanupFailed('transport_close',e);}
      let lockRetained=lockAcquiring&&unknown;if(lock){if(unknown){lock.retain();lockRetained=true;}else try{await timed(()=>lock.release(),12000,'cleanup',true);}catch(e){cleanupFailed('lock_release',e);lock.retain();lockRetained=true;}}
      if(unknown){record=null;output={status:'page_exploration_failed',phase:'cleanup',reason:'cleanup_unconfirmed'};}
      else if(unexpected&&navigationAcknowledged&&beforeProjection){record=makeRecord(true,'scope_changed');output=quarantineResult('scope_changed');}
      output={...output,target:args.target,counts,menuDifference,labelMatchCounts,expiryDiagnostic,expirySemanticsVerified:false,historicalEntryUsed:selectedMenu?.historicalEntryUsed??false,
        lockRetained,cleanupConfirmed:!unknown,cleanupFailureStep,cleanupFailureKind,scopeVerificationFailureStep,
        sourceState,sourceRetired,sourceScopeUnverified:!record||record.evidence==='quarantined_unverified',sourceReuseAuthorized:false,
        ownOperationUnknown:unknown,scopeStable:!unexpected&&!!record&&record.evidence==='observed',navigationAcknowledged,enterpriseBinding:false,
        identityAttemptedCount:identityAttempted,identityPerformedCount:identityPerformed,identityCompleteCount:identityComplete,identityUnknownCount:identityUnknown,identityNotPerformedCount:identityNotPerformed,
        navigationAttemptedCount:navAttempted,navigationConfirmedCount:navConfirmed,bootstrapContextClearCount:clearCount,downloadPerformed:false,downstreamReady:false,consumable:false};
      if(record)try{if(record.evidence!=='quarantined_unverified')await active('publish');const saved=await timed(()=>this.d.evidence.save(record),60000,'publish');if(record.evidence!=='quarantined_unverified')await active('publish');output={...output,...saved};}
      catch{output={...output,status:'page_exploration_failed',phase:'publish',reason:'storage_failed'};}
    }
    return output;
  }
}
