// One observed read-only filing query. Values and row instances stay private.
import {createHash} from 'node:crypto';
import {requireActiveSource,validateRecipe} from './tax-collection-contract.mjs';
import {FULL_FRAME_URL_SEMANTICS} from './tax-frame-url.mjs';
export const HISTORY_ORIGIN='https://etax.fujian.chinatax.gov.cn:8443';
export const HISTORY_PATH='/szc/szzh/sjswszzh/zhcx/v1/DescribeSbmxcx2';
export const HISTORY_FIELDS=Object.freeze(['zsxmDmArray','nssbrq','skssqq','skssqz','ybtse','gzlxDm','gzlx','zfbz','zfrq','sbuuid','yzpzzlDm','yzpzzlMc','pzxh']);
export const exact=(v,keys)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'&&v.length<=4096;
export const historyFail=code=>{const e=new Error(code);e.code=code;return e;};
export const historyRef=(v,kind)=>typeof v==='string'&&new RegExp('^taxhistory'+kind+'_[a-f0-9]{48}$').test(v);
const ref=(v,p)=>typeof v==='string'&&new RegExp('^'+p+'_[a-f0-9]{48}$').test(v);
export const canonical=v=>JSON.stringify(v,(_k,x)=>object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export const enterpriseOf=p=>Object.fromEntries(['reg_number','company_name','creditCode','taxpayer_id'].map(k=>[k,p?.userinfo?.[k]]));
export const validEnterprise=v=>exact(v,['reg_number','company_name','creditCode','taxpayer_id'])&&Object.values(v).every(x=>text(x)&&x.trim().length>0);
export const sameEnterprise=(a,b)=>validEnterprise(a)&&validEnterprise(b)&&canonical(a)===canonical(b);
export function historyRecipeValid(r){
  const keys=['gzlx','pageNum','pageSize','sbrqq','sbrqz','skssqq','skssqz','zfbz','yzpzzlDm'];
  return exact(r,['path','method','query','body'])&&r.path===HISTORY_PATH&&r.method==='POST'&&Array.isArray(r.query)&&r.query.length===0
    &&exact(r.body,keys)&&Array.isArray(r.body.gzlx)&&r.body.gzlx.length===2&&r.body.gzlx.every(text)
    &&Number.isSafeInteger(r.body.pageNum)&&r.body.pageNum>=1&&r.body.pageNum<=10000000
    &&Number.isSafeInteger(r.body.pageSize)&&r.body.pageSize>=1&&r.body.pageSize<=1000
    &&keys.filter(k=>!['gzlx','pageNum','pageSize'].includes(k)).every(k=>text(r.body[k]));
}
export function historyDocumentValid(d){
  if(!exact(d,['targetId','frameId','loaderId','fullUrl','documentUrlSemantics','documentUrlDigest'])
    ||!['targetId','frameId','loaderId'].every(k=>text(d[k])&&d[k].length>0&&d[k].length<=256)
    ||d.documentUrlSemantics!==FULL_FRAME_URL_SEMANTICS||typeof d.fullUrl!=='string'||d.fullUrl.length>8192)return false;
  try{const u=new URL(d.fullUrl);return u.href===d.fullUrl&&u.origin===HISTORY_ORIGIN&&!u.username&&!u.password&&!u.href.includes('#')
    &&u.pathname==='/szzh/zhcx/sbxx/sbxxcx'&&[...u.searchParams.keys()].join(',')==='ruuid'
    &&!!u.searchParams.get('ruuid')&&u.searchParams.get('ruuid').length<=4096
    &&createHash('sha256').update(d.fullUrl).digest('hex')===d.documentUrlDigest;}catch{return false;}
}
function midnight(v){
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2} 00:00:00$/.test(v))return false;
  const [y,m,d]=v.slice(0,10).split('-').map(Number),leap=y%400===0||y%4===0&&y%100!==0;
  return y>=1&&m>=1&&m<=12&&d>=1&&d<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][m-1];
}
export function historyProjection(body,recipe){
  if(!historyRecipeValid(recipe))throw historyFail('history_recipe_invalid');
  if(!object(body?.Response)||!Object.hasOwn(body.Response,'Error')||body.Response.Error!==null)throw historyFail('history_business_failed');
  const d=body.Response.Data;
  if(!object(d)||!Number.isSafeInteger(d.PageNumber)||d.PageNumber<1||d.PageNumber>10000000
    ||!Number.isSafeInteger(d.PageSize)||d.PageSize<1||d.PageSize>1000||!Number.isSafeInteger(d.Total)||d.Total<0||d.Total>10000000
    ||d.PageNumber!==recipe.body.pageNum||d.PageSize!==recipe.body.pageSize
    ||!Array.isArray(d.List)||d.List.length>d.PageSize||d.List.length>d.Total||!d.List.every(object)
    ||d.Total===0&&(d.PageNumber!==1||d.List.length!==0)
    ||d.Total>0&&((d.PageNumber-1)*d.PageSize>=d.Total||d.List.length>d.Total-(d.PageNumber-1)*d.PageSize))throw historyFail('history_shape_invalid');
  const rows=d.List.map(row=>{
    if(!HISTORY_FIELDS.every(k=>Object.hasOwn(row,k))||row.zsxmDmArray!==null||typeof row.ybtse!=='number'||!Number.isFinite(row.ybtse)
      ||!HISTORY_FIELDS.filter(k=>!['zsxmDmArray','ybtse'].includes(k)).every(k=>text(row[k])))throw historyFail('history_shape_invalid');
    if(!midnight(row.skssqq)||!midnight(row.skssqz)||row.skssqq>row.skssqz)throw historyFail('history_period_invalid');
    return Object.fromEntries(HISTORY_FIELDS.map(k=>[k,row[k]]));
  });
  return {PageNumber:d.PageNumber,PageSize:d.PageSize,Total:d.Total,rows};
}
function projectionValid(p,r){
  if(!exact(p,['PageNumber','PageSize','Total','rows'])||!Array.isArray(p.rows)||!p.rows.every(row=>exact(row,HISTORY_FIELDS)))return false;
  try{return canonical(historyProjection({Response:{Error:null,Data:{...p,List:p.rows}}},r))===canonical(p);}catch{return false;}
}
export function historySummary(p){return {rowCount:p.rows.length,totalCount:p.Total,pageCount:1,
  capturedQueryCoverageComplete:p.PageNumber===1&&p.Total===p.rows.length,paginationSupported:false,requestFilterSemanticsVerified:false,
  allHistoryVerified:false,recordIdentityVerified:false,versionSemanticsVerified:false,correctionRelationsVerified:false,
  parameterEnterpriseBound:false,responseEnterpriseBound:false,filingPeriodsVerified:p.rows.length>0,
  distinctPeriodCount:new Set(p.rows.map(r=>r.skssqq+'|'+r.skssqz)).size};}
export function compareHistory(left,right){
  const ordered=p=>canonical(p.rows),multiset=p=>canonical(p.rows.map(canonical).sort());
  return {leftRowCount:left.rows.length,rightRowCount:right.rows.length,rowProjectionEqual:ordered(left)===ordered(right),
    contentMultisetEqual:multiset(left)===multiset(right),paginationEqual:['PageNumber','PageSize','Total'].every(k=>left[k]===right[k]),
    periodMultisetEqual:canonical(left.rows.map(r=>r.skssqq+'|'+r.skssqz).sort())===canonical(right.rows.map(r=>r.skssqq+'|'+r.skssqz).sort()),
    recordIdentityVerified:false,versionSemanticsVerified:false,correctionRelationsVerified:false};
}
export function buildHistoryTemplate(m,parent,artifactRef){
  requireActiveSource(parent);
  if(!exact(m,['version','sourceRef','target','capturedAt','requests','assets','document','identityProjection'])||m.version!==1||m.target!=='filing_query'
    ||!ref(m.sourceRef,'taxsource')||!ref(artifactRef,'taxquery')||!Number.isSafeInteger(m.capturedAt)||m.capturedAt<parent.capturedAt
    ||!Array.isArray(m.requests)||m.requests.length>128||!Array.isArray(m.assets)||m.assets.length>64
    ||!exact(m.document,['targetId','frameId','loaderId','url'])||m.document.targetId!==parent.targetId||m.document.loaderId===parent.loaderId
    ||!sameEnterprise(enterpriseOf(m.identityProjection),enterpriseOf(parent.identity.projection)))throw historyFail('history_template_invalid');
  const captureDocument={targetId:m.document.targetId,frameId:m.document.frameId,loaderId:m.document.loaderId,fullUrl:m.document.url,
    documentUrlSemantics:FULL_FRAME_URL_SEMANTICS,documentUrlDigest:createHash('sha256').update(String(m.document.url)).digest('hex')};
  if(!historyDocumentValid(captureDocument))throw historyFail('history_template_invalid');
  const matches=m.requests.filter(r=>{try{const u=new URL(r.url);return u.origin===HISTORY_ORIGIN&&u.pathname===HISTORY_PATH;}catch{return false;}});
  if(matches.length!==1)throw historyFail('history_recipe_missing');
  const request=matches[0],u=new URL(request.url),recipe={path:HISTORY_PATH,method:request.method,query:[],body:request.body};
  if(!exact(request,['url','method','body','response'])||u.href!==request.url||request.url!==HISTORY_ORIGIN+HISTORY_PATH||u.username||u.password||u.href.includes('#')||u.search
    ||!historyRecipeValid(recipe))throw historyFail('history_template_invalid');
  const template={version:1,parentSourceRef:m.sourceRef,parentArtifactRef:artifactRef,capturedAt:m.capturedAt,
    registrationRef:parent.registrationRef,registrationRoot:parent.registrationRoot,browserKey:parent.browserKey,captureDocument,
    identityRecipe:parent.identity.recipe,enterprise:enterpriseOf(parent.identity.projection),recipe,captureProjection:historyProjection(request.response,recipe)};
  return validateHistoryRecord('template',template);
}
function proofs(p,resources){return Array.isArray(p)&&p.length===resources.length&&new Set(p.map(x=>x?.requestRef)).size===p.length
  &&p.every((x,i)=>exact(x,['requestRef','resource','requestPerformed','responseComplete'])&&ref(x.requestRef,'taxreq')&&x.resource===resources[i]&&x.requestPerformed===true&&x.responseComplete===true);}
export function validateHistoryRecord(kind,v){
  let valid=false;
  if(kind==='template')valid=exact(v,['version','parentSourceRef','parentArtifactRef','capturedAt','registrationRef','registrationRoot','browserKey','captureDocument','identityRecipe','enterprise','recipe','captureProjection'])
    &&v.version===1&&ref(v.parentSourceRef,'taxsource')&&ref(v.parentArtifactRef,'taxquery')&&Number.isSafeInteger(v.capturedAt)&&v.capturedAt>=0
    &&ref(v.registrationRef,'taxr')&&typeof v.registrationRoot==='string'&&/[\\/]\.agent-runs[\\/]tax-browser-registry$/.test(v.registrationRoot)
    &&/^[a-f0-9]{64}$/.test(v.browserKey)&&historyDocumentValid(v.captureDocument)&&validateRecipe(v.identityRecipe,'identity')
    &&validEnterprise(v.enterprise)&&historyRecipeValid(v.recipe)&&projectionValid(v.captureProjection,v.recipe);
  if(kind==='context')valid=exact(v,['version','templateRef','createdAt','expiresAt','replayDocument','enterprise','operationRef','proof'])&&v.version===1
    &&historyRef(v.templateRef,'template')&&Number.isSafeInteger(v.createdAt)&&v.createdAt>=0&&v.expiresAt===v.createdAt+1800000
    &&historyDocumentValid(v.replayDocument)&&validEnterprise(v.enterprise)&&ref(v.operationRef,'taxop')&&proofs(v.proof,['identity','identity']);
  if(kind==='run')valid=exact(v,['version','contextRef','templateRef','createdAt','enterprise','operationRef','proof','recipe','projection'])&&v.version===1
    &&historyRef(v.contextRef,'context')&&historyRef(v.templateRef,'template')&&Number.isSafeInteger(v.createdAt)&&v.createdAt>=0
    &&validEnterprise(v.enterprise)&&ref(v.operationRef,'taxop')&&proofs(v.proof,['identity','filing_history','identity'])
    &&historyRecipeValid(v.recipe)&&projectionValid(v.projection,v.recipe);
  if(!valid)throw historyFail('history_record_invalid');return v;
}
