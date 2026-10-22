// local-backup.mjs — LOCAL-06 独立子包：运行中 SQLite 一致性快照 + 可验证备份清单 + 恢复到全新独立目标。
//
// 设计约束（实施契约，改动需同步 docs/LOCAL-BACKUP.md）：
// 1) **无模块级副作用**：不 import db.mjs，不在导入时打开任何数据库、不读默认数据目录、不创建目录。
//    所有函数只处理调用方**显式传入**的路径（源库文件 / 新备份目录 / 新恢复目标目录）。
// 2) 快照在**真正只读**的连接（`readOnly: true`）上用 `VACUUM INTO` 生成：单文件一致快照，
//    包含 WAL 中已提交（未 checkpoint）的数据，不包含其它连接尚未提交的事务。
//    只读连接不会 checkpoint、不会删 `-wal`、不会写源主库；`-shm` 可能因 SQLite 读锁 / 读标记
//    协调而发生变化，那是锁协调而不是业务数据变化（见文档 §2）。
//    禁止直接复制主库文件、忽略 `-wal`，或用可写连接打开源库。
//    与 import-storage.mjs 的迁移前备份契约一致（同样是 VACUUM INTO + 独立只读连接验完整性），
//    但**不复用**「文件大小非 0 就当可用快照」的判定：这里始终重新生成并重新验证。
// 3) 结构版本只支持**当前真实结构**：`TABLE_STRUCTURE` 逐表校验列 / 类型 / NOT NULL /
//    主键 / UNIQUE / 外键，并校验 `schema_migrations` 记录连续且与版本一致、`schema_backups`
//    记录存在。外键按**真实外键分组**（多列外键整体比较，不只比目标列）与期望外键**一对一**比对
//    `ON DELETE` / `ON UPDATE` / `MATCH` 动作（同一列组对同一目标重复声明也一样逐组验动作并拒绝
//    `foreign_key_duplicate`，绝不用「按目标键建 Map」静默覆盖）：只改动作的伪结构
//    （例如把 `ON DELETE CASCADE` 改成 `NO ACTION`）会伪装成兼容结构，
//    恢复后真实删除账套才失败，必须拒绝。
//    缺表 / 缺列 / 缺关键约束 / 动作不符 / 重复或未声明的外键 / 伪造或矛盾迁移记录一律拒绝；
//    旧版本库（< 当前支持版本）给 `schema_outdated`，未来版本给 `schema_unsupported`，
//    都要求先由产品真实入口升级 / 换新版工具，本模块**不**替候选库初始化或迁移。
//    未来 schema v4（LOCAL-02）合并后必须按真实契约重验并扩展本表，不得只靠「表是动态算的」放行。
// 4) 清单（manifest.json）绑定产品 / 格式 / 格式版本 / 应用版本（信息性）/ 结构版本与迁移记录 /
//    表清单 / 每表行数与内容摘要 / 快照字节数、sha256、页大小、journal mode。
//    验证端只信**自己重新计算**的结果：不按清单自报的路径取文件，不信清单自报的版本 / 页大小 /
//    journal mode / user_version / 行数与摘要，逐项与真实快照比对。
// 5) 恢复只写**全新目录**：目标已存在（含空目录、文件、符号链接）一律拒绝且内容完全不动。
//    发布顺序是「partial 临时文件 → fsync → 原子 rename → 再验证已发布文件」，
//    失败或中断只会留下 `.restore-incomplete` 标记 / partial 残留，不会出现被当成成功的 workbench.db。
//    「目标在备份目录内」的判定用**真实路径**（realpath）比较两侧，父目录 junction 别名不能绕过。
// 6) 不执行备份文件里的 SQL、不对候选库做初始化或迁移：只以 `readOnly` 打开并执行固定 PRAGMA / SELECT，
//    因此不会「修好」不合格的库来让验证通过。
// 7) 错误一律返回稳定 code，不回显账务原文、原始 SQL、堆栈或绝对路径；明细只含字段名、计数、
//    表名 / 列名、版本号与固定的 reason 标记。

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { IMPORT_SCHEMA_VERSION, schemaVersion } from "./import-storage.mjs";

/** 备份清单格式标识；格式不匹配一律拒绝恢复。 */
export const BACKUP_FORMAT = "youshu-workbench-local-backup";
/** 清单格式版本；未来升级格式必须递增，旧代码遇到更高的版本必须拒绝。 */
export const BACKUP_FORMAT_VERSION = 1;
/** 产品标识，用来拒绝「非本产品库 / 别人的备份」。 */
export const PRODUCT_ID = "youshu-workbench";

/** 备份目录内的固定文件名（验证端不按清单里的路径找文件）。 */
export const SNAPSHOT_FILE = "workbench.db.snapshot";
export const MANIFEST_FILE = "manifest.json";
/** 恢复目标内的数据库文件名（当前产品数据目录布局：<dir>/workbench.db）。 */
export const TARGET_DATABASE_FILE = "workbench.db";
/** 恢复回执（不含任何绝对路径，可随目标目录一起备份 / 汇报）。 */
export const RESTORE_RECEIPT_FILE = "restore.json";

/** 未完成标记：备份目录内表示「生成中 / 中断」，恢复目标内表示「发布中 / 中断」。 */
export const BACKUP_INCOMPLETE_MARKER = ".local-backup-incomplete";
export const RESTORE_INCOMPLETE_MARKER = ".restore-incomplete";
/** 临时文件前缀；任何 `.partial-*` 残留都视为未完成。 */
export const PARTIAL_PREFIX = ".partial-";

/**
 * 本模块**已按真实结构验证**的 schema 版本（当前产品只有 v3）。
 * 校验内容：核心会计表 + 导入表 + 迁移 / 备份记录表的列、类型、NOT NULL、主键、UNIQUE、外键，
 * 以及 schema_migrations 记录连续性与 schema_backups 记录存在性。
 *
 * 未来 schema v4（LOCAL-02 #47）合并后必须：先按新真实结构扩展本表并重跑本套件，
 * 再提升该值。**不允许**仅因为表清单是动态计算的就把 v4 当成已支持。
 */
export const SUPPORTED_SCHEMA_VERSION = 3;

/** 核心会计表（本产品业务数据；缺任何一个都不是本产品库）。 */
const CORE_ACCOUNTING_TABLES = Object.freeze([
  "account_sets",
  "accounts",
  "opening_balances",
  "periods",
  "vouchers",
  "voucher_entries",
  "asset_cards",
  "asset_depreciation_runs",
]);

/** 导入 / 版本化迁移表（LOCAL-01 schema v3 的真实结构）。 */
const IMPORT_SCHEMA_TABLES = Object.freeze([
  "schema_migrations",
  "schema_backups",
  "import_enterprise_account_sets",
  "import_source_bindings",
  "import_batches",
  "import_voucher_sources",
  "import_batch_vouchers",
]);

/**
 * 当前真实结构规范（schema v3）：逐表列名 / 声明类型 / NOT NULL、主键列顺序、
 * UNIQUE 约束列组、外键（本表列 -> 目标表(目标列)，动作见 `REAL_FOREIGN_KEY_ACTIONS`）。
 * 列规范写成 `"<TYPE>"` 或 `"<TYPE> NOT NULL"`；`INTEGER PRIMARY KEY` 在 SQLite 里
 * `PRAGMA table_info` 的 notnull 为 0，因此这类主键列按 `"INTEGER"` 声明。
 */
const TABLE_STRUCTURE = Object.freeze({
  // ---------------- 核心会计表（db.mjs） ----------------
  account_sets: {
    columns: {
      id: "INTEGER",
      name: "TEXT NOT NULL",
      taxpayer_type: "TEXT NOT NULL",
      accounting_standard: "TEXT NOT NULL",
      start_period: "TEXT NOT NULL",
      created_at: "TEXT NOT NULL",
    },
    primaryKey: ["id"],
    unique: [],
    foreignKeys: [],
  },
  accounts: {
    columns: {
      id: "INTEGER",
      account_set_id: "INTEGER NOT NULL",
      code: "TEXT NOT NULL",
      name: "TEXT NOT NULL",
      category: "TEXT NOT NULL",
      direction: "TEXT NOT NULL",
      contra: "INTEGER NOT NULL",
      is_leaf: "INTEGER NOT NULL",
    },
    primaryKey: ["id"],
    unique: [["account_set_id", "code"]],
    foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
  },
  opening_balances: {
    columns: {
      account_set_id: "INTEGER NOT NULL",
      code: "TEXT NOT NULL",
      debit: "REAL NOT NULL",
      credit: "REAL NOT NULL",
    },
    primaryKey: ["account_set_id", "code"],
    unique: [],
    foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
  },
  periods: {
    columns: {
      account_set_id: "INTEGER NOT NULL",
      period: "TEXT NOT NULL",
      status: "TEXT NOT NULL",
    },
    primaryKey: ["account_set_id", "period"],
    unique: [],
    foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
  },
  vouchers: {
    columns: {
      id: "INTEGER",
      account_set_id: "INTEGER NOT NULL",
      period: "TEXT NOT NULL",
      voucher_date: "TEXT NOT NULL",
      word: "TEXT NOT NULL",
      number: "INTEGER NOT NULL",
      summary: "TEXT",
      status: "TEXT NOT NULL",
      created_at: "TEXT NOT NULL",
      kind: "TEXT NOT NULL",
    },
    primaryKey: ["id"],
    unique: [],
    foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
  },
  voucher_entries: {
    columns: {
      id: "INTEGER",
      voucher_id: "INTEGER NOT NULL",
      line_no: "INTEGER NOT NULL",
      code: "TEXT NOT NULL",
      summary: "TEXT",
      debit: "REAL NOT NULL",
      credit: "REAL NOT NULL",
    },
    primaryKey: ["id"],
    unique: [],
    foreignKeys: [{ from: ["voucher_id"], table: "vouchers", to: ["id"] }],
  },
  asset_cards: {
    columns: {
      id: "INTEGER",
      account_set_id: "INTEGER NOT NULL",
      kind: "TEXT NOT NULL",
      name: "TEXT NOT NULL",
      original_cost: "REAL NOT NULL",
      residual_rate: "REAL NOT NULL",
      useful_life_months: "INTEGER NOT NULL",
      start_period: "TEXT NOT NULL",
      asset_account: "TEXT NOT NULL",
      accum_account: "TEXT NOT NULL",
      expense_account: "TEXT NOT NULL",
      created_at: "TEXT NOT NULL",
    },
    primaryKey: ["id"],
    unique: [],
    foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
  },
  asset_depreciation_runs: {
    columns: {
      id: "INTEGER",
      account_set_id: "INTEGER NOT NULL",
      asset_id: "INTEGER NOT NULL",
      period: "TEXT NOT NULL",
      amount: "REAL NOT NULL",
      voucher_id: "INTEGER",
      created_at: "TEXT NOT NULL",
    },
    primaryKey: ["id"],
    unique: [["account_set_id", "asset_id", "period"]],
    foreignKeys: [
      { from: ["account_set_id"], table: "account_sets", to: ["id"] },
      { from: ["asset_id"], table: "asset_cards", to: ["id"] },
    ],
  },

  // ---------------- 迁移 / 备份记录（import-storage.mjs） ----------------
  schema_migrations: {
    columns: { version: "INTEGER", applied_at: "TEXT NOT NULL", note: "TEXT" },
    primaryKey: ["version"],
    unique: [],
    foreignKeys: [],
  },
  schema_backups: {
    columns: {
      id: "INTEGER",
      version: "INTEGER NOT NULL",
      path: "TEXT NOT NULL",
      created_at: "TEXT NOT NULL",
      bytes: "INTEGER",
      integrity: "TEXT NOT NULL",
      note: "TEXT",
    },
    primaryKey: ["id"],
    unique: [],
    foreignKeys: [],
  },

  // ---------------- 导入表（schema v3） ----------------
  import_enterprise_account_sets: {
    columns: {
      enterprise_key: "TEXT",
      enterprise_name: "TEXT NOT NULL",
      account_set_id: "INTEGER NOT NULL",
      bound_at: "TEXT NOT NULL",
      bound_by: "TEXT NOT NULL",
    },
    primaryKey: ["enterprise_key"],
    unique: [["account_set_id"]],
    foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
  },
  import_source_bindings: {
    columns: {
      id: "INTEGER",
      source_system: "TEXT NOT NULL",
      enterprise_key: "TEXT NOT NULL",
      enterprise_name: "TEXT NOT NULL",
      bound_at: "TEXT NOT NULL",
      bound_by: "TEXT NOT NULL",
    },
    primaryKey: ["id"],
    unique: [["source_system", "enterprise_key"]],
    foreignKeys: [{
      from: ["enterprise_key"], table: "import_enterprise_account_sets", to: ["enterprise_key"],
    }],
  },
  import_batches: {
    columns: {
      batch_id: "TEXT",
      source_system: "TEXT NOT NULL",
      enterprise_key: "TEXT NOT NULL",
      mode: "TEXT NOT NULL",
      account_set_id: "INTEGER",
      content_fingerprint: "TEXT NOT NULL",
      status: "TEXT NOT NULL",
      attempts: "INTEGER NOT NULL",
      created_at: "TEXT NOT NULL",
      updated_at: "TEXT NOT NULL",
      result_json: "TEXT NOT NULL",
      error_code: "TEXT",
      error_message: "TEXT",
    },
    primaryKey: ["batch_id"],
    unique: [],
    foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
  },
  import_voucher_sources: {
    columns: {
      id: "INTEGER",
      source_system: "TEXT NOT NULL",
      enterprise_key: "TEXT NOT NULL",
      source_voucher_id: "TEXT NOT NULL",
      account_set_id: "INTEGER NOT NULL",
      voucher_id: "INTEGER NOT NULL",
      voucher_fingerprint: "TEXT NOT NULL",
      content_fingerprint: "TEXT NOT NULL",
      batch_id: "TEXT NOT NULL",
      created_at: "TEXT NOT NULL",
    },
    primaryKey: ["id"],
    unique: [["source_system", "enterprise_key", "source_voucher_id"]],
    foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
  },
  import_batch_vouchers: {
    columns: {
      id: "INTEGER",
      batch_id: "TEXT NOT NULL",
      source_system: "TEXT NOT NULL",
      enterprise_key: "TEXT NOT NULL",
      source_voucher_id: "TEXT NOT NULL",
      account_set_id: "INTEGER NOT NULL",
      voucher_id: "INTEGER NOT NULL",
      content_fingerprint: "TEXT NOT NULL",
      action: "TEXT NOT NULL",
      created_at: "TEXT NOT NULL",
    },
    primaryKey: ["id"],
    unique: [["batch_id", "source_voucher_id"]],
    foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
  },
});

const REQUIRED_TABLES = Object.freeze([
  ...CORE_ACCOUNTING_TABLES,
  ...IMPORT_SCHEMA_TABLES,
]);

/** SQLite 可能出现的 journal mode（清单里只做规范范围校验）。 */
const JOURNAL_MODES = Object.freeze(["delete", "truncate", "persist", "memory", "wal", "off"]);

/** SQLite WAL 的附属文件；这些文件出现在备份 / 目标目录即意味着快照不独立。 */
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];

const BUSY_TIMEOUT_MS = 5000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_DETAIL_ITEMS = 5;
const HASH_CHUNK = 1024 * 1024;

// ------------------------------------------------------------------ 结果 / 错误
const okResult = (fields = {}) => ({ ok: true, status: "ok", code: null, details: null, ...fields });
const rejected = (code, details = null, fields = {}) =>
  ({ ok: false, status: "rejected", code, details: details ?? null, ...fields });
const internalFailure = () => ({ ok: false, status: "failed", code: "internal_error", details: null });

/** 领域内可预期失败：携带稳定 code，绝不把 SQLite message / 堆栈带给调用方。 */
function expected(code, details = null) {
  const error = new Error(code);
  error.expected = true;
  error.code = code;
  error.details = details ?? null;
  return error;
}

const asFailure = (error, fallbackCode = "internal_error") => {
  if (error && error.expected) return rejected(error.code, error.details);
  return internalFailure();
};

/** 源库入口专用的失败折叠：把 SQLite errcode 映射成稳定 code，其它一律 internal_error。 */
const asSourceFailure = (error) => {
  if (error && error.expected) return rejected(error.code, error.details);
  const code = sqliteCode(error, {
    busy: "source_busy",
    unreadable: "source_not_database",
    readonly: "source_readonly_blocked",
  });
  return code ? rejected(code) : internalFailure();
};

// ------------------------------------------------------------------ 路径工具
const isSamePath = (a, b) => (process.platform === "win32"
  ? String(a).toLowerCase() === String(b).toLowerCase()
  : String(a) === String(b));

const sidecarsOf = (filePath) => SIDECAR_SUFFIXES.map((suffix) => `${filePath}${suffix}`);

const lstatOrNull = (filePath) => {
  try { return fs.lstatSync(filePath); } catch { return null; }
};

const realpathOrNull = (filePath) => {
  try { return fs.realpathSync(filePath); } catch { return null; }
};

const digestFile = (filePath) => {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK);
    let bytes = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      bytes += read;
      hash.update(buffer.subarray(0, read));
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    fs.closeSync(fd);
  }
};

const sha256Text = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const isSha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const randomTag = () => randomBytes(6).toString("hex");

/**
 * 解析「将被创建」的新目录。规则：
 * - 输入必须是非空字符串，且最后一节不是 `.` / `..`；
 * - 父目录必须存在且是真实目录（不递归建父目录，避免误建到意外位置）；
 * - 目标本身不得已存在：符号链接 / 目录 / 文件一律拒绝，绝不覆盖；
 * - 目标路径一律按**父目录真实路径**拼装，避免经符号链接 / junction 写到别名位置。
 */
function prepareNewDirectory(input, kind, publishedName = null) {
  if (typeof input !== "string" || !input.trim()) return { error: `${kind}_required` };
  const resolved = resolve(input);
  const leaf = basename(resolved);
  if (!leaf || leaf === "." || leaf === "..") return { error: `${kind}_invalid` };
  let parentReal;
  try {
    parentReal = fs.realpathSync(dirname(resolved));
    if (!fs.statSync(parentReal).isDirectory()) return { error: `${kind}_parent_missing` };
  } catch {
    return { error: `${kind}_parent_missing` };
  }
  const full = join(parentReal, leaf);
  const existing = lstatOrNull(full);
  if (existing) {
    if (existing.isSymbolicLink()) return { error: `${kind}_alias` };
    if (existing.isDirectory() && publishedName) {
      // 只有未完成标记 / 临时文件、且没有已发布成果的目录：给出可操作的「未完成」而不是笼统的「已存在」。
      let entries = [];
      try { entries = fs.readdirSync(full); } catch { entries = []; }
      const incomplete = entries.some((name) => name === BACKUP_INCOMPLETE_MARKER
        || name === RESTORE_INCOMPLETE_MARKER
        || name.startsWith(PARTIAL_PREFIX));
      if (incomplete && !entries.includes(publishedName)) return { error: `${kind}_incomplete` };
    }
    return { error: `${kind}_exists` };
  }
  return { path: full, parent: parentReal };
}

/**
 * 源库路径规则：
 * - 必须存在且是普通文件；
 * - 不得是符号链接、硬链接别名（nlink>1）或经符号链接 / junction 的路径（realpath≠resolve），
 *   否则备份来源不可追溯；不得指向 `-wal` / `-shm` / `-journal` 附属文件；
 * - 0 字节文件直接拒绝（不是可用 SQLite 库）。
 */
function examineDatabasePath(input) {
  if (typeof input !== "string" || !input.trim()) return { error: "db_path_required" };
  const resolved = resolve(input);
  const leaf = basename(resolved);
  if (!leaf) return { error: "source_missing" };
  if (SIDECAR_SUFFIXES.some((suffix) => leaf.toLowerCase().endsWith(suffix))) return { error: "source_sidecar" };
  const lst = lstatOrNull(resolved);
  if (!lst) return { error: "source_missing" };
  if (lst.isSymbolicLink()) return { error: "source_alias" };
  if (!lst.isFile()) return { error: "source_not_file" };
  let real;
  try { real = fs.realpathSync(resolved); } catch { return { error: "source_missing" }; }
  if (!isSamePath(real, resolved)) return { error: "source_alias" };
  let stat;
  try { stat = fs.statSync(resolved); } catch { return { error: "source_missing" }; }
  if (stat.nlink > 1) return { error: "source_alias" };
  if (stat.size === 0) return { error: "source_empty" };
  return { path: resolved, bytes: stat.size };
}

/** 计划写入的目标文件不得与源库自身或其附属文件是同一路径。 */
function conflictsWithSource(plannedFiles, sourcePath) {
  const banned = [sourcePath, ...sidecarsOf(sourcePath)];
  return plannedFiles.some((planned) => banned.some((item) => isSamePath(item, planned)));
}

const isInside = (child, parent) => {
  const normalize = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const c = normalize(resolve(child));
  const p = normalize(resolve(parent));
  if (c === p) return true;
  return c.startsWith(p.endsWith("\\") || p.endsWith("/") ? p : `${p}${process.platform === "win32" ? "\\" : "/"}`);
};

/** 只清理本次调用自己创建的条目；目录仅在已空时删除。 */
function removeCreated(directory, names, { removeDirectory }) {
  for (const name of names) {
    try { fs.rmSync(join(directory, name), { force: true, recursive: true }); } catch { /* 尽力清理 */ }
  }
  if (!removeDirectory) return { directoryRemoved: false };
  try { fs.rmdirSync(directory); return { directoryRemoved: true }; } catch { return { directoryRemoved: false }; }
}

/** 从「本次已创建条目」清单里移除一项（发布 rename 成功后调用）。 */
function forgetCreated(created, name) {
  const index = created.indexOf(name);
  if (index >= 0) created.splice(index, 1);
}

// ------------------------------------------------------------------ 耐久性（fsync）
/** 对已写入的文件内容执行 fsync；失败一律以稳定 code 拒绝（绝不当成已耐久）。 */
function syncFile(filePath, code) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r+");
    fs.fsyncSync(fd);
  } catch {
    throw expected(code);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 写文件 + fsync（`wx` 独占，绝不覆盖既有文件）。 */
function writeSyncedFile(filePath, text, code) {
  let fd;
  try {
    fd = fs.openSync(filePath, "wx");
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } catch {
    throw expected(code);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * 目录项耐久性：POSIX 下 fsync 目录，Windows 无法对目录 fsync（如实返回 unsupported）。
 * 结果只用于如实汇报边界，不把不支持平台说成已耐久。
 */
function syncDirectory(directory) {
  if (process.platform === "win32") return { supported: false, synced: false };
  let fd;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
    return { supported: true, synced: true };
  } catch {
    return { supported: true, synced: false };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

const durabilityReport = (directoryState) => ({
  fileContentsSynced: true,
  directoryEntrySynced: directoryState.synced === true,
  directoryEntrySyncSupported: directoryState.supported === true,
});

// ------------------------------------------------------------------ 数据库事实
const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

const readAppVersion = (() => {
  let cached;
  return () => {
    if (cached !== undefined) return cached;
    try {
      const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      cached = typeof pkg?.version === "string" && pkg.version ? pkg.version : "unknown";
    } catch {
      cached = "unknown";
    }
    return cached;
  };
})();

/** 把 SQLite errcode 映射成稳定 code；其它返回 null。 */
function sqliteCode(error, { busy, unreadable, readonly }) {
  const errcode = Number(error?.errcode ?? 0);
  const primary = errcode & 0xff;
  if (primary === 5 || primary === 6) return busy;
  if (primary === 11 || primary === 26) return unreadable;
  // 8 = SQLITE_READONLY（含 264 READONLY_RECOVERY）：只读打开需要写 -shm / 恢复 WAL 索引，
  // 本模块不会为了备份去写源库；此时要求操作者先用产品真实入口打开一次再备份。
  if (primary === 8) return readonly;
  return null;
}

function openDatabase(filePath, { readOnly }) {
  try {
    const conn = new DatabaseSync(filePath, { readOnly, timeout: BUSY_TIMEOUT_MS });
    conn.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return conn;
  } catch (error) {
    const code = sqliteCode(error, {
      busy: "source_busy",
      unreadable: "source_not_database",
      readonly: "source_readonly_blocked",
    });
    throw expected(code ?? "source_unreadable");
  }
}

const pragmaRows = (conn, sql) => conn.prepare(sql).all().map((row) => Object.values(row)[0]);

function integrityState(conn) {
  const values = pragmaRows(conn, "PRAGMA integrity_check").map((value) => String(value));
  if (values.length === 0) return { ok: false, reason: "empty" };
  const unexpected = values.filter((value) => value.toLowerCase() !== "ok");
  return unexpected.length ? { ok: false, reason: "not_ok", count: unexpected.length } : { ok: true };
}

function foreignKeyState(conn) {
  const rows = conn.prepare("PRAGMA foreign_key_check").all();
  if (!rows.length) return { ok: true };
  const tables = [...new Set(rows.map((row) => String(row.table ?? "unknown")))].sort().slice(0, MAX_DETAIL_ITEMS);
  return { ok: false, count: rows.length, tables };
}

function tableNames(conn) {
  return conn
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

/** 单行规范序列化：键排序、BLOB 转 base64、BigInt 显式标注，保证同一库重复计算结果稳定。 */
function canonicalRow(row) {
  const parts = [];
  for (const key of Object.keys(row).sort()) {
    const value = row[key];
    if (typeof value === "bigint") parts.push([key, `bigint:${value}`]);
    else if (value instanceof Uint8Array) parts.push([key, `blob:${Buffer.from(value).toString("base64")}`]);
    else parts.push([key, value]);
  }
  return JSON.stringify(parts);
}

function tableFacts(conn, table) {
  const ident = quoteIdent(table);
  const rows = Number(conn.prepare(`SELECT COUNT(*) AS n FROM ${ident}`).get().n);
  const hash = createHash("sha256");
  let ordered = true;
  let statement;
  try {
    statement = conn.prepare(`SELECT * FROM ${ident} ORDER BY rowid`);
  } catch {
    ordered = false;
    statement = conn.prepare(`SELECT * FROM ${ident}`);
  }
  const collected = [];
  for (const row of statement.all()) {
    const text = canonicalRow(row);
    if (ordered) hash.update(`${text}\n`);
    else collected.push(text);
  }
  if (!ordered) {
    collected.sort();
    for (const text of collected) hash.update(`${text}\n`);
  }
  return { rows, digest: hash.digest("hex") };
}

function describeContent(conn, tables) {
  const tableMap = {};
  for (const table of tables) tableMap[table] = tableFacts(conn, table);
  const digest = sha256Text(tables.map((table) => `${table}|${tableMap[table].rows}|${tableMap[table].digest}`).join("\n"));
  return { digest, tables: tableMap };
}

// ------------------------------------------------------------------ 真实结构校验
const parseColumnSpec = (spec) => {
  const notNull = /\bNOT NULL\b/.test(spec);
  const type = spec.replace(/\s+NOT\s+NULL\s*$/, "").trim();
  return { type, notNull };
};

const uniqueColumnGroups = (conn, table) => {
  const groups = [];
  const indexes = conn.prepare("SELECT * FROM pragma_index_list(?)").all(table);
  for (const index of indexes) {
    if (Number(index.unique) !== 1) continue;
    if (String(index.origin) !== "u") continue; // 只看 UNIQUE 约束（pk 单独校验，普通索引不算）
    if (Number(index.partial) === 1) continue;
    const columns = conn.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(String(index.name))
      .map((row) => String(row.name));
    if (!columns.length || columns.some((name) => !name || name === "null")) continue;
    groups.push(columns.join(","));
  }
  return groups;
};

/**
 * 真实 DDL 的外键动作契约（schema v3）：`db.mjs` / `import-storage.mjs` 里**所有**外键都写作
 * `REFERENCES <表>(<列>) ON DELETE CASCADE`（未声明 `ON UPDATE`，即 SQLite 默认 `NO ACTION`；
 * 匹配语义为默认 `NONE`）。这些动作是业务语义的一部分：改成 `NO ACTION` / `RESTRICT` 会让真实
 * 「删除账套」级联失败，改成 `SET NULL` / `SET DEFAULT` 会改写业务数据，都不是本产品结构。
 * 未来 v4 若出现不同动作的外键，必须在该外键条目上用 `actions` **逐条显式覆盖**，
 * 不得把比较放宽成「任一动作均可」或关闭外键检查。
 */
const REAL_FOREIGN_KEY_ACTIONS = Object.freeze({ onDelete: "CASCADE", onUpdate: "NO ACTION", match: "NONE" });

const foreignKeyActions = (fk) => ({ ...REAL_FOREIGN_KEY_ACTIONS, ...(fk.actions ?? {}) });
const foreignKeyTargetKey = (fk) => `${fk.from.join(",")}->${fk.table}(${fk.to.join(",")})`;

/**
 * 按 `PRAGMA foreign_key_list` 的 `id` 分组，读出每个外键的列组与删除 / 更新 / 匹配动作。
 * 多列外键按 `seq` 顺序聚合，因此比较的是**整个外键契约**，不会只比单个目标列。
 * 返回的是**每一个实际外键分组**（同一列组被声明两次就是两组），调用方必须逐组比对，
 * 不得按目标键折叠成 Map —— 否则后声明的动作会覆盖前一条，把重复外键伪装成兼容结构。
 */
const foreignKeyGroups = (conn, table) => {
  const rows = conn.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(table)
    .sort((a, b) => Number(a.id) - Number(b.id) || Number(a.seq) - Number(b.seq));
  const grouped = new Map();
  for (const fk of rows) {
    const key = String(fk.id);
    if (!grouped.has(key)) {
      grouped.set(key, {
        table: String(fk.table),
        from: [],
        to: [],
        onDelete: String(fk.on_delete ?? "").toUpperCase(),
        onUpdate: String(fk.on_update ?? "").toUpperCase(),
        match: String(fk.match ?? "NONE").toUpperCase(),
      });
    }
    const entry = grouped.get(key);
    entry.from[Number(fk.seq)] = String(fk.from);
    entry.to[Number(fk.seq)] = fk.to === null || fk.to === undefined ? null : String(fk.to);
  }
  return [...grouped.values()];
};

/** 逐表校验列 / 类型 / NOT NULL / 主键 / UNIQUE / 外键；返回问题清单（不含 SQL 与路径）。 */
function structureProblems(conn, tables) {
  const problems = [];
  const missingTables = REQUIRED_TABLES.filter((table) => !tables.includes(table)).sort();
  if (missingTables.length) problems.push({ kind: "missing_tables", tables: missingTables.slice(0, MAX_DETAIL_ITEMS) });
  const unexpected = tables
    .filter((table) => !Object.prototype.hasOwnProperty.call(TABLE_STRUCTURE, table))
    .filter((table) => !table.startsWith("sqlite_"))
    .sort();
  if (unexpected.length) problems.push({ kind: "unexpected_tables", tables: unexpected.slice(0, MAX_DETAIL_ITEMS) });

  for (const [table, spec] of Object.entries(TABLE_STRUCTURE)) {
    if (!tables.includes(table)) continue;
    const columns = conn.prepare("SELECT * FROM pragma_table_info(?)").all(table).map((column) => ({
      name: String(column.name),
      type: String(column.type ?? ""),
      notNull: Number(column.notnull) === 1,
      pk: Number(column.pk),
    }));
    const actualNames = columns.map((column) => column.name);
    const expectedNames = Object.keys(spec.columns);
    const missingColumns = expectedNames.filter((name) => !actualNames.includes(name));
    const unexpectedColumns = actualNames.filter((name) => !expectedNames.includes(name));
    if (missingColumns.length) problems.push({ kind: "missing_columns", table, columns: missingColumns.slice(0, MAX_DETAIL_ITEMS) });
    if (unexpectedColumns.length) {
      problems.push({ kind: "unexpected_columns", table, columns: unexpectedColumns.slice(0, MAX_DETAIL_ITEMS) });
    }
    for (const name of expectedNames) {
      const actual = columns.find((column) => column.name === name);
      if (!actual) continue;
      const want = parseColumnSpec(spec.columns[name]);
      if (actual.type.trim().toUpperCase() !== want.type.toUpperCase()) {
        problems.push({ kind: "column_type", table, column: name, expected: want.type });
      }
      if (actual.notNull !== want.notNull) problems.push({ kind: "column_not_null", table, column: name });
    }
    const actualPk = columns.filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk).map((column) => column.name);
    if (actualPk.join(",") !== spec.primaryKey.join(",")) problems.push({ kind: "primary_key", table });
    const uniqueGroups = uniqueColumnGroups(conn, table);
    for (const wanted of spec.unique) {
      if (!uniqueGroups.includes(wanted.join(","))) problems.push({ kind: "unique", table, columns: wanted });
    }
    // 外键：目标列组 + 动作（ON DELETE / ON UPDATE / MATCH）整体比对。
    // 实际外键分组与期望外键**一对一**匹配：不能按目标键建 Map（会把重复分组覆盖成一条），
    // 因此同一列组指向同一目标却声明了两次时，每个实际分组都要验动作，并显式拒绝重复；
    // 未声明的额外分组同样拒绝。
    const actualForeignKeys = foreignKeyGroups(conn, table);
    const unmatched = actualForeignKeys.map((fk) => ({ fk, used: false }));
    for (const wanted of spec.foreignKeys) {
      const targetKey = foreignKeyTargetKey(wanted);
      const candidates = unmatched.filter((entry) => !entry.used && foreignKeyTargetKey(entry.fk) === targetKey);
      if (!candidates.length) {
        problems.push({ kind: "foreign_key", table, columns: wanted.from, references: wanted.table });
        continue;
      }
      const want = foreignKeyActions(wanted);
      for (const entry of candidates) {
        entry.used = true;
        const actual = entry.fk;
        if (actual.onDelete !== want.onDelete
          || actual.onUpdate !== want.onUpdate
          || actual.match !== want.match) {
          problems.push({
            kind: "foreign_key_actions",
            table,
            columns: wanted.from,
            references: wanted.table,
            expected: `${want.onDelete}/${want.onUpdate}/${want.match}`,
            actual: `${actual.onDelete}/${actual.onUpdate}/${actual.match}`,
          });
        }
      }
      if (candidates.length > 1) {
        problems.push({
          kind: "foreign_key_duplicate",
          table,
          columns: wanted.from,
          references: wanted.table,
          count: candidates.length,
        });
      }
    }
    const unexpectedForeignKeys = unmatched.filter((entry) => !entry.used).map((entry) => entry.fk);
    if (unexpectedForeignKeys.length) {
      problems.push({
        kind: "unexpected_foreign_keys",
        table,
        columns: unexpectedForeignKeys.map((fk) => fk.from.join(",")).slice(0, MAX_DETAIL_ITEMS),
        references: [...new Set(unexpectedForeignKeys.map((fk) => fk.table))].slice(0, MAX_DETAIL_ITEMS),
      });
    }
  }
  return problems;
}

/** 迁移记录必须是从 1 到当前版本连续的整数，且时间可解析（伪造 / 跳跃 / 缺失都拒绝）。 */
function migrationRecordProblems(conn, version) {
  const rows = conn.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all();
  const problems = [];
  const versions = rows.map((row) => Number(row.version));
  if (!versions.length) {
    problems.push({ kind: "migrations_empty" });
    return { problems, versions };
  }
  for (let index = 0; index < versions.length; index += 1) {
    if (versions[index] !== index + 1) {
      problems.push({ kind: "migrations_gap", versions: versions.slice(0, MAX_DETAIL_ITEMS) });
      break;
    }
  }
  if (versions[versions.length - 1] !== version) problems.push({ kind: "migrations_version_conflict", version });
  const badTimestamp = rows.filter((row) => typeof row.applied_at !== "string"
    || !row.applied_at || Number.isNaN(Date.parse(row.applied_at))).length;
  if (badTimestamp) problems.push({ kind: "migrations_timestamp", count: badTimestamp });
  return { problems, versions };
}

/** 迁移前备份记录：真实库每次真正升级都会登记；缺失 / 形状不合法说明库被改过。 */
function backupRecordProblems(conn, version) {
  const rows = conn.prepare("SELECT version, path, created_at, bytes, integrity FROM schema_backups").all();
  if (!rows.length) return [{ kind: "backup_records_empty" }];
  const problems = [];
  const badVersion = rows.filter((row) => {
    const value = Number(row.version);
    return !Number.isInteger(value) || value < 1 || value > version;
  }).length;
  if (badVersion) problems.push({ kind: "backup_records_version", count: badVersion });
  const badPath = rows.filter((row) => typeof row.path !== "string" || !row.path).length;
  if (badPath) problems.push({ kind: "backup_records_path", count: badPath });
  const badTimestamp = rows.filter((row) => typeof row.created_at !== "string"
    || !row.created_at || Number.isNaN(Date.parse(row.created_at))).length;
  if (badTimestamp) problems.push({ kind: "backup_records_timestamp", count: badTimestamp });
  const badIntegrity = rows.filter((row) => typeof row.integrity !== "string" || !row.integrity).length;
  if (badIntegrity) problems.push({ kind: "backup_records_integrity", count: badIntegrity });
  return problems;
}

/**
 * 只读校验一个库是否为本产品**当前支持版本**的真实结构。
 * 顺序：必需表 → 版本（未来 / 旧版本）→ 列 / 约束 → 迁移与备份记录。
 * `notProductCode` 供调用方按入口语义命名（源库 / 快照）。
 */
function inspectStructure(conn, { notProductCode }) {
  const tables = tableNames(conn);
  const missingTables = REQUIRED_TABLES.filter((table) => !tables.includes(table)).sort();
  if (missingTables.length) {
    throw expected(notProductCode, { missingTables: missingTables.slice(0, MAX_DETAIL_ITEMS) });
  }
  const version = Number(schemaVersion(conn));
  if (!Number.isInteger(version) || version < 0) throw expected("schema_unreadable");
  if (version > SUPPORTED_SCHEMA_VERSION) {
    throw expected("schema_unsupported", { found: version, supported: SUPPORTED_SCHEMA_VERSION });
  }
  if (version < SUPPORTED_SCHEMA_VERSION) {
    throw expected("schema_outdated", { found: version, supported: SUPPORTED_SCHEMA_VERSION });
  }
  const migrations = migrationRecordProblems(conn, version);
  const problems = [
    ...structureProblems(conn, tables),
    ...migrations.problems,
    ...backupRecordProblems(conn, version),
  ];
  if (problems.length) throw expected("structure_invalid", { problems: problems.slice(0, MAX_DETAIL_ITEMS) });
  return { version, tables, migrations: migrations.versions };
}

/**
 * 用固定 PRAGMA / SELECT 采集一个 SQLite 库的事实（不改写、不迁移候选库）。
 * 顺序：完整性 → 外键 → 真实结构 / 迁移记录 → 快照物理属性与内容摘要。
 */
function inspectDatabase(conn, { notProductCode = "not_product_database" } = {}) {
  const integrity = integrityState(conn);
  if (!integrity.ok) throw expected("integrity_failed", integrity);
  const foreignKeys = foreignKeyState(conn);
  if (!foreignKeys.ok) throw expected("foreign_key_violation", { rows: foreignKeys.count, tables: foreignKeys.tables });

  const structure = inspectStructure(conn, { notProductCode });
  const journalMode = String(pragmaRows(conn, "PRAGMA journal_mode")[0] ?? "unknown").toLowerCase();
  const pageSize = Number(pragmaRows(conn, "PRAGMA page_size")[0] ?? 0);
  const userVersion = Number(pragmaRows(conn, "PRAGMA user_version")[0] ?? 0);
  const sqliteVersion = String(conn.prepare("SELECT sqlite_version() AS v").get().v ?? "unknown");
  const content = describeContent(conn, structure.tables);
  return {
    structure: {
      schemaVersion: structure.version,
      userVersion,
      sqliteVersion,
      migrations: structure.migrations,
      tables: structure.tables,
    },
    content,
    snapshot: { journalMode, pageSize },
  };
}

function inspectSnapshotFile(filePath) {
  const fileDigest = digestFile(filePath);
  const conn = openDatabase(filePath, { readOnly: true });
  try {
    const facts = inspectDatabase(conn);
    return {
      ...facts,
      snapshot: { file: SNAPSHOT_FILE, bytes: fileDigest.bytes, sha256: fileDigest.sha256, ...facts.snapshot },
    };
  } catch (error) {
    const code = sqliteCode(error, {
      busy: "snapshot_busy",
      unreadable: "snapshot_unreadable",
      readonly: "snapshot_unreadable",
    });
    if (code) throw expected(code);
    throw error;
  } finally {
    try { conn.close(); } catch { /* 只读连接关闭失败不影响结论 */ }
  }
}

// ------------------------------------------------------------------ 清单校验
const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
const isPositiveInteger = (value) => Number.isInteger(value) && value >= 1;
const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const isJournalMode = (value) => typeof value === "string" && JOURNAL_MODES.includes(value.toLowerCase());
const isPageSize = (value) => Number.isInteger(value) && value >= 512 && value <= 65536
  && (value & (value - 1)) === 0;
const sortedUnique = (list) => [...new Set(list)].sort();

/**
 * 校验清单**自身**的字段类型与规范范围（不看快照；与快照的比对在 verifyBackup 里）。
 * 应用版本只校验「存在且是非空字符串」，**不参与兼容判定**（与文档口径一致）：
 * 格式 / 结构版本才是兼容契约。
 */
function validateManifest(manifest) {
  if (!isPlainObject(manifest)) return { code: "manifest_invalid", details: { field: "root" } };
  if (manifest.product !== PRODUCT_ID) return { code: "backup_app_unsupported", details: null };
  if (manifest.format !== BACKUP_FORMAT) return { code: "backup_format_unsupported", details: null };
  if (!Number.isInteger(manifest.formatVersion) || manifest.formatVersion < 1) {
    return { code: "manifest_invalid", details: { field: "formatVersion" } };
  }
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    return { code: "backup_format_unsupported", details: { supported: BACKUP_FORMAT_VERSION } };
  }
  // 应用版本：只作为生成者记录，缺失 / 类型不合法仍拒绝（不伪装成兼容判定）。
  if (!isNonEmptyString(manifest.appVersion)) return { code: "manifest_invalid", details: { field: "appVersion" } };
  if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) {
    return { code: "manifest_invalid", details: { field: "createdAt" } };
  }

  const snapshot = manifest.snapshot;
  if (!isPlainObject(snapshot)) return { code: "manifest_invalid", details: { field: "snapshot" } };
  if (snapshot.file !== SNAPSHOT_FILE) return { code: "manifest_invalid", details: { field: "snapshot.file" } };
  if (!isPositiveInteger(snapshot.bytes)) return { code: "manifest_invalid", details: { field: "snapshot.bytes" } };
  if (!isSha256(snapshot.sha256)) return { code: "manifest_invalid", details: { field: "snapshot.sha256" } };
  if (!isPageSize(snapshot.pageSize)) return { code: "manifest_invalid", details: { field: "snapshot.pageSize" } };
  if (!isJournalMode(snapshot.journalMode)) {
    return { code: "manifest_invalid", details: { field: "snapshot.journalMode" } };
  }

  const structure = manifest.structure;
  if (!isPlainObject(structure)) return { code: "manifest_invalid", details: { field: "structure" } };
  if (!isNonNegativeInteger(structure.schemaVersion)) {
    return { code: "manifest_invalid", details: { field: "structure.schemaVersion" } };
  }
  if (structure.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    return { code: "schema_unsupported", details: { found: structure.schemaVersion, supported: SUPPORTED_SCHEMA_VERSION } };
  }
  if (structure.schemaVersion < SUPPORTED_SCHEMA_VERSION) {
    return { code: "schema_outdated", details: { found: structure.schemaVersion, supported: SUPPORTED_SCHEMA_VERSION } };
  }
  if (!isNonNegativeInteger(structure.userVersion)) {
    return { code: "manifest_invalid", details: { field: "structure.userVersion" } };
  }
  if (!isNonEmptyString(structure.sqliteVersion)) {
    return { code: "manifest_invalid", details: { field: "structure.sqliteVersion" } };
  }
  if (!Array.isArray(structure.tables) || structure.tables.some((name) => !isNonEmptyString(name))) {
    return { code: "manifest_invalid", details: { field: "structure.tables" } };
  }
  if (sortedUnique(structure.tables).length !== structure.tables.length) {
    return { code: "manifest_invalid", details: { field: "structure.tables" } };
  }
  const expectedMigrations = Array.from({ length: structure.schemaVersion }, (_, index) => index + 1);
  if (!Array.isArray(structure.migrations)
    || structure.migrations.some((value) => !Number.isInteger(value))
    || structure.migrations.join(",") !== expectedMigrations.join(",")) {
    return { code: "manifest_invalid", details: { field: "structure.migrations" } };
  }

  const content = manifest.content;
  if (!isPlainObject(content)) return { code: "manifest_invalid", details: { field: "content" } };
  if (!isSha256(content.digest)) return { code: "manifest_invalid", details: { field: "content.digest" } };
  if (!isPlainObject(content.tables)) return { code: "manifest_invalid", details: { field: "content.tables" } };
  const contentTables = Object.keys(content.tables);
  if (contentTables.length !== structure.tables.length
    || sortedUnique(contentTables).join("\u0000") !== sortedUnique(structure.tables).join("\u0000")) {
    return { code: "manifest_invalid", details: { field: "content.tables" } };
  }
  for (const [name, facts] of Object.entries(content.tables)) {
    if (!isNonEmptyString(name) || !isPlainObject(facts)) {
      return { code: "manifest_invalid", details: { field: "content.tables" } };
    }
    if (!isNonNegativeInteger(facts.rows)) return { code: "manifest_invalid", details: { field: "content.tables.rows" } };
    if (!isSha256(facts.digest)) return { code: "manifest_invalid", details: { field: "content.tables.digest" } };
  }

  const source = manifest.source;
  if (!isPlainObject(source)) return { code: "manifest_invalid", details: { field: "source" } };
  if (!isNonEmptyString(source.file)) return { code: "manifest_invalid", details: { field: "source.file" } };
  if (source.file !== basename(source.file)) return { code: "manifest_invalid", details: { field: "source.file" } };
  if (!isPositiveInteger(source.bytes)) return { code: "manifest_invalid", details: { field: "source.bytes" } };
  if (!isNonNegativeInteger(source.schemaVersion)) {
    return { code: "manifest_invalid", details: { field: "source.schemaVersion" } };
  }
  if (source.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    return { code: "schema_unsupported", details: { found: source.schemaVersion, supported: SUPPORTED_SCHEMA_VERSION } };
  }
  if (source.schemaVersion < SUPPORTED_SCHEMA_VERSION) {
    return { code: "schema_outdated", details: { found: source.schemaVersion, supported: SUPPORTED_SCHEMA_VERSION } };
  }
  if (source.schemaVersion !== structure.schemaVersion) {
    return { code: "structure_mismatch", details: { field: "source.schemaVersion" } };
  }
  if (!isJournalMode(source.journalMode)) return { code: "manifest_invalid", details: { field: "source.journalMode" } };
  return null;
}

// ------------------------------------------------------------------ 备份
/**
 * 生成备份（快照 + 清单）到一个**全新的**目录。
 * @returns {{ok:boolean,status:string,code:string|null,backupDir?:string,backupMeta?:object,manifest?:object,details?:object}}
 */
export function createBackup({ dbPath, outDir, now = () => new Date() } = {}) {
  const source = examineDatabasePath(dbPath);
  if (source.error) return rejected(source.error);
  const out = prepareNewDirectory(outDir, "out", SNAPSHOT_FILE);
  if (out.error) return rejected(out.error);

  const planned = [join(out.path, SNAPSHOT_FILE), join(out.path, MANIFEST_FILE), join(out.path, BACKUP_INCOMPLETE_MARKER)];
  if (conflictsWithSource(planned, source.path)) return rejected("path_conflicts_source");

  const created = [];
  let reader;
  try {
    // ---- 1) 真正只读打开源库 + 真实结构 / 迁移记录预检（不写源库、不 checkpoint、不删 WAL）----
    reader = openDatabase(source.path, { readOnly: true });
    const pre = inspectStructure(reader, { notProductCode: "not_product_database" });
    const sourceFacts = {
      file: basename(source.path),
      bytes: source.bytes,
      schemaVersion: pre.version,
      journalMode: String(pragmaRows(reader, "PRAGMA journal_mode")[0] ?? "unknown").toLowerCase(),
    };

    // ---- 2) 原子占位（mkdir 独占）+ 未完成标记（fsync 后落盘）----
    try {
      fs.mkdirSync(out.path);
    } catch (error) {
      if (error?.code === "EEXIST") return rejected("out_exists");
      return rejected("out_uncreatable");
    }
    writeSyncedFile(
      join(out.path, BACKUP_INCOMPLETE_MARKER),
      `${JSON.stringify({ startedAt: now().toISOString(), formatVersion: BACKUP_FORMAT_VERSION })}\n`,
      "write_failed",
    );
    created.push(BACKUP_INCOMPLETE_MARKER);

    // ---- 3) 一致性快照：只读连接 + VACUUM INTO（含已提交 WAL，排除未提交事务）----
    const partialName = `${PARTIAL_PREFIX}${process.pid}-${randomTag()}.db`;
    const partialPath = join(out.path, partialName);
    created.push(partialName);
    try {
      reader.prepare("VACUUM INTO ?").run(partialPath);
    } catch (error) {
      throw expected(sqliteCode(error, {
        busy: "source_busy",
        unreadable: "source_not_database",
        readonly: "source_readonly_blocked",
      }) ?? "snapshot_failed");
    }
    if (!fs.existsSync(partialPath)) throw expected("snapshot_failed");
    reader.close();
    reader = undefined;

    // ---- 4) 快照自检 → fsync → 原子 rename（先验证再发布）----
    const facts = inspectSnapshotFile(partialPath);
    syncFile(partialPath, "snapshot_fsync_failed");
    fs.renameSync(partialPath, join(out.path, SNAPSHOT_FILE));
    forgetCreated(created, partialName);
    created.push(SNAPSHOT_FILE);
    syncDirectory(out.path);

    // ---- 5) 清单：写临时文件 → fsync → 原子 rename ----
    const manifest = {
      product: PRODUCT_ID,
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: readAppVersion(),
      createdAt: now().toISOString(),
      source: sourceFacts,
      snapshot: {
        file: SNAPSHOT_FILE,
        bytes: facts.snapshot.bytes,
        sha256: facts.snapshot.sha256,
        pageSize: facts.snapshot.pageSize,
        journalMode: facts.snapshot.journalMode,
      },
      structure: facts.structure,
      content: facts.content,
    };
    const manifestPartial = `${PARTIAL_PREFIX}${process.pid}-${randomTag()}.json`;
    created.push(manifestPartial);
    writeSyncedFile(join(out.path, manifestPartial), `${JSON.stringify(manifest, null, 2)}\n`, "write_failed");
    fs.renameSync(join(out.path, manifestPartial), join(out.path, MANIFEST_FILE));
    forgetCreated(created, manifestPartial);
    created.push(MANIFEST_FILE);
    syncDirectory(out.path);

    // 完成标记最后移除：中断时残留标记会让后续 verify 明确拒绝。
    fs.rmSync(join(out.path, BACKUP_INCOMPLETE_MARKER), { force: true });
    forgetCreated(created, BACKUP_INCOMPLETE_MARKER);
    const finalDirState = syncDirectory(out.path);

    return okResult({
      backupDir: out.path,
      backupMeta: {
        formatVersion: manifest.formatVersion,
        appVersion: manifest.appVersion,
        createdAt: manifest.createdAt,
        schemaVersion: manifest.structure.schemaVersion,
        migrations: manifest.structure.migrations,
        tables: manifest.structure.tables.length,
        rows: Object.values(manifest.content.tables).reduce((sum, entry) => sum + entry.rows, 0),
        snapshotBytes: manifest.snapshot.bytes,
        snapshotSha256: manifest.snapshot.sha256,
        durability: durabilityReport(finalDirState),
      },
      manifest,
    });
  } catch (error) {
    const cleanup = created.length || fs.existsSync(out.path)
      ? removeCreated(out.path, created, { removeDirectory: true })
      : { directoryRemoved: true };
    const failure = asSourceFailure(error);
    // 源库结构问题统一用入口语义的 code 返回。
    let result = failure;
    if (failure.code === "not_product_database") result = rejected("source_not_product_database", failure.details);
    else if (failure.code === "structure_invalid") result = rejected("source_structure_invalid", failure.details);
    if (result.status === "rejected" && !cleanup.directoryRemoved) {
      result.details = { ...(result.details ?? {}), cleanup: "directory_kept" };
    }
    return result;
  } finally {
    if (reader) { try { reader.close(); } catch { /* 只读连接关闭失败不影响结论 */ } }
  }
}

// ------------------------------------------------------------------ 验证
function readManifest(backupDir) {
  const manifestPath = join(backupDir, MANIFEST_FILE);
  const stat = lstatOrNull(manifestPath);
  if (!stat) return { error: rejected("manifest_missing") };
  if (stat.isSymbolicLink()) return { error: rejected("manifest_invalid", { field: "manifest.link" }) };
  if (!stat.isFile()) return { error: rejected("manifest_missing") };
  if (stat.size > MAX_MANIFEST_BYTES) return { error: rejected("manifest_invalid", { field: "manifest.size" }) };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return { error: rejected("manifest_invalid", { field: "manifest.json" }) };
  }
  const invalid = validateManifest(parsed);
  if (invalid) return { error: rejected(invalid.code, invalid.details) };
  return { manifest: parsed };
}

function incompleteArtifacts(backupDir) {
  let names;
  try { names = fs.readdirSync(backupDir); } catch { return { error: rejected("backup_dir_missing") }; }
  // 未完成标记 / 临时文件：生成中或中断的备份，一律不当作可用备份。
  const leftovers = names.filter((name) =>
    name === BACKUP_INCOMPLETE_MARKER
    || name === RESTORE_INCOMPLETE_MARKER
    || name.startsWith(PARTIAL_PREFIX));
  // 备份目录内若出现快照的 -wal / -shm / -journal，说明快照依赖附属文件，不是单文件一致快照。
  const sidecars = names.filter((name) => SIDECAR_SUFFIXES.some((suffix) => name === `${SNAPSHOT_FILE}${suffix}`));
  return { leftovers: sortedUnique(leftovers), sidecars: sortedUnique(sidecars), names };
}

/**
 * 验证一个备份目录：清单格式 / 应用 / 结构版本、快照单文件性、sha256、SQLite 完整性与外键、
 * 真实结构（列 / 约束 / 迁移记录）、内容摘要，以及页大小 / journal mode / user_version 等
 * **可重算字段**与清单的一致性。
 * @returns {{ok:boolean,status:string,code:string|null,backupDir?:string,manifest?:object,summary?:object,details?:object}}
 */
export function verifyBackup({ backupDir } = {}) {
  if (typeof backupDir !== "string" || !backupDir.trim()) return rejected("backup_dir_required");
  const resolvedDir = resolve(backupDir);
  const dirStat = lstatOrNull(resolvedDir);
  if (!dirStat) return rejected("backup_dir_missing");
  if (!dirStat.isDirectory()) return rejected("backup_dir_missing");

  try {
    const artifacts = incompleteArtifacts(resolvedDir);
    if (artifacts.error) return artifacts.error;
    if (artifacts.leftovers.length || artifacts.sidecars.length) {
      return rejected("backup_incomplete", {
        leftovers: artifacts.leftovers.slice(0, MAX_DETAIL_ITEMS),
        sidecars: artifacts.sidecars.slice(0, MAX_DETAIL_ITEMS),
      });
    }

    const read = readManifest(resolvedDir);
    if (read.error) return read.error;
    const manifest = read.manifest;

    // 只按固定文件名取快照，绝不按清单里的路径取文件（清单不提供路径）。
    const snapshotPath = join(resolvedDir, SNAPSHOT_FILE);
    const snapshotStat = lstatOrNull(snapshotPath);
    if (!snapshotStat) return rejected("snapshot_missing");
    if (snapshotStat.isSymbolicLink()) return rejected("snapshot_symlink");
    if (!snapshotStat.isFile()) return rejected("snapshot_missing");
    const fileDigest = digestFile(snapshotPath);
    if (fileDigest.bytes !== manifest.snapshot.bytes) {
      return rejected("snapshot_size_mismatch", { recorded: manifest.snapshot.bytes, actual: fileDigest.bytes });
    }
    if (fileDigest.sha256 !== manifest.snapshot.sha256) return rejected("snapshot_digest_mismatch");

    let facts;
    try {
      facts = inspectSnapshotFile(snapshotPath);
    } catch (error) {
      const failure = asFailure(error);
      if (failure.code === "not_product_database") return rejected("snapshot_not_product_database", failure.details);
      return failure;
    }

    // ---- 结构绑定：表清单 / 版本 / 迁移记录 / user_version 与真实快照逐项比对 ----
    if (facts.structure.tables.length !== manifest.structure.tables.length
      || sortedUnique(facts.structure.tables).join("\u0000") !== sortedUnique(manifest.structure.tables).join("\u0000")) {
      return rejected("structure_mismatch", { field: "tables" });
    }
    if (facts.structure.schemaVersion !== manifest.structure.schemaVersion
      || facts.structure.schemaVersion !== manifest.source.schemaVersion) {
      return rejected("structure_mismatch", {
        field: "schemaVersion",
        recorded: manifest.structure.schemaVersion,
        actual: facts.structure.schemaVersion,
      });
    }
    if (facts.structure.migrations.join(",") !== manifest.structure.migrations.join(",")) {
      return rejected("structure_mismatch", { field: "migrations" });
    }
    if (facts.structure.userVersion !== manifest.structure.userVersion) {
      return rejected("structure_mismatch", { field: "userVersion" });
    }
    // ---- 可重算的物理属性：不信清单自报 ----
    if (facts.snapshot.pageSize !== manifest.snapshot.pageSize) {
      return rejected("snapshot_metadata_mismatch", {
        field: "pageSize",
        recorded: manifest.snapshot.pageSize,
        actual: facts.snapshot.pageSize,
      });
    }
    if (facts.snapshot.journalMode !== String(manifest.snapshot.journalMode).toLowerCase()) {
      return rejected("snapshot_metadata_mismatch", {
        field: "journalMode",
        recorded: String(manifest.snapshot.journalMode).toLowerCase(),
        actual: facts.snapshot.journalMode,
      });
    }
    // ---- 内容绑定：总摘要 + 每表行数 / 摘要 ----
    if (facts.content.digest !== manifest.content.digest) return rejected("content_mismatch", { field: "digest" });
    for (const table of facts.structure.tables) {
      const recorded = manifest.content.tables[table];
      const actual = facts.content.tables[table];
      if (!recorded || recorded.rows !== actual.rows || recorded.digest !== actual.digest) {
        return rejected("content_mismatch", { field: "table", table });
      }
    }

    return okResult({
      backupDir: resolvedDir,
      manifest,
      summary: {
        formatVersion: manifest.formatVersion,
        appVersion: manifest.appVersion,
        createdAt: manifest.createdAt,
        schemaVersion: manifest.structure.schemaVersion,
        migrations: manifest.structure.migrations,
        tables: manifest.structure.tables.length,
        rows: Object.values(manifest.content.tables).reduce((sum, entry) => sum + entry.rows, 0),
        snapshotBytes: manifest.snapshot.bytes,
        snapshotSha256: manifest.snapshot.sha256,
      },
    });
  } catch (error) {
    return asFailure(error);
  }
}

// ------------------------------------------------------------------ 恢复到全新目标
/**
 * 把已验证的备份恢复到一个**全新目录**（恢复后目录内是 `<target>/workbench.db`）。
 * 已存在的目标（空目录也算）默认拒绝且不写入任何内容；先验证再发布；失败 / 中断不留半套数据。
 */
export function restoreNew({ backupDir, targetDir, now = () => new Date() } = {}) {
  const verified = verifyBackup({ backupDir });
  if (!verified.ok) return { ...verified, stage: "verify" };
  const manifest = verified.manifest;
  const sourceBackupDir = verified.backupDir;
  // 备份目录本身可能就是别名（例如父目录 junction）：用真实路径做「目标是否落在备份内」判定。
  const backupReal = realpathOrNull(sourceBackupDir) ?? sourceBackupDir;

  const target = prepareNewDirectory(targetDir, "target", TARGET_DATABASE_FILE);
  if (target.error) return rejected(target.error, null, { stage: "target" });
  if (isInside(target.path, backupReal)
    || isInside(target.path, sourceBackupDir)
    || isInside(backupReal, target.path)) {
    return rejected("target_conflicts_backup", null, { stage: "target" });
  }

  const databasePath = join(target.path, TARGET_DATABASE_FILE);
  const receiptPath = join(target.path, RESTORE_RECEIPT_FILE);
  const manifestCopyPath = join(target.path, MANIFEST_FILE);
  if (conflictsWithSource([databasePath, receiptPath, manifestCopyPath], join(backupReal, SNAPSHOT_FILE))) {
    // 极端别名布局（例如目标目录与备份目录是同一真实目录的别名）——拒绝，不冒险覆盖。
    return rejected("target_conflicts_backup", null, { stage: "target" });
  }

  try {
    fs.mkdirSync(target.path);
  } catch (error) {
    if (error?.code === "EEXIST") return rejected("target_exists", null, { stage: "target" });
    return rejected("target_uncreatable", null, { stage: "target" });
  }

  const created = [];
  try {
    writeSyncedFile(
      join(target.path, RESTORE_INCOMPLETE_MARKER),
      `${JSON.stringify({ startedAt: now().toISOString(), snapshotSha256: manifest.snapshot.sha256 })}\n`,
      "write_failed",
    );
    created.push(RESTORE_INCOMPLETE_MARKER);

    // ---- 1) 复制（复制后重新计算摘要，防止验证与复制之间快照被替换）----
    const partialName = `${PARTIAL_PREFIX}${process.pid}-${randomTag()}.db`;
    const partialPath = join(target.path, partialName);
    created.push(partialName);
    try {
      fs.copyFileSync(join(sourceBackupDir, SNAPSHOT_FILE), partialPath);
    } catch (error) {
      throw expected(error?.code === "ENOSPC" ? "target_no_space" : "restore_copy_failed");
    }
    const copied = digestFile(partialPath);
    if (copied.bytes !== manifest.snapshot.bytes) {
      throw expected("snapshot_size_mismatch", { recorded: manifest.snapshot.bytes, actual: copied.bytes });
    }
    if (copied.sha256 !== manifest.snapshot.sha256) throw expected("snapshot_digest_mismatch");

    // ---- 2) 落盘耐久：fsync 后再原子发布 ----
    syncFile(partialPath, "restore_fsync_failed");
    try {
      fs.renameSync(partialPath, databasePath);
    } catch {
      throw expected("restore_publish_failed");
    }
    forgetCreated(created, partialName);
    created.push(TARGET_DATABASE_FILE);
    syncDirectory(target.path);

    // ---- 3) 发布后再验证一次已发布文件（内容 + 结构 + 摘要），失败即撤回 ----
    let published;
    try {
      published = inspectSnapshotFile(databasePath);
    } catch {
      throw expected("restore_verify_failed");
    }
    if (published.snapshot.bytes !== manifest.snapshot.bytes
      || published.snapshot.sha256 !== manifest.snapshot.sha256
      || published.content.digest !== manifest.content.digest
      || published.structure.schemaVersion !== manifest.structure.schemaVersion
      || published.structure.migrations.join(",") !== manifest.structure.migrations.join(",")) {
      throw expected("restore_verify_failed");
    }
    const strayRestore = SIDECAR_SUFFIXES.map((suffix) => `${databasePath}${suffix}`).filter((file) => lstatOrNull(file));
    if (strayRestore.length) throw expected("restore_verify_failed", { sidecars: strayRestore.length });

    // ---- 4) 回执与清单副本（只含仓库相对 / 文件名信息，不写本机绝对路径）----
    const receipt = {
      product: PRODUCT_ID,
      format: BACKUP_FORMAT,
      formatVersion: manifest.formatVersion,
      restoredAt: now().toISOString(),
      verified: true,
      database: TARGET_DATABASE_FILE,
      sourceDatabase: manifest.source.file,
      snapshot: {
        file: SNAPSHOT_FILE,
        bytes: manifest.snapshot.bytes,
        sha256: manifest.snapshot.sha256,
      },
      structure: {
        schemaVersion: manifest.structure.schemaVersion,
        migrations: manifest.structure.migrations,
        tables: manifest.structure.tables,
      },
    };
    created.push(MANIFEST_FILE);
    writeSyncedFile(manifestCopyPath, `${JSON.stringify(manifest, null, 2)}\n`, "write_failed");
    created.push(RESTORE_RECEIPT_FILE);
    writeSyncedFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "write_failed");
    syncDirectory(target.path);

    fs.rmSync(join(target.path, RESTORE_INCOMPLETE_MARKER), { force: true });
    forgetCreated(created, RESTORE_INCOMPLETE_MARKER);
    const finalDirState = syncDirectory(target.path);

    return okResult({
      targetDir: target.path,
      database: TARGET_DATABASE_FILE,
      receipt,
      durability: durabilityReport(finalDirState),
      summary: {
        schemaVersion: manifest.structure.schemaVersion,
        migrations: manifest.structure.migrations,
        tables: manifest.structure.tables.length,
        rows: Object.values(manifest.content.tables).reduce((sum, entry) => sum + entry.rows, 0),
        snapshotBytes: manifest.snapshot.bytes,
        snapshotSha256: manifest.snapshot.sha256,
        restoredAt: receipt.restoredAt,
      },
    });
  } catch (error) {
    const cleanup = removeCreated(target.path, created, { removeDirectory: true });
    const failure = asFailure(error);
    const stage = { ...failure, stage: "restore" };
    if (!cleanup.directoryRemoved) stage.details = { ...(stage.details ?? {}), cleanup: "directory_kept" };
    return stage;
  }
}

/** 供上层（CLI / 后续接线）查询当前支持的备份格式与结构契约。 */
export function backupContract() {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    product: PRODUCT_ID,
    supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    productSchemaVersion: IMPORT_SCHEMA_VERSION,
    snapshotFile: SNAPSHOT_FILE,
    manifestFile: MANIFEST_FILE,
    targetDatabase: TARGET_DATABASE_FILE,
    coreTables: [...CORE_ACCOUNTING_TABLES],
    requiredTables: [...REQUIRED_TABLES],
  };
}
