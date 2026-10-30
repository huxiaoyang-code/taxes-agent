import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, dirname, basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildConfig} from '../../05-reconstruction/codex/hosts/zcode/adapter.mjs';
import {HARNESS_TOOL_NAMES} from '../../05-reconstruction/codex/mcp/finance-mcp/tools.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const testTempRoot = resolve(tmpdir());
const outputDir = mkdtempSync(join(testTempRoot, 'finance-zcode-synthetic-'));
const serverPath = join(repoRoot, '05-reconstruction/codex/mcp/finance-mcp/server.mjs');
const databasePath = join(outputDir, 'synthetic-unopened.db');
const skillsDir = join(repoRoot, '05-reconstruction/codex/skills');
const mcpEnv = {FINANCE_MCP_PROFILE: 'harness', FINANCE_API_BASE: 'http://127.0.0.1:49999', FINANCE_DATABASE_PATH: databasePath, FINANCE_SKILLS_DIR: skillsDir};
const context = {repoRoot, nodePath: process.execPath, serverPath, skillsDir, apiBase: mcpEnv.FINANCE_API_BASE, databasePath, outputDir, mcpEnv, mcp: {command: process.execPath, args: [serverPath], env: mcpEnv, cwd: repoRoot}};
const before = JSON.stringify(context);
const bundle = buildConfig(context);
assert.equal(JSON.stringify(context), before, 'adapter mutated shared context');
const file = path => bundle.files.find(f => f.path === path)?.content;
const config = JSON.parse(file('.zcode/config.json'));
assert.deepEqual(config.mcp.servers.finance, {type: 'stdio', ...context.mcp, enabled: true, timeoutMs: 180000});
assert.equal(config.permission.mode, 'build');
assert.equal(config.features.mcp, true);
assert.deepEqual(config.skills.roots, [skillsDir]);
assert.equal(config.model, undefined, 'adapter must not supply a model or credentials');
assert.ok(!bundle.files.some(f => f.path.startsWith('.zcode/agents/')), 'user-only agent must not masquerade as a workspace role');
assert.match(file('manual-user/agents/finance-parser.md'), /tools: \[Read, Grep, Glob, Write, Edit, Bash\]/);
assert.match(file('manual-user/agents/finance-parser.md'), /injectAgentsMd: false/);
assert.match(file('AGENTS.md'), /harness\/SKILL\.md/);
assert.ok(bundle.notes.some(n => n.includes('自动连接')));

// 使用为 ZCode 生成的精确 command/args/env 连接实际 MCP 服务。
// 这是协议探针，不是 ZCode 进程或模型调用。
const native = config.mcp.servers.finance;
assert.equal(native.command, process.execPath);
assert.equal(native.args.length, 1);
const client = new McpStdioClient(native.args[0], {cwd: native.cwd, env: {...native.env, NODE_NO_WARNINGS: '1'}, timeoutMs: 30000}).start();
try {
  await client.initialize('zcode-config-protocol-probe');
  const listed = (await client.rpc('tools/list')).result.tools;
  const expected = [...HARNESS_TOOL_NAMES, 'skills_list', 'skills_read'].sort();
  assert.deepEqual(listed.map(t => t.name).sort(), expected);
  assert.equal(listed.some(t => t.name === 'account_set_create'), false);
  const denied = await client.call('account_set_create', {name: 'SYNTHETIC-NOT-CREATED'});
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /tool_not_available/);
  const discovery = await client.call('harness_discover');
  assert.equal(discovery.isError, false, discovery.text);
  assert.ok(discovery.structured.domains.some(d => d.domain === 'agency'));
  const skill = await client.call('skills_read', {resource: 'harness/SKILL.md'});
  assert.equal(skill.isError, false);
  assert.match(skill.data.markdown, /本机财税 Harness/);
  const sourcePath = join(outputDir, '合成原件.txt');
  writeFileSync(sourcePath, '合成行政采购原件\n82.46\n', 'utf8');
  const storePath = join(outputDir, 'store');
  const scope = {enterpriseKey: 'SYN-ZCODE-PROTOCOL', accountSetId: 1, databaseInstanceId: 'synthetic-zcode-instance', period: '2026-03', currency: 'CNY'};
  for (const [name, args] of [
    ['harness_init', {storePath, scope}],
    ['harness_source_register', {storePath, source: {sourceId: 'raw', path: sourcePath, locator: '第2行', classification: 'provided', unrecognized: []}}],
    ['harness_facts_register', {storePath, factEvidencePolicy: 'require', facts: [{factId: 'amount', state: 'provided', reason: '合成原件精确金额', sourceRefs: ['raw'], value: '82.46', evidence: {version: 'harness-fact-evidence/1', kind: 'original', bindings: [{sourceId: 'raw', valuePath: '', locator: {startLine: 2, endLine: 2}, quote: '82.46'}]}}]}],
  ]) {
    const result = await client.call(name, args);
    assert.equal(result.isError, false, `${name}: ${result.text}`);
  }
  const journal = JSON.parse(readFileSync(join(storePath, 'events/00000003.json'), 'utf8'));
  assert.equal(journal.kind, 'facts');
  assert.equal(journal.data[0].value, '82.46');
  assert.equal(journal.data[0].evidence.bindings[0].quote, '82.46');
  assert.equal(existsSync(databasePath), false, 'metadata probe unexpectedly opened a ledger');
  console.log(JSON.stringify({status: 'passed', modelInvoked: false, zcodeProcessInvoked: false, tools: listed.length, checks: ['native config preserves explicit target/profile', 'no model or automatic user agent installation', 'real stdio list/call profile enforcement', 'native discovery and existing Chinese Skill', 'actual original amount evidence registered without ledger creation']}));
} finally {
  await client.close();
  assert.equal(dirname(resolve(outputDir)), testTempRoot);
  assert.ok(basename(outputDir).startsWith('finance-zcode-synthetic-'));
  rmSync(outputDir, {recursive: true, force: true});
}
