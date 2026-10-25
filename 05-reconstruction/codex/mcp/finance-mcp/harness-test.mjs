import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join,dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from './mcp-stdio-client.mjs';
mkdirSync(resolve('.agent-runs'),{recursive:true});const here=dirname(fileURLToPath(import.meta.url)),root=mkdtempSync(resolve('.agent-runs/harness-mcp-'));
const client=new McpStdioClient(join(here,'server.mjs'),{env:{NODE_NO_WARNINGS:'1'},timeoutMs:60000}).start();
try {
 assert.equal((await client.initialize()).result.protocolVersion,'2025-06-18');
 const listed=(await client.rpc('tools/list')).result.tools;assert.equal(listed.filter(t=>t.name.startsWith('harness_')).length,12);assert.equal(listed.find(t=>t.name==='harness_discover').annotations.readOnlyHint,true);
 const discovery=await client.call('harness_discover');assert.equal(discovery.isError,false,discovery.text);assert.ok(discovery.structured.capabilities.some(c=>c.capabilityId==='batch.resume'));assert.ok(discovery.structured.capabilities.some(c=>c.capabilityId==='review.feedback'));
 const skill=await client.call('skills_read',{resource:'harness/SKILL.md'});assert.match(skill.data.markdown,/原始资料/);
 const resources=(await client.rpc('resources/list')).result.resources;assert.ok(resources.some(r=>r.uri==='skill://harness/references/recovery.md'));
 const scope={enterpriseKey:'SYN-MCP',accountSetId:1,databaseInstanceId:'synthetic-instance',period:'2026-Q2',currency:'CNY'},storePath=join(root,'state');
 assert.equal((await client.call('harness_init',{storePath,scope})).isError,false);
 const sourcePath=join(root,'raw.arbitrary');writeFileSync(sourcePath,'synthetic unknown-layout original');
 assert.equal((await client.call('harness_source_register',{storePath,source:{sourceId:'raw',path:sourcePath,locator:'line 1',parsed:false,unrecognized:['layout requires investigation'],classification:'unknown'}})).isError,false);
 assert.equal((await client.call('harness_facts_register',{storePath,facts:[{factId:'missing',state:'missing',reason:'Exact contract and business use absent',sourceRefs:[]}]})).isError,false);
 assert.equal((await client.call('harness_plan',{storePath,tasks:[{taskId:'blocked',capabilityId:'voucher.create',factIds:['missing'],dependsOn:[],goal:'Keep a concrete blocked branch'}]})).isError,false);
 const status=await client.call('harness_status',{storePath});assert.equal(status.structured.tasks[0].blockers[0].state,'missing');
 const blocked=await client.call('harness_run',{storePath,taskId:'blocked'});assert.equal(blocked.isError,true);assert.equal(blocked.data.error,'harness_task_blocked');
 const invalid=await client.call('harness_feedback',{storePath,feedback:{decision:'public_rule'}});assert.equal(invalid.isError,true);
 const supplement=await client.call('harness_request_materials',{storePath,request:{taskIds:['blocked'],text:'请补合同服务日期及实际用途'}});assert.equal(supplement.structured.sent,false);
 console.log('harness MCP: real stdio initialize/list/resources/discovery/register/plan/status/blocked execution/error and local supplement passed');
}finally{await client.close();}
