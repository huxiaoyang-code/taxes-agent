/**
 * tools.mjs — finance-mcp 的工具契约（名称、描述、参数 schema、真实可用状态）
 *
 * 这里同时承担两件事：
 *   1) 向 MCP 客户端公布工具清单与 JSON Schema；
 *   2) 对入参做最小运行时校验，避免把明显无效的调用转发给后端。
 *
 * 可用状态分三档：
 *   - available   ：本地后端已实现，可真实完成业务；
 *   - limited     ：可调用但行为受限（例如 update_plan 只回显、不持久化）；
 *   - unavailable ：本地未实现，调用必须返回 isError，绝不伪装成功。
 */

export class ToolCallError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = "ToolCallError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------- schema 片段
const ACCOUNT_SET_ID = { type: ["integer", "string"], description: "账套 ID（必填，不猜默认账套）" };
const PERIOD = { type: "string", description: "会计期间，格式 YYYY-MM" };
const ENTRIES = {
  type: "array",
  description: "分录数组，每项 { code, debit, credit, summary? }；借贷必须平衡",
  items: {
    type: "object",
    properties: {
      code: { type: "string", description: "科目编码" },
      debit: { type: "number" },
      credit: { type: "number" },
      summary: { type: "string" },
    },
    required: ["code"],
  },
};

const obj = (properties, required = []) => ({ type: "object", properties, required });

// ---------------------------------------------------------------- 工具清单
const available = (name, description, inputSchema, origin = "upstream") =>
  ({ name, description, inputSchema, status: "available", origin });
const limited = (name, description, inputSchema, origin = "upstream") =>
  ({ name, description, inputSchema, status: "limited", origin });
const unavailable = (name, description, origin = "upstream") =>
  ({ name, description, inputSchema: obj({}), status: "unavailable", origin });

/** 后端已实现（含本轮正式注册的 4 个扩展工具与 11 个新增管理工具）。 */
const BACKEND_TOOLS = [
  available("account_context", "列出账套（可选带出某账套的期间）。本地不保存“当前账套”，不返回选中状态。",
    obj({ accountSetId: { ...ACCOUNT_SET_ID, description: "可选：一并返回该账套的期间" } })),
  available("finance_context_resolve", "account_context 的兼容别名：列出账套与可选期间。",
    obj({ accountSetId: { ...ACCOUNT_SET_ID, description: "可选：一并返回该账套的期间" } })),
  available("finance_query", "查询财务数据。必须显式提供 accountSetId；期间类能力必须显式提供 period。可用能力见 finance_query_catalog。",
    obj({
      nodeId: { type: "string", description: "查询能力 ID，例如 report.balance_sheet" },
      accountSetId: ACCOUNT_SET_ID,
      period: PERIOD,
      params: { type: "object", description: "附加参数，如 voucher.detail 的 { voucherId }、ledger.general 的 { code }" },
    }, ["nodeId", "accountSetId"])),

  available("voucher_check", "只校验凭证分录（借贷平衡、科目存在），不落库。",
    obj({ accountSetId: ACCOUNT_SET_ID, entries: ENTRIES }, ["accountSetId", "entries"])),
  available("voucher_create", "创建凭证：支持明确的 period / voucher_date / entries / status；status 缺省为 draft。",
    obj({
      accountSetId: ACCOUNT_SET_ID,
      period: PERIOD,
      voucher_date: { type: "string", description: "凭证日期 YYYY-MM-DD，缺省为期间首日" },
      summary: { type: "string" },
      word: { type: "string", description: "凭证字，缺省 记" },
      number: { type: "integer", description: "凭证号，缺省自动取号" },
      status: { type: "string", enum: ["draft", "posted"], description: "缺省 draft（草稿）" },
      entries: ENTRIES,
    }, ["accountSetId", "period", "entries"])),

  available("legacy_book_import", "导入旧账：账套 + 科目 + 期初 + 历史凭证。默认 dryRun=true 只预检，必须显式 dryRun=false 才落库。",
    obj({
      dryRun: { type: "boolean", description: "缺省 true=仅预检；显式 false=正式导入" },
      payload: { type: "object", description: "{account_set, accounts, opening_balances, vouchers}" },
      texts: { type: "object", description: "CSV 文本：{meta, accounts, openings, vouchers}" },
      paths: { type: "object", description: "本机 CSV 路径：{meta, accounts, openings, vouchers}" },
      files: { type: "object", description: "CSV base64：{meta, accounts, openings, vouchers}" },
      encoding: { type: "string", description: "files 解码编码，如 utf-8 / gbk" },
      meta: { type: "object", description: "覆盖账套信息：{name, taxpayer_type, accounting_standard, start_period}" },
    })),

  // ---- 账套 / 科目 / 期初 / 期间 ----
  available("account_set_create", "新建账套并自动载入标准科目。",
    obj({
      name: { type: "string", description: "账套名称" },
      start_period: PERIOD,
      taxpayer_type: { type: "string", description: "缺省 小规模纳税人" },
      accounting_standard: { type: "string", description: "缺省 小企业会计准则" },
    }, ["name", "start_period"]), "local"),
  available("account_list", "列出账套下的科目。",
    obj({ accountSetId: ACCOUNT_SET_ID }, ["accountSetId"]), "local"),
  available("account_create", "新增明细科目。",
    obj({
      accountSetId: ACCOUNT_SET_ID,
      code: { type: "string" },
      name: { type: "string" },
      category: { type: "string", enum: ["资产", "负债", "权益", "成本", "损益"] },
      direction: { type: "string", enum: ["debit", "credit"] },
    }, ["accountSetId", "code", "name", "category", "direction"]), "local"),
  available("opening_balance_get", "查询期初余额。",
    obj({ accountSetId: ACCOUNT_SET_ID }, ["accountSetId"]), "local"),
  available("opening_balance_set", "保存期初余额（按科目覆盖写入）。",
    obj({
      accountSetId: ACCOUNT_SET_ID,
      items: {
        type: "array",
        description: "期初余额数组，每项 { code, debit, credit }",
        items: { type: "object", properties: { code: { type: "string" }, debit: { type: "number" }, credit: { type: "number" } }, required: ["code"] },
      },
    }, ["accountSetId", "items"]), "local"),
  available("period_list", "列出账套已登记的期间及状态。",
    obj({ accountSetId: ACCOUNT_SET_ID }, ["accountSetId"]), "local"),
  available("period_set_status", "结账/反结账：把期间状态设为 closed 或 open。仅对本账套已登记的期间生效。",
    obj({
      accountSetId: ACCOUNT_SET_ID,
      period: PERIOD,
      status: { type: "string", enum: ["open", "closed"] },
    }, ["accountSetId", "period", "status"]), "local"),

  // ---- 凭证状态流转 ----
  available("voucher_post", "过账草稿凭证。",
    obj({ accountSetId: ACCOUNT_SET_ID, voucherId: { type: ["integer", "string"] } }, ["accountSetId", "voucherId"]), "local"),
  available("voucher_unpost", "反过账：把已过账凭证退回草稿。",
    obj({ accountSetId: ACCOUNT_SET_ID, voucherId: { type: ["integer", "string"] } }, ["accountSetId", "voucherId"]), "local"),
  available("voucher_delete", "删除凭证（仅草稿；已过账需先反过账）。",
    obj({ accountSetId: ACCOUNT_SET_ID, voucherId: { type: ["integer", "string"] } }, ["accountSetId", "voucherId"]), "local"),

  // ---- 查账 ----
  available("ledger_query", "查询某科目在指定期间的明细账（含期初、逐笔余额）。",
    obj({ accountSetId: ACCOUNT_SET_ID, code: { type: "string", description: "科目编码" }, period: PERIOD },
      ["accountSetId", "code", "period"]), "local"),

  // ---- 后端已有、本轮正式注册（本地扩展，非原站契约工具）----
  available("asset_list", "列出固定资产/无形资产卡片及已计提金额。",
    obj({ accountSetId: ACCOUNT_SET_ID }, ["accountSetId"]), "local"),
  available("asset_create", "新增固定资产/无形资产卡片（不自动生成购入凭证）。",
    obj({
      accountSetId: ACCOUNT_SET_ID,
      kind: { type: "string", enum: ["fixed", "intangible"], description: "缺省 fixed" },
      name: { type: "string" },
      original_cost: { type: "number", description: "原值" },
      useful_life_months: { type: "integer" },
      start_period: PERIOD,
      residual_rate: { type: "number", description: "残值率，固定资产缺省 0.05，无形资产缺省 0" },
      asset_account: { type: "string" },
      accum_account: { type: "string" },
      expense_account: { type: "string", description: "折旧/摊销费用科目，缺省 5602" },
    }, ["accountSetId", "name", "original_cost", "useful_life_months", "start_period"]), "local"),
  available("depreciation_run", "对全部资产卡片按直线法计提指定期间折旧/摊销，生成一张凭证。同期不重复计提。",
    obj({ accountSetId: ACCOUNT_SET_ID, period: PERIOD }, ["accountSetId", "period"]), "local"),
  available("carry_forward_profit", "结转本期损益到 3103；yearEnd=true 时再结转 3103→3104。",
    obj({ accountSetId: ACCOUNT_SET_ID, period: PERIOD, yearEnd: { type: "boolean" } }, ["accountSetId", "period"]), "local"),

  // ---- 兼容入口：行为受限，但不谎报 ----
  limited("update_plan", "更新处理计划。本地分支仅回显入参，不持久化（返回 persisted=false）。",
    obj({ plan: { type: "array", description: "计划步骤数组" } })),
];

/** 原站契约内、本地未实现的工具：保留名称，调用返回 isError。 */
const PLACEHOLDER_TOOLS = [
  ["invoice_collect", "采集发票（未实现：需对接发票数据源）"],
  ["invoice_file", "获取发票原件（未实现：需对接发票数据源）"],
  ["invoice_issue", "开具发票（未实现：无开票服务通道）"],
  ["invoice_issue_result", "查询开票结果（未实现：无开票服务通道）"],
  ["invoice_precheck", "开票预检（未实现：无开票服务通道）"],
  ["invoice_red_apply", "申请红字信息表（未实现：无开票服务通道）"],
  ["invoice_red_issue", "开具红字发票（未实现：无开票服务通道）"],
  ["invoice_red_status", "查询红字状态（未实现：无开票服务通道）"],
  ["invoice_tax_code", "筛选税收分类编码（未实现：编码库未接入）"],
  ["declaration_query", "查询申报状态（未实现：无税局通道）"],
  ["tax_declaration_query", "查询申报状态（未实现：无税局通道）"],
  ["exec", "运行命令（未实现：finance 后端无执行分支，与 Codex 命令工具无关）"],
  ["finance_task_status", "查询财税任务状态（未实现：本地无异步任务系统，不能返回 completed）"],
].map(([name, description]) => unavailable(name, description));

/** 纯本地工具（不经后端）。 */
const LOCAL_TOOLS = [
  available("finance_query_catalog", "列出财务查询能力：items 为原站契约原文，capabilities 标注本地真实支持状态。", obj({}), "local"),
  available("skills_list", "查找可用财税业务规则(Skill)文件。", obj({}), "local"),
  available("skills_read", "读取业务规则(Skill) Markdown 正文。",
    obj({ resource: { type: "string", description: "Skill 相对路径，例如 bookkeeping/SKILL.md" } }, ["resource"]), "local"),
];

export const TOOLS = [...LOCAL_TOOLS, ...BACKEND_TOOLS, ...PLACEHOLDER_TOOLS];
export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** 本地自己处理、不转发后端的工具。 */
export const LOCAL_ONLY = new Set(["finance_query_catalog", "skills_list", "skills_read"]);

// ---------------------------------------------------------------- 查询能力可用性
/**
 * 原站 21 项查询能力的本地真实状态。
 * 未列出的 nodeId（且不在 LOCAL_QUERY 中）一律视为“未知能力”，报错而不是静默。
 */
const UNIMPLEMENTED_QUERIES = {
  "enterprise_account.bank": "银行账户数据源未接入",
  "enterprise_account.business": "工商信息数据源未接入",
  "enterprise_account.personnel": "人员数据源未接入",
  "enterprise_account.tax_assessment": "税种核定数据源未接入",
  "enterprise_account.tax": "税务信息数据源未接入",
  "enterprise_account.auxiliary_accounting.all": "辅助核算未实现",
  "fund.unbooked.list": "银行流水未接入",
  "fund.unbooked.summary": "银行流水未接入",
  "invoice.detail": "发票数据源未接入",
  "invoice.unbooked.list": "发票数据源未接入",
  "invoice.unbooked.summary": "发票数据源未接入",
};
const IMPLEMENTED_QUERIES = {
  "enterprise_account.account_set": { requiresPeriod: false },
  "enterprise_account.subject_system.all": { requiresPeriod: false },
  "voucher.generated.list": { requiresPeriod: true },
  "voucher.generated.summary": { requiresPeriod: true, note: "当前与 voucher.generated.list 相同，返回凭证列表而非独立汇总" },
  "voucher.draft.summary": { requiresPeriod: true },
  "voucher.detail": { requiresPeriod: false, requiresVoucherId: true },
  "report.balance_sheet": { requiresPeriod: true },
  "report.income_statement": { requiresPeriod: true },
  "report.cash_flow_statement": { requiresPeriod: true },
  "period_end.summary": { requiresPeriod: true },
};
/** 本地扩展的查询能力：单列，不混入原站证据。 */
export const LOCAL_QUERIES = {
  "report.trial_balance": { label: "查询试算平衡", requiresPeriod: true },
  "ledger.general": { label: "查询科目明细账", requiresPeriod: true, requiresCode: true },
};

export function queryStatus(nodeId) {
  if (Object.prototype.hasOwnProperty.call(IMPLEMENTED_QUERIES, nodeId)) {
    return { status: "available", origin: "upstream", ...IMPLEMENTED_QUERIES[nodeId] };
  }
  if (Object.prototype.hasOwnProperty.call(UNIMPLEMENTED_QUERIES, nodeId)) {
    return { status: "unavailable", origin: "upstream", note: UNIMPLEMENTED_QUERIES[nodeId] };
  }
  if (Object.prototype.hasOwnProperty.call(LOCAL_QUERIES, nodeId)) {
    return { status: "available", origin: "local", ...LOCAL_QUERIES[nodeId] };
  }
  return null; // 未知能力
}

// ---------------------------------------------------------------- 参数校验
function typeOk(v, t) {
  for (const ty of [].concat(t)) {
    if (ty === "string" && typeof v === "string") return true;
    if (ty === "integer" && Number.isInteger(v)) return true;
    if (ty === "number" && typeof v === "number" && Number.isFinite(v)) return true;
    if (ty === "boolean" && typeof v === "boolean") return true;
    if (ty === "object" && v && typeof v === "object" && !Array.isArray(v)) return true;
    if (ty === "array" && Array.isArray(v)) return true;
  }
  return false;
}

/** 最小运行时校验：必填、类型、枚举。返回问题字符串数组，空数组表示通过。 */
export function validateArgs(schema, args) {
  const problems = [];
  if (!schema || schema.type !== "object") return problems;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return ["arguments 必须是 JSON 对象"];
  for (const key of schema.required || []) {
    const v = args[key];
    if (v === undefined || v === null || v === "") problems.push(`缺少必填参数：${key}`);
  }
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    if (prop.type && !typeOk(v, prop.type)) {
      problems.push(`参数 ${key} 类型应为 ${[].concat(prop.type).join(" | ")}`);
      continue;
    }
    if (prop.enum && !prop.enum.includes(v)) problems.push(`参数 ${key} 只能是：${prop.enum.join(" / ")}`);
  }
  return problems;
}
