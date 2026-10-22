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

export function bankSchemaVersion(db) {
  if (!tableExists(db, "bank_component_migrations")) return 0;
  const row = db.prepare(`SELECT COALESCE(MAX(version),0) AS v FROM bank_component_migrations`).get();
  return Number(row?.v || 0);
}

/** 只读自检：组件版本、表、迁移 / 备份记录。 */
export function bankSchemaState(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name);
  const migrations = tableExists(db, "bank_component_migrations")
    ? db.prepare(`SELECT version, applied_at, note FROM bank_component_migrations ORDER BY version`).all()
    : [];
  const backups = tableExists(db, "bank_component_backups")
    ? db.prepare(`SELECT id, version, path, bytes, integrity, created_at, note FROM bank_component_backups ORDER BY id`).all()
    : [];
  return {
    version: bankSchemaVersion(db),
    target: BANK_SCHEMA_VERSION,
    tables: tables.filter((t) => t.startsWith("bank_")),
    migrations,
    backups,
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
  const from = bankSchemaVersion(db);
  if (from >= BANK_SCHEMA_VERSION) {
    return { migrated: false, from, to: from, creation: "already-initialized", backup: null };
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
      return { migrated: true, from, to: BANK_SCHEMA_VERSION, creation, backup };
    });
  } catch (e) {
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
}// ------------------------------------------------------------------ 审计
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
