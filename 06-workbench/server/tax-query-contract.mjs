// Fixed, observed enterprise-query resources. No caller URL/parameter input.
import {createHash} from 'node:crypto';
import {requireActiveSource,validateRecipe} from './tax-collection-contract.mjs';
import {FULL_FRAME_URL_SEMANTICS} from './tax-frame-url.mjs';
export const QUERY_ORIGIN='https://etax.fujian.chinatax.gov.cn:8443';
export const QUERY_PATHS=Object.freeze({basic_profile:'/szc/szzh/sjswszzh/sy/v1/DescribeNsrjbxx',
  enterprise_profile:'/szc/szzh/sjswszzh/zhcx/nsrxx/v1/DescribeNsrxxJcxx',
  income_assessment:'/szc/szzh/sjswszzh/zhcx/nsrxx/v1/DescribeQysdshdxx',getUserMsg:'/szc/szzh/sjswszzh/sy/v1/getUserMsg'});
export const BASIC_FIELDS=Object.freeze(['nsrsbh','nsrmc','tyshxydm','nsrxydj','kjzdzzDm','kjzdzzmc','nsrzg','nsrzgmc','sfckqy','zgswjDm','zgswjmc']);
export const ENTERPRISE_FIELDS=Object.freeze(['shxydm','nsrmc','nsrztDm','nsrzt','swdjrq','djzclxDm','djzclx','zzjgDm','hyDm','hydl',
  'zhymxhy','nsxypddj','pdnd','kyslrq','zcxs','zzsqylxDm','zzsqylx','qygmDm','qygm','sfcktsqy','sffdqybnsr','sfqhjt','sffylzz',
  'kjzdzzDm','kjzdzz','hsrj','zgswjDm','zgswjMc','nsrzg','zgswskfjDm','zgswskfjMc','qybz','kqyccsdjztbz','sfshow']);
export const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const object=v=>v&&typeof v==='object'&&!Array.isArray(v),nonempty=v=>typeof v==='string'&&v.trim().length>0&&v.length<=4096;
export const queryFail=code=>{const error=new Error(code);error.code=code;return error};
export const queryRef=(v,kind)=>typeof v==='string'&&new RegExp('^taxquery'+kind+'_[a-f0-9]{48}$').test(v);
export const enterpriseOf=projection=>Object.fromEntries(['reg_number','company_name','creditCode','taxpayer_id'].map(k=>[k,projection?.userinfo?.[k]]));
export const validEnterprise=v=>exact(v,['reg_number','company_name','creditCode','taxpayer_id'])&&Object.values(v).every(nonempty);
export const sameQueryEnterprise=(a,b)=>validEnterprise(a)&&validEnterprise(b)&&Object.keys(a).every(k=>a[k]===b[k]);
const omitted=value=>{const text=JSON.stringify(value);return typeof text!=='string'||/\[(?:credential|unstructured body|depth) omitted\]/.test(text);};
export function queryRecipeValid(recipe,resource){
  if(!exact(recipe,['path','method','query','body'])||recipe.path!==QUERY_PATHS[resource]||recipe.body!==null||!Array.isArray(recipe.query))return false;
  if(recipe.method!==(['basic_profile','getUserMsg'].includes(resource)?'GET':'POST')||recipe.query.some(p=>!exact(p,['key','value'])
    ||typeof p.key!=='string'||typeof p.value!=='string'||p.value.length>4096||omitted(p)))return false;
  const keys=recipe.query.map(p=>p.key).join(',');
  if(resource==='basic_profile')return keys==='t'&&/^[0-9]{1,20}$/.test(recipe.query[0].value);
  if(resource==='getUserMsg')return keys===''||keys==='t'&&/^[0-9]{1,20}$/.test(recipe.query[0].value);
  if(resource==='enterprise_profile')return keys==='djxh'&&nonempty(recipe.query[0].value);
  return resource==='income_assessment'&&keys==='pageNum,pageSize,djxh'&&/^[1-9][0-9]{0,6}$/.test(recipe.query[0].value)
    &&/^[1-9][0-9]{0,3}$/.test(recipe.query[1].value)&&Number(recipe.query[1].value)<=1000&&nonempty(recipe.query[2].value);
}
export function queryDocumentValid(document,capture=false){
  if(!exact(document,['targetId','frameId','loaderId','fullUrl','documentUrlSemantics','documentUrlDigest'])
    ||!['targetId','frameId','loaderId'].every(k=>nonempty(document[k])&&document[k].length<=256)
    ||document.documentUrlSemantics!==FULL_FRAME_URL_SEMANTICS)return false;
  let url;try{url=new URL(document.fullUrl)}catch{return false;}
  if(url.href!==document.fullUrl||url.origin!==QUERY_ORIGIN||url.username||url.password||url.hash||url.href.includes('#')
    ||!['/szzh/zhcx/nsrxxcx','/szzh/zhcx/sbxx','/szzh/zhcx/sbxx/sbxxcx'].includes(url.pathname)
    ||document.fullUrl.length>8192||[...url.searchParams.keys()].some(k=>! /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k)
      ||/(?:auth|token|ticket|code|session|cookie|password|passwd|secret|credential|key|sign|redirect|callback)/i.test(k))||[...url.searchParams.keys()].length>20
    ||capture&&(url.pathname!=='/szzh/zhcx/nsrxxcx'||[...url.searchParams.keys()].join(',')!=='ruuid')
    ||capture&&(!url.searchParams.get('ruuid')||url.searchParams.get('ruuid').length>4096)
    ||[...url.searchParams.values()].some(value=>value.length>4096))return false;
  return createHash('sha256').update(document.fullUrl).digest('hex')===document.documentUrlDigest;
}
export function responseData(body){
  if(!object(body?.Response)||!Object.hasOwn(body.Response,'Error')||body.Response.Error!==null||!object(body.Response.Data))throw queryFail('query_business_failed');
  return body.Response.Data;
}
const fields=(data,names)=>Object.fromEntries(names.filter(k=>Object.hasOwn(data,k)).map(k=>{
  const value=data[k];if(value!==null&&!['string','number','boolean'].includes(typeof value)||typeof value==='string'&&value.length>4096
    ||typeof value==='number'&&!Number.isFinite(value))throw queryFail('query_shape_invalid');
  return[k,value];}));
export function queryProjection(body,resource,enterprise,djxh){
  const data=responseData(body);
  if(resource==='getUserMsg'){
    if(!nonempty(data.djxh)||data.djxh!==djxh||data.nsrsbh!==enterprise.taxpayer_id||data.shxydm!==enterprise.creditCode)throw queryFail('query_enterprise_changed');
    return{djxh:data.djxh,nsrsbh:data.nsrsbh,shxydm:data.shxydm};
  }
  if(resource==='basic_profile'){
    if(data.nsrsbh!==enterprise.taxpayer_id||data.nsrmc!==enterprise.company_name||data.tyshxydm!==enterprise.creditCode)throw queryFail('query_enterprise_changed');
    return fields(data,BASIC_FIELDS);
  }
  if(resource==='enterprise_profile'){
    if(data.shxydm!==enterprise.creditCode||data.nsrmc!==enterprise.company_name)throw queryFail('query_enterprise_changed');
    return fields(data,ENTERPRISE_FIELDS);
  }
  const {PageNumber,PageSize,Total,List}=data;
  if(!Number.isSafeInteger(PageNumber)||PageNumber<1||PageNumber>10000000||!Number.isSafeInteger(PageSize)||PageSize<1||PageSize>1000
    ||!Number.isSafeInteger(Total)||Total<0||Total>10000000||!Array.isArray(List)||List.length>PageSize||List.length>Total
    ||!List.every(object)||Total===0&&(PageNumber!==1||List.length!==0)
    ||Total>0&&((PageNumber-1)*PageSize>=Total||List.length>Total-(PageNumber-1)*PageSize))throw queryFail('query_shape_invalid');
  return{PageNumber,PageSize,Total,ListCount:List.length,rowsCompared:false,pageCoverageComplete:PageNumber===1&&List.length===Total,
    unknownRowSchema:List.length>0,parameterEnterpriseBound:true,responseEnterpriseBound:false,obligationVerified:false};
}
export function buildQueryTemplate(manifest,parent,parentSourceRef,artifactRef){
  requireActiveSource(parent);
  if(!exact(manifest,['version','sourceRef','target','capturedAt','requests','assets','document','identityProjection'])||manifest.version!==1
    ||manifest.sourceRef!==parentSourceRef||manifest.target!=='taxpayer_profile'||!Number.isSafeInteger(manifest.capturedAt)
    ||manifest.capturedAt<parent.capturedAt||!Array.isArray(manifest.requests)||manifest.requests.length>128
    ||!Array.isArray(manifest.assets)||manifest.assets.length>64||!exact(manifest.document,['targetId','frameId','loaderId','url']))throw queryFail('query_template_invalid');
  const enterprise=enterpriseOf(parent.identity.projection);
  if(!sameQueryEnterprise(enterprise,enterpriseOf(manifest.identityProjection))||manifest.document.targetId!==parent.targetId
    ||manifest.document.loaderId===parent.loaderId)throw queryFail('query_template_invalid');
  const captureDocument={targetId:manifest.document.targetId,frameId:manifest.document.frameId,loaderId:manifest.document.loaderId,
    fullUrl:manifest.document.url,documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,
    documentUrlDigest:createHash('sha256').update(manifest.document.url).digest('hex')};
  if(!queryDocumentValid(captureDocument,true))throw queryFail('query_template_invalid');
  const records={};
  for(const [resource,path] of Object.entries(QUERY_PATHS)){
    const matches=manifest.requests.filter(r=>{try{const u=new URL(r.url);return u.origin===QUERY_ORIGIN&&u.pathname===path;}catch{return false;}});
    if(matches.length!==1)throw queryFail('query_recipe_missing');
    const request=matches[0],url=new URL(request.url),recipe={path,method:request.method,query:[...url.searchParams].map(([key,value])=>({key,value})),body:request.body};
    if(!exact(request,['url','method','body','response'])||url.username||url.password||url.hash||!queryRecipeValid(recipe,resource)||omitted(request.response))throw queryFail('query_template_invalid');
    records[resource]={recipe,body:request.response};
  }
  const djxh=records.enterprise_profile.recipe.query[0].value;
  if(records.income_assessment.recipe.query[2].value!==djxh)throw queryFail('query_enterprise_changed');
  const captureProjections={};
  for(const [resource,item] of Object.entries(records)){
    const projection=queryProjection(item.body,resource,enterprise,djxh);
    if(resource!=='getUserMsg')captureProjections[resource]=projection;
    if(resource==='income_assessment'&&(projection.PageNumber!==Number(item.recipe.query[0].value)
      ||projection.PageSize!==Number(item.recipe.query[1].value)))throw queryFail('query_shape_invalid');
  }
  return{version:1,parentSourceRef,parentArtifactRef:artifactRef,capturedAt:manifest.capturedAt,registrationRef:parent.registrationRef,
    registrationRoot:parent.registrationRoot,browserKey:parent.browserKey,captureDocument,identityRecipe:parent.identity.recipe,enterprise,
    recipes:Object.fromEntries(['basic_profile','enterprise_profile','income_assessment'].map(k=>[k,records[k].recipe])),getUserMsgRecipe:records.getUserMsg.recipe,captureProjections};
}
const canonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const kind=value=>value===null?'null':typeof value;
export function compareCapturedProjections(capture,run){
  const summary={},diff=[];
  for(const resource of ['basic_profile','enterprise_profile']){
    const before=capture[resource],after=run[resource],missingFields=Object.keys(before).filter(k=>!Object.hasOwn(after,k)),
      typeChangedFields=Object.keys(before).filter(k=>Object.hasOwn(after,k)&&kind(before[k])!==kind(after[k]));
    const comparable=missingFields.length===0&&typeChangedFields.length===0;
    summary[resource]={capturedFieldCount:Object.keys(before).length,runFieldCount:Object.keys(after).length,missingFields,typeChangedFields,
      comparable,equal:comparable&&canonical(before)===canonical(after)};
    for(const field of new Set([...Object.keys(before),...Object.keys(after)])){
      if(!Object.hasOwn(after,field))diff.push({resource,field,kind:'missing',capturedValue:before[field],runValue:null});
      else if(!Object.hasOwn(before,field))diff.push({resource,field,kind:'added',capturedValue:null,runValue:after[field]});
      else if(kind(before[field])!==kind(after[field]))diff.push({resource,field,kind:'type_changed',capturedValue:before[field],runValue:after[field]});
      else if(before[field]!==after[field])diff.push({resource,field,kind:'value_changed',capturedValue:before[field],runValue:after[field]});
    }
  }
  const before=capture.income_assessment,after=run.income_assessment;
  summary.incomePaginationComparable=true;summary.incomePaginationEqual=['PageNumber','PageSize','Total','ListCount'].every(k=>before[k]===after[k]);
  summary.incomeRowsCompared=false;
  for(const field of ['PageNumber','PageSize','Total','ListCount'])if(before[field]!==after[field])diff.push({resource:'income_assessment',field,
    kind:'value_changed',capturedValue:before[field],runValue:after[field]});
  return{summary,diff};
}
function validateProjectionSet(projections,enterprise){
  if(!exact(projections,['basic_profile','enterprise_profile','income_assessment']))throw queryFail('query_record_invalid');
    for(const [resource,projection] of Object.entries(projections)){
      if(resource==='income_assessment'){
        if(!exact(projection,['PageNumber','PageSize','Total','ListCount','rowsCompared','pageCoverageComplete','unknownRowSchema','parameterEnterpriseBound','responseEnterpriseBound','obligationVerified'])
          ||projection.rowsCompared!==false||projection.parameterEnterpriseBound!==true||projection.responseEnterpriseBound!==false||projection.obligationVerified!==false
          ||!Number.isSafeInteger(projection.ListCount)||projection.ListCount<0||projection.ListCount>1000
          ||!Number.isSafeInteger(projection.PageNumber)||projection.PageNumber<1||projection.PageNumber>10000000
          ||!Number.isSafeInteger(projection.PageSize)||projection.PageSize<1||projection.PageSize>1000
          ||!Number.isSafeInteger(projection.Total)||projection.Total<0||projection.Total>10000000
          ||projection.ListCount>projection.PageSize||projection.ListCount>projection.Total
          ||projection.Total===0&&(projection.PageNumber!==1||projection.ListCount!==0)
          ||projection.Total>0&&((projection.PageNumber-1)*projection.PageSize>=projection.Total
            ||projection.ListCount>projection.Total-(projection.PageNumber-1)*projection.PageSize)
          ||typeof projection.pageCoverageComplete!=='boolean'||projection.pageCoverageComplete!==(projection.PageNumber===1&&projection.ListCount===projection.Total)
          ||typeof projection.unknownRowSchema!=='boolean'||projection.unknownRowSchema!==(projection.ListCount>0))throw queryFail('query_record_invalid');
      }else if(!object(projection)||Object.keys(projection).some(k=>!(resource==='basic_profile'?BASIC_FIELDS:ENTERPRISE_FIELDS).includes(k))
        ||Object.values(projection).some(x=>x!==null&&!['string','number','boolean'].includes(typeof x)
          ||typeof x==='number'&&!Number.isFinite(x)||typeof x==='string'&&x.length>4096))throw queryFail('query_record_invalid');
      else queryProjection({Response:{Error:null,Data:projection}},resource,enterprise,'');
    }
}
const refs=(v,prefix)=>typeof v==='string'&&new RegExp('^'+prefix+'_[a-f0-9]{48}$').test(v);
export function validateQueryRecord(kind,v){
  const shared=['version','parentSourceRef','parentArtifactRef','capturedAt','registrationRef','registrationRoot','browserKey','captureDocument','identityRecipe','enterprise','recipes','getUserMsgRecipe','captureProjections'];
  if(kind==='template'){
    if(!exact(v,shared)||v.version!==1||!refs(v.parentSourceRef,'taxsource')||!refs(v.parentArtifactRef,'taxquery')||!Number.isSafeInteger(v.capturedAt)
      ||!refs(v.registrationRef,'taxr')||typeof v.registrationRoot!=='string'||!/[\\/]\.agent-runs[\\/]tax-browser-registry$/.test(v.registrationRoot)
      ||! /^[a-f0-9]{64}$/.test(v.browserKey)||!queryDocumentValid(v.captureDocument,true)||!validateRecipe(v.identityRecipe,'identity')||!validEnterprise(v.enterprise)
      ||!exact(v.recipes,['basic_profile','enterprise_profile','income_assessment'])||!Object.entries(v.recipes).every(([k,r])=>queryRecipeValid(r,k))
      ||!queryRecipeValid(v.getUserMsgRecipe,'getUserMsg')||v.recipes.enterprise_profile.query[0].value!==v.recipes.income_assessment.query[2].value)throw queryFail('query_record_invalid');
    validateProjectionSet(v.captureProjections,v.enterprise);
    if(v.captureProjections.income_assessment.PageNumber!==Number(v.recipes.income_assessment.query[0].value)
      ||v.captureProjections.income_assessment.PageSize!==Number(v.recipes.income_assessment.query[1].value))throw queryFail('query_record_invalid');
  }else if(kind==='context'){
    if(!exact(v,['version','templateRef','createdAt','expiresAt','replayDocument','enterprise','operationRef','proof'])||v.version!==1
      ||!queryRef(v.templateRef,'template')||!Number.isSafeInteger(v.createdAt)||v.expiresAt!==v.createdAt+1800000
      ||!queryDocumentValid(v.replayDocument)||!validEnterprise(v.enterprise)||!refs(v.operationRef,'taxop')||!proofValid(v.proof,['identity','getUserMsg','identity']))throw queryFail('query_record_invalid');
  }else if(kind==='run'){
    if(!exact(v,['version','contextRef','templateRef','createdAt','enterprise','operationRef','proof','projections','captureDiff'])||v.version!==1
      ||!queryRef(v.contextRef,'context')||!queryRef(v.templateRef,'template')||!Number.isSafeInteger(v.createdAt)||!validEnterprise(v.enterprise)
      ||!refs(v.operationRef,'taxop')||!proofValid(v.proof,['identity','getUserMsg','basic_profile','enterprise_profile','income_assessment','getUserMsg','identity'])
      ||!exact(v.projections,['basic_profile','enterprise_profile','income_assessment']))throw queryFail('query_record_invalid');
    validateProjectionSet(v.projections,v.enterprise);
    if(!Array.isArray(v.captureDiff)||v.captureDiff.length>256||v.captureDiff.some(item=>!exact(item,['resource','field','kind','capturedValue','runValue'])
      ||!['missing','added','type_changed','value_changed'].includes(item.kind)
      ||!(item.resource==='basic_profile'?BASIC_FIELDS:item.resource==='enterprise_profile'?ENTERPRISE_FIELDS:item.resource==='income_assessment'?['PageNumber','PageSize','Total','ListCount']:[]).includes(item.field)
      ||[item.capturedValue,item.runValue].some(x=>x!==null&&!['string','number','boolean'].includes(typeof x)
        ||typeof x==='string'&&x.length>4096||typeof x==='number'&&!Number.isFinite(x))))throw queryFail('query_record_invalid');
  }else throw queryFail('query_record_invalid');
  return v;
}
function proofValid(proof,resources){return Array.isArray(proof)&&proof.length===resources.length&&new Set(proof.map(p=>p?.requestRef)).size===resources.length
  &&proof.every((p,i)=>exact(p,['requestRef','resource','requestPerformed','responseComplete'])&&refs(p.requestRef,'taxreq')&&p.resource===resources[i]
    &&p.requestPerformed===true&&p.responseComplete===true);}
