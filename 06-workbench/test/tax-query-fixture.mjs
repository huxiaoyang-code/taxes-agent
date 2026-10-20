// Synthetic fixture shared by unit and real MCP/HTTP integration tests.
import assert from 'node:assert/strict';
import {mkdir,lstat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {TaxCollectionStore,collectionLock} from '../server/tax-collection-local.mjs';
import {businessProjection} from '../server/tax-collection-shape.mjs';
import {FULL_FRAME_URL_SEMANTICS} from '../server/tax-frame-url.mjs';
import {TaxQueryStore} from '../server/tax-query-store.mjs';
import {TaxQueryCollection} from '../server/tax-query-collection.mjs';
import {QUERY_ORIGIN,QUERY_PATHS} from '../server/tax-query-contract.mjs';
export const PRIVATE='SYNTHETIC_QUERY_BUSINESS_TRIPWIRE',OPERATOR='SYNTHETIC_QUERY_OPERATOR_TRIPWIRE';
export async function queryFixture(directory,{collector=new TaxQueryCollection()}={}){
  const security={testStorage:true,async secureDirectory(){},async verifyDirectory(p){assert.ok((await lstat(p)).isDirectory())},
    async verifyFile(p){assert.ok((await lstat(p)).isFile())}};
  const parentStore=new TaxCollectionStore({root:join(directory,'parent-evidence'),security}),profile=join(directory,'profile');await mkdir(profile);
  const captureRoot=join(directory,'captures');await mkdir(captureRoot);
  const store=new TaxQueryStore({root:join(directory,'query-evidence'),captureRoot,security});
  const identityBody=()=>({Response:{Data:{userinfo:{reg_number:PRIVATE+'_REG',company_name:PRIVATE+'_COMPANY',creditCode:PRIVATE+'_CREDIT',
    taxpayer_id:PRIVATE+'_TAX',user_id:OPERATOR}}}}),enterprise=identityBody().Response.Data.userinfo;
  const identity={resource:'identity',recipe:{path:'/mhzx/api/mh/mhsy/getUserInfo',method:'GET',body:null,queryTimestamp:true},
    projection:businessProjection(identityBody(),'identity')};
  const parent={version:2,documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,authorizedNavigation:true,
    handoffMode:'quarantined_reader_new_navigation',readerStoppedConfirmed:true,registrationRef:'taxr_'+'1'.repeat(48),
    registrationRoot:join(directory,'.agent-runs','tax-browser-registry'),pageRef:'taxpage_'+'1'.repeat(48),targetId:PRIVATE+'_TARGET',
    frameId:'parent-frame',loaderId:'parent-loader',browserKey:'a'.repeat(64),documentUrlDigest:'b'.repeat(64),capturedAt:1000,identity,
    filing:{resource:'current_filing',recipe:{path:'/mhzx/api/mh/wddb/v1/wddbquerybbsmxx',method:'POST',body:{Csbz:''},queryTimestamp:true},
      projection:businessProjection({Response:{Data:{wsbxxGrid:[]}}},'current_filing')}};
  const parentSourceRef=await parentStore.save('source',parent),artifactRef='taxquery_'+'2'.repeat(48),artifactDirectory=join(captureRoot,artifactRef);await mkdir(artifactDirectory);
  const djxh=PRIVATE+'_DJXH',bodies={getUserMsg:{Response:{Error:null,Data:{djxh,nsrsbh:enterprise.taxpayer_id,shxydm:enterprise.creditCode,username:OPERATOR}}},
    basic_profile:{Response:{Error:null,Data:{nsrsbh:enterprise.taxpayer_id,nsrmc:enterprise.company_name,tyshxydm:enterprise.creditCode,
      kjzdzzDm:PRIVATE+'_ACCOUNTING',loginUserName:OPERATOR,lastLoginTime:OPERATOR}}},
    enterprise_profile:{Response:{Error:null,Data:{shxydm:enterprise.creditCode,nsrmc:enterprise.company_name,kjzdzz:PRIVATE+'_ACCOUNTING',
      sfshow:true,yhzh:PRIVATE+'_BANK_ACCOUNT',ssglyXm:OPERATOR,ssglyDm:OPERATOR}}},
    income_assessment:{Response:{Error:null,Data:{PageNumber:1,PageSize:10,Total:0,List:[]}}}};
  const manifest={version:1,sourceRef:parentSourceRef,target:'taxpayer_profile',capturedAt:2000,assets:[],document:{targetId:parent.targetId,
    frameId:'capture-frame',loaderId:'capture-loader',url:QUERY_ORIGIN+'/szzh/zhcx/nsrxxcx?ruuid='+PRIVATE+'_OPAQUE'},
    identityProjection:identity.projection,requests:Object.entries(QUERY_PATHS).map(([resource,path])=>({url:QUERY_ORIGIN+path+
      (resource==='basic_profile'?'?t=1700000000000':resource==='enterprise_profile'?'?djxh='+djxh:
        resource==='income_assessment'?'?pageNum=1&pageSize=10&djxh='+djxh:''),method:['basic_profile','getUserMsg'].includes(resource)?'GET':'POST',body:null,response:bodies[resource]}))};
  const manifestPath=join(artifactDirectory,'manifest.json');await writeFile(manifestPath,JSON.stringify(manifest));
  const state={mode:'normal',requests:[],calls:[],closed:0,now:3000};
  const frame=()=>({id:'current-frame',loaderId:state.mode==='wrong_loader'?'other-loader':'current-loader',
    url:QUERY_ORIGIN+(state.mode==='wrong_path'?'/business/save':state.currentPath||'/szzh/zhcx/sbxx')});
  const openDiagnostic=async()=>{
    const handlers=new Map(),emit=(name,p={})=>{for(const h of handlers.get(name)||[])h(p,{sessionId:'synthetic-session'})};
    return {localScope:{profilePath:profile,browserKey:parent.browserKey,registrationState:'quarantined',
      currentRegistrationState:async()=>state.mode==='registry_changed'&&state.requests.length>3?'active':'quarantined'},
      close(){state.closed++;if(state.mode==='close_failed')throw Error(PRIVATE)},cdp:{on(name,h){if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name).add(h);return()=>handlers.get(name).delete(h)},
        async send(method,params){state.calls.push(method);
          if(['Runtime.disable','Page.disable','Target.detachFromTarget'].includes(method)&&state.mode==='cleanup_failed')throw Error(PRIVATE);
          if(method==='Target.getTargetInfo')return{targetInfo:{type:'page'}};
          if(method==='Target.attachToTarget')return{sessionId:'synthetic-session'};
          if(method==='Page.getFrameTree')return{frameTree:{frame:frame()}};
          if(method==='Runtime.evaluate'){
            const expression=params.expression,resource=Object.keys(QUERY_PATHS).find(key=>expression.includes(QUERY_PATHS[key]))??'identity';
            const requestRef=JSON.parse(expression.match(/requestRef:("taxreq_[a-f0-9]{48}")/)[1]);
            const address=expression.match(/fetch\(("[^"\n]+")/)?.[1];state.requests.push({resource,expression,address:address?JSON.parse(address):null});
            let body=structuredClone(resource==='identity'?identityBody():bodies[resource]);
            if(state.mode==='unknown')return{result:{value:{status:'request_unconfirmed',settled:false}}};
            if(state.mode==='http_failed_complete')return{result:{value:{status:'http_failed',settled:true,requestPerformed:true,responseComplete:true,requestRef}}};
            if(state.mode==='scope_before_fetch')return{result:{value:{status:'scope_changed',settled:true,requestPerformed:false,responseComplete:false,requestRef}}};
            if(state.mode==='invalid_json_complete')return{result:{value:{status:'invalid_json',settled:true,requestPerformed:true,responseComplete:true,requestRef}}};
            if(state.mode==='http_failed_incomplete')return{result:{value:{status:'http_failed',settled:true,requestPerformed:true,responseComplete:false,requestRef}}};
            if(state.mode==='infinite_field'&&resource==='basic_profile')body.Response.Data.kjzdzzmc=Infinity;
            if(state.mode==='identity_changed'&&resource==='identity')body.Response.Data.userinfo.creditCode=PRIVATE+'_OTHER';
            if(state.mode==='identity_business_error'&&resource==='identity')body.Response.Error={code:PRIVATE};
            if(state.mode==='identity_schema_error'&&resource==='identity')body.Response.Data.userinfo={};
            if(state.mode==='wrong_djxh'&&resource==='getUserMsg')body.Response.Data.djxh=PRIVATE+'_OTHER';
            if(state.mode==='cross_basic'&&resource==='basic_profile')body.Response.Data.nsrmc=PRIVATE+'_OTHER';
            if(state.mode==='cross_enterprise'&&resource==='enterprise_profile')body.Response.Data.shxydm=PRIVATE+'_OTHER';
            if(state.mode==='missing_optional'&&resource==='enterprise_profile')delete body.Response.Data.kjzdzz;
            if(state.mode==='value_changed'&&resource==='enterprise_profile')body.Response.Data.kjzdzz=PRIVATE+'_UPDATED';
            if(state.mode==='type_changed'&&resource==='enterprise_profile')body.Response.Data.kjzdzz=1;
            if(state.mode==='business_error'&&resource==='basic_profile')body.Response.Error={message:PRIVATE};
            if(state.mode==='null_data'&&resource==='enterprise_profile')body.Response.Data=null;
            if(state.mode==='bad_pagination'&&resource==='income_assessment')body.Response.Data.PageNumber=0;
            if(state.mode==='wrong_page'&&resource==='income_assessment')body.Response.Data.PageSize=9;
            if(state.mode==='nonempty_income'&&resource==='income_assessment')body.Response.Data={PageNumber:1,PageSize:10,Total:20,List:[{unknownPrivate:PRIVATE}]};
            if(state.mode==='scope_changed'&&resource==='basic_profile'){
              emit('Page.navigatedWithinDocument',{frameId:'current-frame'});emit('Page.navigatedWithinDocument',{frameId:'current-frame'});}
            return{result:{value:{status:'observed',settled:true,requestPerformed:true,responseComplete:state.mode!=='incomplete',requestRef,body}}};
          }return{};
        }}};
  };
  collector.d={store,parentStore,enabled:true,now:()=>state.now,clock:Date.now,openDiagnostic,
    acquireLock:(path,options)=>collectionLock(path,{...options,security})};
  return{collector,store,parentStore,state,artifactRef,parentSourceRef,manifest,manifestPath,profile,security,
    async changeManifest(fn){fn(manifest);await writeFile(manifestPath,JSON.stringify(manifest));}};
}
