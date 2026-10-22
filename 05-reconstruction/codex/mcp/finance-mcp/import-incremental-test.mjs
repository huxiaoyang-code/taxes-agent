// LOCAL-01 增量导入 MCP 真实链路：stdio MCP → 生产 HTTP 后端 → Agent 工具 → SQLite。
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

const SOURCE = { system: 'local-book', enterpriseKey: '91350000MCP00001X', enterpriseName: 'MCP 合成公司' };
const meta = (over = {}) => ({
  name: 'MCP 合成公司', taxpayer_type: '小规模纳税人', accounting_standard: '小企业会计准则',
  start_period: '2026-01', ...over,
});
const payloadJan = () => ({
  account_set: meta(),
  opening_balances: [{ code: '1002', debit: 20000, credit: 0 }, { code: '3001', debit: 0, credit: 20000 }],
  vouchers: [{
    period: '2026-01', date: '2026-01-07', word: '记', number: 1, summary: '销售商品',
    sourceVoucherId: 'MCP-SRC-0001',
    entries: [
      { code: '1122', debit: 5650, credit: 0 },
      { code: '5001', debit: 0, credit: 5000 },
      { code: '2221', debit: 0, credit: 650 },
    ],
  }],
});

/** 启动隔离后端（临时目录 + PORT=0），返回 MCP 客户端。 */
async function withBackend(run) {
  const directory = mkdtempSync(join(tmpdir(), 'import-incremental-mcp-'));
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
    await client.initialize('import-incremental-synthetic-test');
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
  return r.data;
}
async function fails(client, name, args, expected) {
  const r = await client.call(name, args);
  assert.equal(r.isError, true, `expected failure for ${name}: ${r.text}`);
  assert.match(r.text, expected);
  return r;
}

test('增量导入工具已公布严格 schema（绝不由 MCP 本地伪造执行）', () => {
  const inc = TOOLS.find((t) => t.name === 'book_import_incremental');
  assert.ok(inc, 'book_import_incremental 必须公布');
  assert.equal(inc.status, 'available');
  assert.equal(inc.origin, 'local');
  assert.equal(inc.inputSchema.type, 'object');
  assert.deepEqual(inc.inputSchema.required, ['batchId', 'source']);
  assert.equal(inc.inputSchema.properties.source.type, 'object');
  assert.deepEqual(inc.inputSchema.properties.source.required, ['system', 'enterpriseKey']);
  assert.deepEqual(inc.inputSchema.properties.mode.enum, ['create', 'append']);
  assert.ok(inc.inputSchema.properties.dryRun, 'dryRun 必须在 schema 中');
  assert.match(inc.description, /dryRun=false/);

  const batch = TOOLS.find((t) => t.name === 'book_import_batch');
  assert.ok(batch);
  assert.equal(batch.origin, 'local');
  assert.deepEqual(batch.inputSchema.required, ['batchId']);

  assert.deepEqual(validateArgs(inc.inputSchema, { batchId: 'b1', source: { system: 's', enterpriseKey: 'k' } }), []);
  assert.ok(validateArgs(inc.inputSchema, { batchId: 'b1' }).length === 1);
  assert.ok(validateArgs(inc.inputSchema, { batchId: 'b1', source: 'x' }).length >= 1);
  assert.ok(validateArgs(inc.inputSchema, { batchId: 'b1', source: { system: 's', enterpriseKey: 'k' }, mode: 'merge' }).length >= 1);
});

test('MCP 预检默认只读，正式导入后同批重试幂等', async () => {
  await withBackend(async (client) => {
    const listed = await client.rpc('tools/list');
    for (const name of ['book_import_incremental', 'book_import_batch']) {
      assert.ok(listed.result.tools.some((t) => t.name === name), name);
    }

    const preview = await ok(client, 'book_import_incremental', {
      batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(),
    });
    assert.equal(preview.status, 'preview');
    assert.equal(preview.dryRun, true);
    assert.equal(preview.created, null);
    assert.deepEqual(preview.planned.vouchersToCreate, ['MCP-SRC-0001']);

    const applied = await ok(client, 'book_import_incremental', {
      batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(), dryRun: false,
    });
    assert.equal(applied.status, 'applied');
    assert.equal(applied.created.accountSetCreated, true);
    assert.equal(applied.created.vouchersCreated, 1);
    const setId = applied.created.accountSetId;

    const retry = await ok(client, 'book_import_incremental', {
      batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(), dryRun: false,
    });
    assert.equal(retry.status, 'idempotent_replay');
    assert.equal(retry.created.vouchersCreated, 0);

    const batch = await ok(client, 'book_import_batch', { batchId: 'MCP-2026-01' });
    assert.equal(batch.batch.status, 'completed');
    assert.equal(batch.batch.accountSetId, setId);
    assert.equal(batch.voucherCount, 1);
    assert.equal(batch.sourceTrace[0].sourceVoucherId, 'MCP-SRC-0001');
    assert.deepEqual(applied.sourceTrace, batch.sourceTrace,
      '新建批次首调 applied 与批次查询的逐张 DTO 必须一致');

    // 报表侧复核：借贷平衡且金额落在手算值上（1002 期初 20000，本期无变动）。
    const report = await ok(client, 'finance_query', {
      nodeId: 'report.trial_balance', accountSetId: setId, period: '2026-01',
    });
    assert.equal(report.data.period, '2026-01');
    const line = report.data.lines.find((l) => l.code === '1002');
    assert.equal(line.closing_debit, 20000);
    assert.equal(report.data.totals.closing_debit, report.data.totals.closing_credit);
  });
});

test('MCP 追加到已有账套 + 冲突以结构化错误返回（不静默覆盖）', async () => {
  await withBackend(async (client) => {
    const created = await ok(client, 'book_import_incremental', {
      batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(), dryRun: false,
    });
    const setId = created.created.accountSetId;

    const feb = {
      account_set: meta(),
      vouchers: [{
        period: '2026-02', date: '2026-02-11', word: '记', number: 1, summary: '收回货款',
        sourceVoucherId: 'MCP-SRC-0002',
        entries: [{ code: '1002', debit: 5650, credit: 0 }, { code: '1122', debit: 0, credit: 5650 }],
      }],
    };
    const appended = await ok(client, 'book_import_incremental', {
      batchId: 'MCP-2026-02', source: SOURCE, mode: 'append', accountSetId: setId,
      payload: feb, dryRun: false,
    });
    assert.equal(appended.status, 'applied');
    assert.equal(appended.created.accountSetCreated, false);
    assert.equal(appended.created.vouchersCreated, 1);

    // 内容修订 → import_conflict（details.conflicts 带结构化冲突码）
    const revised = JSON.parse(JSON.stringify(feb));
    revised.vouchers[0].entries = [{ code: '1002', debit: 1, credit: 0 }, { code: '1122', debit: 0, credit: 1 }];
    const conflict = await fails(client, 'book_import_incremental', {
      batchId: 'MCP-2026-02-revise', source: SOURCE, mode: 'append', accountSetId: setId,
      payload: revised, dryRun: false,
    }, /import_conflict/);
    assert.match(conflict.text, /source_voucher_content_changed/);
    assert.equal(conflict.data?.error, 'import_conflict');

    // 身份不符：另一个企业身份写同一账套
    const identity = await fails(client, 'book_import_incremental', {
      batchId: 'MCP-other-enterprise',
      source: { system: 'local-book', enterpriseKey: '91350000MCP00002Y' },
      mode: 'append', accountSetId: setId, payload: feb, confirmNewBinding: true, dryRun: false,
    }, /import_conflict/);
    assert.match(identity.text, /account_set_bound_to_other_enterprise/);

    // 校验失败：非法金额不得被吞成成功
    const bad = JSON.parse(JSON.stringify(feb));
    bad.vouchers[0].entries[0].debit = 'abc';
    bad.vouchers[0].entries[1].credit = 'abc';
    await fails(client, 'book_import_incremental', {
      batchId: 'MCP-bad-amount', source: SOURCE, mode: 'append', accountSetId: setId,
      payload: bad, dryRun: false,
    }, /import_validation_failed/);

    // 未知批次查询明确报错
    await fails(client, 'book_import_batch', { batchId: 'no-such-batch' }, /batch_not_found/);
  });
});

test('MCP 一企一账套：跨来源 create 引导到已有账套，反过账后回放不伪报完成', async () => {
  await withBackend(async (client) => {
    const applied = await ok(client, 'book_import_incremental', {
      batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(), dryRun: false,
    });
    const setId = applied.created.accountSetId;
    const vid = applied.sourceTrace[0].voucherId;

    // 同一 enterpriseKey 从另一个来源 create → 结构化冲突并引导到已有账套，不得新建第二本。
    const cross = await fails(client, 'book_import_incremental', {
      batchId: 'MCP-other-src-create',
      source: { system: 'other-book', enterpriseKey: SOURCE.enterpriseKey },
      payload: payloadJan(), dryRun: false,
    }, /import_conflict/);
    assert.match(cross.text, /enterprise_already_bound/);

    // 本机反过账后，同批回放必须给结构化冲突，不能按来源指纹伪报完成。
    await ok(client, 'voucher_unpost', { accountSetId: setId, voucherId: vid });
    const unposted = await fails(client, 'book_import_incremental', {
      batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(), dryRun: false,
    }, /import_conflict/);
    assert.match(unposted.text, /source_voucher_voucher_unposted/);
    const batch = await ok(client, 'book_import_batch', { batchId: 'MCP-2026-01' });
    assert.equal(batch.batch.status, 'completed');
    assert.equal(batch.sourceTrace[0].state, 'unposted');

    // 重新过账后恢复幂等回放。
    await ok(client, 'voucher_post', { accountSetId: setId, voucherId: vid });
    const replay = await ok(client, 'book_import_incremental', {
      batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(), dryRun: false,
    });
    assert.equal(replay.status, 'idempotent_replay');
    assert.equal(replay.created.vouchersCreated, 0);
  });
});

test('MCP 空账套首次追加期初：同批重试幂等回放（不误报期初覆盖）', async () => {
  await withBackend(async (client) => {
    const set = await ok(client, 'account_set_create', { name: 'MCP 填空公司', start_period: '2026-01' });
    const source = { system: 'local-book', enterpriseKey: '91350000MCPEMPTY1X', enterpriseName: 'MCP 填空公司' };
    const payload = {
      account_set: meta({ name: 'MCP 填空公司' }),
      opening_balances: [{ code: '1002', debit: 100, credit: 0 }, { code: '3001', debit: 0, credit: 100 }],
      vouchers: [],
    };
    const args = {
      batchId: 'MCP-EMPTY-2026-01', source, mode: 'append', accountSetId: set.id,
      confirmNewBinding: true, payload, dryRun: false,
    };
    const applied = await ok(client, 'book_import_incremental', args);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.created.openingBalancesApplied, 2);

    const retry = await ok(client, 'book_import_incremental', args);
    assert.equal(retry.status, 'idempotent_replay');
    assert.equal(retry.created.openingBalancesApplied, 0);
    assert.equal(retry.created.vouchersCreated, 0);

    const batch = await ok(client, 'book_import_batch', { batchId: 'MCP-EMPTY-2026-01' });
    assert.equal(batch.batch.status, 'completed');
    assert.equal(batch.batch.accountSetId, set.id);

    // 真正改期初（新批次）仍被拒绝：只回放本批自己写入的期初，不豁免期初覆盖。
    const overwrite = await fails(client, 'book_import_incremental', {
      ...args,
      batchId: 'MCP-EMPTY-overwrite',
      payload: { ...payload, opening_balances: [{ code: '1002', debit: 999, credit: 0 }, { code: '3001', debit: 0, credit: 999 }] },
    }, /import_conflict/);
    assert.match(overwrite.text, /opening_balance_overwrite_refused|opening_rewrite_after_posting/);
  });
});

test('MCP 跨批去重保留逐张追踪：去重批次 book_import_batch 不是空', async () => {
  await withBackend(async (client) => {
    const created = await ok(client, 'book_import_incremental', {
      batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(), dryRun: false,
    });
    const setId = created.created.accountSetId;
    const v1VoucherId = created.sourceTrace[0].voucherId;

    // 仅凭证（不带期初）：同一来源凭证在不同批次重复提交 → 去重不新增凭证。
    const dedupeArgs = {
      batchId: 'MCP-2026-01-again', source: SOURCE, mode: 'append', accountSetId: setId, dryRun: false,
      payload: { account_set: meta(), vouchers: payloadJan().vouchers },
    };
    const dedupe = await ok(client, 'book_import_incremental', dedupeArgs);
    assert.equal(dedupe.status, 'applied');
    assert.equal(dedupe.created.vouchersCreated, 0);
    assert.equal(dedupe.created.vouchersDeduplicated, 1);

    const batch = await ok(client, 'book_import_batch', { batchId: 'MCP-2026-01-again' });
    assert.equal(batch.voucherCount, 1, '去重批次必须保留逐张来源凭证追踪');
    assert.equal(batch.sourceTrace[0].sourceVoucherId, 'MCP-SRC-0001');
    assert.equal(batch.sourceTrace[0].status, 'deduplicated');
    assert.equal(batch.sourceTrace[0].voucherId, v1VoucherId, '必须指向既有凭证，不伪造第二张');
    assert.deepEqual(dedupe.sourceTrace, batch.sourceTrace,
      '纯去重批次首调 applied 与批次查询的逐张 DTO 必须一致（含 action / state）');

    const replay = await ok(client, 'book_import_incremental', dedupeArgs);
    assert.equal(replay.status, 'idempotent_replay');
    assert.deepEqual(replay.sourceTrace, batch.sourceTrace);
  });
});

test('MCP 旧 legacy_book_import 入口行为不变（默认预检）', async () => {
  await withBackend(async (client) => {
    const payload = {
      account_set: meta({ name: 'MCP 旧接口公司' }),
      opening_balances: [{ code: '1002', debit: 100, credit: 0 }, { code: '3001', debit: 0, credit: 100 }],
    };
    const dry = await ok(client, 'legacy_book_import', { payload });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.created, null);
    const formal = await ok(client, 'legacy_book_import', { payload, dryRun: false });
    assert.equal(formal.dryRun, false);
    assert.equal(formal.created.name, 'MCP 旧接口公司');
    // 旧入口不产生增量导入的身份 / 批次记录，因此批次查询明确报「不存在」。
    await fails(client, 'book_import_batch', { batchId: 'legacy-none' }, /batch_not_found/);
  });
});
