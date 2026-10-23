// Fixed synthetic test identities, independent of display names and production defaults.
let identityFixtureSequence = 0;
const identityFixture = () => ({ enterpriseKey: 'SYNTHETIC-import-incremental-test-mjs-' + (++identityFixtureSequence) });

// LOCAL-01 增量导入 MCP 真实链路：stdio MCP → 生产 HTTP 后端 → Agent 工具 → SQLite。
// LOCAL-08 起普通工具返回模型投影信封；业务原文 / 逐张来源追踪经本机引用接口读取，
// 结构化冲突原因经本机 raw 通道核对（模型通道只回固定错误码）。
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

/** 启动隔离后端（临时目录 + PORT=0），返回 MCP 客户端与本机 HTTP 基址。 */
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
    const base = `http://127.0.0.1:${port}`;
    client = new McpStdioClient(join(here, 'server.mjs'), {
      env: { FINANCE_API_BASE: base }, cwd: here,
    }).start();
    await client.initialize('import-incremental-synthetic-test');
    await run(client, base);
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
/** 本机引用：读回原 DTO（业务原文只在本机通道）。 */
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
/** 本机兼容 raw 通道：核对结构化冲突原因（模型通道只回固定码）。 */
async function rawAgent(base, name, args) {
  const res = await fetch(`${base}/agent/tools/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args),
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = null; }
  return { status: res.status, data, text };
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
  assert.match(inc.description, /localRef|摘要/, '应声明模型摘要语义');

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
  await withBackend(async (client, base) => {
    const listed = await client.rpc('tools/list');
    for (const name of ['book_import_incremental', 'book_import_batch']) {
      assert.ok(listed.result.tools.some((t) => t.name === name), name);
    }

    const preview = await ok(client, 'book_import_incremental', {
      batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(),
    });
    assert.equal(preview.projection.status, 'preview');
    assert.equal(preview.applied, false);
    assert.equal(preview.appliedReason, 'dry_run');
    assert.equal(preview.accountSetId, null);
    assert.equal(preview.projection.plannedVouchers, 1);
    assert.equal(preview.projection.plannedAccountSetCreated, true);
    const previewRaw = await rawAgent(base, 'book_import_incremental', { batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan() });
    assert.equal(previewRaw.status, 200);
    assert.deepEqual(previewRaw.data.planned.vouchersToCreate, ['MCP-SRC-0001']);

    const applied = await ok(client, 'book_import_incremental', {
      batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(), dryRun: false,
    });
    assert.equal(applied.projection.status, 'applied');
    assert.equal(applied.applied, true);
    assert.equal(applied.projection.accountSetCreated, true);
    assert.equal(applied.projection.vouchersCreated, 1);
    const setId = applied.accountSetId;
    assert.ok(setId > 0);

    const retry = await ok(client, 'book_import_incremental', {
      batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(), dryRun: false,
    });
    assert.equal(retry.projection.status, 'idempotent_replay');
    assert.equal(retry.applied, false);
    assert.equal(retry.appliedReason, 'idempotent_replay');
    assert.equal(retry.projection.vouchersCreated, 0);

    const batch = await ok(client, 'book_import_batch', { batchId: 'MCP-2026-01' });
    assert.equal(batch.projection.batchStatus, 'completed');
    assert.equal(batch.accountSetId, setId);
    assert.equal(batch.projection.voucherCount, 1);
    const batchRaw = await localValue(base, batch, 'book_import_batch');
    assert.equal(batchRaw.sourceTrace[0].sourceVoucherId, 'MCP-SRC-0001');
    const appliedRaw = await localValue(base, applied, 'book_import_incremental');
    assert.deepEqual(appliedRaw.sourceTrace, batchRaw.sourceTrace,
      '新建批次首调 applied 与批次查询的逐张 DTO 必须一致');

    // 报表侧复核：借贷平衡且金额落在手算值上（1002 期初 20000，本期无变动）。
    const report = await ok(client, 'finance_query', {
      nodeId: 'report.trial_balance', accountSetId: setId, period: '2026-01',
    });
    assert.equal(report.projection.period, '2026-01');
    assert.equal(report.projection.closingDebit, 20000 + 5650);
    assert.equal(report.projection.closingDebit, report.projection.closingCredit);
    const reportRaw = await localValue(base, report, 'trial_balance');
    const line = reportRaw.lines.find((l) => l.code === '1002');
    assert.equal(line.closing_debit, 20000);
  });
});

test('MCP 追加到已有账套 + 冲突以结构化错误返回（不静默覆盖）', async () => {
  await withBackend(async (client, base) => {
    const created = await ok(client, 'book_import_incremental', {
      batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(), dryRun: false,
    });
    const setId = created.accountSetId;

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
    assert.equal(appended.projection.status, 'applied');
    assert.equal(appended.projection.accountSetCreated, false);
    assert.equal(appended.projection.vouchersCreated, 1);
    assert.equal(appended.accountSetId, setId);

    // 内容修订 → import_conflict（模型固定码；结构化冲突码经本机 raw 通道核对）
    const revised = JSON.parse(JSON.stringify(feb));
    revised.vouchers[0].entries = [{ code: '1002', debit: 1, credit: 0 }, { code: '1122', debit: 0, credit: 1 }];
    const reviseArgs = {
      batchId: 'MCP-2026-02-revise', source: SOURCE, mode: 'append', accountSetId: setId,
      payload: revised, dryRun: false,
    };
    await fails(client, 'book_import_incremental', reviseArgs, 'import_conflict');
    const reviseRaw = await rawAgent(base, 'book_import_incremental', reviseArgs);
    assert.equal(reviseRaw.status, 400);
    assert.match(reviseRaw.text, /source_voucher_content_changed/);

    // 身份不符：另一个企业身份写同一账套
    const identityArgs = {
      batchId: 'MCP-other-enterprise',
      source: { system: 'local-book', enterpriseKey: '91350000MCP00002Y' },
      mode: 'append', accountSetId: setId, payload: feb, confirmNewBinding: true, dryRun: false,
    };
    await fails(client, 'book_import_incremental', identityArgs, 'import_conflict');
    const identityRaw = await rawAgent(base, 'book_import_incremental', identityArgs);
    assert.match(identityRaw.text, /account_set_bound_to_other_enterprise/);

    // 校验失败：非法金额不得被吞成成功
    const bad = JSON.parse(JSON.stringify(feb));
    bad.vouchers[0].entries[0].debit = 'abc';
    bad.vouchers[0].entries[1].credit = 'abc';
    const badArgs = {
      batchId: 'MCP-bad-amount', source: SOURCE, mode: 'append', accountSetId: setId,
      payload: bad, dryRun: false,
    };
    await fails(client, 'book_import_incremental', badArgs, 'import_validation_failed');
    const badRaw = await rawAgent(base, 'book_import_incremental', badArgs);
    assert.equal(badRaw.status, 400);
    assert.match(badRaw.text, /import_validation_failed/);

    // 未知批次查询明确报错
    await fails(client, 'book_import_batch', { batchId: 'no-such-batch' }, 'batch_not_found');
  });
});

test('MCP 一企一账套：跨来源 create 引导到已有账套，反过账后回放不伪报完成', async () => {
  await withBackend(async (client, base) => {
    const applied = await ok(client, 'book_import_incremental', {
      batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(), dryRun: false,
    });
    const setId = applied.accountSetId;
    const appliedRaw = await localValue(base, applied, 'book_import_incremental');
    const vid = appliedRaw.sourceTrace[0].voucherId;

    // 同一 enterpriseKey 从另一个来源 create → 结构化冲突并引导到已有账套，不得新建第二本。
    const crossArgs = {
      batchId: 'MCP-other-src-create',
      source: { system: 'other-book', enterpriseKey: SOURCE.enterpriseKey },
      payload: payloadJan(), dryRun: false,
    };
    await fails(client, 'book_import_incremental', crossArgs, 'import_conflict');
    const crossRaw = await rawAgent(base, 'book_import_incremental', crossArgs);
    assert.match(crossRaw.text, /enterprise_already_bound/);

    // 本机反过账后，同批回放必须给结构化冲突，不能按来源指纹伪报完成。
    await ok(client, 'voucher_unpost', { accountSetId: setId, voucherId: vid });
    const replayArgs = { batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(), dryRun: false };
    await fails(client, 'book_import_incremental', replayArgs, 'import_conflict');
    const unpostedRaw = await rawAgent(base, 'book_import_incremental', replayArgs);
    assert.match(unpostedRaw.text, /source_voucher_voucher_unposted/);
    const batch = await ok(client, 'book_import_batch', { batchId: 'MCP-2026-01' });
    assert.equal(batch.projection.batchStatus, 'completed');
    assert.equal(batch.projection.inconsistentTraceCount, 1);
    const batchRaw = await localValue(base, batch, 'book_import_batch');
    assert.equal(batchRaw.sourceTrace[0].state, 'unposted');

    // 重新过账后恢复幂等回放。
    await ok(client, 'voucher_post', { accountSetId: setId, voucherId: vid });
    const replay = await ok(client, 'book_import_incremental', replayArgs);
    assert.equal(replay.projection.status, 'idempotent_replay');
    assert.equal(replay.projection.vouchersCreated, 0);
  });
});

test('MCP 空账套首次追加期初：同批重试幂等回放（不误报期初覆盖）', async () => {
  await withBackend(async (client, base) => {
    const set = await ok(client, 'account_set_create', { enterprise: { enterpriseKey: '91350000MCPEMPTY1X' }, name: 'MCP 填空公司', start_period: '2026-01' });
    const setId = set.accountSetId;
    const source = { system: 'local-book', enterpriseKey: '91350000MCPEMPTY1X', enterpriseName: 'MCP 填空公司' };
    const payload = {
      account_set: meta({ name: 'MCP 填空公司' }),
      opening_balances: [{ code: '1002', debit: 100, credit: 0 }, { code: '3001', debit: 0, credit: 100 }],
      vouchers: [],
    };
    const args = {
      batchId: 'MCP-EMPTY-2026-01', source, mode: 'append', accountSetId: setId,
      confirmNewBinding: true, payload, dryRun: false,
    };
    const applied = await ok(client, 'book_import_incremental', args);
    assert.equal(applied.projection.status, 'applied');
    assert.equal(applied.projection.openingBalancesApplied, 2);

    const retry = await ok(client, 'book_import_incremental', args);
    assert.equal(retry.projection.status, 'idempotent_replay');
    assert.equal(retry.projection.openingBalancesApplied, 0);
    assert.equal(retry.projection.vouchersCreated, 0);

    const batch = await ok(client, 'book_import_batch', { batchId: 'MCP-EMPTY-2026-01' });
    assert.equal(batch.projection.batchStatus, 'completed');
    assert.equal(batch.accountSetId, setId);

    // 真正改期初（新批次）仍被拒绝：只回放本批自己写入的期初，不豁免期初覆盖。
    const overwriteArgs = {
      ...args,
      batchId: 'MCP-EMPTY-overwrite',
      payload: { ...payload, opening_balances: [{ code: '1002', debit: 999, credit: 0 }, { code: '3001', debit: 0, credit: 999 }] },
    };
    await fails(client, 'book_import_incremental', overwriteArgs, 'import_conflict');
    const overwriteRaw = await rawAgent(base, 'book_import_incremental', overwriteArgs);
    assert.match(overwriteRaw.text, /opening_balance_overwrite_refused|opening_rewrite_after_posting/);
  });
});

test('MCP 跨批去重保留逐张追踪：去重批次 book_import_batch 不是空', async () => {
  await withBackend(async (client, base) => {
    const created = await ok(client, 'book_import_incremental', {
      batchId: 'MCP-2026-01', source: SOURCE, payload: payloadJan(), dryRun: false,
    });
    const setId = created.accountSetId;
    const createdRaw = await localValue(base, created, 'book_import_incremental');
    const v1VoucherId = createdRaw.sourceTrace[0].voucherId;

    // 仅凭证（不带期初）：同一来源凭证在不同批次重复提交 → 去重不新增凭证。
    const dedupeArgs = {
      batchId: 'MCP-2026-01-again', source: SOURCE, mode: 'append', accountSetId: setId, dryRun: false,
      payload: { account_set: meta(), vouchers: payloadJan().vouchers },
    };
    const dedupe = await ok(client, 'book_import_incremental', dedupeArgs);
    assert.equal(dedupe.projection.status, 'applied');
    assert.equal(dedupe.projection.vouchersCreated, 0);
    assert.equal(dedupe.projection.vouchersDeduplicated, 1);

    const batch = await ok(client, 'book_import_batch', { batchId: 'MCP-2026-01-again' });
    assert.equal(batch.projection.voucherCount, 1, '去重批次必须保留逐张来源凭证追踪');
    const batchRaw = await localValue(base, batch, 'book_import_batch');
    assert.equal(batchRaw.sourceTrace[0].sourceVoucherId, 'MCP-SRC-0001');
    assert.equal(batchRaw.sourceTrace[0].status, 'deduplicated');
    assert.equal(batchRaw.sourceTrace[0].voucherId, v1VoucherId, '必须指向既有凭证，不伪造第二张');
    const dedupeRaw = await localValue(base, dedupe, 'book_import_incremental');
    assert.deepEqual(dedupeRaw.sourceTrace, batchRaw.sourceTrace,
      '纯去重批次首调 applied 与批次查询的逐张 DTO 必须一致（含 action / state）');

    const replay = await ok(client, 'book_import_incremental', dedupeArgs);
    assert.equal(replay.projection.status, 'idempotent_replay');
    const replayRaw = await localValue(base, replay, 'book_import_incremental');
    assert.deepEqual(replayRaw.sourceTrace, batchRaw.sourceTrace);
  });
});

test('MCP 旧 legacy_book_import 入口行为不变（默认预检）', async () => {
  await withBackend(async (client, base) => {
    const payload = {
      account_set: meta({ name: 'MCP 旧接口公司' }),
      opening_balances: [{ code: '1002', debit: 100, credit: 0 }, { code: '3001', debit: 0, credit: 100 }],
    };
    const dry = await ok(client, 'legacy_book_import', { enterprise: identityFixture(), payload });
    assert.equal(dry.applied, false);
    assert.equal(dry.appliedReason, 'dry_run');
    assert.equal(dry.projection.dryRun, true);
    assert.equal(dry.accountSetId, null);
    const formal = await ok(client, 'legacy_book_import', { enterprise: identityFixture(), payload, dryRun: false });
    assert.equal(formal.projection.dryRun, false);
    assert.ok(formal.accountSetId > 0);
    const formalRaw = await localValue(base, formal, 'legacy_book_import');
    assert.equal(formalRaw.created.name, 'MCP 旧接口公司');
    // 旧入口不产生增量导入的身份 / 批次记录，因此批次查询明确报「不存在」。
    await fails(client, 'book_import_batch', { batchId: 'legacy-none' }, 'batch_not_found');
  });
});
