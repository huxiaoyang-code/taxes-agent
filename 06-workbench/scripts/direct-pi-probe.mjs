#!/usr/bin/env node
// 仅加载真实Pi扩展并检查stdio MCP，绝不调用模型或启动Agent任务。
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname,join,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {DEFAULT_TOOL_MODIFIERS,MAIN_TOOLS} from '../../05-reconstruction/codex/hosts/pi/launcher.mjs';
const piRoot=process.argv[2];if(!piRoot||!isAbsolute(piRoot))throw Error('explicit_pi_package_root_required');
const pkg=JSON.parse(readFileSync(join(piRoot,'package.json'),'utf8'));assert.equal(pkg.name,'@earendil-works/pi-coding-agent');assert.equal(pkg.version,'1.1.0');
const at=process.argv.indexOf('--agent-dir'),agentDir=process.argv[at+1];if(at<0||!agentDir||!isAbsolute(agentDir))throw Error('explicit_new_probe_agent_dir_required');
mkdirSync(agentDir);process.env.PI_CODING_AGENT_DIR=agentDir;
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),extension=join(repo,'05-reconstruction/codex/pi/finance-direct.ts');
const {loadExtensions}=await import(pathToFileURL(join(piRoot,'dist/core/extensions/loader.js')).href);
const loaded=await loadExtensions([extension],repo);assert.deepEqual(loaded.errors,[]);
const registered=loaded.runtime.mcpServers.list().find(server=>server.name==='finance');assert.ok(registered);
assert.equal(registered.config.toolExposure.finance_rules,'direct');assert.equal(registered.config.toolExposure['*'],'deferred');
const {McpServerConnection,createDefaultTransport}=await import(pathToFileURL(join(piRoot,'dist/extensions/mcp/runtime.js')).href);
const connection=new McpServerConnection({entry:{name:'finance',config:registered.config,source:extension,scope:'extension'},cwd:repo,createTransport:createDefaultTransport,onTools:()=>{}});
try{
  await connection.getClient();assert.equal(connection.state,'connected');
  const names=connection.tools.map(tool=>tool.name);assert.ok(names.includes('finance_workpaper'));assert.ok(names.includes('finance_rules'));assert.equal(names.some(name=>name.startsWith('harness_')),false);
  const resources=await connection.callTool('skills_list',{},{});assert.notEqual(resources.isError,true);
  const sdk=await import(pathToFileURL(join(piRoot,'dist/index.js')).href),{builtInExtensions}=await import(pathToFileURL(join(piRoot,'dist/extensions/index.js')).href);
  const {parseArgs}=await import(pathToFileURL(join(piRoot,'dist/cli/args.js')).href);
  const parsed=parseArgs(['--tools',DEFAULT_TOOL_MODIFIERS.join(',')]);assert.deepEqual(parsed.tools,DEFAULT_TOOL_MODIFIERS);
  const settings=sdk.SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false},defaultProjectTrust:'never'});
  const loader=new sdk.DefaultResourceLoader({cwd:repo,agentDir,settingsManager:settings,noExtensions:true,noContextFiles:true,noSkills:true,noPromptTemplates:true,
    additionalExtensionPaths:['builtin:mcp','builtin:tool-search',extension],extensionFactories:builtInExtensions});await loader.reload();
  const runtime=await sdk.ModelRuntime.create({authPath:join(agentDir,'empty-probe-auth.json'),modelsPath:null,modelsStorePath:join(agentDir,'probe-models-cache.json'),allowModelNetwork:false,refreshOnCreate:false});
  const created=await sdk.createAgentSession({cwd:repo,agentDir,settingsManager:settings,sessionManager:sdk.SessionManager.inMemory(repo),resourceLoader:loader,modelRuntime:runtime,tools:parsed.tools});
  const session=created.session;
  try{
    assert.deepEqual(created.extensionsResult.errors,[]);await session.bindExtensions({});
    const deadline=Date.now()+15000;while(!session.getAllTools().some(tool=>tool.name==='mcp__finance__finance_workpaper')&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,25));
    assert.ok(session.getAllTools().some(tool=>tool.name==='mcp__finance__finance_workpaper'),'CLI tools option must not suppress deferred MCP registration');
    const initial=session.getActiveToolNames();assert.equal(initial.includes('mcp__finance__finance_workpaper'),false);assert.ok(initial.includes('tool_search'));assert.ok(initial.every(name=>MAIN_TOOLS.includes(name)),'only the configured initial tool set may be exposed');
    const require=createRequire(join(piRoot,'package.json')),corePackage=require.resolve('@earendil-works/pi-agent-core/package.json'),{runToolCall}=await import(pathToFileURL(join(dirname(corePackage),'dist/index.js')).href);
    const toolCall={type:'toolCall',id:'native-cli-probe-search',name:'tool_search',arguments:{query:'finance_workpaper',limit:3}};
    const assistantMessage={role:'assistant',content:[toolCall],api:'openai-completions',provider:'synthetic-no-model',model:'synthetic-no-model',stopReason:'toolUse',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const outcome=await runToolCall(toolCall,{tools:session.agent.state.tools,assistantMessage,context:{messages:session.agent.state.messages,tools:session.agent.state.tools},beforeToolCall:session.agent.beforeToolCall,afterToolCall:session.agent.afterToolCall,signal:AbortSignal.timeout(15000)});
    assert.equal(outcome.isError,false);assert.ok(session.getActiveToolNames().includes('mcp__finance__finance_workpaper'),'real native tool_search must activate the deferred business tool');
    console.log(JSON.stringify({status:'passed',piVersion:pkg.version,extension,toolCount:names.length,cliTools:parsed.tools,initialActiveTools:initial,deferredRegisteredBeforeSearch:true,deferredActivatedAfterSearch:true,modelInvoked:false,agentTaskInvoked:false,scope:'actual CLI tools parsing → SDK session registration → native MCP → runToolCall tool_search; no model or business calculation'}));
  }finally{await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();}
}finally{await connection.close();}
