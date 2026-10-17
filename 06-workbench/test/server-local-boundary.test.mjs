#!/usr/bin/env node
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
A.createAccountSet({ name: "合成边界测试公司", start_period: "2026-01" });

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

/** 原生 HTTP 请求：可传任意 Host 头（fetch 会拒绝设置 Host）。 */
function raw({ host, method = "GET", path = "/api/meta" } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { host }, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(10000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
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
  const res = await raw({ host: "evil.example", path: "/api/tax-browser/config" });
  assert.equal(res.status, 403);
  assert.match(res.headers["content-type"] ?? "", /^application\/json/);
  assert.equal(res.headers["access-control-allow-origin"], undefined, "税局接口不得发送 CORS 放行头");
  const body = JSON.parse(res.body);
  assert.equal(body.error, "host_not_local");
  assert.doesNotMatch(res.body, /evil\.example/, "不得回显敌对 Host");
  assert.equal(res.body.includes("loginToken"), false, "拒绝时不得发放令牌");
});

test("回环 Host 的税局只读接口正常（服务边界未误伤正常路径）", async () => {
  const res = await raw({ host: `127.0.0.1:${port}`, path: "/api/tax-browser/config" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  const body = JSON.parse(res.body);
  assert.equal(typeof body.loginToken, "string");
});
