// Synthetic native-cache/CDP fixtures only. Never reads a private runtime directory.
import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {mkdtemp,mkdir,rm,lstat,readFile,link,unlink,writeFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {TaxDownloadPage,TaxDownloadPageStore,downloadPageMenuScript} from '../server/tax-download-page.mjs';
import {businessProjection} from '../server/tax-collection-shape.mjs';
import {FULL_FRAME_URL_SEMANTICS} from '../server/tax-frame-url.mjs';
import {HISTORY_ORIGIN} from '../server/tax-history-contract.mjs';
const PRIVATE='PRIVATE_DOWNLOAD_PAGE_TRIPWIRE',PORTAL=HISTORY_ORIGIN+'/loginb/',ref=(p,c='1')=>p+'_'+c.repeat(48);
const safe=v=>assert.doesNotMatch(JSON.stringify(v),/PRIVATE_DOWNLOAD|https?:|taxpayer_id|registrationRoot|frameId|loaderId|\.json|发票查询|财务报表申报信息查询|发票综合查询/);
const leaf=(label='财务报表申报信息查询',cddz='/szc/szzh/sjswszzh/spHandler?cdlj=/szzh/zhcx/cwbbsbxxcx/20260101',service=HISTORY_ORIGIN)=>({gnmc:label,cddz,yyfwqdz:service,gndm:'NORMAL',arr:[]});
function fixture(mode='normal',target='financial_report'){
  const body={Response:{Error:null,Data:{userinfo:{reg_number:PRIVATE+'_REG',company_name:PRIVATE+'_CO',creditCode:PRIVATE+'_CC',taxpayer_id:PRIVATE+'_TAX',relatedType:'01'}}}};
  const source={version:2,documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,authorizedNavigation:true,handoffMode:'quarantined_reader_new_navigation',readerStoppedConfirmed:true,
    registrationRef:ref('taxr'),registrationRoot:'D:/synthetic/.agent-runs/tax-browser-registry',pageRef:ref('taxpage'),targetId:PRIVATE+'_TARGET',frameId:PRIVATE+'_FRAME',loaderId:PRIVATE+'_OLD_LOADER',
    documentUrlDigest:createHash('sha256').update(PORTAL).digest('hex'),browserKey:'a'.repeat(64),capturedAt:1000,
    identity:{resource:'identity',recipe:{path:'/mhzx/api/mh/mhsy/getUserInfo',method:'GET',body:null,queryTimestamp:true},projection:businessProjection(body,'identity')},
    filing:{resource:'current_filing',recipe:{path:'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx',method:'POST',body:{Csbz:''},queryTimestamp:true},projection:businessProjection({Response:{Data:{wsbxxGrid:[]}}},'current_filing')}};
  const sourceId=ref('taxsource'),state={mode,target,clock:0,now:1001,calls:[],identities:0,menus:0,fetches:0,nav:0,release:0,retain:0,closed:0,records:[],events:new Map(),abandoned:false,afterReads:0};
  let frame={id:source.frameId,loaderId:source.loaderId,url:PORTAL};
  const emit=(name,p,session='session')=>{for(const fn of state.events.get(name)||[])fn(p,{sessionId:session});};
  let leaves=target==='invoice'?[leaf('全量发票查询','/kpfw/spHandler?cdlj=OPAQUE_MENU_DESTINATION',HISTORY_ORIGIN)]:[leaf()];
  if(mode==='numeric_path')leaves=[leaf('财务报表申报信息查询','/szzh/zhcx/cwbbsbxxcx/20260101')];
  if(mode==='other_labels')leaves=[leaf('全量发票查询'),leaf('发票综合查询'),leaf('财务报表查询')];
  if(mode==='ambiguous')leaves=[leaf(),leaf('财务报表申报信息查询','/szzh/zhcx/cwbbsbxxcx/20260102')];
  if(mode==='duplicate_same')leaves=[leaf(),leaf()];
  if(mode==='cross_dppt')leaves=[leaf('全量发票查询','/kpfw/spHandler?cdlj=OPAQUE_DESTINATION','https://dppt.fujian.chinatax.gov.cn:8443')];
  if(mode==='service_prefix')leaves=[leaf('财务报表申报信息查询','/szzh/sjswszzh/spHandler?cdlj=/szzh/zhcx/cwbbsbxxcx/20260101',HISTORY_ORIGIN+'/szc')];
  if(mode==='tpass_menu')leaves=[leaf('财务报表申报信息查询','/szzh/query','https://tpass.fujian.chinatax.gov.cn')];
  if(mode==='credential_menu')leaves=[leaf('财务报表申报信息查询','/szzh/query?token='+PRIVATE)];
  if(mode==='external_menu')leaves=[leaf('财务报表申报信息查询','/szzh/query','https://example.invalid')];
  if(mode==='write_menu')leaves=[leaf('财务报表申报信息查询','/szzh/saveRecord')];
  if(mode==='dot_menu')leaves=[leaf('财务报表申报信息查询','/szzh/../szzh/query')];
  if(mode==='special_branch')leaves[0].gndm='GN00000410000001';
  if(mode==='financial_login_gateway')leaves=[leaf('财务报表申报信息查询','/szzh/loginGateway')];
  if(mode==='financial_login_query')leaves=[leaf('财务报表申报信息查询','/szzh/loginGateway?cdlj=OPAQUE')];
  if(mode==='invoice_menu_handler')leaves=[leaf('全量发票查询','/actualMenuGroup/spHandler?cdlj=OPAQUE','https://dppt.fujian.chinatax.gov.cn:8443')];
  if(mode==='invoice_wrong_handler')leaves=[leaf('全量发票查询','/actualMenuGroup/spHandlerExtra?cdlj=OPAQUE','https://dppt.fujian.chinatax.gov.cn:8443')];
  if(mode==='invoice_auth_handler')leaves=[leaf('全量发票查询','/loginGroup/spHandler?cdlj=OPAQUE','https://dppt.fujian.chinatax.gov.cn:8443')];
  if(mode==='invoice_write_handler')leaves=[leaf('全量发票查询','/saveGroup/spHandler?cdlj=OPAQUE','https://dppt.fujian.chinatax.gov.cn:8443')];
  const responseBodies=new Map();
  const network=(id,url,type='Fetch',method='POST',payload={Response:{Error:null,Data:{List:[{value:PRIVATE,token:PRIVATE}]}}},options={})=>{
    emit('Network.requestWillBeSent',{requestId:id,request:{url,method,postData:JSON.stringify({key:PRIVATE,token:PRIVATE})},frameId:frame.id,loaderId:frame.loaderId,type,...options});
    emit('Network.responseReceived',{requestId:id,response:{url,status:200,mimeType:type==='Script'?'application/javascript':'application/json'}});
    emit('Network.loadingFinished',{requestId:id,encodedDataLength:100});responseBodies.set(id,type==='Script'?payload:JSON.stringify(payload));
  };
  const cdp={on(name,fn){if(!state.events.has(name))state.events.set(name,new Set());state.events.get(name).add(fn);return()=>{state.events.get(name).delete(fn);if(mode==='off_failure')throw Error(PRIVATE);};},
    async send(method,params,opts){state.calls.push({method,params,opts});assert.ok(opts.timeoutMs>0&&opts.timeoutMs<=15000);
      if(method==='Target.getTargetInfo')return {targetInfo:{type:'page'}};
      if(method==='Target.attachToTarget'){if(mode==='attach_timeout')throw Error(PRIVATE);return {sessionId:'session'};}
      if(method==='Target.detachFromTarget'){if(mode==='detach_failure')throw Error(PRIVATE);return {};}
      if(method==='Runtime.enable'){emit('Runtime.executionContextCreated',{context:{id:10}});return {};}
      if(method==='Page.createIsolatedWorld'){
        assert.deepEqual(params,{frameId:source.frameId,worldName:'youshu-download-menu',grantUniveralAccess:false});
        if(mode==='isolated_world_timeout')throw Error(PRIVATE);return {executionContextId:77};
      }
      if(['Page.enable','Network.enable'].includes(method))return {};
      if(method==='Runtime.disable'){emit('Runtime.executionContextsCleared',{});throw Error('must_not_call');}
      if(method==='Page.getFrameTree'){
        if(mode==='late_redirect_before_body'&&state.nav&&!state.lateRedirect){state.lateRedirect=true;
          emit('Network.requestWillBeSent',{requestId:'json',request:{url:'https://example.invalid/auth',method:'GET'},redirectResponse:{status:302},frameId:frame.id,loaderId:frame.loaderId,type:'Fetch'});
          emit('Network.responseReceived',{requestId:'json',response:{url:'https://example.invalid/auth',status:200,mimeType:'application/json'}});
        }
        if(mode==='original_hash'&&state.nav===0)frame.urlFragment='#';
        if(mode==='missing_frame'&&state.nav)state.clock=91000;
        if(mode==='cleanup_document'&&state.identities===2)frame.urlFragment='#late';
        return {frameTree:{frame:{...frame}}};
      }
      if(method==='Runtime.evaluate'){
        const menu=params.expression.includes('mhNavDataAfter_mh');if(menu)state.menus++;else state.identities++;
        assert.equal(params.contextId,menu?77:undefined);
        if(!menu&&mode==='identity_timeout')return new Promise(()=>{});
        const location={href:frame.url+(frame.urlFragment||''),origin:new URL(frame.url).origin};
        const entries=structuredClone(leaves);if(mode==='menu_changed'&&state.menus===2)entries[0].cddz='/szzh/other';
        const expiries={expired_menu:900,zero_expiry:0,negative_expiry:-1,seconds_expiry:1800000000,historical_date:1700000000000};
        const envelope={val:entries,exp:Object.hasOwn(expiries,mode)?expiries[mode]:100000};
        const now=state.now,storage=Object.create(null);Object.defineProperty(storage,'getItem',{value:mode==='nonnative_storage'?()=>{}:Array.prototype.push});
        const reflect={...Reflect,apply(fn,obj,args){assert.equal(fn,storage.getItem);assert.deepEqual([...args],['mhNavDataAfter_mh']);return JSON.stringify(envelope);}};
        const value=await runInNewContext(params.expression,{location,URL,AbortController,TextDecoder,Date:class extends Date{static now(){return now;}},Storage:{prototype:storage},sessionStorage:{},Reflect:reflect,
          window:{fetch:mode==='nonnative_fetch'?()=>{}:Array.prototype.push,setTimeout:Array.prototype.push},setTimeout:()=>1,clearTimeout:()=>{},
          async fetch(url,init){state.fetches++;assert.match(url,/\/mhzx\/api\/mh\/mhsy\/getUserInfo\?t=\d+$/);assert.equal(init.method,'GET');assert.equal(init.body,undefined);
            let result=structuredClone(body);if(mode==='enterprise_changed'&&state.identities===2)result.Response.Data.userinfo.creditCode=PRIVATE+'_OTHER';
            if(mode==='identity_event')emit('Runtime.executionContextsCleared',{});
            return new Response(JSON.stringify(result),{status:mode==='identity_http'?500:200});}});
        if(!menu&&mode==='unknown_identity_status')return {result:{value:{status:PRIVATE,settled:true}}};
        if(!menu&&mode==='proof_performed_false')value.requestPerformed=false;
        if(!menu&&mode==='proof_complete_false')value.responseComplete=false;
        if(!menu&&mode==='proof_performed_missing')delete value.requestPerformed;
        if(!menu&&mode==='proof_complete_missing')delete value.responseComplete;
        if(!menu&&mode==='wrong_proof')value.requestRef=ref('taxreq','f');return {result:{value}};
      }
      if(method==='Page.navigate'){
        state.nav++;assert.equal(params.frameId,source.frameId);const selected=leaves[0].yyfwqdz+leaves[0].cddz;
        assert.equal(params.url,new URL(selected,PORTAL).href);if(mode==='navigation_timeout')throw Error(PRIVATE);
        if(mode==='navigation_error')return {errorText:PRIVATE};
        const origin=mode==='cross_dppt'?'https://dppt.fujian.chinatax.gov.cn:8443':HISTORY_ORIGIN;
        frame={id:source.frameId,loaderId:PRIVATE+'_NEW_LOADER',url:origin+(target==='invoice'?'/kpfw/invoice/query':'/szzh/zhcx/cwbbsbxxcx/20260101?ruuid='+PRIVATE)};
        if(mode==='authentication_landing')frame.url='https://tpass.fujian.chinatax.gov.cn/login?ticket='+PRIVATE;
        if(mode==='financial_login_gateway')frame.url=HISTORY_ORIGIN+'/szzh/loginGateway';
        if(mode==='external_landing')frame.url='https://example.invalid/callback';
        emit('Runtime.executionContextsCleared',{});emit('Runtime.executionContextsCleared',{});
        if(mode==='third_clear')emit('Runtime.executionContextsCleared',{});
        if(mode!=='missing_frame')emit('Page.frameNavigated',{frame:{...frame}});
        if(mode==='aba')emit('Page.frameNavigated',{frame:{...frame}});
        if(mode==='clear_after_frame')emit('Runtime.executionContextsCleared',{});
        if(mode==='retired_after_nav')state.abandoned=true;
        network('json',origin+'/szzh/DescribeObservedQuery','Fetch','POST');
        network('script',origin+'/szzh/assets/query.123.js','Script','GET','const url="/szzh/DescribeObservedQuery";');
        network('auth',origin+'/szzh/getToken','Fetch','GET');network('write',origin+'/szzh/saveRecord','Fetch','POST');
        network('outside','https://example.invalid/szzh/query','Fetch','GET');
        if(mode==='child_old_loader'){
          emit('Page.frameNavigated',{frame:{id:PRIVATE+'_CHILD',parentId:source.frameId,loaderId:PRIVATE+'_CHILD_OLD',url:origin+'/szzh/child'}});
          emit('Page.frameNavigated',{frame:{id:PRIVATE+'_CHILD',parentId:source.frameId,loaderId:PRIVATE+'_CHILD_NEW',url:origin+'/szzh/child-new'}});
          emit('Network.requestWillBeSent',{requestId:'old-child',request:{url:origin+'/szzh/DescribeOldChild',method:'POST'},frameId:PRIVATE+'_CHILD',loaderId:PRIVATE+'_CHILD_OLD',type:'Fetch'});
          emit('Network.responseReceived',{requestId:'old-child',response:{status:200,mimeType:'application/json'}});
          emit('Network.loadingFinished',{requestId:'old-child',encodedDataLength:100});
        }
        if(mode==='crowded_capture')for(let i=0;i<90;i++)network('extra-'+i,origin+'/szzh/DescribeExtraQuery','Fetch','POST');
        if(mode==='document_metadata')network('document',params.url,'Document','GET');
        if(mode==='redirect_replacement'){
          network('json','https://example.invalid/redirect','Fetch','GET',{}, {redirectResponse:{status:302}});
        }
        if(mode==='too_large')responseBodies.set('json','x'.repeat(2097153));
        if(mode==='invalid_json')responseBodies.set('json',PRIVATE);
        if(mode==='base64_body')responseBodies.set('json',Buffer.from(JSON.stringify({key:PRIVATE,token:PRIVATE})).toString('base64'));
        return {frameId:frame.id,loaderId:frame.loaderId};
      }
      if(method==='Network.getResponseBody'){
        if(mode==='late_redirect_during_body'&&params.requestId==='json'){
          emit('Network.requestWillBeSent',{requestId:'json',request:{url:'https://example.invalid/auth',method:'GET'},redirectResponse:{status:302},frameId:frame.id,loaderId:frame.loaderId,type:'Fetch'});
          emit('Network.responseReceived',{requestId:'json',response:{url:'https://example.invalid/auth',status:200,mimeType:'application/json'}});
          return {body:JSON.stringify({foreign:'FOREIGN_AUTH_BODY_TRIPWIRE'}),base64Encoded:false};
        }
        if(mode==='crowded_capture')state.clock+=4000;
        assert.ok(!state.calls.some(c=>c.method==='Runtime.evaluate'&&c.params.expression.includes('getUserInfo')&&state.identities===0));
        if(mode==='response_timeout')throw Error(PRIVATE);
        return {body:responseBodies.get(params.requestId),base64Encoded:mode==='base64_body'&&params.requestId==='json'};
      }
      throw Error(PRIVATE);
    }};
  const admin=new TaxDownloadPage({enabled:true,now:()=>state.now,clock:()=>state.clock,pause:async ms=>{assert.equal(ms,8000);if(mode==='late_capture_budget')state.clock=50000;},
    store:{async load(id){assert.equal(id,sourceId);return structuredClone(source);},async assertNotAbandoned(id){assert.equal(id,sourceId);if(state.abandoned)throw Error(PRIVATE);}},
    evidence:{async save(record){if(mode==='storage_failure')throw Error(PRIVATE);state.records.push(structuredClone(record));return {artifactRef:ref('taxdownloadpage'),safeAssetRefs:[]};}},
    async acquireLock(_path,opts){assert.equal(opts.scope.operation,'download_page_exploration');if(mode==='busy')throw Error('tax_collection_busy');return {async release(){state.release++;if(mode==='release_failure')throw Error(PRIVATE);},retain(){state.retain++;}};},
    async openDiagnostic(){return {cdp,localScope:{browserKey:source.browserKey,profilePath:'D:/synthetic/profile',registrationState:'quarantined',
      async currentRegistrationState(){if(state.identities===2)state.afterReads++;if(mode==='registry_after'&&state.nav)return 'active';return 'quarantined';}},
      async close(){state.closed++;if(mode==='close_failure')throw Error(PRIVATE);}};}});
  return {admin,state,source,sourceId,emit,leaves};
}

test('fixed same-origin financial page: two fresh identities, native menu twice, original URL and passive private evidence',async()=>{
  const f=fixture(),r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);
  assert.equal(r.status,'page_quarantined_unverified');assert.equal(r.identityCompleteCount,2);assert.equal(r.identityUnknownCount,0);assert.equal(r.navigationConfirmedCount,1);assert.equal(r.lockRetained,false);
  assert.equal(r.downloadPerformed,false);assert.equal(r.consumable,false);assert.equal(r.downstreamReady,false);assert.equal(r.labelMatchCounts.financial_filing_query,1);
  assert.equal(f.state.menus,2);assert.equal(f.state.nav,1);assert.equal(f.state.fetches,2);assert.equal(f.state.release,1);assert.equal(f.state.closed,1);
  const record=f.state.records[0];assert.equal(record.requests.length,2);assert.equal(record.assets.length,1);assert.equal(record.identityAfterProjection,null);assert.equal(record.expirySemanticsVerified,false);
  assert.equal(record.requests[0].response.Response.Data.List[0].value,PRIVATE);assert.equal(record.requests[0].response.Response.Data.List[0].token,'[credential omitted]');
  assert.equal(record.requests[0].body.token,'[credential omitted]');assert.equal(record.requests[0].readOnlyVerified,false);assert.equal(record.assets[0].modelReadable,false);
  assert.equal(record.requests[1].assetOrdinal,0);assert.equal(record.assets[0].requestOrdinal,1);assert.match(record.navigation.url,/spHandler\?cdlj=/);
  assert.equal(f.state.calls.some(c=>['Runtime.disable','Page.disable','Network.disable','Browser.close','Target.closeTarget'].includes(c.method)),false);
  assert.equal(r.counts.authentication,1);assert.equal(r.counts.sideEffect,1);assert.equal(r.counts.external,1);
});
for(const mode of ['numeric_path','service_prefix'])test('menu original address supports '+mode,async()=>{
  const f=fixture(mode),r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);assert.equal(r.status,'page_quarantined_unverified');assert.equal(f.state.nav,1);
});
test('invoice opaque cdlj is navigated as the exact menu URL without reconstructing a route',async()=>{
  const f=fixture('normal','invoice'),r=await f.admin.navigate({sourceRef:f.sourceId,target:'invoice'});safe(r);assert.equal(r.status,'page_quarantined_unverified');
  assert.match(f.state.calls.find(c=>c.method==='Page.navigate').params.url,/cdlj=OPAQUE_MENU_DESTINATION$/);
  assert.equal(r.labelMatchCounts.all_invoice_query,1);assert.equal(r.labelMatchCounts.invoice_query,0);
});
for(const [mode,target] of [['financial_login_gateway','financial_report'],['invoice_menu_handler','invoice']])test('verified exact official menu gateway supports only normal navigation '+mode,async()=>{
  const f=fixture(mode,target),r=await f.admin.navigate({sourceRef:f.sourceId,target});safe(r);assert.equal(r.status,'page_quarantined_unverified');assert.equal(f.state.nav,1);
  assert.equal(r.lockRetained,false);assert.equal(r.enterpriseBinding,false);assert.equal(r.consumable,false);
  if(mode==='financial_login_gateway'){assert.equal(r.landingStatus,'authentication_redirect');assert.equal(r.identityCompleteCount,1);assert.equal(f.state.fetches,1);}
});
for(const [mode,target,reason] of [['financial_login_query','financial_report','authentication_route'],['invoice_wrong_handler','invoice','path_root'],
  ['invoice_auth_handler','invoice','authentication_route'],['invoice_write_handler','invoice','side_effect_route']])test('menu gateway exceptions preserve other boundaries '+mode,async()=>{
  const f=fixture(mode,target),r=await f.admin.navigate({sourceRef:f.sourceId,target});safe(r);assert.equal(r.status,'page_exploration_failed');assert.equal(f.state.nav,0);
  assert.equal(r.menuDifference.rejectionCounts[reason],1);assert.equal(r.lockRetained,false);
});
for(const [mode,classification] of [['expired_menu','positive_small'],['zero_expiry','zero'],['negative_expiry','negative'],['seconds_expiry','epoch_seconds_like'],['historical_date','epoch_milliseconds_like']])test('historical/unknown expiry permits only exact normal navigation and quarantined discovery '+mode,async()=>{
  const f=fixture(mode);if(mode==='historical_date'){f.state.now=1800000000000;f.source.capturedAt=f.state.now-1;}
  const r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);assert.equal(r.status,'page_quarantined_unverified');assert.equal(f.state.nav,1);
  assert.equal(r.expiryDiagnostic.classification,classification);assert.equal(r.expiryDiagnostic.semanticsVerified,false);assert.equal(r.expirySemanticsVerified,false);
  assert.equal(r.labelMatchCounts.financial_filing_query,1);assert.equal(r.historicalEntryUsed,true);assert.equal(r.enterpriseBinding,false);assert.equal(r.consumable,false);assert.equal(r.lockRetained,false);
  if(mode==='historical_date')assert.equal(r.expiryDiagnostic.comparison,'past');
});
for(const mode of ['late_redirect_before_body','late_redirect_during_body'])test('late redirect never inherits a previous allowed request provenance '+mode,async()=>{
  const f=fixture(mode),r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);assert.equal(r.status,'page_quarantined_unverified');assert.equal(r.lockRetained,false);
  assert.doesNotMatch(JSON.stringify(f.state.records),/FOREIGN_AUTH_BODY_TRIPWIRE|example\.invalid\/auth/);
  if(mode==='late_redirect_before_body')assert.equal(f.state.calls.some(c=>c.method==='Network.getResponseBody'&&c.params.requestId==='json'),false);
  else{const previous=f.state.records[0].requests.find(v=>v.url.includes('DescribeObservedQuery'));assert.equal(previous.response,null);assert.equal(previous.provenance,'redirect_invalidated');}
});
test('diagnostic vocabulary counts actual labels but never fuzzy-selects alternatives',async()=>{
  const f=fixture('other_labels'),r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);
  assert.equal(r.reason,'menu_target_missing');assert.equal(r.labelMatchCounts.all_invoice_query,1);assert.equal(r.labelMatchCounts.invoice_comprehensive_query,1);assert.equal(r.labelMatchCounts.financial_report_query,1);
  assert.equal(r.labelMatchCounts.financial_filing_query,0);assert.equal(f.state.nav,0);
});
for(const mode of ['ambiguous','duplicate_same','tpass_menu','external_menu','credential_menu','write_menu','dot_menu','special_branch','nonnative_storage','menu_changed'])test('menu rejects before navigation '+mode,async()=>{
  const f=fixture(mode),r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);assert.equal(r.status,'page_exploration_failed');assert.equal(f.state.nav,0);
  assert.equal(r.lockRetained,false);if(mode==='ambiguous'){assert.equal(r.menuDifference.exactMatchCount,2);assert.equal(r.menuDifference.distinctRouteCount,2);}
  const reasons={tpass_menu:'origin',external_menu:'origin',credential_menu:'authentication_route',write_menu:'side_effect_route',dot_menu:'path_encoding_or_traversal',special_branch:'special_branch'};
  if(reasons[mode])assert.equal(r.menuDifference.rejectionCounts[reasons[mode]],1);
});
for(const mode of ['cross_dppt','authentication_landing','external_landing'])test('cross-origin/auth landing is quarantined with one identity and no guessed identity request '+mode,async()=>{
  const target=mode==='cross_dppt'?'invoice':'financial_report',f=fixture(mode,target),r=await f.admin.navigate({sourceRef:f.sourceId,target});safe(r);
  assert.equal(r.status,'page_quarantined_unverified');assert.equal(r.identityCompleteCount,1);assert.equal(f.state.fetches,1);assert.equal(r.identityProjectionMatched,false);
  assert.equal(r.consumable,false);assert.equal(r.lockRetained,false);assert.equal(f.state.records[0].evidence,'quarantined_unverified');assert.equal(f.state.records[0].identityAfterProjection,null);
  if(mode!=='cross_dppt')assert.equal(f.state.records[0].document,null);
});
for(const mode of ['attach_timeout','isolated_world_timeout','wrong_proof','unknown_identity_status','proof_performed_false','proof_complete_false','proof_performed_missing','proof_complete_missing','navigation_timeout','detach_failure','off_failure','close_failure','release_failure'])test('owned-operation uncertainty retains lock and publishes nothing '+mode,async()=>{
  const f=fixture(mode),r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);assert.equal(r.status,'page_exploration_failed');assert.equal(r.lockRetained,true);assert.equal(f.state.retain,1);assert.equal(f.state.records.length,0);
});
for(const mode of ['identity_http','nonnative_fetch','identity_event','navigation_error','original_hash','busy','storage_failure'])test('settled failure is honest '+mode,async()=>{
  const f=fixture(mode),r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);assert.equal(r.status,'page_exploration_failed');assert.equal(r.lockRetained,false);assert.equal(f.state.records.length,0);
});
for(const mode of ['third_clear','aba','clear_after_frame','retired_after_nav','registry_after','enterprise_changed','cleanup_document','missing_frame'])test('known scope change quarantines discoveries and releases confirmed owned operation '+mode,async()=>{
  const f=fixture(mode),r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);assert.equal(r.status,'page_quarantined_unverified');
  assert.equal(r.lockRetained,false);assert.equal(r.ownOperationUnknown,false);assert.equal(r.cleanupConfirmed,true);assert.equal(r.enterpriseBinding,false);assert.equal(r.identityProjectionMatched,false);
  assert.equal(f.state.release,1);assert.equal(f.state.closed,1);assert.equal(f.state.records[0].evidence,'quarantined_unverified');assert.equal(f.state.records[0].identityAfterProjection,null);
  assert.equal(f.state.records[0].sourceScopeUnverified,true);assert.equal(f.state.records[0].sourceReuseAuthorized,false);
  if(mode==='retired_after_nav'){assert.equal(f.state.records[0].sourceState,'retired_or_unavailable');assert.equal(f.state.records[0].sourceRetired,null);}
  if(mode!=='enterprise_changed'&&mode!=='cleanup_document')assert.equal(f.state.identities,1);
});
test('diagnostic response-body failure consumes no owned-runtime uncertainty or persistent lock',async()=>{
  const f=fixture('response_timeout'),r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);assert.equal(r.status,'page_quarantined_unverified');assert.equal(r.lockRetained,false);
  assert.equal(r.ownOperationUnknown,false);assert.equal(r.identityCompleteCount,2);assert.equal(f.state.records[0].captureComplete,false);assert.ok(r.counts.bodyUnavailable>0);
});
test('old child loader responses are never captured or attributed to the main document',async()=>{
  const f=fixture('child_old_loader'),r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);assert.equal(r.status,'page_quarantined_unverified');
  assert.ok(r.counts.subframeUnverified>=3);assert.equal(f.state.records[0].requests.length,2);assert.equal(f.state.calls.some(c=>c.method==='Network.getResponseBody'&&c.params.requestId==='old-child'),false);
  assert.equal(f.state.records[0].requests.every(v=>v.frameId===f.source.frameId),true);
});
test('crowded capture truncates diagnostics and reserves post-identity and cleanup instead of retaining a lock',async()=>{
  const f=fixture('crowded_capture'),r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);assert.equal(r.status,'page_quarantined_unverified');
  assert.equal(r.identityCompleteCount,2);assert.equal(r.lockRetained,false);assert.ok(r.counts.bodyBudgetSkipped>0);assert.ok(r.counts.truncated>0);
  assert.ok(f.state.calls.filter(c=>c.method==='Network.getResponseBody').length<=3);assert.equal(f.state.records[0].captureComplete,false);assert.equal(f.state.release,1);
});
test('insufficient post-identity reserve quarantines without dispatching another runtime read',async()=>{
  const f=fixture('late_capture_budget'),r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);assert.equal(r.status,'page_quarantined_unverified');
  assert.equal(r.landingStatus,'identity_budget_unavailable');assert.equal(r.identityCompleteCount,1);assert.equal(r.ownOperationUnknown,false);assert.equal(r.lockRetained,false);
  assert.equal(f.state.calls.filter(c=>c.method==='Network.getResponseBody').length,0);assert.equal(f.state.records[0].identityAfterProjection,null);
});
for(const mode of ['too_large','invalid_json','base64_body','redirect_replacement'])test('passive body boundaries '+mode,async()=>{
  const f=fixture(mode),r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);assert.equal(r.status,'page_quarantined_unverified');
  if(mode==='base64_body')assert.equal(f.state.records[0].requests[0].response.token,'[credential omitted]');
  if(mode==='redirect_replacement'){assert.equal(f.state.records[0].requests.length,1);assert.equal(r.counts.redirects,1);}
  if(['too_large','invalid_json'].includes(mode)){assert.ok(r.counts.bodyUnavailable>0);assert.equal(f.state.records[0].requests[0].response,null);}
});
for(const input of [{},null,[],{sourceRef:'bad',target:'invoice'},{sourceRef:ref('taxsource'),target:'unknown'},
  {sourceRef:ref('taxsource'),target:'invoice',url:PORTAL},{sourceRef:ref('taxsource'),target:'invoice',label:'anything'},{sourceRef:ref('taxsource'),target:'invoice',body:{}}])test('strict action input '+JSON.stringify(input),async()=>{
  const f=fixture(),r=await f.admin.navigate(input);safe(r);assert.equal(r.status,'input_invalid');assert.equal(f.state.calls.length,0);
});
test('disabled by default; retired and expired source stop before browser',async()=>{
  const f=fixture();f.admin.d.enabled=false;assert.equal((await f.admin.navigate({sourceRef:f.sourceId,target:'invoice'})).status,'not_enabled');
  f.admin.d.enabled=true;f.state.abandoned=true;assert.equal((await f.admin.navigate({sourceRef:f.sourceId,target:'invoice'})).reason,'source_inactive');assert.equal(f.state.calls.length,0);
  f.state.abandoned=false;f.state.now=1801001;assert.equal((await f.admin.navigate({sourceRef:f.sourceId,target:'invoice'})).reason,'source_expired');
});
test('genuinely unresolved identity CDP promise returns on its bound and retains exclusion',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture('identity_timeout'),pending=f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.state.identities,1);f.state.clock=14001;t.mock.timers.tick(14001);
  const r=await pending;safe(r);assert.equal(r.lockRetained,true);assert.equal(r.identityUnknownCount,1);assert.equal(f.state.nav,0);
});
test('menu script reads only the known native key; no DOM/handler/click or network capability exists',()=>{
  const script=downloadPageMenuScript();assert.doesNotMatch(script,/\.click\(|querySelector|fetch\(|XMLHttpRequest|onclick|localStorage/);
  assert.match(script,/mhNavDataAfter_mh/);assert.match(script,/getOwnPropertyDescriptor/);
});
test('actual document request metadata is kept privately without requesting its HTML body',async()=>{
  const f=fixture('document_metadata'),r=await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});safe(r);assert.equal(r.status,'page_quarantined_unverified');
  const request=f.state.records[0].requests.at(-1);assert.equal(request.url,f.state.records[0].navigation.url);assert.equal(request.evidence,'observed');assert.equal(request.response,null);
  assert.equal(f.state.calls.some(c=>c.method==='Network.getResponseBody'&&c.params.requestId==='document'),false);
});

test('private evidence publishes a manifest last, quarantines scripts, and rejects aliases/hardlinks/arbitrary paths',async()=>{
  const temporaryParent=dirname(fileURLToPath(import.meta.url));
  const parent=await mkdtemp(join(temporaryParent,'tax-download-page-synthetic-')),root=join(parent,'evidence');
  const security={testStorage:true,async secureDirectory(){},async verifyDirectory(p){assert.ok((await lstat(p)).isDirectory());},async verifyFile(p){assert.ok((await lstat(p)).isFile());}};
  try{
    const f=fixture();await f.admin.navigate({sourceRef:f.sourceId,target:'financial_report'});const store=new TaxDownloadPageStore({root,security});
    const saved=await store.save(f.state.records[0]);safe(saved);const loaded=await store.load(saved.artifactRef);
    assert.equal(loaded.sourceRef,f.sourceId);assert.equal(loaded.assets[0].modelReadable,false);assert.equal(loaded.assets[0].evidence,'static_candidate');
    assert.equal(loaded.assets[0].requestOrdinal,1);assert.match(loaded.assets[0].sourceUrl,/query\.123\.js$/);
    const folder=join(root,saved.artifactRef),asset=join(folder,loaded.assets[0].file);assert.match(await readFile(asset,'utf8'),/DescribeObservedQuery/);
    await assert.rejects(()=>store.load('../outside'));await assert.rejects(()=>store.write(folder,'../outside','bad'));
    await assert.rejects(()=>store.save({...f.state.records[0],consumable:true}));
    const manifest=join(folder,'manifest.json'),alias=join(parent,'alias.json');await link(manifest,alias);await assert.rejects(()=>store.load(saved.artifactRef));await unlink(alias);
    assert.equal((await store.load(saved.artifactRef)).consumable,false);
    const incomplete=ref('taxdownloadpage','2');await mkdir(join(root,incomplete));await writeFile(join(root,incomplete,'private.tmp'),'incomplete');await assert.rejects(()=>store.load(incomplete));
  }finally{assert.equal(dirname(resolve(parent)),resolve(temporaryParent));assert.match(parent.split(/[\\/]/).at(-1),/^tax-download-page-synthetic-/);await rm(parent,{recursive:true,force:true});}
});
