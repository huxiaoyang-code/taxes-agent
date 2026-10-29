import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {nativeCommand,systemEnv,modelEndpoint,inside,requireGateway,EXPERIMENT_TOOLS,RESEARCH_TOOLS} from '../../05-reconstruction/codex/harness2/hosts/common.mjs';
import {inspectEvent,versionMatches,capture,runPlan} from '../../05-reconstruction/codex/harness2/hosts/native-runner.mjs';
import {decodeAnthropicRequest,encodeAnthropicResponse} from '../../05-reconstruction/codex/harness2/hosts/anthropic-codec.mjs';
import {readSurfaceBundle} from '../../05-reconstruction/codex/harness2/surface.mjs';

const nativeArgs=process.argv.slice(2),outAt=nativeArgs.indexOf('--out');let root;
if(outAt!==-1){assert.equal(outAt,3);assert.equal(nativeArgs.length,5);root=nativeArgs[4];assert.ok(isAbsolute(root));assert.equal(existsSync(root),false);mkdirSync(root);nativeArgs.splice(3);}
else{const scratch=process.platform==='win32'||['--native','--native-run','--bridge-probe'].includes(nativeArgs[0])?join(dirname(fileURLToPath(import.meta.url)),'../tmp'):tmpdir();mkdirSync(scratch,{recursive:true});root=mkdtempSync(join(scratch,'harness2-hosts-'));}
assert.equal(systemEnv().DEEPSEEK_API_KEY,undefined);assert.equal(systemEnv().ANTHROPIC_AUTH_TOKEN,undefined);
assert.throws(()=>nativeCommand(process.execPath,'relative.cmd'),/absolute_required/);
for(const ext of ['.cmd','.ps1','.bat']){const p=join(root,'wrapper'+ext);writeFileSync(p,'echo never');assert.throws(()=>nativeCommand(process.execPath,p),/no_shell_wrapper/);}
assert.throws(()=>nativeCommand(process.execPath,join(root,'missing.cjs')),/cli_missing/);
for(const url of ['https://proxy.example/v1','http://example.com:1234','https://api.deepseek.com/anthropic?x=1','http://user:secret@127.0.0.1:1'])assert.throws(()=>modelEndpoint(url,'messages'));
assert.equal(modelEndpoint(undefined,'messages'),'https://api.deepseek.com/anthropic');
assert.equal(modelEndpoint('http://127.0.0.1:49123/anthropic','messages'),'http://127.0.0.1:49123/anthropic');
assert.throws(()=>requireGateway('https://api.deepseek.com/v1'),/bounded_loopback_model_gateway_required/);
assert.throws(()=>inside(root,dirname(root),'task'),/outside_workspace/);
assert.ok(versionMatches('2.1.309 (Claude Code)','2.1.309'));assert.ok(!versionMatches('2.1.3090','2.1.309'));assert.ok(versionMatches('dsh 0.2.1-rc.2','0.2.1-rc.2'));assert.ok(!versionMatches('0.2.1-rc.20','0.2.1-rc.2'));
const errors=inspectEvent({success:true,result:{content:[{type:'text',text:JSON.stringify({status:'rejected',error:'harness_evidence_value_unbound'})}]}});assert.equal(errors[0].code,'harness_evidence_value_unbound');
assert.equal(inspectEvent({success:true,result:{isError:true}}).length,1);
assert.equal(inspectEvent({id:1,error:{code:-32603,message:'synthetic error'}}).length,1);
const anthropic={model:'deepseek-flash',max_tokens:128,stream:true,system:[{type:'text',text:'synthetic system',cache_control:{type:'ephemeral'}}],messages:[{role:'user',content:'synthetic task'},{role:'assistant',content:[{type:'thinking',thinking:'synthetic reasoning',signature:'opaque'},{type:'tool_use',id:'call-1',name:'harness_discover',input:{capabilityId:'period.inspect'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call-1',content:[{type:'text',text:'synthetic refusal'}],is_error:true}]}],tools:[{name:'harness_discover',description:'synthetic',input_schema:{type:'object'}}],output_config:{effort:'low'}};
const chat=decodeAnthropicRequest(anthropic);assert.equal(chat.messages[2].reasoning_content,'synthetic reasoning');assert.equal(chat.messages[2].tool_calls[0].function.name,'harness_discover');assert.equal(JSON.parse(chat.messages[3].content).is_error,true);assert.equal(chat.tools[0].function.parameters.type,'object');
assert.throws(()=>decodeAnthropicRequest({...anthropic,model:'other-model'}),/unsupported/);assert.throws(()=>decodeAnthropicRequest({...anthropic,messages:[{role:'user',content:[{type:'image',source:{}}]}]}),/unsupported/);
const chatResult={id:'synthetic-id',model:'deepseek-flash',choices:[{message:{role:'assistant',reasoning_content:'synthetic reasoning',tool_calls:[{id:'call-1',type:'function',function:{name:'harness_discover',arguments:'{}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:7}};
const encoded=JSON.parse(encodeAnthropicResponse(chatResult).body);assert.equal(encoded.stop_reason,'tool_use');assert.equal(encoded.usage.input_tokens,10);assert.equal(encoded.content[1].type,'tool_use');assert.ok(encodeAnthropicResponse(chatResult,{stream:true}).body.includes('event: message_stop'));
const wrong=join(root,'wrong-version.cjs'),neverRun=join(root,'unexpected-run.txt');writeFileSync(wrong,`if(process.argv.includes('--version'))console.log('9.9.9');else require('node:fs').writeFileSync(${JSON.stringify(neverRun)},'unexpected');`);
await assert.rejects(runPlan({schema:'harness2-native-plan/1',host:'dsh',mode:'check',expectedVersion:'0.2.1-rc.2',native:{command:process.execPath,prefix:[wrong]},cwd:root,timeoutMs:3000,checkArgs:['--dump-config']},{env:systemEnv(),emit:()=>{}}),/version_mismatch/);assert.equal(existsSync(neverRun),false);

const fakeCliPaths={};
for(const host of ['claude-code','dsh','zcode']){
  const {buildHostSpec,SUPPORTED_VERSION}=await import(`../../05-reconstruction/codex/harness2/hosts/${host}.mjs`);
  const packageDir=join(root,host+'-package');mkdirSync(join(packageDir,'glm'),{recursive:true});mkdirSync(join(packageDir,'config/provider'),{recursive:true});writeFileSync(join(packageDir,'config/provider/zcode-builtin.json'),'{}');
  const cli=join(packageDir,'glm',host+' fake ; $.cjs');
  fakeCliPaths[host]=cli;
  writeFileSync(cli,host==='zcode'?`if(process.argv.includes('--version'))console.log('0.16.9');else{const rl=require('node:readline').createInterface({input:process.stdin});const send=x=>console.log(JSON.stringify(x));const max=JSON.parse(require('node:fs').readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE)).config.modelConfigRules.providerModelRules[0].config.optionSpecs?.maxOutputTokens?.max??393216;rl.on('line',line=>{const m=JSON.parse(line);let result={};if(m.method==='session/create')result={sessionId:'synthetic-session',settings:{model:{current:m.params.model,available:[{maxOutputTokens:max}]},mode:{current:'build'},thoughtLevel:{current:'low'}},projection:{turnCount:0,totalTokenCount:0}};if(m.method==='mcp/list')result={statuses:{finance:{status:'connected',transport:'stdio',toolCount:process.env.FINANCE_HARNESS2_SYNTHETIC_ROOT?10:15}}};send({id:m.id,result});if(m.method==='session/send'){send({params:{event:{type:'tool.updated',payload:{result:{success:true,content:[{type:'text',text:JSON.stringify({status:'rejected',error:'synthetic_failure'})}]}}}}});send({params:{event:{type:'turn.completed'}}});}});}`:`if(process.argv.includes('--version'))console.log(${JSON.stringify(SUPPORTED_VERSION)});else if(process.argv.includes('--dump-config'))console.log('finance-harness-mcp FINANCE_MCP_PROFILE');else if(process.argv.includes('list'))console.log('finance: Connected');else if(process.argv.includes('--profile')&&!process.argv.includes('--json'))console.log(JSON.stringify({type:'harness2_dsh_probe',status:'passed',modelInvoked:false,turnCount:0,visibleTools:(process.env.FINANCE_HARNESS2_SYNTHETIC_ROOT?${JSON.stringify(RESEARCH_TOOLS)}:${JSON.stringify(EXPERIMENT_TOOLS)}).map(x=>'mcp__finance__'+x).sort()}));else console.log(JSON.stringify({success:true,result:{content:[{type:'text',text:JSON.stringify({status:'rejected',error:'synthetic_failure'})}]}}));`);
  for(const mode of ['check','run']){
    const workspace=join(root,host+'-'+mode);mkdirSync(workspace);writeFileSync(join(workspace,'task.txt'),'Synthetic metadata only.');const candidateDir=join(workspace,'candidate');mkdirSync(candidateDir);writeFileSync(join(candidateDir,'SKILL.md'),'SYNTHETIC_CANDIDATE_GUIDANCE');
    const spec=buildHostSpec({workspace,nodePath:process.execPath,cliPath:cli,databasePath:join(workspace,'synthetic.db'),apiBase:'http://127.0.0.1:49123',taskFile:join(workspace,'task.txt'),candidateDir,modelBaseUrl:'http://127.0.0.1:49124/v1',mode,...mode==='check'?{timeoutMs:10000}:{}});
    assert.equal(spec.host,host);assert.equal(spec.modelInvoked,mode==='run');assert.equal(spec.env.HOME.startsWith(workspace),true);assert.equal(spec.env.DSH_HOME?.includes('.host-dsh')??true,true);
    if(mode==='check'){assert.equal(spec.env.DEEPSEEK_API_KEY,host==='dsh'?'synthetic-harness2-placeholder':undefined);assert.equal(spec.env.ANTHROPIC_API_KEY,undefined);}
    const plan=JSON.parse(readFileSync(spec.planPath,'utf8'));assert.equal(JSON.stringify(plan).includes('apiKey:'),false);assert.equal(plan.native.prefix[0],cli);assert.equal(Object.hasOwn(plan,'maxOutputTokens'),false);assert.equal(spec.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,undefined);
    if(mode==='run'){
      assert.equal(plan.timeoutMs,null);assert.equal(spec.env.API_TIMEOUT_MS,undefined);
      if(host==='claude-code')assert.equal(spec.env.ANTHROPIC_API_KEY,'synthetic-harness2-placeholder');
      if(host==='dsh')assert.equal(spec.env.DEEPSEEK_API_KEY,'synthetic-harness2-placeholder');
      assert.ok(JSON.stringify(plan).includes('SYNTHETIC_CANDIDATE_GUIDANCE')||host==='dsh');
      if(host!=='zcode'){
        assert.equal(plan.runArgs.some(x=>/dangerously-skip|bypassPermissions|yolo/.test(x)),false);
        assert.equal(plan.runArgs.includes('--fallback-model'),false);
      }else{assert.equal(plan.protocol,'zcode-app-server');assert.equal(plan.allowedTools.includes('Bash'),false);assert.equal(spec.env.DEEPSEEK_API_KEY,undefined);}
      if(host==='claude-code'){assert.equal(plan.runArgs[plan.runArgs.indexOf('--tools')+1],'');assert.equal(plan.runArgs.includes('--no-session-persistence'),true);}
    }
    const r=spawnSync(spec.command,spec.args,{env:spec.env,cwd:spec.cwd,encoding:'utf8',windowsHide:true,shell:false,timeout:15000});
    assert.equal(r.status,0,r.stderr);const events=r.stdout.trim().split(/\r?\n/).map(x=>JSON.parse(x));assert.equal(events[0].version,SUPPORTED_VERSION);assert.equal(events.at(-1).status,mode==='check'?'completed':'completed_with_tool_errors');
    if(mode==='run')assert.equal(events.at(-1).innerErrorCount,1);
    assert.throws(()=>buildHostSpec({workspace,nodePath:process.execPath,cliPath:cli,databasePath:join(workspace,'synthetic.db'),apiBase:'http://127.0.0.1:49123',taskFile:join(workspace,'task.txt'),mode}),/host_output_must_be_new/);
  }
}

{
  const {buildHostSpec}=await import('../../05-reconstruction/codex/harness2/hosts/pi.mjs');
  const toolRoot=join(root,'pi-tools'),packageRoot=join(toolRoot,'node_modules/@earendil-works/pi-coding-agent');
  for(const name of ['pi-agent-core','pi-ai','pi-tui','pi-coding-agent','pi-codemode','pi-mcp','pi-telemetry','chord','typebox']){
    const id=name==='typebox'?name:'@earendil-works/'+name,directory=join(toolRoot,'node_modules',id);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'package.json'),JSON.stringify({name:id,version:name==='typebox'?'1.3.27':'1.1.0'}));
  }
  mkdirSync(join(packageRoot,'dist/bundle'),{recursive:true});writeFileSync(join(packageRoot,'dist/bundle/cli.js'),'// not executed');
  for(const requested of [undefined,65536]){
    const workspace=join(root,'pi-capability-'+String(requested));mkdirSync(workspace);const candidateDir=join(workspace,'candidate');mkdirSync(candidateDir);writeFileSync(join(candidateDir,'SKILL.md'),'SYNTHETIC ONLY');const taskFile=join(workspace,'task.txt');writeFileSync(taskFile,'Synthetic task');
    const spec=buildHostSpec({workspace,nodePath:process.execPath,packageRoot,apiBase:'http://127.0.0.1:49123',databasePath:join(workspace,'synthetic.db'),taskFile,candidateDir,mode:'run',modelBaseUrl:'http://127.0.0.1:49124/v1',...requested===undefined?{}:{maxOutputTokens:requested}});
    const models=JSON.parse(readFileSync(join(spec.env.PI_CODING_AGENT_DIR,'models.json'),'utf8')),model=models.providers.deepseek.models[0];
    assert.equal(model.contextWindow,1048576);assert.equal(model.maxTokens,requested??393216);assert.equal(model.reasoning,true);
  }
  for(const host of ['pi','claude-code','dsh','zcode']){
    const {buildHostSpec}=await import(`../../05-reconstruction/codex/harness2/hosts/${host}.mjs`),prompts=[];
    for(const changed of ['none','tools','recovery']){
      const workspace=join(root,'surface-'+host+'-'+changed),candidateDir=join(workspace,'candidate');mkdirSync(candidateDir,{recursive:true});
      const markers=['SURFACE_SKILL_ALWAYS','SURFACE_TOOLS_ALWAYS'+(changed==='tools'?'_CHANGED':''),'SURFACE_RECOVERY_ALWAYS'+(changed==='recovery'?'_CHANGED':'')];
      for(const [index,name] of ['SKILL.md','tools.md','recovery.md'].entries())writeFileSync(join(candidateDir,name),markers[index]);
      const taskFile=join(workspace,'task.txt');writeFileSync(taskFile,'Synthetic task');
      const options={workspace,nodePath:process.execPath,packageRoot,cliPath:fakeCliPaths[host],apiBase:'http://127.0.0.1:49123',databasePath:join(workspace,'synthetic.db'),taskFile,candidateDir,candidateText:'CALLER_MUST_NOT_REPLACE_SURFACE',mode:'run',modelBaseUrl:'http://127.0.0.1:49124/v1'};
      const spec=buildHostSpec(options),expected=readSurfaceBundle(candidateDir).text;let prompt;
      if(host==='pi'){assert.equal(spec.args.filter(arg=>arg==='--append-system-prompt').length,1);prompt=spec.args[spec.args.indexOf('--append-system-prompt')+1];assert.ok(prompt.includes('你是本机财税主 Agent。'));assert.ok(prompt.includes('不得编造会计批准、申报或付款。'));}
      else{
        const plan=JSON.parse(readFileSync(spec.planPath,'utf8'));
        if(host==='claude-code')prompt=plan.runArgs[plan.runArgs.indexOf('--append-system-prompt')+1];
        else if(host==='zcode')prompt=plan.task;
        else prompt=JSON.parse(readFileSync(join(workspace,'.host-dsh/model.cordis.patch.yml'),'utf8')).find(entry=>entry.id==='system-prompt').config.personaPrefix;
      }
      assert.ok(prompt.includes(expected),host+' must receive the complete verified always-on bundle');
      assert.equal(prompt.includes('CALLER_MUST_NOT_REPLACE_SURFACE'),false);
      for(const marker of markers)assert.ok(prompt.includes(marker),host+' missing '+marker);
      assert.ok(prompt.indexOf(markers[0])<prompt.indexOf(markers[1]));assert.ok(prompt.indexOf(markers[1])<prompt.indexOf(markers[2]));
      prompts.push(prompt);
    }
    assert.notEqual(prompts[0],prompts[1],host+' tools-only edits must affect the native prompt');assert.notEqual(prompts[0],prompts[2],host+' recovery-only edits must affect the native prompt');
    const workspace=join(root,'surface-'+host+'-invalid'),candidateDir=join(workspace,'candidate');mkdirSync(candidateDir,{recursive:true});writeFileSync(join(candidateDir,'SKILL.md'),'SYNTHETIC');writeFileSync(join(candidateDir,'forbidden.js'),'SYNTHETIC');const taskFile=join(workspace,'task.txt');writeFileSync(taskFile,'Synthetic task');
    assert.throws(()=>buildHostSpec({workspace,nodePath:process.execPath,packageRoot,cliPath:fakeCliPaths[host],apiBase:'http://127.0.0.1:49123',databasePath:join(workspace,'synthetic.db'),taskFile,candidateDir,mode:'run',modelBaseUrl:'http://127.0.0.1:49124/v1'}),/harness2_surface_file_forbidden/);
  }
}

{
  const {prepare,dispatch}=await import('../../05-reconstruction/codex/harness2/bridge.mjs'),experiment=join(root,'production-bridge-regression');await prepare({root:experiment});
  for(const host of ['claude-code','dsh','zcode']){
    const receipt=await dispatch({version:'finance-harness2-request/1',action:'probe',root:experiment,host,cliPath:fakeCliPaths[host],runId:'fake-'+host,timeoutMs:30000});assert.equal(receipt.status,'probe_passed');
    const run=join(experiment,'runs','fake-'+host),plan=JSON.parse(readFileSync(join(run,'.host-'+host,'native-plan.json'),'utf8'));
    assert.deepEqual(plan.expectedMcpTools,RESEARCH_TOOLS.slice().sort());assert.equal(plan.expectedMcpTools.includes('harness_init'),false);assert.equal(plan.allowedToolNames.length,10);
    const frames=readFileSync(join(run,'native.stdout'),'utf8').trim().split('\n').map(JSON.parse),proof=frames.find(frame=>frame.type==='mcp_contract_probe');assert.deepEqual(proof.toolNames,RESEARCH_TOOLS.slice().sort());
  }
}

const longCli=join(root,'long.cjs');writeFileSync(longCli,'setInterval(()=>{},100);');
const timed=await capture(process.execPath,[longCli],{cwd:root,env:systemEnv(),timeoutMs:150});assert.equal(timed.reason,'timeout');
const controller=new AbortController();setTimeout(()=>controller.abort(),100);const cancelled=await capture(process.execPath,[longCli],{cwd:root,env:systemEnv(),timeoutMs:5000,signal:controller.signal});assert.equal(cancelled.reason,'cancelled');
const flood=join(root,'flood.cjs');writeFileSync(flood,"process.stdout.write('x'.repeat(3*1024*1024));setInterval(()=>{},100);");const limited=await capture(process.execPath,[flood],{cwd:root,env:systemEnv(),timeoutMs:5000,outputLimit:2*1024*1024});assert.equal(limited.reason,'output_limit');
const complete=join(root,'complete-large-output.cjs');writeFileSync(complete,"setTimeout(()=>process.stdout.write('x'.repeat(3*1024*1024)),80);");const uncut=await capture(process.execPath,[complete],{cwd:root,env:systemEnv()});assert.equal(uncut.reason,null);assert.equal(uncut.exitCode,0);assert.equal(uncut.stdout.length,3*1024*1024);
const {boundedSpawn:bridgeCapture}=await import('../../05-reconstruction/codex/harness2/bridge.mjs');const bridgeUncut=await bridgeCapture({command:process.execPath,args:[complete],cwd:root,env:systemEnv()},{timeoutMs:null});assert.equal(bridgeUncut.reason,null);assert.equal(bridgeUncut.exitCode,0);assert.equal(bridgeUncut.stdout.length,3*1024*1024);
const noDeadlineCancel=new AbortController();const noDeadlineTimer=setTimeout(()=>noDeadlineCancel.abort(),100);const noDeadlineCancelled=await capture(process.execPath,[longCli],{cwd:root,env:systemEnv(),signal:noDeadlineCancel.signal});clearTimeout(noDeadlineTimer);assert.equal(noDeadlineCancelled.reason,'cancelled');
if(process.platform!=='win32'){
  const {boundedSpawn}=await import('../../05-reconstruction/codex/harness2/bridge.mjs');
  const nativeRunner=fileURLToPath(new URL('../../05-reconstruction/codex/harness2/hosts/native-runner.mjs',import.meta.url));
  const running=pid=>{try{process.kill(pid,0);return readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1]?.[0]!=='Z';}catch{return false;}};
  for(const scenario of ['outer_timeout','outer_cancel','inner_timeout']){
    const pidFile=join(root,scenario+'-pids.json'),cli=join(root,scenario+'-cli.cjs'),planPath=join(root,scenario+'-plan.json');
    writeFileSync(cli,`if(process.argv.includes('--version'))console.log('0.2.1-rc.2');else{const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'inherit',detached:false});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({runner:process.ppid,native:process.pid,grandchild:child.pid}));setInterval(()=>{},100);}`);
    writeFileSync(planPath,JSON.stringify({schema:'harness2-native-plan/1',host:'dsh',expectedVersion:'0.2.1-rc.2',native:{command:process.execPath,prefix:[cli]},cwd:root,timeoutMs:scenario==='inner_timeout'?700:10000,mode:'run',runArgs:[]}));
    const cancel=new AbortController();
    const started=Date.now(),resultPromise=boundedSpawn({command:process.execPath,args:[nativeRunner,planPath],cwd:root,env:{...systemEnv(),FINANCE_HARNESS2_SUPERVISED:'1'}},{timeoutMs:scenario==='outer_timeout'?1500:5000,signal:cancel.signal});
    const deadline=Date.now()+3000;while(!existsSync(pidFile)&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,20));assert.equal(existsSync(pidFile),true,'synthetic_three_generation_startup_missing');
    if(scenario==='outer_cancel')cancel.abort();const result=await resultPromise;
    if(scenario!=='inner_timeout')assert.equal(result.reason,scenario==='outer_cancel'?'cancelled':'timeout');
    else{assert.equal(result.reason,null,'inner_timeout_waited_for_outer_timeout');assert.ok(Date.now()-started<3500,'inner_timeout_did_not_exit_promptly');assert.ok(result.stdout.includes('"status":"timeout"'));}
    const pids=JSON.parse(readFileSync(pidFile,'utf8')),exitDeadline=Date.now()+3000;while(Object.values(pids).some(running)&&Date.now()<exitDeadline)await new Promise(ok=>setTimeout(ok,20));
    assert.equal(Object.values(pids).some(running),false,'three_generation_process_survived_'+scenario);
  }
}
if(nativeArgs[0]==='--native'){
  const [flag,host,cliPath,...rest]=nativeArgs;assert.equal(flag,'--native');assert.ok(['claude-code','dsh','zcode'].includes(host));assert.equal(rest.length,0);
  const {buildHostSpec}=await import(`../../05-reconstruction/codex/harness2/hosts/${host}.mjs`),workspace=join(root,'native-'+host);mkdirSync(workspace);
  const spec=buildHostSpec({workspace,nodePath:process.execPath,cliPath,apiBase:'http://127.0.0.1:49123',databasePath:join(workspace,'synthetic.db'),mode:'check',timeoutMs:30000});
  const native=spawnSync(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,windowsHide:true,shell:false,encoding:'utf8',timeout:35000});
  writeFileSync(join(workspace,'native.stdout.jsonl'),native.stdout??'');writeFileSync(join(workspace,'native.stderr.log'),native.stderr??'');
  assert.equal(native.status,0,native.stderr);const events=native.stdout.trim().split('\n').map(JSON.parse),result=events.at(-1);assert.equal(result.status,'completed');assert.equal(result.modelInvoked,false);
  console.log(JSON.stringify({status:'native_probe_passed',host,workspace,version:events[0].version,result,scope:host==='dsh'?'native config, mounted agent/MCP/restriction, model preselection; prompt execution untested':host==='zcode'?'native app-server build session, explicit model preselection and MCP; prompt execution untested':'native MCP health check; model run untested',modelInvoked:false}));
}
if(nativeArgs[0]==='--bridge-probe'){
  const [,host,cliPath,...rest]=nativeArgs;assert.ok(['claude-code','dsh','zcode'].includes(host));assert.equal(rest.length,0);
  const {prepare,dispatch}=await import('../../05-reconstruction/codex/harness2/bridge.mjs'),experiment=join(root,'native-production-bridge');await prepare({root:experiment});
  const receipt=await dispatch({version:'finance-harness2-request/1',action:'probe',root:experiment,host,cliPath,runId:'native-'+host,timeoutMs:30000,maxOutputTokens:2048});
  const run=join(experiment,'runs','native-'+host);assert.equal(receipt.status,'probe_passed');assert.equal(receipt.nativeStatus,'completed');assert.equal(receipt.innerErrorCount,0);
  const frames=readFileSync(join(run,'native.stdout'),'utf8').trim().split('\n').map(JSON.parse),contract=frames.find(frame=>frame.type==='mcp_contract_probe');assert.deepEqual(contract.toolNames,RESEARCH_TOOLS.slice().sort());
  console.log(JSON.stringify({status:'production_bridge_native_probe_passed',host,run,mcpToolNames:contract.toolNames,receipt,modelInvoked:false}));
}
if(nativeArgs[0]==='--native-run'){
  const [,host,cliPath,...rest]=nativeArgs;assert.ok(['claude-code','dsh','zcode'].includes(host));assert.equal(rest.length,0);
  const {createBudgetGateway}=await import('../../05-reconstruction/codex/harness2/budget-gateway.mjs');
  const {killTree}=await import('../../05-reconstruction/codex/harness2/hosts/native-runner.mjs');
  const {buildHostSpec}=await import(`../../05-reconstruction/codex/harness2/hosts/${host}.mjs`);
  const workspace=join(root,'mock-native-'+host);mkdirSync(workspace);const data=join(workspace,'data');mkdirSync(data);const home=join(workspace,'backend-home');mkdirSync(home);
  const repo=join(dirname(fileURLToPath(import.meta.url)),'../..'),backend=spawn(process.execPath,[join(repo,'06-workbench/server/server.mjs')],{cwd:repo,env:{...systemEnv(),HOME:home,USERPROFILE:home,WORKBENCH_DATA_DIR:data,HOST:'127.0.0.1',PORT:'0',NODE_NO_WARNINGS:'1'},windowsHide:true,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});backend.harness2OwnGroup=process.platform!=='win32';let backendText='',backendError='',gateway;
  backend.stderr.on('data',chunk=>backendError+=chunk);
  try{
    const apiBase=await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('synthetic_backend_timeout')),15000);backend.once('error',e=>{clearTimeout(timer);no(e);});backend.once('exit',()=>{clearTimeout(timer);no(Error('synthetic_backend_failed'));});backend.stdout.on('data',chunk=>{backendText+=chunk;const match=backendText.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);ok(match[0]);}});});
    let fixtureCalls=0,toolResultObserved=false;
    const transport=async body=>{
      fixtureCalls++;assert.ok(fixtureCalls<=2,'native_requested_unexpected_model_retry');const tool=body.tools?.find(x=>x.function?.name==='mcp__finance__harness_discover');assert.ok(tool,'native_mcp_tool_not_disclosed');
      const toolResult=body.messages.findLast(message=>message.role==='tool');
      if(fixtureCalls===2){assert.ok(toolResult,'native_tool_result_missing');assert.ok(JSON.stringify(toolResult.content).includes('period.inspect'),'actual_mcp_capability_result_missing');toolResultObserved=true;}
      return {status:200,body:{id:'synthetic-chat-'+fixtureCalls,object:'chat.completion',created:1,model:'deepseek-flash',choices:[{index:0,message:fixtureCalls===1?{role:'assistant',content:null,reasoning_content:'Synthetic transport reasoning.',tool_calls:[{id:'synthetic-discover',type:'function',function:{name:'mcp__finance__harness_discover',arguments:JSON.stringify({capabilityId:'period.inspect'})}}]}:{role:'assistant',content:'MOCK_TRANSPORT_COMPLETE'},finish_reason:fixtureCalls===1?'tool_calls':'stop'}],usage:{prompt_tokens:37,completion_tokens:24,total_tokens:61}}};
    };
    gateway=createBudgetGateway({socketPath:join(workspace,'unused-test-socket'),ledgerPath:join(workspace,'mock-budget-ledger.json'),apiKey:'synthetic-no-real-api-key',maxCalls:4,maxInputBytes:262144,maxOutputTokens:2048,maxUsd:2,inputUsdPerMillion:1,outputUsdPerMillion:1,maxWallMs:90000,transport});
    const httpMetadata=[];gateway.server.on('request',(request,response)=>{const entry={path:request.url,method:request.method};httpMetadata.push(entry);const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{try{const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));Object.assign(entry,{fields:Object.keys(body),messageRoles:body.messages?.map(x=>x.role),blockTypes:body.messages?.flatMap(x=>Array.isArray(x.content)?x.content.map(b=>b.type):['string']),maxTokens:body.max_tokens,stream:body.stream});}catch{}});response.on('finish',()=>{entry.status=response.statusCode;writeFileSync(join(workspace,'mock-http-metadata.json'),JSON.stringify(httpMetadata,null,2));});});
    await new Promise((ok,no)=>{gateway.server.once('error',no);gateway.server.listen(0,'127.0.0.1',ok);});const modelBaseUrl='http://127.0.0.1:'+gateway.server.address().port;
    const candidateDir=join(workspace,'candidate');mkdirSync(candidateDir);writeFileSync(join(candidateDir,'SKILL.md'),'Use only the explicitly requested synthetic MCP capability discovery.');const taskFile=join(workspace,'task.txt');writeFileSync(taskFile,'Call mcp__finance__harness_discover with capabilityId period.inspect exactly once, then report its actual tool result. Do not execute or approve business operations.');
    const spec=buildHostSpec({workspace,nodePath:process.execPath,cliPath,apiBase,databasePath:join(data,'workbench.db'),candidateDir,taskFile,modelBaseUrl,mode:'run',timeoutMs:60000,maxOutputTokens:2048});
    const result=await capture(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,timeoutMs:65000});writeFileSync(join(workspace,'native.stdout.jsonl'),result.stdout);writeFileSync(join(workspace,'native.stderr.log'),result.stderr);
    const frames=result.stdout.trim().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}),final=frames.findLast(frame=>frame.type==='host_result');
    assert.equal(result.exitCode,0,result.stderr);assert.equal(result.reason,null);assert.equal(final?.status,'completed');assert.equal(final.innerErrorCount,0);assert.equal(fixtureCalls,2);assert.equal(toolResultObserved,true);assert.equal(gateway.ledger.calls,2);assert.equal(gateway.ledger.stopped,null);assert.ok(gateway.ledger.events.every(event=>event.status==='completed'));
    const summary={status:'native_mock_transport_passed',host,workspace,version:spec.expectedVersion,nativeStatus:final.status,innerErrorCount:final.innerErrorCount,scriptedApiCalls:fixtureCalls,realMcpTool:'harness_discover',capabilityId:'period.inspect',mockModelTransport:true,paidModelInvoked:false,syntheticUsageFixture:true};writeFileSync(join(workspace,'mock-summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
  }finally{if(gateway)await gateway.close();killTree(backend);writeFileSync(join(workspace,'backend.stderr.log'),backendError);}
}
console.log(JSON.stringify({status:'passed',root,modelInvoked:false,processTreeTests:process.platform==='win32'?'POSIX branch not run':'three-generation outer timeout/cancel and inner timeout passed',scope:'synthetic fake-CLI process contract, model-free only',checks:['explicit native path and no shell wrappers','environment credential exclusion','endpoint allowlist','fixed versions','native JSON inner-error preservation','fresh host config','timeout/cancellation/output bound']}));
