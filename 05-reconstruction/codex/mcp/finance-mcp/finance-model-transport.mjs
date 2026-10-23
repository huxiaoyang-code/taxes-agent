// finance-model-transport.mjs — 模型通道信封的**纯出站校验 / 固定错误转换**（未挂载）。
//
// 用途：给后续 MCP backend.mjs / server.mjs 接线时用。它只做三件事：
//   1) 严格校验后端返回的「模型通道信封」字段与值形状（默认拒绝未知字段 / 不适用字段）；
//   2) 把运输层失败（不可达 / 超时 / 非 2xx / 非 JSON / 畸形信封）转换成固定错误常量；
//   3) 保证任何原始 message / details / stack / 路径 / API_BASE / 额外字段都不会穿出。
//
// 本模块**不打开业务数据库、不发网络请求、不 import 06-workbench 服务端模块**，
// 不复制会计算法，也不知道业务字段——它只认识信封契约本身。
// 为了不把安全交给“调用方记得传完整登记表”，operation / tool / nodeId / 错误码 / 目录
// 都内置固定登记语义；调用方仍可传登记表作为额外的收紧（必须同时命中）。
//
// 重要：本模块与它的测试**不是 MCP / HTTP 挂载验收**。当前 MCP 仍是原样透传后端结果
// （见 tools.mjs / backend.mjs / server.mjs，归 LOCAL-02 共享入口），接入必须另走集成任务。
export const TRANSPORT_VERSION = "finance-model-transport/v1";
export const MODEL_ENVELOPE_VERSION = "finance-output-policy/v1";
export const MODEL_ADAPTER_VERSION = "finance-model-adapter/v1";
export const OPERATION_CATEGORIES = Object.freeze([
  "query", "write", "create", "static", "context", "node_query", "batch_query", "unimplemented",
]);
export const ENVELOPE_SCOPES = Object.freeze(["account_set", "global", "batch", "result"]);
export const ACCOUNT_SET_ID_SOURCES = Object.freeze(["argument", "result"]);

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const prop = (obj, key) => {
  if (obj === null || typeof obj !== "object") return undefined;
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return desc && own(desc, "value") ? desc.value : undefined;
};
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// ---------------------------------------------------------------- 纯数据快照
// 校验器只接受「自有 data 属性」构建的普通对象 / 数组，并且**返回重建的副本**：
// 即使调用方传入 enumerable getter / toJSON / Symbol / 非普通原型，也不会在 JSON.stringify
// 阶段执行用户代码或带出未校验属性。快照本身有界，避免恶意输入撑爆内存。
const SNAPSHOT_MAX_DEPTH = 8;
const SNAPSHOT_MAX_NODES = 4096;
const SNAPSHOT_MAX_ARRAY = 256;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function plainSnapshot(root) {
  let nodes = 0;
  const ancestors = new Set();
  const walk = (value, depth) => {
    nodes++;
    if (nodes > SNAPSHOT_MAX_NODES) throw new Error("snapshot");
    if (value === null) return null;
    const type = typeof value;
    if (type === "string") return value;
    if (type === "number") {
      if (!Number.isFinite(value)) throw new Error("snapshot");
      return value;
    }
    if (type === "boolean") return value;
    // 函数 / Symbol / BigInt / undefined 都不是合法信封数据。
    if (type !== "object") throw new Error("snapshot");
    if (depth > SNAPSHOT_MAX_DEPTH || ancestors.has(value)) throw new Error("snapshot");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const length = prop(value, "length");
        if (!Number.isSafeInteger(length) || length < 0 || length > SNAPSHOT_MAX_ARRAY) throw new Error("snapshot");
        if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("snapshot");
        if (Object.keys(value).length !== length) throw new Error("snapshot");
        const out = new Array(length);
        for (let i = 0; i < length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (!descriptor || !own(descriptor, "value")) throw new Error("snapshot");
          out[i] = walk(descriptor.value, depth + 1);
        }
        return out;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error("snapshot");
      if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("snapshot");
      const out = {};
      for (const key of Object.keys(value)) {
        if (BLOCKED_KEYS.has(key)) throw new Error("snapshot");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !own(descriptor, "value")) throw new Error("snapshot");
        // 与校验阶段的 prop() 语义一致：显式 undefined 视为缺省，不进入副本。
        if (descriptor.value === undefined) continue;
        out[key] = walk(descriptor.value, depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(value);
    }
  };
  return walk(root, 0);
}

const MONEY_LIMIT = 1e12;
const COUNT_LIMIT = 1e15;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const OPERATION_RE = /^[A-Za-z][A-Za-z0-9_.:]{0,63}$/;
const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const NODE_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const REF_RE = /^finref_[a-f0-9]{48}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROJ_MAX_DEPTH = 3;
const PROJ_MAX_NODES = 96;
const PROJ_MAX_ARRAY = 32;
const PROJ_MAX_STRING = 40;

/** 信封顶层允许的字段（其它一律拒绝，绝不透传）。 */
const ENVELOPE_KEYS = new Set([
  "ok", "outputPolicy", "adapter", "channel", "operation", "operationCategory", "accountSetId",
  "accountSetIdSource", "tool", "scope", "nodeId", "projection", "projectionDropped", "localRef",
  "refPersistence", "refExpiresAt", "refUnavailable", "applied", "appliedReason", "needsLocalReview",
  "rawValuesIncluded", "error", "rawErrorIncluded", "catalog",
]);
/** 即使将来有人放宽未知字段，这些名字也永远不允许出现（它们正是原文泄漏面）。 */
const SENSITIVE_KEYS = new Set([
  "message", "details", "stack", "path", "paths", "raw", "rawtext", "rawbody", "apibase", "api_base",
  "baseurl", "base_url", "enterprisename", "enterprise_name", "enterprisekey", "enterprise_key",
  "accountname", "account_name", "accountcode", "account_code", "summary", "entries", "voucher",
  "vouchers", "items", "lines", "source", "sourcevoucherid", "batchid", "batch_id", "filename",
]);
const ERROR_KEYS = new Set(["code", "category", "retriable", "messageKey"]);
const CATALOG_KEYS = new Set(["available", "unimplemented", "localExtensions"]);
const REF_UNAVAILABLE_TOKENS = new Set([
  "capacity", "node_budget", "byte_budget", "value_limit", "value_invalid", "summary_unavailable",
  "global_scope", "unbound_scope", "not_applied", "not_executed", "outcome_unknown", "scope_mismatch",
]);
const APPLIED_REASONS = new Set([
  "unverified_result", "missing_voucher_id", "nothing_due", "dry_run", "idempotent_replay",
  "rejected_before_execution",
]);

// ---------------------------------------------------------------- 固定登记表（不依赖调用方）
const FINANCE_QUERY_AVAILABLE = Object.freeze([
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
const FINANCE_QUERY_UNIMPLEMENTED = Object.freeze([
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
const FINANCE_QUERY_LOCAL_EXTENSIONS = Object.freeze(["report.trial_balance", "ledger.general"]);
const MODEL_NODE_IDS = new Set([...FINANCE_QUERY_AVAILABLE, ...FINANCE_QUERY_UNIMPLEMENTED]);

const PLAIN_TOOL_OPERATIONS = Object.freeze({
  finance_query_catalog: "finance_query_catalog",
  update_plan: "update_plan",
  account_context: "account_context",
  finance_context_resolve: "finance_context_resolve",
  finance_query: null,
  voucher_check: "voucher_check",
  account_list: "account_list",
  opening_balance_get: "opening_balance_get",
  period_list: "period_list",
  ledger_query: "ledger_query",
  asset_list: "asset_list",
  period_end_check: "period_end_check",
  book_import_batch: "book_import_batch",
  voucher_create: "voucher_create",
  voucher_post: "voucher_post",
  voucher_unpost: "voucher_unpost",
  voucher_delete: "voucher_delete",
  period_set_status: "period_set_status",
  opening_balance_set: "opening_balance_set",
  account_create: "account_create",
  asset_create: "asset_create",
  asset_update: "asset_update",
  depreciation_run: "depreciation_run",
  carry_forward_profit: "carry_forward_profit",
  account_set_create: "account_set_create",
  legacy_book_import: "legacy_book_import",
  book_import_incremental: "book_import_incremental",
});
const UNIMPLEMENTED_TOOL_NAMES = Object.freeze([
  "declaration_query", "exec", "finance_task_status", "invoice_collect", "invoice_file", "invoice_issue",
  "invoice_issue_result", "invoice_precheck", "invoice_red_apply", "invoice_red_issue", "invoice_red_status",
  "invoice_tax_code",
]);
const MODEL_TOOL_NAMES = new Set([...Object.keys(PLAIN_TOOL_OPERATIONS), ...UNIMPLEMENTED_TOOL_NAMES]);

const QUERY_OPERATIONS = Object.freeze([
  "account_list", "asset_list", "book_import_batch",
  "finance_query:enterprise_account.account_set",
  "finance_query:enterprise_account.subject_system.all",
  "finance_query:ledger.general",
  "finance_query:period_end.summary",
  "finance_query:report.balance_sheet",
  "finance_query:report.cash_flow_statement",
  "finance_query:report.income_statement",
  "finance_query:report.trial_balance",
  "finance_query:voucher.detail",
  "finance_query:voucher.draft.summary",
  "finance_query:voucher.generated.list",
  "finance_query:voucher.generated.summary",
  "ledger_query", "opening_balance_get", "period_end_check", "period_list", "voucher_check",
]);
const WRITE_OPERATIONS = Object.freeze([
  "account_create", "account_set_create", "asset_create", "asset_update", "book_import_incremental",
  "carry_forward_profit", "depreciation_run", "legacy_book_import", "opening_balance_set",
  "period_set_status", "voucher_create", "voucher_delete", "voucher_post", "voucher_unpost",
]);
const STATIC_OPERATIONS = Object.freeze(["finance_query_catalog", "update_plan"]);
const CONTEXT_OPERATIONS = Object.freeze(["account_context", "finance_context_resolve"]);
const CREATE_OPERATIONS = new Set(["account_set_create", "legacy_book_import", "book_import_incremental"]);
const MODEL_OPERATIONS = new Set([
  ...QUERY_OPERATIONS, ...WRITE_OPERATIONS, ...STATIC_OPERATIONS, ...CONTEXT_OPERATIONS,
]);

const categories = (...values) => Object.freeze(values);
const OPERATION_CATEGORIES_BY_OPERATION = Object.freeze(Object.fromEntries([
  ...QUERY_OPERATIONS.map((operation) => [operation,
    operation === "book_import_batch" ? categories("query", "batch_query") : categories("query")]),
  ...WRITE_OPERATIONS.map((operation) => [operation,
    CREATE_OPERATIONS.has(operation) ? categories("write", "create") : categories("write")]),
  ...STATIC_OPERATIONS.map((operation) => [operation, categories("static")]),
  ...CONTEXT_OPERATIONS.map((operation) => [operation, categories("context")]),
]));
const SCOPES_BY_CATEGORY = Object.freeze({
  query: categories("account_set", "batch"),
  batch_query: categories("batch"),
  write: categories("account_set"),
  create: categories("result", "account_set"),
  static: categories("global"),
  context: categories("global", "account_set"),
  node_query: categories("account_set"),
  unimplemented: categories(),
});

/** projection 里允许出现的字符串只可能是这些受控状态 / 枚举 token，或期间。 */
const PROJECTION_TOKENS = new Set([
  "assets", "liabilities", "equity", "cost", "profit_loss",
  "debit", "credit",
  "draft", "posted", "open", "closed",
  "create", "append",
  "completed", "failed", "pending", "started",
  "preview", "applied", "idempotent_replay",
  "small_scale", "general", "small_business", "enterprise", "unknown",
  "not_persisted", "global", "account_set", "batch", "explicit_account_set_id",
  "fixed", "intangible",
  "ok", "blocked", "not_applicable",
  "booked", "pending_purchase_voucher", "purchase", "supplement", "import",
  // LOCAL-02 期末检查固定步骤 / 固定阻塞码（只允许这些代码常量进入 projection）。
  "draft_vouchers", "trial_balance", "depreciation", "asset_reconciliation",
  "profit_carry_forward", "year_end_carry_forward", "period_sequence",
  "period_has_draft_vouchers", "period_unbalanced", "depreciation_run_stale",
  "asset_ledger_pending", "depreciation_missing", "depreciation_draft_exists",
  "depreciation_life_expired_underprovided", "asset_missing_card", "asset_cost_mismatch",
  "asset_accumulated_mismatch", "asset_acquired_period_missing", "asset_purchase_voucher_pending",
  "profit_not_carried_forward", "profit_carry_stale", "year_end_not_carried",
  "previous_period_open", "previous_period_depreciation_pending",
  "later_period_closed", "carryforward_stale",
]);

// 固定错误码 → 固定 category。未登记码一律拒绝（不能靠“看起来像 token”穿过）。
const ERROR_CATEGORY_BY_CODE = Object.freeze({
  account_set_not_found: "account_set",
  account_not_found: "account",
  period_closed: "period",
  period_invalid: "period",
  period_required: "period",
  period_before_start: "period",
  voucher_not_found: "voucher",
  voucher_invalid: "voucher",
  voucher_id_required: "voucher",
  account_set_id_required: "account_set",
  account_set_id_invalid: "account_set",
  code_required: "account",
  entries_required: "voucher",
  name_required: "input",
  start_period_invalid: "input",
  opening_items_invalid: "input",
  opening_rewrite_after_posting: "opening",
  opening_rewrite_period_closed: "opening",
  opening_borrow_lend_conflict: "opening",
  already_carried_forward: "period_end",
  already_year_end_carried: "period_end",
  depreciation_draft_exists: "depreciation",
  asset_has_depreciation_runs: "asset",
  payload_or_texts_or_files_required: "input",
  report_data_invalid: "report",
  model_tool_unknown: "tool",
  model_tool_tax_excluded: "tool",
  model_tool_not_implemented: "tool",
  model_node_unknown: "tool",
  model_node_not_implemented: "tool",
  model_arguments_invalid: "input",
  account_set_id_conflict: "input",
  model_context_page_invalid: "input",
  model_scope_mismatch: "input",
  model_result_invalid: "output_policy",
  operation_failed: "unknown",
  accountSetId_required: "account_set",
  accountSetId_invalid: "account_set",
  nodeId_required: "input",
  items_required: "input",
  import_validation_failed: "import",
  import_conflict: "import",
  batch_not_found: "import",
  batchId_required: "input",
  code_and_name_required: "account",
  direction_invalid: "account",
  category_invalid: "account",
  status_invalid: "period",
  period_not_found: "period",
  period_has_draft_vouchers: "period",
  period_unbalanced: "period",
  posted_voucher_requires_unpost: "voucher",
  voucherId_required: "voucher",
  opening_unbalanced: "opening",
  opening_code_required: "opening",
  opening_amount_invalid: "opening",
  original_cost_invalid: "asset",
  useful_life_months_invalid: "asset",
  useful_life_months_out_of_range: "asset",
  residual_rate_invalid: "asset",
  assetId_required: "asset",
  asset_not_found: "asset",
  acquired_period_invalid: "asset",
  opening_accumulated_invalid: "asset",
  opening_accumulated_exceeds_depreciable: "asset",
  ledger_status_invalid: "asset",
  ledger_note_required: "asset",
  asset_origin_invalid: "asset",
  asset_card_affects_closed_period: "asset",
  asset_card_locked_by_posted_runs: "asset",
  asset_acquired_period_missing: "asset",
  asset_purchase_voucher_pending: "asset",
  asset_ledger_pending: "asset",
  asset_missing_card: "asset",
  asset_cost_mismatch: "asset",
  asset_accumulated_mismatch: "asset",
  period_end_check_failed: "period_end",
  later_period_closed: "period_end",
  later_year_end_carryforward_depends_on_period: "period_end",
  later_profit_carryforward_depends_on_period: "period_end",
  later_depreciation_depends_on_period: "period_end",
  carryforward_stale: "period_end",
  profit_not_carried_forward: "period_end",
  profit_carry_stale: "period_end",
  year_end_not_carried: "period_end",
  previous_period_open: "period_end",
  previous_period_depreciation_pending: "period_end",
  depreciation_missing: "depreciation",
  depreciation_run_stale: "depreciation",
  depreciation_life_expired_underprovided: "depreciation",
  depreciation_global_over_depreciable: "depreciation",
  voucher_number_unplanned: "voucher",
  depreciation_exceeds_depreciable: "depreciation",
  unknown_tool: "tool",
  tool_required: "tool",
  output_policy_ref_unknown: "output_policy",
  output_policy_ref_expired: "output_policy",
  output_policy_ref_invalid: "output_policy",
  output_policy_ref_binding_mismatch: "output_policy",
  output_policy_ref_cross_account: "output_policy",
  output_policy_ref_capacity_exceeded: "output_policy",
  output_policy_ref_revoked: "output_policy",
  output_policy_channel_required: "output_policy",
  output_policy_channel_untrusted: "output_policy",
  output_policy_channel_revoked: "output_policy",
  output_policy_unknown_operation: "output_policy",
  output_policy_operation_required: "output_policy",
  output_policy_account_set_invalid: "output_policy",
  output_policy_path_invalid: "output_policy",
  output_policy_compute_op_invalid: "output_policy",
  output_policy_value_too_large: "output_policy",
  output_policy_value_invalid: "output_policy",
  output_policy_disposed: "output_policy",
  output_policy_option_invalid: "output_policy",
  output_policy_projection_invalid: "output_policy",
});

/**
 * 运输层 / 信封层的固定失败常量。
 * `outcome`：not_sent（可确认没发出去） / unknown（可能已到后端，写场景绝不建议自动重试）。
 * 通用连接错误（unreachable）无法证明请求没发出去，因此保守记 unknown。
 */
export const TRANSPORT_FAILURES = Object.freeze({
  backend_not_configured: Object.freeze({ outcome: "not_sent", retriableWhenRead: false }),
  backend_unreachable: Object.freeze({ outcome: "unknown", retriableWhenRead: true }),
  backend_timeout: Object.freeze({ outcome: "unknown", retriableWhenRead: true }),
  backend_non_json: Object.freeze({ outcome: "unknown", retriableWhenRead: false }),
  backend_http_error: Object.freeze({ outcome: "unknown", retriableWhenRead: false }),
  backend_result_not_object: Object.freeze({ outcome: "unknown", retriableWhenRead: false }),
  envelope_invalid: Object.freeze({ outcome: "unknown", retriableWhenRead: false }),
  envelope_unexpected_field: Object.freeze({ outcome: "unknown", retriableWhenRead: false }),
  envelope_sensitive_field: Object.freeze({ outcome: "unknown", retriableWhenRead: false }),
  envelope_policy_mismatch: Object.freeze({ outcome: "unknown", retriableWhenRead: false }),
  envelope_operation_unregistered: Object.freeze({ outcome: "unknown", retriableWhenRead: false }),
  envelope_projection_invalid: Object.freeze({ outcome: "unknown", retriableWhenRead: false }),
  envelope_ref_invalid: Object.freeze({ outcome: "unknown", retriableWhenRead: false }),
  envelope_status_invalid: Object.freeze({ outcome: "unknown", retriableWhenRead: false }),
  envelope_error_shape_invalid: Object.freeze({ outcome: "unknown", retriableWhenRead: false }),
});

/** 固定失败对象：只含常量，不含任何原始文本 / 路径 / 地址。 */
export function transportFailure(code, options = {}) {
  const known = typeof code === "string" && own(TRANSPORT_FAILURES, code) ? code : "envelope_invalid";
  const meta = TRANSPORT_FAILURES[known];
  const forWrite = prop(options, "forWrite") === true;
  const outcome = forWrite && meta.outcome !== "not_sent" ? "unknown" : meta.outcome;
  return Object.freeze({
    ok: false,
    isError: true,
    transport: TRANSPORT_VERSION,
    error: Object.freeze({ code: known, retriable: false, messageKey: known }),
    outcome,
    ...(forWrite ? { writeOutcome: outcome } : {}),
    retriable: forWrite ? false : meta.retriableWhenRead,
    // 写场景下 outcome=unknown 时绝不建议重试；这里显式给出理由常量，方便上层直接展示。
    ...(forWrite && outcome === "unknown" ? { retryBlockedBy: "write_outcome_unknown" } : {}),
  });
}

/** 非 2xx / 无响应归类：只按固定种类返回，不回显 status 文本 / URL。 */
export function classifyTransportFailure(kind, options = {}) {
  const table = {
    not_configured: "backend_not_configured",
    unreachable: "backend_unreachable",
    timeout: "backend_timeout",
    non_json: "backend_non_json",
    http_error: "backend_http_error",
    not_object: "backend_result_not_object",
  };
  const code = typeof kind === "string" && own(table, kind) ? table[kind] : "backend_http_error";
  return transportFailure(code, options);
}

function invalid(code) {
  return { ok: false, failure: transportFailure(code) };
}

// ---------------------------------------------------------------- 值校验
function projectionValue(value, depth, state) {
  if (state.nodes > PROJ_MAX_NODES) return false;
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= MONEY_LIMIT;
  if (typeof value === "boolean") return true;
  if (typeof value === "string") {
    return value.length <= PROJ_MAX_STRING && (PROJECTION_TOKENS.has(value) || PERIOD_RE.test(value));
  }
  if (Array.isArray(value)) {
    const length = prop(value, "length");
    if (!Number.isSafeInteger(length) || length < 0 || length > PROJ_MAX_ARRAY) return false;
    for (let i = 0; i < length; i++) {
      const item = prop(value, i);
      if (typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= MONEY_LIMIT) continue;
      if (typeof item === "boolean") continue;
      if (typeof item === "string" && item.length <= PROJ_MAX_STRING
        && (PROJECTION_TOKENS.has(item) || PERIOD_RE.test(item))) continue;
      return false;
    }
    return true;
  }
  if (isPlainObject(value)) {
    if (depth + 1 > PROJ_MAX_DEPTH) return false;
    for (const key of Object.keys(value)) {
      if (!KEY_RE.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") return false;
      if (SENSITIVE_KEYS.has(String(key).toLowerCase())) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !own(descriptor, "value")) return false;
      state.nodes++;
      if (!projectionValue(descriptor.value, depth + 1, state)) return false;
    }
    return true;
  }
  return false;
}

function validProjection(value) {
  if (!isPlainObject(value)) return false;
  const state = { nodes: 0 };
  return projectionValue(value, 1, state);
}

function validRef(value) {
  return value === null || (typeof value === "string" && REF_RE.test(value));
}

function validNumberField(value, { integer = false, max = COUNT_LIMIT } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (integer && !Number.isSafeInteger(value)) return false;
  return Math.abs(value) <= max;
}

function registryOf(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.filter((item) => typeof item === "string"));
  return null;
}

function isValidNodeId(value) {
  return typeof value === "string" && value.length <= 96 && NODE_RE.test(value);
}

function sameStringList(value, expected) {
  if (!Array.isArray(value)) return false;
  const length = prop(value, "length");
  if (length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) if (prop(value, i) !== expected[i]) return false;
  return true;
}

function allowedValue(value, builtin, registry) {
  return builtin.has(value) && (!registry || registry.has(value));
}

/** 写结果三态：applied 只允许 true / false / "unknown"；未知或未应用必须标记复核与固定原因。 */
function validateStatusFields(data) {
  const applied = prop(data, "applied");
  if (applied !== true && applied !== false && applied !== "unknown") return false;
  const needsLocalReview = prop(data, "needsLocalReview");
  if (typeof needsLocalReview !== "boolean") return false;
  if (applied !== true && needsLocalReview !== true) return false;
  if (applied === true && needsLocalReview === true) {
    const unavailable = prop(data, "refUnavailable");
    if (prop(data, "localRef") !== null || prop(data, "refPersistence") !== "none"
      || (unavailable !== "value_invalid" && unavailable !== "summary_unavailable")) return false;
  }
  const reason = prop(data, "appliedReason");
  if (applied === true) return reason === undefined;
  return typeof reason === "string" && APPLIED_REASONS.has(reason);
}

function validateCatalog(catalog) {
  if (!isPlainObject(catalog)) return false;
  for (const key of Object.keys(catalog)) if (!CATALOG_KEYS.has(key)) return false;
  for (const key of CATALOG_KEYS) if (!own(catalog, key)) return false;
  return sameStringList(prop(catalog, "available"), FINANCE_QUERY_AVAILABLE)
    && sameStringList(prop(catalog, "unimplemented"), FINANCE_QUERY_UNIMPLEMENTED)
    && sameStringList(prop(catalog, "localExtensions"), FINANCE_QUERY_LOCAL_EXTENSIONS);
}

// ---------------------------------------------------------------- 信封校验
function validateEnvelope(data, registries) {
  try {
    // 第一遍：在原对象上完整校验，只用于沿用既有的固定错误码
    // （prop() 只读属性描述符，不执行 getter）。这一遍的结论**不能**直接决定返回什么。
    const checked = validateEnvelopeInner(data, registries);
    if (checked.ok !== true) return checked;
    // 第二遍：先重建**有界纯数据快照**，再对这份「将要返回的同一份快照」重新完整校验。
    // 于是「校验的内容」与「返回的内容」永远是同一个对象：原对象即使在多次反射读取之间
    // 变化（例如 getOwnPropertyDescriptor 每次返回不同的值），也只可能让快照校验失败，
    // 绝不会出现「校验 A、返回 B」或返回未按契约校验过的副本。
    // 快照本身不含 getter / Symbol / 非普通原型 / toJSON，后续 JSON.stringify 也不会执行用户代码。
    const snapshot = plainSnapshot(data);
    const verified = validateEnvelopeInner(snapshot, registries);
    if (verified.ok !== true) return verified;
    return { ok: true, envelope: verified.envelope };
  } catch {
    // getter / Proxy / 快照超界等异常也绝不能把原文带出去：统一固定结果。
    return invalid("envelope_invalid");
  }
}

function validateEnvelopeInner(data, registries) {
  if (!isPlainObject(data)) return invalid("envelope_invalid");

  // ① 字段白名单（未知字段默认拒绝；敏感字段单独给出更精确的固定码）
  for (const key of Object.keys(data)) {
    if (ENVELOPE_KEYS.has(key)) continue;
    return invalid(SENSITIVE_KEYS.has(String(key).toLowerCase()) ? "envelope_sensitive_field" : "envelope_unexpected_field");
  }
  for (const key of Object.keys(data)) {
    if (SENSITIVE_KEYS.has(String(key).toLowerCase())) return invalid("envelope_sensitive_field");
  }

  // ② 契约版本 / 适配器 / 通道声明
  if (prop(data, "outputPolicy") !== MODEL_ENVELOPE_VERSION) return invalid("envelope_policy_mismatch");
  if (prop(data, "adapter") !== MODEL_ADAPTER_VERSION) return invalid("envelope_policy_mismatch");
  if (prop(data, "channel") !== "model") return invalid("envelope_policy_mismatch");
  if (prop(data, "rawValuesIncluded") !== false) return invalid("envelope_policy_mismatch");
  const rawErrorIncluded = prop(data, "rawErrorIncluded");
  if (rawErrorIncluded !== undefined && rawErrorIncluded !== false) return invalid("envelope_policy_mismatch");

  const ok = prop(data, "ok");
  if (typeof ok !== "boolean") return invalid("envelope_invalid");

  // ③ operation / category / scope：固定登记语义，且互相必须一致
  const operation = prop(data, "operation");
  if (operation !== undefined) {
    if (typeof operation !== "string" || !OPERATION_RE.test(operation)) return invalid("envelope_operation_unregistered");
    if (!allowedValue(operation, MODEL_OPERATIONS, registries.operations)) {
      return invalid("envelope_operation_unregistered");
    }
  } else if (ok) {
    return invalid("envelope_invalid");
  }
  const category = prop(data, "operationCategory");
  if (category !== undefined) {
    if (typeof category !== "string" || !OPERATION_CATEGORIES.includes(category)) return invalid("envelope_invalid");
    if (operation !== undefined) {
      const allowedCategories = OPERATION_CATEGORIES_BY_OPERATION[operation];
      if (!allowedCategories || !allowedCategories.includes(category)) return invalid("envelope_invalid");
    }
  } else if (ok) {
    return invalid("envelope_invalid");
  }
  const scope = prop(data, "scope");
  if (scope !== undefined) {
    if (typeof scope !== "string" || !ENVELOPE_SCOPES.includes(scope)) return invalid("envelope_invalid");
    if (category === undefined) return invalid("envelope_invalid");
    const allowedScopes = SCOPES_BY_CATEGORY[category];
    if (!allowedScopes || !allowedScopes.includes(scope)) return invalid("envelope_invalid");
  } else if (ok) {
    return invalid("envelope_invalid");
  }

  // ④ 工具 / nodeId：固定清单，且与 operation 对得上
  const toolName = prop(data, "tool");
  if (toolName !== undefined) {
    if (typeof toolName !== "string" || !TOOL_RE.test(toolName)) return invalid("envelope_invalid");
    if (!allowedValue(toolName, MODEL_TOOL_NAMES, registries.tools)) return invalid("envelope_invalid");
    if (operation !== undefined) {
      if (toolName === "finance_query") {
        if (!operation.startsWith("finance_query:")) return invalid("envelope_invalid");
      } else if (operation !== toolName) {
        return invalid("envelope_invalid");
      }
    }
  }
  const nodeId = prop(data, "nodeId");
  if (nodeId !== undefined) {
    if (!isValidNodeId(nodeId) || !allowedValue(nodeId, MODEL_NODE_IDS, registries.nodeIds)) {
      return invalid("envelope_invalid");
    }
    if (operation !== undefined) {
      if (!operation.startsWith("finance_query:") || operation !== `finance_query:${nodeId}`) {
        return invalid("envelope_invalid");
      }
    }
  }

  // ⑤ 账套 ID / 来源：成功信封必须有账套字段；global/static 明确为 null
  const accountSetId = prop(data, "accountSetId");
  const hasAccountSetId = own(data, "accountSetId");
  if (hasAccountSetId && accountSetId !== null) {
    if (!validNumberField(accountSetId, { integer: true, max: 1e15 }) || accountSetId <= 0) {
      return invalid("envelope_invalid");
    }
  }
  if (ok && !hasAccountSetId) return invalid("envelope_invalid");
  if (ok && scope === "global" && accountSetId !== null) return invalid("envelope_invalid");
  const source = prop(data, "accountSetIdSource");
  if (own(data, "accountSetIdSource")) {
    if (typeof source !== "string" || !ACCOUNT_SET_ID_SOURCES.includes(source)) return invalid("envelope_invalid");
    if (!ok) return invalid("envelope_unexpected_field");
    // 来源与分支语义绑定：写用入参、create / batch 只认真实结果。
    const sourceAllowed = (source === "argument" && category === "write")
      || (source === "result" && (category === "create" || scope === "batch"));
    if (!sourceAllowed) return invalid("envelope_unexpected_field");
  }

  // ⑥ 引用字段：成功 = 可用的 process_memory 引用或明确降级；失败 = 只能 null / none
  const localRef = prop(data, "localRef");
  const hasLocalRef = own(data, "localRef");
  const refPersistence = prop(data, "refPersistence");
  const hasPersistence = own(data, "refPersistence");
  const refExpiresAt = prop(data, "refExpiresAt");
  const hasExpires = own(data, "refExpiresAt");
  const refUnavailable = prop(data, "refUnavailable");
  const hasUnavailable = own(data, "refUnavailable");
  if (hasLocalRef && !validRef(localRef)) return invalid("envelope_ref_invalid");
  if (hasPersistence && refPersistence !== "process_memory" && refPersistence !== "none") {
    return invalid("envelope_ref_invalid");
  }
  if (hasExpires) {
    const parsed = typeof refExpiresAt === "string" && ISO_RE.test(refExpiresAt) ? Date.parse(refExpiresAt) : NaN;
    if (!Number.isFinite(parsed)) return invalid("envelope_ref_invalid");
  }
  if (hasUnavailable
    && (typeof refUnavailable !== "string" || !REF_UNAVAILABLE_TOKENS.has(refUnavailable))) {
    return invalid("envelope_ref_invalid");
  }
  if (typeof localRef === "string") {
    if (refPersistence !== "process_memory" || !hasExpires || hasUnavailable) {
      return invalid("envelope_ref_invalid");
    }
  } else if (localRef === null) {
    // 失败信封的引用字段由分支规则统一判“不适用”；这里只查真正的矛盾组合。
    if (hasExpires) return invalid("envelope_ref_invalid");
    if (ok && refPersistence !== "none") return invalid("envelope_ref_invalid");
    if (!ok && hasPersistence && refPersistence !== "none") return invalid("envelope_ref_invalid");
  } else {
    // 没有 localRef 时不允许出现任何引用伴随字段（悬空字段直接拒绝）。
    if (hasPersistence || hasExpires || hasUnavailable) return invalid("envelope_ref_invalid");
  }
  if (ok) {
    if (!hasLocalRef) return invalid("envelope_invalid");
    if (localRef === null && !hasUnavailable) return invalid("envelope_ref_invalid");
    if (scope === "account_set" && accountSetId === null) {
      // 未绑定账套的写结果（dry-run / 未建账 / 写后降级）可以明确为 null；
      // 查询 / 上下文 / 静态结果仍必须有真实账套或明确的 global。
      const unboundWrite = (category === "write" || category === "create")
        && localRef === null && hasUnavailable;
      if (!unboundWrite) return invalid("envelope_invalid");
    }
  } else {
    if (localRef !== undefined && localRef !== null) return invalid("envelope_ref_invalid");
    if (hasPersistence && refPersistence !== "none") return invalid("envelope_ref_invalid");
    if (hasExpires) return invalid("envelope_ref_invalid");
  }

  const writeLike = category === "write" || category === "create";
  const hasProjection = own(data, "projection");
  const hasDropped = own(data, "projectionDropped");
  const hasStatus = own(data, "applied") || own(data, "appliedReason") || own(data, "needsLocalReview");
  const hasError = own(data, "error");
  const hasCatalog = own(data, "catalog");

  // ⑦ 分支许可先判：不适用字段直接拒绝（保持固定错误码），再验适用的值。
  if (!ok) {
    if (!writeLike) {
      for (const key of [
        "projection", "projectionDropped", "applied", "appliedReason", "needsLocalReview",
        "localRef", "refPersistence", "refUnavailable", "catalog",
      ]) {
        if (own(data, key)) return invalid("envelope_unexpected_field");
      }
    }
    if (!hasError) return invalid("envelope_error_shape_invalid");
    if (hasCatalog) return invalid("envelope_unexpected_field");
  } else {
    if (hasError) return invalid("envelope_unexpected_field");
    if (!writeLike && hasStatus) return invalid("envelope_unexpected_field");
    if (writeLike && !hasStatus) return invalid("envelope_status_invalid");
  }

  // ⑧ projection / projectionDropped：**每个出现的键都独立校验**，不依赖伴随键。
  if (hasProjection && !validProjection(prop(data, "projection"))) return invalid("envelope_projection_invalid");
  if (hasDropped) {
    const dropped = prop(data, "projectionDropped");
    if (!validNumberField(dropped, { integer: true, max: 1e6 }) || dropped < 0) {
      return invalid("envelope_projection_invalid");
    }
  }
  // 悬空 / 缺失的伴随字段都拒绝：合法截断契约是「有 projection 才允许 dropped，且必须是计数」。
  if (hasDropped && !hasProjection) return invalid("envelope_unexpected_field");
  if (hasProjection && !hasDropped) return invalid("envelope_projection_invalid");
  if (ok && !hasProjection) return invalid("envelope_invalid");

  // ⑨ applied 三态：只在写类分支适用；存在即完整校验。
  if (writeLike && !validateStatusFields(data)) return invalid("envelope_status_invalid");

  // ⑩ 失败信封：只允许固定错误码，且 code/category/messageKey 必须自洽。
  if (!ok) {
    const error = prop(data, "error");
    if (!isPlainObject(error)) return invalid("envelope_error_shape_invalid");
    for (const key of Object.keys(error)) if (!ERROR_KEYS.has(key)) return invalid("envelope_error_shape_invalid");
    const errorCode = prop(error, "code");
    const errorCategory = prop(error, "category");
    const retriable = prop(error, "retriable");
    const messageKey = prop(error, "messageKey");
    if (typeof errorCode !== "string" || !ERROR_CODE_RE.test(errorCode)) return invalid("envelope_error_shape_invalid");
    if (!own(ERROR_CATEGORY_BY_CODE, errorCode)) return invalid("envelope_error_shape_invalid");
    if (registries.errors && !registries.errors.has(errorCode)) return invalid("envelope_error_shape_invalid");
    if (typeof errorCategory !== "string" || errorCategory !== ERROR_CATEGORY_BY_CODE[errorCode]) {
      return invalid("envelope_error_shape_invalid");
    }
    if (typeof retriable !== "boolean") return invalid("envelope_error_shape_invalid");
    if (typeof messageKey !== "string" || messageKey !== errorCode) return invalid("envelope_error_shape_invalid");
  } else if (own(data, "rawErrorIncluded")) {
    return invalid("envelope_unexpected_field");
  }

  // ⑪ 静态目录：只允许固定代码常量，且必须是登记过的 node 集合。
  if (hasCatalog) {
    if (!ok || category !== "static" || toolName !== "finance_query_catalog") {
      return invalid("envelope_unexpected_field");
    }
    if (!validateCatalog(prop(data, "catalog"))) return invalid("envelope_invalid");
  }

  return { ok: true, envelope: data };
}

/**
 * 校验器工厂：内置 operation / tool / nodeId / 错误码 / 目录登记表始终生效。
 * `operations` / `tools` / `nodeIds` / `errors` 可额外传入作为更窄的白名单（必须同时命中）。
 */
export function createModelEnvelopeValidator(options = {}) {
  if (!isPlainObject(options)) throw new TypeError("finance-model-transport: options 必须是对象");
  const registries = {
    operations: registryOf(prop(options, "operations")),
    tools: registryOf(prop(options, "tools")),
    nodeIds: registryOf(prop(options, "nodeIds")),
    errors: registryOf(prop(options, "errors")),
  };
  return Object.freeze({
    version: TRANSPORT_VERSION,
    validate: (data) => validateEnvelope(data, registries),
    accepts: (data) => validateEnvelope(data, registries).ok === true,
  });
}

/** 一次性校验。登记表由本模块内置；不传 options 也仍会做完整成员校验。 */
export function validateModelEnvelope(data, options = {}) {
  return createModelEnvelopeValidator(options).validate(data);
}

/** 布尔便捷入口。 */
export function isModelEnvelope(data, options = {}) {
  return validateModelEnvelope(data, options).ok;
}

/**
 * 解析并校验后端响应文本：非 JSON / 非对象一律固定错误码，绝不回显响应片段。
 * 返回 `{ ok:true, envelope }` 或 `{ ok:false, failure }`。
 */
export function parseModelEnvelope(text, options = {}) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, failure: transportFailure("backend_non_json") };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, failure: transportFailure("backend_non_json") };
  }
  if (!isPlainObject(data)) return { ok: false, failure: transportFailure("backend_result_not_object") };
  try {
    return validateModelEnvelope(data, options);
  } catch {
    return { ok: false, failure: transportFailure("envelope_invalid") };
  }
}
