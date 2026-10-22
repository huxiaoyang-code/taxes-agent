// local-restore-audit.mjs — LOCAL-06 恢复操作 ledger（A 包，仅原语 / 只读查询，不含 restore-new 接线）。
//
// 为什么要独立 ledger：恢复失败时**目标库可能根本不可用**，恢复动作不能只记进将被恢复的业务库；
// 恢复 ledger 是显式路径的独立 SQLite（无默认库、无默认目录、无原始路径 / 业务内容）。
//
// 边界（必须遵守）：
//   1) 调用方显式提供 ledger 路径，并自行放于「备份 / 目标目录之外」；本模块不猜路径、不扫目录。
//   2) ledger 与业务库是**两个数据库**：本模块不假装跨库原子提交。业务库里的审计事件与此处 ledger
//      行只能是「两阶段 + 可对账（reconcile）」关系。
//   3) 终态不可伪造：
//      - `succeeded` 只能从 `prepared` 迁移，且必须同时满足 operationId / receipt / backupDigest 一致；
//      - 缺证据（started）或证据不一致一律拒绝；reconcile 证据不足时不改状态、不猜终态；
//      - 任何写入故障都整体回滚，不会留下「半个 succeeded」。
//   4) 只存固定词表 + 摘要 + 内部技术 ID；不存备份 / 目标原始路径、业务金额、凭证内容或异常原文。

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { auditError as fail, runInTransaction } from "./local-audit.mjs";

export const RESTORE_LEDGER_COMPONENT = "restore-ledger";
export const RESTORE_LEDGER_SCHEMA_VERSION = 1;
export const RESTORE_LEDGER_TABLES = Object.freeze([
  "restore_ledger_meta",
  "restore_operations",
  "restore_operation_events",
]);

/**
 * append-only 触发器的规范定义；结构检查逐字比对（忽略空白 / 大小写），
 * 所以「同名但无效」的触发器不会被当成已保护。
 *
 * no_replace 针对 SQLite 默认 `recursive_triggers=0` 下的 INSERT OR REPLACE：
 * 隐式删除不会触发 DELETE 触发器，因此必须在 BEFORE INSERT 阶段就拒绝与既有 id 冲突的插入。
 */
export const RESTORE_TRIGGER_SQL = Object.freeze({
  restore_events_no_update: `CREATE TRIGGER restore_events_no_update BEFORE UPDATE ON restore_operation_events
     BEGIN SELECT RAISE(ABORT, 'restore_events_append_only'); END`,
  restore_events_no_delete: `CREATE TRIGGER restore_events_no_delete BEFORE DELETE ON restore_operation_events
     BEGIN SELECT RAISE(ABORT, 'restore_events_append_only'); END`,
  restore_events_no_replace: `CREATE TRIGGER restore_events_no_replace BEFORE INSERT ON restore_operation_events
     WHEN EXISTS (SELECT 1 FROM restore_operation_events WHERE id = NEW.id)
     BEGIN SELECT RAISE(ABORT, 'restore_events_append_only'); END`,
});
export const RESTORE_TRIGGERS = Object.freeze(Object.keys(RESTORE_TRIGGER_SQL));

/** 结构检查的必需列；缺列时先给固定结构化拒绝，再去查询。 */
const RESTORE_REQUIRED_COLUMNS = Object.freeze({
  restore_ledger_meta: Object.freeze(["component", "version", "installed_at", "note"]),
  restore_operations: Object.freeze([
    "operation_id", "started_at", "updated_at", "status", "result_code", "reason_code",
    "backup_digest", "backup_bytes", "backup_schema_version", "component_versions", "producer",
    "receipt", "target_digest", "target_instance_id", "prepared_at", "published_at", "terminal_at",
    "attempts", "note_code",
  ]),
  restore_operation_events: Object.freeze([
    "id", "operation_id", "at", "from_status", "to_status", "result_code", "reason_code", "note_code",
  ]),
});

/** 恢复操作状态机：started → prepared → succeeded | failed | rejected | unknown。 */
export const RESTORE_STATUSES = Object.freeze(["started", "prepared", "succeeded", "failed", "rejected", "unknown"]);
/** 需要后续对账 / 核验的状态：未知结果不得从可对账集合里消失。 */
const PENDING_STATUSES = Object.freeze(["started", "prepared", "unknown"]);

/** 终态（不可再迁移，除幂等重放）。unknown 不是终态：只能由带证据的核验转成 succeeded。 */
const TERMINAL_STATUSES = Object.freeze(["succeeded", "failed", "rejected"]);

/** 各终态的合法 resultCode 组合：status 与 resultCode 不能任意拼接。 */
const FAIL_RESULT_CODES = Object.freeze({
  failed: Object.freeze(["restore_new_failed"]),
  rejected: Object.freeze(["restore_new_rejected"]),
  // unknown 表示「结果待确认」：已发布但终态未确认也用 published_pending。
  unknown: Object.freeze(["restore_unknown", "restore_published_pending"]),
});

/** 本 ledger 自己的固定 resultCode 词表（不复用审计事件词表，避免两套语义混淆）。 */
export const RESTORE_RESULT_CODES = Object.freeze([
  "restore_started",
  "restore_prepared",
  "restore_new_succeeded",
  "restore_new_failed",
  "restore_new_rejected",
  "restore_published_pending",
  "restore_unknown",
  "restore_reconcile_pending",
]);

/** 本 ledger 自己的固定 reasonCode 词表。 */
export const RESTORE_REASON_CODES = Object.freeze([
  "none",
  "restore_operation_conflict",
  "restore_state_conflict",
  "restore_receipt_mismatch",
  "restore_digest_mismatch",
  "restore_verify_failed",
  "restore_reconcile_insufficient_evidence",
  "restore_ledger_write_failed",
  "internal_error",
]);

const STATUS_SET = new Set(RESTORE_STATUSES);
const RESULT_CODE_SET = new Set(RESTORE_RESULT_CODES);
const REASON_CODE_SET = new Set(RESTORE_REASON_CODES);

const TECH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const PRODUCER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_COMPONENTS = 32;

const isTechId = (v) => typeof v === "string" && TECH_ID_RE.test(v);
const isDigest = (v) => typeof v === "string" && DIGEST_RE.test(v);
const isCount = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** 规范化组件版本登记：{componentName: version}，名称受限、版本正整数、数量有上限。 */
export function normalizeComponentVersions(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw fail("restore_operation_invalid", { field: "componentVersions" });
  }
  const keys = Object.keys(raw);
  if (!keys.length || keys.length > MAX_COMPONENTS) {
    throw fail("restore_operation_invalid", { field: "componentVersions" });
  }
  const out = {};
  for (const key of keys.sort()) {
    if (!isTechId(key)) throw fail("restore_operation_invalid", { field: "componentVersions" });
    const version = raw[key];
    if (!Number.isSafeInteger(version) || version < 1) {
      throw fail("restore_operation_invalid", { field: "componentVersions" });
    }
    out[key] = version;
  }
  return out;
}

const V1_STATEMENTS = Object.freeze([
  `CREATE TABLE restore_ledger_meta (
     component TEXT PRIMARY KEY,
     version INTEGER NOT NULL,
     installed_at TEXT NOT NULL,
     note TEXT
   )`,
  `CREATE TABLE restore_operations (
     operation_id TEXT PRIMARY KEY,
     started_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     status TEXT NOT NULL,
     result_code TEXT NOT NULL,
     reason_code TEXT NOT NULL DEFAULT 'none',
     backup_digest TEXT NOT NULL,
     backup_bytes INTEGER NOT NULL,
     backup_schema_version INTEGER,
     component_versions TEXT NOT NULL,
     producer TEXT NOT NULL,
     receipt TEXT,
     target_digest TEXT,
     target_instance_id TEXT,
     prepared_at TEXT,
     published_at TEXT,
     terminal_at TEXT,
     attempts INTEGER NOT NULL DEFAULT 1,
     note_code TEXT
   )`,
  `CREATE INDEX idx_restore_operations_status ON restore_operations (status, started_at)`,
  `CREATE TABLE restore_operation_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     operation_id TEXT NOT NULL,
     at TEXT NOT NULL,
     from_status TEXT,
     to_status TEXT NOT NULL,
     result_code TEXT NOT NULL,
     reason_code TEXT NOT NULL DEFAULT 'none',
     note_code TEXT
   )`,
  `CREATE INDEX idx_restore_events_operation ON restore_operation_events (operation_id, id)`,
  // append-only：迁移历史不可改写 / 删除 / 被 INSERT OR REPLACE 替换（默认连接同样成立）。
  ...Object.values(RESTORE_TRIGGER_SQL),
]);

// ------------------------------------------------------------------ 结构
const listTables = (db) =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => r.name);

const normalizeSql = (text) => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const columnsOf = (db, name) => db.prepare(`PRAGMA table_info(${name})`).all().map((r) => r.name);

/**
 * 只读检查 ledger 结构（不建表、不写库）。
 *
 * 结构检查先于任何列查询：缺表 / 缺列 / 未知或更高版本 / 触发器缺失或同名但定义不符，
 * 都会得到固定 `state`，而不是把原始 SQLite 报错当结论。
 */
export function inspectRestoreLedger(db) {
  const tables = listTables(db);
  const present = RESTORE_LEDGER_TABLES.filter((name) => tables.includes(name));
  const missingTables = RESTORE_LEDGER_TABLES.filter((name) => !tables.includes(name));

  const missingColumns = {};
  for (const name of present) {
    const columns = columnsOf(db, name);
    const missing = RESTORE_REQUIRED_COLUMNS[name].filter((column) => !columns.includes(column));
    if (missing.length) missingColumns[name] = missing;
  }
  const columnsReady = missingTables.length === 0 && Object.keys(missingColumns).length === 0;

  let version = 0;
  if (columnsReady) {
    const row = db.prepare(`SELECT version FROM restore_ledger_meta WHERE component=?`).get(RESTORE_LEDGER_COMPONENT);
    if (row && Number.isSafeInteger(Number(row.version))) version = Number(row.version);
  }

  const triggerRows = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name IN (${RESTORE_TRIGGERS.map(() => "?").join(",")})`)
    .all(...RESTORE_TRIGGERS);
  const triggerMap = new Map(triggerRows.map((row) => [row.name, row]));
  const missingTriggers = RESTORE_TRIGGERS.filter((name) => !triggerMap.has(name));
  const invalidTriggers = RESTORE_TRIGGERS.filter((name) => {
    const row = triggerMap.get(name);
    return !!row && normalizeSql(row.sql) !== normalizeSql(RESTORE_TRIGGER_SQL[name]);
  });

  const problems = [];
  if (missingTables.length) problems.push("missing_tables");
  if (Object.keys(missingColumns).length) problems.push("missing_columns");
  if (columnsReady && version > RESTORE_LEDGER_SCHEMA_VERSION) problems.push("version_newer");
  else if (columnsReady && version !== RESTORE_LEDGER_SCHEMA_VERSION) problems.push("version_unknown");
  if (present.length) {
    if (missingTriggers.length) problems.push("missing_triggers");
    if (invalidTriggers.length) problems.push("invalid_triggers");
  }

  let state;
  if (!present.length) state = "not_installed";
  else if (missingTables.length || Object.keys(missingColumns).length) state = "invalid";
  else if (version > RESTORE_LEDGER_SCHEMA_VERSION) state = "unsupported";
  else if (version !== RESTORE_LEDGER_SCHEMA_VERSION) state = "invalid";
  else if (missingTriggers.length || invalidTriggers.length) state = "invalid";
  else state = "ok";

  return {
    tables,
    present,
    missingTables,
    missingColumns,
    installed: missingTables.length === 0,
    version,
    target: RESTORE_LEDGER_SCHEMA_VERSION,
    missingTriggers,
    invalidTriggers,
    problems,
    state,
    ok: state === "ok",
  };
}

/**
 * 受保护的 ledger 初始化：只接受空 SQLite（或已装且结构 / 版本 / 触发器完整且一致的 ledger）。
 * 已含其他表 → `restore_ledger_foreign_tables`（不把业务库当 ledger 用）；
 * 版本更高 / 缺表 / 缺列 / 缺触发器 / 同名无效触发器 → 固定错误码拒绝。
 */
export function ensureRestoreLedgerSchema(db) {
  if (!db || typeof db.exec !== "function") throw fail("restore_operation_invalid", { field: "db" });
  const state = inspectRestoreLedger(db);
  if (state.present.length) {
    if (state.present.length !== RESTORE_LEDGER_TABLES.length) {
      throw fail("restore_ledger_inconsistent", { reason: "partial_tables" });
    }
    assertLedgerSchema(db);
    return { installed: false, version: state.version };
  }
  const foreign = state.tables.filter((name) => !RESTORE_LEDGER_TABLES.includes(name));
  if (foreign.length) {
    throw fail("restore_ledger_foreign_tables", { foreignTableCount: foreign.length });
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of V1_STATEMENTS) db.exec(step);
    db.prepare(`INSERT INTO restore_ledger_meta (component, version, installed_at, note) VALUES (?,?,?,?)`)
      .run(RESTORE_LEDGER_COMPONENT, RESTORE_LEDGER_SCHEMA_VERSION, new Date().toISOString(), "local-06-audit");
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* 保留原始拒绝 */ }
    throw fail("restore_ledger_inconsistent", { reason: "install_failed" });
  }
  return { installed: true, version: RESTORE_LEDGER_SCHEMA_VERSION };
}

function assertLedgerSchema(db) {
  const state = inspectRestoreLedger(db);
  if (state.missingTables.length) {
    throw fail("restore_ledger_inconsistent", { reason: "missing_tables", tableCount: state.present.length });
  }
  if (Object.keys(state.missingColumns).length) {
    throw fail("restore_ledger_inconsistent", {
      reason: "missing_columns", tableCount: Object.keys(state.missingColumns).length,
    });
  }
  if (state.version > RESTORE_LEDGER_SCHEMA_VERSION) {
    throw fail("restore_ledger_incompatible", { reason: "version", version: state.version });
  }
  if (state.version !== RESTORE_LEDGER_SCHEMA_VERSION) {
    throw fail("restore_ledger_inconsistent", { reason: "version", version: state.version });
  }
  if (state.missingTriggers.length) throw fail("restore_ledger_inconsistent", { reason: "missing_triggers" });
  if (state.invalidTriggers.length) throw fail("restore_ledger_inconsistent", { reason: "invalid_triggers" });
  return state;
}

/**
 * 显式路径打开恢复 ledger。
 * - `{ create: true }`：文件不存在则创建；存在则按受保护初始化处理（已含其他表 → 拒绝）。
 * - `{ readOnly: true }`：只读打开，缺文件给 `restore_ledger_missing`，不创建。
 * - 默认：只检查结构，**不**创建、不迁移。
 */
export function openRestoreLedger(path, { create = false, readOnly = false } = {}) {
  if (typeof path !== "string" || !path.trim()) {
    throw fail("restore_operation_invalid", { field: "path" });
  }
  const exists = existsSync(path);
  if (!exists && !create) throw fail("restore_ledger_missing", { readOnly: readOnly === true });
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: readOnly === true });
  } catch {
    throw fail("restore_ledger_invalid", { reason: "open_failed" });
  }
  try {
    if (readOnly) {
      assertLedgerSchema(db);
      return db;
    }
    ensureRestoreLedgerSchema(db);
    return db;
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    if (e && typeof e.code === "string" && e.code.startsWith("restore_")) throw e;
    throw fail("restore_ledger_invalid", { reason: "not_a_ledger" });
  }
}

// ------------------------------------------------------------------ 行序列化
const toOperationDto = (row) => ({
  operationId: row.operation_id,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
  status: row.status,
  resultCode: row.result_code,
  reasonCode: row.reason_code,
  backupDigest: row.backup_digest,
  backupBytes: Number(row.backup_bytes),
  backupSchemaVersion: row.backup_schema_version === null ? null : Number(row.backup_schema_version),
  componentVersions: JSON.parse(row.component_versions),
  producer: row.producer,
  receipt: row.receipt ?? null,
  targetDigest: row.target_digest ?? null,
  targetInstanceId: row.target_instance_id ?? null,
  preparedAt: row.prepared_at ?? null,
  publishedAt: row.published_at ?? null,
  terminalAt: row.terminal_at ?? null,
  attempts: Number(row.attempts),
  noteCode: row.note_code ?? null,
});

const OPERATION_COLUMNS = `operation_id, started_at, updated_at, status, result_code, reason_code,
  backup_digest, backup_bytes, backup_schema_version, component_versions, producer, receipt, target_digest,
  target_instance_id, prepared_at, published_at, terminal_at, attempts, note_code`;

const getRow = (db, operationId) =>
  db.prepare(`SELECT ${OPERATION_COLUMNS} FROM restore_operations WHERE operation_id=?`).get(operationId) || null;

/**
 * ledger 写入统一在一条短事务内完成；底层写入失败（IO / 锁 / 触发器）归一成固定错误码，
 * 不把原始 SQLite 文本当业务结论，也不留半个终态。
 * 写之前先做结构断言：未知版本 / 缺列 / 缺触发器 / 同名无效触发器给固定结构化拒绝。
 */
const guardedWrite = (db, fn) => {
  assertLedgerSchema(db);
  try {
    return runInTransaction(db, fn).result;
  } catch (e) {
    if (e && typeof e.code === "string" && (e.code.startsWith("restore_") || e.code.startsWith("audit_"))) throw e;
    throw fail("restore_ledger_write_failed", { reason: "write_failed" });
  }
};

const insertTransition = (db, { operationId, fromStatus, toStatus, resultCode, reasonCode, noteCode }) => {
  db.prepare(`INSERT INTO restore_operation_events
                (operation_id, at, from_status, to_status, result_code, reason_code, note_code)
              VALUES (?,?,?,?,?,?,?)`)
    .run(operationId, new Date().toISOString(), fromStatus, toStatus, resultCode, reasonCode, noteCode ?? null);
};

// ------------------------------------------------------------------ 写原语
/**
 * 登记一次恢复操作的开始（started）。
 *
 * 幂等：同 operationId + 同 backupDigest / bytes / schema 版本 / 组件登记 / producer → 返回已有行；
 * 任一不一致 → `restore_operation_conflict`（不覆盖、不静默改动）。
 * 注意：开始记录**先于**任何发布动作持久化；失败也必须在同一 operationId 下落固定终态。
 */
export function beginRestoreOperation(db, input = {}) {
  const {
    operationId, backupDigest, backupBytes, backupSchemaVersion = null, componentVersions, producer, noteCode = null,
  } = input;
  if (!isTechId(operationId)) throw fail("restore_operation_invalid", { field: "operationId" });
  if (!isDigest(backupDigest)) throw fail("restore_operation_invalid", { field: "backupDigest" });
  if (!isCount(backupBytes) || backupBytes <= 0) throw fail("restore_operation_invalid", { field: "backupBytes" });
  if (backupSchemaVersion !== null && !isCount(backupSchemaVersion)) {
    throw fail("restore_operation_invalid", { field: "backupSchemaVersion" });
  }
  if (typeof producer !== "string" || !PRODUCER_RE.test(producer)) {
    throw fail("restore_operation_invalid", { field: "producer" });
  }
  if (noteCode !== null && !isTechId(noteCode)) throw fail("restore_operation_invalid", { field: "noteCode" });
  const components = normalizeComponentVersions(componentVersions);
  const componentJson = JSON.stringify(components);

  return guardedWrite(db, () => {
    const now = new Date().toISOString();
    const existing = getRow(db, operationId);
    if (existing) {
      const same = existing.backup_digest === backupDigest
        && Number(existing.backup_bytes) === backupBytes
        && (existing.backup_schema_version === null ? null : Number(existing.backup_schema_version)) === backupSchemaVersion
        && JSON.stringify(normalizeComponentVersions(JSON.parse(existing.component_versions))) === componentJson
        && existing.producer === producer
        && (existing.note_code ?? null) === (noteCode ?? null);
      if (!same) throw fail("restore_operation_conflict", { reason: "begin_reused_with_different_data" });
      return { created: false, operation: toOperationDto(existing) };
    }
    db.prepare(`INSERT INTO restore_operations
                  (operation_id, started_at, updated_at, status, result_code, reason_code, backup_digest,
                   backup_bytes, backup_schema_version, component_versions, producer, attempts, note_code)
                VALUES (?,?,?,'started','restore_started','none',?,?,?,?,?,1,?)`)
      .run(operationId, now, now, backupDigest, backupBytes, backupSchemaVersion, componentJson, producer, noteCode);
    insertTransition(db, {
      operationId, fromStatus: null, toStatus: "started", resultCode: "restore_started", reasonCode: "none", noteCode,
    });
    return { created: true, operation: toOperationDto(getRow(db, operationId)) };
  });
}

/**
 * 记录「目标仍是 incomplete 标记时的准备结果」：持久化 operation-bound receipt。
 * succeeded 只能在 prepared 之后发生，因此 receipt 是终态的必备证据。
 */
export function markRestorePrepared(db, { operationId, receipt } = {}) {
  if (!isTechId(operationId)) throw fail("restore_operation_invalid", { field: "operationId" });
  if (!isDigest(receipt)) throw fail("restore_operation_invalid", { field: "receipt" });
  return guardedWrite(db, () => {
    const row = getRow(db, operationId);
    if (!row) throw fail("restore_operation_invalid", { reason: "operation_missing" });
    if (row.status === "prepared") {
      if (row.receipt !== receipt) throw fail("restore_receipt_mismatch", { reason: "prepared_receipt_differs" });
      return { changed: false, operation: toOperationDto(row) };
    }
    if (row.status !== "started") {
      throw fail("restore_state_conflict", { reason: "not_started", status: row.status });
    }
    const now = new Date().toISOString();
    db.prepare(`UPDATE restore_operations
                   SET status='prepared', result_code='restore_prepared', reason_code='none',
                       receipt=?, prepared_at=?, updated_at=?, attempts=attempts + 1
                 WHERE operation_id=?`).run(receipt, now, now, operationId);
    insertTransition(db, {
      operationId, fromStatus: "started", toStatus: "prepared", resultCode: "restore_prepared", reasonCode: "none",
    });
    return { changed: true, operation: toOperationDto(getRow(db, operationId)) };
  });
}

/**
 * 发布成功后补记终态 succeeded。
 *
 * 约束（不可伪造终态）：
 *   - 必须已持久化 started 与 prepared，且 receipt / backupDigest 与登记一致；
 *   - 从 unknown 进入时也必须已有 receipt，且证据（receipt / backupDigest / target）完全一致：
 *     这代表「结果待确认」经显式核验后得到的可靠终态，不是猜成功；
 *   - 只接受 64 位低 hex 的 targetDigest 与技术 targetInstanceId；
 *   - 已在 succeeded 且证据一致 → 幂等 `{ changed: false }`；证据不一致 → 冲突。
 */
export function completeRestoreOperation(db, input = {}) {
  const { operationId, receipt, backupDigest, targetDigest, targetInstanceId } = input;
  if (!isTechId(operationId)) throw fail("restore_operation_invalid", { field: "operationId" });
  if (!isDigest(receipt)) throw fail("restore_operation_invalid", { field: "receipt" });
  if (!isDigest(backupDigest)) throw fail("restore_operation_invalid", { field: "backupDigest" });
  if (!isDigest(targetDigest)) throw fail("restore_operation_invalid", { field: "targetDigest" });
  if (!isTechId(targetInstanceId)) throw fail("restore_operation_invalid", { field: "targetInstanceId" });

  return guardedWrite(db, () => {
    const row = getRow(db, operationId);
    if (!row) throw fail("restore_operation_invalid", { reason: "operation_missing" });
    if (row.status === "succeeded") {
      const same = row.receipt === receipt && row.backup_digest === backupDigest
        && row.target_digest === targetDigest && row.target_instance_id === targetInstanceId;
      if (!same) throw fail("restore_digest_mismatch", { reason: "succeeded_evidence_differs" });
      return { changed: false, operation: toOperationDto(row) };
    }
    if (TERMINAL_STATUSES.includes(row.status)) {
      throw fail("restore_state_conflict", { reason: "already_terminal", status: row.status });
    }
    if (row.status !== "prepared" && row.status !== "unknown") {
      // started（未 prepare）不足以证明发布已完成：拒绝补记成功。
      throw fail("restore_state_conflict", { reason: "not_prepared", status: row.status });
    }
    if (!row.receipt) {
      // 没有持久化 receipt 就不能证明「发布已完成」，unknown 仍必须保持未完成。
      throw fail("restore_state_conflict", { reason: "no_receipt_evidence", status: row.status });
    }
    if (row.receipt !== receipt) throw fail("restore_receipt_mismatch", { reason: "terminal_receipt_differs" });
    if (row.backup_digest !== backupDigest) throw fail("restore_digest_mismatch", { reason: "backup_digest_differs" });

    const now = new Date().toISOString();
    db.prepare(`UPDATE restore_operations
                   SET status='succeeded', result_code='restore_new_succeeded', reason_code='none',
                       target_digest=?, target_instance_id=?, terminal_at=?, published_at=?, updated_at=?,
                       attempts=attempts + 1
                 WHERE operation_id=?`)
      .run(targetDigest, targetInstanceId, now, now, now, operationId);
    insertTransition(db, {
      operationId, fromStatus: row.status, toStatus: "succeeded",
      resultCode: "restore_new_succeeded", reasonCode: "none",
    });
    return { changed: true, operation: toOperationDto(getRow(db, operationId)) };
  });
}

/**
 * 记录失败 / 拒绝 / 无法判定终态。
 *
 * - 已 succeeded 不可被改写；failed / rejected 为终态，unknown 表示「结果待确认」，
 *   都不能被不同字段的请求覆写（必须走带证据的 complete / reconcile 或保持 unknown）。
 * - 同一请求（status / resultCode / reasonCode / noteCode 全相同）幂等，返回 `changed:false`；
 *   任一字段不同 → `restore_state_conflict`，原库不变（不 UPDATE、不追加迁移记录）。
 * - status 与 resultCode 必须合法配对：failed→restore_new_failed、rejected→restore_new_rejected、
 *   unknown→restore_unknown；不允许把 failed 行改成 restore_new_succeeded。
 */
export function failRestoreOperation(db, input = {}) {
  const { operationId, status = "failed", resultCode, reasonCode = "none", noteCode = null } = input;
  if (!isTechId(operationId)) throw fail("restore_operation_invalid", { field: "operationId" });
  if (!["failed", "rejected", "unknown"].includes(status)) {
    throw fail("restore_operation_invalid", { field: "status" });
  }
  if (!RESULT_CODE_SET.has(resultCode)) throw fail("restore_operation_invalid", { field: "resultCode" });
  if (!REASON_CODE_SET.has(reasonCode)) throw fail("restore_operation_invalid", { field: "reasonCode" });
  if (noteCode !== null && !isTechId(noteCode)) throw fail("restore_operation_invalid", { field: "noteCode" });

  return guardedWrite(db, () => {
    const row = getRow(db, operationId);
    if (!row) throw fail("restore_operation_invalid", { reason: "operation_missing" });
    if (row.status === "succeeded") throw fail("restore_state_conflict", { reason: "already_succeeded" });
    // noteCode 为 null 时 UPDATE 用 COALESCE 保留原值；因此「同请求」判定只在调用方显式给出
    // noteCode 时要求与库内一致，不给时沿用原值，重复调用仍然幂等。
    const noteMatches = noteCode === null || (row.note_code ?? null) === noteCode;
    const same = row.status === status && row.result_code === resultCode
      && row.reason_code === reasonCode && noteMatches;
    if (same) return { changed: false, operation: toOperationDto(row) };
    if (TERMINAL_STATUSES.includes(row.status) || row.status === "unknown") {
      // 终态 / 待确认结果不能被不同字段的失败调用改写；状态冲突优先于具体字段组合报错。
      throw fail("restore_state_conflict", { reason: "terminal_fields_differ", status: row.status });
    }
    // 只有真正可迁移的 started / prepared 才检查 status / resultCode 合法性。
    if (!FAIL_RESULT_CODES[status].includes(resultCode)) {
      throw fail("restore_operation_invalid", { field: "resultCode", status });
    }
    const now = new Date().toISOString();
    db.prepare(`UPDATE restore_operations
                   SET status=?, result_code=?, reason_code=?, terminal_at=?, updated_at=?,
                       attempts=attempts + 1, note_code=COALESCE(?, note_code)
                 WHERE operation_id=?`)
      .run(status, resultCode, reasonCode, now, now, noteCode, operationId);
    insertTransition(db, {
      operationId, fromStatus: row.status, toStatus: status, resultCode, reasonCode, noteCode,
    });
    return { changed: true, operation: toOperationDto(getRow(db, operationId)) };
  });
}

/**
 * 真实对账原语（供 CLI / C 包在有显式目标与回执时补记终态）。
 *
 * 只基于「调用方给出的显式目标 + operationId + 备份摘要 + 重新校验的已发布库」：
 *   - 不重做恢复、不复制 / 覆盖目录、不修改备份；
 *   - started / prepared / **unknown** 都在可对账集合内：unknown 是「结果待确认」，
 *     不会因为一次证据不足就永久退出待对账列表；带 receipt 的 unknown 只要证据完整即可转 succeeded；
 *   - 证据不足（未持久化 receipt / 回调抛错 / 回执或摘要不一致）→ 不改状态，返回
 *     `{ reconciled:false, terminal:'unknown' }` 并追加一条 `restore_reconcile_pending` 迁移记录；
 *   - 证据完整 → 与 `completeRestoreOperation` 相同的约束下补记 succeeded，幂等。
 *   - 跨库（ledger ↔ 目标库）非原子：本原语只做显式核验，不假装原子提交。
 */
export function reconcileRestoreOperation(db, input = {}) {
  const { operationId, verifyPublished } = input;
  if (!isTechId(operationId)) throw fail("restore_operation_invalid", { field: "operationId" });
  if (typeof verifyPublished !== "function") {
    throw fail("restore_operation_invalid", { field: "verifyPublished" });
  }
  assertLedgerSchema(db);

  const row = getRow(db, operationId);
  if (!row) throw fail("restore_operation_invalid", { reason: "operation_missing" });
  if (row.status === "succeeded") return { reconciled: false, changed: false, terminal: "succeeded", operation: toOperationDto(row) };
  if (!PENDING_STATUSES.includes(row.status)) {
    // failed / rejected 是已确认终态，不参与猜成功。
    return { reconciled: false, changed: false, terminal: row.status, operation: toOperationDto(row) };
  }
  if (!row.receipt) {
    // started（或从未持久化 receipt 的 unknown）无法证明「发布已完成」，保持未完成。
    recordReconcilePending(db, operationId, row.status);
    return { reconciled: false, changed: false, terminal: "unknown", operation: toOperationDto(getRow(db, operationId)) };
  }

  let evidence = null;
  try { evidence = verifyPublished({ operationId, backupDigest: row.backup_digest, receipt: row.receipt }); }
  catch { evidence = null; }
  const usable = evidence && typeof evidence === "object"
    && isDigest(evidence.targetDigest)
    && isTechId(evidence.targetInstanceId)
    && evidence.receipt === row.receipt
    && (evidence.backupDigest === undefined || evidence.backupDigest === row.backup_digest);
  if (!usable) {
    recordReconcilePending(db, operationId, row.status);
    return { reconciled: false, changed: false, terminal: "unknown", operation: toOperationDto(getRow(db, operationId)) };
  }

  const done = completeRestoreOperation(db, {
    operationId,
    receipt: row.receipt,
    backupDigest: row.backup_digest,
    targetDigest: evidence.targetDigest,
    targetInstanceId: evidence.targetInstanceId,
  });
  return { reconciled: done.changed, changed: done.changed, terminal: "succeeded", operation: done.operation };
}

function recordReconcilePending(db, operationId, fromStatus) {
  guardedWrite(db, () => {
    insertTransition(db, {
      operationId,
      fromStatus,
      toStatus: fromStatus,
      resultCode: "restore_reconcile_pending",
      reasonCode: "restore_reconcile_insufficient_evidence",
      noteCode: "reconcile",
    });
    db.prepare(`UPDATE restore_operations SET updated_at=? WHERE operation_id=?`)
      .run(new Date().toISOString(), operationId);
  });
}

// ------------------------------------------------------------------ 只读查询
/** 单条恢复操作；不存在返回 null。 */
export function getRestoreOperation(db, operationId) {
  if (!isTechId(operationId)) throw fail("restore_operation_invalid", { field: "operationId" });
  assertLedgerSchema(db);
  const row = getRow(db, operationId);
  return row ? toOperationDto(row) : null;
}

/** 需要后续对账 / 核验的恢复操作（started / prepared / unknown），按开始时间排序。 */
export function listPendingRestoreOperations(db, { limit = 50 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw fail("restore_operation_invalid", { field: "limit" });
  }
  assertLedgerSchema(db);
  const rows = db.prepare(`SELECT ${OPERATION_COLUMNS} FROM restore_operations
                            WHERE status IN (${PENDING_STATUSES.map(() => "?").join(",")})
                            ORDER BY started_at ASC, operation_id ASC LIMIT ?`)
    .all(...PENDING_STATUSES, limit);
  return rows.map(toOperationDto);
}

/**
 * 只读分页查询恢复操作：固定按 `started_at, operation_id` 升序；游标为二元组，稳定无重复 / 无遗漏。
 */
export function queryRestoreOperations(db, filter = {}) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw fail("restore_operation_invalid", { field: "filter" });
  }
  assertLedgerSchema(db);
  const allowed = ["status", "producer", "resultCode", "afterStartedAt", "afterOperationId", "limit"];
  let unknown = 0;
  for (const key of Object.keys(filter)) if (!allowed.includes(key)) unknown += 1;
  if (unknown) throw fail("restore_operation_invalid", { field: "unknown", count: unknown });

  const where = [];
  const params = [];
  if (filter.status !== undefined && filter.status !== null) {
    if (!STATUS_SET.has(filter.status)) throw fail("restore_operation_invalid", { field: "status" });
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.producer !== undefined && filter.producer !== null) {
    if (typeof filter.producer !== "string" || !PRODUCER_RE.test(filter.producer)) {
      throw fail("restore_operation_invalid", { field: "producer" });
    }
    where.push("producer = ?");
    params.push(filter.producer);
  }
  if (filter.resultCode !== undefined && filter.resultCode !== null) {
    if (!RESULT_CODE_SET.has(filter.resultCode)) throw fail("restore_operation_invalid", { field: "resultCode" });
    where.push("result_code = ?");
    params.push(filter.resultCode);
  }
  const afterStartedAt = filter.afterStartedAt ?? null;
  const afterOperationId = filter.afterOperationId ?? null;
  if ((afterStartedAt === null) !== (afterOperationId === null)) {
    throw fail("restore_operation_invalid", { field: "cursor" });
  }
  if (afterStartedAt !== null) {
    if (typeof afterStartedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(afterStartedAt)) {
      throw fail("restore_operation_invalid", { field: "afterStartedAt" });
    }
    if (!isTechId(afterOperationId)) throw fail("restore_operation_invalid", { field: "afterOperationId" });
    where.push("(started_at > ? OR (started_at = ? AND operation_id > ?))");
    params.push(afterStartedAt, afterStartedAt, afterOperationId);
  }
  let limit = 50;
  if (filter.limit !== undefined && filter.limit !== null) {
    if (!Number.isSafeInteger(filter.limit) || filter.limit < 1 || filter.limit > 500) {
      throw fail("restore_operation_invalid", { field: "limit" });
    }
    limit = filter.limit;
  }
  const rows = db.prepare(`SELECT ${OPERATION_COLUMNS} FROM restore_operations
                            ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                            ORDER BY started_at ASC, operation_id ASC LIMIT ?`)
    .all(...params, limit + 1);
  const hasMore = rows.length > limit;
  const operations = rows.slice(0, limit).map(toOperationDto);
  const last = operations[operations.length - 1] || null;
  return {
    operations,
    hasMore,
    nextCursor: hasMore && last ? { afterStartedAt: last.startedAt, afterOperationId: last.operationId } : null,
  };
}

/** 只读：某操作的迁移历史（append-only）。 */
export function listRestoreTransitions(db, operationId) {
  if (!isTechId(operationId)) throw fail("restore_operation_invalid", { field: "operationId" });
  assertLedgerSchema(db);
  return db.prepare(`SELECT id, at, from_status, to_status, result_code, reason_code, note_code
                       FROM restore_operation_events WHERE operation_id=? ORDER BY id`)
    .all(operationId)
    .map((r) => ({
      id: Number(r.id),
      at: r.at,
      fromStatus: r.from_status ?? null,
      toStatus: r.to_status,
      resultCode: r.result_code,
      reasonCode: r.reason_code,
      noteCode: r.note_code ?? null,
    }));
}

/** 只读状态计数。 */
export function restoreLedgerStats(db) {
  assertLedgerSchema(db);
  const byStatus = db.prepare(`SELECT status, COUNT(*) AS n FROM restore_operations GROUP BY status ORDER BY status`)
    .all().map((r) => ({ status: r.status, count: Number(r.n) }));
  const total = byStatus.reduce((sum, item) => sum + item.count, 0);
  return { total, byStatus };
}
