#!/usr/bin/env node
/**
 * smoke-test.mjs — MCP 冒烟：握手、工具清单、本地工具、错误路径。
 *
 * 后端在线时顺带验证真实业务调用；后端不可达时清晰报告并跳过后端校验
 * （不再出现“解析错误信息本身失败”的二次 JSON 错误）。
 *
 * 运行：node smoke-test.mjs
 * 后端：FINANCE_API_BASE（默认 http://127.0.0.1:8787）
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpStdioClient } from "./mcp-stdio-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const client = new McpStdioClient(join(here, "server.mjs"), { timeoutMs: 20000 }).start();

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

try {
  const init = await client.initialize("smoke");
  console.log("server:", JSON.stringify(init.result?.serverInfo));

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

  const catalog = await client.call("finance_query_catalog");
  const cat = catalog.data;
  console.log("query catalog: items=%d capabilities=%d unavailable=%d local=%d",
    Object.keys(cat?.items || {}).length, cat?.capabilities?.length, cat?.unavailable?.length, cat?.local_extensions?.length);
  check("items 保留原站 21 项", Object.keys(cat?.items || {}).length === 21);
  check("逐项标注可用状态", Array.isArray(cat?.capabilities) && cat.capabilities.every((c) => !!c.status));
  check("未实现查询明确不可用（11 项）", cat?.unavailable?.length === 11);

  const skills = await client.call("skills_list");
  console.log("skill files:", skills.data?.files?.length);
  const read = await client.call("skills_read", { resource: "bookkeeping/SKILL.md" });
  check("skills_read bookkeeping/SKILL.md", !read.isError && (read.data?.markdown || "").length > 0, read.text?.slice(0, 80));
  const missing = await client.call("skills_read", { resource: "../secret.md" });
  check("skills_read 越界路径返回 isError", missing.isError === true);

  // ---- 未实现工具必须 isError 且结构化 ----
  for (const t of ["invoice_issue", "declaration_query", "exec", "finance_task_status"]) {
    const r = await client.call(t, {});
    check(`${t} 返回 isError 且结构化`, r.isError === true && r.data?.error === "not_implemented", r.text?.slice(0, 120));
  }
  // ---- 未知工具 / 参数缺失 ----
  const unknown = await client.call("no_such_tool", {});
  check("未知工具返回 isError", unknown.isError === true && unknown.data?.error === "unknown_tool");
  const badArgs = await client.call("asset_create", {});
  check("必填参数缺失返回 invalid_arguments", badArgs.isError === true && badArgs.data?.error === "invalid_arguments", badArgs.text?.slice(0, 120));
  const noSet = await client.call("finance_query", { nodeId: "report.income_statement", period: "2026-01" });
  check("finance_query 缺 accountSetId 返回 isError", noSet.isError === true, noSet.text?.slice(0, 120));
  const noPeriod = await client.call("finance_query", { nodeId: "report.income_statement", accountSetId: 1 });
  check("finance_query 缺 period 返回 isError", noPeriod.isError === true, noPeriod.text?.slice(0, 120));
  const unknownNode = await client.call("finance_query", { nodeId: "nope.nope", accountSetId: 1, period: "2026-01" });
  check("finance_query 未知 nodeId 返回 isError", unknownNode.isError === true && unknownNode.data?.error === "unknown_node_id");
  const unimplNode = await client.call("finance_query", { nodeId: "invoice.detail", accountSetId: 1, period: "2026-01" });
  check("finance_query 未实现 nodeId 返回 isError", unimplNode.isError === true && unimplNode.data?.error === "not_implemented");

  // ---- 后端相关：可达则验证真实调用，不可达则清晰报告 ----
  const q = await client.call("finance_query", { nodeId: "report.income_statement", accountSetId: 1, period: "2026-02" });
  if (q.isError && q.data?.error === "backend_unreachable") {
    console.log("  ! 后端不可达，跳过后端业务校验：", q.data.message);
  } else if (q.isError) {
    failed++;
    console.log("  ✗ 后端业务调用失败：", q.text?.slice(0, 200));
  } else {
    console.log("  ✓ finance_query 利润表 2026-02 净利润 =", q.data?.data?.ytd?.["净利润"] ?? q.data?.data?.current?.["净利润"]);
  }

  const imp = await client.call("legacy_book_import", { payload: { account_set: {}, accounts: [], opening_balances: [], vouchers: [] } });
  check("legacy_book_import 默认预检（dryRun=true）", !imp.isError && imp.data?.dryRun === true && imp.data?.created === null);
} catch (e) {
  failed++;
  console.error("冒烟失败：", e.message);
  if (client.stderr) console.error("mcp stderr:", client.stderr.slice(0, 500));
} finally {
  await client.close();
}

console.log(failed ? `\n${failed} 项失败\n` : "\n冒烟通过\n");
process.exitCode = failed ? 1 : 0;
