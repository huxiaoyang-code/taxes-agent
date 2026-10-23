#!/usr/bin/env node
/**
 * import-demo.mjs — 本地复现「导入旧账」的端到端演示（不经过 Codex，直接打 MCP）。
 *
 * 作用：验证 工作台 + finance-mcp + legacy_book_import 三者打通；
 *       也是 Codex 内部实际会走的调用路径（tools/call legacy_book_import）。
 *
 * 运行：
 *   1) 先启动工作台：cd 06-workbench && npm start
 *   2) node import-demo.mjs                         # 用内置示例账套
 *      node import-demo.mjs --paths D:/旧账/meta.csv,...  # 自定义
 *
 * 环境变量：FINANCE_API_BASE（默认 http://127.0.0.1:8787）
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, "..", "..", "..", "examples", "legacy-book");

const argPaths = process.argv.find((a) => a.startsWith("--paths="));
const paths = argPaths
  ? Object.fromEntries(["meta", "accounts", "openings", "vouchers"].map((k, i) => [k, argPaths.slice(8).split(",")[i]]))
  : {
      meta: join(examples, "meta.csv"),
      accounts: join(examples, "accounts.csv"),
      openings: join(examples, "openings.csv"),
      vouchers: join(examples, "vouchers.csv")
    };

console.log("账套导入演示");
console.log("  FINANCE_API_BASE =", process.env.FINANCE_API_BASE || "http://127.0.0.1:8787");
console.log("  paths =", paths);

const child = spawn(process.execPath, [join(here, "server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let buf = "";
child.stdout.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
let nextId = 1;
const rpc = (method, params) => new Promise((res) => {
  const id = nextId++; pending.set(id, res);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text;
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* 保留原始文本 */ }
  return { isError: r.result?.isError === true, data };
};

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "import-demo", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const read = await call("skills_read", { resource: "legacy-book-import/SKILL.md" });
console.log("\n[1] 读取业务规则 legacy-book-import/SKILL.md:", read.isError ? "ERROR" : "OK");

const pre = await call("legacy_book_import", { paths, enterprise: { enterpriseKey: "SYNTHETIC-MCP-IMPORT-DEMO-001" }, dryRun: true });
console.log("\n[2] 预检 dryRun=true ->", JSON.stringify(pre.data?.validation ?? pre.data, null, 2).slice(0, 900));

const done = await call("legacy_book_import", { paths, enterprise: { enterpriseKey: "SYNTHETIC-MCP-IMPORT-DEMO-001" }, dryRun: false });
console.log("\n[3] 正式导入 dryRun=false -> created =", JSON.stringify(done.data?.created ?? done.data, null, 2).slice(0, 500));

const setId = done.data?.created?.id;
if (setId) {
  const q = await call("finance_query", { nodeId: "report.balance_sheet", accountSetId: String(setId), period: "2026-01" });
  const b = q.data?.data;
  console.log(`\n[4] 导入后勾稽 资产负债表 2026-01 balanced = ${b?.balanced}`);
  const v = await call("finance_query", { nodeId: "voucher.generated.list", accountSetId: String(setId), period: "2026-01" });
  console.log(`    已生成凭证 ${Array.isArray(v.data?.data) ? v.data.data.length : "?"} 张`);
}

child.kill();
