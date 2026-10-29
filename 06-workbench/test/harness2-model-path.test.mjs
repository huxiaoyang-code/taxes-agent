// Explicit Linux-only integration: real Pi CLI + MCP + Google core, scripted
// Separate scripted Codex CLI and DS execution transport. No paid model call.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createBudgetGateway} from '../../05-reconstruction/codex/harness2/budget-gateway.mjs';
if(process.platform!=='linux'||!process.argv[2])throw Error('explicit_linux_model_path_config_required');
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(config.delayExecutorCall!==undefined||config.responseDelayMs!==undefined){assert.ok(Number.isSafeInteger(config.delayExecutorCall)&&config.delayExecutorCall>0);assert.ok(Number.isSafeInteger(config.responseDelayMs)&&config.responseDelayMs>0);}
const content=value=>typeof value==='string'?value:Array.isArray(value)?value.map(x=>x.text??'').join('\n'):'';
let calls=0;const delayedExecutorCalls=[];
const transport=async body=>{
 calls++;let message;
 assert.notEqual(body.response_format?.type,'json_object','optimizer must never call the DS execution gateway');
 {
   const text=body.messages.map(x=>content(x.content)).join('\n');
   const match=text.match(/existing Harness Store is ([^;]+); scope is (\{[^}]+\})/);assert.ok(match,'scripted native task prompt missing');
   const storePath=match[1],scope=JSON.parse(match[2]),synthetic=storePath.replace(/\/harness-store$/,''),target={dbPath:synthetic+'/data/workbench.db',databaseInstanceId:scope.databaseInstanceId,enterpriseKey:scope.enterpriseKey,accountSetId:scope.accountSetId};
   if(calls===config.delayExecutorCall){
     const event={call:calls,storePath,requestedDelayMs:config.responseDelayMs,elapsedMs:null};delayedExecutorCalls.push(event);
     writeFileSync(join(config.brokerDir,'executor-delay.json'),JSON.stringify(delayedExecutorCalls,null,2));
     const started=performance.now(),deadline=started+config.responseDelayMs;
     for(let remaining=deadline-performance.now();remaining>0;remaining=deadline-performance.now())await new Promise(ok=>setTimeout(ok,Math.max(1,Math.ceil(remaining))));
     event.elapsedMs=performance.now()-started;
     writeFileSync(join(config.brokerDir,'executor-delay.json'),JSON.stringify(delayedExecutorCalls,null,2));
     if(config.delayExecutorCall===8)assert.ok(!storePath.includes('/runs/base1/'),'call 8 must delay a candidate, not the baseline');
   }
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
const fakeCodex=join(config.brokerDir,'fake-codex-cli.mjs');
const codexCounter=join(config.brokerDir,'codex-exec-count.jsonl');
writeFileSync(fakeCodex,`import{writeFileSync,appendFileSync}from'node:fs';
const a=process.argv.slice(2);if(a[0]==='--version'){console.log('synthetic-codex-cli');process.exit(0);}if(a[0]==='mcp'){console.log('[]');process.exit(0);}
appendFileSync(${JSON.stringify(codexCounter)},'exec\\n');
let raw='';for await(const c of process.stdin)raw+=c;const p=JSON.parse(raw);
let reply;const files={'SKILL.md':null,'tools.md':null,'recovery.md':null};
if(p.mission.includes('# WHAT HAPPENED'))reply='<experience>\\ncue: pending native review\\nlesson: preserve actual native state axes\\nevidence: synthetic native period inspection\\n</experience>';
else{reply='<notes>Clarified pending native review.</notes>';files['SKILL.md']=p.syntheticFiles['harness/SKILL.md']+'\\nKeep human review pending.\\n';}
writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({reply,files}));console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-codex'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:100}}));`);
const args=[join(config.sourceRepo,'06-workbench/scripts/harness2-google.py'),'--upstream',config.upstream,'--repo-stage',config.repoStage,'--host-stage',config.hostStage,'--node',config.node,'--work',config.work,'--canary',config.canary,'--execution-mode','model','--gateway-socket',config.budget.socketPath,'--budget-config',budgetPath,'--optimizer','codex','--codex-cli',config.node,'--codex-node',config.node,'--codex-work-root',join(config.brokerDir,'codex-contexts'),'--codex-script',fakeCodex];
const setArg=(input,name,value)=>{const result=[...input],i=result.indexOf(name);if(i>=0)result.splice(i,2);if(value!==undefined)result.push(name,value);return result;};
const invoke=async input=>{const child=spawn('/usr/bin/python3.12',input,{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);const code=await new Promise((ok,no)=>{child.once('error',no);child.once('close',ok);});return {code,stdout,stderr};};
const optimizerCalls=()=>readFileSync(codexCounter,'utf8').trim().split('\n').length;
try{
 const withoutMode=args.filter((value,index)=>value!=='--execution-mode'&&args[index-1]!=='--execution-mode');
 const omitted=spawn('/usr/bin/python3.12',withoutMode,{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});let omittedError='';omitted.stdout.resume();omitted.stderr.on('data',x=>omittedError+=x);
 const omittedExit=await new Promise((ok,no)=>{omitted.once('error',no);omitted.once('close',ok);});assert.notEqual(omittedExit,0);assert.match(omittedError,/--execution-mode/);assert.equal(calls,0);assert.equal((await import('node:fs')).existsSync(join(config.brokerDir,'codex-contexts')),false,'missing mode must not start Codex');
 const child=spawn('/usr/bin/python3.12',args,{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 const exit=await new Promise((ok,no)=>{child.once('error',no);child.once('close',ok);});
 writeFileSync(join(config.brokerDir,'cycle.stdout'),stdout);writeFileSync(join(config.brokerDir,'cycle.stderr'),stderr);
 assert.equal(exit,0,stderr+'\n'+stdout);assert.ok(calls>0&&(config.budget.maxCalls===undefined||calls<=config.budget.maxCalls));assert.equal(gateway.ledger.stopped,null);
 const cyclePath=join(config.work,'experiment/cycle.json'),cycleBytes=readFileSync(cyclePath),cycle=JSON.parse(cycleBytes);assert.equal(cycle.optimizer.kind,'codex');assert.equal(cycle.optimizer.invocations.length,4);assert.equal(cycle.executor.calls,calls);assert.equal(cycle.optimizer.actualBilledUsd,null);assert.equal(cycle.executionMode,'model');assert.equal(optimizerCalls(),4);
 const bound=JSON.parse(readFileSync(join(config.work,'experiment/controller.json'),'utf8'));assert.equal(bound.binding.assessor.sha256,cycle.assessment.assessmentCodeDigest,'completed result binds the trusted assessor that actually checked it');
 const beforeCalls=calls;
 const reused=await invoke(args);assert.equal(reused.code,0,reused.stderr);assert.equal(JSON.parse(reused.stdout).resumeStatus,'already_completed');assert.equal(calls,beforeCalls);assert.equal(optimizerCalls(),4);
 const rejectChanged=async changed=>{const rejected=await invoke(changed);assert.notEqual(rejected.code,0);assert.match(rejected.stderr,/harness2_controller_binding_changed/);assert.equal(calls,beforeCalls);assert.equal(optimizerCalls(),4);};
 await rejectChanged(setArg(args,'--mode','seq'));
 await rejectChanged(setArg(args,'--host','dsh'));
 await rejectChanged(setArg(args,'--execution-mode','synthetic-native'));
 const budgetBytes=readFileSync(budgetPath);try{writeFileSync(budgetPath,JSON.stringify({...config.budget,maxOutputTokens:131072}));await rejectChanged(args);}finally{writeFileSync(budgetPath,budgetBytes);}
 const codexBytes=readFileSync(fakeCodex);try{writeFileSync(fakeCodex,Buffer.concat([codexBytes,Buffer.from('\n// changed CLI artifact\n')]));await rejectChanged(args);}finally{writeFileSync(fakeCodex,codexBytes);}
 const assessor=join(config.sourceRepo,'06-workbench/scripts/harness2-assess.mjs'),assessorBytes=readFileSync(assessor);try{writeFileSync(assessor,Buffer.concat([assessorBytes,Buffer.from('\n// synthetic assessor version change, restored below\n')]));await rejectChanged(args);}finally{writeFileSync(assessor,assessorBytes);}
 try{writeFileSync(cyclePath,JSON.stringify({...cycle,executionMode:'synthetic-native'}));const rejected=await invoke(args);assert.notEqual(rejected.code,0);assert.match(rejected.stderr,/harness2_completed_cycle_binding_changed/);assert.equal(calls,beforeCalls);assert.equal(optimizerCalls(),4);}finally{writeFileSync(cyclePath,cycleBytes);}
 const syntheticWork=config.work+'-synthetic';mkdirSync(syntheticWork);
 let syntheticArgs=setArg(setArg(setArg(args,'--work',syntheticWork),'--execution-mode','synthetic-native'),'--optimizer','synthetic-fixture');syntheticArgs=setArg(setArg(syntheticArgs,'--gateway-socket',undefined),'--budget-config',undefined);
 const synthetic=await invoke(syntheticArgs);assert.equal(synthetic.code,0,synthetic.stderr);assert.equal(JSON.parse(synthetic.stdout).executionMode,'synthetic-native');assert.equal(calls,beforeCalls);assert.equal(optimizerCalls(),4);
 let toModel=setArg(setArg(syntheticArgs,'--execution-mode','model'),'--optimizer','codex');toModel=setArg(setArg(toModel,'--gateway-socket',config.budget.socketPath),'--budget-config',budgetPath);await rejectChanged(toModel);
 if(config.delayExecutorCall!==undefined){assert.equal(delayedExecutorCalls.length,1);assert.ok(delayedExecutorCalls[0].elapsedMs>=config.responseDelayMs);}
 console.log(JSON.stringify({status:'passed',nativeHost:'pi',mockModelTransport:true,mockCodexCli:true,paidModelInvoked:false,executorGatewayCalls:calls,optimizerCliInvocations:4,fullProductionModelPath:true,rolesSeparated:true,delayedExecutorCalls,candidateDelayVerified:config.delayExecutorCall===8&&delayedExecutorCalls.length===1&&!delayedExecutorCalls[0].storePath.includes('/runs/base1/'),resumeBinding:['same config has no new calls','mode/host/executionMode/relay config/CLI changes refused','changed completion mode refused','synthetic to model refused']}));
}finally{await gateway.close();}
