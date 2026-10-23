// database-open-guard.mjs — 「本进程独占新建的库文件」与「实际打开的 SQLite 连接」之间的纯守卫。
//
// 为什么需要它（LOCAL-07 独审 P1）：
//   `db.mjs` 一被 import 就 `new DatabaseSync(workbench.db)`，随后立刻执行核心 DDL、`PRAGMA journal_mode = WAL`
//   与导入结构迁移写。旧实现只在 import 之前 stat 一次目录 / 文件，因此存在 TOCTOU：claim 拿到回执之后，
//   只要把 workbench.db 换成一份外部旧库，`db.mjs` 就会先在**别人的库**上建表 / 设 WAL 并跑迁移，直到
//   `ensureBatchSchema` 才发现「文件被替换」——那时外部库已经被污染（先污染再拒绝）。
//
// 本模块把「创建事实」做成进程内不可伪造的记录，并把记录与**实际文件对象 / 实际连接**绑定：
//   1) 创建事实：`claimFreshDataDir` 用 `O_EXCL` 创建 workbench.db 时拿到的 fd 本身参与登记；
//      身份（dev/ino）来自 `fstat(fd)`，不是之后按路径 stat 的结果。
//   2) 页 1 种子：claim 阶段**只用这个创建 fd** 把一份经真实 SQLite 验证过的空库种子（4096 字节，
//      无任何 schema 对象）写到文件名偏移 0，并把本进程随机 nonce 写进页 1 头部的 user_version、
//      把 "LB07" 魔数写进 application_id。写入目标是 fd 绑定的文件对象，**因此按路径替换文件
//      （包括 ABA：换走再换回）都不能改变这段写入落在哪个对象上**；外部文件永远不会被写。
//   3) 任何核心 DDL / WAL / 迁移写之前，`db.mjs` 通过本模块用**同一条已打开的连接**读页 1 头部：
//      只有读到本进程的 31 位随机 nonce + 魔数、且 `PRAGMA database_list` / `db.location()` 指向目标、
//      且创建 fd 的 fstat 身份未变、路径身份未变、连接里还没有任何 schema 对象，才允许继续。
//      这个 nonce 只是**本地随机识别标记**，不是秘密、也不是认证凭据：它同时写进所有权标记 JSON、
//      页 1 头部，并被 `describeFreshClaim` 返回、被测试诊断输出，外部程序读到标记文件即可看到它。
//      它证明的是「这条连接里读到的是本进程 claim 时写下、且未被后续写入覆盖的值」；真正授权的
//      来源是私有 WeakMap 里的创建事实 + 创建 fd 身份 + 实际连接 / 路径核验。`PRAGMA database_list`
//      只返回路径字符串，单靠它会被「路径相同、文件已换」骗过，因此它只是辅助检查。
//   4) 文件系统层同时校验：目录 / 文件不是符号链接或 junction、realpath 与显式路径一致、dev/ino 与
//      `fstat(fd)` 记录一致（Windows 上 dev/ino 来自 NTFS 文件索引，替换后必然变化）。
//   5) 跨路径：本进程**持有活动创建事实**时，`db.mjs` 初始化钩子打开的目标必须就是该次创建的对象。
//      目标不对应任何活动创建事实（另一个数据目录、别名 / junction 路径、未指定目录）一律按
//      `fresh_claim_target_mismatch` 拒绝，**不**因为按路径查表未命中就退化成普通入口——否则
//      「先 claim A，再把 WORKBENCH_DATA_DIR 指向既有库 B」就能在 guard 之前把核心结构写进 B。
//      没有任何活动创建事实时（普通业务入口）行为完全不变。
//   6) 所有权标记（`.local-batch-create`）同样要绑定创建时的不可变身份：nonce 会明文出现在标记
//      JSON / 页 1 / 诊断输出里，**不是秘密**，所以「内容命中 nonce」不能当删除依据——同一个 nonce
//      的新文件对象（哪怕字节完全相同）或加了额外字段的外部标记都必须保留。标记身份取自 O_EXCL
//      创建时的 `fstat(markerFd)` 并只保存在私有 facts，删除 / 打开校验时都只比对这份身份 +
//      本进程写下的期望内容，绝不重新按路径认领当前对象。
//
// 授权事实只保存在模块私有 WeakMap：对外返回的 token 是一个空对象，调用方改字段 / 嵌套改值 / 复制 /
// 伪造 / 删除字段都不能改变授权目标。安装、校验、release 全部只读内部不可变记录。
//
// 残余边界（如实记录，不夸大）：nonce 会作为 `user_version` 长期留在本次创建的库里（产品其它逻辑不读
// `user_version`；LOCAL-06 备份只把它当作待比对字段），也会以明文留在所有权标记 JSON 与诊断输出中；
// 它不是秘密，本模块也**不**承诺「不可伪造的认证」。本模块不尝试防御同进程内的恶意代码（它能直接
// 调用本模块 API）或物理层伪造，只保证「按路径替换 / 别名 / ABA / 零字节外部文件」不会导致向外部对象
// 写入或在外部库上建结构。
//
// 约束：本文件不 import `db.mjs` / `accounting.mjs` / `local-batch-*.mjs`，import 时无副作用
// （只做常量自检）；只有显式调用才会打开文件或连接。

import { randomInt } from "node:crypto";
import {
  closeSync, fsyncSync, fstatSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 页 1 头部的 application_id 魔数（ASCII "LB07"），标识「本产品独占创建窗口写入的库」。 */
export const CLAIM_APPLICATION_ID = 0x4c423037;

const PAGE_SIZE = 4096;
const PAGE1_OFFSET_USER_VERSION = 60;
const PAGE1_OFFSET_APPLICATION_ID = 68;
const PAGE1_OFFSET_SCHEMA_FORMAT = 44;
const PAGE1_OFFSET_TEXT_ENCODING = 56;
const PAGE1_OFFSET_CELL_COUNT = 103;

/**
 * 一份由真实 SQLite（node:sqlite）生成的**空库**种子：4096 字节、1 页、`sqlite_master` 0 个对象。
 * claim 阶段只把 user_version / application_id 两个头部字段改写成本进程 nonce / 魔数，其余字节保持
 * SQLite 生成的原样；写完后立即用只读 SQLite 连接校验（见 `stampFreshClaimNonce`）。
 */
const EMPTY_SQLITE_SEED_B64 = "U1FMaXRlIGZvcm1hdCAzABAAAQEAQCAgAAAAAQAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAC6N+w0AAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

const EMPTY_SQLITE_SEED = Buffer.from(EMPTY_SQLITE_SEED_B64, "base64");

// 模块加载自检：纯内存、无文件 / 连接副作用。种子结构不对就立刻失败，绝不写进任何目标。
(function assertEmptySqliteSeed() {
  const fail = (reason) => { throw new Error(`claim seed invalid: ${reason}`); };
  if (EMPTY_SQLITE_SEED.length !== PAGE_SIZE) fail("size");
  if (EMPTY_SQLITE_SEED.subarray(0, 16).toString("latin1") !== "SQLite format 3\u0000") fail("magic");
  if (EMPTY_SQLITE_SEED.readUInt16BE(16) !== PAGE_SIZE) fail("page_size");
  if (EMPTY_SQLITE_SEED.readUInt32BE(28) !== 1) fail("page_count");
  // 从未写过 schema 的空库：schema_format（44）/ text_encoding（56）都还是 0，SQLite 读作「尚未设置」。
  if (EMPTY_SQLITE_SEED.readUInt32BE(PAGE1_OFFSET_SCHEMA_FORMAT) !== 0) fail("schema_format");
  if (EMPTY_SQLITE_SEED.readUInt32BE(PAGE1_OFFSET_TEXT_ENCODING) !== 0) fail("text_encoding");
  if (EMPTY_SQLITE_SEED[100] !== 0x0d) fail("page1_btree_type");
  if (EMPTY_SQLITE_SEED.readUInt16BE(PAGE1_OFFSET_CELL_COUNT) !== 0) fail("page1_cell_count");
  // 空页的「单元格内容起点」必须等于页大小：种子页除了头部外没有任何内容。
  if (EMPTY_SQLITE_SEED.readUInt16BE(105) !== PAGE_SIZE) fail("page1_cell_content_start");
})();

/** 私有事实表：token → 冻结的创建事实（唯一授权来源）。 */
const CLAIM_FACTS = new WeakMap();
/** 已写入页 1 种子的创建事实（模块内部状态，同样不依赖调用方对象）。 */
const STAMPED_FACTS = new WeakSet();
/** 供 `db.mjs` 初始化钩子按「实际要打开的库路径」反查创建事实。 */
const ACTIVE_BY_DB_PATH = new Map();

const IDENTITY_CODES = new Set([
  "data_dir_required", "data_dir_invalid", "data_dir_alias", "data_dir_unreadable",
  "fresh_receipt_invalid", "fresh_receipt_stale", "fresh_target_claimed", "fresh_database_missing",
  "fresh_database_alias", "fresh_database_replaced", "fresh_database_mismatch",
  "fresh_database_foreign_content", "fresh_database_not_pristine", "fresh_database_unreadable",
  "fresh_claim_stamp_failed", "fresh_claim_cleanup_required", "fresh_claim_target_mismatch",
]);

function guardError(code, details = {}, message) {
  const error = new Error(message || code);
  error.code = code;
  error.details = details;
  return error;
}

/** 路径比较口径：Windows 的 NTFS 默认大小写不敏感，realpath 也可能改盘符大小写。 */
function canonical(value) {
  const resolved = resolve(String(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function samePath(left, right) {
  if (!left || !right) return false;
  return canonical(left) === canonical(right);
}
function sameIdentity(left, right) {
  return !!left && !!right && String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function identityOf(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

/** 每次独占新建的随机 nonce（31 位正整数，避免 PRAGMA 有符号 32 位边界问题）。 */
export function newClaimNonce() {
  return randomInt(1, 0x7ffffffe);
}

function requireFacts(token) {
  const facts = token && typeof token === "object" ? CLAIM_FACTS.get(token) : null;
  if (!facts) {
    throw guardError("fresh_receipt_invalid", {}, "新建批量结构必须持有本进程独占创建回执（该对象不是本进程签发的回执）");
  }
  return facts;
}

/** 页 1 种子字节：空库种子 + 本进程 nonce / 魔数（只改这两个头部字段）。 */
function seededPage1(nonce) {
  const bytes = Buffer.from(EMPTY_SQLITE_SEED);
  bytes.writeUInt32BE(factsSafeInt(CLAIM_APPLICATION_ID), PAGE1_OFFSET_APPLICATION_ID);
  bytes.writeUInt32BE(factsSafeInt(nonce), PAGE1_OFFSET_USER_VERSION);
  return bytes;
}
function factsSafeInt(value) {
  return Number(value) >>> 0;
}

/**
 * 登记「本进程刚刚独占创建了这条库文件」的事实。
 * `fd` 必须是 `openSync(dbPath, "wx")` 返回、仍打开着的创建句柄；身份取自 `fstat(fd)`，
 * 任何后续按路径 stat 的结果都不会回填 / 覆盖这里的身份。
 * `markerFd` 必须是 `openSync(markerPath, "wx")` 返回、仍打开着的标记创建句柄；标记身份同样只取自
 * `fstat(markerFd)`，`markerContent` 是本进程写进该 fd 的期望内容（删除 / 校验时逐字节比对）。
 * 返回值是一个空对象 token（不含任何可修改的授权字段）。
 */
export function createFreshClaimFacts({
  dataDir, dbPath, markerPath, identity, fd, pid, nonce, markerFd, markerIdentity, markerContent,
}) {
  if (!dataDir || !dbPath || !markerPath) throw guardError("data_dir_required", {}, "创建回执缺少目标路径");
  if (!identity || identity.dev === undefined || identity.ino === undefined) {
    throw guardError("fresh_receipt_invalid", {}, "创建回执必须绑定 O_EXCL 创建时的文件身份");
  }
  if (!Number.isInteger(Number(fd)) || Number(fd) < 0) {
    throw guardError("fresh_receipt_invalid", {}, "创建回执必须绑定 O_EXCL 创建时持有的文件句柄");
  }
  let created;
  try { created = fstatSync(Number(fd)); } catch {
    throw guardError("fresh_receipt_invalid", {}, "创建句柄已不可用：无法证明本次创建对象");
  }
  if (!created.isFile() || !sameIdentity(identityOf(created), identity)) {
    throw guardError("fresh_receipt_invalid", {}, "创建句柄与登记身份不一致");
  }
  if (created.size !== 0) {
    throw guardError("fresh_database_not_pristine", {}, "独占创建的新库必须是零字节");
  }
  const resolvedDir = resolve(String(dataDir));
  const resolvedDb = resolve(String(dbPath));
  if (!samePath(dirname(resolve(String(markerPath))), resolvedDir) || !samePath(dirname(resolvedDb), resolvedDir)) {
    throw guardError("fresh_receipt_invalid", {}, "所有权标记与库文件必须与该数据目录同目录");
  }
  const nonceValue = Number(nonce);
  if (!Number.isInteger(nonceValue) || nonceValue < 1 || nonceValue > 0x7ffffffe) {
    throw guardError("fresh_receipt_invalid", {}, "创建 nonce 非法");
  }
  if (!Number.isInteger(Number(markerFd)) || Number(markerFd) < 0) {
    throw guardError("fresh_receipt_invalid", {}, "创建回执必须绑定 O_EXCL 创建所有权标记时持有的文件句柄");
  }
  if (Number(markerFd) === Number(fd)) {
    throw guardError("fresh_receipt_invalid", {}, "库文件与所有权标记必须是两个不同的创建句柄");
  }
  const expectedMarker = typeof markerContent === "string" ? markerContent : "";
  if (!expectedMarker) {
    throw guardError("fresh_receipt_invalid", {}, "创建回执必须记录所有权标记的期望内容");
  }
  let markerCreated;
  try { markerCreated = fstatSync(Number(markerFd)); } catch {
    throw guardError("fresh_receipt_invalid", {}, "所有权标记创建句柄已不可用：无法证明本次创建的标记对象");
  }
  if (!markerCreated.isFile()) {
    throw guardError("fresh_receipt_invalid", {}, "所有权标记创建句柄不是普通文件");
  }
  if (markerIdentity && !sameIdentity(identityOf(markerCreated), markerIdentity)) {
    throw guardError("fresh_receipt_invalid", {}, "所有权标记创建句柄与登记身份不一致");
  }
  if (Number(markerCreated.size) !== Buffer.byteLength(expectedMarker, "utf8")) {
    throw guardError("fresh_receipt_invalid", {}, "所有权标记创建句柄的大小与期望内容不一致");
  }
  const key = canonical(resolvedDb);
  if (ACTIVE_BY_DB_PATH.has(key)) {
    throw guardError("fresh_target_claimed", {}, "同一进程内已存在该目标库的创建回执");
  }
  const facts = Object.freeze({
    dataDir: resolvedDir,
    dbPath: resolvedDb,
    markerPath: resolve(String(markerPath)),
    identity: Object.freeze({ dev: String(identity.dev), ino: String(identity.ino) }),
    fd: Number(fd),
    pid: Number(pid) || 0,
    nonce: nonceValue,
    applicationId: CLAIM_APPLICATION_ID,
    markerFd: Number(markerFd),
    markerIdentity: Object.freeze(identityOf(markerCreated)),
    markerContent: expectedMarker,
    registeredAt: new Date().toISOString(),
  });
  const token = {};
  CLAIM_FACTS.set(token, facts);
  ACTIVE_BY_DB_PATH.set(key, token);
  return token;
}

/** 只读的创建事实快照（内部记录，不含任何来自调用方对象的可变字段）。 */
export function describeFreshClaim(token) {
  const facts = requireFacts(token);
  return {
    dataDir: facts.dataDir, dbPath: facts.dbPath, markerPath: facts.markerPath,
    pid: facts.pid, nonce: facts.nonce, applicationId: facts.applicationId,
    identity: { dev: facts.identity.dev, ino: facts.identity.ino },
    stamped: STAMPED_FACTS.has(facts),
  };
}

/**
 * 目录 / 文件层身份校验：拒绝符号链接 / junction、realpath 不一致、文件消失。
 * 只读（lstat / realpath），不写任何内容。
 */
function inspectClaimPaths(facts) {
  let dirStat;
  try { dirStat = lstatSync(facts.dataDir); } catch { throw guardError("data_dir_unreadable", {}, "数据目录已不可读"); }
  if (dirStat.isSymbolicLink()) throw guardError("data_dir_alias", {}, "数据目录不能是符号链接 / junction");
  if (!dirStat.isDirectory()) throw guardError("data_dir_invalid", {}, "数据目录必须是真实目录");
  let dirReal;
  try { dirReal = realpathSync(facts.dataDir); } catch { throw guardError("data_dir_unreadable", {}, "数据目录无法解析真实路径"); }
  if (!samePath(dirReal, facts.dataDir)) {
    throw guardError("data_dir_alias", {}, "数据目录解析后的真实路径与显式路径不一致（别名 / junction）");
  }
  let fileStat;
  try { fileStat = lstatSync(facts.dbPath); } catch { throw guardError("fresh_database_missing", {}, "本次创建的库文件已不存在"); }
  if (fileStat.isSymbolicLink()) throw guardError("fresh_database_alias", {}, "workbench.db 变成了符号链接 / junction");
  if (!fileStat.isFile()) throw guardError("fresh_database_alias", {}, "workbench.db 必须是普通文件");
  let fileReal;
  try { fileReal = realpathSync(facts.dbPath); } catch { throw guardError("fresh_database_unreadable", {}, "workbench.db 无法解析真实路径"); }
  if (!samePath(fileReal, facts.dbPath)) {
    throw guardError("fresh_database_alias", {}, "workbench.db 真实路径与目标不一致（别名替换）");
  }
  return { dev: String(fileStat.dev), ino: String(fileStat.ino), size: Number(fileStat.size) };
}

/** 创建 fd 自身的身份（不经路径）：即使路径被换走 / 换回也能证明「本进程创建对象」是否还在。 */
function inspectClaimFd(facts) {
  let stat;
  try { stat = fstatSync(facts.fd); } catch {
    throw guardError("fresh_database_missing", {}, "创建句柄已不可用：无法证明本进程创建对象");
  }
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size) };
}

function connectionFacts(db) {
  const main = db.prepare(`PRAGMA database_list`).all().find((row) => row.name === "main") || null;
  const applicationId = Number(db.prepare(`PRAGMA application_id`).get()?.application_id ?? NaN);
  const userVersion = Number(db.prepare(`PRAGMA user_version`).get()?.user_version ?? NaN);
  const pageCount = Number(db.prepare(`PRAGMA page_count`).get()?.page_count ?? NaN);
  const schemaObjects = Number(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master`).get()?.n ?? NaN);
  let location = null;
  try { location = typeof db.location === "function" ? db.location() : null; } catch { location = null; }
  return { mainFile: main?.file ?? null, applicationId, userVersion, pageCount, schemaObjects, location };
}

/**
 * 把「本进程创建事实」与「实际打开的连接」绑定校验。
 * 只读：只执行 PRAGMA / SELECT，绝不在连接上写入。顺序：
 *   文件身份（替换 / 别名）→ 创建 fd 身份 → 连接页 1 nonce / 魔数 / 路径 → 复核身份。
 */
export function assertConnectionOwnsClaim(db, facts, { phase = "verify", requirePristine = false } = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw guardError("fresh_receipt_invalid", {}, "缺少可校验的 SQLite 连接");
  }
  const before = inspectClaimPaths(facts);
  if (!sameIdentity(before, facts.identity)) {
    throw guardError("fresh_database_replaced", { phase }, "库文件在创建后被替换：拒绝在他人库上执行任何核心 DDL / WAL / 迁移写");
  }
  if (before.size === 0) {
    // 本进程创建的文件在 claim 完成时必然已写入页 1 种子；零字节说明不是本次创建的对象。
    throw guardError("fresh_database_foreign_content", { phase }, "目标库文件不是本次创建并写入标记的对象");
  }
  if (!STAMPED_FACTS.has(facts)) {
    throw guardError("fresh_database_not_pristine", { phase }, "本次创建尚未写入页 1 种子：拒绝继续");
  }
  const created = inspectClaimFd(facts);
  if (!sameIdentity(created, facts.identity) || created.size === 0) {
    throw guardError("fresh_database_replaced", { phase }, "本进程创建的文件对象已被替换 / 清空");
  }
  let conn;
  try { conn = connectionFacts(db); } catch {
    // 连接存在但读不到页 1 头部（例如同路径同 dev/ino 但内容已被改写成非 SQLite 文件）：
    // 仍然是 fail-closed，且不向上暴露原生 SQLite 错误当成「基础设施错误」。
    throw guardError("fresh_database_foreign_content", { phase }, "连接无法读取页 1 头部：实际连接不是本次创建的 SQLite 库");
  }
  if (!samePath(conn.mainFile, facts.dbPath)) {
    throw guardError("fresh_database_mismatch", { phase }, "已打开的连接不是本次独占创建的目标文件");
  }
  if (conn.location && !samePath(conn.location, facts.dbPath)) {
    throw guardError("fresh_database_mismatch", { phase }, "SQLite 连接位置与目标文件不一致");
  }
  // 决定性证据：这条连接必须能读到本进程 claim 时写进页 1 的随机 nonce / 魔数。
  // 外部旧库 / 零字节外部文件 / 「换走再换回」都会让这里读到 0 或别的值。
  // nonce 不是秘密（标记 JSON / describeFreshClaim / 测试诊断都有它），它只证明「这条连接里读到的
  // 是本进程写下的值」；授权仍来自私有事实 + 创建 fd + 连接核验。
  if (conn.applicationId !== facts.applicationId || conn.userVersion !== facts.nonce) {
    throw guardError(
      "fresh_database_foreign_content", { phase },
      "连接无法读到本次创建写入的页 1 标记：实际连接的库不是本次创建对象",
    );
  }
  if (!(conn.pageCount >= 1)) {
    throw guardError("fresh_database_foreign_content", { phase }, "连接中没有本进程写入的页 1");
  }
  if (requirePristine && conn.schemaObjects !== 0) {
    throw guardError("fresh_database_foreign_content", { phase }, "核心 DDL 之前连接里已有 schema 对象：不是本次创建的空库");
  }
  const fdAfter = inspectClaimFd(facts);
  const after = inspectClaimPaths(facts);
  if (!sameIdentity(fdAfter, facts.identity) || !sameIdentity(after, facts.identity) || after.size === 0) {
    throw guardError("fresh_database_replaced", { phase }, "校验期间库文件被替换");
  }
  return {
    dev: after.dev, ino: after.ino, applicationId: conn.applicationId, userVersion: conn.userVersion,
    bytes: after.size,
  };
}

/**
 * 所有权标记的归属校验：创建句柄身份 → 路径对象身份 → realpath → 期望内容。
 * 只比对注册时从 `fstat(markerFd)` 抓到的不可变身份与写下的期望内容；nonce 只是其中一个字段，
 * 同一个 nonce 的新文件对象 / 追加了字段的外部标记都会在这里被识别为「不是我的」。
 */
function inspectMarkerOwnership(facts) {
  let created;
  try { created = fstatSync(facts.markerFd); } catch {
    throw guardError("fresh_receipt_stale", {}, "标记创建句柄已不可用：无法证明所有权标记对象");
  }
  if (!sameIdentity(identityOf(created), facts.markerIdentity)) {
    throw guardError("fresh_receipt_stale", {}, "本进程创建的标记对象已被替换");
  }
  let stat;
  try { stat = lstatSync(facts.markerPath); } catch {
    throw guardError("fresh_receipt_stale", {}, "新建所有权标记已丢失 / 无法读取：拒绝继续");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw guardError("fresh_receipt_stale", {}, "所有权标记必须是普通文件（不是符号链接 / junction）");
  }
  if (!sameIdentity(identityOf(stat), facts.markerIdentity)) {
    throw guardError("fresh_receipt_stale", {}, "所有权标记文件对象不是本进程创建的那一个（同 nonce 的替换对象同样拒绝）");
  }
  let real;
  try { real = realpathSync(facts.markerPath); } catch {
    throw guardError("fresh_receipt_stale", {}, "所有权标记无法解析真实路径：拒绝继续");
  }
  if (!samePath(real, facts.markerPath)) {
    throw guardError("fresh_receipt_stale", {}, "所有权标记真实路径与目标不一致（别名 / junction）");
  }
  let content;
  try { content = readFileSync(facts.markerPath, "utf8"); } catch {
    throw guardError("fresh_receipt_stale", {}, "所有权标记无法读取：拒绝继续");
  }
  if (content !== facts.markerContent) {
    throw guardError("fresh_receipt_stale", {}, "所有权标记内容已被改写：不是本进程写下的那份");
  }
  return { identity: identityOf(stat), content };
}

function assertMarkerOwnership(facts) {
  inspectMarkerOwnership(facts);
}

/** 用真实 SQLite（只读连接）校验页 1 种子是否被接受为「本进程创建的空库」。 */
function verifySeedWithSqlite(facts) {
  let probe = null;
  try {
    probe = new DatabaseSync(facts.dbPath, { readOnly: true });
    const applicationId = Number(probe.prepare(`PRAGMA application_id`).get()?.application_id ?? NaN);
    const userVersion = Number(probe.prepare(`PRAGMA user_version`).get()?.user_version ?? NaN);
    const pageCount = Number(probe.prepare(`PRAGMA page_count`).get()?.page_count ?? NaN);
    const objects = Number(probe.prepare(`SELECT COUNT(*) AS n FROM sqlite_master`).get()?.n ?? NaN);
    if (applicationId !== facts.applicationId || userVersion !== facts.nonce || pageCount < 1 || objects !== 0) {
      throw guardError("fresh_claim_stamp_failed", { pageCount, objects },
        "页 1 种子经 SQLite 读回不一致（或路径已不再指向本次创建对象）");
    }
    return { pageCount, objects };
  } catch (error) {
    if (error?.code === "fresh_claim_stamp_failed") throw error;
    throw guardError("fresh_claim_stamp_failed", {}, "页 1 种子无法用 SQLite 校验（只读打开失败）");
  } finally {
    try { probe?.close(); } catch { /* 只读探测关闭失败不影响结论 */ }
  }
}

/**
 * 用**创建时持有的 fd** 写入页 1 种子（空库种子 + nonce + 魔数）。
 * 写入目标由 fd 绑定：即使路径在写入前/后被换走或 ABA 换回，写入也只落在本进程创建的对象上，
 * 外部文件不会被写入；写完后用只读 SQLite 连接（按路径）校验种子，读取失败 / nonce 不一致一律拒绝。
 */
export function stampFreshClaimNonce(token) {
  const facts = requireFacts(token);
  if (STAMPED_FACTS.has(facts)) {
    throw guardError("fresh_database_not_pristine", {}, "本次创建已写入页 1 种子：拒绝重复写入");
  }
  const created = inspectClaimFd(facts);
  if (!sameIdentity(created, facts.identity)) {
    throw guardError("fresh_database_replaced", {}, "创建后库文件被替换：拒绝写入任何标记");
  }
  if (created.size !== 0) {
    throw guardError("fresh_database_not_pristine", {}, "显式新目标的库文件不是零字节空库：拒绝写入标记");
  }
  // 路径也必须仍指向本进程创建的对象：否则写入本对象已不能证明「目标仍是本次创建」。
  const before = inspectClaimPaths(facts);
  if (!sameIdentity(before, facts.identity) || before.size !== 0) {
    throw guardError("fresh_database_replaced", {}, "写入标记前库文件被替换：拒绝写入");
  }
  const bytes = seededPage1(facts.nonce);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(facts.fd, bytes, offset, bytes.length - offset, offset);
    if (!(written > 0)) throw guardError("fresh_claim_stamp_failed", {}, "页 1 种子写入未推进");
    offset += written;
  }
  fsyncSync(facts.fd);
  const after = inspectClaimFd(facts);
  if (!sameIdentity(after, facts.identity) || after.size !== bytes.length) {
    throw guardError("fresh_claim_stamp_failed", {}, "页 1 种子写入后创建句柄身份 / 大小不一致");
  }
  // 真实 SQLite 校验（只读连接，不会写外部文件）。
  const verified = verifySeedWithSqlite(facts);
  const pathAfter = inspectClaimPaths(facts);
  if (!sameIdentity(pathAfter, facts.identity) || pathAfter.size !== bytes.length) {
    throw guardError("fresh_database_replaced", {}, "写入标记后库文件被替换：拒绝继续");
  }
  STAMPED_FACTS.add(facts);
  return {
    applicationId: facts.applicationId, userVersion: facts.nonce, bytes: after.size,
    pageCount: verified.pageCount, schemaObjects: verified.objects,
  };
}

/** 批量结构安装前的完整校验：标记仍属于本进程 + 连接确实是本次创建对象。 */
export function assertFreshClaimConnection(token, db) {
  const facts = requireFacts(token);
  assertMarkerOwnership(facts);
  return assertConnectionOwnsClaim(db, facts, { phase: "schema-install" });
}

/**
 * `db.mjs` 初始化钩子：在**任何核心 DDL / WAL 持久设置 / 迁移写之前**调用。
 * 没有登记创建事实（普通业务入口）时返回 `{ claimed: false }`，行为与旧实现一致；
 * 有登记时必须证明「这条连接挂载的就是本次创建对象」，否则抛错（此时尚未执行任何写语句）。
 */
export function assertOpenedDatabaseClaimsMatch(db, { dataDir, dbPath } = {}) {
  const target = dbPath ? resolve(String(dbPath)) : (dataDir ? resolve(String(dataDir), "workbench.db") : null);
  const token = target ? ACTIVE_BY_DB_PATH.get(canonical(target)) : null;
  const facts = token ? CLAIM_FACTS.get(token) : null;
  if (!facts) {
    // 本进程仍持有活动的创建事实，而核心这次要打开的不是那次创建的目标（另一个数据目录 / 别名 /
    // junction / 未指定目录）：必须在任何核心 DDL / WAL / 迁移写之前拒绝。不能因为按路径查表未命中就
    // 当成「普通入口」——那恰好允许在 guard 之前把核心结构写进另一个既有库。
    if (ACTIVE_BY_DB_PATH.size > 0) {
      throw guardError(
        "fresh_claim_target_mismatch",
        { activeClaims: ACTIVE_BY_DB_PATH.size, target: target ? basename(target) : null },
        "本进程持有独占新建回执，但核心首次打开的目标不是该次创建对象的路径：拒绝在任何核心 DDL / WAL / 迁移写之前继续",
      );
    }
    return { claimed: false };
  }
  // db-init 阶段要求连接里还没有任何 schema 对象：DDL 之前看到表，说明连的不是本次创建的空库。
  assertConnectionOwnsClaim(db, facts, { phase: "db-init", requirePristine: true });
  return { claimed: true };
}

/** 只有「本进程刚创建、身份未变、除页 1 种子外没有任何 schema 对象」的库才允许在失败清理时删除。 */
function isPristineClaimDatabase(facts) {
  let probe = null;
  try {
    probe = new DatabaseSync(facts.dbPath, { readOnly: true });
    const applicationId = Number(probe.prepare(`PRAGMA application_id`).get()?.application_id ?? NaN);
    const userVersion = Number(probe.prepare(`PRAGMA user_version`).get()?.user_version ?? NaN);
    if (applicationId !== facts.applicationId || userVersion !== facts.nonce) return false;
    const objects = Number(probe.prepare(`SELECT COUNT(*) AS n FROM sqlite_master`).get()?.n ?? 1);
    return objects === 0;
  } catch {
    return false;
  } finally {
    try { probe?.close(); } catch { /* 只读探测关闭失败不影响结论 */ }
  }
}

/**
 * 释放回执：全部判断只读模块私有事实（调用方 token 上的任何字段都不参与）。
 * 只删除「文件对象仍是创建时 dev/ino 且内容仍是本进程写下的那份」的自己的标记，以及
 * 「身份仍是创建时 dev/ino 且仍只有页 1 种子」的自己创建的库文件；被替换（含同 nonce 的新对象）/ 已有核心表 /
 * 外部零字节文件一律保留现场。重复 release 是无副作用的 no-op。
 */
export function releaseFreshClaimFacts(token) {
  const facts = token && typeof token === "object" ? CLAIM_FACTS.get(token) : null;
  if (!facts) return { released: false, markerRemoved: false, databaseRemoved: false };
  CLAIM_FACTS.delete(token);
  STAMPED_FACTS.delete(facts);
  const key = canonical(facts.dbPath);
  if (ACTIVE_BY_DB_PATH.get(key) === token) ACTIVE_BY_DB_PATH.delete(key);
  try { closeSync(facts.fd); } catch { /* 句柄已关闭不影响结论 */ }
  let markerRemoved = false;
  try {
    // 只认「创建时抓到的对象身份 + 本进程写下的期望内容」；nonce 相同的新对象 / 追加字段的外部标记保留。
    inspectMarkerOwnership(facts);
    unlinkSync(facts.markerPath);
    markerRemoved = true;
  } catch { /* 标记已被替换 / 删除 / 内容被改写：不碰他人对象 */ }
  try { closeSync(facts.markerFd); } catch { /* 句柄已关闭不影响结论 */ }
  let databaseRemoved = false;
  try {
    const stat = lstatSync(facts.dbPath);
    if (!stat.isSymbolicLink() && stat.isFile() && sameIdentity(identityOf(stat), facts.identity)
        && samePath(realpathSync(facts.dbPath), facts.dbPath) && isPristineClaimDatabase(facts)) {
      unlinkSync(facts.dbPath);
      databaseRemoved = true;
    }
  } catch { /* 库文件已被替换 / 删除 / 已有结构：保留现场 */ }
  return { released: true, markerRemoved, databaseRemoved };
}

/** 供存储层 / CLI 判断某个错误是否属于「库身份」类（退出码 3、需人工核对现场）。 */
export function isDatabaseIdentityCode(code) {
  return IDENTITY_CODES.has(String(code));
}
