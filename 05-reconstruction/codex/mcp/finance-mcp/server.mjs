#!/usr/bin/env node
/**
 * finance-mcp — 财税工作台 MCP Server（stdio）
 *
 * 工具契约见 tools.mjs；后端执行经 backend.mjs 转发到 06-workbench。
 * 原则：工具描述与调用结果必须真实——未实现的工具返回 isError，绝不伪装成功。
 *
 * 运行：node server.mjs   （由 Codex config.toml 以 stdio 方式拉起）
 * 后端：FINANCE_API_BASE，默认 http://127.0.0.1:8787
 */
import { createInterface } from "node:readline";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { callBackend, backendInfo, BackendError } from "./backend.mjs";
import { TOOLS, TOOL_BY_NAME, LOCAL_QUERIES, validateArgs, queryStatus, ToolCallError } from "./tools.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECON = join(__dirname, "..", "..", ".."); // 05-reconstruction/
const CATALOG = JSON.parse(readFileSync(join(RECON, "catalog.json"), "utf8"));
const SKILLS_DIR = process.env.FINANCE_SKILLS_DIR || join(RECON, "codex", "skills");

const SERVER = { name: "finance-mcp", version: "0.2.0" };
const PROTOCOL = "2025-06-18";

// ------------------------------------------------------------------ resources
function listSkillFiles(dir = SKILLS_DIR, base = SKILLS_DIR) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listSkillFiles(p, base));
    else if (ent.name.endsWith(".md")) out.push(relative(base, p).replaceAll("\\", "/"));
  }
  return out;
}

function readSkill(resource) {
  const normalized = String(resource || "").replaceAll("\\", "/").split(/[?#]/)[0];
  const root = resolve(SKILLS_DIR);
  const full = resolve(root, normalized);
  // Windows 下环境变量常用正斜杠，join 会输出反斜杠，直接用 startsWith 会误判；用 resolve + 分隔符比较。
  if (full !== root && !full.startsWith(root + sep)) {
    throw new ToolCallError("skill_not_found", `skill_not_found: ${normalized}`);
  }
  if (!existsSync(full)) throw new ToolCallError("skill_not_found", `skill_not_found: ${normalized}`);
  return readFileSync(full, "utf8");
}

// ------------------------------------------------------------------ 查询目录
/**
 * items 逐字保留原站契约（兼容字段）；
 * capabilities 逐项标注本地真实状态；本地扩展单列，不混入原站证据。
 */
function queryCatalog() {
  const items = CATALOG.finance_query_catalog || {};
  const capabilities = [];
  for (const [nodeId, label] of Object.entries(items)) {
    const st = queryStatus(nodeId) || { status: "unavailable", origin: "upstream", note: "本地未实现" };
    capabilities.push({
      nodeId, label, origin: "upstream", status: st.status,
      requiresPeriod: !!st.requiresPeriod,
      ...(st.requiresVoucherId ? { requiresVoucherId: true } : {}),
      ...(st.requiresCode ? { requiresCode: true } : {}),
      ...(st.note ? { note: st.note } : {}),
    });
  }
  for (const [nodeId, def] of Object.entries(LOCAL_QUERIES)) {
    capabilities.push({
      nodeId, label: def.label, origin: "local", status: "available",
      requiresPeriod: !!def.requiresPeriod,
      ...(def.requiresCode ? { requiresCode: true } : {}),
    });
  }
  return {
    items, // 原站契约原文（兼容字段）
    capabilities,
    unavailable: capabilities.filter((c) => c.status !== "available").map((c) => c.nodeId),
    local_extensions: Object.keys(LOCAL_QUERIES),
    subagents: CATALOG.subagents,
    note: "items 为原站契约原文；本地扩展在 capabilities 中以 origin=local 单列，不冒充原站证据。",
  };
}

// ------------------------------------------------------------------ 工具实现
/** 读取 legacy_book_import 的本机 CSV 路径（与 Codex 同机时免 base64）。 */
function readPathTexts(args) {
  const texts = { ...(args.texts || {}) };
  const encoding = args.encoding || "utf-8";
  for (const key of ["meta", "accounts", "openings", "vouchers"]) {
    const p = args.paths[key];
    if (!p) continue;
    texts[key] = new TextDecoder(encoding).decode(readFileSync(String(p)));
  }
  return texts;
}

/** finance_query 的显式前置校验：不猜账套、不猜期间、未知能力报错。 */
async function financeQuery(args) {
  const nodeId = String(args.nodeId || "").trim();
  if (!nodeId) throw new ToolCallError("nodeId_required", "必须提供 nodeId；先用 finance_query_catalog 查看可用能力");
  const st = queryStatus(nodeId);
  if (!st) {
    throw new ToolCallError("unknown_node_id", `未知查询能力：${nodeId}；先用 finance_query_catalog 查看`, { nodeId });
  }
  if (st.status !== "available") {
    throw new ToolCallError("not_implemented", `查询能力 ${nodeId} 本地未实现：${st.note || "数据源未接入"}`, { nodeId });
  }
  const sid = args.accountSetId ?? args.account_set_id;
  if (sid === undefined || sid === null || sid === "") {
    throw new ToolCallError("accountSetId_required", "finance_query 必须显式提供 accountSetId（不猜选默认账套）", { nodeId });
  }
  if (st.requiresPeriod && !args.period) {
    throw new ToolCallError("period_required", `查询 ${nodeId} 必须提供 period（YYYY-MM）`, { nodeId });
  }
  if (st.requiresVoucherId && !(args.params?.voucherId ?? args.voucherId)) {
    throw new ToolCallError("voucherId_required", `查询 ${nodeId} 必须提供 params.voucherId`, { nodeId });
  }
  if (st.requiresCode && !(args.params?.code ?? args.code)) {
    throw new ToolCallError("code_required", `查询 ${nodeId} 必须提供 params.code`, { nodeId });
  }
  return callBackend("finance_query", args, CATALOG);
}

async function callTool(name, args = {}) {
  const spec = TOOL_BY_NAME.get(name);
  if (!spec) throw new ToolCallError("unknown_tool", `未知工具：${name}`);

  const problems = validateArgs(spec.inputSchema, args);
  if (problems.length) {
    throw new ToolCallError("invalid_arguments", `参数校验失败：${problems.join("；")}`, { tool: name, problems });
  }
  if (spec.status === "unavailable") {
    throw new ToolCallError("not_implemented", `${name} 本地未实现：${spec.description}`, { tool: name });
  }

  // ---- 纯本地工具 ----
  if (name === "finance_query_catalog") return queryCatalog();
  if (name === "skills_list") return { files: listSkillFiles(), labels: CATALOG.skill_files };
  if (name === "skills_read") return { resource: args.resource, markdown: readSkill(args.resource) };

  // ---- finance_query ----
  if (name === "finance_query") return financeQuery(args);

  // ---- legacy_book_import：本机路径读盘 + 默认预检 ----
  const payload = { ...args };
  if (name === "legacy_book_import") {
    if (args.paths && typeof args.paths === "object") {
      try {
        payload.texts = readPathTexts(args);
      } catch (e) {
        throw new ToolCallError("path_read_failed", `读取本机 CSV 失败：${e.message}`, { paths: args.paths });
      }
    }
    // 默认预检；只有显式 dryRun=false 才落库。
    payload.dryRun = args.dryRun === false ? false : true;
  }

  const result = await callBackend(name, payload, CATALOG);
  // 后端明确回报未实现时，同样升级为工具错误，避免“成功返回 not_implemented”。
  if (result && typeof result === "object" && result.not_implemented === true) {
    throw new ToolCallError("not_implemented", result.hint || `${name} 后端未实现`, { tool: name });
  }
  return result;
}

// ------------------------------------------------------------------ transport
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

/** 失败统一返回结构化内容 + isError: true。 */
function errorResult(e) {
  const payload = { error: e?.code || "tool_error", message: String(e?.message || e) };
  if (e?.tool) payload.tool = e.tool;
  if (e?.details !== undefined && e?.details !== null) payload.details = e.details;
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
}

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  const { id, method, params } = msg;

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {}, resources: {} },
      serverInfo: SERVER
    });
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  if (method === "tools/call") {
    try {
      const result = await callTool(params?.name, params?.arguments || {});
      return ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      if (e instanceof BackendError || e instanceof ToolCallError || e?.code) return ok(id, errorResult(e));
      return ok(id, errorResult(new ToolCallError("tool_error", String(e?.message || e))));
    }
  }
  if (method === "resources/list") {
    return ok(id, {
      resources: listSkillFiles().map((uri) => ({
        uri: `skill://${uri}`, name: uri, mimeType: "text/markdown"
      }))
    });
  }
  if (method === "resources/read") {
    const uri = String(params?.uri || "").replace(/^skill:\/\//, "");
    try { return ok(id, { contents: [{ uri: params.uri, mimeType: "text/markdown", text: readSkill(uri) }] }); }
    catch (e) { return err(id, -32002, String(e?.message || e)); }
  }
  if (method === "prompts/list") return ok(id, { prompts: [] });
  if (id !== undefined) return err(id, -32601, `method not found: ${method}`);
});

if (process.env.FINANCE_MCP_DEBUG) {
  console.error("finance-mcp backend:", JSON.stringify(backendInfo()));
}
