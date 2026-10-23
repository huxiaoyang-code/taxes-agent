#!/usr/bin/env node
/**
 * scripts/windows-delivery-check.mjs — Windows 源码交付包的可复跑验收脚本。
 *
 * 它只做两件事：
 *  1) install-start：从一份**冷拷贝**（白名单源码）验证依赖、空环境启动、真实 HTTP
 *     导入 / 报表 / Office 渲染、失败路径、运行中一致备份与新目录恢复、重复启停与
 *     双进程隔离。
 *  2) upgrade-rollback：**W1 只保留命令形态**，一律 `w2_contract_pending` blocked：
 *     不建业务 DB、不迁移、不安装依赖；任何用户提供的 `--schema-pair` 都不解除。
 *     W2 的 v(n)→v(n+1) 演练需要上游版本契约与已登记配对，另行交付。
 *  3) 把每个阶段的结果、退出码、耗时、进程 pid（仅本机）、源码 / 锁摘要写入
 *     `<out>/windows-delivery-result.json`，原始子进程输出只写 `<out>/logs/`。
 *
 * 用法（在 06-workbench 下）：
 *   node scripts/windows-delivery-check.mjs --help
 *   node scripts/windows-delivery-check.mjs --phase install-start \
 *     --release <冷拷贝根> --node <node.exe> --npm <npm> --cache <授权缓存> --out <新输出目录> \
 *     [--scratch-root <显式授权的绝对路径>] [--require-packaged-tooling]
 *   node scripts/windows-delivery-check.mjs --phase upgrade-rollback \
 *     --release <发布根> --out <新输出目录>        （W1 恒为 blocked，见上）
 *
 * 退出码：0 = 全部通过；1 = 用法错误；2 = blocked（W2 契约未就绪 / 前置条件）；
 *         3 = 任一阶段 fail（首个失败不会被后续成功覆盖）。
 *
 * 安全边界：
 *  - 只处理显式路径；不读默认数据目录、不读用户 npm 配置 / 凭据、不按进程名杀进程。
 *  - `--release` / `--out` / `--scratch-root` 先按**原始完整绝对路径**校验：“绝对”只认盘符绝对
 *    或**完整 UNC**（`\\server\share`，server 与 share 均非空）；拒绝相对、drive-relative
 *    `C:foo`、root-relative `\foo`、设备路径（含 `//?/` 斜杠变体）与缺 share 的不完整 UNC。
 *    再核验根与完整祖先链到卷根（有 symlink / junction 即拒绝）与 realpath；并在**任何扫描 /
 *    创建 / 复制之前**检查安全关系（out 与 release 互不包含、out 不得等于或包含 scratch base）。
 *    显式或**实际默认**的 scratch base 同样在这一步审核（根 / 最近既存祖先 / 根类型 / realpath），
 *    所以无效 scratch 不会出现“out 已写、scratch 后拒”的半截现场。拒绝时只写 stdout 并非零，
 *    不为了留日志先创建未验证的输出目录。
 *  - 冷拷贝入口 `copyReleaseWhitelist` 自己重新核验源根 / 选定 workbench / 目标（不信任历史检查）：
 *    根与祖先无重解析点、目标不存在且不重叠源，失败不创建也不补删除。
 *  - 所有启动强制 HOST=127.0.0.1；验收 PORT=0 并从本次 stdout 解析实际端口。
 *  - 子进程环境为白名单，不 dump env；stdout / stderr 各自上限 1 MiB；每个子进程都有
 *    真实 deadline，杀不掉时按硬截止返回“未回收”而不是无限等 close。
 *  - 临时根只在 workspace 专属目录（默认 `<workbench>/tmp/windows-delivery`，或用
 *    `--scratch-root` 传入的**显式授权**专项目录）下新建随机目录；守卫实现在
 *    `windows-runtime-check.mjs` 里并由本脚本 / 测试 import 复用，不维护第二套：
 *    任何 mkdir 前逐级核验祖先到卷根，创建后与删除前重验完整祖先链与 realpath；
 *    manifest 逐项登记删除目标并与内存互校；任何不确定就保留并非零报告。
 *    base 永不被删除，也不按名称 / 前缀 / manifest 推断 base 整体的所有权。
 *  - 不使用系统 TEMP 作为可删根，不扫描 / 通配删除用户目录。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditAncestorChain,
  auditExistingAncestorChain,
  createScratchRecord as createGuardedScratchRecord,
  defaultScratchBase,
  inspectRawAbsolutePath,
  removeScratchRecord as removeGuardedScratchRecord,
  removeTrackedPath,
  trackExistingPath,
  verifyScratchManifest,
} from "./windows-runtime-check.mjs";

// 守卫只有一份实现（windows-runtime-check.mjs）；这里只做本工具身份的包装与再导出。
export { defaultScratchBase, removeTrackedPath, trackExistingPath, verifyScratchManifest };

export const TOOL = "windows-delivery-check";
export const TOOL_SCHEMA_VERSION = 1;
export const TESTED_NODE_VERSION = "24.15.0";
export const OWNER_TASK = "LOCAL-06-WINDOWS";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKBENCH_ROOT = dirname(SCRIPT_DIR);
const SCRATCH_LABEL = "delivery-check";

/** 以本工具身份创建专属根（tool / ownerTask 写进 manifest）。 */
export function createScratchRecord(options = {}) {
  return createGuardedScratchRecord({ tool: TOOL, ownerTask: OWNER_TASK, label: SCRATCH_LABEL, ...options });
}

/** 以本工具身份删除专属根（manifest / 内存 / 完整祖先链 / realpath 全验）。 */
export function removeScratchRecord(record) {
  return removeGuardedScratchRecord(record);
}
/** 强杀后等待 close 的硬上限；超过即按「未回收」返回，绝不无限等待。 */
const KILL_GRACE_MS = 5000;

const MAX_STREAM_BYTES = 1024 * 1024;
const LIMITS = Object.freeze({
  readinessMs: 15000,
  httpMs: 10000,
  suiteMs: 120000,
  stabilityMs: 600000,
  npmMs: 300000,
  startScriptMs: 30000,
  officeMs: 120000,
});

/**
 * 阶段**耗时后验**上限（不是中途硬 deadline）：`fn` 结束后才比实际耗时，超出即判失败
 * （不再「只记 code 仍 pass」）。阶段内真正能中途生效的 deadline 仍是：子进程
 * `spawnCaptured` 的 timeoutMs + `KILL_GRACE_MS`、HTTP 的 `AbortSignal.timeout`、
 * 隔离子进程探针的 `MAX_PROBE_MS`；本表不新增总进程 watchdog，也不中断执行中的 fn。
 */
const STAGE_BUDGET_MS = Object.freeze({
  preflight: LIMITS.suiteMs,
  runtime: LIMITS.suiteMs,
  dependencies: LIMITS.npmMs * 3 + LIMITS.suiteMs,
  startup: LIMITS.readinessMs * 2 + LIMITS.suiteMs,
  import: LIMITS.suiteMs,
  reports: LIMITS.suiteMs,
  restart: LIMITS.readinessMs * 2 + LIMITS.suiteMs,
  office: LIMITS.officeMs * 6 + LIMITS.suiteMs,
  "failure-paths": LIMITS.suiteMs * 2,
  "backup-restore": LIMITS.suiteMs * 2,
  stability: LIMITS.stabilityMs,
});

/** 固定 lock 只允许这些公共 registry 的 HTTPS 来源（并必须有完整性字段）。 */
const ALLOWED_LOCK_HOSTS = Object.freeze(["registry.npmjs.org", "registry.npmmirror.com"]);

const EXIT = Object.freeze({ ok: 0, usage: 1, blocked: 2, failed: 3 });

const USAGE = [
  "node scripts/windows-delivery-check.mjs --help",
  "node scripts/windows-delivery-check.mjs --phase install-start --release <冷拷贝根> --node <node.exe> --npm <npm> --cache <授权缓存> --out <新输出目录> [--scratch-root <显式授权的绝对路径>] [--require-packaged-tooling]",
  "node scripts/windows-delivery-check.mjs --phase upgrade-rollback --release <发布根> --out <新输出目录>   # W1: 恒为 w2_contract_pending blocked",
].join("\n");

const FORBIDDEN_NAMES = new Set([
  ".git", "node_modules", "data", "profiles", "profile", "logs", "tmp", "temp",
  ".npmrc", "npmrc", ".codex", ".codex-home", ".agents", ".agent-runs", ".env",
  "package-lock.orig", "workbench.db", "workbench.db-wal", "workbench.db-shm",
]);
const FORBIDDEN_EXTENSIONS = [".db", ".db-wal", ".db-shm", ".sqlite", ".sqlite3", ".log"];

function isForbiddenName(name) {
  const lower = name.toLowerCase();
  if (FORBIDDEN_NAMES.has(lower)) return true;
  if (lower.startsWith(".env.")) return true;
  return FORBIDDEN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

// ------------------------------------------------------------------ 参数

export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const options = { phase: null, release: null, previousRelease: null, schemaPair: null, scratchRoot: null, node: process.execPath, npm: null, cache: null, out: null, keep: false, font: null, fontFamily: null, requirePackagedTooling: false };
  const seen = new Set();
  const flags = new Set(["keep", "require-packaged-tooling"]);
  const allowed = new Set(["phase", "release", "previous-release", "schema-pair", "scratch-root", "node", "npm", "cache", "out", "keep", "font", "font-family", "require-packaged-tooling"]);
  const valueKey = (name) => (name === "previous-release" ? "previousRelease" : name === "schema-pair" ? "schemaPair" : name === "scratch-root" ? "scratchRoot" : name === "font-family" ? "fontFamily" : name);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) return { error: { code: "usage_unexpected_argument" } };
    const name = token.slice(2);
    if (!allowed.has(name)) return { error: { code: "usage_unknown_option", field: name.slice(0, 40) } };
    if (seen.has(name)) return { error: { code: "usage_duplicate_option", field: name } };
    seen.add(name);
    if (flags.has(name)) {
      if (name === "keep") options.keep = true;
      if (name === "require-packaged-tooling") options.requirePackagedTooling = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) return { error: { code: "usage_missing_value", field: name } };
    options[valueKey(name)] = value;
    index += 1;
  }
  if (!options.phase) return { error: { code: "usage_missing_option", field: "phase" } };
  if (!["install-start", "upgrade-rollback"].includes(options.phase)) return { error: { code: "usage_unknown_phase", field: String(options.phase).slice(0, 40) } };
  if (!options.release) return { error: { code: "usage_missing_option", field: "release" } };
  if (!options.out) return { error: { code: "usage_missing_option", field: "out" } };
  if (options.phase === "install-start") {
    if (!options.npm) return { error: { code: "usage_missing_option", field: "npm" } };
    if (!options.cache) return { error: { code: "usage_missing_option", field: "cache" } };
  }
  return { options };
}

// ------------------------------------------------------------------ 通用

function nowIso() {
  return new Date().toISOString();
}

function randomTag() {
  return createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 12);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function jsonWrite(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pathKey(path) {
  return resolve(path).toLowerCase();
}

/**
 * 固定 lock 的来源白名单校验：只允许冻结 lock 已用的公共 registry HTTPS 来源，
 * 且每条都要有完整性字段。不把 npm_config_registry 当成能约束 lock URL 的保证。
 */
export function validateLockSources(lockFilePath) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockFilePath, "utf8"));
  } catch {
    return { ok: false, checked: 0, violations: [{ reason: "lock_unreadable" }] };
  }
  const violations = [];
  let checked = 0;
  const visit = (name, entry) => {
    if (!entry || typeof entry !== "object") return;
    const resolvedValue = entry.resolved;
    if (resolvedValue === undefined || resolvedValue === null) return;
    if (typeof resolvedValue !== "string") {
      violations.push({ name: String(name).slice(0, 80), reason: "resolved_not_string" });
      return;
    }
    checked += 1;
    let url;
    try {
      url = new URL(resolvedValue);
    } catch {
      violations.push({ name: String(name).slice(0, 80), reason: "resolved_not_absolute_url" });
      return;
    }
    if (url.protocol !== "https:") {
      violations.push({ name: String(name).slice(0, 80), reason: "protocol_not_https" });
      return;
    }
    if (url.username || url.password) {
      violations.push({ name: String(name).slice(0, 80), reason: "credentials_in_url" });
      return;
    }
    if (!ALLOWED_LOCK_HOSTS.includes(url.host.toLowerCase())) {
      violations.push({ name: String(name).slice(0, 80), reason: "host_not_allowed", host: url.host.toLowerCase().slice(0, 80) });
      return;
    }
    if (url.port && url.port !== "443") {
      violations.push({ name: String(name).slice(0, 80), reason: "non_default_port" });
      return;
    }
    if (typeof entry.integrity !== "string" || !/^sha(1|384|512)-/.test(entry.integrity)) {
      violations.push({ name: String(name).slice(0, 80), reason: "integrity_missing_or_weak" });
    }
  };
  const packages = lock && typeof lock.packages === "object" && lock.packages !== null ? lock.packages : null;
  if (packages) {
    for (const [name, entry] of Object.entries(packages)) {
      if (name === "") continue;
      visit(name, entry);
    }
  } else if (lock && typeof lock.dependencies === "object" && lock.dependencies !== null) {
    for (const [name, entry] of Object.entries(lock.dependencies)) visit(name, entry);
  }
  if (checked === 0) violations.push({ reason: "lock_has_no_resolved_entries" });
  return {
    ok: violations.length === 0,
    checked,
    allowedHosts: [...ALLOWED_LOCK_HOSTS],
    violations: violations.slice(0, 10),
  };
}

class StageError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.code = code;
    this.blocked = options.blocked === true;
    this.details = options.details ?? null;
  }
}

function minimalEnv(extra = {}) {
  const env = {};
  for (const name of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  // All callers must identify their run-owned temporary scope; never inherit OS defaults.
  if (!extra.TEMP || !extra.TMP || !isAbsolute(extra.TEMP) || !isAbsolute(extra.TMP)) throw new StageError("child_environment_scope_required");
  const childRoot = dirname(extra.TEMP);
  env.WORKBENCH_DATA_DIR = join(childRoot, "fallback-data");
  env.WINDOWS_DELIVERY_SCRATCH_ROOT = join(childRoot, "child-scratch");
  env.NODE_OPTIONS = "";
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null) env[key] = String(value);
  }
  return env;
}

function spawnCaptured(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : LIMITS.suiteMs;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let hardDeadline = false;
    let timer = null;
    let graceTimer = null;
    let hangTimer = null;
    let child = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (hangTimer) clearTimeout(hangTimer);
      resolvePromise({
        stdout: Buffer.concat(stdout).subarray(0, MAX_STREAM_BYTES).toString("utf8"),
        stderr: Buffer.concat(stderr).subarray(0, MAX_STREAM_BYTES).toString("utf8"),
        stdoutTruncated: stdoutBytes > MAX_STREAM_BYTES,
        stderrTruncated: stderrBytes > MAX_STREAM_BYTES,
        timedOut,
        hardDeadline,
        durationMs: Date.now() - started,
        ...payload,
      });
    };

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch {
      finish({ code: null, signal: null, spawnError: "spawn_failed", pid: null });
      return;
    }
    child.once("error", (error) => {
      finish({ code: null, signal: null, spawnError: error?.code ?? "spawn_failed", pid: child.pid ?? null });
    });
    child.stdout.on("data", (chunk) => {
      if (stdoutBytes < MAX_STREAM_BYTES) {
        stdout.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes < MAX_STREAM_BYTES) {
        stderr.push(chunk);
        stderrBytes += chunk.length;
      }
    });
    child.once("close", (code, signal) => finish({ code: code ?? null, signal: signal ?? null, pid: child.pid ?? null, reclaimed: true }));

    // 真实 deadline：到点先礼后兵；强杀后仍不 close 就在 KILL_GRACE_MS 后按「未回收」返回。
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
      graceTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        hangTimer = setTimeout(() => {
          hardDeadline = true;
          // 硬截止：断开管道并 unref，避免一个杀不掉的孩子把父进程事件循环拖住。
          try { child.stdout?.destroy(); } catch { /* ignore */ }
          try { child.stderr?.destroy(); } catch { /* ignore */ }
          try { child.unref?.(); } catch { /* ignore */ }
          finish({ code: null, signal: "SIGKILL", pid: child.pid ?? null, unreclaimed: true });
        }, KILL_GRACE_MS);
        hangTimer.unref?.();
      }, 1000);
      graceTimer.unref?.();
    }, timeoutMs);
  });
}

/** Only the owned handle's close event proves reclamation; exit code alone does not. */
export function childLifecycleFailure(result) {
  if (result.unreclaimed || result.hardDeadline) return "child_process_unreclaimed";
  if (result.spawnError) return "child_process_spawn_failed";
  if (result.reclaimed !== true) return "child_process_reclamation_unknown";
  if (result.timedOut) return "child_process_timed_out";
  if (!Number.isInteger(result.code) || result.signal) return "child_process_exit_unknown";
  return null;
}

function requireChildCompletion(result) {
  const code = childLifecycleFailure(result);
  if (code) throw new StageError(code, { details: { exitCode: result.code ?? null, spawnError: result.spawnError ?? null, timedOut: result.timedOut === true } });
}

/** Lifecycle failures stop every caller before further work or cleanup in that directory. */
async function spawnChecked(run, label, command, args, options = {}) {
  const result = await spawnCaptured(command, args, options);
  const failure = childLifecycleFailure(result);
  if (failure) {
    run.log(label, result.stdout, result.stderr);
    if (result.unreclaimed || result.hardDeadline || (result.reclaimed !== true && result.pid != null)) {
      run.recordResidual({ kind: "child", label, pid: result.pid ?? null });
    }
    run.addAssertion(`${label}.lifecycle`, "fail", failure, { label, spawnError: result.spawnError ?? null });
    requireChildCompletion(result);
  }
  return result;
}

function delay(ms) {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, ms); });
}

/**
 * 存活探测（只用于如实的残留报告）：ESRCH 才算已消失。
 * 它**不证明身份**：这个 PID“还活着”并不说明它就是本次创建的服务实例，所以不能拿它当终止依据。
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? LIMITS.httpMs),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, headers: response.headers, text, json };
}

// ------------------------------------------------------------------ 路径守卫（原始绝对路径 / 完整祖先链 / 安全关系）

function lstatOrNull(path) {
  try { return lstatSync(path); } catch { return null; }
}

function realpathOrNull(path) {
  try { return realpathSync(path); } catch { return null; }
}

/** `a` 是否等于 `b` 或包含 `b`（已解析路径、大小写不敏感）。 */
function pathCovers(a, b) {
  const base = pathKey(a);
  const value = pathKey(b);
  if (base === value) return true;
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  return value.startsWith(prefix);
}

/**
 * 将被**扫描 / 复制 / 作为输出目标**的目录根的只读核验：
 * 原始入参必须是完整绝对路径（拒绝相对 / drive-relative / root-relative / 设备路径，
 * 见共享的 `inspectRawAbsolutePath`）→ 必须存在 → 不是 symlink / junction → 完整祖先链到
 * 卷根逐级无重解析点 → realpath 与规范化路径一致。
 * 只读：不创建、不枚举、不删除；核验不过就不写任何东西。
 */
export function auditDirectoryRoot(rawPath, label = "path") {
  const raw = inspectRawAbsolutePath(rawPath);
  if (!raw.ok) return { ok: false, code: `${label}_not_absolute`, reason: raw.reason, resolved: null, real: null };
  const stat = lstatOrNull(raw.resolved);
  if (!stat) return { ok: false, code: `${label}_missing`, reason: "target_missing", resolved: raw.resolved, real: null };
  if (stat.isSymbolicLink()) return { ok: false, code: `${label}_is_reparse_point`, reason: "reparse_point_at_path", resolved: raw.resolved, real: null };
  if (!stat.isDirectory()) return { ok: false, code: `${label}_not_directory`, reason: "target_not_directory", resolved: raw.resolved, real: null };
  const chain = auditAncestorChain(raw.resolved);
  if (!chain.ok) return { ok: false, code: `${label}_ancestor_refused`, reason: chain.reason, resolved: raw.resolved, real: null };
  const real = realpathOrNull(raw.resolved);
  if (!real) return { ok: false, code: `${label}_realpath_failed`, reason: "realpath_failed", resolved: raw.resolved, real: null };
  if (pathKey(real) !== pathKey(raw.resolved)) return { ok: false, code: `${label}_realpath_mismatch`, reason: "realpath_mismatch", resolved: raw.resolved, real: null };
  return { ok: true, code: null, reason: null, resolved: raw.resolved, real };
}

/**
 * 专属临时根（scratch base）的**只读**核验，必须在任何 out mkdir / 扫描 / 复制之前执行。
 * 显式 `--scratch-root` 与**实际默认** `<workbench>/tmp/windows-delivery` 走同一套规则：
 *  - 原始字符串必须是完整绝对路径（相对 / drive-relative / root-relative / 设备路径 / 不完整 UNC 拒绝）；
 *  - 不得是文件系统根（不能把整卷当工作区）；
 *  - 从**最近已存在祖先（包含 base 自身）**逐级核验到卷根；自身或祖先为
 *    symlink / junction 均固定返回 scratch_root_ancestor_refused /
 *    reparse_point_in_ancestor_chain（先查整条链，不另分自身 alias 错误码）；
 *  - 已存在时必须是真实目录，且 realpath 等于规范化路径。
 * 只读：不 mkdir、不枚举、不删除。base 本身**从不**算作本工具所有——所有权只来自
 * `createScratchRecord` 在 base 下新建的随机根及其 manifest，不把 base 全部当自己所有。
 */
export function auditScratchBase(rawPath) {
  const raw = inspectRawAbsolutePath(rawPath);
  if (!raw.ok) return { ok: false, code: "scratch_root_not_absolute", reason: raw.reason, base: null, real: null };
  if (dirname(raw.resolved) === raw.resolved) {
    return { ok: false, code: "scratch_root_is_filesystem_root", reason: "filesystem_root", base: raw.resolved, real: null };
  }
  const chain = auditExistingAncestorChain(raw.resolved);
  if (!chain.ok) return { ok: false, code: "scratch_root_ancestor_refused", reason: chain.reason, base: raw.resolved, real: null };
  const stat = lstatOrNull(raw.resolved);
  if (!stat) return { ok: true, code: null, reason: null, base: raw.resolved, real: null, exists: false, nearest: chain.nearest };
  if (stat.isSymbolicLink()) return { ok: false, code: "scratch_root_is_reparse_point", reason: "reparse_point_at_path", base: raw.resolved, real: null };
  if (!stat.isDirectory()) return { ok: false, code: "scratch_root_not_directory", reason: "target_not_directory", base: raw.resolved, real: null };
  const real = realpathOrNull(raw.resolved);
  if (!real || pathKey(real) !== pathKey(raw.resolved)) {
    return { ok: false, code: "scratch_root_realpath_mismatch", reason: "realpath_mismatch", base: raw.resolved, real: null };
  }
  return { ok: true, code: null, reason: null, base: raw.resolved, real, exists: true, nearest: chain.nearest };
}

/**
 * 调用级路径关系审计，必须在**任何 mkdir / 扫描 / 复制之前**执行：
 *  - out / release 先按原始完整绝对路径校验（不做 resolve 后再查）；
 *  - out 的最近已存在祖先与整条链、release 的完整链都核验到卷根（有 symlink / junction 即拒绝）；
 *  - **scratch base（显式或实际默认）同样在 out 创建之前核验**：根 / 最近已存在祖先 / 根类型 /
 *    realpath 不合格就拒绝，因此无效 scratch 不会出现“out 已写、scratch 后拒”的半截现场；
 *  - release 必须是真实目录且不是重解析点（reviewer 的 source-alias 形态）；out 已存在时必须是真实目录；
 *  - 关系：out 与 release 互不包含；out 不得等于或包含 scratch base。out 可以放在 base 之内
 *    （“输出放授权工作区内”的正常形态，仍走同一套祖先链核验）；base 本身永不被本工具删除，
 *    也不把 base 整体当作本工具所有（只认自己在 base 下新建的随机根 + manifest）。
 * 拒绝时调用方**只写 stdout 并非零**，不创建未验证的 out（不为记录失败先写目录）。
 */
export function auditInvocationPaths({ out = null, release = null, scratchRoot = null } = {}) {
  if (release === null || release === undefined || String(release) === "") {
    return { ok: false, code: "release_missing", reason: "release_missing", exitCode: EXIT.usage };
  }
  if (out === null || out === undefined || String(out) === "") {
    return { ok: false, code: "out_missing", reason: "out_missing", exitCode: EXIT.usage };
  }
  const releaseAudit = auditDirectoryRoot(release, "release");
  if (!releaseAudit.ok) {
    const exitCode = releaseAudit.code === "release_not_absolute" ? EXIT.usage : EXIT.failed;
    return { ok: false, code: releaseAudit.code, reason: releaseAudit.reason, exitCode, details: { reason: releaseAudit.reason } };
  }
  const outRaw = inspectRawAbsolutePath(out);
  if (!outRaw.ok) return { ok: false, code: "out_not_absolute", reason: outRaw.reason, exitCode: EXIT.usage, details: { reason: outRaw.reason } };
  const outChain = auditExistingAncestorChain(outRaw.resolved);
  if (!outChain.ok) return { ok: false, code: "out_path_refused", reason: outChain.reason, exitCode: EXIT.usage, details: { reason: outChain.reason } };
  const outStat = lstatOrNull(outRaw.resolved);
  if (outStat) {
    if (outStat.isSymbolicLink()) return { ok: false, code: "out_is_reparse_point", reason: "reparse_point_at_path", exitCode: EXIT.usage, details: { reason: "reparse_point_at_path" } };
    if (!outStat.isDirectory()) return { ok: false, code: "out_not_directory", reason: "target_not_directory", exitCode: EXIT.usage, details: { reason: "target_not_directory" } };
  }
  if (pathCovers(outRaw.resolved, releaseAudit.resolved)) {
    return { ok: false, code: "out_contains_release", reason: "release_inside_out", exitCode: EXIT.usage, details: { reason: "release_inside_out" } };
  }
  if (pathCovers(releaseAudit.resolved, outRaw.resolved)) {
    return { ok: false, code: "out_inside_release", reason: "out_inside_release", exitCode: EXIT.usage, details: { reason: "out_inside_release" } };
  }
  // scratch base：未提供时校验**实际默认**根（`<workbench>/tmp/windows-delivery`）；
  // 显式给出（包括空 / 空白）一律按入参校验，不静默退回默认根。两者都在 out mkdir 之前。
  const scratchExplicit = scratchRoot !== null && scratchRoot !== undefined;
  const scratchAudit = auditScratchBase(scratchExplicit ? scratchRoot : defaultScratchBase());
  if (!scratchAudit.ok) {
    const exitCode = scratchAudit.code === "scratch_root_not_absolute" ? EXIT.usage : EXIT.failed;
    return {
      ok: false,
      code: scratchAudit.code,
      reason: scratchAudit.reason,
      exitCode,
      details: { reason: scratchAudit.reason, explicitScratchRoot: scratchExplicit },
    };
  }
  if (pathCovers(outRaw.resolved, scratchAudit.base)) {
    return { ok: false, code: "out_contains_scratch_root", reason: "scratch_base_inside_out", exitCode: EXIT.usage, details: { reason: "scratch_base_inside_out" } };
  }
  return {
    ok: true,
    code: null,
    reason: null,
    out: outRaw.resolved,
    release: releaseAudit.resolved,
    releaseReal: releaseAudit.real,
    scratchBase: scratchAudit.base,
    scratchBaseReal: scratchAudit.real,
    scratchExplicit,
  };
}

// ------------------------------------------------------------------ 发布检查 / 冷拷贝

/**
 * 发布清洁度扫描。
 * 只跳过**明确已知**的专属 scratch 目录：`<workbench>/tmp/windows-delivery`（文档固定的
 * 本任务专属根）与调用者用 `excludeScratch` 显式传入的绝对路径（例如本次运行刚创建的根）。
 * 不再扫描其它现存 run 的 manifest 去“推断整个 base 的拥有权”；不含这些已知路径的
 * `tmp` / 其它目录仍按 forbidden 拒绝。
 */
export function inspectRelease(releasePath, options = {}) {
  // 扫描 / 复制来源之前先核验根：原始绝对路径、非重解析点、完整祖先链到卷根、realpath 一致。
  const rootAudit = auditDirectoryRoot(releasePath, "release");
  if (!rootAudit.ok) throw new StageError(rootAudit.code, { details: { reason: rootAudit.reason } });
  const root = rootAudit.resolved;
  const packageAtRoot = join(root, "package.json");
  const workbenchDir = existsSync(packageAtRoot) ? root : join(root, "06-workbench");
  // 嵌套的 workbench 目录同样可能是 junction（或经 junction 指向别处）：扫描 / 复制前复核它的链。
  if (!existsSync(workbenchDir)) throw new StageError("release_required_file_missing", { details: { file: "06-workbench" } });
  const workbenchChain = auditAncestorChain(workbenchDir);
  if (!workbenchChain.ok) throw new StageError("release_workbench_refused", { details: { reason: workbenchChain.reason } });
  const workbenchReal = realpathOrNull(workbenchDir);
  if (!workbenchReal || pathKey(workbenchReal) !== pathKey(workbenchDir)) {
    throw new StageError("release_workbench_refused", { details: { reason: "realpath_mismatch" } });
  }
  const required = ["package.json", "package-lock.json", "server/server.mjs", "public/index.html"];
  for (const item of required) {
    const file = join(workbenchDir, item.split("/").join(sep));
    if (!existsSync(file) || !statSync(file).isFile()) throw new StageError("release_required_file_missing", { details: { file: item } });
  }

  const forbidden = [];
  const excludedScratch = [];
  let files = 0;
  const excludeKeys = new Set();
  const knownScratch = [join(workbenchDir, "tmp", "windows-delivery"), ...(Array.isArray(options.excludeScratch) ? options.excludeScratch : [])];
  for (const candidate of knownScratch) {
    if (typeof candidate !== "string" || candidate === "" || !isAbsolute(candidate)) continue;
    excludeKeys.add(pathKey(candidate));
  }
  const recordExcluded = (dir) => {
    const rel = relative(root, dir).split(sep).join("/");
    if (rel && !excludedScratch.includes(rel)) excludedScratch.push(rel);
  };
  /** 目录里除“明确已知的专属 scratch 路径”外没有任何其它内容时，整个目录也视为被排除。 */
  let knownScratchScanned = 0;
  const onlyKnownScratch = (dir, depth = 0) => {
    if (depth > 14 || knownScratchScanned > 40000) return false;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    if (entries.length === 0) return false;
    for (const entry of entries) {
      knownScratchScanned += 1;
      if (knownScratchScanned > 40000) return false;
      const full = join(dir, entry.name);
      if (excludeKeys.has(pathKey(full))) continue;
      if (entry.isDirectory() && !entry.isSymbolicLink() && onlyKnownScratch(full, depth + 1)) continue;
      return false;
    }
    return true;
  };
  const walk = (dir, depth) => {
    if (depth > 14 || forbidden.length > 0) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      forbidden.push(relative(root, dir).split(sep).join("/") || ".");
      return;
    }
    for (const entry of entries) {
      files += 1;
      if (files > 40000) throw new StageError("release_too_large");
      const name = entry.name;
      const full = join(dir, name);
      if (excludeKeys.has(pathKey(full))) { recordExcluded(full); continue; }
      if (entry.isDirectory() && !entry.isSymbolicLink() && onlyKnownScratch(full)) { recordExcluded(full); continue; }
      if (isForbiddenName(name)) {
        forbidden.push(relative(root, full).split(sep).join("/"));
        if (forbidden.length >= 20) return;
        continue;
      }
      if (entry.isSymbolicLink()) {
        forbidden.push(relative(root, full).split(sep).join("/"));
        continue;
      }
      if (entry.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  if (forbidden.length) throw new StageError("release_not_clean", { details: { forbidden: forbidden.slice(0, 20) } });

  const packageJson = JSON.parse(readFileSync(join(workbenchDir, "package.json"), "utf8"));
  const engines = String(packageJson?.engines?.node ?? "");
  const lockSha256 = sha256File(join(workbenchDir, "package-lock.json"));
  const digest = digestTree(workbenchDir, ["server", "public", "package.json", "package-lock.json"]);
  return { root, workbenchDir, lockSha256, digest, engines, packageVersion: String(packageJson?.version ?? ""), files, excludedScratch };
}

function listFiles(root, target) {
  const absolute = join(root, target.split("/").join(sep));
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [{ rel: target, abs: absolute }];
  const result = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) result.push({ rel, abs: join(dir, entry.name) });
    }
  };
  walk(absolute, target);
  return result;
}

export function digestTree(root, targets) {
  const hash = createHash("sha256");
  for (const target of targets) {
    for (const file of listFiles(root, target)) {
      hash.update(file.rel);
      hash.update("\0");
      hash.update(sha256File(file.abs));
      hash.update("\n");
    }
  }
  return hash.digest("hex");
}

const OPTIONAL_RELEASE_FILES = [
  "scripts/local-backup.mjs",
  "scripts/windows-runtime-check.mjs",
  "scripts/windows-start.ps1",
  "scripts/windows-delivery-check.mjs",
  "test/windows-delivery.test.mjs",
];

/**
 * 冷拷贝：把**已核验**发布目录的白名单文件复制到 `destRoot`。
 *
 * 作为导出的冷拷贝入口，它**不信任调用顺序，也不信任历史校验结果**：
 *  1) 复制前重新只读核验源根与**选定 workbench**（完整绝对 / 非重解析点 / 完整祖先链到卷根 /
 *     realpath 一致），并要求 workbench 真在源根内；再重算源摘要，与 `inspected.digest` 不一致
 *     即拒绝（源在检查后被改过）。
 *  2) 目标必须是原始完整绝对路径、不存在、最近既存祖先到卷根无 symlink / junction，
 *    且与源根互不包含（不把目标建到源里，也不让目标包含源）。
 *  3) 拒绝时**不创建目标、不补删除**；目标创建后仍重验 realpath，不符即停手（已复制内容原样保留）。
 * 只做根 / 祖先 / 路径关系校验，不试图演绎全部恶意并发 TOCTOU，也不扫描系统目录。
 */
export function copyReleaseWhitelist(inspected, destRoot) {
  if (!inspected || typeof inspected !== "object" || typeof inspected.root !== "string" || typeof inspected.workbenchDir !== "string") {
    throw new StageError("copy_source_unverified", { details: { reason: "inspected_unavailable" } });
  }
  const sourceRoot = auditDirectoryRoot(inspected.root, "copy_source_root");
  if (!sourceRoot.ok) throw new StageError(sourceRoot.code, { details: { reason: sourceRoot.reason } });
  const sourceWorkbench = auditDirectoryRoot(inspected.workbenchDir, "copy_source_workbench");
  if (!sourceWorkbench.ok) throw new StageError(sourceWorkbench.code, { details: { reason: sourceWorkbench.reason } });
  if (!pathCovers(sourceRoot.resolved, sourceWorkbench.resolved)) {
    throw new StageError("copy_source_workbench_outside_root", { details: { reason: "workbench_outside_release_root" } });
  }
  const sourceDigest = digestTree(sourceWorkbench.resolved, ["server", "public", "package.json", "package-lock.json"]);
  if (typeof inspected.digest === "string" && sourceDigest !== inspected.digest) {
    throw new StageError("copy_source_digest_changed", { details: { reason: "source_changed_since_inspection" } });
  }
  const destRaw = inspectRawAbsolutePath(destRoot);
  if (!destRaw.ok) throw new StageError("copy_destination_not_absolute", { details: { reason: destRaw.reason } });
  const dest = destRaw.resolved;
  const destStat = lstatOrNull(dest);
  if (destStat) {
    if (destStat.isSymbolicLink()) throw new StageError("copy_destination_is_reparse_point", { details: { reason: "reparse_point_at_path" } });
    throw new StageError("copy_destination_exists");
  }
  const destChain = auditExistingAncestorChain(dest);
  if (!destChain.ok) throw new StageError("copy_destination_refused", { details: { reason: destChain.reason } });
  if (pathCovers(sourceRoot.resolved, dest)) {
    throw new StageError("copy_destination_inside_source", { details: { reason: "destination_inside_source" } });
  }
  if (pathCovers(dest, sourceRoot.resolved)) {
    throw new StageError("copy_destination_contains_source", { details: { reason: "source_inside_destination" } });
  }

  try {
    mkdirSync(dest, { recursive: false });
  } catch (error) {
    throw new StageError("copy_destination_create_failed", { details: { code: error?.code ?? null } });
  }
  // 创建后重验：完整祖先链到卷根 + realpath 等于预期规范化路径。
  const destVerified = auditDirectoryRoot(dest, "copy_destination");
  if (!destVerified.ok) throw new StageError(destVerified.code, { details: { reason: destVerified.reason } });

  const destRootVerified = destVerified.resolved;
  const destWorkbench = join(destRootVerified, "06-workbench");
  mkdirSync(destWorkbench);
  const copied = [];
  const optionalMissing = [];
  const copyFile = (rel) => {
    const source = join(sourceWorkbench.resolved, rel.split("/").join(sep));
    const dest = join(destWorkbench, rel.split("/").join(sep));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    copied.push(rel);
  };
  copyFile("package.json");
  copyFile("package-lock.json");
  const copyDir = (rel) => {
    const source = join(sourceWorkbench.resolved, rel);
    const walk = (src, prefix) => {
      for (const entry of readdirSync(src, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (isForbiddenName(entry.name) || entry.isSymbolicLink()) continue;
        const dest = join(destWorkbench, prefix.split("/").join(sep));
        if (entry.isDirectory()) {
          mkdirSync(dest, { recursive: true });
          walk(join(src, entry.name), `${prefix}/${entry.name}`);
        } else if (entry.isFile()) {
          copyFile(`${prefix}/${entry.name}`);
        }
      }
    };
    walk(source, rel);
  };
  copyDir("server");
  copyDir("public");
  for (const rel of OPTIONAL_RELEASE_FILES) {
    const source = join(sourceWorkbench.resolved, rel.split("/").join(sep));
    if (existsSync(source) && statSync(source).isFile()) copyFile(rel);
    else optionalMissing.push(rel);
  }
  const digest = digestTree(destWorkbench, ["server", "public", "package.json", "package-lock.json"]);
  if (digest !== inspected.digest) throw new StageError("cold_copy_digest_mismatch");
  return { destRoot: destRootVerified, workbenchDir: destWorkbench, copied, optionalMissing, digest };
}

/**
 * 输出目录：先做**原始完整绝对路径 + 最近已存在祖先到卷根 + realpath** 核验，再创建。
 * 只在核验通过的路径下 mkdir；创建后重验完整链与 realpath，不符即拒绝（不再继续写）。
 * 输出校验失败时调用方只写 stdout 并非零，不为了记录失败先写一个未验证的 out。
 */
export function prepareOutDir(outPath) {
  const raw = inspectRawAbsolutePath(outPath);
  if (!raw.ok) throw new StageError("out_not_absolute", { details: { reason: raw.reason } });
  const out = raw.resolved;
  const preAudit = auditExistingAncestorChain(out);
  if (!preAudit.ok) throw new StageError("out_path_refused", { details: { reason: preAudit.reason } });
  const existing = lstatOrNull(out);
  if (existing) {
    if (existing.isSymbolicLink()) throw new StageError("out_is_reparse_point", { details: { reason: "reparse_point_at_path" } });
    if (!existing.isDirectory()) throw new StageError("out_not_directory");
    if (readdirSync(out).length > 0) throw new StageError("out_not_empty");
  } else {
    try {
      mkdirSync(out, { recursive: true });
    } catch (error) {
      throw new StageError("out_create_failed", { details: { code: error?.code ?? null } });
    }
  }
  // 创建后重验：完整祖先链到卷根 + realpath 必须等于预期规范化路径。
  const verified = auditDirectoryRoot(out, "out");
  if (!verified.ok) throw new StageError(verified.code, { details: { reason: verified.reason } });
  for (const name of ["logs", "artifacts"]) {
    const dir = join(verified.resolved, name);
    const stat = lstatOrNull(dir);
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StageError("out_subdir_refused", { details: { name, reason: "reparse_point_or_not_directory" } });
      continue;
    }
    try {
      mkdirSync(dir, { recursive: false });
    } catch (error) {
      throw new StageError("out_create_failed", { details: { name, code: error?.code ?? null } });
    }
    const chain = auditAncestorChain(dir);
    if (!chain.ok) throw new StageError("out_subdir_refused", { details: { name, reason: chain.reason } });
  }
  return verified.resolved;
}

// ------------------------------------------------------------------ npm

function resolveNpm(npmPath, nodePath) {
  if (!npmPath) throw new StageError("npm_not_found");
  const path = resolve(npmPath);
  if (!existsSync(path) || !statSync(path).isFile()) throw new StageError("npm_not_found");
  if (/\.m?js$/i.test(path)) return { command: nodePath, prefix: [path], mode: "node_js_entry" };
  const cli = join(dirname(path), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(cli) && statSync(cli).isFile()) return { command: nodePath, prefix: [cli], mode: "npm_cli_js" };
  // 未核实的 .cmd / .bat 不再拼 cmd.exe 命令线：句柄回收与引用歧义风险太大，直接拒绝。
  throw new StageError("npm_cli_not_verified", { details: { required: "node_modules/npm/bin/npm-cli.js", reason: "unknown_npm_entry" } });
}

function npmEnv({ cache, tempRoot, nodePath }) {
  const home = join(tempRoot, "npm-home");
  mkdirSync(home, { recursive: true });
  const emptyUser = join(tempRoot, "empty-user.npmrc");
  const emptyGlobal = join(tempRoot, "empty-global.npmrc");
  if (!existsSync(emptyUser)) writeFileSync(emptyUser, "", "utf8");
  if (!existsSync(emptyGlobal)) writeFileSync(emptyGlobal, "", "utf8");
  mkdirSync(join(home, "appdata"), { recursive: true });
  mkdirSync(join(home, "localappdata"), { recursive: true });
  // 不设 npm_config_registry：它不能约束 lock 里的 resolved URL，真正的门禁是
  // validateLockSources() 对冻结 lock 的静态校验。
  return minimalEnv({
    PATH: [dirname(nodePath), process.env.PATH ?? ""].join(";"),
    TEMP: join(tempRoot, "tmp"),
    TMP: join(tempRoot, "tmp"),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "appdata"),
    LOCALAPPDATA: join(home, "localappdata"),
    npm_config_cache: resolve(cache),
    npm_config_userconfig: emptyUser,
    npm_config_globalconfig: emptyGlobal,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_ignore_scripts: "true",
    npm_config_loglevel: "error",
  });
}

async function npmCi(run, label, { npm, nodePath, workbenchDir, cache, tempRoot, offline }) {
  mkdirSync(join(tempRoot, "tmp"), { recursive: true });
  const args = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
  if (offline) args.push("--offline");
  const result = await spawnChecked(run, label, npm.command, [...npm.prefix, ...args], {
    cwd: workbenchDir,
    env: npmEnv({ cache, tempRoot, nodePath }),
    timeoutMs: LIMITS.npmMs,
  });
  return { ...result, offline, cacheMiss: isOfflineCacheMiss(result) };
}

/** npm's explicit error code is required; connectivity, permissions and usage errors are not cache misses. */
export function isOfflineCacheMiss(result) {
  return childLifecycleFailure(result) === null && result.code !== 0
    && /^\s*npm (?:error|ERR!) code ENOTCACHED\s*$/mi.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

/** Install protocol with explicit effects: only a completed ENOTCACHED may start online work. */
export async function runDependencyInstallSequence({ install, removeModules }) {
  const first = await install("offline", true);
  requireChildCompletion(first);
  if (first.code === 0) return { networkUsed: false, offlineProven: true };
  if (!isOfflineCacheMiss(first)) throw new StageError("dependency_offline_install_failed", { details: { exitCode: first.code } });
  const online = await install("online", false);
  requireChildCompletion(online);
  if (online.code !== 0) throw new StageError("dependency_install_failed", { details: { exitCode: online.code } });
  // No remove or reinstall is reachable until both preceding owned children completed.
  await removeModules();
  const second = await install("offline-after-online", true);
  requireChildCompletion(second);
  if (second.code !== 0) throw new StageError("dependency_offline_reinstall_failed", { details: { exitCode: second.code } });
  return { networkUsed: true, offlineProven: true };
}

async function installDependencies(run, { npm, nodePath, copied, cache, tempRoot, stageName, scratch }) {
  const workbenchDir = copied.workbenchDir;
  const lockBefore = sha256File(join(workbenchDir, "package-lock.json"));
  const { networkUsed, offlineProven } = await runDependencyInstallSequence({
    install: async (step, offline) => {
      const result = await npmCi(run, `${stageName}-${step}`, { npm, nodePath, workbenchDir, cache, tempRoot, offline });
      run.log(`${stageName}-${step}`, result.stdout, result.stderr);
      if (step === "offline" && result.code !== 0 && result.cacheMiss) {
        run.note(`${stageName}.offline_first`, "dependency_cache_missing", { code: result.code, cacheMiss: true });
      }
      return result;
    },
    removeModules: async () => {
      // 删除 node_modules 后证明同一专属缓存可完全离线重装。删除走唯一守卫：manifest 登记 +
      // 根内 + 完整祖先链 + realpath + 无重解析点核验；拒绝/失败就是非零阶段失败，不是 best-effort。
      const modules = join(workbenchDir, "node_modules");
      if (existsSync(modules)) {
        const registered = trackExistingPath(scratch, modules, "node_modules_reinstall");
        const removal = registered ? removeTrackedPath(scratch, modules) : { ok: false, reason: "cleanup_refused:target_not_registered" };
        run.assert(`${stageName}.node_modules_cleanup`, removal.ok, { code: removal.reason ?? "node_modules_cleanup_refused" });
      }
    },
  });
  run.note(`${stageName}.install_mode`, networkUsed ? "online_download_then_offline_reinstall" : "offline_cache_hit");
  const lockAfter = sha256File(join(workbenchDir, "package-lock.json"));
  run.assert(`${stageName}.lock_hash_unchanged`, lockBefore === lockAfter, { code: "lock_hash_changed" });
  const modules = join(workbenchDir, "node_modules");
  run.assert(`${stageName}.node_modules_present`, existsSync(modules), { code: "dependency_install_missing" });

  const load = await spawnChecked(run, `${stageName}-load`, nodePath, ["--input-type=module", "-e", [
    "import { readFileSync } from 'node:fs';",
    "import { pathToFileURL } from 'node:url';",
    "await import('exceljs'); await import('pdfkit'); await import(pathToFileURL(process.cwd() + '/server/report-office-export.mjs').href);",
    "const version = (name) => JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;",
    "process.stdout.write(JSON.stringify({ exceljs: version('exceljs'), pdfkit: version('pdfkit') }));",
  ].join(" ")], {
    cwd: workbenchDir,
    env: minimalEnv({ TEMP: join(tempRoot, "tmp"), TMP: join(tempRoot, "tmp") }),
    timeoutMs: LIMITS.suiteMs,
  });
  run.log(`${stageName}-load`, load.stdout, load.stderr);
  if (load.code !== 0) throw new StageError("dependency_load_failed", { details: { exitCode: load.code } });
  let versions = null;
  try { versions = JSON.parse(load.stdout.trim()); } catch { versions = null; }
  run.assert(`${stageName}.exceljs_version`, versions?.exceljs === "4.4.0", { code: "dependency_version_mismatch", details: { expected: "4.4.0", actual: versions?.exceljs ?? null } });
  run.assert(`${stageName}.pdfkit_version`, versions?.pdfkit === "0.20.2", { code: "dependency_version_mismatch", details: { expected: "0.20.2", actual: versions?.pdfkit ?? null } });
  const npmVersion = await spawnChecked(run, `${stageName}-npm-version`, npm.command, [...npm.prefix, "--version"], {
    cwd: workbenchDir,
    env: npmEnv({ cache, tempRoot, nodePath }),
    timeoutMs: LIMITS.suiteMs,
  });
  run.note(`${stageName}.tool_versions`, "recorded", {
    node: process.versions.node,
    npm: npmVersion.code === 0 ? npmVersion.stdout.trim() : null,
    platform: process.platform,
    arch: process.arch,
  });
  return { networkUsed, offlineProven, versions, lockSha256: lockAfter };
}

// ------------------------------------------------------------------ 服务器进程

/** Production-owned child observer: exit is diagnostic; only close proves reclamation. */
export function observeOwnedChild(child, { wait = waitBounded, termMs = 10000, killMs = KILL_GRACE_MS } = {}) {
  let closed = false;
  let exited = false;
  let info = null;
  let spawnError = null;
  let stopping = null;
  const completion = new Promise((done) => {
    child.once("error", (error) => { spawnError = error; });
    child.once("exit", () => { exited = true; });
    child.once("close", (code, signal) => { closed = true; info = { code, signal }; done(info); });
  });
  return {
    get closed() { return closed; }, get exited() { return exited; },
    get spawnError() { return spawnError; }, get info() { return info; },
    wait: (ms) => closed ? Promise.resolve(info) : wait(completion, ms),
    stop() {
      if (!stopping) stopping = (async () => {
        if (closed) return info;
        try { child.kill(); } catch { /* owned handle only */ }
        let result = await wait(completion, termMs);
        if (!result) {
          try { child.kill("SIGKILL"); } catch { /* owned handle only */ }
          result = await wait(completion, killMs);
        }
        if (!closed || !result) {
          // Do not let unknown owned handles keep the manager event loop alive.
          // This changes no reclamation fact; callers must record unknown and retain.
          child.stdout?.unref?.(); child.stderr?.unref?.(); child.unref?.();
          throw new StageError("owned_child_close_unknown");
        }
        return result;
      })();
      return stopping;
    },
  };
}

function waitBounded(promise, ms) {
  return new Promise((done) => {
    const timer = setTimeout(() => done(null), ms);
    promise.then((value) => { clearTimeout(timer); done(value); });
  });
}

export async function startServer(run, { nodePath, workbenchDir, dataDir, tempRoot, port = 0, font, fontFamily, label }, ops = {}) {
  if (existsSync(dataDir) && !statSync(dataDir).isDirectory()) throw new StageError("data_dir_not_directory");
  const env = minimalEnv({
    TEMP: join(tempRoot, "tmp"),
    TMP: join(tempRoot, "tmp"),
    HOST: "127.0.0.1",
    PORT: String(port),
    WORKBENCH_DATA_DIR: dataDir,
    REPORT_PDF_FONT: font ?? undefined,
    REPORT_PDF_FONT_FAMILY: fontFamily ?? undefined,
  });
  const started = Date.now();
  const child = (ops.spawn ?? spawn)(nodePath, [join(workbenchDir, "server", "server.mjs")], {
    cwd: workbenchDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let ready = false;
  const lifecycle = observeOwnedChild(child, ops.lifecycle);
  const terminate = async (reason) => {
    try {
      const info = await lifecycle.stop();
      run.note(`${label}.service_close`, "reclaimed", { ...info, reason });
      return info;
    }
    catch (error) {
      run.recordResidual({ kind: "server", label, pid: child.pid ?? null, reason, exited: lifecycle.exited, closed: lifecycle.closed, spawnError: lifecycle.spawnError?.code ?? null });
      run.addAssertion(`${label}.service_reclaimed`, "fail", "service_not_reclaimed", { reason });
      // Unknown close blocks callers, including restart and sequential same-directory starts.
      throw error;
    }
  };
  const portPromise = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new StageError("server_not_ready_timeout")), LIMITS.readinessMs);
    child.once("error", () => { clearTimeout(timer); rejectPromise(new StageError("server_spawn_failed")); });
    child.once("exit", (code) => { clearTimeout(timer); rejectPromise(new StageError("server_exited_before_ready", { details: { exitCode: code } })); });
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_STREAM_BYTES) stdout += chunk.toString("utf8");
      const match = /127\.0\.0\.1:(\d+)\//.exec(stdout);
      if (match) { clearTimeout(timer); resolvePromise(Number(match[1])); }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STREAM_BYTES) stderr += chunk.toString("utf8");
    });
  });
  let actualPort;
  try {
    actualPort = await portPromise;
  } catch (error) {
    try { await terminate("readiness_failed"); }
    finally { run.log(`${label}-start-failure`, stdout, stderr); }
    throw error;
  }
  const base = `http://127.0.0.1:${actualPort}`;
  const requested = [];
  const request = async (method, path, body) => {
    requested.push(path.split("?")[0]);
    return (ops.fetchJson ?? fetchJson)(`${base}${path}`, { method, body });
  };
  // Port output is only a candidate. HTTP success and a live owned child are both required.
  try {
    const readyDeadline = Date.now() + (ops.readinessMs ?? LIMITS.readinessMs);
    while (Date.now() < readyDeadline) {
      if (lifecycle.exited || lifecycle.closed || lifecycle.spawnError) throw new StageError("server_exited_before_ready");
      try {
        const probe = await request("GET", "/api/account-sets");
        if (probe.status === 200 && !lifecycle.exited && !lifecycle.closed && !lifecycle.spawnError) { ready = true; break; }
      } catch { /* bounded HTTP retry, never return an unready handle */ }
      if (lifecycle.exited || lifecycle.closed || lifecycle.spawnError) throw new StageError("server_exited_before_ready");
      await delay(100);
    }
    if (!ready) throw new StageError("server_not_ready_http");
  } catch (error) {
    try { await terminate("http_readiness_failed"); }
    finally { run.log(`${label}-start-failure`, stdout, stderr); }
    throw error;
  }
  const handle = {
    child,
    port: actualPort,
    base,
    requested,
    request,
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    async stop() {
      return terminate("stop");
    },
    stdout: () => stdout,
    stderr: () => stderr,
    startedAt: started,
    ready,
  };
  run.note(`${label}.port`, "loopback_ready", { port: actualPort, readyMs: Date.now() - started });
  return handle;
}

// ------------------------------------------------------------------ 合成业务

const SOURCE = Object.freeze({ system: "local-book", enterpriseKey: "91350000WINDELIVERY01X", enterpriseName: "Windows 交付合成公司" });
const META = Object.freeze({ name: "Windows 交付合成公司", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" });
const JAN_BATCH = "WIN-DELIVERY-2026-01";
const FEB_BATCH = "WIN-DELIVERY-2026-02";

function payloadJan() {
  return {
    account_set: { ...META },
    opening_balances: [{ code: "1002", debit: 50000, credit: 0 }, { code: "3001", debit: 0, credit: 50000 }],
    vouchers: [{
      period: "2026-01", date: "2026-01-08", word: "记", number: 1, summary: "销售商品",
      sourceVoucherId: "WIN-SRC-0001",
      entries: [
        { code: "1122", debit: 11300, credit: 0 },
        { code: "5001", debit: 0, credit: 10000 },
        { code: "2221", debit: 0, credit: 1300 },
      ],
    }],
  };
}

function payloadFeb() {
  return {
    account_set: { ...META },
    vouchers: [{
      period: "2026-02", date: "2026-02-09", word: "记", number: 1, summary: "收回货款",
      sourceVoucherId: "WIN-SRC-0002",
      entries: [{ code: "1002", debit: 11300, credit: 0 }, { code: "1122", debit: 0, credit: 11300 }],
    }],
  };
}

async function importDemoBusiness(run, handle, stagePrefix = "import") {
  const dry = await handle.post("/api/import/incremental", { batchId: JAN_BATCH, source: SOURCE, payload: payloadJan() });
  run.assert(`${stagePrefix}.dry_run_preview`, dry.status === 200 && dry.json?.status === "preview" && dry.json?.dryRun === true, { code: "import_dry_run_failed", details: { status: dry.status, statusField: dry.json?.status ?? null } });
  const empty = await handle.get("/api/account-sets");
  run.assert(`${stagePrefix}.dry_run_no_write`, empty.status === 200 && Array.isArray(empty.json) && empty.json.length === 0, { code: "dry_run_wrote_data" });

  const applied = await handle.post("/api/import/incremental", { batchId: JAN_BATCH, source: SOURCE, payload: payloadJan(), dryRun: false });
  run.assert(`${stagePrefix}.january_applied`, applied.status === 201 && applied.json?.status === "applied" && applied.json?.created?.accountSetCreated === true && applied.json?.created?.vouchersCreated === 1, { code: "first_import_failed", details: { status: applied.status } });
  const setId = applied.json?.created?.accountSetId;
  run.assert(`${stagePrefix}.account_set_id`, Number.isInteger(setId) && setId > 0, { code: "account_set_id_missing" });

  const retry = await handle.post("/api/import/incremental", { batchId: JAN_BATCH, source: SOURCE, payload: payloadJan(), dryRun: false });
  run.assert(`${stagePrefix}.retry_idempotent`, retry.status === 200 && retry.json?.status === "idempotent_replay" && retry.json?.created?.vouchersCreated === 0, { code: "retry_not_idempotent", details: { status: retry.status } });

  const feb = await handle.post("/api/import/incremental", { batchId: FEB_BATCH, source: SOURCE, mode: "append", accountSetId: setId, payload: payloadFeb(), dryRun: false });
  run.assert(`${stagePrefix}.february_append`, feb.status === 201 && feb.json?.status === "applied" && feb.json?.created?.accountSetCreated === false && feb.json?.created?.vouchersCreated === 1, { code: "second_month_import_failed", details: { status: feb.status } });
  const sets = await handle.get("/api/account-sets");
  run.assert(`${stagePrefix}.one_account_set`, sets.status === 200 && Array.isArray(sets.json) && sets.json.length === 1 && sets.json[0].id === setId, { code: "account_set_not_reused" });
  return { setId };
}

async function assertBatchTrace(run, handle, id, prefix) {
  const jan = await handle.get(`/api/import/batches/${JAN_BATCH}`);
  run.assert(`${prefix}.january_batch`, jan.status === 200 && jan.json?.batch?.status === "completed" && jan.json?.sourceTrace?.[0]?.sourceVoucherId === "WIN-SRC-0001", { code: "batch_trace_missing", details: { status: jan.status } });
  const feb = await handle.get(`/api/import/batches/${FEB_BATCH}`);
  run.assert(`${prefix}.february_batch`, feb.status === 200 && feb.json?.sourceTrace?.[0]?.sourceVoucherId === "WIN-SRC-0002" && feb.json?.sourceTrace?.[0]?.voucherId > 0, { code: "batch_trace_missing", details: { status: feb.status } });
  const sets = await handle.get("/api/account-sets");
  run.assert(`${prefix}.single_account_set`, sets.status === 200 && sets.json?.length === 1 && sets.json[0].id === id, { code: "account_set_not_persisted" });
}

function moneyEqual(actual, expected) {
  return typeof actual === "number" && Math.abs(actual - expected) < 0.005;
}

async function assertAmounts(run, handle, prefix, setId) {
  const jan = await handle.get(`/api/account-sets/${setId}/reports/trial-balance/export-data?period=2026-01`);
  const janLines = Array.isArray(jan.json?.data?.lines) ? jan.json.data.lines : [];
  const jan1002 = janLines.find((line) => line.code === "1002");
  const jan1122 = janLines.find((line) => line.code === "1122");
  const jan5001 = janLines.find((line) => line.code === "5001");
  run.assert(`${prefix}.january_bank`, moneyEqual(jan1002?.closing_debit, 50000), { code: "amount_mismatch", details: { field: "1002.closing_debit", actual: jan1002?.closing_debit ?? null } });
  run.assert(`${prefix}.january_receivable`, moneyEqual(jan1122?.closing_debit, 11300), { code: "amount_mismatch", details: { field: "1122.closing_debit", actual: jan1122?.closing_debit ?? null } });
  run.assert(`${prefix}.january_revenue`, moneyEqual(jan5001?.period_credit, 10000), { code: "amount_mismatch", details: { field: "5001.period_credit", actual: jan5001?.period_credit ?? null } });

  const feb = await handle.get(`/api/account-sets/${setId}/reports/trial-balance/export-data?period=2026-02`);
  const lines = Array.isArray(feb.json?.data?.lines) ? feb.json.data.lines : [];
  const bank = lines.find((line) => line.code === "1002");
  const receivable = lines.find((line) => line.code === "1122");
  const revenue = lines.find((line) => line.code === "5001");
  run.assert(`${prefix}.february_bank`, moneyEqual(bank?.opening_debit, 50000) && moneyEqual(bank?.period_debit, 11300) && moneyEqual(bank?.closing_debit, 61300), { code: "amount_mismatch", details: { field: "1002", opening: bank?.opening_debit ?? null, period: bank?.period_debit ?? null, closing: bank?.closing_debit ?? null } });
  run.assert(`${prefix}.february_receivable`, moneyEqual(receivable?.period_debit, 0) && moneyEqual(receivable?.period_credit, 11300) && moneyEqual(receivable?.closing_debit, 0), { code: "amount_mismatch", details: { field: "1122", period_debit: receivable?.period_debit ?? null, period_credit: receivable?.period_credit ?? null } });
  run.assert(`${prefix}.february_revenue`, moneyEqual(revenue?.period_credit, 0) && moneyEqual(revenue?.ytd_credit, 10000), { code: "amount_mismatch", details: { field: "5001", current: revenue?.period_credit ?? null, ytd: revenue?.ytd_credit ?? null } });
  return { jan, feb };
}

function parseCsv(text) {
  const source = String(text ?? "").replace(/^\uFEFF/u, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(field); field = ""; continue; }
    if (char === "\r") { if (source[index + 1] === "\n") index += 1; row.push(field); field = ""; rows.push(row); row = []; continue; }
    if (char === "\n") { row.push(field); field = ""; rows.push(row); row = []; continue; }
    field += char;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function findHeader(rows, firstCell) {
  return rows.findIndex((row) => Array.isArray(row) && row[0] === firstCell);
}

function cellsByHeader(rows, headerIndex) {
  const header = rows[headerIndex];
  const map = new Map(header.map((label, index) => [String(label).trim(), index]));
  const body = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.every((cell) => String(cell ?? "").trim() === "")) break;
    body.push(row);
  }
  return { map, body };
}

function cellAt(row, map, label) {
  const index = map.get(label);
  return index === undefined ? undefined : row[index];
}

function numberCell(value) {
  const text = String(value ?? "").replaceAll(",", "").trim();
  if (text === "") return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function assertCsvReports(run, responses) {
  const checks = {
    "trial-balance": (rows) => {
      const headerIndex = findHeader(rows, "科目编码");
      run.assert("reports.csv.trial_balance_header", headerIndex >= 0, { code: "csv_header_missing" });
      const { map, body } = cellsByHeader(rows, headerIndex);
      const row = body.find((item) => cellAt(item, map, "科目编码") === "1002");
      run.assert("reports.csv.trial_balance_1002", row !== undefined
        && numberCell(cellAt(row, map, "期初借方")) === 50000
        && numberCell(cellAt(row, map, "本期借方")) === 11300
        && numberCell(cellAt(row, map, "期末借方")) === 61300, { code: "csv_amount_mismatch" });
      const revenue = body.find((item) => cellAt(item, map, "科目编码") === "5001");
      run.assert("reports.csv.trial_balance_revenue", revenue !== undefined
        && numberCell(cellAt(revenue, map, "本期贷方")) === 0
        && numberCell(cellAt(revenue, map, "本年贷方")) === 10000, { code: "csv_amount_mismatch" });
    },
    "income-statement": (rows) => {
      const headerIndex = findHeader(rows, "项目");
      run.assert("reports.csv.income_header", headerIndex >= 0, { code: "csv_header_missing" });
      const { map, body } = cellsByHeader(rows, headerIndex);
      const row = body.find((item) => cellAt(item, map, "项目") === "营业收入");
      run.assert("reports.csv.income_revenue", row !== undefined
        && numberCell(cellAt(row, map, "本期发生")) === 0
        && numberCell(cellAt(row, map, "本年累计")) === 10000, { code: "csv_amount_mismatch" });
    },
    "balance-sheet": (rows) => {
      const headerIndex = findHeader(rows, "分类");
      run.assert("reports.csv.balance_header", headerIndex >= 0, { code: "csv_header_missing" });
      const { map, body } = cellsByHeader(rows, headerIndex);
      const cash = body.find((item) => cellAt(item, map, "项目") === "货币资金");
      const capital = body.find((item) => cellAt(item, map, "项目") === "实收资本");
      const retained = body.find((item) => cellAt(item, map, "项目") === "未分配利润");
      run.assert("reports.csv.balance_cash", cash !== undefined
        && numberCell(cellAt(cash, map, "期间期初")) === 50000
        && numberCell(cellAt(cash, map, "期末")) === 61300, { code: "csv_amount_mismatch" });
      run.assert("reports.csv.balance_equity", capital !== undefined && retained !== undefined
        && numberCell(cellAt(capital, map, "期末")) === 50000
        && numberCell(cellAt(retained, map, "期末")) === 10000, { code: "csv_amount_mismatch" });
    },
    "cash-flow-statement": (rows) => {
      const headerIndex = findHeader(rows, "分类");
      run.assert("reports.csv.cashflow_header", headerIndex >= 0, { code: "csv_header_missing" });
      const { map, body } = cellsByHeader(rows, headerIndex);
      const operating = body.find((item) => cellAt(item, map, "分类") === "经营活动净额");
      const begin = body.find((item) => cellAt(item, map, "分类") === "现金期初余额");
      const end = body.find((item) => cellAt(item, map, "分类") === "现金期末余额");
      run.assert("reports.csv.cashflow_operating", operating !== undefined
        && numberCell(cellAt(operating, map, "本期发生")) === 11300, { code: "csv_amount_mismatch" });
      run.assert("reports.csv.cashflow_balances", begin !== undefined && end !== undefined
        && numberCell(cellAt(begin, map, "本期发生")) === 50000
        && numberCell(cellAt(end, map, "本期发生")) === 61300, { code: "csv_amount_mismatch" });
    },
    ledger: (rows) => {
      const headerIndex = findHeader(rows, "日期");
      run.assert("reports.csv.ledger_header", headerIndex >= 0, { code: "csv_header_missing" });
      const { map, body } = cellsByHeader(rows, headerIndex);
      const row = body.find((item) => cellAt(item, map, "科目编码") === "1002");
      run.assert("reports.csv.ledger_1002", row !== undefined
        && numberCell(cellAt(row, map, "借方")) === 11300
        && numberCell(cellAt(row, map, "余额（借减贷）")) === 61300, { code: "csv_amount_mismatch" });
    },
  };
  for (const [kind, verify] of Object.entries(checks)) {
    const response = responses.get(kind);
    run.assert(`reports.export.${kind}`, response?.status === 200 && /text\/csv/.test(response.headers.get("content-type") ?? "") && /attachment/.test(response.headers.get("content-disposition") ?? ""), { code: "csv_export_failed", details: { status: response?.status ?? null } });
    const rows = parseCsv(response?.text ?? "");
    verify(rows);
  }
}

function dtoFor(kind, query, setId = 1) {
  return `/api/account-sets/${setId}/reports/${kind}/export-data?period=2026-02${query}`;
}

async function assertDtoReports(run, handle, setId) {
  const dto = new Map();
  for (const kind of ["balance-sheet", "income-statement", "cash-flow-statement", "trial-balance"]) {
    const response = await handle.get(dtoFor(kind, "", setId));
    run.assert(`reports.dto.${kind}`, response.status === 200 && response.json?.kind === kind && response.json?.period === "2026-02", { code: "dto_export_failed", details: { status: response.status } });
    dto.set(kind, response.json);
  }
  const ledger = await handle.get(dtoFor("ledger", "&code=1002", setId));
  run.assert("reports.dto.ledger", ledger.status === 200 && ledger.json?.data?.code === "1002" && ledger.json?.data?.items?.length >= 1, { code: "dto_export_failed", details: { status: ledger.status } });
  dto.set("ledger", ledger.json);

  const trial = dto.get("trial-balance");
  const bank = trial?.data?.lines?.find((line) => line.code === "1002");
  run.assert("reports.dto.trial_balance_amounts", moneyEqual(bank?.closing_debit, 61300) && moneyEqual(bank?.ytd_debit, 11300), { code: "dto_amount_mismatch" });
  const income = dto.get("income-statement");
  run.assert("reports.dto.income_amounts", moneyEqual(income?.data?.current?.["营业收入"], 0) && moneyEqual(income?.data?.ytd?.["营业收入"], 10000), { code: "dto_amount_mismatch" });
  const balance = dto.get("balance-sheet");
  const cash = balance?.data?.assets?.find((line) => line.label === "货币资金");
  const retained = balance?.data?.liabilities?.find((line) => line.label === "未分配利润");
  run.assert("reports.dto.balance_amounts", moneyEqual(cash?.value, 61300) && moneyEqual(retained?.value, 10000), { code: "dto_amount_mismatch" });
  const cashflow = dto.get("cash-flow-statement");
  run.assert("reports.dto.cashflow_amounts", moneyEqual(cashflow?.data?.totals?.operating, 11300) && moneyEqual(cashflow?.data?.cash?.end, 61300), { code: "dto_amount_mismatch" });
  const ledgerDto = dto.get("ledger");
  run.assert("reports.dto.ledger_amounts", moneyEqual(ledgerDto?.data?.current?.debit, 11300) && moneyEqual(ledgerDto?.data?.closing?.debit, 61300), { code: "dto_amount_mismatch" });

  // The current HTTP layer intentionally supports CSV only; XLSX / PDF are pure DTO renderers.
  for (const format of ["xlsx", "pdf"]) {
    const httpOffice = await handle.get(`/api/account-sets/${setId}/reports/trial-balance/export?period=2026-02&format=${format}`);
    run.assert(`office.http_${format}_not_wired`, httpOffice.status === 400 && httpOffice.json?.error === "report_format_unsupported", { code: "http_office_unexpectedly_wired", details: { status: httpOffice.status } });
  }
  return dto;
}

// ------------------------------------------------------------------ Office（纯 DTO）

const OFFICE_HELPER = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = Object.fromEntries(process.argv.slice(2).map((item) => item.split("=")));
const { pathToFileURL } = await import("node:url");
const modulePath = pathToFileURL(join(process.cwd(), "server", "report-office-export.mjs")).href;
const office = await import(modulePath);
const report = JSON.parse(readFileSync(args.dto, "utf8"));
const document = office.buildReportDocument(report);
const result = { kind: report.kind, xlsx: null, pdf: null, pdfError: null };
try {
  const xlsx = await office.buildReportXlsx(report, document);
  const xlsxPath = join(args.outdir, report.kind + ".xlsx");
  writeFileSync(xlsxPath, xlsx);
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsx);
  const worksheet = workbook.worksheets[0];
  const numbers = new Set();
  worksheet.eachRow((row) => row.eachCell({ includeEmpty: false }, (cell) => {
    const value = cell.value;
    if (typeof value === "number") numbers.add(value);
    else if (value && typeof value === "object" && typeof value.result === "number") numbers.add(value.result);
  }));
  result.xlsx = { bytes: xlsx.length, sheets: workbook.worksheets.length, sheetName: worksheet.name, numbers: [...numbers].slice(0, 200) };
} catch (error) {
  result.xlsxError = error?.code || "xlsx_failed";
}
try {
  const pdf = await office.buildReportPdf(report, document);
  const pdfPath = join(args.outdir, report.kind + ".pdf");
  writeFileSync(pdfPath, pdf.buffer);
  result.pdf = { bytes: pdf.buffer.length, pages: pdf.pageCount, font: pdf.font ?? null, magic: pdf.buffer.subarray(0, 5).toString("ascii") };
} catch (error) {
  result.pdfError = error?.code || "pdf_failed";
}
process.stdout.write(JSON.stringify(result));
`;

/** 必需 Office 产物种类：五份报表都必须真的产出 PDF。缺字体时 CSV / XLSX 仍算通过，但不能算整体成功。 */
export const REQUIRED_OFFICE_KINDS = Object.freeze(["balance-sheet", "income-statement", "cash-flow-statement", "trial-balance", "ledger"]);

/**
 * 汇总 Office 渲染结果：必需 PDF 缺失时**不能**算通过，也不能被后续成功覆盖。
 * 缺字体（`pdf_font_unavailable`）只是“PDF 不可用”的原因之一，处理方式一致：
 * 阶段 blocked、总结果 blocked、非零退出、保留现场；CSV / XLSX 的真实通过断言不受影响。
 * @param {Map<string, any>} results
 * @param {readonly string[]} [requiredKinds]
 * @returns {{required:number, rendered:number, requiredBlocked:{kind:string,code:string}[]}}
 */
export function classifyOfficeOutputs(results, requiredKinds = REQUIRED_OFFICE_KINDS) {
  const kinds = Array.isArray(requiredKinds) ? requiredKinds : [];
  const requiredBlocked = [];
  for (const kind of kinds) {
    const result = typeof results?.get === "function" ? results.get(kind) : undefined;
    if (!result || !result.pdf) requiredBlocked.push({ kind, code: result?.pdfError ?? "pdf_render_failed" });
  }
  return { required: kinds.length, rendered: kinds.length - requiredBlocked.length, requiredBlocked };
}

/** Cleanup is a success effect, never a finally effect: rejection retains the real evidence. */
export async function runWithSuccessCleanup(operation, cleanup) {
  const result = await operation();
  await cleanup();
  return result;
}

async function runOfficeStage(run, { nodePath, workbenchDir, tempRoot, outDir, dto, font, fontFamily, label, scratch }) {
  const artifacts = join(outDir, "artifacts", "office");
  const failsBefore = run.assertions.filter((item) => item.status === "fail").length;
  mkdirSync(artifacts, { recursive: true });
  const helperPath = join(workbenchDir, ".windows-delivery-office-helper.mjs");
  const writeHelper = () => {
    writeFileSync(helperPath, OFFICE_HELPER, "utf8");
    const real = trackExistingPath(scratch, helperPath, "office_helper");
    run.assert(`${label}.helper_registered`, Boolean(real), { code: "cleanup_refused:helper_not_registered", details: { file: basename(helperPath) } });
  };
  // 辅助脚本是本进程写入专属冷拷贝根内的精确文件：删除走同一守卫（manifest + 完整祖先链 + realpath）。
  const removeHelper = () => {
    if (!existsSync(helperPath)) return;
    const removal = removeTrackedPath(scratch, helperPath);
    run.assert(`${label}.helper_cleanup`, removal.ok, { code: removal.reason ?? "helper_cleanup_failed", details: { file: basename(helperPath) } });
    run.assert(`${label}.helper_manifest_refresh`, removal.manifestRefreshed !== false, { code: "cleanup_failed:manifest_refresh_failed", details: { file: basename(helperPath) } });
  };
  writeHelper();
  return runWithSuccessCleanup(async () => {
    const results = new Map();
    // Keep the exact helper on any failed/blocked path, including a failed owned child.
    for (const [kind, report] of dto.entries()) {
      const dtoPath = join(artifacts, `${kind}.dto.json`);
      jsonWrite(dtoPath, report);
      const runResult = await spawnChecked(run, `${label}-${kind}`, nodePath, [helperPath, `dto=${dtoPath}`, `outdir=${artifacts}`], {
        cwd: workbenchDir,
        env: minimalEnv({ TEMP: join(tempRoot, "tmp"), TMP: join(tempRoot, "tmp"), REPORT_PDF_FONT: font ?? undefined, REPORT_PDF_FONT_FAMILY: fontFamily ?? undefined }),
        timeoutMs: LIMITS.officeMs,
      });
      run.log(`${label}-${kind}`, runResult.stdout, runResult.stderr);
      if (runResult.code !== 0) throw new StageError("office_render_failed", { details: { kind, exitCode: runResult.code, timedOut: runResult.timedOut === true } });
      let parsed = null;
      try { parsed = JSON.parse(runResult.stdout.trim()); } catch { parsed = null; }
      if (!parsed) throw new StageError("office_render_output_invalid", { details: { kind } });
      results.set(kind, parsed);
    }

    const expectedNumbers = {
      "trial-balance": [50000, 11300, 61300, 10000],
      "income-statement": [10000],
      "balance-sheet": [61300, 50000, 10000],
      "cash-flow-statement": [11300, 50000, 61300],
      ledger: [50000, 11300, 61300],
    };
    const expectedPdf = {
      "trial-balance": ["科目余额表", "61,300.00"],
      "income-statement": ["利润表", "10,000.00"],
      "balance-sheet": ["资产负债表", "61,300.00"],
      "cash-flow-statement": ["现金流量表", "11,300.00"],
      ledger: ["明细账", "61,300.00"],
    };

    for (const [kind, result] of results) {
      run.assert(`office.xlsx.${kind}`, result.xlsx && result.xlsx.bytes > 0 && result.xlsx.sheets >= 1, { code: result.xlsxError ?? "xlsx_render_failed", details: { kind } });
      const numbers = new Set((result.xlsx?.numbers ?? []).map((value) => Math.round(Number(value) * 100) / 100));
      const missing = expectedNumbers[kind].filter((value) => !numbers.has(value));
      run.assert(`office.xlsx.${kind}.amounts`, missing.length === 0, { code: "xlsx_amount_missing", details: { kind, missing } });
      if (result.pdf) {
        run.assert(`office.pdf.${kind}`, result.pdf.bytes > 0 && result.pdf.pages >= 1 && result.pdf.magic === "%PDF-", { code: "pdf_render_failed", details: { kind, pages: result.pdf.pages } });
        run.assert(`office.pdf.${kind}.font_embedded`, Boolean(result.pdf.font?.label), { code: "pdf_font_not_embedded", details: { kind } });
        const extracted = await extractPdfPages(run, {
          pdfPath: join(artifacts, `${kind}.pdf`),
          pngPrefix: join(artifacts, kind),
          tempRoot,
          label: `${label}-${kind}-pdf`,
        });
        if (extracted.status === "unavailable") {
          run.note(`office.pdf.${kind}.text`, "pdf_text_extraction_unavailable", { reason: extracted.reason });
          run.addAssertion(`office.pdf.${kind}.text`, "skipped", "pdf_text_extraction_unavailable");
          run.addAssertion(`office.pdf.${kind}.pages_rendered`, "skipped", "pdf_visual_render_unavailable");
          run.addAssertion(`office.pdf.${kind}.visual_inspection`, "skipped", "pdf_visual_render_unavailable");
        } else {
          run.addAssertion(`office.pdf.${kind}.pages`, extracted.pages >= 1 ? "pass" : "fail", extracted.pages >= 1 ? null : "pdf_page_count_invalid");
          const text = String(extracted.text ?? "");
          const [title, amount] = expectedPdf[kind];
          const textOk = text.includes(title) && text.includes(amount);
          run.addAssertion(`office.pdf.${kind}.text`, textOk ? "pass" : "fail", textOk ? null : "pdf_text_mismatch");
          // 声明“全页 PNG”就必须真的逐页输出：页数必须完全相等，否则按失败记。
          const renderedPages = Array.isArray(extracted.renderedPages) ? extracted.renderedPages : [];
          const pageFiles = renderedPages.map((page) => `${join(artifacts, kind)}-page-${page}.png`);
          const allPagesRendered = extracted.pages >= 1
            && renderedPages.length === extracted.pages
            && pageFiles.every((file) => existsSync(file) && statSync(file).size > 1000);
          run.addAssertion(`office.pdf.${kind}.pages_rendered`, allPagesRendered ? "pass" : "fail", allPagesRendered ? null : "pdf_page_render_incomplete", { pages: extracted.pages, rendered: renderedPages.length });
          run.addAssertion(`office.pdf.${kind}.visual_inspection`, "skipped", "human_visual_inspection_not_performed");
          if (allPagesRendered) run.note(`office.pdf.${kind}.visual_artifacts`, "rendered_all_pages_png", { pages: extracted.pages, pattern: `artifacts/office/${kind}-page-<n>.png` });
        }
      } else {
        run.addAssertion(`office.pdf.${kind}`, "blocked", result.pdfError ?? "pdf_render_failed");
        run.note("office.pdf_unavailable", result.pdfError ?? "pdf_render_failed", { kind });
      }
    }

    // Missing font must be an explicit, isolated failure; CSV/XLSX stay usable.
    mkdirSync(join(artifacts, "missing-font"), { recursive: true });
    {
      const probe = await spawnChecked(run, "office-missing-font", nodePath, [helperPath, `dto=${join(artifacts, "trial-balance.dto.json")}`, `outdir=${join(artifacts, "missing-font")}`], {
        cwd: workbenchDir,
        env: minimalEnv({ TEMP: join(tempRoot, "tmp"), TMP: join(tempRoot, "tmp"), REPORT_PDF_FONT: join(tempRoot, "no-such-font-file.ttf") }),
        timeoutMs: LIMITS.officeMs,
      });
      run.log("office-missing-font", probe.stdout, probe.stderr);
      run.assert("failures.missing_font_child", probe.code === 0, { code: "office_missing_font_probe_failed", details: { exitCode: probe.code } });
      let parsed = null;
      try { parsed = JSON.parse(probe.stdout.trim()); } catch { parsed = null; }
      run.assert("failures.missing_font_reported", parsed?.pdfError === "pdf_font_unavailable", { code: "pdf_font_error_not_reported", details: { pdfError: parsed?.pdfError ?? null } });
      run.assert("failures.missing_font_xlsx_still_usable", parsed?.xlsx?.bytes > 0, { code: "xlsx_blocked_by_font" });
    }

    // 必需 PDF 产物缺失（例如缺字体）不能算成功：阶段 blocked、总结果 blocked、退出 2，并保留现场。
    // CSV / XLSX 已真实通过（上面保留），不作为“字体可选”的理由，也不放宽 / 安装字体。
    const outputs = classifyOfficeOutputs(results);
    run.note("office.required_outputs", outputs.requiredBlocked.length === 0 ? "all_required_pdf_rendered" : "required_pdf_output_blocked", {
      required: outputs.required,
      rendered: outputs.rendered,
      blocked: outputs.requiredBlocked,
      csvAndXlsxUnaffected: true,
    });
    if (outputs.requiredBlocked.length > 0) {
      // 已有 fail 断言时按 fail 报：blocked 不得抢在真实失败前面把结论说轻。
      const failsAdded = run.assertions.filter((item) => item.status === "fail").length - failsBefore;
      if (failsAdded > 0) {
        throw new StageError("office_output_incomplete", { details: { blocked: outputs.requiredBlocked, failedAssertions: failsAdded } });
      }
      throw new StageError("pdf_output_required_blocked", {
        blocked: true,
        details: {
          blocked: outputs.requiredBlocked,
          required: outputs.required,
          rendered: outputs.rendered,
          note: "必需 PDF 产物缺失（如 pdf_font_unavailable）时不能算成功：阶段 blocked / 总结果 blocked / 退出 2，输出目录与工作根保留；CSV 与 XLSX 的真实通过断言不受影响，也不安装字体。",
        },
      });
    }
    run.assert(`${label}.outputs_valid`, run.assertions.filter((item) => item.status === "fail").length === failsBefore, { code: "office_output_invalid" });
    return results;
  }, removeHelper);
}

/**
 * 可选验收工具（PyMuPDF）：提取文本并**逐页**渲染 PNG。工具缺失就返回 unavailable（诚实 skip），
 * 不安装依赖、不用首页代替全页。
 */
async function extractPdfPages(run, { pdfPath, pngPrefix, tempRoot, label }) {
  const script = [
    "import fitz, json, sys",
    "doc = fitz.open(sys.argv[1])",
    "text = '\\n'.join(page.get_text() for page in doc)",
    "pages = doc.page_count",
    "rendered = []",
    "for index in range(pages):",
    "    pix = doc[index].get_pixmap(matrix=fitz.Matrix(1.5, 1.5))",
    "    pix.save(sys.argv[2] + '-page-' + str(index + 1) + '.png')",
    "    rendered.append(index + 1)",
    "print(json.dumps({'pages': pages, 'chars': len(text), 'text': text[:400000], 'renderedPages': rendered}, ensure_ascii=True))",
  ].join("\n");
  // 缺少 python / PyMuPDF 是“诚实 skip”，不是交付失败；但子进程未回收仍要如实记失败。
  const result = await spawnCaptured("python", ["-X", "utf8", "-c", script, pdfPath, pngPrefix], {
    cwd: tempRoot,
    env: minimalEnv({
      TEMP: join(tempRoot, "tmp"),
      TMP: join(tempRoot, "tmp"),
      // Optional development-only tool: PyMuPDF may live in the per-user Python
      // site-packages, so keep the standard Windows profile pointers. They are
      // never printed or written to the result.
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
    }),
    timeoutMs: LIMITS.officeMs,
  });
  // Only an absent optional executable is harmless without a close event.
  if (result.spawnError === "ENOENT" && result.pid == null) return { status: "unavailable", reason: "python_pdf_tool_unavailable" };
  const failure = childLifecycleFailure(result);
  if (failure) {
    run.log(label, result.stdout, result.stderr);
    if (result.unreclaimed || result.hardDeadline || (result.reclaimed !== true && result.pid != null)) {
      run.recordResidual({ kind: "child", label, pid: result.pid ?? null });
    }
    run.addAssertion(`${label}.lifecycle`, "fail", failure);
    requireChildCompletion(result);
  }
  if (result.code !== 0) return { status: "unavailable", reason: "python_pdf_tool_unavailable" };
  try {
    const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1));
    return { status: "ok", ...parsed };
  } catch {
    return { status: "unavailable", reason: "python_pdf_output_invalid" };
  }
}

// ------------------------------------------------------------------ 备份 / 恢复

async function runBackupCli(run, { nodePath, workbenchDir, tempRoot, args, label }) {
  const script = join(workbenchDir, "scripts", "local-backup.mjs");
  if (!existsSync(script)) throw new StageError("backup_cli_missing");
  const result = await spawnChecked(run, label, nodePath, [script, ...args], {
    cwd: workbenchDir,
    env: minimalEnv({ TEMP: join(tempRoot, "tmp"), TMP: join(tempRoot, "tmp") }),
    timeoutMs: LIMITS.suiteMs,
  });
  run.log(`${label}`, result.stdout, result.stderr);
  let payload = null;
  try { payload = JSON.parse(result.stdout.trim()); } catch { payload = null; }
  return { ...result, payload };
}

async function readDatabaseFacts(run, nodePath, dbPath, tempRoot) {
  const script = [
    "import { DatabaseSync } from 'node:sqlite';",
    "const db = new DatabaseSync(process.argv[1], { readOnly: true });",
    "const integrity = db.prepare('PRAGMA integrity_check').all();",
    "const fk = db.prepare('PRAGMA foreign_key_check').all();",
    "const count = (name) => { try { return db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n; } catch { return null; } };",
    "const version = (() => { try { return db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations').get().v; } catch { return null; } })();",
    "process.stdout.write(JSON.stringify({ integrity: integrity[0]?.integrity_check ?? null, foreignKeyViolations: fk.length, vouchers: count('vouchers'), voucherEntries: count('voucher_entries'), importBatches: count('import_batches'), importBatchVouchers: count('import_batch_vouchers'), schemaVersion: version }));",
    "db.close();",
  ].join(" ");
  const result = await spawnChecked(run, "database-integrity-probe", nodePath, ["--input-type=module", "-e", script, dbPath], {
    cwd: tempRoot,
    env: minimalEnv({ TEMP: join(tempRoot, "tmp"), TMP: join(tempRoot, "tmp") }),
    timeoutMs: LIMITS.suiteMs,
  });
  if (result.code !== 0) throw new StageError("database_integrity_probe_failed", { details: { exitCode: result.code } });
  try { return JSON.parse(result.stdout.trim()); } catch { throw new StageError("database_integrity_probe_output_invalid"); }
}

async function backupDrill(run, { nodePath, workbenchDir, tempRoot, dataDir, release, outDir }) {
  const backups = join(tempRoot, "backups");
  mkdirSync(backups, { recursive: true });
  const backupDir = join(backups, `backup-${randomTag()}`);
  const created = await runBackupCli(run, { nodePath, workbenchDir, tempRoot, args: ["backup", "--db", join(dataDir, "workbench.db"), "--out", backupDir], label: "backup-create" });
  run.assert("backup.create", created.code === 0 && created.payload?.ok === true && created.payload?.backupMeta?.schemaVersion === 3, { code: "backup_create_failed", details: { exitCode: created.code, code: created.payload?.code ?? null } });
  const snapshotHash = sha256File(join(backupDir, "workbench.db.snapshot"));
  const verified = await runBackupCli(run, { nodePath, workbenchDir, tempRoot, args: ["verify", "--backup", backupDir], label: "backup-verify" });
  run.assert("backup.verify", verified.code === 0 && verified.payload?.ok === true && verified.payload?.summary?.snapshotSha256 === snapshotHash, { code: "backup_verify_failed", details: { exitCode: verified.code } });

  // Negative: corrupted snapshot must be rejected and the original left untouched.
  const corrupt = join(backups, `corrupt-${randomTag()}`);
  mkdirSync(corrupt);
  copyFileSync(join(backupDir, "workbench.db.snapshot"), join(corrupt, "workbench.db.snapshot"));
  copyFileSync(join(backupDir, "manifest.json"), join(corrupt, "manifest.json"));
  const snapshotBytes = readFileSync(join(corrupt, "workbench.db.snapshot"));
  snapshotBytes[Math.floor(snapshotBytes.length / 2)] ^= 0xff;
  writeFileSync(join(corrupt, "workbench.db.snapshot"), snapshotBytes);
  const corruptVerify = await runBackupCli(run, { nodePath, workbenchDir, tempRoot, args: ["verify", "--backup", corrupt], label: "backup-corrupt-snapshot" });
  run.assert("backup.reject_corrupt_snapshot", corruptVerify.code === 2 && corruptVerify.payload?.ok === false && typeof corruptVerify.payload?.code === "string", { code: "corrupt_snapshot_accepted", details: { exitCode: corruptVerify.code, code: corruptVerify.payload?.code ?? null } });
  run.assert("backup.original_unchanged", sha256File(join(backupDir, "workbench.db.snapshot")) === snapshotHash, { code: "original_backup_changed" });

  const corruptManifest = join(backups, `manifest-${randomTag()}`);
  mkdirSync(corruptManifest);
  copyFileSync(join(backupDir, "workbench.db.snapshot"), join(corruptManifest, "workbench.db.snapshot"));
  writeFileSync(join(corruptManifest, "manifest.json"), "{ not-json", "utf8");
  const manifestVerify = await runBackupCli(run, { nodePath, workbenchDir, tempRoot, args: ["verify", "--backup", corruptManifest], label: "backup-corrupt-manifest" });
  run.assert("backup.reject_corrupt_manifest", manifestVerify.code === 2 && manifestVerify.payload?.ok === false, { code: "corrupt_manifest_accepted", details: { exitCode: manifestVerify.code } });

  // Negative: unknown schema must not be "fixed" or accepted.
  const tampered = join(backups, `unknown-schema-${randomTag()}.db`);
  copyFileSync(join(backupDir, "workbench.db.snapshot"), tampered);
  const tamperScript = [
    "import { DatabaseSync } from 'node:sqlite';",
    "const db = new DatabaseSync(process.argv[1]);",
    "db.exec('UPDATE schema_migrations SET version = 4 WHERE version = 3');",
    "db.close();",
  ].join(" ");
  const tamper = await spawnChecked(run, "backup-unknown-schema-setup", nodePath, ["--input-type=module", "-e", tamperScript, tampered], {
    cwd: tempRoot,
    env: minimalEnv({ TEMP: join(tempRoot, "tmp"), TMP: join(tempRoot, "tmp") }),
    timeoutMs: LIMITS.suiteMs,
  });
  run.assert("backup.unknown_schema_setup", tamper.code === 0, { code: "unknown_schema_setup_failed" });
  const unknown = await runBackupCli(run, { nodePath, workbenchDir, tempRoot, args: ["backup", "--db", tampered, "--out", join(backups, `unknown-schema-out-${randomTag()}`)], label: "backup-unknown-schema" });
  run.assert("backup.reject_unknown_schema", unknown.code === 2 && unknown.payload?.ok === false, { code: "unknown_schema_accepted", details: { exitCode: unknown.code, code: unknown.payload?.code ?? null } });

  // Negative: an existing target (even empty / with a sentinel) must be rejected untouched.
  const sentinelDir = join(tempRoot, "data-existing-sentinel");
  mkdirSync(sentinelDir);
  const sentinel = join(sentinelDir, "sentinel.txt");
  writeFileSync(sentinel, "keep-me", "utf8");
  const existing = await runBackupCli(run, { nodePath, workbenchDir, tempRoot, args: ["restore-new", "--backup", backupDir, "--target", sentinelDir], label: "restore-existing-target" });
  run.assert("backup.reject_existing_target", existing.code === 2 && existing.payload?.ok === false && readFileSync(sentinel, "utf8") === "keep-me", { code: "existing_target_accepted", details: { exitCode: existing.code, code: existing.payload?.code ?? null } });

  // Restore to a new directory, then boot the same release against it.
  const restoredDir = join(tempRoot, "data-restored");
  const restored = await runBackupCli(run, { nodePath, workbenchDir, tempRoot, args: ["restore-new", "--backup", backupDir, "--target", restoredDir], label: "restore-new" });
  run.assert("backup.restore_new", restored.code === 0 && restored.payload?.ok === true && existsSync(join(restoredDir, "workbench.db")), { code: "restore_new_failed", details: { exitCode: restored.code, code: restored.payload?.code ?? null } });
  const integrity = await readDatabaseFacts(run, nodePath, join(restoredDir, "workbench.db"), tempRoot);
  run.assert("backup.restored_integrity", integrity.integrity === "ok" && integrity.foreignKeyViolations === 0, { code: "restored_integrity_failed", details: { integrity: integrity.integrity, fk: integrity.foreignKeyViolations } });
  run.assert("backup.restored_row_counts", integrity.vouchers === 2 && integrity.voucherEntries === 5 && integrity.importBatches === 2 && integrity.importBatchVouchers === 2, { code: "restored_row_count_mismatch", details: integrity });

  const restoredServer = await startServer(run, { nodePath, workbenchDir, dataDir: restoredDir, tempRoot, label: "restored" });
  try {
    const sets = await restoredServer.get("/api/account-sets");
    run.assert("backup.restored_account_set", sets.status === 200 && sets.json?.length === 1 && sets.json[0].name === META.name, { code: "restored_account_set_missing" });
    await assertAmounts(run, restoredServer, "backup.restored", sets.json[0].id);
    await assertBatchTrace(run, restoredServer, sets.json[0].id, "backup.restored");
    const replay = await restoredServer.post("/api/import/incremental", { batchId: JAN_BATCH, source: SOURCE, payload: payloadJan(), dryRun: false });
    run.assert("backup.restored_idempotent", replay.status === 200 && replay.json?.status === "idempotent_replay" && replay.json?.created?.vouchersCreated === 0, { code: "restored_retry_not_idempotent", details: { status: replay.status } });
    const vouchers = await restoredServer.get(`/api/account-sets/${sets.json[0].id}/vouchers`);
    run.assert("backup.restored_voucher_count", vouchers.status === 200 && vouchers.json?.length === 2, { code: "restored_voucher_count_mismatch" });
  } finally {
    await restoredServer.stop();
  }
  return { backupDir, snapshotHash, restoredDir, release: release.workbenchDir, outDir };
}

// ------------------------------------------------------------------ 失败路径 / 稳定性

async function portConflictProbe(run, { nodePath, workbenchDir, tempRoot }) {
  const listener = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    listener.once("error", rejectPromise);
    listener.listen(0, "127.0.0.1", resolvePromise);
  });
  let connections = 0;
  listener.on("connection", () => { connections += 1; });
  const port = listener.address().port;
  try {
    const result = await spawnChecked(run, "port-conflict", nodePath, [join(workbenchDir, "server", "server.mjs")], {
      cwd: workbenchDir,
      env: minimalEnv({ TEMP: join(tempRoot, "tmp"), TMP: join(tempRoot, "tmp"), HOST: "127.0.0.1", PORT: String(port), WORKBENCH_DATA_DIR: join(tempRoot, "data-port-conflict") }),
      timeoutMs: LIMITS.readinessMs,
    });
    run.log("port-conflict", result.stdout, result.stderr);
    const diagnostic = /EADDRINUSE/.test(result.stderr) ? "port_in_use" : "port_conflict_unclassified";
    run.assert("failures.port_conflict", result.code !== null && result.code !== 0 && !result.timedOut, { code: "port_conflict_not_reported", details: { exitCode: result.code, signal: result.signal, timedOut: result.timedOut } });
    run.note("failures.port_conflict.diagnostic", diagnostic, { exitCode: result.code });
    run.assert("failures.port_conflict_no_placeholder_traffic", connections === 0, { code: "placeholder_service_contacted", details: { connections } });
  } finally {
    await new Promise((resolvePromise) => listener.close(resolvePromise));
  }
}

async function illegalDirectoryProbe(run, { nodePath, workbenchDir, tempRoot, runtimeCheckScript, scratchRoot }) {
  const filePath = join(tempRoot, "data-illegal-file");
  writeFileSync(filePath, "not-a-directory", "utf8");
  const before = sha256File(filePath);
  const pre = await spawnChecked(run, "illegal-data-dir-precheck", nodePath, [runtimeCheckScript, "--json", "--data-dir", filePath, "--scratch-root", scratchRoot], {
    cwd: workbenchDir,
    env: minimalEnv({ TEMP: join(tempRoot, "tmp"), TMP: join(tempRoot, "tmp") }),
    timeoutMs: LIMITS.suiteMs,
  });
  let prePayload = null;
  try { prePayload = JSON.parse(pre.stdout.trim()); } catch { prePayload = null; }
  run.assert("failures.illegal_data_dir_precheck", pre.code === 2 && prePayload?.ok === false && prePayload?.code === "data_dir_not_directory", { code: "illegal_data_dir_precheck_failed", details: { exitCode: pre.code, code: prePayload?.code ?? null } });
  run.assert("failures.illegal_data_dir_precheck_cleaned", prePayload?.cleanup?.completed === true, { code: "precheck_cleanup_incomplete", details: { cleanup: prePayload?.cleanup ?? null } });
  const server = await spawnChecked(run, "illegal-data-dir-server", nodePath, [join(workbenchDir, "server", "server.mjs")], {
    cwd: workbenchDir,
    env: minimalEnv({ TEMP: join(tempRoot, "tmp"), TMP: join(tempRoot, "tmp"), HOST: "127.0.0.1", PORT: "0", WORKBENCH_DATA_DIR: filePath }),
    timeoutMs: LIMITS.readinessMs,
  });
  run.log("illegal-data-dir-server", server.stdout, server.stderr);
  run.assert("failures.illegal_data_dir_server", server.code !== null && server.code !== 0 && !server.timedOut, { code: "illegal_data_dir_started", details: { exitCode: server.code, timedOut: server.timedOut } });
  run.assert("failures.illegal_data_dir_untouched", sha256File(filePath) === before, { code: "illegal_data_dir_mutated" });
}

export async function startScriptProbe(run, { tempRoot, nodePath, startScript, scratchRoot }, ops = {}) {
  if (!(ops.existsSync ?? existsSync)(startScript)) {
    run.addAssertion("start_script.available", "blocked", "windows_start_script_missing");
    return;
  }
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!(ops.existsSync ?? existsSync)(powershell)) {
    run.addAssertion("start_script.windows_powershell_5_1", "blocked", "windows_powershell_5_1_unavailable");
    return;
  }
  const dataDir = join(tempRoot, "data-start-script");
  const child = (ops.spawn ?? spawn)(powershell, [
    "-NoProfile", "-File", startScript,
    "-NodePath", nodePath, "-DataDir", dataDir, "-Port", "0", "-MaxRunSeconds", "4",
    "-ScratchRoot", scratchRoot,
  ], {
    cwd: dirname(startScript),
    env: minimalEnv({ TEMP: join(tempRoot, "tmp"), TMP: join(tempRoot, "tmp") }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let servicePid = null;
  let finished = null;
  let failed = false;
  const lifecycle = observeOwnedChild(child, ops.lifecycle);
  const alive = ops.isProcessAlive ?? isProcessAlive;
  const wrapperDeadline = Date.now() + (ops.wrapperMs ?? LIMITS.startScriptMs);
  const waitWrapper = () => lifecycle.wait(Math.max(0, wrapperDeadline - Date.now()));
  const trackPid = () => {
    const match = /windows_start_service_pid=(\d+)/.exec(stdout);
    if (match) servicePid = Number(match[1]);
  };
  child.stdout?.on("data", (chunk) => {
    if (stdout.length < MAX_STREAM_BYTES) stdout += chunk.toString("utf8").slice(0, MAX_STREAM_BYTES - stdout.length);
    trackPid();
  });
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < MAX_STREAM_BYTES) stderr += chunk.toString("utf8").slice(0, MAX_STREAM_BYTES - stderr.length);
  });
  try {
    const port = await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new StageError("start_script_not_ready")), ops.readinessMs ?? LIMITS.readinessMs);
      const fail = (code) => { clearTimeout(timer); reject(new StageError(code)); };
      child.once("error", () => fail("start_script_spawn_failed"));
      child.once("exit", () => fail("start_script_exited_before_ready"));
      child.stdout?.on("data", () => {
        const match = /127\.0\.0\.1:(\d+)\//.exec(stdout);
        if (match) { clearTimeout(timer); done(Number(match[1])); }
      });
    });
    const probe = await (ops.fetchJson ?? fetchJson)(`http://127.0.0.1:${port}/api/account-sets`);
    run.assert("start_script.http_empty", probe.status === 200 && Array.isArray(probe.json) && probe.json.length === 0 && !lifecycle.exited && !lifecycle.closed, { code: "start_script_http_failed", details: { status: probe.status } });
    finished = await waitWrapper();
    run.assert("start_script.bounded_exit", finished?.code === 124, { code: "start_script_exit_not_bounded", details: { exitCode: finished?.code ?? null } });
    run.assert("start_script.service_pid_tracked", servicePid !== null, { code: "service_pid_missing" });
    run.assert("start_script.data_created", (ops.existsSync ?? existsSync)(join(dataDir, "workbench.db")), { code: "start_script_data_missing" });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // First allow the launcher its bounded natural shutdown so its .NET owned service
    // handle can run finally. Never guess-kill the service by its printed PID.
    let cleanupError = null;
    try {
      if (!lifecycle.closed) await waitWrapper();
      if (!lifecycle.closed) await lifecycle.stop();
    } catch (error) {
      cleanupError = error;
      run.recordResidual({ kind: "powershell_wrapper", label: "start-script", pid: child.pid ?? null, reason: "close_unknown", exited: lifecycle.exited, closed: lifecycle.closed, spawnError: lifecycle.spawnError?.code ?? null });
      run.addAssertion("start_script.wrapper_reclaimed", "fail", "wrapper_not_reclaimed");
    }
    run.note("start_script.wrapper_close", lifecycle.closed ? "reclaimed" : "unknown", {
      exited: lifecycle.exited, closed: lifecycle.closed, exitCode: lifecycle.info?.code ?? null,
      signal: lifecycle.info?.signal ?? null, spawnError: lifecycle.spawnError?.code ?? null,
    });
    trackPid();
    // ESRCH is absence only, never PID identity. Missing PID after a launched wrapper
    // is unknown; spawn failure before execution is the sole no-service case.
    let serviceUnknown = servicePid === null && !lifecycle.spawnError;
    if (servicePid !== null) {
      for (let attempt = 0; attempt < 20 && alive(servicePid); attempt += 1) await (ops.delay ?? delay)(100);
      serviceUnknown = alive(servicePid);
    }
    if (serviceUnknown) {
      run.recordResidual({ kind: "service", label: "start-script", pid: servicePid, reason: "identity_unverified" });
      run.addAssertion("start_script.service_identity_unverified", "fail", "service_identity_unverified");
      cleanupError ??= new StageError("service_identity_unverified");
    }
    run.note("start_script.service_stop", serviceUnknown ? "unknown" : (servicePid === null ? "spawn_failed_no_service" : "not_alive_at_check"));
    run.log("start-script", stdout, stderr);
    if (cleanupError) throw cleanupError;
    if (!failed && (!lifecycle.closed || lifecycle.info?.code !== 124)) throw new StageError("start_script_exit_not_bounded");
  }
}

async function stabilitySequential(run, { nodePath, workbenchDir, dataDir, tempRoot, setId }) {
  const started = Date.now();
  const results = [];
  for (let index = 1; index <= 10; index += 1) {
    if (Date.now() - started > LIMITS.stabilityMs) throw new StageError("stability_time_budget_exceeded", { details: { completed: index - 1 } });
    const server = await startServer(run, { nodePath, workbenchDir, dataDir, tempRoot, label: `sequential-${index}` });
    try {
      const report = await server.get(`/api/account-sets/${setId}/reports/trial-balance/export-data?period=2026-02`);
      const bank = report.json?.data?.lines?.find((line) => line.code === "1002");
      const batch = await server.get(`/api/import/batches/${FEB_BATCH}`);
      results.push({ index, bank: bank?.closing_debit ?? null, batch: batch.json?.batch?.status ?? null });
      if (!moneyEqual(bank?.closing_debit, 61300) || batch.json?.batch?.status !== "completed") {
        throw new StageError("sequential_start_data_lost", { details: { index } });
      }
    } finally {
      await server.stop();
    }
  }
  run.assert("stability.sequential_10", results.length === 10 && results.every((item) => moneyEqual(item.bank, 61300) && item.batch === "completed"), { code: "sequential_start_failed" });
  run.note("stability.sequential_duration", "completed", { iterations: results.length, durationMs: Date.now() - started });
}

async function stabilityParallel(run, { nodePath, workbenchDir, tempRoot }) {
  const dirs = [join(tempRoot, "data-parallel-a"), join(tempRoot, "data-parallel-b")];
  const sources = [
    { system: "local-book", enterpriseKey: "91350000WINPARALLELAX", enterpriseName: "并行 A 公司" },
    { system: "local-book", enterpriseKey: "91350000WINPARALLELBX", enterpriseName: "并行 B 公司" },
  ];
  const amounts = [61000, 62000];
  // 用 allSettled 收齐**所有**启动结果：一台失败不能把另一台已成功启动的服务丢在后台。
  const settled = await Promise.allSettled(dirs.map((dataDir, index) => startServer(run, { nodePath, workbenchDir, dataDir, tempRoot, label: `parallel-${index === 0 ? "a" : "b"}` })));
  const servers = [];
  const startFailures = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") servers.push(outcome.value);
    else startFailures.push(outcome.reason);
  }
  /** 回收本阶段自己启动的服务句柄：有界；杀不掉由 stop() 登记残留并让总结果非零。 */
  const stopAll = async () => {
    const stops = await Promise.allSettled(servers.map((server) => server.stop()));
    for (const item of stops) {
      if (item.status === "rejected") run.addAssertion("stability.parallel_stop", "fail", "service_stop_failed");
    }
    if (stops.some((item) => item.status === "rejected")) throw new StageError("service_stop_failed");
  };
  if (startFailures.length > 0) {
    // 先回收已启动的自有句柄，再如实抛首个启动失败。
    await stopAll();
    const first = startFailures[0];
    if (first instanceof StageError) throw first;
    throw new StageError("parallel_start_failed", { details: { started: servers.length, failed: startFailures.length } });
  }
  try {
    for (let index = 0; index < 2; index += 1) {
      const result = await servers[index].post("/api/import/incremental", {
        batchId: `PARALLEL-${index === 0 ? "A" : "B"}`,
        source: sources[index],
        payload: {
          account_set: { ...META, name: sources[index].enterpriseName },
          opening_balances: [{ code: "1002", debit: amounts[index], credit: 0 }, { code: "3001", debit: 0, credit: amounts[index] }],
          vouchers: [],
        },
        dryRun: false,
      });
      if (result.status !== 201) throw new StageError("parallel_import_failed", { details: { index, status: result.status } });
    }
    for (let index = 0; index < 2; index += 1) {
      const sets = await servers[index].get("/api/account-sets");
      const report = await servers[index].get("/api/account-sets/1/reports/trial-balance/export-data?period=2026-01");
      const bank = report.json?.data?.lines?.find((line) => line.code === "1002");
      const forbiddenBatch = await servers[index].get(`/api/import/batches/PARALLEL-${index === 0 ? "B" : "A"}`);
      run.assert(`stability.parallel_${index === 0 ? "a" : "b"}_isolated`, sets.status === 200 && sets.json?.length === 1 && sets.json[0].name === sources[index].enterpriseName && moneyEqual(bank?.closing_debit, amounts[index]) && forbiddenBatch.status === 404, { code: "parallel_data_leak", details: { index, sets: sets.json?.length ?? null, bank: bank?.closing_debit ?? null, forbiddenBatchStatus: forbiddenBatch.status } });
    }
  } finally {
    await stopAll();
  }
}

// ------------------------------------------------------------------ W2 契约占位

/**
 * W1 不实现 v(n)→v(n+1) 迁移 / 回退演练：当前没有真实版本配对与上游契约。
 * 命令形态保留，但一律 blocked 且**不产生业务副作用**（不建 DB、不迁移、不装依赖）。
 * 任何用户提供的 `--schema-pair` 都不得解除这个状态。
 */
function w2ContractPending(options) {
  return new StageError("w2_contract_pending", {
    blocked: true,
    details: {
      note: "W2 需要上游版本契约与已登记的真实版本配对；W1 不实现通用升级/降级链。",
      schemaPairAccepted: false,
      schemaPairProvided: Boolean(options.schemaPair),
      businessDbTouched: false,
      dependenciesInstalled: false,
      migrationsRun: false,
    },
  });
}

// ------------------------------------------------------------------ 结果 / 阶段

function makeRun(outDir) {
  return {
    outDir,
    stages: [],
    assertions: [],
    warnings: [],
    notes: [],
    residual: [],
    failed: false,
    logs: new Map(),
    seq: 0,
    startedAt: nowIso(),
    current: null,
    addAssertion(id, status, code, details = null) {
      const entry = { id, status, code, details };
      this.assertions.push(entry);
      if (status === "warn") this.warnings.push({ code, id, details });
      // 任一 fail 断言都让总结果非零，不被后续成功掩盖。
      if (status === "fail") this.failed = true;
      return entry;
    },
    assert(id, condition, options = {}) {
      if (condition) return this.addAssertion(id, "pass", null, options.details ?? null);
      const error = new StageError(options.code ?? "assertion_failed", { details: options.details ?? null });
      this.addAssertion(id, "fail", error.code, error.details);
      throw error;
    },
    note(id, value, details = null) {
      this.notes.push({ id, value, details });
    },
    recordResidual(details) {
      this.residual.push({ ...details });
      this.note("process.residual", "not_reclaimed", details);
    },
    log(label, stdout, stderr) {
      if (!stdout && !stderr) return;
      const safe = String(label).replace(/[^A-Za-z0-9_.-]/g, "_");
      this.logs.set(safe, `--- stdout ---\n${stdout ?? ""}\n--- stderr ---\n${stderr ?? ""}\n`);
      writeFileSync(join(this.outDir, "logs", `${safe}.log`), this.logs.get(safe), "utf8");
    },
    snapshot(status, code, error) {
      return {
        tool: TOOL,
        schemaVersion: TOOL_SCHEMA_VERSION,
        phase: this.phase ?? null,
        ok: status === "ok",
        status,
        code,
        startedAt: this.startedAt,
        finishedAt: nowIso(),
        runtime: { node: process.versions.node, platform: process.platform, arch: process.arch, testedNode: TESTED_NODE_VERSION, qualifiedScope: { node: TESTED_NODE_VERSION, platform: "win32", arch: "x64" } },
        options: this.publicOptions ?? {},
        stages: this.stages,
        assertions: this.assertions,
        warnings: this.warnings,
        notes: this.notes,
        error: error ? { code: error.code ?? "failed", blocked: error.blocked === true, details: error.details ?? null } : null,
        cleanup: this.cleanup ?? null,
        evidence: { resultFile: "windows-delivery-result.json", logsDir: "logs", artifactsDir: "artifacts" },
      };
    },
    write(status, code, error) {
      jsonWrite(join(this.outDir, "windows-delivery-result.json"), this.snapshot(status, code, error));
    },
    async stage(name, fn) {
      this.seq += 1;
      const budgetMs = STAGE_BUDGET_MS[name] ?? LIMITS.suiteMs;
      const stage = { name, seq: this.seq, status: "running", code: null, budgetMs, startedAt: nowIso(), endedAt: null, durationMs: null, pid: process.pid, details: null };
      this.stages.push(stage);
      this.current = stage;
      const started = Date.now();
      try {
        const details = await fn(stage);
        const durationMs = Date.now() - started;
        // 阶段耗时后验：fn 已结束，这里只是把「跑了多久」与预算对比，不具备中途中断能力。
        if (durationMs > budgetMs) {
          throw new StageError("stage_time_budget_exceeded", { details: { durationMs, budgetMs } });
        }
        stage.status = "pass";
        stage.details = details ?? null;
        return details;
      } catch (error) {
        const stageError = error instanceof StageError ? error : new StageError("stage_failed");
        stage.status = stageError.blocked ? "blocked" : "fail";
        stage.code = stageError.code;
        stage.details = stageError.details ?? null;
        throw stageError;
      } finally {
        stage.endedAt = nowIso();
        stage.durationMs = Date.now() - started;
        this.current = null;
      }
    },
  };
}

// ------------------------------------------------------------------ 主流程

/** 随包窗口工具清单；最终候选包必须完整。 */
const PACKAGED_TOOLING = Object.freeze({
  runtimeCheck: "scripts/windows-runtime-check.mjs",
  startScript: "scripts/windows-start.ps1",
  deliveryCheck: "scripts/windows-delivery-check.mjs",
  test: "test/windows-delivery.test.mjs",
});

/**
 * 工具来源选择：冷拷贝里有哪份就用哪份（不能用开发 worktree 脚本冒充随包）；
 * 开发 e86 冷源缺 W1 文件时才显式退成 external_tooling，并记录为阶段证据。
 */
function selectTooling(workbenchDir) {
  const external = {
    runtimeCheck: join(SCRIPT_DIR, "windows-runtime-check.mjs"),
    startScript: join(SCRIPT_DIR, "windows-start.ps1"),
    deliveryCheck: join(SCRIPT_DIR, "windows-delivery-check.mjs"),
    test: join(WORKBENCH_ROOT, "test", "windows-delivery.test.mjs"),
  };
  const chosen = {};
  const sources = {};
  const missing = [];
  for (const [key, rel] of Object.entries(PACKAGED_TOOLING)) {
    const file = join(workbenchDir, rel.split("/").join(sep));
    if (existsSync(file) && statSync(file).isFile()) {
      chosen[key] = file;
      sources[key] = `release_cold_copy:${rel}`;
    } else {
      chosen[key] = external[key];
      sources[key] = `external_tooling:${basename(external[key])}`;
      missing.push(rel);
    }
  }
  const mode = missing.length === 0
    ? "release_cold_copy"
    : missing.length === Object.keys(PACKAGED_TOOLING).length ? "external_tooling" : "partial_release_tooling";
  const digest = {};
  for (const [key, file] of Object.entries(chosen)) {
    digest[key] = { source: sources[key], sha256: existsSync(file) ? sha256File(file) : null };
  }
  return { mode, missing, digest, ...chosen };
}

async function installStart(run, options, paths) {
  run.phase = "install-start";
  const inspected = await run.stage("preflight", async () => {
    // 发布扫描只排除**明确已知**的本任务专属 scratch 路径（本工具固定 base + 本次运行刚建的根）。
    const release = inspectRelease(options.release, { excludeScratch: [paths.scratch.base, paths.scratch.root] });
    // 固定 lock 的来源/完整性先静态校验；不把 npm 配置的 registry 当成能约束 lock URL 的保证。
    const lockSources = validateLockSources(join(release.workbenchDir, "package-lock.json"));
    run.assert("preflight.lock_sources", lockSources.ok, { code: "lock_source_not_allowed", details: { checked: lockSources.checked, violations: lockSources.violations } });
    run.note("preflight.lock_sources", "allowed_public_registries_only", { checked: lockSources.checked, allowedHosts: lockSources.allowedHosts });
    const nodeVersion = await spawnChecked(run, "preflight-node-version", options.node, ["--version"], { env: minimalEnv({ TEMP: join(paths.tempRoot, "tmp"), TMP: join(paths.tempRoot, "tmp") }), timeoutMs: LIMITS.suiteMs });
    run.assert("preflight.node_binary", nodeVersion.code === 0 && /^v24\.15\.0/.test(nodeVersion.stdout.trim()), { code: "node_binary_unqualified", details: { version: nodeVersion.stdout.trim() || null } });
    if (release.engines !== "24.15.0") {
      run.addAssertion("preflight.engines_declaration", "warn", "engines_declaration_too_wide", { declared: release.engines, testedNode: TESTED_NODE_VERSION, note: "只有 24.15.0 做过资格验证；24.15.x 的其它 patch 未实测。" });
    } else {
      run.addAssertion("preflight.engines_declaration", "pass", null, { declared: release.engines });
    }
    if (release.excludedScratch.length > 0) run.note("preflight.scratch_excluded", "known_task_scratch_dirs_skipped", { relative: release.excludedScratch });
    const copied = copyReleaseWhitelist(release, join(paths.tempRoot, "release-old"));
    const copiedDestRegistered = trackExistingPath(paths.scratch, copied.destRoot, "cold_copy_root");
    const copiedWorkbenchRegistered = trackExistingPath(paths.scratch, copied.workbenchDir, "cold_copy_workbench");
    run.assert("preflight.cold_copy_registered", Boolean(copiedDestRegistered) && Boolean(copiedWorkbenchRegistered), { code: "cleanup_refused:cold_copy_not_registered" });
    run.assert("preflight.cold_copy_clean", !existsSync(join(copied.workbenchDir, "node_modules")) && !existsSync(join(copied.workbenchDir, "data")), { code: "cold_copy_not_clean" });
    run.assert("preflight.cold_copy_digest", copied.digest === release.digest, { code: "cold_copy_digest_mismatch" });
    run.note("preflight.source", "release_inspected", { lockSha256: release.lockSha256, digest: release.digest, engines: release.engines, files: release.files });
    const tooling = selectTooling(copied.workbenchDir);
    run.note("preflight.tooling_source", tooling.mode, { missing: tooling.missing, files: tooling.digest });
    if (options.requirePackagedTooling) {
      run.assert("preflight.tooling_packaged", tooling.mode === "release_cold_copy", { code: "packaged_tooling_incomplete", details: { missing: tooling.missing } });
    }
    run.note("preflight.cold_copy", "copied", { files: copied.copied.length, optionalMissing: copied.optionalMissing, path: "release-old" });
    // 后续阶段一律使用这里选定的工具：随包有就用随包那份。
    paths.runtimeCheckScript = tooling.runtimeCheck;
    paths.startScript = tooling.startScript;
    return { release, copied, nodeVersion: nodeVersion.stdout.trim(), tooling: tooling.mode };
  });

  const runtime = await run.stage("runtime", async () => {
    const check = await spawnChecked(run, "runtime-check", options.node, [paths.runtimeCheckScript, "--json", "--data-dir", join(paths.tempRoot, "数据 交付", "data-old"), "--scratch-root", paths.tempRoot], {
      cwd: dirname(paths.runtimeCheckScript),
      env: minimalEnv({ TEMP: join(paths.tempRoot, "tmp"), TMP: join(paths.tempRoot, "tmp") }),
      timeoutMs: LIMITS.suiteMs,
    });
    run.log("runtime-check", check.stdout, check.stderr);
    let payload = null;
    try { payload = JSON.parse(check.stdout.trim()); } catch { payload = null; }
    run.assert("runtime.precheck_ok", check.code === 0 && payload?.ok === true && payload?.runtime?.qualified === true, { code: payload?.code ?? "runtime_precheck_failed", details: { exitCode: check.code } });
    run.assert("runtime.sqlite_features", payload?.features?.sqliteModule === true && payload?.features?.isTransaction === true && payload?.features?.readOnly === true && payload?.features?.busyTimeout === true && payload?.features?.fs === true, { code: "runtime_feature_missing" });
    run.assert("runtime.probe_isolated_and_bounded", payload?.limits?.probeIsolatedProcess === true && payload?.limits?.probeDeadlineMs > 0 && payload?.limits?.probeTimedOut === false, { code: "runtime_probe_not_bounded", details: { limits: payload?.limits ?? null } });
    run.assert("runtime.no_business_db_created", !existsSync(join(paths.tempRoot, "数据 交付", "data-old")), { code: "precheck_created_data_dir" });
    run.assert("runtime.probe_cleaned", payload?.cleanup?.completed === true, { code: "precheck_cleanup_incomplete", details: { cleanup: payload?.cleanup ?? null } });
    run.addAssertion("runtime.engines_declaration_flagged", payload?.warnings?.some((warning) => warning.code === "engines_declaration_too_wide") ? "pass" : "warn", payload?.warnings?.some((warning) => warning.code === "engines_declaration_too_wide") ? null : "engines_declaration_not_flagged");
    return { node: payload?.runtime ?? null, fonts: payload?.fonts?.status ?? null };
  });

  const dependencies = await run.stage("dependencies", async () => {
    const installed = await installDependencies(run, {
      npm: paths.npm,
      nodePath: options.node,
      copied: inspected.copied,
      cache: options.cache,
      tempRoot: paths.tempRoot,
      stageName: "dependencies",
      scratch: paths.scratch,
    });
    return { ...installed, workbenchDir: inspected.copied.workbenchDir, copied: inspected.copied };
  });

  // 数据目录带中文与空格，用来覆盖非 ASCII + 空格路径（发布副本 / data / 备份都在专属根下）。
  const dataDir = join(paths.tempRoot, "数据 交付", "data-old");
  const server = await run.stage("startup", async () => {
    const handle = await startServer(run, { nodePath: options.node, workbenchDir: dependencies.workbenchDir, dataDir, tempRoot: paths.tempRoot, label: "startup" });
    try {
      const sets = await handle.get("/api/account-sets");
      run.assert("startup.empty_account_sets", sets.status === 200 && Array.isArray(sets.json) && sets.json.length === 0, { code: "fresh_data_not_empty", details: { status: sets.status } });
      const index = await handle.get("/");
      run.assert("startup.static_index", index.status === 200 && /<html/i.test(index.text), { code: "static_index_failed", details: { status: index.status } });
      const app = await handle.get("/app.js");
      run.assert("startup.static_js", app.status === 200 && /javascript/.test(app.headers.get("content-type") ?? ""), { code: "static_js_failed", details: { status: app.status } });
      const css = await handle.get("/styles.css");
      run.assert("startup.static_css", css.status === 200 && /text\/css/.test(css.headers.get("content-type") ?? ""), { code: "static_css_failed", details: { status: css.status } });
      run.assert("startup.data_isolated", existsSync(join(dataDir, "workbench.db")), { code: "data_dir_not_created" });
      run.assert("startup.old_port_untouched", !handle.requested.some((path) => path.includes("tax")), { code: "unexpected_tax_call", details: { port: handle.port } });
      run.note("startup.network", "loopback_only", { port: handle.port, requested: [...new Set(handle.requested)] });
      run.addAssertion("startup.tax_calls_zero", "pass", null, { calls: handle.requested.filter((path) => path.includes("tax")).length });
      return { handle, dataDir };
    } catch (error) {
      await handle.stop();
      throw error;
    }
  });

  let business;
  let office = null;
  try {
    business = await run.stage("import", async () => {
      const imported = await importDemoBusiness(run, server.handle);
      await assertBatchTrace(run, server.handle, imported.setId, "import");
      return imported;
    });

    await run.stage("reports", async () => {
      const responses = new Map();
      for (const kind of ["balance-sheet", "income-statement", "cash-flow-statement", "trial-balance", "ledger"]) {
        const query = kind === "ledger" ? "&code=1002" : "";
        const response = await server.handle.get(`/api/account-sets/${business.setId}/reports/${kind}/export?period=2026-02${query === "" ? "" : query}`);
        // ledger requires code, so build the query without a leading separator issue.
        responses.set(kind, response);
        run.assert(`reports.export.${kind}.status`, response.status === 200, { code: "csv_export_failed", details: { kind, status: response.status } });
      }
      assertCsvReports(run, responses);
      const dto = await assertDtoReports(run, server.handle, business.setId);
      return { dto };
    });

    // Restart on the same data directory before Office/backups; this proves persistence.
    await run.stage("restart", async () => {
      await server.handle.stop();
      const restarted = await startServer(run, { nodePath: options.node, workbenchDir: dependencies.workbenchDir, dataDir, tempRoot: paths.tempRoot, label: "restart" });
      try {
        const sets = await restarted.get("/api/account-sets");
        run.assert("restart.account_set_persisted", sets.status === 200 && sets.json?.length === 1 && sets.json[0].id === business.setId, { code: "restart_lost_account_set" });
        const replay = await restarted.post("/api/import/incremental", { batchId: JAN_BATCH, source: SOURCE, payload: payloadJan(), dryRun: false });
        run.assert("restart.batch_recognized", replay.status === 200 && replay.json?.status === "idempotent_replay" && replay.json?.created?.vouchersCreated === 0, { code: "restart_batch_not_recognized", details: { status: replay.status } });
        await assertBatchTrace(run, restarted, business.setId, "restart");
        await assertAmounts(run, restarted, "restart", business.setId);
      } finally {
        server.handle = restarted;
      }
    });

    office = await run.stage("office", async () => {
      const map = new Map();
      for (const kind of ["balance-sheet", "income-statement", "cash-flow-statement", "trial-balance", "ledger"]) {
        const query = kind === "ledger" ? "&code=1002" : "";
        const response = await server.handle.get(dtoFor(kind, query));
        run.assert(`office.dto.${kind}`, response.status === 200 && response.json?.kind === kind, { code: "dto_export_failed", details: { kind, status: response.status } });
        map.set(kind, response.json);
      }
      const rendered = await runOfficeStage(run, {
        nodePath: options.node,
        workbenchDir: dependencies.workbenchDir,
        tempRoot: paths.tempRoot,
        outDir: run.outDir,
        dto: map,
        font: options.font,
        fontFamily: options.fontFamily,
        label: "office",
        scratch: paths.scratch,
      });
      return { rendered };
    });

    await run.stage("failure-paths", async () => {
      await portConflictProbe(run, { nodePath: options.node, workbenchDir: dependencies.workbenchDir, tempRoot: paths.tempRoot });
      await illegalDirectoryProbe(run, { nodePath: options.node, workbenchDir: dependencies.workbenchDir, tempRoot: paths.tempRoot, runtimeCheckScript: paths.runtimeCheckScript, scratchRoot: paths.tempRoot });
      await startScriptProbe(run, { tempRoot: paths.tempRoot, nodePath: options.node, startScript: paths.startScript, scratchRoot: paths.tempRoot });
    });

    await run.stage("backup-restore", async () => {
      const drill = await backupDrill(run, {
        nodePath: options.node,
        workbenchDir: dependencies.workbenchDir,
        tempRoot: paths.tempRoot,
        dataDir,
        release: inspected.release,
        outDir: run.outDir,
      });
      return drill;
    });

    await server.handle.stop();
    await run.stage("stability", async () => {
      await stabilitySequential(run, { nodePath: options.node, workbenchDir: dependencies.workbenchDir, dataDir, tempRoot: paths.tempRoot, setId: business.setId });
      await stabilityParallel(run, { nodePath: options.node, workbenchDir: dependencies.workbenchDir, tempRoot: paths.tempRoot });
    });
  } catch (error) {
    try { await server.handle.stop(); } catch { /* ignore */ }
    throw error;
  }

  run.addAssertion("skipped.old_node_binary", "skipped", "old_node_binary_unavailable");
  run.addAssertion("skipped.other_arch", "skipped", "other_arch_unverified");
  run.addAssertion("skipped.clean_os_install", "skipped", "clean_os_install_not_claimed");
  run.addAssertion("skipped.offline_package_complete", "skipped", "offline_package_bundle_not_claimed");
  return { inspected, dependencies, business, office };
}

// ------------------------------------------------------------------ 入口

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${JSON.stringify({ tool: TOOL, command: "help", ok: true, usage: USAGE, phases: ["install-start", "upgrade-rollback"] }, null, 2)}\n`);
    return EXIT.ok;
  }
  if (parsed.error) {
    process.stdout.write(`${JSON.stringify({ tool: TOOL, command: null, ok: false, status: "rejected", code: parsed.error.code, details: parsed.error, usage: USAGE }, null, 2)}\n`);
    return EXIT.usage;
  }
  const options = parsed.options;
  // 路径守卫必须先于**任何 mkdir / 扫描 / 复制**（含 out 自身的创建）：拒绝时只写 stdout 并非零，
  // 不为了留日志先写一个未验证的 out。
  const invocation = auditInvocationPaths({ out: options.out, release: options.release, scratchRoot: options.scratchRoot });
  if (!invocation.ok) {
    process.stdout.write(`${JSON.stringify({ tool: TOOL, ok: false, status: "rejected", code: invocation.code, details: invocation.details ?? { reason: invocation.reason ?? null } }, null, 2)}\n`);
    return Number.isInteger(invocation.exitCode) ? invocation.exitCode : EXIT.usage;
  }
  let outDir;
  try {
    outDir = prepareOutDir(options.out);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ tool: TOOL, ok: false, status: "rejected", code: error.code ?? "out_invalid", details: error.details ?? null }, null, 2)}\n`);
    return EXIT.usage;
  }
  const run = makeRun(outDir);
  run.publicOptions = {
    phase: options.phase,
    release: "<release>",
    previousRelease: options.previousRelease ? "<previous-release>" : null,
    schemaPair: options.schemaPair ? "<schema-pair>" : null,
    scratchRoot: options.scratchRoot ? "<scratch-root>" : null,
    node: basename(options.node),
    npm: basename(options.npm ?? ""),
    cache: options.cache ? "<cache>" : null,
    out: "<out>",
    font: options.font ? "<explicit-font>" : null,
    keep: options.keep,
    requirePackagedTooling: options.requirePackagedTooling,
  };
  let scratch = null;
  let status = "ok";
  let code = null;
  let failure = null;
  try {
    if (options.phase === "upgrade-rollback") {
      // W1 契约占位：在创建任何临时根 / 业务目录之前就地 blocked，无业务副作用。
      run.phase = "upgrade-rollback";
      run.cleanup = { attempted: false, completed: false, reason: "no_scratch_created", retained: false, manifestVerified: false, pathEchoed: false };
      failure = w2ContractPending(options);
      status = "blocked";
      code = failure.code;
    } else {
      // 先校验 npm 入口，避免因参数错误白建临时根。
      const npm = resolveNpm(options.npm ?? "", options.node);
      // 专属临时根：默认 <workbench>/tmp/windows-delivery；--scratch-root 必须是调用者显式授权、
      // 专用于本次任务的绝对路径（守卫会先校验原始入参就是绝对路径，再逐级核验祖先到卷根）。
      scratch = createScratchRecord({ basePath: options.scratchRoot, label: SCRATCH_LABEL });
      const paths = {
        tempRoot: scratch.root,
        scratch,
        runtimeCheckScript: join(SCRIPT_DIR, "windows-runtime-check.mjs"),
        startScript: join(SCRIPT_DIR, "windows-start.ps1"),
        npm,
      };
      run.note("environment.temp_root", "workspace_dedicated_random_root", { defaultUnderWorkbench: !options.scratchRoot, explicitScratchRootAuthorized: Boolean(options.scratchRoot), manifest: true, manifestSchema: 2, systemTempUsed: false, nonAsciiAndSpaceDataPath: true });
      await installStart(run, options, paths);
    }
  } catch (error) {
    // 预期的阶段结果（StageError，含 blocked / fail）不写成 internal-error；只留意外异常。
    if (!(error instanceof StageError)) {
      try {
        const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
        if (outDir) writeFileSync(join(outDir, "logs", "internal-error.log"), detail, "utf8");
      } catch { /* ignore */ }
    }
    failure = error instanceof StageError
      ? error
      : typeof error?.code === "string" && /^scratch_/.test(error.code)
        ? new StageError(error.code, { details: error.details ?? null })
        : new StageError("internal_error");
    status = failure.blocked ? "blocked" : "failed";
    code = failure.code;
  } finally {
    // 任何 fail 断言 / 未回收进程 / 清理失败都必须让总结果非零，不被后续成功掩盖。
    if (status === "ok" && run.failed) {
      status = "failed";
      code = code ?? "assertion_failed";
    }
    if (status === "ok" && run.residual.length > 0) {
      status = "failed";
      code = "child_process_unreclaimed";
    }
    if (scratch) {
      // manifestVerified 只能反映**实际核验结果**：未尝试 / --keep / 失败保留都必须为 false。
      if (status === "ok" && !options.keep) {
        const removal = removeScratchRecord(scratch);
        run.cleanup = {
          attempted: true,
          completed: removal.ok === true,
          reason: removal.reason ?? null,
          retained: removal.ok !== true,
          manifestVerified: removal.manifestVerified === true,
          pathEchoed: false,
        };
        if (!removal.ok) {
          const cleanupCode = String(removal.reason ?? "").startsWith("cleanup_refused") ? "cleanup_refused" : "cleanup_failed";
          status = "failed";
          code = cleanupCode;
          failure = failure ?? new StageError(cleanupCode, { details: { reason: removal.reason ?? null } });
        }
      } else {
        const reason = status !== "ok"
          ? (status === "blocked" ? "blocked_residual_kept" : "stage_failed_residual_kept")
          : options.keep ? "keep_requested" : "cleanup_not_allowed";
        run.cleanup = { attempted: false, completed: false, reason, retained: true, manifestVerified: false, pathEchoed: false };
        run.note("cleanup.retained", "scratch_root_retained", { reason, manifestVerified: false, note: "未核验也未删除：目录保留供诊断，不按名称/前缀事后清理。" });
      }
    }
    run.write(status, code, failure);
    process.stdout.write(`${JSON.stringify(run.snapshot(status, code, failure), null, 2)}\n`);
  }
  if (status === "ok") return EXIT.ok;
  if (status === "blocked") return EXIT.blocked;
  return EXIT.failed;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
const self = resolve(fileURLToPath(import.meta.url));
if (entry && entry.toLowerCase() === self.toLowerCase()) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch(() => {
      // 总结果写入失败等极端情况：仍以非零退出，不假报成功。
      process.stderr.write("windows_delivery_check_error: finalize_failed\n");
      process.exitCode = EXIT.failed;
    });
}
