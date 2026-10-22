#!/usr/bin/env node
/**
 * scripts/windows-runtime-check.mjs — Windows 交付包的运行时 / 目录 / 字体预检。
 *
 * 只做三件事：
 *  1) 在**不加载任何业务模块、不打开任何产品数据库**的前提下，探测本机运行时是否满足
 *     Windows 交付所需的最小 API 集合（node:sqlite 无 flag 可用、事务标志、真正只读、
 *     有界 busy timeout、必要 fs 能力）。可阻塞的 sqlite / fs 探针放在**独立子进程**内，
 *     由本进程用真实 deadline（MAX_PROBE_MS）强杀并回收，不用「信息字段」冒充限时。
 *  2) 只在显式给出的数据目录 / 本进程自建的专属临时根上做探测；不枚举驱动器、不扫描
 *     home 或系统 TEMP、不读取用户字体目录、不读取任何凭据或 npm 配置。
 *     数据目录只做**只读**检查（不写删探针）；真实写 / 删能力由自建根内的真实探针证明。
 *  3) 版本 / 平台 / 架构不合格时**先拒绝**，拒绝早于任何目录写探针。
 *
 * 专属临时根（同时是交付验收脚本 / 测试复用的共享守卫，见下方导出）：
 *  - 默认 `<本脚本所属 06-workbench>/tmp/windows-delivery/` 下建随机**新**目录；
 *  - 也可用 `--scratch-root <绝对路径>` 显式传入（发布目录只读时必须这样给）；
 *    显式入参先校验“原始字符串就是绝对路径”（不能 resolve 后再查），且由调用者显式授权、
 *    专用于本次任务；本守卫从不删除 base，也不枚举 base 下的其它目录。
 *  - 任何 mkdir 之前：从最近已存在祖先**逐级到卷根**核验（有 symlink / junction 就拒绝）；
 *    创建后再次核验完整祖先链与 realpath 等于预期规范化路径；删除前重验同一链。
 *  - manifest 记录精确绝对路径 + 运行 token + 任务 + **逐项删除目标与其 realpath**，
 *    与内存记录双向互校；不从磁盘 manifest 导入任何删除目标。读 / 写 manifest 之前先核验
 *    它本身就是内存固定 root 内的预期普通文件（祖先链 + realpath + 非重解析点）；核验不过
 *    一律拒绝——不先读目标再判断，也不把损坏 manifest 覆盖成有效授权。
 *  - 删除只有一个入口（已登记 + 根内 + realpath + 完整祖先链 + 树内无重解析点），
 *    任何不确定 → 保留并非零退出。
 *
 * 用法（在 06-workbench 下）：
 *   node scripts/windows-runtime-check.mjs --json
 *   node scripts/windows-runtime-check.mjs --json --data-dir <显式数据目录>
 *   node scripts/windows-runtime-check.mjs --json --scratch-root <工作区绝对路径>
 *   node scripts/windows-runtime-check.mjs --help
 *
 * 输出为**白名单字段**的 JSON：版本 / 平台 / 架构 / 各检查状态 / 稳定错误码 / 字体候选的
 * 文件名（不是完整路径）。不输出环境变量、用户名、绝对路径或堆栈。
 *
 * 退出码：0 = 可用；1 = 用法错误；2 = 明确拒绝（版本 / 平台 / API / 目录 / 清理不合格）；
 *         3 = 预检自身内部错误。
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants as FS,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL = "windows-runtime-check";
export const TOOL_SCHEMA_VERSION = 1;
export const OWNER_TASK = "LOCAL-06-WINDOWS";
/** 本交付包**实际跑过完整验收**的 Node 版本；不是「支持所有 24.x / 22.x」的声明。 */
export const TESTED_NODE_VERSION = "24.15.0";
/** 冻结源码 API 分析下限（仅信息字段，来自官方版本文档，不是实测放行条件）。 */
export const ANALYZED_MINIMUM_NODE_VERSION = "22.16.0";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKBENCH_ROOT = dirname(HERE);
/** 隔离子进程探针的真实 deadline；超时即强杀并返回稳定错误码。 */
const MAX_PROBE_MS = 15000;
export const MANIFEST_PREFIX = ".wb-scratch-";
/** manifest v2：除精确绝对路径 / token / 任务外，还逐项登记删除目标与其 realpath。 */
export const MANIFEST_SCHEMA_VERSION = 2;
/** 允许写本任务族所有权 manifest 的工具；manifest 里的 tool 必须与内存记录一致。 */
export const SCRATCH_TOOLS = Object.freeze(["windows-runtime-check", "windows-delivery-check", "windows-delivery-test"]);
const MAX_ANCESTOR_DEPTH = 128;

/** 专属临时根 / 所有权守卫的稳定错误（早于任何 mkdir 抛出）。 */
export class ScratchGuardError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = "ScratchGuardError";
    this.code = code;
    this.details = options.details ?? null;
    this.cleanup = options.cleanup ?? null;
  }
}

// ------------------------------------------------------------------ 专属临时根 + 所有权 manifest

/** 默认专属根：本脚本所属 workbench 的 `tmp/windows-delivery`（不使用系统 TEMP）。 */
export function defaultScratchBase() {
  return join(WORKBENCH_ROOT, "tmp", "windows-delivery");
}

function pathKey(path) {
  return resolve(path).toLowerCase();
}

function isInsideRoot(root, target) {
  if (typeof root !== "string" || root === "" || typeof target !== "string" || target === "") return false;
  const base = pathKey(root);
  const value = pathKey(target);
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  return value === base || value.startsWith(prefix);
}

function lstatOrNull(path) {
  try { return lstatSync(path); } catch { return null; }
}

function realpathOrNull(path) {
  try { return realpathSync(path); } catch { return null; }
}

/**
 * 从 target 逐级向上核验到**卷根**（Windows 形如 `<盘符>:\`）：
 * 每级必须存在、不是 symlink / junction / reparse point，且 realpath 与自顶规范路径一致。
 * 只读检查；不创建、不枚举、不删除。任一级不符即拒绝。
 * **只有真的走到卷根才 ok**：深度耗尽一律 `path_too_deep` 拒绝，不把「没核验完」当通过。
 */
export function auditAncestorChain(target) {
  if (typeof target !== "string" || target === "" || !isAbsolute(target)) return { ok: false, reason: "path_not_absolute" };
  const resolvedTarget = resolve(target);
  const volumeRoot = parse(resolvedTarget).root;
  if (!volumeRoot || !isAbsolute(volumeRoot)) return { ok: false, reason: "volume_root_unknown" };
  let current = resolvedTarget;
  let checkedDepth = 0;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const stat = lstatOrNull(current);
    if (!stat) return { ok: false, reason: depth === 0 ? "target_missing" : "ancestor_missing" };
    if (stat.isSymbolicLink()) return { ok: false, reason: "reparse_point_in_ancestor_chain" };
    const real = realpathOrNull(current);
    if (!real) return { ok: false, reason: "ancestor_realpath_failed" };
    if (pathKey(real) !== pathKey(current)) return { ok: false, reason: "ancestor_realpath_mismatch" };
    checkedDepth += 1;
    if (pathKey(current) === pathKey(volumeRoot)) {
      return { ok: true, reason: null, volumeRoot: pathKey(volumeRoot), checkedDepth, reachedVolumeRoot: true };
    }
    const parent = dirname(current);
    // 尚未到卷根却已无父目录：整条链核验不完，同样拒绝（fail closed）。
    if (parent === current) return { ok: false, reason: "path_too_deep" };
    current = parent;
  }
  return { ok: false, reason: "path_too_deep" };
}

/**
 * 创建前检查：找最近已存在祖先，并从它逐级核验到卷根。
 * **必须在任何 mkdir 之前调用**；不存在的更深层级因此永远不会被写入。
 */
export function auditExistingAncestorChain(target) {
  if (typeof target !== "string" || target === "" || !isAbsolute(target)) return { ok: false, reason: "path_not_absolute" };
  let current = resolve(target);
  let nearest = null;
  let depthExhausted = true;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    if (lstatOrNull(current)) { nearest = current; depthExhausted = false; break; }
    const parent = dirname(current);
    if (parent === current) { depthExhausted = false; break; }
    current = parent;
  }
  if (depthExhausted) return { ok: false, reason: "path_too_deep" };
  if (!nearest) return { ok: false, reason: "no_existing_ancestor" };
  const audit = auditAncestorChain(nearest);
  if (!audit.ok) return audit;
  return { ...audit, nearest };
}

/** 扫描目标树：任何 symlink / junction / reparse point 都拒绝递归删除；读不了 / 过大同样拒绝。 */
export function scanTreeForReparse(target) {
  const stack = [resolve(target)];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return { ok: false, reason: "tree_read_failed" };
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > 200000) return { ok: false, reason: "tree_too_large" };
      if (entry.isSymbolicLink()) return { ok: false, reason: "reparse_point_inside_tree" };
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
    }
  }
  return { ok: true, scanned: seen };
}

function manifestTargets(record) {
  return [...record.tracked.values()]
    .map((entry) => ({ path: entry.path, real: entry.real, reason: entry.reason ?? "tracked" }))
    .sort((left, right) => pathKey(left.path).localeCompare(pathKey(right.path)));
}

/**
 * manifest 自身的路径核验（**读 / 写之前**必须先通过）：
 *  - 精确等于内存记录推出的预期文件名（不是「根内任意 json」）；
 *  - 位于内存固定 root 与 rootReal 内；
 *  - root 自身到卷根的完整祖先链已核验，且 root 的 realpath 等于内存值；
 *  - 已存在时必须是普通文件，不是 symlink / junction，realpath 与预期相符。
 * 只读检查：不创建、不枚举、不删除，也**不从磁盘上的任何路径重新授权**。
 */
function auditManifestTarget(record) {
  if (!record || typeof record !== "object") return { ok: false, reason: "manifest_target_unavailable" };
  const { root, rootReal, token, manifestPath } = record;
  if (typeof root !== "string" || root === "" || !isAbsolute(root)) return { ok: false, reason: "manifest_root_unavailable" };
  if (typeof rootReal !== "string" || rootReal === "" || !isAbsolute(rootReal)) return { ok: false, reason: "manifest_root_real_unavailable" };
  if (typeof token !== "string" || token === "") return { ok: false, reason: "manifest_token_unavailable" };
  if (typeof manifestPath !== "string" || manifestPath === "" || !isAbsolute(manifestPath)) return { ok: false, reason: "manifest_path_unavailable" };
  const expectedPath = join(resolve(root), `${MANIFEST_PREFIX}${token}.json`);
  const expectedReal = join(rootReal, `${MANIFEST_PREFIX}${token}.json`);
  if (pathKey(manifestPath) !== pathKey(expectedPath)) return { ok: false, reason: "manifest_path_not_expected" };
  if (!isInsideRoot(root, manifestPath)) return { ok: false, reason: "manifest_outside_root" };
  if (!isInsideRoot(rootReal, manifestPath)) return { ok: false, reason: "manifest_outside_root_real" };
  const rootStat = lstatOrNull(root);
  if (!rootStat) return { ok: false, reason: "manifest_root_missing" };
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { ok: false, reason: "manifest_root_not_directory" };
  const rootChain = auditAncestorChain(root);
  if (!rootChain.ok) return { ok: false, reason: `manifest_root_${rootChain.reason}` };
  const rootRealActual = realpathOrNull(root);
  if (!rootRealActual || pathKey(rootRealActual) !== pathKey(rootReal)) return { ok: false, reason: "manifest_root_realpath_mismatch" };
  const stat = lstatOrNull(manifestPath);
  if (!stat) return { ok: true, exists: false, path: manifestPath, real: expectedReal };
  if (stat.isSymbolicLink()) return { ok: false, reason: "manifest_is_reparse_point" };
  if (!stat.isFile()) return { ok: false, reason: "manifest_not_regular_file" };
  const real = realpathOrNull(manifestPath);
  if (!real) return { ok: false, reason: "manifest_realpath_failed" };
  if (pathKey(real) !== pathKey(expectedReal)) return { ok: false, reason: "manifest_realpath_mismatch" };
  return { ok: true, exists: true, path: manifestPath, real };
}

/**
 * 把内存记录写成 manifest（临时文件独占创建 + rename，避免半截内容），不从磁盘导入任何目标。
 * 顺序固定：先核验 manifest 自身与 root 祖先链 → 再确认既有 manifest 仍是本次运行写过的
 * root 内普通文件 → 最后独占创建 `.writing-<token>` 临时文件并 rename。任何一步不通过就抛错：
 * 不覆盖已有临时文件、不跟随其链接、也不接管别人的 manifest。
 */
function writeScratchManifest(record) {
  const target = auditManifestTarget(record);
  if (!target.ok) throw new ScratchGuardError("scratch_manifest_unverified", { details: { reason: target.reason } });
  if (!target.exists && record.manifestWritten === true) {
    throw new ScratchGuardError("scratch_manifest_vanished", { details: { reason: "manifest_missing_before_update" } });
  }
  if (target.exists && record.manifestWritten !== true) {
    throw new ScratchGuardError("scratch_manifest_preexisting", { details: { reason: "manifest_not_written_by_this_run" } });
  }
  const payload = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    tool: record.tool,
    ownerTask: record.ownerTask,
    runToken: record.token,
    label: record.label,
    base: record.base,
    baseReal: record.baseReal ?? null,
    root: record.root,
    rootReal: record.rootReal ?? null,
    createdAt: record.createdAt,
    pid: process.pid,
    targets: manifestTargets(record),
    note: "删除前必须同时满足：目标在内存与 manifest 中都登记且 realpath 一致、绝对路径在专属根内、完整祖先链到卷根无 symlink/junction、目标内部无 reparse point；不按名称/前缀推断所有权，也不从磁盘 manifest 导入任何删除目标。",
  };
  const tempPath = `${target.path}.writing-${record.token}`;
  try {
    // `wx` = O_CREAT|O_EXCL：不覆盖已存在的 .writing-token 文件，也不跟随其链接（已存在即失败）。
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    throw new ScratchGuardError("scratch_manifest_write_failed", { details: { stage: "temp_create", code: error?.code ?? null } });
  }
  try {
    renameSync(tempPath, target.path);
  } catch (error) {
    // 临时文件留在 root 内，不用“顺手删”来掩盖失败：删除只走同一守卫。
    throw new ScratchGuardError("scratch_manifest_write_failed", { details: { stage: "rename", code: error?.code ?? null } });
  }
  record.manifestWritten = true;
  return payload;
}

/**
 * 读回 manifest 并与内存记录双向互校（数量一致、双向包含、realpath 一致）。
 * **先核验路径本身**（内存固定 root 内的预期普通文件 + 完整祖先链 + realpath）：核验不过就
 * `manifestVerified:false` 拒绝，绝不先读目标再判断。
 * 缺失 / 破坏 / 多出的磁盘目标一律拒绝：绝不把磁盘上的路径当成删除依据。
 */
export function verifyScratchManifest(record) {
  const target = auditManifestTarget(record);
  if (!target.ok) return { ok: false, reason: target.reason, targets: [] };
  if (!target.exists) return { ok: false, reason: "manifest_unreadable", targets: [] };
  let text;
  try { text = readFileSync(target.path, "utf8"); } catch { return { ok: false, reason: "manifest_unreadable", targets: [] }; }
  let manifest;
  try { manifest = JSON.parse(text); } catch { return { ok: false, reason: "manifest_unreadable", targets: [] }; }
  if (!manifest || typeof manifest !== "object") return { ok: false, reason: "manifest_unreadable", targets: [] };
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) return { ok: false, reason: "manifest_schema_mismatch", targets: [] };
  if (manifest.tool !== record.tool) return { ok: false, reason: "manifest_tool_mismatch", targets: [] };
  if (manifest.ownerTask !== record.ownerTask) return { ok: false, reason: "manifest_owner_mismatch", targets: [] };
  if (manifest.runToken !== record.token) return { ok: false, reason: "manifest_token_mismatch", targets: [] };
  if (typeof manifest.root !== "string" || pathKey(manifest.root) !== pathKey(record.root)) {
    return { ok: false, reason: "manifest_root_mismatch", targets: [] };
  }
  if (typeof manifest.base !== "string" || pathKey(manifest.base) !== pathKey(record.base)) {
    return { ok: false, reason: "manifest_base_mismatch", targets: [] };
  }
  if (!Array.isArray(manifest.targets)) return { ok: false, reason: "manifest_targets_missing", targets: [] };
  if (manifest.targets.length !== record.tracked.size) return { ok: false, reason: "manifest_targets_count_mismatch", targets: [] };
  const seen = new Set();
  for (const item of manifest.targets) {
    if (!item || typeof item.path !== "string" || !isAbsolute(item.path)) return { ok: false, reason: "manifest_target_not_absolute", targets: [] };
    if (typeof item.real !== "string" || !isAbsolute(item.real)) return { ok: false, reason: "manifest_real_not_absolute", targets: [] };
    if (!isInsideRoot(record.root, item.path)) return { ok: false, reason: "manifest_target_outside_root", targets: [] };
    if (!isInsideRoot(record.rootReal, item.real)) return { ok: false, reason: "manifest_real_outside_root", targets: [] };
    const key = pathKey(item.path);
    if (seen.has(key)) return { ok: false, reason: "manifest_target_duplicate", targets: [] };
    seen.add(key);
    const memory = record.tracked.get(key);
    if (!memory) return { ok: false, reason: "manifest_target_not_in_memory", targets: [] };
    if (pathKey(memory.real) !== pathKey(item.real)) return { ok: false, reason: "manifest_realpath_mismatch", targets: [] };
  }
  return { ok: true, reason: null, targets: manifest.targets };
}

/** 单个目标的审计：已登记 + 根内 + 完整祖先链到卷根 + 非重解析点 + realpath 一致。 */
function auditTrackedPath(record, target) {
  if (typeof target !== "string" || target === "") return { ok: false, reason: "target_empty" };
  if (!isAbsolute(target)) return { ok: false, reason: "target_not_absolute" };
  const resolvedTarget = resolve(target);
  const memory = record.tracked.get(pathKey(resolvedTarget));
  if (!memory) return { ok: false, reason: "target_not_registered" };
  if (!isInsideRoot(record.root, resolvedTarget)) return { ok: false, reason: "target_outside_scratch_root" };
  if (!isInsideRoot(record.rootReal, memory.real)) return { ok: false, reason: "tracked_realpath_outside_root" };
  const chain = auditAncestorChain(resolvedTarget);
  if (!chain.ok) return chain;
  const stat = lstatOrNull(resolvedTarget);
  if (!stat) return { ok: false, reason: "target_missing" };
  if (stat.isSymbolicLink()) return { ok: false, reason: "target_is_reparse_point" };
  const real = realpathOrNull(resolvedTarget);
  if (!real) return { ok: false, reason: "target_realpath_failed" };
  if (pathKey(real) !== pathKey(memory.real)) return { ok: false, reason: "target_realpath_mismatch" };
  if (!isInsideRoot(record.rootReal, real)) return { ok: false, reason: "target_realpath_outside_root" };
  return { ok: true, stat, resolvedTarget, memory };
}

/**
 * **唯一删除入口**：manifest + 内存 + 完整祖先链 + realpath + 无重解析点全部通过才删。
 * 成功后才从内存删登记并刷新 manifest（剩余登记同步）；任何失败都保留登记并如实返回。
 * @returns {{ok:boolean, reason:string|null, manifestVerified:boolean, manifestRefreshed?:boolean, deleted?:boolean}}
 */
export function removeTrackedPath(record, target) {
  const refuse = (reason, extra = {}) => ({ ok: false, reason: `cleanup_refused:${reason}`, manifestVerified: false, ...extra });
  if (!record || !(record.tracked instanceof Map)) return refuse("record_unavailable");
  if (typeof target !== "string" || target === "") return refuse("target_empty");
  if (!isAbsolute(target)) return refuse("target_not_absolute");
  const resolvedTarget = resolve(target);
  const key = pathKey(resolvedTarget);
  const memory = record.tracked.get(key);
  if (!memory) return refuse("target_not_registered");

  const manifest = verifyScratchManifest(record);
  if (!manifest.ok) return refuse(manifest.reason, { manifestVerified: false });
  const entry = manifest.targets.find((item) => pathKey(item.path) === key);
  if (!entry) return refuse("target_not_in_manifest", { manifestVerified: true });
  if (pathKey(entry.real) !== pathKey(memory.real)) return refuse("manifest_realpath_mismatch", { manifestVerified: true });

  const audit = auditTrackedPath(record, resolvedTarget);
  if (!audit.ok) return refuse(audit.reason, { manifestVerified: true });
  if (audit.stat.isDirectory()) {
    const scan = scanTreeForReparse(resolvedTarget);
    if (!scan.ok) return refuse(scan.reason, { manifestVerified: true });
  }
  try {
    rmSync(resolvedTarget, { recursive: audit.stat.isDirectory(), force: false, maxRetries: 3, retryDelay: 200 });
  } catch {
    return { ok: false, reason: "cleanup_failed:remove_error", manifestVerified: true };
  }
  if (existsSync(resolvedTarget)) return { ok: false, reason: "cleanup_failed:target_still_present", manifestVerified: true };

  record.tracked.delete(key);
  if (key === pathKey(record.root)) {
    // manifest 本身就在根内，随根一起消失：没有剩余登记可刷新。
    return { ok: true, reason: null, manifestVerified: true, manifestRefreshed: null, deleted: true };
  }
  try {
    writeScratchManifest(record);
  } catch {
    // 目标已删除但剩余登记无法写盘：保守报失败（根会保留，避免带着过期 manifest 递归删除）。
    return { ok: false, reason: "cleanup_failed:manifest_refresh_failed", manifestVerified: true, manifestRefreshed: false, deleted: true };
  }
  const verify = verifyScratchManifest(record);
  if (!verify.ok) return { ok: false, reason: `cleanup_failed:manifest_refresh_mismatch:${verify.reason}`, manifestVerified: true, manifestRefreshed: false, deleted: true };
  return { ok: true, reason: null, manifestVerified: true, manifestRefreshed: true, deleted: true };
}

/**
 * 登记一个**本次自建**路径（及其 realpath）到内存与 manifest；失败则不登记。
 * 更新 manifest 之前先核验**已存在的那份** manifest 仍与内存一致：磁盘上的损坏 / 篡改
 * manifest 不得被本次写入悄悄“修好”成有效授权。
 */
export function trackExistingPath(record, target, reason = "tracked") {
  if (!record || !(record.tracked instanceof Map)) return null;
  if (typeof target !== "string" || target === "" || !isAbsolute(target)) return null;
  const resolvedTarget = resolve(target);
  if (!isInsideRoot(record.root, resolvedTarget)) return null;
  if (pathKey(resolvedTarget) === pathKey(record.root)) return record.rootReal ?? null;
  const chain = auditAncestorChain(resolvedTarget);
  if (!chain.ok) return null;
  const real = realpathOrNull(resolvedTarget);
  if (!real) return null;
  if (!isInsideRoot(record.rootReal, real)) return null;
  // 先核验现有 manifest（读之前已验路径 / 普通文件 / 祖先链 / realpath），再改动内存。
  const existing = verifyScratchManifest(record);
  if (!existing.ok) return null;
  record.tracked.set(pathKey(resolvedTarget), { path: resolvedTarget, real, reason: String(reason).slice(0, 40) });
  try {
    writeScratchManifest(record);
  } catch {
    record.tracked.delete(pathKey(resolvedTarget));
    return null;
  }
  const verify = verifyScratchManifest(record);
  if (!verify.ok) {
    record.tracked.delete(pathKey(resolvedTarget));
    return null;
  }
  return real;
}

/** 删除整个专属根：先核验 manifest 与已登记目标，再走唯一删除入口。 */
export function removeScratchRecord(record) {
  if (!record || !(record.tracked instanceof Map)) {
    return { ok: false, reason: "cleanup_refused:record_unavailable", manifestVerified: false };
  }
  const manifest = verifyScratchManifest(record);
  if (!manifest.ok) return { ok: false, reason: `cleanup_refused:${manifest.reason}`, manifestVerified: false };
  for (const [key, entry] of record.tracked) {
    if (pathKey(entry.path) !== key) return { ok: false, reason: "cleanup_refused:tracked_key_mismatch", manifestVerified: true };
    if (!isInsideRoot(record.root, entry.path)) return { ok: false, reason: "cleanup_refused:target_outside_scratch_root", manifestVerified: true };
    if (!existsSync(entry.path)) continue;
    const audit = auditTrackedPath(record, entry.path);
    if (!audit.ok) return { ok: false, reason: `cleanup_refused:${audit.reason}`, manifestVerified: true };
  }
  const removal = removeTrackedPath(record, record.root);
  if (!removal.ok) return { ok: false, reason: removal.reason, manifestVerified: removal.manifestVerified === true };
  // 根已消失：清掉内存里随之消失的登记（manifest 已随根删除，无需也无法再写）。
  for (const [key, entry] of [...record.tracked]) {
    if (!existsSync(entry.path)) record.tracked.delete(key);
  }
  return { ok: true, reason: null, manifestVerified: true, targetsRemaining: record.tracked.size };
}

/**
 * 新建随机专属根并写入所有权 manifest（精确绝对路径 + 真实路径 + 运行 token + 任务 + 逐项目标）。
 * 顺序：显式 base 的**原始入参**先 inAbsolute 检查 → 最近已存在祖先逐级核验到卷根 → 才允许 mkdir
 * → 创建后再次核验完整祖先链与 realpath 等于预期规范化路径 → 写 manifest 并回读校验。
 * 任何一步不通过都不写 / 不枚举 / 不删。**创建中途失败不做抢救式回滚**：已创建的部分原样保留，
 * 返回 `attempted:false, completed:false, retained:true` 与原因，交给管理者定点核验；
 * 不在已判不安全的路径写 manifest、不扫描、不删除。
 */
export function createScratchRecord({ label = "scratch", basePath = null, tool = TOOL, ownerTask = OWNER_TASK } = {}) {
  if (!SCRATCH_TOOLS.includes(tool)) throw new ScratchGuardError("scratch_tool_not_allowed", { details: { reason: "unknown_tool" } });
  const explicit = basePath !== null && basePath !== undefined && basePath !== "";
  if (explicit && typeof basePath !== "string") throw new ScratchGuardError("scratch_root_invalid");
  // 原始入参必须先校验绝对路径：resolve() 会把相对路径补成绝对路径，之后检查永远通过。
  if (explicit && !isAbsolute(basePath)) throw new ScratchGuardError("scratch_root_not_absolute");
  const base = explicit ? resolve(basePath) : defaultScratchBase();
  if (!isAbsolute(base)) throw new ScratchGuardError("scratch_root_not_absolute");
  if (dirname(base) === base) throw new ScratchGuardError("scratch_root_is_filesystem_root");

  // 任何 mkdir 之前：最近已存在祖先逐级核验到卷根，有 symlink / junction 就拒绝。
  const preAudit = auditExistingAncestorChain(base);
  if (!preAudit.ok) throw new ScratchGuardError("scratch_root_ancestor_refused", { details: { reason: preAudit.reason } });

  const baseExistedBefore = pathKey(preAudit.nearest) === pathKey(base) && Boolean(lstatOrNull(base));
  if (!baseExistedBefore) {
    try {
      mkdirSync(base, { recursive: true });
    } catch (error) {
      throw new ScratchGuardError("scratch_root_unavailable", { details: { code: error?.code ?? null } });
    }
  }
  const baseStat = lstatOrNull(base);
  if (!baseStat) throw new ScratchGuardError("scratch_root_unavailable", { details: { reason: "base_missing_after_create" } });
  if (baseStat.isSymbolicLink()) throw new ScratchGuardError("scratch_root_not_directory", { details: { reason: "base_is_reparse_point" } });
  if (!baseStat.isDirectory()) throw new ScratchGuardError("scratch_root_not_directory", { details: { reason: "base_is_file" } });

  // 创建后再次核验：完整祖先链到卷根 + realpath 等于预期规范化路径。
  const baseAudit = auditAncestorChain(base);
  if (!baseAudit.ok) throw new ScratchGuardError("scratch_root_verification_failed", { details: { reason: baseAudit.reason } });
  const baseReal = realpathOrNull(base);
  if (!baseReal || pathKey(baseReal) !== pathKey(base)) {
    throw new ScratchGuardError("scratch_root_verification_failed", { details: { reason: "base_realpath_mismatch" } });
  }

  const safeLabel = (String(label ?? "").replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40) || "scratch");
  const token = randomBytes(8).toString("hex");
  const rootName = `${safeLabel}-${token}`;
  const root = join(base, rootName);
  const tmpDir = join(root, "tmp");
  const record = {
    tool,
    ownerTask,
    label: safeLabel,
    token,
    base,
    baseReal,
    root,
    rootReal: null,
    tmpDir,
    manifestPath: join(root, `${MANIFEST_PREFIX}${token}.json`),
    manifestWritten: false,
    createdAt: new Date().toISOString(),
    tracked: new Map(),
  };
  const created = [];
  try {
    mkdirSync(root, { recursive: false });
    created.push(root);
    const rootChain = auditAncestorChain(root);
    if (!rootChain.ok) throw new ScratchGuardError("scratch_root_verification_failed", { details: { reason: rootChain.reason } });
    const rootReal = realpathOrNull(root);
    const expectedRootReal = join(baseReal, rootName);
    if (!rootReal || pathKey(rootReal) !== pathKey(expectedRootReal)) {
      throw new ScratchGuardError("scratch_root_verification_failed", { details: { reason: "root_realpath_mismatch" } });
    }
    record.rootReal = rootReal;
    record.tracked.set(pathKey(root), { path: root, real: rootReal, reason: "scratch_root" });
    // 先登记根：manifest 写入成功后，正常成功返回的 record 才能走统一守卫清理。
    writeScratchManifest(record);
    const rootManifest = verifyScratchManifest(record);
    if (!rootManifest.ok) throw new ScratchGuardError("scratch_manifest_unverified", { details: { reason: rootManifest.reason } });

    mkdirSync(tmpDir, { recursive: false });
    created.push(tmpDir);
    const tmpChain = auditAncestorChain(tmpDir);
    if (!tmpChain.ok) throw new ScratchGuardError("scratch_root_verification_failed", { details: { reason: tmpChain.reason } });
    const tmpReal = realpathOrNull(tmpDir);
    const expectedTmpReal = join(rootReal, "tmp");
    if (!tmpReal || pathKey(tmpReal) !== pathKey(expectedTmpReal)) {
      throw new ScratchGuardError("scratch_root_verification_failed", { details: { reason: "tmp_realpath_mismatch" } });
    }
    record.tracked.set(pathKey(tmpDir), { path: tmpDir, real: tmpReal, reason: "scratch_tmp" });
    writeScratchManifest(record);
    const verify = verifyScratchManifest(record);
    if (!verify.ok) throw new ScratchGuardError("scratch_manifest_unverified", { details: { reason: verify.reason } });
    return record;
  } catch (error) {
    // 创建失败一律保留已创建部分，不再有“补写 manifest 再删”的抢救式回滚：
    // 已经判不安全的路径不得写 manifest、不得扫描、不得删除。
    const retained = retainCreatedPaths(created, error);
    if (error instanceof ScratchGuardError) {
      error.cleanup = retained;
      throw error;
    }
    throw new ScratchGuardError("scratch_root_unavailable", { details: { code: error?.code ?? null }, cleanup: retained });
  }
}

/**
 * 创建失败时的**保留**报告（不做任何删除 / 扫描 / manifest 写入）。
 * 只回报本次已创建路径的目录名（随机 label + token，不含父目录绝对路径）与失败原因。
 */
function retainCreatedPaths(createdPaths, error) {
  const names = (Array.isArray(createdPaths) ? createdPaths : []).map((item) => basename(item));
  return {
    attempted: false,
    completed: false,
    retained: true,
    manifestVerified: false,
    reason: error?.code ?? error?.details?.reason ?? "scratch_creation_failed",
    createdCount: names.length,
    created: names,
  };
}

// ------------------------------------------------------------------ 隔离子进程探针

/**
 * 探针子进程：只做 sqlite / fs 探测、**只创建**探针文件并把精确路径报回父进程；
 * 子进程自己**不删除任何东西**（删除统一由父进程按同一守卫对已登记精确路径执行）。
 * 所有数据库句柄与文件句柄都在 finally 关闭，早 return 不漏句柄。
 */
const PROBE_SCRIPT = String.raw`
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  copyFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

const root = process.argv[1];

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function probeFs() {
  const dir = join(root, "fs");
  const source = join(dir, "a.txt");
  const renamed = join(dir, "b.txt");
  const copied = join(dir, "c.txt");
  let fd = null;
  try {
    mkdirSync(dir);
    fd = openSync(source, "w");
    writeSync(fd, Buffer.from("probe", "utf8"));
    fsyncSync(fd);
  } catch {
    return { status: "fail", code: "runtime_fs_unusable", artifacts: [], dir: null, dirReal: null };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
  try {
    if (readFileSync(source, "utf8") !== "probe") return { status: "fail", code: "runtime_fs_read_write_failed", artifacts: [], dir, dirReal: null };
    renameSync(source, renamed);
    copyFileSync(renamed, copied);
    if (!existsSync(copied) || !statSync(copied).isFile()) return { status: "fail", code: "runtime_fs_copy_failed", artifacts: [], dir, dirReal: null };
    const target = lstatSync(copied);
    if (target.isSymbolicLink() || !target.isFile()) return { status: "fail", code: "runtime_fs_reparse_detected", artifacts: [], dir, dirReal: null };
    const dirReal = realpathSync(dir);
    return {
      status: "pass",
      code: null,
      dir,
      dirReal,
      // 只报告本进程真实写出的精确路径；删除由父进程执行。
      artifacts: [{ path: renamed, kind: "renamed" }, { path: copied, kind: "copied" }],
    };
  } catch {
    return { status: "fail", code: "runtime_fs_unusable", artifacts: [], dir, dirReal: null };
  }
}

async function probeSqlite() {
  let DatabaseSync = null;
  try {
    const module = await import("node:sqlite");
    DatabaseSync = module.DatabaseSync ?? null;
  } catch {
    DatabaseSync = null;
  }
  if (!DatabaseSync) return { status: "fail", code: "runtime_sqlite_module_unavailable", detail: {} };

  const dbPath = join(root, "probe.db");
  let db = null;
  let basicFailure = null;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE t (x INTEGER)");
    if (typeof db.isTransaction !== "boolean") basicFailure = "runtime_is_transaction_missing";
    else if (db.isTransaction !== false) basicFailure = "runtime_is_transaction_initial";
    else {
      db.exec("BEGIN");
      if (db.isTransaction !== true) basicFailure = "runtime_is_transaction_begin";
      else {
        db.exec("COMMIT");
        if (db.isTransaction !== false) basicFailure = "runtime_is_transaction_commit";
        else db.exec("INSERT INTO t VALUES (1)");
      }
    }
  } catch {
    basicFailure = "runtime_sqlite_unusable";
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
  }
  if (basicFailure) return { status: "fail", code: basicFailure, detail: {} };

  const before = sha256File(dbPath);
  let reader = null;
  let readOnlyFailure = null;
  try {
    reader = new DatabaseSync(dbPath, { readOnly: true });
    let rejected = false;
    try { reader.exec("INSERT INTO t VALUES (2)"); } catch { rejected = true; }
    if (!rejected) readOnlyFailure = "runtime_readonly_not_enforced";
  } catch {
    readOnlyFailure = "runtime_readonly_option_unusable";
  } finally {
    if (reader) { try { reader.close(); } catch { /* ignore */ } }
  }
  if (readOnlyFailure) return { status: "fail", code: readOnlyFailure, detail: {} };
  if (sha256File(dbPath) !== before) return { status: "fail", code: "runtime_readonly_mutated_source", detail: {} };

  const lockPath = join(root, "lock.db");
  const detail = {};
  let holder = null;
  let waiter = null;
  let busyFailure = null;
  const started = Date.now();
  try {
    holder = new DatabaseSync(lockPath, { timeout: 500 });
    holder.exec("CREATE TABLE l (x INTEGER)");
    holder.exec("BEGIN IMMEDIATE");
    waiter = new DatabaseSync(lockPath, { timeout: 120 });
    const pragma = waiter.prepare("PRAGMA busy_timeout").all();
    const timeoutValue = Number(pragma?.[0]?.timeout);
    if (!Number.isFinite(timeoutValue) || timeoutValue < 100) {
      busyFailure = "runtime_busy_timeout_option_unusable";
    } else {
      let bounded = false;
      try {
        waiter.exec("INSERT INTO l VALUES (1)");
      } catch (error) {
        bounded = Number(error?.errcode) === 5 || /locked|busy/i.test(String(error?.errstr ?? error?.message ?? ""));
      }
      const elapsed = Date.now() - started;
      if (!bounded) busyFailure = "runtime_busy_timeout_not_enforced";
      else if (elapsed > 5000) busyFailure = "runtime_busy_timeout_unbounded";
      else detail.busyRejectionMs = elapsed;
    }
  } catch {
    busyFailure = busyFailure ?? "runtime_busy_timeout_probe_failed";
  } finally {
    if (holder) { try { holder.exec("ROLLBACK"); } catch { /* ignore */ } }
    if (waiter) { try { waiter.close(); } catch { /* ignore */ } }
    if (holder) { try { holder.close(); } catch { /* ignore */ } }
  }
  if (busyFailure) return { status: "fail", code: busyFailure, detail };
  return { status: "pass", code: null, detail };
}

const sqlite = await probeSqlite().catch(() => ({ status: "fail", code: "runtime_sqlite_unusable", detail: {} }));
process.stdout.write(JSON.stringify({ sqlite, fs: probeFs() }));
`;

/** 在独立子进程里跑可阻塞探针；真实 deadline，超时强杀，绝不无限等待。 */
function runIsolatedProbe(probeRoot) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE_SCRIPT, probeRoot], {
    cwd: probeRoot,
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", WINDIR: process.env.WINDIR ?? "", TEMP: join(probeRoot, "tmp"), TMP: join(probeRoot, "tmp") },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: MAX_PROBE_MS,
    killSignal: "SIGKILL",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const timedOut = (result.error && result.error.code === "ETIMEDOUT") || result.signal === "SIGKILL";
  if (result.error && result.error.code !== "ETIMEDOUT") {
    return { status: "fail", code: "runtime_probe_spawn_failed", timedOut: false };
  }
  if (timedOut) return { status: "fail", code: "runtime_probe_timeout", timedOut: true };
  if (result.status !== 0) return { status: "fail", code: "runtime_probe_failed", timedOut: false, exitCode: result.status ?? null };
  let payload = null;
  try {
    payload = JSON.parse(String(result.stdout ?? "").trim());
  } catch {
    payload = null;
  }
  if (!payload) return { status: "fail", code: "runtime_probe_output_invalid", timedOut: false };
  return { status: "ok", payload, timedOut: false };
}

/**
 * 父进程处理子进程的 fs 探针结果：只登记子进程报告的**精确文件**，再用同一删除守卫
 * 对刚复制出的文件真正执行一次 rm 来证明删除 API 可用。子进程自己不做任何删除。
 */
function applyFsProbeResult(record, fsPayload) {
  if (!fsPayload || fsPayload.status !== "pass") {
    return { status: "fail", code: fsPayload?.code ?? "runtime_fs_unusable", rmVerified: false };
  }
  const expectedDir = join(record.root, "fs");
  if (typeof fsPayload.dir !== "string" || pathKey(fsPayload.dir) !== pathKey(expectedDir)) {
    return { status: "fail", code: "runtime_fs_probe_path_mismatch", rmVerified: false };
  }
  const expectedDirReal = join(record.rootReal, "fs");
  if (typeof fsPayload.dirReal !== "string" || pathKey(fsPayload.dirReal) !== pathKey(expectedDirReal)) {
    return { status: "fail", code: "runtime_fs_probe_realpath_mismatch", rmVerified: false };
  }
  const artifacts = Array.isArray(fsPayload.artifacts) ? fsPayload.artifacts : [];
  if (artifacts.length === 0) return { status: "fail", code: "runtime_fs_probe_artifacts_missing", rmVerified: false };
  const registered = [];
  for (const item of artifacts) {
    const kind = String(item?.kind ?? "artifact").replace(/[^a-z]/g, "").slice(0, 16) || "artifact";
    const real = trackExistingPath(record, item?.path, `probe_fs_${kind}`);
    if (!real) {
      // 子进程报告的路径不可登记（越界 / 重解析 / realpath 不符）→ 不删、如实拒绝。
      return { status: "fail", code: "runtime_fs_probe_unregistered", rmVerified: false, retained: true };
    }
    registered.push({ kind, path: item.path, real });
  }
  const copied = registered.find((item) => item.kind === "copied");
  if (!copied) return { status: "fail", code: "runtime_fs_probe_copied_missing", rmVerified: false };
  const removal = removeTrackedPath(record, copied.path);
  if (!removal.ok) {
    return { status: "fail", code: "runtime_fs_rm_refused", rmVerified: false, reason: removal.reason ?? null };
  }
  return { status: "pass", code: null, rmVerified: true, registeredArtifacts: registered.length, removedArtifacts: 1 };
}

// ------------------------------------------------------------------ 版本策略

/**
 * 版本放行策略：**只放行本包实际做过完整验收的 24.15.0**。
 * - 22.16 / 24.0 只是冻结源码 API 分析下限（官方文档），本包没有这些真实二进制的验收证据；
 * - 24 其它 minor / patch（含 24.15.1）、25+ 均未验，不因「数字更大」自动放行；
 * - 版本判断在读 Node 版本时完成，早于任何数据目录创建 / 迁移 / 目录写探针。
 * @returns {{ok:boolean,code:string|null,reason:string|null,tested:boolean}}
 */
export function decideRuntimeVersion(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(raw ?? "").trim());
  if (!match) return { ok: false, code: "runtime_version_unreadable", reason: "unreadable", tested: false };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major === 24 && minor === 15 && patch === 0) return { ok: true, code: null, reason: null, tested: true };
  if (major === 24 && minor === 15) return { ok: false, code: "runtime_version_not_qualified", reason: "patch_unverified", tested: false };
  if (major === 24) return { ok: false, code: "runtime_version_not_qualified", reason: "minor_unverified", tested: false };
  if (major === 22) return { ok: false, code: "runtime_version_not_qualified", reason: "branch_22_unverified", tested: false };
  return { ok: false, code: "runtime_version_not_qualified", reason: "major_unverified", tested: false };
}

const USAGE = [
  "node scripts/windows-runtime-check.mjs --json",
  "node scripts/windows-runtime-check.mjs --json --data-dir <显式数据目录>",
  "node scripts/windows-runtime-check.mjs --json --scratch-root <工作区绝对路径>",
].join("\n");

function parseArgs(argv) {
  const options = { json: false, dataDir: null, scratchRoot: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h" || token === "help") {
      options.help = true;
      continue;
    }
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--data-dir" || token === "--scratch-root") {
      const value = argv[index + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        return { error: { code: "usage_missing_value", field: token.slice(2) } };
      }
      if (token === "--data-dir") options.dataDir = value;
      else options.scratchRoot = value;
      index += 1;
      continue;
    }
    return { error: { code: "usage_unknown_option", field: String(token).slice(0, 40) } };
  }
  return { options };
}

function nearestExistingAncestor(path) {
  let current = path;
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * 只检查显式数据目录（**只读**）：不创建目录、不写探针、不删除、不枚举。
 * 真实写 / 删能力由本脚本自建的专属 scratch 与实际 HTTP 验收证明，
 * 不在用户已有数据目录里写删任何东西。
 */
function checkDataDir(rawPath) {
  const path = resolve(rawPath);
  const writeProbe = "not_performed";
  if (!existsSync(path)) {
    const ancestor = nearestExistingAncestor(path);
    if (!ancestor) return { status: "fail", code: "data_dir_parent_missing", writeProbe };
    const chain = auditAncestorChain(ancestor);
    if (!chain.ok) return { status: "fail", code: "data_dir_ancestor_refused", writeProbe, detail: chain.reason };
    try {
      if (!statSync(ancestor).isDirectory()) return { status: "fail", code: "data_dir_parent_not_directory", writeProbe };
      accessSync(ancestor, FS.W_OK);
    } catch {
      return { status: "fail", code: "data_dir_parent_not_writable", writeProbe };
    }
    return { status: "pass", code: null, exists: false, writableAncestor: true, writeProbe };
  }
  const stat = lstatOrNull(path);
  if (!stat) return { status: "fail", code: "data_dir_not_readable", writeProbe };
  if (stat.isSymbolicLink()) return { status: "fail", code: "data_dir_is_reparse_point", writeProbe };
  if (!stat.isDirectory()) return { status: "fail", code: "data_dir_not_directory", writeProbe };
  const chain = auditAncestorChain(path);
  if (!chain.ok) return { status: "fail", code: "data_dir_ancestor_refused", writeProbe, detail: chain.reason };
  try {
    accessSync(path, FS.W_OK);
  } catch {
    return { status: "fail", code: "data_dir_not_writable", writeProbe };
  }
  return { status: "pass", code: null, exists: true, writableAncestor: true, writeProbe };
}

/**
 * 字体候选与 server/report-office-export.mjs 的固定列表一致，并支持显式参数。
 * 只判断这些固定路径**是否存在**（candidate_present），不扫描字体目录、不把字体文件复制进
 * 仓库；存在不等于已验证可嵌入 / 字形完整——实际导出结果才是最终判据。
 */
function checkFonts(env) {
  const root = env.SystemRoot || env.WINDIR || "C:\\Windows";
  const explicit = typeof env.REPORT_PDF_FONT === "string" ? env.REPORT_PDF_FONT.trim() : "";
  const candidates = [
    { label: basename(join(root, "Fonts", "simsun.ttc")), path: join(root, "Fonts", "simsun.ttc"), family: "SimSun" },
    { label: basename(join(root, "Fonts", "simhei.ttf")), path: join(root, "Fonts", "simhei.ttf"), family: null },
    { label: basename(join(root, "Fonts", "Deng.ttf")), path: join(root, "Fonts", "Deng.ttf"), family: null },
    { label: "NotoSansCJK-Regular.ttc", path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", family: "Noto Sans CJK SC" },
    { label: "PingFang.ttc", path: "/System/Library/Fonts/PingFang.ttc", family: "PingFang SC" },
  ].map((item) => ({ label: item.label, candidatePresent: existsSync(item.path), family: item.family }));
  if (explicit) {
    const present = existsSync(explicit);
    return {
      status: present ? "candidate_present" : "explicit_missing",
      code: present ? null : "pdf_font_unavailable",
      explicit: true,
      explicitLabel: basename(explicit),
      candidates,
      verification: "existence_only_actual_export_is_the_criterion",
    };
  }
  const anyCandidate = candidates.some((item) => item.candidatePresent);
  return {
    status: anyCandidate ? "candidate_present" : "unavailable",
    code: anyCandidate ? null : "pdf_font_unavailable",
    explicit: false,
    explicitLabel: null,
    candidates,
    verification: "existence_only_actual_export_is_the_criterion",
  };
}

function engineWarning() {
  try {
    const pkg = JSON.parse(readFileSync(join(WORKBENCH_ROOT, "package.json"), "utf8"));
    const declared = String(pkg?.engines?.node ?? "");
    if (!declared) return null;
    // 声明范围偏宽：>=22.5.0 既早于 22.16 的必需 API，也没有 22 分支真实验收。
    return { code: "engines_declaration_too_wide", declared, testedNode: TESTED_NODE_VERSION };
  } catch {
    return null;
  }
}

function probeLimits(extra = {}) {
  return {
    probeDeadlineMs: MAX_PROBE_MS,
    probeIsolatedProcess: true,
    probeVerifiesRmThroughGuard: true,
    dataDirWriteProbe: "not_performed",
    probeResiduePolicy: "removed_by_guarded_scratch_root_or_retained",
    readsUserFontDirectories: false,
    loadsBusinessDb: false,
    ...extra,
  };
}

/**
 * 执行预检。不使用任何业务模块，不创建默认数据目录。
 * @param {{dataDir?:string|null, scratchRoot?:string|null, env?:NodeJS.ProcessEnv}} [options]
 */
export async function runRuntimeCheck(options = {}) {
  const env = options.env ?? process.env;
  const startedAt = Date.now();
  const checks = [];
  const errors = [];
  const warnings = [];
  const runtime = {
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    testedNode: TESTED_NODE_VERSION,
    analyzedMinimumNode: ANALYZED_MINIMUM_NODE_VERSION,
    qualified: false,
    code: null,
    reason: null,
  };
  const decide = decideRuntimeVersion(process.versions.node);
  runtime.code = decide.code;
  runtime.reason = decide.reason;
  checks.push({ id: "node_version", status: decide.ok ? "pass" : "fail", code: decide.code });
  if (!decide.ok) errors.push({ code: decide.code, stage: "node_version", reason: decide.reason });
  const platformOk = process.platform === "win32";
  checks.push({ id: "platform", status: platformOk ? "pass" : "fail", code: platformOk ? null : "runtime_platform_unsupported" });
  if (!platformOk) errors.push({ code: "runtime_platform_unsupported", stage: "platform" });
  // 只放行本次实测过的 Windows x64；arm64 未实测，同样拒绝（不因"看起来兼容"自动放行）。
  const archOk = process.arch === "x64";
  checks.push({ id: "arch", status: archOk ? "pass" : "fail", code: archOk ? null : "runtime_arch_unsupported" });
  if (!archOk) errors.push({ code: "runtime_arch_unsupported", stage: "arch" });
  // 资格是「版本 + 平台 + 架构」三者同时满足本次实测组合；不能只绑版本（API 可能可用 ≠ 已验资格）。
  runtime.qualified = decide.ok && platformOk && archOk;
  runtime.qualifiedScope = { node: TESTED_NODE_VERSION, platform: "win32", arch: "x64" };
  runtime.qualifiedBasis = ["node_version", "platform", "arch"];
  if (!decide.ok) runtime.reason = decide.reason;
  else if (!platformOk) runtime.reason = "platform_unverified";
  else if (!archOk) runtime.reason = "arch_unverified";
  else runtime.reason = null;

  // 版本 / 平台 / 架构拒绝必须早于**任何**目录写探针：这里直接返回，不建临时根、不碰数据目录。
  if (!decide.ok || !platformOk || !archOk) {
    checks.push({ id: "sqlite", status: "skipped", code: "runtime_rejected_before_probe" });
    checks.push({ id: "fs", status: "skipped", code: "runtime_rejected_before_probe" });
    checks.push({ id: "data_dir", status: "skipped", code: "runtime_rejected_before_probe" });
    return {
      tool: TOOL,
      schemaVersion: TOOL_SCHEMA_VERSION,
      ok: false,
      status: "rejected",
      code: errors[0]?.code ?? "runtime_rejected",
      runtime,
      features: { sqliteModule: false, isTransaction: false, readOnly: false, busyTimeout: false, fs: false },
      checks,
      fonts: { status: "not_checked", code: null, candidates: [], verification: "not_run" },
      dataDir: { status: "skipped", code: "runtime_rejected_before_probe" },
      warnings,
      errors,
      limits: probeLimits(),
      cleanup: { attempted: false, completed: false, manifestVerified: false, retained: false, reason: "no_probe_created", pathEchoed: false },
      evidence: { durationMs: Date.now() - startedAt },
    };
  }

  let scratch = null;
  let cleanup = { attempted: false, completed: false, manifestVerified: false, retained: false, reason: "no_probe_created", pathEchoed: false };
  try {
    scratch = createScratchRecord({ label: "runtime", basePath: options.scratchRoot ?? null });
  } catch (error) {
    const code = error?.code ?? "scratch_root_unavailable";
    checks.push({ id: "probe", status: "fail", code });
    checks.push({ id: "sqlite", status: "skipped", code });
    checks.push({ id: "fs", status: "skipped", code });
    checks.push({ id: "data_dir", status: "skipped", code });
    errors.push({ code, stage: "scratch", hint: "发布目录不可写时用 --scratch-root 指定工作区绝对路径", reason: error?.details?.reason ?? null });
    const fontsUnavailable = checkFonts(env);
    return {
      tool: TOOL, schemaVersion: TOOL_SCHEMA_VERSION, ok: false, status: "rejected",
      code: errors[0].code, runtime,
      features: { sqliteModule: false, isTransaction: false, readOnly: false, busyTimeout: false, fs: false },
      checks, fonts: fontsUnavailable, dataDir: { status: "skipped", code },
      warnings, errors,
      limits: probeLimits(),
      // 创建失败不做抢救式回滚：这里只如实附上“保留 / 未尝试清理”的报告（attempted:false）。
      cleanup: { ...cleanup, reason: code, retained: error?.cleanup?.retained === true, creationFailure: error?.cleanup ?? null },
      evidence: { durationMs: Date.now() - startedAt },
    };
  }

  let probe = { status: "fail", code: "runtime_probe_not_run", timedOut: false };
  let fsProbe = { status: "fail", code: "runtime_fs_not_run", rmVerified: false };
  let dataDir = { status: "not_checked", code: null, writeProbe: "not_performed" };
  try {
    probe = runIsolatedProbe(scratch.root);
    if (probe.status === "ok") {
      checks.push({ id: "sqlite", status: probe.payload.sqlite?.status === "pass" ? "pass" : "fail", code: probe.payload.sqlite?.code ?? null });
      if (probe.payload.sqlite?.status !== "pass") errors.push({ code: probe.payload.sqlite?.code ?? "runtime_sqlite_unusable", stage: "sqlite" });
      // fs 探针的删除由父进程按同一守卫对已登记精确文件执行（子进程只创建、不删除）。
      fsProbe = applyFsProbeResult(scratch, probe.payload.fs);
      checks.push({ id: "fs", status: fsProbe.status === "pass" ? "pass" : "fail", code: fsProbe.code ?? null });
      if (fsProbe.status !== "pass") errors.push({ code: fsProbe.code ?? "runtime_fs_unusable", stage: "fs" });
    } else {
      checks.push({ id: "sqlite", status: "fail", code: probe.code });
      checks.push({ id: "fs", status: "fail", code: probe.code });
      errors.push({ code: probe.code, stage: "probe" });
    }

    if (options.dataDir) {
      dataDir = checkDataDir(options.dataDir);
      checks.push({ id: "data_dir", status: dataDir.status, code: dataDir.code });
      if (dataDir.status !== "pass") errors.push({ code: dataDir.code, stage: "data_dir" });
    } else {
      checks.push({ id: "data_dir", status: "skipped", code: "data_dir_not_provided" });
    }
  } finally {
    // 任何早返回 / 抛错都会走到这里：专属根一定尝试清理；清理失败明确非零并保留现场。
    const removal = removeScratchRecord(scratch);
    cleanup = {
      attempted: true,
      completed: removal.ok === true,
      manifestVerified: removal.manifestVerified === true,
      reason: removal.reason ?? null,
      retained: removal.ok !== true,
      pathEchoed: false,
      // 被外层 deadline 杀死的探针残留只能由确权父根处理；清不掉就明确保留。
      probeResidueHandledByGuardedRoot: removal.ok === true,
    };
    if (!removal.ok) {
      const code = String(removal.reason ?? "").startsWith("cleanup_refused") ? "cleanup_refused" : "cleanup_failed";
      checks.push({ id: "cleanup", status: "fail", code });
      errors.unshift({ code, stage: "cleanup", detail: removal.reason ?? null });
    } else {
      checks.push({ id: "cleanup", status: "pass", code: null });
    }
  }

  const fonts = checkFonts(env);
  checks.push({ id: "pdf_font", status: fonts.status === "candidate_present" ? "pass" : "warn", code: fonts.code });
  if (fonts.code) warnings.push({ code: fonts.code, detail: fonts.status });
  const engine = engineWarning();
  if (engine) warnings.push(engine);

  const ok = errors.length === 0;
  return {
    tool: TOOL,
    schemaVersion: TOOL_SCHEMA_VERSION,
    ok,
    status: ok ? "ok" : "rejected",
    code: ok ? null : errors[0]?.code ?? "runtime_rejected",
    runtime,
    features: {
      sqliteModule: checks.find((item) => item.id === "sqlite")?.status === "pass",
      isTransaction: checks.find((item) => item.id === "sqlite")?.status === "pass",
      readOnly: checks.find((item) => item.id === "sqlite")?.status === "pass",
      busyTimeout: checks.find((item) => item.id === "sqlite")?.status === "pass",
      fs: checks.find((item) => item.id === "fs")?.status === "pass",
    },
    checks,
    fonts,
    dataDir,
    warnings,
    errors,
    limits: probeLimits({
      probeTimedOut: probe.timedOut === true,
      fsRmVerifiedThroughGuard: fsProbe.rmVerified === true,
    }),
    cleanup,
    evidence: { durationMs: Date.now() - startedAt },
  };
}

function emit(payload, exitCode) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = exitCode;
}

export async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.options?.help) {
    emit({ tool: TOOL, command: "help", ok: true, status: "ok", code: null, usage: USAGE, testedNode: TESTED_NODE_VERSION }, 0);
    return 0;
  }
  if (parsed.error) {
    emit({ tool: TOOL, command: null, ok: false, status: "rejected", code: parsed.error.code, details: parsed.error }, 1);
    return 1;
  }
  let result;
  try {
    result = await runRuntimeCheck({ dataDir: parsed.options.dataDir, scratchRoot: parsed.options.scratchRoot });
  } catch {
    result = {
      tool: TOOL, schemaVersion: TOOL_SCHEMA_VERSION, ok: false, status: "rejected",
      code: "runtime_check_internal_error", errors: [{ code: "runtime_check_internal_error", stage: "internal" }],
    };
  }
  emit(result, result.ok ? 0 : 2);
  return result.ok ? 0 : 2;
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntry) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
