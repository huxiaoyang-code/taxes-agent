// import-storage.mjs — 增量导入持久层：表结构、版本化迁移、迁移前备份、查询封装。
//
// 设计约束（LOCAL-01）：
// 1) 所有函数显式接收 DatabaseSync 句柄，本文件不 import db.mjs，避免与 db.mjs 形成
//    循环依赖（db.mjs 在启动时调用 ensureImportSchema 完成迁移）。
// 2) 任何新增持久表 / 迁移之前，必须先产生一次**可恢复的一致备份**。
//    VACUUM INTO 生成的单文件快照包含 WAL 中尚未 checkpoint 的已提交数据，
//    因此「旧库带未 checkpoint 的 WAL」也能得到一致备份；备份后立即用独立只读连接
//    执行 PRAGMA integrity_check 验证可恢复性，验证失败则拒绝迁移、保留原库。
//    每次版本升级都重新备份（失败重试也重新备份）；只有「启动时版本已达目标」才跳过备份，
//    因此绝不会复用原库又提交新业务之前的过期快照。
// 3) 迁移整体在一个事务内执行（含 schema_migrations / schema_backups 自身的建立与记录），
//    任一步失败即 ROLLBACK，原库业务表、schema 与版本记录都不变。备份文件在事务之外生成，
//    失败后作为孤儿文件保留（不登记），重试时重新生成一份新的。
// 4) 身份关系（产品口径：一家企业只需要一个账套，多企业批量处理 = 多个账套）：
//      import_enterprise_account_sets：规范企业身份 PK -> 唯一账套（account_set_id UNIQUE），
//        由数据库本身保证「一家企业一个账套」且「一个账套只属一家企业」；
//      import_source_bindings：某来源已显式登记过该企业（同企业可来自多个来源，但都指向同一账套）。
//    不同来源（source.system）不构成第二家企业，只构成同一企业的来源证据。
// 5) 这里只放「导入所需」的最小审计：批次结果（import_batches）、逐张来源追踪
//    （import_voucher_sources）与批次→逐张来源凭证关联（import_batch_vouchers，去重命中也留痕）。
//    完整审计 / 留痕见后续 LOCAL06。

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { centsToNumber, parseMoney } from "./money.mjs";
import { assertRestoreWritable } from './local-restore-control.mjs';

/** 本文件负责的 schema 版本。新增列 / 新增表必须新增 migration 并递增版本。 */
export const IMPORT_SCHEMA_VERSION = 5;

/** 本文件创建的持久对象（供自检 / 测试断言使用）。 */
export const IMPORT_TABLES = [
  "schema_migrations",
  "schema_backups",
  "import_enterprise_account_sets",
  "import_source_bindings",
  "import_batches",
  "import_voucher_sources",
  "import_batch_vouchers",
];

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- 规范内容指纹
// 放在存储层：迁移时要用它给历史来源登记回填「落库后指纹」，避免与领域层循环依赖。
// 金额统一按分归一化（ROUND_HALF_UP），与领域层写入口径一致，不用浮点乘法。
const money2 = (value) => {
  const parsed = parseMoney(value, { allowNegative: true, label: "金额" });
  if (!parsed.ok) throw new Error(`money_invalid:${parsed.code}`);
  return centsToNumber(parsed.cents);
};
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * 来源内容指纹：只包含确定性的业务字段，金额取 2 位小数。
 * 自动取号的凭证（number 缺省）指纹里 number 记为 null，同批重试不会因自动编号变化被误判为修订。
 */
export function voucherFingerprint(v = {}) {
  const period = String(v.period ?? "");
  return sha256(JSON.stringify({
    period,
    date: v.date || `${period}-01`,
    word: v.word || "记",
    number: typeof v.number === "number" ? v.number : null,
    summary: v.summary || "",
    entries: (Array.isArray(v.entries) ? v.entries : []).map((e) => [
      String(e.code ?? ""), money2(e.debit), money2(e.credit), String(e.summary ?? ""),
    ]),
  }));
}

/**
 * 落库后凭证指纹：用数据库里的实际凭证（含自动分配的凭证号 / 分录摘要默认值）计算，
 * 用于核验「登记的来源凭证」与「当前本机凭证」是否仍是同一张、内容未被修改。
 */
export function persistedVoucherFingerprint(v = {}, entries = []) {
  return voucherFingerprint({
    period: v.period,
    date: v.voucher_date,
    word: v.word,
    number: typeof v.number === "number" ? v.number : null,
    summary: v.summary ?? "",
    entries: (Array.isArray(entries) ? entries : []).map((e) => ({
      code: e.code, debit: e.debit, credit: e.credit, summary: e.summary ?? "",
    })),
  });
}

// ---------------------------------------------------------------- 数据库结构 v1
const V1_STATEMENTS = [
  // ---- 迁移记录与备份记录（最小版本化 / 回退依据）----
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     version INTEGER PRIMARY KEY,
     applied_at TEXT NOT NULL,
     note TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS schema_backups (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     version INTEGER NOT NULL,
     path TEXT NOT NULL,
     created_at TEXT NOT NULL,
     bytes INTEGER,
     integrity TEXT NOT NULL DEFAULT 'ok',
     note TEXT
   )`,

  // ---- 来源身份绑定（v1：按来源系统隔离；v2 起改为来源证据 + 规范企业->账套唯一关系）----
  `CREATE TABLE IF NOT EXISTS import_source_bindings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_system TEXT NOT NULL,
     enterprise_key TEXT NOT NULL,
     enterprise_name TEXT NOT NULL DEFAULT '',
     account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
     bound_at TEXT NOT NULL,
     bound_by TEXT NOT NULL DEFAULT 'import',
     UNIQUE (source_system, enterprise_key, account_set_id)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_import_bindings_set
     ON import_source_bindings (source_system, account_set_id)`,
  `CREATE INDEX IF NOT EXISTS idx_import_bindings_enterprise
     ON import_source_bindings (source_system, enterprise_key)`,

  // ---- 批次：稳定批次 ID + 规范内容指纹 + 结果 ----
  `CREATE TABLE IF NOT EXISTS import_batches (
     batch_id TEXT PRIMARY KEY,
     source_system TEXT NOT NULL,
     enterprise_key TEXT NOT NULL,
     mode TEXT NOT NULL,
     account_set_id INTEGER REFERENCES account_sets(id) ON DELETE CASCADE,
     content_fingerprint TEXT NOT NULL,
     status TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     result_json TEXT NOT NULL DEFAULT '{}',
     error_code TEXT,
     error_message TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_import_batches_scope
     ON import_batches (source_system, enterprise_key, status)`,

  // ---- 逐张来源凭证追踪：跨批去重与内容修订判定的唯一依据 ----
  `CREATE TABLE IF NOT EXISTS import_voucher_sources (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_system TEXT NOT NULL,
     enterprise_key TEXT NOT NULL,
     source_voucher_id TEXT NOT NULL,
     account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
     voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
     content_fingerprint TEXT NOT NULL,
     batch_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (source_system, enterprise_key, source_voucher_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_import_voucher_sources_voucher
     ON import_voucher_sources (voucher_id)`,
  `CREATE INDEX IF NOT EXISTS idx_import_voucher_sources_batch
     ON import_voucher_sources (batch_id)`,
];

// ---------------------------------------------------------------- 数据库结构 v2
/** v1 的来源绑定 -> 规范企业账套映射；遇到互相矛盾的旧数据时拒绝迁移（不自动合并 / 删除 / 改名）。 */
function backfillEnterpriseAccountSets(db) {
  const rows = db.prepare(`SELECT * FROM import_source_bindings ORDER BY id`).all();
  const ownerByEnterprise = new Map();
  const ownerBySet = new Map();
  for (const row of rows) {
    const enterprise = row.enterprise_key;
    const setId = row.account_set_id;
    const existingSet = ownerByEnterprise.get(enterprise);
    if (existingSet !== undefined && existingSet !== setId) {
      throw new Error(`import_binding_conflict:enterprise_bound_to_multiple_sets:${enterprise}`);
    }
    const existingOwner = ownerBySet.get(setId);
    if (existingOwner !== undefined && existingOwner !== enterprise) {
      throw new Error(`import_binding_conflict:account_set_bound_to_multiple_enterprises:${setId}`);
    }
    if (existingSet === undefined) {
      db.prepare(`INSERT INTO import_enterprise_account_sets
                    (enterprise_key, enterprise_name, account_set_id, bound_at, bound_by)
                  VALUES (?,?,?,?,?)`)
        .run(enterprise, row.enterprise_name || "", setId, row.bound_at || nowIso(), row.bound_by || "import");
      ownerByEnterprise.set(enterprise, setId);
      ownerBySet.set(setId, enterprise);
    }
  }
}

/** 给 v1 的历史来源登记回填落库后指纹；凭证已被删除的登记保持空串（核验时按未验证处理，不猜）。 */
function backfillVoucherFingerprints(db) {
  const rows = db.prepare(`SELECT id, voucher_id FROM import_voucher_sources`).all();
  const findVoucher = db.prepare(`SELECT * FROM vouchers WHERE id=?`);
  const findEntries = db.prepare(
    `SELECT code, summary, debit, credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no`,
  );
  const update = db.prepare(`UPDATE import_voucher_sources SET voucher_fingerprint=? WHERE id=?`);
  for (const row of rows) {
    const voucher = findVoucher.get(row.voucher_id);
    if (!voucher) continue; // 已删除：留空，核验时给结构化冲突而不是静默重入账
    update.run(persistedVoucherFingerprint(voucher, findEntries.all(voucher.id)), row.id);
  }
}

const V2_STATEMENTS = [
  // ---- 规范企业身份 -> 唯一账套（数据库级保证一家企业一个账套、一个账套只属一家企业）----
  `CREATE TABLE IF NOT EXISTS import_enterprise_account_sets (
     enterprise_key TEXT PRIMARY KEY,
     enterprise_name TEXT NOT NULL DEFAULT '',
     account_set_id INTEGER NOT NULL UNIQUE REFERENCES account_sets(id) ON DELETE CASCADE,
     bound_at TEXT NOT NULL,
     bound_by TEXT NOT NULL DEFAULT 'import'
   )`,
  backfillEnterpriseAccountSets,

  // ---- 来源绑定改为「来源证据」：同企业可来自多个来源，但都指向同一个规范账套 ----
  `CREATE TABLE import_source_bindings_v2 (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_system TEXT NOT NULL,
     enterprise_key TEXT NOT NULL REFERENCES import_enterprise_account_sets(enterprise_key) ON DELETE CASCADE,
     enterprise_name TEXT NOT NULL DEFAULT '',
     bound_at TEXT NOT NULL,
     bound_by TEXT NOT NULL DEFAULT 'import',
     UNIQUE (source_system, enterprise_key)
   )`,
  `INSERT INTO import_source_bindings_v2
     (id, source_system, enterprise_key, enterprise_name, bound_at, bound_by)
   SELECT id, source_system, enterprise_key, enterprise_name, bound_at, bound_by
     FROM import_source_bindings`,
  `DROP TABLE import_source_bindings`,
  `ALTER TABLE import_source_bindings_v2 RENAME TO import_source_bindings`,
  `CREATE INDEX IF NOT EXISTS idx_import_bindings_enterprise
     ON import_source_bindings (enterprise_key)`,

  // ---- 逐张来源追踪：删除本机凭证后保留可追踪登记（去掉 vouchers 外键），并记录落库后指纹 ----
  `CREATE TABLE import_voucher_sources_v2 (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_system TEXT NOT NULL,
     enterprise_key TEXT NOT NULL,
     source_voucher_id TEXT NOT NULL,
     account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
     voucher_id INTEGER NOT NULL,
     voucher_fingerprint TEXT NOT NULL DEFAULT '',
     content_fingerprint TEXT NOT NULL,
     batch_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (source_system, enterprise_key, source_voucher_id)
   )`,
  `INSERT INTO import_voucher_sources_v2
     (id, source_system, enterprise_key, source_voucher_id, account_set_id, voucher_id,
      voucher_fingerprint, content_fingerprint, batch_id, created_at)
   SELECT id, source_system, enterprise_key, source_voucher_id, account_set_id, voucher_id,
          '', content_fingerprint, batch_id, created_at
     FROM import_voucher_sources`,
  `DROP TABLE import_voucher_sources`,
  `ALTER TABLE import_voucher_sources_v2 RENAME TO import_voucher_sources`,
  `CREATE INDEX IF NOT EXISTS idx_import_voucher_sources_voucher
     ON import_voucher_sources (voucher_id)`,
  `CREATE INDEX IF NOT EXISTS idx_import_voucher_sources_batch
     ON import_voucher_sources (batch_id)`,
  backfillVoucherFingerprints,
];

// ---------------------------------------------------------------- 数据库结构 v3
/** v2 的逐张来源登记回填「批次 → 逐张来源凭证」关联（历史批次都按 created 记录）。 */
function backfillBatchVouchers(db) {
  db.exec(`INSERT INTO import_batch_vouchers
             (batch_id, source_system, enterprise_key, source_voucher_id, account_set_id,
              voucher_id, content_fingerprint, action, created_at)
           SELECT batch_id, source_system, enterprise_key, source_voucher_id, account_set_id,
                  voucher_id, content_fingerprint, 'created', created_at
             FROM import_voucher_sources
            ORDER BY id`);
}

const V3_STATEMENTS = [
  // 跨批去重不会新增第二张凭证，但必须能回答「这一批到底处理了哪些来源凭证、各自是新建还是去重」。
  // 只存关联（不复制来源凭证 / 凭证），因此不会伪造第二个来源或第二张凭证；
  // 来源当前状态仍由 import_voucher_sources + 实时核验得出。
  `CREATE TABLE IF NOT EXISTS import_batch_vouchers (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     batch_id TEXT NOT NULL,
     source_system TEXT NOT NULL,
     enterprise_key TEXT NOT NULL,
     source_voucher_id TEXT NOT NULL,
     account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
     voucher_id INTEGER NOT NULL,
     content_fingerprint TEXT NOT NULL,
     action TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (batch_id, source_voucher_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_import_batch_vouchers_voucher
     ON import_batch_vouchers (voucher_id)`,
  `CREATE INDEX IF NOT EXISTS idx_import_batch_vouchers_scope
     ON import_batch_vouchers (source_system, enterprise_key, account_set_id)`,
  backfillBatchVouchers,
];

// ---------------------------------------------------------------- 数据库结构 v4
/** 加列前先看当前列（旧库 / 新建库 / 重试都要幂等）；表不存在时跳过（合成旧库可能只有子集表）。 */
const columnExists = (db, table, column) => {
  if (!tableExists(db, table)) return true; // 表不存在：跳过，不报错
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
};
const addColumnIfMissing = (table, column, ddl) => (db) => {
  if (columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
};

/**
 * LOCAL-02 资产卡片补项契约（只加列，不改旧行语义）：
 *  acquired_period      显式取得 / 入账期间；留 NULL 表示未登记（**不回落** start_period，也不臆造取得日期；
 *                       核对时按「已存在」保守参与并报 asset_acquired_period_missing，经维护入口补登记后解除）
 *  opening_accumulated  补项期初累计（历史已入账的累计折旧 / 摊销，计入剩余可计提额）
 *  ledger_status        booked=参与卡片/总账核对；pending_purchase_voucher=已显式登记“尚未入固定资产账”
 *  ledger_note          未入账 / 补项原因（必填于非 booked）
 *  origin               purchase / supplement / import（补项来源留痕）
 */
const V4_STATEMENTS = [
  addColumnIfMissing("asset_cards", "acquired_period", "TEXT"),
  addColumnIfMissing("asset_cards", "opening_accumulated", "REAL NOT NULL DEFAULT 0"),
  addColumnIfMissing("asset_cards", "ledger_status", "TEXT NOT NULL DEFAULT 'booked'"),
  addColumnIfMissing("asset_cards", "ledger_note", "TEXT NOT NULL DEFAULT ''"),
  addColumnIfMissing("asset_cards", "origin", "TEXT NOT NULL DEFAULT 'purchase'"),
];

// ---------------------------------------------------------------- 数据库结构 v5
/**
 * LOCAL-03a 会计 profile 持久化（只加一列，不做准则转换）：
 *  - accounting_profile_id  不可变 profile ID（解析科目表 / 报表映射版本）；
 *  - 默认 'legacy-small-coa-v1'：**所有迁移前既有账套**（小企标签、企业标签、未知标签、空账套）
 *    一律成为 legacy 兼容账套，保留原 accounting_standard 字符串，不改历史科目 / 期初 / 凭证 / 卡片 / 批次 / 指纹；
 *  - 只存 profile ID，不另存可互相矛盾的 coaVersion / reportMappingVersion 多列；
 *  - 没有普通更新入口，本迁移也不按标签重种科目或把 legacy 升级成新准则。
 */
const V5_STATEMENTS = [
  addColumnIfMissing(
    "account_sets",
    "accounting_profile_id",
    "TEXT NOT NULL DEFAULT 'legacy-small-coa-v1'",
  ),
];

const MIGRATIONS = [
  {
    version: 1,
    note: "LOCAL-01 增量导入：来源绑定 / 批次 / 逐张来源追踪（迁移前自动备份，可用 VACUUM INTO 备份文件回退）",
    steps: V1_STATEMENTS,
  },
  {
    version: 2,
    note: "LOCAL-01 一企一账套：规范企业->唯一账套、来源绑定改为来源证据、来源凭证删除后保留追踪并记录落库指纹",
    steps: V2_STATEMENTS,
  },
  {
    version: 3,
    note: "LOCAL-01 逐张批次追踪：批次->来源凭证关联（新建 / 去重各自留痕），回填历史批次",
    steps: V3_STATEMENTS,
  },
  {
    version: 4,
    note: "LOCAL-02 资产卡片补项契约：取得期间 / 期初累计 / 未入账登记 / 来源（只加列，旧行默认值不变）",
    steps: V4_STATEMENTS,
  },
  {
    version: 5,
    note: "LOCAL-03a 会计 profile：账套增加不可变 accounting_profile_id；迁移前既有账套一律 legacy 兼容，原 accounting_standard 与历史业务不变",
    steps: V5_STATEMENTS,
  },
];

const tableExists = (db, name) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);

/** 当前 schema 版本；没有任何迁移记录时为 0（旧库 / 新库）。 */
export function schemaVersion(db) {
  if (!tableExists(db, "schema_migrations")) return 0;
  const r = db.prepare(`SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations`).get();
  return Number(r?.v || 0);
}

/** 只读自检：版本、已建对象、备份记录。 */
export function schemaState(db) {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all()
    .map((r) => r.name);
  const backups = tableExists(db, "schema_backups")
    ? db.prepare(`SELECT id, version, path, created_at, bytes, integrity, note FROM schema_backups ORDER BY id`).all()
    : [];
  return { version: schemaVersion(db), target: IMPORT_SCHEMA_VERSION, tables, backups };
}

/**
 * 生成一致性备份并验证可恢复性。
 * - VACUUM INTO 生成的是单文件完整快照（含 WAL 中已提交但未 checkpoint 的数据）；
 * - 立即另开只读连接执行 PRAGMA integrity_check，失败则抛 migration_backup_invalid，
 *   调用方据此拒绝迁移，原库不受影响。
 *
 * 注意：本函数**不**复用旧备份。旧实现只按 size>0 判断可复用，会在原库又有新业务提交后
 * 复用过期快照；现在每次真正需要迁移时都重新备份，只有「启动时版本已达目标」才跳过备份。
 */
function createBackup(db, dataDir, version) {
  const stamp = nowIso().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  // 目标文件已存在时 VACUUM INTO 会失败：按序号递推取一个未占用的名字，
  // 但绝不复用 / 覆盖既有备份文件。
  let path = join(dataDir, `workbench.db.pre-v${version}-${stamp}.bak`);
  for (let i = 2; existsSync(path) && i <= 20; i += 1) {
    path = join(dataDir, `workbench.db.pre-v${version}-${stamp}-${i}.bak`);
  }
  if (existsSync(path)) throw new Error(`migration_backup_exists:${path}`);
  db.prepare(`VACUUM INTO ?`).run(path);
  if (!existsSync(path)) throw new Error("migration_backup_missing");
  let integrity = "ok";
  const probe = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = probe.prepare(`PRAGMA integrity_check`).all();
    const values = rows.map((r) => String(Object.values(r)[0]));
    if (!values.length || values.some((v) => v.toLowerCase() !== "ok")) integrity = values.join(";") || "unknown";
    // 备份必须能读到既有业务表（证明不是空壳快照）。
    const legacy = ["account_sets", "vouchers", "voucher_entries"]
      .filter((name) => tableExists(probe, name));
    if (!legacy.length) integrity = "no_legacy_tables";
  } finally {
    probe.close();
  }
  const bytes = statSync(path).size;
  if (integrity !== "ok") {
    throw new Error(`migration_backup_invalid:${integrity}`);
  }
  return { path, bytes, integrity };
}

/**
 * 确保导入所需的表 / 版本存在。
 * 顺序（重要）：先产生一致备份，再把「新增结构 + 备份记录 + 迁移记录」放进同一个事务。
 * 因此备份文件里没有本次新增的 schema；失败回滚后原库 schema / 业务数据都不变。
 *
 * 返回 { migrated, from, to, backup, reusedBackup }；失败时抛 migration_failed 且原库不变。
 */
export function ensureImportSchema(db, { dataDir, targetVersion = IMPORT_SCHEMA_VERSION } = {}) {
  assertRestoreWritable(db);
  if (!dataDir) throw new Error("migration_data_dir_required");
  if (!Number.isInteger(targetVersion) || targetVersion < 1 || targetVersion > IMPORT_SCHEMA_VERSION) {
    throw new Error(`migration_target_invalid:${targetVersion}`);
  }
  const from = schemaVersion(db);
  if (from >= targetVersion) {
    return { migrated: false, from, to: from, backup: null, reusedBackup: false };
  }

  // ---- 迁移前最小备份条件：每次真正升级都重新备份（绝不复用可能过期的旧快照） ----
  const backup = createBackup(db, dataDir, targetVersion);

  // ---- 迁移本身：单事务；新增结构在备份之后创建；失败即回滚 ----
  db.exec("BEGIN IMMEDIATE");
  try {
    // 版本记录表与备份记录表也属于「新增结构」，必须在本事务内建立，
    // 这样备份文件保持迁移前结构，失败回滚也不会遗留半截版本记录。
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
               version INTEGER PRIMARY KEY,
               applied_at TEXT NOT NULL,
               note TEXT
             )`);
    db.exec(`CREATE TABLE IF NOT EXISTS schema_backups (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               version INTEGER NOT NULL,
               path TEXT NOT NULL,
               created_at TEXT NOT NULL,
               bytes INTEGER,
               integrity TEXT NOT NULL DEFAULT 'ok',
               note TEXT
             )`);
    const info = db
      .prepare(`INSERT INTO schema_backups (version, path, created_at, bytes, integrity, note)
                VALUES (?,?,?,?,?,?)`)
      .run(targetVersion, backup.path, nowIso(), backup.bytes, backup.integrity, "pre-migration");
    const backupRecord = {
      id: Number(info.lastInsertRowid), version: targetVersion, path: backup.path, bytes: backup.bytes,
    };

    for (const migration of MIGRATIONS) {
      if (migration.version <= from || migration.version > targetVersion) continue;
      for (const step of migration.steps) {
        if (typeof step === "function") step(db);
        else db.exec(step);
      }
      db.prepare(`INSERT INTO schema_migrations (version, applied_at, note) VALUES (?,?,?)`)
        .run(migration.version, nowIso(), migration.note);
    }
    db.exec("COMMIT");
    return { migrated: true, from, to: targetVersion, backup: backupRecord, reusedBackup: false };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* 回滚失败时仍抛出原始错误 */ }
    const err = new Error("migration_failed");
    err.cause = e;
    err.details = { from, to: targetVersion, backupPath: backup?.path ?? null, reason: e?.message || String(e) };
    throw err;
  }
}

/** 仅供恢复的固定精确迁移。私有签发者先验证其持有的官方保护备份，再向此入口交付一次性能力。 */
export async function upgradeRestoreImportSchema(db, { capability, backup } = {}) {
  const { assertPrivateRestoreCapability } = await import('./local-backup.mjs');
  assertPrivateRestoreCapability(db, capability);
  const from = schemaVersion(db);
  if (![3,4,5].includes(from)) throw new Error('migration_failed');
  if (from === 5) return;
  if (!backup || typeof backup.path !== 'string' || !Number.isSafeInteger(backup.bytes)) throw new Error('migration_failed');
  db.prepare('INSERT INTO schema_backups(version,path,created_at,bytes,integrity,note) VALUES(?,?,?,?,?,?)')
    .run(5,backup.path,nowIso(),backup.bytes,'ok','pre-migration');
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    for (const step of migration.steps) typeof step === 'function' ? step(db) : db.exec(step);
    db.prepare('INSERT INTO schema_migrations(version,applied_at,note) VALUES(?,?,?)').run(migration.version,nowIso(),migration.note);
  }
  assertPrivateRestoreCapability(db, capability);
}

// ------------------------------------------------------------------ 规范企业身份 -> 账套
export function getEnterpriseAccountSet(db, enterpriseKey) {
  return db
    .prepare(`SELECT * FROM import_enterprise_account_sets WHERE enterprise_key=?`)
    .get(enterpriseKey) || null;
}

export function getAccountSetEnterprise(db, accountSetId) {
  return db
    .prepare(`SELECT * FROM import_enterprise_account_sets WHERE account_set_id=?`)
    .get(accountSetId) || null;
}

export function insertEnterpriseAccountSet(db, {
  enterpriseKey, enterpriseName = "", accountSetId, boundBy = "import",
}) {
  assertRestoreWritable(db);
  db.prepare(`INSERT INTO import_enterprise_account_sets
                (enterprise_key, enterprise_name, account_set_id, bound_at, bound_by)
              VALUES (?,?,?,?,?)`)
    .run(enterpriseKey, enterpriseName, accountSetId, nowIso(), boundBy);
}

// ------------------------------------------------------------------ 来源证据（同企业可多来源）
export function getSourceBinding(db, sourceSystem, enterpriseKey) {
  return db
    .prepare(`SELECT b.source_system, b.enterprise_key, b.enterprise_name, b.bound_at, b.bound_by,
                     c.account_set_id, c.enterprise_name AS canonical_name
                FROM import_source_bindings b
                JOIN import_enterprise_account_sets c ON c.enterprise_key = b.enterprise_key
               WHERE b.source_system=? AND b.enterprise_key=?`)
    .get(sourceSystem, enterpriseKey) || null;
}

export function listSourceBindingsForEnterprise(db, enterpriseKey) {
  return db
    .prepare(`SELECT b.source_system, b.enterprise_key, b.enterprise_name, b.bound_at, b.bound_by,
                     c.account_set_id
                FROM import_source_bindings b
                JOIN import_enterprise_account_sets c ON c.enterprise_key = b.enterprise_key
               WHERE b.enterprise_key=? ORDER BY b.id`)
    .all(enterpriseKey);
}

export function listSourceBindingsForAccountSet(db, accountSetId) {
  return db
    .prepare(`SELECT b.source_system, b.enterprise_key, b.enterprise_name, b.bound_at, b.bound_by,
                     c.account_set_id
                FROM import_source_bindings b
                JOIN import_enterprise_account_sets c ON c.enterprise_key = b.enterprise_key
               WHERE c.account_set_id=? ORDER BY b.id`)
    .all(accountSetId);
}

export function insertSourceBinding(db, {
  sourceSystem, enterpriseKey, enterpriseName = "", boundBy = "import",
}) {
  assertRestoreWritable(db);
  db.prepare(`INSERT INTO import_source_bindings
                (source_system, enterprise_key, enterprise_name, bound_at, bound_by)
              VALUES (?,?,?,?,?)`)
    .run(sourceSystem, enterpriseKey, enterpriseName, nowIso(), boundBy);
}

// ------------------------------------------------------------------ 批次
export function getBatch(db, batchId) {
  return db.prepare(`SELECT * FROM import_batches WHERE batch_id=?`).get(batchId) || null;
}

export function markBatchCompleted(db, {
  batchId, sourceSystem, enterpriseKey, mode, accountSetId, contentFingerprint, result,
}) {
  assertRestoreWritable(db);
  db.prepare(`INSERT INTO import_batches
                (batch_id, source_system, enterprise_key, mode, account_set_id, content_fingerprint,
                 status, attempts, created_at, updated_at, result_json, error_code, error_message)
              VALUES (?,?,?,?,?,?,'completed',1,?,?,?,NULL,NULL)
              ON CONFLICT(batch_id) DO UPDATE SET
                status='completed',
                account_set_id=excluded.account_set_id,
                content_fingerprint=excluded.content_fingerprint,
                updated_at=excluded.updated_at,
                attempts=import_batches.attempts + 1,
                result_json=excluded.result_json,
                error_code=NULL,
                error_message=NULL`)
    .run(batchId, sourceSystem, enterpriseKey, mode, accountSetId ?? null, contentFingerprint,
      nowIso(), nowIso(), JSON.stringify(result ?? {}));
}

/**
 * 记录失败批次（事务回滚之后单独写入，仅审计用途，不含业务状态）。
 * 不吞原始错误：调用方在 catch 中调用本函数后必须重新抛出原错误。
 *
 * 已完成的批次永远不能被失败审计覆写：ON CONFLICT 的 UPDATE 带 status<>'completed' 条件，
 * 对已完成批次整条更新不生效（保留 completed / 原结果）。
 */
export function markBatchFailed(db, {
  batchId, sourceSystem, enterpriseKey, mode, accountSetId, contentFingerprint, errorCode, errorMessage,
}) {
  assertRestoreWritable(db);
  db.prepare(`INSERT INTO import_batches
                (batch_id, source_system, enterprise_key, mode, account_set_id, content_fingerprint,
                 status, attempts, created_at, updated_at, result_json, error_code, error_message)
              VALUES (?,?,?,?,?,?,'failed',1,?,?,'{}',?,?)
              ON CONFLICT(batch_id) DO UPDATE SET
                status='failed',
                updated_at=excluded.updated_at,
                attempts=import_batches.attempts + 1,
                error_code=excluded.error_code,
                error_message=excluded.error_message
              WHERE import_batches.status <> 'completed'`)
    .run(batchId, sourceSystem, enterpriseKey, mode, accountSetId ?? null, contentFingerprint,
      nowIso(), nowIso(), String(errorCode ?? "").slice(0, 200), String(errorMessage ?? "").slice(0, 2000));
}

// ------------------------------------------------------------------ 来源凭证
export function getVoucherSource(db, sourceSystem, enterpriseKey, sourceVoucherId) {
  return db
    .prepare(`SELECT * FROM import_voucher_sources
               WHERE source_system=? AND enterprise_key=? AND source_voucher_id=?`)
    .get(sourceSystem, enterpriseKey, sourceVoucherId) || null;
}

export function insertVoucherSource(db, {
  sourceSystem, enterpriseKey, sourceVoucherId, accountSetId, voucherId,
  contentFingerprint, voucherFingerprint: voucherFp, batchId,
}) {
  assertRestoreWritable(db);
  db.prepare(`INSERT INTO import_voucher_sources
                (source_system, enterprise_key, source_voucher_id, account_set_id, voucher_id,
                 voucher_fingerprint, content_fingerprint, batch_id, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(sourceSystem, enterpriseKey, sourceVoucherId, accountSetId, voucherId,
      voucherFp, contentFingerprint, batchId, nowIso());
}

export function listVoucherSourcesForBatch(db, batchId) {
  return db
    .prepare(`SELECT source_voucher_id, voucher_id, account_set_id, voucher_fingerprint,
                     content_fingerprint, created_at
                FROM import_voucher_sources WHERE batch_id=? ORDER BY id`)
    .all(batchId);
}

/** 记录「本批次处理了哪张来源凭证、是新建还是去重」；只存关联，不复制来源凭证 / 凭证。 */
export function insertBatchVoucher(db, {
  batchId, sourceSystem, enterpriseKey, sourceVoucherId, accountSetId, voucherId,
  contentFingerprint, action,
}) {
  assertRestoreWritable(db);
  db.prepare(`INSERT INTO import_batch_vouchers
                (batch_id, source_system, enterprise_key, source_voucher_id, account_set_id,
                 voucher_id, content_fingerprint, action, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(batchId, sourceSystem, enterpriseKey, sourceVoucherId, accountSetId,
      voucherId, contentFingerprint, action, nowIso());
}

/** 只读：某批次处理的逐张来源凭证（含去重命中项），按插入顺序。 */
export function listBatchVouchers(db, batchId) {
  return db
    .prepare(`SELECT batch_id, source_system, enterprise_key, source_voucher_id, account_set_id,
                     voucher_id, content_fingerprint, action, created_at
                FROM import_batch_vouchers WHERE batch_id=? ORDER BY id`)
    .all(batchId);
}

export function listVoucherSourcesForAccountSet(db, sourceSystem, enterpriseKey, accountSetId) {
  return db
    .prepare(`SELECT source_voucher_id, voucher_id, voucher_fingerprint, content_fingerprint,
                     batch_id, created_at
                FROM import_voucher_sources
               WHERE source_system=? AND enterprise_key=? AND account_set_id=?
               ORDER BY id`)
    .all(sourceSystem, enterpriseKey, accountSetId);
}
