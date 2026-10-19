#!/usr/bin/env node
/**
 * tax-browser-security.test.mjs — 税局浏览器 HTTP 接口安全出口专项测试（RC-A0）
 *
 * 目标（只验证 HTTP 出口，不触真实浏览器/税局）：
 *   A. sendError 固定文案字典：任意 err.code/message/details（含合成哨兵）都不得出现在响应；
 *      未知 code（含 __proto__/constructor 等怪 code）统一 500 tax_browser_internal。
 *   B. 连接来源回环校验：远端 socket 即使伪造 Host/Origin 也拒绝；本机回环放行；
 *      绝不信任 X-Forwarded-*。
 *   C. 未知路径固定 404（不回显 pathname）；请求体读取失败固定文案。
 *   D. 所有响应不带任何 CORS 放行头。
 *   E. 原一次性令牌重放不影响后续且被拒绝。
 *
 * 直接调用 createTaxBrowserRoutes 返回的真实路由函数（注入假 service / 假 socket），
 * 不启动浏览器、不连接真实税务系统、不使用真实凭据。
 *
 * 运行：node test/tax-browser-security.test.mjs（在 06-workbench 目录）
 */
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";

const {
  createTaxBrowserRoutes,
  isLoopbackAddress,
  checkLocalOrigin,
} = await import("../server/tax-browser-http.mjs");
const { TaxBrowserError } = await import("../server/tax-browser.mjs");

const SENTINEL = "SYNTHETIC_SECRET_SENTINEL";

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.message}`); }
};

// ---------------------------------------------------------------- 假 req/res
function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; this.headersSent = true; return this; },
    end(chunk) { if (chunk) this.body += String(chunk); this.ended = true; return this; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

function makeReq({ method = "GET", headers = {}, remoteAddress = "127.0.0.1", body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress };
  process.nextTick(() => {
    if (body !== undefined) {
      const raw = typeof body === "string" ? body : JSON.stringify(body);
      req.emit("data", Buffer.from(raw));
    }
    req.emit("end");
  });
  return req;
}

async function callRoute(routes, { method = "GET", path, headers = {}, remoteAddress = "127.0.0.1", body } = {}) {
  const res = makeRes();
  const url = new URL(path, "http://127.0.0.1");
  const req = makeReq({ method, headers, remoteAddress, body });
  // POST 默认带 application/json（除非用例显式覆盖），与真实请求一致。
  if (method === "POST" && !("content-type" in req.headers)) req.headers["content-type"] = "application/json";
  await routes(req, res, url, method);
  return { status: res.statusCode, headers: res.headers || {}, body: res.json() };
}

const HOST = "127.0.0.1:8787";
const okOrigin = { host: HOST, origin: `http://${HOST}` };
const assertNoSentinel = (r, label) => {
  const text = JSON.stringify(r);
  assert.ok(!text.includes(SENTINEL), `${label}: 响应泄漏了合成哨兵：${text.slice(0, 300)}`);
};
const assertNoCors = (r, label) => {
  for (const key of Object.keys(r.headers)) {
    assert.ok(!/^access-control-/i.test(key), `${label}: 不得带 CORS 头 ${key}`);
  }
};

// ---------------------------------------------------------------- 假 service
const configStub = { supported: [{ region: "350000", city: "350600" }], browser: { found: true } };

/** service：所有动作都抛出给定错误（用于探测错误出口）。 */
function throwingService(makeError) {
  const boom = () => { throw makeError(); };
  return {
    describeConfig: () => configStub,
    issueLoginToken: () => "taxlt_probe",
    openSession: async () => boom(),
    getSession: () => boom(),
    readCurrentPage: async () => boom(),
    closeSession: async () => boom(),
    importCandidates: async () => boom(),
  };
}

/** service：可正常发放/消费一次性令牌（用于令牌重放）。 */
function tokenService() {
  let token = null;
  let seq = 0;
  const sessions = new Map();
  return {
    describeConfig: () => configStub,
    issueLoginToken: () => { token = `taxlt_${++seq}`; return token; },
    openSession: async ({ loginToken }) => {
      if (!loginToken || loginToken !== token) {
        const e = new Error(`bad token ${SENTINEL}`); e.code = "tax_browser_login_token_invalid"; e.details = { secret: SENTINEL };
        throw e;
      }
      token = null; // 单次使用
      const id = `taxb_${++seq}`;
      sessions.set(id, { sessionId: id, status: "open" });
      return { sessionId: id, status: "open" };
    },
    getSession: ({ sessionId }) => {
      const s = sessions.get(sessionId);
      if (!s) { const e = new Error("nf"); e.code = "tax_browser_session_not_found"; throw e; }
      return s;
    },
    readCurrentPage: async () => ({ read: { count: 0, items: [] } }),
    closeSession: async ({ sessionId }) => ({ sessionId, status: "closed" }),
    importCandidates: async () => ({ results: [] }),
  };
}

console.log("\nA. sendError 安全字典（不透传 code/message/details）\n");

await test("已知 browser code：message/details 含哨兵 → 固定文案，无 details", async () => {
  const routes = createTaxBrowserRoutes(throwingService(() => {
    const e = new TaxBrowserError("tax_browser_read_failed", `boom ${SENTINEL}`, { page: SENTINEL });
    return e;
  }));
  const r = await callRoute(routes, { method: "POST", path: "/api/tax-browser/sessions/taxb_x/read", headers: okOrigin, body: {} });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "tax_browser_read_failed");
  assert.equal(r.body.message, "页面读取失败，请稍后重试");
  assert.ok(!("details" in r.body), "不得包含 details");
  assertNoSentinel(r, "read_failed");
  assertNoCors(r, "read_failed");
});

await test("CDP 错误：details.cdpError 含哨兵 → 不得透出", async () => {
  const routes = createTaxBrowserRoutes(throwingService(() => {
    const e = new TaxBrowserError("tax_browser_cdp_error", `CDP ${SENTINEL}`, { cdpError: SENTINEL });
    return e;
  }));
  const r = await callRoute(routes, { method: "POST", path: "/api/tax-browser/sessions/taxb_x/close", headers: okOrigin, body: {} });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "tax_browser_cdp_error");
  assertNoSentinel(r, "cdp_error");
});

await test("导入校验 code：message/details 含哨兵 → 固定文案", async () => {
  const routes = createTaxBrowserRoutes(throwingService(() => {
    const e = new Error(`导入失败 ${SENTINEL}`); e.code = "taxpayer_id_invalid"; e.details = { raw: SENTINEL };
    throw e;
  }));
  const r = await callRoute(routes, { method: "POST", path: "/api/tax-browser/sessions/taxb_x/import", headers: okOrigin, body: { candidateIds: ["c_1"], mode: "create" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "taxpayer_id_invalid");
  assert.equal(r.body.message, "企业税号严格校验未通过");
  assertNoSentinel(r, "import_error");
});

await test("未知/怪 code（__proto__/constructor/toString/伪造）→ 500 tax_browser_internal，无哨兵", async () => {
  for (const code of ["__proto__", "constructor", "toString", "hasOwnProperty", "evil_sentinel_code", "tax_browser_NOT_REAL"]) {
    const routes = createTaxBrowserRoutes(throwingService(() => {
      const e = new Error(`boom ${SENTINEL}`); e.code = code; e.details = { leak: SENTINEL };
      throw e;
    }));
    const r = await callRoute(routes, { method: "POST", path: "/api/tax-browser/sessions/taxb_x/read", headers: okOrigin, body: {} });
    assert.equal(r.status, 500, `code=${code} 应返回 500`);
    assert.equal(r.body.error, "tax_browser_internal", `code=${code}`);
    assert.equal(r.body.message, "服务内部错误", `code=${code}`);
    assertNoSentinel(r, `weird_code ${code}`);
    assertNoCors(r, `weird_code ${code}`);
  }
});

await test("已登记状态码保持原行为（session_not_found 404 / closed 409 / expired 410）", async () => {
  const cases = [
    ["tax_browser_session_not_found", 404],
    ["tax_browser_session_closed", 409],
    ["tax_browser_session_expired", 410],
  ];
  for (const [code, status] of cases) {
    const routes = createTaxBrowserRoutes(throwingService(() => { const e = new Error(SENTINEL); e.code = code; return e; }));
    const r = await callRoute(routes, { method: "GET", path: "/api/tax-browser/sessions/taxb_x", headers: okOrigin });
    assert.equal(r.status, status, code);
    assertNoSentinel(r, code);
  }
});

await test("非 Error 抛出（字符串/对象）也统一 500 固定文案", async () => {
  for (const thrown of [`${SENTINEL}`, { message: SENTINEL }, null, 42]) {
    const routes = createTaxBrowserRoutes(throwingService(() => { throw thrown; }));
    const r = await callRoute(routes, { method: "POST", path: "/api/tax-browser/sessions/taxb_x/read", headers: okOrigin, body: {} });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "tax_browser_internal");
    assertNoSentinel(r, `throw ${String(thrown)}`);
  }
});

console.log("\nB. 连接来源回环校验\n");

await test("isLoopbackAddress：接受 127.0.0.1 / ::1 / ::ffff:127.0.0.1 / 127.0.0.0-8", () => {
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.2", "127.1.2.3"]) {
    assert.equal(isLoopbackAddress(a), true, a);
  }
  for (const a of ["10.0.0.1", "192.168.1.2", "::ffff:10.0.0.1", "0.0.0.0", "8.8.8.8", "", null, undefined, "127.0.0.1 evil", "999.0.0.1"]) {
    assert.equal(isLoopbackAddress(a), false, String(a));
  }
});

await test("远端 socket + 伪造本机 Host/Origin → 403 remote_not_local，不发令牌", async () => {
  const svc = tokenService();
  const routes = createTaxBrowserRoutes(svc);
  for (const remote of ["203.0.113.9", "10.1.2.3", "::ffff:198.51.100.7"]) {
    const r = await callRoute(routes, { method: "GET", path: "/api/tax-browser/config", headers: okOrigin, remoteAddress: remote });
    assert.equal(r.status, 403, remote);
    assert.equal(r.body.error, "remote_not_local", remote);
    assert.equal(r.body.loginToken, undefined, remote);
    assertNoSentinel(r, remote);
    assertNoCors(r, remote);
  }
});

await test("远端 socket 绝不信任 X-Forwarded-For/Real-IP", async () => {
  const routes = createTaxBrowserRoutes(tokenService());
  const r = await callRoute(routes, {
    method: "GET", path: "/api/tax-browser/config",
    headers: { ...okOrigin, "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1", "forwarded": "for=127.0.0.1" },
    remoteAddress: "203.0.113.9",
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "remote_not_local");
  assert.equal(r.body.loginToken, undefined);
});

await test("本机 socket（127.0.0.1 / ::1 / ::ffff:127.0.0.1）准入 config", async () => {
  for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    const routes = createTaxBrowserRoutes(tokenService());
    const r = await callRoute(routes, { method: "GET", path: "/api/tax-browser/config", headers: okOrigin, remoteAddress: remote });
    assert.equal(r.status, 200, remote);
    assert.ok(String(r.body.loginToken).startsWith("taxlt_"), remote);
    assertNoCors(r, remote);
  }
});

await test("本机 socket 但 Host/Origin 非回环 → 仍拒绝（403）", async () => {
  const routes = createTaxBrowserRoutes(tokenService());
  const badHost = await callRoute(routes, { method: "GET", path: "/api/tax-browser/config", headers: { host: "evil.example:8787", origin: "https://evil.example:8787" } });
  assert.equal(badHost.status, 403);
  assert.equal(badHost.body.error, "host_not_local");
  const badOrigin = await callRoute(routes, { method: "GET", path: "/api/tax-browser/config", headers: { host: HOST, origin: "https://evil.example" } });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.body.error, "origin_not_allowed");
});

await test("checkLocalOrigin 纯 helper 行为保持（header 级测试兼容）", () => {
  assert.deepEqual(checkLocalOrigin({ headers: { host: HOST, origin: `http://${HOST}` } }), { ok: true, origin: `http://${HOST}`, reason: null });
  assert.equal(checkLocalOrigin({ headers: { host: HOST } }).ok, true);
  assert.equal(checkLocalOrigin({ headers: { host: "evil.example:1" } }).reason, "host_not_local");
  assert.equal(checkLocalOrigin({ headers: { host: HOST, origin: "https://evil.example" } }).reason, "origin_not_allowed");
});

console.log("\nC. 未知路径 / 请求体读取失败（固定文案）\n");

await test("未知路径 404 固定文案，不回显 pathname / 哨兵", async () => {
  const routes = createTaxBrowserRoutes(tokenService());
  const r = await callRoute(routes, { method: "GET", path: `/api/tax-browser/${SENTINEL}/secret`, headers: okOrigin });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "not_found");
  assert.ok(!r.body.message.includes(SENTINEL), "不得回显 pathname");
  assert.ok(!r.body.message.includes("secret"), "不得回显 pathname");
  assertNoSentinel(r, "not_found");
  assertNoCors(r, "not_found");
});

await test("POST 非 JSON content-type → 400 json_content_type_required 固定文案", async () => {
  const routes = createTaxBrowserRoutes(tokenService());
  const r = await callRoute(routes, {
    method: "POST", path: "/api/tax-browser/sessions",
    headers: { ...okOrigin, "content-type": "text/plain" }, body: `x=${SENTINEL}`,
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "json_content_type_required");
  assert.equal(r.body.message, "POST 必须是 application/json");
  assertNoSentinel(r, "bad content-type");
});

await test("POST 坏 JSON → 400 invalid_json 固定文案", async () => {
  const routes = createTaxBrowserRoutes(tokenService());
  const r = await callRoute(routes, {
    method: "POST", path: "/api/tax-browser/sessions",
    headers: { ...okOrigin, "content-type": "application/json" }, body: `{${SENTINEL}`,
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_json");
  assert.equal(r.body.message, "请求体不是合法 JSON");
  assertNoSentinel(r, "bad json");
});

console.log("\nD. 无 CORS + 一次性令牌重放\n");

await test("OPTIONS 预检：204 且无任何 CORS 放行头", async () => {
  const routes = createTaxBrowserRoutes(tokenService());
  const r = await callRoute(routes, { method: "OPTIONS", path: "/api/tax-browser/config", headers: { host: HOST, origin: "https://evil.example" } });
  assert.equal(r.status, 204);
  assertNoCors(r, "options");
});

await test("成功响应同样无 CORS 头", async () => {
  const routes = createTaxBrowserRoutes(tokenService());
  const r = await callRoute(routes, { method: "GET", path: "/api/tax-browser/config", headers: okOrigin });
  assert.equal(r.status, 200);
  assertNoCors(r, "config ok");
});

await test("原令牌重放：首次成功、重放 403 固定文案且无哨兵；不影响后续令牌", async () => {
  const routes = createTaxBrowserRoutes(tokenService());
  const cfg = await callRoute(routes, { method: "GET", path: "/api/tax-browser/config", headers: okOrigin });
  const token = cfg.body.loginToken;
  assert.ok(String(token).startsWith("taxlt_"));

  const first = await callRoute(routes, { method: "POST", path: "/api/tax-browser/sessions", headers: okOrigin, body: { region: "350000", city: "350600", loginToken: token } });
  assert.equal(first.status, 201);
  assert.ok(String(first.body.sessionId).startsWith("taxb_"));

  const replay = await callRoute(routes, { method: "POST", path: "/api/tax-browser/sessions", headers: okOrigin, body: { region: "350000", city: "350600", loginToken: token } });
  assert.equal(replay.status, 403);
  assert.equal(replay.body.error, "tax_browser_login_token_invalid");
  assert.equal(replay.body.message, "登录令牌无效或已过期");
  assertNoSentinel(replay, "replay");

  const cfg2 = await callRoute(routes, { method: "GET", path: "/api/tax-browser/config", headers: okOrigin });
  const second = await callRoute(routes, { method: "POST", path: "/api/tax-browser/sessions", headers: okOrigin, body: { region: "350000", city: "350600", loginToken: cfg2.body.loginToken } });
  assert.equal(second.status, 201, "新令牌仍可用");
  assertNoSentinel(second, "second token");
});

// ---------------------------------------------------------------- 收尾
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过\n`);
process.exitCode = failed ? 1 : 0;
