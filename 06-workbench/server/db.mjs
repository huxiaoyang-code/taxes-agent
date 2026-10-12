// db.mjs — SQLite 存储（node:sqlite，零依赖）
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.WORKBENCH_DATA_DIR || join(__dirname, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, "workbench.db"));

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
