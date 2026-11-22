// 原生CLI参数边界回归；使用最小合成身份库与真实Node子进程，不启动Claude或模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createContext,writeBundle} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import {loadBoundBusinessSession,prepareBoundBusinessSession} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {buildConfig} from '../../05-reconstruction/codex/hosts/claude-code/adapter.mjs';
import {parseClaudeArgs,buildClaudeLaunchSpec} from '../../05-reconstruction/codex/hosts/claude-code/launcher.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {resolveDirectFinanceTarget} from '../server/direct-finance-target.mjs';

const root=mkdtempSync(join(tmpdir(),'claude-argv-合成 ')),dbPath=join(root,'identity.db'),cli=join(root,'synthetic-claude.mjs');
const databaseInstanceId='a1111111-1111-4111-8111-111111111111';
const db=new DatabaseSync(dbPath);
try{
 db.exec('CREATE TABLE audit_database_instances(instance_id TEXT,is_active INTEGER);CREATE TABLE account_sets(id INTEGER);CREATE TABLE import_enterprise_account_sets(account_set_id INTEGER,enterprise_key TEXT)');
 db.prepare('INSERT INTO audit_database_instances VALUES(?,1)').run(databaseInstanceId);
 db.prepare('INSERT INTO account_sets VALUES(1)').run();
 db.prepare('INSERT INTO import_enterprise_account_sets VALUES(1,?)').run('SYNTHETIC-ARGV-ENTERPRISE');
}finally{db.close();}
// 子进程只返回实际收到的argv，避免用拼接字符串或shell模拟CLI传参。
writeFileSync(cli,'console.log(JSON.stringify({argv:process.argv.slice(2),autoMemoryDisabled:process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY!==undefined,memoryPathOverridden:process.env.CLAUDE_CODE_AUTO_MEMORY_PATH!==undefined,cwd:process.cwd()}));');
const config=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:dbPath,outputDir:join(root,'workspace')});
writeBundle(config,buildConfig(config));
const {scope}=resolveDirectFinanceTarget({accountSetId:1,period:'2026-02'},dbPath);
writeFileSync(join(config.outputDir,'.finance/business-session.json'),JSON.stringify({version:'finance-business-session/1',host:'claude-code',workspace:config.outputDir,databasePath:dbPath,scope,sourceRoot:null,auditDir:config.auditDir}));
const tools='mcp__finance__finance_company_context,mcp__finance__finance_method_read';
const prompt='合成企业：读取摘要并保留未核项。\n特殊字符保持原样 & $() ` " \\';
const parse=extra=>parseClaudeArgs(['--claude-cli',cli,'--',...extra]);
const spec=extra=>buildClaudeLaunchSpec(config.outputDir,parse(extra));
function delivered(launch){
 const result=spawnSync(launch.command,launch.args,{cwd:launch.cwd,env:launch.env,encoding:'utf8',windowsHide:true,shell:false,timeout:15000});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}

test('提示词放在variadic allowedTools之后，实际argv仍以选项终止符分隔',()=>{
 const options=parse(['--print','--allowedTools',tools,prompt]);
 assert.equal(options.prompt,prompt);assert.deepEqual(options.extra,['--print','--allowedTools',tools]);
 const inherited=Object.fromEntries(['CLAUDE_CODE_DISABLE_AUTO_MEMORY','CLAUDE_CODE_AUTO_MEMORY_PATH'].map(key=>[key,process.env[key]]));
 process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY='1';
 process.env.CLAUDE_CODE_AUTO_MEMORY_PATH=join(root,'wrong-memory');
 let launch;
 try{launch=spec(['--print','--allowedTools',tools,prompt]);}finally{
  for(const [key,value] of Object.entries(inherited))if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
 const received=delivered(launch);
 assert.deepEqual(received.argv.slice(-5),['--print','--allowedTools',tools,'--',prompt]);
 assert.equal(received.argv.filter(value=>value===prompt).length,1);
 assert.equal(received.autoMemoryDisabled,false);assert.equal(received.memoryPathOverridden,false);assert.equal(received.cwd,config.outputDir);
 assert.equal(received.argv[received.argv.indexOf('--mcp-config')+1],join(config.outputDir,'.mcp.json'));
 const memoryDirectory=join(root,'.finance-memory','identity.db',databaseInstanceId,'1');
 const {permissions,...memory}=JSON.parse(received.argv[received.argv.indexOf('--settings')+1]);
 assert.deepEqual(memory,{autoMemoryEnabled:true,autoMemoryDirectory:memoryDirectory});
 assert.ok(['finance_query','account_list'].every(name=>permissions.allow.includes('mcp__finance__'+name)));
 assert.ok(permissions.allow.includes('Edit(/outputs/*.csv)'));
 assert.ok(permissions.allow.includes('Edit(/outputs/*.md)'));
 assert.ok(!permissions.allow.includes('mcp__finance__voucher_correct'));
 assert.equal(launch.env.FINANCE_REQUIRE_BOUND_READS,'1');
 assert.equal(launch.memoryPath,join(memoryDirectory,'MEMORY.md'));
 assert.equal(received.argv[received.argv.indexOf('--setting-sources')+1],'project');
});

test('已核启动后绑定丢失时账套查询拒绝，随包技能仍可从 MCP 读取',async()=>{
 const launch=spec(['--print',prompt]);
 const client=new McpStdioClient(config.serverPath,{env:{
  ...launch.env,FINANCE_BUSINESS_SESSION:join(root,'missing-session.json'),FINANCE_AUDIT_DIR:join(root,'lost-binding-audit')
 }}).start();
 try{
  await client.initialize();
  for(const [name,args] of [['account_list',{accountSetId:1}],['finance_query',{accountSetId:1,nodeId:'ledger.general',period:'2026-02',params:{code:'1002'}}]]){
   const result=await client.call(name,args);assert.equal(result.isError,true);
   assert.match(result.text,/finance_memory_session_required/);
  }
  assert.equal((await client.call('skills_read',{resource:'reconciliation/SKILL.md'})).isError,false);
 }finally{await client.close();}
});

test('旧会话配置可按原权限及 MCP 技能目录接续',async()=>{
 const old=createContext({nodePath:process.execPath,apiBase:config.apiBase,databasePath:dbPath,outputDir:join(root,'old-workspace')});
 delete old.mcpEnv.FINANCE_SKILL_DISCOVERY;
 const bundle=buildConfig(old);
 bundle.files=bundle.files.filter(file=>!file.path.startsWith('.claude/skills/') && file.path!=='.finance/skill-source.json');
 writeBundle(old,bundle);
 await prepareBoundBusinessSession(old.outputDir,{accountSetId:1,period:'2026-02'});
 const launch=buildClaudeLaunchSpec(old.outputDir,parse(['--print',prompt]));
 assert.equal(JSON.parse(launch.args[launch.args.indexOf('--settings')+1]).permissions,undefined);
 const client=new McpStdioClient(old.serverPath,{env:{...launch.env,FINANCE_SKILL_DISCOVERY:undefined}}).start();
 try{
  await client.initialize();
  const listing=await client.call('skills_list',{});assert.equal(listing.isError,false);
  assert.ok(listing.data.files.includes('close-management/SKILL.md'));
  const oldMethod=await client.call('skills_read',{resource:'close-management/SKILL.md'});
  assert.equal(oldMethod.data.resolvedResource,'tax-period/references/close-management.md');
 }finally{await client.close();}
});

test('同目录下直接复制的账库保留实例标识，但记忆路径彼此隔离',async()=>{
 const databasePath=join(root,'identity-copy.db');copyFileSync(dbPath,databasePath);
 const copy=createContext({nodePath:process.execPath,apiBase:config.apiBase,databasePath,outputDir:join(root,'workspace-copy')});
 writeBundle(copy,buildConfig(copy));
 const original=loadBoundBusinessSession(config.outputDir);
 const duplicate=await prepareBoundBusinessSession(copy.outputDir,original.target);
 assert.equal(duplicate.session.scope.databaseInstanceId,original.session.scope.databaseInstanceId);
 assert.equal(duplicate.memoryPath,join(root,'.finance-memory','identity-copy.db',databaseInstanceId,'1','MEMORY.md'));
 assert.notEqual(duplicate.memoryPath,original.memoryPath);
});

test('提示词早于工具选项也统一移到选项结束之后',()=>{
 const received=delivered(spec(['--print',prompt,'--allowedTools',tools]));
 assert.deepEqual(received.argv.slice(-5),['--print','--allowedTools',tools,'--',prompt]);
});

test('多个工具选项与空工具列表不吞掉Unicode提示词',()=>{
 const received=delivered(spec(['--print','--tools','','--disallowedTools','Bash,Write','--allowedTools',tools,prompt]));
 assert.deepEqual(received.argv.slice(-9),['--print','--tools','','--disallowedTools','Bash,Write','--allowedTools',tools,'--',prompt]);
});

test('明确的原生终止符允许前导短横线文本，不能把文本当配置覆盖',()=>{
 const literal='--settings 只是提示词，不是启动选项';
 const received=delivered(spec(['--print','--allowedTools',tools,'--',literal]));
 assert.deepEqual(received.argv.slice(-2),['--',literal]);
 assert.equal(received.argv.filter(value=>value==='--settings').length,1);
});

test('仍拒绝配置覆盖、缺少选项值、多个提示词及check中启动任务',()=>{
 for(const name of ['--settings','--setting-sources','--mcp-config','--strict-mcp-config','--cwd','--resume','--continue','--session-id','--dangerously-skip-permissions','--plugin-dir']){
  assert.throws(()=>parse([name,'other']),/claude_launch_override_rejected/);
  assert.throws(()=>parse(['--allowedTools',name]),/claude_launch_override_rejected/);
  assert.throws(()=>parse(['--allowedTools',name+'=other']),/claude_launch_override_rejected/);
 }
 assert.throws(()=>parse(['--allowedTools']),/claude_launch_arguments_invalid/);
 assert.throws(()=>parse(['--print','one','two']),/claude_launch_arguments_invalid/);
 assert.throws(()=>parseClaudeArgs(['--claude-cli',cli,'--check','--',prompt]),/claude_check_cannot_run_task/);
});

test('init-only和无提示词stdin模式不添加空的positional参数',()=>{
 for(const extra of [['--init-only'],['--print','--allowedTools',tools]]){
  const options=parse(extra);assert.equal(options.prompt,undefined);
  const received=delivered(buildClaudeLaunchSpec(config.outputDir,options));
  assert.deepEqual(received.argv.slice(-extra.length),extra);assert.equal(received.argv.includes('--'),false);
 }
});
