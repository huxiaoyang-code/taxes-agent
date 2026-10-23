#!/usr/bin/env node
/**
 * smoke-test.mjs — MCP 冒烟：握手、工具清单、本地资源、错误路径、真实模型信封。
 *
 * LOCAL-08：普通财务工具固定返回模型投影信封（projection + localRef），
 * 因此本套件只断言信封字段与固定错误码；业务原文/SQL 不在这里核对。
 *
 * 运行：node smoke-test.mjs
 * 后端：脚本自行拉起临时后端（临时数据目录 + PORT=0），FINANCE_API_BASE 由脚本显式注入。
 * 绝不连接默认 8787 或工程 data/。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { McpStdioClient } from "./mcp-stdio-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..", "..");
const WORKBENCH = join(REPO, "06-workbench", "server", "server.mjs");

const dataDir = mkdtempSync(join(tmpdir(), "mcp-smoke-"));
let backend = null;
let client = null;

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
      const res = await fetch(`${base}/api/meta`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error("backend_not_ready");
    await new Promise((r) => setTimeout(r, 150));
  }
}

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  backend = spawn(process.execPath, [WORKBENCH], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", WORKBENCH_DATA_DIR: dataDir },
  });
  let backendErr = "";
  backend.stderr.on("data", (d) => { backendErr += d; });
  backend.on("exit", (code) => { if (code) backendErr += `\nbackend exited code=${code}`; });
  await waitReady(base);

  client = new McpStdioClient(join(here, "server.mjs"), {
    env: { FINANCE_API_BASE: base, FINANCE_API_TIMEOUT_MS: "10000" }, timeoutMs: 20000,
  }).start();

  const init = await client.initialize("smoke");
  console.log("server:", JSON.stringify(init.result?.serverInfo));
  console.log(`\nMCP 冒烟 @ ${base}（临时目录 ${dataDir}）\n`);

  const list = await client.rpc("tools/list");
  const names = list.result.tools.map((t) => t.name);
  console.log("tools (%d): %s", names.length, names.join(", "));
  for (const required of ["finance_query", "asset_list", "asset_create", "depreciation_run", "carry_forward_profit",
    "account_set_create", "account_list", "account_create", "opening_balance_get", "opening_balance_set",
    "period_list", "period_set_status", "voucher_post", "voucher_unpost", "voucher_delete", "ledger_query",
    "legacy_book_import"]) {
    check(`tools/list 含 ${required}`, names.includes(required));
  }
  check("tools/list 每个工具都有 inputSchema", list.result.tools.every((t) => t.inputSchema && t.inputSchema.type === "object"));
  check("tools/list 不登记 raw / local 读取工具", !["localRead", "localCompute", "finance_output_read"].some((n) => names.includes(n)));

  const catalog = await client.call("finance_query_catalog");
  const cat = catalog.data;
  check("finance_query_catalog 返回模型静态信封", catalog.isError === false && cat?.ok === true && cat?.scope === "global");
  check("静态目录列出 12 个可用 nodeId", cat?.catalog?.available?.length === 12);
  check("未实现 node 明确列出（11 项）", cat?.catalog?.unimplemented?.length === 11);
  check("静态目录不回业务原文（无 capabilities / items）",
    !Object.prototype.hasOwnProperty.call(cat || {}, "capabilities")
    && !Object.prototype.hasOwnProperty.call(cat || {}, "items"));

  const skills = await client.call("skills_list");
  console.log("skill files:", skills.data?.files?.length);
  const read = await client.call("skills_read", { resource: "bookkeeping/SKILL.md" });
  check("skills_read bookkeeping/SKILL.md", !read.isError && (read.data?.markdown || "").length > 0, read.text?.slice(0, 80));
  const missing = await client.call("skills_read", { resource: "../secret.md" });
  check("skills_read 越界路径返回 isError", missing.isError === true);
  check("skills_read 越界不回显路径", missing.isError === true && !missing.text.includes("../secret.md"));

  for (const t of ["invoice_issue", "declaration_query", "exec", "finance_task_status"]) {
    const r = await client.call(t, {});
    check(`${t} 返回 isError 且结构化`, r.isError === true && r.data?.error === "not_implemented", r.text?.slice(0, 120));
  }
  const unknown = await client.call("no_such_tool", {});
  check("未知工具返回 isError", unknown.isError === true && unknown.data?.error === "unknown_tool");
  const badArgs = await client.call("asset_create", {});
  check("必填参数缺失返回 invalid_arguments", badArgs.isError === true && badArgs.data?.error === "invalid_arguments", badArgs.text?.slice(0, 120));
  const noSet = await client.call("finance_query", { nodeId: "report.income_statement", period: "2026-01" });
  check("finance_query 缺 accountSetId 返回 isError", noSet.isError === true && noSet.data?.error === "invalid_arguments", noSet.text?.slice(0, 120));
  const noPeriod = await client.call("finance_query", { nodeId: "report.income_statement", accountSetId: 1 });
  check("finance_query 缺 period 返回 isError", noPeriod.isError === true && noPeriod.data?.error?.code === "period_required", noPeriod.text?.slice(0, 120));
  const unknownNode = await client.call("finance_query", { nodeId: "nope.nope", accountSetId: 1, period: "2026-01" });
  check("finance_query 未知 nodeId 返回固定码", unknownNode.isError === true && unknownNode.data?.error?.code === "model_node_unknown");
  const unimplNode = await client.call("finance_query", { nodeId: "invoice.detail", accountSetId: 1, period: "2026-01" });
  check("finance_query 未实现 nodeId 返回固定码", unimplNode.isError === true && unimplNode.data?.error?.code === "model_node_not_implemented");

  // ---- 真实模型链路（本脚本自建临时后端）----
  const created = await client.call("account_set_create", { name: "冒烟合成公司", start_period: "2026-01" });
  check("account_set_create 返回 applied 信封", created.isError === false && created.data?.applied === true && created.data?.accountSetId > 0);
  const setId = created.data?.accountSetId;
  await client.call("opening_balance_set", {
    accountSetId: setId,
    items: [{ code: "1002", debit: 1000, credit: 0 }, { code: "3001", debit: 0, credit: 1000 }],
  });
  await client.call("voucher_create", {
    accountSetId: setId, period: "2026-01", status: "posted",
    entries: [{ code: "1122", debit: 300 }, { code: "5001", credit: 300 }],
  });
  const q = await client.call("finance_query", { nodeId: "report.income_statement", accountSetId: setId, period: "2026-01" });
  check("finance_query 利润表摘要可读（净利润 300）", q.isError === false && q.data?.projection?.currentNetProfit === 300, q.text?.slice(0, 200));
  check("模型信封不含 raw 原文", q.isError === false && q.data?.rawValuesIncluded === false && q.data?.channel === "model");

  const imp = await client.call("legacy_book_import", { payload: { account_set: {}, accounts: [], opening_balances: [], vouchers: [] } });
  check("legacy_book_import 默认预检（dryRun=true / applied=false）",
    !imp.isError && imp.data?.projection?.dryRun === true && imp.data?.applied === false && imp.data?.appliedReason === "dry_run");
} catch (e) {
  failed++;
  console.error("冒烟失败：", e.stack);
  if (client?.stderr) console.error("mcp stderr:", client.stderr.slice(0, 500));
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

console.log(failed ? `\n${failed} 项失败\n` : "\n冒烟通过\n");
process.exitCode = failed ? 1 : 0;
