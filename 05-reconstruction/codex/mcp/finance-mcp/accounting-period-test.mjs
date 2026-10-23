// LOCAL-02 期末完整性 MCP 真实链路：stdio MCP → 生产 HTTP 后端 → Agent 工具 → SQLite。
// LOCAL-08 起普通工具返回模型投影信封：摘要 / 固定码直接断言 projection，
// 逐条原因（dueAmount / reason / ledger_note 等）经本机引用接口或本机 raw 通道核对。
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
    const base = `http://127.0.0.1:${port}`;
    client = new McpStdioClient(join(here, 'server.mjs'), {
      env: { FINANCE_API_BASE: base }, cwd: here,
    }).start();
    await client.initialize('accounting-period-synthetic-test');
    await run(client, base);
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
  assert.equal(r.data?.ok, true, r.text);
  return r.data;
}
async function fails(client, name, args, code) {
  const r = await client.call(name, args);
  assert.equal(r.isError, true, `expected failure for ${name}: ${r.text}`);
  const actual = typeof r.data?.error === 'string' ? r.data.error : r.data?.error?.code;
  assert.equal(actual, code, `${name} 错误码应为 ${code}，实际 ${actual}：${r.text}`);
  return r;
}
async function localValue(base, envelope, label = envelope?.tool) {
  assert.match(String(envelope?.localRef), /^finref_[a-f0-9]{48}$/, `${label} 应有 localRef`);
  const res = await fetch(`${base}/api/finance-output/read`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: envelope.localRef, accountSetId: envelope.accountSetId, operation: envelope.operation }),
  });
  const data = await res.json();
  assert.equal(res.status, 200, `${label} 本机读取应 200：${JSON.stringify(data)}`);
  return data.value;
}
async function rawAgent(base, name, args) {
  const res = await fetch(`${base}/agent/tools/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args),
  });
  return { status: res.status, text: await res.text() };
}
const stepStatus = (check, id) => {
  const index = check.projection.stepIds.indexOf(id);
  assert.notEqual(index, -1, `缺少步骤 ${id}`);
  return check.projection.stepStatuses[index];
};

test('期末完整性工具与资产补项工具已公布严格 schema（不在 MCP 本地伪造执行）', () => {
  const check = TOOLS.find((t) => t.name === 'period_end_check');
  assert.ok(check, 'period_end_check 必须公布');
  assert.equal(check.status, 'available');
  assert.equal(check.origin, 'local');
  assert.deepEqual(check.inputSchema.required, ['accountSetId', 'period']);
  assert.doesNotMatch(check.description, /税局已接入/);
  assert.match(check.description, /localRef|摘要/);

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
  await withBackend(async (client, base) => {
    const listed = await client.rpc('tools/list');
    for (const name of ['period_end_check', 'asset_update']) {
      assert.ok(listed.result.tools.some((t) => t.name === name), name);
    }

    const set = await ok(client, 'account_set_create', { name: 'MCP 期末合成公司', start_period: '2026-01' });
    const setId = set.accountSetId;
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
    const cardRaw = await localValue(base, card, 'asset_create');
    assert.equal(cardRaw.depreciable, 57000);
    assert.equal(cardRaw.monthly, 950);
    const cardId = card.projection.assetId;

    // 缺计提：期末检查与封账入口都给出同一结论。
    const beforeClose = await ok(client, 'period_end_check', { accountSetId: setId, period: '2026-01' });
    assert.equal(beforeClose.projection.ready, false);
    assert.ok(beforeClose.projection.blockingCodes.includes('depreciation_missing'), JSON.stringify(beforeClose.projection));
    const beforeCloseRaw = await localValue(base, beforeClose, 'period_end_check');
    assert.equal(beforeCloseRaw.blocking.find((b) => b.code === 'depreciation_missing').details.dueAmount, 950);
    await fails(client, 'period_set_status', { accountSetId: setId, period: '2026-01', status: 'closed' },
      'period_end_check_failed');

    const dep = await ok(client, 'depreciation_run', { accountSetId: setId, period: '2026-01' });
    assert.equal(dep.projection.totalAmount, 950);
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
    assert.ok(missingCarry.projection.blockingCodes.includes('profit_not_carried_forward'), JSON.stringify(missingCarry.projection));
    await fails(client, 'period_set_status', { accountSetId: setId, period: '2026-01', status: 'closed' },
      'period_end_check_failed');

    const carry = await ok(client, 'carry_forward_profit', { accountSetId: setId, period: '2026-01' });
    assert.equal(carry.projection.profit, 9050); // 手算：10000 − 950
    const ready = await ok(client, 'period_end_check', { accountSetId: setId, period: '2026-01' });
    assert.equal(ready.projection.ready, true, JSON.stringify(ready.projection.blockingCodes));
    const closed = await ok(client, 'period_set_status', { accountSetId: setId, period: '2026-01', status: 'closed' });
    assert.deepEqual(closed.projection, { period: '2026-01', status: 'closed' });

    // 封账后：写入与重复计提都被拒绝。
    await fails(client, 'voucher_create', {
      accountSetId: setId, period: '2026-01', status: 'draft',
      entries: [{ code: '1002', debit: 1, credit: 0 }, { code: '3001', debit: 0, credit: 1 }],
    }, 'period_closed');
    await fails(client, 'depreciation_run', { accountSetId: setId, period: '2026-01' }, 'period_closed');

    // 二月：连续一个月完整链。
    assert.equal((await ok(client, 'depreciation_run', { accountSetId: setId, period: '2026-02' })).projection.totalAmount, 950);
    await ok(client, 'voucher_create', {
      accountSetId: setId, period: '2026-02', voucher_date: '2026-02-18', summary: '销售商品', status: 'posted',
      entries: [
        { code: '1122', debit: 22600, credit: 0 },
        { code: '5001', debit: 0, credit: 20000 },
        { code: '2221', debit: 0, credit: 2600 },
      ],
    });
    assert.equal((await ok(client, 'carry_forward_profit', { accountSetId: setId, period: '2026-02' })).projection.profit, 19050);
    const income = await ok(client, 'finance_query', {
      nodeId: 'report.income_statement', accountSetId: setId, period: '2026-02',
    });
    assert.equal(income.projection.currentNetProfit, 19050);
    assert.equal(income.projection.ytdNetProfit, 28100); // 9050 + 19050
    assert.equal((await ok(client, 'period_end_check', { accountSetId: setId, period: '2026-02' })).projection.ready, true);
    await ok(client, 'period_set_status', { accountSetId: setId, period: '2026-02', status: 'closed' });

    // 更晚期间已封账：不能重开前期。
    await fails(client, 'period_set_status', { accountSetId: setId, period: '2026-01', status: 'open' },
      'later_period_closed');
    const reopenRaw = await rawAgent(base, 'period_set_status', { accountSetId: setId, period: '2026-01', status: 'open' });
    assert.match(reopenRaw.text, /2026-02/);

    // 资产补项：已封账期间的事实维护被拒绝（先按倒序反结账）；纯显示信息可维护。
    await fails(client, 'asset_update', {
      accountSetId: setId, assetId: cardId, patch: { original_cost: 61000 },
    }, 'asset_card_affects_closed_period');
    await fails(client, 'asset_update', {
      accountSetId: setId, assetId: cardId, patch: { acquired_period: '2025-12' },
    }, 'asset_card_affects_closed_period');
    const noted = await ok(client, 'asset_update', {
      accountSetId: setId, assetId: cardId, patch: { ledger_note: 'MCP 复核' },
    });
    assert.equal(noted.projection.originalCost, 60000);
    const notedRaw = await localValue(base, noted, 'asset_update');
    assert.equal(notedRaw.ledger_note, 'MCP 复核');
    assert.equal(notedRaw.original_cost, 60000);
    // 按倒序反结账后：原值仍被已过账计提锁住，取得期间 / 备注可维护。
    await ok(client, 'period_set_status', { accountSetId: setId, period: '2026-02', status: 'open' });
    await ok(client, 'period_set_status', { accountSetId: setId, period: '2026-01', status: 'open' });
    await fails(client, 'asset_update', {
      accountSetId: setId, assetId: cardId, patch: { original_cost: 61000 },
    }, 'asset_card_locked_by_posted_runs');
    const updated = await ok(client, 'asset_update', {
      accountSetId: setId, assetId: cardId, patch: { acquired_period: '2025-12', ledger_note: 'MCP 复核' },
    });
    assert.equal(updated.projection.acquiredPeriod, '2025-12');
    assert.equal(updated.projection.originalCost, 60000);
    const updatedRaw = await localValue(base, updated, 'asset_update');
    assert.equal(updatedRaw.acquired_period, '2025-12');
    assert.equal(updatedRaw.ledger_note, 'MCP 复核');
  });
});

test('MCP 负例：未入账登记不得计提 / 封账；后期普通结转依赖前期累计（真实入口）', async () => {
  await withBackend(async (client, base) => {
    // F4：未入账登记不是原值差异豁免。
    const f4 = await ok(client, 'account_set_create', { name: 'MCP F4 待补凭证公司', start_period: '2026-01' });
    await ok(client, 'opening_balance_set', { accountSetId: f4.accountSetId, items: [
      { code: '1002', debit: 1000, credit: 0 }, { code: '3001', debit: 0, credit: 1000 },
    ] });
    await ok(client, 'asset_create', {
      accountSetId: f4.accountSetId, kind: 'fixed', name: '待补购入设备', original_cost: 600,
      residual_rate: 0, useful_life_months: 60, start_period: '2026-01', acquired_period: '2026-01',
      ledger_status: 'pending_purchase_voucher', ledger_note: '购入凭证待补',
    });
    const f4check = await ok(client, 'period_end_check', { accountSetId: f4.accountSetId, period: '2026-01' });
    assert.ok(f4check.projection.blockingCodes.includes('asset_cost_mismatch'), JSON.stringify(f4check.projection));
    assert.ok(f4check.projection.blockingCodes.includes('asset_purchase_voucher_pending'));
    await fails(client, 'depreciation_run', { accountSetId: f4.accountSetId, period: '2026-01' }, 'asset_ledger_pending');
    await fails(client, 'period_set_status', { accountSetId: f4.accountSetId, period: '2026-01', status: 'closed' },
      'period_end_check_failed');

    // F2：普通后期结转读取累计余额，因此前期反过账被明确拒绝并给撤销顺序。
    const f2 = await ok(client, 'account_set_create', { name: 'MCP F2 依赖公司', start_period: '2026-01' });
    const f2Id = f2.accountSetId;
    await ok(client, 'opening_balance_set', { accountSetId: f2Id, items: [
      { code: '1002', debit: 1000, credit: 0 }, { code: '3001', debit: 0, credit: 1000 },
    ] });
    const jan = await ok(client, 'voucher_create', {
      accountSetId: f2Id, period: '2026-01', status: 'posted',
      entries: [{ code: '1002', debit: 100, credit: 0 }, { code: '5001', debit: 0, credit: 100 }],
    });
    await ok(client, 'voucher_create', {
      accountSetId: f2Id, period: '2026-02', status: 'posted',
      entries: [{ code: '1002', debit: 20, credit: 0 }, { code: '5001', debit: 0, credit: 20 }],
    });
    const febCarry = await ok(client, 'carry_forward_profit', { accountSetId: f2Id, period: '2026-02' });
    assert.equal(febCarry.projection.profit, 120); // 手算：一月 100 + 二月 20
    await fails(client, 'voucher_unpost', { accountSetId: f2Id, voucherId: jan.projection.voucherId },
      'later_profit_carryforward_depends_on_period');
    const deniedRaw = await rawAgent(base, 'voucher_unpost', { accountSetId: f2Id, voucherId: jan.projection.voucherId });
    assert.match(deniedRaw.text, /反过账/, '本机 raw 通道仍给可执行撤销顺序');
    // 正确顺序：反过账后期结转 → 撤销前期 → 重新结转。
    await ok(client, 'voucher_unpost', { accountSetId: f2Id, voucherId: febCarry.projection.voucherId });
    await ok(client, 'voucher_unpost', { accountSetId: f2Id, voucherId: jan.projection.voucherId });
    assert.equal((await ok(client, 'carry_forward_profit', { accountSetId: f2Id, period: '2026-02' })).projection.profit, 20);
  });
});

test('MCP 负例：旧折旧草稿重过账 / 亚分金额 / 大寿命（真实链路）', async () => {
  await withBackend(async (client, base) => {
    // ---- P1：反过账后改寿命，旧草稿不得重过账，必须删除后重算 ----
    const set = await ok(client, 'account_set_create', { name: 'MCP P1 旧草稿公司', start_period: '2026-01' });
    const setId = set.accountSetId;
    await ok(client, 'opening_balance_set', { accountSetId: setId, items: [
      { code: '1601', debit: 100, credit: 0 }, { code: '3001', debit: 0, credit: 100 },
    ] });
    const card = await ok(client, 'asset_create', {
      accountSetId: setId, kind: 'fixed', name: 'MCP 旧草稿设备', original_cost: 100,
      residual_rate: 0, useful_life_months: 10, start_period: '2026-01', acquired_period: '2026-01',
    });
    assert.equal((await localValue(base, card, 'asset_create')).monthly, 10); // 手算：100 ÷ 10
    const dep = await ok(client, 'depreciation_run', { accountSetId: setId, period: '2026-01' });
    assert.equal(dep.projection.totalAmount, 10);
    await ok(client, 'voucher_unpost', { accountSetId: setId, voucherId: dep.projection.voucherId });
    const relife = await ok(client, 'asset_update', {
      accountSetId: setId, assetId: card.projection.assetId, patch: { useful_life_months: 5 },
    });
    assert.equal(relife.projection.usefulLifeMonths, 5);
    assert.equal((await localValue(base, relife, 'asset_update')).monthly, 20);
    await fails(client, 'voucher_post', { accountSetId: setId, voucherId: dep.projection.voucherId },
      'depreciation_run_stale');
    const blocked = await ok(client, 'period_end_check', { accountSetId: setId, period: '2026-01' });
    assert.equal(blocked.projection.ready, false);
    assert.ok(blocked.projection.blockingCodes.includes('depreciation_draft_exists'), JSON.stringify(blocked.projection));
    await fails(client, 'period_set_status', { accountSetId: setId, period: '2026-01', status: 'closed' },
      'period_has_draft_vouchers');
    // 可行解除路径：删除旧草稿 → 重新计提 20 → 结转 → 封账。
    await ok(client, 'voucher_delete', { accountSetId: setId, voucherId: dep.projection.voucherId });
    assert.equal((await ok(client, 'depreciation_run', { accountSetId: setId, period: '2026-01' })).projection.totalAmount, 20);
    await ok(client, 'carry_forward_profit', { accountSetId: setId, period: '2026-01' });
    assert.equal((await ok(client, 'period_end_check', { accountSetId: setId, period: '2026-01' })).projection.ready, true);
    await ok(client, 'period_set_status', { accountSetId: setId, period: '2026-01', status: 'closed' });

    // ---- P2：亚分金额逐字段拒绝（模型固定码 + 本机原因）----
    const p2 = await ok(client, 'account_set_create', { name: 'MCP P2 亚分公司', start_period: '2026-01' });
    const p2Id = p2.accountSetId;
    const subcentArgs = {
      accountSetId: p2Id, period: '2026-01', status: 'posted',
      entries: [{ code: '1002', debit: 1, credit: 0.001 }, { code: '1001', debit: 0.001, credit: 1 }],
    };
    await fails(client, 'voucher_create', subcentArgs, 'voucher_invalid');
    const subcentRaw = await rawAgent(base, 'voucher_create', subcentArgs);
    assert.equal(subcentRaw.status, 400);
    assert.match(subcentRaw.text, /不足一分/);
    const check = await ok(client, 'voucher_check', {
      accountSetId: p2Id,
      entries: [{ code: '1002', debit: 1 }, { code: '1001', credit: 0.0049 }],
    });
    assert.equal(check.projection.checkOk, false);
    assert.ok(check.projection.errorCount >= 1);
    const checkRaw = await rawAgent(base, 'voucher_check', {
      accountSetId: p2Id,
      entries: [{ code: '1002', debit: 1 }, { code: '1001', credit: 0.0049 }],
    });
    assert.match(checkRaw.text, /不足一分/);
    // 正常边界保留：0.005 → 0.01
    const okVoucher = await ok(client, 'voucher_create', {
      accountSetId: p2Id, period: '2026-01', status: 'posted',
      entries: [{ code: '1002', debit: 0.005 }, { code: '1001', credit: 0.005 }],
    });
    assert.equal(okVoucher.projection.totalDebit, 0.01);

    // ---- P4：大寿命在 MCP 参数层就被拦住；patch 路径由后端边界拒绝，且不留半张卡片 ----
    const p4 = await ok(client, 'account_set_create', { name: 'MCP P4 寿命边界公司', start_period: '2026-01' });
    const p4Id = p4.accountSetId;
    const badLife = await client.call('asset_create', {
      accountSetId: p4Id, kind: 'fixed', name: '寿命非法设备', original_cost: 100, residual_rate: 0,
      useful_life_months: 4294967296, start_period: '2026-01', acquired_period: '2026-01',
    });
    assert.equal(badLife.isError, true);
    assert.equal(badLife.data.error, 'invalid_arguments');
    assert.equal((await ok(client, 'asset_list', { accountSetId: p4Id })).projection.cardCount, 0, '非法寿命不得落库');
    const edge = await ok(client, 'asset_create', {
      accountSetId: p4Id, kind: 'fixed', name: '边界寿命设备', original_cost: 1200, residual_rate: 0,
      useful_life_months: 1200, start_period: '2026-01', acquired_period: '2026-01',
    });
    assert.equal((await localValue(base, edge, 'asset_create')).monthly, 1);
    await fails(client, 'asset_update', {
      accountSetId: p4Id, assetId: edge.projection.assetId, patch: { useful_life_months: 4294967296 },
    }, 'useful_life_months_out_of_range');
    const listed = await ok(client, 'asset_list', { accountSetId: p4Id });
    assert.equal(listed.projection.cardCount, 1);
    const listedRaw = await localValue(base, listed, 'asset_list');
    assert.equal(listedRaw[0].useful_life_months, 1200, '更新失败必须完整回滚');
  });
});

test('MCP 负例：无资产 / 无损益标 not_applicable；缺省 period 与未知账套给出稳定错误', async () => {
  await withBackend(async (client, base) => {
    const set = await ok(client, 'account_set_create', { name: 'MCP 空账套', start_period: '2026-01' });
    const check = await ok(client, 'period_end_check', { accountSetId: set.accountSetId, period: '2026-01' });
    assert.equal(check.projection.ready, true);
    assert.equal(stepStatus(check, 'depreciation'), 'not_applicable');
    assert.equal(stepStatus(check, 'asset_reconciliation'), 'not_applicable');
    assert.equal(stepStatus(check, 'profit_carry_forward'), 'not_applicable');
    assert.equal(stepStatus(check, 'year_end_carry_forward'), 'not_applicable');
    const checkRaw = await localValue(base, check, 'period_end_check');
    assert.ok(checkRaw.steps.find((s) => s.id === 'depreciation').reason);

    await fails(client, 'period_end_check', { accountSetId: set.accountSetId }, 'invalid_arguments');
    await fails(client, 'period_end_check', { accountSetId: set.accountSetId, period: '2026-13' }, 'period_invalid');
    await fails(client, 'period_end_check', { accountSetId: 999999, period: '2026-01' }, 'account_set_not_found');
    await fails(client, 'asset_update', { accountSetId: set.accountSetId }, 'invalid_arguments');
  });
});
