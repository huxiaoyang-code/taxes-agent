#!/usr/bin/env node
// Fixed synthetic test identities, independent of display names and production defaults.
let identityFixtureSequence = 0;
const identityFixture = () => ({ enterpriseKey: 'SYNTHETIC-contract-test-mjs-' + (++identityFixtureSequence) });

/**
 * contract-test.mjs — MCP ↔ HTTP 后端 端到端契约测试（LOCAL-08 模型信封版）
 *
 * 自己启动临时后端（独立数据目录 + 空闲端口），再 spawn stdio MCP，覆盖：
 * 工具发现、扩展工具、必要 CRUD、finance_query 错误路径、未实现工具 isError、导入默认预检，
 * 以及直连 HTTP 的入口加固（原型属性名、非法月份、REST 导入默认预检、本地扩展 origin）。
 *
 * LOCAL-08：普通财务工具经 MCP 返回**模型投影信封**。业务原文核对搬到本机通道：
 *   - `POST /api/finance-output/read`（用信封里的 localRef）读原 DTO；
 *   - `POST /agent/tools/<name>`（本机兼容 raw 路由）核对业务校验 / 失败原因。
 *
 * 运行：node contract-test.mjs
 * 不连接 8787，也不触碰 06-workbench/data/；退出时清理自建子进程与临时库。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { McpStdioClient } from "./mcp-stdio-client.mjs";
import { TOOLS } from "./tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..", "..");
const WORKBENCH = join(REPO, "06-workbench", "server", "server.mjs");
const SENSITIVE = "契约测试公司";

const dataDir = mkdtempSync(join(tmpdir(), "mcp-contract-"));
let backend = null;
let client = null;
let BASE = "";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function waitReady(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/meta`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error("backend_not_ready");
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function httpJson(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 保留原始文本 */ }
  return { status: res.status, data, text };
}

/** 本机通道：用模型信封里的引用读回原 DTO（证明原文只在本机可读）。 */
async function localValue(envelope, label = "localRef") {
  assert.match(String(envelope?.localRef), /^finref_[a-f0-9]{48}$/, `${label} 应有 localRef`);
  const r = await httpJson(BASE, "POST", "/api/finance-output/read", {
    ref: envelope.localRef, accountSetId: envelope.accountSetId, operation: envelope.operation,
  });
  assert.equal(r.status, 200, `${label} 本机读取应 200：${r.text?.slice(0, 160)}`);
  assert.equal(r.data?.channel, "local");
  return r.data.value;
}
/** 本机兼容 raw 路由：核对业务校验 / 失败原因（模型通道只给固定码）。 */
async function rawAgent(name, args) {
  return httpJson(BASE, "POST", `/agent/tools/${name}`, args);
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const CSV = {
  meta: "键,值\n账套名称,契约测试导入公司\n纳税人性质,一般纳税人\n会计准则,小企业会计准则\n启用期间,2026-01\n",
  accounts: "科目编码,科目名称,类别,方向\n5602,管理费用,损益,借\n",
  openings: "科目编码,借方,贷方\n1002,50000,0\n3001,0,50000\n",
  vouchers: "期间,日期,字号,凭证号,摘要,科目编码,借方,贷方\n"
    + "2026-01,2026-01-15,记,1,报销办公费,5602,300,0\n"
    + "2026-01,2026-01-15,记,1,报销办公费,1002,0,300\n",
};

try {
  const PORT = await freePort();
  const DEAD_PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;

  backend = spawn(process.execPath, [WORKBENCH], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", WORKBENCH_DATA_DIR: dataDir },
  });
  let backendErr = "";
  backend.stderr.on("data", (d) => { backendErr += d; });
  backend.on("exit", (code) => { if (code) backendErr += `\nbackend exited code=${code}`; });
  await waitReady(BASE);

  client = new McpStdioClient(join(here, "server.mjs"), {
    env: { FINANCE_API_BASE: BASE, FINANCE_API_TIMEOUT_MS: "10000" },
    timeoutMs: 20000,
  }).start();

  console.log(`\nMCP 契约测试 @ ${BASE}（数据目录 ${dataDir}）\n`);
  await client.initialize("contract");

  let setId, v1, throwaway;

  await test("tools/list 公布全部必需工具且有 schema", async () => {
    const list = await client.rpc("tools/list");
    const names = list.result.tools.map((t) => t.name);
    const required = [
      "finance_query", "finance_query_catalog", "finance_context_resolve", "account_context",
      "voucher_check", "voucher_create", "legacy_book_import", "skills_list", "skills_read",
      "asset_list", "asset_create", "depreciation_run", "carry_forward_profit",
      "account_set_create", "account_list", "account_create",
      "opening_balance_get", "opening_balance_set",
      "period_list", "period_set_status",
      "voucher_post", "voucher_unpost", "voucher_delete",
      "ledger_query", "update_plan",
      "invoice_issue", "declaration_query", "tax_declaration_query", "exec", "finance_task_status",
    ];
    for (const n of required) assert.ok(names.includes(n), `缺少工具 ${n}`);
    for (const t of list.result.tools) {
      assert.equal(t.inputSchema?.type, "object", `${t.name} 应有 object schema`);
      assert.ok(t.description && t.description.length > 4, `${t.name} 应有描述`);
    }
    assert.equal(new Set(names).size, names.length, "工具名不应重复");
  });

  await test("本地扩展工具标 origin=local，原站契约工具仍为 upstream", async () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t]));
    for (const n of ["asset_list", "asset_create", "depreciation_run", "carry_forward_profit"]) {
      assert.equal(byName.get(n)?.origin, "local", `${n} 是本地扩展，必须 origin=local`);
    }
    for (const n of ["finance_query", "voucher_create", "legacy_book_import", "invoice_issue"]) {
      assert.equal(byName.get(n)?.origin, "upstream", `${n} 属原站契约，应保持 origin=upstream`);
    }
  });

  await test("finance_query_catalog：静态摘要目录（12 / 11 / 2），不回原文", async () => {
    const r = await client.call("finance_query_catalog");
    assert.equal(r.isError, false, r.text);
    const d = r.data;
    assert.equal(d.ok, true);
    assert.equal(d.operation, "finance_query_catalog");
    assert.equal(d.scope, "global");
    assert.equal(d.localRef, null);
    assert.equal(d.catalog.available.length, 12);
    assert.equal(d.catalog.unimplemented.length, 11);
    assert.deepEqual(d.catalog.localExtensions.sort(), ["ledger.general", "report.trial_balance"]);
    assert.equal(Object.prototype.hasOwnProperty.call(d, "items"), false, "不再把原站 21 条原文返回模型");
    assert.equal(Object.prototype.hasOwnProperty.call(d, "capabilities"), false);
  });

  await test("account_set_create 新建账套并载入标准科目（applied=true）", async () => {
    const r = await client.call("account_set_create", { enterprise: identityFixture(),
      name: SENSITIVE, taxpayer_type: "小规模纳税人",
      accounting_standard: "小企业会计准则", start_period: "2026-01",
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.applied, true);
    setId = r.data.accountSetId;
    assert.ok(setId > 0);
    const raw = await localValue(r.data, "account_set_create");
    assert.equal(raw.name, SENSITIVE);
    assert.equal(raw.start_period, "2026-01");
  });

  await test("account_set_create 非法启用期间被拒绝（固定码）", async () => {
    const r = await client.call("account_set_create", { enterprise: identityFixture(), name: "坏账套", start_period: "2026/01" });
    assert.equal(r.isError, true);
    assert.equal(r.data.error.code, "start_period_invalid");
  });

  await test("account_list 返回科目计数摘要；本机引用可读回原科目", async () => {
    const r = await client.call("account_list", { accountSetId: setId });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.data.projection.accountCount >= 55, `科目数 ${r.data.projection.accountCount}`);
    const raw = await localValue(r.data, "account_list");
    assert.ok(raw.items.find((a) => a.code === "1002"));
  });

  await test("account_create 新增明细科目", async () => {
    const r = await client.call("account_create", {
      accountSetId: setId, code: "100201", name: "工行基本户", category: "资产", direction: "debit",
    });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.data.projection.accountCount >= 56);
    const raw = await localValue(r.data, "account_create");
    assert.ok(raw.items.find((a) => a.code === "100201"));
  });

  await test("opening_balance_set / opening_balance_get（摘要 + 本机原值）", async () => {
    const w = await client.call("opening_balance_set", {
      accountSetId: setId,
      items: [
        { code: "1002", debit: 100000, credit: 0 },
        { code: "1601", debit: 60000, credit: 0 },
        { code: "3001", debit: 0, credit: 160000 },
      ],
    });
    assert.equal(w.isError, false, w.text);
    assert.equal(w.data.projection.itemCount, 3);
    const r = await client.call("opening_balance_get", { accountSetId: setId });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.itemCount, 3);
    assert.equal(r.data.projection.totalDebit, 160000);
    assert.equal(r.data.projection.balanced, true);
    const raw = await localValue(r.data, "opening_balance_get");
    assert.equal(raw.items.find((o) => o.code === "1002").debit, 100000);
    assert.equal(raw.items.find((o) => o.code === "1601").debit, 60000);
  });

  await test("opening_balance_set 不存在的科目被拒绝（模型固定码 + 本机原因）", async () => {
    const r = await client.call("opening_balance_set", { accountSetId: setId, items: [{ code: "9999", debit: 1, credit: 0 }] });
    assert.equal(r.isError, true);
    // 模型通道只回固定码：域错误 message 内嵌科目编码，不会被四显。
    assert.equal(r.data.error.code, "operation_failed");
    assert.equal(r.text.includes("9999"), false);
    const raw = await rawAgent("opening_balance_set", { accountSetId: setId, items: [{ code: "9999", debit: 1, credit: 0 }] });
    assert.equal(raw.status, 400);
    assert.match(raw.text, /account_not_found/);
  });

  await test("period_list 列出启用期间（本机原值核对）", async () => {
    const r = await client.call("period_list", { accountSetId: setId });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.openPeriodCount, 1);
    const raw = await localValue(r.data, "period_list");
    assert.ok(raw.items.find((p) => p.period === "2026-01" && p.status === "open"));
  });

  const entries = [
    { code: "1122", debit: 11300, credit: 0, summary: "销售商品" },
    { code: "5001", debit: 0, credit: 10000, summary: "销售商品" },
    { code: "2221", debit: 0, credit: 1300, summary: "销售商品" },
  ];

  await test("voucher_check 校验借贷平衡", async () => {
    const r = await client.call("voucher_check", { accountSetId: setId, entries });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.checkOk, true);
    assert.equal(r.data.projection.balanced, true);
    const bad = await client.call("voucher_check", {
      accountSetId: setId,
      entries: [{ code: "1001", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 90 }],
    });
    assert.equal(bad.data.projection.checkOk, false);
    assert.equal(bad.data.projection.balanced, false);
  });

  await test("voucher_create 默认草稿（status 缺省）", async () => {
    const r = await client.call("voucher_create", {
      accountSetId: setId, period: "2026-01", voucher_date: "2026-01-10", summary: "销售商品", entries,
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.status, "draft");
    assert.equal(r.data.projection.totalDebit, 11300);
    v1 = r.data.projection.voucherId;
    const raw = await localValue(r.data, "voucher_create");
    assert.equal(raw.status, "draft");
  });

  await test("voucher_create 缺少 period 被拒绝", async () => {
    const r = await client.call("voucher_create", { accountSetId: setId, entries });
    assert.equal(r.isError, true);
    assert.equal(r.data.error, "invalid_arguments");
  });

  await test("voucher_post 过账", async () => {
    const r = await client.call("voucher_post", { accountSetId: setId, voucherId: v1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.status, "posted");
    assert.equal(r.data.applied, true);
  });

  await test("finance_query 已过账凭证列表（摘要 + 本机原值）", async () => {
    const r = await client.call("finance_query", {
      nodeId: "voucher.generated.list", accountSetId: setId, period: "2026-01",
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.voucherCount, 1);
    assert.equal(r.data.nodeId, "voucher.generated.list");
    const raw = await localValue(r.data, "voucher.generated.list");
    assert.equal(raw.length, 1);
    assert.equal(raw[0].id, v1);
  });

  await test("ledger_query 科目明细账（摘要 + 本机原值）", async () => {
    const r = await client.call("ledger_query", { accountSetId: setId, code: "1122", period: "2026-01" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.itemCount, 1);
    assert.equal(r.data.projection.closingBalance, 11300);
    const raw = await localValue(r.data, "ledger_query");
    assert.equal(raw.items[0].balance, 11300);
  });

  await test("本地扩展查询能力经 finance_query 可用（origin=local）", async () => {
    const tb = await client.call("finance_query", {
      nodeId: "report.trial_balance", accountSetId: setId, period: "2026-01",
    });
    assert.equal(tb.isError, false, tb.text);
    assert.equal(tb.data.projection.balanced, true);
    const rawTb = await localValue(tb.data, "report.trial_balance");
    assert.ok(rawTb.totals);

    const gl = await client.call("finance_query", {
      nodeId: "ledger.general", accountSetId: setId, period: "2026-01", params: { code: "1122" },
    });
    assert.equal(gl.isError, false, gl.text);
    assert.equal(gl.data.projection.closingBalance, 11300);
    const rawGl = await localValue(gl.data, "ledger.general");
    assert.equal(rawGl.items[0].balance, 11300);

    const noCode = await client.call("finance_query", {
      nodeId: "ledger.general", accountSetId: setId, period: "2026-01",
    });
    assert.equal(noCode.isError, true);
    assert.equal(noCode.data.error.code, "code_required");
  });

  await test("voucher_unpost 反过账 → 草稿", async () => {
    const r = await client.call("voucher_unpost", { accountSetId: setId, voucherId: v1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.status, "draft");
  });

  await test("voucher_delete 删除草稿凭证", async () => {
    const mk = await client.call("voucher_create", {
      accountSetId: setId, period: "2026-01",
      entries: [{ code: "1001", debit: 5, credit: 0 }, { code: "1002", debit: 0, credit: 5 }],
    });
    throwaway = mk.data.projection.voucherId;
    const r = await client.call("voucher_delete", { accountSetId: setId, voucherId: throwaway });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.deletedVoucherId, throwaway);
  });

  await test("voucher_delete 已过账凭证被拒绝", async () => {
    await client.call("voucher_post", { accountSetId: setId, voucherId: v1 });
    const r = await client.call("voucher_delete", { accountSetId: setId, voucherId: v1 });
    assert.equal(r.isError, true);
    assert.equal(r.data.error.code, "posted_voucher_requires_unpost");
  });

  await test("asset_create 新增固定资产卡片", async () => {
    const r = await client.call("asset_create", {
      accountSetId: setId, kind: "fixed", name: "办公设备", original_cost: 60000,
      residual_rate: 0.05, useful_life_months: 60, start_period: "2026-01", acquired_period: "2026-01",
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.applied, true);
    assert.equal(r.data.projection.originalCost, 60000);
    const raw = await localValue(r.data, "asset_create");
    assert.equal(raw.monthly, 950);
  });

  await test("asset_list 列出资产卡片（摘要 + 本机原值）", async () => {
    const r = await client.call("asset_list", { accountSetId: setId });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.cardCount, 1);
    assert.equal(r.data.projection.totalOriginalCost, 60000);
    const raw = await localValue(r.data, "asset_list");
    assert.equal(raw[0].name, "办公设备");
  });

  await test("depreciation_run 计提折旧并生成凭证", async () => {
    const r = await client.call("depreciation_run", { accountSetId: setId, period: "2026-01" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.totalAmount, 950);
    assert.equal(r.data.projection.runCount, 1);
    const raw = await localValue(r.data, "depreciation_run");
    assert.equal(raw.voucher.total_debit, 950);
    assert.equal(raw.runs.length, 1);
  });

  await test("carry_forward_profit 结转损益（含年末结转）", async () => {
    const r = await client.call("carry_forward_profit", { accountSetId: setId, period: "2026-01", yearEnd: true });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.profit, 9050);
    assert.ok(r.data.projection.voucherId > 0);
    assert.ok(r.data.projection.yearEndVoucherId > 0);
    const raw = await localValue(r.data, "carry_forward_profit");
    assert.equal(raw.voucher.kind, "carryforward");
    assert.ok(raw.yearEndVoucher, "应生成年末结转凭证");
  });

  await test("结转后利润表净利润 = 9050", async () => {
    const r = await client.call("finance_query", {
      nodeId: "report.income_statement", accountSetId: setId, period: "2026-01",
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.currentNetProfit, 9050);
    const raw = await localValue(r.data, "income_statement");
    assert.equal(raw.current["净利润"], 9050);
  });

  await test("period_set_status 结账后拒绝新增凭证", async () => {
    const c = await client.call("period_set_status", { accountSetId: setId, period: "2026-01", status: "closed" });
    assert.equal(c.isError, false, c.text);
    assert.equal(c.data.projection.status, "closed");
    const r = await client.call("voucher_create", {
      accountSetId: setId, period: "2026-01",
      entries: [{ code: "1001", debit: 1, credit: 0 }, { code: "1002", debit: 0, credit: 1 }],
    });
    assert.equal(r.isError, true);
    assert.equal(r.data.error.code, "period_closed");
  });

  await test("period_set_status 反结账恢复 open", async () => {
    const r = await client.call("period_set_status", { accountSetId: setId, period: "2026-01", status: "open" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.status, "open");
  });

  await test("finance_query 缺 accountSetId → invalid_arguments（MCP schema）", async () => {
    const r = await client.call("finance_query", { nodeId: "report.income_statement", period: "2026-01" });
    assert.equal(r.isError, true);
    assert.equal(r.data.error, "invalid_arguments");
  });

  await test("finance_query 缺 period → period_required", async () => {
    const r = await client.call("finance_query", { nodeId: "report.income_statement", accountSetId: setId });
    assert.equal(r.isError, true);
    assert.equal(r.data.error.code, "period_required");
  });

  await test("finance_query 未知 nodeId → model_node_unknown", async () => {
    const r = await client.call("finance_query", { nodeId: "nope.nope", accountSetId: setId, period: "2026-01" });
    assert.equal(r.isError, true);
    assert.equal(r.data.error.code, "model_node_unknown");
  });

  await test("finance_query 原站未实现查询 → model_node_not_implemented", async () => {
    for (const nodeId of ["enterprise_account.bank", "invoice.detail", "fund.unbooked.list"]) {
      const r = await client.call("finance_query", { nodeId, accountSetId: setId, period: "2026-01" });
      assert.equal(r.isError, true, `${nodeId} 应失败`);
      assert.equal(r.data.error.code, "model_node_not_implemented", `${nodeId} 错误码`);
    }
  });

  await test("HTTP raw 入口：toString/constructor 等原型名一律 unknown_tool", async () => {
    for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      const r = await httpJson(BASE, "POST", `/agent/tools/${name}`, {});
      assert.equal(r.status, 404, `POST /agent/tools/${name} 应 404，实际 ${r.status}：${r.text?.slice(0, 120)}`);
      assert.equal(r.data?.error, "unknown_tool", `${name} 应返回 unknown_tool`);
    }
  });

  await test("HTTP raw 入口：finance_query 原型 nodeId 仍结构化未实现（本机兼容不变）", async () => {
    for (const nodeId of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const r = await httpJson(BASE, "POST", "/agent/tools/finance_query", { nodeId, accountSetId: setId, period: "2026-01" });
      assert.equal(r.status, 200, `nodeId=${nodeId} 应 200 结构化返回，实际 ${r.status}`);
      assert.equal(r.data?.not_implemented, true, `nodeId=${nodeId} 应 not_implemented`);
      assert.equal(r.data?.nodeId, nodeId);
    }
  });

  await test("MCP 层同样拒绝原型属性名（工具名与 nodeId）", async () => {
    for (const name of ["toString", "constructor"]) {
      const r = await client.call(name, {});
      assert.equal(r.isError, true, `${name} 应 isError`);
      assert.equal(r.data?.error, "unknown_tool", `${name} 应 unknown_tool`);
    }
    for (const nodeId of ["constructor", "toString", "__proto__"]) {
      const r = await client.call("finance_query", { nodeId, accountSetId: setId, period: "2026-01" });
      assert.equal(r.isError, true, `nodeId=${nodeId} 应 isError`);
      assert.equal(r.data?.error?.code, "model_node_unknown", `nodeId=${nodeId} 应 model_node_unknown`);
    }
  });

  await test("非法月份 2026-13 / 2026-00 被拒绝（固定码）", async () => {
    for (const period of ["2026-13", "2026-00"]) {
      const q = await client.call("finance_query", { nodeId: "report.income_statement", accountSetId: setId, period });
      assert.equal(q.isError, true, `finance_query period=${period} 应失败`);
      assert.equal(q.data?.error?.code, "period_invalid", `finance_query period=${period} 错误码`);

      const c = await client.call("account_set_create", { enterprise: identityFixture(), name: `坏月份${period}`, start_period: period });
      assert.equal(c.isError, true, `account_set_create start_period=${period} 应失败`);
      assert.equal(c.data?.error?.code, "start_period_invalid", `account_set_create start_period=${period} 错误码`);
    }
    const ok = await client.call("finance_query", { nodeId: "report.income_statement", accountSetId: setId, period: "2026-12" });
    assert.equal(ok.isError, false, ok.text);
  });

  await test("未知账套 → account_set_not_found", async () => {
    const r = await client.call("account_list", { accountSetId: 999999 });
    assert.equal(r.isError, true);
    assert.equal(r.data.error.code, "account_set_not_found");
  });

  await test("未实现工具（发票/申报/exec/任务状态）返回 isError", async () => {
    for (const name of ["invoice_issue", "invoice_precheck", "invoice_tax_code",
      "declaration_query", "tax_declaration_query", "exec", "finance_task_status"]) {
      const r = await client.call(name, {});
      assert.equal(r.isError, true, `${name} 应 isError`);
      assert.equal(r.data?.error, "not_implemented", `${name} 应结构化 not_implemented`);
      assert.ok(r.structured?.error === "not_implemented", `${name} 应有 structuredContent`);
    }
  });

  await test("update_plan 不谎报持久化、不回显计划文本", async () => {
    const r = await client.call("update_plan", { plan: ["导入旧账", "出报表"] });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.saved, false);
    assert.equal(r.data.projection.persisted, false);
    assert.equal(r.data.projection.planItemCount, 2);
    assert.equal(r.text.includes("导入旧账"), false);
  });

  await test("account_context 不保存当前账套且不做写操作", async () => {
    const r = await client.call("account_context", { accountSetId: setId });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.scope, "account_set");
    assert.equal(r.data.projection.accountSetId, setId);
    assert.equal(r.data.projection.persisted, false);
    const global = await client.call("account_context", {});
    assert.equal(global.data.scope, "global");
    assert.equal(global.data.accountSetId, null);
    assert.equal(global.data.projection.accountSetId, undefined);
    assert.equal(global.text.includes(SENSITIVE), false, "模型通道不得回显企业名");
  });

  await test("REST /api/import/account-set 省略 dryRun 时默认预检且不落库", async () => {
    const texts = { ...CSV, meta: CSV.meta.replace("契约测试导入公司", "REST预检公司") };
    const parsed = await httpJson(BASE, "POST", "/api/import/parse", { enterprise: identityFixture(), texts });
    assert.equal(parsed.status, 200, parsed.text?.slice(0, 160));

    const before = await httpJson(BASE, "GET", "/api/account-sets");
    assert.equal(before.status, 200);
    assert.ok(!before.data.some((s) => s.name === "REST预检公司"), "前置条件：该账套尚不存在");

    const r = await httpJson(BASE, "POST", "/api/import/account-set", { enterprise: identityFixture(), payload: parsed.data.payload });
    assert.equal(r.status, 201, r.text?.slice(0, 160));
    assert.equal(r.data?.dryRun, true, "省略 dryRun 必须默认预检");
    assert.equal(r.data?.created, null, "预检不得返回 created");
    assert.equal(r.data?.validation?.ok, true, JSON.stringify(r.data?.validation?.errors));

    const after = await httpJson(BASE, "GET", "/api/account-sets");
    assert.equal(after.data.length, before.data.length, "预检不得新增账套");
    assert.ok(!after.data.some((s) => s.name === "REST预检公司"), "预检不得落库该账套");
  });

  await test("legacy_book_import 默认 dryRun=true（模型信封 + 本机校验摘要）", async () => {
    const r = await client.call("legacy_book_import", { enterprise: identityFixture(), texts: CSV });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.applied, false);
    assert.equal(r.data.appliedReason, "dry_run");
    assert.equal(r.data.accountSetId, null);
    assert.equal(r.data.localRef, null);
    assert.equal(r.data.projection.dryRun, true);
    assert.equal(r.data.projection.validationOk, true);
    // 业务校验摘要（created / 明细计数）走本机 raw 通道核对。
    const raw = await rawAgent("legacy_book_import", { enterprise: identityFixture(), texts: CSV });
    assert.equal(raw.status, 200, raw.text?.slice(0, 160));
    assert.equal(raw.data.created, null);
    assert.equal(raw.data.validation.ok, true, JSON.stringify(raw.data.validation.errors));
    assert.equal(raw.data.validation.summary.vouchers, 1);
  });

  await test("legacy_book_import dryRun=false 才正式导入（setId 取真实结果）", async () => {
    const r = await client.call("legacy_book_import", { enterprise: identityFixture(), texts: CSV, dryRun: false });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.applied, true);
    assert.equal(r.data.accountSetIdSource, "result");
    assert.equal(r.data.projection.createdAccountSetId, r.data.accountSetId);
    const raw = await localValue(r.data, "legacy_book_import");
    assert.equal(raw.created.name, "契约测试导入公司");
    assert.equal(raw.created.vouchers, 1);
    assert.ok(raw.created.accounts >= 55);
  });

  await test("导入后报表勾稽（资产负债表平衡）", async () => {
    const imp = await client.call("legacy_book_import", { enterprise: identityFixture(), texts: CSV, dryRun: false });
    const newId = imp.data.projection.createdAccountSetId;
    const r = await client.call("finance_query", {
      nodeId: "report.balance_sheet", accountSetId: newId, period: "2026-01",
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.projection.balanced, true);
  });

  await test("本机引用：伪造 channel / 跨账套 / 未知 ref 全部拒绝", async () => {
    const envelope = (await client.call("account_list", { accountSetId: setId })).data;
    const body = { ref: envelope.localRef, accountSetId: setId, operation: envelope.operation };
    const forged = await httpJson(BASE, "POST", "/api/finance-output/read", { ...body, channel: { channelId: "localch_fake" } });
    assert.equal(forged.status, 400);
    assert.equal(forged.data.error, "output_policy_channel_untrusted");
    const cross = await httpJson(BASE, "POST", "/api/finance-output/read", { ...body, accountSetId: setId + 1 });
    assert.equal(cross.data.error, "output_policy_ref_cross_account");
    const unknown = await httpJson(BASE, "POST", "/api/finance-output/read", { ...body, ref: "finref_" + "b".repeat(48) });
    assert.equal(unknown.data.error, "output_policy_ref_unknown");
  });

  await test("模型通道不回显企业名 / 科目名 / 凭证摘要", async () => {
    const r = await client.call("finance_query", {
      nodeId: "voucher.detail", accountSetId: setId, params: { voucherId: v1 },
    });
    assert.equal(r.isError, false, r.text);
    for (const needle of ["契约测试公司", "销售商品", "应收", "工行基本户"]) {
      assert.equal(r.text.includes(needle), false, `模型输出不应包含 ${needle}`);
    }
  });

  await test("后端不可达返回固定运输失败（不回显地址）", async () => {
    const dead = new McpStdioClient(join(here, "server.mjs"), {
      env: { FINANCE_API_BASE: `http://127.0.0.1:${DEAD_PORT}` },
      timeoutMs: 20000,
    }).start();
    try {
      await dead.initialize("contract-dead");
      const r = await dead.call("account_list", { accountSetId: 1 });
      assert.equal(r.isError, true);
      assert.equal(r.data.error, "backend_unreachable");
      assert.equal(r.data.retriable, true);
      assert.equal(r.text.includes(String(DEAD_PORT)), false, "不得回显后端地址");
      assert.equal(r.text.includes("127.0.0.1"), false);
    } finally {
      await dead.close();
    }
  });
} catch (e) {
  results.push([false, "测试初始化"]);
  console.error("契约测试初始化失败：", e.message);
} finally {
  if (client) await client.close();
  if (backend && !backend.killed) {
    const done = new Promise((r) => backend.once("exit", r));
    backend.kill();
    await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
    if (backend.exitCode === null && backend.signalCode === null) { try { backend.kill("SIGKILL"); } catch { /* ignore */ } }
  }
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过\n`);
process.exitCode = failed ? 1 : 0;
