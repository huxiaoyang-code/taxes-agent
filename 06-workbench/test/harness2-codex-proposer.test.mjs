// 实际外层工作进程配合脚本化 CLI，绝不使用模型/提供商凭据。
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {runCodexRequest} from '../../05-reconstruction/codex/harness2/codex-proposer-worker.mjs';
const root=mkdtempSync(join(tmpdir(),'harness2-codex-')),fake=join(root,'fake-cli.mjs');
writeFileSync(fake,`import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('codex-fixture 1.0');process.exit(0);}
if(a[0]==='mcp'){
 const disabled=a.includes('mcp_servers.codex_app={command='+JSON.stringify(process.execPath)+',enabled=false}');
 const servers=[{name:process.env.HARNESS2_FIXTURE_MCP_NAME??'configured-server',transport:{type:process.env.HARNESS2_FIXTURE_MCP_TRANSPORT??'stdio',command:'synthetic-original',env:{TOKEN:'SYNTHETIC_CONFIG_SECRET'}},enabled:!disabled},{name:'codex_app',transport:{type:'stdio'},enabled:!disabled}];
 if(disabled&&process.env.HARNESS2_FIXTURE_NEW_ENABLED==='yes')servers.push({name:'new-enabled-server',enabled:true,transport:{type:'stdio'}});
 console.log(JSON.stringify(servers));process.exit(0);
}
assert.equal(a[0],'exec');assert.equal(a[a.indexOf('--sandbox')+1],'read-only');
assert.ok(a.includes('features.shell_tool=false')&&a.includes('tools.web_search=false'));
for(const name of ['apps','plugins','remote_plugin','browser_use','computer_use','multi_agent','view_image','workspace_dependencies','hooks','skill_mcp_dependency_install'])assert.ok(a.includes('features.'+name+'=false'));
const configuredStub=process.env.HARNESS2_FIXTURE_MCP_TRANSPORT==='streamable_http'?'{url="http://127.0.0.1:1",enabled=false}':'{command='+JSON.stringify(process.execPath)+',enabled=false}';
assert.deepEqual(a.filter(x=>x.startsWith('mcp_servers.')),['mcp_servers.codex_app={command='+JSON.stringify(process.execPath)+',enabled=false}','mcp_servers.configured-server='+configuredStub]);
for(const option of ['--model','--ignore-user-config','--dangerously-bypass-approvals-and-sandbox'])assert.ok(!a.includes(option));
assert.equal(process.env.DEEPSEEK_API_KEY,undefined);
let s='';for await(const chunk of process.stdin)s+=chunk;
const p=JSON.parse(s);assert.ok(p.syntheticFiles['harness/SKILL.md']);
if(p.mission==='hang'){writeFileSync(p.syntheticFiles['pid.txt'],String(process.pid));setInterval(()=>{},1000);await new Promise(()=>{});}
if(p.mission==='exit23'){console.error('synthetic cli failure');process.exit(23);}
const files={'SKILL.md':null,'tools.md':p.mission==='select'?null:'Preserve pending human review.','recovery.md':null};
if(p.mission==='bad-file'||p.mission==='recovered-bad-file')files['script.py']='forbidden';
writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({reply:'<notes>Clarified native recovery.</notes>',files}));
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread',model:'fixture-model'}));
if(p.mission.startsWith('recovered')){
 for(const attempt of [2,3,4,5])console.log(JSON.stringify({type:'error',message:'Reconnecting... '+attempt+'/5 (request timed out)'}));
 console.log(JSON.stringify({type:'item.completed',message:'SYNTHETIC_UNVALIDATED_ROOT_SENTINEL',item:{id:'item_0',type:'error',message:'Falling back from WebSockets to HTTPS transport. request timed out'}}));
}
if(p.mission==='unknown-error')console.log(JSON.stringify({type:'error',message:'Unknown fatal provider failure SYNTHETIC_MUST_NOT_REACH_CODEX'}));
if(p.mission==='near-reconnect')console.log(JSON.stringify({type:'error',message:'Reconnecting... 2/5 (request timed out) but not the known diagnostic'}));
if(p.mission==='near-fallback')console.log(JSON.stringify({type:'item.completed',item:{type:'error',message:'Falling back from WebSockets to HTTPS transport. request timed out; fatal'}}));
if(p.mission==='unexpected-tool'||p.mission==='recovered-tool')console.log(JSON.stringify({type:'item.completed',item:{type:'plugin_tool_call'}}));
console.log(JSON.stringify({type:'item.completed',item:{id:'item_1',type:'agent_message',text:'Synthetic structured answer emitted.'}}));
if(p.mission==='recovered-failed')console.log(JSON.stringify({type:'turn.failed',error:{message:'Synthetic terminal failure'}}));
if(p.mission!=='recovered-no-completion')console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:2,output_tokens:7}}));
if(p.mission==='recovered-exit23')process.exit(23);
`);
const request=(label,mission='edit')=>({version:'finance-codex-proposer/1',codexCli:process.execPath,codexScript:fake,workRoot:join(root,'contexts'),label,mission,harvest:mission!=='select',syntheticFiles:{'harness/SKILL.md':'# Synthetic\nPreserve unknown.\n','evidence.txt':'x'.repeat(100000)}});
const prior=process.env.DEEPSEEK_API_KEY;process.env.DEEPSEEK_API_KEY='SYNTHETIC_MUST_NOT_REACH_CODEX';
try{
 const edited=await runCodexRequest(request('large-context'));assert.equal(edited.ok,true);assert.equal(edited.files['tools.md'],'Preserve pending human review.');
 assert.equal(edited.metadata.modelSelection,'inherited');assert.equal(edited.metadata.actualModel,'fixture-model');assert.equal(edited.metadata.actualBilledUsd,null);
 const inv=JSON.parse(readFileSync(join(edited.metadata.artifactDirectory,'invocation.json')));assert.ok(inv.inputUtf8Bytes>65536);assert.equal(inv.disabledMcpServerCount,2);
 const previousMcpName=process.env.HARNESS2_FIXTURE_MCP_NAME;process.env.HARNESS2_FIXTURE_MCP_NAME='unsafe.server';
 try{await assert.rejects(runCodexRequest(request('unsafe-mcp-name')),/codex_mcp_server_name_unsupported/);}finally{if(previousMcpName===undefined)delete process.env.HARNESS2_FIXTURE_MCP_NAME;else process.env.HARNESS2_FIXTURE_MCP_NAME=previousMcpName;}
 const previousTransport=process.env.HARNESS2_FIXTURE_MCP_TRANSPORT;process.env.HARNESS2_FIXTURE_MCP_TRANSPORT='unknown';
 try{await assert.rejects(runCodexRequest(request('unsupported-mcp-transport')),/codex_mcp_transport_unsupported/);}finally{if(previousTransport===undefined)delete process.env.HARNESS2_FIXTURE_MCP_TRANSPORT;else process.env.HARNESS2_FIXTURE_MCP_TRANSPORT=previousTransport;}
 process.env.HARNESS2_FIXTURE_MCP_TRANSPORT='streamable_http';
 try{assert.equal((await runCodexRequest(request('disabled-http-stub'))).ok,true);}finally{if(previousTransport===undefined)delete process.env.HARNESS2_FIXTURE_MCP_TRANSPORT;else process.env.HARNESS2_FIXTURE_MCP_TRANSPORT=previousTransport;}
 const previousEnabled=process.env.HARNESS2_FIXTURE_NEW_ENABLED;process.env.HARNESS2_FIXTURE_NEW_ENABLED='yes';
 try{await assert.rejects(runCodexRequest(request('mcp-new-enabled')),/codex_mcp_disable_verification_failed/);}finally{if(previousEnabled===undefined)delete process.env.HARNESS2_FIXTURE_NEW_ENABLED;else process.env.HARNESS2_FIXTURE_NEW_ENABLED=previousEnabled;}
 for(const name of readdirSync(edited.metadata.artifactDirectory).filter(x=>x.endsWith('.stdout')||x.endsWith('.stderr')||x==='result.json'||x==='invocation.json'))assert.ok(!readFileSync(join(edited.metadata.artifactDirectory,name),'utf8').includes('SYNTHETIC_CONFIG_SECRET'));
 const selected=await runCodexRequest(request('select','select'));assert.equal(selected.ok,true);assert.deepEqual(selected.files,{});
 const invalid=await runCodexRequest(request('bad-file','bad-file'));assert.equal(invalid.ok,false);assert.equal(invalid.code,'codex_answer_invalid');
 const failed=await runCodexRequest(request('failure','exit23'));assert.equal(failed.ok,false);assert.equal(failed.metadata.exitCode,23);assert.match(readFileSync(join(failed.metadata.artifactDirectory,'codex.stderr'),'utf8'),/synthetic cli failure/);
 const tool=await runCodexRequest(request('unexpected-tool','unexpected-tool'));assert.equal(tool.ok,false);assert.equal(tool.code,'codex_unexpected_tool_use');assert.deepEqual(tool.metadata.unexpectedItemTypes,['plugin_tool_call']);
 const recovered=await runCodexRequest(request('recovered','recovered'));assert.equal(recovered.ok,true);assert.equal(recovered.metadata.transportRecovered,true);assert.equal(recovered.metadata.diagnostics.length,5);assert.ok(recovered.metadata.diagnostics.every(x=>x.classification==='recoverable_transport'));assert.deepEqual(recovered.metadata.unexpectedItemTypes,[]);
 assert.equal(recovered.metadata.diagnostics.at(-1).message,'Falling back from WebSockets to HTTPS transport. request timed out');assert.ok(!JSON.stringify(recovered.metadata).includes('SYNTHETIC_UNVALIDATED_ROOT_SENTINEL'));
 assert.deepEqual(JSON.parse(readFileSync(join(recovered.metadata.artifactDirectory,'result.json'))).diagnostics,recovered.metadata.diagnostics);
 for(const [mission,code]of [['recovered-no-completion','codex_completion_missing'],['recovered-failed','codex_turn_failed'],['recovered-bad-file','codex_answer_invalid'],['recovered-exit23','codex_process_failed'],['recovered-tool','codex_unexpected_tool_use'],['unknown-error','codex_turn_failed'],['near-reconnect','codex_turn_failed'],['near-fallback','codex_turn_failed']]){
   const rejected=await runCodexRequest(request(mission,mission));assert.equal(rejected.ok,false,mission);assert.equal(rejected.code,code,mission);assert.equal(rejected.metadata.transportRecovered,false,mission);
   if(mission==='unknown-error'){assert.equal(rejected.metadata.fatalErrorCount,1);assert.deepEqual(rejected.metadata.diagnostics,[]);assert.ok(!JSON.stringify(rejected.metadata).includes('Unknown fatal provider failure'));assert.ok(!JSON.stringify(rejected.metadata).includes('SYNTHETIC_MUST_NOT_REACH_CODEX'));assert.match(readFileSync(join(rejected.metadata.artifactDirectory,'codex.stdout'),'utf8'),/redacted/);}
 }
 await assert.rejects(runCodexRequest({...request('escape'),syntheticFiles:{'../auth.json':'forbidden'}}),/context_file_forbidden/);
 await assert.rejects(runCodexRequest(request('large-context')),/invocation_already_exists/);
 const pidPath=join(root,'fake.pid'),hang=request('cancel','hang');hang.syntheticFiles['pid.txt']=pidPath;
 const worker=join(import.meta.dirname,'../../05-reconstruction/codex/harness2/codex-proposer-worker.mjs');
 const child=spawn(process.execPath,[worker],{stdio:['pipe','pipe','pipe'],windowsHide:true});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.stdin.write(JSON.stringify(hang)+'\n');
 const completion=new Promise((ok,no)=>{child.once('error',no);child.once('close',code=>ok(code));});
 const deadline=Date.now()+10000;while(!existsSync(pidPath)&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,20));assert.ok(existsSync(pidPath),stderr);
 const pid=Number(readFileSync(pidPath,'utf8'));child.stdin.end();assert.equal(await completion,1);assert.equal(JSON.parse(stdout).code,'codex_cancelled');
 let alive=true;try{process.kill(pid,0);}catch{alive=false;}assert.equal(alive,false,'owned fake Codex child terminated after parent pipe EOF');
 console.log(JSON.stringify({status:'passed',mockCodexCli:true,paidModelInvoked:false,checks:['inherited model/auth configuration','read-only and disabled unrelated tools','100KB context without local model cap','candidate allowlist','native exit23 and logs','single-use phase directory','stdin EOF cancels owned CLI child'],root}));
}finally{if(prior===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=prior;}
