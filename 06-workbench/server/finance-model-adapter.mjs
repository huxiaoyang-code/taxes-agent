// finance-model-adapter.mjs — 普通财务工具的「模型边界适配层」（**未挂载到 HTTP / MCP**）。
//
// 职责：把 agent-tools.mjs 的普通财务工具调用变成**模型通道信封**。
//   - 注入 `executeRaw(name, args)`（生产环境由接线方注入真实的 `callAgentTool`），
//     本模块**不 import agent-tools.mjs**，避免形成循环依赖，也不复制业务计算 / DB 访问 /
//     输入业务校验 / 事务；
//   - 所有成功结果都经 finance-output-policy.mjs 的字段 + 值形状白名单投影，
//     原数据只留在本机进程内引用后面（本机通道 localRead / localCompute 由 policy 实例提供）；
//   - 未知工具、税务工具、未实现工具、未知/未实现 finance_query node 一律**不执行**，
//     返回固定错误码；不通过禁用主要业务工具来“完成任务”。
//
// 边界之外（本模块不做，接线任务负责）：
//   - 不挂 HTTP / Agent / MCP / CLI 路由，不签发/读取本机 channel；
//   - 不执行任何税务工具（tax_* 属既有税务链路，行为不变）；
//   - 不复制 accounting.mjs 的任何算法，不改记账结果与返回结构。
//
// 写语义：`callAgentTool` 是 async，**禁止** `policy.runWrite(() => callAgentTool(...))`
// （回调返回 Promise，写没发生就已被当成功包装）。这里统一按
// 「先做所有可预验校验 → await 真实写一次 → 再做投影/引用」的顺序，包装阶段失败只降级，
// 绝不把已发生的写报成失败，也绝不重复执行写。
import { Buffer } from "node:buffer";
import { types } from "node:util";
import {
  FinanceOutputPolicy,
  OUTPUT_POLICY_VERSION,
  PROJECTION_NUMBER_LIMIT,
  SUPPORTED_OPERATIONS,
  OutputPolicyError,
  enumTokenOf,
  isPeriodEndCheckConsistent,
  safeErrorProjection,
  sanitizeProjection,
  summarizeQueryResult,
  summarizeWriteResult,
} from "./finance-output-policy.mjs";

export const MODEL_ADAPTER_VERSION = "finance-model-adapter/v1";
/** 全局上下文（account_context）分页上限：必须显式有界，避免一次吐出全部账套。 */
export const MAX_CONTEXT_PAGE_SIZE = 32;
export const DEFAULT_CONTEXT_PAGE_SIZE = 10;
/** 税务工具只用于「精确拒绝原因」，绝不用前缀允许任何未登记操作。 */
export const TAX_TOOL_PREFIX = "tax_";

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const prop = (obj, key) => {
  if (obj === null || typeof obj !== "object") return undefined;
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return desc && own(desc, "value") ? desc.value : undefined;
};
const intOf = (obj, key) => {
  const value = prop(obj, key);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};
const textOf = (obj, key) => {
  const value = prop(obj, key);
  return typeof value === "string" ? value : undefined;
};
const listLen = (list) => {
  const length = prop(list, "length");
  return Number.isSafeInteger(length) && length >= 0 ? length : 0;
};
const periodOf = (obj, key) => {
  const value = textOf(obj, key);
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : undefined;
};
/** 账套上下文的必需期间：非法 / 缺失一律 model_result_invalid（与 global 账套列表一致）。 */
const requirePeriod = (obj, key) => {
  const value = periodOf(obj, key);
  if (value === undefined) throw policyError("model_result_invalid");
  return value;
};
/**
 * 可投影的 ID 范围：projection 的有限数值上限（policy 的 1e12）。
 * 超过上限的 ID 会被白名单消毒丢弃，模型就会看到「returnedCount=1 但 accountSetIds:[]」，
 * 既无法选择又没有任何提示。这里**明确拒绝不可表示值**（model_result_invalid），
 * 而不是静默删掉必需的选择信息，也不去编造 / 截断 ID。
 */
const MAX_PROJECTED_ID = PROJECTION_NUMBER_LIMIT;
const projectedIdOf = (obj, key) => {
  const id = intOf(obj, key);
  return id !== undefined && id <= MAX_PROJECTED_ID ? id : undefined;
};
const requireProjectedId = (obj, key) => {
  const id = projectedIdOf(obj, key);
  if (id === undefined) throw policyError("model_result_invalid");
  return id;
};
const isPlainArgs = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const policyError = (code) => new OutputPolicyError(code, code);

// ---------------------------------------------------------------- 参数快照（预验与执行必须看到同一份值）
// `callModelTool` 是 async：如果直接把调用方对象交给 executeRaw，调用方可以在 Promise 挂起期间
// 改 `args.accountSetId`（或嵌套 entries），形成“预验 A、执行 B”的串账。这里在任何异步边界之前
// 复制出一份只含自有 data 属性的稳定快照，并拒绝访问器 / 原型 / 别名冲突 / 超量形状。
const MAX_ARG_DEPTH = 32;
const MAX_ARG_NODES = 200000;
const MAX_ARG_BYTES = 4 * 1024 * 1024;
const MAX_ARG_ARRAY = 20000;
const BLOCKED_ARG_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function normalizeAccountSetIdValue(raw) {
  let id;
  if (typeof raw === "number") id = raw;
  else if (typeof raw === "string" && raw.trim() !== "") id = Number(raw);
  else throw policyError("account_set_id_invalid");
  if (!Number.isSafeInteger(id) || id <= 0) throw policyError("account_set_id_invalid");
  return id;
}

function snapshotArguments(args, { strictAccountScope = false } = {}) {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set();
  const walk = (value, depth) => {
    nodes++;
    bytes += 8;
    if (nodes > MAX_ARG_NODES || bytes > MAX_ARG_BYTES) throw policyError("model_arguments_invalid");
    if (value === null) return null;
    const type = typeof value;
    if (type === "string") {
      bytes += Buffer.byteLength(value, "utf8");
      if (bytes > MAX_ARG_BYTES) throw policyError("model_arguments_invalid");
      return value;
    }
    if (type === "number") {
      if (!Number.isFinite(value)) throw policyError("model_arguments_invalid");
      return value;
    }
    if (type === "boolean") return value;
    if (type === "undefined") { if (strictAccountScope) throw policyError("model_arguments_invalid"); return undefined; }
    if (type !== "object" || strictAccountScope && types.isProxy(value)) throw policyError("model_arguments_invalid");
    if (depth > MAX_ARG_DEPTH || ancestors.has(value)) throw policyError("model_arguments_invalid");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const length = prop(value, "length");
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARG_ARRAY) {
          throw policyError("model_arguments_invalid");
        }
        const keys = Object.keys(value);
        if (keys.length !== length) throw policyError("model_arguments_invalid");
        if (Object.getOwnPropertySymbols(value).length > 0) throw policyError("model_arguments_invalid");
        const out = new Array(length);
        for (let i = 0; i < length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (!descriptor || !own(descriptor, "value")) throw policyError("model_arguments_invalid");
          bytes += Buffer.byteLength(String(i), "utf8");
          out[i] = walk(descriptor.value, depth + 1);
        }
        return out;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw policyError("model_arguments_invalid");
      if (Object.getOwnPropertySymbols(value).length > 0) throw policyError("model_arguments_invalid");
      const out = Object.create(null);
      for (const key of Object.keys(value)) {
        if (BLOCKED_ARG_KEYS.has(key)) throw policyError("model_arguments_invalid");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !own(descriptor, "value")) throw policyError("model_arguments_invalid");
        bytes += Buffer.byteLength(key, "utf8");
        if (bytes > MAX_ARG_BYTES) throw policyError("model_arguments_invalid");
        const child = walk(descriptor.value, depth + 1);
        if (child !== undefined) out[key] = child;
      }
      return out;
    } finally {
      ancestors.delete(value);
    }
  };
  const snapshot = walk(args, 0);
  // 两个别名只能有一个规范化值：冲突直接拒绝，避免预验与真实工具各读一个。
  const camel = prop(snapshot, "accountSetId");
  const snake = prop(snapshot, "account_set_id");
  if (strictAccountScope && ["accountSetId", "account_set_id"].some(k => own(snapshot,k) && (prop(snapshot,k) === null || prop(snapshot,k) === ""))) throw policyError("account_set_id_invalid");
  const camelPresent = camel !== undefined && camel !== null && camel !== "";
  const snakePresent = snake !== undefined && snake !== null && snake !== "";
  delete snapshot.account_set_id;
  if (!camelPresent && !snakePresent) {
    delete snapshot.accountSetId;
  } else if (camelPresent && snakePresent) {
    const a = normalizeAccountSetIdValue(camel);
    const b = normalizeAccountSetIdValue(snake);
    if (a !== b) throw policyError("account_set_id_conflict");
    snapshot.accountSetId = a;
  } else {
    snapshot.accountSetId = normalizeAccountSetIdValue(camelPresent ? camel : snake);
  }
  return snapshot;
}

// ---------------------------------------------------------------- finance_query node 登记表
// 与 agent-tools.mjs 的 QUERY / QUERY_UNIMPLEMENTED 一一对应（本模块不 import 它，因此需
// 保持同步；测试会用真实 agent-tools 的 finance_query_catalog 与调用计数交叉核对）。
export const FINANCE_QUERY_AVAILABLE = Object.freeze([
  "enterprise_account.account_set",
  "enterprise_account.subject_system.all",
  "voucher.generated.list",
  "voucher.generated.summary",
  "voucher.draft.summary",
  "voucher.detail",
  "report.balance_sheet",
  "report.income_statement",
  "report.cash_flow_statement",
  "period_end.summary",
  "report.trial_balance",
  "ledger.general",
]);
export const FINANCE_QUERY_UNIMPLEMENTED = Object.freeze([
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
export const FINANCE_QUERY_LOCAL_EXTENSIONS = Object.freeze(["report.trial_balance", "ledger.general"]);
const FINANCE_QUERY_NODES = (() => {
  const table = Object.create(null);
  for (const nodeId of FINANCE_QUERY_AVAILABLE) table[nodeId] = "available";
  for (const nodeId of FINANCE_QUERY_UNIMPLEMENTED) table[nodeId] = "unimplemented";
  return Object.freeze(table);
})();

// 模块加载时的静态自检：每个可用 node 都必须有 policy 白名单 spec，避免出现“有入口没投影”
// 而退化成空对象假成功的路径。全部是代码常量，不含任何业务数据。
for (const nodeId of FINANCE_QUERY_AVAILABLE) {
  const operation = `finance_query:${nodeId}`;
  if (!SUPPORTED_OPERATIONS.query.includes(operation)) {
    throw new Error(`finance-model-adapter: finance_query node 缺少 policy 投影 spec（${operation}）`);
  }
}

// ---------------------------------------------------------------- 普通工具 → operation 映射
// category：
//   static    —— 固定静态安全目录 / 只由入参计数派生，不执行 executeRaw；
//   context   —— 合法全局操作（无 setId 时为明确 global scope，不伪造 setId）；
//   node_query—— finance_query，operation 由已登记 nodeId 决定；
//   query     —— 账套内只读工具；
//   batch_query—— 批次审计只读，账套由**真实结果**确定；
//   write     —— 账套内写动作（setId 来自入参并先验）；
//   create    —— 可能建新账套的写动作（setId 只能来自真实结果，缺失即未绑定）。
const tool = (operation, category, scope) => Object.freeze({ operation, category, scope });
export const PLAIN_MODEL_TOOLS = Object.freeze({
  auxiliary_entities: tool("auxiliary_entities", "query", "account_set"),
  auxiliary_entries: tool("auxiliary_entries", "query", "account_set"),
  auxiliary_ledger: tool("auxiliary_ledger", "query", "account_set"),
  auxiliary_party: tool("auxiliary_party", "query", "account_set"),
  auxiliary_entity_create: tool("auxiliary_entity_create", "write", "account_set"),
  auxiliary_entity_update: tool("auxiliary_entity_update", "write", "account_set"),
  auxiliary_allocate: tool("auxiliary_allocate", "write", "account_set"),
  auxiliary_requirement_set: tool("auxiliary_requirement_set", "write", "account_set"),
  finance_query_catalog: tool("finance_query_catalog", "static", "global"),
  update_plan: tool("update_plan", "static", "global"),
  account_context: tool("account_context", "context", "context"),
  finance_context_resolve: tool("finance_context_resolve", "context", "context"),
  finance_query: tool(null, "node_query", "account_set"),
  voucher_check: tool("voucher_check", "query", "account_set"),
  account_list: tool("account_list", "query", "account_set"),
  opening_balance_get: tool("opening_balance_get", "query", "account_set"),
  period_list: tool("period_list", "query", "account_set"),
  ledger_query: tool("ledger_query", "query", "account_set"),
  asset_list: tool("asset_list", "query", "account_set"),
  // LOCAL-02 新增只读期末检查：与封账前置同一规则，输出仅经固定白名单投影。
  period_end_check: tool("period_end_check", "query", "account_set"),
  book_import_batch: tool("book_import_batch", "batch_query", "batch"),
  voucher_create: tool("voucher_create", "write", "account_set"),
  voucher_post: tool("voucher_post", "write", "account_set"),
  voucher_unpost: tool("voucher_unpost", "write", "account_set"),
  voucher_delete: tool("voucher_delete", "write", "account_set"),
  period_set_status: tool("period_set_status", "write", "account_set"),
  opening_balance_set: tool("opening_balance_set", "write", "account_set"),
  account_create: tool("account_create", "write", "account_set"),
  asset_create: tool("asset_create", "write", "account_set"),
  // LOCAL-02 新增资产维护：明确归为写动作，只有显式写调用才执行；
  // 未知 / 只读工具不会因名称相似被当成写执行。
  asset_update: tool("asset_update", "write", "account_set"),
  depreciation_run: tool("depreciation_run", "write", "account_set"),
  carry_forward_profit: tool("carry_forward_profit", "write", "account_set"),
  account_set_create: tool("account_set_create", "create", "result"),
  legacy_book_import: tool("legacy_book_import", "create", "result"),
  book_import_incremental: tool("book_import_incremental", "create", "result"),
});

// agent-tools.mjs 里明确未实现的普通工具（税务前缀的声明查询走税务拒绝分支）：
// 不执行、不伪造成功，只回固定「未实现」状态。
export const UNIMPLEMENTED_MODEL_TOOLS = Object.freeze([
  "declaration_query",
  "exec",
  "finance_task_status",
  "invoice_collect",
  "invoice_file",
  "invoice_issue",
  "invoice_issue_result",
  "invoice_precheck",
  "invoice_red_apply",
  "invoice_red_issue",
  "invoice_red_status",
  "invoice_tax_code",
]);
const UNIMPLEMENTED_TOOL_SET = new Set(UNIMPLEMENTED_MODEL_TOOLS);

export const MODEL_TOOL_INVENTORY = Object.freeze({
  version: MODEL_ADAPTER_VERSION,
  projected: Object.freeze(Object.keys(PLAIN_MODEL_TOOLS).filter((name) => {
    const category = PLAIN_MODEL_TOOLS[name].category;
    return category === "query" || category === "node_query" || category === "batch_query";
  }).sort()),
  static: Object.freeze(Object.keys(PLAIN_MODEL_TOOLS)
    .filter((name) => PLAIN_MODEL_TOOLS[name].category === "static").sort()),
  context: Object.freeze(Object.keys(PLAIN_MODEL_TOOLS)
    .filter((name) => PLAIN_MODEL_TOOLS[name].category === "context").sort()),
  write: Object.freeze(Object.keys(PLAIN_MODEL_TOOLS)
    .filter((name) => PLAIN_MODEL_TOOLS[name].category === "write").sort()),
  create: Object.freeze(Object.keys(PLAIN_MODEL_TOOLS)
    .filter((name) => PLAIN_MODEL_TOOLS[name].category === "create").sort()),
  unimplemented: UNIMPLEMENTED_MODEL_TOOLS,
  financeQuery: Object.freeze({
    available: FINANCE_QUERY_AVAILABLE,
    unimplemented: FINANCE_QUERY_UNIMPLEMENTED,
    localExtensions: FINANCE_QUERY_LOCAL_EXTENSIONS,
  }),
  taxTools: Object.freeze({
    policy: "excluded_from_this_adapter",
    reason: "税务链路保持既有行为；适配器既不调用也不以 tax_ 前缀放行任何未登记操作",
  }),
});

/** operation 只能来自代码常量：错误投影里也只回声这里已登记的字符串。 */
const REGISTERED_OPERATIONS = new Set([
  ...SUPPORTED_OPERATIONS.query,
  ...SUPPORTED_OPERATIONS.write,
  "finance_query_catalog",
  "update_plan",
  "account_context",
  "finance_context_resolve",
]);

// ---------------------------------------------------------------- 参数边界
/**
 * 账套 ID 必须显式给正整数（与 agent-tools 一样绝不猜默认账套），但这里在**执行前**校验：
 * 只接受 number 或数字字符串，避免 `Number(true) === 1` 之类的隐式转换选错账套。
 */
function readAccountSetId(args, { required }) {
  const raw = prop(args, "accountSetId");
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw policyError("account_set_id_required");
    return null;
  }
  return normalizeAccountSetIdValue(raw);
}

/** 全局上下文分页：有界、可继续选择；超界明确拒绝而不是静默少给。 */
function readPage(args) {
  const rawLimit = prop(args, "limit");
  const rawOffset = prop(args, "offset");
  let limit = DEFAULT_CONTEXT_PAGE_SIZE;
  let offset = 0;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (!Number.isSafeInteger(rawLimit) || rawLimit <= 0 || rawLimit > MAX_CONTEXT_PAGE_SIZE) {
      throw policyError("model_context_page_invalid");
    }
    limit = rawLimit;
  }
  if (rawOffset !== undefined && rawOffset !== null) {
    if (!Number.isSafeInteger(rawOffset) || rawOffset < 0 || rawOffset > 1_000_000) {
      throw policyError("model_context_page_invalid");
    }
    offset = rawOffset;
  }
  return { offset, limit };
}

// ---------------------------------------------------------------- 结果形状 / 可信 ID 解析
// 只校验「这个工具的 DTO 必需字段是否存在 / 类型对不对」，**不重算业务值、不看原文字段**。
// 目的：真实 DTO 意外变形时显式失败，而不是投影出一份静默为 0 / 空的“假报表”。
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasNumber = (obj, key) => typeof prop(obj, key) === "number" && Number.isFinite(prop(obj, key));
const hasText = (obj, key) => typeof prop(obj, key) === "string";
const hasAllNumbers = (obj, keys) => keys.every((key) => hasNumber(obj, key));
const hasBoolean = (obj, key) => typeof prop(obj, key) === "boolean";
const hasProjectedId = (obj, key) => projectedIdOf(obj, key) !== undefined;
const hasEntriesShape = (items) => Array.isArray(items) && items.every((item) => isRecord(item)
  && hasNumber(item, "debit") && hasNumber(item, "credit"));
const hasLedgerShape = (value) => isRecord(value) && Array.isArray(prop(value, "items"))
  && hasEntriesShape(prop(value, "items")) && isRecord(prop(value, "opening"))
  && hasNumber(prop(value, "opening"), "debit") && hasNumber(prop(value, "opening"), "credit")
  && hasText(value, "direction") && hasText(value, "period");
// 期末检查只读 DTO：结构 + `ready` / 步骤 / 阻塞的**全局一致性**由 policy 的纯函数校验
// （与本模块同属纯模块，不 import period-end-controls.mjs，避免把会打开业务 DB 的模块
// 拉进模型边界）。缺步骤 / 重复步骤 / 未知状态 / ready 与 blocking 或 blocked 步骤矛盾 /
// 阻塞不归属到真实 blocked 步骤，一律视为结果无效，不建引用。
const hasPeriodEndCheckShape = (value) => isRecord(value) && hasText(value, "period")
  && isPeriodEndCheckConsistent(value);

const PLAIN_QUERY_SHAPES = Object.freeze({
  auxiliary_entities: value => summarizeQueryResult("auxiliary_entities",value).summaryUnavailable === false,
  auxiliary_entries: value => summarizeQueryResult("auxiliary_entries",value).summaryUnavailable === false,
  auxiliary_ledger: value => summarizeQueryResult("auxiliary_ledger",value).summaryUnavailable === false,
  auxiliary_party: value => summarizeQueryResult("auxiliary_party",value).summaryUnavailable === false,
  voucher_check: (value) => typeof prop(value, "ok") === "boolean"
    && hasNumber(value, "total_debit") && hasNumber(value, "total_credit") && Array.isArray(prop(value, "errors")),
  account_list: (value) => Array.isArray(prop(value, "items")),
  opening_balance_get: (value) => Array.isArray(prop(value, "items"))
    && hasEntriesShape(prop(value, "items")),
  period_list: (value) => Array.isArray(prop(value, "items"))
    && prop(value, "items").every((item) => isRecord(item) && hasText(item, "status")),
  ledger_query: hasLedgerShape,
  period_end_check: hasPeriodEndCheckShape,
  asset_list: (value) => Array.isArray(value) && value.every((item) => isRecord(item)
    && hasText(item, "kind") && hasNumber(item, "original_cost")
    && hasNumber(item, "accumulated") && hasNumber(item, "remaining")),
  book_import_batch: (value) => isRecord(prop(value, "batch")) && Array.isArray(prop(value, "sourceTrace")),
});

const FINANCE_QUERY_SHAPES = Object.freeze({
  "enterprise_account.account_set": (data) => isRecord(data) && hasProjectedId(data, "id")
    && hasText(data, "start_period") && hasText(data, "name")
    && hasText(data, "taxpayer_type") && hasText(data, "accounting_standard"),
  "enterprise_account.subject_system.all": (data) => Array.isArray(data) && listLen(data) > 0
    && data.every((item) => isRecord(item) && hasText(item, "category")
      && hasNumber(item, "is_leaf") && hasNumber(item, "contra")),
  // 凭证列表 / 汇总允许真的为空（那是真实业务状态，不是变形）。
  "voucher.generated.list": (data) => Array.isArray(data),
  "voucher.generated.summary": (data) => Array.isArray(data),
  "voucher.draft.summary": (data) => Array.isArray(data),
  "voucher.detail": (data) => isRecord(data) && hasNumber(data, "id")
    && hasText(data, "period") && hasText(data, "status") && hasEntriesShape(prop(data, "entries")),
  "report.balance_sheet": (data) => isRecord(data) && Array.isArray(prop(data, "assets"))
    && Array.isArray(prop(data, "liabilities")) && isRecord(prop(data, "totals"))
    && hasAllNumbers(prop(data, "totals"), ["assets", "liabilities", "equity"])
    && hasText(data, "period"),
  "report.income_statement": (data) => isRecord(data) && isRecord(prop(data, "current"))
    && isRecord(prop(data, "ytd"))
    && hasAllNumbers(prop(data, "current"), [
      "营业收入", "营业成本", "销售费用", "管理费用", "财务费用", "利润总额", "净利润",
    ])
    && hasAllNumbers(prop(data, "ytd"), ["营业收入", "净利润"])
    && hasText(data, "period"),
  "report.cash_flow_statement": (data) => isRecord(data) && isRecord(prop(data, "totals"))
    && isRecord(prop(data, "cash")) && Array.isArray(prop(data, "operating"))
    && Array.isArray(prop(data, "investing")) && Array.isArray(prop(data, "financing"))
    && hasAllNumbers(prop(data, "totals"), ["operating", "investing", "financing", "net_increase"])
    && hasAllNumbers(prop(data, "cash"), ["begin", "end"])
    && hasBoolean(data, "reconciles") && hasText(data, "period"),
  "period_end.summary": (data) => isRecord(data) && Array.isArray(prop(data, "periods"))
    && prop(data, "periods").every((item) => isRecord(item) && hasText(item, "status"))
    && isRecord(prop(data, "trial_balance")) && isRecord(prop(prop(data, "trial_balance"), "totals"))
    && hasAllNumbers(prop(prop(data, "trial_balance"), "totals"), ["closing_debit", "closing_credit"])
    && hasText(prop(data, "trial_balance"), "period"),
  "report.trial_balance": (data) => isRecord(data) && Array.isArray(prop(data, "lines"))
    && isRecord(prop(data, "totals")) && hasAllNumbers(prop(data, "totals"), [
      "opening_debit", "opening_credit", "period_debit", "period_credit", "closing_debit", "closing_credit",
    ]) && hasText(data, "period"),
  "ledger.general": hasLedgerShape,
});

/** 从**真实结果**里取账套 ID：只认登记过的可信字段，且必须是正安全整数。 */
function resolveCreateAccountSetId(operation, value) {
  const created = prop(value, "created");
  if (operation === "account_set_create") return intOf(value, "id") ?? null;
  if (operation === "legacy_book_import") return intOf(created, "id") ?? null;
  if (operation === "book_import_incremental") {
    const ids = [[created,"accountSetId"],[value,"accountSetId"],[prop(value,"batch"),"accountSetId"]]
      .filter(([obj,key]) => prop(obj,key) !== undefined && prop(obj,key) !== null)
      .map(([obj,key]) => { const id = intOf(obj,key); if (id === undefined) throw policyError("model_result_invalid"); return id; });
    if (ids.some(id => id !== ids[0])) throw policyError("model_scope_mismatch");
    return intOf(created, "accountSetId")
      ?? intOf(value, "accountSetId")
      ?? intOf(prop(value, "batch"), "accountSetId")
      ?? null;
  }
  return null;
}

/** 普通写动作的结果里若回显账套，必须是同一个账套（否则不绑定引用，但仍如实报 applied）。 */
function resolveEchoedAccountSetId(value) {
  return intOf(value, "account_set_id") ?? intOf(value, "accountSetId") ?? null;
}

/** 批次审计：账套只能由真实结果确定（batch.accountSetId）。 */
function resolveBatchAccountSetId(value) {
  return intOf(prop(value, "batch"), "accountSetId") ?? null;
}

// ---------------------------------------------------------------- data 层归属核对
/**
 * finance_query 的真实返回是 `{ nodeId, label, data }`：wrapper 里**没有**账套字段，
 * 只核对 wrapper 会漏掉「请求 A 却拿到 B 的 data」。这里按具体 node 的**已知可信字段**核对：
 *   - 账套节点：`data.id`
 *   - 凭证节点：`data.account_set_id`（列表节点逐行核对）
 *   - 科目体系：逐行 `account_set_id`
 * 只核对**真实存在**的可信字段；报表 / 试算 / 明细账 / 期末等聚合 DTO 没有账套字段，
 * 不臆造必需字段（那会把合法聚合节点全部拒绝）。字段存在但类型不对同样按结果无效处理。
 */
const scopedIdOf = (row, key) => {
  if (!own(row, key)) return undefined;
  const id = intOf(row, key);
  if (id === undefined) throw policyError("model_result_invalid");
  return id;
};
const rowScopeIds = (rows) => {
  const ids = [];
  const length = listLen(rows);
  for (let i = 0; i < length; i++) {
    const id = scopedIdOf(prop(rows, i), "account_set_id");
    if (id !== undefined) ids.push(id);
  }
  return ids;
};
const FINANCE_QUERY_DATA_SCOPE = Object.freeze({
  "enterprise_account.account_set": (data) => {
    const id = scopedIdOf(data, "id");
    return id === undefined ? [] : [id];
  },
  "enterprise_account.subject_system.all": (data) => rowScopeIds(data),
  "voucher.generated.list": (data) => rowScopeIds(data),
  "voucher.generated.summary": (data) => rowScopeIds(data),
  "voucher.draft.summary": (data) => rowScopeIds(data),
  "voucher.detail": (data) => {
    const id = scopedIdOf(data, "account_set_id");
    return id === undefined ? [] : [id];
  },
});
// 普通只读工具里**同样带可信账套字段**的 DTO（列表行 account_set_id）。
const PLAIN_QUERY_DATA_SCOPE = Object.freeze({
  auxiliary_entities: value => [scopedIdOf(value,"accountSetId"), ...rowScopeIds(prop(value,"items"))],
  auxiliary_entries: value => [scopedIdOf(value,"accountSetId")],
  auxiliary_ledger: value => [scopedIdOf(value,"accountSetId")],
  auxiliary_party: value => [scopedIdOf(value,"accountSetId")],
  account_list: (value) => rowScopeIds(prop(value, "items")),
  asset_list: (value) => rowScopeIds(value),
});

// ---------------------------------------------------------------- 信封构造
const rawValuesIncluded = false;

function failure(code, { tool: toolName, operation, category, scope, accountSetId, executed, nodeId } = {}) {
  const registered = typeof operation === "string" && REGISTERED_OPERATIONS.has(operation) ? operation : undefined;
  return envelopeFromSafeError(
    safeErrorProjection(new OutputPolicyError(code, code), registered ? { operation: registered } : {}),
    { tool: toolName, category, scope, accountSetId, executed, nodeId },
  );
}

function envelopeFromSafeError(base, { tool: toolName, category, scope, accountSetId, executed, nodeId } = {}) {
  const envelope = { ...base, adapter: MODEL_ADAPTER_VERSION, channel: "model", rawValuesIncluded };
  if (toolName) envelope.tool = toolName;
  if (category) envelope.operationCategory = category;
  if (scope) envelope.scope = scope;
  if (nodeId && own(FINANCE_QUERY_NODES, nodeId)) envelope.nodeId = nodeId;
  if (accountSetId !== undefined && accountSetId !== null) envelope.accountSetId = accountSetId;
  if (category === "write" || category === "create") {
    const beforeExecution = executed !== true;
    envelope.applied = beforeExecution ? false : "unknown";
    // 与 policy 的无引用摘要保持一致：只要不是 applied:true 就必须标记本机复核。
    envelope.needsLocalReview = true;
    envelope.appliedReason = beforeExecution ? "rejected_before_execution" : "unverified_result";
    envelope.projection = Object.freeze({});
    envelope.projectionDropped = 0;
    envelope.localRef = null;
    envelope.refPersistence = "none";
    envelope.refUnavailable = beforeExecution ? "not_executed" : "outcome_unknown";
  }
  return envelope;
}

function failureFromError(error, context = {}) {
  // safeErrorProjection 自己按固定 allowlist 读取 code / message 作为查表键，永不回声原文。
  const registered = typeof context.operation === "string" && REGISTERED_OPERATIONS.has(context.operation)
    ? context.operation
    : undefined;
  return envelopeFromSafeError(
    safeErrorProjection(error, registered ? { operation: registered } : {}),
    context,
  );
}

function unboundEnvelope({ tool: toolName, operation, category, scope, projection, projectionDropped, summary, refUnavailable }) {
  const envelope = {
    ok: true,
    outputPolicy: OUTPUT_POLICY_VERSION,
    adapter: MODEL_ADAPTER_VERSION,
    channel: "model",
    tool: toolName,
    operation,
    operationCategory: category,
    scope,
    accountSetId: null,
    projection,
    projectionDropped,
    localRef: null,
    refPersistence: "none",
    refUnavailable,
    rawValuesIncluded,
  };
  if (summary) {
    envelope.applied = summary.applied;
    envelope.needsLocalReview = summary.needsLocalReview;
    if (summary.appliedReason) envelope.appliedReason = summary.appliedReason;
  }
  return envelope;
}

function unboundWriteEnvelope(toolName, operation, summary, refUnavailable) {
  return unboundEnvelope({
    tool: toolName,
    operation,
    category: "write",
    scope: "account_set",
    projection: summary.projection,
    projectionDropped: summary.projectionDropped,
    summary,
    refUnavailable,
  });
}

// ---------------------------------------------------------------- 静态目录 / 计划摘要
function buildStaticCatalog(toolName) {
  const projection = sanitizeProjection({
    availableCount: FINANCE_QUERY_AVAILABLE.length,
    unimplementedCount: FINANCE_QUERY_UNIMPLEMENTED.length,
    localExtensionCount: FINANCE_QUERY_LOCAL_EXTENSIONS.length,
    staticCatalog: true,
  });
  return {
    ok: true,
    outputPolicy: OUTPUT_POLICY_VERSION,
    adapter: MODEL_ADAPTER_VERSION,
    channel: "model",
    tool: toolName,
    operation: "finance_query_catalog",
    operationCategory: "static",
    scope: "global",
    accountSetId: null,
    // 目录项全部是代码常量（nodeId），不含任何业务数据；模型据此选择 nodeId。
    catalog: Object.freeze({
      available: FINANCE_QUERY_AVAILABLE,
      unimplemented: FINANCE_QUERY_UNIMPLEMENTED,
      localExtensions: FINANCE_QUERY_LOCAL_EXTENSIONS,
    }),
    projection: projection.value,
    projectionDropped: projection.dropped,
    localRef: null,
    refPersistence: "none",
    refUnavailable: "global_scope",
    rawValuesIncluded,
  };
}

/** update_plan：用户任意文本只转成状态/计数，绝不回显入参计划内容，也不落库。 */
function buildPlanSummary(toolName, args) {
  const plan = prop(args, "plan");
  const planItemCount = Array.isArray(plan) ? Math.min(listLen(plan), 1000) : 0;
  const projection = sanitizeProjection({
    status: "not_persisted",
    persisted: false,
    saved: false,
    planItemCount,
  });
  return {
    ok: true,
    outputPolicy: OUTPUT_POLICY_VERSION,
    adapter: MODEL_ADAPTER_VERSION,
    channel: "model",
    tool: toolName,
    operation: "update_plan",
    operationCategory: "static",
    scope: "global",
    accountSetId: null,
    projection: projection.value,
    projectionDropped: projection.dropped,
    localRef: null,
    refPersistence: "none",
    refUnavailable: "global_scope",
    rawValuesIncluded,
  };
}

// ---------------------------------------------------------------- 全局 / 指定账套上下文
function findAccountSet(sets, id) {
  const length = listLen(sets);
  for (let i = 0; i < length; i++) {
    const entry = prop(sets, i);
    if (intOf(entry, "id") === id) return entry;
  }
  return null;
}

function buildAccountSetPage(sets, page) {
  const total = listLen(sets);
  const accountSetIds = [];
  const startPeriods = [];
  const taxpayerTypes = [];
  const accountingStandards = [];
  const displayNameFlags = [];
  for (let i = page.offset; i < total && accountSetIds.length < page.limit; i++) {
    const entry = prop(sets, i);
    // 结构异常 / 不可投影的账套行不静默跳过（那会悄悄漏账套），直接失败，让调用方修根因。
    const id = requireProjectedId(entry, "id");
    const startPeriod = requirePeriod(entry, "start_period");
    accountSetIds.push(id);
    startPeriods.push(startPeriod);
    taxpayerTypes.push(enumTokenOf("taxpayer", textOf(entry, "taxpayer_type")) ?? "unknown");
    accountingStandards.push(enumTokenOf("standard", textOf(entry, "accounting_standard")) ?? "unknown");
    displayNameFlags.push((textOf(entry, "name") || "").length > 0);
  }
  const returnedCount = accountSetIds.length;
  const hasNextPage = page.offset + returnedCount < total;
  const projection = sanitizeProjection({
    scope: "global",
    accountSetCount: total,
    returnedCount,
    pageOffset: page.offset,
    pageLimit: page.limit,
    truncated: hasNextPage,
    hasNextPage,
    ...(hasNextPage ? { nextOffset: page.offset + returnedCount } : {}),
    accountSetIds,
    startPeriods,
    taxpayerTypes,
    accountingStandards,
    displayNameFlags,
    selectionRequirement: "explicit_account_set_id",
    persisted: false,
  });
  // 真实丢弃数必须回给调用方，不能固定 0（固定 0 会把“选择信息被删”伪装成完整结果）。
  return { projection: projection.value, projectionDropped: projection.dropped };
}

function buildScopedContextProjection(entry, periods) {
  const periodCount = listLen(periods);
  let open = 0;
  let closed = 0;
  for (let i = 0; i < periodCount; i++) {
    const status = enumTokenOf("status", textOf(prop(periods, i), "status"));
    if (status === "open") open++;
    else if (status === "closed") closed++;
    else throw policyError("model_result_invalid");
  }
  const projection = sanitizeProjection({
    scope: "account_set",
    accountSetId: requireProjectedId(entry, "id"),
    startPeriod: requirePeriod(entry, "start_period"),
    taxpayerType: enumTokenOf("taxpayer", textOf(entry, "taxpayer_type")) ?? "unknown",
    accountingStandard: enumTokenOf("standard", textOf(entry, "accounting_standard")) ?? "unknown",
    hasDisplayName: (textOf(entry, "name") || "").length > 0,
    periodCount,
    openPeriodCount: open,
    closedPeriodCount: closed,
    selectionRequirement: "explicit_account_set_id",
    persisted: false,
  });
  return { projection: projection.value, projectionDropped: projection.dropped };
}

// ---------------------------------------------------------------- adapter 工厂
export function createFinanceModelAdapter(options = {}) {
  if (!isPlainArgs(options)) throw new TypeError("finance-model-adapter: options 必须是对象");
  const executeRaw = prop(options, "executeRaw");
  if (typeof executeRaw !== "function") throw new TypeError("finance-model-adapter: 必须注入 executeRaw(name, args)");
  const policy = prop(options, "policy") instanceof FinanceOutputPolicy
    ? prop(options, "policy")
    : new FinanceOutputPolicy(isPlainArgs(prop(options, "policy")) ? prop(options, "policy") : {});

  // -------------------------------------------------------------- 只读：账套内工具
  async function runAccountSetQuery(toolName, spec, args) {
    const operation = spec.operation;
    let executed = false;
    let accountSetId = null;
    try {
      accountSetId = readAccountSetId(args, { required: true });
      executed = true;
      const value = await Promise.resolve().then(() => executeRaw(toolName, args));
      const echoed = resolveEchoedAccountSetId(value);
      if (echoed !== null && echoed !== accountSetId) throw policyError("model_scope_mismatch");
      const shape = PLAIN_QUERY_SHAPES[operation];
      if (typeof shape !== "function" || !shape(value)) throw policyError("model_result_invalid");
      // 已知带账套字段的普通查询 DTO：逐行核对归属（wrapper 回显一致也不代表行数据同属一个账套）。
      const scopeProbe = PLAIN_QUERY_DATA_SCOPE[operation];
      if (typeof scopeProbe === "function") {
        for (const scopedId of scopeProbe(value)) {
          if (scopedId !== accountSetId) throw policyError("model_scope_mismatch");
        }
      }
      const summary = summarizeQueryResult(operation, value);
      if (summary.summaryUnavailable || Object.keys(summary.projection).length === 0) {
        // 不把「没读到预期字段」当成功：否则模型会得到一个静默为 0 / 空的假报表。
        return failure("model_result_invalid", {
          tool: toolName, operation, category: "query", scope: "account_set", accountSetId, executed,
        });
      }
      return {
        ...policy.wrapQuery(operation, { accountSetId, value }),
        adapter: MODEL_ADAPTER_VERSION,
        tool: toolName,
        scope: "account_set",
      };
    } catch (error) {
      return failureFromError(error, {
        tool: toolName, operation, category: "query", scope: "account_set", accountSetId, executed,
      });
    }
  }

  // -------------------------------------------------------------- 只读：finance_query
  async function runFinanceQuery(args) {
    const toolName = "finance_query";
    let executed = false;
    let accountSetId = null;
    let nodeId;
    let operation;
    try {
      nodeId = prop(args, "nodeId");
      if (typeof nodeId !== "string" || nodeId === "") throw policyError("nodeId_required");
      if (!own(FINANCE_QUERY_NODES, nodeId)) throw policyError("model_node_unknown");
      if (FINANCE_QUERY_NODES[nodeId] !== "available") throw policyError("model_node_not_implemented");
      operation = `finance_query:${nodeId}`;
      accountSetId = readAccountSetId(args, { required: true });
      executed = true;
      const result = await Promise.resolve().then(() => executeRaw(toolName, args));
      // 真实返回形状必须是 { nodeId, label, data }：把 wrapper 当报表会静默出 0。
      if (result === null || typeof result !== "object" || Array.isArray(result)) {
        throw policyError("model_result_invalid");
      }
      if (prop(result, "not_implemented") === true) throw policyError("model_node_not_implemented");
      if (prop(result, "nodeId") !== nodeId || !own(result, "data")) throw policyError("model_result_invalid");
      const echoed = resolveEchoedAccountSetId(result);
      if (echoed !== null && echoed !== accountSetId) throw policyError("model_scope_mismatch");
      const data = prop(result, "data");
      const shape = FINANCE_QUERY_SHAPES[nodeId];
      if (typeof shape !== "function" || !shape(data)) throw policyError("model_result_invalid");
      // wrapper 没有账套字段：按具体 node 的可信 data 字段核对归属，不匹配则不建引用。
      const probe = FINANCE_QUERY_DATA_SCOPE[nodeId];
      if (typeof probe === "function") {
        for (const scopedId of probe(data)) {
          if (scopedId !== accountSetId) throw policyError("model_scope_mismatch");
        }
      }
      const summary = summarizeQueryResult(operation, data);
      if (summary.summaryUnavailable || Object.keys(summary.projection).length === 0) {
        throw policyError("model_result_invalid");
      }
      return {
        ...policy.wrapQuery(operation, { accountSetId, value: data }),
        adapter: MODEL_ADAPTER_VERSION,
        tool: toolName,
        scope: "account_set",
        nodeId,
      };
    } catch (error) {
      return failureFromError(error, {
        tool: toolName, operation, category: "query", scope: "account_set", accountSetId, executed, nodeId,
      });
    }
  }

  // -------------------------------------------------------------- 只读：批次审计
  async function runBatchQuery(spec, args) {
    const toolName = "book_import_batch";
    const operation = spec.operation;
    let executed = false;
    try {
      const batchId = prop(args, "batchId") ?? prop(args, "batch_id");
      if (typeof batchId !== "string" || batchId.trim() === "") throw policyError("batchId_required");
      const claimedAccountSetId = readAccountSetId(args, { required: false });
      executed = true;
      const value = await Promise.resolve().then(() => executeRaw(toolName, args));
      const resultAccountSetId = resolveBatchAccountSetId(value);
      // 入参账套只能用于“核对”，绝不能替换结果所属账套。
      if (claimedAccountSetId !== null && resultAccountSetId !== null && claimedAccountSetId !== resultAccountSetId) {
        throw policyError("model_scope_mismatch");
      }
      if (resultAccountSetId === null) {
        const summary = summarizeQueryResult(operation, value);
        if (summary.summaryUnavailable || Object.keys(summary.projection).length === 0) {
          throw policyError("model_result_invalid");
        }
        return unboundEnvelope({
          tool: toolName, operation, category: "query", scope: "batch",
          projection: summary.projection, projectionDropped: summary.projectionDropped,
          refUnavailable: "unbound_scope",
        });
      }
      const summary = summarizeQueryResult(operation, value);
      if (summary.summaryUnavailable || Object.keys(summary.projection).length === 0) {
        throw policyError("model_result_invalid");
      }
      return {
        ...policy.wrapQuery(operation, { accountSetId: resultAccountSetId, value }),
        adapter: MODEL_ADAPTER_VERSION,
        tool: toolName,
        scope: "batch",
        accountSetIdSource: "result",
      };
    } catch (error) {
      return failureFromError(error, { tool: toolName, operation, category: "query", scope: "batch", executed });
    }
  }

  // -------------------------------------------------------------- 只读：全局 / 指定账套上下文
  async function runContextTool(toolName, spec, args) {
    const operation = spec.operation;
    let executed = false;
    let claimedAccountSetId = null;
    try {
      claimedAccountSetId = readAccountSetId(args, { required: false });
      const page = readPage(args);
      executed = true;
      const result = await Promise.resolve().then(() => executeRaw(toolName, args));
      if (result === null || typeof result !== "object" || Array.isArray(result)) throw policyError("model_result_invalid");
      const sets = prop(result, "account_sets");
      if (!Array.isArray(sets)) throw policyError("model_result_invalid");

      if (claimedAccountSetId === null) {
        // 明确的 global scope：不伪造 setId=0/1，也不把全局原文塞进某个账套引用里。
        const pageResult = buildAccountSetPage(sets, page);
        return {
          ok: true,
          outputPolicy: OUTPUT_POLICY_VERSION,
          adapter: MODEL_ADAPTER_VERSION,
          channel: "model",
          tool: toolName,
          operation,
          operationCategory: "context",
          scope: "global",
          accountSetId: null,
          projection: pageResult.projection,
          projectionDropped: pageResult.projectionDropped,
          localRef: null,
          refPersistence: "none",
          refUnavailable: "global_scope",
          rawValuesIncluded,
        };
      }
      const entry = findAccountSet(sets, claimedAccountSetId);
      // 指定账套时必须真实存在（归属校验），不得凭入参伪造一个本机没有的账套。
      if (!entry) throw policyError("account_set_not_found");
      const periods = prop(result, "periods");
      if (!Array.isArray(periods)) throw policyError("model_result_invalid");
      const scopedResult = buildScopedContextProjection(entry, periods);
      return {
        ok: true,
        outputPolicy: OUTPUT_POLICY_VERSION,
        adapter: MODEL_ADAPTER_VERSION,
        channel: "model",
        tool: toolName,
        operation,
        operationCategory: "context",
        scope: "account_set",
        accountSetId: claimedAccountSetId,
        projection: scopedResult.projection,
        projectionDropped: scopedResult.projectionDropped,
        localRef: null,
        refPersistence: "none",
        // 上下文结果本身是全局列表（含其它账套），不能塞进单账套引用。
        refUnavailable: "global_scope",
        rawValuesIncluded,
      };
    } catch (error) {
      return failureFromError(error, {
        tool: toolName, operation, category: "context",
        scope: claimedAccountSetId === null ? "global" : "account_set",
        accountSetId: claimedAccountSetId, executed,
      });
    }
  }

  // -------------------------------------------------------------- 写：账套内动作
  async function runAccountSetWrite(toolName, spec, args) {
    const operation = spec.operation;
    let executed = false;
    let accountSetId = null;
    try {
      // 所有能预验的边界约束在 executeRaw 之前完成；未通过时回调从未执行。
      accountSetId = readAccountSetId(args, { required: true });
      executed = true;
      const value = await Promise.resolve().then(() => executeRaw(toolName, args));
      if (operation.startsWith("auxiliary_")) {
        const id = scopedIdOf(value,"accountSetId");
        const nested = prop(value,"result");
        const nestedId = isRecord(nested) ? scopedIdOf(nested,"account_set_id") : undefined;
        if (id !== accountSetId || nestedId !== undefined && nestedId !== accountSetId) return unboundWriteEnvelope(toolName,operation,summarizeWriteResult(operation,value),"scope_mismatch");
      }
      const echoed = resolveEchoedAccountSetId(value);
      if (echoed !== null && echoed !== accountSetId) {
        // 写已经发生：如实报 applied，但不把引用绑到不一致的账套。
        const summary = summarizeWriteResult(operation, value);
        return unboundWriteEnvelope(toolName, operation, summary, "scope_mismatch");
      }
      try {
        return {
          ...policy.wrapWrite(operation, { accountSetId, value }),
          adapter: MODEL_ADAPTER_VERSION,
          tool: toolName,
          scope: "account_set",
          accountSetIdSource: "argument",
        };
      } catch {
        const summary = summarizeWriteResult(operation, value);
        return unboundWriteEnvelope(toolName, operation, summary, "summary_unavailable");
      }
    } catch (error) {
      return failureFromError(error, {
        tool: toolName, operation, category: "write", scope: "account_set", accountSetId, executed,
      });
    }
  }

  // -------------------------------------------------------------- 写：可能建账套
  async function runCreateTool(toolName, spec, args) {
    const operation = spec.operation;
    let executed = false;
    let claimedAccountSetId = null;
    try {
      // 若调用方给了 accountSetId，只做类型预验（append 模式的目标账套）；null 表示未指定。
      claimedAccountSetId = readAccountSetId(args, { required: false });
      executed = true;
      const value = await Promise.resolve().then(() => executeRaw(toolName, args));
      const resolvedAccountSetId = resolveCreateAccountSetId(operation, value);
      const summary = summarizeWriteResult(operation, value);
      if (resolvedAccountSetId === null) {
        // 默认 dry-run / 校验未通过 / 未真正建账：明确「未绑定」，绝不造假 ID。
        const refUnavailable = summary.applied === false ? "not_applied" : "unbound_scope";
        return unboundWriteEnvelope(toolName, operation, summary, refUnavailable);
      }
      if (claimedAccountSetId !== null && claimedAccountSetId !== resolvedAccountSetId) {
        // 入参账套与真实结果不一致：写已经发生，但绝不能把引用绑到另一个账套。
        return unboundWriteEnvelope(toolName, operation, summary, "scope_mismatch");
      }
      try {
        return {
          ...policy.wrapWrite(operation, { accountSetId: resolvedAccountSetId, value }),
          adapter: MODEL_ADAPTER_VERSION,
          tool: toolName,
          operationCategory: "create",
          scope: "result",
          accountSetIdSource: "result",
        };
      } catch {
        return unboundWriteEnvelope(toolName, operation, summary, "summary_unavailable");
      }
    } catch (error) {
      return failureFromError(error, {
        tool: toolName, operation, category: "create", scope: "result", executed,
      });
    }
  }

  async function callModelTool(name, args = {}) {
    if (typeof name !== "string" || name === "" || !own(PLAIN_MODEL_TOOLS, name)) {
      // 税务链路保持既有行为：这里既不调用也不放行；tax_ 前缀只用于给出精确拒绝原因。
      if (typeof name === "string" && name.startsWith(TAX_TOOL_PREFIX)) return failure("model_tool_tax_excluded");
      if (typeof name === "string" && UNIMPLEMENTED_TOOL_SET.has(name)) {
        return failure("model_tool_not_implemented", { tool: name, category: "unimplemented" });
      }
      return failure("model_tool_unknown");
    }
    const spec = PLAIN_MODEL_TOOLS[name];
    if (!isPlainArgs(args)) {
      return failure("model_arguments_invalid", { tool: name, operation: spec.operation, category: spec.category });
    }
    let snapshot;
    try {
      // 在任何 await / Promise 之前固定参数：预验与 executeRaw 看到同一份规范化值。
      snapshot = snapshotArguments(args, { strictAccountScope: name.startsWith("auxiliary_") });
    } catch (error) {
      return failureFromError(error, { tool: name, operation: spec.operation, category: spec.category });
    }
    try {
      if (spec.category === "static") {
        return name === "finance_query_catalog" ? buildStaticCatalog(name) : buildPlanSummary(name, snapshot);
      }
      if (spec.category === "context") return await runContextTool(name, spec, snapshot);
      if (spec.category === "node_query") return await runFinanceQuery(snapshot);
      if (spec.category === "query") return await runAccountSetQuery(name, spec, snapshot);
      if (spec.category === "batch_query") return await runBatchQuery(spec, snapshot);
      if (spec.category === "write") return await runAccountSetWrite(name, spec, snapshot);
      return await runCreateTool(name, spec, snapshot);
    } catch (error) {
      // 兜底：任何意料之外的异常都只出固定错误码，绝不把 message / details / stack 带回模型。
      return failureFromError(error, { tool: name, operation: spec.operation, category: spec.category });
    }
  }

  return Object.freeze({
    version: MODEL_ADAPTER_VERSION,
    policy,
    registry: PLAIN_MODEL_TOOLS,
    inventory: MODEL_TOOL_INVENTORY,
    maxContextPageSize: MAX_CONTEXT_PAGE_SIZE,
    callModelTool,
  });
}

/**
 * 一次性便捷入口：`callModelTool(name, args, { executeRaw, policy })`。
 * 多步会话（需要复用同一个 localRef / 本机通道）请复用 createFinanceModelAdapter 的实例。
 */
export async function callModelTool(name, args, options) {
  return createFinanceModelAdapter(options).callModelTool(name, args);
}

export default createFinanceModelAdapter;
