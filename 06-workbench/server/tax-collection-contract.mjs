import {IDENTITY_FIELDS,FILING_FIELDS,PASSIVE_RECIPES} from './tax-collection-shape.mjs';
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const scalarFields=(v,allowed)=>object(v)&&Object.keys(v).every(k=>allowed.includes(k)&&typeof v[k]==='string'&&v[k].length<=4096);
const opaque=v=>typeof v==='string'&&v.length>0&&v.length<=256;
const fail=()=>{throw new Error('tax_collection_evidence_invalid')};
export function validateRecipe(recipe,resource){
  if(!exact(recipe,['path','method','body','queryTimestamp'])||typeof recipe.queryTimestamp!=='boolean')return false;
  const known=PASSIVE_RECIPES[recipe.path];
  if(!known||known.resource!==resource||known.method!==recipe.method)return false;
  if(resource==='identity')return recipe.body===null;
  return resource==='current_filing'&&exact(recipe.body,['Csbz'])&&typeof recipe.body.Csbz==='string'
    &&/^[A-Za-z0-9_-]{0,32}$/.test(recipe.body.Csbz);
}
export function validateCapture(capture,resource){
  if(!exact(capture,['resource','recipe','projection'])||capture.resource!==resource||!validateRecipe(capture.recipe,resource))return false;
  const p=capture.projection;
  if(resource==='identity')return exact(p,['userinfo'])&&scalarFields(p.userinfo,IDENTITY_FIELDS)
    &&typeof p.userinfo.reg_number==='string'&&p.userinfo.reg_number.trim().length>0
    &&typeof p.userinfo.company_name==='string'&&p.userinfo.company_name.trim().length>0;
  if(!exact(p,['wsbxxGrid','rowCount','projectionComplete','periodVerified','navigation'])
    ||!Array.isArray(p.wsbxxGrid)||p.wsbxxGrid.length>10000||p.rowCount!==p.wsbxxGrid.length
    ||p.projectionComplete!==false||p.periodVerified!==false||!p.wsbxxGrid.every(row=>scalarFields(row,FILING_FIELDS)))return false;
  return exact(p.navigation,['present','missing','sameOrigin','externalOrigin','hasQuery','hasAuthMaterial','invalid'])
    &&Object.values(p.navigation).every(n=>Number.isSafeInteger(n)&&n>=0&&n<=20000);
}
export function validateEvidence(kind,v){
  if(kind==='source'){
    if(!exact(v,['version','authorizedNavigation','handoffMode','readerStoppedConfirmed','registrationRef','registrationRoot','pageRef','targetId','frameId','loaderId','documentUrlDigest','browserKey','capturedAt','identity','filing'])
      ||v.version!==1||v.authorizedNavigation!==true||!/^taxr_[a-f0-9]{48}$/.test(v.registrationRef)
      ||v.handoffMode!=='quarantined_reader_new_navigation'||v.readerStoppedConfirmed!==true
      ||!/^taxpage_[a-f0-9]{48}$/.test(v.pageRef)||typeof v.registrationRoot!=='string'
      ||!/[\\/]\.agent-runs[\\/]tax-browser-registry$/.test(v.registrationRoot)
      ||!opaque(v.targetId)||!opaque(v.frameId)||!opaque(v.loaderId)||! /^[a-f0-9]{64}$/.test(v.browserKey)
      ||! /^[a-f0-9]{64}$/.test(v.documentUrlDigest)
      ||!Number.isSafeInteger(v.capturedAt)||!validateCapture(v.identity,'identity')||!validateCapture(v.filing,'current_filing'))fail();
  }else if(kind==='run'){
    if(!exact(v,['version','sourceRef','capturedAt','identity','filing','operationRef','requestProof'])||v.version!==1
      ||!/^taxsource_[a-f0-9]{48}$/.test(v.sourceRef)||!Number.isSafeInteger(v.capturedAt)
      ||!validateCapture(v.identity,'identity')||!validateCapture(v.filing,'current_filing')
      ||!/^taxop_[a-f0-9]{48}$/.test(v.operationRef)||!Array.isArray(v.requestProof)||v.requestProof.length!==3
      ||!v.requestProof.every((proof,index)=>exact(proof,['requestRef','resource','requestPerformed','responseComplete'])
        &&/^taxreq_[a-f0-9]{48}$/.test(proof.requestRef)&&proof.resource===(index===1?'current_filing':'identity')
        &&proof.requestPerformed===true&&proof.responseComplete===true)
      ||new Set(v.requestProof.map(p=>p.requestRef)).size!==3)fail();
  }else fail();
  return v;
}
