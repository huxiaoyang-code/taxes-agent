// server.mjs — 记账 + 报表 工作台 HTTP 服务（REST + Codex Agent 工具 + 静态网页）
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as A from "./accounting.mjs";
import { COA, STANDARDS } from "./coa.mjs";
import { callAgentTool, decodeFiles, ToolError } from "./agent-tools.mjs";

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
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/reports\/(trial-balance|balance-sheet|income-statement|cash-flow-statement)$/))) {
    const id = +match[1], kind = match[2], period = url.searchParams.get("period");
    if (m !== "GET") return json(res, 405, { error: "method_not_allowed" });
    if (!period) return json(res, 400, { error: "period_required" });
    if (kind === "trial-balance") return json(res, 200, A.trialBalance(id, period));
    if (kind === "balance-sheet") return json(res, 200, A.balanceSheet(id, period));
    if (kind === "income-statement") return json(res, 200, A.incomeStatement(id, period));
    return json(res, 200, A.cashFlowStatement(id, period));
  }
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/carry-forward$/)) && m === "POST") {
    const b = await readBody(req);
    return json(res, 201, A.carryForwardProfit(+match[1], b.period, { yearEnd: !!b.yearEnd }));
  }
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/assets$/))) {
    const id = +match[1];
    if (m === "GET") return json(res, 200, A.listAssetCards(id));
    if (m === "POST") return json(res, 201, A.addAssetCard(id, await readBody(req)));
  }
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/assets\/(\d+)$/)) && m === "DELETE") {
    return json(res, 200, A.deleteAssetCard(+match[1], +match[2]));
  }
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/depreciation$/)) && m === "POST") {
    const b = await readBody(req);
    return json(res, 201, A.generateDepreciation(+match[1], b.period));
  }
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/depreciation-runs$/)) && m === "GET") {
    return json(res, 200, A.listDepreciationRuns(+match[1], { period: url.searchParams.get("period") || undefined }));
  }
  if (p === "/api/import/parse" && m === "POST") {
    const b = await readBody(req);
    const texts = b.texts || decodeFiles(b.files, b.encoding);
    const payload = A.parseImportTexts(texts, b.meta || {});
    return json(res, 200, { payload, validation: A.validateImportPayload(payload) });
  }
  if (p === "/api/import/account-set" && m === "POST") {
    const b = await readBody(req);
    // 与 MCP 一致：默认预检，只有显式 dryRun=false 才正式落库。
    return json(res, 201, A.importAccountSet(b.payload || b, { dryRun: b.dryRun !== false }));
  }
  if (p === "/api/import/templates" && m === "GET") {
    return json(res, 200, TEMPLATES);
  }
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/ledger$/))) {
    const id = +match[1], code = url.searchParams.get("code"), period = url.searchParams.get("period");
    if (!code || !period) return json(res, 400, { error: "code_and_period_required" });
    return json(res, 200, A.generalLedger(id, code, period));
  }

  // -------- Codex / MCP Agent 工具入口（finance-mcp 的 backend.mjs 调用这里）
  // 工具注册表与参数校验见 agent-tools.mjs（不在此复制领域逻辑）。
  if (m === "POST" && (match = p.match(/^\/agent\/tools\/([A-Za-z0-9_]+)$/))) {
    const name = match[1];
    try {
      return json(res, 200, await callAgentTool(name, await readBody(req)));
    } catch (e) {
      if (e instanceof ToolError) {
        return json(res, e.code === "unknown_tool" ? 404 : 400, {
          error: e.code, message: e.message, tool: name, details: e.details ?? null,
        });
      }
      // 领域层异常（如 voucher_invalid / period_closed）：保留原 message 与 details。
      const msg = e?.message || String(e);
      return json(res, /not_found$/.test(msg) ? 404 : 400, {
        error: msg, message: msg, tool: name, details: e?.details ?? null,
      });
    }
  }

  return json(res, 404, { error: "not_found", path: p });
}

const TEMPLATES = {
  meta: "\uFEFF键,值\n账套名称,示例贸易有限公司\n纳税人性质,小规模纳税人\n会计准则,小企业会计准则\n启用期间,2026-01\n",
  accounts: "\uFEFF科目编码,科目名称,类别,方向\n1002,银行存款,资产,借\n5001,主营业务收入,损益,贷\n",
  openings: "\uFEFF科目编码,借方,贷方\n1002,100000,0\n3001,0,100000\n",
  vouchers: "\uFEFF期间,日期,字号,凭证号,摘要,科目编码,借方,贷方\n2026-01,2026-01-10,记,1,销售商品,1122,11300,0\n2026-01,2026-01-10,记,1,销售商品,5001,0,10000\n2026-01,2026-01-10,记,1,销售商品,2221,0,1300\n",
};

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
