import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join,dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from './mcp-stdio-client.mjs';
mkdirSync(resolve('.agent-runs'),{recursive:true});const here=dirname(fileURLToPath(import.meta.url)),root=mkdtempSync(resolve('.agent-runs/harness-mcp-'));
const client=new McpStdioClient(join(here,'server.mjs'),{env:{FINANCE_MCP_PROFILE:'harness',NODE_NO_WARNINGS:'1'},timeoutMs:60000}).start();
// 将摘要引入前的原生断言保留为明确的兼容验证路径。
const nativeCall=client.call.bind(client);client.call=(name,args={})=>nativeCall(name,{...args,...(name.startsWith('harness_')?{responseMode:'full'}:{})});
try {
 assert.equal((await client.initialize()).result.protocolVersion,'2025-06-18');
 const listed=(await client.rpc('tools/list')).result.tools;assert.equal(listed.filter(t=>t.name.startsWith('harness_')).length,13);assert.equal(listed.find(t=>t.name==='harness_discover').annotations.readOnlyHint,true);
 const discovery=await nativeCall('harness_discover');assert.equal(discovery.isError,false,discovery.text);assert.deepEqual(discovery.structured.capabilities,[]);assert.ok(discovery.structured.domains.some(d=>d.domain==='batch'));const batch=await client.call('harness_discover',{domain:'batch'}),review=await client.call('harness_discover',{domain:'review'});assert.ok(batch.structured.capabilities.some(c=>c.capabilityId==='batch.resume'));assert.ok(review.structured.capabilities.some(c=>c.capabilityId==='review.feedback'));
 const inventory=await client.call('harness_discover');assert.equal(inventory.structured.capabilities.length,29);assert.ok(inventory.structured.capabilities.some(c=>c.capabilityId==='batch.resume'));assert.ok(inventory.structured.capabilities.some(c=>c.capabilityId==='review.feedback'));
 const skill=await client.call('skills_read',{resource:'harness/SKILL.md'});assert.match(skill.data.markdown,/原始资料/);
 const resources=(await client.rpc('resources/list')).result.resources;assert.ok(resources.some(r=>r.uri==='skill://harness/references/recovery.md'));
 const scope={enterpriseKey:'SYN-MCP',accountSetId:1,databaseInstanceId:'synthetic-instance',period:'2026-Q2',currency:'CNY'},storePath=join(root,'state');
 assert.equal((await client.call('harness_init',{storePath,scope})).isError,false);
 const sourcePath=join(root,'raw.arbitrary');writeFileSync(sourcePath,'synthetic unknown-layout original');
 assert.equal((await client.call('harness_source_register',{storePath,source:{sourceId:'raw',path:sourcePath,locator:'line 1',parsed:false,unrecognized:['layout requires investigation'],classification:'unknown'}})).isError,false);
 assert.equal((await client.call('harness_facts_register',{storePath,facts:[{factId:'missing',state:'missing',reason:'Exact contract and business use absent',sourceRefs:[]}]})).isError,false);
 assert.equal((await client.call('harness_plan',{storePath,tasks:[{taskId:'blocked',capabilityId:'voucher.create',factIds:['missing'],dependsOn:[],goal:'Keep a concrete blocked branch'}]})).isError,false);
 const status=await client.call('harness_status',{storePath});assert.equal(status.structured.tasks[0].blockers[0].state,'missing');
 const blocked=await client.call('harness_run',{storePath,taskId:'blocked'});assert.equal(blocked.isError,true);assert.equal(blocked.data.error,'harness_task_blocked');assert.ok(blocked.data.details.blockers.some(b=>b.factId==='missing'&&b.state==='missing'));
 const summaryBlocked=await nativeCall('harness_run',{storePath,taskId:'blocked'});assert.equal(summaryBlocked.structured.code,'harness_task_blocked');assert.ok(summaryBlocked.structured.details.blockers.some(b=>b.factId==='missing'&&b.state==='missing'));
 // 不可用的业务事实保留各自状态的阻塞；provided 值结构错误时保留结构诊断。
 const unavailable=['conflict','unknown','not_applicable'].map(state=>({factId:'request-'+state,state,reason:'Synthetic '+state+' business state',sourceRefs:[]}));
 const malformed=[{factId:'request-string',state:'provided',reason:'Synthetic malformed request',sourceRefs:['raw'],value:'SYN-NOT-A-REQUEST'},{factId:'request-null',state:'provided',reason:'Synthetic malformed request',sourceRefs:['raw'],value:null}];
 assert.equal((await client.call('harness_facts_register',{storePath,facts:[...unavailable,...malformed]})).isError,false);
 const additionalTasks=[...unavailable,...malformed].map(f=>({taskId:f.factId,capabilityId:'voucher.create',requestFactId:f.factId,factIds:[f.factId],dependsOn:[],goal:'Synthetic missing-versus-invalid request boundary'}));
 assert.equal((await client.call('harness_plan',{storePath,tasks:[{taskId:'blocked',capabilityId:'voucher.create',factIds:['missing'],dependsOn:[],goal:'Keep the existing blocked branch'},...additionalTasks]})).isError,false);
 for(const state of ['conflict','unknown']){const r=await client.call('harness_run',{storePath,taskId:'request-'+state});assert.equal(r.isError,true);assert.equal(r.data.error,'harness_task_blocked');assert.ok(r.data.details.blockers.some(b=>b.factId==='request-'+state&&b.state===state));}
 const na=await client.call('harness_run',{storePath,taskId:'request-not_applicable'});assert.equal(na.isError,true);assert.equal(na.data.error,'harness_request_fact_required');
 for(const suffix of ['string','null']){const r=await client.call('harness_run',{storePath,taskId:'request-'+suffix});assert.equal(r.isError,true);assert.equal(r.data.error,'harness_capability_input_invalid');assert.ok(r.data.details.problems.some(p=>p.inputPointer===''&&p.keyword==='type'));}
 const invalid=await client.call('harness_feedback',{storePath,feedback:{decision:'public_rule'}});assert.equal(invalid.isError,true);
 const supplement=await client.call('harness_request_materials',{storePath,request:{taskIds:['blocked'],text:'请补合同服务日期及实际用途'}});assert.equal(supplement.structured.sent,false);
 console.log('harness MCP: real stdio initialize/list/resources/discovery/register/plan/status/blocked execution/error and local supplement passed');
}finally{await client.close();}
