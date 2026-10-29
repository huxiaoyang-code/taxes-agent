import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createContext,writeBundle,repoRoot} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../05-reconstruction/codex/hosts/claude-code/adapter.mjs';
import {toolsForProfile} from '../../05-reconstruction/codex/mcp/finance-mcp/tool-profile.mjs';
import {TOOLS} from '../../05-reconstruction/codex/mcp/finance-mcp/tools.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';

const root=mkdtempSync(join(tmpdir(),'finance-hosts-')),options={nodePath:process.execPath,apiBase:'http://127.0.0.1:8787',databasePath:join(root,'synthetic.db'),outputDir:join(root,'claude')};
const c=createContext(options);assert.equal(c.repoRoot,repoRoot);assert.equal(c.mcp.env.FINANCE_MCP_PROFILE,'harness');
assert.deepEqual(toolsForProfile(undefined),TOOLS);assert.throws(()=>toolsForProfile(''),/finance_mcp_profile_invalid/);assert.throws(()=>toolsForProfile('all'),/finance_mcp_profile_invalid/);
for(const change of [{nodePath:'node'},{databasePath:'relative.db'},{outputDir:root},{apiBase:'https://example.com'},{apiBase:'http://127.0.0.1:8787/private'},{apiBase:'http://user:pass@localhost:8787'}])assert.throws(()=>createContext({...options,...change}));
assert.throws(()=>writeBundle(c,{files:[{path:'../escape',content:'x'}]}),/host_file_invalid/);assert.equal(existsSync(c.outputDir),false);
const bundle=buildConfig(c);writeBundle(c,bundle);const config=JSON.parse(readFileSync(join(c.outputDir,'.mcp.json'),'utf8'));assert.deepEqual(config.mcpServers.finance,{command:c.nodePath,args:[c.serverPath],env:c.mcpEnv});
assert.throws(()=>writeBundle(c,bundle),/EEXIST/);assert.equal(existsSync(join(root,'escape')),false);
const permissions=JSON.parse(readFileSync(join(c.outputDir,'.claude/settings.json'),'utf8')).permissions;assert.ok(!permissions.allow.some(x=>x==='mcp__finance__*'||x==='mcp__finance__harness_run'));assert.ok(permissions.ask.includes('mcp__finance__harness_run'));
assert.deepEqual(new Set([...permissions.allow,...permissions.ask]),new Set(toolsForProfile('harness').map(t=>'mcp__finance__'+t.name)));
for(const tool of toolsForProfile('harness').filter(t=>t.annotations?.readOnlyHint===false))assert.ok(permissions.ask.includes('mcp__finance__'+tool.name));
assert.match(readFileSync(join(c.outputDir,'.claude/agents/finance-parser.md'),'utf8'),/disallowedTools: Agent, mcp__\*/);
for(const host of ['dsh','zcode']){
  const {buildConfig:build}=await import(`../../05-reconstruction/codex/hosts/${host}/adapter.mjs`);
  const context=createContext({...options,outputDir:join(root,host)}),output=writeBundle(context,build(context));assert.ok(output.files.length>0);
  const native=JSON.parse(readFileSync(join(context.outputDir,host==='dsh'?'finance.cordis.patch.yml':'.zcode/config.json'),'utf8'));
  assert.ok(JSON.stringify(native).includes('FINANCE_MCP_PROFILE'));assert.ok(JSON.stringify(native).includes('harness'));
}

const server=join(repoRoot,'05-reconstruction/codex/mcp/finance-mcp/server.mjs');
for(const profile of [undefined,'harness']){
  const client=new McpStdioClient(server,{env:{FINANCE_MCP_PROFILE:profile,NODE_NO_WARNINGS:'1'},timeoutMs:30000}).start();
  try{
    await client.initialize();const names=(await client.rpc('tools/list')).result.tools.map(t=>t.name);
    assert.deepEqual(new Set(names),new Set(toolsForProfile(profile).map(t=>t.name)));
    assert.equal(names.includes('account_set_create'),profile===undefined);
    assert.equal((await client.call('synthetic_unknown_tool')).data.error,'unknown_tool');
    if(profile){const denied=await client.call('account_set_create',{name:'SYN-NEVER-CREATE'});assert.equal(denied.isError,true);assert.equal(denied.data.error,'tool_not_available');}
    assert.equal((await client.call('harness_discover')).isError,false);assert.equal((await client.call('skills_read',{resource:'harness/SKILL.md'})).isError,false);
    assert.ok((await client.rpc('resources/list')).result.resources.some(r=>r.uri==='skill://harness/SKILL.md'));
  }finally{await client.close();}
}
const invalid=spawnSync(process.execPath,[server],{env:{...process.env,FINANCE_MCP_PROFILE:'bad'},encoding:'utf8',timeout:30000,windowsHide:true});assert.notEqual(invalid.status,0);assert.equal(invalid.stdout,'');assert.match(invalid.stderr,/finance_mcp_profile_invalid/);
console.log(JSON.stringify({status:'passed',root,modelInvoked:false,checks:['explicit paths and loopback','fresh output/no traversal/no overwrite','Claude query-only autoallow and parser scope','default tool list compatibility','profile list and guessed-call refusal','real stdio discovery/Skill/resources','unknown profile startup refuses']}));
