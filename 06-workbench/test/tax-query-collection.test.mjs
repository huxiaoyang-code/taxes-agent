import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtemp,rm,mkdir,readdir,readFile,writeFile,link} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {queryFixture,PRIVATE,OPERATOR} from './tax-query-fixture.mjs';
import {TaxQueryCollection,queryRequestScript} from '../server/tax-query-collection.mjs';
import {QUERY_ORIGIN,QUERY_PATHS,queryProjection,validateQueryRecord} from '../server/tax-query-contract.mjs';
const ROOT=fileURLToPath(new URL('../.agent-runs/',import.meta.url));
const safe=v=>assert.doesNotMatch(JSON.stringify(v),/SYNTHETIC_QUERY|profilePath|registrationRoot|targetId|frameId|loaderId|expression|headers|cookie|fullUrl/i);
async function fixture(fn,options){await mkdir(ROOT,{recursive:true});const dir=await mkdtemp(join(ROOT,'synthetic-query-'));
  try{await fn(await queryFixture(dir,options),dir);}finally{assert.equal(dirname(resolve(dir)),resolve(ROOT));await rm(dir,{recursive:true,force:true});}}
test('opaque refs only and default disabled',async()=>{
  const c=new TaxQueryCollection();assert.equal((await c.collect({contextRef:'taxquerycontext_'+'1'.repeat(48)})).status,'not_enabled');
  assert.equal((await c.collect({contextRef:'../x'})).status,'input_invalid');
  assert.equal((await c.collect({contextRef:'taxquerycontext_'+'1'.repeat(48),url:PRIVATE})).status,'input_invalid');
});
test('new replay context distinctly binds current doc; each collect actually performs seven requests',async()=>fixture(async f=>{
  const refresh=await f.collector.refresh({artifactRef:f.artifactRef});safe(refresh);assert.equal(refresh.status,'query_context_refreshed',JSON.stringify(refresh));
  assert.equal(refresh.requestPerformedCount,3);const context=await f.store.load(refresh.contextRef),template=await f.store.load(context.templateRef);
  assert.notEqual(template.captureDocument.loaderId,context.replayDocument.loaderId);assert.ok(template.captureDocument.fullUrl.includes('ruuid='));
  assert.ok(!context.replayDocument.fullUrl.includes('ruuid='));assert.equal(context.createdAt,3000);
  const first=await f.collector.collect({contextRef:refresh.contextRef}),second=await f.collector.collect({contextRef:refresh.contextRef});safe(first);safe(second);
  assert.equal(first.status,'query_resources_observed',JSON.stringify(first));assert.equal(first.requestPerformedCount,7);assert.equal(first.responseCompleteCount,7);
  assert.equal(first.resources.income_assessment.responseEnterpriseBound,false);assert.equal(first.resources.income_assessment.obligationVerified,false);
  assert.equal(first.bindingMode,'literal_parameter');assert.equal(first.resources.income_assessment.parameterEnterpriseBound,true);
  assert.equal(first.resources.income_assessment.sessionEnterpriseBound,false);
  assert.equal(first.businessScopeVerified,false);assert.equal(first.periodVerified,false);assert.notEqual(first.runRef,second.runRef);
  const compared=await f.collector.compare({leftRef:first.runRef,rightRef:second.runRef});safe(compared);assert.equal(compared.independentRequests,true);
  assert.equal(compared.basicProfileEqual,true);assert.equal(compared.enterpriseProfileEqual,true);
  assert.equal((await f.collector.compare({leftRef:first.runRef,rightRef:first.runRef})).status,'not_comparable');
  assert.equal(f.state.requests.length,17);assert.deepEqual(await readdir(f.profile),[]);
  for(const name of await readdir(f.store.root))assert.doesNotMatch(await readFile(join(f.store.root,name),'utf8'),new RegExp(OPERATOR+'|_BANK_ACCOUNT|loginUser|ssgly'));
  const calls=f.state.requests.filter(r=>r.resource==='enterprise_profile');
  assert.ok(calls.every(r=>r.address.includes('djxh='+PRIVATE+'_DJXH')));
  assert.ok(calls.every(r=>!r.expression.includes('Content-Type')&&!r.expression.includes(',body:')));
}));
for(const mode of ['identity_changed','wrong_djxh','cross_basic','cross_enterprise','business_error','null_data','bad_pagination','wrong_page','scope_changed','wrong_loader','wrong_path','registry_changed','incomplete'])
test('fail closed '+mode,async()=>fixture(async f=>{
  const r=await f.collector.refresh({artifactRef:f.artifactRef});assert.equal(r.status,'query_context_refreshed');f.state.mode=mode;
  const result=await f.collector.collect({contextRef:r.contextRef});safe(result);assert.equal(result.status,'query_collection_failed',mode);
  assert.equal((await readdir(f.store.root)).filter(n=>n.startsWith('taxqueryrun_')).length,0);
}));
for(const mode of ['identity_business_error','identity_schema_error','identity_changed'])test('completed identity counts survive validation failure '+mode,async()=>fixture(async f=>{
  const r=await f.collector.refresh({artifactRef:f.artifactRef});f.state.mode=mode;
  const result=await f.collector.collect({contextRef:r.contextRef});safe(result);assert.equal(result.status,'query_collection_failed');
  assert.equal(result.requestAttemptedCount,1);assert.equal(result.requestPerformedCount,1);assert.equal(result.responseCompleteCount,1);assert.equal(result.lockRetained,false);
}));
test('unknown request retains real profile lock and prevents a second collector',async()=>fixture(async f=>{
  const r=await f.collector.refresh({artifactRef:f.artifactRef});f.state.mode='unknown';
  const first=await f.collector.collect({contextRef:r.contextRef});safe(first);assert.equal(first.lockRetained,true);
  const count=f.state.requests.length,second=await f.collector.collect({contextRef:r.contextRef});safe(second);
  assert.equal(second.reason,'tax_collection_busy');assert.equal(f.state.requests.length,count);assert.equal((await readdir(f.profile)).length,1);
}));
for(const mode of ['cleanup_failed','close_failed'])test('cleanup failure retains exclusion '+mode,async()=>fixture(async f=>{
  const r=await f.collector.refresh({artifactRef:f.artifactRef});f.state.mode=mode;const result=await f.collector.collect({contextRef:r.contextRef});
  safe(result);assert.equal(result.lockRetained,true);assert.equal((await readdir(f.store.root)).filter(n=>n.startsWith('taxqueryrun_')).length,0);
}));
test('historical template is never silently upgraded: fresh context gets its own timestamp and proof',async()=>fixture(async f=>{
  f.state.now=10000000;const r=await f.collector.refresh({artifactRef:f.artifactRef});safe(r);assert.equal(r.status,'query_context_refreshed');
  const context=await f.store.load(r.contextRef),template=await f.store.load(context.templateRef);
  assert.equal(template.capturedAt,2000);assert.equal(context.createdAt,10000000);assert.equal(context.proof.length,3);
  f.state.now=context.expiresAt;assert.equal((await f.collector.collect({contextRef:r.contextRef})).reason,'query_context_expired');
}));
for(const mode of ['missing_helper','body_credential','wrong_capture','cross_helper','cross_basic'])test('invalid capture cannot authorize refresh '+mode,async()=>fixture(async f=>{
  await f.changeManifest(m=>{
    if(mode==='missing_helper')m.requests=m.requests.filter(r=>!r.url.includes('getUserMsg'));
    if(mode==='body_credential')m.requests[1].body={token:'[credential omitted]'};
    if(mode==='wrong_capture')m.document.url=m.document.url.replace('/nsrxxcx','/sbxx');
    if(mode==='cross_helper')m.requests.find(r=>r.url.includes('getUserMsg')).response.Response.Data.djxh=PRIVATE+'_OTHER';
    if(mode==='cross_basic')m.requests.find(r=>r.url.includes('DescribeNsrjbxx')).response.Response.Data.nsrmc=PRIVATE+'_OTHER';
  });
  const result=await f.collector.refresh({artifactRef:f.artifactRef});safe(result);assert.equal(result.status,'query_refresh_failed');assert.equal(f.state.requests.length,0);
}));
test('nonempty unknown income rows are never stored or compared as complete business data',async()=>fixture(async f=>{
  const r=await f.collector.refresh({artifactRef:f.artifactRef});f.state.mode='nonempty_income';const run=await f.collector.collect({contextRef:r.contextRef});safe(run);
  assert.equal(run.status,'query_resources_observed');assert.equal(run.resources.income_assessment.unknownRowSchema,true);
  assert.equal(run.resources.income_assessment.pageCoverageComplete,false);const record=await f.store.load(run.runRef);
  assert.equal(record.projections.income_assessment.ListCount,1);assert.equal(Object.hasOwn(record.projections.income_assessment,'List'),false);
}));
test('hard-linked capture manifests are refused before any active request',async()=>fixture(async(f,dir)=>{
  await link(f.manifestPath,join(dir,'second-link.json'));const r=await f.collector.refresh({artifactRef:f.artifactRef});safe(r);
  assert.equal(r.status,'query_refresh_failed');assert.equal(f.state.requests.length,0);
}));
test('publication verification failure retracts its linked context; no false context reference',async()=>fixture(async f=>{
  const verify=f.store.security.verifyFile;f.store.security.verifyFile=async p=>{if(/taxquerycontext_[a-f0-9]{48}\.json$/.test(p))throw Error(PRIVATE);return verify(p);};
  const r=await f.collector.refresh({artifactRef:f.artifactRef});safe(r);assert.equal(r.status,'query_refresh_failed');assert.equal(r.contextPublished,false);
  assert.equal((await readdir(f.store.root)).filter(n=>n.startsWith('taxquerycontext_')).length,0);
}));
for(const [mode,performed,complete] of [['http_failed_complete',1,1],['invalid_json_complete',1,1],['http_failed_incomplete',1,0],['scope_before_fetch',0,0]])
test('transport failure counts are explicit: '+mode,async()=>fixture(async f=>{
  const context=await f.collector.refresh({artifactRef:f.artifactRef});f.state.mode=mode;
  const result=await f.collector.collect({contextRef:context.contextRef});safe(result);
  assert.equal(result.status,'query_collection_failed');assert.equal(result.requestAttemptedCount,1);
  assert.equal(result.requestPerformedCount,performed);assert.equal(result.responseCompleteCount,complete);
  assert.equal(result.requestPerformedUnknownCount,0);assert.equal(result.responseCompleteUnknownCount,0);assert.equal(result.lockRetained,false);
}));
test('actual generated transport distinguishes complete HTTP/JSON failures, pre/post scope failure, oversized and unknown dispatch',async()=>{
  const recipe={path:QUERY_PATHS.getUserMsg,method:'GET',query:[],body:null},expected=QUERY_ORIGIN+'/szzh/zhcx/sbxx';
  for(const mode of ['normal','http','json','pre_scope','post_scope','oversized','opaque','unknown']){
    let dispatched=0,read=0;const location={href:mode==='pre_scope'?expected+'?changed=1':expected,origin:QUERY_ORIGIN};
    const response=mode==='post_scope'?{status:200,type:'basic',body:{getReader:()=>({async read(){if(read++===0)return{done:false,value:new TextEncoder().encode('{"ok":true}')};
      location.href=expected+'?changed=1';return{done:true};}})}}:mode==='opaque'?{status:302,type:'opaqueredirect',body:{async cancel(){}}}:
      new Response(mode==='json'?'invalid':mode==='oversized'?'x'.repeat(1048577):'{"ok":true}',{status:mode==='http'?500:200});
    const fetch=(async()=>{dispatched++;if(mode==='unknown')throw Error('synthetic network failure');return response;}).bind(null),timer=(()=>1).bind(null);
    const sandbox={location,window:{fetch,setTimeout:timer},fetch,setTimeout:timer,clearTimeout(){},AbortController,TextDecoder};
    const value=await vm.runInNewContext(queryRequestScript(recipe,'getUserMsg','taxreq_'+'4'.repeat(48),expected),sandbox);
    assert.equal(dispatched,mode==='pre_scope'?0:1);assert.equal(value.requestPerformed,mode==='pre_scope'?false:mode==='unknown'?null:true);
    assert.equal(value.responseComplete,['normal','http','json','post_scope'].includes(mode));assert.equal(value.settled,mode!=='unknown');
    assert.equal(value.status,({normal:'observed',http:'http_failed',json:'invalid_json',pre_scope:'scope_changed',post_scope:'scope_changed',oversized:'oversized',opaque:'http_failed',unknown:'request_unconfirmed'})[mode]);
    if(mode!=='normal')assert.equal(Object.hasOwn(value,'body'),false);
  }
});
test('finite number and string size contract is consistent in fresh/source projection and stored run',async()=>fixture(async f=>{
  const context=await f.collector.refresh({artifactRef:f.artifactRef});f.state.mode='infinite_field';
  assert.equal((await f.collector.collect({contextRef:context.contextRef})).status,'query_collection_failed');
  f.state.mode='normal';const run=await f.collector.collect({contextRef:context.contextRef}),record=await f.store.load(run.runRef);
  for(const value of [NaN,Infinity,-Infinity,'x'.repeat(4097)]){
    const corrupt=structuredClone(record);corrupt.projections.basic_profile.kjzdzzmc=value;assert.throws(()=>validateQueryRecord('run',corrupt));
  }
}));
test('capture pagination must match the original fixed request, before refresh',async()=>fixture(async f=>{
  await f.changeManifest(m=>m.requests.find(r=>r.url.includes('DescribeQysdshdxx')).response.Response.Data.PageSize=9);
  const r=await f.collector.refresh({artifactRef:f.artifactRef});safe(r);assert.equal(r.status,'query_refresh_failed');assert.equal(f.state.requests.length,0);
}));
for(const mode of ['missing_optional','value_changed','type_changed'])test('capture→run and both runs preserve coverage/dynamic differences: '+mode,async()=>fixture(async f=>{
  const refreshed=await f.collector.refresh({artifactRef:f.artifactRef});f.state.mode=mode;
  const first=await f.collector.collect({contextRef:refreshed.contextRef}),second=await f.collector.collect({contextRef:refreshed.contextRef});safe(first);safe(second);
  assert.equal(first.status,'query_resources_observed');assert.equal(first.responseCompleteCount,7);
  const coverage=first.captureComparison.enterprise_profile;
  assert.equal(coverage.equal,false);assert.equal(coverage.comparable,mode==='value_changed');
  assert.deepEqual(coverage.missingFields,mode==='missing_optional'?['kjzdzz']:[]);
  assert.deepEqual(coverage.typeChangedFields,mode==='type_changed'?['kjzdzz']:[]);
  const stored=await f.store.load(first.runRef);assert.ok(stored.captureDiff.some(d=>d.field==='kjzdzz'));
  const result=await f.collector.compare({leftRef:first.runRef,rightRef:second.runRef});safe(result);
  assert.equal(result.status,'query_runs_compared');assert.equal(result.enterpriseProfileComparable,mode==='value_changed');
  assert.equal(result.enterpriseProfileEqual,mode==='value_changed');
  assert.equal(result.captureComparisons.left.enterprise_profile.equal,false);
}));
test('fresh context may bind the separately observed filing query document without borrowing its query values',async()=>fixture(async f=>{
  f.state.currentPath='/szzh/zhcx/sbxx/sbxxcx?ruuid='+PRIVATE+'_CURRENT';
  const refreshed=await f.collector.refresh({artifactRef:f.artifactRef});safe(refreshed);assert.equal(refreshed.status,'query_context_refreshed');
  const run=await f.collector.collect({contextRef:refreshed.contextRef});safe(run);assert.equal(run.status,'query_resources_observed');
  assert.ok(f.state.requests.filter(r=>r.address&&r.resource!=='identity').every(r=>!r.address.includes('ruuid')));
}));
test('operation deadline also bounds private-store work before starting any live request',async()=>fixture(async f=>{
  let calls=0;f.collector.d.clock=()=>calls++===0?0:120001;
  const r=await f.collector.refresh({artifactRef:f.artifactRef});safe(r);assert.equal(r.reason,'query_deadline');assert.equal(f.state.requests.length,0);
}));
for(const failedKind of ['template','context','run'])test('unknown publication is assigned only to its actual record kind: '+failedKind,async()=>fixture(async f=>{
  const context=failedKind==='run'?await f.collector.refresh({artifactRef:f.artifactRef}):null,save=f.store.save.bind(f.store);
  f.store.save=async(kind,...args)=>{if(kind===failedKind){const error=Error('query_publication_unknown');error.code='query_publication_unknown';throw error;}return save(kind,...args);};
  const result=failedKind==='run'?await f.collector.collect({contextRef:context.contextRef}):await f.collector.refresh({artifactRef:f.artifactRef});safe(result);
  assert.equal(result.phase,'publish');assert.equal(result.reason,'query_publication_unknown');
  assert.equal(result.templatePublished,failedKind==='template'?null:failedKind==='context');
  assert.equal(result.contextPublished,failedKind==='context'?null:false);assert.equal(result.runPublished,failedKind==='run'?null:false);
  assert.equal(result.requestAttemptedCount,failedKind==='run'?7:3);assert.equal(result.requestPerformedCount,failedKind==='run'?7:3);
  assert.equal(result.responseCompleteCount,failedKind==='run'?7:3);assert.equal(result.lockRetained,false);
}));
for(const [name,mutate] of [['page zero',p=>p.PageNumber=0],['pageSize string',p=>p.PageSize='10'],['negative total',p=>p.Total=-1],
  ['false coverage',p=>p.pageCoverageComplete=false],['unknown schema string',p=>p.unknownRowSchema='no'],
  ['rows contradiction',p=>{p.ListCount=1;p.Total=1;}],['missing identity',(_p,r)=>delete r.projections.basic_profile.nsrsbh],
  ['valid shape wrong page',p=>{p.PageSize=9;}]] )test('corrupt run cannot compare: '+name,async()=>fixture(async f=>{
  const ctx=await f.collector.refresh({artifactRef:f.artifactRef}),first=await f.collector.collect({contextRef:ctx.contextRef}),second=await f.collector.collect({contextRef:ctx.contextRef});
  const path=join(f.store.root,second.runRef+'.json'),record=JSON.parse(await readFile(path,'utf8'));mutate(record.projections.income_assessment,record);
  await writeFile(path,JSON.stringify(record));const result=await f.collector.compare({leftRef:first.runRef,rightRef:second.runRef});safe(result);
  assert.notEqual(result.status,'query_runs_compared');
}));
test('empty original parameters remain empty under current-session binding, including both fresh runs',async()=>fixture(async f=>{
  const refreshed=await f.collector.refresh({artifactRef:f.artifactRef});safe(refreshed);assert.equal(refreshed.status,'query_context_refreshed');
  assert.equal(refreshed.bindingMode,'current_session');const context=await f.store.load(refreshed.contextRef),template=await f.store.load(context.templateRef);
  assert.equal(template.bindingMode,'current_session');assert.equal(template.capturedHelperDjxh,PRIVATE+'_DJXH');
  assert.equal(template.recipes.enterprise_profile.query[0].value,'');assert.equal(template.recipes.income_assessment.query[2].value,'');
  const first=await f.collector.collect({contextRef:refreshed.contextRef}),second=await f.collector.collect({contextRef:refreshed.contextRef});safe(first);safe(second);
  assert.equal(first.status,'query_resources_observed');assert.equal(first.requestPerformedCount,7);assert.equal(first.bindingMode,'current_session');
  assert.equal(first.resources.income_assessment.parameterEnterpriseBound,false);assert.equal(first.resources.income_assessment.sessionEnterpriseBound,true);
  assert.equal(first.resources.income_assessment.responseEnterpriseBound,false);assert.equal(first.resources.income_assessment.obligationVerified,false);
  const requests=f.state.requests.filter(r=>['enterprise_profile','income_assessment'].includes(r.resource));assert.equal(requests.length,4);
  assert.ok(requests.every(r=>new URL(r.address).searchParams.get('djxh')===''));assert.ok(requests.every(r=>!r.address.includes(PRIVATE)));
  const compared=await f.collector.compare({leftRef:first.runRef,rightRef:second.runRef});safe(compared);
  assert.equal(compared.status,'query_runs_compared');assert.equal(compared.enterpriseProfileEqual,true);assert.equal(compared.incomePaginationEqual,true);
  assert.equal(first.captureComparison.incomePaginationEqual,true);assert.equal(first.projectionComplete,false);
},{bindingMode:'current_session'}));
for(const mode of ['missing_helper_djxh','empty_helper_djxh','cross_helper','cross_basic','cross_profile','mixed_parameters','whitespace_parameter','wrong_page','wrong_parent'])
test('current-session capture rejects incomplete or mismatched provenance: '+mode,async()=>fixture(async f=>{
  await f.changeManifest(m=>{
    const helper=m.requests.find(r=>r.url.includes('getUserMsg')).response.Response.Data;
    if(mode==='missing_helper_djxh')delete helper.djxh;
    if(mode==='empty_helper_djxh')helper.djxh='';
    if(mode==='cross_helper')helper.shxydm=PRIVATE+'_OTHER';
    if(mode==='cross_basic')m.requests.find(r=>r.url.includes('DescribeNsrjbxx')).response.Response.Data.tyshxydm=PRIVATE+'_OTHER';
    if(mode==='cross_profile')m.requests.find(r=>r.url.includes('DescribeNsrxxJcxx')).response.Response.Data.nsrmc=PRIVATE+'_OTHER';
    if(mode==='mixed_parameters')m.requests.find(r=>r.url.includes('DescribeQysdshdxx')).url+=PRIVATE+'_DJXH';
    if(mode==='whitespace_parameter')for(const r of m.requests)if(r.url.includes('djxh='))r.url+='++';
    if(mode==='wrong_page')m.requests.find(r=>r.url.includes('DescribeQysdshdxx')).response.Response.Data.PageSize=9;
    if(mode==='wrong_parent')m.identityProjection.userinfo.creditCode=PRIVATE+'_OTHER';
  });
  const result=await f.collector.refresh({artifactRef:f.artifactRef});safe(result);assert.equal(result.status,'query_refresh_failed');
  assert.equal(result.requestAttemptedCount,0);assert.equal(f.state.requests.length,0);assert.equal(result.lockRetained,false);
},{bindingMode:'current_session'}));
for(const mode of ['wrong_djxh','identity_changed','cross_basic','cross_enterprise','wrong_page'])
test('current-session fresh verification rejects changed enterprise/helper or paging: '+mode,async()=>fixture(async f=>{
  const context=await f.collector.refresh({artifactRef:f.artifactRef});assert.equal(context.status,'query_context_refreshed');f.state.mode=mode;
  const result=await f.collector.collect({contextRef:context.contextRef});safe(result);assert.equal(result.status,'query_collection_failed');
  assert.equal((await readdir(f.store.root)).filter(n=>n.startsWith('taxqueryrun_')).length,0);
},{bindingMode:'current_session'}));
test('stored run with a different valid binding mode cannot compare against its template',async()=>fixture(async f=>{
  const ctx=await f.collector.refresh({artifactRef:f.artifactRef}),first=await f.collector.collect({contextRef:ctx.contextRef}),second=await f.collector.collect({contextRef:ctx.contextRef});
  const path=join(f.store.root,second.runRef+'.json'),record=await f.store.load(second.runRef);
  record.bindingMode='literal_parameter';record.projections.income_assessment.parameterEnterpriseBound=true;record.projections.income_assessment.sessionEnterpriseBound=false;
  validateQueryRecord('run',record);await writeFile(path,JSON.stringify(record));
  assert.equal((await f.collector.compare({leftRef:first.runRef,rightRef:second.runRef})).status,'not_comparable');
},{bindingMode:'current_session'}));
test('template mode/helper inconsistency is rejected before any fresh request',async()=>fixture(async f=>{
  const ctx=await f.collector.refresh({artifactRef:f.artifactRef}),context=await f.store.load(ctx.contextRef),template=await f.store.load(context.templateRef);
  for(const mutate of [t=>t.bindingMode='literal_parameter',t=>t.capturedHelperDjxh='',t=>t.captureProjections.income_assessment.parameterEnterpriseBound=true]){
    const corrupt=structuredClone(template);mutate(corrupt);assert.throws(()=>validateQueryRecord('template',corrupt));
  }
},{bindingMode:'current_session'}));
