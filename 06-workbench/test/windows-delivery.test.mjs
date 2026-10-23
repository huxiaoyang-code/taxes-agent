#!/usr/bin/env node
/**
 * test/windows-delivery.test.mjs — Windows 交付包失败路径与关键成功链。
 *
 * 独立运行（不依赖 npm test 挂载）：
 *   node test/windows-delivery.test.mjs
 *
 * 全部使用 workspace 专属临时根（默认 `<workbench>/tmp/windows-delivery`，可用
 * 环境变量 WINDOWS_DELIVERY_SCRATCH_ROOT 指定显式授权的绝对路径）+ 随机回环端口；
 * 不连接既有后端、不读真实账套 / 凭据、不按进程名杀进程、不扫描系统 TEMP。
 * 每个临时根都有所有权 manifest v2（逐项删除目标 + realpath），删除统一走
 * `windows-runtime-check.mjs` 导出的同一守卫（脚本 / 测试不维护第二套）；任何子进程都有
 * 真实 deadline。Node 运行时要求与交付包一致：24.15.0（本包实际验收版本）。
 *
 * 需管理者前置（可选，缺失则明确 skip，不假报通过）的用量型用例：
 *   WINDOWS_DELIVERY_RELEASE_ROOT   已包含 W1 随包工具的冷拷贝发布根（绝对路径）
 *   WINDOWS_DELIVERY_NPM_ENTRY      npm-cli.js 或 npm.cmd 的绝对路径（同既授权公共 lock）
 *   WINDOWS_DELIVERY_NPM_CACHE      本任务专属 npm 缓存绝对路径
 *   WINDOWS_DELIVERY_NODE_BINARY    可选，默认 process.execPath
 */

import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import nodeTest, { after } from "node:test";

import { decideRuntimeVersion, inspectRawAbsolutePath, inspectScratchBasePath, TESTED_NODE_VERSION } from "../scripts/windows-runtime-check.mjs";
import {
  auditScratchBase,
  classifyOfficeOutputs,
  childLifecycleFailure,
  isOfflineCacheMiss,
  runDependencyInstallSequence,
  runWithSuccessCleanup,
  copyReleaseWhitelist,
  createScratchRecord,
  defaultScratchBase,
  inspectRelease,
  prepareOutDir,
  removeScratchRecord,
  removeTrackedPath,
  REQUIRED_OFFICE_KINDS,
  trackExistingPath,
  validateLockSources,
} from "../scripts/windows-delivery-check.mjs";

const WORKBENCH = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const RUNTIME_CHECK = join(WORKBENCH, "scripts", "windows-runtime-check.mjs");
const DELIVERY_CHECK = join(WORKBENCH, "scripts", "windows-delivery-check.mjs");
const START_SCRIPT = join(WORKBENCH, "scripts", "windows-start.ps1");
const SERVER = join(WORKBENCH, "server", "server.mjs");
const PS5 = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

const STREAM_LIMIT = 1024 * 1024;
const KILL_GRACE_MS = 5000;
const cleanupFailures = [];
const residuals = [];
/** 故意保留的“预期拒绝”fixture 证据（不进入通用“全清”断言）。 */
const expectedRefusalFixtures = [];
const fixtureScope = new AsyncLocalStorage();

// Finally blocks only request cleanup. The complete test (including assertions and
// process shutdown) must succeed before any requested fixture is removed.
function cleanupDecision(scope) {
  const reasons = [...scope.reasons];
  if (!scope.passed) reasons.push("test_failed_or_assertion_failed");
  for (const child of scope.children) if (!child.reclaimed) reasons.push(`${child.label}:child_unreclaimed_or_unknown`);
  return reasons.length ? reasons.join(",") : null;
}

function test(name, body) {
  return nodeTest(name, async (t) => {
    const scope = { passed: false, records: new Set(), requested: new Set(), children: [], reasons: [], checks: [] };
    return fixtureScope.run(scope, async () => {
      try {
        await body(t);
        scope.passed = true;
      } finally {
        let reason = cleanupDecision(scope);
        // Children before their parent: every registered nested manifest is checked.
        for (const record of [...scope.records].sort((a, b) => b.root.length - a.root.length)) {
          const explicit = expectedRefusalFixtures.some((entry) => isInsideDir(record.root, entry.root));
          if (reason || explicit || !scope.requested.has(record)) {
            recordExpectedRefusalFixture({ kind: `retained-${name}`, root: record.root,
              reason: reason ?? (explicit ? "expected_refusal_evidence" : "cleanup_not_requested") });
            t.diagnostic(`fixture retained: ${record.root}; ${reason ?? "expected_refusal_or_cleanup_not_requested"}`);
          } else {
            const removal = removeScratchRecord(record);
            if (!removal.ok) {
              cleanupFailures.push({ name, reason: removal.reason });
              recordExpectedRefusalFixture({ kind: `cleanup-refused-${name}`, root: record.root, reason: removal.reason });
              // Never let a parent cleanup erase a nested fixture whose own guard refused.
              reason = `nested_cleanup_refused:${removal.reason}`;
            }
          }
        }
        if (!reason) for (const check of scope.checks) check();
      }
    });
  });
}

function trackChild(label) {
  const state = { label, reclaimed: false };
  fixtureScope.getStore().children.push(state);
  return state;
}

function retainForChild(label, result) {
  if (result.timedOut || result.unreclaimed || result.spawnError || result.code !== 0) {
    fixtureScope.getStore().reasons.push(`${label}:${result.timedOut ? "timed_out" : result.unreclaimed ? "unreclaimed" : result.spawnError ? "spawn_failed" : `exit_${result.code}`}`);
  }
}

function recordExpectedRefusalFixture(entry) {
  expectedRefusalFixtures.push(entry);
}

// ------------------------------------------------------------------ 专属临时根 / 清理事实

function scratchBase() {
  const override = (process.env.WINDOWS_DELIVERY_SCRATCH_ROOT ?? "").trim();
  return override === "" ? defaultScratchBase() : override;
}

function safeLabel(label) {
  return String(label).replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40);
}

function newScratch(label) {
  const record = createScratchRecord({ label: `test-${safeLabel(label)}`, basePath: scratchBase(), tool: "windows-delivery-test" });
  fixtureScope.getStore().records.add(record);
  return record;
}

function pathKeyOf(path) {
  return resolve(path).toLowerCase();
}

function isInsideDir(root, target) {
  const base = pathKeyOf(root);
  const value = pathKeyOf(target);
  return value === base || value.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/** 目录项名字的有序快照（只用于本用例自有 fixture，不扫描卷根 / 用户目录）。 */
function snapshotDir(dir) {
  return readdirSync(dir).sort();
}

/**
 * 从**本用例自有绝对目标**派生 relative / drive-relative / root-relative 原始入参，
 * 并在调用前断言：即使被旧实现按 cwd 规范化，结果也只是本 fixture 内的同一个目标
 * （绝不会变成卷根 / 用户目录 / 仓库）。
 *
 * `cwdDir` 必须显式给出：子进程用例传子进程真实 cwd，进程内用例传 process.cwd()。
 * 不使用 process.chdir（会串扰并发用例）。
 */
function rawPathVariants(target, { fixtureRoot, cwdDir = process.cwd() }) {
  assert.ok(typeof fixtureRoot === "string" && isInsideDir(fixtureRoot, target), `目标必须在本用例 fixture 内：${target}`);
  assert.notEqual(pathKeyOf(fixtureRoot), pathKeyOf(target), "目标必须是 fixture 内的子路径，不能就是 fixture 根本身");
  const volumeRoot = parse(target).root;
  assert.match(volumeRoot, /^[A-Za-z]:[\\/]$/, `候选目标必须在盘符卷上（便于构造 drive-relative）：${volumeRoot}`);
  assert.equal(
    pathKeyOf(parse(cwdDir).root),
    pathKeyOf(volumeRoot),
    `cwd 必须与 fixture 同卷，否则相对原入参无法定位到自有目标：${pathKeyOf(parse(cwdDir).root)} ≠ ${pathKeyOf(volumeRoot)}`,
  );
  const rel = relative(cwdDir, target);
  assert.ok(rel !== "" && !isAbsolute(rel), `相对片段必须真的相对：${rel}`);
  const variants = {
    relative: rel,
    "drive-relative": `${volumeRoot.slice(0, 2)}${rel}`,
    // 从自有绝对目标去盘符产生：单反斜杠起头但保留本任务完整子路径，不是「\ + 裸 tag」。
    "root-relative": `${sep}${target.slice(volumeRoot.length)}`,
  };
  for (const [name, raw] of Object.entries(variants)) {
    assert.equal(pathKeyOf(resolve(cwdDir, raw)), pathKeyOf(target), `${name} 误规范化结果必须就是本 fixture 目标`);
    assert.ok(isInsideDir(fixtureRoot, resolve(cwdDir, raw)), `${name} 误规范化结果必须仍在本 fixture 内`);
  }
  return variants;
}

function cleanupScratch(record) {
  if (!record) return;
  const scope = fixtureScope.getStore();
  assert.ok(scope.records.has(record), "cleanup must belong to current test");
  scope.requested.add(record);
}

after(() => {
  assert.deepEqual(cleanupFailures, [], `scratch cleanup failed: ${JSON.stringify(cleanupFailures)}`);
  assert.deepEqual(residuals, [], `unreclaimed processes: ${JSON.stringify(residuals)}`);
  // 预期拒绝的 fixture 必须**真的保留**在磁盘上，且原因已记录：守卫拒绝后不得用 unlink /
  // 手工删除去“修饰结果”，所以它们不能进 cleanupFailures，也不能要求全清成功。
  for (const fixture of expectedRefusalFixtures) {
    assert.equal(existsSync(fixture.root), true, `expected-refusal fixture must be retained: ${fixture.kind}`);
    assert.ok(typeof fixture.reason === "string" && fixture.reason.length > 0, `expected-refusal reason must be recorded: ${fixture.kind}`);
  }
});

/** 在给定目录下建一个满足 inspectRelease 最小要求的发布目录（只在本次专属根内）。 */
function buildReleaseWorkbench(dir) {
  mkdirSync(dir);
  const workbench = join(dir, "06-workbench");
  mkdirSync(workbench);
  writeFileSync(join(workbench, "package.json"), "{}", "utf8");
  writeFileSync(join(workbench, "package-lock.json"), "{}", "utf8");
  mkdirSync(join(workbench, "server"));
  writeFileSync(join(workbench, "server", "server.mjs"), "", "utf8");
  mkdirSync(join(workbench, "public"));
  writeFileSync(join(workbench, "public", "index.html"), "<html></html>", "utf8");
  return workbench;
}

function manifestFileOf(record) {
  return join(record.root, readdirSync(record.root).find((name) => name.startsWith(".wb-scratch-") && name.endsWith(".json")));
}

function delay(ms) {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, ms); });
}


/** 子进程环境白名单：不把整个 process.env（含 npm 配置、凭据、代理）传给子进程。 */
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

/** All child defaults are created in an independent, owned fixture before spawn. */
function childEnvironment(root, extra = {}) {
  const dirs = {
    TEMP: join(root, "process-temp"), TMP: join(root, "process-temp"),
    WORKBENCH_DATA_DIR: join(root, "fallback-data"),
    WINDOWS_DELIVERY_SCRATCH_ROOT: join(root, "child-scratch"),
  };
  for (const path of new Set(Object.values(dirs))) mkdirSync(path, { recursive: true });
  const env = minimalEnv({ ...dirs, ...extra });
  for (const key of Object.keys(dirs)) {
    assert.ok(isInsideDir(root, env[key]), `${key} must belong to this child fixture`);
    mkdirSync(env[key], { recursive: true });
  }
  return env;
}

/** Copy the launcher, runtime and delivery module together: default scratch stays inside fixture. */
function copyChildTools(root) {
  const wb = join(root, "isolated-workbench");
  mkdirSync(join(wb, "scripts"), { recursive: true });
  mkdirSync(join(wb, "test"));
  mkdirSync(join(wb, "server"));
  for (const source of [RUNTIME_CHECK, DELIVERY_CHECK, START_SCRIPT]) {
    copyFileSync(source, join(wb, "scripts", source.split(/[\\/]/).at(-1)));
  }
  copyFileSync(fileURLToPath(import.meta.url), join(wb, "test", "windows-delivery.test.mjs"));
  // Negative launcher calls must never start a real service if their guards regress.
  writeFileSync(join(wb, "server", "server.mjs"), 'throw new Error("negative_fixture_service_must_not_start");', "utf8");
  return wb;
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 60000;
    let child = null;
    let timer = null;
    let graceTimer = null;
    let hangTimer = null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (hangTimer) clearTimeout(hangTimer);
      resolvePromise({ stdout, stderr, timedOut, reclaimed: false, pid: child?.pid ?? null, ...payload });
    };
    try {
      child = spawn(command, args, {
        cwd: options.cwd ?? WORKBENCH,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch {
      finish({ code: null, signal: null, spawnError: "spawn_failed" });
      return;
    }
    child.stdout.on("data", (chunk) => { if (stdout.length < STREAM_LIMIT) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { if (stderr.length < STREAM_LIMIT) stderr += chunk.toString("utf8"); });
    child.once("error", (error) => finish({ code: null, signal: null, spawnError: error?.code ?? "spawn_failed" }));
    child.once("close", (code, signal) => finish({ code: code ?? null, signal: signal ?? null, reclaimed: true }));
    // 真实 deadline：先礼后兵；强杀后仍不 close 就在 KILL_GRACE_MS 后报“未回收”。
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
      graceTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        hangTimer = setTimeout(() => {
          try { child.stdout?.destroy(); } catch { /* ignore */ }
          try { child.stderr?.destroy(); } catch { /* ignore */ }
          try { child.unref?.(); } catch { /* ignore */ }
          finish({ code: null, signal: "SIGKILL", unreclaimed: true });
        }, KILL_GRACE_MS);
        hangTimer.unref?.();
      }, 1000);
      graceTimer.unref?.();
    }, timeoutMs);
  });
}

async function capture(label, command, args, options = {}) {
  const childFixture = newScratch(`child-${safeLabel(label)}`);
  // Queue only: test-scope finalization waits for all caller assertions as well.
  cleanupScratch(childFixture);
  const childState = trackChild(label);
  const wb = copyChildTools(childFixture.root);
  const childArgs = args.map((arg) => [RUNTIME_CHECK, DELIVERY_CHECK, START_SCRIPT].includes(arg)
    ? join(wb, "scripts", arg.split(/[\\/]/).at(-1)) : arg);
  const suppliedEnv = { ...(options.env ?? {}) };
  // capture owns all fallback paths; explicit --data-dir / -DataDir arguments still target caller fixture.
  for (const key of ["TEMP", "TMP", "WINDOWS_DELIVERY_SCRATCH_ROOT"]) delete suppliedEnv[key];
  const explicitDataDir = suppliedEnv.WORKBENCH_DATA_DIR;
  delete suppliedEnv.WORKBENCH_DATA_DIR;
  const env = childEnvironment(childFixture.root, suppliedEnv);
  if (explicitDataDir !== undefined) {
    assert.ok(isInsideDir(scratchBase(), explicitDataDir), "explicit server data must stay under suite fixture base");
    env.WORKBENCH_DATA_DIR = explicitDataDir;
  }
  // Caller data directories intentionally belong to its own fixture; TEMP and fallback remain child-owned.
  const result = await spawnCapture(command, childArgs, { ...options, cwd: options.cwd ?? wb, env });
  childState.reclaimed = result.reclaimed === true;
  retainForChild(label, result);
  if (result.unreclaimed || (!childState.reclaimed && result.pid !== null)) residuals.push({ label, pid: result.pid ?? null, kind: "child" });
  return { ...result, isolation: { root: childFixture.root, workbench: wb } };
}

async function fetchJson(base, path, options = {}) {
  const response = await fetch(base + path, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, text };
}

async function startServer(dataDir, scratch) {
  const childState = trackChild("test-server");
  let stoppingRequested = false;
  const child = spawn(NODE, [SERVER], {
    cwd: WORKBENCH,
    env: childEnvironment(scratch.root, {
      TEMP: join(scratch.root, "tmp"),
      TMP: join(scratch.root, "tmp"),
      HOST: "127.0.0.1",
      PORT: "0",
      WORKBENCH_DATA_DIR: dataDir,
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  const exitPromise = new Promise((resolvePromise) => child.once("close", (code, signal) => {
    childState.reclaimed = true;
    if (!stoppingRequested) fixtureScope.getStore().reasons.push(`server_exited_without_stop:${code}:${signal}`);
    resolvePromise({ code, signal, reclaimed: true });
  }));
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  // readiness 失败也必须回收本测试自己的服务子进程（有界），不能丢在后台。
  const hardStop = async (label) => {
    stoppingRequested = true;
    if (childState.reclaimed) return { reclaimed: true };
    try { child.kill(); } catch { /* ignore */ }
    let done = await Promise.race([exitPromise, delay(KILL_GRACE_MS).then(() => null)]);
    if (!done) {
      fixtureScope.getStore().reasons.push(`${label}:stop_deadline_exceeded`);
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      done = await Promise.race([exitPromise, delay(KILL_GRACE_MS).then(() => null)]);
    }
    if (!done) residuals.push({ label, pid: child.pid ?? null, kind: "server" });
    return { reclaimed: done?.reclaimed === true, code: done?.code ?? null, signal: done?.signal ?? null };
  };
  let port;
  try {
    port = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("server_not_ready_timeout")), 15000);
      child.once("error", () => { clearTimeout(timer); rejectPromise(new Error("server_spawn_failed")); });
      child.once("exit", (code) => { clearTimeout(timer); rejectPromise(new Error(`server_exited_before_ready:${code}`)); });
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
        const match = /127\.0\.0\.1:(\d+)\//.exec(stdout);
        if (match) { clearTimeout(timer); resolvePromise(Number(match[1])); }
      });
    });
  } catch (error) {
    fixtureScope.getStore().reasons.push(`server_readiness_failed:${error.message}`);
    error.reclamation = await hardStop("test-server-not-ready");
    throw error;
  }
  const base = `http://127.0.0.1:${port}`;
  let stopping = null;
  return {
    port,
    base,
    get: (path) => fetchJson(base, path),
    post: (path, body) => fetchJson(base, path, { method: "POST", body }),
    async stop() {
      // 只停止本测试自己创建的句柄；杀不掉就有界报残留，不无限等。
      if (stopping) return stopping;
      stopping = (async () => {
        stoppingRequested = true;
        if (childState.reclaimed) return exitPromise;
        try { child.kill(); } catch { /* ignore */ }
        let done = await Promise.race([exitPromise, delay(10000).then(() => null)]);
        if (!done) {
          fixtureScope.getStore().reasons.push("test-server:stop_deadline_exceeded");
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
          done = await Promise.race([exitPromise, delay(KILL_GRACE_MS).then(() => null)]);
        }
        if (!done) residuals.push({ label: "test-server", pid: child.pid ?? null, kind: "server" });
        if (!done) fixtureScope.getStore().reasons.push("server_stop_unreclaimed");
        return { reclaimed: done?.reclaimed === true, code: done?.code ?? null, signal: done?.signal ?? null };
      })();
      return stopping;
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

const SOURCE = { system: "local-book", enterpriseKey: "91350000WINTEST0001X", enterpriseName: "Windows 测试合成公司" };
const META = { name: "Windows 测试合成公司", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" };
const JAN = {
  account_set: { ...META },
  opening_balances: [{ code: "1002", debit: 50000, credit: 0 }, { code: "3001", debit: 0, credit: 50000 }],
  vouchers: [{
    period: "2026-01", date: "2026-01-08", word: "记", number: 1, summary: "销售商品", sourceVoucherId: "TEST-SRC-1",
    entries: [
      { code: "1122", debit: 11300, credit: 0 },
      { code: "5001", debit: 0, credit: 10000 },
      { code: "2221", debit: 0, credit: 1300 },
    ],
  }],
};
const FEB = {
  account_set: { ...META },
  vouchers: [{
    period: "2026-02", date: "2026-02-09", word: "记", number: 1, summary: "收回货款", sourceVoucherId: "TEST-SRC-2",
    entries: [{ code: "1002", debit: 11300, credit: 0 }, { code: "1122", debit: 0, credit: 11300 }],
  }],
};

test("现场保留决策：调用方断言、失败、超时与回收未知阻止清理，成功且回收才允许", () => {
  const ok = { passed: true, children: [{ label: "owned", reclaimed: true }], reasons: [] };
  assert.equal(cleanupDecision(ok), null, "successful owned processes allow manifest cleanup");
  assert.match(cleanupDecision({ ...ok, passed: false }), /test_failed_or_assertion_failed/);
  assert.match(cleanupDecision({ ...ok, children: [{ label: "server", reclaimed: false }] }), /server:child_unreclaimed_or_unknown/);
  for (const reason of ["child:exit_2", "child:timed_out", "child:spawn_failed", "server_readiness_failed", "wrapper_aborted_service_reclamation_unknown", "test-server:stop_deadline_exceeded"]) {
    assert.equal(cleanupDecision({ ...ok, reasons: [reason] }), reason);
  }
  assert.match(cleanupDecision({ ...ok, passed: false, reasons: ["child:timed_out"] }), /child:timed_out.*test_failed_or_assertion_failed/);
  // Exercise capture's actual result-to-retention mapping without starting a child.
  for (const result of [
    { code: 0 }, { code: 2 }, { code: 0, timedOut: true },
    { code: null, unreclaimed: true }, { code: null, spawnError: "ENOENT" },
  ]) {
    const scope = { ...ok, reasons: [] };
    fixtureScope.run(scope, () => retainForChild("capture", result));
    assert.equal(cleanupDecision(scope) === null, result.code === 0 && !result.timedOut,
      `only a successful child may allow caller fixture cleanup: ${JSON.stringify(result)}`);
  }
});

async function importTwoMonths(server) {
  const dry = await server.post("/api/import/incremental", { batchId: "TEST-2026-01", source: SOURCE, payload: JAN });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.status, "preview");
  const empty = await server.get("/api/account-sets");
  assert.deepEqual(empty.json, []);
  const applied = await server.post("/api/import/incremental", { batchId: "TEST-2026-01", source: SOURCE, payload: JAN, dryRun: false });
  assert.equal(applied.status, 201, JSON.stringify(applied.json));
  const setId = applied.json.created.accountSetId;
  const retry = await server.post("/api/import/incremental", { batchId: "TEST-2026-01", source: SOURCE, payload: JAN, dryRun: false });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.status, "idempotent_replay");
  const feb = await server.post("/api/import/incremental", { batchId: "TEST-2026-02", source: SOURCE, mode: "append", accountSetId: setId, payload: FEB, dryRun: false });
  assert.equal(feb.status, 201, JSON.stringify(feb.json));
  return setId;
}

async function assertAmounts(server, setId) {
  const report = await server.get(`/api/account-sets/${setId}/reports/trial-balance/export-data?period=2026-02`);
  assert.equal(report.status, 200);
  const bank = report.json.data.lines.find((line) => line.code === "1002");
  const receivable = report.json.data.lines.find((line) => line.code === "1122");
  const revenue = report.json.data.lines.find((line) => line.code === "5001");
  assert.equal(bank.closing_debit, 61300);
  assert.equal(receivable.closing_debit, 0);
  assert.equal(revenue.period_credit, 0);
  assert.equal(revenue.ytd_credit, 10000);
}

test("子进程生命周期：回收未知、timeout、spawnError 不得触发 online / 删除 / 重装", async () => {
  const completed = { code: 0, reclaimed: true, timedOut: false, signal: null, stdout: "", stderr: "" };
  const cacheMiss = { ...completed, code: 1, stderr: "npm error code ENOTCACHED\n" };
  const unsafe = [
    [{ unreclaimed: true }, "child_process_unreclaimed"],
    [{ hardDeadline: true }, "child_process_unreclaimed"],
    [{ timedOut: true }, "child_process_timed_out"],
    [{ spawnError: "ENOENT" }, "child_process_spawn_failed"],
    [{ reclaimed: undefined }, "child_process_reclamation_unknown"],
    [{ reclaimed: false }, "child_process_reclamation_unknown"],
    [{ code: null }, "child_process_exit_unknown"],
    [{ signal: "SIGTERM" }, "child_process_exit_unknown"],
  ];
  for (const [flags, expected] of unsafe) {
    for (const base of [completed, cacheMiss]) {
      const bad = { ...base, ...flags };
      assert.equal(childLifecycleFailure(bad), expected);
      assert.equal(isOfflineCacheMiss(bad), false);
      for (const failureStep of [0, 1, 2]) {
        const calls = [];
        const values = [cacheMiss, completed, completed];
        values[failureStep] = bad;
        await assert.rejects(runDependencyInstallSequence({
          install: async (step, offline) => {
            calls.push([step, offline]);
            return values[["offline", "online", "offline-after-online"].indexOf(step)];
          },
          removeModules: async () => { calls.push(["remove"]); },
        }), { code: expected });
        assert.deepEqual(calls, [
          ["offline", true],
          ...(failureStep >= 1 ? [["online", false]] : []),
          ...(failureStep >= 2 ? [["remove"], ["offline-after-online", true]] : []),
        ]);
      }
    }
  }
});

test("依赖安装决策：只有明确 ENOTCACHED 可回退，非缓存错误保留且成功链有序", async () => {
  const completed = { code: 0, reclaimed: true, timedOut: false, signal: null, stdout: "", stderr: "" };
  const cacheMiss = { ...completed, code: 1, stderr: "npm error code ENOTCACHED\n" };
  assert.equal(isOfflineCacheMiss(cacheMiss), true);
  assert.equal(isOfflineCacheMiss({ ...cacheMiss, stderr: "npm ERR! code ENOTCACHED\r\n" }), true);
  assert.equal(isOfflineCacheMiss({ ...completed, stderr: cacheMiss.stderr }), false);
  for (const error of ["EAI_AGAIN", "ENETUNREACH", "ECONNREFUSED", "EACCES", "EINTEGRITY", "EUSAGE", "only-if-cached", "ENOTCACHED mentioned in a stack"]) {
    const failed = { ...completed, code: 1, stderr: `npm error code ${error}\n`, cacheMiss: true };
    const calls = [];
    assert.equal(isOfflineCacheMiss(failed), false);
    await assert.rejects(runDependencyInstallSequence({
      install: async (step) => { calls.push(step); return failed; },
      removeModules: async () => { calls.push("remove"); },
    }), { code: "dependency_offline_install_failed" });
    assert.deepEqual(calls, ["offline"]);
  }
  for (const values of [[completed], [cacheMiss, completed, completed]]) {
    const calls = [];
    const queue = [...values];
    const result = await runDependencyInstallSequence({
      install: async (step, offline) => { calls.push([step, offline]); return queue.shift(); },
      removeModules: async () => { calls.push(["remove"]); },
    });
    assert.deepEqual(result, { networkUsed: values.length > 1, offlineProven: true });
    assert.deepEqual(calls, values.length === 1 ? [["offline", true]] : [["offline", true], ["online", false], ["remove"], ["offline-after-online", true]]);
  }
  for (const failureStep of [1, 2]) {
    const values = [cacheMiss, completed, completed];
    values[failureStep] = { ...completed, code: 1 };
    const calls = [];
    await assert.rejects(runDependencyInstallSequence({
      install: async (step) => { calls.push(step); return values.shift(); },
      removeModules: async () => { calls.push("remove"); },
    }), { code: failureStep === 1 ? "dependency_install_failed" : "dependency_offline_reinstall_failed" });
    assert.deepEqual(calls, failureStep === 1 ? ["offline", "online"] : ["offline", "online", "remove", "offline-after-online"]);
  }
  const calls = [];
  const removalError = new Error("manifest refused");
  await assert.rejects(runDependencyInstallSequence({
    install: async (step) => { calls.push(step); return step === "offline" ? cacheMiss : completed; },
    removeModules: async () => { calls.push("remove"); throw removalError; },
  }), (error) => error === removalError);
  assert.deepEqual(calls, ["offline", "online", "remove"]);
});

test("Office helper 生命周期：失败与 blocked 保留，成功后才运行清理", async () => {
  for (const code of ["child_process_unreclaimed", "child_process_timed_out", "child_process_spawn_failed", "child_process_reclamation_unknown", "office_render_failed", "pdf_output_required_blocked"]) {
    const failure = Object.assign(new Error(code), { code });
    let removed = 0;
    await assert.rejects(runWithSuccessCleanup(async () => { throw failure; }, () => { removed++; }), (error) => error === failure);
    assert.equal(removed, 0);
  }
  const calls = [];
  assert.equal(await runWithSuccessCleanup(async () => { calls.push("complete"); return "outputs"; }, () => { calls.push("remove"); }), "outputs");
  assert.deepEqual(calls, ["complete", "remove"]);
  const cleanupError = new Error("manifest refused");
  await assert.rejects(runWithSuccessCleanup(async () => "outputs", () => { throw cleanupError; }), (error) => error === cleanupError);
});

test("版本策略：只放行本包实际验收的 24.15.0，不把更大版本或其它 patch 当已支持", () => {
  assert.equal(TESTED_NODE_VERSION, "24.15.0");
  assert.equal(decideRuntimeVersion("24.15.0").ok, true);
  assert.equal(decideRuntimeVersion("v24.15.0").ok, true);
  assert.equal(decideRuntimeVersion("24.15.1").ok, false);
  assert.equal(decideRuntimeVersion("24.14.9").code, "runtime_version_not_qualified");
  assert.equal(decideRuntimeVersion("22.16.0").code, "runtime_version_not_qualified");
  assert.equal(decideRuntimeVersion("25.0.0").code, "runtime_version_not_qualified");
  assert.equal(decideRuntimeVersion("garbage").code, "runtime_version_unreadable");
});

test("专属临时根：默认在 workbench 的 tmp/windows-delivery，manifest 记录所有权，越界删除被拒绝", async () => {
  assert.equal(defaultScratchBase(), join(WORKBENCH, "tmp", "windows-delivery"));
  const scratch = newScratch("ownership");
  try {
    const copied = copyChildTools(scratch.root);
    const defaultResult = await capture("ownership-default", NODE, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      const guard = await import(${JSON.stringify(pathToFileURL(join(copied, "scripts", "windows-runtime-check.mjs")).href)});
      const record = guard.createScratchRecord({ tool: "windows-delivery-test" });
      assert.equal(record.base, guard.defaultScratchBase());
      assert.equal(record.base, ${JSON.stringify(join(copied, "tmp", "windows-delivery"))});
      assert.equal(guard.removeScratchRecord(record).ok, true);
    `], { cwd: copied });
    assert.equal(defaultResult.code, 0, defaultResult.stderr);

    const manifestFile = readdirSync(scratch.root).find((name) => name.startsWith(".wb-scratch-") && name.endsWith(".json"));
    assert.ok(manifestFile, "manifest file must exist");
    const manifest = JSON.parse(readFileSync(join(scratch.root, manifestFile), "utf8"));
    assert.equal(manifest.ownerTask, "LOCAL-06-WINDOWS");
    assert.equal(manifest.runToken, scratch.token);
    assert.equal(manifest.root, scratch.root);

    // 未登记目标、根外目标都必须被拒绝（不按名称/前缀推断所有权）。
    assert.equal(removeTrackedPath(scratch, join(scratch.root, "not-registered")).ok, false);
    const outside = join(dirname(scratch.root), "someone-else");
    assert.equal(removeTrackedPath(scratch, outside).ok, false);

    // 登记后再删除仍必须在根内：登记一个归属记录的路径是允许的，但越界路径仍未登记。
    assert.equal(trackExistingPath(scratch, join(scratch.root, "not-registered")), null);
  } finally {
    cleanupScratch(scratch);
  }
  fixtureScope.getStore().checks.push(() => assert.equal(scratch.tracked.has(scratch.root.toLowerCase()), false, "root must be unregistered after cleanup"));
});

test("lock 来源白名单：真实冻结 lock 通过，file/私有域/无完整性被拒绝", () => {
  const real = validateLockSources(join(WORKBENCH, "package-lock.json"));
  assert.equal(real.ok, true, JSON.stringify(real.violations));
  assert.ok(real.checked > 0);
  assert.deepEqual(real.allowedHosts, ["registry.npmjs.org", "registry.npmmirror.com"]);

  const scratch = newScratch("lock-sources");
  try {
    const cases = [
      { name: "file", entry: { resolved: "file:../../vendor/pkg.tgz", integrity: "sha512-abc" } },
      { name: "git", entry: { resolved: "git+https://example.invalid/pkg.git", integrity: "sha512-abc" } },
      { name: "private", entry: { resolved: "https://npm.internal.invalid/pkg/-/pkg-1.0.0.tgz", integrity: "sha512-abc" } },
      { name: "credentials", entry: { resolved: "https://user:pass@registry.npmjs.org/pkg/-/pkg-1.0.0.tgz", integrity: "sha512-abc" } },
      { name: "no-integrity", entry: { resolved: "https://registry.npmmirror.com/pkg/-/pkg-1.0.0.tgz" } },
    ];
    for (const item of cases) {
      const file = join(scratch.root, `lock-${item.name}.json`);
      writeFileSync(file, JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "root" }, "node_modules/pkg": item.entry } }), "utf8");
      const result = validateLockSources(file);
      assert.equal(result.ok, false, `${item.name} must be rejected`);
      assert.ok(result.violations.length > 0);
    }
  } finally {
    cleanupScratch(scratch);
  }
});

test("运行时预检：真实 Node 通过，输出不含业务 DB，探针隔离且有界并已清理", async () => {
  const before = existsSync(join(WORKBENCH, "data"));
  const result = await capture("runtime-check", NODE, [RUNTIME_CHECK, "--json"], { timeoutMs: 120000 });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.runtime.platform, "win32");
  assert.equal(payload.features.sqliteModule, true);
  assert.equal(payload.features.isTransaction, true);
  assert.equal(payload.features.readOnly, true);
  assert.equal(payload.features.busyTimeout, true);
  assert.equal(payload.limits.probeIsolatedProcess, true);
  assert.ok(payload.limits.probeDeadlineMs > 0);
  assert.equal(payload.limits.probeTimedOut, false);
  assert.equal(payload.cleanup.completed, true);
  assert.equal(payload.cleanup.pathEchoed, false);
  assert.equal(existsSync(join(WORKBENCH, "data")), before, "预检不得创建默认 data 目录");
});

test("运行时预检：显式 --scratch-root 内建探针且清理完成，不在系统 TEMP 留根", async () => {
  const scratch = newScratch("runtime-check-root");
  try {
    const result = await capture("runtime-check-scratch", NODE, [RUNTIME_CHECK, "--json", "--scratch-root", scratch.root], { timeoutMs: 120000 });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.cleanup.completed, true);
    const leftovers = readdirSync(scratch.root).filter((name) => name.startsWith("runtime-"));
    assert.deepEqual(leftovers, [], `probe roots must be removed: ${JSON.stringify(leftovers)}`);
  } finally {
    cleanupScratch(scratch);
  }
});

test("运行时预检：文件冒充数据目录被拒绝且文件不变，数据目录不做写删探针", async () => {
  const scratch = newScratch("runtime-bad-dir");
  try {
    const file = join(scratch.root, "not-a-directory");
    writeFileSync(file, "keep-me", "utf8");
    const result = await capture("runtime-check-bad-dir", NODE, [RUNTIME_CHECK, "--json", "--data-dir", file], { timeoutMs: 120000 });
    assert.equal(result.code, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "data_dir_not_directory");
    assert.equal(payload.dataDir.writeProbe, "not_performed", "用户数据目录不得写删探针");
    assert.equal(readFileSync(file, "utf8"), "keep-me");
    // 专属根已清理，且清理是核验过的（manifest 互校通过）；不能靠真值。
    assert.equal(payload.cleanup.completed, true, JSON.stringify(payload.cleanup));
    assert.equal(payload.cleanup.manifestVerified, true);
  } finally {
    cleanupScratch(scratch);
  }
});

test("运行时预检：已有数据目录只读检查——不加文件、不删文件、不递归清理", async () => {
  const scratch = newScratch("runtime-existing-data-dir");
  try {
    const dataDir = join(scratch.root, "existing-data");
    mkdirSync(dataDir);
    const sentinel = join(dataDir, "workbench.db");
    writeFileSync(sentinel, "existing-account-set-placeholder", "utf8");
    const before = readFileSync(sentinel, "utf8");
    const result = await capture("runtime-check-existing-data-dir", NODE, [RUNTIME_CHECK, "--json", "--data-dir", dataDir], { timeoutMs: 120000 });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.dataDir.status, "pass");
    assert.equal(payload.dataDir.writeProbe, "not_performed");
    assert.deepEqual(readdirSync(dataDir), ["workbench.db"], "数据目录不得被写入探针文件");
    assert.equal(readFileSync(sentinel, "utf8"), before);
    assert.equal(payload.limits.fsRmVerifiedThroughGuard, true, "删除 API 由自建 scratch 内的守卫式 rm 证明");
    assert.equal(payload.cleanup.completed, true);
    assert.equal(payload.cleanup.manifestVerified, true);
  } finally {
    cleanupScratch(scratch);
  }
});

test("专属临时根：relative / drive-relative / root-relative 原始 base 只在本用例自有候选目标上被拒绝且不写盘", async () => {
  const fixture = newScratch("guard-raw-base");
  try {
    const cases = [
      { name: "relative", reason: "path_not_absolute" },
      { name: "drive-relative", reason: "drive_relative_not_allowed" },
      { name: "root-relative", reason: "root_relative_not_allowed" },
    ];
    for (const item of cases) {
      // 候选目标只在本用例 scratch 内：即使守卫失效被旧实现规范化，也不会落到卷根 / WORKBENCH / 用户目录。
      const candidate = join(fixture.root, `candidate-${item.name}`);
      const raw = rawPathVariants(candidate, { fixtureRoot: fixture.root })[item.name];
      const before = snapshotDir(fixture.root);
      assert.throws(
        () => createScratchRecord({ label: `guard-${item.name}`, basePath: raw, tool: "windows-delivery-test" }),
        (error) => error?.code === "scratch_root_not_absolute" && error?.details?.reason === item.reason,
        `${item.name} base 必须在 mkdir 前被拒绝`,
      );
      assert.equal(existsSync(candidate), false, `${item.name} 候选目标不得被创建`);
      assert.deepEqual(snapshotDir(fixture.root), before, `${item.name} 拒绝后父目录快照必须不变`);
    }

    // Blank is tested against a fixture-local module copy in a fixture-local cwd.
    const blankWB = copyChildTools(fixture.root);
    const blankBefore = snapshotDir(fixture.root);
    const blank = await capture("guard-blank-base", NODE, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      const { createScratchRecord } = await import(${JSON.stringify(pathToFileURL(join(blankWB, "scripts", "windows-runtime-check.mjs")).href)});
      assert.throws(() => createScratchRecord({basePath: "   ", tool: "windows-delivery-test"}),
        error => error.code === "scratch_root_not_absolute" && error.details?.reason === "path_empty");
    `], { cwd: blankWB });
    assert.equal(blank.code, 0, blank.stderr);
    assert.deepEqual(snapshotDir(fixture.root), blankBefore, "空白 base 拒绝后 fixture 不得出现新条目");
    assert.equal(existsSync(join(blankWB, "tmp")), false, "空白误退默认也只能写 fixture 副本，且应无写入");

    // Real volume root goes through production's shared pure preflight, never createScratchRecord / FS.
    const volumeRoot = parse(fixture.root).root;
    assert.ok(volumeRoot.length > 0);
    assert.deepEqual(inspectScratchBasePath(volumeRoot), { ok: false, code: "scratch_root_is_filesystem_root" });

    // 文件不能当 base，且不得改写文件内容。
    const file = join(fixture.root, "base-file");
    writeFileSync(file, "not-a-directory", "utf8");
    assert.throws(
      () => createScratchRecord({ label: "guard-file", basePath: file, tool: "windows-delivery-test" }),
      (error) => error?.code === "scratch_root_not_directory",
    );
    assert.equal(readFileSync(file, "utf8"), "not-a-directory", "文件 base 不得被改写");
  } finally {
    cleanupScratch(fixture);
  }
});

test("专属临时根：manifest v2 逐项登记删除目标并与内存互校，磁盘 manifest 不得新增删除目标", () => {
  const scratch = newScratch("manifest-guard");
  try {
    const manifestPath = manifestFileOf(scratch);
    assert.ok(manifestPath, "manifest 必须存在");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.ownerTask, "LOCAL-06-WINDOWS");
    assert.equal(manifest.tool, "windows-delivery-test");
    assert.equal(manifest.runToken, scratch.token);
    assert.equal(manifest.root, scratch.root);
    assert.equal(manifest.base, scratch.base);
    const rootTarget = manifest.targets.find((item) => item.path === scratch.root);
    assert.ok(rootTarget, "root 必须逐项登记");
    assert.equal(rootTarget.real, scratch.rootReal, "登记目标必须带 realpath");

    // 登记本次自建的子目录 → manifest 同步；守卫式删除后刷新剩余登记。
    const work = join(scratch.root, "work");
    mkdirSync(work);
    assert.ok(trackExistingPath(scratch, work, "test-work"));
    assert.ok(JSON.parse(readFileSync(manifestPath, "utf8")).targets.some((item) => item.path === work));
    const removal = removeTrackedPath(scratch, work);
    assert.equal(removal.ok, true, removal.reason);
    assert.equal(removal.manifestRefreshed, true);
    assert.equal(existsSync(work), false);
    assert.equal(scratch.tracked.has(work.toLowerCase()), false, "删除后内存登记必须清除");
    const afterRemovalText = readFileSync(manifestPath, "utf8");
    const afterRemoval = JSON.parse(afterRemovalText);
    assert.equal(afterRemoval.targets.some((item) => item.path === work), false, "删除后 manifest 必须刷新");

    // 未登记但存在的子目录：不得删除。
    const untracked = join(scratch.root, "untracked");
    mkdirSync(untracked);
    const untrackedRemoval = removeTrackedPath(scratch, untracked);
    assert.equal(untrackedRemoval.ok, false);
    assert.match(untrackedRemoval.reason, /^cleanup_refused:target_not_registered$/);
    assert.equal(existsSync(untracked), true);

    try {
      // 磁盘上多出的目标（根内、看似合理）必须拒绝：不从 manifest 导入删除目标。
      const ghost = { path: join(scratch.root, "ghost"), real: join(scratch.rootReal, "ghost"), reason: "tampered" };
      writeFileSync(manifestPath, JSON.stringify({ ...afterRemoval, targets: [...afterRemoval.targets, ghost] }), "utf8");
      const extraTarget = removeScratchRecord(scratch);
      assert.equal(extraTarget.ok, false);
      assert.equal(extraTarget.manifestVerified, false, "manifest 不一致不得报已验证");
      assert.match(extraTarget.reason, /^cleanup_refused:manifest_/);
      assert.equal(existsSync(scratch.root), true, "拒绝时必须保留现场");

      // token 不符同样拒绝。
      writeFileSync(manifestPath, JSON.stringify({ ...afterRemoval, runToken: "0".repeat(16) }), "utf8");
      const wrongToken = removeScratchRecord(scratch);
      assert.equal(wrongToken.ok, false);
      assert.match(wrongToken.reason, /^cleanup_refused:manifest_token_mismatch$/);

      // manifest 缺失同样拒绝，而不是“当作没有目标”。
      renameSync(manifestPath, join(scratch.root, "manifest.moved-aside"));
      const missingManifest = removeScratchRecord(scratch);
      assert.equal(missingManifest.ok, false);
      assert.equal(missingManifest.manifestVerified, false);
      assert.match(missingManifest.reason, /^cleanup_refused:manifest_unreadable$/);
      renameSync(join(scratch.root, "manifest.moved-aside"), manifestPath);
    } finally {
      writeFileSync(manifestPath, afterRemovalText, "utf8");
    }
  } finally {
    cleanupScratch(scratch);
  }
  fixtureScope.getStore().checks.push(() => assert.equal(existsSync(scratch.root), false, "恢复 manifest 后专属根必须可清理"));
});

/**
 * 真正的 junction（目录重解析点）拒绝回归。只写不跑：本员工未执行，由管理者复跑。
 * fixture 全部在**本次 workspace 自建、带 manifest** 的目录内，junction 只指向这个自有目标：
 * 不使用系统 TEMP、不指向仓库或任何真实目录、不装软件、不提权。
 * 故意拒绝的 fixture **明确保留并记录**为预期拒绝证据（不用 unlink 等绕过守卫的手工删除修饰结果），
 * 因此它不进通用 after 的「全清」断言。若系统不允许创建 junction 则明确 skip。
 */
test("junction 拒绝：base 祖先为 junction 时不建新子目录，root 内 junction 时登记 / 清理拒绝且哨兵完整", (t) => {
  if (process.platform !== "win32") {
    t.skip("junction 语义只在 Windows 上适用");
    return;
  }
  const fixture = newScratch("junction-fixture");
  const baseTarget = join(fixture.root, "junction-target");
  const baseLink = join(fixture.root, "junction-link");
  const sentinelDir = join(fixture.root, "junction-sentinel");
  const sentinelFile = join(sentinelDir, "keep.txt");
  const work = join(fixture.root, "junction-work");
  const workLink = join(work, "inner-link");
  mkdirSync(baseTarget);
  mkdirSync(sentinelDir);
  writeFileSync(sentinelFile, "keep-me", "utf8");
  mkdirSync(work);
  try {
    // `symlink` + type "junction" 在本机创建目录重解析点（不需要管理员权限）。
    symlinkSync(baseTarget, baseLink, "junction");
    symlinkSync(sentinelDir, workLink, "junction");
  } catch (error) {
    // 系统不允许：明确 skip，不装软件、不提权；已可能建立的重解析点不做手工删除。
    recordExpectedRefusalFixture({ kind: "junction_fixture_unavailable", root: fixture.root, reason: `junction_unavailable:${error?.code ?? "unknown"}` });
    t.skip(`本机不允许创建 junction（${error?.code ?? "unknown"}）`);
    return;
  }

  assert.equal(readdirSync(fixture.root).includes("junction-link"), true);

  // (1) base 祖先是 junction：必须在任何 mkdir 之前拒绝，且不通过 junction 建出新的子目录。
  let baseRefusal = null;
  try {
    createScratchRecord({ label: "junction-child", basePath: join(baseLink, "child"), tool: "windows-delivery-test" });
  } catch (error) {
    baseRefusal = error;
  }
  assert.ok(baseRefusal, "base 祖先为 junction 时必须拒绝创建");
  assert.equal(baseRefusal.code, "scratch_root_ancestor_refused");
  assert.equal(baseRefusal.details?.reason, "reparse_point_in_ancestor_chain");
  // 拒绝发生在任何 mkdir 之前：既没有创建、也就没有回滚 / 保留动作。
  assert.equal(baseRefusal.cleanup ?? null, null, "mkdir 之前拒绝时不得有任何清理 / 回滚动作");
  assert.equal(existsSync(join(baseTarget, "child")), false, "junction 目标下不得出现新子目录");

  // (2) root 内部 junction：junction 本身不得被登记，含 junction 的目录必须拒绝清理。
  assert.ok(trackExistingPath(fixture, work, "junction-work"), "junction 建立前的普通目录可正常登记");
  assert.equal(trackExistingPath(fixture, workLink, "junction-link"), null, "junction 自身不得被登记为删除目标");
  const workRemoval = removeTrackedPath(fixture, work);
  assert.equal(workRemoval.ok, false, "含 junction 的目录必须拒绝清理");
  assert.equal(workRemoval.reason, "cleanup_refused:reparse_point_inside_tree");
  assert.equal(existsSync(work), true, "拒绝时必须保留目录");
  assert.equal(readFileSync(sentinelFile, "utf8"), "keep-me", "junction 目标哨兵必须完整不变");

  const rootRemoval = removeScratchRecord(fixture);
  assert.equal(rootRemoval.ok, false, "含 junction 的专属根必须拒绝整体删除");
  assert.equal(rootRemoval.reason, "cleanup_refused:reparse_point_inside_tree");
  assert.equal(existsSync(fixture.root), true, "预期拒绝的 fixture 明确保留，不再尝试第二次删除");
  assert.equal(readFileSync(sentinelFile, "utf8"), "keep-me", "整根拒绝后哨兵仍完整");

  recordExpectedRefusalFixture({ kind: "junction_inside_root_expected_refusal", root: fixture.root, reason: rootRemoval.reason });
});

test("交付检查：用法错误非零，upgrade-rollback 恒 w2_contract_pending 且无业务副作用", async () => {
  const missing = await capture("delivery-usage", NODE, [DELIVERY_CHECK, "--phase", "install-start", "--release", WORKBENCH], { timeoutMs: 60000 });
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).code, "usage_missing_option");

  const scratch = newScratch("upgrade-blocked");
  try {
    // 创建 scratch 之后的**精确初始项快照**：只有 scratch 自建的 manifest（.wb-scratch-<token>.json）
    // 与默认 tmp。它是「无业务副作用」的基线，之后每轮只允许增加本轮自建的 out-* 目录。
    const baseline = readdirSync(scratch.root).sort();
    const manifestName = baseline.find((name) => name.startsWith(".wb-scratch-") && name.endsWith(".json"));
    assert.ok(manifestName, `scratch 初始项必须含自建 manifest：${JSON.stringify(baseline)}`);
    assert.deepEqual(baseline, [manifestName, "tmp"].sort(), `scratch 初始项只能是自建 manifest 与 tmp：${JSON.stringify(baseline)}`);

    const createdOuts = [];
    for (const extra of [[], ["--schema-pair", "3->4", "--previous-release", WORKBENCH]]) {
      const outName = extra.length === 0 ? "out-nopair" : "out-withpair";
      const out = join(scratch.root, outName);
      createdOuts.push(outName);
      const blocked = await capture("delivery-upgrade-blocked", NODE, [
        DELIVERY_CHECK, "--phase", "upgrade-rollback",
        "--release", WORKBENCH, "--out", out,
        ...extra,
      ], { timeoutMs: 60000 });
      assert.equal(blocked.code, 2, blocked.stderr);
      const payload = JSON.parse(blocked.stdout);
      assert.equal(payload.status, "blocked");
      assert.equal(payload.code, "w2_contract_pending");
      // 两种场景都必须真的实跑：带 --schema-pair 时该参数确实被传入，仍不解除 blocked。
      assert.equal(payload.error?.details?.schemaPairProvided, extra.length > 0, "本轮 --schema-pair 传入状态必须与实参一致");
      assert.ok(existsSync(join(out, "windows-delivery-result.json")));
      assert.equal(payload.cleanup.completed, false);
      assert.equal(payload.cleanup.manifestVerified, false, "--keep 未尝试删除时不得报 manifest 已验证");
      assert.equal(payload.cleanup.retained, false, "upgrade-rollback 不建 scratch，不应声称保留目录");
      // 本轮 out 只允许工具自建的日志 / 产物空目录与结果文件，不出现任何业务内容。
      for (const entry of readdirSync(out)) {
        assert.ok(["artifacts", "logs", "windows-delivery-result.json"].includes(entry), `out 中出现非工具允许项：${entry}`);
      }
      // 精确集合比较：初始项 + 本轮累计自建 out-*，没有 data-*、release-*、node_modules、DB 等业务副作用。
      assert.deepEqual(readdirSync(scratch.root).sort(), [...baseline, ...createdOuts].sort());
    }
  } finally {
    cleanupScratch(scratch);
  }
});

test("冷拷贝检查：拒绝含 node_modules / 私有配置的发布目录", () => {
  const scratch = newScratch("release-dirty");
  try {
    const dir = join(scratch.root, "release");
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), "{}", "utf8");
    writeFileSync(join(dir, "package-lock.json"), "{}", "utf8");
    mkdirSync(join(dir, "server"));
    writeFileSync(join(dir, "server", "server.mjs"), "", "utf8");
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public", "index.html"), "<html></html>", "utf8");
    writeFileSync(join(dir, ".npmrc"), "registry=https://example.invalid/", "utf8");
    assert.throws(() => inspectRelease(dir), (error) => error.code === "release_not_clean");
  } finally {
    cleanupScratch(scratch);
  }
});

test("冷拷贝检查：只跳过明确已知的本任务专属 scratch 目录，剩余 tmp 内容仍然拒绝", () => {
  const scratch = newScratch("release-scratch-exclusion");
  try {
    // 1) tmp 下还有其它内容 → 整棵 tmp 仍按 forbidden 拒绝。
    const foreign = join(scratch.root, "release-foreign");
    const foreignWorkbench = buildReleaseWorkbench(foreign);
    mkdirSync(join(foreignWorkbench, "tmp", "another-run"), { recursive: true });
    writeFileSync(join(foreignWorkbench, "tmp", "another-run", "keep.txt"), "x", "utf8");
    assert.throws(() => inspectRelease(foreign), (error) => error.code === "release_not_clean");

    // 2) 只有文档固定的专属 base（以及里面残留的子目录）→ 只排除这个明确已知的绝对路径。
    const dir = join(scratch.root, "release-known");
    const workbench = buildReleaseWorkbench(dir);
    mkdirSync(join(workbench, "tmp", "windows-delivery", "residual-from-older-run"), { recursive: true });
    const nested = createScratchRecord({ label: "nested-release", basePath: join(workbench, "tmp", "windows-delivery") });
    fixtureScope.getStore().records.add(nested);
    try {
      const inspected = inspectRelease(dir);
      // 报告的是被跳过的最高一层目录（tmp 里只剩这个明确已知的专属 base）。
      assert.deepEqual(inspected.excludedScratch, ["06-workbench/tmp"]);
    } finally {
      cleanupScratch(nested);
      fixtureScope.getStore().checks.push(() => assert.equal(existsSync(nested.root), false, "nested manifest cleanup must succeed"));
    }
  } finally {
    cleanupScratch(scratch);
  }
});

test("冷拷贝检查：只排除显式传入的本次 scratch 绝对路径，相对路径不构成排除依据", () => {
  const scratch = newScratch("release-explicit-scratch");
  try {
    const dir = join(scratch.root, "release");
    const workbench = buildReleaseWorkbench(dir);
    const knownRun = join(workbench, "tmp", "known-run-2026");
    mkdirSync(knownRun, { recursive: true });
    writeFileSync(join(knownRun, "artifact.txt"), "x", "utf8");

    assert.throws(() => inspectRelease(dir), (error) => error.code === "release_not_clean");
    assert.throws(() => inspectRelease(dir, { excludeScratch: ["tmp/known-run-2026"] }), (error) => error.code === "release_not_clean");
    const inspected = inspectRelease(dir, { excludeScratch: [knownRun] });
    assert.deepEqual(inspected.excludedScratch, ["06-workbench/tmp"]);
  } finally {
    cleanupScratch(scratch);
  }
});

test("启动脚本：Windows PowerShell 5.1 下有界启动、跟踪 service pid、真实 HTTP、退出码 124", async (t) => {
  if (!existsSync(PS5)) {
    t.skip("Windows PowerShell 5.1 unavailable");
    return;
  }
  const scratch = newScratch("start-script");
  const wrapperState = trackChild("powershell-wrapper-and-service");
  let child = null;
  let wrapperExited = false;
  let serviceStopped = false;
  let servicePid = null;
  try {
    const dataDir = join(scratch.root, "数据 目录");
    child = spawn(PS5, [
      "-NoProfile", "-File", START_SCRIPT,
      "-NodePath", NODE, "-DataDir", dataDir, "-Port", "0", "-MaxRunSeconds", "4",
      "-ScratchRoot", scratch.root,
    ], {
      cwd: WORKBENCH,
      env: childEnvironment(scratch.root, { TEMP: join(scratch.root, "tmp"), TMP: join(scratch.root, "tmp") }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const exitPromise = new Promise((resolvePromise) => child.once("close", (code, signal) => {
      wrapperExited = true;
      resolvePromise({ code, signal });
    }));
    const port = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("start_script_timeout")), 20000);
      child.once("exit", (code) => { clearTimeout(timer); rejectPromise(new Error(`start_script_exited:${code}`)); });
      child.once("error", (error) => { clearTimeout(timer); rejectPromise(new Error(`start_script_spawn_failed:${error?.code ?? "unknown"}`)); });
      child.stdout.on("data", () => {
        const pidMatch = /windows_start_service_pid=(\d+)/.exec(stdout);
        if (pidMatch) servicePid = Number(pidMatch[1]);
        const match = /127\.0\.0\.1:(\d+)\//.exec(stdout);
        if (match) { clearTimeout(timer); resolvePromise(Number(match[1])); }
      });
    });
    const response = await fetchJson(`http://127.0.0.1:${port}`, "/api/account-sets");
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, []);
    assert.ok(servicePid !== null, "launcher must print the tracked service pid");
    const exited = await Promise.race([exitPromise, delay(40000).then(() => null)]);
    assert.equal(exited?.code, 124, `${stdout}\n${stderr}`);
    assert.ok(existsSync(join(dataDir, "workbench.db")));
    // 正常成功必须无残留：包装器用自己的 Process 句柄停服务，测试**不做裸 PID 兜底**。
    // 这里用“该端口不再响应”证明服务已停（比 PID 存活探测更稳，且不涉进程身份）。
    const serviceGone = async () => {
      try {
        await fetchJson(`http://127.0.0.1:${port}`, "/api/account-sets");
        return false;
      } catch {
        return true;
      }
    };
    let stopped = await serviceGone();
    for (let attempt = 0; attempt < 20 && !stopped; attempt += 1) {
      await delay(150);
      stopped = await serviceGone();
    }
    serviceStopped = stopped;
    assert.equal(stopped, true, "包装器自停后该端口不得再响应（测试不按 PID 猜杀）");
  } finally {
    // 异常路径（含外层终止包装器）：只停止本人创建的包装器句柄。
    // 服务 pid 只能如实记录，不用裸 PID 猜杀（PID 可能已被复用，端口可达也不证明身份）；
    // 正式路径下服务由包装器在 -MaxRunSeconds 到期时用自有句柄回收。
    if (child && !wrapperExited) {
      fixtureScope.getStore().reasons.push("wrapper_aborted_service_reclamation_unknown");
      try { child.kill(); } catch { /* ignore */ }
      const done = await Promise.race([delay(KILL_GRACE_MS).then(() => null), new Promise((resolveExit) => child.once("close", () => resolveExit({ reclaimed: true })))]);
      if (!done) residuals.push({ label: "powershell-wrapper", pid: child.pid ?? null, kind: "wrapper" });
      if (servicePid !== null) residuals.push({ label: "powershell-wrapper-service", pid: servicePid, kind: "service", reason: "wrapper_aborted_pid_recorded_not_force_killed" });
    }
    wrapperState.reclaimed = wrapperExited && serviceStopped;
    if (!wrapperState.reclaimed) fixtureScope.getStore().reasons.push("wrapper_or_service_not_confirmed_reclaimed");
    cleanupScratch(scratch);
  }
});

test("启动脚本：-Help 不启动服务并退出 0", async (t) => {
  if (!existsSync(PS5)) {
    t.skip("Windows PowerShell 5.1 unavailable");
    return;
  }
  const result = await capture("start-help", PS5, ["-NoProfile", "-File", START_SCRIPT, "-Help"], { timeoutMs: 60000 });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /HOST is always 127\.0\.0\.1/);
  assert.match(result.stdout, /windows_start_service_pid=/);
});

test("启动脚本：非法数据目录在创建数据库前被拒绝", async (t) => {
  if (!existsSync(PS5)) {
    t.skip("Windows PowerShell 5.1 unavailable");
    return;
  }
  const scratch = newScratch("start-bad-dir");
  try {
    const file = join(scratch.root, "data-file");
    writeFileSync(file, "keep-me", "utf8");
    const result = await capture("start-bad-dir", PS5, ["-NoProfile", "-File", START_SCRIPT, "-NodePath", NODE, "-DataDir", file, "-Port", "0", "-ScratchRoot", scratch.root], { timeoutMs: 120000 });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /runtime_check_rejected:data_dir_not_directory/);
    assert.equal(readFileSync(file, "utf8"), "keep-me");
  } finally {
    cleanupScratch(scratch);
  }
});

test("端口冲突：本次占位 listener 不被连接，服务以非零退出", async () => {
  const scratch = newScratch("port-conflict");
  const listener = createServer();
  let connections = 0;
  listener.on("connection", () => { connections += 1; });
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      listener.once("error", rejectPromise);
      listener.listen(0, "127.0.0.1", resolvePromise);
    });
    const port = listener.address().port;
    const result = await capture("port-conflict", NODE, [SERVER], {
      env: minimalEnv({
        TEMP: join(scratch.root, "tmp"),
        TMP: join(scratch.root, "tmp"),
        HOST: "127.0.0.1",
        PORT: String(port),
        WORKBENCH_DATA_DIR: join(scratch.root, "data"),
      }),
      timeoutMs: 60000,
    });
    assert.notEqual(result.code, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.stderr, /EADDRINUSE/);
    assert.equal(connections, 0);
  } finally {
    await new Promise((resolvePromise) => listener.close(resolvePromise));
    cleanupScratch(scratch);
  }
});

test("关键成功链：HTTP 导入两月、重启幂等、金额正确、运行中备份可恢复", async (t) => {
  const scratch = newScratch("success-chain");
  const dataDir = join(scratch.root, "data 目录");
  let server = null;
  try {
    server = await startServer(dataDir, scratch);
    const setId = await importTwoMonths(server);
    await assertAmounts(server, setId);

    // Consistent backup while the service is running (committed WAL included).
    const backupDir = join(scratch.root, "backups", "b1");
    mkdirSync(join(scratch.root, "backups"), { recursive: true });
    const backup = await capture("local-backup backup", NODE, [join(WORKBENCH, "scripts", "local-backup.mjs"), "backup", "--db", join(dataDir, "workbench.db"), "--out", backupDir], { timeoutMs: 120000 });
    assert.equal(backup.code, 0, backup.stderr);
    assert.equal(JSON.parse(backup.stdout).ok, true);
    const verify = await capture("local-backup verify", NODE, [join(WORKBENCH, "scripts", "local-backup.mjs"), "verify", "--backup", backupDir], { timeoutMs: 120000 });
    assert.equal(verify.code, 0, verify.stderr);
    const restoreDir = join(scratch.root, "restored");
    const restore = await capture("local-backup restore-new", NODE, [join(WORKBENCH, "scripts", "local-backup.mjs"), "restore-new", "--backup", backupDir, "--target", restoreDir], { timeoutMs: 120000 });
    assert.equal(restore.code, 0, restore.stderr);
    const db = new DatabaseSync(join(restoreDir, "workbench.db"), { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM vouchers").get().n, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM import_batch_vouchers").get().n, 2);
    } finally {
      db.close();
    }

    const firstStop = await server.stop();
    assert.equal(firstStop.reclaimed, true, "first server must be reclaimed before restarting");
    server = null;

    // Restart on the same data directory: batch identity and amounts survive.
    server = await startServer(dataDir, scratch);
    const sets = await server.get("/api/account-sets");
    assert.equal(sets.json.length, 1);
    assert.equal(sets.json[0].id, setId);
    const replay = await server.post("/api/import/incremental", { batchId: "TEST-2026-01", source: SOURCE, payload: JAN, dryRun: false });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.status, "idempotent_replay");
    const batch = await server.get("/api/import/batches/TEST-2026-01");
    assert.equal(batch.json.batch.status, "completed");
    assert.equal(batch.json.sourceTrace[0].sourceVoucherId, "TEST-SRC-1");
    await assertAmounts(server, setId);
  } finally {
    if (server) {
      const stopped = await server.stop();
      if (!stopped.reclaimed) fixtureScope.getStore().reasons.push("success_chain_server_unreclaimed");
    }
    cleanupScratch(scratch);
  }
});

// ================================================================== 独审返修回归

/** 管理者可选前置：用量型用例缺这些输入就明确 skip，不用任何 mock 冒充成功。 */
const HEAVY = {
  release: (process.env.WINDOWS_DELIVERY_RELEASE_ROOT ?? "").trim(),
  npm: (process.env.WINDOWS_DELIVERY_NPM_ENTRY ?? "").trim(),
  cache: (process.env.WINDOWS_DELIVERY_NPM_CACHE ?? "").trim(),
  node: (process.env.WINDOWS_DELIVERY_NODE_BINARY ?? "").trim() || NODE,
};
const HEAVY_SKIP = "需要管理者前置：WINDOWS_DELIVERY_RELEASE_ROOT / WINDOWS_DELIVERY_NPM_ENTRY / WINDOWS_DELIVERY_NPM_CACHE（可选 WINDOWS_DELIVERY_NODE_BINARY）";
const REQUIRED_PDF_ASSERTIONS = REQUIRED_OFFICE_KINDS.map((kind) => `office.pdf.${kind}`);

test("路径字符串边界：只认盘符绝对与完整 UNC，拒绝不完整 UNC / 设备路径（含斜杠变体）/ 相对与 drive-relative", () => {
  const fixture = newScratch("raw-path-string");
  try {
    // 正常绝对路径必须成功（不因新增判定误拒）。
    const validDrive = inspectRawAbsolutePath(fixture.root);
    assert.equal(validDrive.ok, true, JSON.stringify(validDrive));
    assert.equal(pathKeyOf(validDrive.resolved), pathKeyOf(fixture.root));
    assert.equal(inspectRawAbsolutePath("C:\\work\\release").ok, true);
    // 完整 UNC（server + share）是字符串级判定：不连接网络、不 lstat。
    const unc = inspectRawAbsolutePath("\\\\server\\share\\release");
    assert.equal(unc.ok, true, JSON.stringify(unc));
    assert.equal(unc.volumeRoot, "\\\\server\\share\\");
    assert.equal(inspectRawAbsolutePath("//server/share/release").ok, true);

    const rejections = [
      { name: "empty", raw: "", reason: "path_empty" },
      { name: "blank", raw: "   ", reason: "path_empty" },
      { name: "edge-space", raw: ` ${fixture.root} `, reason: "path_has_whitespace_edges" },
      { name: "relative", raw: `foo\\bar-${process.pid}`, reason: "path_not_absolute" },
      { name: "drive-relative", raw: `C:foo-bar-${process.pid}`, reason: "drive_relative_not_allowed" },
      { name: "root-relative", raw: `\\foo-bar-${process.pid}`, reason: "root_relative_not_allowed" },
      { name: "root-relative-forward", raw: `/foo-bar-${process.pid}`, reason: "root_relative_not_allowed" },
      { name: "unc-no-share", raw: "\\\\server", reason: "unc_incomplete" },
      { name: "unc-trailing-sep", raw: "\\\\server\\", reason: "unc_incomplete" },
      { name: "unc-empty", raw: "\\\\", reason: "unc_incomplete" },
      { name: "unc-forward-no-share", raw: "//server", reason: "unc_incomplete" },
      { name: "device-question", raw: "\\\\?\\C:\\work", reason: "device_path_not_allowed" },
      { name: "device-dot", raw: "\\\\.\\pipe\\x", reason: "device_path_not_allowed" },
      { name: "device-forward-question", raw: "//?/C:/work", reason: "device_path_not_allowed" },
      { name: "device-forward-dot", raw: "//./pipe/x", reason: "device_path_not_allowed" },
      { name: "device-unc-namespace", raw: "\\\\?\\UNC\\server\\share", reason: "device_path_not_allowed" },
      { name: "device-mixed-slash", raw: "\\/?\\x", reason: "device_path_not_allowed" },
      { name: "unc-invalid-host", raw: "\\/?.\\x", reason: "unc_invalid_name" },
    ];
    for (const item of rejections) {
      const result = inspectRawAbsolutePath(item.raw);
      assert.equal(result.ok, false, `${item.name} 必须被拒绝`);
      assert.equal(result.reason, item.reason, `${item.name}: ${JSON.stringify(result)}`);
      assert.equal(result.resolved, null, `${item.name} 拒绝时不得给出规范化结果`);
    }
  } finally {
    cleanupScratch(fixture);
  }
});

test("路径守卫：out / release 原始入参不是完整绝对路径时只 stdout 非零，不创建任何目录（真实 CLI，自有 cwd 与候选目标）", async () => {
  const scratch = newScratch("path-raw-absolute");
  try {
    // 子进程 cwd 始终显式指定为本用例自有目录（不依赖默认 cwd、不用 process.chdir）。
    const cliCwd = join(scratch.root, "cli-cwd");
    mkdirSync(cliCwd);
    const outCases = [
      { name: "relative", reason: "path_not_absolute" },
      { name: "drive-relative", reason: "drive_relative_not_allowed" },
      { name: "root-relative", reason: "root_relative_not_allowed" },
    ];
    for (const item of outCases) {
      // 候选 out 只在本用例 scratch 内；relative / drive-relative / root-relative 已断言误规范化落点。
      const candidate = join(scratch.root, `out-candidate-${item.name}`);
      const raw = rawPathVariants(candidate, { fixtureRoot: scratch.root, cwdDir: cliCwd })[item.name];
      const before = snapshotDir(scratch.root);
      const result = await capture(`delivery-raw-out-${item.name}`, NODE, [DELIVERY_CHECK, "--phase", "upgrade-rollback", "--release", WORKBENCH, "--out", raw], { cwd: cliCwd, timeoutMs: 60000 });
      assert.equal(result.code, 1, `${item.name}: ${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, false);
      assert.equal(payload.status, "rejected");
      assert.equal(payload.code, "out_not_absolute");
      assert.equal(payload.details.reason, item.reason);
      // 只写 stdout：不为记录失败先建未验证的 out，也没有结果 JSON 落地。
      assert.doesNotMatch(result.stdout, /windows-delivery-result\.json/);
      assert.equal(existsSync(candidate), false, `${item.name} out 候选目标不得被创建`);
      assert.deepEqual(snapshotDir(cliCwd), [], `${item.name} 拒绝时子进程 cwd 内不得出现任何自建条目`);
      assert.deepEqual(snapshotDir(scratch.root), before, `${item.name} 拒绝后父目录快照必须不变`);
    }

    // release 原始入参同样拒绝，而且拒绝发生在 out 创建之前。
    const releaseCandidate = join(scratch.root, "release-candidate");
    const rawRelease = rawPathVariants(releaseCandidate, { fixtureRoot: scratch.root, cwdDir: cliCwd }).relative;
    const out = join(scratch.root, "out-not-created");
    const releaseCase = await capture("delivery-raw-release", NODE, [DELIVERY_CHECK, "--phase", "upgrade-rollback", "--release", rawRelease, "--out", out], { cwd: cliCwd, timeoutMs: 60000 });
    assert.equal(releaseCase.code, 1, releaseCase.stderr);
    const releasePayload = JSON.parse(releaseCase.stdout);
    assert.equal(releasePayload.status, "rejected");
    assert.equal(releasePayload.code, "release_not_absolute");
    assert.equal(existsSync(releaseCandidate), false, "release 相对候选目标不得被创建");
    assert.equal(existsSync(out), false, "release 被拒绝时不得先创建 out");
  } finally {
    cleanupScratch(scratch);
  }
});

test("路径守卫：out 根 / 祖先 junction 在任何写入前被拒绝（真实 CLI，自有 fixture）", async (t) => {
  if (process.platform !== "win32") {
    t.skip("junction 语义只在 Windows 上适用");
    return;
  }
  const fixture = newScratch("path-out-alias");
  const releaseDir = join(fixture.root, "release-real");
  buildReleaseWorkbench(releaseDir);
  const outTarget = join(fixture.root, "out-target");
  const outAncestorTarget = join(fixture.root, "out-ancestor-target");
  const outRootLink = join(fixture.root, "out-alias");
  const outAncestorLink = join(fixture.root, "out-ancestor-alias");
  mkdirSync(outTarget);
  mkdirSync(outAncestorTarget);
  // 子进程 cwd 显式指定为用例自有目录（不依赖默认 cwd）。
  const cliCwd = join(fixture.root, "cli-cwd");
  mkdirSync(cliCwd);
  try {
    // junction 只指向本测试在同一个自有根内创建的目标。
    symlinkSync(outTarget, outRootLink, "junction");
    symlinkSync(outAncestorTarget, outAncestorLink, "junction");
  } catch (error) {
    recordExpectedRefusalFixture({ kind: "out_junction_fixture_unavailable", root: fixture.root, reason: `junction_unavailable:${error?.code ?? "unknown"}` });
    t.skip(`本机不允许创建 junction（${error?.code ?? "unknown"}）`);
    return;
  }
  const refusals = [];
  try {
    // (1) out 自身是 junction（reviewer 的 out-alias 形态）：不得经链接写入目标。
    const rootCase = await capture("delivery-out-alias", NODE, [DELIVERY_CHECK, "--phase", "upgrade-rollback", "--release", releaseDir, "--out", outRootLink], { cwd: cliCwd, timeoutMs: 60000 });
    assert.notEqual(rootCase.code, 0, "out 为 junction 时必须非零退出");
    const rootPayload = JSON.parse(rootCase.stdout);
    assert.equal(rootPayload.status, "rejected");
    assert.match(String(rootPayload.code), /^out_/);
    assert.match(String(rootPayload.details?.reason ?? ""), /reparse_point|realpath/);
    assert.deepEqual(readdirSync(outTarget), [], "不得通过 out junction 在目标里写任何东西");
    refusals.push(`${rootPayload.code}:${rootPayload.details?.reason ?? ""}`);

    // (2) out 的更深层经祖先 junction 逃逸（reviewer 的 out-alias/escaped 形态）。
    const escaped = join(outAncestorLink, "escaped");
    const ancestorCase = await capture("delivery-out-alias-escaped", NODE, [DELIVERY_CHECK, "--phase", "upgrade-rollback", "--release", releaseDir, "--out", escaped], { cwd: cliCwd, timeoutMs: 60000 });
    assert.notEqual(ancestorCase.code, 0);
    const ancestorPayload = JSON.parse(ancestorCase.stdout);
    assert.equal(ancestorPayload.status, "rejected");
    assert.match(String(ancestorPayload.code), /^out_/);
    assert.equal(existsSync(join(outAncestorTarget, "escaped")), false, "不得经祖先 junction 新建目录");
    assert.deepEqual(readdirSync(outAncestorTarget), []);
    refusals.push(`${ancestorPayload.code}:${ancestorPayload.details?.reason ?? ""}`);

    // (3) 拒绝时不得写“未验证的 out”：两个目标里都没有结果 JSON / logs / artifacts。
    for (const dir of [outTarget, outAncestorTarget]) {
      const entries = readdirSync(dir);
      assert.deepEqual(entries.filter((name) => ["windows-delivery-result.json", "logs", "artifacts"].includes(name)), []);
    }

    // (4) 同一守卫在库内直接调用也拒绝（不靠 CLI 的调用顺序）。
    assert.throws(() => prepareOutDir(outRootLink), (error) => /^out_/.test(String(error?.code)));
  } finally {
    // 含 junction 的 fixture 按规则保留（不用 unlink / 手工删除修饰结果）。
    recordExpectedRefusalFixture({ kind: "out_junction_expected_refusal", root: fixture.root, reason: refusals.join(",") || "out_alias_refused" });
  }
});

test("路径守卫：release 根 / 祖先 junction 被拒绝且不创建 out（真实 CLI + inspectRelease）", async (t) => {
  if (process.platform !== "win32") {
    t.skip("junction 语义只在 Windows 上适用");
    return;
  }
  const fixture = newScratch("path-release-alias");
  const realRelease = join(fixture.root, "release-real");
  const nestedParent = join(fixture.root, "release-parent");
  const nestedRelease = join(nestedParent, "release-nested");
  buildReleaseWorkbench(realRelease);
  mkdirSync(nestedParent);
  buildReleaseWorkbench(nestedRelease);
  const releaseLink = join(fixture.root, "release-alias");
  const parentLink = join(fixture.root, "release-parent-alias");
  // 子进程 cwd 显式指定为用例自有目录（不依赖默认 cwd）。
  const cliCwd = join(fixture.root, "cli-cwd");
  mkdirSync(cliCwd);
  try {
    symlinkSync(realRelease, releaseLink, "junction");
    symlinkSync(nestedParent, parentLink, "junction");
  } catch (error) {
    recordExpectedRefusalFixture({ kind: "release_junction_fixture_unavailable", root: fixture.root, reason: `junction_unavailable:${error?.code ?? "unknown"}` });
    t.skip(`本机不允许创建 junction（${error?.code ?? "unknown"}）`);
    return;
  }
  const refusals = [];
  try {
    // (1) release 自身是 junction（reviewer 的 source-alias 形态）。
    const outRoot = join(fixture.root, "out-should-not-exist");
    const rootCase = await capture("delivery-release-alias", NODE, [DELIVERY_CHECK, "--phase", "upgrade-rollback", "--release", releaseLink, "--out", outRoot], { cwd: cliCwd, timeoutMs: 60000 });
    assert.notEqual(rootCase.code, 0);
    const rootPayload = JSON.parse(rootCase.stdout);
    assert.equal(rootPayload.status, "rejected");
    assert.equal(rootPayload.code, "release_is_reparse_point");
    assert.equal(existsSync(outRoot), false, "拒绝时不得先创建未验证的 out");
    refusals.push(rootPayload.code);

    // (2) release 的祖先目录是 junction。
    const outAncestor = join(fixture.root, "out-ancestor-should-not-exist");
    const ancestorCase = await capture("delivery-release-ancestor-alias", NODE, [DELIVERY_CHECK, "--phase", "upgrade-rollback", "--release", join(parentLink, "release-nested"), "--out", outAncestor], { cwd: cliCwd, timeoutMs: 60000 });
    assert.notEqual(ancestorCase.code, 0);
    const ancestorPayload = JSON.parse(ancestorCase.stdout);
    assert.equal(ancestorPayload.status, "rejected");
    assert.equal(ancestorPayload.code, "release_ancestor_refused");
    assert.match(String(ancestorPayload.details?.reason ?? ""), /reparse_point|realpath/);
    assert.equal(existsSync(outAncestor), false);
    refusals.push(`${ancestorPayload.code}:${ancestorPayload.details?.reason ?? ""}`);

    // (3) 库内直接调用同样拒绝（扫描 / 复制前）。
    assert.throws(() => inspectRelease(releaseLink), (error) => error?.code === "release_is_reparse_point");
    assert.throws(() => inspectRelease(join(parentLink, "release-nested")), (error) => error?.code === "release_ancestor_refused");
  } finally {
    recordExpectedRefusalFixture({ kind: "release_junction_expected_refusal", root: fixture.root, reason: refusals.join(",") || "release_alias_refused" });
  }
});

test("路径守卫：scratch base 根 / 祖先 junction 与显式空白都在 out 创建前被拒绝（真实 CLI，自有 fixture）", async (t) => {
  if (process.platform !== "win32") {
    t.skip("junction 语义只在 Windows 上适用");
    return;
  }
  const fixture = newScratch("path-scratch-alias");
  const releaseDir = join(fixture.root, "release-real");
  buildReleaseWorkbench(releaseDir);
  const scratchRootTarget = join(fixture.root, "scratch-target");
  const scratchAncestorTarget = join(fixture.root, "scratch-ancestor-target");
  mkdirSync(scratchRootTarget);
  mkdirSync(scratchAncestorTarget);
  const scratchRootLink = join(fixture.root, "scratch-alias");
  const scratchAncestorLink = join(fixture.root, "scratch-ancestor-alias");
  try {
    // junction 只指向本测试在同一自有根内创建的目标。
    symlinkSync(scratchRootTarget, scratchRootLink, "junction");
    symlinkSync(scratchAncestorTarget, scratchAncestorLink, "junction");
  } catch (error) {
    recordExpectedRefusalFixture({ kind: "scratch_junction_fixture_unavailable", root: fixture.root, reason: `junction_unavailable:${error?.code ?? "unknown"}` });
    t.skip(`本机不允许创建 junction（${error?.code ?? "unknown"}）`);
    return;
  }
  const cwd = join(fixture.root, "cli-cwd");
  mkdirSync(cwd);
  const refusals = [];
  try {
    // (1) scratch base 自身是 junction：必须在 out mkdir 之前拒绝，否则会先写 out 再在
    // createScratchRecord 才拒绝。
    const outRoot = join(fixture.root, "out-after-bad-scratch-root");
    const rootBefore = snapshotDir(fixture.root);
    const rootCase = await capture("delivery-scratch-root-alias", NODE, [
      DELIVERY_CHECK, "--phase", "upgrade-rollback", "--release", releaseDir, "--out", outRoot, "--scratch-root", scratchRootLink,
    ], { cwd, timeoutMs: 60000 });
    assert.notEqual(rootCase.code, 0, "scratch base 为 junction 时必须非零退出");
    const rootPayload = JSON.parse(rootCase.stdout);
    assert.equal(rootPayload.status, "rejected");
    assert.equal(rootPayload.code, "scratch_root_ancestor_refused");
    assert.equal(rootPayload.details?.reason, "reparse_point_in_ancestor_chain");
    assert.equal(existsSync(outRoot), false, "无效 scratch 拒绝时 out 不得被创建");
    assert.deepEqual(snapshotDir(scratchRootTarget), [], "不得经 scratch junction 目标写入任何东西");
    assert.deepEqual(snapshotDir(fixture.root), rootBefore, "拒绝时 fixture 不得出现新条目");
    refusals.push(rootPayload.code);

    // (2) scratch base 的祖先目录是 junction。
    const outAncestor = join(fixture.root, "out-after-bad-scratch-ancestor");
    const ancestorCase = await capture("delivery-scratch-ancestor-alias", NODE, [
      DELIVERY_CHECK, "--phase", "upgrade-rollback", "--release", releaseDir, "--out", outAncestor, "--scratch-root", join(scratchAncestorLink, "child"),
    ], { cwd, timeoutMs: 60000 });
    assert.notEqual(ancestorCase.code, 0);
    const ancestorPayload = JSON.parse(ancestorCase.stdout);
    assert.equal(ancestorPayload.status, "rejected");
    assert.equal(ancestorPayload.code, "scratch_root_ancestor_refused");
    assert.equal(ancestorPayload.details?.reason, "reparse_point_in_ancestor_chain");
    assert.equal(existsSync(outAncestor), false, "无效 scratch 拒绝时 out 不得被创建");
    assert.equal(existsSync(join(scratchAncestorTarget, "child")), false, "不得经祖先 junction 新建目录");
    assert.deepEqual(snapshotDir(scratchAncestorTarget), []);
    refusals.push(`${ancestorPayload.code}:${ancestorPayload.details?.reason ?? ""}`);

    // (3) 显式空白 scratch root 同样在 out 创建前被拒绝（不静默退回默认根）。
    const outBlank = join(fixture.root, "out-after-blank-scratch");
    const blankBefore = snapshotDir(fixture.root);
    const blankCase = await capture("delivery-scratch-blank", NODE, [
      DELIVERY_CHECK, "--phase", "upgrade-rollback", "--release", releaseDir, "--out", outBlank, "--scratch-root", "   ",
    ], { cwd, timeoutMs: 60000 });
    assert.equal(blankCase.code, 1, blankCase.stderr);
    const blankPayload = JSON.parse(blankCase.stdout);
    assert.equal(blankPayload.status, "rejected");
    assert.equal(blankPayload.code, "scratch_root_not_absolute");
    assert.equal(blankPayload.details.reason, "path_empty");
    assert.equal(blankPayload.details.explicitScratchRoot, true, "显式空白不得被当作未提供");
    assert.equal(existsSync(outBlank), false, "scratch 被拒绝时不得先创建 out");
    assert.deepEqual(snapshotDir(fixture.root), blankBefore, "拒绝后 fixture 快照必须不变");
    refusals.push(`${blankPayload.code}:${blankPayload.details.reason}`);

    // (4) 同一守卫在库内直接调用也拒绝（不依赖 CLI 调用顺序）。
    assert.equal(auditScratchBase(scratchRootLink).code, "scratch_root_ancestor_refused");
    assert.equal(auditScratchBase(scratchRootLink).reason, "reparse_point_in_ancestor_chain");
    assert.equal(auditScratchBase(join(scratchAncestorLink, "child")).code, "scratch_root_ancestor_refused");
    assert.equal(auditScratchBase(join(scratchAncestorLink, "child")).reason, "reparse_point_in_ancestor_chain");
    assert.equal(auditScratchBase("   ").code, "scratch_root_not_absolute");
    // 正常绝对 scratch base 仍通过（不放宽正向路径）。
    const okBase = join(fixture.root, "ok-base");
    mkdirSync(okBase);
    assert.equal(auditScratchBase(okBase).ok, true);
  } finally {
    // 含 junction 的 fixture 按规则保留（不用 unlink / 手工删除修饰结果）。
    recordExpectedRefusalFixture({ kind: "scratch_junction_expected_refusal", root: fixture.root, reason: refusals.join(",") || "scratch_alias_refused" });
  }
});

test("冷拷贝入口：源根 / 选定 workbench / 目标 alias 与越界目标被拒绝且不写目标（自有 fixture）", async (t) => {
  if (process.platform !== "win32") {
    t.skip("junction 语义只在 Windows 上适用");
    return;
  }
  const fixture = newScratch("copy-release-entry");
  const releaseDir = join(fixture.root, "release-real");
  buildReleaseWorkbench(releaseDir);
  // 历史 inspected 对象来自真实 inspectRelease，但入口不信任它。
  const inspected = inspectRelease(releaseDir);
  const destTarget = join(fixture.root, "dest-target");
  const destAncestorTarget = join(fixture.root, "dest-ancestor-target");
  mkdirSync(destTarget);
  mkdirSync(destAncestorTarget);
  const sourceLink = join(fixture.root, "release-alias");
  const destLink = join(fixture.root, "dest-alias");
  const destAncestorLink = join(fixture.root, "dest-ancestor-alias");
  try {
    symlinkSync(releaseDir, sourceLink, "junction");
    symlinkSync(destTarget, destLink, "junction");
    symlinkSync(destAncestorTarget, destAncestorLink, "junction");
  } catch (error) {
    recordExpectedRefusalFixture({ kind: "copy_entry_junction_unavailable", root: fixture.root, reason: `junction_unavailable:${error?.code ?? "unknown"}` });
    t.skip(`本机不允许创建 junction（${error?.code ?? "unknown"}）`);
    return;
  }
  const refusals = [];
  try {
    // (1) 源根 alias：入口必须重新核验源根，不信任历史 inspectRelease 结果。
    const aliasRootDest = join(fixture.root, "copy-from-alias-root");
    assert.throws(
      () => copyReleaseWhitelist({ ...inspected, root: sourceLink }, aliasRootDest),
      (error) => error?.code === "copy_source_root_is_reparse_point",
      "源根 alias 必须在复制前被拒绝",
    );
    assert.equal(existsSync(aliasRootDest), false, "源根被拒绝时不得创建目标");
    refusals.push("copy_source_root_is_reparse_point");

    // (2) 选定 workbench 经 junction 逃逸。
    const aliasWorkbenchDest = join(fixture.root, "copy-from-alias-workbench");
    let workbenchCode = null;
    try {
      copyReleaseWhitelist({ ...inspected, workbenchDir: join(sourceLink, "06-workbench") }, aliasWorkbenchDest);
    } catch (error) {
      workbenchCode = error?.code ?? null;
    }
    assert.match(String(workbenchCode), /^copy_source_workbench_/, "选定 workbench alias 必须被拒绝");
    refusals.push(String(workbenchCode));

    // (3) 目标自身是 junction：不得经目标 alias 写入。
    assert.throws(
      () => copyReleaseWhitelist(inspected, destLink),
      (error) => error?.code === "copy_destination_is_reparse_point",
    );
    assert.deepEqual(snapshotDir(destTarget), [], "不得经目标 junction 写入任何内容");
    refusals.push("copy_destination_is_reparse_point");

    // (4) 目标的祖先目录是 junction。
    assert.throws(
      () => copyReleaseWhitelist(inspected, join(destAncestorLink, "copy")),
      (error) => error?.code === "copy_destination_refused",
    );
    assert.deepEqual(snapshotDir(destAncestorTarget), []);
    assert.equal(existsSync(join(destAncestorTarget, "copy")), false);
    refusals.push("copy_destination_refused");

    // (5) 目标在源根内 / 目标已存在。
    const insideSource = join(releaseDir, "copy-inside-source");
    assert.throws(
      () => copyReleaseWhitelist(inspected, insideSource),
      (error) => error?.code === "copy_destination_inside_source",
    );
    assert.equal(existsSync(insideSource), false);
    refusals.push("copy_destination_inside_source");
    const existingDest = join(fixture.root, "dest-existing");
    mkdirSync(existingDest);
    assert.throws(
      () => copyReleaseWhitelist(inspected, existingDest),
      (error) => error?.code === "copy_destination_exists",
    );
    assert.deepEqual(snapshotDir(existingDest), [], "目标已存在时不得写入");
    refusals.push("copy_destination_exists");

    // (6) 正常绝对目标仍成功（不放宽正向路径）。
    const okDest = join(fixture.root, "dest-ok");
    const copied = copyReleaseWhitelist(inspected, okDest);
    assert.equal(copied.destRoot, okDest);
    assert.equal(copied.digest, inspected.digest);
    assert.equal(existsSync(join(copied.workbenchDir, "package.json")), true);
    assert.deepEqual(copied.optionalMissing.sort(), ["scripts/windows-delivery-check.mjs", "scripts/windows-runtime-check.mjs", "scripts/windows-start.ps1", "scripts/local-backup.mjs", "test/windows-delivery.test.mjs"].sort());
  } finally {
    // 含 junction 的 fixture 按规则保留。
    recordExpectedRefusalFixture({ kind: "copy_entry_expected_refusal", root: fixture.root, reason: refusals.join(",") || "copy_entry_guards" });
  }
});

test("Office 汇总：必需 PDF 缺失必须归类为 blocked，不得当作通过", () => {
  const complete = new Map(REQUIRED_OFFICE_KINDS.map((kind) => [kind, { pdf: { bytes: 10, pages: 1, magic: "%PDF-" } }]));
  assert.deepEqual(classifyOfficeOutputs(complete), { required: 5, rendered: 5, requiredBlocked: [] });

  const partial = new Map(complete);
  partial.set("trial-balance", { pdf: null, pdfError: "pdf_font_unavailable" });
  const blocked = classifyOfficeOutputs(partial);
  assert.equal(blocked.required, 5);
  assert.equal(blocked.rendered, 4);
  assert.deepEqual(blocked.requiredBlocked, [{ kind: "trial-balance", code: "pdf_font_unavailable" }]);

  const missingReport = classifyOfficeOutputs(new Map(), ["trial-balance", "ledger"]);
  assert.deepEqual(missingReport.requiredBlocked, [
    { kind: "trial-balance", code: "pdf_render_failed" },
    { kind: "ledger", code: "pdf_render_failed" },
  ]);
});

test("缺字体必需 PDF：真实 install-start CLI 退出 2 / blocked，输出与工作根保留（管理者前置）", async (t) => {
  if (HEAVY.release === "" || HEAVY.npm === "" || HEAVY.cache === "") {
    t.skip(HEAVY_SKIP);
    return;
  }
  const scratch = newScratch("missing-font-cli");
  let runStarted = false;
  let retainedRoot = null;
  try {
    const out = join(scratch.root, "out-font");
    const scratchBaseForRun = join(scratch.root, "cli-scratch");
    mkdirSync(scratchBaseForRun);
    const missingFont = join(scratch.root, "deliberately-missing-font.ttf");
    assert.equal(existsSync(missingFont), false, "缺字体用例必须用真的不存在的字体文件");
    runStarted = true;
    const result = await capture("delivery-missing-font", HEAVY.node, [
      DELIVERY_CHECK, "--phase", "install-start",
      "--release", HEAVY.release,
      "--node", HEAVY.node,
      "--npm", HEAVY.npm,
      "--cache", HEAVY.cache,
      "--out", out,
      "--scratch-root", scratchBaseForRun,
      "--font", missingFont,
    ], { timeoutMs: 45 * 60 * 1000 });
    assert.equal(result.timedOut, false, "真实 CLI 运行不得被测试 deadline 打死");
    assert.equal(result.code, 2, `缺字体必须 blocked（exit 2）：${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.code, "pdf_output_required_blocked");
    assert.equal(payload.error?.blocked, true);

    // 阶段状态：office 必须是 blocked，不能报 pass。
    const officeStage = payload.stages.find((stage) => stage.name === "office");
    assert.ok(officeStage, "office 阶段必须出现在结果里");
    assert.equal(officeStage.status, "blocked");
    assert.equal(officeStage.code, "pdf_output_required_blocked");

    // 五个必需 PDF 的 blocked 断言保留；缺字体路径不得产生 fail 断言。
    const blocked = payload.assertions.filter((item) => item.status === "blocked" && /^office\.pdf\./.test(item.id));
    assert.deepEqual(blocked.map((item) => item.id).sort(), [...REQUIRED_PDF_ASSERTIONS].sort());
    assert.ok(blocked.every((item) => /pdf_font_unavailable|pdf_render_failed/.test(String(item.code))), JSON.stringify(blocked));
    const failedIds = payload.assertions.filter((item) => item.status === "fail").map((item) => item.id);
    assert.deepEqual(failedIds, [], `缺字体路径不得产生 fail 断言：${JSON.stringify(failedIds)}`);

    // CSV / XLSX 的真实通过断言保留（不把缺字体改成可选，也不放宽 skip）。
    for (const id of ["reports.csv.trial_balance_1002", "reports.csv.balance_cash", "office.xlsx.trial-balance", "office.xlsx.trial-balance.amounts", "failures.missing_font_reported", "failures.missing_font_xlsx_still_usable"]) {
      const entry = payload.assertions.find((item) => item.id === id);
      assert.equal(entry?.status, "pass", `${id} 必须在缺字体路径下仍然真实通过`);
    }

    // 保留策略：不清理、也不假装已清理 / 已验证 manifest。
    assert.equal(payload.cleanup.retained, true);
    assert.equal(payload.cleanup.attempted, false);
    assert.equal(payload.cleanup.completed, false);
    assert.equal(payload.cleanup.manifestVerified, false);
    assert.equal(payload.cleanup.reason, "blocked_residual_kept");

    // 输出保留：结果 JSON + XLSX 产物在，缺字体时不得写出 PDF。
    assert.equal(existsSync(join(out, "windows-delivery-result.json")), true, "结果 JSON 必须保留");
    const artifactFiles = readdirSync(join(out, "artifacts", "office"));
    assert.equal(artifactFiles.some((name) => name.endsWith(".pdf")), false, "缺字体时不得写出 PDF");
    assert.ok(artifactFiles.filter((name) => name.endsWith(".xlsx")).length >= REQUIRED_OFFICE_KINDS.length, `XLSX 产物必须保留：${JSON.stringify(artifactFiles)}`);

    // 工作根保留：本次 CLI 自建的随机根仍在，并带自己的所有权 manifest。
    const createdRoots = readdirSync(scratchBaseForRun).filter((name) => name.startsWith("delivery-check-"));
    assert.equal(createdRoots.length, 1, `--scratch-root 下应只有本次 CLI 自建随机根：${JSON.stringify(readdirSync(scratchBaseForRun))}`);
    retainedRoot = join(scratchBaseForRun, createdRoots[0]);
    assert.equal(existsSync(retainedRoot), true, "blocked 时工作根必须保留");
    assert.ok(readdirSync(retainedRoot).some((name) => name.startsWith(".wb-scratch-") && name.endsWith(".json")), "保留的工作根必须仍带所有权 manifest");
  } finally {
    if (!runStarted) {
      cleanupScratch(scratch);
    } else {
      // 真实 CLI 的 blocked 现场按协议保留（保留证据不删），不进通用 after 的“全清”断言。
      recordExpectedRefusalFixture({
        kind: "missing_font_cli_retained",
        root: retainedRoot ?? scratch.root,
        reason: "pdf_output_required_blocked",
      });
    }
  }
});

test("启动脚本：relative / drive-relative / root-relative / 空白 / 设备路径 -ScratchRoot 在规范化前被拒绝且无副作用", async (t) => {
  if (!existsSync(PS5)) {
    t.skip("Windows PowerShell 5.1 unavailable");
    return;
  }
  const scratch = newScratch("start-script-raw-root");
  try {
    // 子进程 cwd 始终显式指定为本用例自有目录（不用 process.chdir）。
    const cwd = join(scratch.root, "launcher-cwd");
    mkdirSync(cwd);
    // 普通文件当 DataDir：即使拒绝失效，服务也绝不会真的启动。
    const dataFile = join(scratch.root, "data-file");
    writeFileSync(dataFile, "keep-me", "utf8");
    // Extract only the pure predicate AST; never dot-source or execute the launcher for UNC strings.
    const pureCheck = join(scratch.root, "pure-path-check.ps1");
    // Windows PowerShell 5.1 reads BOM-less scripts using the legacy system encoding.
    // Emit a UTF-8 BOM so embedded Unicode launcher paths survive -File decoding.
    writeFileSync(pureCheck, `\uFEFF
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${START_SCRIPT.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'launcher_parse_failed' }
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-RawAbsolutePath' }, $true)
if ($null -eq $fn) { throw 'predicate_missing' }
# The AST extent contains exactly one pure function, without launcher top-level code.
Invoke-Expression $fn.Extent.Text
foreach ($raw in @('\\\\server', '\\\\server\\', '\\/?.\\x', '\\/?\\x')) {
  if (Test-RawAbsolutePath $raw) { throw 'unsafe_string_accepted' }
}
`, "utf8");
    const pureResult = await capture("ps-pure-unc", PS5, ["-NoProfile", "-File", pureCheck], { cwd });
    assert.equal(pureResult.code, 0, pureResult.stderr);
    const cases = [
      // 候选目标只在本用例 scratch 内；误规范化落点已在 rawPathVariants 内断言。
      { name: "relative", candidate: join(scratch.root, "candidate-relative") },
      { name: "drive-relative", candidate: join(scratch.root, "candidate-drive-relative") },
      { name: "root-relative", candidate: join(scratch.root, "candidate-root-relative") },
      // Blank defaults are contained by capture's fixture-local launcher/runtime copies.
      { name: "whitespace", raw: "   ", candidate: null },
      // Device namespace points only at this fixture's candidate if validation regresses.
      { name: "device-path", raw: `\\\\?\\${join(scratch.root, "candidate-device")}`, candidate: join(scratch.root, "candidate-device") },
    ];
    const device = cases.find((item) => item.name === "device-path");
    assert.equal(pathKeyOf(device.raw.slice(4)), pathKeyOf(device.candidate));
    assert.ok(isInsideDir(scratch.root, device.raw.slice(4)));
    for (const item of cases) {
      const raw = item.raw !== undefined
        ? item.raw
        : rawPathVariants(item.candidate, { fixtureRoot: scratch.root, cwdDir: cwd })[item.name];
      const before = snapshotDir(scratch.root);
      const result = await capture(`start-script-raw-root-${item.name}`, PS5, [
        "-NoProfile", "-File", START_SCRIPT,
        "-NodePath", NODE, "-DataDir", dataFile, "-Port", "0", "-ScratchRoot", raw,
      ], { cwd, timeoutMs: 120000, env: minimalEnv({ TEMP: join(scratch.root, "tmp"), TMP: join(scratch.root, "tmp") }) });
      assert.equal(result.code, 1, `${item.name}: ${result.stderr}`);
      assert.match(result.stderr, /windows_start_error: scratch_root_not_absolute/, item.name);
      assert.doesNotMatch(result.stdout, /windows_start_service_pid=/, `${item.name} 不得启动服务`);
      assert.equal(existsSync(join(result.isolation.workbench, "tmp")), false, `${item.name} 拒绝不得写入副本默认 scratch`);
      assert.equal(existsSync(join(result.isolation.workbench, "   ")), false, `${item.name} 拒绝不得写入副本空白相对目录`);
      if (item.candidate !== null) assert.equal(existsSync(item.candidate), false, `${item.name} -ScratchRoot 候选目标不得被创建`);
      assert.deepEqual(snapshotDir(cwd), [], `${item.name} 拒绝时 cwd 内不得出现任何自建目录`);
      assert.deepEqual(snapshotDir(scratch.root), before, `${item.name} 拒绝后父目录快照必须不变`);
    }
    assert.equal(readFileSync(dataFile, "utf8"), "keep-me", "拒绝时不得创建 / 改写数据目录目标");
  } finally {
    cleanupScratch(scratch);
  }
});
