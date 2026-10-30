import { assertRestoreOpenPath, assertRestoreWritable } from './local-restore-control.mjs';
// db.mjs — SQLite 存储（node:sqlite，零依赖）
import { DatabaseSync } from "node:sqlite";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { ensureImportSchema } from "./import-storage.mjs";
import { assertOpenedDatabaseClaimsMatch } from "./database-open-guard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 隔离年度 worker 使用显式的进程级只读模式；
// 此模式不创建目录/数据库，也不调用安装器或迁移。
const DATABASE_MODE = process.env.WORKBENCH_DATABASE_MODE ?? 'readwrite';
if (!['readwrite', 'readonly'].includes(DATABASE_MODE)) throw Object.assign(new Error('database_mode_invalid'), { code: 'database_mode_invalid' });
const READ_ONLY = DATABASE_MODE === 'readonly';
if (READ_ONLY && (!process.env.WORKBENCH_DATA_DIR || !isAbsolute(process.env.WORKBENCH_DATA_DIR))) throw Object.assign(new Error('readonly_data_dir_required'), { code: 'readonly_data_dir_required' });
const DATA_DIR = process.env.WORKBENCH_DATA_DIR || join(__dirname, "..", "data");
assertRestoreOpenPath(join(DATA_DIR,'workbench.db'));
if (!READ_ONLY) mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = join(DATA_DIR, "workbench.db");
export const db = READ_ONLY ? new DatabaseSync(DB_FILE, { readOnly: true }) : new DatabaseSync(DB_FILE);

// 初始化钩子（**必须**在任何核心 DDL、`journal_mode = WAL` 与导入结构迁移写之前）：
// 若本进程刚用独占创建回执创建了这个 workbench.db（页 1 种子由创建 fd 写入），则必须证明
// 「这条实际打开的连接」挂载的就是那个对象（连接页 1 的随机 nonce + 魔数 + 创建 fd 身份 + 无别名），
// 否则立即关闭连接并拒绝——外部旧库 / 零字节文件被换入 / 同路径同 dev-ino 但内容被改写时
// 到这里就停下，不会先建表 / 设 WAL 污染再报错。
// 反之，若本进程**持有活动独占创建回执**而这次要打开的是另一个库（别的数据目录 / 别名 / junction /
// 未指定目录），同样在任何写之前以 `fresh_claim_target_mismatch` 拒绝：不能因为按路径查不到创建事实
// 就退化成普通入口，否则「claim A、再把 WORKBENCH_DATA_DIR 指向既有库 B」会把核心结构写进 B。
// 普通业务入口（本进程没有任何活动创建事实）行为与旧实现完全一致。
try {
  assertOpenedDatabaseClaimsMatch(db, { dataDir: DATA_DIR, dbPath: DB_FILE });
  // 路径预检使用了另一条连接；若预检后文件发生变化，须在
  // WAL、核心 DDL 或迁移前重新检查实际句柄。
  assertRestoreWritable(db);
} catch (error) {
  try { db.close(); } catch { /* 拒绝后关闭失败不改变结论 */ }
  throw error;
}

if (READ_ONLY) {
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON');
    // 要求完整的当前核心 DDL 以及 v4 资产、v5 profile 字段。
    // 版本记录不能代替缺失字段，因为部分业务读取器
    // 为了兼容旧证据，会有意对缺失值使用默认值。
    const required = {
      schema_migrations: ['version', 'applied_at', 'note'],
      account_sets: ['id', 'name', 'taxpayer_type', 'accounting_standard', 'start_period', 'created_at', 'accounting_profile_id'],
      accounts: ['id', 'account_set_id', 'code', 'name', 'category', 'direction', 'contra', 'is_leaf'],
      opening_balances: ['account_set_id', 'code', 'debit', 'credit'], periods: ['account_set_id', 'period', 'status'],
      vouchers: ['id', 'account_set_id', 'period', 'voucher_date', 'word', 'number', 'summary', 'status', 'created_at', 'kind'],
      voucher_entries: ['id', 'voucher_id', 'line_no', 'code', 'summary', 'debit', 'credit'],
      asset_cards: ['id', 'account_set_id', 'kind', 'name', 'original_cost', 'residual_rate', 'useful_life_months', 'start_period',
        'asset_account', 'accum_account', 'expense_account', 'created_at', 'acquired_period', 'opening_accumulated', 'ledger_status', 'ledger_note', 'origin'],
      asset_depreciation_runs: ['id', 'account_set_id', 'asset_id', 'period', 'amount', 'voucher_id', 'created_at'],
    };
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const ready = Object.entries(required).every(([name, fields]) => tables.has(name) && fields.every(field => db.prepare(`PRAGMA table_info(${name})`).all().some(column => column.name === field)));
    if (!ready || db.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v !== 5) throw Object.assign(new Error('readonly_database_not_ready'), { code: 'readonly_database_not_ready' });
    const { inspectAuditSchema } = await import('./local-audit-storage.mjs');
    const { inspectBatchSchema } = await import('./local-batch-storage.mjs');
    if (!inspectAuditSchema(db).ok || !inspectBatchSchema(db).ok) throw Object.assign(new Error('readonly_database_not_ready'), { code: 'readonly_database_not_ready' });
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') throw Object.assign(new Error('readonly_database_wal_required'), { code: 'readonly_database_wal_required' });
  } catch (error) {
    try { db.close(); } catch {}
    if (!['readonly_database_not_ready', 'readonly_database_wal_required'].includes(error.code)) throw Object.assign(new Error('readonly_database_not_ready'), { code: 'readonly_database_not_ready' });
    throw error;
  }
}

if (!READ_ONLY) {
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS account_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  taxpayer_type TEXT NOT NULL DEFAULT '小规模纳税人',
  accounting_standard TEXT NOT NULL DEFAULT '小企业会计准则',
  start_period TEXT NOT NULL,                 -- 'YYYY-MM' 启用期间
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  direction TEXT NOT NULL,
  contra INTEGER NOT NULL DEFAULT 0,
  is_leaf INTEGER NOT NULL DEFAULT 1,
  UNIQUE (account_set_id, code)
);

CREATE TABLE IF NOT EXISTS opening_balances (
  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (account_set_id, code)
);

CREATE TABLE IF NOT EXISTS periods (
  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',        -- open | closed
  PRIMARY KEY (account_set_id, period)
);

CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  voucher_date TEXT NOT NULL,
  word TEXT NOT NULL DEFAULT '记',
  number INTEGER NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'draft',       -- draft | posted
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS voucher_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  code TEXT NOT NULL,
  summary TEXT,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_vouchers_set_period ON vouchers(account_set_id, period, status);
CREATE INDEX IF NOT EXISTS idx_entries_voucher ON voucher_entries(voucher_id);
CREATE INDEX IF NOT EXISTS idx_entries_code ON voucher_entries(code);

-- 固定资产 / 无形资产卡片
CREATE TABLE IF NOT EXISTS asset_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'fixed',            -- fixed | intangible
  name TEXT NOT NULL,
  original_cost REAL NOT NULL,
  residual_rate REAL NOT NULL DEFAULT 0.05,      -- 残值率（无形资产默认 0）
  useful_life_months INTEGER NOT NULL,
  start_period TEXT NOT NULL,                    -- 开始计提期间 'YYYY-MM'
  asset_account TEXT NOT NULL,                   -- 1601 / 1701
  accum_account TEXT NOT NULL,                   -- 1602 / 1702
  expense_account TEXT NOT NULL DEFAULT '5602',  -- 折旧/摊销计入的费用科目
  created_at TEXT NOT NULL
);

-- 已计提记录（防重复计提，并用于累计额）
CREATE TABLE IF NOT EXISTS asset_depreciation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES asset_cards(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  amount REAL NOT NULL,
  voucher_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (account_set_id, asset_id, period)
);
`);

// ---- 轻量迁移：老库补 vouchers.kind ----
const voucherCols = db.prepare(`PRAGMA table_info(vouchers)`).all().map((c) => c.name);
if (!voucherCols.includes("kind")) {
  db.exec(`ALTER TABLE vouchers ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'`);
}

// ---- LOCAL-01 增量导入表 / 版本化迁移 ----
// 先产生一致备份，再把新增结构放进迁移事务（见 import-storage.mjs）；
// 每次真正升级都重新备份，启动时版本已达目标则不备份；迁移失败整体回滚并抛 migration_failed。
}
export const importSchema = READ_ONLY
  ? Object.freeze({ from: 5, to: 5, version: 5, migrated: false, readOnly: true })
  : ensureImportSchema(db, { dataDir: DATA_DIR });

// 模块就绪只等待一次；全部会计与导入导出函数仍保持同步。
if (!READ_ONLY) try {
  const { installAuditSchema } = await import('./local-audit-storage.mjs');
  const { installBatchSchema } = await import('./local-batch-storage.mjs');
  const { randomUUID } = await import('node:crypto');
  await installAuditSchema(db,{dbPath:DB_FILE,outDir:join(DATA_DIR,`audit-install-${randomUUID()}`)});
  await installBatchSchema(db,{dbPath:DB_FILE,outDir:join(DATA_DIR,`batch-${randomUUID()}`)});
} catch(error) { try { db.close(); } catch {} throw error; }
