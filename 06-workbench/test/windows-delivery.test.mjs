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
 */

import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { decideRuntimeVersion, TESTED_NODE_VERSION } from "../scripts/windows-runtime-check.mjs";
import {
  createScratchRecord,
  defaultScratchBase,
  inspectRelease,
  removeScratchRecord,
  removeTrackedPath,
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
  return createScratchRecord({ label: `test-${safeLabel(label)}`, basePath: scratchBase(), tool: "windows-delivery-test" });
}

function cleanupScratch(record) {
  if (!record) return;
  const removal = removeScratchRecord(record);
  if (!removal.ok) cleanupFailures.push({ name: `test-${safeLabel(record.token)}`, reason: removal.reason });
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
      resolvePromise({ stdout, stderr, timedOut, pid: child?.pid ?? null, ...payload });
    };
    try {
      child = spawn(command, args, {
        cwd: options.cwd ?? WORKBENCH,
        env: options.env ?? minimalEnv(),
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
    child.once("close", (code, signal) => finish({ code: code ?? null, signal: signal ?? null }));
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
  const result = await spawnCapture(command, args, options);
  if (result.unreclaimed) residuals.push({ label, pid: result.pid ?? null, kind: "child" });
  return result;
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
  const child = spawn(NODE, [SERVER], {
    cwd: WORKBENCH,
    env: minimalEnv({
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
  const exitPromise = new Promise((resolvePromise) => child.once("exit", (code, signal) => resolvePromise({ code, signal })));
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  // readiness 失败也必须回收本测试自己的服务子进程（有界），不能丢在后台。
  const hardStop = async (label) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill(); } catch { /* ignore */ }
    let done = await Promise.race([exitPromise, delay(KILL_GRACE_MS).then(() => null)]);
    if (!done) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      done = await Promise.race([exitPromise, delay(KILL_GRACE_MS).then(() => null)]);
    }
    if (!done) residuals.push({ label, pid: child.pid ?? null, kind: "server" });
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
    await hardStop("test-server-not-ready");
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
        if (child.exitCode !== null || child.signalCode !== null) return exitPromise;
        try { child.kill(); } catch { /* ignore */ }
        let done = await Promise.race([exitPromise, delay(10000).then(() => null)]);
        if (!done) {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
          done = await Promise.race([exitPromise, delay(KILL_GRACE_MS).then(() => null)]);
        }
        if (!done) residuals.push({ label: "test-server", pid: child.pid ?? null, kind: "server" });
        return done;
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

test("专属临时根：默认在 workbench 的 tmp/windows-delivery，manifest 记录所有权，越界删除被拒绝", () => {
  assert.equal(defaultScratchBase(), join(WORKBENCH, "tmp", "windows-delivery"));
  const scratch = newScratch("ownership");
  try {
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
  assert.equal(scratch.tracked.has(scratch.root.toLowerCase()), false, "root must be unregistered after cleanup");
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

test("专属临时根：相对 path 原始入参在 mkdir 前被拒绝，卷根不可作为 base，文件不能当 base", () => {
  const relative = `relative-scratch-${process.pid}`;
  assert.throws(
    () => createScratchRecord({ label: "guard-relative", basePath: relative, tool: "windows-delivery-test" }),
    (error) => error?.code === "scratch_root_not_absolute",
  );
  assert.equal(existsSync(join(WORKBENCH, relative)), false, "被拒绝的相对 base 不得被创建");

  const volumeRoot = parse(WORKBENCH).root;
  assert.ok(volumeRoot.length > 0);
  assert.throws(
    () => createScratchRecord({ label: "guard-volume", basePath: volumeRoot, tool: "windows-delivery-test" }),
    (error) => error?.code === "scratch_root_is_filesystem_root",
  );

  const scratch = newScratch("guard-file-base");
  try {
    const file = join(scratch.root, "base-file");
    writeFileSync(file, "not-a-directory", "utf8");
    assert.throws(
      () => createScratchRecord({ label: "guard-file", basePath: file, tool: "windows-delivery-test" }),
      (error) => error?.code === "scratch_root_not_directory",
    );
    assert.equal(readFileSync(file, "utf8"), "not-a-directory", "文件 base 不得被改写");
  } finally {
    cleanupScratch(scratch);
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
  assert.equal(existsSync(scratch.root), false, "恢复 manifest 后专属根必须可清理");
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
    try {
      const inspected = inspectRelease(dir);
      // 报告的是被跳过的最高一层目录（tmp 里只剩这个明确已知的专属 base）。
      assert.deepEqual(inspected.excludedScratch, ["06-workbench/tmp"]);
    } finally {
      const removal = removeScratchRecord(nested);
      assert.equal(removal.ok, true, removal.reason);
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
  let child = null;
  let wrapperExited = false;
  let servicePid = null;
  try {
    const dataDir = join(scratch.root, "数据 目录");
    child = spawn(PS5, [
      "-NoProfile", "-File", START_SCRIPT,
      "-NodePath", NODE, "-DataDir", dataDir, "-Port", "0", "-MaxRunSeconds", "4",
      "-ScratchRoot", scratch.root,
    ], {
      cwd: WORKBENCH,
      env: minimalEnv({ TEMP: join(scratch.root, "tmp"), TMP: join(scratch.root, "tmp") }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const exitPromise = new Promise((resolvePromise) => child.once("exit", (code, signal) => {
      wrapperExited = true;
      resolvePromise({ code, signal });
    }));
    const port = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("start_script_timeout")), 20000);
      child.once("exit", (code) => { clearTimeout(timer); rejectPromise(new Error(`start_script_exited:${code}`)); });
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
    assert.equal(stopped, true, "包装器自停后该端口不得再响应（测试不按 PID 猜杀）");
  } finally {
    // 异常路径（含外层终止包装器）：只停止本人创建的包装器句柄。
    // 服务 pid 只能如实记录，不用裸 PID 猜杀（PID 可能已被复用，端口可达也不证明身份）；
    // 正式路径下服务由包装器在 -MaxRunSeconds 到期时用自有句柄回收。
    if (child && !wrapperExited) {
      try { child.kill(); } catch { /* ignore */ }
      const done = await Promise.race([delay(KILL_GRACE_MS).then(() => null), new Promise((resolveExit) => child.once("exit", resolveExit))]);
      if (!done) residuals.push({ label: "powershell-wrapper", pid: child.pid ?? null, kind: "wrapper" });
      if (servicePid !== null) residuals.push({ label: "powershell-wrapper-service", pid: servicePid, kind: "service", reason: "wrapper_aborted_pid_recorded_not_force_killed" });
    }
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

    await server.stop();
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
    if (server) await server.stop();
    cleanupScratch(scratch);
  }
});
