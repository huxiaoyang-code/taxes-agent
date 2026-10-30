#!/usr/bin/env node
// 仅加载真实Pi扩展并检查stdio MCP，绝不调用模型或启动Agent任务。
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname,join,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
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
  console.log(JSON.stringify({status:'passed',piVersion:pkg.version,extension,toolCount:names.length,initialTools:['finance_rules','skills_read'],otherTools:'deferred',modelInvoked:false,agentTaskInvoked:false,scope:'actual Pi extension loader and MCP tools/resources only'}));
}finally{await connection.close();}
