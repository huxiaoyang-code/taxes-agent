// bank-storage.mjs — LOCAL-04 银行组件持久层：bank_* 独立命名空间、组件版本与迁移门槛。
//
// 设计约束（LOCAL-04 / LOCAL-06 依赖）：
// 1) 本文件加载时不 import db.mjs / accounting.mjs：业务函数显式接收 DatabaseSync 连接，
//    导入本模块不会打开默认库、不会建表、不会触发全局迁移。
//    initializeFreshDatabaseCore 仅在显式新建时延迟加载固定核心入口，其 actual-connection hook 在 DDL 前核验。
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
import { existsSync, mkdirSync, openSync, closeSync, fstatSync, readSync, readFileSync, writeFileSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as freshGuard from "./database-open-guard.mjs";

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
 * 表级结构契约：列规范（类型 / NOT NULL / 默认值）+ 主键列顺序 + rowid 别名语义。
 * `columns` 由列规范键派生，避免「名字数组」和「完整列规格」两份清单各自漂移。
 *
 * `rowidAlias` 显式登记主键是否为 `INTEGER PRIMARY KEY` 的 rowid 别名：
 *  - `true`：不另建主键索引，主键列与 rowid 必须逐行相等（`bank_transactions` 等 `id INTEGER PRIMARY KEY`）；
 *  - `false`：主键另有自动索引（本组件的 `bank_accounts` / `bank_batches` 复合主键）。
 * 备份验证器按本字段核对**真实 rowid 语义**，因此这里写死事实，而不是按名字 / 列数推断。
 */
const tableContract = (columnSpecs, primaryKey, { rowidAlias }) => Object.freeze({
  columns: Object.freeze(Object.keys(columnSpecs)),
  columnSpecs: Object.freeze(columnSpecs),
  primaryKey: Object.freeze([...primaryKey]),
  rowidAlias: rowidAlias === true,
});

/**
 * 索引契约条目：列序 + UNIQUE / partial / 谓词 + **完整键语义**（`keys`）+ 来源 `origin`。
 *
 * 产品真实 DDL 里每个索引键都是「普通列 + `BINARY` 排序规则 + 升序 + 非表达式」。把这一事实
 * 写进契约（而不是只记列名），才能拒绝 `COLLATE NOCASE` / `RTRIM` / `DESC` / 表达式等
 * 改变真实写入行为的同名索引。`origin` 固定来源：命名索引只能来自 `CREATE INDEX`（`c`），
 * 自动索引只能来自表级 PRIMARY KEY（`pk`）或 UNIQUE 约束（`u`）。
 *
 * 业务写门槛（`bankSchemaContract`）与备份验证器（LOCAL-06 `local-backup.mjs`）都按
 * `keys` / `origin` / `unique` / `partial` / `where` **逐项**比对；备份验证器还会把这些
 * 事实写进组件结构契约并核对真实 rowid 别名语义（见 `BANK_COMPONENT_STRUCTURE`）。
 */
const indexContract = ({ index = null, table, columns, unique, partial = false, where = null, origin }) => Object.freeze({
  index,
  table,
  columns: Object.freeze([...columns]),
  unique,
  partial,
  where: where ?? null,
  origin,
  keys: Object.freeze(columns.map((column) => Object.freeze({
    column, collation: "BINARY", desc: false, expression: false, rowid: false,
  }))),
});

/**
 * 组件结构契约（v1）：表 / 关键列 / 主键 / 索引（含 UNIQUE 与部分索引）/ 外键动作。
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
    bank_component_migrations: tableContract({
      version: "INTEGER",
      applied_at: "TEXT NOT NULL",
      note: "TEXT",
    }, ["version"], { rowidAlias: true }),
    bank_component_backups: tableContract({
      id: "INTEGER",
      version: "INTEGER NOT NULL",
      path: "TEXT NOT NULL",
      bytes: "INTEGER",
      integrity: "TEXT NOT NULL DEFAULT 'unknown'",
      created_at: "TEXT NOT NULL",
      note: "TEXT",
    }, ["id"], { rowidAlias: true }),
    bank_accounts: tableContract({
      account_set_id: "INTEGER NOT NULL",
      bank_account_id: "TEXT NOT NULL",
      source_id: "TEXT NOT NULL",
      currency: "TEXT NOT NULL",
      gl_account_code: "TEXT NOT NULL",
      display_name: "TEXT NOT NULL DEFAULT ''",
      bank_account_no: "TEXT NOT NULL DEFAULT ''",
      created_at: "TEXT NOT NULL",
    }, ["account_set_id", "bank_account_id"], { rowidAlias: false }),
    bank_batches: tableContract({
      account_set_id: "INTEGER NOT NULL",
      bank_account_id: "TEXT NOT NULL",
      source_id: "TEXT NOT NULL",
      batch_id: "TEXT NOT NULL",
      currency: "TEXT NOT NULL",
      period: "TEXT NOT NULL",
      content_sha256: "TEXT NOT NULL",
      mapping_fingerprint: "TEXT NOT NULL",
      normalization_version: "TEXT NOT NULL",
      status: "TEXT NOT NULL",
      row_count: "INTEGER NOT NULL DEFAULT 0",
      imported_rows: "INTEGER NOT NULL DEFAULT 0",
      reused_rows: "INTEGER NOT NULL DEFAULT 0",
      ambiguous_rows: "INTEGER NOT NULL DEFAULT 0",
      attempts: "INTEGER NOT NULL DEFAULT 1",
      replay_of_batch: "TEXT",
      result_json: "TEXT NOT NULL DEFAULT '{}'",
      error_code: "TEXT",
      error_message: "TEXT",
      created_at: "TEXT NOT NULL",
      updated_at: "TEXT NOT NULL",
    }, ["account_set_id", "bank_account_id", "batch_id"], { rowidAlias: false }),
    bank_transactions: tableContract({
      id: "INTEGER",
      account_set_id: "INTEGER NOT NULL",
      bank_account_id: "TEXT NOT NULL",
      source_id: "TEXT NOT NULL",
      currency: "TEXT NOT NULL",
      txn_date: "TEXT NOT NULL",
      period: "TEXT NOT NULL",
      direction: "TEXT NOT NULL",
      amount_cents: "INTEGER NOT NULL",
      summary: "TEXT NOT NULL DEFAULT ''",
      bank_ref_id: "TEXT",
      balance_after_cents: "INTEGER",
      content_fingerprint: "TEXT NOT NULL",
      row_fingerprint: "TEXT NOT NULL",
      batch_id: "TEXT NOT NULL",
      row_index: "INTEGER NOT NULL",
      origin: "TEXT NOT NULL",
      created_at: "TEXT NOT NULL",
    }, ["id"], { rowidAlias: true }),
    bank_batch_rows: tableContract({
      id: "INTEGER",
      account_set_id: "INTEGER NOT NULL",
      bank_account_id: "TEXT NOT NULL",
      batch_id: "TEXT NOT NULL",
      row_index: "INTEGER NOT NULL",
      row_sha256: "TEXT NOT NULL",
      row_fingerprint: "TEXT",
      status: "TEXT NOT NULL",
      transaction_id: "INTEGER",
      ambiguity_id: "INTEGER",
      note: "TEXT NOT NULL DEFAULT ''",
      created_at: "TEXT NOT NULL",
    }, ["id"], { rowidAlias: true }),
    bank_ambiguities: tableContract({
      id: "INTEGER",
      account_set_id: "INTEGER NOT NULL",
      bank_account_id: "TEXT NOT NULL",
      source_id: "TEXT NOT NULL",
      batch_id: "TEXT NOT NULL",
      row_index: "INTEGER NOT NULL",
      txn_date: "TEXT NOT NULL",
      period: "TEXT NOT NULL",
      direction: "TEXT NOT NULL",
      amount_cents: "INTEGER NOT NULL",
      summary: "TEXT NOT NULL DEFAULT ''",
      currency: "TEXT NOT NULL",
      row_fingerprint: "TEXT NOT NULL",
      content_fingerprint: "TEXT NOT NULL",
      batch_row_sha256: "TEXT NOT NULL",
      candidate_transaction_ids: "TEXT NOT NULL DEFAULT '[]'",
      status: "TEXT NOT NULL",
      decision: "TEXT",
      decision_reason: "TEXT",
      resolved_transaction_id: "INTEGER",
      resolved_at: "TEXT",
      created_at: "TEXT NOT NULL",
    }, ["id"], { rowidAlias: true }),
    bank_matches: tableContract({
      id: "INTEGER",
      account_set_id: "INTEGER NOT NULL",
      bank_account_id: "TEXT NOT NULL",
      currency: "TEXT NOT NULL",
      transaction_id: "INTEGER",
      voucher_id: "INTEGER NOT NULL",
      entry_id: "INTEGER NOT NULL",
      entry_line_no: "INTEGER NOT NULL",
      status: "TEXT NOT NULL",
      snapshot_json: "TEXT NOT NULL",
      reason: "TEXT NOT NULL DEFAULT ''",
      confirmed_at: "TEXT NOT NULL",
      cancelled_at: "TEXT",
      cancel_reason: "TEXT",
      invalidated_at: "TEXT",
      invalidation_reason: "TEXT",
    }, ["id"], { rowidAlias: true }),
    bank_audit_events: tableContract({
      id: "INTEGER",
      account_set_id: "INTEGER",
      bank_account_id: "TEXT",
      event_type: "TEXT NOT NULL",
      subject_type: "TEXT NOT NULL DEFAULT ''",
      subject_id: "TEXT NOT NULL DEFAULT ''",
      detail_json: "TEXT NOT NULL DEFAULT '{}'",
      created_at: "TEXT NOT NULL",
    }, ["id"], { rowidAlias: true }),
    bank_reconcile_runs: tableContract({
      id: "INTEGER",
      account_set_id: "INTEGER NOT NULL",
      bank_account_id: "TEXT NOT NULL",
      currency: "TEXT NOT NULL",
      period: "TEXT NOT NULL",
      as_of: "TEXT NOT NULL",
      status: "TEXT NOT NULL",
      book_close_cents: "INTEGER NOT NULL",
      adjusted_book_cents: "INTEGER NOT NULL",
      statement_close_cents: "INTEGER NOT NULL",
      adjusted_bank_cents: "INTEGER NOT NULL",
      difference_cents: "INTEGER NOT NULL",
      result_json: "TEXT NOT NULL",
      stale: "INTEGER NOT NULL DEFAULT 0",
      stale_reason: "TEXT",
      created_at: "TEXT NOT NULL",
    }, ["id"], { rowidAlias: true }),
  }),
  /**
   * 索引契约：`index` 有名字时按名字核对，没有名字时按（来源 + 表 + 完整键语义 + unique + partial + 谓词）
   * 签名核对（用于表级 PRIMARY KEY / UNIQUE 约束生成的自动索引）。部分索引的 `where` 写契约谓词，
   * 运行时与 `sqlite_master.sql` 中的实际谓词做规范化整体比对。
   *
   * 每个条目同时固定**完整索引键语义**（`keys`：逐键列名 / collation / 方向 / 是否表达式 / 是否 rowid）
   * 与索引来源 `origin`（命名索引只能来自 `CREATE INDEX` 的 `c`；自动索引只能是 `pk` / `u`）。
   * 只比列名会让「同样的列名但 collation 变了」蒙混过关：例如给 `bank_ref_id` 加
   * `COLLATE NOCASE`，`Ref-A` 与 `ref-a` 会在 UNIQUE 索引里相撞，同一份流水从「2 条成功」
   * 变成「第 2 条 UNIQUE 失败」。方向（DESC）与表达式同理。
   */
  indexes: Object.freeze([
    indexContract({ index: "idx_bank_accounts_gl", table: "bank_accounts", columns: ["account_set_id", "gl_account_code"], unique: true, origin: "c" }),
    indexContract({ index: "idx_bank_accounts_source", table: "bank_accounts", columns: ["account_set_id", "source_id"], unique: false, origin: "c" }),
    indexContract({ table: "bank_accounts", columns: ["account_set_id", "bank_account_id"], unique: true, origin: "pk" }),
    indexContract({ index: "idx_bank_batches_file", table: "bank_batches", columns: ["account_set_id", "bank_account_id", "source_id", "content_sha256"], unique: false, origin: "c" }),
    indexContract({ index: "idx_bank_batches_status", table: "bank_batches", columns: ["account_set_id", "bank_account_id", "status"], unique: false, origin: "c" }),
    indexContract({ table: "bank_batches", columns: ["account_set_id", "bank_account_id", "batch_id"], unique: true, origin: "pk" }),
    indexContract({ index: "idx_bank_txn_ref", table: "bank_transactions", columns: ["account_set_id", "bank_account_id", "source_id", "bank_ref_id"], unique: true, partial: true, where: "bank_ref_id IS NOT NULL", origin: "c" }),
    indexContract({ index: "idx_bank_txn_batch_row", table: "bank_transactions", columns: ["account_set_id", "bank_account_id", "batch_id", "row_index"], unique: true, origin: "c" }),
    indexContract({ index: "idx_bank_txn_scope_date", table: "bank_transactions", columns: ["account_set_id", "bank_account_id", "txn_date"], unique: false, origin: "c" }),
    indexContract({ index: "idx_bank_txn_fingerprint", table: "bank_transactions", columns: ["account_set_id", "bank_account_id", "source_id", "row_fingerprint"], unique: false, origin: "c" }),
    indexContract({ index: "idx_bank_batch_rows_txn", table: "bank_batch_rows", columns: ["transaction_id"], unique: false, origin: "c" }),
    indexContract({ table: "bank_batch_rows", columns: ["account_set_id", "bank_account_id", "batch_id", "row_index"], unique: true, origin: "u" }),
    indexContract({ index: "idx_bank_ambiguities_status", table: "bank_ambiguities", columns: ["account_set_id", "bank_account_id", "status"], unique: false, origin: "c" }),
    indexContract({ table: "bank_ambiguities", columns: ["account_set_id", "bank_account_id", "batch_id", "row_index"], unique: true, origin: "u" }),
    indexContract({ index: "idx_bank_matches_active_txn", table: "bank_matches", columns: ["transaction_id"], unique: true, partial: true, where: "status = 'confirmed'", origin: "c" }),
    indexContract({ index: "idx_bank_matches_active_entry", table: "bank_matches", columns: ["account_set_id", "entry_id"], unique: true, partial: true, where: "status = 'confirmed'", origin: "c" }),
    indexContract({ index: "idx_bank_matches_scope", table: "bank_matches", columns: ["account_set_id", "bank_account_id", "status"], unique: false, origin: "c" }),
    indexContract({ index: "idx_bank_audit_scope", table: "bank_audit_events", columns: ["account_set_id", "bank_account_id", "event_type"], unique: false, origin: "c" }),
    indexContract({ index: "idx_bank_reconcile_scope", table: "bank_reconcile_runs", columns: ["account_set_id", "bank_account_id", "period", "as_of"], unique: false, origin: "c" }),
  ]),
  /** 外键契约：列顺序、目标表 / 列与 `ON UPDATE` / `ON DELETE` 动作都必须与 DDL 一致；
   *  运行时按表比较完整集合（含重复约束），未列外键的表实际也必须没有外键。 */
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

/** 列规范解析：`"<TYPE>[ NOT NULL][ DEFAULT <literal>]"`（默认值必须在末尾，与 DDL 书写一致）。 */
export const parseBankColumnSpec = (spec) => {
  const match = /\s+DEFAULT\s+(.+)$/.exec(spec);
  const defaultText = match ? match[1].trim() : null;
  const head = match ? spec.slice(0, match.index) : spec;
  const notNull = /\bNOT NULL\b/.test(head);
  const type = head.replace(/\s+NOT\s+NULL\s*$/, "").trim();
  return { type, notNull, default: defaultText };
};

/**
 * 备份 / 恢复支持所用的完整银行组件结构契约（schema v1）。
 *
 * 与业务写门槛共用 `BANK_SCHEMA_CONTRACT` 的表 / 列 / 主键 / 索引 / 外键定义，
 * 只把列规范与外键动作整理成备份验证器可直接逐项比对的形状：
 *  - `tables[].columns` 是列规范对象（类型 / NOT NULL / 默认值），不是只有列名；
 *  - `tables[].primaryKey` / `tables[].rowidAlias` 显式描述主键列序与 rowid 别名语义，
 *    备份验证器按真实 rowid 逐行核对（不再按列名猜「是不是 rowid 别名」）；
 *  - `tables[].unique` 用**对象数组**描述该表所有唯一性约束（主键自动索引 / 表级 UNIQUE /
 *    命名唯一索引），每项带 `origin`、可选的 `index` 名字、`partial` / `where` 与逐键 `columns`
 *    （`name` / `collation` / `desc` / `expression` / `rowid`）：与核心（LOCAL-02）备份契约
 *    的「唯一性键对象」模型一致，不退回旧版「只有列名数组」的形状，也不在备份侧动态放松；
 *  - `foreignKeys[].actions` 固定 `ON DELETE` / `ON UPDATE` / `MATCH`（未声明的按 SQLite 默认
 *    `NO ACTION` / `NONE`）；
 *  - `indexes` 保留**全部**索引条目的名字（若有）、列序、UNIQUE / partial 与规范化后的部分索引谓词，
 *    并携带 `keys`（逐键 collation / 方向 / 是否表达式 / 是否 rowid）与 `origin`
 *    （`c` / `pk` / `u`）；备份验证器把每一张表的实际索引集合逐条比对到该契约，
 *    数量 / 额外 / 缺失 / 互相替代（例如命名唯一索引被表级 UNIQUE 顶替）一律拒绝；
 *  - `triggers` / `views` 固定为空：本版本真实 DDL 不创建任何触发器或视图，
 *    备份验证器会把任何引用 `bank_*` 的未登记触发器 / 视图当成未知对象拒绝。
 */
export const BANK_COMPONENT_STRUCTURE = Object.freeze({
  name: "bank",
  version: BANK_SCHEMA_VERSION,
  tables: Object.freeze(Object.fromEntries(Object.entries(BANK_SCHEMA_CONTRACT.tables).map(([name, spec]) => [
    name,
    Object.freeze({
      columns: spec.columnSpecs,
      primaryKey: spec.primaryKey,
      rowidAlias: spec.rowidAlias === true,
      // 唯一性键契约：直接来自同一份 BANK_SCHEMA_CONTRACT.indexes（unique=true 的条目），
      // 每个键保留 collation / 方向 / 表达式 / rowid 语义与来源 / 名字 / 部分谓词。
      unique: Object.freeze(BANK_SCHEMA_CONTRACT.indexes
        .filter((entry) => entry.table === name && entry.unique === true)
        .map((entry) => Object.freeze({
          origin: entry.origin,
          index: entry.index ?? null,
          partial: entry.partial === true,
          where: entry.where ?? null,
          columns: Object.freeze(entry.keys.map((key) => Object.freeze({
            name: key.column,
            collation: key.collation,
            desc: key.desc === true,
            expression: key.expression === true,
            rowid: key.rowid === true,
          }))),
        }))),
      foreignKeys: Object.freeze(BANK_SCHEMA_CONTRACT.foreignKeys
        .filter((fk) => fk.table === name)
        .map((fk) => Object.freeze({
          from: Object.freeze([...fk.columns]),
          table: fk.refTable,
          to: Object.freeze([...fk.refColumns]),
          actions: Object.freeze({
            onDelete: fk.onDelete ?? "NO ACTION",
            onUpdate: fk.onUpdate ?? "NO ACTION",
            match: fk.match ?? "NONE",
          }),
        }))),
    }),
  ]))),
  indexes: BANK_SCHEMA_CONTRACT.indexes,
  triggers: Object.freeze([]),
  views: Object.freeze([]),
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
  bank_schema_corrupt: "银行组件表结构与本版本契约不一致（缺表 / 缺列 / 列类型 / NOT NULL / 默认值 / 主键 / 索引签名与谓词 / 额外索引 / 外键集合与动作 / 版本表形状），拒绝在损坏结构上读写",
});

/** 指向单引号字符串字面量起点，返回结尾单引号下标（'' 转义按两个字符处理）。 */
function skipSqlString(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "'") {
      if (text[i + 1] === "'") { i += 2; continue; }
      return i;
    }
    i += 1;
  }
  return text.length - 1;
}

/** 去掉整体外层括号（只有当首尾括号确实配对时才剥）。 */
function stripOuterParens(text) {
  let out = text;
  for (;;) {
    if (!out.startsWith("(") || !out.endsWith(")")) return out;
    let depth = 0;
    let paired = true;
    for (let i = 0; i < out.length; i += 1) {
      const ch = out[i];
      if (ch === "'") { i = skipSqlString(out, i); continue; }
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0 && i !== out.length - 1) { paired = false; break; }
      }
    }
    if (!paired) return out;
    out = out.slice(1, -1);
  }
}

/**
 * 谓词规范化：删除字面量之外的空白、把未加引号 / 双引号 / 反引号 / 方括号标识符统一小写，
 * 剥掉整体外层括号；**保留单引号字符串字面量的原始大小写**。
 * 只用于把契约里的可读谓词与 sqlite_master 中实际 DDL 文本整体比对（不做 substring 判断）。
 */
function canonicalCondition(text) {
  if (text === null || text === undefined) return null;
  const source = String(text);
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'") {
      const end = skipSqlString(source, i);
      out += source.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "`") {
      let j = i + 1;
      let ident = "";
      while (j < source.length) {
        if (source[j] === ch) {
          if (source[j + 1] === ch) { ident += ch; j += 2; continue; }
          break;
        }
        ident += source[j];
        j += 1;
      }
      out += ident.toLowerCase();
      i = j + 1;
      continue;
    }
    if (ch === "[") {
      const close = source.indexOf("]", i + 1);
      const ident = close > 0 ? source.slice(i + 1, close) : source.slice(i + 1);
      out += ident.toLowerCase();
      i = close > 0 ? close + 1 : source.length;
      continue;
    }
    if (/\s/.test(ch)) { i += 1; continue; }
    out += ch.toLowerCase();
    i += 1;
  }
  return stripOuterParens(out) || null;
}

/** 从 sqlite_master.sql 里取出索引列清单之后的 WHERE 谓词原文（无则 null）。 */
function indexWhereSql(sql) {
  const text = String(sql ?? "");
  if (!text) return null;
  let depth = 0;
  let end = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") { i = skipSqlString(text, i); continue; }
    if (ch === "(") { depth += 1; continue; }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  const tail = text.slice(end + 1).trim();
  const m = /^WHERE\b([\s\S]+)$/i.exec(tail);
  return m ? (m[1].trim() || null) : null;
}

/** 供备份 / 恢复验证器复用同一套部分索引谓词规范化（避免两处判定漂移）。 */
export const canonicalSqlCondition = canonicalCondition;
/** 供备份 / 恢复验证器从 sqlite_master 取部分索引的 WHERE 原文。 */
export const indexWherePredicate = indexWhereSql;

/**
 * 索引事实：名字 / 来源 / UNIQUE / partial / 真实谓词 / **完整键语义**。
 * 用 `pragma_index_xinfo` 而不是 `pragma_index_info`：只有 xinfo 才给出每个键的
 * collation（`coll`）、方向（`desc`）与是否表达式（`cid === -2` / 名字为 null），
 * 这些都会改变 UNIQUE / 排序的真实语义。
 */
function indexSignatures(db, table) {
  return db.prepare(`PRAGMA index_list(${table})`).all().map((idx) => {
    const name = String(idx.name);
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`).get(name);
    const keys = db.prepare(`SELECT * FROM pragma_index_xinfo(?)`).all(name)
      .filter((key) => Number(key.key) === 1)
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .map((key) => {
        const cid = Number(key.cid);
        return {
          column: key.name === null || key.name === undefined ? null : String(key.name),
          collation: String(key.coll ?? "BINARY").toUpperCase(),
          desc: Number(key.desc) === 1,
          expression: cid === -2,
          rowid: cid === -1,
        };
      });
    return {
      name,
      unique: Number(idx.unique) === 1,
      partial: Number(idx.partial) === 1,
      origin: String(idx.origin ?? ""),
      // 列名只从键语义派生，避免出现「键里有 NOCASE / 表达式，columns 却仍是普通列名」。
      columns: keys.map((key) => key.column),
      keys,
      // 部分索引的实际 WHERE 谓词（规范化后整体比对）；普通索引必须为 null。
      where: canonicalCondition(indexWhereSql(row?.sql)),
    };
  });
}

function foreignKeySignatures(db, table) {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  const groups = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    const entry = groups.get(id) ?? {
      refTable: String(row.table),
      onUpdate: String(row.on_update ?? "NO ACTION").toUpperCase(),
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
      onUpdate: entry.onUpdate,
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
 * - 版本表本身形状不对（version 列缺失 / 改名）→ problems 里给 `bank_schema_version_table_corrupt`，
 *   此时**不读取 version**，也不把形状问题伪装成矛盾或未来版本；
 * - 其余结构偏差 → `bank_schema_corrupt`（problems 里逐项给出表 / 列 / 主键 / 索引签名与谓词 /
 *   外键完整集合与动作）。
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
  // 先验证版本表形状再读 version：缺列 / 改名时直接 SELECT 会抛原始 SQLite 错误，
  // 这里必须给出结构化损坏结果，而不是把 ERR_SQLITE_ERROR 交给上层。
  const versionColumns = hasVersionTable ? columnNames(db, "bank_component_migrations") : [];
  const versionReadable = hasVersionTable && versionColumns.includes("version");
  const versions = versionReadable
    ? db.prepare(`SELECT version FROM bank_component_migrations ORDER BY version`).all()
      .map((r) => Number(r.version))
    : [];
  const version = versions.length ? Math.max(...versions) : 0;
  if (hasVersionTable && !versionReadable) {
    const spec = BANK_SCHEMA_CONTRACT.tables.bank_component_migrations;
    problems.push({
      code: "bank_schema_version_table_corrupt",
      detail: {
        table: "bank_component_migrations",
        missing: spec.columns.filter((c) => !versionColumns.includes(c)),
        columns: versionColumns,
      },
    });
  }

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
  } else if (versionReadable && (versions.length !== 1 || versions[0] !== BANK_SCHEMA_VERSION)) {
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
    // 列类型 / NOT NULL / 默认值同样是结构契约：只比列名会让「同名但语义不通」的列通过。
    for (const [columnName, columnSpec] of Object.entries(spec.columnSpecs)) {
      const actual = info.find((c) => String(c.name) === columnName);
      if (!actual) continue;
      const want = parseBankColumnSpec(columnSpec);
      if (String(actual.type ?? "").trim().toUpperCase() !== want.type.toUpperCase()) {
        problems.push({
          code: "bank_schema_column_type",
          detail: { table: name, column: columnName, expected: want.type, actual: String(actual.type ?? "") },
        });
      }
      if ((Number(actual.notnull) === 1) !== want.notNull) {
        problems.push({ code: "bank_schema_column_not_null", detail: { table: name, column: columnName } });
      }
      const actualDefault = actual.dflt_value === null || actual.dflt_value === undefined
        ? null : String(actual.dflt_value);
      if (actualDefault !== want.default) {
        problems.push({
          code: "bank_schema_column_default",
          detail: { table: name, column: columnName, expected: want.default === null ? null : "contract", actual: actualDefault === null ? null : "different" },
        });
      }
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
  const matchedIndexes = new Map();
  // 契约键语义归一：漏写 collation / desc / expression 时按产品真实 DDL 的默认（BINARY / 升序 / 普通列）。
  const contractKeys = (want) => (want.keys ?? []).map((key) => ({
    column: key.column ?? null,
    collation: String(key.collation ?? "BINARY").toUpperCase(),
    desc: key.desc === true,
    expression: key.expression === true,
    rowid: key.rowid === true,
  }));
  const sameKeys = (actualKeys, wantedKeys) => actualKeys.length === wantedKeys.length
    && actualKeys.every((key, i) => {
      const want = wantedKeys[i];
      return key.column === want.column
        && key.collation === want.collation
        && key.desc === want.desc
        && key.expression === want.expression
        && key.rowid === want.rowid;
    });
  for (const want of BANK_SCHEMA_CONTRACT.indexes) {
    const have = indexesFor(want.table);
    const wantWhere = canonicalCondition(want.where);
    const wantKeys = contractKeys(want);
    const signature = (idx) => idx.unique === want.unique && idx.partial === want.partial
      && sameList(idx.columns, [...want.columns]) && idx.where === wantWhere
      && sameKeys(idx.keys, wantKeys);
    // 有名字的索引必须按名字找到，再整体比对来源 / 列 / unique / partial / 实际 WHERE 谓词 / 完整键语义；
    // 无名字的是表级 PRIMARY KEY / UNIQUE 约束生成的自动索引，按来源 + 完整签名匹配。
    const match = have.find((idx) => (want.index ? idx.name === want.index : idx.origin === want.origin && signature(idx)));
    if (!match) {
      problems.push({
        code: "bank_schema_index_missing",
        detail: {
          table: want.table, index: want.index ?? null, columns: [...want.columns],
          unique: want.unique, partial: want.partial, where: want.where ?? null,
          origin: want.origin ?? null, keys: wantKeys,
        },
      });
      continue;
    }
    const used = matchedIndexes.get(want.table) ?? new Set();
    used.add(match.name);
    matchedIndexes.set(want.table, used);
    if (!signature(match) || match.origin !== want.origin) {
      problems.push({
        code: "bank_schema_index_mismatch",
        detail: {
          table: want.table, index: match.name,
          expected: {
            columns: [...want.columns], unique: want.unique, partial: want.partial,
            where: want.where ?? null, origin: want.origin ?? null, keys: wantKeys,
          },
          actual: {
            columns: match.columns, unique: match.unique, partial: match.partial,
            where: match.where, origin: match.origin, keys: match.keys,
          },
        },
      });
    }
  }
  // 契约之外的额外索引同样拒绝：未登记的 UNIQUE / partial / 表达式索引会改变真实写入行为。
  for (const table of Object.keys(BANK_SCHEMA_CONTRACT.tables)) {
    if (!columnsByTable.has(table)) continue;
    const used = matchedIndexes.get(table) ?? new Set();
    for (const idx of indexesFor(table)) {
      if (used.has(idx.name)) continue;
      problems.push({
        code: "bank_schema_index_unexpected",
        detail: {
          table, index: idx.name, columns: idx.columns, unique: idx.unique,
          partial: idx.partial, where: idx.where, origin: idx.origin, keys: idx.keys,
        },
      });
    }
  }

  // 外键按表比较**完整集合**（含重复约束），不是「找到必需项就通过」：
  // 额外 / 重复 / 动作不符的约束都会改变真实删除行为，必须拒绝。
  // 契约里没有外键条目的表（含 bank_audit_events / bank_reconcile_runs）实际也必须没有外键。
  const expectedFksByTable = new Map();
  for (const want of BANK_SCHEMA_CONTRACT.foreignKeys) {
    const list = expectedFksByTable.get(want.table) ?? [];
    list.push(want);
    expectedFksByTable.set(want.table, list);
  }
  const fkKey = (fk) => JSON.stringify([
    fk.columns, fk.refTable, fk.refColumns,
    String(fk.onUpdate ?? "NO ACTION").toUpperCase(),
    String(fk.onDelete ?? "NO ACTION").toUpperCase(),
  ]);
  for (const table of Object.keys(BANK_SCHEMA_CONTRACT.tables)) {
    if (!columnsByTable.has(table)) continue;
    const expected = expectedFksByTable.get(table) ?? [];
    const actual = foreignKeySignatures(db, table);
    const remaining = [...actual];
    for (const want of expected) {
      const key = fkKey(want);
      const index = remaining.findIndex((fk) => fkKey(fk) === key);
      if (index >= 0) { remaining.splice(index, 1); continue; }
      problems.push({
        code: "bank_schema_foreign_key_missing",
        detail: {
          table, columns: [...want.columns], refTable: want.refTable,
          refColumns: [...want.refColumns], onDelete: want.onDelete,
          actual: actual.slice(0, 10),
        },
      });
    }
    for (const extra of remaining) {
      problems.push({
        code: "bank_schema_foreign_key_unexpected",
        detail: {
          table, columns: extra.columns, refTable: extra.refTable,
          refColumns: extra.refColumns, onDelete: extra.onDelete, onUpdate: extra.onUpdate,
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
  // 回滚未确认的连接可能仍持着未提交的银行写入：在结构 / 版本检查之前就要拒绝继续读写。
  assertConnectionUsable(db);
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
  // 版本表形状不对时不能直接 SELECT version（否则抛原始 SQLite 错误）。
  if (!columnNames(db, "bank_component_migrations").includes("version")) return 0;
  const row = db.prepare(`SELECT COALESCE(MAX(version),0) AS v FROM bank_component_migrations`).get();
  return Number(row?.v || 0);
}

/** 只取实际存在的列，避免版本表 / 备份表形状损坏时读状态抛原始 SQL 错误。 */
function selectExistingColumns(db, table, columns, orderBy) {
  if (!tableExists(db, table)) return [];
  const have = columnNames(db, table);
  const picked = columns.filter((c) => have.includes(c));
  if (!picked.length) return [];
  const order = picked.includes(orderBy) ? orderBy : "rowid";
  return db.prepare(`SELECT ${picked.join(", ")} FROM ${table} ORDER BY ${order}`).all();
}

/** 只读自检：组件版本、表、迁移 / 备份记录与结构契约状态。 */
export function bankSchemaState(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name);
  const migrations = selectExistingColumns(db, "bank_component_migrations",
    ["version", "applied_at", "note"], "version");
  const backups = selectExistingColumns(db, "bank_component_backups",
    ["id", "version", "path", "bytes", "integrity", "created_at", "note"], "id");
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
/** 回滚未确认（failed / unknown）的连接：在调用方明确恢复或丢弃前，禁止继续银行读写。 */
const unusableConnections = new WeakMap();

/** 连接是否真的有活动事务（只读连接事实，不推断是谁开的）；无法判断给 null。 */
const transactionActiveOf = (db) => (typeof db?.isTransaction === "boolean" ? db.isTransaction : null);

/** 调用方自己开启的事务 / 保存点：不在银行 `inTransaction` 管理的层里。 */
const hasExternalTransaction = (db) => transactionActiveOf(db) === true
  && (txnDepth.get(db) || 0) === 0;

/**
 * 连接事务状态：
 *  - `clean`：银行可以自己开启并提交事务；
 *  - `external_transaction`：连接上有调用方自己的事务 / 保存点（银行既没有开，也不会提交 / 回滚它）；
 *  - `rollback_unconfirmed`：上一次回滚未确认，连接可能仍持有未提交写入。
 * `writable` 只表示「银行可以自己开事务并提交」；未知态与调用方事务都不满足。
 * `transactionActive` 反映连接真实事实（`db.isTransaction`），不按银行是否管理那层事务来猜。
 */
export function bankConnectionState(db) {
  const depth = txnDepth.get(db) || 0;
  const failure = unusableConnections.get(db) ?? null;
  const active = transactionActiveOf(db);
  const external = !failure && depth === 0 && active === true;
  return {
    transactionDepth: depth,
    transactionState: failure ? "rollback_unconfirmed" : (external ? "external_transaction" : "clean"),
    writable: !failure && !external,
    bankManagedTransaction: depth > 0,
    externalTransaction: external,
    stage: failure ? failure.stage : null,
    transactionActive: failure ? failure.transactionActive : active === true,
  };
}

/**
 * 明确恢复连接：只在调用方已确认连接不再持有未决事务（回滚成功 / 丢弃并重建连接）后才解除阻断。
 * 仍在事务里就拒绝恢复，避免把「未提交写入」当成已清理。
 */
export function recoverBankConnectionState(db) {
  const failure = unusableConnections.get(db);
  if (!failure) return { transactionState: bankConnectionState(db).transactionState, recovered: false };
  const active = transactionActiveOf(db);
  if (active !== false) {
    throw bankError("bank_connection_recovery_refused",
      "连接仍处于未决事务，必须先确认回滚成功或丢弃该连接后再恢复", {
        transactionActive: active,
      });
  }
  unusableConnections.delete(db);
  txnDepth.delete(db);
  return { transactionState: "clean", recovered: true };
}

/** 未知态连接的写 / 读门槛：固定错误 + 固定标志，不回显原始 SQL 或库路径。 */
function assertConnectionUsable(db) {
  const failure = unusableConnections.get(db);
  if (!failure) return;
  throw bankError("bank_connection_state_unknown",
    "上一次事务回滚未确认，连接可能仍持有未提交写入；已停止继续银行读写，请先确认回滚成功或丢弃连接", {
      stage: failure.stage,
      transactionState: "rollback_unconfirmed",
      transactionActive: failure.transactionActive,
    });
}

const markConnectionUnknown = (db, stage) => {
  const active = transactionActiveOf(db);
  unusableConnections.set(db, { stage, transactionActive: active });
  // 未知连接不再当作可嵌套事务，避免外层把内层失败当成可继续。
  txnDepth.delete(db);
  return active;
};

/** 只保留形如错误码的令牌，避免把原始 SQL / 驱动文本 / 路径带进错误输出。 */
const causeCodeToken = (error) => {
  const code = error && typeof error.code === "string" ? error.code : null;
  return code && /^[A-Za-z0-9_]{1,60}$/.test(code) ? code : null;
};

/** 回滚失败：**不**声称已回滚，给出固定状态标志。 */
const rollbackUnconfirmedError = (stage, transactionActive, cause = null) => bankError(
  "bank_transaction_rollback_failed",
  "事务回滚未确认：连接可能仍持有未提交写入，已停止继续使用该连接；"
  + "请先确认回滚成功或丢弃连接（不能把本次操作当成已回滚 / 已完成）",
  {
    stage,
    rolledBack: false,
    transactionState: "rollback_unconfirmed",
    transactionActive,
    ...(causeCodeToken(cause) ? { causeCode: causeCodeToken(cause) } : {}),
  },
);

/** 事务结果类错误：已区分已确认回滚与 failed / unknown / 未开始，不得被上层改写成「已回滚」。 */
const isTransactionOutcomeError = (e) => e?.code === "bank_transaction_rollback_failed"
  || e?.code === "bank_transaction_discarded"
  || e?.code === "bank_transaction_conflict"
  || e?.code === "bank_transaction_begin_failed"
  || e?.code === "bank_connection_state_unknown";

/**
 * 事务冲突：连接上已有事务（调用方自己的，或银行尚未结束的嵌套层），银行不会在其中开事务，
 * 也不会提交 / 回滚那一层。`bankManaged` 区分「调用方事务」与「银行自己的嵌套层」。
 */
const transactionConflictError = (stage, { bankManaged = false } = {}) => bankError(
  "bank_transaction_conflict",
  "连接上已有进行中的事务：银行不会在其中开启事务，也不会提交或回滚那一层；本次操作未开始，"
  + "也没有任何写入，请先由调用方提交或回滚自己的事务后再重试",
  {
    stage,
    started: false,
    rolledBack: false,
    transactionState: bankManaged ? "bank_transaction_active" : "external_transaction",
    transactionActive: true,
    bankManaged,
  },
);

/** 事务 / 保存点没建立起来：本层没有开始，也没有可回滚的写入，绝不冒充「已回滚」。 */
const transactionBeginFailedError = (stage, transactionActive, cause = null) => bankError(
  "bank_transaction_begin_failed",
  "银行事务未能开始（未取得事务 / 保存点）：本次没有写入，也没有回滚任何事务；可释放占用后重试",
  {
    stage,
    started: false,
    rolledBack: false,
    transactionState: "not_started",
    transactionActive,
    ...(causeCodeToken(cause) ? { causeCode: causeCodeToken(cause) } : {}),
  },
);

/** 回滚已确认（回滚命令真实成功）：可以明确说「本次操作未提交」，连接重归可用。 */
const rollbackDiscardedError = (stage) => bankError(
  "bank_transaction_discarded",
  "本次操作未提交：失败后已确认回滚（未留下半成品）",
  { stage, rolledBack: true, transactionState: "rolled_back", transactionActive: false },
);

/** 回滚命令：返回是否**确认**回滚成功；成功则清理未知标记，失败则把连接标记为未知态。 */
const runRollback = (db, commands, stage) => {
  try {
    for (const sql of commands) db.exec(sql);
    unusableConnections.delete(db);
    return { rolledBack: true, transactionActive: false };
  } catch {
    return { rolledBack: false, transactionActive: markConnectionUnknown(db, stage) };
  }
};

const rollbackCommandsFor = (savepoint) => (savepoint
  ? [`ROLLBACK TO ${savepoint}`, `RELEASE ${savepoint}`]
  : ["ROLLBACK"]);

/**
 * 显式事务（外层 BEGIN IMMEDIATE，嵌套使用 SAVEPOINT）。
 *
 * 开始事务前先分三种边界（不能一律说「已回滚」）：
 *  - 连接上已有**调用方**事务 / 保存点：直接 `bank_transaction_conflict`，银行不开事务、
 *    也绝不提交或回滚调用方事务（本层什么都没做）；
 *  - BEGIN / SAVEPOINT 没建立起来：`bank_transaction_begin_failed` + `rolledBack:false`，
 *    本层没有开始也没有回滚任何写入（`transactionState: "not_started"`）；
 *  - 已开始的事务失败，才进入下面的回滚状态机。
 *
 * 失败时**必须区分三种结果**（不能一律说「已回滚」）：
 *  - 回滚已确认：原错误原样上抛，连接可继续用（调用方看到的是业务失败，不是回滚失败）；
 *  - 回滚失败 / 未知：给 `bank_transaction_rollback_failed` + `rolledBack:false`，并把连接标记为不可用
 *    （后续银行读写给 `bank_connection_state_unknown`），绝不假称「已回滚 / 已安装 / 已留痕」；
 *  - 内层回滚失败后外层已确认整体回滚：给 `bank_transaction_discarded` + `rolledBack:true`。
 * 内层 SAVEPOINT 回滚失败即使被调用方吞掉，外层也**不会** COMMIT：整层放弃并如实报告。
 * 未知态连接的恢复只能由调用方显式确认（`recoverBankConnectionState`）或丢弃连接后重建。
 */
export function inTransaction(db, fn) {
  assertConnectionUsable(db);
  const depth = txnDepth.get(db) || 0;
  const savepoint = depth > 0 ? `bank_sp_${depth}` : null;
  // 调用方自己的事务：银行既不在里面开事务，也不会对它 ROLLBACK / COMMIT。
  if (!savepoint && hasExternalTransaction(db)) throw transactionConflictError("begin");
  try {
    if (savepoint) db.exec(`SAVEPOINT ${savepoint}`);
    else db.exec("BEGIN IMMEDIATE");
  } catch (e) {
    // 事务 / 保存点没有建立：本层没有任何写入可回滚，绝不能报「已回滚」或去回滚外层。
    throw transactionBeginFailedError(savepoint ? "savepoint" : "begin", transactionActiveOf(db), e);
  }
  txnDepth.set(db, depth + 1);
  let out;
  try {
    out = fn();
  } catch (e) {
    const rollback = runRollback(db, rollbackCommandsFor(savepoint), savepoint ? "savepoint" : "begin");
    txnDepth.set(db, depth);
    if (!rollback.rolledBack) {
      throw rollbackUnconfirmedError(savepoint ? "savepoint" : "begin", rollback.transactionActive, e);
    }
    // 内层回滚未确认、但本层已确认回滚（保存点或整个事务）：结果从「unknown」变成「已确认回滚」。
    if (e && e.code === "bank_transaction_rollback_failed") throw rollbackDiscardedError("outer-rollback");
    // 内层「事务没开始」被外层放弃：本层已确认回滚整层，结果从「未开始」变成「已确认放弃」。
    if (e && (e.code === "bank_transaction_begin_failed" || e.code === "bank_transaction_conflict")) {
      throw rollbackDiscardedError("outer-abort");
    }
    throw e;
  }
  // 内层回滚已经失败但错误被调用方吞掉：本层不得提交，整层放弃。
  if (unusableConnections.has(db)) {
    const rollback = runRollback(db, rollbackCommandsFor(savepoint), "abort");
    txnDepth.set(db, depth);
    if (!rollback.rolledBack) throw rollbackUnconfirmedError("abort", rollback.transactionActive, null);
    throw rollbackDiscardedError("abort");
  }
  try {
    if (savepoint) db.exec(`RELEASE ${savepoint}`);
    else db.exec("COMMIT");
    txnDepth.set(db, depth);
    return out;
  } catch (e) {
    // COMMIT / RELEASE 失败（例如真实 SQLITE_BUSY）：事务可能仍活着，必须真的回滚才能说「已回滚」。
    const rollback = runRollback(db, rollbackCommandsFor(savepoint), savepoint ? "release" : "commit");
    txnDepth.set(db, depth);
    if (!rollback.rolledBack) {
      throw rollbackUnconfirmedError(savepoint ? "release" : "commit", rollback.transactionActive, e);
    }
    throw e;
  }
}

// ------------------------------------------------------------------ 新库创建事实
// 进程内回执：只有「本次调用确认文件不存在并亲手创建」才发回执。
// 回执不落盘、不跨进程，因此其他进程（含 CLI 独立调用）无法把已有库伪装成新库。
const freshClaims = new WeakMap();

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
  // Every ancestor must be a real directory. In particular, a junction above the
  // immediate parent must not turn an explicit fresh target into another path.
  for (let dir = dirname(abs); ; dir = dirname(dir)) {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw bankError("data_dir_alias", "新库目录不能经过别名 / junction");
    if (dirname(dir) === dir) break;
  }
  let fd, markerFd, token;
  const markerPath = join(dirname(abs), `.local-bank-create-${basename(abs)}`);
  try {
    fd = openSync(abs, "wx+");
    const identity = fstatSync(fd);
    markerFd = openSync(markerPath, "wx");
    const nonce = freshGuard.newClaimNonce();
    const markerContent = JSON.stringify({ kind: "local-bank-create", nonce, pid: process.pid });
    writeFileSync(markerFd, markerContent, "utf8");
    const markerIdentity = fstatSync(markerFd);
    token = freshGuard.createFreshClaimFacts({
      dataDir: dirname(abs), dbPath: abs, markerPath, fd, identity,
      markerFd, markerIdentity, markerContent, nonce, pid: process.pid,
    });
    freshGuard.stampFreshClaimNonce(token);
    const receipt = { dbPath: abs, kind: "fresh-database-claim" };
    const seed = Buffer.alloc(4096);
    if (readSync(fd, seed, 0, seed.length, 0) !== seed.length) throw bankError("fresh_claim_stamp_failed", "无法读回创建种子");
    freshClaims.set(receipt, Object.freeze({
      token, dbPath: abs, fd, markerFd, markerPath, markerContent,
      identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
      markerIdentity: Object.freeze({ dev: markerIdentity.dev, ino: markerIdentity.ino }),
      seed, connections: new WeakSet(),
    }));
    return receipt;
  } catch (error) {
    if (token) freshGuard.releaseFreshClaimFacts(token, { preserveDatabase: true });
    else {
      // Before registration there is no complete immutable creation fact. Close
      // only our handles and retain the objects for inspection, never guess ownership.
      try { if (fd !== undefined) closeSync(fd); } catch { /* preserve */ }
      try { if (markerFd !== undefined) closeSync(markerFd); } catch { /* preserve */ }
    }
    throw error;
  }
}

function requireFreshClaim(receipt, dbPath) {
  const claim = receipt && typeof receipt === "object" ? freshClaims.get(receipt) : null;
  const descriptors = receipt && typeof receipt === "object" ? Object.getOwnPropertyDescriptors(receipt) : {};
  if (!claim || Reflect.ownKeys(receipt).length !== 2
      || descriptors.dbPath?.value !== claim.dbPath || descriptors.kind?.value !== "fresh-database-claim") {
    throw bankError("fresh_receipt_invalid", "新库回执无效、被修改或不是本进程签发的对象");
  }
  if (resolve(String(dbPath ?? "")) !== claim.dbPath) throw bankError("fresh_claim_target_mismatch", "新库路径与创建事实不一致");
  return claim;
}

/** Release only immutable privately registered facts, even if receipt fields changed. */
export function releaseFreshDatabaseClaim(receipt) {
  const claim = receipt && typeof receipt === "object" ? freshClaims.get(receipt) : null;
  if (!claim) return false;
  freshClaims.delete(receipt);
  return freshGuard.releaseFreshClaimFacts(claim.token, { preserveDatabase: true }).released === true;
}

/** Explicit hand-written core initializers must call this before any DDL / WAL. */
export function verifyFreshDatabaseConnection(receipt, db, dbPath) {
  const claim = requireFreshClaim(receipt, dbPath);
  freshGuard.assertFreshClaimConnection(claim.token, db);
  const result = freshGuard.assertOpenedDatabaseClaimsMatch(db, { dataDir: dirname(claim.dbPath), dbPath: claim.dbPath });
  claim.connections.add(db);
  return result;
}

// Opening even a read-only SQLite connection to an old WAL-mode database can
// create -wal/-shm. Reject changed creation objects before opening that probe;
// this supplements, never replaces, the actual-connection pre-DDL guard.
function assertPristineCreationFiles(claim) {
  const sameIdentity = (stat, expected) => stat.isFile() && !stat.isSymbolicLink?.()
    && String(stat.dev) === String(expected.dev) && String(stat.ino) === String(expected.ino);
  const pathStat = lstatSync(claim.dbPath);
  const fdStat = fstatSync(claim.fd);
  if (!sameIdentity(pathStat, claim.identity) || !sameIdentity(fdStat, claim.identity)) {
    throw bankError("fresh_database_replaced", "新库文件对象在创建后被替换");
  }
  const canonical = path => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  if (canonical(realpathSync(claim.dbPath)) !== canonical(claim.dbPath)) {
    throw bankError("fresh_database_alias", "新库路径经过别名 / junction");
  }
  const page = Buffer.alloc(claim.seed.length);
  if (pathStat.size !== page.length || fdStat.size !== page.length
      || readSync(claim.fd, page, 0, page.length, 0) !== page.length || !page.equals(claim.seed)) {
    throw bankError("fresh_database_foreign_content", "新库创建对象在打开前已被写入其他内容");
  }
  if (!sameIdentity(lstatSync(claim.markerPath), claim.markerIdentity)
      || !sameIdentity(fstatSync(claim.markerFd), claim.markerIdentity)
      || readFileSync(claim.markerPath, "utf8") !== claim.markerContent) {
    throw bankError("fresh_receipt_stale", "新库所有权标记对象或内容已被替换");
  }
}

/** Fixed real core entry, never an arbitrary callback or a post-DDL trust flag. */
export async function initializeFreshDatabaseCore(receipt) {
  const claim = requireFreshClaim(receipt, freshClaims.get(receipt)?.dbPath);
  assertPristineCreationFiles(claim);
  const probe = new DatabaseSync(claim.dbPath, { readOnly: true });
  try { verifyFreshDatabaseConnection(receipt, probe, claim.dbPath); }
  finally { probe.close(); }
  process.env.WORKBENCH_DATA_DIR = dirname(claim.dbPath);
  // The imported core must execute its actual-connection pre-DDL hook. A cached
  // module cannot bless a new path: the binding assertion below rejects it.
  const core = await import("./db.mjs");
  freshGuard.assertFreshClaimConnection(claim.token, core.db);
  claim.connections.add(core.db);
  return core;
}

/** 测试 / 诊断用：回执是否仍然有效（不消费）。 */
export function hasFreshDatabaseClaim(receipt, dbPath) {
  try { requireFreshClaim(receipt, dbPath); return true; } catch { return false; }
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
 * 备份门槛：只有注入的真实备份实现成功生成、且对**真实返回字段**完成验证后才返回备份证据。
 *
 * 这里刻意不接受 `true` / `{ integrity: 'ok' }` / 只有 `{ ok: true }` 的弱 mock：
 *  - create 必须 `ok === true` 并返回非空 `backupDir` 与真实 `backupMeta.snapshotBytes / snapshotSha256`；
 *  - verify 必须独立返回 `ok === true`、`status === 'ok'`，且快照字节 / 摘要与 create 一致；
 *  - verify 返回的清单要绑定同一个源文件名与当前核心 schema 版本，且迁移前不得已含组件。
 * 备份实现可以是同步或返回 Promise。
 */
async function runBackupGate({ db, backupService, dbPath, outDir, version, expectedSchemaVersion }) {
  if (!backupService || typeof backupService.createBackup !== "function" || typeof backupService.verifyBackup !== "function") {
    throw bankError("migration_backup_unavailable", "已有库加入 / 升级 bank_* 之前必须先完成可验证的一致备份；" +
      "当前未提供已审查的 LOCAL-06 备份实现（createBackup / verifyBackup）。", { version });
  }
  let created;
  try {
    created = await backupService.createBackup({ dbPath, outDir });
  } catch (e) {
    throw bankError("migration_backup_failed", "迁移前一致备份失败，原库未改动", {
      reason: String(e?.message || e).slice(0, 200),
    });
  }
  if (!created || typeof created !== "object" || created.ok !== true) {
    throw bankError("migration_backup_failed", "备份实现没有返回成功的真实备份结果", {
      version, status: created && typeof created === "object" ? created.status ?? null : null,
    });
  }
  const backupDir = created.backupDir;
  if (typeof backupDir !== "string" || !backupDir.trim()) {
    throw bankError("migration_backup_failed", "备份实现未返回可校验的备份位置", { version });
  }
  const meta = created.backupMeta;
  const snapshotBytes = Number(meta?.snapshotBytes);
  const snapshotSha256 = meta?.snapshotSha256;
  if (!Number.isInteger(snapshotBytes) || snapshotBytes <= 0
    || typeof snapshotSha256 !== "string" || !/^[a-f0-9]{64}$/.test(snapshotSha256)) {
    throw bankError("migration_backup_failed", "备份实现没有返回真实快照字节数 / 摘要，不能把未验证的备份当迁移保护", {
      version,
    });
  }
  let verified;
  try {
    verified = await backupService.verifyBackup({ backupDir });
  } catch (e) {
    throw bankError("migration_backup_invalid", "迁移前备份无法通过校验，原库未改动", {
      reason: String(e?.message || e).slice(0, 200),
    });
  }
  // 只接受 verify 真实返回的 ok / status，不接受 true 或仅有 integrity 字符串的旧 mock。
  if (!verified || typeof verified !== "object" || verified.ok !== true || verified.status !== "ok") {
    throw bankError("migration_backup_invalid", "迁移前备份校验未通过，原库未改动", {
      detail: verified && typeof verified === "object" ? { status: verified.status ?? null, code: verified.code ?? null } : null,
    });
  }
  const summary = verified.summary;
  if (!summary || Number(summary.snapshotBytes) !== snapshotBytes || summary.snapshotSha256 !== snapshotSha256) {
    throw bankError("migration_backup_invalid", "备份校验结果与生成结果不是同一份快照，拒绝把陈旧 / 错位备份当迁移保护", {
      detail: { reason: "snapshot_binding" },
    });
  }
  const manifest = verified.manifest;
  if (!manifest || !manifest.snapshot
    || Number(manifest.snapshot.bytes) !== snapshotBytes || manifest.snapshot.sha256 !== snapshotSha256) {
    throw bankError("migration_backup_invalid", "备份清单没有绑定同一份快照，拒绝继续安装", {
      detail: { reason: "manifest_binding" },
    });
  }
  if (!manifest.source || manifest.source.file !== basename(dbPath)) {
    throw bankError("migration_backup_invalid", "备份清单的来源文件与当前安装库不一致，拒绝备份 A 却安装 B", {
      detail: { reason: "source_file" },
    });
  }
  if (expectedSchemaVersion !== null && Number(manifest.structure?.schemaVersion) !== expectedSchemaVersion) {
    throw bankError("migration_backup_invalid", "备份清单的核心 schema 版本与当前安装库不一致", {
      detail: { reason: "source_schema", expected: expectedSchemaVersion },
    });
  }
  const components = manifest.components ?? [];
  try { const official=await import('./local-backup.mjs');official.assertInstallableComponentSet(manifest,'bank'); }
  catch {throw bankError('migration_backup_invalid','迁移前备份组件集合不受支持', {detail:{reason:'component_present'}});}
  if (created.manifest) {
    if (!created.manifest.snapshot
      || Number(created.manifest.snapshot.bytes) !== snapshotBytes
      || created.manifest.snapshot.sha256 !== snapshotSha256
      || created.manifest.source?.file !== basename(dbPath)) {
      throw bankError("migration_backup_invalid", "备份生成结果自身不一致，拒绝继续安装", {
        detail: { reason: "created_manifest_binding" },
      });
    }
  }
  // Always use the fixed official verifier and connection validator. Injected service
  // responses alone cannot establish a backup or impersonate source-content checks.
  try {
    const official = await import("./local-backup.mjs");
    const checked = official.verifyBackup({ backupDir });
    if (!checked.ok || checked.status !== "ok"
        || JSON.stringify(checked.manifest) !== JSON.stringify(manifest)
        || (created.manifest && JSON.stringify(created.manifest) !== JSON.stringify(manifest))) {
      throw new Error("official_backup_binding");
    }
    official.assertSupportedDatabaseConnection(db);
    official.assertBackupSourceConnection(db, checked.manifest);
  } catch {
    throw bankError("migration_backup_invalid", "官方备份核验或持锁源库内容绑定未通过，原库未改动", {
      detail: { reason: "source_content_binding" },
    });
  }
  return {
    backupDir,
    bytes: snapshotBytes,
    integrity: "ok",
    sha256: snapshotSha256,
    formatVersion: manifest.formatVersion ?? null,
    schemaVersion: manifest.structure?.schemaVersion ?? null,
  };
}

/** 当前 SQLite 连接实际指向的文件（`PRAGMA database_list` 的 main）。 */
function databaseHandleFile(db) {
  let rows;
  try {
    rows = db.prepare(`PRAGMA database_list`).all();
  } catch {
    throw bankError("database_handle_unreadable", "无法读取当前数据库连接的文件信息，拒绝继续", null);
  }
  const main = rows.find((row) => String(row.name) === "main");
  const file = main && typeof main.file === "string" && main.file ? resolve(String(main.file)) : null;
  return file;
}

const sameFilePath = (a, b) => (process.platform === "win32"
  ? String(a).toLowerCase() === String(b).toLowerCase()
  : String(a) === String(b));

/**
 * 核对调用方传进来的连接 **就是** dbPath 指向的文件。
 * 不用 `dbPath` 自己声称的路径去代替真实连接事实，避免「备份 A 却往 B 安装」。
 */
function assertDatabaseHandleMatchesPath(db, absPath) {
  const handleFile = databaseHandleFile(db);
  if (!handleFile) {
    throw bankError("database_handle_unbound", "当前连接不是磁盘上的单文件账务库，拒绝安装银行组件", null);
  }
  let realHandle = handleFile;
  let realExpected = absPath;
  try { realHandle = realpathSync(handleFile); } catch { /* 文件刚创建 / 已存在时以 resolve 结果比较 */ }
  try { realExpected = realpathSync(absPath); } catch { /* 同上 */ }
  if (!sameFilePath(realHandle, realExpected)) {
    throw bankError("database_handle_mismatch", "数据库连接与传入的库路径不一致，拒绝对另一个库做迁移备份 / DDL", {
      expectedFile: basename(absPath),
      actualFile: basename(handleFile),
    });
  }
}

/** 当前库已登记的核心 schema 版本（迁移记录缺失时返回 null，不做推断）。 */
function coreSchemaVersionOf(db) {
  if (!tableExists(db, "schema_migrations")) return null;
  const columns = columnNames(db, "schema_migrations");
  if (!columns.includes("version")) return null;
  const row = db.prepare(`SELECT MAX(version) AS version FROM schema_migrations`).get();
  const value = Number(row?.version);
  return Number.isInteger(value) ? value : null;
}

/**
 * 为本次安装生成一个**尚不存在**的专属备份子目录。
 * 真实 LOCAL-06 `createBackup` 要求 outDir 全新；直接把已有 dataDir 传进去会稳定拒绝。
 */
function allocateBackupOutDir({ absPath, dataDir }) {
  const root = join(resolve(dataDir || dirname(absPath)), "bank-component-backups");
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    throw bankError("migration_backup_failed", "无法创建银行组件迁移备份目录，原库未改动", {
      reason: "backup_root_unavailable",
    });
  }
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = join(root, `pre-bank-v1-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw bankError("migration_backup_failed", "无法分配唯一的迁移备份目录，原库未改动", {
    reason: "backup_dir_exhausted",
  });
}

/** 组件 DDL + 版本 / 备份证据：单事务内执行，调用方负责提交 / 回滚。 */
function runComponentDdl(db, { from, creation, backup }) {
  for (const statement of COMPONENT_DDL) db.exec(statement);
  if (backup) {
    db.prepare(`INSERT INTO bank_component_backups (version, path, bytes, integrity, created_at, note)
                VALUES (?,?,?,?,?,?)`)
      .run(BANK_SCHEMA_VERSION, backup.backupDir, backup.bytes, backup.integrity, nowIso(),
        `${creation}; snapshot sha256=${backup.sha256}`);
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
}

/**
 * 初始化 / 升级银行组件结构。
 *
 * 版本 / 结构契约（未来版本、矛盾版本、缺表 / 缺列 / 主键 / UNIQUE / 索引 / FK 动作 / 额外索引）：
 *  - 已符合本版本契约 → 幂等 no-op（already-initialized）；
 *  - 已经有 bank_* 结构但与契约不符 → 结构化拒绝，**不做任何 DDL / 备份 / 写入**，
 *    也不用 CREATE IF NOT EXISTS 静默修补坏库；
 *  - 完全没有 bank_* 表 → 走已有库备份门槛 / 新库创建事实后建组件。
 *
 * 已有库的备份与 DDL 在**同一个 `BEGIN IMMEDIATE` 写事务**内完成：备份期间其他连接无法提交新的
 * 业务写入，DDL 失败 / 备份失败整体回滚，因此不会把「备份之后、DDL 之前」的并发写入当成已保护。
 * VACUUM INTO 由注入的备份实现在**独立只读连接**上执行，不需要在本事务内执行。
 *
 * 失败语义：只有 ROLLBACK 真实成功才返回 `bank_migration_failed` + `rolledBack:true`；
 * 回滚失败 / 未确认时返回 `bank_transaction_rollback_failed` + `rolledBack:false`，
 * 并把连接标为不可用（后续银行读写给 `bank_connection_state_unknown`），不假装「原库已回滚」。
 * 事务冲突（连接上已有调用方事务 / 保存点，或银行自己的未结束嵌套层）在**任何 DDL / 备份 /
 * 回执消耗之前**给 `bank_transaction_conflict` + `rolledBack:false` + `started:false`：不提交、
 * 也不回滚那层事务；BEGIN / SAVEPOINT 没建立起来时给 `bank_transaction_begin_failed`。
 *
 * @param {DatabaseSync} db 显式连接
 * @param {object} options
 * @param {string} options.dbPath 当前库文件路径（备份与创建事实都绑定它）
 * @param {object|null} options.receipt claimFreshDatabase() 返回的进程内创建回执
 * @param {object|null} options.backupService LOCAL-06 备份服务（createBackup / verifyBackup）
 * @param {string|null} options.dataDir 备份输出根目录（默认库文件所在目录；实际备份目录是其中全新的子目录）
 * @returns {Promise<{migrated:boolean, from:number, to:number, creation:string, backup:object|null}>}
 */
export async function ensureBankSchema(db, options = {}) {
  const { dbPath, receipt = null, backupService = null, dataDir = null } = options;
  if (!dbPath) throw bankError("db_path_required", "初始化银行组件必须显式提供库路径");
  // 回滚未确认的连接可能仍持着未提交的组件 DDL / 版本行：不能在上面继续「安装 / 已初始化」判断。
  assertConnectionUsable(db);
  const abs = resolve(String(dbPath));
  // A supplied invalid claim must never silently fall back to existing install.
  const freshClaim = receipt === null ? null : requireFreshClaim(receipt, abs);
  if (freshClaim) freshGuard.assertFreshClaimConnection(freshClaim.token, db);
  if (freshClaim && !freshClaim.connections.has(db)) {
    throw bankError("fresh_database_not_pristine", "该实际连接未在核心 DDL 前通过新库核验");
  }
  // 连接事实必须先绑定到 dbPath，之后的备份 / DDL 才可能是同一个库。
  assertDatabaseHandleMatchesPath(db, abs);
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
  // 安装（新库初始化 / 已有库迁移）必须由银行在最外层自己开事务：
  // 连接上已有调用方事务 / 保存点（或银行自己的未结束嵌套层）时，在消耗创建回执 / 分配备份目录 /
  // 任何 DDL 之前就拒绝，既不提交也不回滚那层事务，也不把它误报成「已回滚」。
  const activeDepth = txnDepth.get(db) || 0;
  if (activeDepth > 0 || transactionActiveOf(db) === true) {
    throw transactionConflictError("begin", { bankManaged: activeDepth > 0 });
  }

  // 只用「仍然有效」的创建事实选路；安装确认提交后才消耗回执，拒绝 / 未开始的调用不烧掉回执。
  const fresh = freshClaim !== null;
  if (fresh) {
    // 新库：创建事实已在进程内验证，不需要也不允许伪造迁移前备份。
    try {
      const result = inTransaction(db, () => runComponentDdl(db, {
        from,
        creation: "fresh-database",
        backup: null,
      }));
      if (!releaseFreshDatabaseClaim(receipt)) throw bankError("fresh_receipt_stale", "新库回执释放失败");
      return result;
    } catch (e) {
      // 事务冲突 / 未开始 / 回滚未确认 / 已确认放弃：原样上抛，不能改写成一个「已回滚」的安装失败。
      if (isTransactionOutcomeError(e)) throw e;
      if (e && typeof e.code === "string" && e.code.startsWith("bank_schema_")) throw e;
      throw bankError("bank_migration_failed", "银行组件结构初始化失败，已确认回滚（未留下半成品）", {
        from,
        to: BANK_SCHEMA_VERSION,
        rolledBack: true,
        transactionState: "rolled_back",
        ...(causeCodeToken(e) ? { causeCode: causeCodeToken(e) } : {}),
      });
    }
  }

  // 已有库：备份 + DDL 必须在同一个排他写事务内。
  const creation = from === 0 ? "existing-database" : "component-upgrade";
  const expectedSchemaVersion = coreSchemaVersionOf(db);
  const outDir = allocateBackupOutDir({ absPath: abs, dataDir });
  let backup = null;
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (e) {
    // BEGIN 没建立：不存在可回滚的写入；若是连接上已有事务则按事务冲突报告（不碰那层事务）。
    if (transactionActiveOf(db) === true) {
      throw transactionConflictError("begin", { bankManaged: (txnDepth.get(db) || 0) > 0 });
    }
    throw bankError("migration_lock_failed", "无法获取安装所需的数据库写锁，原库未改动", {
      started: false,
      rolledBack: false,
      transactionState: "not_started",
      transactionActive: transactionActiveOf(db),
      ...(causeCodeToken(e) ? { causeCode: causeCodeToken(e) } : {}),
    });
  }
  try {
    // 取得写锁后重新核对连接与结构；其他连接在这段时间内无法提交新的业务写入。
    assertDatabaseHandleMatchesPath(db, abs);
    const current = bankSchemaContract(db);
    if (current.ok) {
      const rollback = runRollback(db, ["ROLLBACK"], "already-initialized");
      if (!rollback.rolledBack) throw rollbackUnconfirmedError("already-initialized", rollback.transactionActive, null);
      return {
        migrated: false, from: current.version, to: current.version,
        creation: "already-initialized", backup: null,
      };
    }
    if (current.initialized) {
      throw bankError(current.code, current.message, {
        from: current.version,
        to: BANK_SCHEMA_VERSION,
        problems: current.problems.slice(0, 20),
      });
    }
    assertBaseSchema(db);
    backup = await runBackupGate({
      db,
      backupService,
      dbPath: abs,
      outDir,
      version: BANK_SCHEMA_VERSION,
      expectedSchemaVersion,
    });
    const result = runComponentDdl(db, { from, creation, backup });
    db.exec("COMMIT");
    return result;
  } catch (e) {
    // COMMIT 失败（例如真实 SQLITE_BUSY）时事务可能仍活着：只有 ROLLBACK 真实成功才能说「已回滚」。
    const rollback = runRollback(db, ["ROLLBACK"], "migration");
    if (!rollback.rolledBack) {
      throw rollbackUnconfirmedError("migration", rollback.transactionActive, e);
    }
    if (isTransactionOutcomeError(e)) throw e;
    if (e && typeof e.code === "string" && (
      e.code.startsWith("bank_schema_")
      || e.code.startsWith("migration_")
      || e.code.startsWith("database_handle_")
      || e.code === "schema_not_supported"
    )) throw e;
    throw bankError("bank_migration_failed", "银行组件结构初始化失败，已确认回滚（未留下半成品）", {
      from,
      to: BANK_SCHEMA_VERSION,
      rolledBack: true,
      transactionState: "rolled_back",
      ...(causeCodeToken(e) ? { causeCode: causeCodeToken(e) } : {}),
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
