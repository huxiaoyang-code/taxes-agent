// 仅用合成数据。不读取已登记浏览器、私有采集结果或实时账套。
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,lstat,rm,writeFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {TaxCollectionStore,collectionLock} from '../server/tax-collection-local.mjs';
import {TaxHistoryStore} from '../server/tax-history-store.mjs';
import {TaxHistoryCollection} from '../server/tax-history-collection.mjs';
import {businessProjection} from '../server/tax-collection-shape.mjs';
import {HISTORY_ORIGIN,HISTORY_PATH} from '../server/tax-history-contract.mjs';
import {FULL_FRAME_URL_SEMANTICS} from '../server/tax-frame-url.mjs';
export const PRIVATE='PRIVATE_SYNTHETIC_HISTORY_TRIPWIRE';
export const ref=(p,c='1')=>p+'_'+c.repeat(48);
export const safe=v=>assert.doesNotMatch(JSON.stringify(v),/PRIVATE_SYNTHETIC|targetId|frameId|loaderId|registrationRoot|profilePath|https?:|\.json|\bybtse\b/);
export const security={testStorage:true,async secureDirectory(){},async verifyDirectory(p){assert.ok((await lstat(p)).isDirectory());},
  async verifyFile(p){assert.ok((await lstat(p)).isFile());}};
export function recipe(){return {path:HISTORY_PATH,method:'POST',query:[],body:{gzlx:['synthetic_a','synthetic_b'],pageNum:1,pageSize:10,
  sbrqq:'',sbrqz:'',skssqq:'',skssqz:'',zfbz:'',yzpzzlDm:''}};}
export function row(suffix='a'){return {zsxmDmArray:null,nssbrq:PRIVATE,skssqq:'2026-09-01 00:00:00',skssqz:'2026-09-30 00:00:00',ybtse:12.34,
  gzlxDm:PRIVATE,gzlx:PRIVATE,zfbz:PRIVATE,zfrq:'',sbuuid:PRIVATE+suffix,yzpzzlDm:PRIVATE,yzpzzlMc:PRIVATE,pzxh:PRIVATE+suffix};}
export function response(rows=[row('a'),row('a')],total=rows.length){return {Response:{Error:null,Data:{PageNumber:1,PageSize:10,Total:total,List:rows}}};}
export async function makeFixture(directory,options={}){
  const state={mode:options.mode||'normal',requests:[],closeCount:0,detachCount:0,opens:0,now:1002,clock:0};
  const parentStore=new TaxCollectionStore({root:join(directory,'parent'),security});
  const store=new TaxHistoryStore({root:join(directory,'history'),captureRoot:join(directory,'capture'),security});
  const profile=join(directory,'profile');await mkdir(profile);
  const identityBody={Response:{Error:null,Data:{userinfo:{reg_number:PRIVATE+'_REG',company_name:PRIVATE+'_COMPANY',creditCode:PRIVATE+'_CREDIT',taxpayer_id:PRIVATE+'_TAX'}}}};
  const identity={resource:'identity',recipe:{path:'/mhzx/api/mh/mhsy/getUserInfo',method:'GET',body:null,queryTimestamp:true},projection:businessProjection(identityBody,'identity')};
  const filing={resource:'current_filing',recipe:{path:'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx',method:'POST',body:{Csbz:''},queryTimestamp:true},
    projection:businessProjection({Response:{Data:{wsbxxGrid:[]}}},'current_filing')};
  const parent={version:2,documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,authorizedNavigation:true,handoffMode:'quarantined_reader_new_navigation',readerStoppedConfirmed:true,
    registrationRef:ref('taxr'),registrationRoot:join(directory,'.agent-runs','tax-browser-registry'),pageRef:ref('taxpage'),
    targetId:PRIVATE+'_TARGET',frameId:PRIVATE+'_PORTALFRAME',loaderId:PRIVATE+'_PORTALLOADER',browserKey:'a'.repeat(64),documentUrlDigest:'b'.repeat(64),capturedAt:1000,identity,filing};
  const sourceRef=await parentStore.save('source',parent),artifactRef=ref('taxquery');
  const url=HISTORY_ORIGIN+'/szzh/zhcx/sbxx/sbxxcx?ruuid='+PRIVATE;
  const manifest={version:1,sourceRef,target:'filing_query',capturedAt:1001,requests:[{url:HISTORY_ORIGIN+HISTORY_PATH,method:'POST',body:recipe().body,response:response()}],
    assets:[],document:{targetId:parent.targetId,frameId:PRIVATE+'_QUERYFRAME',loaderId:PRIVATE+'_QUERYLOADER',url},identityProjection:identity.projection};
  await mkdir(join(store.captureRoot,artifactRef),{recursive:true});await writeFile(join(store.captureRoot,artifactRef,'manifest.json'),JSON.stringify(manifest));
  const frame={id:manifest.document.frameId,loaderId:manifest.document.loaderId,url};
  const collector=new TaxHistoryCollection({store,parentStore,enabled:true,now:()=>state.now,clock:()=>state.clock,
    acquireLock:(path,opts)=>collectionLock(path,{...opts,security}),
    async openDiagnostic(){state.opens++;if(state.mode==='deadline')state.clock=130000;const handlers=new Map();return {localScope:{browserKey:parent.browserKey,profilePath:profile,registrationState:'quarantined',
      async currentRegistrationState(){return state.mode==='registry_changed'&&state.requests.length>0?'active':'quarantined';}},
      async close(){state.closeCount++;if(state.mode==='close_failure')throw Error(PRIVATE);},cdp:{
        on(name,fn){handlers.set(name,fn);return()=>{handlers.delete(name);if(state.mode==='off_failure')throw Error(PRIVATE);};},
        async send(method,params){
          if(method==='Target.getTargetInfo')return {targetInfo:{type:'page'}};
          if(method==='Target.attachToTarget')return {sessionId:'synthetic-session'};
          if(method==='Target.detachFromTarget'){state.detachCount++;if(state.mode==='detach_failure')throw Error(PRIVATE);return {};}
          if(method==='Page.getFrameTree')return {frameTree:{frame:{...frame}}};
          if(['Page.enable','Runtime.enable','Page.disable','Runtime.disable'].includes(method))return {};
          if(method==='Runtime.evaluate'){
            if(state.mode==='cdp_timeout')throw Error(PRIVATE);
            const location={href:frame.url,origin:HISTORY_ORIGIN};
            if(state.mode==='scope_before_dispatch')location.href+='&changed=1';
            const value=await runInNewContext(params.expression,{location,URL,AbortController,TextDecoder,
              window:{fetch:Array.prototype.push,setTimeout:Array.prototype.push},setTimeout:()=>0,clearTimeout:()=>{},
              async fetch(address,init){
                const history=address.includes(HISTORY_PATH);state.requests.push({history,address,init});
                if(state.mode==='fetch_unknown')throw Error(PRIVATE);
                if(history){assert.equal(address,HISTORY_ORIGIN+HISTORY_PATH);assert.deepEqual(JSON.parse(init.body),recipe().body);}
                let body=structuredClone(history?response():identityBody);
                if(history&&state.mode==='partial')body=response([row()],12);
                if(history&&state.mode==='changed')body=response([row('b')]);
                if(history&&state.mode==='extra_field')body.Response.Data.List[0][PRIVATE]=PRIVATE;
                if(history&&state.mode==='period_invalid')body.Response.Data.List[0].skssqq='2026-02-30 00:00:00';
                if(state.mode==='enterprise_changed')body.Response.Data.userinfo&&(body.Response.Data.userinfo.taxpayer_id=PRIVATE+'_OTHER');
                if(state.mode==='business_error')body.Response.Error={Message:PRIVATE};
                if(state.mode==='aba'&&history)handlers.get('Page.navigatedWithinDocument')?.({}, {sessionId:'synthetic-session'});
                return new Response(JSON.stringify(body),{status:state.mode==='http_error'?500:200});
              }});
            return {result:{value:state.mode==='wrong_proof'?{...value,requestRef:ref('taxreq','f')}:value}};
          }
          throw Error('synthetic_unexpected_cdp');
        }}};}
  });
  return {state,store,parentStore,profile,parent,sourceRef,artifactRef,manifest,frame,collector};
}
export async function fixture(callback,options){
  const temporaryParent=fileURLToPath(new URL('../.agent-runs/tax-history-test-temporary/',import.meta.url));
  await mkdir(temporaryParent,{recursive:true});const directory=await mkdtemp(join(temporaryParent,'tax-history-synthetic-'));
  try{return await callback(await makeFixture(directory,options),directory);}finally{
    assert.equal(dirname(resolve(directory)),resolve(temporaryParent));assert.match(directory.split(/[\\/]/).at(-1),/^tax-history-synthetic-/);
    await rm(directory,{recursive:true,force:true});
  }
}
