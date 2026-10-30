import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createContext,writeBundle,repoRoot} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../05-reconstruction/codex/hosts/claude-code/adapter.mjs';
import {toolsForProfile} from '../../05-reconstruction/codex/mcp/finance-mcp/tool-profile.mjs';
import {TOOLS} from '../../05-reconstruction/codex/mcp/finance-mcp/tools.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {parseArgs as parsePiArgs,buildLaunchSpec,MAIN_TOOLS} from '../../05-reconstruction/codex/hosts/pi/launcher.mjs';
const root=mkdtempSync(join(tmpdir(),'finance-hosts-')),options={nodePath:process.execPath,apiBase:'http://127.0.0.1:8787',databasePath:join(root,'synthetic.db'),outputDir:join(root,'claude')};
const c=createContext(options);assert.equal(c.repoRoot,repoRoot);assert.equal(c.mcp.env.FINANCE_MCP_PROFILE,'direct');
assert.deepEqual(toolsForProfile(undefined),toolsForProfile('direct'));assert.deepEqual(toolsForProfile('legacy'),TOOLS);assert.throws(()=>toolsForProfile(''),/finance_mcp_profile_invalid/);assert.throws(()=>toolsForProfile('all'),/finance_mcp_profile_invalid/);
for(const change of [{nodePath:'node'},{databasePath:'relative.db'},{outputDir:root},{apiBase:'https://example.com'},{apiBase:'http://127.0.0.1:8787/private'},{apiBase:'http://user:pass@localhost:8787'},{pluginRoot:root},{auditDir:'relative'}])assert.throws(()=>createContext({...options,...change}));
assert.throws(()=>writeBundle(c,{files:[{path:'../escape',content:'x'}]}),/host_file_invalid/);assert.equal(existsSync(c.outputDir),false);
const bundle=buildConfig(c);writeBundle(c,bundle);const config=JSON.parse(readFileSync(join(c.outputDir,'.mcp.json'),'utf8'));assert.deepEqual(config.mcpServers.finance,{command:c.nodePath,args:[c.serverPath],env:c.mcpEnv});
assert.throws(()=>writeBundle(c,bundle),/EEXIST/);assert.equal(existsSync(join(root,'escape')),false);
const permissions=JSON.parse(readFileSync(join(c.outputDir,'.claude/settings.json'),'utf8')).permissions;
assert.ok(!permissions.allow.includes('mcp__finance__*'));assert.equal([...permissions.allow,...permissions.ask].some(x=>x.startsWith('mcp__finance__harness_')),false);
assert.deepEqual(new Set([...permissions.allow,...permissions.ask]),new Set(toolsForProfile('direct').map(t=>'mcp__finance__'+t.name)));
for(const tool of toolsForProfile('direct').filter(t=>t.annotations?.readOnlyHint!==true))assert.ok(permissions.ask.includes('mcp__finance__'+tool.name));
assert.equal(bundle.files.some(f=>f.path.startsWith('.claude/agents/')),false);
const plugin=join(root,'synthetic-plugin');mkdirSync(join(plugin,'.claude-plugin'),{recursive:true});mkdirSync(join(plugin,'skills'));writeFileSync(join(plugin,'.claude-plugin/plugin.json'),JSON.stringify({name:'synthetic-cn'}));
const pluginContext=createContext({...options,outputDir:join(root,'plugin-host'),pluginRoot:plugin,auditDir:join(root,'explicit-local-records')});
assert.equal(pluginContext.skillsDir,join(plugin,'skills'));assert.equal(pluginContext.mcpEnv.FINANCE_AUDIT_DIR,join(root,'explicit-local-records'));assert.equal(existsSync(pluginContext.auditDir),false);
for(const host of ['pi','dsh','zcode']){
  const {buildConfig:build}=await import(`../../05-reconstruction/codex/hosts/${host}/adapter.mjs`);
  const context=createContext({...options,outputDir:join(root,host)}),output=writeBundle(context,build(context));assert.ok(output.files.length>0);
  const native=JSON.parse(readFileSync(join(context.outputDir,host==='pi'?'pi-host.json':host==='dsh'?'finance.cordis.patch.yml':'.zcode/config.json'),'utf8'));
  assert.ok(JSON.stringify(native).includes('FINANCE_MCP_PROFILE'));assert.ok(JSON.stringify(native).includes('direct'));
  const instructions=readFileSync(join(context.outputDir,'AGENTS.md'),'utf8');assert.ok(instructions.includes('账本金额→凭证/计算结果→规则依据→工具调用→输入与原件'));
  if(host==='pi'){
    assert.equal(native.model,'deepseek-flash');assert.equal(native.provider,'deepseek');assert.equal(native.extensionPath,join(repoRoot,'05-reconstruction/codex/pi/finance-direct.ts'));
    assert.ok(MAIN_TOOLS.includes('tool_search'));assert.ok(!MAIN_TOOLS.some(tool=>tool.includes('harness_')));assert.ok(!MAIN_TOOLS.includes('finance_delegate_parser'));
    const launcher=join(context.outputDir,'start-pi.mjs');
    const help=spawnSync(process.execPath,[launcher,'--help'],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/--pi-root/);
    const missing=spawnSync(process.execPath,[launcher,'--check'],{encoding:'utf8',windowsHide:true,timeout:15000});assert.notEqual(missing.status,0);assert.match(missing.stderr,/explicit_pi_package_root_required/);
    assert.throws(()=>buildLaunchSpec(native,context.outputDir,parsePiArgs(['--pi-root',join(root,'not-installed'),'--check'])),/ENOENT/);
    const packageRoot=join(root,'synthetic-pi-package');mkdirSync(join(packageRoot,'dist/bundle'),{recursive:true});writeFileSync(join(packageRoot,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.1.0'}));writeFileSync(join(packageRoot,'dist/bundle/cli.js'),'throw Error("must not run synthetic CLI");');
    const spec=buildLaunchSpec(native,context.outputDir,parsePiArgs(['--pi-root',packageRoot]));assert.equal(spec.env.FINANCE_MCP_PROFILE,'direct');assert.equal(spec.env.FINANCE_DATABASE_PATH,context.databasePath);assert.equal(spec.cwd,context.outputDir);assert.ok(spec.args.includes('builtin:mcp'));assert.ok(spec.args.includes('builtin:tool-search'));assert.ok(spec.args.includes(native.extensionPath));assert.equal(spec.args[spec.args.indexOf('--model')+1],'deepseek-flash');assert.equal(spec.args[spec.args.indexOf('--skill')+1],context.skillsDir);assert.ok(!spec.args.includes('--print'));
    const check=buildLaunchSpec(native,context.outputDir,parsePiArgs(['--pi-root',packageRoot,'--check']));assert.ok(check.args[0].endsWith('direct-pi-probe.mjs'));assert.equal(check.modelInvoked,false);assert.equal(existsSync(check.env.PI_CODING_AGENT_DIR),false);
  }
}
for(const args of [[],['--pi-root','relative'],['--pi-root',root,'--check','--json'],['--pi-root',root,'--tools','read'],['--pi-root',root,'--task-file','relative.txt'],['--pi-root',root,'--task-file',join(root,'goal.txt'),'--tools','mcp__other__write'],['--pi-root',root,'--task-file',join(root,'goal.txt'),'--tools','mcp__finance__harness_run'],['--pi-root',root,'--bypass']])assert.throws(()=>parsePiArgs(args));
assert.equal(parsePiArgs(['--help'])['--help'],true);
const server=join(repoRoot,'05-reconstruction/codex/mcp/finance-mcp/server.mjs');
for(const profile of [undefined,'direct','harness','legacy']){
  const client=new McpStdioClient(server,{env:{FINANCE_MCP_PROFILE:profile,FINANCE_AUDIT_DIR:join(root,'records-'+(profile??'default')),NODE_NO_WARNINGS:'1'},timeoutMs:30000}).start();
  try{
    await client.initialize();const names=(await client.rpc('tools/list')).result.tools.map(t=>t.name);assert.deepEqual(new Set(names),new Set(toolsForProfile(profile).map(t=>t.name)));
    assert.equal((await client.call('synthetic_unknown_tool')).isError,true);
    const legacy=profile==='harness'||profile==='legacy';assert.equal((await client.call('harness_discover')).isError,!legacy);
    assert.equal((await client.call('finance_rules',{})).isError,profile==='harness');
    assert.equal((await client.call('skills_list',{})).isError,false);assert.ok((await client.rpc('resources/list')).result.resources.length>0);
    if(!legacy)assert.equal(names.some(name=>name.startsWith('harness_')),false);
  }finally{await client.close();}
}
const invalid=spawnSync(process.execPath,[server],{env:{...process.env,FINANCE_MCP_PROFILE:'bad'},encoding:'utf8',timeout:30000,windowsHide:true});assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/finance_mcp_profile_invalid/);
console.log(JSON.stringify({status:'passed',root,modelInvoked:false,checks:['four direct host configurations','native lazy MCP tools and no workflow orchestration','plugin-root and local audit directory','Claude read-only permissions','explicit legacy profiles','real stdio business rules and errors','no ledger created']}));
