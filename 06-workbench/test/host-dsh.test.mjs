import assert from 'node:assert/strict';
import { buildConfig } from '../../05-reconstruction/codex/hosts/dsh/adapter.mjs';

const context = {
  repoRoot: '/synthetic/product', nodePath: '/synthetic/bin/node', serverPath: '/synthetic/product/server.mjs',
  skillsDir: '/synthetic/product/skills', apiBase: 'http://127.0.0.1:19876',
  databasePath: '/synthetic/data/book.db', outputDir: '/synthetic/generated',
  mcp: { command: '/synthetic/bin/node', args: ['/synthetic/product/server.mjs'], cwd: '/synthetic/product', env: {
    FINANCE_MCP_PROFILE: 'harness', FINANCE_API_BASE: 'http://127.0.0.1:19876',
    FINANCE_DATABASE_PATH: '/synthetic/data/book.db', FINANCE_SKILLS_DIR: '/synthetic/product/skills',
  } },
};
const original = structuredClone(context), result = buildConfig(context);
assert.deepEqual(context, original, 'adapter must not mutate the supplied connection');
assert.ok(result.files.every(f => typeof f.content === 'string' && !f.path.includes('..')));
const patches = JSON.parse(result.files.find(f => f.path === 'finance.cordis.patch.yml').content);
const mcp = patches.find(p => p.insert).insert.find(p => p.id === 'finance-harness-mcp');
assert.equal(mcp.name, '@deepseek-ai/dsh-mcp-client');
assert.equal(mcp.config.transport, 'stdio');
for (const field of ['command', 'args', 'cwd', 'env']) assert.deepEqual(mcp.config[field], context.mcp[field]);
assert.equal(mcp.config.reconnect.enabled, false);
assert.equal(patches.find(p => p.id === 'session-log-deepseek').config.enabled, false);
assert.equal(patches.find(p => p.id === 'session-telemetry-otel').disabled, true);
assert.deepEqual(patches.find(p => p.id === 'skill-filesystem').config, {
  includeDefaultRoots: false, customSkillDirs: [context.skillsDir], watch: false,
});
assert.throws(() => buildConfig({ ...context, mcp: { ...context.mcp, env: {} } }), /dsh_harness_profile_required/);
const special = structuredClone(context); special.mcp.command = 'C:\\合成 目录\\node.exe';
special.mcp.env.FINANCE_DATABASE_PATH = 'C:\\合成 目录\\book.db';
const specialRows = JSON.parse(buildConfig(special).files.find(f => f.path.endsWith('.yml')).content);
assert.equal(specialRows.find(p => p.insert).insert[0].config.command, special.mcp.command);
console.log(JSON.stringify({ status: 'passed', modelInvoked: false, checks: [
  'native stdio configuration preserves explicit target', 'upload plugins explicitly disabled',
  'isolated skill roots', 'profile required', 'Unicode and Windows paths remain literal',
] }));
