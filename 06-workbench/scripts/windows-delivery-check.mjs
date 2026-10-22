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
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createScratchRecord as createGuardedScratchRecord,
  defaultScratchBase,
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
    child.once("close", (code, signal) => finish({ code: code ?? null, signal: signal ?? null, pid: child.pid ?? null }));

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

/** spawnCaptured + 把「未回收 / 未启动」如实记为失败断言，并登记残留进程。 */
async function spawnChecked(run, label, command, args, options = {}) {
  const result = await spawnCaptured(command, args, options);
  if (result.unreclaimed || result.hardDeadline) {
    run.recordResidual({ kind: "child", label, pid: result.pid ?? null });
    run.addAssertion(`${label}.child_reclaimed`, "fail", "child_process_unreclaimed", { pid: result.pid ?? null });
  }
  if (result.spawnError) {
    run.addAssertion(`${label}.spawn`, "fail", result.spawnError, { label });
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

// ------------------------------------------------------------------ 发布检查 / 冷拷贝

/**
 * 发布清洁度扫描。
 * 只跳过**明确已知**的专属 scratch 目录：`<workbench>/tmp/windows-delivery`（文档固定的
 * 本任务专属根）与调用者用 `excludeScratch` 显式传入的绝对路径（例如本次运行刚创建的根）。
 * 不再扫描其它现存 run 的 manifest 去“推断整个 base 的拥有权”；不含这些已知路径的
 * `tmp` / 其它目录仍按 forbidden 拒绝。
 */
export function inspectRelease(releasePath, options = {}) {
  const root = resolve(releasePath);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new StageError("release_not_directory");
  const packageAtRoot = join(root, "package.json");
  const workbenchDir = existsSync(packageAtRoot) ? root : join(root, "06-workbench");
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

export function copyReleaseWhitelist(inspected, destRoot) {
  if (existsSync(destRoot)) throw new StageError("copy_destination_exists");
  mkdirSync(destRoot, { recursive: false });
  const destWorkbench = join(destRoot, "06-workbench");
  mkdirSync(destWorkbench);
  const copied = [];
  const optionalMissing = [];
  const copyFile = (rel) => {
    const source = join(inspected.workbenchDir, rel.split("/").join(sep));
    const dest = join(destWorkbench, rel.split("/").join(sep));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    copied.push(rel);
  };
  copyFile("package.json");
  copyFile("package-lock.json");
  const copyDir = (rel) => {
    const source = join(inspected.workbenchDir, rel);
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
    const source = join(inspected.workbenchDir, rel.split("/").join(sep));
    if (existsSync(source) && statSync(source).isFile()) copyFile(rel);
    else optionalMissing.push(rel);
  }
  const digest = digestTree(destWorkbench, ["server", "public", "package.json", "package-lock.json"]);
  if (digest !== inspected.digest) throw new StageError("cold_copy_digest_mismatch");
  return { destRoot, workbenchDir: destWorkbench, copied, optionalMissing, digest };
}

function prepareOutDir(outPath) {
  const out = resolve(outPath);
  if (existsSync(out)) {
    if (!statSync(out).isDirectory()) throw new StageError("out_not_directory");
    if (readdirSync(out).length > 0) throw new StageError("out_not_empty");
  } else {
    mkdirSync(out, { recursive: true });
  }
  mkdirSync(join(out, "logs"), { recursive: true });
  mkdirSync(join(out, "artifacts"), { recursive: true });
  return out;
}

// ------------------------------------------------------------------ npm

function resolveNpm(npmPath, nodePath) {
  if (!npmPath) throw new StageError("npm_not_found");
  const path = resolve(npmPath);
  if (!existsSync(path) || !statSync(path).isFile()) throw new StageError("npm_not_found");
  if (/\.m?js$/i.test(path)) return { command: nodePath, prefix: [path], mode: "node_js_entry" };
  const cli = join(dirname(path), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(cli) && statSync(cli).isFile()) return { command: nodePath, prefix: [cli], mode: "npm_cli_js" };
  // 未核实的 .cmd / .bat 不再拼 cmd.exe 命令线：句柄回收与引用歧义风险太大，直接拒绕。
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
  return { ...result, offline, cacheMiss: /ENOTCACHED|only-if-cached|EAI_AGAIN|ENETUNREACH|ECONNREFUSED/i.test(`${result.stdout}\n${result.stderr}`) };
}

async function installDependencies(run, { npm, nodePath, copied, cache, tempRoot, stageName, scratch }) {
  const workbenchDir = copied.workbenchDir;
  const lockBefore = sha256File(join(workbenchDir, "package-lock.json"));
  const offlineFirst = await npmCi(run, `${stageName}-offline`, { npm, nodePath, workbenchDir, cache, tempRoot, offline: true });
  run.log(`${stageName}-offline`, offlineFirst.stdout, offlineFirst.stderr);
  let networkUsed = false;
  let offlineProven = false;
  if (offlineFirst.code === 0) {
    offlineProven = true;
    run.note(`${stageName}.install_mode`, "offline_cache_hit");
  } else {
    run.note(`${stageName}.offline_first`, "dependency_cache_missing", { code: offlineFirst.code, cacheMiss: offlineFirst.cacheMiss });
    const online = await npmCi(run, `${stageName}-online`, { npm, nodePath, workbenchDir, cache, tempRoot, offline: false });
    run.log(`${stageName}-online`, online.stdout, online.stderr);
    if (online.code !== 0) throw new StageError("dependency_install_failed", { details: { exitCode: online.code, cacheMiss: offlineFirst.cacheMiss } });
    networkUsed = true;
    // 删除 node_modules 后证明同一专属缓存可完全离线重装。删除走唯一守卫：manifest 登记 +
    // 根内 + 完整祖先链 + realpath + 无重解析点核验；拒绝/失败就是非零阶段失败，不是 best-effort。
    const modules = join(workbenchDir, "node_modules");
    if (existsSync(modules)) {
      const registered = trackExistingPath(scratch, modules, "node_modules_reinstall");
      const removal = registered ? removeTrackedPath(scratch, modules) : { ok: false, reason: "cleanup_refused:target_not_registered" };
      run.assert(`${stageName}.node_modules_cleanup`, removal.ok, { code: removal.reason ?? "node_modules_cleanup_refused" });
    }
    const offlineSecond = await npmCi(run, `${stageName}-offline-after-online`, { npm, nodePath, workbenchDir, cache, tempRoot, offline: true });
    run.log(`${stageName}-offline-after-online`, offlineSecond.stdout, offlineSecond.stderr);
    if (offlineSecond.code !== 0) throw new StageError("dependency_offline_reinstall_failed", { details: { exitCode: offlineSecond.code } });
    offlineProven = true;
    run.note(`${stageName}.install_mode`, "online_download_then_offline_reinstall");
  }
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

async function startServer(run, { nodePath, workbenchDir, dataDir, tempRoot, port = 0, font, fontFamily, label }) {
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
  const child = spawn(nodePath, [join(workbenchDir, "server", "server.mjs")], {
    cwd: workbenchDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let ready = false;
  let exited = false;
  let exitInfo = null;
  let terminatePromise = null;
  const exitPromise = new Promise((resolvePromise) => {
    child.once("exit", (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      resolvePromise(exitInfo);
    });
  });
  /** 有界停止：先 SIGTERM，超时再 SIGKILL；仍不退出就登记残留并如实报失败。 */
  const terminate = (reason) => {
    if (terminatePromise) return terminatePromise;
    terminatePromise = (async () => {
      if (exited) return { exited: true, info: exitInfo, unreclaimed: false };
      try { child.kill(); } catch { /* ignore */ }
      let finished = await Promise.race([exitPromise, new Promise((resolveDelay) => setTimeout(() => resolveDelay(null), 10000))]);
      if (!finished) {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        finished = await Promise.race([exitPromise, new Promise((resolveDelay) => setTimeout(() => resolveDelay(null), KILL_GRACE_MS))]);
      }
      if (!finished) {
        run.recordResidual({ kind: "server", label, pid: child.pid ?? null, reason });
        run.addAssertion(`${label}.service_reclaimed`, "fail", "service_not_reclaimed", { pid: child.pid ?? null, reason });
        // 不把杀不掉的孩子留给父进程事件循环：断开管道并 unref，只保留如实残留记录。
        try { child.stdout?.destroy(); } catch { /* ignore */ }
        try { child.stderr?.destroy(); } catch { /* ignore */ }
        try { child.unref?.(); } catch { /* ignore */ }
        return { exited: false, info: exitInfo, unreclaimed: true };
      }
      return { exited: true, info: finished, unreclaimed: false };
    })();
    return terminatePromise;
  };
  const portPromise = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new StageError("server_not_ready_timeout")), LIMITS.readinessMs);
    child.once("error", () => { clearTimeout(timer); rejectPromise(new StageError("server_spawn_failed")); });
    child.once("exit", (code) => { clearTimeout(timer); rejectPromise(new StageError("server_exited_before_ready", { details: { exitCode: code } })); });
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_STREAM_BYTES) stdout += chunk.toString("utf8");
      const match = /127\.0\.0\.1:(\d+)\//.exec(stdout);
      if (match) { ready = true; clearTimeout(timer); resolvePromise(Number(match[1])); }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STREAM_BYTES) stderr += chunk.toString("utf8");
    });
  });
  let actualPort;
  try {
    actualPort = await portPromise;
  } catch (error) {
    await terminate("readiness_failed");
    run.log(`${label}-start-failure`, stdout, stderr);
    throw error;
  }
  const base = `http://127.0.0.1:${actualPort}`;
  const requested = [];
  const request = async (method, path, body) => {
    requested.push(path.split("?")[0]);
    return fetchJson(`${base}${path}`, { method, body });
  };
  // Confirm readiness with bounded HTTP; a printed port alone is not readiness.
  let lastError = null;
  const readyDeadline = Date.now() + LIMITS.readinessMs;
  while (Date.now() < readyDeadline) {
    try {
      const probe = await request("GET", "/api/account-sets");
      if (probe.status === 200) break;
      lastError = new StageError("server_not_ready_http", { details: { status: probe.status } });
    } catch (error) {
      lastError = new StageError("server_not_ready_http");
    }
    if (exited) { lastError = new StageError("server_exited_before_ready", { details: { exitCode: exitInfo?.code ?? null } }); break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!exited && lastError && Date.now() >= readyDeadline) {
    await terminate("http_readiness_failed");
    throw lastError;
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
      const result = await terminate("stop");
      return result.info;
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

async function runOfficeStage(run, { nodePath, workbenchDir, tempRoot, outDir, dto, font, fontFamily, label, scratch }) {
  const artifacts = join(outDir, "artifacts", "office");
  mkdirSync(artifacts, { recursive: true });
  const helperPath = join(workbenchDir, ".windows-delivery-office-helper.mjs");
  const writeHelper = () => {
    writeFileSync(helperPath, OFFICE_HELPER, "utf8");
    const real = trackExistingPath(scratch, helperPath, "office_helper");
    if (!real) run.addAssertion(`${label}.helper_registered`, "fail", "cleanup_refused:helper_not_registered", { file: basename(helperPath) });
  };
  // 辅助脚本是本进程写入专属冷拷贝根内的精确文件：删除走同一守卫（manifest + 完整祖先链 + realpath）。
  const removeHelper = () => {
    if (!existsSync(helperPath)) return;
    const removal = removeTrackedPath(scratch, helperPath);
    if (!removal.ok) run.addAssertion(`${label}.helper_cleanup`, "fail", removal.reason, { file: basename(helperPath) });
    else if (removal.manifestRefreshed === false) run.addAssertion(`${label}.helper_manifest_refresh`, "fail", "cleanup_failed:manifest_refresh_failed", { file: basename(helperPath) });
  };
  writeHelper();
  const results = new Map();
  try {
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
  } finally {
    removeHelper();
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
  writeHelper();
  try {
    const probe = await spawnChecked(run, "office-missing-font", nodePath, [helperPath, `dto=${join(artifacts, "trial-balance.dto.json")}`, `outdir=${join(artifacts, "missing-font")}`], {
      cwd: workbenchDir,
      env: minimalEnv({ TEMP: join(tempRoot, "tmp"), TMP: join(tempRoot, "tmp"), REPORT_PDF_FONT: join(tempRoot, "no-such-font-file.ttf") }),
      timeoutMs: LIMITS.officeMs,
    });
    let parsed = null;
    try { parsed = JSON.parse(probe.stdout.trim()); } catch { parsed = null; }
    run.assert("failures.missing_font_reported", parsed?.pdfError === "pdf_font_unavailable", { code: "pdf_font_error_not_reported", details: { pdfError: parsed?.pdfError ?? null } });
    run.assert("failures.missing_font_xlsx_still_usable", parsed?.xlsx?.bytes > 0, { code: "xlsx_blocked_by_font" });
  } finally {
    removeHelper();
  }
  return results;
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
  if (result.unreclaimed || result.hardDeadline) {
    run.recordResidual({ kind: "child", label, pid: result.pid ?? null });
    run.addAssertion(`${label}.child_reclaimed`, "fail", "child_process_unreclaimed", { pid: result.pid ?? null });
    return { status: "unavailable", reason: "python_pdf_tool_unreclaimed" };
  }
  if (result.spawnError || result.code !== 0) return { status: "unavailable", reason: "python_pdf_tool_unavailable" };
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

async function startScriptProbe(run, { tempRoot, nodePath, startScript, scratchRoot }) {
  if (!existsSync(startScript)) {
    run.addAssertion("start_script.available", "blocked", "windows_start_script_missing");
    return;
  }
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(powershell)) {
    run.addAssertion("start_script.windows_powershell_5_1", "blocked", "windows_powershell_5_1_unavailable");
    return;
  }
  const dataDir = join(tempRoot, "data-start-script");
  const child = spawn(powershell, [
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
  let port = null;
  let exited = false;
  const exitPromise = new Promise((resolvePromise) => child.once("exit", (code, signal) => { exited = true; resolvePromise({ code, signal }); }));
  const trackPid = () => {
    const match = /windows_start_service_pid=(\d+)/.exec(stdout);
    if (match && servicePid === null) servicePid = Number(match[1]);
  };
  child.stdout.on("data", (chunk) => {
    if (stdout.length < MAX_STREAM_BYTES) stdout += chunk.toString("utf8").slice(0, MAX_STREAM_BYTES);
    trackPid();
  });
  child.stderr.on("data", (chunk) => { if (stderr.length < MAX_STREAM_BYTES) stderr += chunk.toString("utf8").slice(0, MAX_STREAM_BYTES); });

  /**
   * 只回收**本进程自己创建**的包装器句柄（有界）。
   * 服务子进程一律由包装器用自己保留的 Process 句柄停止；管理器**不做裸 `process.kill(servicePid)`
   * 兜底**：PID 可能已被复用，而 `/api/account-sets` 能返回 JSON 也不能证明「这个 PID 就是该端口 /
   * 该创建实例」，因此那不能称为 PID 身份验证。
   */
  const reclaimWrapper = async (reason) => {
    if (exited) return { exited: true };
    try { child.kill(); } catch { /* ignore */ }
    let done = await Promise.race([exitPromise, delay(5000).then(() => null)]);
    if (!done) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      done = await Promise.race([exitPromise, delay(KILL_GRACE_MS).then(() => null)]);
    }
    if (!done) {
      run.recordResidual({ kind: "powershell_wrapper", label: "start-script", pid: child.pid ?? null, reason });
      run.addAssertion("start_script.wrapper_reclaimed", "fail", "wrapper_not_reclaimed", { pid: child.pid ?? null, reason });
      return { exited: false };
    }
    return { exited: true };
  };

  /**
   * 服务子进程没被包装器回收时的**如实报告**：只做存活探测（不构成身份证明）、不终止任何进程，
   * 记 fail 断言并保留目录，留给管理者定点核验。有界等待（最多约 2 秒）只是为了避免把
   * “刚收到退出、还没来得及回收”误报成残留。
   */
  const reportUnresolvedService = async (reason) => {
    trackPid();
    if (servicePid === null) return;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!isProcessAlive(servicePid)) {
        run.note("start_script.service_stop", "not_alive_at_check", { reason });
        return;
      }
      await delay(100);
    }
    run.recordResidual({ kind: "service", label: "start-script", pid: servicePid, reason: `identity_unverified:${reason}` });
    run.addAssertion("start_script.service_identity_unverified", "fail", "service_identity_unverified", { pid: servicePid, reason });
  };

  try {
    port = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new StageError("start_script_not_ready")), LIMITS.readinessMs);
      child.once("exit", () => { clearTimeout(timer); rejectPromise(new StageError("start_script_exited_before_ready")); });
      child.stdout.on("data", () => {
        const match = /127\.0\.0\.1:(\d+)\//.exec(stdout);
        if (match) { clearTimeout(timer); resolvePromise(Number(match[1])); }
      });
    });
  } catch (error) {
    await reclaimWrapper("not_ready");
    await reportUnresolvedService("not_ready");
    run.log("start-script", stdout, stderr);
    throw error;
  }

  const probe = await fetchJson(`http://127.0.0.1:${port}/api/account-sets`);
  run.assert("start_script.http_empty", probe.status === 200 && Array.isArray(probe.json) && probe.json.length === 0, { code: "start_script_http_failed", details: { status: probe.status } });
  const finished = await Promise.race([exitPromise, delay(LIMITS.startScriptMs).then(() => null)]);
  // 包装器应在 -MaxRunSeconds 到点后用自己的保留句柄停服务并退出 124；管理器只等这个结果。
  if (!finished) {
    // 超过有界宽限：只回收自有包装器句柄，服务状态如实记为未核实残留并 fail，目录保留。
    await reclaimWrapper("wrapper_deadline_exceeded");
    await reportUnresolvedService("wrapper_deadline_exceeded");
  } else if (finished.code !== 124) {
    // 非 124 退出（异常路径 / 自停失败）：服务是否已回收未核实，不猜测、也不裸杀。
    await reportUnresolvedService(`wrapper_exit_${finished.code}`);
  } else {
    // 包装器声称有界退出，但服务仍存活 → 事实与声明不符，如实记残留并 fail。
    await reportUnresolvedService("bounded_exit_but_service_alive");
  }
  run.log("start-script", stdout, stderr);
  run.assert("start_script.service_pid_tracked", servicePid !== null, { code: "service_pid_missing" });
  run.assert("start_script.bounded_exit", finished?.code === 124, { code: "start_script_exit_not_bounded", details: { exitCode: finished?.code ?? null, signal: finished?.signal ?? null } });
  run.assert("start_script.service_released", servicePid === null || !isProcessAlive(servicePid), { code: "service_still_running", details: { tracked: servicePid !== null } });
  run.assert("start_script.data_created", existsSync(join(dataDir, "workbench.db")), { code: "start_script_data_missing" });
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
    const nodeVersion = await spawnChecked(run, "preflight-node-version", options.node, ["--version"], { env: minimalEnv(), timeoutMs: LIMITS.suiteMs });
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
  let outDir;
  try {
    outDir = prepareOutDir(options.out);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ tool: TOOL, ok: false, status: "rejected", code: error.code ?? "out_invalid" }, null, 2)}\n`);
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
    try {
      const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
      if (outDir) writeFileSync(join(outDir, "logs", "internal-error.log"), detail, "utf8");
    } catch { /* ignore */ }
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
        const reason = status !== "ok" ? "stage_failed_residual_kept" : options.keep ? "keep_requested" : "cleanup_not_allowed";
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
