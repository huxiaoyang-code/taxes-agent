#!/usr/bin/env node
// Model-free verification against the actual installed Pi 1.1.0 loader and its
// native MCP connection implementation. No auth/config/session files are read.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
// The real registered parser tool launches this script in replay mode. It only
// emits previously saved protocol bytes; it never creates a model runtime.
if(process.argv.includes('--mode')&&process.env.FINANCE_HARNESS_REPLAY_SOURCE){
 const source=process.env.FINANCE_HARNESS_REPLAY_SOURCE,splitAt=Number(process.env.FINANCE_HARNESS_REPLAY_SPLIT_AT);let offset=0,splitDone=false;
 const send=bytes=>new Promise((ok,no)=>process.stdout.write(bytes,error=>error?no(error):ok()));
 for await(const chunk of createReadStream(source)){
  if(!splitDone&&splitAt>offset&&splitAt<=offset+chunk.length){const at=splitAt-offset;await send(chunk.subarray(0,at));await new Promise(ok=>setTimeout(ok,15));await send(chunk.subarray(at));splitDone=true;}
  else await send(chunk);
  offset+=chunk.length;
 }
 process.exit(0);
}
const piRoot=process.argv[2]&&resolve(process.argv[2]);if(!piRoot)throw new Error('explicit_pi_package_root_required');
const pkg=JSON.parse(readFileSync(join(piRoot,'package.json'),'utf8'));assert.equal(pkg.version,'1.1.0');assert.equal(pkg.license,'MIT');
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),extension=join(repo,'05-reconstruction/codex/pi/finance-harness.ts');
mkdirSync(join(repo,'06-workbench/.agent-runs'),{recursive:true});const agentDir=mkdtempSync(join(repo,'06-workbench/.agent-runs/pi-model-free-'));process.env.PI_CODING_AGENT_DIR=agentDir;
const {loadExtensions}=await import(pathToFileURL(join(piRoot,'dist/core/extensions/loader.js')).href);
const loaded=await loadExtensions([extension],repo);assert.deepEqual(loaded.errors,[]);assert.equal(loaded.extensions.length,1);
let offlineReplay=null;
const replayFlag=process.argv.indexOf('--replay-events');
if(replayFlag>=0){
 assert.ok(process.argv[replayFlag+1],'recorded_pi_jsonl_path_required');const source=resolve(process.argv[replayFlag+1]);
 const expected=[];let lastType=null,offset=0,splitAt=null,chineseTask=null;
 for await(const line of createInterface({input:createReadStream(source),crlfDelay:Infinity})){
  const e=JSON.parse(line);lastType=e.type;
  if(e.type==='tool_execution_start'||e.type==='tool_execution_end')expected.push([e.type,e.toolName,e.toolCallId,e.isError??false]);
  if(!chineseTask&&e.type==='tool_execution_start'&&typeof e.args?.task==='string'&&/[\u3400-\u9fff]/.test(e.args.task)){
   chineseTask={toolCallId:e.toolCallId,task:e.args.task};splitAt=offset+Buffer.from(line).findIndex(byte=>byte>=0xc2)+1;
  }
  offset+=Buffer.byteLength(line)+1;
 }
 assert.ok(chineseTask&&splitAt,'recorded_stream_must_contain_a_Chinese_parser_task');const rawBytes=statSync(source).size;assert.ok(rawBytes>4*1024*1024);
 const oldSource=process.env.FINANCE_HARNESS_REPLAY_SOURCE,oldSplit=process.env.FINANCE_HARNESS_REPLAY_SPLIT_AT;
 let result;
 try{
  process.env.FINANCE_HARNESS_REPLAY_SOURCE=source;process.env.FINANCE_HARNESS_REPLAY_SPLIT_AT=String(splitAt);
  result=await loaded.extensions[0].tools.get('finance_delegate_parser').definition.execute('offline-recorded-events',{task:'Offline replay of saved pi protocol events only; no Agent/model execution.'},AbortSignal.timeout(60000),()=>{},{cwd:agentDir,model:{provider:'offline',id:'recorded-events'}});
 }finally{
  if(oldSource===undefined)delete process.env.FINANCE_HARNESS_REPLAY_SOURCE;else process.env.FINANCE_HARNESS_REPLAY_SOURCE=oldSource;
  if(oldSplit===undefined)delete process.env.FINANCE_HARNESS_REPLAY_SPLIT_AT;else process.env.FINANCE_HARNESS_REPLAY_SPLIT_AT=oldSplit;
 }
 assert.notEqual(result.isError,true,JSON.stringify(result.details));const saved=JSON.parse(readFileSync(result.details.tracePath,'utf8'));
 assert.equal(saved.stdoutBytes,rawBytes);assert.equal(saved.rawExitCode,0);assert.equal(saved.rawExitSignal,null);assert.equal(saved.killReason,null);assert.equal(saved.pendingEventBytes,0);assert.ok(saved.peakEventBytes<=saved.stdoutEventLimitBytes);assert.ok(saved.traceBytes<=saved.traceLimitBytes);
 assert.deepEqual(saved.trace.filter(e=>e.type==='tool_execution_start'||e.type==='tool_execution_end').map(e=>[e.type,e.toolName,e.toolCallId,e.isError]),expected);
 assert.equal(saved.trace.find(e=>e.type==='tool_execution_start'&&e.toolCallId===chineseTask.toolCallId).args.task,chineseTask.task);assert.equal(saved.lastCompletedEvent.type,lastType);
 offlineReplay={source,tracePath:result.details.tracePath,stdoutBytes:saved.stdoutBytes,peakEventBytes:saved.peakEventBytes,traceBytes:saved.traceBytes,toolCalls:saved.trace.filter(e=>e.type==='tool_execution_start').length,lastEvent:lastType,splitChineseUtf8Bytes:true,scope:'offline replay of saved parent pi JSON events through the actual parser tool stream path; not a reconstruction of missing child stdout or a new Agent demonstration'};
}
const servers=loaded.runtime.mcpServers.list();const registered=servers.find(s=>s.name==='finance');assert.ok(registered);assert.ok(loaded.extensions[0].tools.has('finance_delegate_parser'));
const {McpServerConnection,createDefaultTransport}=await import(pathToFileURL(join(piRoot,'dist/extensions/mcp/runtime.js')).href);
const connection=new McpServerConnection({entry:{name:registered.name,config:registered.config,source:extension,scope:'extension'},cwd:repo,createTransport:createDefaultTransport,onTools:()=>{}});
try {
 await connection.getClient();assert.equal(connection.state,'connected');assert.ok(connection.tools.some(t=>t.name==='harness_discover'));
 const discovery=await connection.callTool('harness_discover',{},{});assert.equal(discovery.isError,undefined);const payload=discovery.structuredContent;assert.deepEqual(payload.capabilities,[]);assert.ok(payload.domains.some(d=>d.domain==='offline'));const filtered=await connection.callTool('harness_discover',{domain:'offline'},{});assert.ok(filtered.structuredContent.capabilities.some(c=>c.capabilityId==='offline.vat_q2'));const selected=await connection.callTool('harness_discover',{capabilityId:'offline.vat_q2'},{});assert.equal(selected.structuredContent.contractAvailable,true);
 const skill=await connection.readResource('skill://harness/SKILL.md',{});assert.match(skill.contents[0].text,/原始资料/);
 // Reproduce the documented CLI extension selection: -ne, explicit built-in
 // mcp and tool-search, plus this extension. No silently injected defaults.
 const {DefaultResourceLoader}=await import(pathToFileURL(join(piRoot,'dist/core/resource-loader.js')).href),{builtInExtensions}=await import(pathToFileURL(join(piRoot,'dist/extensions/index.js')).href),{SettingsManager}=await import(pathToFileURL(join(piRoot,'dist/core/settings-manager.js')).href),{SessionManager}=await import(pathToFileURL(join(piRoot,'dist/core/session-manager.js')).href),{AuthStorage}=await import(pathToFileURL(join(piRoot,'dist/core/auth-storage.js')).href),{ModelRuntime}=await import(pathToFileURL(join(piRoot,'dist/core/model-runtime.js')).href),{createAgentSession}=await import(pathToFileURL(join(piRoot,'dist/core/sdk.js')).href);
 const settingsManager=SettingsManager.inMemory(),extensionPaths=['builtin:mcp','builtin:tool-search',extension];
 const loader=new DefaultResourceLoader({cwd:repo,agentDir,settingsManager,noExtensions:true,noContextFiles:true,noSkills:true,noPromptTemplates:true,additionalExtensionPaths:extensionPaths,extensionFactories:builtInExtensions});await loader.reload();
 const modelRuntime=await ModelRuntime.create({credentials:AuthStorage.inMemory(),modelsPath:null,modelsStorePath:join(agentDir,'models-cache.json'),allowModelNetwork:false,refreshOnCreate:false});
 const {session,extensionsResult}=await createAgentSession({cwd:repo,agentDir,settingsManager,resourceLoader:loader,sessionManager:SessionManager.inMemory(repo),modelRuntime});
 try {
  assert.deepEqual(extensionsResult.errors,[]);await session.bindExtensions({});
  const deadline=Date.now()+15000;while(!session.getAllTools().some(t=>t.name==='mcp__finance__harness_status')&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,50));
  assert.ok(session.getActiveToolNames().includes('tool_search'),'explicit native tool-search must be active for deferred MCP tools');
  const search=session.agent.state.tools.find(t=>t.name==='tool_search');assert.ok(search);await search.execute('model-free-search',{query:'harness_status',limit:3},AbortSignal.timeout(15000));
  assert.ok(session.getActiveToolNames().includes('mcp__finance__harness_status'),'deferred tool must be reachable through actual tool-search');
  const discover=session.agent.state.tools.find(t=>t.name==='mcp__finance__harness_discover');assert.ok(discover);const nativeResult=await discover.execute('model-free-discover',{},AbortSignal.timeout(15000));assert.ok(nativeResult.content.some(c=>c.type==='text'&&c.text.includes('capabilities')));
  console.log(JSON.stringify({status:'passed',piVersion:pkg.version,license:pkg.license,extensionLoaded:extension,explicitCliExtensions:extensionPaths,noExtensions:true,nativeMcpState:connection.state,toolCount:connection.tools.length,harnessTools:connection.tools.filter(t=>t.name.startsWith('harness_')).map(t=>t.name),deferredMcpLoadedThroughNativeToolSearch:true,registeredParserTool:true,modelInvoked:false,parserAgentInvoked:false,offlineReplay,scope:'actual loader + documented native built-ins + deferred tool search + MCP; optional protocol replay is model-free and does not replace an authorized Agent demonstration'}));
 }finally{await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();}
}finally{await connection.close();}
