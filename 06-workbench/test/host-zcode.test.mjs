import assert from 'node:assert/strict';
import {mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildConfig} from '../../05-reconstruction/codex/hosts/zcode/adapter.mjs';
import {toolsForProfile} from '../../05-reconstruction/codex/mcp/finance-mcp/tool-profile.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),outputDir=mkdtempSync(join(tmpdir(),'finance-zcode-synthetic-'));
const serverPath=join(repoRoot,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),databasePath=join(outputDir,'synthetic-unopened.db'),skillsDir=join(repoRoot,'05-reconstruction/codex/skills');
const mcpEnv={FINANCE_MCP_PROFILE:'direct',FINANCE_API_BASE:'http://127.0.0.1:49999',FINANCE_DATABASE_PATH:databasePath,FINANCE_SKILLS_DIR:skillsDir,FINANCE_AUDIT_DIR:join(outputDir,'records')};
const context={repoRoot,nodePath:process.execPath,serverPath,skillsDir,apiBase:mcpEnv.FINANCE_API_BASE,databasePath,outputDir,auditDir:mcpEnv.FINANCE_AUDIT_DIR,mcpEnv,mcp:{command:process.execPath,args:[serverPath],env:mcpEnv,cwd:repoRoot}};
const before=JSON.stringify(context),bundle=buildConfig(context);assert.equal(JSON.stringify(context),before);
const file=path=>bundle.files.find(f=>f.path===path)?.content,config=JSON.parse(file('.zcode/config.json'));
assert.deepEqual(config.mcp.servers.finance,{type:'stdio',...context.mcp,enabled:true,timeoutMs:180000});assert.equal(config.permission.mode,'build');assert.deepEqual(config.skills.roots,[skillsDir]);assert.equal(config.model,undefined);
assert.equal(bundle.files.some(f=>f.path.includes('/agents/')),false);assert.match(file('AGENTS.md'),/账本金额→凭证\/计算结果→规则依据→工具调用→输入与原件/);
const native=config.mcp.servers.finance,client=new McpStdioClient(native.args[0],{cwd:native.cwd,env:{...native.env,NODE_NO_WARNINGS:'1'},timeoutMs:30000}).start();
try{
  await client.initialize('zcode-config-protocol-probe');const listed=(await client.rpc('tools/list')).result.tools;
  assert.deepEqual(listed.map(t=>t.name).sort(),toolsForProfile('direct').map(t=>t.name).sort());assert.equal(listed.some(t=>t.name.startsWith('harness_')),false);
  assert.equal((await client.call('harness_init',{})).isError,true);
  const rules=await client.call('finance_rules',{});assert.equal(rules.isError,false,rules.text);
  assert.equal((await client.call('skills_list',{})).isError,false);
  const rejected=await client.call('finance_workpaper',{unexpected:true});assert.equal(rejected.isError,true);
  assert.equal(existsSync(databasePath),false,'protocol inspection unexpectedly opened a ledger');
  console.log(JSON.stringify({status:'passed',modelInvoked:false,zcodeProcessInvoked:false,tools:listed.length,checks:['native direct configuration','no model or role installation','real rules and schema rejection','no Harness tool exposure','no ledger creation']}));
}finally{await client.close();}
