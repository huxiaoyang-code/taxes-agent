#!/usr/bin/env node
// 固定的合成测试身份，不依赖显示名及生产默认值。
let identityFixtureSequence = 0;
const identityFixture = () => ({ enterpriseKey: 'SYNTHETIC-server-local-boundary-test-mjs-' + (++identityFixtureSequence) });
const identityFixtureCreate = (A, options) => A.createAccountSet({ enterprise: identityFixture(), ...options });
/**
 * server-local-boundary.test.mjs — 生产 server.mjs「请求地址边界」HTTP 回归（rc-a0 收尾）
 *
 * 合成临时数据库 + PORT=0 子进程，用 node:http 直发原生请求（可自定义 Host 头，
 * fetch 禁止设置 Host 所以这里必须用 node:http）。不访问真税局、真库、任何原件。
 *
 * 覆盖：
 *  1. 畸形 Host 让 new URL(req.url, http://<host>) 抛错时，服务返回固定 400 JSON，
 *     绝不回显原始 Host/url/底层 error；响应无任何 CORS 放行头。
 *  2. 畸形请求之后服务仍存活：/api/meta 继续 200，证明异常没有终止进程。
 *  3. 非本机 Host 访问税局敏感接口仍被固定拒绝（403 host_not_local，无 CORS、无回显）；
 *     回环 Host 的税局只读接口正常。
 *
 * 运行：node test/server-local-boundary.test.mjs（在 06-workbench 目录）
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "wb-local-boundary-"));
process.env.WORKBENCH_DATA_DIR = directory;
const { db } = await import("../server/db.mjs");
const A = await import("../server/accounting.mjs");
// 合成账套：证明子进程用的是本临时库，且服务在畸形请求后仍能正常操作真实存储。
identityFixtureCreate(A, { name: "合成边界测试公司", start_period: "2026-01" });
// 恶意 Origin 探针账套：证明旧 REST 数据出口无法被跨源读取（管理者实际复现的绕过点）。
identityFixtureCreate(A, { name: "SYNTHETIC_ORIGIN_PROBE", start_period: "2026-01" });

let child, exited, port;

before(async () => {
  child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "../server/server.mjs")], {
    env: { ...process.env, PORT: "0", WORKBENCH_DATA_DIR: directory, HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  exited = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  port = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => finish(new Error(`Server startup timed out: ${stderr}`)), 10000);
    const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(new Error(`Server exited ${code}: ${stderr}`)));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/127\.0\.0\.1:(\d+)\//);
      if (match) finish(null, +match[1]);
    });
  });
});

after(async () => {
  try {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (exited) await exited;
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** 原生 HTTP 请求：可传任意 Host/Origin 头与 JSON 体（fetch 会拒绝设置 Host）。 */
function raw({ host, method = "GET", path = "/api/meta", origin, contentType = "application/json", body } = {}) {
  const payload = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1", port, method, path, agent: false,
      headers: {
        host,
        ...(origin !== undefined ? { origin } : {}),
        ...(payload !== null ? { "content-type": contentType, "content-length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(10000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** 畸形请求目标（无法解析成合法 URL）应统一固定 400，且不泄漏任何输入。 */
// 注意：仅用合法 HTTP 头可承载的畸形 Host（含 NUL 等控制字符会被 http 客户端先拒，
// 发不出来，不能作为断言向量）。
const MALFORMED_HOSTS = ["[", "bad host", "a:b", "x]y", "127.0.0.1:99999", "127.0.0.1:1:2", "..:..", "[]", "[::1"];

for (const host of MALFORMED_HOSTS) {
  test(`畸形 Host ${JSON.stringify(host)} → 固定 400 JSON，无回显/无 CORS`, async () => {
    const res = await raw({ host, path: "/api/meta" });
    assert.equal(res.status, 400);
    assert.match(res.headers["content-type"] ?? "", /^application\/json/);
    assert.equal(res.headers["access-control-allow-origin"], undefined, "错误响应不得发送 CORS 放行头");
    assert.equal(res.headers["cache-control"], "no-store");
    const body = JSON.parse(res.body);
    assert.deepEqual(body, { error: "bad_request", message: "请求地址不合法" });
    assert.equal(res.body.includes(host), false, "不得回显原始 Host");
    assert.doesNotMatch(res.body, /ERR_INVALID_URL|Invalid URL|TypeError/, "不得回显底层错误");
  });
}

test("畸形 Host 的 OPTIONS 预检同样固定 400 且无 CORS", async () => {
  const res = await raw({ host: "bad host", method: "OPTIONS", path: "/api/meta" });
  assert.equal(res.status, 400);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(JSON.parse(res.body), { error: "bad_request", message: "请求地址不合法" });
});

test("连续畸形请求后服务仍存活：/api/meta 正常 200（异常未终止进程）", async () => {
  for (const host of MALFORMED_HOSTS) await raw({ host, path: "/api/meta" });
  const res = await raw({ host: `127.0.0.1:${port}`, path: "/api/meta" });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"] ?? "", /^application\/json/);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.standards) && body.standards.length > 0);
  assert.ok(body.coa && typeof body.coa === "object");
});

test("非本机 Host 访问税局敏感接口：固定 403、无 CORS、无回显；不启动任何采集", async () => {
  const res = await raw({ host: "evil.example", method: "POST", path: "/agent/tools/tax_regions", body: {} });
  assert.equal(res.status, 403);
  assert.match(res.headers["content-type"] ?? "", /^application\/json/);
  assert.equal(res.headers["access-control-allow-origin"], undefined, "税局接口不得发送 CORS 放行头");
  const body = JSON.parse(res.body);
  assert.equal(body.error, "forbidden");
  assert.doesNotMatch(res.body, /evil\.example/, "不得回显敌对 Host");
  assert.equal(res.body.includes("loginToken"), false, "拒绝时不得发放令牌");
});

test("回环 Host 的税局只读接口正常（服务边界未误伤正常路径）", async () => {
  const res = await raw({ host: `127.0.0.1:${port}`, method: "POST", path: "/agent/tools/tax_regions", body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  const body = JSON.parse(res.body);
  assert.equal(body.summary.adaptersTotal, 0);
});

// ------------------------------------------------ 旧 REST / Agent 入口的同源保护（RC-A0 补口）
// 管理者实际复现：临时库先建 SYNTHETIC_ORIGIN_PROBE，再带 Origin:https://evil.example
// GET /api/account-sets 返回 200 + CORS:* + 合成企业名——旧 REST 数据出口绕过同源校验。
// 以下专项测试证明：恶意 Origin 既拿不到合成数据，也不能写库，且无任何 CORS 放行。

/** 断言响应为统一的固定 403 拒绝：无 CORS、无回显。*/
function assertForbidden(res, forbidden = []) {
  assert.equal(res.status, 403);
  assert.match(res.headers["content-type"] ?? "", /^application\/json/);
  assert.equal(res.headers["access-control-allow-origin"], undefined, "拒绝时不得发送 CORS 放行头");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(res.body), { error: "forbidden", message: "请求来源不被允许" });
  for (const needle of forbidden) assert.equal(res.body.includes(needle), false, `不得回显 ${needle}`);
}

const EVIL_ORIGIN = "https://evil.example";

let probeSetId;
before(() => {
  const probe = A.listAccountSets().find((s) => s.name === "SYNTHETIC_ORIGIN_PROBE");
  assert.ok(probe, "前置：临时库已建 SYNTHETIC_ORIGIN_PROBE");
  probeSetId = probe.id;
});

const countAccountSets = () => A.listAccountSets().length;

for (const method of ["GET", "POST"]) {
  test(`恶意 Origin ${method} /api/account-sets（旧 REST 数据出口）：403、无 CORS、无合成企业名` , async () => {
    const before = countAccountSets();
    const res = await raw({
      host: `127.0.0.1:${port}`, method, path: "/api/account-sets", origin: EVIL_ORIGIN,
      body: method === "POST" ? { name: "跨站写入公司", start_period: "2026-01" } : undefined,
    });
    assertForbidden(res, ["SYNTHETIC_ORIGIN_PROBE", "evil.example"]);
    assert.equal(countAccountSets(), before, "恶意 Origin 不得修改数据库");
    assert.equal(A.listAccountSets().some((s) => s.name === "跨站写入公司"), false);
  });
}

for (const [label, make] of [
  ["同源 Origin", () => ({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })],
  ["无 Origin（本机 CLI/MCP）", () => ({ host: `127.0.0.1:${port}`, origin: undefined })],
  ["localhost 别名同源", () => ({ host: `localhost:${port}`, origin: `http://localhost:${port}` })],
]) {
  test(`本机 ${label} GET /api/account-sets 保持 200 且无 CORS 头`, async () => {
    const { host, origin } = make();
    const res = await raw({ host, path: "/api/account-sets", origin });
    assert.equal(res.status, 200);
    assert.equal(res.headers["access-control-allow-origin"], undefined, "同源/CLI 也不需要 CORS；绝不发通配头");
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body));
    assert.ok(body.some((s) => s.name === "SYNTHETIC_ORIGIN_PROBE"), "本机同源可正常读取");
  });
}

test("恶意 Origin 写旧 REST（POST 建账 / PUT 期初 / POST 凭证）：403 且 DB 未变", async () => {
  const before = countAccountSets();
  const create = await raw({ host: `127.0.0.1:${port}`, method: "POST", path: "/api/account-sets", origin: EVIL_ORIGIN,
    body: { name: "跨站注入公司", start_period: "2026-01" } });
  assertForbidden(create, ["跨站注入公司", "evil.example"]);
  const opening = await raw({ host: `127.0.0.1:${port}`, method: "PUT", path: `/api/account-sets/${probeSetId}/opening-balances`, origin: EVIL_ORIGIN,
    body: { items: [{ code: "1002", debit: 1 }] } });
  assertForbidden(opening);
  const voucher = await raw({ host: `127.0.0.1:${port}`, method: "POST", path: `/api/account-sets/${probeSetId}/vouchers`, origin: EVIL_ORIGIN,
    body: { period: "2026-01", status: "posted", entries: [{ code: "1001", debit: 1 }, { code: "1002", credit: 1 }] } });
  assertForbidden(voucher);
  assert.equal(countAccountSets(), before, "恶意 Origin 不得创建账套");
  assert.equal(A.getOpeningBalances(probeSetId).length, 0, "恶意 Origin 不得写入期初");
  assert.equal(A.listVouchers(probeSetId).length, 0, "恶意 Origin 不得写入凭证");
});

test("JSON text/plain 简单请求（可绕过预检）带恶意 Origin 也不能改数据", async () => {
  const before = countAccountSets();
  const res = await raw({ host: `127.0.0.1:${port}`, method: "POST", path: "/api/account-sets", origin: EVIL_ORIGIN,
    contentType: "text/plain", body: JSON.stringify({ name: "简单请求公司", start_period: "2026-01" }) });
  assertForbidden(res, ["简单请求公司"]);
  assert.equal(countAccountSets(), before);
});

for (const tool of ["account_context", "finance_context_resolve", "finance_query"]) {
  test(`恶意 Origin 真实 Agent 入口 /agent/tools/${tool}：403、无 CORS、无合成企业名`, async () => {
    const res = await raw({ host: `127.0.0.1:${port}`, method: "POST", path: `/agent/tools/${tool}`, origin: EVIL_ORIGIN,
      body: tool === "finance_query" ? { nodeId: "report.income_statement", accountSetId: probeSetId, period: "2026-01" } : {} });
    assertForbidden(res, ["SYNTHETIC_ORIGIN_PROBE", "evil.example"]);
  });
}

test("跨站 OPTIONS 预检（旧 REST / agent）：固定 403 且无任何 CORS 放行头", async () => {
  for (const path of ["/api/account-sets", "/agent/tools/account_context", "/api/meta"]) {
    const res = await raw({ host: `127.0.0.1:${port}`, method: "OPTIONS", path, origin: EVIL_ORIGIN });
    assertForbidden(res, ["evil.example"]);
  }
});

test("本机同源 OPTIONS 预检放行（204），且不发送任何 CORS 头", async () => {
  const res = await raw({ host: `127.0.0.1:${port}`, method: "OPTIONS", path: "/api/account-sets", origin: `http://127.0.0.1:${port}` });
  assert.equal(res.status, 204);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  assert.equal(res.headers["access-control-allow-methods"], undefined, "同源 UI 不需要 CORS 授权");
});

test("非本机 Host 访问旧 REST：403 固定拒绝、无 CORS、不泄漏数据", async () => {
  for (const host of ["evil.example", "evil.example:8787", "attacker.test"]) {
    const list = await raw({ host, path: "/api/account-sets", origin: EVIL_ORIGIN });
    assertForbidden(list, ["SYNTHETIC_ORIGIN_PROBE", host]);
    const write = await raw({ host, method: "POST", path: "/api/account-sets", origin: EVIL_ORIGIN,
      body: { name: "敌对Host公司", start_period: "2026-01" } });
    assertForbidden(write, ["敌对Host公司"]);
  }
  assert.equal(A.listAccountSets().some((s) => s.name === "敌对Host公司"), false);
});

test("无 Origin 的本机 Agent 工具照常可用（CLI/MCP 未被误伤）", async () => {
  const res = await raw({ host: `127.0.0.1:${port}`, method: "POST", path: "/agent/tools/account_context", body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  const body = JSON.parse(res.body);
  assert.ok(body.account_sets.some((s) => s.name === "SYNTHETIC_ORIGIN_PROBE"));
});

test("静态文件（不含业务数据）回环访问不受影响", async () => {
  const res = await raw({ host: `127.0.0.1:${port}`, path: "/" });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"] ?? "", /^text\/html/);
});

test("税务 Agent 简单表单请求被拒绝，即便无 Origin 也不接受 text/plain", async () => {
  const res = await raw({ host: `127.0.0.1:${port}`, method: "POST", path: "/agent/tools/tax_resource_collect",
    contentType: "text/plain", body: { sessionId: "synthetic", resource: "tax_assessments", period: "2026-09" } });
  assert.equal(res.status, 415);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("税务 Agent 的跨站请求不得经过新工具链", async () => {
  for (const tool of ["tax_session_verify", "tax_resource_collect", "tax_preparation_build"]) {
    const res = await raw({ host: `127.0.0.1:${port}`, method: "POST", path: `/agent/tools/${tool}`, origin: EVIL_ORIGIN,
      body: { sessionId: "synthetic", period: "2026-09" } });
    assertForbidden(res, ["synthetic"]);
  }
});
