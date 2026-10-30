import { randomUUID } from 'node:crypto';
import { withRequestMetadata,operationErrorEvidence } from './local-audit-coordinator.mjs';
// server.mjs — 记账 + 报表 工作台 HTTP 服务（REST + Codex Agent 工具 + 静态网页）
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as A from "./accounting.mjs";
import { getImportBatch, importIncremental } from "./import-incremental.mjs";
import { buildOfficeExport } from "./report-office-export.mjs";
import { listTaxReportTemplates, assessTaxReportReadiness, buildTaxReportExport } from "./tax-report-format.mjs";
import { listAccountingProfiles } from "./accounting-profiles.mjs";
import { COA, STANDARDS } from "./coa.mjs";
import { callAgentTool, callAgentModelTool, decodeFiles, ToolError, taxBrowserSessions, AUXILIARY_ACTION_TO_TOOL, prepareBankDraft } from "./agent-tools.mjs";
import { readLocalReference, computeLocalReference } from "./finance-model-entry.mjs";
import { isLoopbackAddress, checkLocalOrigin } from "./tax-local-boundary.mjs";

import { BANK_ACTION_TO_TOOL, bankLocalDrafts, BankDraftError } from "./bank-local-drafts.mjs";
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const json = (res, code, data) => {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 5e6) reject(new Error("body_too_large")); });
  req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error("invalid_json")); } });
  req.on("error", reject);
});

// RFC 6266/5987：安全的 ASCII 回退名，加原始 Unicode 下载文件名。
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
const REPORT_NOT_FOUND_ERRORS = new Set(["account_set_not_found", "account_not_found"]);
const REPORT_REJECTED_ERRORS = new Set(["report_data_invalid", "office_text_too_long"]);
// 格式级失败使用固定产品文案，不将内部字体路径或堆栈返回客户端。
const REPORT_FONT_ERRORS = {
  pdf_font_unavailable: "服务器缺少可嵌入的中文字体，暂时无法生成 PDF；请改用 CSV 或 Excel",
  pdf_font_glyph_missing: "当前中文字体缺少报表所需字符，无法生成 PDF；请改用 CSV 或 Excel",
};
function reportError(e) {
  const code = e?.code;
  if (REPORT_FONT_ERRORS[code]) return { status: 500, body: { error: code, message: REPORT_FONT_ERRORS[code], details: null } };
  if (REPORT_NOT_FOUND_ERRORS.has(code)) return { status: 404, body: { error: code, message: e.message, details: e.details ?? null } };
  if (code === "office_text_too_long") {
    // 只定位出错字段，绝不回显超长文本本身。
    const { field = null, length = null, limit = null } = e.details ?? {};
    return { status: 422, body: { error: code, message: e.message, details: { field, length, limit } } };
  }
  if (REPORT_REJECTED_ERRORS.has(code)) return { status: 422, body: { error: code, message: e.message, details: e.details ?? null } };
  if (REPORT_INPUT_ERRORS.has(code)) return { status: 400, body: { error: code, message: e.message, details: e.details ?? null } };
  return { status: 500, body: { error: "report_export_failed", message: "报表导出失败，请稍后重试", details: null } };
}

// 前期可改性守卫 / 封账前置 / 资产卡片维护守卫的结构化错误码：HTTP 入口给 409 + 明细，不降级成 500。
const PERIOD_GUARD_CODES = new Set([
  "later_period_closed", "later_year_end_carryforward_depends_on_period",
  "later_profit_carryforward_depends_on_period", "later_depreciation_depends_on_period",
  "period_end_check_failed", "carryforward_stale",
  "asset_card_affects_closed_period", "asset_card_locked_by_posted_runs",
  "asset_ledger_pending", "depreciation_global_over_depreciable", "depreciation_exceeds_depreciable",
  "depreciation_run_stale",
]);

const AUX_IMPORT_CODES = new Set("aux_import_busy aux_import_failed account_set_not_found accounting_profile_unknown aux_allocation_exceeds_entry aux_allocation_invalid aux_allocations_invalid aux_amount_invalid aux_code_invalid aux_commit_unknown aux_connection_quarantined aux_dimension_invalid aux_dimension_required aux_entry_not_found aux_id_invalid aux_import_actual_entry_required aux_import_allocation_exists aux_import_entity_conflict aux_import_entry_identity_required aux_import_explicit_identity_required aux_import_identity_duplicate aux_import_invalid aux_import_mapping_conflict aux_import_receipt_invalid aux_import_ref_invalid aux_import_replay_state_conflict aux_import_request_conflict aux_import_source_conflict aux_import_transaction_required aux_import_version_invalid aux_kind_invalid aux_name_invalid aux_not_installed aux_opening_code_required aux_opening_not_found aux_period_closed aux_reason_required aux_replay_state_conflict aux_request_conflict aux_request_id_required aux_side_invalid aux_structure_invalid aux_target_invalid aux_tuple_duplicate later_period_closed later_year_end_carryforward_depends_on_period".split(" "));

// ------------------------------------------------------------------ 路由表
async function api(req, res, url, m) {
  const p = url.pathname;
  let match;

  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/(bank-drafts(?:\/(approve-import|revoke))?|bank\/([^/]+))$/))) {
    if(m!=="POST") return json(res,405,{error:"method_not_allowed"});
    if(!/^application\/json(?:;|$)/i.test(req.headers["content-type"]||"")) return json(res,415,{error:"bank_draft_input_invalid"});
    try {
      const b=await readBody(req),id=Number(match[1]);let value;
      if(match[2]==="bank-drafts") value=await prepareBankDraft(id,b);
      else if(match[3]==="approve-import") value=bankLocalDrafts.approveImport(id,b);
      else if(match[3]==="revoke") value=bankLocalDrafts.revoke(id,b);
      else {
        const tool=BANK_ACTION_TO_TOOL[match[4]];
        if(!tool)return json(res,404,{error:"bank_draft_tool_invalid"});
        if(!b||Array.isArray(b)||Object.keys(b).length!==1||typeof b.draftRef!=="string") throw new ToolError("bank_draft_input_invalid");
        res.setHeader('X-Workbench-Operation-Id',bankLocalDrafts.operationIdFor(id,b.draftRef,tool));
        value=await callAgentTool(tool,{accountSetId:id,draftRef:b.draftRef});
      }
      return json(res,200,value);
    } catch(e) {const audit=operationErrorEvidence(e);if(String(e?.code??'').startsWith('audit_'))return json(res,409,{error:e.code,...(audit??{applied:false,needsLocalReview:false})});const c=e?.code;const code=typeof c==="string"&&/^(bank_draft_|bank_local_)[a-z_]+$/.test(c)?c:"bank_local_operation_failed";return json(res,400,{error:code,message:code,details:null,...(audit??{})});}
  }

  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/auxiliary\/([^/]+)$/))) {
    if (m !== "POST") return json(res, 405, { error: "method_not_allowed" });
    const tool = AUXILIARY_ACTION_TO_TOOL[match[2]];
    if (!tool) return json(res, 404, { error: "aux_action_unknown" });
    try {
      const b = await readBody(req), id = Number(match[1]);
      if (!b || Array.isArray(b) || typeof b !== "object") throw new ToolError("aux_input_invalid");
      for (const key of ["accountSetId", "account_set_id"]) if (Object.hasOwn(b, key)) {
        const v = b[key];
        if (!(typeof v === "number" || typeof v === "string" && v.trim() !== "") || !Number.isSafeInteger(Number(v)) || Number(v) <= 0) throw new ToolError("account_set_id_invalid");
        if (Number(v) !== id) throw new ToolError("account_set_id_conflict");
      }
      return json(res, 200, await callAgentTool(tool, { ...b, accountSetId: id }));
    } catch (e) {
      const audit=operationErrorEvidence(e);if(String(e?.code??'').startsWith('audit_'))return json(res,409,{error:e.code,...(audit??{applied:false,needsLocalReview:false})});
      const c = e?.code ?? e?.message;
      const code = typeof c === "string" && /^(aux_|account_set_|account_not_found$|later_)[a-z_]*$/.test(c) ? c : "aux_operation_failed";
      return json(res, /not_found$/.test(code) ? 404 : code === "aux_commit_unknown" ? 500 : 400,
        { error: code, message: code, details: null,...(audit??{}) });
    }
  }

  if (m === "GET" && p === "/api/meta") return json(res, 200, { standards: STANDARDS, coa: COA, coaDefaultStandard: "小企业会计准则", profiles: listAccountingProfiles() });

  if (m === "GET" && p === "/api/account-sets") return json(res, 200, A.listAccountSets());
  if (m === "POST" && p === "/api/account-sets") return json(res, 201, A.createAccountSet(await readBody(req)));
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/enterprise$/))) {
    if (m === "GET") return json(res, 200, { accountSetId: +match[1], enterprise: A.getAccountSetEnterpriseIdentity(+match[1]) });
    if (m === "POST") {
      const b = await readBody(req);
      return json(res, 200, A.bindAccountSetEnterprise(+match[1], b.enterprise, { confirmNewBinding: b.confirmNewBinding === true }));
    }
  }
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
      // 账套元数据为权威依据，查询参数不能声明其他准则或已验证模板。
      options.accountingStandard = accountSet.accounting_standard;
      if (operation === "readiness") return json(res, 200, assessTaxReportReadiness(id, options));
      buildTaxReportExport(id, options);
      // 尚无已验证上传适配器；不能把未来意外返回值变成可下载文件。
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
      const preview = match[3] === "export-data";
      // export-data 保持 CSV 形状的 JSON DTO，保留原来的严格格式合同：
      // 只接受 csv 或不传格式，不能静默把办公格式改写为 CSV。
      const requestedFormat = url.searchParams.get("format") ?? "csv";
      if (preview && requestedFormat !== "csv") {
        const error = new Error("report_format_unsupported");
        error.code = "report_format_unsupported";
        error.details = { supported: ["csv"] };
        throw error;
      }
      // 只有 /export 才会把请求格式转换为真实附件。
      const result = await buildOfficeExport(+match[1], {
        kind: match[2], period: url.searchParams.get("period"),
        format: preview ? "csv" : requestedFormat, code: url.searchParams.get("code"),
      });
      if (preview) return json(res, 200, result.report);
      // 生成完成后才发送响应头；失败仍须返回 JSON，不返回部分文件。
      const body = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body, "utf8");
      res.writeHead(200, {
        "content-type": result.contentType, "content-length": body.length,
        "content-disposition": attachmentName(result.filename), "x-content-type-options": "nosniff",
      });
      return res.end(body);
    } catch (e) {
      const failure = reportError(e);
      return json(res, failure.status, failure.body);
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
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/assets\/(\d+)$/))) {
    const id = +match[1], assetId = +match[2];
    if (m === "DELETE") return json(res, 200, A.deleteAssetCard(id, assetId));
    // 资产卡片维护 / 补项（取得期间、期初累计、未入账登记），用于解除卡片与总账差异造成的封账阻塞。
    if (m === "PATCH") return json(res, 200, A.updateAssetCard(id, assetId, await readBody(req)));
  }
  // 期末检查（只读）：与封账前置同一套规则，逐步给适用 / 不适用理由与明确缺项。
  if ((match = p.match(/^\/api\/account-sets\/(\d+)\/period-end-check$/)) && m === "GET") {
    const period = url.searchParams.get("period");
    if (!period) return json(res, 400, { error: "period_required", message: "必须提供 period（YYYY-MM）" });
    try {
      return json(res, 200, A.periodEndCheck(+match[1], period));
    } catch (e) {
      const code = e?.message || String(e);
      const status = ["account_set_not_found", "period_invalid", "period_before_start"].includes(code) ? 400 : 500;
      return json(res, status, {
        error: status === 500 ? "period_end_check_failed" : code,
        message: status === 500 ? "期末检查失败" : code,
        details: status === 500 ? null : e.details ?? null,
      });
    }
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
    return json(res, 200, { payload, validation: A.validateImportPayload(payload, { enterprise: b.enterprise, profileId: b.profileId }) });
  }
  if (p === "/api/import/account-set" && m === "POST") {
    const b = await readBody(req);
    // 与 MCP 一致：默认预检，只有显式 dryRun=false 才正式落库。
    return json(res, 201, A.importAccountSet(b.payload || (b.texts ? A.parseImportTexts(b.texts, b.meta || {})
      : b.files ? A.parseImportTexts(decodeFiles(b.files, b.encoding), b.meta || {}) : b),
      { dryRun: b.dryRun !== false, enterprise: b.enterprise, profileId: b.profileId }));
  }
  if (p === "/api/import/templates" && m === "GET") {
    return json(res, 200, { ...TEMPLATES, accounting_standard: "小企业会计准则", profileId: "small-2011-basic-v1", templateScope: "small_enterprise_only" });
  }
  // 增量导入（LOCAL-01）：稳定来源 / 企业身份 + 批次幂等 + 来源凭证去重 / 冲突。
  // 与旧导入一致：默认 dryRun=true，只有显式 dryRun=false 才落库。
  if (p === "/api/import/incremental" && m === "POST") {
    const b = await readBody(req);
    const payload = b.payload
      || (b.texts ? A.parseImportTexts(b.texts, b.meta || {}) : null)
      || (b.files ? A.parseImportTexts(decodeFiles(b.files, b.encoding), b.meta || {}) : null);
    try {
      const result = importIncremental({
        payload,
        dryRun: b.dryRun !== false,
        batchId: b.batchId ?? b.batch_id,
        source: b.source, enterprise: b.enterprise, profileId: b.profileId, profile_id: b.profile_id,
        mode: b.mode,
        accountSetId: b.accountSetId ?? b.account_set_id,
        confirmNewBinding: b.confirmNewBinding === true,
        auxiliaryAppendix: b.auxiliaryAppendix,
      });
      const status = result.status === "applied" ? 201
        : result.status === "conflict" ? 409
          : result.status === "rejected" ? 400 : 200;
      return json(res, status, result);
    } catch (e) {
      if (b.auxiliaryAppendix !== undefined) {
        const code = AUX_IMPORT_CODES.has(e?.code) ? e.code : "aux_import_failed";
        return json(res, code === "aux_commit_unknown" || code === "aux_import_failed" ? 500 : 400,
          { error: code, message: code, details: null });
      }
      if (e?.code === "account_set_not_found") {
        return json(res, 404, { error: "account_set_not_found", message: "目标账套不存在", details: null });
      }
      // 前期可改性 / 封账前置守卫：给结构化 409 + 可执行的依赖处理顺序，不降级成 500。
      if (e?.code && PERIOD_GUARD_CODES.has(e.code)) {
        return json(res, 409, { error: e.code, message: e.message, details: e.details ?? null });
      }
      // 无附录保留原失败合同。
      return json(res, 500, { error: "import_failed", message: "增量导入失败（事务已回滚）", details: null });
    }
  }
  if (m === "GET" && (match = p.match(/^\/api\/import\/batches\/([^/]+)$/))) {
    try {
      return json(res, 200, getImportBatch(decodeURIComponent(match[1])));
    } catch (e) {
      const code = e?.code || e?.message;
      return json(res, code === "batch_not_found" ? 404 : 400, {
        error: code === "batch_not_found" ? "batch_not_found" : "batchId_required",
        message: code === "batch_not_found" ? "批次不存在" : "必须提供批次 ID",
        details: null,
      });
    }
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
      const body=await readBody(req);if(name.startsWith('bank_')&&body?.draftRef)res.setHeader('X-Workbench-Operation-Id',bankLocalDrafts.operationIdFor(body.accountSetId,body.draftRef,name));
      return json(res, 200, await callAgentTool(name,body));
    } catch (e) {
      if (e instanceof ToolError) {
        return json(res, e.code === "unknown_tool" ? 404 : 400, {
          error: e.code, message: e.message, tool: name, details: e.details ?? null,
        });
      }
      // 领域层异常（如 voucher_invalid / period_closed）：保留原 message 与 details。
      const msg = e?.message || String(e);
      const guard = typeof e?.code === "string" && PERIOD_GUARD_CODES.has(e.code);
      return json(res, guard ? 409 : /not_found$/.test(msg) ? 404 : 400, {
        error: guard ? e.code : msg, message: msg, tool: name, details: e?.details ?? null,...(operationErrorEvidence(e)??{}),
      });
    }
  }

  // -------- 模型输出通道（LOCAL-08）：普通财务工具固定最小信封。
  // 与下方既有 /agent/tools/<name> 本机兼容入口并列；这里没有 local / raw 参数，也不回退到 raw。
  if (p.startsWith("/agent/model-tools/")) {
    if (m !== "POST") {
      res.setHeader("allow", "POST");
      return json(res, 405, { error: "method_not_allowed" });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
      return json(res, 415, { error: "json_content_type_required" });
    }
    const name = p.slice("/agent/model-tools/".length);
    if (!/^[A-Za-z0-9_]+$/.test(name)) return json(res, 404, { error: "model_tool_unknown" });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: "request_body_invalid" }); }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return json(res, 400, { error: "request_body_invalid" });
    }
    try {
      if(name.startsWith('bank_')&&body?.draftRef){try{res.setHeader('X-Workbench-Operation-Id',bankLocalDrafts.operationIdFor(body.accountSetId,body.draftRef,name));}catch(error){if(!(error instanceof BankDraftError))throw error;}}
      return json(res, 200, await callAgentModelTool(name, body));
    } catch {
      // 投影层之外的意外异常：固定码，绝不把 message / details / stack 带回模型通道。
      return json(res, 500, { error: "model_entry_failed" });
    }
  }

  // -------- 本机受信引用接口（LOCAL-08）：只回环 + Origin 校验，能力对象只在本机进程内。
  // 请求必须显式带 ref / accountSetId / operation；不接受请求体里的 channel / local。
  if (p === "/api/finance-output/read" || p === "/api/finance-output/compute") {
    if (m !== "POST") {
      res.setHeader("allow", "POST");
      return json(res, 405, { error: "method_not_allowed" });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
      return json(res, 415, { error: "json_content_type_required" });
    }
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: "request_body_invalid" }); }
    try {
      const result = p.endsWith("/compute") ? computeLocalReference(body) : readLocalReference(body);
      return json(res, 200, result);
    } catch (e) {
      // 只回固定输出策略错误码；不回显 message / details / 引用值。
      const code = typeof e?.code === "string" && /^output_policy_[a-z0-9_]{1,48}$/.test(e.code)
        ? e.code : "finance_output_failed";
      return json(res, code === "finance_output_failed" ? 500 : 400, { error: code });
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
  try { url = new URL(req.url, `http://${req.headers.host}`); }
  catch { return json(res, 400, { error: "bad_request", message: "请求地址不合法" }); }
  if (!isLoopbackAddress(req.socket?.remoteAddress) || !checkLocalOrigin(req).ok) {
    return json(res, 403, { error: "forbidden", message: "请求来源不被允许" });
  }
  const method = req.method.toUpperCase();
  if (method === "OPTIONS") {
    res.writeHead(204, { allow: "GET,POST,PUT,DELETE,OPTIONS" });
    return res.end();
  }
  if (url.pathname.startsWith("/agent/tools/tax_") && method === "POST"
      && !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
    return json(res, 415, { error: "json_content_type_required", message: "工具调用必须使用 application/json" });
  }
  try {
    const operationId=req.headers['x-workbench-operation-id']??randomUUID();
    res.setHeader('X-Workbench-Operation-Id',operationId);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/agent/")) return await withRequestMetadata({operationId,actor:'http',explicit:req.headers['x-workbench-operation-id']!==undefined},()=>api(req,res,url,method));
    return await serveStatic(res, url.pathname);
  } catch (e) {
    // 模型通道 / 本机引用通道只回固定码：外层原始 message / details 不得回传。
    if (url.pathname.startsWith("/agent/model-tools/")) {
      return json(res, 500, { error: "model_entry_failed" });
    }
    if (url.pathname.startsWith("/api/finance-output/")) {
      return json(res, 500, { error: "finance_output_failed" });
    }
    const audit=operationErrorEvidence(e);
    if(String(e?.code??'').startsWith('audit_'))return json(res,409,{error:e.code,...(audit??{applied:false,needsLocalReview:false})});
    const guard = typeof e?.code === "string" && PERIOD_GUARD_CODES.has(e.code);
    return json(res, guard ? 409 : 400, {
      error: e.code || e.message || "operation_failed",
      ...(operationErrorEvidence(e)??{}),
      details: e.details || null,
    });
  }
});

server.listen(PORT, HOST, () => {
  // 实际监听端口：PORT=0 时由系统分配，日志必须报告实际端口，测试才能连到本进程。
  const actualPort = server.address().port;
  console.log(`记账+报表工作台:  http://127.0.0.1:${actualPort}/`);
  console.log(`Agent 工具入口:   http://127.0.0.1:${actualPort}/agent/tools/<name>`);
});

// 正常关闭时，只关闭本后端拥有的浏览器进程。
// 操作系统强制终止无法保证清理，不能声称已经清理。
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  const deadline = setTimeout(() => {
    console.error("tax_browser_shutdown_timeout");
    process.exit(1);
  }, 60000);
  void taxBrowserSessions.closeAll().then(() => {
    clearTimeout(deadline);
    process.exit(0);
  }).catch(() => {
    clearTimeout(deadline);
    console.error("tax_browser_cleanup_failed");
    process.exit(1);
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
