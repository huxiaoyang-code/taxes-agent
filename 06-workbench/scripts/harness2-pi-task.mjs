// 通过 Pi 实际 MCP 运行时进行确定性的无模型集成驱动。
// 这是明确的合成任务，不作为模型决策质量的证据。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const db=process.env.FINANCE_DATABASE_PATH,root=dirname(dirname(db));
const {scope}=JSON.parse(readFileSync(join(root,'synthetic.json'),'utf8'));
assert.equal(scope.enterpriseKey,'SYNTHETIC-HARNESS2-A');
const {McpServerConnection,createDefaultTransport}=await import(pathToFileURL(join(process.argv[2],'dist/extensions/mcp/runtime.js')).href);
const connection=new McpServerConnection({entry:{name:'finance',config:{command:process.execPath,args:[join(import.meta.dirname,'../../05-reconstruction/codex/harness2/restricted-mcp.mjs')],env:{FINANCE_DATABASE_PATH:db,FINANCE_API_BASE:process.env.FINANCE_API_BASE,FINANCE_MCP_PROFILE:'harness',FINANCE_HARNESS2_SYNTHETIC_ROOT:root}},source:import.meta.filename,scope:'extension'},cwd:root,createTransport:createDefaultTransport,onTools:()=>{}});
const storePath=join(root,'harness-store');
const call=async(name,args)=>{const r=await connection.callTool(name,{...args,responseMode:'full'},{});assert.notEqual(r.isError,true,JSON.stringify(r.structuredContent));return r.structuredContent;};
try{
 await connection.getClient();const target=await call('harness_scope_discover',{});assert.equal(target.databaseInstanceId,scope.databaseInstanceId);
 const request={target:{dbPath:db,databaseInstanceId:scope.databaseInstanceId,enterpriseKey:scope.enterpriseKey,accountSetId:scope.accountSetId}};
 const original=join(root,'period-request.json');writeFileSync(original,JSON.stringify(request),{flag:'wx'});
 await call('harness_source_register',{storePath,source:{sourceId:'synthetic-request',path:original,locator:'Complete synthetic explicit target request',classification:'synthetic',parsed:false,unrecognized:[]}});
 await call('harness_facts_register',{storePath,facts:[{factId:'request',state:'provided',reason:'Explicit synthetic task request; no accounting judgment',sourceRefs:['synthetic-request'],value:request}]});
 await call('harness_plan',{storePath,tasks:[{taskId:'inspect-period',capabilityId:'period.inspect',factIds:['request'],requestFactId:'request',dependsOn:[],goal:'Inspect actual synthetic period controls; keep review pending'}]});
 let view=await call('harness_status',{storePath});const current=view.tasks.find(t=>t.taskId==='inspect-period');
 const result=await call('harness_run',{storePath,taskId:current.taskId,phase:'execute',dependencyDigest:current.dependencyDigest});assert.equal(result.status,'executed',JSON.stringify(result));
 view=await call('harness_status',{storePath});const task=view.tasks.find(t=>t.taskId==='inspect-period');assert.equal(task.executionState,'executed');assert.notEqual(task.reviewState,'accepted');
 const artifact={version:'finance-harness2-deliverable/1',synthetic:true,mode:'synthetic-native',host:'pi',capabilityId:'period.inspect',scope,task,modelInvoked:false,businessComplete:false};
 writeFileSync(join(dirname(root),'deliverable.json'),JSON.stringify(artifact,null,2),{flag:'wx'});
 console.log(JSON.stringify({status:'native_task_executed',modelInvoked:false,reviewState:task.reviewState,businessComplete:false}));
}finally{await connection.close();}
