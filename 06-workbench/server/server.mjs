// server.mjs — 记账 + 报表 工作台 HTTP 服务（REST + Codex Agent 工具 + 静态网页）
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as A from "./accounting.mjs";
import { COA, STANDARDS } from "./coa.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 8787);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const json = (res, code, data) => {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body), "access-control-allow-origin": "*" });
  res.end(body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 5e6) reject(new Error("body_too_large")); });
  req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error("invalid_json")); } });
  req.on("error", reject);
});

// ------------------------------------------------------------------ 路由表
async function api(req, res, url, m) {
  const p = url.pathname;
  let match;

  if (m === "GET" && p === "/api/meta") return json(res, 200, { standards: STANDARDS, coa: COA });

  if (m === "GET" && p === "/api/account-sets") return json(res, 200, A.listAccountSets());
  if (m === "POST" && p === "/api/account-sets") return json(res, 201, A.createAccountSet(await readBody(req)));
  if ((match = p.match(/^\/api\/account-sets\/(\d+)$/))) {
    const id = +match[1];
    if (m === "GET") return json(res, 200, A.getAccountSet(id));
    if (m === "DELETE") return json(res, 200, A.deleteAccountSet(id));
  }
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/accounts$/))) {
    const id = +match[1];
    if (m === "GET") return json(res, 200, A.listAccounts(id));
    if (m === "POST") return json(res, 201, A.addAccount(id, await readBody(req)));
  }
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/opening-balances$/))) {
    const id = +match[1];
    if (m === "GET") return json(res, 200, A.getOpeningBalances(id));
    if (m === "PUT") { const b = await readBody(req); return json(res, 200, A.setOpeningBalances(id, b.items || b)); }
  }
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/periods$/))) {
    const id = +match[1];
    if (m === "GET") return json(res, 200, A.listPeriods(id));
    if (m === "POST") { const b = await readBody(req); return json(res, 200, A.setPeriodStatus(id, b.period, b.status)); }
  }
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/vouchers$/))) {
    const id = +match[1];
    if (m === "GET") return json(res, 200, A.listVouchers(id, { period: url.searchParams.get("period") || undefined,
      status: url.searchParams.get("status") || undefined }));
    if (m === "POST") return json(res, 201, A.createVoucher(id, await readBody(req)));
  }
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/vouchers\/(\d+)(?:\/(post|unpost))?$/))) {
    const id = +match[1], vid = +match[2], op = match[3];
    if (m === "GET" && !op) return json(res, 200, A.getVoucher(id, vid));
    if (m === "DELETE" && !op) return json(res, 200, A.deleteVoucher(id, vid));
    if (m === "POST" && op === "post") return json(res, 200, A.postVoucher(id, vid));
    if (m === "POST" && op === "unpost") return json(res, 200, A.unpostVoucher(id, vid));
  }
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/reports\/(trial-balance|balance-sheet|income-statement)$/))) {
    const id = +match[1], kind = match[2], period = url.searchParams.get("period");
    if (m !== "GET") return json(res, 405, { error: "method_not_allowed" });
    if (!period) return json(res, 400, { error: "period_required" });
    if (kind === "trial-balance") return json(res, 200, A.trialBalance(id, period));
    if (kind === "balance-sheet") return json(res, 200, A.balanceSheet(id, period));
    return json(res, 200, A.incomeStatement(id, period));
  }
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/ledger$/))) {
    const id = +match[1], code = url.searchParams.get("code"), period = url.searchParams.get("period");
    if (!code || !period) return json(res, 400, { error: "code_and_period_required" });
    return json(res, 200, A.generalLedger(id, code, period));
  }

  // -------- Codex / MCP Agent 工具入口（finance-mcp 的 backend.mjs 调用这里）
  if (m === "POST" && (match = p.match(/^\/agent\/tools\/([A-Za-z0-9_]+)$/))) {
    return json(res, 200, await agentTool(match[1], await readBody(req)));
  }

  return json(res, 404, { error: "not_found", path: p });
}

// ------------------------------------------------------------- Agent 工具层
async function agentTool(name, args = {}) {
  const setId = +(args.accountSetId || args.account_set_id || 0);
  const period = args.period;
  const q = (nodeId) => {
    if (!setId) throw new Error("accountSetId_required");
    switch (nodeId) {
      case "enterprise_account.account_set": return A.getAccountSet(setId);
      case "enterprise_account.subject_system.all": return A.listAccounts(setId);
      case "voucher.generated.list":
      case "voucher.generated.summary": return A.listVouchers(setId, { period, status: "posted" });
      case "voucher.draft.summary": return A.listVouchers(setId, { period, status: "draft" });
      case "voucher.detail": return A.getVoucher(setId, +(args.params?.voucherId || args.voucherId));
      case "report.balance_sheet": return A.balanceSheet(setId, period);
      case "report.income_statement": return A.incomeStatement(setId, period);
      case "report.cash_flow_statement": return { not_implemented: true, nodeId };
      case "period_end.summary": return { periods: A.listPeriods(setId), trial_balance: A.trialBalance(setId, period) };
      default:
        if (String(nodeId).match(/^(invoice|fund|enterprise_account\.(bank|business|personnel|tax))/))
          return { not_implemented: true, nodeId, hint: "发票/银行/税务数据源未接入" };
        return { not_implemented: true, nodeId };
    }
  };

  switch (name) {
    case "finance_query_catalog":
      return { capabilities: Object.keys(CATALOG_QUERIES), subagents: SUBAGENTS };
    case "finance_query":
      if (args.nodeId === "finance_query_catalog") return { capabilities: Object.keys(CATALOG_QUERIES) };
      return { nodeId: args.nodeId, label: CATALOG_QUERIES[args.nodeId] || "查询财务数据", data: q(args.nodeId) };
    case "account_context":
    case "finance_context_resolve":
      return { account_sets: A.listAccountSets(), periods: setId ? A.listPeriods(setId) : [] };
    case "voucher_check":
      return { accountSetId: setId, ...A.checkVoucher(setId, args.entries || []) };
    case "voucher_create":
      return A.createVoucher(setId, args);
    case "finance_task_status":
      return { status: "completed", note: "本地记账无异步任务" };
    case "update_plan":
      return { plan: args.plan || [], saved: true };
    default:
      return { not_implemented: true, tool: name,
        hint: "MVP 仅实现记账+报表；发票/申报/企业微信等后期接入" };
  }
}

const CATALOG_QUERIES = {
  "enterprise_account.account_set": "查询账套信息",
  "enterprise_account.subject_system.all": "查询科目体系",
  "voucher.generated.list": "查询已生成凭证",
  "voucher.generated.summary": "查询已生成凭证",
  "voucher.draft.summary": "查询草稿凭证",
  "voucher.detail": "读取凭证详情",
  "report.balance_sheet": "查询资产负债表",
  "report.income_statement": "查询利润表",
  "report.cash_flow_statement": "查询现金流量表",
  "period_end.summary": "盘点期末状态",
};
const SUBAGENTS = [
  { runtimeName: "bookkeeping", displayName: "智能核算" },
  { runtimeName: "legacy-book-import", displayName: "导入旧账" },
];

// ------------------------------------------------------------------ 静态文件
async function serveStatic(res, pathname) {
  const rel = decodeURIComponent(pathname).replace(/\\/g, "/").replace(/^\/+/, "");
  let file = join(PUBLIC, rel || "index.html");
  const isFile = await stat(file).then((s) => s.isFile()).catch(() => false);
  if (!(file === PUBLIC || file.startsWith(PUBLIC + sep)) || !isFile) file = join(PUBLIC, "index.html");
  try {
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "content-length": buf.length });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method.toUpperCase();
  if (method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization" });
    return res.end();
  }
  try {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/agent/")) return await api(req, res, url, method);
    return await serveStatic(res, url.pathname);
  } catch (e) {
    return json(res, 400, { error: e.message || String(e), details: e.details || null });
  }
});

server.listen(PORT, () => {
  console.log(`记账+报表工作台:  http://127.0.0.1:${PORT}/`);
  console.log(`Agent 工具入口:   http://127.0.0.1:${PORT}/agent/tools/<name>`);
});
