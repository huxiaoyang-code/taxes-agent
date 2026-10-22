// finance-model-transport.mjs — 模型通道信封的**纯出站校验 / 固定错误转换**（未挂载）。
//
// 用途：给后续 MCP backend.mjs / server.mjs 接线时用。它只做三件事：
//   1) 严格校验后端返回的「模型通道信封」字段与值形状（默认拒绝未知字段）；
//   2) 把运输层失败（不可达 / 超时 / 非 2xx / 非 JSON / 畸形信封）转换成固定错误常量；
//   3) 保证任何原始 message / details / stack / 路径 / API_BASE / 额外字段都不会穿出。
//
// 本模块**不打开业务数据库、不发网络请求、不 import 06-workbench 服务端模块**，
// 不复制会计算法，也不知道业务字段——它只认识信封契约本身。
//
// 重要：本模块与它的测试**不是 MCP / HTTP 挂载验收**。当前 MCP 仍是原样透传后端结果
// （见 tools.mjs / backend.mjs / server.mjs，归 LOCAL-02 共享入口），接入必须另走集成任务。
export const TRANSPORT_VERSION = "finance-model-transport/v1";
export const MODEL_ENVELOPE_VERSION = "finance-output-policy/v1";
export const OPERATION_CATEGORIES = Object.freeze(["query", "write", "static", "context"]);
export const ENVELOPE_SCOPES = Object.freeze(["account_set", "global", "batch"]);
export const ACCOUNT_SET_ID_SOURCES = Object.freeze(["argument", "result"]);

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const prop = (obj, key) => {
  if (obj === null || typeof obj !== "object") return undefined;
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return desc && own(desc, "value") ? desc.value : undefined;
};
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const MONEY_LIMIT = 1e12;
const COUNT_LIMIT = 1e15;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const TOKEN_RE = /^[a-z][a-z0-9_]{0,31}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const OPERATION_RE = /^[A-Za-z][A-Za-z0-9_.:]{0,63}$/;
const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const NODE_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
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

/**
 * 运输层 / 信封层的固定失败常量。
 * `outcome`：not_sent（可确认没发出去） / unknown（可能已到后端，写场景绝不建议自动重试）。
 */
export const TRANSPORT_FAILURES = Object.freeze({
  backend_not_configured: Object.freeze({ outcome: "not_sent", retriableWhenRead: false }),
  backend_unreachable: Object.freeze({ outcome: "not_sent", retriableWhenRead: true }),
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
  return Object.freeze({
    ok: false,
    isError: true,
    transport: TRANSPORT_VERSION,
    error: Object.freeze({ code: known, retriable: false, messageKey: known }),
    outcome: meta.outcome,
    ...(forWrite ? { writeOutcome: "unknown", needsLocalReview: true } : {}),
    retriable: forWrite ? false : meta.retriableWhenRead,
    // 写场景下 outcome=unknown 时绝不建议重试；这里显式给出理由常量，方便上层直接展示。
    ...(forWrite && meta.outcome === "unknown" ? { retryBlockedBy: "write_outcome_unknown" } : {}),
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
    return value.length <= PROJ_MAX_STRING && (TOKEN_RE.test(value) || PERIOD_RE.test(value));
  }
  if (Array.isArray(value)) {
    const length = prop(value, "length");
    if (!Number.isSafeInteger(length) || length < 0 || length > PROJ_MAX_ARRAY) return false;
    for (let i = 0; i < length; i++) {
      const item = prop(value, i);
      if (typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= MONEY_LIMIT) continue;
      if (typeof item === "boolean") continue;
      if (typeof item === "string" && item.length <= PROJ_MAX_STRING
        && (TOKEN_RE.test(item) || PERIOD_RE.test(item))) continue;
      return false;
    }
    return true;
  }
  if (isPlainObject(value)) {
    if (depth + 1 > PROJ_MAX_DEPTH) return false;
    for (const key of Object.keys(value)) {
      if (!KEY_RE.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") return false;
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

// ---------------------------------------------------------------- 信封校验
function validateEnvelope(data, registries) {
  if (!isPlainObject(data)) return invalid("envelope_invalid");

  // ① 字段白名单（未知字段默认拒绝；敏感字段单独给出更精确的固定码）
  for (const key of Object.keys(data)) {
    if (ENVELOPE_KEYS.has(key)) continue;
    return invalid(SENSITIVE_KEYS.has(String(key).toLowerCase()) ? "envelope_sensitive_field" : "envelope_unexpected_field");
  }
  // 即使字段名在白名单，也不允许承载原文的结构（defense in depth）。
  for (const key of Object.keys(data)) {
    if (SENSITIVE_KEYS.has(String(key).toLowerCase())) return invalid("envelope_sensitive_field");
  }

  // ② 契约版本 / 通道声明
  if (prop(data, "outputPolicy") !== MODEL_ENVELOPE_VERSION) return invalid("envelope_policy_mismatch");
  if (prop(data, "channel") !== "model") return invalid("envelope_policy_mismatch");
  if (prop(data, "rawValuesIncluded") !== false) return invalid("envelope_policy_mismatch");
  const rawErrorIncluded = prop(data, "rawErrorIncluded");
  if (rawErrorIncluded !== undefined && rawErrorIncluded !== false) return invalid("envelope_policy_mismatch");

  const ok = prop(data, "ok");
  if (typeof ok !== "boolean") return invalid("envelope_invalid");

  // ③ operation：成功信封必须是登记表里的字符串；失败信封可以没有 operation（固定拒绝码本身
  // 就是完整信息），但一旦带上就必须同样经过登记表校验，不拼接任何未验证输入。
  const operation = prop(data, "operation");
  if (ok || operation !== undefined) {
    if (typeof operation !== "string" || !OPERATION_RE.test(operation)) return invalid("envelope_operation_unregistered");
    if (registries.operations && !registries.operations.has(operation)) {
      return invalid("envelope_operation_unregistered");
    }
  }
  const category = prop(data, "operationCategory");
  if (ok || category !== undefined) {
    if (typeof category !== "string" || !OPERATION_CATEGORIES.includes(category)) return invalid("envelope_invalid");
  }

  // ④ 通用可选标量
  const toolName = prop(data, "tool");
  if (toolName !== undefined) {
    if (typeof toolName !== "string" || !TOOL_RE.test(toolName)) return invalid("envelope_invalid");
    if (registries.tools && !registries.tools.has(toolName)) return invalid("envelope_invalid");
  }
  const nodeId = prop(data, "nodeId");
  if (nodeId !== undefined) {
    if (!isValidNodeId(nodeId)) return invalid("envelope_invalid");
    if (registries.nodeIds && !registries.nodeIds.has(nodeId)) return invalid("envelope_invalid");
  }
  const scope = prop(data, "scope");
  if (scope !== undefined && (typeof scope !== "string" || !ENVELOPE_SCOPES.includes(scope))) {
    return invalid("envelope_invalid");
  }
  const accountSetId = prop(data, "accountSetId");
  if (accountSetId !== undefined && accountSetId !== null) {
    if (!validNumberField(accountSetId, { integer: true, max: 1e15 }) || accountSetId <= 0) {
      return invalid("envelope_invalid");
    }
  } else if (accountSetId === undefined && ok) {
    return invalid("envelope_invalid");
  }
  const source = prop(data, "accountSetIdSource");
  if (source !== undefined && (typeof source !== "string" || !ACCOUNT_SET_ID_SOURCES.includes(source))) {
    return invalid("envelope_invalid");
  }

  // ⑤ 引用
  const localRef = prop(data, "localRef");
  if (localRef !== undefined && !validRef(localRef)) return invalid("envelope_ref_invalid");
  const refPersistence = prop(data, "refPersistence");
  if (refPersistence !== undefined && refPersistence !== "process_memory" && refPersistence !== "none") {
    return invalid("envelope_ref_invalid");
  }
  if (typeof localRef === "string" && refPersistence !== "process_memory") return invalid("envelope_ref_invalid");
  if (refPersistence === "none" && typeof localRef === "string") return invalid("envelope_ref_invalid");
  const refExpiresAt = prop(data, "refExpiresAt");
  if (refExpiresAt !== undefined) {
    const parsed = typeof refExpiresAt === "string" && ISO_RE.test(refExpiresAt) ? Date.parse(refExpiresAt) : NaN;
    if (!Number.isFinite(parsed)) return invalid("envelope_ref_invalid");
    if (typeof localRef !== "string") return invalid("envelope_ref_invalid");
  }
  if (typeof localRef === "string" && refExpiresAt === undefined) return invalid("envelope_ref_invalid");
  const refUnavailable = prop(data, "refUnavailable");
  if (refUnavailable !== undefined
    && (typeof refUnavailable !== "string" || !REF_UNAVAILABLE_TOKENS.has(refUnavailable))) {
    return invalid("envelope_ref_invalid");
  }

  // ⑥ 失败信封
  if (ok === false) {
    const error = prop(data, "error");
    if (!isPlainObject(error)) return invalid("envelope_error_shape_invalid");
    for (const key of Object.keys(error)) if (!ERROR_KEYS.has(key)) return invalid("envelope_error_shape_invalid");
    const errorCode = prop(error, "code");
    const errorCategory = prop(error, "category");
    const retriable = prop(error, "retriable");
    const messageKey = prop(error, "messageKey");
    if (typeof errorCode !== "string" || !TOKEN_RE.test(errorCode)) return invalid("envelope_error_shape_invalid");
    if (typeof errorCategory !== "string" || !TOKEN_RE.test(errorCategory)) return invalid("envelope_error_shape_invalid");
    if (typeof retriable !== "boolean") return invalid("envelope_error_shape_invalid");
    if (typeof messageKey !== "string" || messageKey !== errorCode) return invalid("envelope_error_shape_invalid");
    if (registries.errors && !registries.errors.has(errorCode)) return invalid("envelope_error_shape_invalid");
    return { ok: true, envelope: data };
  }

  // ⑦ 成功信封：必须有白名单投影，且投影形状本身也校验
  if (!own(data, "projection") || !own(data, "localRef")) return invalid("envelope_invalid");
  const projection = prop(data, "projection");
  if (!validProjection(projection)) return invalid("envelope_projection_invalid");
  const dropped = prop(data, "projectionDropped");
  if (dropped !== undefined && (!validNumberField(dropped, { integer: true, max: 1e6 }) || dropped < 0)) {
    return invalid("envelope_invalid");
  }
  if (localRef === null && refUnavailable === undefined) return invalid("envelope_ref_invalid");

  // ⑧ 写结果：applied 三态必须显式给出，未知结果必须标 needsLocalReview
  if (category === "write") {
    const applied = prop(data, "applied");
    if (applied !== true && applied !== false && applied !== "unknown") return invalid("envelope_status_invalid");
    const needsLocalReview = prop(data, "needsLocalReview");
    if (typeof needsLocalReview !== "boolean") return invalid("envelope_status_invalid");
    if (applied !== true && needsLocalReview !== true) return invalid("envelope_status_invalid");
    const reason = prop(data, "appliedReason");
    if (reason !== undefined && (typeof reason !== "string" || !TOKEN_RE.test(reason))) {
      return invalid("envelope_status_invalid");
    }
  }

  // ⑨ 静态目录：只允许代码常量数组（nodeId 形状），不含业务数据
  const catalog = prop(data, "catalog");
  if (catalog !== undefined) {
    if (!isPlainObject(catalog)) return invalid("envelope_invalid");
    for (const key of Object.keys(catalog)) if (!CATALOG_KEYS.has(key)) return invalid("envelope_unexpected_field");
    for (const key of Object.keys(catalog)) {
      const list = prop(catalog, key);
      const length = Array.isArray(list) ? prop(list, "length") : -1;
      if (!Array.isArray(list) || !Number.isSafeInteger(length) || length > 256) return invalid("envelope_invalid");
      for (let i = 0; i < length; i++) if (!isValidNodeId(prop(list, i))) return invalid("envelope_invalid");
    }
  }

  return { ok: true, envelope: data };
}

/**
 * 校验器工厂：`operations` / `tools` / `nodeIds` / `errors` 是可选的**已登记清单**
 * （Set 或字符串数组）。给了清单就做成员校验，不给只做形状校验。
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

/** 一次性校验（不传登记表时只校验形状）。 */
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
  return validateModelEnvelope(data, options);
}
