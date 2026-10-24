#!/usr/bin/env node
// Model-free verification against the actual installed Pi 1.1.0 loader and its
// native MCP connection implementation. No auth/config/session files are read.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const piRoot=process.argv[2]&&resolve(process.argv[2]);if(!piRoot)throw new Error('explicit_pi_package_root_required');
const pkg=JSON.parse(readFileSync(join(piRoot,'package.json'),'utf8'));assert.equal(pkg.version,'1.1.0');assert.equal(pkg.license,'MIT');
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),extension=join(repo,'05-reconstruction/codex/pi/finance-harness.ts');
mkdirSync(join(repo,'06-workbench/.agent-runs'),{recursive:true});const agentDir=mkdtempSync(join(repo,'06-workbench/.agent-runs/pi-model-free-'));process.env.PI_CODING_AGENT_DIR=agentDir;
const {loadExtensions}=await import(pathToFileURL(join(piRoot,'dist/core/extensions/loader.js')).href);
const loaded=await loadExtensions([extension],repo);assert.deepEqual(loaded.errors,[]);assert.equal(loaded.extensions.length,1);
const servers=loaded.runtime.mcpServers.list();const registered=servers.find(s=>s.name==='finance');assert.ok(registered);assert.ok(loaded.extensions[0].tools.has('finance_delegate_parser'));
const {McpServerConnection,createDefaultTransport}=await import(pathToFileURL(join(piRoot,'dist/extensions/mcp/runtime.js')).href);
const connection=new McpServerConnection({entry:{name:registered.name,config:registered.config,source:extension,scope:'extension'},cwd:repo,createTransport:createDefaultTransport,onTools:()=>{}});
try {
 await connection.getClient();assert.equal(connection.state,'connected');assert.ok(connection.tools.some(t=>t.name==='harness_discover'));
 const discovery=await connection.callTool('harness_discover',{},{});assert.equal(discovery.isError,undefined);const payload=discovery.structuredContent;assert.ok(payload.capabilities.some(c=>c.capabilityId==='offline.vat_q2'));
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
  console.log(JSON.stringify({status:'passed',piVersion:pkg.version,license:pkg.license,extensionLoaded:extension,explicitCliExtensions:extensionPaths,noExtensions:true,nativeMcpState:connection.state,toolCount:connection.tools.length,harnessTools:connection.tools.filter(t=>t.name.startsWith('harness_')).map(t=>t.name),deferredMcpLoadedThroughNativeToolSearch:true,registeredParserTool:true,modelInvoked:false,parserAgentInvoked:false,scope:'actual loader + documented native built-ins + deferred tool search + MCP only; Agent demonstration still requires authorized model run'}));
 }finally{await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();}
}finally{await connection.close();}
