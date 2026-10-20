// All model-facing names come from verified static source or explicitly confirmed
// technical schema. Business field values remain in the private projection only.
import {FILING_PERIOD_FIELDS} from './tax-filing-period.mjs';
export const COLLECTION_FIELDS = Object.freeze(['Response','Data','data','userinfo','returnCode','code','Error','error',
  'user_id','user_type','reg_number','company_name','enterprise_type','taxpayerStatusCode',
  'ysbList','dqswsList','qtList','fxydList','lx','sbqx',
  'dbzsbt','dbrwblsx','dbztDm','other','dbuuid','sfsytc','sfzdgxzt','dblj',
  'dbt','wsbxxGrid','tbsl','sbb','zt','ztBm','zsxmDm','zspmDm','yyfwqdz','cddz','lybz','relatedType',
  'creditCode','taxpayer_id','enterprise_id','competent_tax_bureau_code','competent_tax_bureau_name','registrationTypeOfLevySubject',
  ...FILING_PERIOD_FIELDS]);
export function collectionShape(body) {
  const allowed=new Set(COLLECTION_FIELDS), schema=[],paths=new Map();let truncated=false,nodes=0;
  const kind=v=>v===null?'null':Array.isArray(v)?'array':['object','string','number','boolean'].includes(typeof v)?typeof v:'unknown';
  function walk(v,path,depth){
    if(depth>6||nodes++>=100000){truncated=true;return;}
    const type=kind(v),keys=type==='object'?Object.keys(v):[];
    let entry=paths.get(path);
    if(!entry){if(schema.length>=128){truncated=true;return;}
      entry={path,kind:type,fieldCount:type==='object'?keys.length:null,arrayCount:type==='array'?v.length:null,
        unknownFieldCount:type==='object'?keys.filter(k=>!allowed.has(k)).length:null,occurrences:0};
      paths.set(path,entry);schema.push(entry);
    }
    entry.occurrences++;if(entry.kind!==type)entry.kind='mixed';
    if(type==='object'){entry.fieldCount=Math.max(entry.fieldCount||0,keys.length);
      entry.unknownFieldCount=Math.max(entry.unknownFieldCount||0,keys.filter(k=>!allowed.has(k)).length);}
    if(type==='array')entry.arrayCount=Math.max(entry.arrayCount||0,v.length);
    if(type==='object')for(const key of keys)if(allowed.has(key))walk(v[key],path+'.'+key,depth+1);
    if(type==='array'){for(const item of v.slice(0,10000))walk(item,path+'[]',depth+1);if(v.length>10000)truncated=true;}
  }
  walk(body,'$',0);
  const data=body?.Response?.Data??body?.data;
  const errorPresent=value=>value!==undefined&&value!==null&&value!==false&&value!==''
    &&(typeof value!=='object'||Object.keys(value).length>0);
  const failed=[body?.Error,body?.error,body?.Response?.Error,data?.Error,data?.error].some(errorPresent);
  const returnCode=data?.returnCode??body?.returnCode;
  return {schema,schemaTruncated:truncated, businessStatus:failed?'failed':returnCode==='1'?'success':
    returnCode!==undefined&&returnCode!==null?'failed':'unverified',
    identityShape:!!data?.userinfo&&typeof data.userinfo==='object'&&!Array.isArray(data.userinfo),
    todoShape:['ysbList','dqswsList','qtList','fxydList'].every(k=>Array.isArray(data?.[k])),
    filingShape:Array.isArray(data?.wsbxxGrid),periodVerified:false};
}
export const PASSIVE_RECIPES=Object.freeze({
  '/mhzx/api/mh/mhsy/getUserInfo':Object.freeze({resource:'identity',method:'GET'}),
  '/xxzx/api/nsrxxzx/txzx/dbrw/v1/listNsrDbxx':Object.freeze({resource:'pending_tasks',method:'POST',body:{Jsqd:'01'}}),
  '/xxzx/api/nsrxxzx/txzx/wntj/v1/listWntj':Object.freeze({resource:'menu_recommendation',method:'POST'}),
  // The verified non-old axios interceptor uppercases the first character of keys.
  '/mhzx/api/mh/wddb/v1/wddbquerybbsmxx':Object.freeze({resource:'current_filing',method:'POST',body:{Csbz:''}}),
});
export function observedRecipe(request){
  try{
    const url=new URL(request.url);
    if(url.origin!=='https://etax.fujian.chinatax.gov.cn:8443'||url.username||url.password||!Object.hasOwn(PASSIVE_RECIPES,url.pathname))return null;
    const recipe=PASSIVE_RECIPES[url.pathname];
    let bodyMatches=false,bodyStatus='absent',bodyFields={csbz:false,Csbz:false,Jsqd:false},unknownBodyFieldCount=0,localBody=null;
    if(recipe.body){try{const body=JSON.parse(request.postData);bodyMatches=body&&typeof body==='object'&&!Array.isArray(body)
      &&Object.keys(body).length===1&&Object.keys(recipe.body).every(key=>body[key]===recipe.body[key]);
      if(body&&typeof body==='object'&&!Array.isArray(body)){
        bodyStatus='json_object';bodyFields={csbz:Object.hasOwn(body,'csbz'),Csbz:Object.hasOwn(body,'Csbz'),Jsqd:Object.hasOwn(body,'Jsqd')};
        unknownBodyFieldCount=Object.keys(body).filter(k=>!['csbz','Csbz','Jsqd'].includes(k)).length;
        if(unknownBodyFieldCount===0&&Object.keys(body).length===1&&Object.keys(recipe.body).every(key=>
          typeof body[key]==='string'&&/^[A-Za-z0-9_-]{0,32}$/.test(body[key]))) localBody=body;
      }else bodyStatus='invalid';}catch{bodyStatus=request.postData===undefined?'absent':'invalid';}}
    else bodyMatches=request.postData===undefined||request.postData==='';
    const queryKeys=[...url.searchParams.keys()];
    const safe={resource:recipe.resource,method:request.method===recipe.method?recipe.method:'unexpected',
      recipeMatches:request.method===recipe.method&&bodyMatches&&queryKeys.every(key=>key==='t'),
      bodyStatus,bodyFields,unknownBodyFieldCount,queryMatches:queryKeys.every(key=>key==='t')};
    Object.defineProperty(safe,'localRecipe',{value:request.method===recipe.method&&queryKeys.every(key=>key==='t')
      &&(recipe.method==='GET'||localBody)?{path:url.pathname,method:recipe.method,body:localBody,
        queryTimestamp:url.searchParams.has('t')}:null});
    return safe;
  }catch{return null;}
}

export const ENTERPRISE_BASIC_FIELDS=Object.freeze(['creditCode','taxpayer_id','enterprise_id',
  'competent_tax_bureau_code','competent_tax_bureau_name','registrationTypeOfLevySubject']);
export const IDENTITY_FIELDS=Object.freeze(['user_id','user_type','reg_number','company_name','enterprise_type','taxpayerStatusCode','relatedType',
  ...ENTERPRISE_BASIC_FIELDS]);
export const FILING_FIELDS=Object.freeze(['sbb','sbqx','zt','ztBm','zsxmDm','zspmDm','lybz',...FILING_PERIOD_FIELDS]);
export function enterpriseBasicFieldCoverage(userinfo){
  const present=ENTERPRISE_BASIC_FIELDS.filter(key=>typeof userinfo?.[key]==='string');
  const nonempty=present.filter(key=>userinfo[key].trim().length>0).length;
  return {fieldCount:ENTERPRISE_BASIC_FIELDS.length,presentCount:present.length,missingCount:ENTERPRISE_BASIC_FIELDS.length-present.length,
    nonemptyStringCount:nonempty,emptyStringCount:present.length-nonempty};
}
const pick=(value,fields)=>Object.fromEntries(fields.filter(key=>typeof value?.[key]==='string'&&value[key].length<=4096).map(key=>[key,value[key]]));
export function businessProjection(body,resource){
  const data=body?.Response?.Data??body?.data;
  if(resource==='identity'&&data?.userinfo&&typeof data.userinfo==='object'&&!Array.isArray(data.userinfo))return{userinfo:pick(data.userinfo,IDENTITY_FIELDS)};
  if(resource==='current_filing'&&Array.isArray(data?.wsbxxGrid)&&data.wsbxxGrid.length<=10000)
    return{wsbxxGrid:data.wsbxxGrid.map(row=>pick(row,FILING_FIELDS)),rowCount:data.wsbxxGrid.length,
      projectionComplete:false,periodVerified:false,navigation:filingNavigationShape(data.wsbxxGrid)};
  return null;
}
export function filingNavigationShape(rows){
  const counts={present:0,missing:0,sameOrigin:0,externalOrigin:0,hasQuery:0,hasAuthMaterial:0,invalid:0};
  for(const row of rows)for(const key of ['cddz','yyfwqdz']){
    const raw=row?.[key];if(typeof raw!=='string'||!raw){counts.missing++;continue;}counts.present++;
    try{const u=new URL(raw,'https://etax.fujian.chinatax.gov.cn:8443');
      if(!['https:','http:'].includes(u.protocol)){counts.invalid++;continue;}
      if(u.origin==='https://etax.fujian.chinatax.gov.cn:8443')counts.sameOrigin++;else counts.externalOrigin++;
      if(u.search)counts.hasQuery++;
      if(u.username||u.password||[...u.searchParams.keys()].some(k=>/token|ticket|code|session|auth|cookie|password|key|sign/i.test(k)))counts.hasAuthMaterial++;
    }catch{counts.invalid++;}
  }
  return counts;
}
