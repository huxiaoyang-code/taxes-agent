// 税局接口目录的真实链路：stdio MCP → 生产 HTTP 服务 → Agent 工具。
// 只使用合成临时数据库和回环地址的临时端口。
// 不使用真实税局端点、浏览器、凭据、账套数据或私有报告副本。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from './mcp-stdio-client.mjs';
import { TOOLS, validateArgs } from './tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../..');
const serverPath = join(root, '06-workbench/server/server.mjs');
const PRIVATE = 'PRIVATE_MCP_CATALOG_TRIPWIRE';
const CATALOG_TOOLS = ['tax_api_catalog_modules', 'tax_api_catalog_search', 'tax_api_catalog_entry',
  'tax_api_catalog_validate', 'tax_api_catalog_prepare', 'tax_api_catalog_classify', 'tax_api_catalog_outcomes'];

async function withBackend(run) {
  const directory = mkdtempSync(join(tmpdir(), 'tax-api-catalog-mcp-'));
  let child, client, stopped;
  try {
    child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, WORKBENCH_DATA_DIR: directory, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    stopped = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error(`startup timeout: ${stderr}`)), 15000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(Error(`startup exit ${code}: ${stderr}`)); });
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const match = output.match(/127\.0\.0\.1:(\d+)\//);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    client = new McpStdioClient(join(here, 'server.mjs'), { env: { FINANCE_API_BASE: `http://127.0.0.1:${port}` }, cwd: here }).start();
    await client.initialize('tax-api-catalog-synthetic-test');
    await run(client, `http://127.0.0.1:${port}`);
  } finally {
    if (client) await client.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (stopped) await stopped;
    rmSync(directory, { recursive: true, force: true });
  }
}
async function ok(client, name, args) {
  const r = await client.call(name, args);
  assert.equal(r.isError, false, r.text);
  assert.doesNotMatch(JSON.stringify(r.data), /PRIVATE_MCP_CATALOG|https?:\/\//i);
  return r.data;
}
async function fails(client, name, args, expected) {
  const r = await client.call(name, args);
  assert.equal(r.isError, true, `expected failure for ${name}`);
  assert.match(r.text, expected);
  assert.doesNotMatch(r.text, /PRIVATE_MCP_CATALOG/);
  return r;
}

test('catalog tools are advertised with strict schemas and are never local-only fakes', () => {
  for (const name of CATALOG_TOOLS) {
    const tool = TOOLS.find((t) => t.name === name);
    assert.ok(tool, name);
    assert.equal(tool.status, 'available');
    assert.equal(tool.origin, 'local');
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties === false || !tool.inputSchema.properties.url, true, name);
    assert.equal(tool.inputSchema.properties.sessionProbe, undefined, '已移除的全局会话推断入口不得出现在 schema');
  }
  const entry = TOOLS.find((t) => t.name === 'tax_api_catalog_entry');
  assert.deepEqual(entry.inputSchema.required, ['id']);
  const search = TOOLS.find((t) => t.name === 'tax_api_catalog_search');
  assert.ok(search.inputSchema.properties.page && search.inputSchema.properties.pageSize);
  assert.equal(search.inputSchema.properties.url, undefined);
  assert.equal(search.inputSchema.properties.source, undefined);
  assert.deepEqual(search.inputSchema.properties.completeness.enum,
    ['full_contract', 'method_and_params_documented', 'method_and_response_documented',
      'method_documented', 'params_documented', 'path_only', 'unknown']);
  assert.equal(search.inputSchema.properties.completeness.enum.includes('partial_contract'), false);
  for (const tool of TOOLS.filter((t) => CATALOG_TOOLS.includes(t.name))) {
    assert.ok(tool.description.length > 10, tool.name);
  }
  // 前置参数校验同样拒绝额外字段值（这里只检查必填与类型层）
  assert.ok(validateArgs(entry.inputSchema, { id: 'portal.mhzx.home.index' }).length === 0);
  assert.ok(validateArgs(entry.inputSchema, {}).length === 1);
});

test('MCP exposes modules, paginated search and entry details through real HTTP', async () => {
  await withBackend(async (client) => {
    const listed = await client.rpc('tools/list');
    for (const name of CATALOG_TOOLS) assert.ok(listed.result.tools.some((t) => t.name === name), name);

    const modules = await ok(client, 'tax_api_catalog_modules', {});
    assert.ok(modules.modules.length > 10);
    assert.equal(modules.stats.autoExecutableCount, 0);
    assert.equal(modules.stats.liveCallVerifiedCount, 0);
    assert.equal(modules.stats.reportListedEntries, modules.stats.entryCount);
    assert.equal(modules.stats.reportListedModules, modules.stats.moduleCount);
    assert.equal(modules.stats.reportClaimIsNotCoverage, true);
    assert.equal(modules.stats.byCompleteness.full_contract, 0);
    assert.equal(modules.stats.entriesWithUnknownResponse + modules.stats.entriesWithDocumentedResponse,
      modules.stats.entryCount);
    assert.equal(modules.stats.entriesWithUnknownPermissionRequirement, modules.stats.entryCount);
    // 参数计数：观测 20 / 推断 1 / 声明 21，推断不得计入已载明
    assert.equal(modules.stats.documentedParamCount, 20);
    assert.equal(modules.stats.inferredParamCount, 1);
    assert.equal(modules.stats.declaredParamCount, 21);
    assert.match(modules.stats.timeoutNote, /不是税局 SLA/);
    assert.equal(modules.catalogManaged, true);
    assert.equal(modules.liveCallVerified, false);
    assert.match(modules.source.reportSha256, /^[a-f0-9]{64}$/);

    const one = await ok(client, 'tax_api_catalog_search', { page: 1, pageSize: 3 });
    const two = await ok(client, 'tax_api_catalog_search', { page: 2, pageSize: 3 });
    assert.equal(one.items.length, 3);
    assert.notDeepEqual(one.items.map((i) => i.id), two.items.map((i) => i.id));
    assert.ok(one.items.every((i) => i.catalogManaged === true && i.liveCallVerified === false));
    assert.deepEqual(one.filters, { textProvided: false, textLength: 0, textApplied: false, page: 1, pageSize: 3 });

    const detail = await ok(client, 'tax_api_catalog_entry', { id: one.items[0].id });
    assert.equal(detail.id, one.items[0].id);
    assert.equal(detail.autoExecutable, false);
    assert.ok(Array.isArray(detail.reportLines) && detail.reportLines.length > 0);
    assert.ok(Array.isArray(detail.completenessGaps));
    await fails(client, 'tax_api_catalog_entry', { id: 'https://example.invalid/x' }, /catalog_id_unknown/);
    await fails(client, 'tax_api_catalog_entry', {}, /缺少必填参数|id/);
  });
});

test('MCP rejects arbitrary URLs, unknown filters, review-regression values and over-long paging', async () => {
  await withBackend(async (client) => {
    await fails(client, 'tax_api_catalog_search', { text: 'https://example.invalid/x' }, /catalog_arbitrary_input_rejected/);
    await fails(client, 'tax_api_catalog_search', { module: 'not-a-module' }, /catalog_module_unknown/);
    await fails(client, 'tax_api_catalog_search', { service: 'not-a-service' }, /invalid_arguments|catalog_filter_invalid/);
    await fails(client, 'tax_api_catalog_search', { pageSize: 500 }, /catalog_filter_invalid/);
    await fails(client, 'tax_api_catalog_search', { method: 'DELETE' }, /catalog_filter_invalid|catalog/);
    // 对象真值不能当过滤条件，也不能回显（MCP schema 先拦或后端拦都算拒绝）
    const nested = await fails(client, 'tax_api_catalog_search', { module: { password: PRIVATE } },
      /catalog_module_unknown|invalid_arguments/);
    assert.doesNotMatch(nested.text, /PRIVATE_MCP_CATALOG/);
    assert.doesNotMatch(nested.text, /password/);
  });
});

test('MCP parameter validation and call preparation separate catalog facts from live verification', async () => {
  await withBackend(async (client) => {
    const good = await ok(client, 'tax_api_catalog_validate', { id: 'portal.mhzx.sso.sso_login', params: { requestPath: '/synthetic' } });
    assert.equal(good.valid, true);
    assert.equal(good.catalogManaged, true);

    const bad = await ok(client, 'tax_api_catalog_validate', {
      id: 'behavior.config.query', params: { t: 1, cookie: PRIVATE, unexpected: 'x' },
    });
    assert.equal(bad.valid, false);
    assert.ok(bad.problems.some((p) => p.code === 'credential_or_session_field_rejected' && p.field === null));
    assert.ok(bad.problems.some((p) => p.code === 'parameter_not_in_contract' && p.field === null));
    assert.doesNotMatch(JSON.stringify(bad), /unexpected|cookie/);

    // 授权码类参数：推断合同 + 凭据值都不接受
    const callback = await ok(client, 'tax_api_catalog_validate', {
      id: 'portal.mhzx.sso.code_callback', params: { code: PRIVATE },
    });
    assert.equal(callback.valid, false);
    assert.equal(callback.paramsEvidence, 'inferred');
    assert.ok(callback.problems.some((p) => p.code === 'sensitive_parameter_value_rejected'));
    assert.doesNotMatch(JSON.stringify(callback), /PRIVATE_MCP_CATALOG/);

    const login = await ok(client, 'tax_api_catalog_prepare', { id: 'identity.sms.user_second_login' });
    assert.equal(login.state, 'blocked_by_policy');
    assert.equal(login.readyToInvoke, false);
    assert.equal(login.transport.retryCapability.allowed, false);
    assert.equal(login.transport.retryAdvice.allowed, false);
    assert.equal(login.transport.autoRetryForLoginOrWrite, false);

    const read = await ok(client, 'tax_api_catalog_prepare', {
      id: 'portal.mhzx.home.get_user_info',
      context: { enterpriseRef: 'ent_0123456789abcdef', loginSessionRef: 'loginsession_0123456789abcdef' },
    });
    assert.equal(read.state, 'not_ready');
    assert.equal(read.liveCallVerified, false);
    assert.equal(read.adapterBinding, 'missing');
    assert.ok(read.notReadyReasons.length > 0);
    assert.equal(read.contextVerification.enterpriseOwnershipChecked, false);
    assert.equal(read.contextVerification.permissionGrantChecked, false);

    // 布尔 true 不得当成 accountSetId=1
    const booleanId = await ok(client, 'tax_api_catalog_prepare', {
      id: 'portal.mhzx.home.get_user_info', context: { accountSetId: true },
    });
    assert.equal(booleanId.contextRefs.accountSetId, null);
    assert.ok(booleanId.notReadyReasons.some((r) => r.code === 'account_set_ref_invalid'));
  });
});

test('MCP result classifier separates outcomes and never returns raw error text', async () => {
  await withBackend(async (client) => {
    assert.equal((await ok(client, 'tax_api_catalog_classify', {
      risk: 'read_only', observation: { requestIssued: false },
    })).outcome, 'not_sent');
    const timeout = await ok(client, 'tax_api_catalog_classify', {
      risk: 'authentication', observation: { requestIssued: true, transportError: 'timeout' },
    });
    assert.equal(timeout.outcome, 'transport_timeout');
    assert.equal(timeout.retryAdvice.allowed, false);
    assert.equal(timeout.globalSessionState, 'unknown');
    const rejected = await fails(client, 'tax_api_catalog_classify', {
      risk: 'read_only', observation: { requestIssued: true, message: PRIVATE },
    }, /classify_field_rejected/);
    assert.doesNotMatch(rejected.text, /PRIVATE_MCP_CATALOG/);

    // 字符串真值不能制造 success
    await fails(client, 'tax_api_catalog_classify', {
      risk: 'read_only',
      observation: { requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200,
        schemaRecognized: 'false', businessCodeFamily: 'success', businessCodePresent: true, resultCount: 1 },
    }, /classify_input_invalid/);

    // 矛盾元数据不成功
    const contradictory = await ok(client, 'tax_api_catalog_classify', {
      risk: 'read_only',
      observation: { requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200,
        schemaRecognized: true, businessCodeFamily: 'success', businessCodePresent: true, authSignal: true },
    });
    assert.equal(contradictory.outcome, 'structure_unrecognized');

    // 空结果族与非 2xx 状态冲突：结构不识别，不推断全局登录失效；empty + 2xx 仍有效
    const emptyOn500 = await ok(client, 'tax_api_catalog_classify', {
      risk: 'read_only',
      observation: { requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 500,
        schemaRecognized: true, businessCodeFamily: 'empty', businessCodePresent: true, resultCount: 0 },
    });
    assert.equal(emptyOn500.outcome, 'structure_unrecognized');
    assert.equal(emptyOn500.retryAdvice.allowed, false);
    assert.equal(emptyOn500.globalSessionState, 'unknown');
    assert.equal((await ok(client, 'tax_api_catalog_classify', {
      risk: 'read_only',
      observation: { requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200,
        schemaRecognized: true, businessCodeFamily: 'empty', businessCodePresent: true, resultCount: 0 },
    })).outcome, 'business_empty');

    // sessionProbe 已移除：不得作为入口推断全局登录
    await fails(client, 'tax_api_catalog_classify', { risk: 'read_only', observation: { requestIssued: true }, sessionProbe: true },
      /catalog_filter_invalid/);

    const outcomes = await ok(client, 'tax_api_catalog_outcomes', {});
    assert.equal(outcomes.outcomes.length, 10);
    assert.equal(outcomes.globalSessionState, 'unknown');
    assert.ok(outcomes.rules.some((r) => r.includes('tax_session_verify')));
  });
});
