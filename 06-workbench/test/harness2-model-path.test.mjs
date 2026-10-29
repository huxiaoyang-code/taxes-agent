// Explicit Linux-only integration: real Pi CLI + MCP + Google core, scripted
// API transport only. No external network request or real credential is used.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createBudgetGateway} from '../../05-reconstruction/codex/harness2/budget-gateway.mjs';
if(process.platform!=='linux'||!process.argv[2])throw Error('explicit_linux_model_path_config_required');
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
const content=value=>typeof value==='string'?value:Array.isArray(value)?value.map(x=>x.text??'').join('\n'):'';
let calls=0;
const transport=async body=>{
 calls++;let message;
 if(body.response_format?.type==='json_object'){
   const payload=JSON.parse(content(body.messages.at(-1).content));
   let reply,files;
   if(payload.mission.includes('# WHAT HAPPENED'))reply='<experience>\ncue: pending native review\nlesson: preserve actual native state axes\nevidence: synthetic native period inspection\n</experience>';
   else if(payload.mission.includes('Choose exactly one of:'))reply='```choice\nA\n```\n<why>Preserves native pending review.</why>';
   else {reply='<notes>Clarified pending native review.</notes>';files={'SKILL.md':payload.syntheticFiles['harness/SKILL.md']+'\nKeep human review pending.\n'};}
   message={role:'assistant',content:JSON.stringify({reply,...files?{files}:{}})};
 }else{
   const text=body.messages.map(x=>content(x.content)).join('\n');
   const match=text.match(/existing Harness Store is ([^;]+); scope is (\{[^}]+\})/);assert.ok(match,'scripted native task prompt missing');
   const storePath=match[1],scope=JSON.parse(match[2]),synthetic=storePath.replace(/\/harness-store$/,''),target={dbPath:synthetic+'/data/workbench.db',databaseInstanceId:scope.databaseInstanceId,enterpriseKey:scope.enterpriseKey,accountSetId:scope.accountSetId};
   const prior=body.messages.filter(x=>x.role==='assistant').flatMap(x=>x.tool_calls??[]),step=prior.length;
   const commands=[['harness_scope_discover',{}],['harness_source_register',{storePath,source:{sourceId:'synthetic-request',path:synthetic+'/period-request.json',locator:'Whole synthetic target request',classification:'synthetic',parsed:false,unrecognized:[]}}],['harness_facts_register',{storePath,facts:[{factId:'request',state:'provided',reason:'Synthetic fixed task request',sourceRefs:['synthetic-request'],value:{target}}]}],['harness_plan',{storePath,tasks:[{taskId:'inspect-period',capabilityId:'period.inspect',factIds:['request'],requestFactId:'request',dependsOn:[],goal:'Inspect actual synthetic period controls'}]}],['harness_status',{storePath,responseMode:'full'}]];
   let selected=commands[step];
   if(step===5){const tool=body.messages.filter(x=>x.role==='tool').at(-1),found=content(tool.content).match(/dependencyDigest["\\: ]+([a-f0-9]{64})/);assert.ok(found,'native dependency digest missing');selected=['harness_run',{storePath,taskId:'inspect-period',phase:'execute',dependencyDigest:found[1]}];}
   message=selected?{role:'assistant',content:null,tool_calls:[{id:'synthetic-call-'+step,type:'function',function:{name:'mcp__finance__'+selected[0],arguments:JSON.stringify(selected[1])}}]}:{role:'assistant',content:'Native inspection executed; human review remains pending.'};
 }
 return {status:200,body:{id:'synthetic-'+calls,model:'deepseek-flash',created:1,choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:100}}};
};
const gateway=createBudgetGateway({...config.budget,apiKey:'SYNTHETIC-NOT-A-REAL-KEY',transport});await gateway.listen();
const budgetPath=join(config.brokerDir,'budget.json');writeFileSync(budgetPath,JSON.stringify(config.budget));
const args=[join(config.sourceRepo,'06-workbench/scripts/harness2-google.py'),'--upstream',config.upstream,'--repo-stage',config.repoStage,'--host-stage',config.hostStage,'--node',config.node,'--work',config.work,'--canary',config.canary,'--execution-mode','model','--gateway-socket',config.budget.socketPath,'--budget-config',budgetPath];
try{
 const child=spawn('/usr/bin/python3.12',args,{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 const exit=await new Promise((ok,no)=>{child.once('error',no);child.once('close',ok);});
 writeFileSync(join(config.brokerDir,'cycle.stdout'),stdout);writeFileSync(join(config.brokerDir,'cycle.stderr'),stderr);
 assert.equal(exit,0,stderr+'\n'+stdout);assert.ok(calls>0&&calls<=config.budget.maxCalls);assert.equal(gateway.ledger.stopped,null);
 console.log(JSON.stringify({status:'passed',nativeHost:'pi',mockModelTransport:true,paidModelInvoked:false,sharedBudgetCalls:calls,fullProductionModelPath:true}));
}finally{await gateway.close();}
