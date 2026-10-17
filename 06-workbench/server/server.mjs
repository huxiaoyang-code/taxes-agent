// server.mjs — 记账 + 报表 工作台 HTTP 服务（REST + Codex Agent 工具 + 静态网页）
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as A from "./accounting.mjs";
import { buildReportExport } from "./report-export.mjs";
import { listTaxReportTemplates, assessTaxReportReadiness, buildTaxReportExport } from "./tax-report-format.mjs";
import { COA, STANDARDS } from "./coa.mjs";
import { callAgentTool, decodeFiles, ToolError } from "./agent-tools.mjs";
import { TaxBrowserService } from "./tax-browser.mjs";
import { importFromTaxBrowser } from "./tax-import.mjs";
import { createTaxBrowserRoutes, isLoopbackAddress, checkLocalOrigin } from "./tax-browser-http.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1"; // 默认只绑回环，税局浏览器导入等敏感接口仅本机访问

// 税局浏览器导入服务：真实浏览器实现 + 真实导入落库（生产无任何 fake 开关）。
const taxBrowserService = new TaxBrowserService({
  importer: importFromTaxBrowser,
  log: (msg) => console.log(msg),
});
const taxBrowserRoutes = createTaxBrowserRoutes(taxBrowserService);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

// 本地 JSON 响应：绝不发送任何 CORS 放行头（同源 UI 不需要 CORS，跨源一律不可读）。
const json = (res, code, data) => {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body) });
  res.end(body);
};
// 请求地址（请求目标 / Host）无法安全解析时的本地错误：固定 400 JSON，
// 绝不回显原始 url/host/error，也不发送任何 CORS 放行头。
const jsonBadRequest = (res) => {
  const body = JSON.stringify({ error: "bad_request", message: "请求地址不合法" }, null, 2);
  res.writeHead(400, { "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body), "cache-control": "no-store",
    "x-content-type-options": "nosniff" });
  res.end(body);
};
// 本机边界拒绝：远端连接 / 非回环 Host / 恶意 Origin 统一固定 403 JSON，
// 不回显原始 Host/Origin、不发任何 CORS 放行头。
const jsonForbidden = (res) => {
  const body = JSON.stringify({ error: "forbidden", message: "请求来源不被允许" }, null, 2);
  res.writeHead(403, { "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body), "cache-control": "no-store",
    "x-content-type-options": "nosniff" });
  res.end(body);
};
const localBoundaryOk = (req) =>
  isLoopbackAddress(req.socket?.remoteAddress) && checkLocalOrigin(req).ok;
const readBody = (req) => new Promise((resolve, reject) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 5e6) reject(new Error("body_too_large")); });
  req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error("invalid_json")); } });
  req.on("error", reject);
});

// RFC 6266/5987: safe ASCII fallback plus the original Unicode download name.
function attachmentName(filename) {
  const name = String(filename).replace(/[\u0000-\u001f\u007f/\\]/g, "_");
  const ascii = name.replace(/[^\x20-\x7e]|[";]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
const REPORT_INPUT_ERRORS = new Set([
  "report_options_invalid", "period_required", "period_invalid", "period_before_start", "period_not_registered",
  "report_kind_unsupported", "report_format_unsupported", "account_code_required",
]);

// ------------------------------------------------------------------ 路由表
async function api(req, res, url, m) {
  const p = url.pathname;
  let match;

  // -------- 税局浏览器导入（/api/tax-browser/*）：回环 + 同源令牌 + 无通配 CORS
  if (p === "/api/tax-browser" || p.startsWith("/api/tax-browser/")) {
    return await taxBrowserRoutes(req, res, url, m);
  }

  // -------- 本机边界（其它所有 /api/* 与 /agent/*）：在执行任何读写/发放信息前，
  // 校验真实 socket 为回环、Host 为回环、Origin（若存在）精确同源。绝不信任 X-Forwarded-*。
  // 无 Origin 的本机 CLI/MCP 照常放行；恶意 Origin / 远端 / 非本机 Host 统一固定 403。
  if (!localBoundaryOk(req)) return jsonForbidden(res);

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
  if (p === "/api/tax-report-templates" || (match = p.match(/^\/api\/account-sets\/(\d+)\/tax-reports\/(readiness|export)$/))) {
    res.setHeader("cache-control", "no-store");
    if (m !== "GET") {
      res.setHeader("allow", "GET");
      return json(res, 405, { error: "method_not_allowed", message: "Only GET is supported", details: null });
    }
    if (p === "/api/tax-report-templates") return json(res, 200, listTaxReportTemplates());
    try {
      const id = +match[1], operation = match[2], accountSet = A.getAccountSet(id);
      const options = Object.fromEntries(["period", "region", "templateId", "templateVersion", "format"].map((key) => [key, url.searchParams.get(key)]));
      // Account metadata is authoritative; query flags cannot claim a different standard or verified template.
      options.accountingStandard = accountSet.accounting_standard;
      if (operation === "readiness") return json(res, 200, assessTaxReportReadiness(id, options));
      buildTaxReportExport(id, options);
      // No upload adapter is verified. Never turn a future accidental return into a downloadable file.
      return json(res, 422, { error: "tax_template_unverified", message: "税局申报格式尚未核实", details: null });
    } catch (e) {
      const code = e?.code || e?.message;
      const status = code === "account_set_not_found" ? 404 : code === "tax_template_unverified" ? 422 : 500;
      return json(res, status, {
        error: status === 500 ? "tax_report_failed" : code,
        message: status === 500 ? "税局格式检查失败" : e.message,
        details: status === 500 ? null : e.details ?? null,
      });
    }
  }
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/reports\/([^/]+)\/(export|export-data)$/))) {
    res.setHeader("cache-control", "no-store");
    if (m !== "GET") {
      res.setHeader("allow", "GET");
      return json(res, 405, { error: "method_not_allowed", message: "Only GET is supported", details: null });
    }
    try {
      const result = buildReportExport(+match[1], {
        kind: match[2], period: url.searchParams.get("period"),
        format: url.searchParams.get("format") ?? "csv", code: url.searchParams.get("code"),
      });
      if (match[3] === "export-data") return json(res, 200, result.report);
      // Complete generation before sending headers: failures must remain JSON, never partial files.
      const body = Buffer.from(result.body, "utf8");
      res.writeHead(200, {
        "content-type": result.contentType, "content-length": body.length,
        "content-disposition": attachmentName(result.filename), "x-content-type-options": "nosniff",
      });
      return res.end(body);
    } catch (e) {
      const code = e?.code;
      const status = ["account_set_not_found", "account_not_found"].includes(code) ? 404 : code === "report_data_invalid" ? 422 : REPORT_INPUT_ERRORS.has(code) ? 400 : 500;
      return json(res, status, {
        error: status === 500 ? "report_export_failed" : code,
        message: status === 500 ? "报表导出失败，请稍后重试" : e.message,
        details: status === 500 ? null : e.details ?? null,
      });
    }
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
  let url;
  try {
    // 畸形 Host / 请求目标会让 URL 解析抛错；必须在路由前拦截为固定 400，
    // 否则未捕获异常会冒泡出请求处理器并终止整个服务进程。
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    return jsonBadRequest(res);
  }
  const method = req.method.toUpperCase();
  if (method === "OPTIONS") {
    // tax-browser 接口不发任何 CORS 放行头：跨源预检必然失败，同源 UI 不需要预检。
    if (url.pathname === "/api/tax-browser" || url.pathname.startsWith("/api/tax-browser/")) {
      res.writeHead(204, { allow: "GET,POST,OPTIONS" });
      return res.end();
    }
    // 预检同样必须先检查来源：跨站预检统一拒绝（403，无任何 CORS 放行头）；
    // 本机同源 / 无 Origin 的预检才放行（204，同样不发 CORS 头，同源 UI 不需预检）。
    if (!localBoundaryOk(req)) return jsonForbidden(res);
    res.writeHead(204, { allow: "GET,POST,PUT,DELETE,OPTIONS" });
    return res.end();
  }
  try {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/agent/")) return await api(req, res, url, method);
    return await serveStatic(res, url.pathname);
  } catch (e) {
    return json(res, 400, { error: e.message || String(e), details: e.details || null });
  }
});

// 退出时关闭浏览器采集会话、清理临时 profile（不留后台浏览器窗口/临时目录）。
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    try { await taxBrowserService.destroy(); } catch { /* ignore */ }
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  // 实际监听端口：PORT=0 时由系统分配，日志必须报告实际端口，测试才能连到本进程。
  const actualPort = server.address().port;
  console.log(`记账+报表工作台:  http://${HOST === "127.0.0.1" ? "127.0.0.1" : HOST}:${actualPort}/`);
  console.log(`Agent 工具入口:   http://${HOST === "127.0.0.1" ? "127.0.0.1" : HOST}:${actualPort}/agent/tools/<name>`);
});
