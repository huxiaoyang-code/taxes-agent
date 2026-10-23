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
        accountingContext: { profileId: 'small-2011-basic-v1', coaVersion: 'small-2011-coa-basic-v1', reportMappingVersion: 'small-2011-report-basic-v1', legacy: false },
        reportStatus: { status: 'complete', complete: true, partialValues: false, diagnostics: [] },
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
  if (name === 'asset_update') {
    // LOCAL-02 新工具：自由文本（名称 / 备注 / 科目）只留给本机，模型通道只看白名单字段。
    return {
      id: 77, account_set_id: 3, kind: 'fixed', name: X.enterprise, ledger_note: X.summary,
      original_cost: 1200, residual_rate: 0.05, useful_life_months: 12,
      start_period: '2026-02', acquired_period: '2026-02', opening_accumulated: 0,
      accumulated: 95, remaining: 1045, ledger_status: 'booked', origin: 'purchase',
      asset_account: '1601', accum_account: '1602', expense_account: '5602', months_done: 1,
    };
  }
  if (name === 'period_end_check') {
    const step = (id, status) => ({
      id, title: X.enterprise, reason: X.summary, status, details: { name: X.enterprise },
    });
    return {
      accountSetId: 3, period: '2026-02', ready: false,
      steps: [
        step('draft_vouchers', 'ok'), step('trial_balance', 'ok'), step('depreciation', 'ok'),
        step('asset_reconciliation', 'ok'), step('profit_carry_forward', 'blocked'),
        step('year_end_carry_forward', 'not_applicable'), step('period_sequence', 'ok'),
      ],
      blocking: [{
        step: 'profit_carry_forward', title: X.enterprise, code: 'profit_not_carried_forward',
        message: X.summary, details: { note: X.message },
      }],
      missing: [{ step: 'profit_carry_forward', code: 'profit_not_carried_forward', message: X.summary }],
      rules: { note: X.message },
    };
  }
  if (name === 'period_set_status') {
    const error = new Error('period_end_check_failed');
    error.code = 'period_end_check_failed';
    throw error;
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
  assert.equal(degraded.needsLocalReview, true);
  assert.deepEqual(degraded.projection, { voucherId: 7 });
  // Only failed projection with no reference permits applied=true + local review.
  for (const reason of ['value_invalid', 'summary_unavailable']) {
    assert.equal(validateModelEnvelope({ ...degraded, refUnavailable: reason }, REGISTRY).ok, true);
  }
  for (const reason of ['capacity', 'value_limit', 'node_budget', 'unbound_scope']) {
    assert.equal(validateModelEnvelope({ ...degraded, refUnavailable: reason }, REGISTRY).ok, false);
  }
  assert.equal(validateModelEnvelope({ ...write, needsLocalReview: true }, REGISTRY).ok, false);
  assert.equal(validateModelEnvelope({ ...degraded, needsLocalReview: false, applied: 'unknown' }, REGISTRY).ok, false);

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

await test('LOCAL-02 新工具：asset_update 写 / period_end_check 只读 / 封账前置拒绝信封都能通过校验', async () => {
  const updated = await adapter.callModelTool('asset_update', {
    accountSetId: 3, assetId: 77, patch: { ledger_note: X.summary },
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.operationCategory, 'write');
  assert.equal(updated.applied, true);
  assert.equal(updated.projection.assetId, 77);
  assert.equal(updated.projection.acquiredPeriod, '2026-02');
  assert.equal(JSON.stringify(updated).includes(X.summary), false);

  const check = await adapter.callModelTool('period_end_check', { accountSetId: 3, period: '2026-02' });
  assert.equal(check.ok, true);
  assert.equal(check.operationCategory, 'query');
  assert.equal(check.scope, 'account_set');
  assert.equal(check.projection.ready, false);
  assert.equal(check.projection.stepCount, 7);
  assert.deepEqual(check.projection.blockingCodes, ['profit_not_carried_forward']);
  assert.equal(JSON.stringify(check.projection).includes(X.summary), false);
  assert.equal(JSON.stringify(check.projection).includes(X.enterprise), false);

  const blocked = await adapter.callModelTool('period_set_status', {
    accountSetId: 3, period: '2026-02', status: 'closed',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'period_end_check_failed');
  assert.equal(blocked.error.category, 'period_end');
  assert.equal(blocked.applied, 'unknown');

  for (const [label, envelope] of Object.entries({ updated, check, blocked })) {
    const checked = validateModelEnvelope(envelope, REGISTRY);
    assert.equal(checked.ok, true, `${label} 应通过：${checked.ok ? '' : checked.failure.error.code}`);
    assertNoLeak(checked.envelope, label);
  }
});

await test('LOCAL-02 回修1：已登记长阻塞码（39 / 36 字符）在 transport 层完整通过，未登记超长 token 仍拒绝', async () => {
  // 真实域里的两条长码都是已登记常量：信封必须原样通过，而不是被投影预算截断 / 拒绝。
  const longCodeAdapter = createFinanceModelAdapter({
    executeRaw: async (name) => {
      if (name !== 'period_end_check') return {};
      const step = (id, status) => ({ id, title: X.enterprise, reason: X.summary, status });
      return {
        accountSetId: 3, period: '2026-09', ready: false,
        steps: [
          step('draft_vouchers', 'ok'), step('trial_balance', 'ok'),
          step('depreciation', 'blocked'), step('asset_reconciliation', 'ok'),
          step('profit_carry_forward', 'ok'), step('year_end_carry_forward', 'not_applicable'),
          step('period_sequence', 'blocked'),
        ],
        blocking: [
          { step: 'depreciation', title: X.enterprise, code: 'depreciation_life_expired_underprovided', message: X.summary },
          { step: 'period_sequence', title: X.enterprise, code: 'previous_period_depreciation_pending', message: X.summary },
        ],
        missing: [],
        rules: { note: X.message },
      };
    },
  });
  const longCheck = await longCodeAdapter.callModelTool('period_end_check', { accountSetId: 3, period: '2026-09' });
  assert.equal(longCheck.ok, true);
  assert.equal(longCheck.projectionDropped, 0);
  assert.deepEqual(longCheck.projection.blockingCodes, [
    'depreciation_life_expired_underprovided', 'previous_period_depreciation_pending',
  ]);
  const checkedLong = validateModelEnvelope(longCheck, REGISTRY);
  assert.equal(checkedLong.ok, true, `已登记长码应通过：${checkedLong.ok ? '' : checkedLong.failure.error.code}`);
  assertNoLeak(checkedLong.envelope, 'long blocking codes');
  longCodeAdapter.policy.dispose();

  // 通用 token 预算 / 长度上限没有被放宽：未登记的长串即使看起来像代码也拒绝。
  const unregistered = { ...longCheck, projection: { ...longCheck.projection, blockingCodes: ['unregistered_long_code_for_projection_xyz'] } };
  expectFailure(validateModelEnvelope(unregistered, REGISTRY), 'envelope_projection_invalid');
  const tooLong = { ...longCheck, projection: { ...longCheck.projection, blockingCodes: ['a'.repeat(41)] } };
  expectFailure(validateModelEnvelope(tooLong, REGISTRY), 'envelope_projection_invalid');
  // 中文业务文本仍进不了投影
  const freeText = { ...longCheck, projection: { ...longCheck.projection, blockingCodes: [X.enterprise] } };
  expectFailure(validateModelEnvelope(freeText, REGISTRY), 'envelope_projection_invalid');
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

await test('review3 F1: 失败写信封删 projection + 对象型 projectionDropped 被拒绝，受控截断计数仍合法', async () => {
  // 真实适配层产出（voucher_create 缺账套 → 写类失败信封）
  const failure = await adapter.callModelTool('voucher_create', { period: '2026-01' });
  assert.equal(failure.ok, false);
  assert.equal(JSON.stringify(failure).includes(X.enterprise), false);

  // 旧漏洞：删 projection 后只在 projection 存在时才验 dropped → 对象型 dropped 直接穿出。
  const dangling = { ...failure };
  delete dangling.projection;
  dangling.projectionDropped = { enterprise: X.enterprise };
  expectFailure(validateModelEnvelope(dangling, REGISTRY), 'envelope_projection_invalid');
  const parsedDangling = parseModelEnvelope(JSON.stringify(dangling), REGISTRY);
  expectFailure(parsedDangling, 'envelope_projection_invalid');
  assertNoLeak(parsedDangling, 'dangling projectionDropped');
  assert.equal(JSON.stringify(parsedDangling.failure).includes('projectionDropped'), false);

  // 悬空但类型合法的计数也不接受：dropped 只能在 projection 存在时出现。
  const orphanCount = { ...failure };
  delete orphanCount.projection;
  expectFailure(validateModelEnvelope(orphanCount, REGISTRY), 'envelope_unexpected_field');

  // 有 projection 时 dropped 必须存在且是受控计数（0 ≤ 整数 ≤ 1e6）。
  for (const bad of [{ enterprise: X.enterprise }, '5', -1, 1.5, 1e9, null, true]) {
    expectFailure(
      validateModelEnvelope({ ...failure, projection: {}, projectionDropped: bad }, REGISTRY),
      'envelope_projection_invalid',
    );
  }
  const missingDropped = { ...failure };
  delete missingDropped.projectionDropped;
  expectFailure(validateModelEnvelope(missingDropped, REGISTRY), 'envelope_projection_invalid');
  const successMissingDropped = { ...invoice };
  delete successMissingDropped.projectionDropped;
  expectFailure(validateModelEnvelope(successMissingDropped, REGISTRY), 'envelope_projection_invalid');
  expectFailure(parseModelEnvelope(JSON.stringify(successMissingDropped), REGISTRY), 'envelope_projection_invalid');

  // 合法截断契约保留：成功查询 / 失败写的计数正例
  for (const dropped of [0, 7]) {
    const okQuery = validateModelEnvelope({ ...invoice, projectionDropped: dropped }, REGISTRY);
    assert.equal(okQuery.ok, true, `成功查询 dropped=${dropped} 应接受`);
    const okFailure = validateModelEnvelope({ ...failure, projection: {}, projectionDropped: dropped }, REGISTRY);
    assert.equal(okFailure.ok, true, `写失败 dropped=${dropped} 应接受`);
  }
});

await test('review3 F1: 访问器 / toJSON / 非普通原型 / Symbol 一律拒绝，且返回的是纯数据副本', async () => {
  // 1) 合法 query 信封的可选 tool 换成 enumerable getter：旧实现视为缺省并返回原对象 → JSON.stringify 触发泄漏。
  let toolGetterCalls = 0;
  const withToolGetter = { ...invoice };
  Object.defineProperty(withToolGetter, 'tool', {
    enumerable: true,
    get() { toolGetterCalls++; return X.enterprise; },
  });
  const getterChecked = validateModelEnvelope(withToolGetter, REGISTRY);
  expectFailure(getterChecked, 'envelope_invalid');
  assert.equal(toolGetterCalls, 0, '校验 / 快照阶段不得执行 getter');
  assertNoLeak(JSON.stringify(getterChecked), 'getter envelope result');

  // 2) 嵌套 projection 访问器：同样不执行，直接拒绝
  let nestedGetterCalls = 0;
  const nested = { ...invoice, projection: { ...invoice.projection } };
  Object.defineProperty(nested.projection, 'note', {
    enumerable: true,
    get() { nestedGetterCalls++; return X.summary; },
  });
  expectFailure(validateModelEnvelope(nested, REGISTRY), 'envelope_projection_invalid');
  assert.equal(nestedGetterCalls, 0);

  // 3) own toJSON（会改变 JSON.stringify 行为）既不在白名单，也不会被调用。
  const withToJson = { ...invoice, toJSON: () => ({ leaked: X.enterprise }) };
  expectFailure(validateModelEnvelope(withToJson, REGISTRY), 'envelope_unexpected_field');
  assert.equal(JSON.stringify(validateModelEnvelope(withToJson, REGISTRY)).includes(X.enterprise), false);

  // 4) 继承属性 / Symbol 键 / 函数值都不进信封
  const inherited = Object.assign(Object.create({ extra: X.enterprise }), { ...invoice });
  expectFailure(validateModelEnvelope(inherited, REGISTRY), 'envelope_invalid');
  const symbolKey = { ...invoice, [Symbol('synthetic')]: X.enterprise };
  expectFailure(validateModelEnvelope(symbolKey, REGISTRY), 'envelope_invalid');
  expectFailure(validateModelEnvelope({ ...invoice, projectionDropped: () => 0 }, REGISTRY), 'envelope_projection_invalid');

  // 5) 通过校验的返回是重建副本：改写副本不影响原对象，也不含额外行为。
  const checked = validateModelEnvelope(invoice, REGISTRY);
  assert.equal(checked.ok, true);
  assert.notEqual(checked.envelope, invoice);
  assert.notEqual(checked.envelope.projection, invoice.projection);
  assert.equal(Object.getPrototypeOf(checked.envelope), Object.prototype);
  assert.equal(Object.getPrototypeOf(checked.envelope.projection), Object.prototype);
  checked.envelope.projection.assets = 1;
  assert.equal(invoice.projection.assets, 1700);
  assertNoLeak(checked.envelope, 'rebuilt envelope');
  const reparsed = parseModelEnvelope(JSON.stringify(invoice), REGISTRY);
  assert.equal(reparsed.ok, true);
  assert.notEqual(reparsed.envelope, invoice);
  assertNoLeak(reparsed.envelope, 'reparsed envelope');
});

await test('review3 F1: 所有可选键在 success / failure / dropped 分支独立校验（矩阵）', async () => {
  const successWrite = await adapter.callModelTool('voucher_create', {
    accountSetId: 3, period: '2026-01', entries: [],
  });
  assert.equal(successWrite.ok, true);
  const failureWrite = await adapter.callModelTool('voucher_create', { period: '2026-01' });
  assert.equal(failureWrite.ok, false);
  const failureRead = await adapter.callModelTool('voucher_approve', {});
  assert.equal(failureRead.ok, false);
  const orphanDropped = { ...failureWrite };
  delete orphanDropped.projection;
  orphanDropped.projectionDropped = 3;

  const cases = [
    // 成功查询：写状态 / 错误 / 目录 / 结果来源都不适用
    ['query+applied', { ...invoice, applied: true }, 'envelope_unexpected_field'],
    ['query+appliedReason', { ...invoice, appliedReason: 'unverified_result' }, 'envelope_unexpected_field'],
    ['query+needsLocalReview', { ...invoice, needsLocalReview: false }, 'envelope_unexpected_field'],
    ['query+error', { ...invoice, error: { code: 'operation_failed', category: 'unknown', retriable: false, messageKey: 'operation_failed' } }, 'envelope_unexpected_field'],
    ['query+catalog', { ...invoice, catalog: { available: [], unimplemented: [], localExtensions: [] } }, 'envelope_unexpected_field'],
    ['query+source', { ...invoice, accountSetIdSource: 'result' }, 'envelope_unexpected_field'],
    ['query+rawErrorIncluded', { ...invoice, rawErrorIncluded: false }, 'envelope_unexpected_field'],
    ['query+badTool', { ...invoice, tool: 'voucher_create' }, 'envelope_invalid'],
    ['query+badNode', { ...invoice, nodeId: 'enterprise_account.bank' }, 'envelope_invalid'],
    ['query+refUnavailable', { ...invoice, refUnavailable: 'global_scope' }, 'envelope_ref_invalid'],
    ['query+badExpiry', { ...invoice, refExpiresAt: X.apiBase }, 'envelope_ref_invalid'],
    ['query+forgedRef', { ...invoice, localRef: 'finref_forged' }, 'envelope_ref_invalid'],
    ['query+badDropped', { ...invoice, projectionDropped: -1 }, 'envelope_projection_invalid'],
    ['query+badDroppedText', { ...invoice, projectionDropped: X.enterprise }, 'envelope_projection_invalid'],

    // 成功写：source 必须是 argument；状态自洽；投影/截断契约必须成对
    ['write+sourceResult', { ...successWrite, accountSetIdSource: 'result' }, 'envelope_unexpected_field'],
    ['write+sourceBad', { ...successWrite, accountSetIdSource: 'synthetic_private_source' }, 'envelope_invalid'],
    ['write+reasonOnApplied', { ...successWrite, appliedReason: 'unverified_result' }, 'envelope_status_invalid'],
    ['write+reviewTrue', { ...successWrite, needsLocalReview: true }, 'envelope_status_invalid'],
    ['write+catalog', { ...successWrite, catalog: { available: [], unimplemented: [], localExtensions: [] } }, 'envelope_unexpected_field'],
    ['write+error', { ...successWrite, error: { code: 'operation_failed', category: 'unknown', retriable: false, messageKey: 'operation_failed' } }, 'envelope_unexpected_field'],

    // 失败写：projection / dropped / 状态 / 来源 / 目录都不因“失败”而放宽
    ['failureWrite+orphanDropped', orphanDropped, 'envelope_unexpected_field'],
    ['failureWrite+badProjection', { ...failureWrite, projection: { note: X.summary } }, 'envelope_projection_invalid'],
    ['failureWrite+missingDropped', { ...failureWrite, projectionDropped: undefined }, 'envelope_projection_invalid'],
    ['failureWrite+badReason', { ...failureWrite, appliedReason: 'synthetic_private_reason' }, 'envelope_status_invalid'],
    ['failureWrite+sourceResult', { ...failureWrite, accountSetIdSource: 'result' }, 'envelope_unexpected_field'],
    ['failureWrite+catalog', { ...failureWrite, catalog: { available: [], unimplemented: [], localExtensions: [] } }, 'envelope_unexpected_field'],
    ['failureWrite+refString', { ...failureWrite, localRef: `finref_${'a'.repeat(48)}` }, 'envelope_ref_invalid'],
    ['failureWrite+badUnavailable', { ...failureWrite, refUnavailable: 'synthetic_private_token' }, 'envelope_ref_invalid'],

    // 失败只读：引用 / 投影 / 状态 / 目录 / 来源全不适用
    ['failureRead+projection', { ...failureRead, projection: {} }, 'envelope_unexpected_field'],
    ['failureRead+dropped', { ...failureRead, projectionDropped: 0 }, 'envelope_unexpected_field'],
    ['failureRead+applied', { ...failureRead, applied: false }, 'envelope_unexpected_field'],
    ['failureRead+reason', { ...failureRead, appliedReason: 'unverified_result' }, 'envelope_unexpected_field'],
    ['failureRead+localRef', { ...failureRead, localRef: null }, 'envelope_unexpected_field'],
    ['failureRead+persistence', { ...failureRead, refPersistence: 'none' }, 'envelope_ref_invalid'],
    ['failureRead+unavailable', { ...failureRead, refUnavailable: 'global_scope' }, 'envelope_ref_invalid'],
    ['failureRead+catalog', { ...failureRead, catalog: { available: [], unimplemented: [], localExtensions: [] } }, 'envelope_unexpected_field'],
    ['failureRead+source', { ...failureRead, accountSetIdSource: 'result' }, 'envelope_unexpected_field'],
    ['failureRead+errorExtra', { ...failureRead, error: { ...failureRead.error, extra: 1 } }, 'envelope_error_shape_invalid'],
  ];
  for (const [label, envelope, code] of cases) {
    const plain = JSON.parse(JSON.stringify(envelope));
    try {
      expectFailure(validateModelEnvelope(envelope, REGISTRY), code);
      expectFailure(parseModelEnvelope(JSON.stringify(plain), REGISTRY), code);
    } catch (error) {
      throw new Error(`[${label}] ${error.message}`);
    }
  }
});

await test('ID 可表示性边界：projection 数值上限 1e12 内的 ID 数组可通过，超界 ID 被拒', async () => {
  const context = await adapter.callModelTool('account_context', { limit: 1 });
  assert.equal(context.ok, true);
  const atLimit = JSON.parse(JSON.stringify(context));
  atLimit.projection = {
    ...atLimit.projection,
    accountSetCount: 2,
    returnedCount: 2,
    truncated: false,
    hasNextPage: false,
    accountSetIds: [999_999_999_999, 1_000_000_000_000],
    startPeriods: ['2026-12', '2026-01'],
    taxpayerTypes: ['small_scale', 'general'],
    accountingStandards: ['small_business', 'enterprise'],
    displayNameFlags: [true, true],
  };
  delete atLimit.projection.nextOffset;
  assert.equal(validateModelEnvelope(atLimit, REGISTRY).ok, true, '上限内的 ID 数组应被接受');

  // 超界 ID 无法用 projection 的有限数值表示：信封层硬拒，不能被静默丢成空选择列表。
  const over = JSON.parse(JSON.stringify(atLimit));
  over.projection.accountSetIds = [1_000_000_000_001];
  over.projection.returnedCount = 1;
  expectFailure(validateModelEnvelope(over, REGISTRY), 'envelope_projection_invalid');
});

await test('最后副本一致性：校验的必须就是返回的（可变反射输入不得返回未校验副本）', () => {
  // 1) 精确复现：合法 query 对象，adapter 的 getOwnPropertyDescriptor 先返回合法版本串，
  //    之后返回普通对象。旧实现「先校验原对象、再快照原对象」，返回的副本从未被校验，
  //    结果 ok:true 且带回一个不符合固定类型的 adapter。
  const legalAdapter = invoice.adapter;
  let adapterReads = 0;
  const shifting = new Proxy({ ...invoice }, {
    ownKeys(target) { return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      if (key === 'adapter') {
        adapterReads++;
        if (adapterReads >= 2) {
          return { configurable: true, enumerable: true, writable: true, value: { leak: X.enterprise } };
        }
      }
      return Object.getOwnPropertyDescriptor(target, key);
    },
  });
  const shifted = validateModelEnvelope(shifting, REGISTRY);
  assert.ok(adapterReads >= 1, '校验必然读过 adapter');
  if (shifted.ok) {
    // 一旦接受，返回对象里的每个字段都必须是校验过的值（不是后来换上的对象）。
    assert.equal(shifted.envelope.adapter, legalAdapter);
    assertNoLeak(shifted.envelope, 'shifting adapter envelope');
  } else {
    assertNoLeak(shifted.failure, 'shifting adapter failure');
  }

  // 2) 同一手法用在嵌套 projection 上：返回的金额只能是校验过的那个值。
  let assetsReads = 0;
  const shiftingProjection = new Proxy({ ...invoice.projection }, {
    ownKeys(target) { return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      if (key === 'assets') {
        assetsReads++;
        if (assetsReads >= 3) {
          return { configurable: true, enumerable: true, writable: true, value: X.enterprise };
        }
      }
      return Object.getOwnPropertyDescriptor(target, key);
    },
  });
  const shiftedNested = validateModelEnvelope({ ...invoice, projection: shiftingProjection }, REGISTRY);
  assert.ok(assetsReads >= 1, '校验必然读过 projection.assets');
  if (shiftedNested.ok) {
    assert.equal(shiftedNested.envelope.projection.assets, invoice.projection.assets);
    assertNoLeak(shiftedNested.envelope, 'shifting projection envelope');
  } else {
    assertNoLeak(shiftedNested.failure, 'shifting projection failure');
  }

  // 3) 状态可变但**始终合法**的输入：接受时返回对象必须逐字段满足实际契约，
  //    再校验一次仍然通过且完全等于返回值（不存在只校验了别的对象的字段）。
  let flips = 0;
  const flipping = new Proxy({ ...invoice }, {
    ownKeys(target) { return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      if (key === 'projection') {
        flips++;
        return {
          configurable: true, enumerable: true, writable: true,
          value: { ...invoice.projection, assets: flips % 2 === 0 ? 1700 : 1800 },
        };
      }
      return Object.getOwnPropertyDescriptor(target, key);
    },
  });
  const flipped = validateModelEnvelope(flipping, REGISTRY);
  if (flipped.ok) {
    const assetsValue = flipped.envelope.projection.assets;
    assert.ok(assetsValue === 1700 || assetsValue === 1800, `返回的 assets 必须落在合法值域：${assetsValue}`);
    const rechecked = validateModelEnvelope(flipped.envelope, REGISTRY);
    assert.equal(rechecked.ok, true, '返回对象自身必须再次通过完整校验');
    assert.deepEqual(rechecked.envelope, flipped.envelope);
  } else {
    assertNoLeak(flipped.failure, 'flipping envelope failure');
  }

  // 4) 普通 plain JSON 正例不受影响：仍然是接受 + 纯数据副本。
  const plainChecked = validateModelEnvelope(JSON.parse(JSON.stringify(invoice)), REGISTRY);
  assert.equal(plainChecked.ok, true);
  assert.equal(plainChecked.envelope.adapter, legalAdapter);
  assertNoLeak(plainChecked.envelope, 'plain JSON envelope');
});

console.log(`\nFinance model transport test: ${results.filter(Boolean).length}/${results.length} passed`);
if (results.some((passed) => !passed)) process.exitCode = 1;
