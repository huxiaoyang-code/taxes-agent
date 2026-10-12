#!/usr/bin/env node
/** smoke-test.mjs — 验证 MCP 握手、工具清单、本地能力；后端在线时顺带验证 finance_query。
 *  运行：node smoke-test.mjs
 *  后端：FINANCE_API_BASE（默认 http://127.0.0.1:8787 = 06-workbench）
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, "server.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env }
});

const pending = new Map();
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

let nextId = 1;
const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return { isError: r.result?.isError === true, text: r.result?.content?.[0]?.text };
};

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
console.log("server:", JSON.stringify(init.result?.serverInfo));
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const list = await rpc("tools/list", {});
console.log("tools (%d): %s", list.result.tools.length, list.result.tools.map((t) => t.name).join(", "));

const catalog = await call("finance_query_catalog");
console.log("query catalog:", Object.keys(JSON.parse(catalog.text).items).length, "capabilities");

const skills = await call("skills_list");
console.log("skill files:", JSON.parse(skills.text).files.length);

const read = await call("skills_read", { resource: "bookkeeping/SKILL.md" });
console.log("skills_read bookkeeping/SKILL.md:", read.isError ? "ERROR" : "OK");

const q = await call("finance_query", { nodeId: "report.income_statement", accountSetId: 1, period: "2026-02" });
if (q.isError) {
  console.log("finance_query: 后端未启动或未配置（%s）", JSON.parse(q.text).message?.slice(0, 60) ?? q.text.slice(0, 60));
} else {
  const d = JSON.parse(q.text);
  console.log("finance_query 利润表 2026-02 净利润 =", d.data?.ytd?.["净利润"] ?? d.data?.current?.["净利润"]);
}

child.kill();
