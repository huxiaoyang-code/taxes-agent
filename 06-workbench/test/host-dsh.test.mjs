import assert from 'node:assert/strict';
import { buildConfig } from '../../05-reconstruction/codex/hosts/dsh/adapter.mjs';
import {PERIOD_TASK_ROUTING} from '../../05-reconstruction/codex/hosts/shared/task-routing.mjs';
import {BUSINESS_MEMORY_ROUTING} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseArgs,buildLaunchSpec} from '../../05-reconstruction/codex/hosts/dsh/launcher.mjs';

const context = {
  repoRoot: '/synthetic/product', nodePath: '/synthetic/bin/node', serverPath: '/synthetic/product/server.mjs',
  skillsDir: '/synthetic/product/skills', apiBase: 'http://127.0.0.1:19876',
  databasePath: '/synthetic/data/book.db', outputDir: '/synthetic/generated',
  mcp: { command: '/synthetic/bin/node', args: ['/synthetic/product/server.mjs'], cwd: '/synthetic/product', env: {
    FINANCE_MCP_PROFILE: 'direct', FINANCE_API_BASE: 'http://127.0.0.1:19876',
    FINANCE_DATABASE_PATH: '/synthetic/data/book.db',
  } },
};
const original = structuredClone(context), result = buildConfig(context);
assert.deepEqual(context, original, 'adapter must not mutate the supplied connection');
assert.ok(result.files.every(f => typeof f.content === 'string' && !f.path.includes('..')));
const patches = JSON.parse(result.files.find(f => f.path === 'finance.cordis.patch.yml').content);
const mcp = patches.find(p => p.insert).insert.find(p => p.id === 'finance-direct-mcp');
assert.equal(mcp.name, '@deepseek-ai/dsh-mcp-client');
assert.equal(mcp.config.transport, 'stdio');
for (const field of ['command', 'args', 'cwd', 'env']) assert.deepEqual(mcp.config[field], context.mcp[field]);
assert.equal(mcp.config.reconnect.enabled, false);
assert.equal(patches.find(p => p.id === 'session-log-deepseek').config.enabled, false);
assert.equal(patches.find(p => p.id === 'session-telemetry-otel').disabled, true);
assert.deepEqual(patches.find(p => p.id === 'skill-filesystem').config, {
  includeDefaultRoots: false, customSkillDirs: [context.skillsDir], watch: false,
});
assert.throws(() => buildConfig({ ...context, mcp: { ...context.mcp, env: {} } }), /dsh_direct_profile_required/);
const special = structuredClone(context); special.mcp.command = 'C:\\合成 目录\\node.exe';
special.mcp.env.FINANCE_DATABASE_PATH = 'C:\\合成 目录\\book.db';
const specialRows = JSON.parse(buildConfig(special).files.find(f => f.path.endsWith('.yml')).content);
assert.equal(specialRows.find(p => p.insert).insert[0].config.command, special.mcp.command);
assert.ok(result.files.find(f=>f.path==='AGENTS.md').content.includes(PERIOD_TASK_ROUTING));
// 实际执行 Node 包装，但只有合成 CLI 接收参数，绝不运行真实 dsh 或模型。
const scratch=mkdtempSync(join(tmpdir(),'finance-dsh-wrapper-'));
const actual=buildConfig({...context,nodePath:process.execPath,repoRoot:fileURLToPath(new URL('../..',import.meta.url))});
for(const file of actual.files)writeFileSync(join(scratch,file.path),file.content,'utf8');
writeFileSync(join(scratch,'model.cordis.patch.yml'),'[]','utf8');
const cli=join(scratch,'synthetic-dsh.mjs');writeFileSync(cli,'process.stdout.write(JSON.stringify(process.argv.slice(2)));','utf8');
const task='合成单项查询 & 保留参数';
const launched=spawnSync(process.execPath,[join(scratch,'start-dsh.mjs'),'--dsh-cli',cli,'--task',task],{encoding:'utf8',windowsHide:true,timeout:15000});
assert.equal(launched.status,0,launched.stderr);const argv=JSON.parse(launched.stdout.trim());
assert.deepEqual(argv.slice(0,3),['--profile','headless','--patch']);assert.equal(argv[4],'--patch');
assert.equal(argv[3],join(scratch,'finance.cordis.patch.yml'));assert.equal(argv[5],join(scratch,'model.cordis.patch.yml'));
assert.ok(argv.at(-1).startsWith(PERIOD_TASK_ROUTING+'\n\n'+BUSINESS_MEMORY_ROUTING));assert.ok(argv.at(-1).endsWith('\n\n本次任务：\n'+task));assert.equal(argv.length,7);
for(const args of [[],['--dsh-cli','relative'],['--dsh-cli',cli],['--dsh-cli',cli,'--task','one','--task-file',cli],['--dsh-cli',cli,'--task-file','relative']])assert.throws(()=>parseArgs(args));
assert.equal(parseArgs(['--help'])['--help'],true);
const taskFile=join(scratch,'任务.txt');writeFileSync(taskFile,task,'utf8');
const spec=buildLaunchSpec(process.execPath,scratch,parseArgs(['--dsh-cli',cli,'--task-file',taskFile]));assert.equal(spec.args.at(-1),argv.at(-1));
assert.throws(()=>buildLaunchSpec(process.execPath,scratch,parseArgs(['--dsh-cli',cli,'--task',task,'--model-patch',join(scratch,'missing.yml')])) ,/dsh_launch_file_missing/);
const failedCli=join(scratch,'synthetic-failure.mjs');writeFileSync(failedCli,'process.exit(17);','utf8');
const failed=spawnSync(process.execPath,[join(scratch,'start-dsh.mjs'),'--dsh-cli',failedCli,'--task',task],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(failed.status,17,'wrapper must preserve a failed CLI exit');
console.log(JSON.stringify({ status: 'passed', modelInvoked: false, checks: [
  'native stdio configuration preserves explicit target', 'upload plugins explicitly disabled',
  'isolated skill roots', 'profile required', 'Unicode and Windows paths remain literal', 'synthetic CLI receives routing and task without shell interpolation', 'CLI failure exit preserved; real dsh not invoked',
] }));
