// LOCAL-02 期末完整性 MCP 真实链路：stdio MCP → 生产 HTTP 后端 → Agent 工具 → SQLite。
// 只用临时合成库与随机回环端口，不连接旧后端、真实账套、凭据或税局接口。
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

/** 启动隔离后端（临时目录 + PORT=0），返回可用的 MCP 客户端。 */
async function withBackend(run) {
  const directory = mkdtempSync(join(tmpdir(), 'accounting-period-mcp-'));
  let child, client, stopped;
  try {
    child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, WORKBENCH_DATA_DIR: directory, PORT: '0', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
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
    client = new McpStdioClient(join(here, 'server.mjs'), {
      env: { FINANCE_API_BASE: `http://127.0.0.1:${port}` }, cwd: here,
    }).start();
    await client.initialize('accounting-period-synthetic-test');
    await run(client, `http://127.0.0.1:${port}`);
  } finally {
    if (client) await client.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (stopped) await stopped;
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function ok(client, name, args) {
  const r = await client.call(name, args);
  assert.equal(r.isError, false, r.text);
  return r.data;
}
async function fails(client, name, args, expected) {
  const r = await client.call(name, args);
  assert.equal(r.isError, true, `expected failure for ${name}: ${r.text}`);
  assert.match(r.text, expected);
  return r;
}

test('期末完整性工具与资产补项工具已公布严格 schema（不在 MCP 本地伪造执行）', () => {
  const check = TOOLS.find((t) => t.name === 'period_end_check');
  assert.ok(check, 'period_end_check 必须公布');
  assert.equal(check.status, 'available');
  assert.equal(check.origin, 'local');
  assert.deepEqual(check.inputSchema.required, ['accountSetId', 'period']);
  assert.doesNotMatch(check.description, /税局已接入/);

  const update = TOOLS.find((t) => t.name === 'asset_update');
  assert.ok(update, 'asset_update 必须公布');
  assert.equal(update.status, 'available');
  assert.equal(update.origin, 'local');
  assert.deepEqual(update.inputSchema.required, ['accountSetId', 'assetId']);
  assert.deepEqual(validateArgs(update.inputSchema, { accountSetId: 1, assetId: 2 }), []);
  assert.ok(validateArgs(update.inputSchema, { accountSetId: 1 }).length >= 1);

  const create = TOOLS.find((t) => t.name === 'asset_create');
  assert.ok(create.inputSchema.properties.acquired_period, 'asset_create 必须支持显式取得期间');
  assert.deepEqual(create.inputSchema.properties.ledger_status.enum, ['booked', 'pending_purchase_voucher']);
  // 寿命是**技术输入边界**（非“法定会计年限”）：MCP 层先拦 2^32 这类巨大值，不交给后端落库后才报错。
  assert.equal(create.inputSchema.properties.useful_life_months.maximum, 1200);
  assert.equal(create.inputSchema.properties.useful_life_months.minimum, 1);
  const lifeProblems = validateArgs(create.inputSchema, {
    accountSetId: 1, name: 'x', original_cost: 1, useful_life_months: 4294967296, start_period: '2026-01',
  });
  assert.ok(lifeProblems.some((m) => /不能大于/.test(m)), JSON.stringify(lifeProblems));
  assert.ok(validateArgs(create.inputSchema, {
    accountSetId: 1, name: 'x', original_cost: 1, useful_life_months: 1200, start_period: '2026-01',
  }).length === 0, '边界 1200 合法');
});

test('MCP 两个月完整链：计提 → 结转 → 期末检查 → 封账；缺步骤与封账后写入口一致拒绝', async () => {
  await withBackend(async (client) => {
    const listed = await client.rpc('tools/list');
    for (const name of ['period_end_check', 'asset_update']) {
      assert.ok(listed.result.tools.some((t) => t.name === name), name);
    }

    const set = await ok(client, 'account_set_create', { name: 'MCP 期末合成公司', start_period: '2026-01' });
    const setId = set.id;
    await ok(client, 'opening_balance_set', {
      accountSetId: setId,
      items: [{ code: '1002', debit: 100000, credit: 0 }, { code: '3001', debit: 0, credit: 100000 }],
    });
    await ok(client, 'voucher_create', {
      accountSetId: setId, period: '2026-01', voucher_date: '2026-01-05', summary: '购入设备', status: 'posted',
      entries: [{ code: '1601', debit: 60000, credit: 0 }, { code: '1002', debit: 0, credit: 60000 }],
    });
    const card = await ok(client, 'asset_create', {
      accountSetId: setId, kind: 'fixed', name: 'MCP 合成设备', original_cost: 60000,
      residual_rate: 0.05, useful_life_months: 60, start_period: '2026-01', acquired_period: '2026-01',
    });
    assert.equal(card.depreciable, 57000);
    assert.equal(card.monthly, 950);

    // 缺计提：期末检查与封账入口都给出同一结论。
    const beforeClose = await ok(client, 'period_end_check', { accountSetId: setId, period: '2026-01' });
    assert.equal(beforeClose.ready, false);
    assert.ok(beforeClose.blocking.some((b) => b.code === 'depreciation_missing'
      && b.details.dueAmount === 950), JSON.stringify(beforeClose.blocking));
    await fails(client, 'period_set_status', { accountSetId: setId, period: '2026-01', status: 'closed' },
      /period_end_check_failed/);

    const dep = await ok(client, 'depreciation_run', { accountSetId: setId, period: '2026-01' });
    assert.equal(dep.voucher.total_debit, 950);
    await ok(client, 'voucher_create', {
      accountSetId: setId, period: '2026-01', voucher_date: '2026-01-20', summary: '销售商品', status: 'posted',
      entries: [
        { code: '1122', debit: 11300, credit: 0 },
        { code: '5001', debit: 0, credit: 10000 },
        { code: '2221', debit: 0, credit: 1300 },
      ],
    });
    // 缺损益结转：同样阻止封账，并指出具体步骤。
    const missingCarry = await ok(client, 'period_end_check', { accountSetId: setId, period: '2026-01' });
    assert.ok(missingCarry.blocking.some((b) => b.code === 'profit_not_carried_forward'), JSON.stringify(missingCarry.blocking));
    await fails(client, 'period_set_status', { accountSetId: setId, period: '2026-01', status: 'closed' },
      /profit_not_carried_forward/);

    const carry = await ok(client, 'carry_forward_profit', { accountSetId: setId, period: '2026-01' });
    assert.equal(carry.profit, 9050); // 手算：10000 − 950
    const ready = await ok(client, 'period_end_check', { accountSetId: setId, period: '2026-01' });
    assert.equal(ready.ready, true, JSON.stringify(ready.blocking));
    assert.deepEqual(await ok(client, 'period_set_status', { accountSetId: setId, period: '2026-01', status: 'closed' }),
      { accountSetId: setId, period: '2026-01', status: 'closed' });

    // 封账后：写入与重复计提都被拒绝。
    await fails(client, 'voucher_create', {
      accountSetId: setId, period: '2026-01', status: 'draft',
      entries: [{ code: '1002', debit: 1, credit: 0 }, { code: '3001', debit: 0, credit: 1 }],
    }, /period_closed/);
    await fails(client, 'depreciation_run', { accountSetId: setId, period: '2026-01' }, /period_closed/);

    // 二月：连续一个月完整链。
    assert.equal((await ok(client, 'depreciation_run', { accountSetId: setId, period: '2026-02' })).voucher.total_debit, 950);
    await ok(client, 'voucher_create', {
      accountSetId: setId, period: '2026-02', voucher_date: '2026-02-18', summary: '销售商品', status: 'posted',
      entries: [
        { code: '1122', debit: 22600, credit: 0 },
        { code: '5001', debit: 0, credit: 20000 },
        { code: '2221', debit: 0, credit: 2600 },
      ],
    });
    assert.equal((await ok(client, 'carry_forward_profit', { accountSetId: setId, period: '2026-02' })).profit, 19050);
    const income = await ok(client, 'finance_query', {
      nodeId: 'report.income_statement', accountSetId: setId, period: '2026-02',
    });
    assert.equal(income.data.current['净利润'], 19050);
    assert.equal(income.data.ytd['净利润'], 28100); // 9050 + 19050
    assert.equal((await ok(client, 'period_end_check', { accountSetId: setId, period: '2026-02' })).ready, true);
    await ok(client, 'period_set_status', { accountSetId: setId, period: '2026-02', status: 'closed' });

    // 更晚期间已封账：不能重开前期。
    const reopen = await fails(client, 'period_set_status', { accountSetId: setId, period: '2026-01', status: 'open' },
      /later_period_closed/);
    assert.match(reopen.text, /2026-02/);

    // 资产补项：已封账期间的事实维护被拒绝（先按倒序反结账）；纯显示信息可维护。
    await fails(client, 'asset_update', {
      accountSetId: setId, assetId: card.id, patch: { original_cost: 61000 },
    }, /asset_card_affects_closed_period/);
    await fails(client, 'asset_update', {
      accountSetId: setId, assetId: card.id, patch: { acquired_period: '2025-12' },
    }, /asset_card_affects_closed_period/);
    const noted = await ok(client, 'asset_update', {
      accountSetId: setId, assetId: card.id, patch: { ledger_note: 'MCP 复核' },
    });
    assert.equal(noted.ledger_note, 'MCP 复核');
    assert.equal(noted.original_cost, 60000);
    // 按倒序反结账后：原值仍被已过账计提锁住，取得期间 / 备注可维护。
    await ok(client, 'period_set_status', { accountSetId: setId, period: '2026-02', status: 'open' });
    await ok(client, 'period_set_status', { accountSetId: setId, period: '2026-01', status: 'open' });
    await fails(client, 'asset_update', {
      accountSetId: setId, assetId: card.id, patch: { original_cost: 61000 },
    }, /asset_card_locked_by_posted_runs/);
    const updated = await ok(client, 'asset_update', {
      accountSetId: setId, assetId: card.id, patch: { acquired_period: '2025-12', ledger_note: 'MCP 复核' },
    });
    assert.equal(updated.acquired_period, '2025-12');
    assert.equal(updated.ledger_note, 'MCP 复核');
    assert.equal(updated.original_cost, 60000);
  });
});

test('MCP 负例：未入账登记不得计提 / 封账；后期普通结转依赖前期累计（真实入口）', async () => {
  await withBackend(async (client) => {
    // F4：未入账登记不是原值差异豁免。
    const f4 = await ok(client, 'account_set_create', { name: 'MCP F4 待补凭证公司', start_period: '2026-01' });
    await ok(client, 'opening_balance_set', { accountSetId: f4.id, items: [
      { code: '1002', debit: 1000, credit: 0 }, { code: '3001', debit: 0, credit: 1000 },
    ] });
    await ok(client, 'asset_create', {
      accountSetId: f4.id, kind: 'fixed', name: '待补购入设备', original_cost: 600,
      residual_rate: 0, useful_life_months: 60, start_period: '2026-01', acquired_period: '2026-01',
      ledger_status: 'pending_purchase_voucher', ledger_note: '购入凭证待补',
    });
    const f4check = await ok(client, 'period_end_check', { accountSetId: f4.id, period: '2026-01' });
    assert.ok(f4check.blocking.some((b) => b.code === 'asset_cost_mismatch'), JSON.stringify(f4check.blocking));
    assert.ok(f4check.blocking.some((b) => b.code === 'asset_purchase_voucher_pending'));
    await fails(client, 'depreciation_run', { accountSetId: f4.id, period: '2026-01' }, /asset_ledger_pending/);
    await fails(client, 'period_set_status', { accountSetId: f4.id, period: '2026-01', status: 'closed' },
      /period_end_check_failed/);

    // F2：普通后期结转读取累计余额，因此前期反过账被明确拒绝并给撤销顺序。
    const f2 = await ok(client, 'account_set_create', { name: 'MCP F2 依赖公司', start_period: '2026-01' });
    await ok(client, 'opening_balance_set', { accountSetId: f2.id, items: [
      { code: '1002', debit: 1000, credit: 0 }, { code: '3001', debit: 0, credit: 1000 },
    ] });
    const jan = await ok(client, 'voucher_create', {
      accountSetId: f2.id, period: '2026-01', status: 'posted',
      entries: [{ code: '1002', debit: 100, credit: 0 }, { code: '5001', debit: 0, credit: 100 }],
    });
    await ok(client, 'voucher_create', {
      accountSetId: f2.id, period: '2026-02', status: 'posted',
      entries: [{ code: '1002', debit: 20, credit: 0 }, { code: '5001', debit: 0, credit: 20 }],
    });
    const febCarry = await ok(client, 'carry_forward_profit', { accountSetId: f2.id, period: '2026-02' });
    assert.equal(febCarry.profit, 120); // 手算：一月 100 + 二月 20
    const denied = await fails(client, 'voucher_unpost', { accountSetId: f2.id, voucherId: jan.id },
      /later_profit_carryforward_depends_on_period/);
    assert.match(denied.text, /反过账/);
    // 正确顺序：反过账后期结转 → 撤销前期 → 重新结转。
    await ok(client, 'voucher_unpost', { accountSetId: f2.id, voucherId: febCarry.voucher.id });
    await ok(client, 'voucher_unpost', { accountSetId: f2.id, voucherId: jan.id });
    assert.equal((await ok(client, 'carry_forward_profit', { accountSetId: f2.id, period: '2026-02' })).profit, 20);
  });
});

test('MCP 负例：旧折旧草稿重过账 / 亚分金额 / 大寿命（真实链路）', async () => {
  await withBackend(async (client) => {
    // ---- P1：反过账后改寿命，旧草稿不得重过账，必须删除后重算 ----
    const set = await ok(client, 'account_set_create', { name: 'MCP P1 旧草稿公司', start_period: '2026-01' });
    await ok(client, 'opening_balance_set', { accountSetId: set.id, items: [
      { code: '1601', debit: 100, credit: 0 }, { code: '3001', debit: 0, credit: 100 },
    ] });
    const card = await ok(client, 'asset_create', {
      accountSetId: set.id, kind: 'fixed', name: 'MCP 旧草稿设备', original_cost: 100,
      residual_rate: 0, useful_life_months: 10, start_period: '2026-01', acquired_period: '2026-01',
    });
    assert.equal(card.monthly, 10); // 手算：100 ÷ 10
    const dep = await ok(client, 'depreciation_run', { accountSetId: set.id, period: '2026-01' });
    assert.equal(dep.voucher.total_debit, 10);
    await ok(client, 'voucher_unpost', { accountSetId: set.id, voucherId: dep.voucher.id });
    assert.equal((await ok(client, 'asset_update', {
      accountSetId: set.id, assetId: card.id, patch: { useful_life_months: 5 },
    })).monthly, 20);
    const denied = await fails(client, 'voucher_post', { accountSetId: set.id, voucherId: dep.voucher.id },
      /depreciation_run_stale/);
    assert.match(denied.text, /2026-01/);
    const blocked = await ok(client, 'period_end_check', { accountSetId: set.id, period: '2026-01' });
    assert.equal(blocked.ready, false);
    assert.ok(blocked.blocking.some((b) => b.code === 'depreciation_draft_exists'), JSON.stringify(blocked.blocking));
    await fails(client, 'period_set_status', { accountSetId: set.id, period: '2026-01', status: 'closed' },
      /period_has_draft_vouchers/);
    // 可行解除路径：删除旧草稿 → 重新计提 20 → 结转 → 封账。
    await ok(client, 'voucher_delete', { accountSetId: set.id, voucherId: dep.voucher.id });
    assert.equal((await ok(client, 'depreciation_run', { accountSetId: set.id, period: '2026-01' })).voucher.total_debit, 20);
    await ok(client, 'carry_forward_profit', { accountSetId: set.id, period: '2026-01' });
    assert.equal((await ok(client, 'period_end_check', { accountSetId: set.id, period: '2026-01' })).ready, true);
    await ok(client, 'period_set_status', { accountSetId: set.id, period: '2026-01', status: 'closed' });

    // ---- P2：亚分金额逐字段拒绝 ----
    const p2 = await ok(client, 'account_set_create', { name: 'MCP P2 亚分公司', start_period: '2026-01' });
    await fails(client, 'voucher_create', {
      accountSetId: p2.id, period: '2026-01', status: 'posted',
      entries: [{ code: '1002', debit: 1, credit: 0.001 }, { code: '1001', debit: 0.001, credit: 1 }],
    }, /不足一分/);
    const check = await ok(client, 'voucher_check', {
      accountSetId: p2.id,
      entries: [{ code: '1002', debit: 1 }, { code: '1001', credit: 0.0049 }],
    });
    assert.equal(check.ok, false);
    assert.match(JSON.stringify(check.errors), /不足一分/);
    // 正常边界保留：0.005 → 0.01
    const okVoucher = await ok(client, 'voucher_create', {
      accountSetId: p2.id, period: '2026-01', status: 'posted',
      entries: [{ code: '1002', debit: 0.005 }, { code: '1001', credit: 0.005 }],
    });
    assert.equal(okVoucher.total_debit, 0.01);

    // ---- P4：大寿命在 MCP 参数层就被拦住；patch 路径由后端边界拒绝，且不留半张卡片 ----
    const p4 = await ok(client, 'account_set_create', { name: 'MCP P4 寿命边界公司', start_period: '2026-01' });
    await fails(client, 'asset_create', {
      accountSetId: p4.id, kind: 'fixed', name: '寿命非法设备', original_cost: 100, residual_rate: 0,
      useful_life_months: 4294967296, start_period: '2026-01', acquired_period: '2026-01',
    }, /不能大于 1200/);
    assert.equal((await ok(client, 'asset_list', { accountSetId: p4.id })).length, 0, '非法寿命不得落库');
    const edge = await ok(client, 'asset_create', {
      accountSetId: p4.id, kind: 'fixed', name: '边界寿命设备', original_cost: 1200, residual_rate: 0,
      useful_life_months: 1200, start_period: '2026-01', acquired_period: '2026-01',
    });
    assert.equal(edge.monthly, 1);
    await fails(client, 'asset_update', {
      accountSetId: p4.id, assetId: edge.id, patch: { useful_life_months: 4294967296 },
    }, /useful_life_months_out_of_range/);
    const listed = await ok(client, 'asset_list', { accountSetId: p4.id });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].useful_life_months, 1200, '更新失败必须完整回滚');
  });
});

test('MCP 负例：无资产 / 无损益标 not_applicable；缺省 period 与未知账套给出稳定错误', async () => {
  await withBackend(async (client) => {
    const set = await ok(client, 'account_set_create', { name: 'MCP 空账套', start_period: '2026-01' });
    const check = await ok(client, 'period_end_check', { accountSetId: set.id, period: '2026-01' });
    assert.equal(check.ready, true);
    const byId = Object.fromEntries(check.steps.map((s) => [s.id, s]));
    assert.equal(byId.depreciation.status, 'not_applicable');
    assert.equal(byId.asset_reconciliation.status, 'not_applicable');
    assert.equal(byId.profit_carry_forward.status, 'not_applicable');
    assert.equal(byId.year_end_carry_forward.status, 'not_applicable');
    assert.ok(byId.depreciation.reason);

    await fails(client, 'period_end_check', { accountSetId: set.id }, /period/);
    await fails(client, 'period_end_check', { accountSetId: set.id, period: '2026-13' }, /period_invalid/);
    await fails(client, 'period_end_check', { accountSetId: 999999, period: '2026-01' }, /account_set_not_found/);
    await fails(client, 'asset_update', { accountSetId: set.id }, /assetId/);
  });
});
