#!/usr/bin/env node
/**
 * finance-mcp — 财税工作台 MCP Server 骨架（stdio）
 *
 * 复刻有数云 /work 的「业务域功能」工具层。工具清单来自 05-reconstruction/catalog.json，
 * 与前端 bundle 中提取的 22 个 Dynamic Tools 一一对应。
 *
 * 运行：node server.mjs         （由 Codex config.toml 以 stdio 方式拉起）
 * 后端：编辑 backend.mjs 的 callBackend() 接上你的财税系统。
 */
import { createInterface } from "node:readline";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { callBackend, localOnly } from "./backend.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECON = join(__dirname, "..", "..", ".."); // 05-reconstruction/
const CATALOG = JSON.parse(readFileSync(join(RECON, "catalog.json"), "utf8"));
const SKILLS_DIR = process.env.FINANCE_SKILLS_DIR || join(RECON, "codex", "skills");

const SERVER = { name: "finance-mcp", version: "0.1.0" };
const PROTOCOL = "2025-06-18";

/** 工具参数 schema：已知的用精确 schema，未知的先用开放对象占位。 */
const SCHEMAS = {
  finance_query: {
    type: "object",
    properties: {
      nodeId: { type: "string", description: "查询能力 ID，见 finance_query_catalog，例如 voucher.generated.list" },
      accountSetId: { type: "string", description: "账套 ID（可选，缺省用当前上下文）" },
      period: { type: "string", description: "会计期间，例如 2026-08" },
      params: { type: "object", description: "查询附加参数" }
    },
    required: ["nodeId"]
  },
  finance_query_catalog: { type: "object", properties: {} },
  skills_list: { type: "object", properties: {} },
  skills_read: {
    type: "object",
    properties: { resource: { type: "string", description: "Skill 文件相对路径，例如 bookkeeping/SKILL.md" } },
    required: ["resource"]
  }
};

const OPEN = { type: "object", properties: {}, additionalProperties: true };

/** name -> description；skills 工具额外加进来。 */
const TOOLS = [];
for (const [name, label] of Object.entries(CATALOG.dynamic_tools)) {
  if (name === "read" || name === "list" || name === "finance_query_catalog") continue; // 以 skills_read / skills_list / 显式 schema 暴露
  TOOLS.push({
    name,
    description: `${label}（有数云 财税工作台业务能力）`,
    inputSchema: SCHEMAS[name] || OPEN
  });
}
TOOLS.push({ name: "finance_query_catalog", description: "列出全部可用的财务查询能力 nodeId", inputSchema: SCHEMAS.finance_query_catalog });
TOOLS.push({ name: "skills_list", description: "查找可用财税业务规则(Skill)文件", inputSchema: SCHEMAS.skills_list });
TOOLS.push({ name: "skills_read", description: "读取业务规则(Skill) Markdown 正文", inputSchema: SCHEMAS.skills_read });

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
  const full = join(SKILLS_DIR, normalized);
  if (!full.startsWith(SKILLS_DIR) || !existsSync(full)) {
    throw new Error(`skill_not_found: ${normalized}`);
  }
  return readFileSync(full, "utf8");
}

// ---------------------------------------------------------------- tool calls
async function callTool(name, args = {}) {
  if (name === "finance_query_catalog") {
    return { items: CATALOG.finance_query_catalog, subagents: CATALOG.subagents };
  }
  if (name === "skills_list") {
    return { files: listSkillFiles(), labels: CATALOG.skill_files };
  }
  if (name === "skills_read") {
    return { resource: args.resource, markdown: readSkill(args.resource) };
  }
  if (localOnly(name)) {
    return { ok: true, tool: name, result: localOnly(name)(args) };
  }
  // 其余全部交给后端适配器
  return callBackend(name, args, CATALOG);
}

// ------------------------------------------------------------------ transport
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

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
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    try {
      const result = await callTool(params?.name, params?.arguments || {});
      return ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return ok(id, { content: [{ type: "text", text: String(e?.message || e) }], isError: true });
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
