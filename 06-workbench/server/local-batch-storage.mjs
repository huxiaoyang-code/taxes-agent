import { assertRestoreWritable } from './local-restore-control.mjs';
import { assertWriteCommitFence, authorizesResourceRenewal } from './local-write-lock.mjs';
import { hasActiveAuditExecution,withAuditSavepoint } from './local-audit-storage.mjs';
// local-batch-storage.mjs — 持久批量任务（LOCAL-07）的存储层：manifest 校验 / 任务 / 阶段 /
// 锁与 fencing / 输入快照 / 报表产物元数据 / 状态汇总。
//
// 设计约束：
// 1) 本文件**不** import db.mjs（也不 import accounting / import-incremental 等会打开 DB 的模块）。
//    所有函数显式接收 node:sqlite 的 DatabaseSync 句柄，因此 CLI 可以在「只解析参数 + 只读检查
//    数据目录」之后才决定是否打开 / 迁移业务库；status 只读命令也只使用本文件。
// 2) 任务、阶段、锁、输入快照、产物元数据全部落在**同一个** workbench.db（local_batch_ 前缀 +
//    独立 component 版本表），这样业务状态与 checkpoint 处于同一备份时点。不另建队列 DB。
// 3) 现库安装 / v1/v2→v3 必须显式 async installBatchSchema 并经官方一致备份保护。
//    同步 ensure 只校验严格v3，或在**显式新目标**（没有任何 workbench.db）上初始化结构，
//    且必须持有本进程 claimFreshDataDir 的独占回执（O_EXCL 标记 + 库文件 dev/ino 绑定）；
//    布尔 fresh / 自造回执无效。已有库不自动建表 / 升级；零字节 / 非产品库不能偷当fresh。
// 4) 同账套跨进程互斥用数据库行锁 + 单调 fencing token + 租约；租约过期不等于旧执行者已死：
//    PID 仍存活或权限不确定时保守拒绝（owner_active），只有「租约过期且 PID 已确认不存在」才接管
//    并递增 fence，旧 token 的任何提交都会被事务内 fence 校验拒绝。

import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as guard from "./database-open-guard.mjs";
import { inspectAuditSchema, sqlReferencesNamespace } from "./local-audit-storage.mjs";

export const LOCAL_BATCH_COMPONENT = "local-batch";
export const LOCAL_BATCH_SCHEMA_VERSION = 3;

/** 新建目标的所有权标记文件：与 workbench.db 同目录，只在「建立批量结构」窗口内存在。 */
export const FRESH_CLAIM_MARKER = ".local-batch-create";

export const LOCAL_BATCH_V1_TABLES = [
  "local_batch_component",
  "local_batch_jobs",
  "local_batch_items",
  "local_batch_stages",
  "local_batch_locks",
  "local_batch_artifacts",
  "local_batch_snapshots",
  "local_batch_inputs",
];

export const LOCAL_BATCH_V2_TABLES = [...LOCAL_BATCH_V1_TABLES, 'local_batch_database_instances', 'local_batch_job_bindings', 'local_batch_input_bindings'];
export const LOCAL_BATCH_TABLES = [...LOCAL_BATCH_V2_TABLES, 'local_batch_lock_epochs'];

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

/** Windows 路径比较：realpath 可能改变盘符 / 大小写；NTFS 默认大小写不敏感。 */
function sameCanonicalPath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * 数据目录路径身份校验：必须是真实目录，不能是符号链接 / junction，
 * realpath 必须与显式路径一致（防止指到别的目录 / 别人的库）。
 * 目录不存在时不报错（由调用方决定是否允许新建）。
 */
export function assertDataDirIdentity(dataDir) {
  if (typeof dataDir !== "string" || !String(dataDir).trim()) FAIL("data_dir_required");
  const resolved = resolve(dataDir);
  if (resolved === parse(resolved).root) FAIL("data_dir_invalid", {}, "--data-dir 不能是文件系统根目录");
  let stat;
  try { stat = lstatSync(resolved); } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, path: resolved };
    FAIL("data_dir_unreadable", { dataDir: basename(resolved) }, "数据目录无法读取");
  }
  if (stat.isSymbolicLink()) FAIL("data_dir_alias", { dataDir: basename(resolved) }, "--data-dir 不能是符号链接 / junction");
  if (!stat.isDirectory()) FAIL("data_dir_invalid", { dataDir: basename(resolved) }, "--data-dir 必须是目录");
  let real;
  try { real = realpathSync(resolved); } catch { FAIL("data_dir_unreadable", { dataDir: basename(resolved) }); }
  if (!sameCanonicalPath(real, resolved)) {
    FAIL("data_dir_alias", { dataDir: basename(resolved) }, "--data-dir 解析后的真实目录与显式路径不一致（别名 / junction）");
  }
  return { exists: true, path: resolved, realPath: real };
}

/**
 * 判断是否可以安全初始化：只允许「数据目录里根本没有 workbench.db」的显式新目标。
 * 已有库一律要求先走 LOCAL-06 一致备份（依赖未合并时返回 dependency_unavailable）。
 * 注意：**零字节 workbench.db 也按既有库拒绝**（不能以「文件为空」绕过现库门槛）。
 */
export function assertInitializable(dataDir) {
  const identity = assertDataDirIdentity(dataDir);
  const resolved = identity.path;
  const state = inspectDataDir(resolved);
  if (!state.readable && state.exists) {
    FAIL("database_unreadable", { dataDir: basename(resolved), reason: state.error }, "数据目录中的 workbench.db 无法只读打开");
  }
  if (!state.exists) return { fresh: true, state };
  if (state.batchVersion === LOCAL_BATCH_SCHEMA_VERSION) return { fresh: false, state };
  if (state.batchVersion === null || state.batchVersion === 0) {
    FAIL(
      "migration_requires_backup",
      {
        dataDir: basename(resolved), dependency: "LOCAL-06 createBackup/verifyBackup", status: "dependency_unavailable",
        batchVersion: state.batchVersion, coreVersion: state.coreVersion, hasBusinessContent: state.hasBusinessContent,
        bytes: state.bytes,
      },
      "请先执行 install --data-dir <目录> --out-dir <全新备份目录>：既有库安装需要官方一致备份",
    );
  }
  FAIL("migration_requires_backup", {
    dataDir: basename(resolved), dependency: "LOCAL-06 createBackup/verifyBackup", status: "dependency_unavailable",
    batchVersion: state.batchVersion, target: LOCAL_BATCH_SCHEMA_VERSION,
  });
}

// ---------------------------------------------------------------- 新建目标独占事实
// 创建事实（目录 / 库路径 / 标记路径 / fstat(fd) 身份 / nonce / 创建句柄）只保存在
// database-open-guard.mjs 的模块私有 WeakMap 里；本模块对外只持有「空 token」。
// 因此调用方改 token 字段、改嵌套值、复制 / 伪造 / 删字段都不能改变授权目标。
// 页 1 种子也由 guard 用**创建时持有的 fd** 写入（不经路径重新打开）：按路径替换 / ABA 换回
// 都不能让这段写入落到外部文件上。

/**
 * 原子占有「显式新目标」：不存在则创建目录，然后以 O_EXCL 建立所有权标记与库文件。
 * 只有拿到回执的进程才拥有「本次亲手创建」资格；并发的另一个进程会稳定失败，
 * 只有在其能确认完整已初始化批量结构时才允许按已有库路径继续（由调用方判断）。
 * 返回的 token 不携带任何可变授权字段（内部事实见 database-open-guard.mjs）。
 */
export function claimFreshDataDir(dataDir, { pid = process.pid } = {}) {
  if (typeof dataDir !== "string" || !String(dataDir).trim()) FAIL("data_dir_required");
  const resolved = resolve(dataDir);
  if (resolved === parse(resolved).root) FAIL("data_dir_invalid", {}, "--data-dir 不能是文件系统根目录");
  if (existsSync(resolved)) {
    assertDataDirIdentity(resolved);
    const entries = readdirSync(resolved);
    if (entries.includes(FRESH_CLAIM_MARKER)) {
      FAIL("fresh_target_claimed", { dataDir: basename(resolved) },
        "新目标已被另一个执行者占用：不帮忙修半库；可稍后重试或确认结构完整后按已有库继续");
    }
    if (existsSync(join(resolved, "workbench.db"))) {
      FAIL("fresh_target_not_fresh", { dataDir: basename(resolved) }, "目标已有 workbench.db：不接受新建占用");
    }
    if (entries.length) {
      FAIL("data_dir_not_empty", { dataDir: basename(resolved), entryCount: entries.length },
        "显式新目标必须为空目录（拒绝在他人目录中创建库）");
    }
  } else {
    mkdirSync(resolved, { recursive: true });
    assertDataDirIdentity(resolved);
  }
  const markerPath = join(resolved, FRESH_CLAIM_MARKER);
  // nonce 是 31 位正整数（写进页 1 的 user_version）。它是**本地随机识别标记**，不是秘密认证凭据：
  // 所有权标记 JSON、页 1 头部与 describeFreshClaim / 测试诊断都会出现它；真正授权来自
  // database-open-guard.mjs 的私有 WeakMap + 创建 fd + 实际连接 / 路径核验。
  const nonce = guard.newClaimNonce();
  const dbPath = join(resolved, "workbench.db");
  const markerContent = JSON.stringify({ nonce, pid, at: nowIso() });

  /**
   * 只删除「O_EXCL 创建时并就被证明属于本进程、且内容仍是本进程写下的那份」的所有权标记。
   * nonce 会明文出现在标记 JSON / 页 1 / 诊断输出里，**不是秘密**，所以「内容命中 nonce」不能当
   * 删除依据：同一个 nonce 的新文件对象（哪怕字节完全相同）或加了额外字段的外部标记都必须保留。
   * 因此本地身份只允许来自**创建时**的 `fstat(markerFd)` 快照（由调用方传入），绝不在这里按路径重新认领当前对象。
   */
  function discardOwnMarker(markerIdentity) {
    if (!markerIdentity) return false;
    try {
      const stat = lstatSync(markerPath);
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
      if (String(stat.dev) !== String(markerIdentity.dev)) return false;
      if (String(stat.ino) !== String(markerIdentity.ino)) return false;
      if (readFileSync(markerPath, "utf8") !== markerContent) return false;
      unlinkSync(markerPath);
      return true;
    } catch {
      return false; // 标记被替换 / 删除 / 内容被改写：不碰他人对象
    }
  }

  let markerFd;
  try {
    markerFd = openSync(markerPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") FAIL("fresh_target_claimed", { dataDir: basename(resolved) });
    throw batchError("fresh_target_claim_failed", { reason: error?.code || String(error) });
  }
  // 所有权标记同样要绑定**创建时的不可变事实**：O_EXCL 之后立刻用创建 fd `fstat` 抓身份，
  // 之后把同一个 fd 交给 guard 存进模块私有 facts（删除 / 校验时只比对这份身份 + 期望内容）。
  // 取不到身份时**不删**任何标记（不能拿「该路径刚被本进程 O_EXCL 建过」当删除依据）。
  let markerIdentity = null;
  try {
    const markerStat = fstatSync(markerFd);
    if (!markerStat.isFile()) {
      throw Object.assign(new Error("ownership marker is not a regular file"), { code: "marker_not_file" });
    }
    markerIdentity = { dev: String(markerStat.dev), ino: String(markerStat.ino) };
    writeFileSync(markerFd, markerContent, "utf8");
  } catch (error) {
    try { closeSync(markerFd); } catch { /* 句柄关闭失败不影响结论 */ }
    if (!markerIdentity) {
      throw batchError("fresh_claim_cleanup_required", {
        status: "manual_review_required", stage: "marker", reason: error?.code || String(error),
        dataDir: basename(resolved),
      }, "独占创建所有权标记后无法读取创建句柄身份：已保留标记现场，请人工核对后再继续");
    }
    discardOwnMarker(markerIdentity);
    throw batchError("fresh_target_claim_failed", {
      stage: "marker", reason: error?.code || String(error),
    }, "写入所有权标记失败");
  }
  // 同时原子创建库文件本身（O_EXCL），并**保留这个创建句柄**：guard 用 fstat(fd) 登记身份、
  // 用同一个 fd 写入页 1 种子，因此「探测后文件被替换 / ABA 换回」既不能通过身份校验，
  // 也不能把种子写进外部对象。
  let dbFd;
  try {
    dbFd = openSync(dbPath, "wx");
  } catch (error) {
    // 此刻标记创建句柄还**没有移交给 guard**（facts 未登记），因此本分支必须自己可靠关闭它，
    // 且与本进程能否删除标记无关：标记被换成外部对象时也要关闭自己的 fd，不能泄漏到进程结束。
    try { closeSync(markerFd); } catch { /* 句柄关闭失败不影响结论 */ }
    // 只清「创建身份 + 期望内容」都对得上的自己的标记；标记被换成别的内容 / 别的对象时保留现场。
    discardOwnMarker(markerIdentity);
    if (error?.code === "EEXIST") FAIL("fresh_target_claimed", { dataDir: basename(resolved) }, "目标库文件已被其它执行者创建");
    throw batchError("fresh_target_claim_failed", { reason: error?.code || String(error) });
  }
  let created;
  try { created = fstatSync(dbFd); } catch (error) {
    try { closeSync(dbFd); } catch { /* 句柄异常关闭失败不影响结论 */ }
    try { closeSync(markerFd); } catch { /* 标记句柄关闭不影响保留在现场的文件 */ }
    // fstat 失败 → 本进程拿不到任何创建身份证明：既不删库文件（可能已被换成外部对象），
    // 也不删所有权标记，保留现场并明确要求人工核对。不使用「该路径曾被本进程创建过」作为删除依据。
    throw batchError("fresh_claim_cleanup_required", {
      status: "manual_review_required", reason: error?.code || String(error), dataDir: basename(resolved),
    }, "独占创建后无法读取创建句柄身份：已保留库文件与所有权标记现场，请人工核对后再继续");
  }
  let token = null;
  try {
    token = guard.createFreshClaimFacts({
      dataDir: resolved, dbPath, markerPath, pid, nonce,
      identity: { dev: String(created.dev), ino: String(created.ino) }, fd: dbFd,
      markerFd, markerIdentity, markerContent,
    });
    guard.stampFreshClaimNonce(token);
    return token;
  } catch (error) {
    // 所有失败固定保留DB/WAL/SHM（含空文件/已写种子），不探测SQLite或删除库。
    // 只关闭本次创建fd、释放仍由创建身份和期望字节证明属于自己的marker。
    if (token) {
      try { guard.releaseFreshClaimFacts(token, { preserveDatabase: true }); } catch { /* 保留现场 */ }
    } else {
      try { closeSync(dbFd); } catch { /* 句柄关闭失败不影响结论 */ }
      try { closeSync(markerFd); } catch { /* 句柄关闭失败不影响结论 */ }
      discardOwnMarker(markerIdentity);
    }
    throw error;
  }
}

/**
 * 释放本进程所有权标记 / 创建句柄（重复 release 是无副作用的 no-op）。
 * 全部判断只读 guard 的模块私有创建事实；调用方 token 上的字段不参与。
 * 仅删除仍属于本进程的标记、关闭创建 fd；固定保留所有 DB / WAL / SHM 字节（包括空种子）。
 * 不为判断空库而重新打开 SQLite，避免同 inode 外部 WAL 的 SHM 被只读探测改变。
 * 失败后留下的种子用于诊断，不代表该路径可直接按 fresh 重试。
 */
export function releaseFreshClaim(receipt) {
  const result = guard.releaseFreshClaimFacts(receipt, { preserveDatabase: true });
  return result.released === true;
}

/**
 * 绑定「实际打开的库」身份：回执必须是本进程签发，标记仍是自己的，库文件不是符号链接，
 * 连接读到的页 1 nonce 属于本进程，dev/ino 在窗口内不变（guard 内部走 fstat(fd) + 路径复核）。
 */
export function assertFreshReceipt(receipt, db) {
  return guard.assertFreshClaimConnection(receipt, db);
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

const V2_STATEMENTS = [
 `CREATE TABLE local_batch_database_instances (
 instance_id TEXT PRIMARY KEY,
 parent_instance_id TEXT REFERENCES local_batch_database_instances(instance_id) ON DELETE RESTRICT,
 audit_instance_id TEXT UNIQUE,
 is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
 created_at TEXT NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN ('initial','restore-new')),
 write_state TEXT NOT NULL CHECK(write_state IN ('ready','restore_pending')),
 restore_operation_id TEXT,
 source_backup_digest TEXT,
 CHECK(parent_instance_id IS NULL OR parent_instance_id<>instance_id),
 CHECK((origin='initial' AND parent_instance_id IS NULL AND restore_operation_id IS NULL AND source_backup_digest IS NULL AND write_state='ready') OR
       (origin='restore-new' AND parent_instance_id IS NOT NULL AND restore_operation_id IS NOT NULL AND source_backup_digest IS NOT NULL))
 )`,
 `CREATE UNIQUE INDEX idx_local_batch_instances_active ON local_batch_database_instances(is_active) WHERE is_active=1`,
 `CREATE TABLE local_batch_job_bindings (
 database_instance_id TEXT NOT NULL REFERENCES local_batch_database_instances(instance_id) ON DELETE RESTRICT,
 job_id INTEGER NOT NULL REFERENCES local_batch_jobs(id) ON DELETE CASCADE,
 output_state TEXT NOT NULL CHECK(output_state IN ('bound','disabled')),
 output_root TEXT,
 bound_at TEXT NOT NULL,
 PRIMARY KEY(database_instance_id,job_id),
 CHECK((output_state='bound' AND output_root IS NOT NULL) OR (output_state='disabled' AND output_root IS NULL))
 )`,
 `CREATE TABLE local_batch_input_bindings (
 database_instance_id TEXT NOT NULL REFERENCES local_batch_database_instances(instance_id) ON DELETE RESTRICT,
 input_key TEXT NOT NULL REFERENCES local_batch_inputs(input_key) ON DELETE CASCADE,
 mode TEXT NOT NULL CHECK(mode IN ('source','inline','saved_snapshot','disabled')),
 source_path TEXT,
 bound_at TEXT NOT NULL,
 PRIMARY KEY(database_instance_id,input_key),
 CHECK((mode='source' AND source_path IS NOT NULL) OR (mode<>'source' AND source_path IS NULL))
 )`,
];
const V3_STATEMENTS = [`CREATE TABLE local_batch_lock_epochs (
 resource_key TEXT PRIMARY KEY,
 last_token INTEGER NOT NULL CHECK(last_token>=1)
 )`];
const batchTables = version => version===1 ? LOCAL_BATCH_V1_TABLES : version===2 ? LOCAL_BATCH_V2_TABLES : LOCAL_BATCH_TABLES;
const normalizeBatchSql = sql => sql===null?null:sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi,'').replace(/\s+/g,' ').trim();
export function batchSchemaFacts(db, version) {
 const tables=batchTables(version);
 const objects=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
  .filter(r=>tables.includes(r.tbl_name.toLowerCase())||r.name.toLowerCase().startsWith('local_batch_')||r.name.toLowerCase().startsWith('idx_local_batch_')||sqlReferencesNamespace(r.sql,'local_batch_'))
  .map(r=>({...r,sql:normalizeBatchSql(r.sql)}));
 return {version,objects,tables:tables.map(table=>({table,
  columns:db.prepare('SELECT * FROM pragma_table_xinfo(?) ORDER BY cid').all(table),
  attributes:db.prepare("SELECT type,ncol,wr,strict FROM pragma_table_list WHERE schema='main' AND name=?").get(table)??null,
  indexes:db.prepare('SELECT * FROM pragma_index_list(?) ORDER BY name').all(table).map(i=>({...i,keys:db.prepare('SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno').all(i.name)})),
  foreignKeys:db.prepare('SELECT * FROM pragma_foreign_key_list(?) ORDER BY id,seq').all(table),
 }))};
}
const batchContracts=new Map();
export function batchComponentContract(version) {
 if(![1,2,3].includes(version))FAIL('batch_schema_future_version');
 if(!batchContracts.has(version)) {
  const ref=new DatabaseSync(':memory:');
  try {for(const sql of SCHEMA_STATEMENTS)ref.exec(sql);if(version>=2)for(const sql of V2_STATEMENTS)ref.exec(sql);if(version===3)for(const sql of V3_STATEMENTS)ref.exec(sql);
   batchContracts.set(version,canonicalJson(batchSchemaFacts(ref,version)));
  }finally{ref.close();}
 }
 return {name:LOCAL_BATCH_COMPONENT,version,tables:[...batchTables(version)],facts:JSON.parse(batchContracts.get(version))};
}
const batchIso=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&!Number.isNaN(Date.parse(v))&&new Date(v).toISOString()===v;
const batchDigest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const batchUuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const batchTech=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const positive=v=>Number.isSafeInteger(v)&&v>0;
export function validResourceKey(v) {
 if(typeof v!=='string')return false;
 if(/^(?:job|account-set):[1-9][0-9]*$/.test(v))return positive(Number(v.slice(v.indexOf(':')+1)));
 if(!v.startsWith('book:'))return false;const key=v.slice(5);return key.length>0&&key.length<=128&&!/[\u0000-\u001f\u007f]/.test(key)&&key.normalize('NFKC').trim()===key;
}
const batchPath=v=>typeof v==='string'&&v.length>0&&!/[\u0000-\u001f\u007f]/.test(v)&&sameCanonicalPath(v,resolve(v))&&/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(v);
function readSavedJson(text) {
 const value=JSON.parse(text);
 // Batch's existing canonical serializer deliberately supports finite currency decimals.
 if(canonicalJson(value)!==text)FAIL('batch_content_invalid');return value;
}
/** Pure saved-row protocol checks. Never read historical source or output paths. */
function batchArtifactPath(jobKey,itemKey,period,spec) {
 const segment=(value,max)=>{
  const text=String(value??'');
  const cleaned=text.replace(/[^A-Za-z0-9._-]/g,'_').replace(/^\.+/,'_').slice(0,max)||'x';
  return /^[A-Za-z0-9._-]+$/.test(text)&&text.length<=max?cleaned:cleaned+'-'+sha256(text).slice(0,8);
 };
 const filename=spec.kind+(spec.code?'-'+segment(spec.code,32):'')+'-'+period+'.'+spec.format;
 return segment(jobKey,60)+'/'+segment(itemKey,60)+'/'+period+'/'+filename;
}
function batchReportRowsValid(db,{jobMap,itemMap,actualStages,expectedStages,snapshotRows,artifactRows}) {
 const stages=new Map(actualStages.map(r=>[r.item_id+':'+r.period+':'+r.stage_key,r]));
 const reportPlans=new Map();
 for(const stage of actualStages)if(stage.stage_key.startsWith('report:')) {
  const spec=expectedStages.get(stage.item_id+':'+stage.period+':'+stage.stage_key).spec;
  reportPlans.set(stage.item_id+':'+stage.period+':'+spec.kind,true);
 }
 const snapshots=new Map();
 for(const r of snapshotRows??db.prepare('SELECT * FROM local_batch_snapshots').all()) {
  const item=itemMap.get(r.item_id);
  if(!item||item.job_id!==r.job_id||!REPORT_KINDS.includes(r.kind)||!PERIOD_RE.test(r.period)
    ||!reportPlans.has(r.item_id+':'+r.period+':'+r.kind)
    ||r.snapshot_key!==r.job_id+':'+r.item_id+':'+r.period+':'+r.kind
    ||typeof r.dto_json!=='string'||!batchDigest(r.dto_hash)||sha256(r.dto_json)!==r.dto_hash
    ||!batchDigest(r.business_hash)||!batchIso(r.created_at))return false;
  const dto=JSON.parse(r.dto_json);
  if(!isPlainObject(dto)||JSON.stringify(dto)!==r.dto_json)return false;
  if((dto.kind!==undefined&&dto.kind!==r.kind)||(dto.period!==undefined&&dto.period!==r.period))return false;
  if(r.csv_text===null?r.csv_hash!==null:typeof r.csv_text!=='string'||!batchDigest(r.csv_hash)||sha256(r.csv_text)!==r.csv_hash)return false;
  snapshots.set(r.snapshot_key,r);
 }
 const artifacts=new Map();
 const mimes={csv:'text/csv; charset=utf-8',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pdf:'application/pdf'};
 for(const r of artifactRows??db.prepare('SELECT * FROM local_batch_artifacts').all()) {
  artifacts.set(r.item_id+':'+r.period+':'+r.stage_key,r);
  const item=itemMap.get(r.item_id),job=jobMap.get(r.job_id);
  const stage=stages.get(r.item_id+':'+r.period+':'+r.stage_key);
  if(!positive(r.id)||!item||item.job_id!==r.job_id||!job||!stage||!stage.stage_key.startsWith('report:'))return false;
  const spec=expectedStages.get(r.item_id+':'+r.period+':'+r.stage_key).spec;
  const snapshot=snapshots.get(r.job_id+':'+r.item_id+':'+r.period+':'+r.kind);
  if(!snapshot||!REPORT_KINDS.includes(r.kind)||!REPORT_FORMATS.includes(r.format)||r.kind!==spec.kind||r.format!==spec.format
    ||r.account_code!==(spec.code??null)||r.artifact_key!==job.job_key+'#'+item.item_key+'#'+r.period+'#'+r.stage_key
    ||!['publishing','published','invalid'].includes(r.status)||r.mime!==mimes[r.format]
    ||typeof r.relative_path!=='string'||r.relative_path!==batchArtifactPath(job.job_key,item.item_key,r.period,spec)
    ||!batchDigest(r.snapshot_hash)||!batchDigest(r.bytes_hash)||!positive(r.bytes)
    ||!positive(r.attempt)||r.attempt>stage.attempt||!batchIso(r.created_at)||!batchIso(r.updated_at))return false;
  const time=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  if(!time(r.render_started))return false;
  if(r.format==='csv') {if(r.worker_thread_id!==null||r.render_finished!==null)return false;}
  else if(!positive(r.worker_thread_id)||!time(r.render_finished)||r.render_finished<r.render_started)return false;
  // An artifact of the current claim is bound to that claim, even before file publication/checkpoint.
  // Older attempts may outlive a replaced mutable snapshot or a newer failed/running claim.
  if(r.attempt===stage.attempt&&r.snapshot_hash!==stage.input_hash)return false;
  if(stage.status===STAGE_STATUS.SUCCEEDED) {
   const e=readSavedJson(stage.evidence_json);
   if(r.status!=='published'||r.snapshot_hash!==stage.input_hash||r.snapshot_hash!==e.snapshotHash
     ||r.bytes_hash!==stage.outcome_hash||r.bytes_hash!==e.bytesHash||r.bytes!==e.bytes
     ||r.artifact_key!==e.artifactKey||r.relative_path!==e.relativePath
     ||r.kind!==e.kind||r.format!==e.format||r.account_code!==(e.code??null))return false;
  }
  const latestHash=sha256(canonicalJson({dtoHash:snapshot.dto_hash,businessHash:snapshot.business_hash,format:r.format,code:r.account_code}));
  // CSV bytes are absent from reportInputHash. Compare mutable CSV only for the
  // current running publication; old/checkpointed artifacts retain their own byte evidence.
  if(r.format==='csv'&&r.attempt===stage.attempt&&stage.status===STAGE_STATUS.RUNNING
    &&r.status==='publishing'&&r.snapshot_hash===latestHash
    &&(snapshot.csv_text===null||r.bytes_hash!==snapshot.csv_hash||r.bytes!==Buffer.byteLength(snapshot.csv_text,'utf8')))return false;
 }
 // persistSnapshot precedes claimStage; artifact registration follows rendering.
 // Successful checkpoints must retain their own tuple, even if evidence names another item.
 for(const stage of actualStages)if(stage.stage_key.startsWith('report:')) {
  const key=stage.item_id+':'+stage.period+':'+stage.stage_key;
  const spec=expectedStages.get(key).spec,item=itemMap.get(stage.item_id);
  const snapshot=snapshots.get(item.job_id+':'+item.id+':'+stage.period+':'+spec.kind);
  if(stage.attempt>0&&!snapshot)return false;
  if(stage.status===STAGE_STATUS.SUCCEEDED&&(!snapshot||!artifacts.has(key)))return false;
 }
 return true;
}
/** Targeted read-only publication/checkpoint contract, shared with strict schema reads.
 * Read the persisted owners and tuple again; supplied snapshots/artifacts only pin
 * expected bytes and identities and never authorize a write or relax row validity.
 */
export function verifyCurrentReportRows(db,{job,item,stage,snapshot=null,artifact=null}) {
 try {
  const currentJob=getJob(db,job.id),currentItem=getItem(db,item.id),currentStage=getStage(db,stage.id);
  const same=(actual,expected,keys)=>actual&&keys.every(k=>actual[k]===expected[k]);
  if(!same(currentJob,job,['id','job_key','manifest_json','manifest_hash','output_dir'])
    ||!same(currentItem,item,['id','job_id','item_key','enterprise_key','source_system','account_set_id'])
    ||!same(currentStage,stage,['id','item_id','period','stage_key','spec_json','attempt','input_hash']))return {ok:false,reason:'report_evidence_changed'};
  for(const k of ['status','outcome_hash','evidence_json'])if(stage[k]!==undefined&&currentStage[k]!==stage[k])return {ok:false,reason:'report_evidence_changed'};
  const spec=readSavedJson(currentStage.spec_json),key=item.id+':'+stage.period+':'+stage.stage_key;
  const snapshots=db.prepare('SELECT * FROM local_batch_snapshots WHERE item_id=? AND period=? AND kind=?').all(item.id,stage.period,spec.kind);
  const artifactKey=job.job_key+'#'+item.item_key+'#'+stage.period+'#'+stage.stage_key;
  const artifacts=db.prepare('SELECT * FROM local_batch_artifacts WHERE item_id=? AND period=? AND stage_key=? OR artifact_key=?').all(item.id,stage.period,stage.stage_key,artifactKey);
  if(snapshots.length!==1||artifacts.length>1)return {ok:false,reason:'report_evidence_changed'};
  if(!batchReportRowsValid(db,{jobMap:new Map([[job.id,currentJob]]),itemMap:new Map([[item.id,currentItem]]),actualStages:[currentStage],expectedStages:new Map([[key,{spec}]]),snapshotRows:snapshots,artifactRows:artifacts}))return {ok:false,reason:'report_evidence_changed'};
  const inputHash=sha256(canonicalJson({dtoHash:snapshots[0].dto_hash,businessHash:snapshots[0].business_hash,format:spec.format,code:spec.code??null}));
  if(currentStage.status===STAGE_STATUS.SUCCEEDED&&inputHash!==currentStage.input_hash)return {ok:false,reason:'report_snapshot_changed'};
  if(currentStage.status===STAGE_STATUS.SUCCEEDED){const evidence=readSavedJson(currentStage.evidence_json);if(evidence.businessHash!==snapshots[0].business_hash||evidence.accountSetId!==currentItem.account_set_id)return {ok:false,reason:'report_evidence_changed'};for(const [column,key] of [['worker_thread_id','workerThreadId'],['render_started','renderStarted'],['render_finished','renderFinished']])if(evidence[key]!==undefined&&artifacts[0][column]!==evidence[key])return {ok:false,reason:'report_evidence_changed'};}
  if(snapshot&&!same(snapshots[0],snapshot,Object.keys(snapshot)))return {ok:false,reason:'report_snapshot_changed'};
  if(artifact&&!same(artifacts[0],artifact,Object.keys(artifact).filter(k=>!['status','updated_at'].includes(k))))return {ok:false,reason:'report_evidence_changed'};
  if(artifact&&artifacts[0].status!==artifact.status&&!(artifact.status==='publishing'&&currentStage.status===STAGE_STATUS.SUCCEEDED&&artifacts[0].status==='published'))return {ok:false,reason:'report_evidence_changed'};
  return {ok:true,job:currentJob,item:currentItem,stage:currentStage,snapshot:snapshots[0],artifact:artifacts[0]??null};
 }catch{return {ok:false,reason:'report_evidence_changed'};}
}
function batchContentValid(db,version) {
 const component=db.prepare('SELECT * FROM local_batch_component').all();
 if(component.length!==1||component[0].component!==LOCAL_BATCH_COMPONENT||component[0].version!==version||!batchIso(component[0].updated_at)||(component[0].note!==null&&typeof component[0].note!=='string'))return false;
 const jobs=db.prepare('SELECT * FROM local_batch_jobs').all(),items=db.prepare('SELECT * FROM local_batch_items').all();
 const jobMap=new Map(),itemMap=new Map(items.map(r=>[r.id,r]));
 for(const j of jobs){const m=readSavedJson(j.manifest_json),validated=validateManifest(m);if(!validated.ok||canonicalJson(validated.manifest)!==j.manifest_json||!positive(j.id)||!batchTech(j.job_key)||!batchDigest(j.manifest_hash)||sha256(j.manifest_json)!==j.manifest_hash||m.jobKey!==j.job_key||m.schemaVersion!==1||!Array.isArray(m.items)||m.concurrency!==j.concurrency||!Number.isInteger(j.concurrency)||j.concurrency<1||j.concurrency>8||!batchPath(j.output_dir)||!Object.values(JOB_STATUS).includes(j.status)||![0,1].includes(j.cancel_requested)||!batchIso(j.created_at)||!batchIso(j.updated_at))return false;jobMap.set(j.id,{...j,manifest:m});}
 for(const r of items){const j=jobMap.get(r.job_id),m=j?.manifest.items.find(i=>i.itemKey===r.item_key);if(!positive(r.id)||!m||m.source?.enterpriseKey!==r.enterprise_key||m.source?.system!==r.source_system||m.source?.enterpriseName!==r.enterprise_name||!Object.values(ITEM_STATUS).includes(r.status)||!batchIso(r.created_at)||!batchIso(r.updated_at)||(r.account_set_id!==null&&!positive(r.account_set_id)))return false;}
 for(const j of jobMap.values())if(j.manifest.items.length!==items.filter(i=>i.job_id===j.id).length)return false;
 const inputs=db.prepare('SELECT * FROM local_batch_inputs').all(),inputMap=new Map(inputs.map(r=>[r.input_key,r]));
 for(const r of inputs){const item=itemMap.get(r.item_id),j=jobMap.get(r.job_id),m=j?.manifest.items.find(i=>i.itemKey===item?.item_key)?.periods?.find(p=>p.period===r.period)?.imports?.find(i=>i.batchId===r.batch_id);const bytes=Buffer.from(r.content);
  if(!item||item.job_id!==r.job_id||!m||r.input_key!==r.job_id+':'+r.item_id+':'+r.batch_id||!batchDigest(r.source_hash)||sha256(bytes)!==r.source_hash||r.bytes!==bytes.length||!batchIso(r.created_at))return false;
  const payload=JSON.parse(bytes.toString('utf8'));if(!isPlainObject(payload))return false;
  if(r.source_path===null){if(m.payloadFile||!isPlainObject(m.payload)||canonicalJson(m.payload)!==bytes.toString('utf8'))return false;}else if(!batchPath(r.source_path)||!m.payloadFile)return false;
 }
 const expectedStages=new Map();
 for(const j of jobMap.values()) {
  const copy=JSON.parse(j.manifest_json);
  for(const mi of copy.items)for(const period of mi.periods)for(const imp of period.imports) {
   const item=items.find(i=>i.job_id===j.id&&i.item_key===mi.itemKey);
   const saved=inputMap.get(j.id+':'+item.id+':'+imp.batchId);if(!saved||saved.period!==period.period)return false;
   imp.payloadFile=null;imp.payload=JSON.parse(Buffer.from(saved.content).toString('utf8'));
  }
  for(const plan of buildPlan({manifest:copy,manifestDir:'.'}).plans) {
   const item=items.find(i=>i.job_id===j.id&&i.item_key===plan.itemKey);
   for(const stage of plan.stages) {
    if(stage.stageKey.startsWith('import:'))stage.spec.payloadHash=inputMap.get(j.id+':'+item.id+':'+stage.spec.batchId).source_hash;
    expectedStages.set(item.id+':'+stage.period+':'+stage.stageKey,{...stage,jobKey:j.job_key,itemKey:item.item_key});
   }
  }
 }
 const actualStages=db.prepare('SELECT * FROM local_batch_stages').all();if(actualStages.length!==expectedStages.size)return false;
 for(const r of actualStages){const item=itemMap.get(r.item_id),j=jobMap.get(item?.job_id);const spec=readSavedJson(r.spec_json),evidence=readSavedJson(r.evidence_json);
  if(!positive(r.id)||!j||!/^\d{4}-\d{2}$/.test(r.period)||!expectedStages.has(r.item_id+':'+r.period+':'+r.stage_key)||!positive(r.stage_order)||!Object.values(STAGE_STATUS).includes(r.status)||!Number.isSafeInteger(r.attempt)||r.attempt<0||!batchIso(r.updated_at)||(r.input_hash!==null&&!batchDigest(r.input_hash))||(r.outcome_hash!==null&&!batchDigest(r.outcome_hash)))return false;
  const expected=expectedStages.get(r.item_id+':'+r.period+':'+r.stage_key);
  if(r.stage_order!==expected.order||canonicalJson(spec)!==canonicalJson(expected.spec))return false;
  const h=sha256(canonicalJson({jobKey:j.job_key,itemKey:item.item_key,period:r.period,stageKey:r.stage_key,spec}));
  if(r.stage_key.startsWith('report:')&&r.attempt>0) {
   // Snapshots can be overwritten before retry claims a new attempt. Only the
   // succeeded checkpoint owns immutable evidence for that attempt's input hash.
   if(!batchDigest(r.input_hash))return false;
   if(r.status===STAGE_STATUS.SUCCEEDED&&(!batchDigest(evidence.snapshotHash)||r.input_hash!==evidence.snapshotHash))return false;
  }else if(r.input_hash!==h)return false;
  if(r.stage_key.startsWith('import:')){const input=inputMap.get(j.id+':'+item.id+':'+spec.batchId);if(!input||input.period!==r.period||spec.payloadHash!==input.source_hash)return false;}
 }
 if(!batchReportRowsValid(db,{jobMap,itemMap,actualStages,expectedStages}))return false;
 for(const r of db.prepare('SELECT * FROM local_batch_locks').all())if(!( /^job:[1-9][0-9]*$/.test(r.resource_key)||/^account-set:[1-9][0-9]*$/.test(r.resource_key)||(r.resource_key.startsWith('book:')&&r.resource_key.length<=133&&!/[\u0000-\u001f\u007f]/.test(r.resource_key)&&r.resource_key.length>5))||!batchTech(r.owner_instance)||!positive(r.fencing_token)||(r.pid!==null&&!positive(r.pid))||!batchIso(r.acquired_at)||!batchIso(r.heartbeat_at)||!batchIso(r.lease_expires_at))return false;
 if(version===3) {
  const epochs=new Map();
  for(const r of db.prepare('SELECT * FROM local_batch_lock_epochs').all()) {
   if(!validResourceKey(r.resource_key)||!positive(r.last_token))return false;epochs.set(r.resource_key,r.last_token);
  }
  for(const r of db.prepare('SELECT * FROM local_batch_locks').all())if(!validResourceKey(r.resource_key)||!positive(r.pid)||epochs.get(r.resource_key)!==r.fencing_token)return false;
 }
 if(version===1)return true;
 const instances=db.prepare('SELECT * FROM local_batch_database_instances').all(),ids=new Map(instances.map(r=>[r.instance_id,r]));
 const active=instances.filter(r=>r.is_active===1);if(active.length!==1)return false;
 const audit=inspectAuditSchema(db);if(audit.state!=='not_installed'&&!audit.ok)return false;
 for(const r of instances){if(!batchUuid(r.instance_id)||!batchIso(r.created_at)||![0,1].includes(r.is_active)||!['initial','restore-new'].includes(r.origin)||!['ready','restore_pending'].includes(r.write_state))return false;
  if(r.origin==='initial'){if(r.parent_instance_id!==null||r.restore_operation_id!==null||r.source_backup_digest!==null||r.write_state!=='ready')return false;}
  else if(!ids.has(r.parent_instance_id)||!batchTech(r.restore_operation_id)||!batchDigest(r.source_backup_digest))return false;
  const seen=new Set();let cur=r;while(cur){if(seen.has(cur.instance_id))return false;seen.add(cur.instance_id);cur=cur.parent_instance_id===null?null:ids.get(cur.parent_instance_id);if(cur===undefined)return false;}
  if(r.audit_instance_id!==null&&(audit.state==='not_installed'||!db.prepare('SELECT 1 FROM audit_database_instances WHERE instance_id=?').get(r.audit_instance_id)))return false;
 }
 if(audit.ok&&active[0].audit_instance_id!==audit.activeInstanceId)FAIL('batch_instance_mismatch');
 const jb=db.prepare('SELECT * FROM local_batch_job_bindings').all(),ib=db.prepare('SELECT * FROM local_batch_input_bindings').all();
 for(const r of jb)if(!ids.has(r.database_instance_id)||!jobMap.has(r.job_id)||!batchIso(r.bound_at)||!['bound','disabled'].includes(r.output_state)||(r.output_state==='bound'?!batchPath(r.output_root):r.output_root!==null))return false;
 for(const r of ib){const input=inputMap.get(r.input_key);if(!ids.has(r.database_instance_id)||!input||!batchIso(r.bound_at)||!['source','inline','saved_snapshot','disabled'].includes(r.mode)||(r.mode==='source'?!batchPath(r.source_path):r.source_path!==null)||(r.mode==='inline'&&input.source_path!==null))return false;}
 if(jobs.some(j=>!jb.some(r=>r.database_instance_id===active[0].instance_id&&r.job_id===j.id))||inputs.some(i=>!ib.some(r=>r.database_instance_id===active[0].instance_id&&r.input_key===i.input_key)))return false;
 return true;
}
export function inspectBatchSchema(db) {
 const any=db.prepare("SELECT 1 FROM sqlite_master WHERE lower(name) GLOB 'local_batch_*' OR lower(name) GLOB 'idx_local_batch_*'").get();
 if(!any)return {state:'not_installed',ok:false,version:0,present:[],tables:[],problems:[]};
 let version=0;const problems=[];
 try {version=readBatchVersion(db)??0;if(![1,2,3].includes(version))problems.push('version_invalid');
  else {if(canonicalJson(batchSchemaFacts(db,version))!==canonicalJson(batchComponentContract(version).facts))problems.push('structure_mismatch');
   if(!problems.length&&!batchContentValid(db,version))problems.push('content_invalid');}
 }catch(e){if(e.code==='batch_instance_mismatch')problems.push('instance_mismatch');else problems.push('structure_or_content_invalid');}
 return {state:problems.length?'invalid':'ok',ok:problems.length===0,version,tables:[...batchTables(version)],present:LOCAL_BATCH_TABLES.filter(t=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)),problems};
}
export function assertBatchSchema(db) {const s=inspectBatchSchema(db);if(!s.ok)FAIL(s.problems.includes('instance_mismatch')?'batch_instance_mismatch':s.version>3?'batch_schema_future_version':'batch_schema_invalid');return s;}
export function readBatchInstance(db) {const s=assertBatchSchema(db);if(s.version<2)FAIL('migration_requires_backup',{},'Run install --data-dir <dir> --out-dir <new-backup-dir> first');return db.prepare('SELECT * FROM local_batch_database_instances WHERE is_active=1').get();}
export function assertBatchRunnable(db,{jobId}={}) {
 assertRestoreWritable(db);
 if(readBatchVersion(db)!==3)FAIL('migration_requires_backup');
 const instance=readBatchInstance(db);if(instance.write_state!=='ready')FAIL('batch_not_ready');
 const jb=db.prepare('SELECT * FROM local_batch_job_bindings WHERE database_instance_id=?').all(instance.instance_id),ib=db.prepare('SELECT * FROM local_batch_input_bindings WHERE database_instance_id=?').all(instance.instance_id);
 for(const r of jb.filter(r=>jobId===undefined||r.job_id===jobId))if(r.output_state!=='bound'||r.output_root!==getJob(db,r.job_id).output_dir)FAIL('batch_binding_disabled');
 for(const r of ib){const input=db.prepare('SELECT * FROM local_batch_inputs WHERE input_key=?').get(r.input_key);if(jobId!==undefined&&input.job_id!==jobId)continue;if(!['source','inline'].includes(r.mode)||(r.mode==='source'&&r.source_path!==input.source_path)||(r.mode==='inline'&&input.source_path!==null))FAIL('batch_binding_disabled');}
 return instance;
}
function seedBatchInstance(db) {
 const audit=inspectAuditSchema(db);if(audit.state!=='not_installed'&&!audit.ok)FAIL('batch_instance_mismatch');
 const instance=randomUUID(),at=nowIso();
 db.prepare("INSERT INTO local_batch_database_instances VALUES(?,NULL,?,1,?,'initial','ready',NULL,NULL)").run(instance,audit.ok?audit.activeInstanceId:null,at);
 bindBatchJobInputs(db,instance,at);
 return instance;
}
function bindBatchJobInputs(db,instance,at,jobId) {
 const jobs=db.prepare('SELECT * FROM local_batch_jobs'+(jobId===undefined?'':' WHERE id=?')).all(...(jobId===undefined?[]:[jobId]));
 for(const j of jobs)db.prepare("INSERT INTO local_batch_job_bindings VALUES(?,?,'bound',?,?)").run(instance,j.id,j.output_dir,at);
 const inputs=db.prepare('SELECT * FROM local_batch_inputs'+(jobId===undefined?'':' WHERE job_id=?')).all(...(jobId===undefined?[]:[jobId]));
 for(const i of inputs)db.prepare('INSERT INTO local_batch_input_bindings VALUES(?,?,?,?,?)').run(instance,i.input_key,i.source_path===null?'inline':'source',i.source_path,at);
}
const batchQuarantine=new WeakSet();
function assertBatchConnection(db){assertRestoreWritable(db);if(!db||batchQuarantine.has(db))FAIL('batch_unavailable');if(db.isTransaction)FAIL('batch_transaction_conflict');if(db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)FAIL('batch_database_invalid');}
function batchFileIdentity(db,explicit) {
 const main=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main');
 function plain(file){if(typeof file!=='string'||!file)FAIL('batch_database_invalid');const full=resolve(file);try{for(let p=full;;p=dirname(p)){const st=lstatSync(p);if(st.isSymbolicLink()||!sameCanonicalPath(realpathSync.native(p),p))FAIL('batch_database_invalid');if(dirname(p)===p)break;}const st=statSync(full,{bigint:true});if(!st.isFile()||st.nlink!==1n)FAIL('batch_database_invalid');return {path:full,dev:st.dev,ino:st.ino};}catch{FAIL('batch_database_invalid');}}
 const id=plain(main?.file),other=plain(explicit);if(!sameCanonicalPath(id.path,other.path)||id.dev!==other.dev||id.ino!==other.ino)FAIL('batch_backup_source_mismatch');return id;
}
const batchIdentityEqual=(a,b)=>sameCanonicalPath(a.path,b.path)&&a.dev===b.dev&&a.ino===b.ino;
function assertBatchMaintenance(db,state) {
 if(state.state==='not_installed')return;
 const locks=db.prepare('SELECT * FROM local_batch_locks').all();
 for(const lock of locks)if(!positive(lock.pid)||isProcessAlive(lock.pid)!==false)FAIL('batch_owner_active');
 for(const stage of db.prepare("SELECT owner_instance FROM local_batch_stages WHERE status='running'").all()){
  const matching=locks.filter(l=>l.owner_instance===stage.owner_instance);if(!matching.length||matching.some(l=>!positive(l.pid)||isProcessAlive(l.pid)!==false))FAIL('batch_owner_active');
 }
}
export function assertBatchMaintenanceReady(db) {
 assertRestoreWritable(db);
 const state=inspectBatchSchema(db);if(state.state!=='not_installed')assertBatchSchema(db);assertBatchMaintenance(db,state);
}
/** Explicit existing-database install/upgrade. The official reader snapshots while we reserve writes. */
export async function installBatchSchema(db,{dbPath,outDir}={}) {
 assertBatchConnection(db);if(!dbPath||!outDir)FAIL('batch_install_requires_verified_backup');const before=batchFileIdentity(db,dbPath);
 const LB=await import('./local-backup.mjs');LB.assertSupportedDatabaseConnection(db);
 let state=inspectBatchSchema(db);if(state.state!=='not_installed')assertBatchSchema(db);
 if(state.version===3)return {installed:false,from:3,to:3,activeInstanceId:readBatchInstance(db).instance_id};
 try {db.exec('BEGIN IMMEDIATE');}catch(e){if(db.isTransaction){batchQuarantine.add(db);FAIL('batch_commit_unknown');}FAIL('batch_admission_busy');}
 try {
  if(!batchIdentityEqual(before,batchFileIdentity(db,dbPath)))FAIL('batch_backup_source_mismatch');
  LB.assertSupportedDatabaseConnection(db);state=inspectBatchSchema(db);if(state.state!=='not_installed')assertBatchSchema(db);assertBatchMaintenance(db,state);
  const created=LB.createBackup({dbPath:before.path,outDir});if(!created.ok)FAIL('batch_backup_invalid');
  const verified=LB.verifyBackup({backupDir:created.backupDir});
  if(!verified.ok||verified.status!=='ok'||verified.summary.snapshotBytes!==created.backupMeta.snapshotBytes||verified.summary.snapshotSha256!==created.backupMeta.snapshotSha256||verified.manifest.source.file!==basename(before.path)||canonicalJson(verified.manifest)!==canonicalJson(created.manifest))FAIL('batch_backup_invalid');
  if(state.state==='not_installed')LB.assertInstallableComponentSet(verified.manifest,LOCAL_BATCH_COMPONENT);
  try{LB.assertBackupSourceConnection(db,verified.manifest);}catch{FAIL('batch_backup_source_mismatch');}
  if(!batchIdentityEqual(before,batchFileIdentity(db,dbPath)))FAIL('batch_backup_source_mismatch');
  if(state.state==='not_installed'){for(const sql of SCHEMA_STATEMENTS)db.exec(sql);db.prepare('INSERT INTO local_batch_component VALUES(?,?,?,?)').run(LOCAL_BATCH_COMPONENT,1,nowIso(),'LOCAL-07');}
  let activeInstanceId;
  if(state.version<2){for(const sql of V2_STATEMENTS)db.exec(sql);activeInstanceId=seedBatchInstance(db);}
  else activeInstanceId=readBatchInstance(db).instance_id;
  for(const sql of V3_STATEMENTS)db.exec(sql);
  db.exec('INSERT INTO local_batch_lock_epochs SELECT resource_key,fencing_token FROM local_batch_locks');
  db.prepare('UPDATE local_batch_component SET version=3 WHERE component=?').run(LOCAL_BATCH_COMPONENT);
  assertBatchSchema(db);if(!batchIdentityEqual(before,batchFileIdentity(db,dbPath)))FAIL('batch_backup_source_mismatch');
  db.exec('COMMIT');return {installed:true,from:state.version,to:3,activeInstanceId,backupDir:created.backupDir};
 }catch(e){try{if(!db.isTransaction)throw Error('unknown');db.exec('ROLLBACK');if(db.isTransaction)throw Error('unknown');}catch{batchQuarantine.add(db);FAIL('batch_commit_unknown');}throw batchError(String(e?.code??'').startsWith('batch_')?e.code:'batch_schema_install_failed');}
}
/** Synchronous: strict v3 validation, or genuine private fresh ownership only. */
export function ensureBatchSchema(db,{receipt=null}={}) {
 assertRestoreWritable(db);
 if(receipt)assertFreshReceipt(receipt,db);
 const state=inspectBatchSchema(db);
 if(state.state!=='not_installed'){assertBatchSchema(db);if(state.version!==3)FAIL('migration_requires_backup',{},'Run install --data-dir <dir> --out-dir <new-backup-dir> first');if(receipt)releaseFreshClaim(receipt);return {created:false,version:3};}
 if(!receipt)FAIL('migration_requires_backup',{},'Run install --data-dir <dir> --out-dir <new-backup-dir> first');
 if(db.isTransaction)FAIL('batch_transaction_conflict');assertFreshReceipt(receipt,db);db.exec('BEGIN IMMEDIATE');
 try {for(const sql of [...SCHEMA_STATEMENTS,...V2_STATEMENTS,...V3_STATEMENTS])db.exec(sql);db.prepare('INSERT INTO local_batch_component VALUES(?,?,?,?)').run(LOCAL_BATCH_COMPONENT,3,nowIso(),'LOCAL-07');seedBatchInstance(db);assertBatchSchema(db);assertFreshReceipt(receipt,db);db.exec('COMMIT');}
 catch(e){try{if(!db.isTransaction)throw Error('unknown');db.exec('ROLLBACK');}catch{batchQuarantine.add(db);FAIL('batch_commit_unknown');}if(String(e?.code??'').startsWith('fresh_'))throw e;throw batchError('local_batch_schema_failed');}
 releaseFreshClaim(receipt);return {created:true,version:3};
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
 assertRestoreWritable(db);
  const instance=assertBatchRunnable(db);
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
    if(created)bindBatchJobInputs(db,instance.instance_id,nowIso(),job.id);
    assertBatchRunnable(db,{jobId:job.id});
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
 assertRestoreWritable(db);
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
 assertRestoreWritable(db);
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
 * 已保存content自身的长度/hash始终校验；显式快照策略仅可豁免外部文件。
 */
export function checkInputEvidence(input,{allowSnapshotOnly=false}={}) {
  if (!input) return { ok: false, problem: "input_snapshot_missing", savedValid:false };
  const saved=input.content instanceof Uint8Array?Buffer.from(input.content):null;
  if(!saved||!Number.isSafeInteger(input.bytes)||input.bytes!==saved.length||sha256(saved)!==input.source_hash)return {ok:false,problem:'input_changed',external:false,savedValid:false,sourceHash:input.source_hash};
  if (!input.source_path||allowSnapshotOnly) return { ok: true, problem: null, external: !!input.source_path, savedValid:true };
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
 assertRestoreWritable(db);
  const previous=getStage(db,stageId);if(previous&&stageAuditNeedsReview(db,previous))FAIL('audit_operation_pending');
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
 assertRestoreWritable(db);
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
 assertRestoreWritable(db);
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
export function acquireLock(db, { resourceKey, instance, pid=process.pid, leaseMs = 120000 }) {
 assertRestoreWritable(db);
  if(!validResourceKey(resourceKey)||!batchTech(instance)||!positive(pid)||!positive(leaseMs))FAIL('lock_request_invalid');
  if(db.prepare('SELECT version FROM local_batch_component WHERE component=?').get(LOCAL_BATCH_COMPONENT)?.version!==3)FAIL('migration_requires_backup');
  const nested=hasActiveAuditExecution(db);
  if(db.isTransaction&&!nested)FAIL('audit_transaction_conflict');
  const run=()=>{
    const row=db.prepare('SELECT * FROM local_batch_locks WHERE resource_key=?').get(resourceKey);
    const historical=db.prepare('SELECT last_token FROM local_batch_lock_epochs WHERE resource_key=?').get(resourceKey);
    if(historical&&!positive(historical.last_token))FAIL('lock_epoch_invalid');
    if(row) {
      if(!historical||row.fencing_token!==historical.last_token)FAIL('lock_epoch_invalid');
      const alive=isProcessAlive(Number(row.pid));
      // Identical public owner/PID is identification, never a renewal capability.
      if(alive!==false)FAIL(row.lease_expires_at>nowIso()?'lock_active':'owner_active',{resourceKey,pidAlive:alive});
    }
    const next=(historical?.last_token??0)+1;if(!positive(next))FAIL('lock_epoch_overflow');
    const at=nowIso(),expires=new Date(Date.now()+leaseMs).toISOString();
    db.prepare('INSERT INTO local_batch_lock_epochs VALUES(?,?) ON CONFLICT(resource_key) DO UPDATE SET last_token=excluded.last_token').run(resourceKey,next);
    db.prepare(`INSERT INTO local_batch_locks VALUES(?,?,?,?,?,?,?) ON CONFLICT(resource_key) DO UPDATE SET owner_instance=excluded.owner_instance,fencing_token=excluded.fencing_token,pid=excluded.pid,acquired_at=excluded.acquired_at,heartbeat_at=excluded.heartbeat_at,lease_expires_at=excluded.lease_expires_at`).run(resourceKey,instance,next,pid,at,at,expires);
    return {token:next,acquired:true,takeover:!!row,previousOwner:row?.owner_instance};
  };
  if(nested)return withAuditSavepoint(db,run);
  db.exec('BEGIN IMMEDIATE');try{const out=run();db.exec('COMMIT');return out;}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
}

export function renewLock(db, { resourceKey, instance, token, leaseMs = 120000 }, capability) {
 assertRestoreWritable(db);
  if(!authorizesResourceRenewal(db,capability,{resourceKey,instance,token}))FAIL('lock_capability_invalid');
  const at = new Date(nowMs()).toISOString();
  const expires = new Date(nowMs() + leaseMs).toISOString();
  const info = db.prepare(`UPDATE local_batch_locks SET heartbeat_at=?, lease_expires_at=?
      WHERE resource_key=? AND owner_instance=? AND fencing_token=?`)
    .run(at, expires, resourceKey, instance, token);
  if (Number(info.changes) !== 1) FAIL("fence_lost", { resourceKey });
  return { renewed: true };
}

export function releaseLock(db, { resourceKey, instance, token }) {
 assertRestoreWritable(db);
  const info = db.prepare(`DELETE FROM local_batch_locks
      WHERE resource_key=? AND owner_instance=? AND fencing_token=?`)
    .run(resourceKey, instance, token);
  return Number(info.changes) === 1;
}

/** 事务内 fence 校验：旧 token / 旧 owner 一律 fence_lost（必须在 BEGIN IMMEDIATE 内调用）。 */
export function assertFence(db, { resourceKey, instance, token }) {
  const row = db.prepare(`SELECT l.owner_instance, l.fencing_token, e.last_token FROM local_batch_locks l JOIN local_batch_lock_epochs e USING(resource_key) WHERE resource_key=?`).get(resourceKey);
  if (!row || row.owner_instance !== instance || Number(row.fencing_token) !== Number(token) || row.last_token!==token) {
    FAIL("fence_lost", { resourceKey, expectedToken: token, actual: row ? { owner: row.owner_instance, token: Number(row.fencing_token) } : null });
  }
}

/**
 * 在同一个 BEGIN IMMEDIATE 事务内执行「fence 校验 + 效果 + checkpoint」。
 * fn 内抛错时整体回滚（会计效果与 checkpoint 一起撤销）。
 */
export function withFencedTransaction(db, { resourceKey, instance, token }, fn) {
 assertRestoreWritable(db);
  if(hasActiveAuditExecution(db))return withAuditSavepoint(db,()=>{assertFence(db,{resourceKey,instance,token});const out=fn();assertFence(db,{resourceKey,instance,token});return out;});
  if(db.isTransaction)FAIL('audit_transaction_conflict');
  db.exec("BEGIN IMMEDIATE");
  try {
    assertFence(db, { resourceKey, instance, token });
    const out = fn();
    assertFence(db, { resourceKey, instance, token });
    assertWriteCommitFence(db);
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
 assertRestoreWritable(db);
  assertBatchRunnable(db);
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
 assertRestoreWritable(db);
  assertBatchRunnable(db);
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
        const unresolved=stageAuditNeedsReview(db,stage);
        if(unresolved){resetStage(db,{stageId:stage.id,status:STAGE_STATUS.NEEDS_REVIEW,errorCode:'audit_operation_pending'});skipped.push({itemKey:item.item_key,period:stage.period,stageKey:stage.stage_key,status:STAGE_STATUS.NEEDS_REVIEW});continue;}
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
 assertRestoreWritable(db);
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

// The persistent stage/attempt tuple is the audit association; no invented schema column.
export function stageAuditOperationId(stage){return `stage:${stage.id}:${stage.attempt}`;}
export function stageAuditNeedsReview(db,stage){
 if(!stage.attempt)return false;
 const present=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_operations'").get();if(!present)return false;
 const row=db.prepare("SELECT state FROM audit_operations WHERE (operation_id=? OR operation_id LIKE ?) AND attempt=1 AND state='pending' LIMIT 1").get(stageAuditOperationId(stage),stageAuditOperationId(stage)+'.%');
 return row?.state==='pending';
}

export function assertClaimedStage(db,{stageId,instance,token,attempt}) {
 const row=db.prepare('SELECT status,owner_instance,fencing_token,attempt FROM local_batch_stages WHERE id=?').get(stageId);
 if(!row||row.status!==STAGE_STATUS.RUNNING||row.owner_instance!==instance||row.fencing_token!==token||row.attempt!==attempt)FAIL('fence_lost');
}
