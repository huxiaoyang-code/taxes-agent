#!/usr/bin/env node
// finance-model-http acceptance — LOCAL-08 真实 HTTP 模型入口 / 本机引用 / 兼容与错误面。
//
// 运行：cd 06-workbench && node test/finance-model-http.test.mjs
//
// 自建临时数据目录 + 随机 loopback 端口：不连接默认 8787，也不触碰工程 data/。
// 两家合成企业的敏感标记分别放在企业名 / 科目名 / 凭证摘要 / 资产名 / 来源 ID 上，
// 先经本机 raw 通道读出证明夹具真的进入 DTO，再经模型通道断言不外发。
// 金额为手算常量：期初 1002=1000 / 1601=1200 / 3001=2200；收入 300；折旧 95；净利 205。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "server", "server.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "wb-model-http-"));

const X = {
  enterpriseA: "合成HTTP企业名称甲",
  enterpriseB: "合成HTTP企业名称乙",
  enterpriseC: "合成HTTP企业名称丙",
  importName: "合成HTTP导入企业辛",
  incrementalName: "合成HTTP增量企业壬",
  accountName: "合成HTTP科目名称乙",
  summary: "合成HTTP摘要丙",
  assetName: "合成HTTP资产名称庚",
  note: "合成HTTP备注戊",
  enterpriseKey: "91350000HTTPX01",
  batchId: "syn-http-batch-20261022",
  sourceSystem: "syn-http-source",
  filePath: "D:/合成HTTP路径/凭证明细.zip",
};
const MARKERS = Object.values(X);
const LEAK_PATTERNS = [...MARKERS, "workbench.db", "dataDir", "Error:", "    at ", X.filePath];
function assertNoLeak(text, label) {
  const value = typeof text === "string" ? text : JSON.stringify(text);
  const hits = LEAK_PATTERNS.filter((needle) => value.includes(needle));
  assert.deepEqual(hits, [], `${label} 泄漏原文 / 路径 / 栈：${hits.join(" / ")}`);
}
/** 本机 UI 通道本来就应能看原文：只断言不含内部路径与堆栈。 */
function assertNoInternalFailure(text, label) {
  const value = typeof text === "string" ? text : JSON.stringify(text);
  for (const needle of ["workbench.db", "dataDir", "    at ", "Error:"]) {
    assert.equal(value.includes(needle), false, `${label} 不应包含内部失败细节：${needle}`);
  }
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  PASS ${name}`); }
  catch (error) { results.push(false); console.error(`  FAIL ${name}\n${error.stack}`); }
}

// ---------------------------------------------------------------- 真实后端进程
let child = null;
let base = "";
let stdout = "";
let stderr = "";

function startBackend() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: "0", HOST: "127.0.0.1", WORKBENCH_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`startup timeout: ${stderr}`)); }, 20000);
    proc.stdout.on("data", (d) => { out += d.toString(); stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`backend exited ${code}: ${stderr.slice(0, 400)}`)); });
    proc.stdout.on("data", () => {
      const match = /127\.0\.0\.1:(\d+)\//.exec(out);
      if (match) {
        clearTimeout(timer);
        child = proc;
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
  });
}

async function stopBackend() {
  if (!child) return;
  const proc = child;
  child = null;
  const done = new Promise((resolve) => proc.once("exit", resolve));
  proc.kill();
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill("SIGKILL"); } catch { /* ignore */ } }
}

async function http(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data, text, headers: Object.fromEntries(res.headers) };
}

const model = (name, args) => http("POST", `/agent/model-tools/${name}`, args);
const raw = (name, args) => http("POST", `/agent/tools/${name}`, args);
const localRead = (body) => http("POST", "/api/finance-output/read", body);
const localCompute = (body) => http("POST", "/api/finance-output/compute", body);

async function modelOk(name, args) {
  const res = await model(name, args);
  assert.equal(res.status, 200, `${name} 应 200，实际 ${res.status}：${res.text.slice(0, 200)}`);
  assert.equal(res.data?.ok, true, `${name} 应 ok=true：${res.text.slice(0, 240)}`);
  assert.equal(res.data?.channel, "model");
  assert.equal(res.data?.rawValuesIncluded, false);
  assertNoLeak(res.text, `${name} 响应体`);
  assertNoLeak(res.headers, `${name} 响应头`);
  return res.data;
}
async function modelWriteOk(name, args) {
  const envelope = await modelOk(name, args);
  assert.equal(envelope.applied, true, `${name} applied 应为 true`);
  assert.equal(envelope.needsLocalReview, false);
  return envelope;
}
async function modelFail(name, args, code, status = 200) {
  const res = await model(name, args);
  assert.equal(res.status, status, `${name} 状态码 ${res.status}`);
  assert.equal(res.data?.ok, false, `${name} 应 ok=false`);
  assert.equal(res.data?.error?.code, code, `${name} 错误码应为 ${code}，实际 ${res.data?.error?.code}`);
  assert.equal(res.data?.rawErrorIncluded, false);
  assertNoLeak(res.text, `${name} 错误响应`);
  return res.data;
}
async function readRaw(envelope, label = envelope.tool) {
  assert.ok(envelope.localRef, `${label} 应有 localRef`);
  const res = await localRead({
    ref: envelope.localRef, accountSetId: envelope.accountSetId, operation: envelope.operation,
  });
  assert.equal(res.status, 200, `${label} 本机读取应 200：${res.text.slice(0, 160)}`);
  assert.equal(res.data.channel, "local");
  return res.data.value;
}

let setA;
let setB;
let assetId;
let voucherId;

try {
  base = await startBackend();
  console.log(`\n模型 HTTP 入口测试 @ ${base}（临时数据目录 ${dataDir}）\n`);

  await test("1. 夹具：本机 raw / REST 通道可读原值（模型通道不是唯一出口）", async () => {
    const a = await raw("account_set_create", { name: X.enterpriseA, start_period: "2026-01" });
    assert.equal(a.status, 200, a.text);
    setA = a.data.id;
    const b = await raw("account_set_create", { name: X.enterpriseB, start_period: "2026-01" });
    setB = b.data.id;
    const ctx = await raw("account_context", {});
    assert.ok(ctx.data.account_sets.some((s) => s.name === X.enterpriseA));
    const rest = await http("GET", "/api/account-sets");
    assert.equal(rest.status, 200);
    assert.ok(rest.data.some((s) => s.name === X.enterpriseB));
    const acc = await raw("account_create", {
      accountSetId: setA, code: "190101", name: X.accountName, category: "资产", direction: "debit",
    });
    assert.equal(acc.status, 200, acc.text);
    const opening = await raw("opening_balance_set", {
      accountSetId: setA,
      items: [
        { code: "1002", debit: 1000, credit: 0 },
        { code: "1601", debit: 1200, credit: 0 },
        { code: "3001", debit: 0, credit: 2200 },
      ],
    });
    assert.equal(opening.status, 200, opening.text);
    const v = await raw("voucher_create", {
      accountSetId: setA, period: "2026-01", summary: X.summary, status: "posted",
      entries: [
        { code: "1122", debit: 300, credit: 0, summary: X.summary },
        { code: "5001", debit: 0, credit: 300, summary: X.summary },
      ],
    });
    assert.equal(v.status, 200, v.text);
    voucherId = v.data.id;
    const detail = await raw("finance_query", {
      nodeId: "voucher.detail", accountSetId: setA, params: { voucherId },
    });
    assert.equal(detail.data.data.summary, X.summary);
  });

  await test("2. 模型查询：上下文分页 / 指定账套绑定", async () => {
    const globalPage = await modelOk("account_context", { limit: 1, offset: 0 });
    assert.equal(globalPage.scope, "global");
    assert.equal(globalPage.accountSetId, null);
    assert.equal(globalPage.localRef, null);
    assert.equal(globalPage.projection.returnedCount, 1);
    assert.equal(globalPage.projection.truncated, true);
    assert.equal(globalPage.projection.nextOffset, 1);
    const lastPage = await modelOk("account_context", { limit: 1, offset: 1 });
    assert.equal(lastPage.projection.hasNextPage, false);
    const scoped = await modelOk("finance_context_resolve", { accountSetId: setA });
    assert.equal(scoped.accountSetId, setA);
    assert.equal(scoped.projection.accountSetId, setA);
    await modelFail("account_context", { limit: 99 }, "model_context_page_invalid");
    await modelFail("account_context", { accountSetId: 999999 }, "account_set_not_found");
  });

  await test("3. 模型写：建账 / 科目 / 期初 / 凭证三态流转，金额与手算一致", async () => {
    const created = await modelWriteOk("account_set_create", {
      name: X.enterpriseC, taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01",
    });
    assert.equal(created.operationCategory, "create");
    assert.equal(created.accountSetIdSource, "result");
    const createdRaw = await readRaw(created);
    assert.equal(createdRaw.name, X.enterpriseC, "create 引用应取真实结果并绑定真实账套");

    const opening = await modelWriteOk("opening_balance_set", {
      accountSetId: setB,
      items: [
        { code: "1002", debit: 2000, credit: 0 },
        { code: "3001", debit: 0, credit: 2000 },
      ],
    });
    assert.equal(opening.projection.itemCount, 2);

    const check = await modelOk("voucher_check", {
      accountSetId: setA, entries: [{ code: "1122", debit: 300 }, { code: "5001", credit: 300 }],
    });
    assert.equal(check.projection.checkOk, true);
    assert.equal(check.projection.balanced, true);

    const draft = await modelWriteOk("voucher_create", {
      accountSetId: setB, period: "2026-01",
      entries: [{ code: "1001", debit: 50 }, { code: "1002", credit: 50 }],
    });
    assert.equal(draft.projection.status, "draft");
    const posted = await modelWriteOk("voucher_post", { accountSetId: setB, voucherId: draft.projection.voucherId });
    assert.equal(posted.projection.status, "posted");
    const unposted = await modelWriteOk("voucher_unpost", { accountSetId: setB, voucherId: draft.projection.voucherId });
    assert.equal(unposted.projection.status, "draft");
    const deleted = await modelWriteOk("voucher_delete", { accountSetId: setB, voucherId: draft.projection.voucherId });
    assert.equal(deleted.projection.deletedVoucherId, draft.projection.voucherId);

    const account = await modelWriteOk("account_create", {
      accountSetId: setA, code: "190102", name: X.accountName, category: "资产", direction: "debit",
    });
    assert.ok(account.projection.accountCount >= 56);
    const period = await modelWriteOk("period_set_status", { accountSetId: setA, period: "2026-02", status: "open" });
    assert.equal(period.projection.status, "open");
  });

  await test("4. 模型查询工具：摘要非空且不含原值", async () => {
    const accounts = await modelOk("account_list", { accountSetId: setA });
    assert.ok(accounts.projection.accountCount >= 56);
    const rawAccounts = await readRaw(accounts);
    assert.ok(rawAccounts.items.some((item) => item.name === X.accountName), "本机引用应能读回科目名");
    assertNoLeak(accounts, "account_list");

    const opening = await modelOk("opening_balance_get", { accountSetId: setA });
    assert.equal(opening.projection.itemCount, 3);
    assert.equal(opening.projection.totalDebit, 2200);
    assert.equal(opening.projection.balanced, true);

    const periods = await modelOk("period_list", { accountSetId: setA });
    assert.equal(periods.projection.periodCount, 2);
    assert.equal(periods.projection.openPeriodCount, 2);

    const ledger = await modelOk("ledger_query", { accountSetId: setA, code: "1122", period: "2026-01" });
    assert.equal(ledger.projection.itemCount, 1);
    assert.equal(ledger.projection.closingBalance, 300);
    const sum = await localCompute({
      ref: ledger.localRef, accountSetId: setA, operation: ledger.operation, op: "sum", path: "items.[].debit",
    });
    assert.equal(sum.status, 200, sum.text);
    assert.equal(sum.data.value, 300);

    const cards = await modelOk("asset_list", { accountSetId: setA });
    assert.equal(cards.projection.cardCount, 0);
  });

  await test("5. finance_query 全部 12 个已实现 node：只投影 data 且金额手算一致", async () => {
    const cases = [
      ["enterprise_account.account_set", {}, (p) => assert.equal(p.startPeriod, "2026-01")],
      ["enterprise_account.subject_system.all", {}, (p) => assert.ok(p.accountCount >= 56)],
      ["voucher.generated.list", { period: "2026-01" }, (p) => assert.equal(p.voucherCount, 1)],
      ["voucher.generated.summary", { period: "2026-01" }, (p) => assert.equal(p.totalDebit, 300)],
      ["voucher.draft.summary", { period: "2026-01" }, (p) => assert.equal(p.draftCount, 0)],
      ["voucher.detail", { params: { voucherId } }, (p) => assert.equal(p.voucherId, voucherId)],
      ["report.balance_sheet", { period: "2026-01" }, (p) => {
        assert.equal(p.assets, 2500);
        assert.equal(p.equity, 2500);
        assert.equal(p.balanced, true);
      }],
      ["report.income_statement", { period: "2026-01" }, (p) => assert.equal(p.currentNetProfit, 300)],
      ["report.cash_flow_statement", { period: "2026-01" }, (p) => {
        assert.equal(p.cashEnd, 1000);
        assert.equal(p.reconciles, true);
      }],
      ["period_end.summary", { period: "2026-01" }, (p) => assert.equal(p.closingDebit, 2500)],
      ["report.trial_balance", { period: "2026-01" }, (p) => assert.equal(p.closingCredit, 2500)],
      ["ledger.general", { period: "2026-01", params: { code: "1122" } }, (p) => assert.equal(p.closingBalance, 300)],
    ];
    for (const [nodeId, extra, check] of cases) {
      const envelope = await modelOk("finance_query", { nodeId, accountSetId: setA, ...extra });
      assert.equal(envelope.nodeId, nodeId);
      assert.equal(Object.prototype.hasOwnProperty.call(envelope.projection, "data"), false);
      check(envelope.projection);
    }
    const draftQuery = await modelOk("finance_query", {
      nodeId: "voucher.detail", accountSetId: setA, params: { voucherId },
    });
    const rawDetail = await readRaw(draftQuery);
    assert.equal(rawDetail.summary, X.summary, "本机引用应能读回凭证摘要");

    await modelFail("finance_query", { nodeId: "nope.nope", accountSetId: setA, period: "2026-01" }, "model_node_unknown");
    await modelFail("finance_query", { nodeId: "invoice.detail", accountSetId: setA, period: "2026-01" }, "model_node_not_implemented");
    await modelFail("finance_query", { nodeId: "report.balance_sheet", accountSetId: setA }, "period_required");
  });

  await test("6. 资产 / 折旧 / 期末检查 / 结转：真实落库与手算金额", async () => {
    const asset = await modelWriteOk("asset_create", {
      accountSetId: setA, kind: "fixed", name: X.assetName, original_cost: 1200,
      residual_rate: 0.05, useful_life_months: 12, start_period: "2026-01", acquired_period: "2026-01",
    });
    assetId = asset.projection.assetId;
    assert.equal(asset.projection.originalCost, 1200);
    const rawAsset = await readRaw(asset);
    assert.equal(rawAsset.name, X.assetName);

    const updated = await modelWriteOk("asset_update", {
      accountSetId: setA, assetId, patch: { ledger_note: X.note },
    });
    assert.equal(updated.projection.ledgerStatus, "booked");
    assertNoLeak(updated, "asset_update");

    const beforeDep = await modelOk("period_end_check", { accountSetId: setA, period: "2026-01" });
    assert.equal(beforeDep.projection.blockingCodes.includes("depreciation_missing"), true);
    assert.equal(beforeDep.projection.stepCount, 7);

    const dep = await modelWriteOk("depreciation_run", { accountSetId: setA, period: "2026-01" });
    assert.equal(dep.projection.runCount, 1);
    assert.equal(dep.projection.totalAmount, 95);

    const afterDep = await modelOk("period_end_check", { accountSetId: setA, period: "2026-01" });
    assert.equal(afterDep.projection.blockingCodes.includes("profit_not_carried_forward"), true);

    const carry = await modelWriteOk("carry_forward_profit", { accountSetId: setA, period: "2026-01" });
    assert.equal(carry.projection.profit, 205);
    const ready = await modelOk("period_end_check", { accountSetId: setA, period: "2026-01" });
    assert.equal(ready.projection.ready, true);

    for (const kind of ["trial-balance", "balance-sheet", "income-statement", "cash-flow-statement"]) {
      const res = await http("GET", `/api/account-sets/${setA}/reports/${kind}?period=2026-01`);
      assert.equal(res.status, 200, `${kind} 预览应保持本机 REST 行为`);
      assertNoInternalFailure(res.text, `${kind} 本机预览`);
    }
    // 本机 UI 通道必须仍然能看到业务原值（模型通道投影不是全局改写业务 DTO）。
    const trial = await http("GET", `/api/account-sets/${setA}/reports/trial-balance?period=2026-01`);
    assert.ok(trial.text.includes(X.accountName), "本机 REST 预览应保留科目名原文");
    const csv = await http("GET", `/api/account-sets/${setA}/reports/balance-sheet/export?period=2026-01&format=csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers["content-type"], /text\/csv/);
    assert.match(csv.headers["content-disposition"], /attachment/);

    const closed = await modelWriteOk("period_set_status", { accountSetId: setA, period: "2026-01", status: "closed" });
    assert.equal(closed.projection.status, "closed");
    await modelFail("voucher_create", {
      accountSetId: setA, period: "2026-01", entries: [{ code: "1001", debit: 1 }, { code: "1002", credit: 1 }],
    }, "period_closed");
  });

  await test("7. 导入 / 批次：默认预检不写、正式导入取真实 setId、幂等回放", async () => {
    const legacyPayload = {
      account_set: { name: X.importName, start_period: "2026-01", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则" },
      opening_balances: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }],
      vouchers: [],
    };
    const before = await http("GET", "/api/account-sets");
    const dry = await modelOk("legacy_book_import", { payload: legacyPayload });
    assert.equal(dry.applied, false);
    assert.equal(dry.appliedReason, "dry_run");
    assert.equal(dry.accountSetId, null);
    assert.equal(dry.localRef, null);
    const afterDry = await http("GET", "/api/account-sets");
    assert.equal(afterDry.data.length, before.data.length, "预检不得新增账套");

    const applied = await modelWriteOk("legacy_book_import", { payload: legacyPayload, dryRun: false });
    assert.equal(applied.accountSetIdSource, "result");
    const afterApplied = await http("GET", "/api/account-sets");
    assert.equal(afterApplied.data.length, before.data.length + 1);

    const preview = await modelOk("book_import_incremental", {
      batchId: `${X.batchId}-preview`,
      source: { system: X.sourceSystem, enterpriseKey: `${X.enterpriseKey}-P` },
      payload: legacyPayload,
    });
    assert.equal(preview.applied, false);
    assert.equal(preview.projection.status, "preview");

    const incremental = await modelWriteOk("book_import_incremental", {
      batchId: `${X.batchId}-apply`,
      source: { system: X.sourceSystem, enterpriseKey: `${X.enterpriseKey}-A` },
      payload: { ...legacyPayload, account_set: { ...legacyPayload.account_set, name: X.incrementalName } },
      dryRun: false,
    });
    assert.equal(incremental.projection.status, "applied");
    const replay = await modelOk("book_import_incremental", {
      batchId: `${X.batchId}-apply`,
      source: { system: X.sourceSystem, enterpriseKey: `${X.enterpriseKey}-A` },
      payload: { ...legacyPayload, account_set: { ...legacyPayload.account_set, name: X.incrementalName } },
      dryRun: false,
    });
    assert.equal(replay.applied, false);
    assert.equal(replay.appliedReason, "idempotent_replay");

    const batch = await modelOk("book_import_batch", { batchId: `${X.batchId}-apply` });
    assert.equal(batch.scope, "batch");
    assert.equal(batch.accountSetId, incremental.accountSetId);
    assert.equal(batch.projection.voucherCount, 0);
    await modelFail("book_import_batch", { batchId: `${X.batchId}-apply`, accountSetId: setB }, "model_scope_mismatch");
  });

  await test("8. 静态目录 / 计划：只回固定常量与计数", async () => {
    const catalog = await modelOk("finance_query_catalog", {});
    assert.equal(catalog.operation, "finance_query_catalog");
    assert.equal(catalog.catalog.unimplemented.length, 11);
    const plan = await modelOk("update_plan", { plan: [X.summary, X.note] });
    assert.equal(plan.projection.planItemCount, 2);
    assert.equal(plan.projection.persisted, false);
  });

  await test("9. 本机引用：跨账套 / 换 operation / 缺 operation / 伪造 channel 全拒绝", async () => {
    const envelope = await modelOk("account_list", { accountSetId: setA });
    const body = { ref: envelope.localRef, accountSetId: setA, operation: envelope.operation };
    const cross = await localRead({ ...body, accountSetId: setB });
    assert.equal(cross.status, 400);
    assert.equal(cross.data.error, "output_policy_ref_cross_account");
    assertNoLeak(cross.data, "cross account error");
    const wrongOp = await localRead({ ...body, operation: "voucher_check" });
    assert.equal(wrongOp.data.error, "output_policy_ref_binding_mismatch");
    const missingOp = await localRead({ ref: body.ref, accountSetId: setA });
    assert.equal(missingOp.data.error, "output_policy_operation_required");
    const forged = await localRead({ ...body, channel: { channelId: "localch_forged" } });
    assert.equal(forged.data.error, "output_policy_channel_untrusted");
    const localFlag = await localRead({ ...body, local: true });
    assert.equal(localFlag.data.error, "output_policy_channel_untrusted");
    const stringChannel = await localRead({ ...body, channel: "local" });
    assert.equal(stringChannel.data.error, "output_policy_channel_untrusted");
    const unknown = await localRead({ ...body, ref: "finref_" + "a".repeat(48) });
    assert.equal(unknown.data.error, "output_policy_ref_unknown");
    const invalidRef = await localRead({ ...body, ref: "nope" });
    assert.equal(invalidRef.data.error, "output_policy_ref_invalid");
    const badOp = await localCompute({ ...body, op: "avg", path: "items" });
    assert.equal(badOp.data.error, "output_policy_compute_op_invalid");
    const badPath = await localCompute({ ...body, op: "sum", path: "constructor.x" });
    assert.equal(badPath.data.error, "output_policy_path_invalid");
  });

  await test("10. 模型通道错误面：无效 JSON / 方法 / content-type / 未知工具与 node 均安全失败", async () => {
    const wrongMethod = await http("GET", "/agent/model-tools/account_list");
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.data.error, "method_not_allowed");
    assertNoLeak(wrongMethod.text, "wrong method");

    const wrongType = await fetch(`${base}/agent/model-tools/account_list`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
    });
    assert.equal(wrongType.status, 415);
    assertNoLeak(await wrongType.text(), "wrong content type");

    const invalidJson = await fetch(`${base}/agent/model-tools/account_list`, {
      method: "POST", headers: { "content-type": "application/json" }, body: `{"x": "${X.summary}"`,
    });
    assert.equal(invalidJson.status, 400);
    const invalidJsonText = await invalidJson.text();
    assert.equal(JSON.parse(invalidJsonText).error, "request_body_invalid");
    assertNoLeak(invalidJsonText, "invalid json");

    const arrayBody = await http("POST", "/agent/model-tools/account_list", [X.summary]);
    assert.equal(arrayBody.status, 400);
    assert.equal(arrayBody.data.error, "request_body_invalid");

    const badName = await http("POST", "/agent/model-tools/account-list", {});
    assert.equal(badName.status, 404);
    assert.equal(badName.data.error, "model_tool_unknown");
    assertNoLeak(badName.text, "bad tool name");

    await modelFail("no_such_tool", {}, "model_tool_unknown");
    await modelFail("invoice_issue", {}, "model_tool_not_implemented");
    await modelFail("tax_login_start", {}, "model_tool_tax_excluded");
    await modelFail("voucher_create", {
      period: "2026-01", entries: [{ code: "1001", debit: 1 }, { code: "1002", credit: 1 }],
    }, "account_set_id_required");
    await modelFail("book_import_batch", {}, "batchId_required");

    const notFound = await http("POST", "/agent/model-tools", {});
    assert.equal(notFound.status, 404);
    assertNoLeak(notFound.text, "model root");
  });

  await test("11. 本机兼容与税务：raw 路由保留原文、税务入口仍走既有链", async () => {
    const rawQuery = await raw("finance_query", {
      nodeId: "voucher.detail", accountSetId: setA, params: { voucherId },
    });
    assert.equal(rawQuery.status, 200);
    assert.equal(rawQuery.data.data.summary, X.summary, "raw 本机兼容入口必须仍能读原文");
    const rawContext = await raw("account_context", {});
    assert.ok(rawContext.data.account_sets.some((s) => s.name === X.enterpriseA));
    const tax = await raw("tax_regions", {});
    assert.equal(tax.status, 200);
    assertNoLeak(tax.text, "tax 既有通道");
  });

  await test("12. loopback / Origin：跨源请求同样被拒绝（模型与本机引用路由）", async () => {
    const origin = "http://evil.example";
    const modelRes = await fetch(`${base}/agent/model-tools/account_list`, {
      method: "POST", headers: { "content-type": "application/json", origin }, body: "{}",
    });
    assert.equal(modelRes.status, 403);
    const localRes = await fetch(`${base}/api/finance-output/read`, {
      method: "POST", headers: { "content-type": "application/json", origin }, body: "{}",
    });
    assert.equal(localRes.status, 403);
    const allowed = await fetch(`${base}/agent/model-tools/account_list`, {
      method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ accountSetId: setA }),
    });
    assert.equal(allowed.status, 200);
  });

  await test("13. 进程重启后旧引用失效（内存引用不持久化）", async () => {
    const envelope = await modelOk("account_list", { accountSetId: setA });
    const body = { ref: envelope.localRef, accountSetId: setA, operation: envelope.operation };
    assert.equal((await localRead(body)).status, 200);
    await stopBackend();
    base = await startBackend();
    const afterRestart = await localRead(body);
    assert.equal(afterRestart.status, 400);
    assert.equal(afterRestart.data.error, "output_policy_ref_unknown");
    const stillWorks = await modelOk("account_context", { accountSetId: setA });
    assert.equal(stillWorks.scope, "account_set");
  });

  await test("14. 服务端日志不含敏感标记 / 数据库路径 / 栈", async () => {
    assertNoLeak(stdout, "后端 stdout");
    assertNoLeak(stderr, "后端 stderr");
  });
  await test("15. same HTTP service concurrent isolated writes and reads", async () => {
    const sets = await Promise.all([31, 47].map((amount) => modelWriteOk("account_set_create", {
      name: `synthetic concurrent HTTP ${amount}`, start_period: "2026-01",
    })));
    const writes = await Promise.all(sets.map((set, i) => modelWriteOk("voucher_create", {
      accountSetId: set.accountSetId, period: "2026-01", status: "posted",
      entries: [{ code: "1001", debit: [31,47][i] }, { code: "5001", credit: [31,47][i] }],
    })));
    const reads = await Promise.all(sets.map((set) => modelOk("ledger_query", {
      accountSetId: set.accountSetId, code: "1001", period: "2026-01",
    })));
    for (let i = 0; i < 2; i++) {
      const setId = sets[i].accountSetId;
      assert.equal(writes[i].accountSetId, setId);
      assert.equal(writes[i].operation, "voucher_create");
      assert.equal(writes[i].projection.totalDebit, [31,47][i]);
      assert.equal(reads[i].accountSetId, setId);
      assert.equal(reads[i].projection.closingBalance, [31,47][i]);
      assert.equal(reads[i].projection.itemCount, 1);
      const local = await localRead({ ref: writes[i].localRef, accountSetId: setId, operation: "voucher_create" });
      assert.equal(local.status, 200);
      assert.equal(local.data.value.id, writes[i].projection.voucherId);
      assert.equal(local.data.value.entries[0].debit, [31,47][i]);
      const cross = await localRead({ ref: writes[i].localRef, accountSetId: sets[1-i].accountSetId, operation: "voucher_create" });
      assert.equal(cross.status, 400);
      const rows = await http("GET", `/api/account-sets/${setId}/vouchers`);
      assert.equal(rows.data.length, 1);
    }
  });
} catch (error) {
  results.push(false);
  console.error("模型 HTTP 入口测试初始化失败：", error.stack);
} finally {
  await stopBackend();
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过\n`);
process.exitCode = failed ? 1 : 0;
