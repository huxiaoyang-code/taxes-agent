// local-audit-storage.mjs — LOCAL-06 业务库审计组件（A 包，仅原语 / 只读查询，不含任何领域接线）。
//
// 结构：
//   audit_components         组件名 → 结构版本（与 LOCAL-02 全局 schema 版本相互独立）
//   audit_database_instances 数据库实例（恢复分叉时新实例记录父实例，旧历史事件不改写）
//   audit_events             append-only 事件（无外键，业务对象删除后留痕仍在）
//
// 设计约束：
//   1) 所有函数显式接收 `DatabaseSync` 句柄；本文件不 import `db.mjs`、不打开默认库、不创建目录。
//   2) 事件只存白名单字段（技术 ID / 固定词表 / 服务端哈希令牌），不存金额、原始凭证、摘要、姓名、
//      企业身份、路径、payload、SQL、堆栈、异常 message 或任意 metadata JSON。
//   3) 成功事件必须写进**外层业务事务**再提交；本模块的 append 不开独立事务。
//      失败 / 拒绝事件在业务回滚**之后**由 `runAuditedOperation` 用短事务补写。
//      写不进审计时抛 `audit_unavailable`，绝不把业务结果报成完整成功。
//   4) 已有业务库的组件安装：A 包**明确拒绝**（缺已审 backup 支持），见
//      `audit_install_requires_verified_backup`；B 包在已审 backup 支持到位后接安装流程。
//      「新库」判定来自对库内实际对象的观察（无任何非审计表），不接受调用方布尔值。
//   5) 跨库（业务库 ↔ 恢复 ledger）不假装原子；恢复 ledger 见 `local-restore-audit.mjs`。

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTORS,
  AUDIT_COMPONENT,
  AUDIT_OUTCOMES,
  AUDIT_RESULT_CODES,
  AUDIT_SCHEMA_VERSION,
  AUDIT_EVENT_OVERRIDABLE_FIELDS,
  AuditError,
  AuditUnavailableError,
  auditError as fail,
  auditEventDedupeKey,
  auditEventDigest,
  classifyFailure,
  contextTargets,
  createOperationContext,
  inTransaction,
  isAuditPeriod,
  isTechId,
  isTechnicalRowId,
  normalizeAuditEvent,
  runInTransaction,
  serverEventFields,
} from "./local-audit.mjs";

/** 本组件创建的持久对象（供自检 / 只读检查 / 结构拒绝使用）。 */
export const AUDIT_TABLES = Object.freeze([
  "audit_components",
  "audit_database_instances",
  "audit_events",
]);
export const AUDIT_TRIGGERS = Object.freeze([
  "audit_events_no_update",
  "audit_events_no_delete",
]);

const OUTCOME_CHECK = `('succeeded','rejected','failed','no_change','replayed','interrupted','unknown')`;

const V1_STATEMENTS = Object.freeze([
  `CREATE TABLE audit_components (
     component TEXT PRIMARY KEY,
     version INTEGER NOT NULL,
     installed_at TEXT NOT NULL,
     note TEXT
   )`,
  `CREATE TABLE audit_database_instances (
     instance_id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     parent_instance_id TEXT,
     is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
     note TEXT
   )`,
  `CREATE UNIQUE INDEX idx_audit_instances_active
     ON audit_database_instances (is_active) WHERE is_active = 1`,
  `CREATE TABLE audit_events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id TEXT NOT NULL UNIQUE,
     dedupe_key TEXT NOT NULL UNIQUE,
     database_instance_id TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     action TEXT NOT NULL,
     outcome TEXT NOT NULL CHECK (outcome IN ${OUTCOME_CHECK}),
     result_code TEXT NOT NULL,
     reason_code TEXT NOT NULL DEFAULT 'none',
     actor TEXT NOT NULL,
     operation_id TEXT NOT NULL,
     parent_operation_id TEXT,
     attempt INTEGER NOT NULL CHECK (attempt >= 1),
     account_set_id INTEGER,
     voucher_id INTEGER,
     period TEXT CHECK (period IS NULL OR period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
     job_id TEXT,
     item_id TEXT,
     stage_id TEXT,
     correlation TEXT,
     content_digest TEXT NOT NULL
   )`,
  `CREATE INDEX idx_audit_events_scope ON audit_events (account_set_id, seq)`,
  `CREATE INDEX idx_audit_events_operation ON audit_events (operation_id, attempt, seq)`,
  `CREATE INDEX idx_audit_events_action ON audit_events (action, seq)`,
  `CREATE INDEX idx_audit_events_period ON audit_events (period, seq)`,
  // append-only：审计行不允许被改写 / 删除（业务对象删除不影响这些行，因为事件本身没有外键）。
  `CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
     BEGIN SELECT RAISE(ABORT, 'audit_events_append_only'); END`,
  `CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
     BEGIN SELECT RAISE(ABORT, 'audit_events_append_only'); END`,
]);

const MIGRATIONS = Object.freeze([
  { version: 1, note: "LOCAL-06 业务审计组件：实例 / append-only 事件 / 组件版本", steps: V1_STATEMENTS },
]);

// ------------------------------------------------------------------ 只读结构检查
const listTables = (db) =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => r.name);

const listTriggers = (db) =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`).all().map((r) => r.name);

const tableExists = (db, name) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);

/**
 * 只读检查审计组件状态。**不创建任何对象、不写库**。
 * @returns {{tables:string[], present:string[], installed:boolean, version:number, target:number, activeInstanceId:string|null}}
 */
export function inspectAuditSchema(db) {
  const tables = listTables(db);
  const present = AUDIT_TABLES.filter((name) => tables.includes(name));
  let version = 0;
  let activeInstanceId = null;
  if (present.includes("audit_components")) {
    const row = db.prepare(`SELECT version FROM audit_components WHERE component=?`).get(AUDIT_COMPONENT);
    if (row && Number.isSafeInteger(Number(row.version))) version = Number(row.version);
  }
  if (present.includes("audit_database_instances")) {
    const row = db.prepare(`SELECT instance_id FROM audit_database_instances WHERE is_active=1`).get();
    if (row) activeInstanceId = String(row.instance_id);
  }
  return {
    tables,
    present,
    installed: present.length === AUDIT_TABLES.length,
    version,
    target: AUDIT_SCHEMA_VERSION,
    activeInstanceId,
  };
}

/** 当前活动数据库实例 ID（恢复分叉后指向分叉实例）。 */
export function currentAuditInstanceId(db) {
  const row = db.prepare(`SELECT instance_id FROM audit_database_instances WHERE is_active=1`).get();
  if (!row) throw fail("audit_schema_inconsistent", { reason: "no_active_instance" });
  return String(row.instance_id);
}

function assertInstalledSchema(db) {  const state = inspectAuditSchema(db);
  if (state.present.length !== AUDIT_TABLES.length) {
    throw fail("audit_schema_inconsistent", { reason: "missing_tables", tableCount: state.present.length });
  }
  if (state.version !== AUDIT_SCHEMA_VERSION) {
    throw fail(state.version > AUDIT_SCHEMA_VERSION ? "audit_schema_newer" : "audit_schema_inconsistent", {
      reason: "version", version: state.version, target: AUDIT_SCHEMA_VERSION,
    });
  }
  if (!state.activeInstanceId) throw fail("audit_schema_inconsistent", { reason: "no_active_instance" });
  const triggers = listTriggers(db);
  if (!AUDIT_TRIGGERS.every((name) => triggers.includes(name))) {
    throw fail("audit_schema_inconsistent", { reason: "missing_triggers" });
  }
  return state;
}

/** 只读断言：审计组件已安装且版本 / 触发器 / 活动实例一致（不建表、不写库）。 */
export function assertAuditSchema(db) {
  return assertInstalledSchema(db);
}

/**
 * 受保护的组件初始化。
 *
 * - 空库（无任何非审计表）→ 在单事务内建立结构，并在事务内自检；失败整体回滚，不留半截对象。
 * - 已装且版本一致 → `{ installed: false, ... }`，不重复建表、不重复写版本。
 * - 已装但缺表 / 缺版本 / 版本更高 → 固定错误码拒绝（不静默「修复」）。
 * - **含其他业务表的既有库 → A 包拒绝安装**（`audit_install_requires_verified_backup`）。
 *   该判定只看库内实际对象，调用方无法用布尔值绕过；B 包接入已审 backup 后再放开。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ faultInjection?: (db:object) => void }} [options] faultInjection 仅供测试注入故障
 */
export function ensureAuditSchema(db, options = {}) {
  if (!db || typeof db.exec !== "function") throw fail("audit_operation_invalid", { field: "db" });
  const state = inspectAuditSchema(db);
  if (state.present.length) {
    if (state.present.length !== AUDIT_TABLES.length) {
      throw fail("audit_schema_inconsistent", { reason: "partial_tables", tableCount: state.present.length });
    }
    assertInstalledSchema(db);
    return { installed: false, from: state.version, to: state.version, activeInstanceId: state.activeInstanceId };
  }

  const foreignTables = state.tables.filter((name) => !AUDIT_TABLES.includes(name));
  if (foreignTables.length) {
    // A 包没有已审 backup 支持：对既有业务库**明确拒绝**，不声称已完成现库升级。
    throw fail("audit_install_requires_verified_backup", {
      reason: "existing_database",
      foreignTableCount: foreignTables.length,
      foreignTables,
    });
  }

  const from = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of MIGRATIONS) {
      for (const step of migration.steps) db.exec(step);
      db.prepare(`INSERT INTO audit_components (component, version, installed_at, note) VALUES (?,?,?,?)`)
        .run(AUDIT_COMPONENT, migration.version, new Date().toISOString(), migration.note);
    }
    db.prepare(`INSERT INTO audit_database_instances (instance_id, created_at, parent_instance_id, is_active, note)
                VALUES (?,?,?,?,?)`)
      .run(randomUUID(), new Date().toISOString(), null, 1, "initial");

    // 事务内自检：结构、版本、活动实例都必须成立，否则整体回滚。
    const check = inspectAuditSchema(db);
    if (check.present.length !== AUDIT_TABLES.length || check.version !== AUDIT_SCHEMA_VERSION) {
      throw fail("audit_schema_install_failed", { reason: "self_check" });
    }
    if (typeof options.faultInjection === "function") options.faultInjection(db);
    db.exec("COMMIT");
    return { installed: true, from, to: AUDIT_SCHEMA_VERSION, activeInstanceId: currentAuditInstanceId(db) };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* 保留原始异常 */ }
    if (e instanceof AuditError && e.code === "audit_schema_install_failed") throw e;
    throw fail("audit_schema_install_failed", { reason: "rollback", from, to: AUDIT_SCHEMA_VERSION });
  }
}

/**
 * 显式路径打开业务库（**没有**默认路径 / 默认数据目录）。
 * readOnly=true 时缺文件不创建、直接给 `audit_database_missing`。
 */
export function openAuditDatabase(path, { readOnly = true } = {}) {
  if (typeof path !== "string" || !path.trim()) throw fail("audit_operation_invalid", { field: "path" });
  if (readOnly && !existsSync(path)) throw fail("audit_database_missing", { readOnly: true });
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: readOnly === true });
    // 打开是惰性的；先做一次只读探测，把「不是数据库 / 已损坏」与「未安装」分开。
    db.prepare(`SELECT name FROM sqlite_master LIMIT 1`).all();
  } catch (e) {
    try { db?.close(); } catch { /* ignore */ }
    throw fail("audit_database_invalid", { reason: "not_a_database" });
  }
  return db;
}

// ------------------------------------------------------------------ 事件写入
const EVENT_COLUMNS = `seq, event_id, database_instance_id, occurred_at, action, outcome, result_code,
  reason_code, actor, operation_id, parent_operation_id, attempt, account_set_id, voucher_id, period,
  job_id, item_id, stage_id, correlation, content_digest`;

const toEventDto = (row) => ({
  seq: Number(row.seq),
  eventId: row.event_id,
  databaseInstanceId: row.database_instance_id,
  occurredAt: row.occurred_at,
  action: row.action,
  outcome: row.outcome,
  resultCode: row.result_code,
  reasonCode: row.reason_code,
  actor: row.actor,
  operationId: row.operation_id,
  parentOperationId: row.parent_operation_id ?? null,
  attempt: Number(row.attempt),
  accountSetId: row.account_set_id === null ? null : Number(row.account_set_id),
  voucherId: row.voucher_id === null ? null : Number(row.voucher_id),
  period: row.period ?? null,
  jobId: row.job_id ?? null,
  itemId: row.item_id ?? null,
  stageId: row.stage_id ?? null,
  correlation: row.correlation ?? null,
  contentDigest: row.content_digest,
});

const comparableOfRow = (row) => JSON.stringify([
  row.outcome, row.result_code, row.reason_code, row.parent_operation_id ?? null,
]);
const comparableOfEvent = (event) => JSON.stringify([
  event.outcome, event.resultCode, event.reasonCode, event.parentOperationId ?? null,
]);

/**
 * 在**调用方事务内**追加一条事件（本函数不开事务、不提交）。
 *
 * 去重语义：同一 operation / attempt / action / 范围目标 / 关联令牌 的相同事件只保留一条，
 * 重复调用返回 `{ appended: false, event }`；键相同而 outcome / resultCode / reasonCode /
 * 父操作不同 → `audit_event_conflict`，绝不用 INSERT OR IGNORE 掩盖不一致。
 *
 * 写不进去（IO / 锁 / 触发器 RAISE 等）→ `AuditUnavailableError('audit_unavailable')`。
 */
export function appendAuditEvent(db, raw, { context = null } = {}) {
  if (!db || typeof db.prepare !== "function") throw fail("audit_operation_invalid", { field: "db" });
  // 成功事件必须写进调用方的外层业务事务：独立自动提交会破坏「业务与审计同一事务」语义。
  if (!inTransaction(db)) throw fail("audit_transaction_required", { reason: "append_outside_transaction" });
  if (context !== null) createOperationContext(context); // 上下文格式错误时提前失败
  const instanceId = currentAuditInstanceId(db);
  const event = normalizeAuditEvent(raw, context, serverEventFields(instanceId));
  const dedupeKey = auditEventDedupeKey(event);
  const digest = auditEventDigest(event);

  const findExisting = db.prepare(`SELECT ${EVENT_COLUMNS} FROM audit_events WHERE dedupe_key=?`);
  const existing = findExisting.get(dedupeKey);
  if (existing) {
    if (comparableOfRow(existing) !== comparableOfEvent(event)) {
      throw fail("audit_event_conflict", { reason: "dedupe_key_reused_with_different_data" });
    }
    return { appended: false, event: toEventDto(existing) };
  }

  try {
    db.prepare(`INSERT INTO audit_events
                  (event_id, dedupe_key, database_instance_id, occurred_at, action, outcome, result_code,
                   reason_code, actor, operation_id, parent_operation_id, attempt, account_set_id, voucher_id,
                   period, job_id, item_id, stage_id, correlation, content_digest)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        event.eventId, dedupeKey, event.databaseInstanceId, event.occurredAt, event.action, event.outcome,
        event.resultCode, event.reasonCode, event.actor, event.operationId, event.parentOperationId ?? null,
        event.attempt, event.accountSetId ?? null, event.voucherId ?? null, event.period ?? null,
        event.jobId ?? null, event.itemId ?? null, event.stageId ?? null, event.correlation ?? null, digest,
      );
  } catch (e) {
    // 并发写入同一去重键：唯一约束失败后重读判断是「同一事件」还是「同键不同数据」。
    const raced = findExisting.get(dedupeKey);
    if (raced) {
      if (comparableOfRow(raced) !== comparableOfEvent(event)) {
        throw fail("audit_event_conflict", { reason: "dedupe_key_reused_with_different_data" });
      }
      return { appended: false, event: toEventDto(raced) };
    }
    throw new AuditUnavailableError("audit_unavailable", { cause: e });
  }

  const saved = findExisting.get(dedupeKey);
  return { appended: true, event: toEventDto(saved) };
}

// ------------------------------------------------------------------ 只读查询
const FILTER_KEYS = Object.freeze([
  "action",
  "outcome",
  "resultCode",
  "actor",
  "operationId",
  "accountSetId",
  "voucherId",
  "period",
  "jobId",
  "itemId",
  "afterSeq",
  "limit",
]);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const requireTechIdFilter = (value, field) => {
  if (!isTechId(value)) throw fail("audit_filter_invalid", { field });
  return value;
};

/**
 * 只读分页查询（**只读**：不改库、不建库）。
 *
 * 过滤条件全部参数化；排序固定为 `seq ASC`，游标 `afterSeq` 稳定（无重复、无遗漏）。
 * 非法过滤值 → `audit_filter_invalid`（不回显原始值，避免注入串或敏感哨兵被回显）。
 *
 * @returns {{events:object[], nextCursor:number|null, hasMore:boolean}}
 */
export function queryAuditEvents(db, filter = {}) {
  if (!db || typeof db.prepare !== "function") throw fail("audit_operation_invalid", { field: "db" });
  assertInstalledSchema(db);
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw fail("audit_filter_invalid", { field: "filter" });
  }
  let unknown = 0;
  for (const key of Object.keys(filter)) if (!FILTER_KEYS.includes(key)) unknown += 1;
  if (unknown) throw fail("audit_filter_invalid", { field: "unknown", count: unknown });

  const where = [];
  const params = [];
  const eq = (column, value) => {
    where.push(`${column} = ?`);
    params.push(value);
  };

  if (filter.action !== undefined && filter.action !== null) {
    if (!ACTION_SET.has(filter.action)) throw fail("audit_filter_invalid", { field: "action" });
    eq("action", filter.action);
  }
  if (filter.outcome !== undefined && filter.outcome !== null) {
    if (!OUTCOME_SET.has(filter.outcome)) throw fail("audit_filter_invalid", { field: "outcome" });
    eq("outcome", filter.outcome);
  }
  if (filter.resultCode !== undefined && filter.resultCode !== null) {
    if (!RESULT_CODE_SET.has(filter.resultCode)) throw fail("audit_filter_invalid", { field: "resultCode" });
    eq("result_code", filter.resultCode);
  }
  if (filter.actor !== undefined && filter.actor !== null) {
    if (!ACTOR_SET.has(filter.actor)) throw fail("audit_filter_invalid", { field: "actor" });
    eq("actor", filter.actor);
  }
  if (filter.operationId !== undefined && filter.operationId !== null) {
    requireTechIdFilter(filter.operationId, "operationId");
    eq("operation_id", filter.operationId);
  }
  if (filter.accountSetId !== undefined && filter.accountSetId !== null) {
    if (!isTechnicalRowId(filter.accountSetId)) throw fail("audit_filter_invalid", { field: "accountSetId" });
    eq("account_set_id", filter.accountSetId);
  }
  if (filter.voucherId !== undefined && filter.voucherId !== null) {
    if (!isTechnicalRowId(filter.voucherId)) throw fail("audit_filter_invalid", { field: "voucherId" });
    eq("voucher_id", filter.voucherId);
  }
  if (filter.period !== undefined && filter.period !== null) {
    if (!isAuditPeriod(filter.period)) throw fail("audit_filter_invalid", { field: "period" });
    eq("period", filter.period);
  }
  for (const [field, column] of [["jobId", "job_id"], ["itemId", "item_id"]]) {
    if (filter[field] === undefined || filter[field] === null) continue;
    requireTechIdFilter(filter[field], field);
    eq(column, filter[field]);
  }

  let afterSeq = 0;
  if (filter.afterSeq !== undefined && filter.afterSeq !== null) {
    if (!Number.isSafeInteger(filter.afterSeq) || filter.afterSeq < 0) {
      throw fail("audit_filter_invalid", { field: "afterSeq" });
    }
    afterSeq = filter.afterSeq;
  }
  if (afterSeq > 0) {
    where.push("seq > ?");
    params.push(afterSeq);
  }

  let limit = DEFAULT_LIMIT;
  if (filter.limit !== undefined && filter.limit !== null) {
    if (!Number.isSafeInteger(filter.limit) || filter.limit < 1) {
      throw fail("audit_filter_invalid", { field: "limit" });
    }
    if (filter.limit > MAX_LIMIT) throw fail("audit_filter_invalid", { field: "limit", max: MAX_LIMIT });
    limit = filter.limit;
  }

  const sql = `SELECT ${EVENT_COLUMNS} FROM audit_events
               ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY seq ASC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit + 1);
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit).map(toEventDto);
  return {
    events,
    nextCursor: events.length ? events[events.length - 1].seq : null,
    hasMore,
  };
}

const ACTION_SET = new Set(AUDIT_ACTIONS);
const OUTCOME_SET = new Set(AUDIT_OUTCOMES);
const ACTOR_SET = new Set(AUDIT_ACTORS);
const RESULT_CODE_SET = new Set(AUDIT_RESULT_CODES);

/** 单条事件（只读）；不存在返回 null。 */
export function getAuditEvent(db, { eventId, seq } = {}) {
  assertInstalledSchema(db);
  if (typeof eventId === "string" && eventId) {
    const row = db.prepare(`SELECT ${EVENT_COLUMNS} FROM audit_events WHERE event_id=?`).get(eventId);
    return row ? toEventDto(row) : null;
  }
  if (Number.isSafeInteger(seq) && seq > 0) {
    const row = db.prepare(`SELECT ${EVENT_COLUMNS} FROM audit_events WHERE seq=?`).get(seq);
    return row ? toEventDto(row) : null;
  }
  throw fail("audit_filter_invalid", { field: "eventId" });
}

/** 只读计数（按 action / outcome 聚合；不含任何业务内容）。 */
export function auditEventStats(db) {
  assertInstalledSchema(db);
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM audit_events`).get()?.n ?? 0);
  const byAction = db.prepare(`SELECT action, COUNT(*) AS n FROM audit_events GROUP BY action ORDER BY action`)
    .all().map((r) => ({ action: r.action, count: Number(r.n) }));
  const byOutcome = db.prepare(`SELECT outcome, COUNT(*) AS n FROM audit_events GROUP BY outcome ORDER BY outcome`)
    .all().map((r) => ({ outcome: r.outcome, count: Number(r.n) }));
  return { total, byAction, byOutcome };
}

/** 只读完整性自检：重算 content_digest，返回不匹配的 seq（空数组 = 全部一致）。 */
export function verifyAuditEvents(db) {
  assertInstalledSchema(db);
  const rows = db.prepare(`SELECT ${EVENT_COLUMNS} FROM audit_events ORDER BY seq`).all();
  const mismatched = [];
  for (const row of rows) {
    const dto = toEventDto(row);
    if (auditEventDigest({
      databaseInstanceId: dto.databaseInstanceId,
      occurredAt: dto.occurredAt,
      action: dto.action,
      outcome: dto.outcome,
      resultCode: dto.resultCode,
      reasonCode: dto.reasonCode,
      actor: dto.actor,
      operationId: dto.operationId,
      parentOperationId: dto.parentOperationId,
      attempt: dto.attempt,
      accountSetId: dto.accountSetId,
      voucherId: dto.voucherId,
      period: dto.period,
      jobId: dto.jobId,
      itemId: dto.itemId,
      stageId: dto.stageId,
      correlation: dto.correlation,
    }) !== dto.contentDigest) mismatched.push(dto.seq);
  }
  return { checked: rows.length, mismatched };
}

// ------------------------------------------------------------------ 恢复分叉实例
/**
 * 恢复出「同一快照的另一个副本」时登记新实例：旧实例历史事件原样保留（不改写），
 * 新副本的**未来**事件使用新 instance ID，并记录父实例关系。
 * 同一父实例重复调用是幂等的（崩溃重试不会产生两个分叉实例）。
 */
export function markAuditInstanceFork(db, { parentInstanceId, note = "restore-new" } = {}) {
  if (!isTechId(parentInstanceId)) throw fail("audit_operation_invalid", { field: "parentInstanceId" });
  if (typeof note !== "string" || note.length > 64) throw fail("audit_operation_invalid", { field: "note" });
  return runInTransaction(db, () => {
    const active = currentAuditInstanceId(db);
    if (active !== parentInstanceId) {
      const child = db.prepare(`SELECT instance_id FROM audit_database_instances
                                 WHERE parent_instance_id=? AND is_active=1`).get(parentInstanceId);
      if (child && String(child.instance_id) === active) {
        return { instanceId: active, parentInstanceId, created: false };
      }
      throw fail("audit_instance_conflict", { reason: "active_instance_mismatch" });
    }
    const instanceId = randomUUID();
    db.prepare(`UPDATE audit_database_instances SET is_active=0 WHERE instance_id=?`).run(parentInstanceId);
    db.prepare(`INSERT INTO audit_database_instances (instance_id, created_at, parent_instance_id, is_active, note)
                VALUES (?,?,?,?,?)`)
      .run(instanceId, new Date().toISOString(), parentInstanceId, 1, note);
    return { instanceId, parentInstanceId, created: true };
  }).result;
}

/** 只读实例列表（分叉链；不返回任何业务内容）。 */
export function listAuditInstances(db) {
  assertInstalledSchema(db);
  return db.prepare(`SELECT instance_id, created_at, parent_instance_id, is_active FROM audit_database_instances
                     ORDER BY created_at, instance_id`).all().map((r) => ({
    instanceId: r.instance_id,
    createdAt: r.created_at,
    parentInstanceId: r.parent_instance_id ?? null,
    isActive: Number(r.is_active) === 1,
  }));
}

// ------------------------------------------------------------------ 受控执行（事务 + 失败兜底）
const TERMINAL_KEYS = Object.freeze([
  "outcome",
  "resultCode",
  "reasonCode",
  ...AUDIT_EVENT_OVERRIDABLE_FIELDS,
]);

/** 失败事件规格：固定映射，不含原始异常文本。 */
function failureSpec(context, error) {
  const mapped = classifyFailure(error);
  return { ...contextTargets(context), ...mapped };
}

/**
 * 在**最外层业务事务**内受控执行一次领域动作并落审计。
 *
 * 成功路径：`fn(audit)` 完成业务写入 → 写终态事件（仍在同一事务内）→ 提交（嵌套时 RELEASE SAVEPOINT）。
 * 失败路径：先回滚本层（最外层 = ROLLBACK；嵌套 = ROLLBACK TO SAVEPOINT，**不**在尚未回滚的外层里
 * 写「持久失败」），最外层再用短事务补写固定失败事件；补写失败抛 `audit_unavailable`。
 * 嵌套失败把待写失败事件挂在 `error.auditFailurePending` 上，由最外层执行者回滚后调用
 * `appendDeferredFailure(db, error)` 落库。
 *
 * 提交结果不明确（COMMIT / RELEASE 抛错）：抛 `AuditUnavailableError('audit_commit_unknown')`，
 * **不伪造** succeeded，也不把失败事件写成「业务已回滚」。
 *
 * @param {object} db 显式 DatabaseSync 句柄
 * @param {{context:object, terminal:object}} operation context=createOperationContext(...)；
 *        terminal={outcome,resultCode,reasonCode?,...范围覆盖}
 * @param {(audit:{append:Function, context:object}) => any} fn
 * @param {{testHooks?:{beforeCommit?:Function, commit?:Function}}} [options] testHooks 仅供测试注入提交故障
 */
export function runAuditedOperation(db, operation, fn, options = {}) {
  if (!db || typeof db.exec !== "function") throw fail("audit_operation_invalid", { field: "db" });
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw fail("audit_operation_invalid", { field: "operation" });
  }
  const context = createOperationContext(operation.context);
  const terminal = operation.terminal;
  if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)) {
    throw fail("audit_event_invalid", { reason: "terminal_required" });
  }
  let unknown = 0;
  for (const key of Object.keys(terminal)) if (!TERMINAL_KEYS.includes(key)) unknown += 1;
  if (unknown) throw fail("audit_event_invalid", { reason: "unknown_field", unknownFieldCount: unknown });
  if (typeof fn !== "function") throw fail("audit_operation_invalid", { field: "fn" });

  const append = (fields = {}) => {
    for (const key of Object.keys(fields)) {
      if (key === "outcome" || key === "resultCode" || key === "reasonCode") continue;
      if (!AUDIT_EVENT_OVERRIDABLE_FIELDS.includes(key)) {
        throw fail("audit_event_field_not_overridable", { field: "other" });
      }
    }
    return appendAuditEvent(db, { ...contextTargets(context), ...fields }, { context });
  };

  const owner = !inTransaction(db);
  const savepoint = owner ? null : `audit_op_sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  if (owner) db.exec("BEGIN IMMEDIATE");
  else db.exec(`SAVEPOINT ${savepoint}`);

  const rollbackOwnLevel = () => {
    if (owner) {
      db.exec("ROLLBACK");
      return true;
    }
    db.exec(`ROLLBACK TO ${savepoint}`);
    db.exec(`RELEASE ${savepoint}`);
    return true;
  };

  const handleBusinessFailure = (businessError, spec) => {
    let rolledBack = false;
    try { rolledBack = rollbackOwnLevel(); } catch { rolledBack = false; }
    if (!rolledBack) {
      // 回滚本身失败：业务结果未知，不能写「已回滚」的失败事件，也不能报成功。
      throw new AuditUnavailableError("audit_commit_unknown", { cause: businessError });
    }
    if (!owner) {
      // 嵌套：外层事务尚未回滚，不能在里面写「持久失败」；交给最外层执行者。
      try {
        Object.defineProperty(businessError, "auditFailurePending", {
          value: { context, spec }, enumerable: false, configurable: true, writable: true,
        });
      } catch { /* 冻结的异常对象仍会原样抛出 */ }
      throw businessError;
    }
    return writeFailureOrThrow(db, context, spec, businessError);
  };

  let result;
  let appended;
  try {
    result = fn({ append, context });
  } catch (businessError) {
    return handleBusinessFailure(businessError, failureSpec(context, businessError));
  }
  try {
    appended = append(terminal);
  } catch (eventError) {
    // 终态事件写不进：业务必须回滚，绝不能先提交业务再补写成功。
    const auditFailure = new AuditUnavailableError("audit_write_failed", {
      cause: eventError, businessError: eventError,
    });
    auditFailure.businessRolledBack = true;
    auditFailure.successEventPersisted = false;
    return handleBusinessFailure(auditFailure, failureSpec(context, auditFailure));
  }

  const commit = () => {
    if (typeof options.testHooks?.commit === "function") options.testHooks.commit(db);
    else if (owner) db.exec("COMMIT");
    else db.exec(`RELEASE ${savepoint}`);
  };
  try {
    if (typeof options.testHooks?.beforeCommit === "function") options.testHooks.beforeCommit(db);
    commit();
  } catch (commitError) {
    // 提交结果不明确：不能声称已回滚，也不能伪造 succeeded。
    try { rollbackOwnLevel(); } catch { /* 结果仍不明确 */ }
    throw new AuditUnavailableError("audit_commit_unknown", { cause: commitError });
  }

  return { result, event: appended.event, appended: appended.appended };
}

function writeFailureOrThrow(db, context, spec, businessError) {
  let written;
  try {
    written = runInTransaction(db, () => appendAuditEvent(db, spec, { context })).result;
  } catch (writeError) {
    if (writeError && writeError.code === "audit_event_conflict") {
      // 同一 operation/attempt 的去重键已被不同数据占用：这是生产者错误，必须可见，不能报成功。
      const conflict = fail("audit_event_conflict", { reason: "failure_event_key_reused" });
      conflict.businessError = businessError;
      throw conflict;
    }
    const unavailable = new AuditUnavailableError("audit_unavailable", { cause: writeError, businessError });
    if (businessError && businessError.businessRolledBack === true) unavailable.businessRolledBack = true;
    throw unavailable;
  }
  try {
    Object.defineProperty(businessError, "auditEvent", {
      value: written.event, enumerable: false, configurable: true, writable: true,
    });
    Object.defineProperty(businessError, "auditPersisted", {
      value: true, enumerable: false, configurable: true, writable: true,
    });
  } catch { /* 忽略不可写异常对象 */ }
  throw businessError;
}

/**
 * 最外层执行者在**自己回滚之后**补写嵌套调用遗留的失败事件。
 * 没有待写事件时返回 null；补写失败抛 `audit_unavailable`。
 */
export function appendDeferredFailure(db, error) {
  const pending = error && typeof error === "object" ? error.auditFailurePending : null;
  if (!pending) return null;
  try {
    const written = runInTransaction(db, () => appendAuditEvent(db, pending.spec, { context: pending.context })).result;
    try {
      Object.defineProperty(error, "auditPersisted", { value: true, enumerable: false, configurable: true, writable: true });
    } catch { /* ignore */ }
    return written.event;
  } catch (writeError) {
    throw new AuditUnavailableError("audit_unavailable", { cause: writeError, businessError: error });
  }
}
