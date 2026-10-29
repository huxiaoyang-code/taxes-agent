import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {prepare,nativeSummary} from '../../05-reconstruction/codex/harness2/bridge.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
const repo=resolve(import.meta.dirname,'../..');mkdirSync(join(repo,'.agent-runs'),{recursive:true});const root=mkdtempSync(join(repo,'.agent-runs/harness2-mcp-')),experiment=join(root,'experiment');await prepare({root:experiment});
const synthetic=join(experiment,'snapshot'),{scope}=JSON.parse(readFileSync(join(synthetic,'synthetic.json'),'utf8'));
const target={dbPath:join(synthetic,'data/workbench.db'),databaseInstanceId:scope.databaseInstanceId,enterpriseKey:scope.enterpriseKey,accountSetId:scope.accountSetId};
const original=join(synthetic,'period-request.json');writeFileSync(original,JSON.stringify({target}));
const client=new McpStdioClient(join(repo,'05-reconstruction/codex/harness2/restricted-mcp.mjs'),{cwd:root,env:{FINANCE_HARNESS2_SYNTHETIC_ROOT:synthetic,FINANCE_DATABASE_PATH:target.dbPath,NODE_NO_WARNINGS:'1'}}).start();
const call=async(name,args,error=false)=>{const result=await client.call(name,args);assert.equal(result.isError,error,result.text);return result.structured??result.data;};
try{
 await client.initialize();const listed=(await client.rpc('tools/list')).result.tools.map(tool=>tool.name);assert.ok(!listed.includes('harness_feedback'));assert.ok(!listed.includes('account_set_create'));
 const storePath=join(synthetic,'harness-store');
 assert.equal((await call('harness_feedback',{storePath,feedback:{decision:'accept'}},true)).code,'harness2_research_tool_forbidden');
 assert.equal((await call('harness_plan',{storePath,tasks:[{taskId:'inspect-period',capabilityId:'voucher.create',factIds:['request'],dependsOn:[],goal:'forbidden'}]},true)).code,'harness2_research_tool_forbidden');
 assert.equal((await call('harness_scope_discover',{dbPath:join(root,'other.db')},true)).code,'harness2_research_tool_forbidden');
 await call('harness_source_register',{storePath,source:{sourceId:'synthetic-request',path:original,locator:'Synthetic explicit target only',classification:'synthetic',parsed:false,unrecognized:[]}});
 await call('harness_facts_register',{storePath,facts:[{factId:'request',state:'provided',reason:'Synthetic request',sourceRefs:['synthetic-request'],value:{target}}]});
 await call('harness_plan',{storePath,tasks:[{taskId:'inspect-period',capabilityId:'period.inspect',factIds:['request'],requestFactId:'request',dependsOn:[],goal:'Read actual synthetic period controls'}]});
 const state=await call('harness_status',{storePath,responseMode:'full'});const task=state.tasks[0];await call('harness_run',{storePath,taskId:'inspect-period',phase:'execute',dependencyDigest:task.dependencyDigest});
 const final=await call('harness_status',{storePath,responseMode:'full'});assert.equal(final.tasks[0].executionState,'executed');assert.notEqual(final.tasks[0].confirmationCurrent,true);
 const summary=await nativeSummary(JSON.stringify({type:'host_result',status:'completed_with_tool_errors',innerErrorCount:2})+'\n');assert.deepEqual(summary,{nativeStatus:'completed_with_tool_errors',innerErrorCount:2});
 console.log('harness2-research-mcp: actual product MCP proxy rejects accounting feedback, write capability and other target; real period.inspect runs and current axes/inner errors remain visible');
}finally{await client.close();}
