import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpStdioClient } from './mcp-stdio-client.mjs';
import { withBackend, closeOwnedChild } from '../../../../06-workbench/test/enterprise-identity-http.test.mjs';
export async function withMcp(run){
 await withBackend(async ctx=>{
 const client=new McpStdioClient(join(import.meta.dirname,'server.mjs'),{cwd:import.meta.dirname,env:{FINANCE_API_BASE:ctx.base}}).start();
 let spawnError=null;
 client.child.on('error',error=>{spawnError=error.code || 'spawn_failed'});
 const ended=new Promise(resolve=>client.child.once('close',(code,signal)=>resolve({code,signal,spawnError})));
 try {await client.initialize('enterprise-identity-synthetic');await run({...ctx,client});}
 finally {try {await client.close();} finally {const closed=await closeOwnedChild(client.child,ended);console.log('owned MCP child close confirmed',JSON.stringify(closed));}}
 });
}
export async function ok(client,name,args){const r=await client.call(name,args);assert.equal(r.isError,false,r.text);assert.equal(r.data.ok,true,r.text);return r.data;}
export async function local(http,envelope){const r=await http('POST','/api/finance-output/read',{ref:envelope.localRef,accountSetId:envelope.accountSetId,operation:envelope.operation});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.value;}
if(import.meta.url===pathToFileURL(process.argv[1]).href){
test('stdio incremental empty profileId is a fixed validation failure with zero creations',async()=>withMcp(async({client,http})=>{
 const r=await client.call('book_import_incremental',{profileId:'',batchId:'INVALID-PROFILE',source:{system:'profile-negative',enterpriseKey:'PROFILE-NEGATIVE'},payload:{account_set:{name:'synthetic',start_period:'2026-01'}},dryRun:false});
 assert.equal(r.isError,true);assert.equal(r.data.error.code,'import_validation_failed');assert.deepEqual((await http('GET','/api/account-sets')).data,[]);
}));
test('stdio manual create requires stable identity and shares canonical binding with legacy/incremental; models exclude identity',async()=>withMcp(async({client,http})=>{
 const missing=await client.call('account_set_create',{name:'missing',start_period:'2026-01'});assert.equal(missing.isError,true);assert.equal(missing.data.error,'invalid_arguments');
 const enterprise={enterpriseKey:'STDIO-SECRET-KEY',enterpriseName:'STDIO-SECRET-NAME'};
 const result=await ok(client,'account_set_create',{name:'STDIO-SECRET-NAME',start_period:'2026-01',enterprise,profileId:'enterprise-2019-general-basic-v1'});assert.equal(result.applied,true);assert.equal(JSON.stringify(result).includes('STDIO-SECRET'),false);
 const raw=await local(http,result);assert.equal(raw.enterprise.enterpriseKey,enterprise.enterpriseKey);assert.equal(raw.accounting_profile_id,'enterprise-2019-general-basic-v1');
 const again=await client.call('account_set_create',{name:'renamed',start_period:'2026-01',enterprise});assert.equal(again.data.error.code,'enterprise_already_bound');
 const legacy=await ok(client,'legacy_book_import',{payload:{account_set:{name:'same enterprise',start_period:'2026-01'}},enterprise,dryRun:false});assert.equal(legacy.applied,false);const legacyRaw=(await http('POST','/agent/tools/legacy_book_import',{payload:{account_set:{name:'same enterprise',start_period:'2026-01'}},enterprise,dryRun:false})).data;assert.equal(legacyRaw.validation.identityError.code,'enterprise_already_bound');
 const conflict=await client.call('book_import_incremental',{source:{system:'changed-source',...enterprise},batchId:'STDIO-DUPLICATE',payload:{account_set:{name:'same enterprise',start_period:'2026-01'}},dryRun:false});assert.equal(conflict.data.error.code,'import_conflict');
 assert.equal((await http('GET','/api/account-sets')).data.length,1);
}));
test('stdio legacy payload/texts/files/paths keeps identity and profile envelopes for preview/apply',async()=>withMcp(async({client,http,directory})=>{
 const templates=(await http('GET','/api/import/templates')).data;
 const texts=Object.fromEntries(['meta','accounts','openings','vouchers'].map(k=>[k,templates[k]]));
 const paths=Object.fromEntries(Object.entries(texts).map(([k,v])=>{const p=join(directory,k+'.csv');writeFileSync(p,v);return[k,p]}));
 const formats=[{payload:{account_set:{name:'JSON synthetic',start_period:'2026-01'}}},{texts},{files:Object.fromEntries(Object.entries(texts).map(([k,v])=>[k,Buffer.from(v).toString('base64')]))},{paths}];
 for(const [i,format] of formats.entries()){
  const options={...format,enterprise:{enterpriseKey:'STDIO-LEGACY-'+i},profileId:'small-2011-basic-v1'};
  const dry=await ok(client,'legacy_book_import',options);assert.equal(dry.applied,false);assert.equal(dry.projection.validationOk,true);
  const applied=await ok(client,'legacy_book_import',{...options,dryRun:false});assert.equal(applied.applied,true);const saved=await local(http,applied);assert.ok(saved.created.id);
  const set=(await http('GET','/api/account-sets/'+saved.created.id)).data;assert.equal(set.enterprise.enterpriseKey,options.enterprise.enterpriseKey);assert.equal(set.accounting_profile_id,options.profileId);
 }
}));
test('stdio incremental paths preserves enterprise/source profile envelope and exact batch replay IDs',async()=>withMcp(async({client,http,directory})=>{
 const paths={meta:join(directory,'meta.csv'),vouchers:join(directory,'vouchers.csv')};
 writeFileSync(paths.meta,'键,值\n账套名称,合成企业\n会计准则,企业会计准则\n启用期间,2026-01\n');
 writeFileSync(paths.vouchers,'期间,日期,字号,凭证号,摘要,科目编码,借方,贷方\n2026-01,2026-01-02,记,1,收入,1002,25,0\n2026-01,2026-01-02,记,1,收入,6001,0,25\n');
 const args={paths,source:{system:'stdio-path',enterpriseKey:'STDIO-INCREMENTAL-PATH'},profileId:'enterprise-2019-general-basic-v1',batchId:'STDIO-PATH-001',dryRun:false};
 const first=await ok(client,'book_import_incremental',args);assert.equal(first.applied,true);const a=await local(http,first);assert.equal(a.status,'applied');
 const replay=await ok(client,'book_import_incremental',args);const b=await local(http,replay);assert.equal(b.status,'idempotent_replay');assert.equal(b.accountSetId,a.accountSetId);assert.deepEqual(b.sourceTrace.map(x=>[x.sourceVoucherId,x.voucherId,x.contentFingerprint]),a.sourceTrace.map(x=>[x.sourceVoucherId,x.voucherId,x.contentFingerprint]));
}));
}
