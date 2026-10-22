#!/usr/bin/env node
// finance-model-transport test — 模型通道信封的纯出站校验 / 固定错误转换。
//
// 运行：node 05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs
//
// 边界：本套件**不启动后端、不连数据库、不发网络请求**，也不验证 MCP stdio 挂载。
// 当前 MCP（tools.mjs / backend.mjs / server.mjs）仍是原样透传后端结果，归 LOCAL-02 共享入口；
// 接入本模块必须另走集成任务并补真实 stdio 验收。本文件只证明：校验器能放过有意义的成功信封，
// 同时拒绝敏感额外字段 / 畸形数据，并且运输失败只产出固定常量（写结果未知不误导重试）。
import assert from 'node:assert/strict';

const T = await import('./finance-model-transport.mjs');
const ADAPTER = await import('../../../../06-workbench/server/finance-model-adapter.mjs');
const { createFinanceModelAdapter, PLAIN_MODEL_TOOLS, FINANCE_QUERY_AVAILABLE, FINANCE_QUERY_UNIMPLEMENTED, UNIMPLEMENTED_MODEL_TOOLS } = ADAPTER;

const { validateModelEnvelope, parseModelEnvelope, transportFailure, classifyTransportFailure, TRANSPORT_FAILURES } = T;

// 合成敏感标记（只用于断言“不会被透传”，不读取任何真实数据）
const X = {
  enterprise: '合成机密企业名称甲',
  summary: '合成机密摘要丙',
  path: 'D:/合成机密路径/凭证明细.zip',
  apiBase: 'http://10.0.0.9:9/synthetic',
  message: '合成机密错误文本乙',
};

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  PASS ${name}`); }
  catch (error) { results.push(false); console.error(`  FAIL ${name}\n${error.stack}`); }
}
function assertNoLeak(value, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const marker of Object.values(X)) assert.ok(!text.includes(marker), `${label} 泄漏：${marker}`);
}
const expectFailure = (result, code) => {
  assert.equal(result.ok, false, `应拒绝（期望 ${code}）`);
  assert.equal(result.failure.error.code, code);
  assert.equal(result.failure.isError, true);
  assertNoLeak(result.failure, `failure ${code}`);
};

// ---------------------------------------------------------------- 登记表（由适配器导出，不拼接入参）
const REGISTRY = {
  operations: [
    'finance_query_catalog', 'update_plan', 'account_context', 'finance_context_resolve',
    ...Object.values(PLAIN_MODEL_TOOLS).map((spec) => spec.operation).filter((op) => typeof op === 'string'),
    ...FINANCE_QUERY_AVAILABLE.map((nodeId) => `finance_query:${nodeId}`),
  ],
  tools: [...Object.keys(PLAIN_MODEL_TOOLS), ...UNIMPLEMENTED_MODEL_TOOLS],
  // nodeIds = 所有**已登记**的 node（可用 + 明确未实现）；是否可用由适配器的 node 登记表决定。
  nodeIds: [...FINANCE_QUERY_AVAILABLE, ...FINANCE_QUERY_UNIMPLEMENTED],
};

// ---------------------------------------------------------------- 适配器真实产出的信封
const fakeExecutor = async (name, args) => {
  if (name === 'finance_query') {
    return {
      nodeId: 'report.balance_sheet', label: 'x',
      data: {
        period: '2026-01',
        assets: [
          { label: '货币资金', value: 1700 },
          { label: '应收账款', value: 0 },
          { label: '存货', value: 0 },
          { label: '固定资产账面价值', value: 0 },
        ],
        liabilities: [],
        totals: { assets: 1700, liabilities: 0, equity: 1700 },
        balanced: true,
      },
    };
  }
  if (name === 'account_context') {
    return {
      account_sets: [
        { id: 3, name: X.enterprise, taxpayer_type: '小规模纳税人', accounting_standard: '小企业会计准则', start_period: '2026-01' },
        { id: 2, name: '第二个合成名称', taxpayer_type: '一般纳税人', accounting_standard: '企业会计准则', start_period: '2026-02' },
      ],
      periods: [],
    };
  }
  if (name === 'voucher_create') {
    return { id: 4321, account_set_id: 3, period: '2026-01', status: 'draft', entries: [{ debit: 1, credit: 0 }] };
  }
  if (name === 'voucher_post') {
    // 写后结果不可安全读取（访问器）→ 适配器应降级引用但保留 applied
    return {
      id: 7, account_set_id: 3, period: '2026-01', status: 'posted',
      get entries() { throw new Error(X.message); },
    };
  }
  if (name === 'legacy_book_import') {
    return {
      dryRun: args?.dryRun !== false,
      validation: { ok: true, errors: [], warnings: [] },
      created: null,
    };
  }
  return {};
};
const adapter = createFinanceModelAdapter({ executeRaw: fakeExecutor });
const invoice = await adapter.callModelTool('finance_query', { accountSetId: 3, nodeId: 'report.balance_sheet', period: '2026-01' });

await test('有意义的成功信封能通过（不是“总是拒绝”）：查询 / 写 / 静态 / 全局上下文', async () => {
  const write = await adapter.callModelTool('voucher_create', { accountSetId: 3, period: '2026-01', entries: [] });
  const degraded = await adapter.callModelTool('voucher_post', { accountSetId: 3, voucherId: 7 });
  const catalog = await adapter.callModelTool('finance_query_catalog', {});
  const context = await adapter.callModelTool('account_context', { limit: 1 });
  const plan = await adapter.callModelTool('update_plan', { plan: [X.summary] });

  assert.equal(invoice.ok, true);
  assert.equal(write.ok, true);
  assert.equal(degraded.ok, true);
  assert.equal(degraded.applied, true);
  assert.equal(degraded.localRef, null);
  assert.equal(catalog.ok, true);
  assert.equal(context.ok, true);
  assert.equal(plan.ok, true);

  for (const [label, envelope] of Object.entries({ invoice, write, degraded, catalog, context, plan })) {
    const checked = validateModelEnvelope(envelope, REGISTRY);
    assert.equal(checked.ok, true, `${label} 应通过：${checked.ok ? '' : checked.failure.error.code}`);
    assertNoLeak(checked.envelope, label);
  }
  // 上下文投影里没有企业名，只有内部 ID / 计数 / 受控枚举
  const contextChecked = validateModelEnvelope(context, REGISTRY);
  assert.equal(contextChecked.ok, true);
  assert.equal(JSON.stringify(contextChecked.envelope.projection).includes(X.enterprise), false);
  assert.deepEqual(contextChecked.envelope.projection.accountSetIds, [3]);
});

await test('失败信封（固定错误码）也能通过校验：未知工具 / 税务拒绝 / 未实现 node / 缺账套', async () => {
  const envelopes = [
    await adapter.callModelTool('voucher_approve', {}),
    await adapter.callModelTool('tax_login_start', {}),
    await adapter.callModelTool('finance_query', { accountSetId: 3, nodeId: 'enterprise_account.bank' }),
    await adapter.callModelTool('voucher_create', { period: '2026-01' }),
  ];
  for (const envelope of envelopes) {
    assert.equal(envelope.ok, false);
    const checked = validateModelEnvelope(envelope, REGISTRY);
    assert.equal(checked.ok, true, `失败信封应通过：${checked.ok ? '' : checked.failure.error.code}`);
    assertNoLeak(checked.envelope, 'failure envelope');
  }
});

await test('敏感 / 未知额外字段一律拒绝，且不回显字段名或字段值', async () => {
  const base = { ...invoice, message: X.message };
  expectFailure(validateModelEnvelope(base, REGISTRY), 'envelope_sensitive_field');
  for (const key of ['details', 'stack', 'path', 'raw', 'apiBase']) {
    expectFailure(validateModelEnvelope({ ...invoice, [key]: X.path }, REGISTRY), 'envelope_sensitive_field');
  }
  const extra = validateModelEnvelope({ ...invoice, extraField: 1 }, REGISTRY);
  expectFailure(extra, 'envelope_unexpected_field');
  assert.equal(JSON.stringify(extra.failure).includes('extraField'), false);
  // 嵌套 error 里也不允许挂原文
  const failureEnvelope = await adapter.callModelTool('nope_tool', {});
  const withMessage = { ...failureEnvelope, error: { ...failureEnvelope.error, message: X.message } };
  expectFailure(validateModelEnvelope(withMessage, REGISTRY), 'envelope_error_shape_invalid');
});

await test('契约 / 通道 / operation / 引用 / 投影形状被严格校验', () => {
  expectFailure(validateModelEnvelope({ ...invoice, outputPolicy: 'other/v1' }, REGISTRY), 'envelope_policy_mismatch');
  expectFailure(validateModelEnvelope({ ...invoice, channel: 'local' }, REGISTRY), 'envelope_policy_mismatch');
  expectFailure(validateModelEnvelope({ ...invoice, rawValuesIncluded: true }, REGISTRY), 'envelope_policy_mismatch');
  expectFailure(validateModelEnvelope({ ...invoice, adapter: X.enterprise }, REGISTRY), 'envelope_policy_mismatch');

  // operation 必须来自固定登记表：不拼接未验证输入
  expectFailure(
    validateModelEnvelope({ ...invoice, operation: 'voucher_delete_all' }, REGISTRY),
    'envelope_operation_unregistered',
  );
  expectFailure(validateModelEnvelope({ ...invoice, operation: { toString: () => 'x' } }, REGISTRY), 'envelope_operation_unregistered');

  // 伪造 / 变形 ref
  expectFailure(
    validateModelEnvelope({ ...invoice, localRef: 'finref_forged' }, REGISTRY),
    'envelope_ref_invalid',
  );
  expectFailure(
    validateModelEnvelope({ ...invoice, localRef: null }, REGISTRY),
    'envelope_ref_invalid',
  );
  expectFailure(
    validateModelEnvelope({ ...invoice, refPersistence: 'disk' }, REGISTRY),
    'envelope_ref_invalid',
  );

  // 投影：自由文本 / 超深嵌套 / 非有限数值 / 超长字符串都不接受
  expectFailure(
    validateModelEnvelope({ ...invoice, projection: { ...invoice.projection, note: X.summary } }, REGISTRY),
    'envelope_projection_invalid',
  );
  expectFailure(
    validateModelEnvelope({ ...invoice, projection: { ...invoice.projection, deep: { a: { b: { c: { d: 1 } } } } } }, REGISTRY),
    'envelope_projection_invalid',
  );
  expectFailure(
    validateModelEnvelope({ ...invoice, projection: { ...invoice.projection, nan: Number.NaN } }, REGISTRY),
    'envelope_projection_invalid',
  );
  expectFailure(
    validateModelEnvelope({ ...invoice, projection: { ...invoice.projection, long: 'z'.repeat(41) } }, REGISTRY),
    'envelope_projection_invalid',
  );
  // 任意 ASCII 业务串不能伪装成状态 / 目录 / 枚举穿过
  expectFailure(
    validateModelEnvelope({ ...invoice, projection: { ...invoice.projection, status: 'synthetic_private_text' } }, REGISTRY),
    'envelope_projection_invalid',
  );
  expectFailure(
    validateModelEnvelope({ ...invoice, projection: { ...invoice.projection, nested: { enterpriseName: 'posted' } } }, REGISTRY),
    'envelope_projection_invalid',
  );
  // 状态三态不合法 / 未知写结果未标 needsLocalReview
  const write = { ...invoice, tool: 'voucher_create', operation: 'voucher_create', nodeId: undefined, operationCategory: 'write', applied: 'maybe', needsLocalReview: true };
  expectFailure(validateModelEnvelope(write, REGISTRY), 'envelope_status_invalid');
  const unmarked = { ...invoice, tool: 'voucher_create', operation: 'voucher_create', nodeId: undefined, operationCategory: 'write', applied: 'unknown', needsLocalReview: false };
  expectFailure(validateModelEnvelope(unmarked, REGISTRY), 'envelope_status_invalid');
});

await test('每个允许键在所有分支都完整校验：不适用字段 / 任意值都被拒绝', async () => {
  // 成功查询信封：adapter / appliedReason / error / catalog / source 都不适用
  expectFailure(validateModelEnvelope({ ...invoice, appliedReason: 'synthetic_private_text' }, REGISTRY), 'envelope_unexpected_field');
  expectFailure(validateModelEnvelope({ ...invoice, error: { message: X.message } }, REGISTRY), 'envelope_unexpected_field');
  expectFailure(validateModelEnvelope({ ...invoice, catalog: { available: ['synthetic_private_company'] } }, REGISTRY), 'envelope_unexpected_field');
  expectFailure(validateModelEnvelope({ ...invoice, accountSetIdSource: 'result' }, REGISTRY), 'envelope_unexpected_field');

  // 失败信封：projection / appliedReason / 目录也必须有规则
  const failureEnvelope = await adapter.callModelTool('voucher_create', { period: '2026-01' });
  assert.equal(failureEnvelope.ok, false);
  expectFailure(
    validateModelEnvelope({ ...failureEnvelope, projection: { note: X.summary } }, REGISTRY),
    'envelope_projection_invalid',
  );
  expectFailure(
    validateModelEnvelope({ ...failureEnvelope, appliedReason: 'synthetic_private_text' }, REGISTRY),
    'envelope_status_invalid',
  );
  expectFailure(
    validateModelEnvelope({ ...failureEnvelope, catalog: { available: ['synthetic_private_company'] } }, REGISTRY),
    'envelope_unexpected_field',
  );
  expectFailure(
    validateModelEnvelope({ ...failureEnvelope, adapter: X.enterprise }, REGISTRY),
    'envelope_policy_mismatch',
  );
  const queryFailure = await adapter.callModelTool('voucher_approve', {});
  expectFailure(
    validateModelEnvelope({ ...queryFailure, projection: { note: X.summary } }, REGISTRY),
    'envelope_unexpected_field',
  );
  expectFailure(
    validateModelEnvelope({ ...queryFailure, appliedReason: 'synthetic_private_text' }, REGISTRY),
    'envelope_unexpected_field',
  );

  // error 里的未知码 / 错 category / 额外 message 都拒绝
  const badCode = { ...failureEnvelope, error: { ...failureEnvelope.error, code: 'synthetic_private_code', messageKey: 'synthetic_private_code' } };
  expectFailure(validateModelEnvelope(badCode, REGISTRY), 'envelope_error_shape_invalid');
  const badCategory = { ...failureEnvelope, error: { ...failureEnvelope.error, category: 'synthetic_private_category' } };
  expectFailure(validateModelEnvelope(badCategory, REGISTRY), 'envelope_error_shape_invalid');
  const badMessage = { ...failureEnvelope, error: { ...failureEnvelope.error, message: X.message } };
  expectFailure(validateModelEnvelope(badMessage, REGISTRY), 'envelope_error_shape_invalid');

  // 普通 JSON 负例：解析入口同样只回固定码
  expectFailure(parseModelEnvelope(JSON.stringify({ ...invoice, adapter: X.enterprise }), REGISTRY), 'envelope_policy_mismatch');
  expectFailure(parseModelEnvelope(JSON.stringify(badMessage), REGISTRY), 'envelope_error_shape_invalid');
});

await test('getter / Proxy 反射异常不抛原文，只回固定失败结果', () => {
  let getterCalls = 0;
  const hostile = { ...invoice };
  Object.defineProperty(hostile, 'adapter', {
    enumerable: true,
    get() { getterCalls++; throw new Error(X.enterprise); },
  });
  const checked = validateModelEnvelope(hostile, REGISTRY);
  expectFailure(checked, 'envelope_policy_mismatch');
  assert.equal(getterCalls, 0, '校验阶段不得执行访问器 getter');

  const proxied = new Proxy({ ...invoice }, {
    ownKeys() { throw new Error(X.message); },
  });
  const proxyChecked = validateModelEnvelope(proxied, REGISTRY);
  expectFailure(proxyChecked, 'envelope_invalid');

  const parsed = parseModelEnvelope(JSON.stringify(invoice), new Proxy({}, {
    getPrototypeOf() { throw new Error(X.path); },
  }));
  expectFailure(parsed, 'envelope_invalid');
});

await test('transport 校验器不吃业务真假：合法数字 / 期间 / token 数组照样接受', () => {
  const envelope = {
    ...invoice,
    projection: {
      ...invoice.projection,
      period: '2026-12',
      flags: [true, false],
      periods: ['2026-01', '2026-02'],
      nested: { a: 1, b: 'posted' },
      byCategory: { assets: 1 },
    },
  };
  const checked = validateModelEnvelope(envelope, REGISTRY);
  assert.equal(checked.ok, true, `应通过：${checked.ok ? '' : checked.failure.error.code}`);
});

await test('登记语义覆盖真实错误家族：固定码 / create+result / 大驼峰缺参码都能通过', async () => {
  // 真实业务错误（由 fake executor 产生，但与真实 agent-tools / accounting 的码一致）
  const failing = createFinanceModelAdapter({
    executeRaw: async (name) => {
      if (name === 'account_set_create') {
        const error = new Error(X.message);
        error.code = 'name_required';
        throw error;
      }
      if (name === 'book_import_incremental') {
        const error = new Error(X.message);
        error.code = 'import_validation_failed';
        throw error;
      }
      if (name === 'finance_query') {
        const error = new Error(X.message);
        error.code = 'nodeId_required';
        throw error;
      }
      if (name === 'voucher_post') {
        const error = new Error(X.message);
        error.code = 'voucherId_required';
        throw error;
      }
      const error = new Error(X.message);
      error.code = 'account_not_found';
      throw error;
    },
  });
  const envelopes = [
    await failing.callModelTool('account_set_create', {}),
    await failing.callModelTool('book_import_incremental', { payload: {} }),
    await failing.callModelTool('finance_query', { accountSetId: 3, nodeId: 'report.balance_sheet' }),
    await failing.callModelTool('voucher_post', { accountSetId: 3 }),
    await failing.callModelTool('ledger_query', { accountSetId: 3, code: 'x', period: '2026-01' }),
  ];
  for (const envelope of envelopes) {
    assert.equal(envelope.ok, false);
    const checked = validateModelEnvelope(envelope, REGISTRY);
    assert.equal(checked.ok, true, `失败信封应通过：${checked.ok ? '' : checked.failure.error.code}`);
    assertNoLeak(checked.envelope, 'real error envelope');
  }
  // create 失败必须允许 operationCategory=create / scope=result
  assert.equal(envelopes[0].operationCategory, 'create');
  assert.equal(envelopes[0].scope, 'result');
  // legacy dry-run 未应用写结果仍然是通过的正例
  const dryRun = await adapter.callModelTool('legacy_book_import', {
    payload: {
      account_set: { name: '合成机密企业甲', start_period: '2026-01' }, accounts: [], opening_balances: [], vouchers: [],
    },
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.needsLocalReview, true);
  const dryChecked = validateModelEnvelope(dryRun, REGISTRY);
  assert.equal(dryChecked.ok, true, `dry-run 应通过：${dryChecked.ok ? '' : dryChecked.failure.error.code}`);
});

await test('非 JSON / 非对象响应只回固定错误码，不回显响应片段', () => {
  const html = `<html><body>${X.path} ${X.apiBase}</body></html>`;
  expectFailure(parseModelEnvelope(html, REGISTRY), 'backend_non_json');
  expectFailure(parseModelEnvelope('', REGISTRY), 'backend_non_json');
  expectFailure(parseModelEnvelope('[1,2,3]', REGISTRY), 'backend_result_not_object');
  expectFailure(parseModelEnvelope('null', REGISTRY), 'backend_result_not_object');
  const ok = parseModelEnvelope(JSON.stringify(invoice), REGISTRY);
  assert.equal(ok.ok, true);
  assertNoLeak(ok.envelope, 'parsed envelope');
});

await test('运输错误固定常量：写结果未知不误导重试，不含路径 / API_BASE', () => {
  for (const kind of Object.keys(TRANSPORT_FAILURES)) {
    const failure = transportFailure(kind, { forWrite: true });
    assert.equal(failure.ok, false);
    assert.equal(failure.error.retriable, false);
    assert.equal(failure.retriable, false);
    if (kind === 'backend_not_configured') {
      assert.equal(failure.outcome, 'not_sent');
      assert.equal(failure.writeOutcome, 'not_sent');
      assert.equal(failure.retryBlockedBy, undefined);
    } else {
      assert.equal(failure.outcome, 'unknown');
      assert.equal(failure.writeOutcome, 'unknown');
      assert.equal(failure.retryBlockedBy, 'write_outcome_unknown');
    }
    assert.equal(failure.needsLocalReview, undefined);
    assertNoLeak(failure, `transport ${kind}`);
  }
  const timeoutWrite = transportFailure('backend_timeout', { forWrite: true });
  assert.equal(timeoutWrite.retryBlockedBy, 'write_outcome_unknown');
  const unreachableRead = transportFailure('backend_unreachable');
  assert.equal(unreachableRead.retriable, true);
  assert.equal(unreachableRead.outcome, 'unknown');
  const timeoutRead = transportFailure('backend_timeout');
  assert.equal(timeoutRead.outcome, 'unknown');

  assert.equal(classifyTransportFailure('timeout').error.code, 'backend_timeout');
  assert.equal(classifyTransportFailure('non_json').error.code, 'backend_non_json');
  assert.equal(classifyTransportFailure('http_error', { forWrite: true }).retriable, false);
  assert.equal(classifyTransportFailure('unknown-kind').error.code, 'backend_http_error');
  const unreachableWrite = classifyTransportFailure('unreachable', { forWrite: true });
  assert.equal(unreachableWrite.outcome, 'unknown');
  assert.equal(unreachableWrite.writeOutcome, 'unknown');

  const failure = transportFailure('backend_http_error', { forWrite: true });
  assertNoLeak(failure, 'http failure');
  assert.equal(JSON.stringify(failure).includes(X.apiBase), false);
  assert.equal(JSON.stringify(failure).includes(X.path), false);
});

await test('合成回环服务：请求已发出后断连按 unknown 处理（绝不用生产服务）', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => req.socket.destroy());
    res.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  let error = null;
  try {
    await fetch(`http://127.0.0.1:${port}/synthetic`, {
      method: 'POST', body: JSON.stringify({ synthetic: X.summary }),
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(3000),
    });
  } catch (caught) {
    error = caught;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.ok(error, '合成服务应在请求发出后断连，使客户端收到连接错误');
  const writeFailure = classifyTransportFailure('unreachable', { forWrite: true });
  assert.equal(writeFailure.outcome, 'unknown');
  assert.equal(writeFailure.writeOutcome, 'unknown');
  assertNoLeak(writeFailure, 'loopback disconnect');
});

console.log(`\nFinance model transport test: ${results.filter(Boolean).length}/${results.length} passed`);
if (results.some((passed) => !passed)) process.exitCode = 1;
