// bank-storage.mjs — LOCAL-04 银行组件持久层：bank_* 独立命名空间、组件版本与迁移门槛。
//
// 设计约束（LOCAL-04 / LOCAL-06 依赖）：
// 1) 本文件不 import db.mjs / accounting.mjs：所有函数显式接收 DatabaseSync 连接，
//    导入本模块不会打开默认库、不会建表、不会触发全局迁移。
// 2) 组件表一律使用 bank_* 前缀，并使用自己的 bank_component_migrations 版本表；
//    绝不写 schema_migrations / schema_backups / PRAGMA user_version，不抢 LOCAL-02 的全局版本。
// 3) 已有库首次加入 bank_*（或组件升级）必须先做一次可验证的一致备份：
//    - 备份实现由 LOCAL-06 提供，本包只把它作为**窄依赖**注入（需 createBackup / verifyBackup）；
//    - 未注入备份服务时返回 migration_backup_unavailable，原库结构 / 数据 / 版本都不动；
//    - 备份生成或校验失败时返回 migration_backup_failed / migration_backup_invalid，同样不动原库；
//    - 只有「本次进程亲手创建的空库」可以免备份初始化：创建事实由 claimFreshDatabase()
//      持有的进程内回执证明，不接受 --force / 布尔参数 / 「没有 bank_* 表」之类的推断。
// 4) 组件 DDL 与创建批次在同一事务内执行；失败整体回滚，保留可验证的迁移前备份。
// 5) 审计表（bank_audit_events）不设级联外键：业务对象被删除时审计证据仍然保留。
//    对账匹配记录引用银行流水时使用 ON DELETE SET NULL，快照字段保留原值。

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, openSync, closeSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** 本文件负责的组件 schema 版本。 */
export const BANK_SCHEMA_VERSION = 1;

/** 组件创建的持久对象（供自检 / 测试断言 / 文档使用）。 */
export const BANK_TABLES = Object.freeze([
  "bank_component_migrations",
  "bank_component_backups",
  "bank_accounts",
  "bank_batches",
  "bank_transactions",
  "bank_batch_rows",
  "bank_ambiguities",
  "bank_matches",
  "bank_audit_events",
  "bank_reconcile_runs",
]);

/** 组件依赖的、由账务核心（LOCAL-01 / LOCAL-02）拥有的表与列。 */
const REQUIRED_BASE_COLUMNS = Object.freeze({
  account_sets: ["id", "name", "start_period", "created_at"],
  accounts: ["account_set_id", "code", "name", "category", "direction", "is_leaf"],
  opening_balances: ["account_set_id", "code", "debit", "credit"],
  periods: ["account_set_id", "period", "status"],
  vouchers: ["id", "account_set_id", "period", "voucher_date", "status", "number", "word", "summary"],
  voucher_entries: ["id", "voucher_id", "line_no", "code", "debit", "credit"],
});

/**
 * 组件结构契约（schema v1）：表 / 关键列 / 主键 / 索引（含 UNIQUE 与部分索引）/ 外键动作。
 *
 * 用途：
 *  - 业务写前结构自检（`assertBankSchemaReady`）：缺表 / 缺列 / 主键 / UNIQUE / FK 动作不符
 *    一律在写入前结构化拒绝，不用 `CREATE TABLE IF NOT EXISTS` 静默修补坏库；
 *  - 文档与后续备份 / 恢复组合的结构核对依据（外部模块可 import 本常量）。
 *
 * 本契约只做**结构**核对（sqlite_master / PRAGMA），不做全表内容扫描。
 * 版本升级必须显式改这里并新增迁移；本版本仍只有 v1，不伪造 v2。
 */
export const BANK_SCHEMA_CONTRACT = Object.freeze({
  version: BANK_SCHEMA_VERSION,
  tables: Object.freeze({
    bank_component_migrations: {
      columns: Object.freeze(["version", "applied_at", "note"]),
      primaryKey: Object.freeze(["version"]),
    },
    bank_component_backups: {
      columns: Object.freeze(["id", "version", "path", "bytes", "integrity", "created_at", "note"]),
      primaryKey: Object.freeze(["id"]),
    },
    bank_accounts: {
      columns: Object.freeze([
        "account_set_id", "bank_account_id", "source_id", "currency", "gl_account_code",
        "display_name", "bank_account_no", "created_at",
      ]),
      primaryKey: Object.freeze(["account_set_id", "bank_account_id"]),
    },
    bank_batches: {
      columns: Object.freeze([
        "account_set_id", "bank_account_id", "source_id", "batch_id", "currency", "period",
        "content_sha256", "mapping_fingerprint", "normalization_version", "status", "row_count",
        "imported_rows", "reused_rows", "ambiguous_rows", "attempts", "replay_of_batch",
        "result_json", "error_code", "error_message", "created_at", "updated_at",
      ]),
      primaryKey: Object.freeze(["account_set_id", "bank_account_id", "batch_id"]),
    },
    bank_transactions: {
      columns: Object.freeze([
        "id", "account_set_id", "bank_account_id", "source_id", "currency", "txn_date", "period",
        "direction", "amount_cents", "summary", "bank_ref_id", "balance_after_cents",
        "content_fingerprint", "row_fingerprint", "batch_id", "row_index", "origin", "created_at",
      ]),
      primaryKey: Object.freeze(["id"]),
    },
    bank_batch_rows: {
      columns: Object.freeze([
        "id", "account_set_id", "bank_account_id", "batch_id", "row_index", "row_sha256",
        "row_fingerprint", "status", "transaction_id", "ambiguity_id", "note", "created_at",
      ]),
      primaryKey: Object.freeze(["id"]),
    },
    bank_ambiguities: {
      columns: Object.freeze([
        "id", "account_set_id", "bank_account_id", "source_id", "batch_id", "row_index", "txn_date",
        "period", "direction", "amount_cents", "summary", "currency", "row_fingerprint",
        "content_fingerprint", "batch_row_sha256", "candidate_transaction_ids", "status", "decision",
        "decision_reason", "resolved_transaction_id", "resolved_at", "created_at",
      ]),
      primaryKey: Object.freeze(["id"]),
    },
    bank_matches: {
      columns: Object.freeze([
        "id", "account_set_id", "bank_account_id", "currency", "transaction_id", "voucher_id",
        "entry_id", "entry_line_no", "status", "snapshot_json", "reason", "confirmed_at",
        "cancelled_at", "cancel_reason", "invalidated_at", "invalidation_reason",
      ]),
      primaryKey: Object.freeze(["id"]),
    },
    bank_audit_events: {
      columns: Object.freeze([
        "id", "account_set_id", "bank_account_id", "event_type", "subject_type", "subject_id",
        "detail_json", "created_at",
      ]),
      primaryKey: Object.freeze(["id"]),
    },
    bank_reconcile_runs: {
      columns: Object.freeze([
        "id", "account_set_id", "bank_account_id", "currency", "period", "as_of", "status",
        "book_close_cents", "adjusted_book_cents", "statement_close_cents", "adjusted_bank_cents",
        "difference_cents", "result_json", "stale", "stale_reason", "created_at",
      ]),
      primaryKey: Object.freeze(["id"]),
    },
  }),
  /**
   * 索引契约：`index` 有名字时按名字核对，没有名字时按（表 + 列 + unique + partial）签名核对
   * （用于表级 UNIQUE 约束生成的自动索引）。
   */
  indexes: Object.freeze([
    { index: "idx_bank_accounts_gl", table: "bank_accounts", columns: ["account_set_id", "gl_account_code"], unique: true, partial: false },
    { index: "idx_bank_accounts_source", table: "bank_accounts", columns: ["account_set_id", "source_id"], unique: false, partial: false },
    { table: "bank_accounts", columns: ["account_set_id", "bank_account_id"], unique: true, partial: false },
    { index: "idx_bank_batches_file", table: "bank_batches", columns: ["account_set_id", "bank_account_id", "source_id", "content_sha256"], unique: false, partial: false },
    { index: "idx_bank_batches_status", table: "bank_batches", columns: ["account_set_id", "bank_account_id", "status"], unique: false, partial: false },
    { table: "bank_batches", columns: ["account_set_id", "bank_account_id", "batch_id"], unique: true, partial: false },
    { index: "idx_bank_txn_ref", table: "bank_transactions", columns: ["account_set_id", "bank_account_id", "source_id", "bank_ref_id"], unique: true, partial: true },
    { index: "idx_bank_txn_batch_row", table: "bank_transactions", columns: ["account_set_id", "bank_account_id", "batch_id", "row_index"], unique: true, partial: false },
    { index: "idx_bank_txn_scope_date", table: "bank_transactions", columns: ["account_set_id", "bank_account_id", "txn_date"], unique: false, partial: false },
    { index: "idx_bank_txn_fingerprint", table: "bank_transactions", columns: ["account_set_id", "bank_account_id", "source_id", "row_fingerprint"], unique: false, partial: false },
    { index: "idx_bank_batch_rows_txn", table: "bank_batch_rows", columns: ["transaction_id"], unique: false, partial: false },
    { table: "bank_batch_rows", columns: ["account_set_id", "bank_account_id", "batch_id", "row_index"], unique: true, partial: false },
    { index: "idx_bank_ambiguities_status", table: "bank_ambiguities", columns: ["account_set_id", "bank_account_id", "status"], unique: false, partial: false },
    { table: "bank_ambiguities", columns: ["account_set_id", "bank_account_id", "batch_id", "row_index"], unique: true, partial: false },
    { index: "idx_bank_matches_active_txn", table: "bank_matches", columns: ["transaction_id"], unique: true, partial: true },
    { index: "idx_bank_matches_active_entry", table: "bank_matches", columns: ["account_set_id", "entry_id"], unique: true, partial: true },
    { index: "idx_bank_matches_scope", table: "bank_matches", columns: ["account_set_id", "bank_account_id", "status"], unique: false, partial: false },
    { index: "idx_bank_audit_scope", table: "bank_audit_events", columns: ["account_set_id", "bank_account_id", "event_type"], unique: false, partial: false },
    { index: "idx_bank_reconcile_scope", table: "bank_reconcile_runs", columns: ["account_set_id", "bank_account_id", "period", "as_of"], unique: false, partial: false },
  ]),
  /** 外键契约：列顺序、目标表 / 列与删除动作都必须与 DDL 一致。 */
  foreignKeys: Object.freeze([
    { table: "bank_accounts", columns: ["account_set_id"], refTable: "account_sets", refColumns: ["id"], onDelete: "CASCADE" },
    { table: "bank_batches", columns: ["account_set_id", "bank_account_id"], refTable: "bank_accounts", refColumns: ["account_set_id", "bank_account_id"], onDelete: "CASCADE" },
    { table: "bank_transactions", columns: ["account_set_id", "bank_account_id"], refTable: "bank_accounts", refColumns: ["account_set_id", "bank_account_id"], onDelete: "CASCADE" },
    { table: "bank_transactions", columns: ["account_set_id", "bank_account_id", "batch_id"], refTable: "bank_batches", refColumns: ["account_set_id", "bank_account_id", "batch_id"], onDelete: "CASCADE" },
    { table: "bank_batch_rows", columns: ["transaction_id"], refTable: "bank_transactions", refColumns: ["id"], onDelete: "SET NULL" },
    { table: "bank_batch_rows", columns: ["account_set_id", "bank_account_id", "batch_id"], refTable: "bank_batches", refColumns: ["account_set_id", "bank_account_id", "batch_id"], onDelete: "CASCADE" },
    { table: "bank_ambiguities", columns: ["resolved_transaction_id"], refTable: "bank_transactions", refColumns: ["id"], onDelete: "SET NULL" },
    { table: "bank_ambiguities", columns: ["account_set_id", "bank_account_id", "batch_id"], refTable: "bank_batches", refColumns: ["account_set_id", "bank_account_id", "batch_id"], onDelete: "CASCADE" },
    { table: "bank_matches", columns: ["transaction_id"], refTable: "bank_transactions", refColumns: ["id"], onDelete: "SET NULL" },
  ]),
});

const nowIso = () => new Date().toISOString();
/** 结构化业务错误：CLI / 上层按 code 映射退出码，不打印原始 SQL。 */
export function bankError(code, message, details) {
  const err = new Error(message || code);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

export const tableExists = (db, name) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);

function columnNames(db, table) {
  if (!tableExists(db, table)) return [];
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));
}

/** 只读核对当前库是否是本产品账务库且结构可用；不可用完返回 schema_not_supported。 */
export function assertBaseSchema(db) {
  const missing = [];
  for (const [table, columns] of Object.entries(REQUIRED_BASE_COLUMNS)) {
    const have = columnNames(db, table);
    if (!have.length) { missing.push({ table, columns: ["*"] }); continue; }
    const absent = columns.filter((c) => !have.includes(c));
    if (absent.length) missing.push({ table, columns: absent });
  }
  if (missing.length) {
    throw bankError("schema_not_supported", "当前库不是受支持的账务库结构，拒绝初始化银行组件", { missing });
  }
}

// ------------------------------------------------------------------ 组件结构契约自检
const SCHEMA_MESSAGES = Object.freeze({
  bank_schema_missing: "当前库尚未初始化银行组件（bank_*）",
  bank_schema_future_version: "银行组件版本比当前程序更新，拒绝在未知结构上读写",
  bank_schema_version_contradiction: "银行组件版本记录与表结构矛盾，拒绝在矛盾结构上读写",
  bank_schema_corrupt: "银行组件表结构与本版本契约不一致（缺表 / 缺列 / 主键 / 索引 / 外键动作），拒绝在损坏结构上读写",
});

function indexSignatures(db, table) {
  return db.prepare(`PRAGMA index_list(${table})`).all().map((idx) => ({
    name: String(idx.name),
    unique: Number(idx.unique) === 1,
    partial: Number(idx.partial) === 1,
    origin: String(idx.origin ?? ""),
    columns: db.prepare(`PRAGMA index_info(${idx.name})`).all()
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .map((c) => String(c.name)),
  }));
}

function foreignKeySignatures(db, table) {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  const groups = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    const entry = groups.get(id) ?? {
      refTable: String(row.table),
      onDelete: String(row.on_delete ?? "NO ACTION").toUpperCase(),
      rows: [],
    };
    entry.rows.push({ seq: Number(row.seq), from: String(row.from), to: String(row.to) });
    groups.set(id, entry);
  }
  return [...groups.values()].map((entry) => {
    const ordered = entry.rows.sort((a, b) => a.seq - b.seq);
    return {
      columns: ordered.map((r) => r.from),
      refTable: entry.refTable,
      refColumns: ordered.map((r) => r.to),
      onDelete: entry.onDelete,
    };
  });
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * 只读核对当前库的银行组件结构 / 版本是否与本版本契约一致。
 *
 * 返回值：{ initialized, ok, version, target, code, message, problems }。
 * - 没有任何 bank_* 表 → initialized:false / code `bank_schema_missing`（可以走迁移门槛）；
 * - 版本比本程序更新 → `bank_schema_future_version`；
 * - 版本记录与表集合矛盾（有表无版本、版本行不是唯一的 v1 等）→ `bank_schema_version_contradiction`；
 * - 其余结构偏差 → `bank_schema_corrupt`（problems 里逐项给出表 / 列 / 主键 / 索引 / 外键）。
 * 本函数不做全表内容扫描，不写库。
 */
export function bankSchemaContract(db) {
  const problems = [];
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
    .map((r) => String(r.name));
  const bankTables = tables.filter((n) => n.startsWith("bank_"));
  if (!bankTables.length) {
    return {
      initialized: false,
      ok: false,
      version: 0,
      target: BANK_SCHEMA_VERSION,
      code: "bank_schema_missing",
      message: SCHEMA_MESSAGES.bank_schema_missing,
      problems: [{ code: "bank_schema_missing", detail: { target: BANK_SCHEMA_VERSION } }],
    };
  }
  const hasVersionTable = bankTables.includes("bank_component_migrations");
  const versions = hasVersionTable
    ? db.prepare(`SELECT version FROM bank_component_migrations ORDER BY version`).all()
      .map((r) => Number(r.version))
    : [];
  const version = versions.length ? Math.max(...versions) : 0;

  if (versions.some((v) => v > BANK_SCHEMA_VERSION)) {
    problems.push({
      code: "bank_schema_future_version",
      detail: { versions, target: BANK_SCHEMA_VERSION },
    });
  }
  if (!hasVersionTable) {
    problems.push({
      code: "bank_schema_version_contradiction",
      detail: { reason: "component_migrations_missing", tables: bankTables.slice(0, 20) },
    });
  } else if (versions.length !== 1 || versions[0] !== BANK_SCHEMA_VERSION) {
    problems.push({
      code: "bank_schema_version_contradiction",
      detail: { versions, target: BANK_SCHEMA_VERSION, reason: "version_rows_not_exactly_target" },
    });
  }

  const expectedTables = Object.keys(BANK_SCHEMA_CONTRACT.tables);
  const unexpected = bankTables.filter((n) => !expectedTables.includes(n));
  if (unexpected.length) {
    problems.push({ code: "bank_schema_unexpected_table", detail: { tables: unexpected.slice(0, 20) } });
  }

  const columnsByTable = new Map();
  for (const [name, spec] of Object.entries(BANK_SCHEMA_CONTRACT.tables)) {
    if (!tables.includes(name)) {
      problems.push({ code: "bank_schema_table_missing", detail: { table: name } });
      continue;
    }
    const info = db.prepare(`PRAGMA table_info(${name})`).all();
    const columns = info.map((c) => String(c.name));
    columnsByTable.set(name, columns);
    const missing = spec.columns.filter((c) => !columns.includes(c));
    const extra = columns.filter((c) => !spec.columns.includes(c));
    if (missing.length || extra.length) {
      problems.push({ code: "bank_schema_column_mismatch", detail: { table: name, missing, extra } });
    }
    const primaryKey = info.filter((c) => Number(c.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((c) => String(c.name));
    if (!sameList(primaryKey, [...spec.primaryKey])) {
      problems.push({
        code: "bank_schema_primary_key_mismatch",
        detail: { table: name, expected: [...spec.primaryKey], actual: primaryKey },
      });
    }
  }

  const indexesByTable = new Map();
  const indexesFor = (table) => {
    if (!columnsByTable.has(table)) return [];
    if (!indexesByTable.has(table)) indexesByTable.set(table, indexSignatures(db, table));
    return indexesByTable.get(table);
  };
  for (const want of BANK_SCHEMA_CONTRACT.indexes) {
    const have = indexesFor(want.table);
    const match = have.find((idx) => (want.index
      ? idx.name === want.index
      : (idx.unique === want.unique && idx.partial === want.partial && sameList(idx.columns, [...want.columns]))));
    if (!match) {
      problems.push({
        code: "bank_schema_index_missing",
        detail: {
          table: want.table, index: want.index ?? null, columns: [...want.columns],
          unique: want.unique, partial: want.partial,
        },
      });
      continue;
    }
    if (match.unique !== want.unique || match.partial !== want.partial
      || !sameList(match.columns, [...want.columns])) {
      problems.push({
        code: "bank_schema_index_mismatch",
        detail: {
          table: want.table, index: match.name,
          expected: { columns: [...want.columns], unique: want.unique, partial: want.partial },
          actual: { columns: match.columns, unique: match.unique, partial: match.partial },
        },
      });
    }
  }

  for (const want of BANK_SCHEMA_CONTRACT.foreignKeys) {
    if (!columnsByTable.has(want.table)) continue;
    const have = foreignKeySignatures(db, want.table);
    const match = have.find((fk) => fk.refTable === want.refTable
      && fk.onDelete === want.onDelete
      && sameList(fk.columns, [...want.columns])
      && sameList(fk.refColumns, [...want.refColumns]));
    if (!match) {
      problems.push({
        code: "bank_schema_foreign_key_missing",
        detail: {
          table: want.table, columns: [...want.columns], refTable: want.refTable,
          refColumns: [...want.refColumns], onDelete: want.onDelete,
          actual: have.slice(0, 10),
        },
      });
    }
  }

  if (!problems.length) {
    return {
      initialized: true,
      ok: true,
      version,
      target: BANK_SCHEMA_VERSION,
      code: null,
      message: null,
      problems: [],
    };
  }
  const code = problems.some((p) => p.code === "bank_schema_future_version")
    ? "bank_schema_future_version"
    : problems.some((p) => p.code === "bank_schema_version_contradiction")
      ? "bank_schema_version_contradiction"
      : "bank_schema_corrupt";
  return {
    initialized: true,
    ok: false,
    version,
    target: BANK_SCHEMA_VERSION,
    code,
    message: SCHEMA_MESSAGES[code],
    problems,
  };
}

/**
 * 业务写 / 读前置门槛：结构或版本不符合本版本契约就结构化拒绝（不写库、不 DDL）。
 * 所有写入口（登记 / 导入 / 匹配 / 歧义 / 对账）都经由 resolveBankScope 等调用本函数。
 */
export function assertBankSchemaReady(db) {
  const state = bankSchemaContract(db);
  if (state.ok) return state;
  throw bankError(state.code, state.message, {
    version: state.version,
    target: state.target,
    problems: state.problems.slice(0, 20),
  });
}

export function bankSchemaVersion(db) {
  if (!tableExists(db, "bank_component_migrations")) return 0;
  const row = db.prepare(`SELECT COALESCE(MAX(version),0) AS v FROM bank_component_migrations`).get();
  return Number(row?.v || 0);
}

/** 只读自检：组件版本、表、迁移 / 备份记录与结构契约状态。 */
export function bankSchemaState(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name);
  const migrations = tableExists(db, "bank_component_migrations")
    ? db.prepare(`SELECT version, applied_at, note FROM bank_component_migrations ORDER BY version`).all()
    : [];
  const backups = tableExists(db, "bank_component_backups")
    ? db.prepare(`SELECT id, version, path, bytes, integrity, created_at, note FROM bank_component_backups ORDER BY id`).all()
    : [];
  const contract = bankSchemaContract(db);
  return {
    version: bankSchemaVersion(db),
    target: BANK_SCHEMA_VERSION,
    tables: tables.filter((t) => t.startsWith("bank_")),
    migrations,
    backups,
    contract: {
      ok: contract.ok,
      code: contract.code,
      problemCodes: [...new Set(contract.problems.map((p) => p.code))],
    },
  };
}

// ------------------------------------------------------------------ 事务
const txnDepth = new WeakMap();

/** 显式事务（外层 BEGIN IMMEDIATE，嵌套使用 SAVEPOINT）。失败回滚并原样抛错。 */
export function inTransaction(db, fn) {
  const depth = txnDepth.get(db) || 0;
  const savepoint = depth > 0 ? `bank_sp_${depth}` : null;
  if (savepoint) db.exec(`SAVEPOINT ${savepoint}`);
  else db.exec("BEGIN IMMEDIATE");
  txnDepth.set(db, depth + 1);
  try {
    const out = fn();
    if (savepoint) db.exec(`RELEASE ${savepoint}`);
    else db.exec("COMMIT");
    txnDepth.set(db, depth);
    return out;
  } catch (e) {
    try {
      if (savepoint) { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`); }
      else db.exec("ROLLBACK");
    } catch { /* 回滚失败时仍抛出原始错误 */ }
    txnDepth.set(db, depth);
    throw e;
  }
}

// ------------------------------------------------------------------ 新库创建事实
// 进程内回执：只有「本次调用确认文件不存在并亲手创建」才发回执。
// 回执不落盘、不跨进程，因此其他进程（含 CLI 独立调用）无法把已有库伪装成新库。
const freshClaims = new Map();

/**
 * 声明「本次初始化拥有创建事实」：仅当目标文件不存在时创建空文件并返回回执。
 * 目标已存在（哪怕是 0 字节 / 空业务库）一律拒绝。
 */
export function claimFreshDatabase({ dbPath }) {
  const abs = resolve(String(dbPath ?? ""));
  if (!abs || String(dbPath ?? "").trim() === "") {
    throw bankError("fresh_database_path_required", "必须显式提供新库路径");
  }
  if (existsSync(abs)) {
    throw bankError("fresh_database_file_exists", "目标库文件已存在，不能作为新库初始化", { dbPath: abs });
  }
  const fd = openSync(abs, "wx");
  closeSync(fd);
  const nonce = randomUUID();
  freshClaims.set(abs, { nonce, claimedAt: nowIso(), sizeAtClaim: statSync(abs).size });
  return { dbPath: abs, nonce, claimedAt: nowIso(), kind: "fresh-database-claim" };
}

function consumeFreshClaim(receipt, dbPath) {
  if (!receipt || typeof receipt !== "object") return false;
  const abs = resolve(String(dbPath ?? ""));
  const claim = freshClaims.get(abs);
  if (!claim) return false;
  if (receipt.kind !== "fresh-database-claim" || receipt.nonce !== claim.nonce) return false;
  if (resolve(String(receipt.dbPath ?? "")) !== abs) return false;
  freshClaims.delete(abs);
  return true;
}

/** 测试 / 诊断用：回执是否仍然有效（不消费）。 */
export function hasFreshDatabaseClaim(receipt, dbPath) {
  if (!receipt || typeof receipt !== "object") return false;
  const abs = resolve(String(dbPath ?? ""));
  const claim = freshClaims.get(abs);
  return !!claim && receipt.kind === "fresh-database-claim" && receipt.nonce === claim.nonce;
}

// ------------------------------------------------------------------ schema DDL
const COMPONENT_DDL = [
  `CREATE TABLE IF NOT EXISTS bank_component_migrations (
     version INTEGER PRIMARY KEY,
     applied_at TEXT NOT NULL,
     note TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS bank_component_backups (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     version INTEGER NOT NULL,
     path TEXT NOT NULL,
     bytes INTEGER,
     integrity TEXT NOT NULL DEFAULT 'unknown',
     created_at TEXT NOT NULL,
     note TEXT
   )`,
  // ---- 银行账户登记：account_set 内的稳定标识；币种目前只支持 CNY ----
  `CREATE TABLE IF NOT EXISTS bank_accounts (
     account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
     bank_account_id TEXT NOT NULL,
     source_id TEXT NOT NULL,
     currency TEXT NOT NULL,
     gl_account_code TEXT NOT NULL,
     display_name TEXT NOT NULL DEFAULT '',
     bank_account_no TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     PRIMARY KEY (account_set_id, bank_account_id)
   )`,
  // 首版没有可靠辅助维度：同一叶子科目不得并行绑定两个不可区分的银行账户。
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_accounts_gl
     ON bank_accounts (account_set_id, gl_account_code)`,
  `CREATE INDEX IF NOT EXISTS idx_bank_accounts_source
     ON bank_accounts (account_set_id, source_id)`,
  // ---- 批次：绑定账套 / 银行账户 / 来源 / 批次 ID / 文件内容摘要 / 映射与规范化版本 ----
  `CREATE TABLE IF NOT EXISTS bank_batches (
     account_set_id INTEGER NOT NULL,
     bank_account_id TEXT NOT NULL,
     source_id TEXT NOT NULL,
     batch_id TEXT NOT NULL,
     currency TEXT NOT NULL,
     period TEXT NOT NULL,
     content_sha256 TEXT NOT NULL,
     mapping_fingerprint TEXT NOT NULL,
     normalization_version TEXT NOT NULL,
     status TEXT NOT NULL,
     row_count INTEGER NOT NULL DEFAULT 0,
     imported_rows INTEGER NOT NULL DEFAULT 0,
     reused_rows INTEGER NOT NULL DEFAULT 0,
     ambiguous_rows INTEGER NOT NULL DEFAULT 0,
     attempts INTEGER NOT NULL DEFAULT 1,
     replay_of_batch TEXT,
     result_json TEXT NOT NULL DEFAULT '{}',
     error_code TEXT,
     error_message TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (account_set_id, bank_account_id, batch_id),
     FOREIGN KEY (account_set_id, bank_account_id)
       REFERENCES bank_accounts (account_set_id, bank_account_id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_bank_batches_file
     ON bank_batches (account_set_id, bank_account_id, source_id, content_sha256)`,
  `CREATE INDEX IF NOT EXISTS idx_bank_batches_status
     ON bank_batches (account_set_id, bank_account_id, status)`,
  // ---- 流水：来自银行文件的已确认入账行（不是账务凭证） ----
  `CREATE TABLE IF NOT EXISTS bank_transactions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     account_set_id INTEGER NOT NULL,
     bank_account_id TEXT NOT NULL,
     source_id TEXT NOT NULL,
     currency TEXT NOT NULL,
     txn_date TEXT NOT NULL,
     period TEXT NOT NULL,
     direction TEXT NOT NULL,
     amount_cents INTEGER NOT NULL,
     summary TEXT NOT NULL DEFAULT '',
     bank_ref_id TEXT,
     balance_after_cents INTEGER,
     content_fingerprint TEXT NOT NULL,
     row_fingerprint TEXT NOT NULL,
     batch_id TEXT NOT NULL,
     row_index INTEGER NOT NULL,
     origin TEXT NOT NULL,
     created_at TEXT NOT NULL,
     FOREIGN KEY (account_set_id, bank_account_id)
       REFERENCES bank_accounts (account_set_id, bank_account_id) ON DELETE CASCADE,
     FOREIGN KEY (account_set_id, bank_account_id, batch_id)
       REFERENCES bank_batches (account_set_id, bank_account_id, batch_id) ON DELETE CASCADE
   )`,
  // 有银行稳定 ID 时：账套 + 账户 + 来源命名空间 + 稳定 ID 唯一。
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_txn_ref
     ON bank_transactions (account_set_id, bank_account_id, source_id, bank_ref_id)
     WHERE bank_ref_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_txn_batch_row
     ON bank_transactions (account_set_id, bank_account_id, batch_id, row_index)`,
  `CREATE INDEX IF NOT EXISTS idx_bank_txn_scope_date
     ON bank_transactions (account_set_id, bank_account_id, txn_date)`,
  `CREATE INDEX IF NOT EXISTS idx_bank_txn_fingerprint
     ON bank_transactions (account_set_id, bank_account_id, source_id, row_fingerprint)`,
  // ---- 批次逐行追踪：导入 / 复用 / 回放 / 歧义决策都保留来源行证据 ----
  `CREATE TABLE IF NOT EXISTS bank_batch_rows (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     account_set_id INTEGER NOT NULL,
     bank_account_id TEXT NOT NULL,
     batch_id TEXT NOT NULL,
     row_index INTEGER NOT NULL,
     row_sha256 TEXT NOT NULL,
     row_fingerprint TEXT,
     status TEXT NOT NULL,
     transaction_id INTEGER REFERENCES bank_transactions(id) ON DELETE SET NULL,
     ambiguity_id INTEGER,
     note TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     UNIQUE (account_set_id, bank_account_id, batch_id, row_index),
     FOREIGN KEY (account_set_id, bank_account_id, batch_id)
       REFERENCES bank_batches (account_set_id, bank_account_id, batch_id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_bank_batch_rows_txn
     ON bank_batch_rows (transaction_id)`,
  // ---- 无稳定 ID 的疑似重复：保留证据，等待人工逐行判定 ----
  `CREATE TABLE IF NOT EXISTS bank_ambiguities (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     account_set_id INTEGER NOT NULL,
     bank_account_id TEXT NOT NULL,
     source_id TEXT NOT NULL,
     batch_id TEXT NOT NULL,
     row_index INTEGER NOT NULL,
     txn_date TEXT NOT NULL,
     period TEXT NOT NULL,
     direction TEXT NOT NULL,
     amount_cents INTEGER NOT NULL,
     summary TEXT NOT NULL DEFAULT '',
     currency TEXT NOT NULL,
     row_fingerprint TEXT NOT NULL,
     content_fingerprint TEXT NOT NULL,
     batch_row_sha256 TEXT NOT NULL,
     candidate_transaction_ids TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL,
     decision TEXT,
     decision_reason TEXT,
     resolved_transaction_id INTEGER REFERENCES bank_transactions(id) ON DELETE SET NULL,
     resolved_at TEXT,
     created_at TEXT NOT NULL,
     UNIQUE (account_set_id, bank_account_id, batch_id, row_index),
     FOREIGN KEY (account_set_id, bank_account_id, batch_id)
       REFERENCES bank_batches (account_set_id, bank_account_id, batch_id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_bank_ambiguities_status
     ON bank_ambiguities (account_set_id, bank_account_id, status)`,
  // ---- 人工确认 / 取消的匹配记录（不自动生成，不自动调整凭证） ----
  `CREATE TABLE IF NOT EXISTS bank_matches (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     account_set_id INTEGER NOT NULL,
     bank_account_id TEXT NOT NULL,
     currency TEXT NOT NULL,
     transaction_id INTEGER REFERENCES bank_transactions(id) ON DELETE SET NULL,
     voucher_id INTEGER NOT NULL,
     entry_id INTEGER NOT NULL,
     entry_line_no INTEGER NOT NULL,
     status TEXT NOT NULL,
     snapshot_json TEXT NOT NULL,
     reason TEXT NOT NULL DEFAULT '',
     confirmed_at TEXT NOT NULL,
     cancelled_at TEXT,
     cancel_reason TEXT,
     invalidated_at TEXT,
     invalidation_reason TEXT
   )`,
  // 同一流水 / 同一分录同时只能有一个有效匹配（数据库级防双重占用）。
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_matches_active_txn
     ON bank_matches (transaction_id) WHERE status = 'confirmed'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_matches_active_entry
     ON bank_matches (account_set_id, entry_id) WHERE status = 'confirmed'`,
  `CREATE INDEX IF NOT EXISTS idx_bank_matches_scope
     ON bank_matches (account_set_id, bank_account_id, status)`,
  // ---- 审计：append-only，无级联外键，业务对象删除也不抹掉证据 ----
  `CREATE TABLE IF NOT EXISTS bank_audit_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     account_set_id INTEGER,
     bank_account_id TEXT,
     event_type TEXT NOT NULL,
     subject_type TEXT NOT NULL DEFAULT '',
     subject_id TEXT NOT NULL DEFAULT '',
     detail_json TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_bank_audit_scope
     ON bank_audit_events (account_set_id, bank_account_id, event_type)`,
  // ---- 余额调节运行记录（每次重新计算都留痕；失效时标记 stale） ----
  `CREATE TABLE IF NOT EXISTS bank_reconcile_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     account_set_id INTEGER NOT NULL,
     bank_account_id TEXT NOT NULL,
     currency TEXT NOT NULL,
     period TEXT NOT NULL,
     as_of TEXT NOT NULL,
     status TEXT NOT NULL,
     book_close_cents INTEGER NOT NULL,
     adjusted_book_cents INTEGER NOT NULL,
     statement_close_cents INTEGER NOT NULL,
     adjusted_bank_cents INTEGER NOT NULL,
     difference_cents INTEGER NOT NULL,
     result_json TEXT NOT NULL,
     stale INTEGER NOT NULL DEFAULT 0,
     stale_reason TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_bank_reconcile_scope
     ON bank_reconcile_runs (account_set_id, bank_account_id, period, as_of)`,
];

/**
 * 备份门槛：只有注入的 LOCAL-06 一致备份实现成功生成并通过校验后才返回备份证据。
 * 备份实现可以是同步或返回 Promise。
 */
async function runBackupGate({ backupService, dbPath, outDir, version }) {
  if (!backupService || typeof backupService.createBackup !== "function" || typeof backupService.verifyBackup !== "function") {
    throw bankError("migration_backup_unavailable", "已有库加入 / 升级 bank_* 之前必须先完成可验证的一致备份；" +
      "当前未提供已审查的 LOCAL-06 备份实现（createBackup / verifyBackup）。", { dbPath });
  }
  let created;
  try {
    created = await backupService.createBackup({ dbPath, outDir });
  } catch (e) {
    throw bankError("migration_backup_failed", "迁移前一致备份失败，原库未改动", {
      reason: String(e?.message || e).slice(0, 200),
    });
  }
  const backupDir = created && typeof created === "object"
    ? (created.backupDir ?? created.outDir ?? created.path ?? created.dir ?? null)
    : null;
  if (!backupDir || typeof backupDir !== "string") {
    throw bankError("migration_backup_failed", "备份实现未返回可校验的备份位置", { version });
  }
  let verified;
  try {
    verified = await backupService.verifyBackup({ backupDir });
  } catch (e) {
    throw bankError("migration_backup_invalid", "迁移前备份无法通过校验，原库未改动", {
      reason: String(e?.message || e).slice(0, 200),
    });
  }
  const ok = verified === true
    || (verified && typeof verified === "object" && (verified.ok === true || verified.integrity === "ok"));
  if (!ok) {
    throw bankError("migration_backup_invalid", "迁移前备份校验未通过，原库未改动", {
      detail: verified && typeof verified === "object" ? { status: verified.status ?? null } : null,
    });
  }
  return {
    backupDir,
    bytes: Number.isFinite(Number(created?.bytes)) ? Number(created.bytes) : null,
    integrity: "ok",
  };
}

/**
 * 初始化 / 升级银行组件结构。
 *
 * 版本 / 结构契约（未来版本、矛盾版本、缺表 / 缺列 / 主键 / UNIQUE / FK 动作）：
 *  - 已符合本版本契约 → 幂等 no-op（already-initialized）；
 *  - 已经有 bank_* 结构但与契约不符 → 结构化拒绝，**不做任何 DDL / 备份 / 写入**，
 *    也不用 CREATE IF NOT EXISTS 静默修补坏库；
 *  - 完全没有 bank_* 表 → 走已有库备份门槛 / 新库创建事实后建组件。
 *
 * @param {DatabaseSync} db 显式连接
 * @param {object} options
 * @param {string} options.dbPath 当前库文件路径（备份与创建事实都绑定它）
 * @param {object|null} options.receipt claimFreshDatabase() 返回的进程内创建回执
 * @param {object|null} options.backupService LOCAL-06 备份服务（createBackup / verifyBackup）
 * @param {string|null} options.dataDir 备份输出目录（默认库文件所在目录）
 * @returns {Promise<{migrated:boolean, from:number, to:number, creation:string, backup:object|null}>}
 */
export async function ensureBankSchema(db, options = {}) {
  const { dbPath, receipt = null, backupService = null, dataDir = null } = options;
  if (!dbPath) throw bankError("db_path_required", "初始化银行组件必须显式提供库路径");
  const abs = resolve(String(dbPath));
  const contract = bankSchemaContract(db);
  const from = contract.version;
  if (contract.ok) {
    return { migrated: false, from, to: from, creation: "already-initialized", backup: null };
  }
  if (contract.initialized) {
    throw bankError(contract.code, contract.message, {
      from,
      to: BANK_SCHEMA_VERSION,
      problems: contract.problems.slice(0, 20),
    });
  }
  // 先核对账务核心结构；不是受支持的库就不做任何 DDL / 备份。
  assertBaseSchema(db);

  const fresh = consumeFreshClaim(receipt, abs);
  let creation = "fresh-database";
  let backup = null;
  if (!fresh) {
    creation = from === 0 ? "existing-database" : "component-upgrade";
    backup = await runBackupGate({
      backupService,
      dbPath: abs,
      outDir: dataDir || dirname(abs),
      version: BANK_SCHEMA_VERSION,
    });
  }

  // ---- 组件 DDL + 版本记录：单事务；失败整体回滚 ----
  try {
    return inTransaction(db, () => {
      for (const statement of COMPONENT_DDL) db.exec(statement);
      if (backup) {
        db.prepare(`INSERT INTO bank_component_backups (version, path, bytes, integrity, created_at, note)
                    VALUES (?,?,?,?,?,?)`)
          .run(BANK_SCHEMA_VERSION, backup.backupDir, backup.bytes, backup.integrity, nowIso(), creation);
      }
      db.prepare(`INSERT INTO bank_component_migrations (version, applied_at, note) VALUES (?,?,?)`)
        .run(BANK_SCHEMA_VERSION, nowIso(), `LOCAL-04 bank component (${creation})`);
      // DDL 后立即按契约自检；不合约就不留半个结构。
      const after = bankSchemaContract(db);
      if (!after.ok) {
        throw bankError(after.code, after.message, {
          from,
          to: BANK_SCHEMA_VERSION,
          problems: after.problems.slice(0, 20),
        });
      }
      return { migrated: true, from, to: BANK_SCHEMA_VERSION, creation, backup };
    });
  } catch (e) {
    if (e && typeof e.code === "string" && e.code.startsWith("bank_schema_")) throw e;
    throw bankError("bank_migration_failed", "银行组件结构初始化失败，原库已回滚", {
      from,
      to: BANK_SCHEMA_VERSION,
      reason: String(e?.message || e).slice(0, 200),
    });
  }
}

// ------------------------------------------------------------------ 账户
export function getBankAccount(db, { accountSetId, bankAccountId }) {
  return db.prepare(`SELECT * FROM bank_accounts WHERE account_set_id=? AND bank_account_id=?`)
    .get(accountSetId, bankAccountId) || null;
}

export function getBankAccountByGl(db, { accountSetId, glAccountCode }) {
  return db.prepare(`SELECT * FROM bank_accounts WHERE account_set_id=? AND gl_account_code=?`)
    .get(accountSetId, glAccountCode) || null;
}

export function insertBankAccount(db, {
  accountSetId, bankAccountId, sourceId, currency, glAccountCode,
  displayName = "", bankAccountNo = "",
}) {
  db.prepare(`INSERT INTO bank_accounts
                (account_set_id, bank_account_id, source_id, currency, gl_account_code,
                 display_name, bank_account_no, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(accountSetId, bankAccountId, sourceId, currency, glAccountCode, displayName, bankAccountNo, nowIso());
  return getBankAccount(db, { accountSetId, bankAccountId });
}

export function listBankAccounts(db, { accountSetId }) {
  return db.prepare(`SELECT * FROM bank_accounts WHERE account_set_id=? ORDER BY bank_account_id`)
    .all(accountSetId);
}

// ------------------------------------------------------------------ 批次
export function getBatch(db, { accountSetId, bankAccountId, batchId }) {
  return db.prepare(`SELECT * FROM bank_batches
                      WHERE account_set_id=? AND bank_account_id=? AND batch_id=?`)
    .get(accountSetId, bankAccountId, batchId) || null;
}

export function findBatchByFile(db, {
  accountSetId, bankAccountId, sourceId, contentSha256, mappingFingerprint, statuses = ["completed", "pending_review"],
}) {
  const placeholders = statuses.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM bank_batches
                      WHERE account_set_id=? AND bank_account_id=? AND source_id=?
                        AND content_sha256=? AND mapping_fingerprint=? AND status IN (${placeholders})
                      ORDER BY created_at, batch_id LIMIT 1`)
    .get(accountSetId, bankAccountId, sourceId, contentSha256, mappingFingerprint, ...statuses) || null;
}

export function insertBatch(db, {
  accountSetId, bankAccountId, sourceId, batchId, currency, period, contentSha256,
  mappingFingerprint, normalizationVersion, status = "pending", result = {}, attempts = 1,
}) {
  const at = nowIso();
  db.prepare(`INSERT INTO bank_batches
                (account_set_id, bank_account_id, source_id, batch_id, currency, period,
                 content_sha256, mapping_fingerprint, normalization_version, status,
                 row_count, imported_rows, reused_rows, ambiguous_rows, attempts,
                 replay_of_batch, result_json, error_code, error_message, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,?,NULL,?,NULL,NULL,?,?)`)
    .run(accountSetId, bankAccountId, sourceId, batchId, currency, period,
      contentSha256, mappingFingerprint, normalizationVersion, status, attempts,
      JSON.stringify(result ?? {}), at, at);
  return getBatch(db, { accountSetId, bankAccountId, batchId });
}

/**
 * 删除一条失败批次记录，用于「同一 batchId 修正文件后重试」。
 * 只允许删除 status='failed' 的批次：失败批次的业务事务已整体回滚，没有留下任何流水 /
 * 逐行记录 / 歧义 / 匹配；已完成或待判定的批次永远不能这样被清理。
 */
export function removeFailedBatch(db, { accountSetId, bankAccountId, batchId }) {
  const info = db.prepare(`DELETE FROM bank_batches
                            WHERE account_set_id=? AND bank_account_id=? AND batch_id=? AND status='failed'`)
    .run(accountSetId, bankAccountId, batchId);
  return Number(info.changes || 0) > 0;
}

/** 更新批次统计 / 状态 / 结果（不动 created_at 与 attempts）。 */
export function updateBatch(db, {
  accountSetId, bankAccountId, batchId, status, rowCount, importedRows, reusedRows,
  ambiguousRows, result, replayOfBatch = null, attempts = null,
}) {
  db.prepare(`UPDATE bank_batches
                 SET status=?, row_count=?, imported_rows=?, reused_rows=?, ambiguous_rows=?,
                     result_json=?, replay_of_batch=?, updated_at=?, error_code=NULL, error_message=NULL,
                     attempts=COALESCE(?, attempts)
               WHERE account_set_id=? AND bank_account_id=? AND batch_id=?`)
    .run(status, rowCount ?? 0, importedRows ?? 0, reusedRows ?? 0, ambiguousRows ?? 0,
      JSON.stringify(result ?? {}), replayOfBatch, nowIso(), attempts, accountSetId, bankAccountId, batchId);
  return getBatch(db, { accountSetId, bankAccountId, batchId });
}

/**
 * 记录失败批次（业务事务回滚之后单独写入，仅审计用途，不含业务状态）。
 * 不吞原始错误：调用方在 catch 中调用本函数后必须重新抛出原错误。
 *
 * 只允许更新「failed」状态的同名批次（同一批次重试再失败）。已完成（completed）与
 * 未决（pending_review）批次永远不会被失败审计覆写：前者保护既有成果，后者保护
 * 尚未判定完的疑似重复证据与批次状态。
 */
export function markBatchFailed(db, {
  accountSetId, bankAccountId, batchId, sourceId, currency, period, contentSha256,
  mappingFingerprint, normalizationVersion, errorCode, errorMessage,
}) {
  const at = nowIso();
  db.prepare(`INSERT INTO bank_batches
                (account_set_id, bank_account_id, source_id, batch_id, currency, period,
                 content_sha256, mapping_fingerprint, normalization_version, status,
                 row_count, imported_rows, reused_rows, ambiguous_rows, attempts,
                 replay_of_batch, result_json, error_code, error_message, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,'failed',0,0,0,0,1,NULL,'{}',?,?,?,?)
              ON CONFLICT(account_set_id, bank_account_id, batch_id) DO UPDATE SET
                status='failed',
                updated_at=excluded.updated_at,
                attempts=bank_batches.attempts + 1,
                error_code=excluded.error_code,
                error_message=excluded.error_message
              WHERE bank_batches.status = 'failed'`)
    .run(accountSetId, bankAccountId, sourceId, batchId, currency, period,
      contentSha256, mappingFingerprint, normalizationVersion,
      String(errorCode ?? "").slice(0, 120), String(errorMessage ?? "").slice(0, 2000), at, at);
  return getBatch(db, { accountSetId, bankAccountId, batchId });
}

/** 批次展示列表：只用于展示（默认 200）。状态计数请用 `countBatchesByStatus`。 */
export function listBatches(db, { accountSetId, bankAccountId, limit = 200 }) {
  return db.prepare(`SELECT * FROM bank_batches
                      WHERE account_set_id=? AND bank_account_id=?
                      ORDER BY created_at DESC, batch_id DESC LIMIT ?`)
    .all(accountSetId, bankAccountId, limit);
}

// ------------------------------------------------------------------ 流水
export function findTransactionByRefId(db, { accountSetId, bankAccountId, sourceId, bankRefId }) {
  return db.prepare(`SELECT * FROM bank_transactions
                      WHERE account_set_id=? AND bank_account_id=? AND source_id=? AND bank_ref_id=?`)
    .get(accountSetId, bankAccountId, sourceId, bankRefId) || null;
}

export function findTransactionsByFingerprint(db, {
  accountSetId, bankAccountId, sourceId, rowFingerprint,
}) {
  return db.prepare(`SELECT * FROM bank_transactions
                      WHERE account_set_id=? AND bank_account_id=? AND source_id=? AND row_fingerprint=?
                      ORDER BY id`)
    .all(accountSetId, bankAccountId, sourceId, rowFingerprint);
}

export function getTransaction(db, { accountSetId, bankAccountId, transactionId }) {
  return db.prepare(`SELECT * FROM bank_transactions
                      WHERE account_set_id=? AND bank_account_id=? AND id=?`)
    .get(accountSetId, bankAccountId, transactionId) || null;
}

export function insertTransaction(db, {
  accountSetId, bankAccountId, sourceId, currency, txnDate, period, direction, amountCents,
  summary, bankRefId, balanceAfterCents, contentFingerprint, rowFingerprint, batchId,
  rowIndex, origin,
}) {
  const info = db.prepare(`INSERT INTO bank_transactions
                (account_set_id, bank_account_id, source_id, currency, txn_date, period, direction,
                 amount_cents, summary, bank_ref_id, balance_after_cents, content_fingerprint,
                 row_fingerprint, batch_id, row_index, origin, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(accountSetId, bankAccountId, sourceId, currency, txnDate, period, direction,
      amountCents, summary, bankRefId, balanceAfterCents, contentFingerprint,
      rowFingerprint, batchId, rowIndex, origin, nowIso());
  return db.prepare(`SELECT * FROM bank_transactions WHERE id=?`).get(Number(info.lastInsertRowid));
}

/** 流水展示列表：只用于展示（默认 500）。内部判定请用完整查询 / SQL 聚合。 */
export function listTransactions(db, {
  accountSetId, bankAccountId, from = null, to = null, limit = 500,
}) {
  const where = ["account_set_id=?", "bank_account_id=?"];
  const args = [accountSetId, bankAccountId];
  if (from) { where.push("txn_date >= ?"); args.push(from); }
  if (to) { where.push("txn_date <= ?"); args.push(to); }
  args.push(limit);
  return db.prepare(`SELECT * FROM bank_transactions WHERE ${where.join(" AND ")}
                      ORDER BY txn_date, id LIMIT ?`).all(...args);
}

// ------------------------------------------------------------------ 逐行追踪
export function insertBatchRow(db, {
  accountSetId, bankAccountId, batchId, rowIndex, rowSha256, rowFingerprint = null,
  status, transactionId = null, ambiguityId = null, note = "",
}) {
  db.prepare(`INSERT INTO bank_batch_rows
                (account_set_id, bank_account_id, batch_id, row_index, row_sha256, row_fingerprint,
                 status, transaction_id, ambiguity_id, note, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(accountSetId, bankAccountId, batchId, rowIndex, rowSha256, rowFingerprint,
      status, transactionId, ambiguityId, note, nowIso());
}

export function listBatchRows(db, { accountSetId, bankAccountId, batchId }) {
  return db.prepare(`SELECT * FROM bank_batch_rows
                      WHERE account_set_id=? AND bank_account_id=? AND batch_id=? ORDER BY row_index`)
    .all(accountSetId, bankAccountId, batchId);
}

// ------------------------------------------------------------------ 歧义
export function insertAmbiguity(db, {
  accountSetId, bankAccountId, sourceId, batchId, rowIndex, txnDate, period, direction,
  amountCents, summary, currency, rowFingerprint, contentFingerprint, batchRowSha256,
  candidateTransactionIds = [],
}) {
  const info = db.prepare(`INSERT INTO bank_ambiguities
                (account_set_id, bank_account_id, source_id, batch_id, row_index, txn_date, period,
                 direction, amount_cents, summary, currency, row_fingerprint, content_fingerprint,
                 batch_row_sha256, candidate_transaction_ids, status, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`)
    .run(accountSetId, bankAccountId, sourceId, batchId, rowIndex, txnDate, period, direction,
      amountCents, summary, currency, rowFingerprint, contentFingerprint, batchRowSha256,
      JSON.stringify(candidateTransactionIds), nowIso());
  return db.prepare(`SELECT * FROM bank_ambiguities WHERE id=?`).get(Number(info.lastInsertRowid));
}

export function getAmbiguity(db, { accountSetId, bankAccountId, ambiguityId }) {
  return db.prepare(`SELECT * FROM bank_ambiguities
                      WHERE account_set_id=? AND bank_account_id=? AND id=?`)
    .get(accountSetId, bankAccountId, ambiguityId) || null;
}

/** 歧义展示列表：只用于展示（默认 500）。真实数量请用 `countPendingAmbiguities*`。 */
export function listAmbiguities(db, { accountSetId, bankAccountId, status = null, limit = 500 }) {
  const where = ["account_set_id=?", "bank_account_id=?"];
  const args = [accountSetId, bankAccountId];
  if (status) { where.push("status=?"); args.push(status); }
  args.push(limit);
  return db.prepare(`SELECT * FROM bank_ambiguities WHERE ${where.join(" AND ")}
                      ORDER BY txn_date, id LIMIT ?`).all(...args);
}

export function resolveAmbiguityRecord(db, {
  ambiguityId, decision, reason, transactionId, status = "resolved",
}) {
  db.prepare(`UPDATE bank_ambiguities
                 SET status=?, decision=?, decision_reason=?, resolved_transaction_id=?, resolved_at=?
               WHERE id=? AND status='pending'`)
    .run(status, decision, reason, transactionId, nowIso(), ambiguityId);
  return db.prepare(`SELECT * FROM bank_ambiguities WHERE id=?`).get(ambiguityId);
}

export function countPendingAmbiguities(db, { accountSetId, bankAccountId, batchId = null }) {
  const where = ["account_set_id=?", "bank_account_id=?", "status='pending'"];
  const args = [accountSetId, bankAccountId];
  if (batchId) { where.push("batch_id=?"); args.push(batchId); }
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM bank_ambiguities WHERE ${where.join(" AND ")}`)
    .get(...args).n);
}

// ------------------------------------------------------------------ 匹配
export function getMatch(db, { accountSetId, bankAccountId, matchId }) {
  return db.prepare(`SELECT * FROM bank_matches
                      WHERE account_set_id=? AND bank_account_id=? AND id=?`)
    .get(accountSetId, bankAccountId, matchId) || null;
}

export function findActiveMatchForTransaction(db, { accountSetId, bankAccountId, transactionId }) {
  return db.prepare(`SELECT * FROM bank_matches
                      WHERE account_set_id=? AND bank_account_id=? AND transaction_id=? AND status='confirmed'`)
    .get(accountSetId, bankAccountId, transactionId) || null;
}

export function findActiveMatchForEntry(db, { accountSetId, entryId }) {
  return db.prepare(`SELECT * FROM bank_matches WHERE account_set_id=? AND entry_id=? AND status='confirmed'`)
    .get(accountSetId, entryId) || null;
}

export function insertMatch(db, {
  accountSetId, bankAccountId, currency, transactionId, voucherId, entryId, entryLineNo,
  snapshot, reason = "",
}) {
  const info = db.prepare(`INSERT INTO bank_matches
                (account_set_id, bank_account_id, currency, transaction_id, voucher_id, entry_id,
                 entry_line_no, status, snapshot_json, reason, confirmed_at)
              VALUES (?,?,?,?,?,?,?,'confirmed',?,?,?)`)
    .run(accountSetId, bankAccountId, currency, transactionId, voucherId, entryId, entryLineNo,
      JSON.stringify(snapshot ?? {}), String(reason ?? ""), nowIso());
  return getMatch(db, { accountSetId, bankAccountId, matchId: Number(info.lastInsertRowid) });
}

/**
 * 展示分页的匹配列表：**只用于展示**，默认上限 500。
 * 内部业务判定（失效核验 / 候选占用 / 对账未达项 / 状态计数）必须使用下面的完整扫描或 SQL 聚合，
 * 否则超过一页后的真实数据会被静默当成不存在。
 */
export function listMatches(db, { accountSetId, bankAccountId, statuses = null, limit = 500 }) {
  const where = ["account_set_id=?", "bank_account_id=?"];
  const args = [accountSetId, bankAccountId];
  if (Array.isArray(statuses) && statuses.length) {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  args.push(limit);
  return db.prepare(`SELECT * FROM bank_matches WHERE ${where.join(" AND ")}
                      ORDER BY id LIMIT ?`).all(...args);
}

// ------------------------------------------------------------------ 内部完整扫描 / 聚合
// 展示分页（LIMIT）只能用于输出；以下函数给内部完整判定用，确保结果与数据量无关。
// 只对内部固定表名生效，不接受外部传入的表名。
const INTERNAL_SCAN_CHUNK = 500;

/** 键集游标完整扫描：按 rowid 分块读取整个过滤集合（内存受块大小约束，结果完整）。 */
function scanTableComplete(db, { table, where = [], params = [], chunkSize = INTERNAL_SCAN_CHUNK }) {
  const rows = [];
  const clauses = [...where, "rowid > ?"];
  const sql = `SELECT rowid AS _bank_scan_rowid, * FROM ${table}
                WHERE ${clauses.join(" AND ")} ORDER BY rowid LIMIT ?`;
  let cursor = 0;
  for (;;) {
    const chunk = db.prepare(sql).all(...params, cursor, chunkSize);
    for (const row of chunk) {
      cursor = Number(row._bank_scan_rowid);
      const copy = { ...row };
      delete copy._bank_scan_rowid;
      rows.push(copy);
    }
    if (chunk.length < chunkSize) break;
  }
  return rows;
}

/** 范围内**全部**匹配（忽略展示分页）。 */
export function listAllMatches(db, { accountSetId, bankAccountId, statuses = null }) {
  const where = ["account_set_id=?", "bank_account_id=?"];
  const params = [accountSetId, bankAccountId];
  if (Array.isArray(statuses) && statuses.length) {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  return scanTableComplete(db, { table: "bank_matches", where, params });
}

/** 给定流水 ID 集合的有效匹配（用于展示视图；按 ID 分块，不依赖总匹配数）。 */
export function listMatchesForTransactionIds(db, { accountSetId, bankAccountId, transactionIds = [] }) {
  const ids = transactionIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const out = [];
  const chunk = 400;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    out.push(...db.prepare(`SELECT * FROM bank_matches
                             WHERE account_set_id=? AND bank_account_id=? AND status='confirmed'
                               AND transaction_id IN (${slice.map(() => "?").join(",")})`)
      .all(accountSetId, bankAccountId, ...slice));
  }
  return out;
}

/**
 * 范围内全部有效匹配的双方日期（用于按 asOf 视角判定未达项）。
 * 不分页：漏读任何一条都会把已核销项误列为未达，或把未发生的一侧当成已发生。
 */
export function listConfirmedMatchSides(db, { accountSetId, bankAccountId }) {
  return db.prepare(`SELECT m.id, m.transaction_id, m.voucher_id, m.entry_id,
                            v.voucher_date AS voucher_date, t.txn_date AS txn_date
                       FROM bank_matches m
                       LEFT JOIN vouchers v ON v.id = m.voucher_id
                       LEFT JOIN bank_transactions t ON t.id = m.transaction_id
                      WHERE m.account_set_id=? AND m.bank_account_id=? AND m.status='confirmed'
                      ORDER BY m.id`).all(accountSetId, bankAccountId);
}

function groupCount(db, table, column, accountSetId, bankAccountId) {
  const rows = db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM ${table}
                            WHERE account_set_id=? AND bank_account_id=? GROUP BY ${column}`)
    .all(accountSetId, bankAccountId);
  return new Map(rows.map((r) => [String(r.k), Number(r.n)]));
}

/** 批次状态真实计数（SQL 聚合，不是当前展示页的计数）。 */
export function countBatchesByStatus(db, { accountSetId, bankAccountId }) {
  const byStatus = groupCount(db, "bank_batches", "status", accountSetId, bankAccountId);
  const total = [...byStatus.values()].reduce((sum, n) => sum + n, 0);
  return {
    total,
    completed: byStatus.get("completed") ?? 0,
    pendingReview: byStatus.get("pending_review") ?? 0,
    failed: byStatus.get("failed") ?? 0,
    byStatus: Object.fromEntries(byStatus),
  };
}

/** 匹配状态真实计数（SQL 聚合）。 */
export function countMatchesByStatus(db, { accountSetId, bankAccountId }) {
  const byStatus = groupCount(db, "bank_matches", "status", accountSetId, bankAccountId);
  return {
    confirmed: byStatus.get("confirmed") ?? 0,
    cancelled: byStatus.get("cancelled") ?? 0,
    invalidated: byStatus.get("invalidated") ?? 0,
    byStatus: Object.fromEntries(byStatus),
  };
}

/** 流水总数与「已有效匹配」数（SQL 聚合；不受展示 limit 影响）。 */
export function countTransactionMatchStates(db, { accountSetId, bankAccountId }) {
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM bank_transactions
                                    WHERE account_set_id=? AND bank_account_id=?`)
    .get(accountSetId, bankAccountId).n);
  const matched = Number(db.prepare(`SELECT COUNT(*) AS n FROM bank_transactions t
                                      WHERE t.account_set_id=? AND t.bank_account_id=?
                                        AND EXISTS (SELECT 1 FROM bank_matches m
                                                     WHERE m.account_set_id=t.account_set_id
                                                       AND m.bank_account_id=t.bank_account_id
                                                       AND m.transaction_id=t.id
                                                       AND m.status='confirmed')`)
    .get(accountSetId, bankAccountId).n);
  return { total, matched, unmatched: total - matched };
}

/** 截止日（含）之前的未决歧义真实数量。 */
export function countPendingAmbiguitiesOnOrBefore(db, { accountSetId, bankAccountId, asOf }) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM bank_ambiguities
                             WHERE account_set_id=? AND bank_account_id=? AND status='pending'
                               AND txn_date <= ?`)
    .get(accountSetId, bankAccountId, asOf).n);
}

/** 截止日（含）之前的未决歧义证据（只限展示条数，不是计数依据）。 */
export function listPendingAmbiguitiesOnOrBefore(db, {
  accountSetId, bankAccountId, asOf, limit = 20,
}) {
  return db.prepare(`SELECT * FROM bank_ambiguities
                      WHERE account_set_id=? AND bank_account_id=? AND status='pending'
                        AND txn_date <= ?
                      ORDER BY txn_date, id LIMIT ?`)
    .all(accountSetId, bankAccountId, asOf, limit);
}

/** 仍需复核的失效匹配（其流水 / 分录当前都没有有效匹配）真实数量；先过滤再限条。 */
export function countUnresolvedInvalidatedMatches(db, { accountSetId, bankAccountId }) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM bank_matches m
                             WHERE m.account_set_id=? AND m.bank_account_id=? AND m.status='invalidated'
                               AND NOT EXISTS (SELECT 1 FROM bank_matches c
                                                WHERE c.account_set_id=m.account_set_id AND c.status='confirmed'
                                                  AND c.entry_id=m.entry_id)
                               AND (m.transaction_id IS NULL OR NOT EXISTS (
                                     SELECT 1 FROM bank_matches c2
                                      WHERE c2.account_set_id=m.account_set_id AND c2.status='confirmed'
                                        AND c2.transaction_id=m.transaction_id))`)
    .get(accountSetId, bankAccountId).n);
}

/** 仍需复核的失效匹配证据（先按同一条件过滤，再限展示条数）。 */
export function listUnresolvedInvalidatedMatches(db, { accountSetId, bankAccountId, limit = 20 }) {
  return db.prepare(`SELECT m.* FROM bank_matches m
                      WHERE m.account_set_id=? AND m.bank_account_id=? AND m.status='invalidated'
                        AND NOT EXISTS (SELECT 1 FROM bank_matches c
                                         WHERE c.account_set_id=m.account_set_id AND c.status='confirmed'
                                           AND c.entry_id=m.entry_id)
                        AND (m.transaction_id IS NULL OR NOT EXISTS (
                              SELECT 1 FROM bank_matches c2
                               WHERE c2.account_set_id=m.account_set_id AND c2.status='confirmed'
                                 AND c2.transaction_id=m.transaction_id))
                      ORDER BY m.id LIMIT ?`).all(accountSetId, bankAccountId, limit);
}

// ------------------------------------------------------------------ 审计
export function appendAuditEvent(db, {
  accountSetId = null, bankAccountId = null, eventType, subjectType = "", subjectId = "", detail = {},
}) {
  const info = db.prepare(`INSERT INTO bank_audit_events
                (account_set_id, bank_account_id, event_type, subject_type, subject_id, detail_json, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(accountSetId, bankAccountId, eventType, subjectType, String(subjectId ?? ""),
      JSON.stringify(detail ?? {}), nowIso());
  return Number(info.lastInsertRowid);
}

export function listAuditEvents(db, {
  accountSetId = null, bankAccountId = null, eventType = null, limit = 200,
}) {
  const where = [];
  const args = [];
  if (accountSetId !== null && accountSetId !== undefined) { where.push("account_set_id=?"); args.push(accountSetId); }
  if (bankAccountId) { where.push("bank_account_id=?"); args.push(bankAccountId); }
  if (eventType) { where.push("event_type=?"); args.push(eventType); }
  args.push(limit);
  const sql = `SELECT * FROM bank_audit_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...args);
}

// ------------------------------------------------------------------ 余额调节运行记录
export function insertReconcileRun(db, {
  accountSetId, bankAccountId, currency, period, asOf, status, bookCloseCents,
  adjustedBookCents, statementCloseCents, adjustedBankCents, differenceCents, result,
}) {
  db.prepare(`UPDATE bank_reconcile_runs SET stale=1, stale_reason='superseded'
               WHERE account_set_id=? AND bank_account_id=? AND stale=0`)
    .run(accountSetId, bankAccountId);
  const info = db.prepare(`INSERT INTO bank_reconcile_runs
                (account_set_id, bank_account_id, currency, period, as_of, status, book_close_cents,
                 adjusted_book_cents, statement_close_cents, adjusted_bank_cents, difference_cents,
                 result_json, stale, stale_reason, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?)`)
    .run(accountSetId, bankAccountId, currency, period, asOf, status, bookCloseCents,
      adjustedBookCents, statementCloseCents, adjustedBankCents, differenceCents,
      JSON.stringify(result ?? {}), nowIso());
  return Number(info.lastInsertRowid);
}

export function markReconcileRunsStale(db, { accountSetId, bankAccountId, reason }) {
  const info = db.prepare(`UPDATE bank_reconcile_runs SET stale=1, stale_reason=?
                            WHERE account_set_id=? AND bank_account_id=? AND stale=0`)
    .run(String(reason ?? "invalidated"), accountSetId, bankAccountId);
  return Number(info.changes || 0);
}

export function listReconcileRuns(db, { accountSetId, bankAccountId, limit = 20 }) {
  return db.prepare(`SELECT id, account_set_id, bank_account_id, currency, period, as_of, status,
                            book_close_cents, adjusted_book_cents, statement_close_cents,
                            adjusted_bank_cents, difference_cents, stale, stale_reason, created_at
                       FROM bank_reconcile_runs
                      WHERE account_set_id=? AND bank_account_id=?
                      ORDER BY id DESC LIMIT ?`).all(accountSetId, bankAccountId, limit);
}

export { nowIso as bankNowIso };
