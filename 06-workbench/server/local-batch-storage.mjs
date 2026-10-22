// local-batch-storage.mjs — 持久批量任务（LOCAL-07）的存储层：manifest 校验 / 任务 / 阶段 /
// 锁与 fencing / 输入快照 / 报表产物元数据 / 状态汇总。
//
// 设计约束：
// 1) 本文件**不** import db.mjs（也不 import accounting / import-incremental 等会打开 DB 的模块）。
//    所有函数显式接收 node:sqlite 的 DatabaseSync 句柄，因此 CLI 可以在「只解析参数 + 只读检查
//    数据目录」之后才决定是否打开 / 迁移业务库；status 只读命令也只使用本文件。
// 2) 任务、阶段、锁、输入快照、产物元数据全部落在**同一个** workbench.db（local_batch_ 前缀 +
//    独立 component 版本表），这样业务状态与 checkpoint 处于同一备份时点。不另建队列 DB。
// 3) 新增 component 结构前必须先有可恢复的一致备份（LOCAL-06 createBackup / verifyBackup）。
//    本包交付时 LOCAL-06 尚未合并，因此：**只在显式新建、空的合成数据目录**上初始化结构；
//    对既有库（已有 workbench.db）返回 migration_requires_backup / dependency_unavailable，
//    绝不自动建表 / 升级，也不用 copyFile 主文件冒充备份。没有 CLI / 环境变量旁路开关。
// 4) 同账套跨进程互斥用数据库行锁 + 单调 fencing token + 租约；租约过期不等于旧执行者已死：
//    PID 仍存活或权限不确定时保守拒绝（owner_active），只有「租约过期且 PID 已确认不存在」才接管
//    并递增 fence，旧 token 的任何提交都会被事务内 fence 校验拒绝。

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve, sep } from "node:path";

export const LOCAL_BATCH_COMPONENT = "local-batch";
export const LOCAL_BATCH_SCHEMA_VERSION = 1;

export const LOCAL_BATCH_TABLES = [
  "local_batch_component",
  "local_batch_jobs",
  "local_batch_items",
  "local_batch_stages",
  "local_batch_locks",
  "local_batch_artifacts",
  "local_batch_snapshots",
  "local_batch_inputs",
];

export const STAGE_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  NOT_APPLICABLE: "not_applicable",
  FAILED: "failed",
  NEEDS_REVIEW: "needs_review",
  BLOCKED_DEPENDENCY: "blocked_dependency",
  CANCEL_REQUESTED: "cancel_requested",
  CANCELLED: "cancelled",
});

export const JOB_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  NEEDS_REVIEW: "needs_review",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const ITEM_STATUS = JOB_STATUS;

const TERMINAL_OK = new Set([STAGE_STATUS.SUCCEEDED, STAGE_STATUS.NOT_APPLICABLE]);
const TERMINAL = new Set([
  STAGE_STATUS.SUCCEEDED, STAGE_STATUS.NOT_APPLICABLE, STAGE_STATUS.FAILED,
  STAGE_STATUS.NEEDS_REVIEW, STAGE_STATUS.BLOCKED_DEPENDENCY, STAGE_STATUS.CANCELLED,
]);

export const REPORT_KINDS = ["balance-sheet", "income-statement", "cash-flow-statement", "trial-balance", "ledger"];
export const REPORT_FORMATS = ["csv", "xlsx", "pdf"];
export const STAGE_KEYS = Object.freeze({
  IMPORT: "import",
  POST: "post",
  DEPRECIATION: "depreciation",
  CARRYFORWARD: "carryforward",
  PERIOD_CHECK: "period-check",
  CLOSE: "close",
  REPORT: "report",
});

// ---------------------------------------------------------------- 小工具
export const nowIso = () => new Date().toISOString();
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function batchError(code, details = {}, message) {
  const error = new Error(message || code);
  error.code = code;
  error.details = details;
  return error;
}

/** 稳定 JSON：对象键排序，用于 manifest / 输入的确定性指纹（不用于对外输出）。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const FAIL = (code, details = {}, message) => {
  throw batchError(code, details, message);
};

// ---------------------------------------------------------------- 数据目录 / 依赖检查
const CORE_TABLES = ["account_sets", "accounts", "vouchers", "voucher_entries"];

/** SQLite 并发竞争下可重试的错误（不是库损坏）：另一个执行者正在写 / 正关闭连接并清理 -wal、-shm。 */
const TRANSIENT_LOCK = /database is locked|database table is locked|unable to open database file|disk I\/O error/i;

/** 同步短睡（CLI 单线程，只用于有限次重试，不引入异步边界）。 */
function sleepSync(ms) {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
}

/**
 * 只读检查数据目录，决定「是否可以由本包初始化结构」。
 * 不 import db.mjs（db.mjs 一 import 就会自动打开并迁移核心库）。
 * 并发场景（两个 CLI 同时 start）：另一个进程正在写、或正在关闭连接并清理 `-wal` / `-shm` 时，
 * 只读探测会瞬时拿到 `database is locked`，这不是库损坏，也不应报成 `database_unreadable`。
 * 因此这里做**有限次**重试（最多 4 次）；仍失败就如实返回不可读（fail-closed，不猜）。
 *
 * 重试预算如实说明（不夸大）：每个连接都尝试 `busy_timeout = 5000`（毫秒），最多 4 次尝试，
 * 重试之间的额外同步短睡合计 300ms（50 + 100 + 150），**没有** < 1 秒或其它总时长截止保证；
 * 单次 `inspectDataDir` 的墙钟时间取决于持锁方，可能远大于 1 秒。
 * 独立审查的真实观察（非推断）：用另一份 DELETE-journal 模式的 SQLite 库以 `BEGIN EXCLUSIVE` 持锁，
 * 另一子进程单次 `inspectDataDir` 实测 29812ms（外层 wall 29867ms），最终返回
 * `readable = false` / `error = "database is locked"`。该数字只描述那一次观测，不能推成
 * 「每个环境固定 30 秒」或「总有 20 秒上限」。产品未要求 < 1 秒，本轮不新增 deadline、不改行为。
 */
export function inspectDataDir(dataDir) {
  if (typeof dataDir !== "string" || !dataDir) FAIL("data_dir_required");
  const dbPath = join(dataDir, "workbench.db");
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const exists = existsSync(dbPath);
  const result = {
    dbPath, exists, bytes: 0, wal: existsSync(walPath), shm: existsSync(shmPath),
    coreVersion: null, batchVersion: null, tables: [], hasBusinessContent: false, readable: null,
  };
  if (!exists) return result;
  result.bytes = statSync(dbPath).size;
  if (result.bytes === 0) { result.readable = true; return result; }
  const attempts = 4;
  for (let attempt = 1; ; attempt += 1) {
    let probe;
    try {
      probe = new DatabaseSync(dbPath, { readOnly: true });
      try { probe.exec("PRAGMA busy_timeout = 5000"); } catch { /* 只读连接不允许设置时忽略 */ }
      result.tables = probe.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name);
      result.coreVersion = null;
      result.batchVersion = null;
      result.hasBusinessContent = false;
      if (result.tables.includes("schema_migrations")) {
        result.coreVersion = Number(probe.prepare(`SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations`).get()?.v || 0);
      }
      if (result.tables.includes(LOCAL_BATCH_TABLES[0])) {
        const row = probe.prepare(`SELECT version FROM local_batch_component WHERE component=?`).get(LOCAL_BATCH_COMPONENT);
        result.batchVersion = row ? Number(row.version) : 0;
      }
      const business = CORE_TABLES.filter((name) => result.tables.includes(name));
      if (business.length) {
        result.hasBusinessContent = true;
        try {
          const sets = Number(probe.prepare(`SELECT COUNT(*) AS n FROM account_sets`).get()?.n || 0);
          result.businessRows = sets;
        } catch { result.businessRows = null; }
      }
      result.readable = true;
      result.error = undefined;
      break;
    } catch (error) {
      result.readable = false;
      result.error = error?.message || String(error);
      if (attempt >= attempts || !TRANSIENT_LOCK.test(result.error)) break;
      sleepSync(50 * attempt);
    } finally {
      try { probe?.close(); } catch { /* 只读探测关闭失败不影响结果 */ }
    }
  }
  return result;
}

/**
 * 判断是否可以安全初始化：只允许「数据目录里根本没有 workbench.db」的显式新目标。
 * 已有库一律要求先走 LOCAL-06 一致备份（依赖未合并时返回 dependency_unavailable）。
 */
export function assertInitializable(dataDir) {
  const state = inspectDataDir(dataDir);
  if (!state.readable && state.exists) {
    FAIL("database_unreadable", { dataDir, reason: state.error }, "数据目录中的 workbench.db 无法只读打开");
  }
  if (!state.exists) return { fresh: true, state };
  const emptyFile = state.bytes === 0 && !state.wal && !state.shm && state.tables.length === 0;
  if (emptyFile) return { fresh: true, state };
  if (state.batchVersion === LOCAL_BATCH_SCHEMA_VERSION) return { fresh: false, state };
  if (state.batchVersion === null || state.batchVersion === 0) {
    FAIL(
      "migration_requires_backup",
      {
        dataDir, dependency: "LOCAL-06 createBackup/verifyBackup", status: "dependency_unavailable",
        batchVersion: state.batchVersion, coreVersion: state.coreVersion, hasBusinessContent: state.hasBusinessContent,
      },
      "既有数据库还没有批量结构：新增 component 结构前必须先用已审 LOCAL-06 一致备份并核验成功",
    );
  }
  FAIL("migration_requires_backup", {
    dataDir, dependency: "LOCAL-06 createBackup/verifyBackup", status: "dependency_unavailable",
    batchVersion: state.batchVersion, target: LOCAL_BATCH_SCHEMA_VERSION,
  });
}

function readBatchVersion(db) {
  const has = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(LOCAL_BATCH_TABLES[0]);
  if (!has) return null;
  const row = db.prepare(`SELECT version FROM local_batch_component WHERE component=?`).get(LOCAL_BATCH_COMPONENT);
  return row ? Number(row.version) : 0;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS local_batch_component (
     component TEXT PRIMARY KEY,
     version INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     note TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS local_batch_jobs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_key TEXT NOT NULL UNIQUE,
     manifest_hash TEXT NOT NULL,
     manifest_json TEXT NOT NULL,
     concurrency INTEGER NOT NULL,
     output_dir TEXT NOT NULL,
     status TEXT NOT NULL,
     cancel_requested INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS local_batch_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id INTEGER NOT NULL REFERENCES local_batch_jobs(id) ON DELETE CASCADE,
     item_key TEXT NOT NULL,
     enterprise_key TEXT NOT NULL,
     source_system TEXT NOT NULL,
     enterprise_name TEXT NOT NULL DEFAULT '',
     account_set_id INTEGER,
     account_set_source TEXT,
     status TEXT NOT NULL,
     error_code TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (job_id, item_key),
     UNIQUE (job_id, enterprise_key)
   )`,
  `CREATE TABLE IF NOT EXISTS local_batch_stages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     item_id INTEGER NOT NULL REFERENCES local_batch_items(id) ON DELETE CASCADE,
     period TEXT NOT NULL,
     stage_key TEXT NOT NULL,
     stage_order INTEGER NOT NULL,
     spec_json TEXT NOT NULL,
     status TEXT NOT NULL,
     attempt INTEGER NOT NULL DEFAULT 0,
     input_hash TEXT,
     outcome_hash TEXT,
     evidence_json TEXT NOT NULL DEFAULT '{}',
     error_code TEXT,
     error_message TEXT,
     owner_instance TEXT,
     fencing_token INTEGER,
     started_at TEXT,
     finished_at TEXT,
     updated_at TEXT NOT NULL,
     UNIQUE (item_id, period, stage_key)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_local_batch_stages_item ON local_batch_stages(item_id, period, stage_order)`,
  `CREATE TABLE IF NOT EXISTS local_batch_locks (
     resource_key TEXT PRIMARY KEY,
     owner_instance TEXT NOT NULL,
     fencing_token INTEGER NOT NULL,
     pid INTEGER,
     acquired_at TEXT NOT NULL,
     heartbeat_at TEXT NOT NULL,
     lease_expires_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS local_batch_artifacts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     artifact_key TEXT NOT NULL UNIQUE,
     job_id INTEGER NOT NULL REFERENCES local_batch_jobs(id) ON DELETE CASCADE,
     item_id INTEGER NOT NULL REFERENCES local_batch_items(id) ON DELETE CASCADE,
     period TEXT NOT NULL,
     stage_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     format TEXT NOT NULL,
     account_code TEXT,
     snapshot_hash TEXT NOT NULL,
     bytes_hash TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     mime TEXT NOT NULL,
     relative_path TEXT NOT NULL,
     status TEXT NOT NULL,
     attempt INTEGER NOT NULL,
     worker_thread_id INTEGER,
     render_started REAL,
     render_finished REAL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_local_batch_artifacts_item ON local_batch_artifacts(item_id, period)`,
  `CREATE TABLE IF NOT EXISTS local_batch_snapshots (
     snapshot_key TEXT PRIMARY KEY,
     job_id INTEGER NOT NULL REFERENCES local_batch_jobs(id) ON DELETE CASCADE,
     item_id INTEGER NOT NULL REFERENCES local_batch_items(id) ON DELETE CASCADE,
     period TEXT NOT NULL,
     kind TEXT NOT NULL,
     dto_hash TEXT NOT NULL,
     business_hash TEXT NOT NULL,
     dto_json TEXT NOT NULL,
     csv_text TEXT,
     csv_hash TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS local_batch_inputs (
     input_key TEXT PRIMARY KEY,
     job_id INTEGER NOT NULL REFERENCES local_batch_jobs(id) ON DELETE CASCADE,
     item_id INTEGER NOT NULL REFERENCES local_batch_items(id) ON DELETE CASCADE,
     period TEXT NOT NULL,
     batch_id TEXT NOT NULL,
     source_path TEXT,
     source_hash TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     content BLOB NOT NULL,
     created_at TEXT NOT NULL
   )`,
];

/**
 * 建立批量结构。只允许在**显式新建**的数据目录（由 assertInitializable 判定 fresh）上调用；
 * 建表 + component 版本记录在同一事务内，任一步失败整体回滚，不留半套 schema。
 */
export function ensureBatchSchema(db, { freshDatabase = false } = {}) {
  const version = readBatchVersion(db);
  if (version !== null) {
    if (version === LOCAL_BATCH_SCHEMA_VERSION) return { created: false, version };
    if (version > LOCAL_BATCH_SCHEMA_VERSION) FAIL("schema_future_version", { found: version, supported: LOCAL_BATCH_SCHEMA_VERSION });
    FAIL("migration_requires_backup", {
      found: version, supported: LOCAL_BATCH_SCHEMA_VERSION, dependency: "LOCAL-06 createBackup/verifyBackup",
    });
  }
  if (!freshDatabase) {
    FAIL("migration_requires_backup", {
      dependency: "LOCAL-06 createBackup/verifyBackup", status: "dependency_unavailable",
    }, "既有数据库缺少批量结构：必须先取得已审 LOCAL-06 一致备份，再建立新结构");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
    db.prepare(`INSERT INTO local_batch_component (component, version, updated_at, note) VALUES (?,?,?,?)`)
      .run(LOCAL_BATCH_COMPONENT, LOCAL_BATCH_SCHEMA_VERSION, nowIso(), "LOCAL-07 持久批量任务与 CLI");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 原库结构以回滚结果为准 */ }
    throw batchError("local_batch_schema_failed", { reason: error?.message || String(error) });
  }
  return { created: true, version: LOCAL_BATCH_SCHEMA_VERSION };
}

// ---------------------------------------------------------------- manifest（schemaVersion=1）
export const MANIFEST_LIMITS = Object.freeze({
  manifestBytes: 4 * 1024 * 1024,
  payloadBytes: 16 * 1024 * 1024,
  items: 200,
  periods: 36,
  importsPerPeriod: 10,
  voucherRefs: 2000,
  reportsPerPeriod: 10,
  concurrencyMax: 8,
  concurrencyDefault: 4,
});

const JOB_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ITEM_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const ALLOWED = {
  root: ["schemaVersion", "jobKey", "concurrency", "items"],
  item: ["itemKey", "source", "accountSetId", "periods"],
  source: ["system", "enterpriseKey", "enterpriseName"],
  period: ["period", "imports", "post", "depreciation", "carryforward", "periodCheck", "close", "reports"],
  import: ["batchId", "mode", "payloadFile", "payload", "confirmNewBinding"],
  post: ["vouchers"],
  voucherRef: ["voucherId", "sourceVoucherId"],
  carryforward: ["yearEnd"],
  report: ["kind", "formats", "code"],
};

function rejectUnknownKeys(raw, allowed, where, errors) {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) errors.push(`${where} 含未知字段：${key}（schemaVersion=1 只接受白名单字段）`);
  }
}

const isFiniteInt = (value) => typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);

function text(raw, where, errors, { required = false, max = 128 } = {}) {
  if (raw === undefined || raw === null) {
    if (required) errors.push(`${where} 必填`);
    return "";
  }
  if (typeof raw !== "string") { errors.push(`${where} 必须是文本`); return ""; }
  const value = raw.trim();
  if (required && !value) errors.push(`${where} 不能为空`);
  if (value.length > max) errors.push(`${where} 过长（上限 ${max} 字符）`);
  if (CONTROL_RE.test(value)) errors.push(`${where} 含控制字符`);
  return value;
}

/**
 * 严格校验 manifest（schemaVersion=1）。只做形状 / 白名单 / 类型 / 上限 / 期间 / ID 校验；
 * 不访问数据库、不读取 payload 文件内容（读取字节与指纹由调用方在同一份字节上完成）。
 */
export function validateManifest(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ["manifest 必须是 JSON 对象"], manifest: null };
  rejectUnknownKeys(raw, ALLOWED.root, "manifest", errors);
  if (raw.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  const jobKey = text(raw.jobKey, "jobKey", errors, { required: true, max: 128 });
  if (jobKey && !JOB_KEY_RE.test(jobKey)) errors.push("jobKey 只允许 [A-Za-z0-9._:-]，且以字母或数字开头");
  let concurrency = MANIFEST_LIMITS.concurrencyDefault;
  if (raw.concurrency !== undefined) {
    if (!isFiniteInt(raw.concurrency) || raw.concurrency < 1 || raw.concurrency > MANIFEST_LIMITS.concurrencyMax) {
      errors.push(`concurrency 必须是 1..${MANIFEST_LIMITS.concurrencyMax} 的整数`);
    } else concurrency = raw.concurrency;
  }
  const items = [];
  if (!Array.isArray(raw.items) || raw.items.length === 0) errors.push("items 必须是非空数组");
  else if (raw.items.length > MANIFEST_LIMITS.items) errors.push(`items 数量超过上限 ${MANIFEST_LIMITS.items}`);
  const seenItemKeys = new Set();
  const seenEnterprises = new Set();
  (Array.isArray(raw.items) ? raw.items : []).forEach((rawItem, index) => {
    const where = `items[${index}]`;
    if (!isPlainObject(rawItem)) { errors.push(`${where} 必须是对象`); return; }
    rejectUnknownKeys(rawItem, ALLOWED.item, where, errors);
    const itemKey = text(rawItem.itemKey, `${where}.itemKey`, errors, { required: true, max: 128 });
    if (itemKey && !ITEM_KEY_RE.test(itemKey)) errors.push(`${where}.itemKey 只允许 [A-Za-z0-9._:-]，且以字母或数字开头`);
    if (itemKey && seenItemKeys.has(itemKey)) errors.push(`${where}.itemKey 重复：${itemKey}`);
    if (itemKey) seenItemKeys.add(itemKey);
    const source = rawItem.source;
    const sourceValue = { system: "", enterpriseKey: "", enterpriseName: "" };
    if (!isPlainObject(source)) errors.push(`${where}.source 必须显式提供 { system, enterpriseKey }`);
    else {
      rejectUnknownKeys(source, ALLOWED.source, `${where}.source`, errors);
      sourceValue.system = text(source.system, `${where}.source.system`, errors, { required: true, max: 64 });
      sourceValue.enterpriseKey = text(source.enterpriseKey, `${where}.source.enterpriseKey`, errors, { required: true, max: 128 })
        .normalize("NFKC").trim();
      sourceValue.enterpriseName = text(source.enterpriseName, `${where}.source.enterpriseName`, errors, { max: 200 });
      if (!/^[A-Za-z0-9\u4e00-\u9fa5]/.test(sourceValue.enterpriseKey) && sourceValue.enterpriseKey) {
        errors.push(`${where}.source.enterpriseKey 必须以字母、数字或汉字开头（规范企业身份，不用名称猜认）`);
      }
    }
    if (sourceValue.enterpriseKey && seenEnterprises.has(sourceValue.enterpriseKey)) {
      errors.push(`${where}.source.enterpriseKey 在本 job 内重复：${sourceValue.enterpriseKey}（一家企业只有一个账套）`);
    }
    if (sourceValue.enterpriseKey) seenEnterprises.add(sourceValue.enterpriseKey);
    let accountSetId = null;
    if (rawItem.accountSetId !== undefined && rawItem.accountSetId !== null) {
      if (!isFiniteInt(rawItem.accountSetId) || rawItem.accountSetId <= 0) errors.push(`${where}.accountSetId 必须是正整数`);
      else accountSetId = rawItem.accountSetId;
    }
    const periods = [];
    if (!Array.isArray(rawItem.periods) || rawItem.periods.length === 0) errors.push(`${where}.periods 必须是非空数组`);
    else if (rawItem.periods.length > MANIFEST_LIMITS.periods) errors.push(`${where}.periods 超过上限 ${MANIFEST_LIMITS.periods}`);
    let lastPeriod = "";
    const seenPeriods = new Set();
    const seenBatchIds = new Set();
    (Array.isArray(rawItem.periods) ? rawItem.periods : []).forEach((rawPeriod, pIndex) => {
      const pWhere = `${where}.periods[${pIndex}]`;
      if (!isPlainObject(rawPeriod)) { errors.push(`${pWhere} 必须是对象`); return; }
      rejectUnknownKeys(rawPeriod, ALLOWED.period, pWhere, errors);
      const period = text(rawPeriod.period, `${pWhere}.period`, errors, { required: true, max: 7 });
      if (period && !PERIOD_RE.test(period)) errors.push(`${pWhere}.period 必须是合法的 YYYY-MM（月份 01-12）`);
      if (period) {
        if (seenPeriods.has(period)) errors.push(`${pWhere}.period 重复：${period}`);
        seenPeriods.add(period);
        if (lastPeriod && period <= lastPeriod) errors.push(`${pWhere}.period 必须按年月升序且不重复`);
        lastPeriod = period;
      }
      const imports = [];
      if (rawPeriod.imports !== undefined) {
        if (!Array.isArray(rawPeriod.imports)) errors.push(`${pWhere}.imports 必须是数组`);
        else if (rawPeriod.imports.length > MANIFEST_LIMITS.importsPerPeriod) {
          errors.push(`${pWhere}.imports 超过上限 ${MANIFEST_LIMITS.importsPerPeriod}`);
        }
        (Array.isArray(rawPeriod.imports) ? rawPeriod.imports : []).forEach((rawImport, iIndex) => {
          const iWhere = `${pWhere}.imports[${iIndex}]`;
          if (!isPlainObject(rawImport)) { errors.push(`${iWhere} 必须是对象`); return; }
          rejectUnknownKeys(rawImport, ALLOWED.import, iWhere, errors);
          const batchId = text(rawImport.batchId, `${iWhere}.batchId`, errors, { required: true, max: 128 });
          if (batchId && !BATCH_ID_RE.test(batchId)) errors.push(`${iWhere}.batchId 只允许 [A-Za-z0-9._:-]`);
          if (batchId && seenBatchIds.has(batchId)) errors.push(`${iWhere}.batchId 在本 item 内重复：${batchId}`);
          if (batchId) seenBatchIds.add(batchId);
          const mode = text(rawImport.mode, `${iWhere}.mode`, errors, { required: true, max: 8 });
          if (mode && !["create", "append"].includes(mode)) errors.push(`${iWhere}.mode 只能是 create / append`);
          if (mode === "create" && accountSetId !== null) {
            errors.push(`${iWhere}: item 已声明 accountSetId，不得再使用 mode=create（一家企业只有一个账套）`);
          }
          const hasFile = rawImport.payloadFile !== undefined && rawImport.payloadFile !== null;
          const hasInline = rawImport.payload !== undefined && rawImport.payload !== null;
          if (hasFile === hasInline) errors.push(`${iWhere} 必须且只能提供 payloadFile 或内联 payload 之一`);
          if (hasFile) {
            const file = text(rawImport.payloadFile, `${iWhere}.payloadFile`, errors, { required: true, max: 512 });
            if (file && (file.startsWith("/") || file.startsWith("\\") || /^[A-Za-z]:/.test(file) || file.split(/[\\/]/).includes(".."))) {
              errors.push(`${iWhere}.payloadFile 必须是 manifest 目录内的相对路径（禁止绝对路径与 ..）`);
            }
          }
          if (hasInline && !isPlainObject(rawImport.payload)) errors.push(`${iWhere}.payload 必须是对象`);
          if (rawImport.confirmNewBinding !== undefined && typeof rawImport.confirmNewBinding !== "boolean") {
            errors.push(`${iWhere}.confirmNewBinding 必须是布尔值`);
          }
          imports.push({
            batchId, mode,
            payloadFile: hasFile ? String(rawImport.payloadFile) : null,
            payload: hasInline ? rawImport.payload : null,
            confirmNewBinding: rawImport.confirmNewBinding === true,
          });
        });
      }
      let post = null;
      if (rawPeriod.post !== undefined && rawPeriod.post !== null) {
        if (!isPlainObject(rawPeriod.post)) errors.push(`${pWhere}.post 必须是对象 { vouchers: [...] }`);
        else {
          rejectUnknownKeys(rawPeriod.post, ALLOWED.post, `${pWhere}.post`, errors);
          const vouchers = [];
          if (!Array.isArray(rawPeriod.post.vouchers) || rawPeriod.post.vouchers.length === 0) {
            errors.push(`${pWhere}.post.vouchers 必须是非空数组（必须显式列出要过账的凭证）`);
          } else if (rawPeriod.post.vouchers.length > MANIFEST_LIMITS.voucherRefs) {
            errors.push(`${pWhere}.post.vouchers 超过上限 ${MANIFEST_LIMITS.voucherRefs}`);
          }
          (Array.isArray(rawPeriod.post.vouchers) ? rawPeriod.post.vouchers : []).forEach((ref, rIndex) => {
            const rWhere = `${pWhere}.post.vouchers[${rIndex}]`;
            if (!isPlainObject(ref)) { errors.push(`${rWhere} 必须是 { voucherId } 或 { sourceVoucherId }`); return; }
            rejectUnknownKeys(ref, ALLOWED.voucherRef, rWhere, errors);
            const hasVoucherId = ref.voucherId !== undefined && ref.voucherId !== null;
            const hasSourceId = ref.sourceVoucherId !== undefined && ref.sourceVoucherId !== null;
            if (hasVoucherId === hasSourceId) { errors.push(`${rWhere} 必须且只能提供 voucherId 或 sourceVoucherId`); return; }
            if (hasVoucherId) {
              if (!isFiniteInt(ref.voucherId) || ref.voucherId <= 0) errors.push(`${rWhere}.voucherId 必须是正整数`);
              else vouchers.push({ voucherId: ref.voucherId });
            } else {
              const sourceVoucherId = text(ref.sourceVoucherId, `${rWhere}.sourceVoucherId`, errors, { required: true, max: 128 });
              if (sourceVoucherId) vouchers.push({ sourceVoucherId });
            }
          });
          if (vouchers.length) post = { vouchers };
        }
      }
      let carryforward = null;
      if (rawPeriod.carryforward !== undefined && rawPeriod.carryforward !== null && rawPeriod.carryforward !== false) {
        if (!isPlainObject(rawPeriod.carryforward)) errors.push(`${pWhere}.carryforward 必须是 { yearEnd } 或 false`);
        else {
          rejectUnknownKeys(rawPeriod.carryforward, ALLOWED.carryforward, `${pWhere}.carryforward`, errors);
          if (rawPeriod.carryforward.yearEnd !== undefined && typeof rawPeriod.carryforward.yearEnd !== "boolean") {
            errors.push(`${pWhere}.carryforward.yearEnd 必须是布尔值`);
          } else {
            carryforward = { yearEnd: rawPeriod.carryforward.yearEnd === true };
          }
        }
      }
      for (const flag of ["depreciation", "periodCheck", "close"]) {
        if (rawPeriod[flag] !== undefined && typeof rawPeriod[flag] !== "boolean") {
          errors.push(`${pWhere}.${flag} 必须是布尔值`);
        }
      }
      const reports = [];
      if (rawPeriod.reports !== undefined) {
        if (!Array.isArray(rawPeriod.reports)) errors.push(`${pWhere}.reports 必须是数组`);
        else if (rawPeriod.reports.length > MANIFEST_LIMITS.reportsPerPeriod) {
          errors.push(`${pWhere}.reports 超过上限 ${MANIFEST_LIMITS.reportsPerPeriod}`);
        }
        const seenKinds = new Set();
        (Array.isArray(rawPeriod.reports) ? rawPeriod.reports : []).forEach((rawReport, rIndex) => {
          const rWhere = `${pWhere}.reports[${rIndex}]`;
          if (!isPlainObject(rawReport)) { errors.push(`${rWhere} 必须是对象`); return; }
          rejectUnknownKeys(rawReport, ALLOWED.report, rWhere, errors);
          const kind = text(rawReport.kind, `${rWhere}.kind`, errors, { required: true, max: 32 });
          if (kind && !REPORT_KINDS.includes(kind)) errors.push(`${rWhere}.kind 必须是 ${REPORT_KINDS.join(" / ")}`);
          if (kind && seenKinds.has(kind)) errors.push(`${rWhere}.kind 重复：${kind}`);
          if (kind) seenKinds.add(kind);
          const formats = [];
          if (!Array.isArray(rawReport.formats) || rawReport.formats.length === 0) errors.push(`${rWhere}.formats 必须是非空数组`);
          else for (const format of rawReport.formats) {
            if (!REPORT_FORMATS.includes(format)) errors.push(`${rWhere}.formats 含不支持的格式：${String(format)}`);
            else if (formats.includes(format)) errors.push(`${rWhere}.formats 重复：${format}`);
            else formats.push(format);
          }
          let code = null;
          if (kind === "ledger") {
            code = text(rawReport.code, `${rWhere}.code`, errors, { required: true, max: 32 });
            if (code && !/^[0-9A-Za-z._-]+$/.test(code)) errors.push(`${rWhere}.code 只允许科目编码字符`);
          } else if (rawReport.code !== undefined && rawReport.code !== null) {
            errors.push(`${rWhere}.code 只允许用于 ledger 报表`);
          }
          if (kind && REPORT_KINDS.includes(kind) && formats.length) reports.push({ kind, formats, code });
        });
      }
      const selected = imports.length || post || rawPeriod.depreciation === true || carryforward
        || rawPeriod.periodCheck === true || rawPeriod.close === true || reports.length;
      if (!selected) errors.push(`${pWhere} 未选择任何操作（不得以空步骤伪造成功）`);
      if (rawPeriod.close === true && rawPeriod.periodCheck !== true) {
        errors.push(`${pWhere}.close 必须在同一期间显式选择 periodCheck=true（不得跳过期末检查直接封账）`);
      }
      periods.push({
        period,
        imports,
        post,
        depreciation: rawPeriod.depreciation === true,
        carryforward,
        periodCheck: rawPeriod.periodCheck === true,
        close: rawPeriod.close === true,
        reports,
      });
    });
    items.push({ itemKey, source: sourceValue, accountSetId, periods });
  });
  if (errors.length) return { ok: false, errors, manifest: null };
  return { ok: true, errors: [], manifest: { schemaVersion: 1, jobKey, concurrency, items } };
}

// ---------------------------------------------------------------- 任务 / 计划
/**
 * 创建（或幂等返回）一个 job 及其 items / stages。
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db
 * @param {object} options.manifest 已通过 validateManifest 的 manifest
 * @param {string} options.manifestHash 规范 manifest 的 SHA-256
 * @param {string} options.manifestJson 规范 manifest JSON（持久保存）
 * @param {string} options.outputDir 操作者显式指定的输出根目录
 * @param {Array} options.plans [{ itemKey, stages: [{ period, stageKey, order, inputHash, spec }] }]
 * @param {Array} options.inputs [{ itemKey, period, batchId, sourcePath, sourceHash, bytes(Buffer) }]
 */
export function createJob(db, { manifest, manifestHash, manifestJson, outputDir, plans, inputs }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    let job = db.prepare(`SELECT * FROM local_batch_jobs WHERE job_key=?`).get(manifest.jobKey);
    let created = false;
    if (!job) {
      const info = db.prepare(`INSERT INTO local_batch_jobs
          (job_key, manifest_hash, manifest_json, concurrency, output_dir, status, cancel_requested, created_at, updated_at)
          VALUES (?,?,?,?,?,?,0,?,?)`)
        .run(manifest.jobKey, manifestHash, manifestJson, manifest.concurrency, outputDir, JOB_STATUS.PENDING, nowIso(), nowIso());
      job = db.prepare(`SELECT * FROM local_batch_jobs WHERE id=?`).get(Number(info.lastInsertRowid));
      created = true;
    } else if (job.manifest_hash !== manifestHash) {
      FAIL("job_key_manifest_conflict", { jobKey: manifest.jobKey, jobId: job.id },
        "同一 jobKey 已用于不同内容的 manifest：拒绝覆盖，请使用新的 jobKey");
    } else if (job.output_dir !== outputDir) {
      FAIL("job_output_dir_conflict", { jobKey: manifest.jobKey, jobId: job.id },
        "同一 jobKey 已登记不同的输出根目录：请使用创建时的输出目录");
    }
    if (created) {
      const itemIds = new Map();
      for (const item of manifest.items) {
        const info = db.prepare(`INSERT INTO local_batch_items
            (job_id, item_key, enterprise_key, source_system, enterprise_name, account_set_id, account_set_source, status, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(job.id, item.itemKey, item.source.enterpriseKey, item.source.system, item.source.enterpriseName,
            item.accountSetId ?? null, item.accountSetId ? "manifest" : null, ITEM_STATUS.PENDING, nowIso(), nowIso());
        itemIds.set(item.itemKey, Number(info.lastInsertRowid));
      }
      for (const plan of plans) {
        const itemId = itemIds.get(plan.itemKey);
        if (!itemId) FAIL("job_plan_item_missing", { itemKey: plan.itemKey });
        for (const stage of plan.stages) {
          db.prepare(`INSERT INTO local_batch_stages
              (item_id, period, stage_key, stage_order, spec_json, status, attempt, input_hash, updated_at)
              VALUES (?,?,?,?,?,?,0,?,?)`)
            .run(itemId, stage.period, stage.stageKey, stage.order, canonicalJson(stage.spec), STAGE_STATUS.PENDING, stage.inputHash, nowIso());
        }
      }
      for (const input of inputs) {
        const itemId = itemIds.get(input.itemKey);
        if (!itemId) FAIL("job_plan_item_missing", { itemKey: input.itemKey });
        db.prepare(`INSERT INTO local_batch_inputs
            (input_key, job_id, item_id, period, batch_id, source_path, source_hash, bytes, content, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(`${job.id}:${itemId}:${input.batchId}`, job.id, itemId, input.period, input.batchId,
            input.sourcePath ?? null, input.sourceHash, input.bytes.length, input.bytes, nowIso());
      }
    }
    db.exec("COMMIT");
    return { job, created };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 以回滚结果为准 */ }
    throw error;
  }
}

export function getJobByKey(db, jobKey) {
  return db.prepare(`SELECT * FROM local_batch_jobs WHERE job_key=?`).get(jobKey) || null;
}

export function getJob(db, jobId) {
  return db.prepare(`SELECT * FROM local_batch_jobs WHERE id=?`).get(jobId) || null;
}

export function listItems(db, jobId) {
  return db.prepare(`SELECT * FROM local_batch_items WHERE job_id=? ORDER BY id`).all(jobId);
}

export function getItem(db, itemId) {
  return db.prepare(`SELECT * FROM local_batch_items WHERE id=?`).get(itemId) || null;
}

export function setItemAccountSet(db, { itemId, accountSetId, source }) {
  db.prepare(`UPDATE local_batch_items SET account_set_id=?, account_set_source=?, updated_at=? WHERE id=?`)
    .run(accountSetId, source, nowIso(), itemId);
}

export function listStages(db, itemId) {
  return db.prepare(`SELECT * FROM local_batch_stages WHERE item_id=? ORDER BY period, stage_order, id`).all(itemId);
}

export function getStage(db, stageId) {
  return db.prepare(`SELECT * FROM local_batch_stages WHERE id=?`).get(stageId) || null;
}

export function listArtifacts(db, itemId) {
  return db.prepare(`SELECT * FROM local_batch_artifacts WHERE item_id=? ORDER BY period, stage_key, id`).all(itemId);
}

export function getArtifactByStage(db, { itemId, period, stageKey }) {
  return db.prepare(`SELECT * FROM local_batch_artifacts WHERE item_id=? AND period=? AND stage_key=? ORDER BY id DESC LIMIT 1`)
    .get(itemId, period, stageKey) || null;
}

export function getSnapshot(db, { itemId, period, kind }) {
  return db.prepare(`SELECT * FROM local_batch_snapshots WHERE item_id=? AND period=? AND kind=?`)
    .get(itemId, period, kind) || null;
}

export function saveSnapshot(db, { jobId, itemId, period, kind, dtoHash, businessHash, dtoJson, csvText, csvHash }) {
  db.prepare(`INSERT INTO local_batch_snapshots
      (snapshot_key, job_id, item_id, period, kind, dto_hash, business_hash, dto_json, csv_text, csv_hash, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_key) DO UPDATE SET
        dto_hash=excluded.dto_hash, business_hash=excluded.business_hash,
        dto_json=excluded.dto_json, csv_text=excluded.csv_text, csv_hash=excluded.csv_hash`)
    .run(`${jobId}:${itemId}:${period}:${kind}`, jobId, itemId, period, kind, dtoHash, businessHash, dtoJson, csvText ?? null, csvHash ?? null, nowIso());
}

export function getInput(db, { jobId, itemId, batchId }) {
  return db.prepare(`SELECT * FROM local_batch_inputs WHERE input_key=?`)
    .get(`${jobId}:${itemId}:${batchId}`) || null;
}

/**
 * 单条输入快照的源证据核验：再次读取原始文件字节并与登记指纹比较。
 * 返回 { ok, problem, sourceHash, currentHash }：problem ∈ input_missing / input_changed。
 * 内联 payload（无外部文件）只有已保存快照本身可比，按 input_hash 前一步核验（见 actions）。
 */
export function checkInputEvidence(input) {
  if (!input) return { ok: false, problem: "input_snapshot_missing" };
  if (!input.source_path) return { ok: true, problem: null, external: false };
  let bytes = null;
  try { bytes = readFileSync(input.source_path); } catch { bytes = null; }
  if (!bytes) return { ok: false, problem: "input_missing", external: true, sourceHash: input.source_hash };
  const currentHash = sha256(bytes);
  if (currentHash !== input.source_hash) {
    return { ok: false, problem: "input_changed", external: true, sourceHash: input.source_hash, currentHash };
  }
  return { ok: true, problem: null, external: true, sourceHash: input.source_hash, currentHash };
}

/** 某 job 全部输入快照的源证据核验（普通续跑 / 首次执行前的统一入口）。 */
export function verifyInputEvidence(db, { jobId }) {
  const rows = db.prepare(`SELECT * FROM local_batch_inputs WHERE job_id=? ORDER BY item_id, period, batch_id`).all(jobId);
  const problems = [];
  for (const row of rows) {
    const check = checkInputEvidence(row);
    if (check.ok) continue;
    problems.push({
      itemId: row.item_id, period: row.period, batchId: row.batch_id,
      problem: check.problem, external: check.external === true,
    });
  }
  return { ok: problems.length === 0, checked: rows.length, problems };
}

// ---------------------------------------------------------------- 阶段状态
export function claimStage(db, { stageId, instance, token, inputHash }) {
  const info = db.prepare(`UPDATE local_batch_stages
      SET status=?, attempt=attempt+1, owner_instance=?, fencing_token=?, input_hash=COALESCE(?, input_hash),
          error_code=NULL, error_message=NULL, started_at=?, updated_at=?
      WHERE id=? AND status=?`)
    .run(STAGE_STATUS.RUNNING, instance, token, inputHash ?? null, nowIso(), nowIso(),
      stageId, STAGE_STATUS.PENDING);
  if (Number(info.changes) !== 1) return { claimed: false };
  const stage = getStage(db, stageId);
  return { claimed: true, attempt: stage.attempt, stage };
}

/**
 * 落阶段结果（CAS：status=running + owner + token + attempt 全中才生效）。
 * 调用方必须已在同一事务内执行过 fence 校验。
 */
export function writeStageResult(db, {
  stageId, instance, token, attempt, status, outcomeHash,
  evidence, errorCode, errorMessage,
}) {
  const info = db.prepare(`UPDATE local_batch_stages
      SET status=?, outcome_hash=?, evidence_json=?, error_code=?, error_message=?,
          finished_at=?, updated_at=?
      WHERE id=? AND status=? AND owner_instance=? AND fencing_token=? AND attempt=?`)
    .run(status, outcomeHash ?? null, canonicalJson(evidence ?? {}),
      errorCode ?? null, errorMessage ? String(errorMessage).slice(0, 500) : null,
      TERMINAL_OK.has(status) || status === STAGE_STATUS.FAILED || status === STAGE_STATUS.NEEDS_REVIEW || status === STAGE_STATUS.BLOCKED_DEPENDENCY ? nowIso() : null,
      nowIso(), stageId, STAGE_STATUS.RUNNING, instance, token, attempt);
  return Number(info.changes) === 1;
}

/**
 * 不经过 owner 的结果登记（用于接管已死 owner 后重置 / 取消等管理动作）。
 * evidence 可选：用于把「为什么停下」这类可审计原因写入阶段证据。
 */
export function resetStage(db, { stageId, status, errorCode, errorMessage, evidence }) {
  db.prepare(`UPDATE local_batch_stages
      SET status=?, error_code=?, error_message=?, evidence_json=COALESCE(?, evidence_json),
          owner_instance=NULL, fencing_token=NULL, updated_at=?
      WHERE id=?`)
    .run(status, errorCode ?? null, errorMessage ? String(errorMessage).slice(0, 500) : null,
      evidence === undefined ? null : canonicalJson(evidence), nowIso(), stageId);
}

// ---------------------------------------------------------------- 锁 / fencing
const nowMs = () => Date.now();

export function isProcessAlive(pid) {
  if (!isFiniteInt(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return null; // EPERM / 平台不确定：保守失败
  }
}

/**
 * 原子申请 / 续租锁。
 * - 自己已持有：续租（token 不变）；
 * - 他人在租约内：lock_active；
 * - 租约已过但 PID 仍存活或无法确认：owner_active（保守拒绝，不按超时抢锁）；
 * - 租约已过且 PID 确认不存在：递增 fence 接管。
 */
export function acquireLock(db, { resourceKey, instance, pid, leaseMs = 120000 }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`SELECT * FROM local_batch_locks WHERE resource_key=?`).get(resourceKey);
    const at = new Date(nowMs()).toISOString();
    const expires = new Date(nowMs() + leaseMs).toISOString();
    if (!row) {
      db.prepare(`INSERT INTO local_batch_locks
          (resource_key, owner_instance, fencing_token, pid, acquired_at, heartbeat_at, lease_expires_at)
          VALUES (?,?,1,?,?,?,?)`)
        .run(resourceKey, instance, pid ?? null, at, at, expires);
      db.exec("COMMIT");
      return { token: 1, acquired: true, takeover: false };
    }
    if (row.owner_instance === instance) {
      db.prepare(`UPDATE local_batch_locks SET heartbeat_at=?, lease_expires_at=?, pid=? WHERE resource_key=?`)
        .run(at, expires, pid ?? row.pid, resourceKey);
      db.exec("COMMIT");
      return { token: Number(row.fencing_token), acquired: true, takeover: false };
    }
    // 租约未到期但 owner 进程已**确认不存在**：可以直接接管（递增 fence），
    // 进程已死就不可能再提交；仅「存活或存活无法确认」才保守拒绝。
    if (row.lease_expires_at > at) {
      const aliveWhileLeased = isProcessAlive(Number(row.pid));
      if (aliveWhileLeased !== false) {
        FAIL("lock_active", {
          resourceKey, ownerInstance: row.owner_instance, leaseExpiresAt: row.lease_expires_at, pidAlive: aliveWhileLeased,
        });
      }
    } else {
      const alive = isProcessAlive(Number(row.pid));
      if (alive !== false) {
        FAIL("owner_active", {
          resourceKey, ownerInstance: row.owner_instance, pidAlive: alive, leaseExpiresAt: row.lease_expires_at,
        });
      }
    }
    const next = Number(row.fencing_token) + 1;
    const info = db.prepare(`UPDATE local_batch_locks
        SET owner_instance=?, fencing_token=?, pid=?, acquired_at=?, heartbeat_at=?, lease_expires_at=?
        WHERE resource_key=? AND owner_instance=? AND fencing_token=?`)
      .run(instance, next, pid ?? null, at, at, expires, resourceKey, row.owner_instance, row.fencing_token);
    if (Number(info.changes) !== 1) FAIL("lock_takeover_race", { resourceKey });
    db.exec("COMMIT");
    return { token: next, acquired: true, takeover: true, previousOwner: row.owner_instance };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 以回滚结果为准 */ }
    throw error;
  }
}

export function renewLock(db, { resourceKey, instance, token, leaseMs = 120000 }) {
  const at = new Date(nowMs()).toISOString();
  const expires = new Date(nowMs() + leaseMs).toISOString();
  const info = db.prepare(`UPDATE local_batch_locks SET heartbeat_at=?, lease_expires_at=?
      WHERE resource_key=? AND owner_instance=? AND fencing_token=?`)
    .run(at, expires, resourceKey, instance, token);
  if (Number(info.changes) !== 1) FAIL("fence_lost", { resourceKey });
  return { renewed: true };
}

export function releaseLock(db, { resourceKey, instance, token }) {
  const info = db.prepare(`DELETE FROM local_batch_locks
      WHERE resource_key=? AND owner_instance=? AND fencing_token=?`)
    .run(resourceKey, instance, token);
  return Number(info.changes) === 1;
}

/** 事务内 fence 校验：旧 token / 旧 owner 一律 fence_lost（必须在 BEGIN IMMEDIATE 内调用）。 */
export function assertFence(db, { resourceKey, instance, token }) {
  const row = db.prepare(`SELECT owner_instance, fencing_token FROM local_batch_locks WHERE resource_key=?`).get(resourceKey);
  if (!row || row.owner_instance !== instance || Number(row.fencing_token) !== Number(token)) {
    FAIL("fence_lost", { resourceKey, expectedToken: token, actual: row ? { owner: row.owner_instance, token: Number(row.fencing_token) } : null });
  }
}

/**
 * 在同一个 BEGIN IMMEDIATE 事务内执行「fence 校验 + 效果 + checkpoint」。
 * fn 内抛错时整体回滚（会计效果与 checkpoint 一起撤销）。
 */
export function withFencedTransaction(db, { resourceKey, instance, token }, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    assertFence(db, { resourceKey, instance, token });
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 以回滚结果为准 */ }
    throw error;
  }
}

/** 只读事务（一致快照读，不写任何表）。 */
export function withReadSnapshot(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 以回滚结果为准 */ }
    throw error;
  }
}

// ---------------------------------------------------------------- 状态汇总
const summarize = (stages) => {
  const counts = {};
  for (const stage of stages) counts[stage.status] = (counts[stage.status] || 0) + 1;
  return counts;
};

function statusFromCounts(counts) {
  if ((counts[STAGE_STATUS.RUNNING] || 0) > 0) return JOB_STATUS.RUNNING;
  if ((counts[STAGE_STATUS.NEEDS_REVIEW] || 0) > 0) return JOB_STATUS.NEEDS_REVIEW;
  if ((counts[STAGE_STATUS.BLOCKED_DEPENDENCY] || 0) > 0) return JOB_STATUS.NEEDS_REVIEW;
  if ((counts[STAGE_STATUS.FAILED] || 0) > 0) return JOB_STATUS.FAILED;
  if ((counts[STAGE_STATUS.PENDING] || 0) > 0) return JOB_STATUS.PENDING;
  if ((counts[STAGE_STATUS.CANCELLED] || 0) > 0 || (counts[STAGE_STATUS.CANCEL_REQUESTED] || 0) > 0) return JOB_STATUS.CANCELLED;
  if (Object.keys(counts).every((status) => TERMINAL_OK.has(status))) return JOB_STATUS.SUCCEEDED;
  return JOB_STATUS.PENDING;
}

/** 依据阶段真实状态刷新 item / job 状态与 error_code。 */
export function refreshStatuses(db, jobId) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const items = listItems(db, jobId);
    const job = getJob(db, jobId);
    const perJob = [];
    for (const item of items) {
      const stages = listStages(db, item.id);
      const counts = summarize(stages);
      const status = statusFromCounts(counts);
      const firstProblem = stages.find((stage) => [
        STAGE_STATUS.FAILED, STAGE_STATUS.NEEDS_REVIEW, STAGE_STATUS.BLOCKED_DEPENDENCY,
      ].includes(stage.status));
      db.prepare(`UPDATE local_batch_items SET status=?, error_code=?, updated_at=? WHERE id=?`)
        .run(status, firstProblem?.error_code ?? null, nowIso(), item.id);
      perJob.push({ status, counts });
    }
    const jobStatus = (() => {
      const statuses = perJob.map((entry) => entry.status);
      if (job.cancel_requested === 1 && !statuses.includes(JOB_STATUS.RUNNING)) {
        const anyCancelled = perJob.some((entry) => (entry.counts[STAGE_STATUS.CANCELLED] || 0) > 0);
        if (anyCancelled) return JOB_STATUS.CANCELLED;
      }
      if (statuses.includes(JOB_STATUS.RUNNING)) return JOB_STATUS.RUNNING;
      if (statuses.includes(JOB_STATUS.NEEDS_REVIEW)) return JOB_STATUS.NEEDS_REVIEW;
      if (statuses.includes(JOB_STATUS.FAILED)) return JOB_STATUS.FAILED;
      if (statuses.includes(JOB_STATUS.PENDING)) return JOB_STATUS.PENDING;
      if (statuses.every((status) => status === JOB_STATUS.SUCCEEDED)) return JOB_STATUS.SUCCEEDED;
      if (statuses.every((status) => status === JOB_STATUS.SUCCEEDED || status === JOB_STATUS.CANCELLED)) return JOB_STATUS.CANCELLED;
      return JOB_STATUS.NEEDS_REVIEW;
    })();
    db.prepare(`UPDATE local_batch_jobs SET status=?, updated_at=? WHERE id=?`).run(jobStatus, nowIso(), jobId);
    db.exec("COMMIT");
    return jobStatus;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 以回滚结果为准 */ }
    throw error;
  }
}

/** 只读状态报告（供 CLI status 使用；不写任何表）。 */export function readJobStatus(db, jobKey) {
  const job = getJobByKey(db, jobKey);
  if (!job) FAIL("job_not_found", { jobKey });
  const items = listItems(db, job.id).map((item) => {
    const stages = listStages(db, item.id).map((stage) => ({
      period: stage.period,
      stageKey: stage.stage_key,
      status: stage.status,
      attempt: stage.attempt,
      inputHash: stage.input_hash,
      outcomeHash: stage.outcome_hash,
      errorCode: stage.error_code,
      evidence: safeJson(stage.evidence_json),
      ownerInstance: stage.owner_instance,
      fencingToken: stage.fencing_token,
      startedAt: stage.started_at,
      finishedAt: stage.finished_at,
    }));
    return {
      itemKey: item.item_key,
      enterpriseKey: item.enterprise_key,
      accountSetId: item.account_set_id,
      status: item.status,
      errorCode: item.error_code,
      stages,
      artifacts: listArtifacts(db, item.id).map((artifact) => ({
        artifactKey: artifact.artifact_key,
        period: artifact.period,
        stageKey: artifact.stage_key,
        kind: artifact.kind,
        format: artifact.format,
        status: artifact.status,
        bytes: artifact.bytes,
        bytesHash: artifact.bytes_hash,
        relativePath: artifact.relative_path,
        workerThreadId: artifact.worker_thread_id,
        renderStarted: artifact.render_started,
        renderFinished: artifact.render_finished,
      })),
    };
  });
  return {
    jobKey: job.job_key,
    jobId: job.id,
    status: job.status,
    concurrency: job.concurrency,
    outputDir: job.output_dir,
    cancelRequested: job.cancel_requested === 1,
    manifestHash: job.manifest_hash,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    items,
  };
}

export function safeJson(text) {
  try { return JSON.parse(text || "{}") ?? {}; } catch { return {}; }
}

// ---------------------------------------------------------------- manifest 文件 + 阶段计划
/**
 * 读取 manifest 文件：一次取得字节，hash 与 JSON 解析使用**同一份字节**。
 * 本文件不打开数据库，因此 CLI 可以在任何库操作之前完成 manifest 形状校验。
 */
export function readManifestFile(manifestPath) {
  const absolute = resolve(manifestPath);
  if (!existsSync(absolute)) FAIL("manifest_not_found", { manifestPath });
  const stat = statSync(absolute);
  if (!stat.isFile()) FAIL("manifest_not_file", { manifestPath });
  if (stat.size === 0) FAIL("manifest_empty", { manifestPath });
  if (stat.size > MANIFEST_LIMITS.manifestBytes) FAIL("manifest_too_large", { bytes: stat.size });
  const bytes = readFileSync(absolute);
  if (bytes.length !== stat.size) FAIL("manifest_read_incomplete", {});
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { FAIL("manifest_invalid_json", {}); }
  return { path: absolute, dir: dirname(absolute), bytes, hash: sha256(bytes), manifest: parsed };
}

function payloadFromFile(manifestDir, relativePath) {
  const baseReal = realpathSync(manifestDir);
  const absolute = resolve(manifestDir, relativePath);
  let real;
  try { real = realpathSync(absolute); } catch { FAIL("payload_file_missing", { payloadFile: relativePath }); }
  if (real !== baseReal && !real.startsWith(baseReal + sep)) FAIL("payload_path_escape", { payloadFile: relativePath });
  const stat = statSync(real);
  if (!stat.isFile()) FAIL("payload_not_file", { payloadFile: relativePath });
  if (stat.size === 0) FAIL("payload_empty", { payloadFile: relativePath });
  if (stat.size > MANIFEST_LIMITS.payloadBytes) FAIL("payload_too_large", { payloadFile: relativePath, bytes: stat.size });
  const bytes = readFileSync(real);
  if (bytes.length !== stat.size) FAIL("payload_read_incomplete", { payloadFile: relativePath });
  assertPayloadObject(bytes, relativePath);
  return { bytes, sourcePath: real };
}

function assertPayloadObject(bytes, label) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { FAIL("payload_invalid_json", { payloadFile: label }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) FAIL("payload_not_object", { payloadFile: label });
  return value;
}

/**
 * 把已校验的 manifest 展开为 items / stages / 输入快照（纯函数，不写库）。
 * 阶段顺序固定：import(s) → post → depreciation → carryforward → period-check → close → reports。
 */
export function buildPlan({ manifest, manifestDir }) {
  const plans = [];
  const inputs = [];
  for (const item of manifest.items) {
    const stages = [];
    let order = 0;
    const push = (period, stageKey, spec, inputHash) => {
      order += 1;
      stages.push({ period, stageKey, order, spec, inputHash });
    };
    const stageHash = (period, stageKey, spec) => sha256(canonicalJson({
      jobKey: manifest.jobKey, itemKey: item.itemKey, period, stageKey, spec,
    }));
    for (const periodSpec of item.periods) {
      const period = periodSpec.period;
      for (const raw of periodSpec.imports) {
        let bytes;
        let sourcePath = null;
        if (raw.payloadFile) {
          const file = payloadFromFile(manifestDir, raw.payloadFile);
          bytes = file.bytes;
          sourcePath = file.sourcePath;
        } else {
          bytes = Buffer.from(canonicalJson(raw.payload), "utf8");
          assertPayloadObject(bytes, "inline");
        }
        const payloadHash = sha256(bytes);
        inputs.push({ itemKey: item.itemKey, period, batchId: raw.batchId, sourcePath, sourceHash: payloadHash, bytes });
        const spec = {
          batchId: raw.batchId, mode: raw.mode,
          confirmNewBinding: raw.confirmNewBinding === true, payloadHash,
        };
        push(period, `${STAGE_KEYS.IMPORT}:${raw.batchId}`, spec, stageHash(period, `${STAGE_KEYS.IMPORT}:${raw.batchId}`, spec));
      }
      if (periodSpec.post) {
        const spec = { vouchers: periodSpec.post.vouchers };
        push(period, STAGE_KEYS.POST, spec, stageHash(period, STAGE_KEYS.POST, spec));
      }
      if (periodSpec.depreciation) {
        const spec = {};
        push(period, STAGE_KEYS.DEPRECIATION, spec, stageHash(period, STAGE_KEYS.DEPRECIATION, spec));
      }
      if (periodSpec.carryforward) {
        const spec = { yearEnd: periodSpec.carryforward.yearEnd === true };
        push(period, STAGE_KEYS.CARRYFORWARD, spec, stageHash(period, STAGE_KEYS.CARRYFORWARD, spec));
      }
      if (periodSpec.periodCheck) {
        const spec = {};
        push(period, STAGE_KEYS.PERIOD_CHECK, spec, stageHash(period, STAGE_KEYS.PERIOD_CHECK, spec));
      }
      if (periodSpec.close) {
        const spec = {};
        push(period, STAGE_KEYS.CLOSE, spec, stageHash(period, STAGE_KEYS.CLOSE, spec));
      }
      for (const report of periodSpec.reports) {
        for (const format of report.formats) {
          const stageKey = `${STAGE_KEYS.REPORT}:${report.kind}:${format}${report.code ? `:${report.code}` : ""}`;
          const spec = { kind: report.kind, format, code: report.code ?? null };
          push(period, stageKey, spec, stageHash(period, stageKey, spec));
        }
      }
    }
    plans.push({ itemKey: item.itemKey, stages });
  }
  return { plans, inputs };
}

/** 锁表快照（只读，供测试与诊断；不含绝对路径）。 */
export function listLocks(db) {
  return db.prepare(`SELECT * FROM local_batch_locks ORDER BY resource_key`).all();
}
/** 为新进程生成实例标识：随机 ID + PID 存活证据（不含主机名 / 路径）。 */
export function newInstanceId(pid = process.pid) {
  return `runner-${pid}-${randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------- 取消 / 重试
/**
 * 请求取消：只登记用户意图。正在执行（running）的阶段不会被伪报 cancelled，
 * 由持有 job 锁的执行者在阶段边界确认；无执行者时可由本命令直接确认。
 */
export function requestCancel(db, jobKey, { pid = process.pid, instance = newInstanceId(pid) } = {}) {
  const job = getJobByKey(db, jobKey);
  if (!job) FAIL("job_not_found", { jobKey });
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE local_batch_jobs SET cancel_requested=1, updated_at=? WHERE id=?`).run(nowIso(), job.id);
    const jobLock = db.prepare(`SELECT * FROM local_batch_locks WHERE resource_key=?`).get(`job:${job.id}`);
    const ownerActive = !!jobLock && jobLock.lease_expires_at > nowIso() && isProcessAlive(Number(jobLock.pid)) !== false;
    let confirmed = 0;
    let running = 0;
    if (!ownerActive) {
      const items = listItems(db, job.id);
      for (const item of items) {
        for (const stage of listStages(db, item.id)) {
          if (stage.status === STAGE_STATUS.PENDING) {
            resetStage(db, { stageId: stage.id, status: STAGE_STATUS.CANCELLED, errorCode: "cancelled_by_operator" });
            confirmed += 1;
          } else if (stage.status === STAGE_STATUS.RUNNING) running += 1;
        }
      }
      if (jobLock && isProcessAlive(Number(jobLock.pid)) === false) {
        db.prepare(`DELETE FROM local_batch_locks WHERE resource_key=?`).run(`job:${job.id}`);
      }
    }
    db.exec("COMMIT");
    const status = refreshStatuses(db, job.id);
    return {
      jobKey, jobId: job.id, status, cancelRequested: true,
      confirmedStages: confirmed, ownerActive, runningStages: running,
      detail: ownerActive
        ? "已登记取消请求：执行者仍在运行，将在当前阶段结束后停止后续阶段（不伪报 cancelled）"
        : "已登记取消请求并确认未开始的阶段为 cancelled；已提交的会计动作不倒撤",
    };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 以回滚结果为准 */ }
    throw error;
  }
}

/**
 * 显式 retry：只把选定的 failed / needs_review / blocked_dependency / cancelled 未完成阶段重开为
 * pending。succeeded / not_applicable 一律不动（不重跑已成功副作用）。
 * 同时核验输入指纹（manifest + 原始资料快照），变化则给 input_changed。
 */
export function resetStagesForRetry(db, { jobKey, itemKey = null, period = null, stageKey = null, allowSnapshotOnly = false }) {
  const job = getJobByKey(db, jobKey);
  if (!job) FAIL("job_not_found", { jobKey });
  const manifest = safeJson(job.manifest_json);
  const items = listItems(db, job.id).filter((item) => !itemKey || item.item_key === itemKey);
  if (itemKey && !items.length) FAIL("job_item_not_found", { jobKey, itemKey });
  if (job.cancel_requested === 1) {
    db.prepare(`UPDATE local_batch_jobs SET cancel_requested=0, updated_at=? WHERE id=?`).run(nowIso(), job.id);
  }
  const reopened = [];
  const skipped = [];
  const inputNotes = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of items) {
      const itemManifest = manifest.items.find((entry) => entry.itemKey === item.item_key) || {};
      const stages = listStages(db, item.id).filter((stage) => (
        (!period || stage.period === period) && (!stageKey || stage.stage_key === stageKey)
      ));
      for (const stage of stages) {
        if (TERMINAL_OK.has(stage.status) || stage.status === STAGE_STATUS.RUNNING) {
          skipped.push({ itemKey: item.item_key, period: stage.period, stageKey: stage.stage_key, status: stage.status });
          continue;
        }
        const spec = safeJson(stage.spec_json);
        if (stage.stage_key.startsWith(`${STAGE_KEYS.IMPORT}:`)) {
          const batchId = spec.batchId;
          const input = getInput(db, { jobId: job.id, itemId: item.id, batchId });
          if (!input) {
            inputNotes.push({ itemKey: item.item_key, batchId, problem: "snapshot_missing" });
            resetStage(db, { stageId: stage.id, status: STAGE_STATUS.NEEDS_REVIEW, errorCode: "input_snapshot_missing" });
            continue;
          }
          if (input.source_path) {
            const onDisk = existsSync(input.source_path) ? statSync(input.source_path).size : null;
            if (onDisk === null) {
              if (!allowSnapshotOnly) {
                inputNotes.push({ itemKey: item.item_key, batchId, problem: "input_missing" });
                resetStage(db, { stageId: stage.id, status: STAGE_STATUS.NEEDS_REVIEW, errorCode: "input_missing" });
                continue;
              }
              inputNotes.push({ itemKey: item.item_key, batchId, problem: "using_saved_snapshot" });
            } else {
              const bytes = readFileBytes(input.source_path);
              if (!bytes || sha256(bytes) !== input.source_hash) {
                if (!allowSnapshotOnly) {
                  inputNotes.push({ itemKey: item.item_key, batchId, problem: "input_changed" });
                  resetStage(db, { stageId: stage.id, status: STAGE_STATUS.NEEDS_REVIEW, errorCode: "input_changed" });
                  continue;
                }
                inputNotes.push({ itemKey: item.item_key, batchId, problem: "input_changed_using_saved_snapshot" });
              }
            }
          }
        }
        resetStage(db, { stageId: stage.id, status: STAGE_STATUS.PENDING });
        reopened.push({ itemKey: item.item_key, period: stage.period, stageKey: stage.stage_key });
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 以回滚结果为准 */ }
    throw error;
  }
  const status = refreshStatuses(db, job.id);
  return { jobKey, jobId: job.id, status, reopened, skipped, inputNotes, manifestItems: manifest.items.length };
}

function readFileBytes(path) {
  try {
    // 只在 retry 校验时读取源文件；读取失败按「缺失 / 不可读」处理，不静默换文件。
    return readFileSync(path);
  } catch { return null; }
}

// ---------------------------------------------------------------- 明细：供 actions / runner 使用
export function listPendingStages(db, itemId) {
  return db.prepare(`SELECT * FROM local_batch_stages WHERE item_id=? AND status=? ORDER BY period, stage_order, id`)
    .all(itemId, STAGE_STATUS.PENDING);
}

export function listStagesByStatus(db, jobId, statuses) {
  const placeholders = statuses.map(() => "?").join(",");
  return db.prepare(`SELECT s.*, i.job_id AS job_id, i.item_key AS item_key, i.enterprise_key AS enterprise_key,
                            i.account_set_id AS account_set_id
                       FROM local_batch_stages s JOIN local_batch_items i ON i.id = s.item_id
                      WHERE i.job_id=? AND s.status IN (${placeholders})
                      ORDER BY i.id, s.period, s.stage_order, s.id`).all(jobId, ...statuses);
}

export function markItemNeedsReview(db, { itemId, stageId, status, errorCode, errorMessage, evidence }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (stageId) {
      db.prepare(`UPDATE local_batch_stages SET status=?, error_code=?, error_message=?, evidence_json=?, updated_at=?
          WHERE id=?`).run(status, errorCode ?? null, errorMessage ? String(errorMessage).slice(0, 500) : null,
        canonicalJson(evidence ?? {}), nowIso(), stageId);
    }
    db.prepare(`UPDATE local_batch_items SET status=?, error_code=?, updated_at=? WHERE id=?`)
      .run(status === STAGE_STATUS.CANCELLED ? ITEM_STATUS.CANCELLED : ITEM_STATUS.NEEDS_REVIEW, errorCode ?? null, nowIso(), itemId);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 以回滚结果为准 */ }
    throw error;
  }
}

export { DatabaseSync };