// local-audit.mjs — LOCAL-06 审计契约层（A 包，仅原语，不含任何接线）。
//
// 职责：
//   1) 固定 action / outcome / resultCode / reasonCode 词表（**允许清单**，不用「像英文就放行」的正则）；
//   2) 技术 ID / 期间 / 关联令牌 / attempt 的严格校验，用户传入的可疑标识一律不原样保存；
//   3) operation 上下文（稳定 operationId、单调 attempt、可选父操作、范围技术 ID）；
//   4) 外层事务 / SAVEPOINT 协调原语与「回滚后再写失败事件」的失败事件构造。
//
// 边界（必须遵守）：
//   * 本文件只 import `node:crypto`；不 import `db.mjs`、不打开数据库、不创建目录、无默认数据目录副作用。
//   * 事件字段是**白名单**：未登记字段一律拒绝（不是静默剔除），错误信息只给数量，不回显键名 / 值，
//     避免用户 payload、摘要、姓名、企业身份、batchId、路径、异常 message / code / stack / details
//     借审计写入或错误信息外泄。
//   * 不存金额、原始凭证、任意 metadata JSON；跨库（业务库 ↔ 恢复 ledger）**不假装原子**。
//
// 接口清单见 docs/LOCAL-AUDIT.md §4；B / C 接线只允许用该清单，不猜内部实现。

import { createHash, randomUUID } from "node:crypto";

/** 业务库内审计组件名（与 LOCAL-02 的全局 schema 版本相互独立）。 */
export const AUDIT_COMPONENT = "business-audit";
/** 审计组件自身结构版本；新增列 / 表必须新增迁移并递增版本。 */
export const AUDIT_SCHEMA_VERSION = 1;

// ------------------------------------------------------------------ 固定词表
/** 固定 action 词表（领域入口统一记账的粒度）。 */
export const AUDIT_ACTIONS = Object.freeze([
  "import.create",
  "import.append",
  "import.legacy",
  "voucher.post",
  "voucher.unpost",
  "period.close",
  "period.reopen",
  "batch.stage",
  "batch.job",
  "restore.new",
]);

/** 固定 outcome 词表；中断不得伪造成 failed 或 succeeded。 */
export const AUDIT_OUTCOMES = Object.freeze([
  "succeeded",
  "rejected",
  "failed",
  "no_change",
  "replayed",
  "interrupted",
  "unknown",
]);

/** 执行者来源（哪一层触发的领域调用，用于区分重复记账，不当权限用）。 */
export const AUDIT_ACTORS = Object.freeze([
  "http",
  "agent",
  "mcp",
  "cli",
  "domain",
  "batch",
  "system",
]);

/** 固定 resultCode 词表。 */
export const AUDIT_RESULT_CODES = Object.freeze([
  // 通用
  "ok",
  "no_change",
  "replayed",
  "rejected",
  "rejected_validation",
  "conflict",
  "not_found",
  "blocked_period_closed",
  "failed",
  "internal_error",
  "audit_unavailable",
  "interrupted",
  "unknown",
  // 领域成功 / 预检
  "import_create_succeeded",
  "import_append_succeeded",
  "import_legacy_succeeded",
  "import_preview_ok",
  "voucher_post_succeeded",
  "voucher_unpost_succeeded",
  "period_close_succeeded",
  "period_reopen_succeeded",
  "batch_stage_succeeded",
  "batch_job_succeeded",
  "restore_new_succeeded",
  // 领域失败 / 恢复中间态
  "batch_stage_failed",
  "batch_job_failed",
  "restore_new_failed",
  "restore_new_rejected",
  "restore_published_pending",
  // 审计组件自身
  "audit_install_refused",
  "audit_schema_rejected",
]);

/**
 * 固定 reasonCode 词表 = 已知领域错误码 + 审计错误码 + `none`。
 * 映射用精确表（见 `classifyFailure`），未知错误码固定归 `internal_error`，绝不透传原始字符串。
 */
export const AUDIT_REASON_CODES = Object.freeze([
  "none",
  // 找不到对象
  "account_set_not_found",
  "voucher_not_found",
  "period_not_found",
  "account_not_found",
  "batch_not_found",
  // 领域规则拒绝
  "period_closed",
  "opening_rewrite_period_closed",
  "opening_rewrite_after_posting",
  "posted_voucher_requires_unpost",
  "period_has_draft_vouchers",
  "period_unbalanced",
  "opening_unbalanced",
  "already_carried_forward",
  "already_year_end_carried",
  "asset_has_depreciation_runs",
  "depreciation_draft_exists",
  "depreciation_exceeds_depreciable",
  "voucher_number_conflict",
  "voucher_number_unplanned",
  "validation_failed",
  // 审计组件自身
  "audit_event_invalid",
  "audit_event_conflict",
  "audit_transaction_required",
  "audit_unavailable",
  "audit_write_failed",
  "audit_commit_unknown",
  "audit_schema_inconsistent",
  "audit_schema_newer",
  "audit_schema_install_failed",
  "audit_install_requires_verified_backup",
  "audit_database_missing",
  "audit_database_invalid",
  // 兜底（固定值，不是异常原文）
  "internal_error",
  "interrupted",
  "unknown",
]);

const ACTIONS = new Set(AUDIT_ACTIONS);
const OUTCOMES = new Set(AUDIT_OUTCOMES);
const ACTORS = new Set(AUDIT_ACTORS);
const RESULT_CODES = new Set(AUDIT_RESULT_CODES);
const REASON_CODES = new Set(AUDIT_REASON_CODES);

// ------------------------------------------------------------------ 错误
/** 审计契约 / 存储固定错误码（业务层据此判定，不解析 message）。 */
export class AuditError extends Error {
  constructor(code, details = null) {
    super(code);
    this.name = "AuditError";
    this.code = code;
    this.details = details; // 只允许放计数 / 枚举等非敏感信息
    this.auditPersisted = false;
  }
}

/** 代码 / 业务名固定错误码（非原始异常文本）。 */
const REJECT_CODES = new Set([
  "audit_event_invalid",
  "audit_event_context_mismatch",
  "audit_event_field_not_overridable",
  "audit_operation_invalid",
  "audit_filter_invalid",
  "audit_schema_inconsistent",
  "audit_schema_newer",
  "audit_schema_install_failed",
  "audit_install_requires_verified_backup",
  "audit_database_missing",
  "audit_database_invalid",
  "audit_instance_conflict",
  "audit_query_forbidden",
  "audit_transaction_required",
  "restore_ledger_missing",
  "restore_ledger_inconsistent",
  "restore_ledger_incompatible",
  "restore_ledger_foreign_tables",
  "restore_ledger_invalid",
  "restore_ledger_write_failed",
  "restore_operation_invalid",
  "restore_operation_conflict",
  "restore_state_conflict",
  "restore_receipt_mismatch",
  "restore_digest_mismatch",
  "restore_reconcile_insufficient_evidence",
]);

const fail = (code, details = null) => {
  const err = new AuditError(code, details);
  if (REJECT_CODES.has(code)) err.auditPersisted = false;
  return err;
};
export const auditError = fail;

/** 审计无法持久化：业务结果已不确定 / 已回滚，但**不能**报「完整成功」。 */
export class AuditUnavailableError extends AuditError {
  constructor(code, { cause = null, businessError = null } = {}) {
    super(code, null);
    this.name = "AuditUnavailableError";
    this.auditPersisted = false;
    if (cause) this.cause = cause;
    if (businessError) this.businessError = businessError;
  }
}

// ------------------------------------------------------------------ 技术 ID 校验
const TECH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;

/** 技术 ID（jobId / itemId / stageId / operationId 等）：只接受受限字符集与长度。 */
export function isTechId(value) {
  return typeof value === "string" && TECH_ID_RE.test(value);
}

/** 账套 / 凭证内部自增 ID：正整数，不接受字符串或浮点。 */
export function isTechnicalRowId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** 期间 YYYY-MM（月 01-12）。 */
export function isAuditPeriod(value) {
  return typeof value === "string" && PERIOD_RE.test(value);
}

/**
 * 关联令牌：把调用方提供的任何标识（batchId / sourceVoucherId / 企业身份等）**在服务端**做规范哈希，
 * 只落 64 位小写 hex，绝不保存原串。只接受字符串 / 有限数字，对象与数组一律拒绝。
 */
export function correlationToken(...parts) {
  const list = [];
  for (const part of parts) {
    if (typeof part === "string") list.push(part);
    else if (typeof part === "number" && Number.isFinite(part)) list.push(String(part));
    else throw fail("audit_operation_invalid", { field: "correlation" });
  }
  if (!list.length) throw fail("audit_operation_invalid", { field: "correlation" });
  return createHash("sha256").update(JSON.stringify(list), "utf8").digest("hex");
}

const isDigest = (value) => typeof value === "string" && DIGEST_RE.test(value);

// ------------------------------------------------------------------ operation 上下文
const CONTEXT_TARGET_FIELDS = Object.freeze([
  "accountSetId",
  "voucherId",
  "period",
  "jobId",
  "itemId",
  "stageId",
]);
const CONTEXT_FIELDS = Object.freeze([
  "operationId",
  "parentOperationId",
  "actor",
  "action",
  "attempt",
  ...CONTEXT_TARGET_FIELDS,
  "correlation",
]);

const UNKNOWN_FIELD = Symbol("unknownField");

function checkTargets(raw, out) {
  if (raw.accountSetId !== undefined && raw.accountSetId !== null) {
    if (!isTechnicalRowId(raw.accountSetId)) throw fail("audit_operation_invalid", { field: "accountSetId" });
    out.accountSetId = raw.accountSetId;
  }
  if (raw.voucherId !== undefined && raw.voucherId !== null) {
    if (!isTechnicalRowId(raw.voucherId)) throw fail("audit_operation_invalid", { field: "voucherId" });
    out.voucherId = raw.voucherId;
  }
  if (raw.period !== undefined && raw.period !== null) {
    if (!isAuditPeriod(raw.period)) throw fail("audit_operation_invalid", { field: "period" });
    out.period = raw.period;
  }
  for (const field of ["jobId", "itemId", "stageId"]) {
    if (raw[field] === undefined || raw[field] === null) continue;
    if (!isTechId(raw[field])) throw fail("audit_operation_invalid", { field });
    out[field] = raw[field];
  }
  if (raw.correlation !== undefined && raw.correlation !== null) {
    if (!isDigest(raw.correlation)) throw fail("audit_operation_invalid", { field: "correlation" });
    out.correlation = raw.correlation;
  }
  return out;
}

/**
 * 规范化 operation 上下文：**稳定**的 operationId + 单调 attempt + 可选父操作 + 范围技术 ID。
 *
 * 约定：
 *  - 同一个「逻辑操作」在重试中复用同一个 operationId；不同尝试用不同 attempt（从 1 递增）。
 *  - post → unpost → post 是三次实际动作，必须用不同 attempt（或不同 operationId），
 *    否则会被同一 operation/attempt 的去重键挡成一条。
 *  - attempt 必须由调用方显式给出（缺省 1），本函数不做「自动 +1」的猜测。
 */
export function createOperationContext(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw fail("audit_operation_invalid", { field: "context" });
  }
  const out = {};
  for (const key of Object.keys(raw)) {
    if (!CONTEXT_FIELDS.includes(key)) throw fail("audit_operation_invalid", { field: "unknown", count: 1 });
  }
  if (!isTechId(raw.operationId)) throw fail("audit_operation_invalid", { field: "operationId" });
  out.operationId = raw.operationId;
  if (raw.parentOperationId !== undefined && raw.parentOperationId !== null) {
    if (!isTechId(raw.parentOperationId)) throw fail("audit_operation_invalid", { field: "parentOperationId" });
    if (raw.parentOperationId === out.operationId) {
      throw fail("audit_operation_invalid", { field: "parentOperationId" });
    }
    out.parentOperationId = raw.parentOperationId;
  }
  if (!ACTORS.has(raw.actor)) throw fail("audit_operation_invalid", { field: "actor" });
  out.actor = raw.actor;
  if (!ACTIONS.has(raw.action)) throw fail("audit_operation_invalid", { field: "action" });
  out.action = raw.action;
  const attempt = raw.attempt === undefined || raw.attempt === null ? 1 : raw.attempt;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 1_000_000) {
    throw fail("audit_operation_invalid", { field: "attempt" });
  }
  out.attempt = attempt;
  checkTargets(raw, out);
  return Object.freeze(out);
}

/** 由已有上下文派生同一逻辑操作的另一 attempt（不改原对象）。 */
export function withAttempt(context, attempt) {
  if (!context || typeof context !== "object") throw fail("audit_operation_invalid", { field: "context" });
  return createOperationContext({ ...context, attempt });
}

/** 由已有上下文派生子操作（父操作 = 当前操作；共享范围技术 ID）。 */
export function createChildOperation(context, { operationId, actor = context.actor, action, attempt = 1 }) {
  const child = {
    ...context,
    operationId,
    parentOperationId: context.operationId,
    actor,
    action,
    attempt,
  };
  return createOperationContext(child);
}

const contextTargets = (context) => {
  const out = {};
  for (const field of CONTEXT_TARGET_FIELDS) if (context[field] !== undefined) out[field] = context[field];
  return out;
};
export { contextTargets };

// ------------------------------------------------------------------ 事件字段白名单
/** 事件字段允许清单（全量）。未登记字段一律拒绝。 */
export const AUDIT_EVENT_FIELDS = Object.freeze([
  "action",
  "outcome",
  "resultCode",
  "reasonCode",
  "attempt",
  "operationId",
  "parentOperationId",
  "actor",
  "correlation",
  "accountSetId",
  "voucherId",
  "period",
  "jobId",
  "itemId",
  "stageId",
]);

/** `runAuditedOperation` 内允许由单条事件覆盖的字段（其余必须来自上下文）。 */
export const AUDIT_EVENT_OVERRIDABLE_FIELDS = Object.freeze([
  "correlation",
  "accountSetId",
  "voucherId",
  "period",
  "jobId",
  "itemId",
  "stageId",
]);

const DEDUPE_FIELDS = Object.freeze([
  "operationId",
  "attempt",
  "action",
  "accountSetId",
  "voucherId",
  "period",
  "jobId",
  "itemId",
  "stageId",
  "correlation",
]);

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const json = (value) => JSON.stringify(value);

/**
 * 事件内容摘要（写入 `content_digest`）：固定字段顺序的规范 JSON 哈希。
 * 只用于完整性校验，不用于去重。
 */
export function auditEventDigest(event) {
  return sha256(json([
    event.databaseInstanceId ?? "",
    event.occurredAt,
    event.action,
    event.outcome,
    event.resultCode,
    event.reasonCode,
    event.actor,
    event.operationId,
    event.parentOperationId ?? null,
    event.attempt,
    event.accountSetId ?? null,
    event.voucherId ?? null,
    event.period ?? null,
    event.jobId ?? null,
    event.itemId ?? null,
    event.stageId ?? null,
    event.correlation ?? null,
  ]));
}

/**
 * 去重键：同一 operation / attempt / action / 范围目标 / 关联令牌 的**同一事件**只写一条。
 * outcome / resultCode / reasonCode 属于「数据」：键相同而数据不同 → 冲突，不用 INSERT OR IGNORE 掩盖。
 */
export function auditEventDedupeKey(event) {
  const picked = {};
  for (const field of DEDUPE_FIELDS) picked[field] = event[field] ?? null;
  return sha256(json(picked));
}

const dedupeComparable = (event) => json([
  event.outcome,
  event.resultCode,
  event.reasonCode,
  event.parentOperationId ?? null,
]);

/**
 * 校验并规范化一条审计事件。
 *
 * @param {object} raw 事件字段（见 AUDIT_EVENT_FIELDS）
 * @param {object} [context] createOperationContext 的结果；提供时补齐缺省字段并校验不可覆盖字段一致
 * @param {{eventId?:string, databaseInstanceId?:string, occurredAt?:string}} [server] 服务端生成字段（外部不得提供）
 */
export function normalizeAuditEvent(raw = {}, context = null, server = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw fail("audit_event_invalid", { reason: "event_object_required" });
  }
  let unknown = 0;
  for (const key of Object.keys(raw)) if (!AUDIT_EVENT_FIELDS.includes(key)) unknown += 1;
  if (unknown) throw fail("audit_event_invalid", { reason: "unknown_field", unknownFieldCount: unknown });

  const out = {};
  const contextField = (field) => (context ? context[field] : undefined);
  const fromContext = (field, fallback = undefined) => {
    const explicit = raw[field];
    const inherited = contextField(field);
    if (explicit === undefined || explicit === null) {
      if (inherited === undefined) {
        if (fallback !== undefined) return fallback;
        throw fail("audit_event_invalid", { reason: "missing_field", field });
      }
      return inherited;
    }
    if (inherited !== undefined && inherited !== explicit) {
      throw fail("audit_event_context_mismatch", { field });
    }
    return explicit;
  };

  out.action = fromContext("action");
  if (!ACTIONS.has(out.action)) throw fail("audit_event_invalid", { reason: "action", field: "action" });

  if (!OUTCOMES.has(raw.outcome)) throw fail("audit_event_invalid", { reason: "outcome", field: "outcome" });
  out.outcome = raw.outcome;

  if (!RESULT_CODES.has(raw.resultCode)) {
    throw fail("audit_event_invalid", { reason: "result_code", field: "resultCode" });
  }
  out.resultCode = raw.resultCode;

  const reasonCode = raw.reasonCode === undefined || raw.reasonCode === null ? "none" : raw.reasonCode;
  if (!REASON_CODES.has(reasonCode)) {
    throw fail("audit_event_invalid", { reason: "reason_code", field: "reasonCode" });
  }
  out.reasonCode = reasonCode;

  out.operationId = fromContext("operationId");
  if (!isTechId(out.operationId)) throw fail("audit_event_invalid", { reason: "operation_id", field: "operationId" });

  out.parentOperationId = fromContext("parentOperationId", null);
  if (out.parentOperationId !== null) {
    if (!isTechId(out.parentOperationId) || out.parentOperationId === out.operationId) {
      throw fail("audit_event_invalid", { reason: "parent_operation_id", field: "parentOperationId" });
    }
  }

  out.actor = fromContext("actor");
  if (!ACTORS.has(out.actor)) throw fail("audit_event_invalid", { reason: "actor", field: "actor" });

  out.attempt = fromContext("attempt", 1);
  if (!Number.isSafeInteger(out.attempt) || out.attempt < 1 || out.attempt > 1_000_000) {
    throw fail("audit_event_invalid", { reason: "attempt", field: "attempt" });
  }

  const targets = {};
  for (const field of CONTEXT_TARGET_FIELDS) {
    const value = raw[field] === undefined || raw[field] === null ? contextField(field) : raw[field];
    if (value !== undefined && value !== null) targets[field] = value;
  }
  try {
    checkTargets(targets, out);
  } catch {
    throw fail("audit_event_invalid", { reason: "target" });
  }

  if (raw.correlation !== undefined && raw.correlation !== null) {
    if (!isDigest(raw.correlation)) throw fail("audit_event_invalid", { reason: "correlation", field: "correlation" });
    out.correlation = raw.correlation;
  } else if (contextField("correlation")) {
    out.correlation = contextField("correlation");
  }

  out.eventId = server.eventId;
  out.databaseInstanceId = server.databaseInstanceId;
  out.occurredAt = server.occurredAt;
  return out;
}

/** 服务端生成字段：eventId / occurredAt / 实例 ID 由存储层生成，调用方不得提供。 */
export function serverEventFields(databaseInstanceId) {
  return {
    eventId: randomUUID(),
    databaseInstanceId,
    occurredAt: new Date().toISOString(),
  };
}

// ------------------------------------------------------------------ 失败映射
/**
 * 错误码 → (outcome, resultCode, reasonCode) 的**精确**映射。
 * 未登记的错误码（包括看起来像英文的错误码）一律 `failed / internal_error`，绝不透传原文。
 */
const FAILURE_MAP = Object.freeze({
  account_set_not_found: ["rejected", "not_found", "account_set_not_found"],
  voucher_not_found: ["rejected", "not_found", "voucher_not_found"],
  period_not_found: ["rejected", "not_found", "period_not_found"],
  account_not_found: ["rejected", "not_found", "account_not_found"],
  batch_not_found: ["rejected", "not_found", "batch_not_found"],
  period_closed: ["rejected", "blocked_period_closed", "period_closed"],
  opening_rewrite_period_closed: ["rejected", "blocked_period_closed", "opening_rewrite_period_closed"],
  opening_rewrite_after_posting: ["rejected", "rejected", "opening_rewrite_after_posting"],
  posted_voucher_requires_unpost: ["rejected", "rejected", "posted_voucher_requires_unpost"],
  period_has_draft_vouchers: ["rejected", "rejected", "period_has_draft_vouchers"],
  period_unbalanced: ["rejected", "rejected", "period_unbalanced"],
  opening_unbalanced: ["rejected", "rejected", "opening_unbalanced"],
  already_carried_forward: ["rejected", "rejected", "already_carried_forward"],
  already_year_end_carried: ["rejected", "rejected", "already_year_end_carried"],
  asset_has_depreciation_runs: ["rejected", "rejected", "asset_has_depreciation_runs"],
  depreciation_draft_exists: ["rejected", "rejected", "depreciation_draft_exists"],
  depreciation_exceeds_depreciable: ["rejected", "rejected", "depreciation_exceeds_depreciable"],
  voucher_number_conflict: ["rejected", "conflict", "voucher_number_conflict"],
  voucher_number_unplanned: ["rejected", "conflict", "voucher_number_unplanned"],
  audit_event_conflict: ["rejected", "conflict", "audit_event_conflict"],
  audit_event_invalid: ["rejected", "rejected_validation", "audit_event_invalid"],
  audit_transaction_required: ["failed", "audit_unavailable", "audit_transaction_required"],
  audit_unavailable: ["failed", "audit_unavailable", "audit_unavailable"],
  audit_write_failed: ["failed", "audit_unavailable", "audit_write_failed"],
  audit_commit_unknown: ["unknown", "unknown", "audit_commit_unknown"],
  audit_schema_inconsistent: ["failed", "audit_schema_rejected", "audit_schema_inconsistent"],
  audit_schema_newer: ["failed", "audit_schema_rejected", "audit_schema_newer"],
  audit_schema_install_failed: ["failed", "audit_schema_rejected", "audit_schema_install_failed"],
  audit_database_missing: ["rejected", "not_found", "audit_database_missing"],
  audit_database_invalid: ["failed", "audit_schema_rejected", "audit_database_invalid"],
  audit_install_requires_verified_backup: ["rejected", "audit_install_refused", "audit_install_requires_verified_backup"],
});

/**
 * 把异常归一成固定 (outcome, resultCode, reasonCode)。
 * **不读取** e.message / e.stack / e.details，避免原始文本进入审计或返回值。
 */
export function classifyFailure(error) {
  const rawCode = error && typeof error === "object" ? error.code : undefined;
  if (typeof rawCode === "string" && Object.prototype.hasOwnProperty.call(FAILURE_MAP, rawCode)) {
    const [outcome, resultCode, reasonCode] = FAILURE_MAP[rawCode];
    return { outcome, resultCode, reasonCode };
  }
  return { outcome: "failed", resultCode: "internal_error", reasonCode: "internal_error" };
}

// ------------------------------------------------------------------ 事务协调
/**
 * 是否已处于事务中（node:sqlite 的 `isTransaction`）。
 * 嵌套调用必须用 SAVEPOINT：SQLite 不支持嵌套 BEGIN。
 */
export function inTransaction(db) {
  if (!db || typeof db.exec !== "function") throw fail("audit_operation_invalid", { field: "db" });
  return db.isTransaction === true;
}

let savepointSeq = 0;

/**
 * 在最外层开启 BEGIN IMMEDIATE；已在外层事务中则改用 SAVEPOINT。
 * 返回 `{ result, owner }`：owner=true 表示本次调用拥有最外层事务（提交 / 回滚由它负责）。
 *
 * 注意：**不**用第二个连接绕开写锁；嵌套语义一律 SAVEPOINT。
 */
export function runInTransaction(db, fn) {
  if (typeof fn !== "function") throw fail("audit_operation_invalid", { field: "fn" });
  if (inTransaction(db)) {
    const sp = `audit_sp_${++savepointSeq}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      return { result, owner: false };
    } catch (e) {
      try {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
      } catch { /* 保留原始异常 */ }
      throw e;
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return { result, owner: true };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* 保留原始异常 */ }
    throw e;
  }
}
