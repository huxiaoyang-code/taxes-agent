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
// 3) 结构版本只支持**两个精确的真实结构**：v3（LOCAL-01 迁移后结构）与 v4（LOCAL-02 资产卡片补项）。
//    每个版本有**独立**的结构契约（`STRUCTURE_V3` / `STRUCTURE_V4`），逐表校验列名 / 声明类型 /
//    NOT NULL / **默认值**、主键列顺序与 **rowid 别名语义**、唯一性键的**完整比较语义**
//    （键列顺序 / 排序规则 `BINARY` / `NOCASE` / `RTRIM` / 升降序 / 表达式 / 部分索引），以及
//    外键，并校验 `schema_migrations` 记录
//    从 1 到该版本连续且与版本一致、`schema_backups` 记录存在。外键按**真实外键分组**
//    （多列外键整体比较，不只比目标列）与期望外键**一对一**比对 `ON DELETE` / `ON UPDATE` / `MATCH`
//    动作（同一列组对同一目标重复声明也一样逐组验动作并拒绝 `foreign_key_duplicate`，绝不用
//    「按目标键建 Map」静默覆盖）：只改动作的伪结构（例如把 `ON DELETE CASCADE` 改成 `NO ACTION`）
//    会伪装成兼容结构，恢复后真实删除账套才失败，必须拒绝。
//    缺表 / 缺列 / 缺关键约束 / 默认值不符 / 动作不符 / 重复或未声明的外键 / 伪造或矛盾迁移记录 /
//    未在本契约内的表（未来组件）一律拒绝；旧版本库（< v3）给 `schema_outdated`，
//    未来版本给 `schema_unsupported`，都要求先由产品真实入口升级 / 换新版工具，
//    本模块**不**替候选库初始化或迁移。**只把版本号抬高而结构仍是旧版本**会被缺列 / 列类型 /
//    默认值比对拦住（不会因为「版本号写了 4」就当成 v4）。
//    v3 备份按 v3 契约只读验证并原样恢复到全新目标（**不**就地迁移备份 / 源库）；
//    之后由产品真实入口打开才走既有 v3→v4 迁移路径。
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
import {
  BANK_COMPONENT_STRUCTURE,
  BANK_TABLES,
  canonicalSqlCondition,
  indexWherePredicate,
} from "./bank-storage.mjs";

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
 * 本模块**已按真实结构逐项验证**的 schema 版本集合（当前真实产品最多到 v4）。
 *
 * - v3：LOCAL-01 迁移后的结构（核心会计表 + 导入表 + 迁移 / 备份记录表，无资产补项列）；
 * - v4：LOCAL-02 在 v3 基础上只给 `asset_cards` 增加 5 列（取得期间 / 期初累计 / 未入账登记 /
 *   补项原因 / 来源），表集合不变。
 *
 * 两个版本各自有独立结构契约（列 / 类型 / NOT NULL / 默认值 / 主键 / 唯一性键比较语义 /
 * 外键动作 /
 * 迁移记录连续性 / 迁移前备份记录）。**不在集合内的版本一律拒绝**：更旧 → `schema_outdated`，
 * 更新（未来 v5+）→ `schema_unsupported`。
 *
 * 未来再新增版本必须：按真实 DDL 新增独立结构契约、补真实 SQLite 行为与合成临时库验收、
 * 再把它加入本集合。**不允许**仅因为表清单是动态计算的、或只把版本号抬高，就把新版本当成已支持。
 */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([3, 4]);
/** 当前支持的最高 schema 版本（`backupContract().supportedSchemaVersion`）。 */
export const SUPPORTED_SCHEMA_VERSION = 4;

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

/** 导入 / 版本化迁移表（LOCAL-01 schema v3 起，v4 未改变这些表）。 */
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
 * 唯一性比较的一个键列（真实 DDL 没写 `COLLATE` 时 SQLite 的默认是 `BINARY` + `ASC`）。
 * 排序规则 / 方向 / 键列顺序都是业务语义：`NOCASE` 会让 `Ref-A` 与 `ref-a` 撞唯一约束。
 */
const collationKey = (name, collation = "BINARY") => Object.freeze({ name, collation, desc: false });
/** 一条**真实存在**的唯一性约束：`pk` = 主键索引，`u` = 表级 / 列级 `UNIQUE (...)` 约束。 */
const uniqueConstraint = (origin, ...columns) => Object.freeze({ origin, columns: Object.freeze(columns) });

/**
 * 真实结构规范的**共用部分**（v3 与 v4 在这些表上逐字相同 —— 真实 DDL 相同）。
 *
 * 逐表声明列名 / 声明类型 / NOT NULL / **默认值**、主键列顺序、**唯一性键的完整比较语义**、
 * 外键（本表列 -> 目标表(目标列)，动作见 `REAL_FOREIGN_KEY_ACTIONS`）。
 * 列规范写成 `"<TYPE>[ NOT NULL][ DEFAULT <literal>]"`，`<literal>` 必须与
 * `PRAGMA table_info` 的 `dflt_value` **逐字**一致（SQLite 原样保存 DDL 里的默认值文本）：
 * `DEFAULT ''` → `''`、`DEFAULT 0.05` → `0.05`、`DEFAULT 'booked'` → `'booked'`。
 * `INTEGER PRIMARY KEY` 在 SQLite 里 `PRAGMA table_info` 的 notnull 为 0、dflt 为 null，
 * 因此这类主键列按 `"INTEGER"` 声明。
 *
 * 唯一性除了「哪些列」还有**比较规则**：
 * - `unique` 逐条声明真实存在的唯一性约束（`pk` 主键索引 / `u` = `UNIQUE (...)` 约束），
 *   每条用 `collationKey(<列>[, <排序规则>])` 给出键列，默认就是真实 DDL 的 `BINARY` + `ASC`；
 *   键列顺序、`COLLATE NOCASE` / `RTRIM`、`DESC`、表达式键、`WHERE` 部分索引都会改变
 *   「哪些业务写入必须被拒绝」，因此逐项比对，**不按列名集合放宽**；
 * - 真实 v3 / v4 没有命名唯一索引（v1 的 `idx_import_bindings_set` 在 v2 重建
 *   `import_source_bindings` 时已随旧表删除，**不得按旧 DDL 要求它存在**）；
 *   快照里出现契约外的唯一索引（含 `origin=c` 的 `CREATE UNIQUE INDEX`）一律拒绝；
 * - `rowidAlias: true` 表示主键就是 `INTEGER PRIMARY KEY` 的 rowid 别名（不另建主键索引），
 *   按真实 rowid 语义核对；`false` 表示主键有自己的一条唯一索引（列名 / 排序规则照常比对）；
 * - 非唯一的普通查询索引不改变唯一性 / 去重语义，不作为结构等价证据，也不据此拒绝。
 *
 * v3 / v4 的差异**只有 `asset_cards`**（v4 只加 5 列），因此该表在两个版本里各自独立声明；
 * 其余表共用本常量。**任何未来版本的差异都必须新增独立条目**，不得修改本共用常量去「顺便」
 * 适配新版本（那会让旧版本契约静默放宽）。
 */
const TABLE_STRUCTURE_COMMON = Object.freeze({
  // ---------------- 核心会计表（db.mjs） ----------------
  account_sets: {
    columns: {
      id: "INTEGER",
      name: "TEXT NOT NULL",
      taxpayer_type: "TEXT NOT NULL DEFAULT '小规模纳税人'",
      accounting_standard: "TEXT NOT NULL DEFAULT '小企业会计准则'",
      start_period: "TEXT NOT NULL",
      created_at: "TEXT NOT NULL",
    },
    primaryKey: ["id"],
    rowidAlias: true,
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
      contra: "INTEGER NOT NULL DEFAULT 0",
      is_leaf: "INTEGER NOT NULL DEFAULT 1",
    },
    primaryKey: ["id"],
    rowidAlias: true,
    unique: [uniqueConstraint("u", collationKey("account_set_id"), collationKey("code"))],
    foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
  },
  opening_balances: {
    columns: {
      account_set_id: "INTEGER NOT NULL",
      code: "TEXT NOT NULL",
      debit: "REAL NOT NULL DEFAULT 0",
      credit: "REAL NOT NULL DEFAULT 0",
    },
    primaryKey: ["account_set_id", "code"],
    rowidAlias: false,
    unique: [uniqueConstraint("pk", collationKey("account_set_id"), collationKey("code"))],
    foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
  },
  periods: {
    columns: {
      account_set_id: "INTEGER NOT NULL",
      period: "TEXT NOT NULL",
      status: "TEXT NOT NULL DEFAULT 'open'",
    },
    primaryKey: ["account_set_id", "period"],
    rowidAlias: false,
    unique: [uniqueConstraint("pk", collationKey("account_set_id"), collationKey("period"))],
    foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
  },
  vouchers: {
    columns: {
      id: "INTEGER",
      account_set_id: "INTEGER NOT NULL",
      period: "TEXT NOT NULL",
      voucher_date: "TEXT NOT NULL",
      word: "TEXT NOT NULL DEFAULT '记'",
      number: "INTEGER NOT NULL",
      summary: "TEXT",
      status: "TEXT NOT NULL DEFAULT 'draft'",
      created_at: "TEXT NOT NULL",
      kind: "TEXT NOT NULL DEFAULT 'normal'",
    },
    primaryKey: ["id"],
    rowidAlias: true,
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
      debit: "REAL NOT NULL DEFAULT 0",
      credit: "REAL NOT NULL DEFAULT 0",
    },
    primaryKey: ["id"],
    rowidAlias: true,
    unique: [],
    foreignKeys: [{ from: ["voucher_id"], table: "vouchers", to: ["id"] }],
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
    rowidAlias: true,
    unique: [uniqueConstraint("u", collationKey("account_set_id"), collationKey("asset_id"),
      collationKey("period"))],
    foreignKeys: [
      { from: ["account_set_id"], table: "account_sets", to: ["id"] },
      { from: ["asset_id"], table: "asset_cards", to: ["id"] },
    ],
  },

  // ---------------- 迁移 / 备份记录（import-storage.mjs） ----------------
  schema_migrations: {
    columns: { version: "INTEGER", applied_at: "TEXT NOT NULL", note: "TEXT" },
    primaryKey: ["version"],
    rowidAlias: true,
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
      integrity: "TEXT NOT NULL DEFAULT 'ok'",
      note: "TEXT",
    },
    primaryKey: ["id"],
    rowidAlias: true,
    unique: [],
    foreignKeys: [],
  },

  // ---------------- 导入表（schema v3） ----------------
  import_enterprise_account_sets: {
    columns: {
      enterprise_key: "TEXT",
      enterprise_name: "TEXT NOT NULL DEFAULT ''",
      account_set_id: "INTEGER NOT NULL",
      bound_at: "TEXT NOT NULL",
      bound_by: "TEXT NOT NULL DEFAULT 'import'",
    },
    primaryKey: ["enterprise_key"],
    rowidAlias: false,
    unique: [uniqueConstraint("pk", collationKey("enterprise_key")),
      uniqueConstraint("u", collationKey("account_set_id"))],
    foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
  },
  import_source_bindings: {
    columns: {
      id: "INTEGER",
      source_system: "TEXT NOT NULL",
      enterprise_key: "TEXT NOT NULL",
      enterprise_name: "TEXT NOT NULL DEFAULT ''",
      bound_at: "TEXT NOT NULL",
      bound_by: "TEXT NOT NULL DEFAULT 'import'",
    },
    primaryKey: ["id"],
    rowidAlias: true,
    unique: [uniqueConstraint("u", collationKey("source_system"), collationKey("enterprise_key"))],
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
      attempts: "INTEGER NOT NULL DEFAULT 1",
      created_at: "TEXT NOT NULL",
      updated_at: "TEXT NOT NULL",
      result_json: "TEXT NOT NULL DEFAULT '{}'",
      error_code: "TEXT",
      error_message: "TEXT",
    },
    primaryKey: ["batch_id"],
    rowidAlias: false,
    unique: [uniqueConstraint("pk", collationKey("batch_id"))],
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
      voucher_fingerprint: "TEXT NOT NULL DEFAULT ''",
      content_fingerprint: "TEXT NOT NULL",
      batch_id: "TEXT NOT NULL",
      created_at: "TEXT NOT NULL",
    },
    primaryKey: ["id"],
    rowidAlias: true,
    unique: [uniqueConstraint("u", collationKey("source_system"), collationKey("enterprise_key"),
      collationKey("source_voucher_id"))],
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
    rowidAlias: true,
    unique: [uniqueConstraint("u", collationKey("batch_id"), collationKey("source_voucher_id"))],
    foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
  },
});

/** 列规范解析：`"<TYPE>[ NOT NULL][ DEFAULT <literal>]"`（默认值必须在末尾，与 DDL 书写一致）。 */
const parseColumnSpec = (spec) => {
  const match = /\s+DEFAULT\s+(.+)$/.exec(spec);
  const defaultText = match ? match[1].trim() : null;
  const head = match ? spec.slice(0, match.index) : spec;
  const notNull = /\bNOT NULL\b/.test(head);
  const type = head.replace(/\s+NOT\s+NULL\s*$/, "").trim();
  return { type, notNull, default: defaultText };
};

/**
 * 资产卡片（`asset_cards`）在 v3 / v4 的**独立列契约**（两份都写全，不用 spread 继承，
 * 避免以后改一份就静默改变另一个版本）。
 * v4 的 5 列来自 import-storage.mjs 的 `addColumnIfMissing`（只加列，旧行语义不变），
 * 因此默认值必须与真实 DDL 逐字一致：可空 `TEXT` / `REAL NOT NULL DEFAULT 0` /
 * `TEXT NOT NULL DEFAULT 'booked'` / `TEXT NOT NULL DEFAULT ''` / `TEXT NOT NULL DEFAULT 'purchase'`。
 */
const ASSET_CARDS_COLUMNS_V3 = Object.freeze({
  id: "INTEGER",
  account_set_id: "INTEGER NOT NULL",
  kind: "TEXT NOT NULL DEFAULT 'fixed'",
  name: "TEXT NOT NULL",
  original_cost: "REAL NOT NULL",
  residual_rate: "REAL NOT NULL DEFAULT 0.05",
  useful_life_months: "INTEGER NOT NULL",
  start_period: "TEXT NOT NULL",
  asset_account: "TEXT NOT NULL",
  accum_account: "TEXT NOT NULL",
  expense_account: "TEXT NOT NULL DEFAULT '5602'",
  created_at: "TEXT NOT NULL",
});
const ASSET_CARDS_COLUMNS_V4 = Object.freeze({
  id: "INTEGER",
  account_set_id: "INTEGER NOT NULL",
  kind: "TEXT NOT NULL DEFAULT 'fixed'",
  name: "TEXT NOT NULL",
  original_cost: "REAL NOT NULL",
  residual_rate: "REAL NOT NULL DEFAULT 0.05",
  useful_life_months: "INTEGER NOT NULL",
  start_period: "TEXT NOT NULL",
  asset_account: "TEXT NOT NULL",
  accum_account: "TEXT NOT NULL",
  expense_account: "TEXT NOT NULL DEFAULT '5602'",
  created_at: "TEXT NOT NULL",
  acquired_period: "TEXT",
  opening_accumulated: "REAL NOT NULL DEFAULT 0",
  ledger_status: "TEXT NOT NULL DEFAULT 'booked'",
  ledger_note: "TEXT NOT NULL DEFAULT ''",
  origin: "TEXT NOT NULL DEFAULT 'purchase'",
});

const assetCardsTable = (columns) => Object.freeze({
  columns,
  primaryKey: ["id"],
  rowidAlias: true,
  unique: [],
  foreignKeys: [{ from: ["account_set_id"], table: "account_sets", to: ["id"] }],
});

/** schema v3 完整结构契约（LOCAL-01 迁移后的真实结构）。 */
const STRUCTURE_V3 = Object.freeze({
  ...TABLE_STRUCTURE_COMMON,
  asset_cards: assetCardsTable(ASSET_CARDS_COLUMNS_V3),
});

/** schema v4 完整结构契约（LOCAL-02：v3 + `asset_cards` 5 个补项列，表集合不变）。 */
const STRUCTURE_V4 = Object.freeze({
  ...TABLE_STRUCTURE_COMMON,
  asset_cards: assetCardsTable(ASSET_CARDS_COLUMNS_V4),
});

/** 版本 -> 独立结构契约。不在本表里的版本一律拒绝（更旧 outdated / 更新 unsupported）。 */
const STRUCTURES_BY_VERSION = Object.freeze({ 3: STRUCTURE_V3, 4: STRUCTURE_V4 });

/**
 * 本模块契约里出现过的全部默认值文本。拒绝明细里只回显**这些**值（或 `nonstandard`），
 * 因此伪造默认值时不会把任意业务文本（如企业名称）带进错误输出。
 */
const KNOWN_DEFAULT_LITERALS = new Set(
  Object.values(STRUCTURES_BY_VERSION)
    .flatMap((structure) => Object.values(structure))
    .flatMap((table) => Object.values(table.columns))
    .map((spec) => parseColumnSpec(spec).default)
    .filter((value) => value !== null),
);

/** 当前支持的所有版本都要必需的表集合（v3 / v4 表集合相同：v4 只加列）。 */
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

// ------------------------------------------------------------------ 可选组件（当前仅 bank v1）
/**
 * 已审查的组件注册表：名字 / 版本 / 表集合 / 完整结构契约。
 * 这里**不**按 `bank_*` 前缀或动态表名白名单放行：只有完整表集 + 版本内容 + 完整结构都符合
 * 注册表里的 v1 契约才被当成受支持组件。
 */
const COMPONENT_REGISTRY = Object.freeze({
  bank: Object.freeze({
    name: BANK_COMPONENT_STRUCTURE.name,
    version: BANK_COMPONENT_STRUCTURE.version,
    tables: Object.freeze([...BANK_TABLES].sort()),
    structure: BANK_COMPONENT_STRUCTURE,
  }),
});

const tableColumnFacts = (conn, table) => conn.prepare("SELECT * FROM pragma_table_info(?)").all(table)
  .sort((a, b) => Number(a.cid) - Number(b.cid))
  .map((column) => ({
    name: String(column.name),
    type: String(column.type ?? ""),
    notNull: Number(column.notnull) === 1,
    pk: Number(column.pk),
    defaultLiteral: column.dflt_value === null || column.dflt_value === undefined
      ? null : String(column.dflt_value),
  }));

const tableIndexFacts = (conn, table) => conn.prepare("SELECT * FROM pragma_index_list(?)").all(table)
  .map((index) => {
    const name = String(index.name);
    const row = conn.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name);
    return {
      name,
      unique: Number(index.unique) === 1,
      partial: Number(index.partial) === 1,
      origin: String(index.origin ?? ""),
      columns: conn.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(name)
        .map((column) => String(column.name)),
      where: canonicalSqlCondition(indexWherePredicate(row?.sql)),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const tableForeignKeyFacts = (conn, table) => {
  const rows = conn.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(table)
    .sort((a, b) => Number(a.id) - Number(b.id) || Number(a.seq) - Number(b.seq));
  const grouped = new Map();
  for (const row of rows) {
    const id = String(row.id);
    if (!grouped.has(id)) {
      grouped.set(id, {
        refTable: String(row.table),
        onDelete: String(row.on_delete ?? "NO ACTION").toUpperCase(),
        onUpdate: String(row.on_update ?? "NO ACTION").toUpperCase(),
        match: String(row.match ?? "NONE").toUpperCase(),
        rows: [],
      });
    }
    grouped.get(id).rows.push({ seq: Number(row.seq), from: String(row.from), to: row.to === null || row.to === undefined ? null : String(row.to) });
  }
  return [...grouped.values()].map((group) => {
    const ordered = group.rows.sort((a, b) => a.seq - b.seq);
    return {
      columns: ordered.map((entry) => entry.from),
      refTable: group.refTable,
      refColumns: ordered.map((entry) => entry.to),
      onDelete: group.onDelete,
      onUpdate: group.onUpdate,
      match: group.match,
    };
  });
};

const componentObjectFacts = (conn, tableSet) => conn.prepare(
  "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('trigger','view') ORDER BY type, name",
).all()
  .filter((object) => tableSet.has(String(object.tbl_name ?? ""))
    || /^bank_/i.test(String(object.name ?? ""))
    || /\bbank_[a-z0-9_]+\b/i.test(String(object.sql ?? "")))
  .map((object) => ({
    type: String(object.type),
    name: String(object.name),
    table: String(object.tbl_name ?? ""),
    sql: String(object.sql ?? ""),
  }));

/** 只读读取组件版本表内容；列缺失时给结构化状态而不是抛原始 SQL 错误。 */
function componentVersionState(conn, tables) {
  const table = "bank_component_migrations";
  if (!tables.includes(table)) return { readable: false, reason: "table_missing", columns: [], rows: [] };
  const columns = conn.prepare("SELECT * FROM pragma_table_info(?)").all(table).map((column) => String(column.name));
  if (!columns.includes("version")) return { readable: false, reason: "version_column_missing", columns, rows: [] };
  const selected = ["version", "applied_at", "note"].filter((name) => columns.includes(name));
  const rows = conn.prepare(`SELECT ${selected.join(", ")} FROM ${table} ORDER BY version`).all()
    .map((row) => ({
      version: Number(row.version),
      appliedAt: row.applied_at === undefined ? undefined : row.applied_at,
      note: row.note === undefined ? undefined : row.note,
    }));
  return { readable: true, reason: null, columns, rows };
}

/**
 * 组件索引的**完整键事实**（只用于结构校验，不写进清单结构摘要）。
 * 逐键给出 `seqno` / 列名 / collation / 方向 / 表达式 / rowid，并保留 `unique` / `partial` /
 * 真实谓词 / `origin` / 名字。单独一份（而不是改 `tableIndexFacts`）是为了不改动已存在健康
 * 内部 bank 备份的 `structureDigest` 定义：旧备份仍可验证，而严格校验由本函数提供。
 */
const componentIndexKeyFacts = (conn, table) => conn.prepare("SELECT * FROM pragma_index_list(?) ORDER BY name").all(table)
  .map((index) => {
    const name = String(index.name);
    const row = conn.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name);
    const keys = conn.prepare("SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno").all(name)
      .filter((entry) => Number(entry.key) === 1)
      .map((entry) => ({
        seqno: Number(entry.seqno),
        name: entry.name === null || entry.name === undefined ? null : String(entry.name),
        expression: Number(entry.cid) === -2,
        rowid: Number(entry.cid) === -1,
        collation: reportCollation(entry.coll),
        desc: Number(entry.desc) === 1,
      }));
    return {
      name,
      unique: Number(index.unique) === 1,
      partial: Number(index.partial) === 1,
      origin: reportOrigin(index.origin),
      keys,
      columns: keys.map((key) => key.name),
      where: canonicalSqlCondition(indexWherePredicate(row?.sql)),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * 组件索引契约比对：名字 / 来源 / 列序 / UNIQUE / partial / 真实谓词 / 逐键
 * （seqno 顺序 + collation + 方向 + 表达式 + rowid）；数量 / 额外 / 缺失 / 顶替全部拒绝。
 * 不针对某个具体索引名特判：一条正常产品 DDL 必须全部通过，任何一条键语义漂移都必须拒绝。
 */
function componentIndexProblems(conn, contract, tableSet) {
  const problems = [];
  const expectedByTable = new Map();
  for (const want of contract.structure.indexes) {
    const list = expectedByTable.get(want.table) ?? [];
    list.push(want);
    expectedByTable.set(want.table, list);
  }
  const contractKeys = (want) => (want.keys ?? want.columns.map((column) => ({
    column, collation: "BINARY", desc: false, expression: false, rowid: false,
  })));
  const sameKeys = (actualKeys, wantedKeys) => actualKeys.length === wantedKeys.length
    && actualKeys.every((key, position) => {
      const want = wantedKeys[position];
      const wantExpression = want.expression === true;
      const wantName = want.column ?? want.name ?? null;
      return key.seqno === position
        && key.expression === wantExpression
        && key.rowid === (want.rowid === true)
        && key.name === (wantExpression || wantName === null ? null : String(wantName))
        && key.collation === reportCollation(want.collation ?? "BINARY")
        && key.desc === (want.desc === true);
    });
  for (const table of contract.tables) {
    if (!tableSet.has(table)) continue;
    const wants = expectedByTable.get(table) ?? [];
    const actual = componentIndexKeyFacts(conn, table);
    const used = new Set();
    for (const want of wants) {
      const wantWhere = canonicalSqlCondition(want.where);
      const wantKeys = contractKeys(want);
      const signature = (index) => index.origin === want.origin && index.unique === want.unique
        && index.partial === want.partial && index.where === wantWhere
        && sameKeys(index.keys, wantKeys);
      const match = want.index
        ? actual.find((index) => index.name === want.index)
        : actual.find((index) => index.origin === want.origin && signature(index));
      if (!match) {
        problems.push({
          kind: "component_index_missing",
          component: contract.name,
          table,
          index: want.index ?? null,
          columns: [...want.columns],
          unique: want.unique,
          partial: want.partial,
          where: want.where ?? null,
          origin: want.origin ?? null,
        });
        continue;
      }
      used.add(match.name);
      if (!signature(match)) {
        problems.push({
          kind: "component_index_mismatch",
          component: contract.name,
          table,
          index: match.name,
          expected: {
            columns: [...want.columns], unique: want.unique, partial: want.partial,
            where: want.where ?? null, origin: want.origin ?? null, keys: wantKeys,
          },
          actual: {
            columns: match.columns, unique: match.unique, partial: match.partial,
            where: match.where, origin: match.origin, keys: match.keys,
          },
        });
      }
    }
    for (const index of actual) {
      if (used.has(index.name)) continue;
      problems.push({
        kind: "component_index_unexpected",
        component: contract.name,
        table,
        index: index.name,
        columns: index.columns,
        unique: index.unique,
        origin: index.origin,
        keys: index.keys,
      });
    }
  }
  return problems;
}

/** 版本表 / 备份证据表的内容约束（不只是结构形状）。 */
function componentContentProblems(conn, contract, tableSet) {
  const problems = [];
  const version = componentVersionState(conn, [...tableSet]);
  if (!version.readable) {
    problems.push({
      kind: "component_version_table_corrupt",
      component: contract.name,
      reason: version.reason,
      columns: version.columns,
    });
  } else {
    const versions = version.rows.map((row) => row.version);
    const hasFuture = versions.some((value) => Number.isInteger(value) && value > contract.version);
    const exact = versions.length === 1 && versions[0] === contract.version;
    if (hasFuture) {
      problems.push({ kind: "component_version_future", component: contract.name, versions, target: contract.version });
    } else if (!exact) {
      problems.push({
        kind: "component_version_contradiction",
        component: contract.name,
        versions,
        target: contract.version,
        reason: versions.length === 1 ? "version_not_target" : "version_rows_not_exactly_one",
      });
    }
    if (exact) {
      const row = version.rows[0];
      if (typeof row.appliedAt !== "string" || !row.appliedAt || Number.isNaN(Date.parse(row.appliedAt))) {
        problems.push({ kind: "component_version_timestamp", component: contract.name });
      }
      if (row.note !== null && row.note !== undefined && typeof row.note !== "string") {
        problems.push({ kind: "component_version_note", component: contract.name });
      }
    }
  }

  const backupTable = "bank_component_backups";
  if (tableSet.has(backupTable)) {
    const columns = conn.prepare("SELECT * FROM pragma_table_info(?)").all(backupTable).map((column) => String(column.name));
    const required = ["version", "path", "bytes", "integrity", "created_at"];
    if (required.every((name) => columns.includes(name))) {
      const rows = conn.prepare(`SELECT ${required.join(", ")} FROM ${backupTable} ORDER BY id`).all();
      const badVersion = rows.filter((row) => {
        const value = Number(row.version);
        return !Number.isInteger(value) || value < 1 || value > contract.version;
      }).length;
      if (badVersion) problems.push({ kind: "component_backup_records_version", component: contract.name, count: badVersion });
      const badPath = rows.filter((row) => typeof row.path !== "string" || !row.path).length;
      if (badPath) problems.push({ kind: "component_backup_records_path", component: contract.name, count: badPath });
      const badBytes = rows.filter((row) => row.bytes !== null && row.bytes !== undefined
        && (!Number.isInteger(Number(row.bytes)) || Number(row.bytes) < 0)).length;
      if (badBytes) problems.push({ kind: "component_backup_records_bytes", component: contract.name, count: badBytes });
      const badIntegrity = rows.filter((row) => typeof row.integrity !== "string" || !row.integrity).length;
      if (badIntegrity) problems.push({ kind: "component_backup_records_integrity", component: contract.name, count: badIntegrity });
      const badTimestamp = rows.filter((row) => typeof row.created_at !== "string"
        || !row.created_at || Number.isNaN(Date.parse(row.created_at))).length;
      if (badTimestamp) problems.push({ kind: "component_backup_records_timestamp", component: contract.name, count: badTimestamp });
    }
  }
  return problems;
}

/**
 * 识别 / 校验可选组件。返回 `{present, name, version, tableSet, tables, problems}`。
 * 任何 `bank_*` 表出现即进入组件校验：必须完整表集 + 唯一 v1 版本 + 完整结构与索引 + 无未知触发器 / 视图。
 */
function inspectComponent(conn, tables) {
  const contract = COMPONENT_REGISTRY.bank;
  const actualTables = tables.filter((name) => name.startsWith("bank_")).sort();
  const tableSet = new Set(actualTables);
  const componentObjects = componentObjectFacts(conn, tableSet);
  if (!actualTables.length && !componentObjects.length) {
    return { present: false, name: contract.name, version: null, tableSet, tables: [], problems: [] };
  }
  const expected = contract.tables;
  const problems = [];
  const missing = expected.filter((table) => !tableSet.has(table));
  const unexpected = actualTables.filter((table) => !expected.includes(table));
  if (missing.length) problems.push({ kind: "component_tables_missing", component: contract.name, tables: missing.slice(0, MAX_DETAIL_ITEMS) });
  if (unexpected.length) problems.push({ kind: "component_tables_unexpected", component: contract.name, tables: unexpected.slice(0, MAX_DETAIL_ITEMS) });

  const versionState = componentVersionState(conn, actualTables);
  const version = versionState.readable && versionState.rows.length === 1
    && Number.isInteger(versionState.rows[0].version) ? versionState.rows[0].version : null;
  problems.push(...componentIndexProblems(conn, contract, tableSet));
  problems.push(...componentContentProblems(conn, contract, tableSet));
  for (const object of componentObjects) {
    problems.push({
      kind: object.type === "trigger" ? "component_trigger_unexpected" : "component_view_unexpected",
      component: contract.name,
      type: object.type,
      name: object.name,
      table: object.table,
    });
  }
  return { present: true, name: contract.name, version, tableSet, tables: actualTables, problems };
}

/** 组件结构的规范化事实（用于清单 structureDigest 绑定与 verify 重算）。 */
function componentStructureFacts(conn, contract, component) {
  const tables = contract.tables.map((table) => ({
    name: table,
    columns: component.tableSet.has(table) ? tableColumnFacts(conn, table) : [],
    primaryKey: component.tableSet.has(table)
      ? conn.prepare("SELECT * FROM pragma_table_info(?)").all(table)
        .filter((column) => Number(column.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((column) => String(column.name))
      : [],
    indexes: component.tableSet.has(table) ? tableIndexFacts(conn, table) : [],
    foreignKeys: component.tableSet.has(table) ? tableForeignKeyFacts(conn, table) : [],
  }));
  return {
    name: contract.name,
    version: component.version,
    tables,
    objects: componentObjectFacts(conn, component.tableSet),
  };
}

const componentStructureDigest = (conn, contract, component) =>
  sha256Text(JSON.stringify(componentStructureFacts(conn, contract, component)));

/** 组件内容摘要：只覆盖该组件的表，与全库内容摘要分开绑定。 */
function componentContentDigest(component, content) {
  const tables = [...component.tables].sort();
  return sha256Text(tables.map((table) => {
    const facts = content.tables[table];
    return `${table}|${facts ? facts.rows : 0}|${facts ? facts.digest : ""}`;
  }).join("\n"));
}

// ------------------------------------------------------------------ 真实结构校验
/**
 * 排序规则 token：只回显 SQLite 内置的三种，其它（自定义 / 伪造）统一报 `nonstandard`，
 * 因此拒绝明细里不会出现任意业务文本。
 */
const INDEX_COLLATIONS = new Set(["BINARY", "NOCASE", "RTRIM"]);
const reportCollation = (value) => {
  const text = String(value ?? "").toUpperCase();
  return INDEX_COLLATIONS.has(text) ? text : "nonstandard";
};
/** 索引来源 token（`pk` 主键 / `u` `UNIQUE` 约束 / `c` `CREATE [UNIQUE] INDEX`）。 */
const INDEX_ORIGINS = new Set(["pk", "u", "c"]);
const reportOrigin = (value) => {
  const text = String(value ?? "");
  return INDEX_ORIGINS.has(text) ? text : "nonstandard";
};
/** 表达式键列的固定 token（绝不回显索引表达式原文）。 */
const EXPRESSION_KEY = "expression";

/**
 * 读出表上**真实存在的唯一性索引**（`PRAGMA index_list` 的 unique / origin / partial +
 * `PRAGMA index_xinfo` 的 `seqno` / 键列 / 排序规则 / 方向 / 表达式 / rowid + `sqlite_master.sql`
 * 的部分索引谓词）：
 *  - `name`：真实索引名（`CREATE UNIQUE INDEX` 的命名索引与自动索引都有名字）；
 *  - `keys[].name`：键列名；表达式列没有列名，标 `expression: true`；
 *  - `keys[].collation`：键列实际使用的排序规则（`BINARY` / `NOCASE` / `RTRIM` / `nonstandard`）；
 *  - `keys[].desc`：是否 `DESC`；`keys[].seqno`：键列顺序（逐键比较，顺序不同就是另一条约束）；
 *  - `keys[].expression` / `keys[].rowid`：表达式键 / rowid 键（产品真实 DDL 都是普通列键）；
 *  - `partial` / `where`：是否 `WHERE` 部分索引 + 规范化后的真实谓词。
 * 只收 `unique=1` 的索引：它们决定「哪些业务写入必须被拒绝」（主键 / 唯一约束 / 跨批去重），
 * 普通（非唯一）索引只影响查询性能、不改变业务规则，因此不作为结构等价证据，也不据此拒绝
 * （真实 v1 的 `idx_import_bindings_set` 在 v2 重建 `import_source_bindings` 时已随旧表删除，
 * 不得按旧 DDL 要求它存在）。`origin=c` 的命名唯一索引与 `u` / `pk` 同列比对：
 * 额外 / 重复 / 语义不同的唯一索引一律参与拒绝。
 */
const uniqueIndexFacts = (conn, table) => {
  const facts = [];
  for (const index of conn.prepare("SELECT * FROM pragma_index_list(?)").all(table)) {
    if (Number(index.unique) !== 1) continue;
    const name = String(index.name);
    const row = conn.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name);
    const keys = conn.prepare("SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno").all(name)
      .filter((entry) => Number(entry.key) === 1)
      .map((entry) => ({
        seqno: Number(entry.seqno),
        name: entry.name === null || entry.name === undefined ? null : String(entry.name),
        expression: Number(entry.cid) === -2,
        rowid: Number(entry.cid) === -1,
        collation: reportCollation(entry.coll),
        desc: Number(entry.desc) === 1,
      }));
    facts.push({
      name,
      origin: reportOrigin(index.origin),
      partial: Number(index.partial) === 1,
      where: canonicalSqlCondition(indexWherePredicate(row?.sql)),
      keys,
    });
  }
  return facts;
};

/** 键列名清单（表达式列用固定 token），用于拒绝明细，不回显表达式原文。 */
const keyColumnNames = (keys) => keys.map((key) => (key.expression ? EXPRESSION_KEY : String(key.name ?? EXPRESSION_KEY)));

/**
 * 期望的唯一性约束与真实索引是否**逐项同义**：来源 / 名字（若契约给出）/ `partial` 与真实谓词 /
 * 键列顺序（seqno）/ 列名 / 排序规则 / 方向 / 表达式 / rowid 都一致才算同一条约束。
 */
const uniqueIndexMatches = (actual, expected) => {
  const expectedPartial = expected.partial === true;
  if (actual.origin !== expected.origin) return false;
  if (actual.partial !== expectedPartial) return false;
  if (expected.index !== null && expected.index !== undefined && actual.name !== expected.index) return false;
  if (actual.where !== canonicalSqlCondition(expected.where)) return false;
  if (actual.keys.length !== expected.columns.length) return false;
  return actual.keys.every((key, position) => {
    const want = expected.columns[position];
    const wantExpression = want.expression === true;
    return key.seqno === position
      && key.expression === wantExpression
      && key.rowid === (want.rowid === true)
      && key.name === (wantExpression ? null : String(want.name))
      && key.collation === reportCollation(want.collation ?? "BINARY")
      && key.desc === (want.desc === true);
  });
};

/** 键列名相同（用于区分「约束缺失」与「约束在但比较规则 / 方向不同」）。 */
const sameUniqueColumns = (actual, expected) => actual.origin === expected.origin
  && (expected.index === null || expected.index === undefined || actual.name === expected.index)
  && actual.keys.length === expected.columns.length
  && actual.keys.every((key, position) => !key.expression && !key.rowid
    && key.name === String(expected.columns[position].name));

/**
 * 真实 rowid 语义核对：`INTEGER PRIMARY KEY` 只有在**确实是 rowid 别名**时才不另建主键索引。
 * 这里直接按 rowid 与主键列逐行比较；`WITHOUT ROWID` 表读不到 rowid（同样判为不符）。
 */
const rowidAliasMatches = (conn, table, column) => {
  try {
    const row = conn.prepare(
      `SELECT COUNT(*) AS n FROM ${quoteIdent(table)} WHERE rowid <> ${quoteIdent(column)}`,
    ).get();
    return Number(row?.n ?? 1) === 0;
  } catch {
    return false;
  }
};

/**
 * 真实 DDL 的外键动作契约（v3 与 v4 相同）：`db.mjs` / `import-storage.mjs` 里**所有**外键都写作
 * `REFERENCES <表>(<列>) ON DELETE CASCADE`（未声明 `ON UPDATE`，即 SQLite 默认 `NO ACTION`；
 * 匹配语义为默认 `NONE`）。这些动作是业务语义的一部分：改成 `NO ACTION` / `RESTRICT` 会让真实
 * 「删除账套」级联失败，改成 `SET NULL` / `SET DEFAULT` 会改写业务数据，都不是本产品结构。
 * 任何版本若出现不同动作的外键，必须在该外键条目上用 `actions` **逐条显式覆盖**，
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

/**
 * 默认值回显白名单：只回显本模块契约里的已知字面值，否则报告 `nonstandard`。
 * （伪造默认值时不会把任意业务文本带进错误输出。）
 */
const reportDefaultLiteral = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return KNOWN_DEFAULT_LITERALS.has(text) ? text : "nonstandard";
};

/**
 * 逐表校验列 / 类型 / NOT NULL / 默认值 / 主键（含 rowid 别名）/ 唯一性键完整语义 / 外键；
 * 返回问题清单（不含 SQL 与路径）。
 * `structure` 是**该版本自己的**结构契约（v3 或 v4），未在本契约里的表一律拒绝（未来组件）。
 */
function structureProblems(conn, tables, structure) {
  const problems = [];
  const missingTables = REQUIRED_TABLES.filter((table) => !tables.includes(table)).sort();
  if (missingTables.length) problems.push({ kind: "missing_tables", tables: missingTables.slice(0, MAX_DETAIL_ITEMS) });
  const unexpected = tables
    .filter((table) => !Object.prototype.hasOwnProperty.call(structure, table))
    .filter((table) => !table.startsWith("sqlite_"))
    .sort();
  if (unexpected.length) problems.push({ kind: "unexpected_tables", tables: unexpected.slice(0, MAX_DETAIL_ITEMS) });

  for (const [table, spec] of Object.entries(structure)) {
    if (!tables.includes(table)) continue;
    const columns = conn.prepare("SELECT * FROM pragma_table_info(?)").all(table).map((column) => ({
      name: String(column.name),
      type: String(column.type ?? ""),
      notNull: Number(column.notnull) === 1,
      pk: Number(column.pk),
      defaultLiteral: column.dflt_value === null || column.dflt_value === undefined
        ? null : String(column.dflt_value),
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
      // 默认值也是结构契约的一部分：`acquired_period` 从可空变成 NOT NULL DEFAULT ''、
      // `ledger_status` 默认值从 'booked' 改成别的值，都会让旧行 / 新行的业务语义静默改变。
      if (actual.defaultLiteral !== want.default) {
        problems.push({
          kind: "column_default",
          table,
          column: name,
          expected: reportDefaultLiteral(want.default),
          actual: reportDefaultLiteral(actual.defaultLiteral),
        });
      }
    }
    const actualPk = columns.filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk).map((column) => column.name);
    if (actualPk.join(",") !== spec.primaryKey.join(",")) problems.push({ kind: "primary_key", table });
    // ---- 唯一性键的完整比较语义：PK / UNIQUE / 真正存在的命名唯一索引 ----
    // 列名相同不等于同一条约束：排序规则（NOCASE / RTRIM）、键列顺序、升序 / 降序、表达式键、
    // 部分索引都会改变「哪些写入必须被拒绝」，所以逐项比对，并拒绝任何契约外的唯一索引。
    const actualUnique = uniqueIndexFacts(conn, table);
    const claimed = actualUnique.map(() => false);
    for (const expected of spec.unique) {
      const columns = expected.columns.map((column) => column.name);
      const origin = reportOrigin(expected.origin);
      const exact = actualUnique.findIndex((actual, position) => !claimed[position]
        && uniqueIndexMatches(actual, expected));
      if (exact >= 0) {
        claimed[exact] = true;
        continue;
      }
      const near = actualUnique.findIndex((actual, position) => !claimed[position]
        && sameUniqueColumns(actual, expected));
      if (near >= 0) {
        claimed[near] = true;
        const actual = actualUnique[near];
        problems.push({
          kind: "unique",
          table,
          origin,
          columns,
          reason: "semantics",
          collation: actual.keys.map((key) => key.collation),
          desc: actual.keys.map((key) => key.desc),
          expression: actual.keys.some((key) => key.expression),
        });
      } else {
        problems.push({ kind: "unique", table, origin, columns, reason: "missing" });
      }
    }
    const unexpectedUnique = actualUnique.filter((_, position) => !claimed[position]);
    if (unexpectedUnique.length) {
      problems.push({
        kind: "unexpected_unique_index",
        table,
        indexes: unexpectedUnique.slice(0, MAX_DETAIL_ITEMS).map((actual) => ({
          origin: actual.origin,
          partial: actual.partial,
          columns: keyColumnNames(actual.keys).slice(0, MAX_DETAIL_ITEMS),
        })),
      });
    }
    // `INTEGER PRIMARY KEY` 不另建主键索引：按**真实 rowid 语义**核对（不是只看列名）。
    if (spec.rowidAlias === true) {
      const pkIndexes = actualUnique.filter((actual) => actual.origin === "pk");
      const column = spec.primaryKey[0];
      if (pkIndexes.length || !rowidAliasMatches(conn, table, column)) {
        problems.push({ kind: "rowid_alias", table, column });
      }
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
 * 只读校验一个库是否为本产品**已独立声明契约的版本**（v3 / v4）的真实结构。
 * 顺序：必需表 → 版本（未来 / 旧版 / 未支持）→ 该版本自己的列 / 约束 / 默认值 → 迁移与备份记录。
 * **版本号只用于选契约**，不足以为凭：写成 4 但结构还是 v3 会被 `missing_columns` 拦住。
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
  const supported = SUPPORTED_SCHEMA_VERSIONS;
  if (version > supported[supported.length - 1]) {
    throw expected("schema_unsupported", { found: version, supported: supported[supported.length - 1] });
  }
  if (version < supported[0]) {
    throw expected("schema_outdated", { found: version, supported: supported[0] });
  }
  const structure = STRUCTURES_BY_VERSION[version];
  if (!structure) {
    // 版本在区间内却没有结构契约（例如以后调整了支持集合却没补契约）：明确拒绝，不猜结构。
    throw expected("schema_unsupported", { found: version, supported: supported[supported.length - 1] });
  }
  // 可选组件：任何 `bank_*` 表出现就按已登记 v1 契约完整校验；旧的无组件库不受影响。
  const component = inspectComponent(conn, tables);
  const effectiveStructure = component.present
    ? { ...structure, ...COMPONENT_REGISTRY.bank.structure.tables }
    : structure;
  const migrations = migrationRecordProblems(conn, version);
  const problems = [
    ...structureProblems(conn, tables, effectiveStructure),
    ...component.problems,
    ...migrations.problems,
    ...backupRecordProblems(conn, version),
  ];
  if (problems.length) {
    throw expected("structure_invalid", {
      schemaVersion: version,
      components: component.present ? [component.name] : [],
      problems: problems.slice(0, MAX_DETAIL_ITEMS),
    });
  }
  return { version, tables, migrations: migrations.versions, component };
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
  const components = [];
  if (structure.component && structure.component.present) {
    const contract = COMPONENT_REGISTRY.bank;
    components.push({
      name: contract.name,
      version: structure.component.version,
      tables: [...structure.component.tables].sort(),
      structureDigest: componentStructureDigest(conn, contract, structure.component),
      contentDigest: componentContentDigest(structure.component, content),
      rows: structure.component.tables.reduce((sum, table) => sum + content.tables[table].rows, 0),
    });
  }
  return {
    structure: {
      schemaVersion: structure.version,
      userVersion,
      sqliteVersion,
      migrations: structure.migrations,
      tables: structure.tables,
    },
    components,
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
 * 清单自报 schema 版本的范围判定：更旧 → `schema_outdated`，更新（未来版本）→
 * `schema_unsupported`，在支持集合内且确有独立契约 → `null`。
 */
function supportedVersionRange(version) {
  const versions = SUPPORTED_SCHEMA_VERSIONS;
  const newest = versions[versions.length - 1];
  const oldest = versions[0];
  if (version > newest) return { code: "schema_unsupported", details: { found: version, supported: newest } };
  if (version < oldest) return { code: "schema_outdated", details: { found: version, supported: oldest } };
  if (!Object.prototype.hasOwnProperty.call(STRUCTURES_BY_VERSION, version)) {
    return { code: "schema_unsupported", details: { found: version, supported: newest } };
  }
  return null;
}

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
  const manifestVersionRange = supportedVersionRange(structure.schemaVersion);
  if (manifestVersionRange) return manifestVersionRange;
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

  // 可选组件清单：只有已登记的名字 / 版本 / 表集才能声明；不存在的组件一律拒绝。
  if (manifest.components !== undefined) {
    if (!Array.isArray(manifest.components)) return { code: "manifest_invalid", details: { field: "components" } };
    const seen = new Set();
    for (const entry of manifest.components) {
      if (!isPlainObject(entry)) return { code: "manifest_invalid", details: { field: "components" } };
      if (!isNonEmptyString(entry.name)) return { code: "manifest_invalid", details: { field: "components.name" } };
      const contract = COMPONENT_REGISTRY[entry.name];
      if (!contract) return { code: "component_unsupported", details: { component: entry.name } };
      if (seen.has(entry.name)) return { code: "manifest_invalid", details: { field: "components.name" } };
      seen.add(entry.name);
      if (!Number.isInteger(entry.version) || entry.version < 1) {
        return { code: "manifest_invalid", details: { field: "components.version" } };
      }
      if (entry.version > contract.version) {
        return { code: "component_version_unsupported", details: { component: entry.name, found: entry.version, supported: contract.version } };
      }
      if (entry.version !== contract.version) {
        return { code: "component_version_unsupported", details: { component: entry.name, found: entry.version, supported: contract.version } };
      }
      if (!Array.isArray(entry.tables) || !entry.tables.length
        || entry.tables.some((name) => !isNonEmptyString(name))) {
        return { code: "manifest_invalid", details: { field: "components.tables" } };
      }
      if (sortedUnique(entry.tables).length !== entry.tables.length) {
        return { code: "manifest_invalid", details: { field: "components.tables" } };
      }
      if (entry.tables.join("\u0000") !== contract.tables.join("\u0000")) {
        return { code: "component_tables_mismatch", details: { component: entry.name } };
      }
      if (!isSha256(entry.structureDigest)) {
        return { code: "manifest_invalid", details: { field: "components.structureDigest" } };
      }
      if (!isSha256(entry.contentDigest)) {
        return { code: "manifest_invalid", details: { field: "components.contentDigest" } };
      }
      if (!isNonNegativeInteger(entry.rows)) {
        return { code: "manifest_invalid", details: { field: "components.rows" } };
      }
    }
  }

  const source = manifest.source;
  if (!isPlainObject(source)) return { code: "manifest_invalid", details: { field: "source" } };
  if (!isNonEmptyString(source.file)) return { code: "manifest_invalid", details: { field: "source.file" } };
  if (source.file !== basename(source.file)) return { code: "manifest_invalid", details: { field: "source.file" } };
  if (!isPositiveInteger(source.bytes)) return { code: "manifest_invalid", details: { field: "source.bytes" } };
  if (!isNonNegativeInteger(source.schemaVersion)) {
    return { code: "manifest_invalid", details: { field: "source.schemaVersion" } };
  }
  const sourceVersionRange = supportedVersionRange(source.schemaVersion);
  if (sourceVersionRange) return sourceVersionRange;
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
      ...(facts.components.length ? { components: facts.components } : {}),
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
        components: (manifest.components ?? []).map((entry) => ({
          name: entry.name, version: entry.version, tables: entry.tables.length, rows: entry.rows,
        })),
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

/** 清单组件绑定与快照重算事实逐项比对；名称 / 版本 / 表集 / 结构摘要 / 内容摘要 / 行数都要一致。 */
function componentBindingProblems(manifestComponents, actualComponents) {
  const recorded = manifestComponents ?? [];
  if (recorded.length !== actualComponents.length) {
    return {
      code: "component_mismatch",
      details: {
        field: "components",
        recorded: recorded.map((entry) => entry.name),
        actual: actualComponents.map((entry) => entry.name),
      },
    };
  }
  for (const actual of actualComponents) {
    const entry = recorded.find((candidate) => candidate.name === actual.name);
    if (!entry) return { code: "component_mismatch", details: { field: "components", component: actual.name } };
    if (entry.version !== actual.version) {
      return { code: "component_mismatch", details: { component: actual.name, field: "version" } };
    }
    if (entry.tables.join("\u0000") !== actual.tables.join("\u0000")) {
      return { code: "component_mismatch", details: { component: actual.name, field: "tables" } };
    }
    if (entry.structureDigest !== actual.structureDigest) {
      return { code: "component_mismatch", details: { component: actual.name, field: "structureDigest" } };
    }
    if (entry.contentDigest !== actual.contentDigest) {
      return { code: "component_mismatch", details: { component: actual.name, field: "contentDigest" } };
    }
    if (entry.rows !== actual.rows) {
      return { code: "component_mismatch", details: { component: actual.name, field: "rows" } };
    }
  }
  return null;
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
    // ---- 可选组件绑定：不信清单自报，按快照重算的版本 / 结构 / 内容摘要比对 ----
    const componentBinding = componentBindingProblems(manifest.components, facts.components ?? []);
    if (componentBinding) return rejected(componentBinding.code, componentBinding.details);
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
        components: (manifest.components ?? []).map((entry) => ({
          name: entry.name, version: entry.version, tables: entry.tables.length, rows: entry.rows,
        })),
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
    if (componentBindingProblems(manifest.components, published.components ?? [])) {
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
      components: (manifest.components ?? []).map((entry) => ({
        name: entry.name,
        version: entry.version,
        tables: entry.tables,
        structureDigest: entry.structureDigest,
        contentDigest: entry.contentDigest,
        rows: entry.rows,
      })),
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
        components: (manifest.components ?? []).map((entry) => ({
          name: entry.name, version: entry.version, tables: entry.tables.length, rows: entry.rows,
        })),
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
    supportedSchemaVersions: [...SUPPORTED_SCHEMA_VERSIONS],
    productSchemaVersion: IMPORT_SCHEMA_VERSION,
    snapshotFile: SNAPSHOT_FILE,
    manifestFile: MANIFEST_FILE,
    targetDatabase: TARGET_DATABASE_FILE,
    coreTables: [...CORE_ACCOUNTING_TABLES],
    requiredTables: [...REQUIRED_TABLES],
    components: Object.values(COMPONENT_REGISTRY).map((component) => ({
      name: component.name,
      version: component.version,
      tables: [...component.tables],
      contractDigest: sha256Text(JSON.stringify(component.structure)),
      // 说明：这是**契约定义**摘要，不是某个具体库的结构摘要；具体库的摘要写在清单 components[].structureDigest。
    })),
  };
}
