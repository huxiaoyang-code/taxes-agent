// 从实际 stdio 和已安装 Claude Code 的控制协议分别读取全量工具名。
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs} from 'node:util';
import {createContext, writeBundle} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../05-reconstruction/codex/hosts/claude-code/adapter.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';

async function directToolNames(context) {
  const inheritedFinanceKeys = Object.keys(process.env).filter(key => /^FINANCE_/i.test(key));
  const env = Object.fromEntries(inheritedFinanceKeys.map(key => [key, undefined]));
  const client = new McpStdioClient(context.serverPath, {cwd: context.outputDir, env: {...env, ...context.mcpEnv}}).start();
  try {
    await client.initialize('claude-direct-discovery');
    const {result} = await client.rpc('tools/list');
    return result.tools.map(tool => tool.name).sort();
  } finally {
    await client.close();
  }
}

async function nativeToolNames(cli, context, profile) {
  const workspace = context.outputDir;
  mkdirSync(profile);
  writeFileSync(join(profile, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    projects: {[workspace.replaceAll('\\', '/')]: {hasTrustDialogAccepted: true}},
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE$|FINANCE_)/i.test(key)));
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: profile, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    ANTHROPIC_API_KEY: 'synthetic-discovery-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  });
  const debugFile = join(profile, 'discovery.log');
  const child = spawn(cli.command, [...cli.args, '-p', '--verbose', '--no-session-persistence', '--debug-file', debugFile,
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--strict-mcp-config',
    '--mcp-config', join(workspace, '.mcp.json'), '--setting-sources', 'project'], {
    cwd: workspace, env, windowsHide: true, timeout: 45000, killSignal: 'SIGKILL',
  });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  child.stderr.resume();
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  const lines = createInterface({input: child.stdout, crlfDelay: Infinity})[Symbol.asyncIterator]();
  async function control(subtype, id) {
    child.stdin.write(JSON.stringify({type: 'control_request', request_id: id, request: {subtype}}) + '\n');
    for (;;) {
      const {value, done} = await lines.next();
      if (done) throw spawnError ?? new Error('Claude Code 在完成控制请求前退出。');
      const message = JSON.parse(value);
      if (message.type !== 'control_response' || message.response?.request_id !== id) continue;
      assert.equal(message.response.subtype, 'success', subtype);
      return message.response.response;
    }
  }
  let connectionStatus, names, exit;
  try {
    await control('initialize', 'init');
    for (let attempt = 0; attempt < 80; attempt++) {
      const status = await control('mcp_status', 'list-' + attempt);
      const finance = status.mcpServers.find(server => server.name === 'finance');
      connectionStatus = finance?.status;
      if (finance?.status === 'connected' && Array.isArray(finance.tools)) {
        assert.equal(finance.transport, 'stdio');
        assert.equal(finance.serverInfo?.name, 'finance-mcp');
        names = finance.tools.map(tool => tool.name).sort();
        break;
      }
      if (finance && !['pending', 'connected'].includes(finance.status)) throw Error('finance MCP 连接状态 ' + finance.status);
      await delay(250);
    }
    assert.ok(names, '等待 Claude Code 载入 finance MCP 工具超时。');
  } finally {
    child.stdin.end();
    const fallback = setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    exit = await closed;
    clearTimeout(fallback);
  }
  // 只摘取宿主明确拒绝的工具名和 JSON Schema 关键词，原生日志仅留在此次临时目录。
  const log = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : '';
  const skippedBySchema = [...log.matchAll(/MCP server "finance" Skipping tool "([\w-]+)": its input schema uses top-level (oneOf|anyOf|allOf)/g)]
    .map(([, name, keyword]) => ({name, keyword}));
  return {names, connectionStatus, exit, skippedBySchema};
}

const {values} = parseArgs({options: {'claude-cli': {type: 'string'}}});
const path = values['claude-cli'];
assert.ok(path && isAbsolute(path), '需要 --claude-cli <本机 Claude Code 可执行文件或 JS 入口绝对路径>');
const cli = /\.[cm]?js$/i.test(path) ? {command: process.execPath, args: [path]} : {command: path, args: []};
const version = execFileSync(cli.command, [...cli.args, '--version'], {encoding: 'utf8', windowsHide: true, timeout: 10000}).trim();
assert.match(version, /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?\s+\(Claude Code\)$/, '需要实际 Claude Code CLI');
const tempRoot = resolve(tmpdir());
const temporary = mkdtempSync(join(tempRoot, 'finance-claude-discovery-'));
try {
  const context = createContext({
    nodePath: process.execPath, apiBase: 'http://127.0.0.1:1', databasePath: join(temporary, 'synthetic.db'),
    outputDir: join(temporary, 'host'),
  });
  writeBundle(context, buildConfig(context));
  const direct = await directToolNames(context);
  const native = await nativeToolNames(cli, context, join(temporary, 'profile'));
  for (const name of ['voucher_correct', 'finance_period_review', 'finance_rules', 'finance_workpaper', 'finance_tax_calculate', 'finance_tax_summary_calculate']) {
    assert.ok(direct.includes(name), 'direct MCP 缺失 ' + name);
  }
  const missing = direct.filter(name => !native.names.includes(name));
  const unexpected = native.names.filter(name => !direct.includes(name));
  const passed = !missing.length && !unexpected.length && direct.length === native.names.length && native.exit.code === 0;
  console.log(JSON.stringify({
    status: passed ? 'passed' : 'failed', version, directCount: direct.length, nativeCount: native.names.length,
    missing, unexpected, modelInvoked: false, ...native,
  }));
  if (!passed) process.exitCode = 1;
} finally {
  assert.equal(dirname(resolve(temporary)), tempRoot);
  rmSync(temporary, {recursive: true, force: true, maxRetries: 3});
}
