#!/usr/bin/env node
/**
 * tax-browser-lifecycle.test.mjs — 浏览器采集模块「启动/导入/清理脱敏 + 生命周期加固」独立测试
 *
 * 覆盖（全部合成，不打开真实浏览器、不连真实税局、不碰真实库/profile）：
 *   1. 日志脱敏：外部错误 message/code/details 一律不进日志；CDP 原始错误内容不外泄。
 *   2. READ_PAGE_SCRIPT 固定白名单 origin：错误 origin 零 DOM 读取；兼容原有
 *      href/title/rows 快照格式（原有 64 测试依赖），仅本机内存、不回 API/日志。
 *   3. stderr 仅匹配 ws://（不匹配 ws//）；CDP 地址必须回环 + 有效端口 + 无 userinfo。
 *   4. 空闲会话主动 TTL timer（unref）：到点自动 expired/候选销毁/杀进程/删 profile；
 *      期间不调用任何 API。
 *   5. 启动 await launch/connect/attach 期间 close/expire/destroy：不返回已关闭会话成功、
 *      不留迟到 proc/conn，迟到句柄也会被完整清理（幂等、不漏杀）。
 *   6. destroy 后拒绝新 session / 新 token。
 *
 * 运行：node test/tax-browser-lifecycle.test.mjs（在 06-workbench 目录）
 */
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const profileRoot = mkdtempSync(join(tmpdir(), "tb-lifecycle-"));

const {
  TaxBrowserService, TaxBrowserError, CdpConnection,
  READ_PAGE_SCRIPT, isLoopbackDevtoolsUrl, extractDevtoolsUrlFromStderr, usccCheckChar,
} = await import("../server/tax-browser.mjs");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
};

const unhandled = [];
process.on("unhandledRejection", (reason) => { unhandled.push(reason); });

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e && e.stack ? e.stack : e}`); }
};
const assertErr = async (fn, code) => {
  let err;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, `期望抛出 ${code}，但没有抛错`);
  assert.equal(err.code, code, `错误码应为 ${code}，实际 ${err.code}（${err.message}）`);
  return err;
};

// ---------------------------------------------------------------- 假浏览器 / 假 CDP
const ENTRY = "https://etax.fujian.chinatax.gov.cn/";
const USCC17 = "91350600MA34B1W60";
const USCC_VALID = USCC17 + usccCheckChar(USCC17);

function fakeBrowser({
  url = ENTRY,
  rows = [["企业名称", "合成示例有限公司", "统一社会信用代码", USCC_VALID]],
  devtoolsUrl = "ws://127.0.0.1:51234/devtools/browser/fake-uuid",
  launchGate = null,
  wsGate = null,
  connectGate = null,
  targetsGate = null,
  snapshotOverride = null,
  connectError = null,
} = {}) {
  const state = { launched: 0, killed: 0, connClosed: false, lastProfileDir: null, connectCount: 0 };
  const exitHandlers = [];
  const proc = {
    pid: 4242,
    onExit: (cb) => exitHandlers.push(cb),
    devtoolsUrl: async () => { if (wsGate) await wsGate; return devtoolsUrl; },
    kill: async () => { state.killed++; for (const cb of exitHandlers.splice(0)) cb(0, null); },
  };
  const conn = {
    send: async (method, params = {}) => {
      if (method === "Target.getTargets") {
        if (targetsGate) await targetsGate;
        return { targetInfos: [{ targetId: "t1", type: "page", url }] };
      }
      if (method === "Target.attachToTarget") return { sessionId: "cdp1" };
      if (method === "Runtime.evaluate") {
        if (params.expression === "location.href") return { result: { type: "string", value: url } };
        if (snapshotOverride) return { result: { type: "object", value: snapshotOverride } };
        return { result: { type: "object", value: { allowed: true, href: url, title: "国家税务总局电子税务局", rows } } };
      }
      if (method === "Browser.close") return {};
      return {};
    },
    close: () => { state.connClosed = true; },
  };
  const deps = {
    launchBrowser: async ({ profileDir }) => {
      state.launched++;
      state.lastProfileDir = profileDir;
      if (launchGate) await launchGate;
      return proc;
    },
    connectBrowser: async () => {
      state.connectCount++;
      if (connectGate) await connectGate;
      if (connectError) throw connectError;
      return conn;
    },
  };
  return { state, proc, conn, deps, exitBrowser: () => { for (const cb of exitHandlers.splice(0)) cb(0, null); } };
}

function makeService({ deps = {}, limits = {}, log = () => {}, now = () => Date.now() } = {}) {
  return new TaxBrowserService({
    profileRootDir: profileRoot,
    browserCandidates: [{ kind: "x", label: "X", paths: ["C:\\fake\\browser.exe"] }],
    fileExists: (p) => p === "C:\\fake\\browser.exe",
    launchBrowser: deps.launchBrowser,
    connectBrowser: deps.connectBrowser,
    now,
    log,
    limits: { maxSessions: 3, sessionTtlMs: 60_000, readTimeoutMs: 500, launchTimeoutMs: 1_000, loginTokenTtlMs: 60_000, ...limits },
  });
}
const open = (svc) => svc.openSession({ region: "350000", city: "350600", loginToken: svc.issueLoginToken() });
const firstSession = (svc) => [...svc.sessions.values()][0];

// ================================================================ 1. 日志脱敏
console.log("\n1. 日志脱敏（不拼接外部 message/code/details）\n");

await test("启动失败：外部异常 message 含 secret → 日志不含 secret", async () => {
  const secret = "SECRET_LAUNCH_AKIA_do_not_log";
  const logs = [];
  const svc = makeService({ log: (m) => logs.push(String(m)) });
  svc.launchBrowser = async () => { const e = new Error(`boom ${secret}`); e.code = secret; throw e; };
  await assertErr(() => open(svc), "tax_browser_launch_failed");
  assert.equal(logs.length > 0, true, "应有启动失败日志");
  assert.ok(!logs.join("\n").includes(secret), "日志不得包含外部异常 message/code");
  await svc.destroy();
});

await test("启动失败：TaxBrowserError.details 含 secret → 日志不含 secret", async () => {
  const secret = "SECRET_DETAILS_do_not_log";
  const logs = [];
  const svc = makeService({ log: (m) => logs.push(String(m)) });
  svc.launchBrowser = async () => { throw new TaxBrowserError("tax_browser_launch_failed", "启动失败", { raw: secret }); };
  await assertErr(() => open(svc), "tax_browser_launch_failed");
  assert.ok(!logs.join("\n").includes(secret), "日志不得包含 details");
  await svc.destroy();
});

await test("导入失败：外部 importer 异常 message 含 secret → 日志不含 secret", async () => {
  const secret = "SECRET_IMPORT_do_not_log";
  const logs = [];
  const fake = fakeBrowser();
  const svc = new TaxBrowserService({
    profileRootDir: profileRoot,
    browserCandidates: [{ kind: "x", label: "X", paths: ["C:\\fake\\browser.exe"] }],
    fileExists: (p) => p === "C:\\fake\\browser.exe",
    ...fake.deps,
    importer: async () => { throw new Error(`import boom ${secret}`); },
    log: (m) => logs.push(String(m)),
    limits: { maxSessions: 3, sessionTtlMs: 60_000, readTimeoutMs: 500, launchTimeoutMs: 1_000, loginTokenTtlMs: 60_000 },
  });
  const s = await open(svc);
  await svc.readCurrentPage({ sessionId: s.sessionId });
  await assertErr(
    () => svc.importCandidates({ sessionId: s.sessionId, candidateIds: ["c_1"], mode: "create", create: {} }),
    undefined
  );
  assert.ok(!logs.join("\n").includes(secret), "导入失败日志不得包含外部异常 message");
  await svc.destroy();
});

await test("启动异常：tax_browser_ 前缀伪 code 与合成秘密 → 日志仅固定失败文案", async () => {
  const fakeCode = "tax_browser_secret123456";
  const secret = "SECRET_LAUNCH_MESSAGE_do_not_log";
  const logs = [];
  const svc = makeService({ log: (m) => logs.push(String(m)) });
  svc.launchBrowser = async () => { throw Object.assign(new Error(`synth ${secret}`), { code: fakeCode }); };
  await assertErr(() => open(svc), "tax_browser_launch_failed");
  const text = logs.join("\n");
  assert.ok(!text.includes(fakeCode), "日志不得包含任意 tax_browser_ 前缀伪 code");
  assert.ok(!text.includes(secret), "日志不得包含外部异常 message");
  assert.ok(text.includes("tax_browser_launch_failed"), "日志应保留固定失败文案");
  await svc.destroy();
});

await test("导入异常：tax_browser_ 前缀伪 code 与合成秘密 → 日志仅固定失败文案", async () => {
  const fakeCode = "tax_browser_secret123456";
  const secret = "SECRET_IMPORT_MESSAGE_do_not_log";
  const logs = [];
  const fake = fakeBrowser();
  const svc = new TaxBrowserService({
    profileRootDir: profileRoot,
    browserCandidates: [{ kind: "x", label: "X", paths: ["C:\\fake\\browser.exe"] }],
    fileExists: (p) => p === "C:\\fake\\browser.exe",
    ...fake.deps,
    importer: async () => { throw Object.assign(new Error(`import synth ${secret}`), { code: fakeCode }); },
    log: (m) => logs.push(String(m)),
    limits: { maxSessions: 3, sessionTtlMs: 60_000, readTimeoutMs: 500, launchTimeoutMs: 1_000, loginTokenTtlMs: 60_000 },
  });
  const s = await open(svc);
  await svc.readCurrentPage({ sessionId: s.sessionId });
  // 仅日志被脱敏；抛回调用方的原始异常不被改造
  await assertErr(
    () => svc.importCandidates({ sessionId: s.sessionId, candidateIds: ["c_1"], mode: "create", create: {} }),
    fakeCode
  );
  const text = logs.join("\n");
  assert.ok(!text.includes(fakeCode), "日志不得包含任意 tax_browser_ 前缀伪 code");
  assert.ok(!text.includes(secret), "日志不得包含外部异常 message");
  assert.ok(text.includes("tax_browser_import_failed"), "日志应保留固定失败文案");
  await svc.destroy();
});

await test("CDP 错误：浏览器返回的原始 message 不进错误对象（details 为空、无 secret）", async () => {
  const secret = "SECRET_CDP_PAGE_CONTENT";
  let instance = null;
  class FakeWebSocket {
    constructor(url) { this.url = url; this.listeners = {}; instance = this; }
    addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); }
    emit(type, ev) { for (const cb of this.listeners[type] || []) cb(ev); }
    send() {}
    close() { this.emit("close", {}); }
  }
  const conn = new CdpConnection("ws://127.0.0.1:1/devtools/browser/x", { WebSocketImpl: FakeWebSocket });
  const openP = conn.open();
  instance.emit("open", {});
  await openP;
  const sendP = conn.send("Runtime.evaluate", {});
  await delay(0);
  instance.emit("message", { data: JSON.stringify({ id: 1, error: { code: -32000, message: secret } }) });
  const err = await sendP.catch((e) => e);
  assert.equal(err.code, "tax_browser_cdp_error");
  assert.ok(!JSON.stringify(err).includes(secret), "CDP 原始错误内容不得外泄");
  assert.ok(!err.details, "details 必须为空");
  conn.close();
});

// ================================================================ 2. READ_PAGE_SCRIPT 白名单
console.log("\n2. READ_PAGE_SCRIPT：固定白名单 origin + 兼容快照格式\n");

await test("错误 origin：脚本最早返回 allowed:false，绝不读取 document（零 DOM）", () => {
  const fn = new Function("document", "location", "return " + READ_PAGE_SCRIPT);
  let reads = 0;
  const document = {
    get title() { reads++; return "不应被读取"; },
    querySelectorAll() { reads++; return []; },
  };
  for (const loc of [
    { href: "https://evil.example/list", origin: "https://evil.example" },
    { href: "https://etax.fujian.chinatax.gov.cn.evil.example/", origin: "https://etax.fujian.chinatax.gov.cn.evil.example" },
    { href: "http://127.0.0.1/", origin: "http://127.0.0.1" },
    { href: "not a url", origin: "" },
    {},
  ]) {
    const snap = fn(document, loc);
    assert.equal(snap.allowed, false, JSON.stringify(loc));
    assert.deepEqual(snap.rows, []);
  }
  assert.equal(reads, 0, "错误 origin 下不得访问 document");
});

await test("允许 origin：保留 href/title/rows 原格式（原 64 测试兼容）", () => {
  const fn = new Function("document", "location", "return " + READ_PAGE_SCRIPT);
  const row = ["企业名称", "合成示例有限公司", "统一社会信用代码", "X"];
  const document = {
    title: "国家税务总局电子税务局",
    querySelectorAll: () => [],
  };
  // 用最小假 DOM 提供一行 tr
  const tr = {
    tag: "tr",
    children: [
      { tag: "td", children: [], textContent: "企业名称", getAttribute: () => null, querySelectorAll: () => [] },
      { tag: "td", children: [], textContent: "合成示例有限公司", getAttribute: () => null, querySelectorAll: () => [] },
      { tag: "td", children: [], textContent: "统一社会信用代码", getAttribute: () => null, querySelectorAll: () => [] },
      { tag: "td", children: [], textContent: "X", getAttribute: () => null, querySelectorAll: () => [] },
    ],
    querySelectorAll(sel) { return sel === "td,th" ? this.children : []; },
  };
  document.querySelectorAll = (sel) => (sel === "tr" ? [tr] : []);
  const snap = fn(document, { href: "https://etax.fujian.chinatax.gov.cn:8443/list?page=2", origin: "https://etax.fujian.chinatax.gov.cn:8443" });
  assert.equal(snap.allowed, true);
  assert.equal(snap.href, "https://etax.fujian.chinatax.gov.cn:8443/list?page=2");
  assert.equal(snap.title, "国家税务总局电子税务局");
  assert.deepEqual(snap.rows, [row]);
});

await test("脚本层 allowed:false（页面读取期间跳转到非白名单）→ 服务拒绝且不写候选", async () => {
  const fake = fakeBrowser({
    snapshotOverride: { allowed: false, origin: "https://evil.example", href: "", title: "", rows: [["企业名称", "A公司", "统一社会信用代码", "X"]] },
  });
  const svc = makeService({ deps: fake.deps });
  const s = await open(svc);
  await assertErr(() => svc.readCurrentPage({ sessionId: s.sessionId }), "tax_browser_page_not_supported");
  assert.equal(svc.getSession({ sessionId: s.sessionId }).preview.count, 0, "结果不得写回会话");
  await svc.destroy();
});

// ================================================================ 3. stderr / CDP 地址
console.log("\n3. stderr 匹配与 CDP 地址校验\n");

await test("stderr：只匹配 ws://127.0.0.1:<port>/...，不匹配 ws// 与其它主机", () => {
  assert.equal(
    extractDevtoolsUrlFromStderr("DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc"),
    "ws://127.0.0.1:9222/devtools/browser/abc"
  );
  assert.equal(extractDevtoolsUrlFromStderr("DevTools listening on ws//127.0.0.1:9222/devtools/browser/abc"), null, "ws// 不得匹配");
  assert.equal(extractDevtoolsUrlFromStderr("DevTools listening on ws://localhost:9222/devtools/browser/abc"), null);
  assert.equal(extractDevtoolsUrlFromStderr("DevTools listening on wss://127.0.0.1:9222/x"), null);
  assert.equal(extractDevtoolsUrlFromStderr("random noise"), null);
});

await test("isLoopbackDevtoolsUrl：回环 + 有效端口 + 无 userinfo", () => {
  assert.equal(isLoopbackDevtoolsUrl("ws://127.0.0.1:9222/devtools/browser/abc"), true);
  assert.equal(isLoopbackDevtoolsUrl("ws://127.0.0.1:65535/devtools/browser/a"), true);
  assert.equal(isLoopbackDevtoolsUrl("ws://127.0.0.1:0/devtools/browser/a"), false, "端口 0 无效");
  assert.equal(isLoopbackDevtoolsUrl("ws://127.0.0.1:65536/devtools/browser/a"), false, "端口越界");
  assert.equal(isLoopbackDevtoolsUrl("ws://127.0.0.1/devtools/browser/a"), false, "缺端口");
  assert.equal(isLoopbackDevtoolsUrl("ws://user:pass@127.0.0.1:9222/devtools/browser/a"), false, "userinfo 禁止");
  assert.equal(isLoopbackDevtoolsUrl("ws://127.0.0.1:9222/"), false, "根路径不算调试 endpoint");
  assert.equal(isLoopbackDevtoolsUrl("ws://localhost:9222/x"), false);
  assert.equal(isLoopbackDevtoolsUrl("ws://0.0.0.0:9222/x"), false);
  assert.equal(isLoopbackDevtoolsUrl("http://127.0.0.1:9222/x"), false);
  assert.equal(isLoopbackDevtoolsUrl("ws://127.0.0.1:9222/x y"), false, "含空白拒绝");
  assert.equal(isLoopbackDevtoolsUrl(""), false);
});

await test("connectBrowser 默认实现拒绝非回环地址（服务注入连接前先校验）", async () => {
  // 直接验证服务端逻辑：非回环 ws 地址 → connect_failed
  const svc = makeService({ deps: { launchBrowser: async () => ({ pid: 1, onExit: () => {}, devtoolsUrl: async () => "ws://evil.example:9/x", kill: async () => {} }), connectBrowser: async () => ({ send: async () => ({}), close: () => {} }) } });
  await assertErr(() => open(svc), "tax_browser_connect_failed");
  await svc.destroy();
});

// ================================================================ 4. 空闲 TTL
console.log("\n4. 空闲会话主动 TTL（unref，期间不访问 API）\n");

await test("空闲 20ms TTL：约 80ms 内自动 expired + 候选销毁 + 杀进程 + 删 profile", async () => {
  const fake = fakeBrowser();
  const svc = makeService({ deps: fake.deps, limits: { sessionTtlMs: 20 } });
  const s = await open(svc);
  const id = s.sessionId;
  const profileDir = svc.listCreatedProfileDirs()[0];
  assert.ok(profileDir && existsSync(profileDir));
  // 期间不调用任何 API，仅轮询内部状态字段
  const ok = await waitFor(() => svc.sessions.get(id)?.status === "expired", 3000);
  assert.ok(ok, "TTL 到点应自动 expired");
  await waitFor(() => fake.state.killed >= 1, 3000);
  await waitFor(() => !existsSync(profileDir), 3000);
  assert.equal(fake.state.killed, 1, "进程应被杀一次");
  assert.equal(fake.state.connClosed, true, "CDP 连接应关闭");
  assert.equal(svc.sessions.get(id).collected.size, 0, "候选数据应销毁");
  assert.ok(!existsSync(profileDir), "profile 应删除");
  assert.equal(svc.listCreatedProfileDirs().length, 0, "登记应清空");
  await svc.destroy();
});

await test("TTL timer 已 unref（不会因未清 timer 阻滞进程退出）且关闭会清 timer", async () => {
  const fake = fakeBrowser();
  const svc = makeService({ deps: fake.deps, limits: { sessionTtlMs: 60_000 } });
  const s = await open(svc);
  const session = svc.sessions.get(s.sessionId);
  assert.ok(session.ttlTimer, "应有 TTL timer");
  assert.equal(session.ttlTimer.hasRef?.(), false, "timer 必须 unref");
  await svc.closeSession({ sessionId: s.sessionId });
  assert.equal(svc.sessions.get(s.sessionId).ttlTimer, null, "关闭后应清理 timer");
  await svc.destroy();
});

// ================================================================ 5. 启动期间 close/expire/destroy
console.log("\n5. 启动 await 期间 close/expire/destroy + 迟到资源\n");

await test("launch await 期间 closeSession：不返回成功，迟到 proc 被杀、profile 删除", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fake = fakeBrowser({ launchGate: gate });
  const svc = makeService({ deps: fake.deps });
  const pending = open(svc);
  pending.catch(() => {});
  await waitFor(() => svc.sessions.size === 1, 1000);
  const id = firstSession(svc).sessionId;
  const closeP = svc.closeSession({ sessionId: id });
  release();
  const err = await pending.catch((e) => e);
  assert.equal(err.code, "tax_browser_session_closed", "不得返回已关闭会话成功");
  await closeP;
  await waitFor(() => fake.state.killed >= 1, 2000);
  assert.equal(fake.state.killed, 1, "迟到 proc 必须被完整 kill，且只 kill 一次");
  assert.equal(svc.listCreatedProfileDirs().length, 0, "profile 登记应清空");
  await svc.destroy();
});

await test("launch await 期间 TTL 过期：返回 expired，迟到 proc 被杀、profile 删除", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fake = fakeBrowser({ launchGate: gate });
  const svc = makeService({ deps: fake.deps, limits: { sessionTtlMs: 20 } });
  const pending = open(svc);
  pending.catch(() => {});
  await waitFor(() => svc.sessions.size === 1, 1000);
  await waitFor(() => firstSession(svc).status === "expired", 2000);
  release();
  const err = await pending.catch((e) => e);
  assert.equal(err.code, "tax_browser_session_expired", "过期优先于启动成功");
  await waitFor(() => fake.state.killed >= 1, 2000);
  assert.equal(fake.state.killed, 1);
  assert.equal(svc.listCreatedProfileDirs().length, 0);
  await svc.destroy();
});

await test("launch await 期间 destroy：不返回成功，迟到 proc 被杀、残留 profile 删除", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fake = fakeBrowser({ launchGate: gate });
  const svc = makeService({ deps: fake.deps });
  const pending = open(svc);
  pending.catch(() => {});
  await waitFor(() => svc.sessions.size === 1, 1000);
  const destroyP = svc.destroy();
  release();
  const err = await pending.catch((e) => e);
  assert.equal(err.code, "tax_browser_session_closed", "destroy 后不得返回成功");
  await destroyP;
  await waitFor(() => fake.state.killed >= 1, 2000);
  assert.equal(fake.state.killed, 1, "迟到 proc 必须被 kill");
  assert.equal(svc.sessions.size, 0);
  assert.equal(svc.listCreatedProfileDirs().length, 0, "profile 登记应清空");
});

await test("connect await 期间 closeSession：迟到 conn 被关闭、proc 被杀、不返回成功", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fake = fakeBrowser({ connectGate: gate });
  const svc = makeService({ deps: fake.deps });
  const pending = open(svc);
  pending.catch(() => {});
  await waitFor(() => fake.state.launched === 1 && svc.sessions.size === 1, 1000);
  const id = firstSession(svc).sessionId;
  // 等 launch 已 resolve、进入 connect 等待
  await waitFor(() => firstSession(svc).proc !== null, 1000);
  const closeP = svc.closeSession({ sessionId: id });
  release();
  const err = await pending.catch((e) => e);
  assert.equal(err.code, "tax_browser_session_closed");
  await closeP;
  await waitFor(() => fake.state.connClosed === true, 2000);
  assert.equal(fake.state.connClosed, true, "迟到 CDP 连接必须关闭");
  assert.equal(fake.state.killed, 1, "proc 必须被杀");
  await svc.destroy();
});

await test("attach await 期间 destroy：迟到 conn/proc 全部清理，不返回成功", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fake = fakeBrowser({ targetsGate: gate });
  const svc = makeService({ deps: fake.deps });
  const pending = open(svc);
  pending.catch(() => {});
  await waitFor(() => fake.state.launched === 1 && svc.sessions.size === 1, 1000);
  await waitFor(() => firstSession(svc).conn !== null, 2000);
  const destroyP = svc.destroy();
  release();
  const err = await pending.catch((e) => e);
  assert.equal(err.code, "tax_browser_session_closed");
  await destroyP;
  await waitFor(() => fake.state.killed >= 1 && fake.state.connClosed === true, 2000);
  assert.equal(fake.state.killed, 1);
  assert.equal(fake.state.connClosed, true);
  assert.equal(svc.listCreatedProfileDirs().length, 0);
});

await test("并发 closeSession：清理幂等，进程只 kill 一次", async () => {
  const fake = fakeBrowser();
  const svc = makeService({ deps: fake.deps });
  const s = await open(svc);
  await svc.readCurrentPage({ sessionId: s.sessionId });
  await Promise.all([
    svc.closeSession({ sessionId: s.sessionId }),
    svc.closeSession({ sessionId: s.sessionId }),
    svc.closeSession({ sessionId: s.sessionId }),
  ]);
  assert.equal(fake.state.killed, 1, "并发关闭不得重复 kill");
  assert.equal(svc.sessions.get(s.sessionId).collected.size, 0);
  await svc.destroy();
});

await test("browser 退出（启动期间）：会话终态 closed/browser_exit，资源清理", async () => {
  const fake = fakeBrowser();
  const svc = makeService({ deps: fake.deps });
  const s = await open(svc);
  fake.exitBrowser();
  await waitFor(() => svc.sessions.get(s.sessionId).status !== "open", 1000);
  const session = svc.sessions.get(s.sessionId);
  assert.equal(session.status, "closed");
  assert.equal(session.closeReason, "browser_exit");
  await assertErr(() => svc.readCurrentPage({ sessionId: s.sessionId }), "tax_browser_session_closed");
  await svc.destroy();
});

// ================================================================ 6. destroy 后拒绝新会话/令牌 + profile 路径
console.log("\n6. destroy 后拒绝 + profile 路径保护\n");

await test("destroy 后：拒绝新 token、新 session、导入", async () => {
  const fake = fakeBrowser();
  const svc = makeService({ deps: fake.deps });
  await svc.destroy();
  assert.throws(() => svc.issueLoginToken(), (e) => e.code === "tax_browser_service_stopped");
  await assertErr(() => svc.openSession({ region: "350000", city: "350600", loginToken: "taxlt_x" }), "tax_browser_service_stopped");
  await assertErr(() => svc.importCandidates({ sessionId: "taxb_x", candidateIds: ["c_1"] }), "tax_browser_service_stopped");
  await svc.destroy(); // 幂等
});

await test("profile 清理：不在本程序创建根内的目录绝不被删除", async () => {
  const extRoot = mkdtempSync(join(tmpdir(), "tb-ext-root-"));
  const extVictim = join(extRoot, "victim-profile");
  mkdirSync(extVictim);
  const fake = fakeBrowser();
  const svc = makeService({ deps: fake.deps });
  const s = await open(svc);
  // 篡改为「未登记、且在根外」的目录：清理必须不动它
  svc.sessions.get(s.sessionId).profileDir = extVictim;
  await svc.destroy();
  assert.ok(existsSync(extVictim), "外部目录不得被删除");
  rmSync(extRoot, { recursive: true, force: true });
});

await test("新会话视图/日志不含 CDP endpoint 或路径 secret", async () => {
  const logs = [];
  const fake = fakeBrowser();
  const svc = makeService({ deps: fake.deps, log: (m) => logs.push(String(m)) });
  const s = await open(svc);
  const text = JSON.stringify(s) + "\n" + logs.join("\n");
  assert.ok(!text.includes("ws://"), "不得出现 ws endpoint");
  assert.ok(!text.includes("51234"), "不得出现调试端口");
  assert.ok(!text.includes(profileRoot), "不得出现 profile 路径");
  await svc.destroy();
});

// ================================================================ 7. 自建根目录清理（非递归、只删空根）
console.log("\n7. 自建 profile 根清理（保留未决 launch / 只删空根 / 不泄路径）\n");

const defaultRootService = (deps = {}, log = () => {}) => new TaxBrowserService({
  browserCandidates: [{ kind: "x", label: "X", paths: ["C:\\fake\\browser.exe"] }],
  fileExists: (p) => p === "C:\\fake\\browser.exe",
  launchBrowser: deps.launchBrowser,
  connectBrowser: deps.connectBrowser,
  log,
  limits: { maxSessions: 3, sessionTtlMs: 60_000, readTimeoutMs: 500, launchTimeoutMs: 1_000, loginTokenTtlMs: 60_000 },
});

await test("自建根+延迟 launch：destroy 快速返回、不删启动中 profile/root，释放后迟到资源回收、空根最终消失", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fake = fakeBrowser({ launchGate: gate });
  const svc = defaultRootService(fake.deps);
  const root = svc.profileRoot;
  assert.ok(existsSync(root), "服务应自建 profile 根");
  const pending = open(svc);
  pending.catch(() => {});
  await waitFor(() => svc.sessions.size === 1, 1000);
  const profileDir = firstSession(svc).profileDir;
  assert.ok(existsSync(profileDir), "启动中的 profile 应存在");
  // 留一个合成文件，证明「根不空不递归删」
  writeFileSync(join(profileDir, "synthetic-late.txt"), "synthetic");
  const t0 = Date.now();
  await svc.destroy(); // launch 未 settle：不得等待未决 launch
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `destroy 不得等待未决 launch（实际 ${elapsed}ms）`);
  assert.ok(existsSync(profileDir), "启动中的 profile 不得被删除");
  assert.ok(existsSync(root), "尚有登记 profile 时根必须保留");
  release();
  const err = await pending.catch((e) => e);
  assert.equal(err.code, "tax_browser_session_closed", "释放后不得返回已关闭会话成功");
  await waitFor(() => fake.state.killed >= 1, 3000);
  assert.equal(fake.state.killed, 1, "迟到 proc 必须被 kill 且只 kill 一次");
  await waitFor(() => !existsSync(profileDir), 3000);
  assert.ok(!existsSync(profileDir), "迟到清理后子 profile 应删除");
  await waitFor(() => !existsSync(root), 3000);
  assert.ok(!existsSync(root), "子目录清空后自建空根应删除，无残留");
  assert.equal(svc.listCreatedProfileDirs().length, 0);
});

await test("自建根删除失败：不递归删不受管哨兵子目录，也不把根路径原文抛/记出去", async () => {
  const fake = fakeBrowser();
  const logs = [];
  const svc = defaultRootService(fake.deps, (m) => logs.push(String(m)));
  const root = svc.profileRoot;
  const sentinel = join(root, "unmanaged-sentinel");
  mkdirSync(sentinel);
  const s = await open(svc);
  await svc.closeSession({ sessionId: s.sessionId }); // 先完成定向子目录清理
  let caught = null;
  try { await svc.destroy(); } catch (e) { caught = e; }
  assert.equal(caught, null, "根删除失败不得把路径相关错误抛出去");
  assert.ok(existsSync(sentinel), "不受管哨兵子目录不得被递归删除");
  assert.ok(existsSync(root), "根非空必须保留待重试");
  assert.ok(!logs.join("\n").includes(root), "日志不得包含根路径原文");
  assert.equal(svc.listCreatedProfileDirs().length, 0, "已清理的 profile 登记应清空");
  rmSync(root, { recursive: true, force: true }); // 测试侧在 temp 内自行清理
});

// ---------------------------------------------------------------- 收尾
try { rmSync(profileRoot, { recursive: true, force: true }); } catch { /* ignore */ }

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过\n`);
if (unhandled.length) {
  console.error(`发现 ${unhandled.length} 个 unhandledRejection：`);
  for (const r of unhandled) console.error("  -", r && r.message ? r.message : r);
}
process.exitCode = failed || unhandled.length ? 1 : 0;
