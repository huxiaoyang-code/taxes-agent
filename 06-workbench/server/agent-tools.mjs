import { extractOperationMetadata,withRequestMetadata,operationErrorEvidence,bankOperationFailure } from './local-audit-coordinator.mjs';
// agent-tools.mjs — `/agent/tools/<name>` 的工具注册表（MCP 的后端执行层）。
//
// 职责边界：只做「参数校验 + 编排既有领域函数 + 统一错误结构」，
// 不复制 accounting.mjs 的任何业务算法；领域签名由 accounting.mjs 提供。
//
// 返回约定：
//   - 成功：返回该工具自己的 JSON 结构（保留既有兼容字段）。
//   - 未实现：返回 { not_implemented: true, ... }（HTTP 200，由 MCP 层转成 isError）。
//   - 参数/领域错误：抛 ToolError 或领域异常，由 HTTP 层映射成 4xx 结构化错误。
//
// 双通道（LOCAL-08）：本文件的 `callAgentTool` 是**本机兼容 raw 入口**，语义保持不变。
// 普通财务工具送模型时必须走下面的 `callAgentModelTool`（投影信封）；两者互不递归适配。
// raw 入口本身不做脱敏，MCP 普通工具不得再到达 `/agent/tools/*`。
import * as A from "./accounting.mjs";
import * as BANK from "./bank-reconciliation.mjs";
import * as BANK_STORAGE from "./bank-storage.mjs";
import * as BANK_BACKUP from "./local-backup.mjs";
import { dirname } from "node:path";
import { bankLocalDrafts, BANK_TOOLS, BANK_WRITE_TOOLS, BankLocalDrafts, BankDraftError } from "./bank-local-drafts.mjs";
import * as AUX from "./auxiliary-accounting.mjs";
import { db } from "./db.mjs";
import { types } from "node:util";
import { getImportBatch, importIncremental } from "./import-incremental.mjs";
import { TaxGateway, TaxError } from "./tax-gateway.mjs";
import { TaxAcquisition } from "./tax-acquisition.mjs";
import { FujianBrowserSessions } from "./tax-fujian-session.mjs";
import { TaxBrowserError } from "./tax-browser-transport.mjs";
import { TaxLiveCollection } from "./tax-live-collection.mjs";
import { TaxHistoryCollection } from "./tax-history-collection.mjs";
import {
  CATALOG_SOURCE, catalogStats, entryDetail, getCatalogEntry, listModules, moduleStats, searchCatalog, validateParams,
} from "./tax-api-catalog.mjs";
import { aggregateOutcomes, classifyOutcome, OUTCOMES } from "./tax-api-catalog-classify.mjs";
import { prepareCatalogCall } from "./tax-api-catalog-readiness.mjs";

export class ToolError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

// 本机辅助核算入口只接收数据；全部写入及事务由业务领域层负责。
const AUX_FIELDS = Object.freeze({
  auxiliary_entities: ["kind"], auxiliary_entries: ["voucherId", "period"],
  auxiliary_ledger: ["period", "code", "groupBy"], auxiliary_party: ["entryId"],
  auxiliary_entity_create: ["kind", "code", "name", "requestId"],
  auxiliary_entity_update: ["entityId", "name", "active", "reason"],
  auxiliary_allocate: ["entryId", "openingCode", "allocations", "requestId", "reason"],
  auxiliary_requirement_set: ["code", "project", "department", "party", "reason"],
});
export const AUXILIARY_ACTION_TO_TOOL = Object.freeze(Object.assign(Object.create(null), {
  entities: "auxiliary_entities", entries: "auxiliary_entries", ledger: "auxiliary_ledger", party: "auxiliary_party",
  "entity-create": "auxiliary_entity_create", "entity-update": "auxiliary_entity_update", allocate: "auxiliary_allocate", requirement: "auxiliary_requirement_set",
}));
function auxiliaryData(value, depth = 0) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || types.isProxy(value) || depth > 16) throw new ToolError("aux_input_invalid");
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new ToolError("aux_input_invalid");
  if (Object.getOwnPropertySymbols(value).length) throw new ToolError("aux_input_invalid");
  const keys = Object.getOwnPropertyNames(value).filter(k => !(array && k === "length"));
  if (keys.length > 10000 || array && (keys.length !== value.length || value.length > 10000)) throw new ToolError("aux_input_invalid");
  const out = array ? [] : Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d) || ["__proto__", "prototype", "constructor"].includes(key) || array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new ToolError("aux_input_invalid");
    out[key] = auxiliaryData(d.value, depth + 1);
  }
  return out;
}
function auxiliaryArgs(name, raw) {
  const args = auxiliaryData(raw);
  if (Array.isArray(args) || !args || typeof args !== "object") throw new ToolError("aux_input_invalid");
  const fields = new Set(["accountSetId", "account_set_id", ...AUX_FIELDS[name]]);
  if (Object.keys(args).some(k => !fields.has(k))) throw new ToolError("aux_input_invalid");
  const parseId = value => {
    if (!(typeof value === "number" || typeof value === "string" && value.trim() !== "")) throw new ToolError("account_set_id_invalid");
    const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw new ToolError("account_set_id_invalid"); return n;
  };
  const ids = ["accountSetId", "account_set_id"].filter(k => Object.hasOwn(args, k)).map(k => parseId(args[k]));
  if (!ids.length) throw new ToolError("account_set_id_required");
  if (ids.some(id => id !== ids[0])) throw new ToolError("account_set_id_conflict");
  args.accountSetId = ids[0]; delete args.account_set_id;
  for (const key of ["entryId", "voucherId", "entityId"]) if (Object.hasOwn(args, key) && (!Number.isSafeInteger(args[key]) || args[key] <= 0)) throw new ToolError("aux_id_invalid");
  if (Object.hasOwn(args, "period") && (typeof args.period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(args.period))) throw new ToolError("aux_period_invalid");
  if (Object.hasOwn(args, "allocations")) {
    if (!Array.isArray(args.allocations)) throw new ToolError("aux_allocations_invalid");
    for (const a of args.allocations) if (!a || Array.isArray(a) || typeof a !== "object" || Object.keys(a).some(k => !["projectId", "departmentId", "partyId", "debit", "credit"].includes(k))) throw new ToolError("aux_allocation_invalid");
  }
  return args;
}
const AUX_FUNCTIONS = { auxiliary_entities: AUX.listAuxiliaryEntities, auxiliary_entries: AUX.listAuxiliaryEntries,
  auxiliary_ledger: AUX.auxiliaryLedger, auxiliary_party: AUX.entryPartyAllocation,
  auxiliary_entity_create: AUX.createAuxiliaryEntity, auxiliary_entity_update: AUX.updateAuxiliaryEntity,
  auxiliary_allocate: AUX.replaceAuxiliaryAllocations, auxiliary_requirement_set: AUX.setAuxiliaryRequirement };
function auxiliaryCall(name, raw) {
  const args = auxiliaryArgs(name, raw), value = AUX_FUNCTIONS[name](db, args);
  if (name === "auxiliary_entities" || name === "auxiliary_entries") return { accountSetId: args.accountSetId, items: value };
  if (name === "auxiliary_ledger" || name === "auxiliary_party") return value;
  return { accountSetId: args.accountSetId, result: value };
}

// 只有显式的本机 prepare 操作才能进入银行组件安装。
let bankInstallPromise;
export async function prepareBankDraft(accountSetId, body) {
  new BankLocalDrafts().prepare(accountSetId, body);
  A.getAccountSet(accountSetId);
  if (!bankInstallPromise) {
    const dbPath = db.prepare("PRAGMA database_list").all().find(r => r.name === "main")?.file;
    bankInstallPromise = BANK_STORAGE.ensureBankSchema(db, { dbPath, dataDir: dirname(dbPath), backupService: BANK_BACKUP }).catch(() => { bankInstallPromise = null; throw new BankDraftError("bank_local_install_failed"); });
  }
  await bankInstallPromise;
  return bankLocalDrafts.prepare(accountSetId, body);
}
const BANK_FUNCTIONS = {bank_account_register:BANK.registerBankAccount,bank_import_preview:BANK.previewBankImport,bank_import:BANK.importBankBatch,
  bank_batches:BANK.listBatchesView,bank_transactions:BANK.listTransactionsView,bank_ambiguities:BANK.listAmbiguitiesView,bank_ambiguity_resolve:BANK.resolveAmbiguity,
  bank_candidates:BANK.listCandidates,bank_confirm:BANK.confirmMatch,bank_cancel:BANK.cancelMatch,bank_matches:BANK.listMatchesView,bank_reconcile:BANK.reconcileBank,bank_status:BANK.getBankStatus,bank_audit:BANK.readBankAudit};
async function bankCall(name, raw) {
  try { return await bankLocalDrafts.execute(name, raw, payload => {
    const write = BANK_WRITE_TOOLS.includes(name);
    if (write && !BANK_STORAGE.bankConnectionState(db).writable) throw new BankDraftError("bank_local_state_unknown");
    let result;
    if (name === "bank_accounts") result = { items: BANK_STORAGE.listBankAccounts(db,payload) };
    else if(name === "bank_import_preview") {const {batchId,...preview}=payload;result=BANK.previewBankImport(db,preview);}
    else if(name === "bank_batches") result={items:BANK.listBatchesView(db,payload)};
    else result=BANK_FUNCTIONS[name](db,payload);
    if (!write) return {accountSetId:payload.accountSetId,result};
    if (!BANK_STORAGE.bankConnectionState(db).writable) throw new BankDraftError("bank_local_state_unknown");
    let performed=name==="bank_account_register"||name==="bank_confirm"?result.created:name==="bank_cancel"?result.cancelled:name==="bank_ambiguity_resolve"?result.resolved:name==="bank_import"?!["same-batch","same-batch-pending"].includes(result.replayKind):false;
    if(name==="bank_reconcile") {
      const row=db.prepare("SELECT id FROM bank_reconcile_runs WHERE id=? AND account_set_id=? AND bank_account_id=?").get(result.reconcileRunId,payload.accountSetId,payload.bankAccountId);
      const audit=db.prepare("SELECT id FROM bank_audit_events WHERE account_set_id=? AND bank_account_id=? AND event_type='reconcile_computed' AND subject_id=?").get(payload.accountSetId,payload.bankAccountId,String(result.reconcileRunId));
      performed=!!row&&!!audit;
      if(!performed)throw new BankDraftError("bank_local_state_unknown");
    }
    return {accountSetId:payload.accountSetId,result,evidence:{durability:"committed",performed:performed===true,replayed:performed===false}};
  }); } catch(e) {
    if(String(e?.code??'').startsWith('audit_'))throw e;
    if(operationErrorEvidence(e))throw bankOperationFailure(e);
    const code=e instanceof BankDraftError?e.code:"bank_local_operation_failed";
    throw new ToolError(code,code);
  }
}

// 期间格式：仅接受合法月份 01–12（2026-13 / 2026-00 一律拒绝）。
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());

// 以工具名 / 能力 ID 直接索引普通对象时，toString、constructor 等原型继承属性会被误判为
// “已登记”，从而绕过 unknown_tool / not_implemented 走到调用或取值分支。
// 统一改用无原型字典，并对关键查表再加 hasOwn 兜底。
const dict = (entries) => Object.assign(Object.create(null), entries);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** 账套 ID 必须显式提供，绝不猜选默认账套。 */
function requireAccountSetId(args = {}) {
  const raw = args.accountSetId ?? args.account_set_id;
  if (raw === undefined || raw === null || raw === "") {
    throw new ToolError("accountSetId_required", "必须显式提供 accountSetId（不猜选默认账套）");
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ToolError("accountSetId_invalid", `accountSetId 必须是正整数，收到：${raw}`);
  }
  return id;
}
/** account_context 等上下文工具允许缺省账套（只列账套），返回 0 表示未指定。 */
function optionalAccountSetId(args = {}) {
  const raw = args.accountSetId ?? args.account_set_id;
  if (raw === undefined || raw === null || raw === "") return 0;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ToolError("accountSetId_invalid", `accountSetId 必须是正整数，收到：${raw}`);
  }
  return id;
}
function requirePeriod(args = {}, field = "period") {
  const p = str(args[field]);
  if (!p) throw new ToolError("period_required", `该操作必须显式提供 ${field}（YYYY-MM）`);
  if (!PERIOD_RE.test(p)) throw new ToolError("period_invalid", `${field} 格式应为 YYYY-MM，收到：${p}`);
  return p;
}
function requireVoucherId(args = {}) {
  const raw = args.voucherId ?? args.voucher_id ?? args.params?.voucherId;
  const id = Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isInteger(id) || id <= 0) {
    throw new ToolError("voucherId_required", "必须提供正整数 voucherId");
  }
  return id;
}
function requireEntries(args = {}) {
  const list = args.entries ?? args.params?.entries;
  if (!Array.isArray(list)) throw new ToolError("entries_required", "entries 必须是分录数组");
  return list;
}

// ------------------------------------------------------------------ 查询能力
// 只登记「本地真的实现」的 nodeId；未登记的一律 not_implemented。
// 可用性分类（原站 21 项中哪 11 项不可用）由 MCP 层依据原站 catalog 判定。
const QUERY = dict({
  "enterprise_account.account_set": { run: (setId) => A.getAccountSet(setId) },
  "enterprise_account.subject_system.all": { run: (setId) => A.listAccounts(setId) },
  "voucher.generated.list": {
    period: true,
    run: (setId, a) => A.listVouchers(setId, { period: a.period, status: "posted" }),
  },
  "voucher.generated.summary": {
    period: true,
    note: "当前与 voucher.generated.list 相同：返回已过账凭证列表，尚无独立汇总实现",
    run: (setId, a) => A.listVouchers(setId, { period: a.period, status: "posted" }),
  },
  "voucher.draft.summary": {
    period: true,
    run: (setId, a) => A.listVouchers(setId, { period: a.period, status: "draft" }),
  },
  "voucher.detail": { run: (setId, a) => A.getVoucher(setId, requireVoucherId(a)) },
  "report.balance_sheet": { period: true, run: (setId, a) => A.balanceSheet(setId, a.period) },
  "report.income_statement": { period: true, run: (setId, a) => A.incomeStatement(setId, a.period) },
  "report.cash_flow_statement": { period: true, run: (setId, a) => A.cashFlowStatement(setId, a.period) },
  "period_end.summary": {
    period: true,
    run: (setId, a) => ({ periods: A.listPeriods(setId), trial_balance: A.trialBalance(setId, a.period) }),
  },
  // ---- 本地扩展（不在原站契约内，单独标注 origin=local，不冒充原站证据）----
  "report.trial_balance": { period: true, local: true, run: (setId, a) => A.trialBalance(setId, a.period) },
  "ledger.general": {
    period: true,
    local: true,
    requiresCode: true,
    run: (setId, a) => A.generalLedger(setId, str(a.params?.code ?? a.code), a.period),
  },
});

const QUERY_LABELS = dict({
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
  "report.trial_balance": "查询试算平衡（本地扩展）",
  "ledger.general": "查询科目明细账（本地扩展）",
});

// 收录于原站契约、但本地无数据源的查询能力：明确返回 not_implemented。
const QUERY_UNIMPLEMENTED = new Set([
  "enterprise_account.bank",
  "enterprise_account.business",
  "enterprise_account.personnel",
  "enterprise_account.tax_assessment",
  "enterprise_account.tax",
  "enterprise_account.auxiliary_accounting.all",
  "fund.unbooked.list",
  "fund.unbooked.summary",
  "invoice.detail",
  "invoice.unbooked.list",
  "invoice.unbooked.summary",
]);

function financeQuery(args = {}) {
  const setId = requireAccountSetId(args);
  const nodeId = str(args.nodeId);
  if (!nodeId) throw new ToolError("nodeId_required", "必须提供 nodeId；先用 finance_query_catalog 查看可用能力");

  const entry = own(QUERY, nodeId) ? QUERY[nodeId] : undefined;
  if (!entry) {
    return {
      nodeId,
      label: (own(QUERY_LABELS, nodeId) && QUERY_LABELS[nodeId]) || "查询财务数据",
      not_implemented: true,
      hint: QUERY_UNIMPLEMENTED.has(nodeId)
        ? "该能力属于原站契约，但本地没有对应数据源（发票/银行/税务/辅助核算未接入）"
        : `本地未实现查询能力：${nodeId}`,
    };
  }

  const period = entry.period ? requirePeriod(args) : args.period;
  const out = { nodeId, label: (own(QUERY_LABELS, nodeId) && QUERY_LABELS[nodeId]) || "查询财务数据" };
  if (entry.local) out.origin = "local";
  if (entry.note) out.note = entry.note;
  if (entry.requiresCode && !str(args.params?.code ?? args.code)) {
    throw new ToolError("code_required", `查询 ${nodeId} 必须提供 params.code（科目编码）`);
  }
  out.data = entry.run(setId, { ...args, period });
  return out;
}

// ------------------------------------------------------------------ 未实现占位
// 保留工具名以兼容原站契约，但结果必须真实：绝不伪装成功。
const NOT_IMPLEMENTED = dict({
  invoice_collect: "发票采集需要对接税局/第三方发票数据源，本地未接入",
  invoice_file: "发票原件获取需要发票数据源，本地未接入",
  invoice_issue: "开票需要真实开票服务通道，本地未接入",
  invoice_issue_result: "开票结果查询需要真实开票服务通道，本地未接入",
  invoice_precheck: "开票预检依赖开票服务通道，本地未接入",
  invoice_red_apply: "红字信息表申请依赖开票服务通道，本地未接入",
  invoice_red_issue: "红字发票开具依赖开票服务通道，本地未接入",
  invoice_red_status: "红字状态查询依赖开票服务通道，本地未接入",
  invoice_tax_code: "税收分类编码库未接入",
  declaration_query: "申报状态查询需要税局通道，本地未接入",
  tax_declaration_query: "申报状态查询需要税局通道，本地未接入",
  exec: "finance 后端的命令执行分支未实现（与 Codex 自身的命令执行工具无关）",
  finance_task_status: "本地工作台没有异步任务系统，无法按 taskId 查询真实任务状态",
});

// ------------------------------------------------------------------ 税务适配层（第一期：仅接口预留）
// 默认注册表为空：生产环境不会加载任何适配器，也就不会有任何地区被标成「已接入」，
// 登录类调用一律返回结构化未接入错误。适配器只能由代码显式 registerAdapter 注入（测试用），
// 不提供任何通过 HTTP / 环境变量加载模块或执行任意代码的入口。
// 账套存在性由 accounting 校验后注入，网关自身不访问数据库。
export const taxGateway = new TaxGateway({
  accountSetExists: (id) => { A.getAccountSet(id); return true; },
});
export const taxAcquisition = new TaxAcquisition({ gateway: taxGateway, accounting: A });
// 显式调用 tax_browser_open 前不打开任何对象。
export const taxBrowserSessions = new FujianBrowserSessions();
export const taxLiveCollection = new TaxLiveCollection();
export const taxHistoryCollection = new TaxHistoryCollection();

/**
 * 把网关的 TaxError 归一成后端工具错误（保留 code 供 MCP 客户端判定）。
 * 网关的会话类方法都是 async（适配器允许返回 Promise），因此这里必须 await：
 * 只有 await 才能捕获 Promise 的拒绝（异步 TaxError），否则会漏成 unhandled rejection。
 */
function taxHandler(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof TaxError || e instanceof TaxBrowserError) throw new ToolError(e.code, e.message, e.details);
      throw e;
    }
  };
}

/**
 * 把目录层/分类器层的纯函数错误归一成 ToolError，保留 code 供 MCP 客户端判定。
 * 这些工具不发网络请求、不接受任意 URL，也不需要税务会话。
 */
function catalogHandler(fn) {
  return (args) => {
    try {
      return fn(args ?? {});
    } catch (e) {
      if (e && typeof e.code === "string" && /^catalog_/.test(e.code)) throw new ToolError(e.code, e.message);
      if (e && typeof e.code === "string" && /^classify_/.test(e.code)) throw new ToolError(e.code, e.message);
      throw e;
    }
  };
}

/** 目录工具只接受固定字段：多余字段直接拒绝，且不回显未知键名。 */
function rejectExtra(args, allowed) {
  const extraCount = Object.keys(args).filter((key) => !allowed.includes(key)).length;
  if (extraCount) {
    throw Object.assign(new Error(`不接受未登记的参数（${extraCount} 项，未回显键名）`), { code: "catalog_filter_invalid" });
  }
}

// ------------------------------------------------------------------ 已实现工具
const HANDLERS = dict({
  ...Object.fromEntries(BANK_TOOLS.map(name=>[name,args=>bankCall(name,args)])),
  auxiliary_entities: args => auxiliaryCall("auxiliary_entities", args),
  auxiliary_entries: args => auxiliaryCall("auxiliary_entries", args),
  auxiliary_ledger: args => auxiliaryCall("auxiliary_ledger", args),
  auxiliary_party: args => auxiliaryCall("auxiliary_party", args),
  auxiliary_entity_create: args => auxiliaryCall("auxiliary_entity_create", args),
  auxiliary_entity_update: args => auxiliaryCall("auxiliary_entity_update", args),
  auxiliary_allocate: args => auxiliaryCall("auxiliary_allocate", args),
  auxiliary_requirement_set: args => auxiliaryCall("auxiliary_requirement_set", args),
  tax_api_catalog_modules: catalogHandler((args) => {
    rejectExtra(args, ["moduleId"]);
    const stats = catalogStats();
    if (args.moduleId !== undefined) {
      const detail = moduleStats(str(args.moduleId));
      return { source: CATALOG_SOURCE, stats, module: detail.module, entries: detail.entries,
        catalogManaged: true, liveCallVerified: false };
    }
    return { source: CATALOG_SOURCE, stats, modules: listModules(), catalogManaged: true, liveCallVerified: false };
  }),
  tax_api_catalog_search: catalogHandler((args) => searchCatalog(args)),
  tax_api_catalog_entry: catalogHandler((args) => {
    rejectExtra(args, ["id"]);
    return { ...entryDetail(getCatalogEntry(str(args.id))), source: CATALOG_SOURCE };
  }),
  tax_api_catalog_validate: catalogHandler((args) => {
    rejectExtra(args, ["id", "params"]);
    return validateParams(str(args.id), args.params ?? {});
  }),
  tax_api_catalog_prepare: catalogHandler((args) => prepareCatalogCall(args, {
    // 约定：resolver 必须同步返回布尔 true/false；返回 false 一律按“账套不存在”拒绝。
    accountSetExists: (id) => { A.getAccountSet(id); return true; },
  })),
  tax_api_catalog_classify: catalogHandler((args) => {
    rejectExtra(args, ["risk", "observation", "results"]);
    const risk = str(args.risk) || "unknown";
    const result = classifyOutcome(args.observation ?? {}, { risk });
    if (args.results !== undefined) return { ...result, aggregate: aggregateOutcomes(args.results) };
    return result;
  }),
  tax_api_catalog_outcomes: catalogHandler((args) => {
    rejectExtra(args, []);
    return {
      outcomes: Object.entries(OUTCOMES).map(([id, label]) => ({ id, label })),
      rules: [
        "HTTP 200 不等于成功：需已解析、结构识别且业务码为成功族，且元数据不矛盾",
        "零事件不等于空数据：空结果必须有显式无记录证据",
        "单接口认证错误不判全局登录失效；本工具不提供全局会话推断（全局校验用既有 tax_session_verify）",
        "重试能力与本次建议分开：只有只读瞬时传输失败且未用尽次数才建议重试",
        "timeoutMs 为本地策略默认值，不是税局 SLA",
      ],
      globalSessionState: "unknown",
      catalogManaged: true,
      liveCallVerified: false,
    };
  }),

  tax_live_collect: (args) => taxLiveCollection.collect(args ?? {}),
  tax_live_compare: (args) => taxLiveCollection.compare(args ?? {}),
  tax_history_collect: (args) => taxHistoryCollection.collect(args ?? {}),
  tax_history_compare: (args) => taxHistoryCollection.compare(args ?? {}),
  tax_browser_open: taxHandler((args) => taxBrowserSessions.open(args ?? {})),
  tax_browser_probe: taxHandler((args) => taxBrowserSessions.probe(args ?? {})),
  tax_browser_close: taxHandler((args) => taxBrowserSessions.close(args ?? {})),
  finance_query_catalog: () => ({
    capabilities: Object.keys(QUERY),
    local_extensions: Object.keys(QUERY).filter((id) => QUERY[id].local),
    subagents: SUBAGENTS,
    note: "此处仅列本地已实现能力；原站完整契约见 MCP 的 finance_query_catalog.items",
  }),

  finance_query: (args) => financeQuery(args),

  account_context: (args) => contextTool(args),
  finance_context_resolve: (args) => contextTool(args),

  voucher_check: (args) => {
    const setId = requireAccountSetId(args);
    return { accountSetId: setId, ...A.checkVoucher(setId, requireEntries(args)) };
  },
  voucher_create: (args) => {
    const setId = requireAccountSetId(args);
    const period = requirePeriod(args);
    return A.createVoucher(setId, {
      period,
      voucher_date: str(args.voucher_date) || `${period}-01`,
      word: args.word,
      number: args.number,
      summary: args.summary,
      kind: args.kind,
      // 默认草稿：只有显式 status='posted' 才过账。
      status: args.status === "posted" ? "posted" : "draft",
      entries: requireEntries(args),
    });
  },

  legacy_book_import: (args) => {
    const payload = args.payload
      || (args.texts ? A.parseImportTexts(args.texts, args.meta || {}) : null)
      || (args.files ? A.parseImportTexts(decodeFiles(args.files, args.encoding), args.meta || {}) : null);
    if (!payload) throw new ToolError("payload_or_texts_or_files_required", "需要 payload / texts / files / paths 之一");
    // 与 MCP/HTTP 语料一致：默认预检，只有显式 dryRun=false 才落库。
    return A.importAccountSet(payload, { dryRun: args.dryRun !== false, enterprise: args.enterprise, profileId: args.profileId });
  },

  // ---- 增量导入（LOCAL-01）：稳定来源 / 企业身份 + 批次幂等 + 来源凭证去重 / 冲突 ----
  book_import_incremental: (args) => {
    const payload = args.payload
      || (args.texts ? A.parseImportTexts(args.texts, args.meta || {}) : null)
      || (args.files ? A.parseImportTexts(decodeFiles(args.files, args.encoding), args.meta || {}) : null);
    const result = importIncremental({
      payload,
      // 与既有导入一致：默认只预检，只有显式 dryRun=false 才落库。
      dryRun: args.dryRun !== false,
      batchId: args.batchId ?? args.batch_id,
      source: args.source, enterprise: args.enterprise, profileId: args.profileId, profile_id: args.profile_id,
      mode: args.mode,
      accountSetId: args.accountSetId ?? args.account_set_id,
      confirmNewBinding: args.confirmNewBinding === true || args.confirm_new_binding === true,
      auxiliaryAppendix: args.auxiliaryAppendix,
    });
    return incrementalOutcome(result);
  },

  book_import_batch: (args) => {
    const batchId = args.batchId ?? args.batch_id;
    if (batchId === undefined || batchId === null || String(batchId).trim() === "") {
      throw new ToolError("batchId_required", "必须提供批次 ID batchId");
    }
    return getImportBatch(batchId);
  },

  // ---- 账套 / 科目 / 期初 ----
  account_set_create: (args) => {
    const name = str(args.name);
    if (!name) throw new ToolError("name_required", "必须提供账套名称 name");
    const start_period = str(args.start_period);
    if (!PERIOD_RE.test(start_period)) {
      throw new ToolError("start_period_invalid", `start_period 格式应为 YYYY-MM，收到：${start_period || "(空)"}`);
    }
    return A.createAccountSet({
      name,
      taxpayer_type: args.taxpayer_type,
      accounting_standard: args.accounting_standard, enterprise: args.enterprise, profileId: args.profileId,
      start_period,
    });
  },
  account_list: (args) => {
    const setId = requireAccountSetId(args);
    return { accountSetId: setId, items: A.listAccounts(setId) };
  },
  account_create: (args) => {
    const setId = requireAccountSetId(args);
    return { accountSetId: setId, items: A.addAccount(setId, {
      code: str(args.code), name: str(args.name),
      category: str(args.category), direction: str(args.direction),
    }) };
  },
  opening_balance_get: (args) => {
    const setId = requireAccountSetId(args);
    return { accountSetId: setId, items: A.getOpeningBalances(setId) };
  },
  opening_balance_set: (args) => {
    const setId = requireAccountSetId(args);
    const items = args.items ?? args.balances;
    if (!Array.isArray(items)) throw new ToolError("items_required", "items 必须是期初余额数组");
    return { accountSetId: setId, items: A.setOpeningBalances(setId, items) };
  },

  // ---- 期间 ----
  period_list: (args) => {
    const setId = requireAccountSetId(args);
    return { accountSetId: setId, items: A.listPeriods(setId) };
  },
  period_set_status: (args) => {
    const setId = requireAccountSetId(args);
    const period = requirePeriod(args);
    return { accountSetId: setId, ...A.setPeriodStatus(setId, period, str(args.status)) };
  },

  // ---- 凭证状态流转 ----
  voucher_post: (args) => {
    const setId = requireAccountSetId(args);
    return A.postVoucher(setId, requireVoucherId(args));
  },
  voucher_unpost: (args) => {
    const setId = requireAccountSetId(args);
    return A.unpostVoucher(setId, requireVoucherId(args));
  },
  voucher_delete: (args) => {
    const setId = requireAccountSetId(args);
    return { accountSetId: setId, ...A.deleteVoucher(setId, requireVoucherId(args)) };
  },

  // ---- 查账 ----
  ledger_query: (args) => {
    const setId = requireAccountSetId(args);
    const code = str(args.code ?? args.params?.code);
    if (!code) throw new ToolError("code_required", "必须提供科目编码 code");
    const period = requirePeriod(args);
    return { accountSetId: setId, ...A.generalLedger(setId, code, period) };
  },

  // ---- 资产 / 折旧 / 结转（后端已有实现，本轮正式注册到 MCP）----
  asset_list: (args) => A.listAssetCards(requireAccountSetId(args)),
  asset_create: (args) => A.addAssetCard(requireAccountSetId(args), args),
  // 资产卡片维护 / 补项：取得期间、期初累计、未入账登记，用于解除卡片与总账差异的封账阻塞。
  asset_update: (args) => {
    const setId = requireAccountSetId(args);
    const rawId = args.assetId ?? args.asset_id;
    const assetId = Number(rawId);
    if (rawId === undefined || rawId === null || rawId === "" || !Number.isInteger(assetId) || assetId <= 0) {
      throw new ToolError("assetId_required", "必须提供正整数 assetId");
    }
    const patch = args.patch && typeof args.patch === "object" && !Array.isArray(args.patch)
      ? args.patch
      : Object.fromEntries(Object.entries(args).filter(([k]) => !["accountSetId", "account_set_id", "assetId", "asset_id", "patch"].includes(k)));
    return A.updateAssetCard(setId, assetId, patch);
  },
  // 期末检查（只读）：与封账前置同一规则，逐步给适用 / 不适用理由、明确缺项与修复建议。
  period_end_check: (args) => {
    const setId = requireAccountSetId(args);
    return A.periodEndCheck(setId, requirePeriod(args));
  },
  depreciation_run: (args) => A.generateDepreciation(requireAccountSetId(args), requirePeriod(args)),
  carry_forward_profit: (args) => A.carryForwardProfit(requireAccountSetId(args), requirePeriod(args), { yearEnd: !!args.yearEnd }),

  // ---- 全国电子税务局适配层（第一期：接口预留，默认未接入任何地区）----
  tax_regions: taxHandler((args) => taxGateway.listRegions(args)),
  tax_capabilities: taxHandler((args) => taxGateway.listCapabilities(args ?? {})),
  tax_login_start: taxHandler((args) => taxGateway.startLogin(args ?? {})),
  tax_login_status: taxHandler((args) => taxGateway.getStatus(args ?? {})),
  tax_login_challenge: taxHandler((args) => taxGateway.submitChallenge(args ?? {})),
  tax_logout: taxHandler((args) => taxGateway.logout(args ?? {})),
  tax_info_query: taxHandler((args) => taxGateway.infoQuery(args ?? {})),
  tax_session_verify: taxHandler((args) => taxAcquisition.verifySession(args ?? {})),
  tax_resource_collect: taxHandler((args) => taxAcquisition.collect(args ?? {})),
  tax_resource_coverage: taxHandler((args) => taxAcquisition.coverage(args ?? {})),
  tax_account_set_link: taxHandler((args) => taxAcquisition.linkAccountSet(args ?? {})),
  tax_preparation_build: taxHandler((args) => taxAcquisition.prepare(args ?? {})),

  // ---- 兼容入口：不再谎报持久化 / 完成任务 ----
  update_plan: (args) => ({
    plan: args.plan ?? [],
    saved: false,
    persisted: false,
    note: "本地分支未实现计划持久化：仅回显入参，不会保存到磁盘或数据库",
  }),
});

/**
 * 增量导入结果 → Agent 工具返回 / 错误：
 * - rejected（参数 / 严格校验失败）→ import_validation_failed；
 * - conflict（身份 / 去重 / 封账 / 期初覆盖等结构化冲突）→ import_conflict；
 * - 其余（preview / applied / idempotent_replay）原样返回，不把失败伪装成成功。
 */
function incrementalOutcome(result) {
  if (result.status === "rejected") {
    throw new ToolError(
      "import_validation_failed",
      `增量导入被拒绝：${result.errors[0] || "参数或数据不合法"}`,
      { errors: result.errors, validation: result.validation, conflicts: result.conflicts },
    );
  }
  if (result.status === "conflict") {
    throw new ToolError(
      "import_conflict",
      `增量导入存在结构化冲突：${result.conflicts.map((c) => c.code).join(", ")}`,
      { conflicts: result.conflicts, validation: result.validation },
    );
  }
  return result;
}

function contextTool(args) {
  const setId = optionalAccountSetId(args);
  return {
    account_sets: A.listAccountSets(),
    periods: setId ? A.listPeriods(setId) : [],
    current_account_set_id: null,
    persisted: false,
    note: "本地分支不保存“当前选中账套”；每次查询都必须显式传 accountSetId",
  };
}

const SUBAGENTS = [
  { runtimeName: "bookkeeping", displayName: "智能核算" },
  { runtimeName: "legacy-book-import", displayName: "导入旧账" },
];

/** 把 base64 文件按指定编码解码成文本（供 CLI/Agent 直传文件用）。 */
export function decodeFiles(files = {}, encoding = "utf-8") {
  const out = {};
  for (const [k, v] of Object.entries(files)) {
    if (typeof v === "string" && v) out[k] = new TextDecoder(encoding).decode(Buffer.from(v, "base64"));
  }
  return out;
}

export const AGENT_TOOL_NAMES = [
  ...Object.keys(HANDLERS),
  ...Object.keys(NOT_IMPLEMENTED),
].sort();

/**
 * 明确的模型调用接口：普通财务工具固定走 finance-model-entry 的投影信封。
 * 与 raw `callAgentTool` 并列，raw 语义不变；本函数不在 raw 实现内递归适配。
 * 动态 import 只为避免 agent-tools ↔ finance-model-entry 的静态循环（entry 会 import 本文件）。
 */
let financeModelEntryPromise = null;
export async function callAgentModelTool(name, args = {}) {
  if (!financeModelEntryPromise) financeModelEntryPromise = import("./finance-model-entry.mjs");
  const entry = await financeModelEntryPromise;
  return entry.callModelTool(name, args);
}

/** 执行一次 /agent/tools/<name> 调用。未知工具抛 ToolError('unknown_tool')。 */
async function callAgentToolBody(name, args = {}) {
  if (!name) throw new ToolError("tool_required", "缺少工具名");
  if (own(NOT_IMPLEMENTED, name)) {
    return { not_implemented: true, tool: name, hint: NOT_IMPLEMENTED[name] };
  }
  const handler = own(HANDLERS, name) ? HANDLERS[name] : undefined;
  if (typeof handler !== "function") throw new ToolError("unknown_tool", `未知工具：${name}`);
  return handler(args && typeof args === "object" ? args : {});
}

export async function callAgentTool(name,args={}) {const extracted=extractOperationMetadata(args,{actor:'agent'});return withRequestMetadata(extracted.metadata,()=>callAgentToolBody(name,extracted.payload));}
