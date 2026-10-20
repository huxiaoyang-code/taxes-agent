// tax-api-catalog-classify.mjs — 纯响应/失败分类器（不联网、不解析业务原文、不回显原文）。
//
// 设计边界：
//   - 只按调用方提供的「安全观察摘要」分类，不接收也不返回响应体、错误消息、URL、凭据。
//     调用方必须自己先把响应解析成布尔/计数/枚举摘要，本模块不做正则猜测。
//   - 所有输入字段都做严格类型/枚举/范围校验：'false' 这类字符串真值不会被当成 true，
//     未通过校验的值一律抛固定错误码，绝不用“看起来真”的值推出成功。
//   - HTTP 200 不等于成功：必须同时满足「已解析 + 结构识别 + 业务码为成功族」且元数据不矛盾。
//   - 零事件不等于空数据：空结果必须有显式证据（业务码明确无记录 / 结构内 total=0 等）。
//   - 本模块不提供任何“全局登录状态”推断入口：单次调用结论只到 call_only；
//     真实的全局会话校验使用既有的 tax_session_verify 证据，离线分类一律 globalSessionState=unknown。
//   - 静态重试能力与本次重试建议分开：只有明确允许的瞬时只读失败才建议有限重试。

export const OUTCOMES = Object.freeze({
  not_sent: "未发出（本进程没有发出请求）",
  transport_timeout: "传输超时（已发出但未在阈值内收到完整响应）",
  transport_failed: "传输失败（非超时的连接/协议错误）",
  response_unparsed: "已收响应待解析（收到字节但尚未解析成结构）",
  auth_required: "认证要求（响应明确要求认证）",
  permission_denied: "明确无权限（响应明确表示无权限）",
  business_empty: "业务空结果（有显式“无记录”证据）",
  success: "成功（结构识别且业务码为成功族）",
  structure_unrecognized: "结构不识别（解析结果不匹配已知结构或元数据矛盾）",
  business_error: "业务错误（结构识别且业务码为失败族）",
});

export const OUTCOME_KEYS = Object.freeze(Object.keys(OUTCOMES));

/** 调用方只能声明这些「业务码族」，不得传业务码原文。 */
export const CODE_FAMILIES = Object.freeze(["success", "auth", "permission", "empty", "error", "unknown"]);

/** 允许的分类阶段（安全元数据）。 */
export const PHASES = Object.freeze(["payload_build", "send", "receive", "parse", "interpret"]);

/** 本地策略默认值：不是税局 SLA，也不是任何官方时限。 */
export const DEFAULT_TIMEOUTS = Object.freeze({
  read_only_ms: 15000,
  authentication_ms: 30000,
  state_changing_ms: 30000,
});
export const TIMEOUT_POLICY_NOTE = "timeoutMs 为本地策略默认值，不是税局 SLA / 官方时限";

/**
 * 静态重试能力：只描述「这个风险类别在原则上允不允许重试」，
 * 不代表本次调用应该重试。本次建议见 retryAdviceFor()。
 */
const STATIC_RETRY = Object.freeze({
  read_only: Object.freeze({ allowed: true, maxAttempts: 2, scope: "read_only_transient_only",
    note: "静态能力：只读接口对瞬时传输失败允许有限重试；认证/无权限/业务结果一律不重试" }),
  unknown: Object.freeze({ allowed: false, maxAttempts: 0, scope: "never", note: "风险未知，不重试" }),
  state_changing: Object.freeze({ allowed: false, maxAttempts: 0, scope: "never", note: "写接口不重试（可能重复提交）" }),
  authentication: Object.freeze({ allowed: false, maxAttempts: 0, scope: "never",
    note: "登录/认证不重试（会烧掉验证码/触发风控）" }),
});

/** 静态策略查询（不是本次调用建议）。 */
export function retryPolicyFor(risk) {
  return { ...(STATIC_RETRY[risk] || STATIC_RETRY.unknown) };
}

/** 只有这些结论属于「瞬时、只读、可能自愈」的失败。 */
const TRANSIENT_OUTCOMES = Object.freeze(["transport_timeout", "transport_failed"]);

/**
 * 本次重试建议。默认不允许；只有只读风险的瞬时传输失败、且尚未用完允许次数时才建议重试。
 * 认证/无权限/成功/空结果/业务错误/结构不识别/未发出 一律 false。
 * 超时只说明“没在阈值内收到”，不会被解释成无权限或全局登录失效。
 */
export function retryAdviceFor(outcome, { risk = "unknown", retryAttempt = 0 } = {}) {
  const policy = retryPolicyFor(risk);
  const attempt = Number.isInteger(retryAttempt) && retryAttempt >= 0 ? retryAttempt : 0;
  const transient = TRANSIENT_OUTCOMES.includes(outcome);
  const allowed = policy.allowed && transient && attempt + 1 < policy.maxAttempts;
  return {
    allowed,
    maxAttempts: policy.allowed ? policy.maxAttempts : 0,
    nextAttempt: allowed ? attempt + 1 : null,
    attemptUsed: attempt,
    scope: allowed ? "read_only_transient_once" : "no_retry",
    reason: allowed
      ? "只读接口的瞬时传输失败，可在同一参数下再试一次"
      : (!policy.allowed
        ? "该风险类别静态不允许重试"
        : (!transient ? `结论 ${outcome} 不属于可自愈的瞬时传输失败` : "重试次数已用尽")),
    note: "重试建议只针对本次调用；超时不等于无权限，也不等于全局登录失效",
  };
}

export function timeoutFor(risk) {
  if (risk === "read_only") return DEFAULT_TIMEOUTS.read_only_ms;
  if (risk === "authentication") return DEFAULT_TIMEOUTS.authentication_ms;
  return DEFAULT_TIMEOUTS.state_changing_ms;
}

function classifyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * 观察字段的严格校验表。值只能是 boolean / 非负整数 / 固定枚举。
 * 不符合就抛 classify_input_invalid（固定码，不回显传入值）。
 */
const OBSERVATION_SCHEMA = Object.freeze({
  requestIssued: "boolean",
  phase: PHASES,
  transportError: Object.freeze([null, "timeout", "network", "other"]),
  httpStatus: "httpStatus",
  responseReceived: "boolean",
  bodyParsed: "boolean",
  schemaRecognized: "boolean",
  businessCodeFamily: CODE_FAMILIES,
  businessCodePresent: "boolean",
  resultCount: "count",
  emptinessEvidence: "boolean",
  authSignal: "boolean",
  permissionSignal: "boolean",
  elapsedMs: "elapsedMs",
  retryAttempt: "retryAttempt",
});

const ALLOWED_KEYS = Object.freeze(Object.keys(OBSERVATION_SCHEMA));

function validateObservation(observation) {
  for (const key of Object.keys(observation)) {
    if (!ALLOWED_KEYS.includes(key)) throw classifyError("classify_field_rejected");
  }
  for (const [key, rule] of Object.entries(OBSERVATION_SCHEMA)) {
    if (!(key in observation)) continue;
    const value = observation[key];
    if (Array.isArray(rule)) {
      if (!rule.includes(value)) throw classifyError("classify_input_invalid");
    } else if (rule === "boolean") {
      if (typeof value !== "boolean") throw classifyError("classify_input_invalid");
    } else if (rule === "httpStatus") {
      if (!Number.isInteger(value) || value < 100 || value > 599) throw classifyError("classify_input_invalid");
    } else if (rule === "count") {
      if (!Number.isInteger(value) || value < 0) throw classifyError("classify_input_invalid");
    } else if (rule === "retryAttempt") {
      if (!Number.isInteger(value) || value < 0 || value > 10) throw classifyError("classify_input_invalid");
    } else if (rule === "elapsedMs") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 3_600_000) {
        throw classifyError("classify_input_invalid");
      }
    }
  }
}

/** 互斥的元数据组合：出现即说明调用方摘要矛盾，不得推出任何“成功”。
 *  只读已校验的规范化值（沸尔 / 整数 / 枚举），不做任何推断。 */
function contradictions(meta) {
  const codes = [];
  const family = meta.businessCodeFamily;
  const successish = family === "success";
  const anyOutcomeSignal = meta.responseReceived || meta.bodyParsed || meta.httpStatus !== null
    || meta.transportError !== null || meta.businessCodeFamily !== null;
  if (meta.requestIssuedDeclared && !meta.requestIssued && anyOutcomeSignal) codes.push("not_sent_with_outcome_fields");
  if (meta.transportError !== null && meta.responseReceived) codes.push("transport_error_with_response");
  // 显式声明“未收到响应”，却又给出解析/结构/业务码/结果计数证据：元数据自相矛盾。
  const responseDenied = meta.responseReceivedDeclared && !meta.responseReceived;
  if (responseDenied && (meta.bodyParsed || meta.schemaRecognized || meta.businessCodePresent
    || meta.businessCodeFamily !== null || meta.resultCount !== null)) {
    codes.push("response_absent_with_response_evidence");
  }
  if (successish && (meta.authSignal || meta.permissionSignal)) codes.push("success_vs_auth_signal");
  if (successish && meta.emptinessEvidence && meta.resultCount !== null && meta.resultCount !== 0) {
    codes.push("success_vs_nonzero_empty_evidence");
  }
  if (family === "empty" && meta.resultCount !== null && meta.resultCount !== 0) codes.push("empty_vs_nonzero_count");
  if (family === "auth" && meta.authSignalDeclared && !meta.authSignal) codes.push("auth_family_vs_negative_signal");
  if (family === "permission" && meta.permissionSignalDeclared && !meta.permissionSignal) {
    codes.push("permission_family_vs_negative_signal");
  }
  if (meta.resultCount !== null && !meta.bodyParsed) codes.push("count_without_parsed_body");
  if (family !== null && family !== "unknown" && meta.businessCodePresentDeclared && !meta.businessCodePresent) {
    codes.push("family_without_business_code");
  }
  // 成功类业务码（success / empty，两者都会计入 successLike）与非 2xx 状态冲突：
  // 只判结构不识别，不据此推断全局登录失效。empty + 2xx 仍是有效空结果。
  const successLikeFamily = successish || family === "empty";
  if (successLikeFamily && meta.httpStatus !== null && (meta.httpStatus < 200 || meta.httpStatus >= 300)) {
    codes.push(successish ? "success_family_on_non_2xx_status" : "empty_family_on_non_2xx_status");
  }
  return codes;
}

/** 规范化后的安全元数据：所有下游判断只读这些字段。 */
function safeMeta(observation, risk) {
  return {
    requestIssued: observation.requestIssued === true,
    requestIssuedDeclared: observation.requestIssued !== undefined,
    phase: observation.phase ?? "interpret",
    transportError: observation.transportError ?? null,
    httpStatus: observation.httpStatus ?? null,
    httpStatusIsSuccessAlone: false,
    responseReceived: observation.responseReceived === true,
    responseReceivedDeclared: observation.responseReceived !== undefined,
    bodyParsed: observation.bodyParsed === true,
    bodyParsedDeclared: observation.bodyParsed !== undefined,
    schemaRecognized: observation.schemaRecognized === true,
    businessCodeFamily: observation.businessCodeFamily ?? null,
    businessCodePresent: observation.businessCodePresent === true,
    businessCodePresentDeclared: observation.businessCodePresent !== undefined,
    resultCount: observation.resultCount ?? null,
    emptinessEvidence: observation.emptinessEvidence === true,
    authSignal: observation.authSignal === true,
    authSignalDeclared: observation.authSignal !== undefined,
    permissionSignal: observation.permissionSignal === true,
    permissionSignalDeclared: observation.permissionSignal !== undefined,
    elapsedMs: observation.elapsedMs === undefined ? null : Math.round(observation.elapsedMs),
    retryAttempt: observation.retryAttempt ?? 0,
    timeoutMs: timeoutFor(risk),
    timeoutPolicy: "local_policy_default_not_tax_sla",
    retryCapability: retryPolicyFor(risk),
    risk,
  };
}

/**
 * 分类一次调用观察。输入只允许安全元数据字段，全部经过严格校验。
 */
export function classifyOutcome(observation = {}, { risk = "unknown" } = {}) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw classifyError("classify_input_invalid");
  }
  if (!Object.prototype.hasOwnProperty.call(STATIC_RETRY, risk)) throw classifyError("classify_risk_invalid");
  validateObservation(observation);
  const meta = safeMeta(observation, risk);
  const conflicts = contradictions(meta);
  const outcome = conflicts.length ? "structure_unrecognized" : decide(meta);
  // 内部“是否声明”标记不对外输出，只输出规范化后的安全元数据。
  const {
    requestIssuedDeclared, responseReceivedDeclared, bodyParsedDeclared, businessCodePresentDeclared,
    authSignalDeclared, permissionSignalDeclared,
    ...publicMeta
  } = meta;
  return {
    outcome,
    outcomeLabel: OUTCOMES[outcome],
    ...publicMeta,
    contradictionCodes: conflicts,
    retryAdvice: retryAdviceFor(outcome, { risk, retryAttempt: meta.retryAttempt }),
    sessionScope: "call_only",
    globalSessionState: "unknown",
    globalSessionNote: "本分类器不推断全局登录状态；真实全局校验请使用既有 tax_session_verify 的可靠证据",
    catalogManaged: true,
    liveCallVerified: false,
  };
}

/** 只用安全元数据（均已经过校验）做判定。 */
function decide(meta) {
  if (!meta.requestIssued) return "not_sent";
  if (meta.transportError === "timeout") return "transport_timeout";
  if (meta.transportError) return "transport_failed";
  // 显式“未收到响应”且未解析、无其他矛盾证据：这是传输失败，不是“收到了待解析”。
  if (!meta.bodyParsed && meta.responseReceivedDeclared && !meta.responseReceived) return "transport_failed";
  // 收到字节但未解析：显式 bodyParsed=false，或已声明收到响应但未声明解析成功。
  if (!meta.bodyParsed && meta.bodyParsedDeclared) return "response_unparsed";
  if (!meta.bodyParsed && meta.responseReceived) return "response_unparsed";
  if (!meta.bodyParsed && !meta.responseReceived) return "transport_failed";
  if (!meta.bodyParsed) return "response_unparsed";
  // 业务码族优先于 HTTP 状态：200 也可能是认证/无权限/业务错误。
  if (meta.authSignal || meta.businessCodeFamily === "auth") return "auth_required";
  if (meta.permissionSignal || meta.businessCodeFamily === "permission") return "permission_denied";
  if (!meta.schemaRecognized) return "structure_unrecognized";
  if (meta.businessCodeFamily === "error") return "business_error";
  if (meta.businessCodeFamily === "empty") return "business_empty";
  if (meta.resultCount === 0 || meta.emptinessEvidence) {
    // 零结果必须有显式“无记录”证据，否则不认。
    return meta.businessCodeFamily === "success" && meta.emptinessEvidence
      ? "business_empty"
      : "structure_unrecognized";
  }
  if (meta.businessCodeFamily === "success" && meta.businessCodePresent) return "success";
  return "structure_unrecognized";
}

/**
 * 汇总多次调用的分类结果。只做计数与分组，不做归因、不提升为全局会话结论。
 */
export function aggregateOutcomes(results = []) {
  if (!Array.isArray(results)) throw classifyError("classify_input_invalid");
  const counts = Object.fromEntries(OUTCOME_KEYS.map((key) => [key, 0]));
  for (const result of results) {
    const outcome = result?.outcome;
    if (!OUTCOME_KEYS.includes(outcome)) throw classifyError("classify_input_invalid");
    counts[outcome] += 1;
  }
  const successful = counts.success + counts.business_empty;
  return {
    callCount: results.length,
    counts,
    successLike: successful,
    failedLike: results.length - successful,
    transportUnknown: counts.transport_timeout,
    sessionScope: "call_only",
    globalSessionState: "unknown",
    note: "汇总只统计调用级结论；任一调用判为认证要求也不等于账号登录失效",
  };
}
