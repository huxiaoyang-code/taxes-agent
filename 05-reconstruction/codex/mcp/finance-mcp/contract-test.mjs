#!/usr/bin/env node
/**
 * contract-test.mjs — MCP ↔ HTTP 后端 端到端契约测试
 *
 * 自己启动临时后端（独立数据目录 + 空闲端口），再 spawn stdio MCP，
 * 覆盖：工具发现、四个扩展工具、必要 CRUD、finance_query 错误路径、
 *       未实现工具的 isError、导入默认预检，
 *       以及直连 HTTP 的入口加固：原型属性名（toString/constructor）不得被误识别、
 *       非法月份拒绝、REST 导入省略 dryRun 不落库、本地扩展 origin=local。
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

const dataDir = mkdtempSync(join(tmpdir(), "mcp-contract-"));
let backend = null;
let client = null;

/** 找一个本机空闲端口，避免和真实 8787 冲突。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
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

/** 直连后端 HTTP（不经 MCP 层）：验证 REST / Agent 入口自身的默认值与拒绝行为。 */
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

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const CSV = {
  meta: "键,值\n账套名称,契约测试导入公司\n纳税人性质,一般纳税人\n会计准则,小企业会计准则\n启用期间,2026-01\n",
  accounts: "科目编码,科目名称,类别,方向\n6602,管理费用,损益,借\n",
  openings: "科目编码,借方,贷方\n1002,50000,0\n3001,0,50000\n",
  vouchers: "期间,日期,字号,凭证号,摘要,科目编码,借方,贷方\n"
    + "2026-01,2026-01-15,记,1,报销办公费,6602,300,0\n"
    + "2026-01,2026-01-15,记,1,报销办公费,1002,0,300\n",
};

try {
  const PORT = await freePort();
  const DEAD_PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;

  backend = spawn(process.execPath, [WORKBENCH], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), WORKBENCH_DATA_DIR: dataDir },
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

  // ---------------- 工具发现 ----------------
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
    // 反向约束：不得把原站契约工具一并标成 local。
    for (const n of ["finance_query", "voucher_create", "legacy_book_import", "invoice_issue"]) {
      assert.equal(byName.get(n)?.origin, "upstream", `${n} 属原站契约，应保持 origin=upstream`);
    }
  });

  await test("finance_query_catalog：items 兼容 + 逐项状态 + 本地扩展单列", async () => {
    const r = await client.call("finance_query_catalog");
    assert.equal(r.isError, false, r.text);
    const d = r.data;
    assert.equal(Object.keys(d.items).length, 21, "items 应保留原站 21 项");
    assert.equal(d.items["report.balance_sheet"], "查询资产负债表");
    const byId = new Map(d.capabilities.map((c) => [c.nodeId, c]));
    assert.equal(byId.get("report.balance_sheet").status, "available");
    assert.equal(byId.get("invoice.unbooked.list").status, "unavailable");
    assert.equal(d.unavailable.length, 11, "原站 11 项应明确不可用");
    assert.ok(d.local_extensions.includes("ledger.general"));
    assert.ok(!Object.keys(d.items).includes("ledger.general"), "本地扩展不得混入原站 items");
  });

  // ---------------- 账套 / 科目 / 期初 / 期间 ----------------
  await test("account_set_create 新建账套并载入标准科目", async () => {
    const r = await client.call("account_set_create", {
      name: "契约测试公司", taxpayer_type: "小规模纳税人",
      accounting_standard: "小企业会计准则", start_period: "2026-01",
    });
    assert.equal(r.isError, false, r.text);
    setId = r.data.id;
    assert.ok(setId > 0);
  });

  await test("account_set_create 非法启用期间被拒绝", async () => {
    const r = await client.call("account_set_create", { name: "坏账套", start_period: "2026/01" });
    assert.equal(r.isError, true);
    assert.equal(r.data.error, "start_period_invalid");
  });

  await test("account_list 返回标准科目", async () => {
    const r = await client.call("account_list", { accountSetId: setId });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.data.items.length >= 55, `科目数 ${r.data.items.length}`);
    assert.ok(r.data.items.find((a) => a.code === "1002"));
  });

  await test("account_create 新增明细科目", async () => {
    const r = await client.call("account_create", {
      accountSetId: setId, code: "100201", name: "工行基本户", category: "资产", direction: "debit",
    });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.data.items.find((a) => a.code === "100201"));
  });

  await test("opening_balance_set / opening_balance_get", async () => {
    const w = await client.call("opening_balance_set", {
      accountSetId: setId,
      items: [{ code: "1002", debit: 100000, credit: 0 }, { code: "3001", debit: 0, credit: 100000 }],
    });
    assert.equal(w.isError, false, w.text);
    const r = await client.call("opening_balance_get", { accountSetId: setId });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.items.find((o) => o.code === "1002").debit, 100000);
  });

  await test("opening_balance_set 不存在的科目被拒绝", async () => {
    const r = await client.call("opening_balance_set", { accountSetId: setId, items: [{ code: "9999", debit: 1, credit: 0 }] });
    assert.equal(r.isError, true);
    assert.match(r.data.error, /account_not_found/);
  });

  await test("period_list 列出启用期间", async () => {
    const r = await client.call("period_list", { accountSetId: setId });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.data.items.find((p) => p.period === "2026-01" && p.status === "open"));
  });

  // ---------------- 凭证 CRUD ----------------
  const entries = [
    { code: "1122", debit: 11300, credit: 0, summary: "销售商品" },
    { code: "5001", debit: 0, credit: 10000, summary: "销售商品" },
    { code: "2221", debit: 0, credit: 1300, summary: "销售商品" },
  ];

  await test("voucher_check 校验借贷平衡", async () => {
    const r = await client.call("voucher_check", { accountSetId: setId, entries });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.ok, true);
    const bad = await client.call("voucher_check", {
      accountSetId: setId,
      entries: [{ code: "1001", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 90 }],
    });
    assert.equal(bad.data.ok, false);
  });

  await test("voucher_create 默认草稿（status 缺省）", async () => {
    const r = await client.call("voucher_create", {
      accountSetId: setId, period: "2026-01", voucher_date: "2026-01-10", summary: "销售商品", entries,
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.status, "draft");
    v1 = r.data.id;
  });

  await test("voucher_create 缺少 period 被拒绝", async () => {
    const r = await client.call("voucher_create", { accountSetId: setId, entries });
    assert.equal(r.isError, true);
    assert.equal(r.data.error, "invalid_arguments");
  });

  await test("voucher_post 过账", async () => {
    const r = await client.call("voucher_post", { accountSetId: setId, voucherId: v1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.status, "posted");
  });

  await test("finance_query 已过账凭证列表（显式 period）", async () => {
    const r = await client.call("finance_query", {
      nodeId: "voucher.generated.list", accountSetId: setId, period: "2026-01",
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.data.length, 1);
    assert.equal(r.data.label, "查询已生成凭证");
  });

  await test("ledger_query 科目明细账", async () => {
    const r = await client.call("ledger_query", { accountSetId: setId, code: "1122", period: "2026-01" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.items.length, 1);
    assert.equal(r.data.items[0].balance, 11300);
  });

  await test("本地扩展查询能力经 finance_query 可用（origin=local）", async () => {
    const tb = await client.call("finance_query", {
      nodeId: "report.trial_balance", accountSetId: setId, period: "2026-01",
    });
    assert.equal(tb.isError, false, tb.text);
    assert.equal(tb.data.origin, "local");
    assert.ok(tb.data.data.totals);

    const gl = await client.call("finance_query", {
      nodeId: "ledger.general", accountSetId: setId, period: "2026-01", params: { code: "1122" },
    });
    assert.equal(gl.isError, false, gl.text);
    assert.equal(gl.data.data.items[0].balance, 11300);

    const noCode = await client.call("finance_query", {
      nodeId: "ledger.general", accountSetId: setId, period: "2026-01",
    });
    assert.equal(noCode.isError, true);
    assert.equal(noCode.data.error, "code_required");
  });

  await test("voucher_unpost 反过账 → 草稿", async () => {
    const r = await client.call("voucher_unpost", { accountSetId: setId, voucherId: v1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.status, "draft");
  });

  await test("voucher_delete 删除草稿凭证", async () => {
    const mk = await client.call("voucher_create", {
      accountSetId: setId, period: "2026-01",
      entries: [{ code: "1001", debit: 5, credit: 0 }, { code: "1002", debit: 0, credit: 5 }],
    });
    throwaway = mk.data.id;
    const r = await client.call("voucher_delete", { accountSetId: setId, voucherId: throwaway });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.deleted, throwaway);
  });

  await test("voucher_delete 已过账凭证被拒绝", async () => {
    await client.call("voucher_post", { accountSetId: setId, voucherId: v1 });
    const r = await client.call("voucher_delete", { accountSetId: setId, voucherId: v1 });
    assert.equal(r.isError, true);
    assert.match(r.data.error, /posted_voucher_requires_unpost/);
  });

  // ---------------- 四个扩展工具 ----------------
  await test("asset_create 新增固定资产卡片", async () => {
    const r = await client.call("asset_create", {
      accountSetId: setId, kind: "fixed", name: "办公设备", original_cost: 60000,
      residual_rate: 0.05, useful_life_months: 60, start_period: "2026-01",
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.monthly, 950);
  });

  await test("asset_list 列出资产卡片", async () => {
    const r = await client.call("asset_list", { accountSetId: setId });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.length, 1);
    assert.equal(r.data[0].name, "办公设备");
  });

  await test("depreciation_run 计提折旧并生成凭证", async () => {
    const r = await client.call("depreciation_run", { accountSetId: setId, period: "2026-01" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.voucher.total_debit, 950);
    assert.equal(r.data.runs.length, 1);
  });

  await test("carry_forward_profit 结转损益（含年末结转）", async () => {
    const r = await client.call("carry_forward_profit", { accountSetId: setId, period: "2026-01", yearEnd: true });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.voucher.kind, "carryforward");
    assert.equal(r.data.profit, 9050);
    assert.ok(r.data.yearEndVoucher, "应生成年末结转凭证");
  });

  await test("结转后利润表净利润 = 9050", async () => {
    const r = await client.call("finance_query", {
      nodeId: "report.income_statement", accountSetId: setId, period: "2026-01",
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.data.current["净利润"], 9050);
  });

  // ---------------- 期间结账 ----------------
  await test("period_set_status 结账后拒绝新增凭证", async () => {
    const c = await client.call("period_set_status", { accountSetId: setId, period: "2026-01", status: "closed" });
    assert.equal(c.isError, false, c.text);
    assert.equal(c.data.status, "closed");
    const r = await client.call("voucher_create", {
      accountSetId: setId, period: "2026-01",
      entries: [{ code: "1001", debit: 1, credit: 0 }, { code: "1002", debit: 0, credit: 1 }],
    });
    assert.equal(r.isError, true);
    assert.match(r.data.error, /period_closed/);
  });

  await test("period_set_status 反结账恢复 open", async () => {
    const r = await client.call("period_set_status", { accountSetId: setId, period: "2026-01", status: "open" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.status, "open");
  });

  // ---------------- finance_query 错误路径 ----------------
  await test("finance_query 缺 accountSetId → invalid_arguments", async () => {
    const r = await client.call("finance_query", { nodeId: "report.income_statement", period: "2026-01" });
    assert.equal(r.isError, true);
    assert.equal(r.data.error, "invalid_arguments");
  });

  await test("finance_query 缺 period → period_required", async () => {
    const r = await client.call("finance_query", { nodeId: "report.income_statement", accountSetId: setId });
    assert.equal(r.isError, true);
    assert.equal(r.data.error, "period_required");
  });

  await test("finance_query 未知 nodeId → unknown_node_id", async () => {
    const r = await client.call("finance_query", { nodeId: "nope.nope", accountSetId: setId, period: "2026-01" });
    assert.equal(r.isError, true);
    assert.equal(r.data.error, "unknown_node_id");
  });

  await test("finance_query 原站未实现查询 → not_implemented", async () => {
    for (const nodeId of ["enterprise_account.bank", "invoice.detail", "fund.unbooked.list"]) {
      const r = await client.call("finance_query", { nodeId, accountSetId: setId, period: "2026-01" });
      assert.equal(r.isError, true, `${nodeId} 应失败`);
      assert.equal(r.data.error, "not_implemented", `${nodeId} 错误码`);
    }
  });

  // ---------------- 原型属性名不得被误当成已登记工具 / 能力 ----------------
  await test("HTTP 入口：toString/constructor 等原型名一律 unknown_tool", async () => {
    for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      const r = await httpJson(BASE, "POST", `/agent/tools/${name}`, {});
      assert.equal(r.status, 404, `POST /agent/tools/${name} 应 404，实际 ${r.status}：${r.text?.slice(0, 120)}`);
      assert.equal(r.data?.error, "unknown_tool", `${name} 应返回 unknown_tool`);
    }
  });

  await test("HTTP 入口：finance_query nodeId 命中原型属性时结构化未实现，不抛 TypeError", async () => {
    for (const nodeId of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const r = await httpJson(BASE, "POST", "/agent/tools/finance_query", { nodeId, accountSetId: setId, period: "2026-01" });
      assert.equal(r.status, 200, `nodeId=${nodeId} 应 200 结构化返回，实际 ${r.status}：${r.text?.slice(0, 160)}`);
      assert.equal(r.data?.not_implemented, true, `nodeId=${nodeId} 应 not_implemented`);
      assert.equal(r.data?.nodeId, nodeId);
      assert.equal(r.data?.error, undefined, `nodeId=${nodeId} 不应是错误响应`);
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
      assert.equal(r.data?.error, "unknown_node_id", `nodeId=${nodeId} 应 unknown_node_id`);
    }
  });

  await test("非法月份 2026-13 / 2026-00 被拒绝（接口层校验）", async () => {
    for (const period of ["2026-13", "2026-00"]) {
      const q = await client.call("finance_query", { nodeId: "report.income_statement", accountSetId: setId, period });
      assert.equal(q.isError, true, `finance_query period=${period} 应失败`);
      assert.equal(q.data?.error, "period_invalid", `finance_query period=${period} 错误码`);

      const c = await client.call("account_set_create", { name: `坏月份${period}`, start_period: period });
      assert.equal(c.isError, true, `account_set_create start_period=${period} 应失败`);
      assert.equal(c.data?.error, "start_period_invalid", `account_set_create start_period=${period} 错误码`);
    }
    // 合法边界月份仍可用（避免把校验写死到个别月份）
    const ok = await client.call("finance_query", { nodeId: "report.income_statement", accountSetId: setId, period: "2026-12" });
    assert.equal(ok.isError, false, ok.text);
  });

  await test("未知账套 → account_set_not_found", async () => {
    const r = await client.call("account_list", { accountSetId: 999999 });
    assert.equal(r.isError, true);
    assert.match(r.data.error, /account_set_not_found/);
  });

  // ---------------- 未实现工具必须 isError 且结构化 ----------------
  await test("未实现工具（发票/申报/exec/任务状态）返回 isError", async () => {
    for (const name of ["invoice_issue", "invoice_precheck", "invoice_tax_code",
      "declaration_query", "tax_declaration_query", "exec", "finance_task_status"]) {
      const r = await client.call(name, {});
      assert.equal(r.isError, true, `${name} 应 isError`);
      assert.equal(r.data?.error, "not_implemented", `${name} 应结构化 not_implemented`);
      assert.ok(r.structured?.error === "not_implemented", `${name} 应有 structuredContent`);
    }
  });

  await test("update_plan 不谎报持久化", async () => {
    const r = await client.call("update_plan", { plan: ["导入旧账", "出报表"] });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.saved, false);
    assert.equal(r.data.persisted, false);
  });

  await test("account_context 不保存当前账套且不做写操作", async () => {
    const r = await client.call("account_context", { accountSetId: setId });
    assert.equal(r.isError, false, r.text);
    assert.ok(Array.isArray(r.data.account_sets));
    assert.equal(r.data.current_account_set_id, null);
    assert.equal(r.data.persisted, false);
  });

  // ---------------- 导入默认预检 ----------------
  await test("REST /api/import/account-set 省略 dryRun 时默认预检且不落库", async () => {
    // 用独立账套名，避免与 MCP 侧的正式导入互相干扰。
    const texts = { ...CSV, meta: CSV.meta.replace("契约测试导入公司", "REST预检公司") };
    const parsed = await httpJson(BASE, "POST", "/api/import/parse", { texts });
    assert.equal(parsed.status, 200, parsed.text?.slice(0, 160));

    const before = await httpJson(BASE, "GET", "/api/account-sets");
    assert.equal(before.status, 200);
    assert.ok(!before.data.some((s) => s.name === "REST预检公司"), "前置条件：该账套尚不存在");

    // 请求体刻意不带 dryRun —— HTTP 默认值才是这次真正变更的行为。
    const r = await httpJson(BASE, "POST", "/api/import/account-set", { payload: parsed.data.payload });
    assert.equal(r.status, 201, r.text?.slice(0, 160));
    assert.equal(r.data?.dryRun, true, "省略 dryRun 必须默认预检");
    assert.equal(r.data?.created, null, "预检不得返回 created");
    assert.equal(r.data?.validation?.ok, true, JSON.stringify(r.data?.validation?.errors));

    const after = await httpJson(BASE, "GET", "/api/account-sets");
    assert.equal(after.data.length, before.data.length, "预检不得新增账套");
    assert.ok(!after.data.some((s) => s.name === "REST预检公司"), "预检不得落库该账套");
  });

  await test("legacy_book_import 默认 dryRun=true（不落库）", async () => {
    const r = await client.call("legacy_book_import", { texts: CSV });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.dryRun, true);
    assert.equal(r.data.created, null);
    assert.equal(r.data.validation.ok, true, JSON.stringify(r.data.validation.errors));
  });

  await test("legacy_book_import dryRun=false 才正式导入", async () => {
    const r = await client.call("legacy_book_import", { texts: CSV, dryRun: false });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.dryRun, false);
    assert.equal(r.data.created.name, "契约测试导入公司");
    assert.equal(r.data.created.vouchers, 1);
  });

  await test("导入后报表勾稽（资产负债表平衡）", async () => {
    const imp = await client.call("legacy_book_import", { texts: CSV, dryRun: false });
    const newId = imp.data.created.id;
    const r = await client.call("finance_query", {
      nodeId: "report.balance_sheet", accountSetId: newId, period: "2026-01",
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.data.balanced, true);
  });

  // ---------------- 后端不可达的错误清晰性 ----------------
  await test("后端不可达返回 backend_unreachable（而非二次 JSON 错误）", async () => {
    const dead = new McpStdioClient(join(here, "server.mjs"), {
      env: { FINANCE_API_BASE: `http://127.0.0.1:${DEAD_PORT}` },
      timeoutMs: 20000,
    }).start();
    try {
      await dead.initialize("contract-dead");
      const r = await dead.call("account_list", { accountSetId: 1 });
      assert.equal(r.isError, true);
      assert.equal(r.data.error, "backend_unreachable");
      assert.ok(r.data.message.includes("无法连接"), r.data.message);
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
