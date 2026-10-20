// agent-tools.mjs — `/agent/tools/<name>` 的工具注册表（MCP 的后端执行层）。
//
// 职责边界：只做「参数校验 + 编排既有领域函数 + 统一错误结构」，
// 不复制 accounting.mjs 的任何业务算法；领域签名由 accounting.mjs 提供。
//
// 返回约定：
//   - 成功：返回该工具自己的 JSON 结构（保留既有兼容字段）。
//   - 未实现：返回 { not_implemented: true, ... }（HTTP 200，由 MCP 层转成 isError）。
//   - 参数/领域错误：抛 ToolError 或领域异常，由 HTTP 层映射成 4xx 结构化错误。
import * as A from "./accounting.mjs";
import { TaxGateway, TaxError } from "./tax-gateway.mjs";
import { TaxAcquisition } from "./tax-acquisition.mjs";
import { FujianBrowserSessions } from "./tax-fujian-session.mjs";
import { TaxBrowserError } from "./tax-browser-transport.mjs";
import { TaxLiveCollection } from "./tax-live-collection.mjs";
import { TaxQueryCollection } from "./tax-query-collection.mjs";

export class ToolError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
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
// Opens nothing until the explicit tax_browser_open tool is invoked.
export const taxBrowserSessions = new FujianBrowserSessions();
export const taxLiveCollection = new TaxLiveCollection();
export const taxQueryCollection = new TaxQueryCollection();

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

// ------------------------------------------------------------------ 已实现工具
const HANDLERS = dict({
  tax_query_collect: (args) => taxQueryCollection.collect(args ?? {}),
  tax_query_compare: (args) => taxQueryCollection.compare(args ?? {}),
  tax_live_collect: (args) => taxLiveCollection.collect(args ?? {}),
  tax_live_compare: (args) => taxLiveCollection.compare(args ?? {}),
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
    return A.importAccountSet(payload, { dryRun: args.dryRun !== false });
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
      accounting_standard: args.accounting_standard,
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

/** 执行一次 /agent/tools/<name> 调用。未知工具抛 ToolError('unknown_tool')。 */
export async function callAgentTool(name, args = {}) {
  if (!name) throw new ToolError("tool_required", "缺少工具名");
  if (own(NOT_IMPLEMENTED, name)) {
    return { not_implemented: true, tool: name, hint: NOT_IMPLEMENTED[name] };
  }
  const handler = own(HANDLERS, name) ? HANDLERS[name] : undefined;
  if (typeof handler !== "function") throw new ToolError("unknown_tool", `未知工具：${name}`);
  return handler(args && typeof args === "object" ? args : {});
}
