#!/usr/bin/env node
/**
 * tax-contract-test.mjs — 全国电子税务局适配层契约测试
 *
 * 分两部分：
 *   A. 网关状态机单测：纯本地构造 TaxGateway 并显式注入 fake adapter，
 *      覆盖未配置默认、状态流转、challenge 不回显、跨区域/跨账套隔离、过期、退出、
 *      不可用资源、结构化错误、DTO 白名单与凭据脱敏；
 *      并额外覆盖 ①异步适配器（Promise，含异步拒绝）②并发下的终态保护
 *      ③大陆 31+5 税务服务目录与计划单列市独立路由 ④infoQuery params 平面白名单
 *      ⑤协议错误（空对象 / requires_action 无 challenge）
 *      ⑥迟到的 startLogin 与「已过期的 expiresAt 不得冒充已认证」
 *      ⑦脱敏边界（challenge 提示 / DTO 字段 / 错误码回显、数字与短验证码、脱敏先于截断）
 *      ⑧已知明文的内存暂存生命周期（会话终结清理 + 全局/每会话上限）。
 *   B. 接线往返：自己启动临时后端（独立数据目录 + 空闲端口）再 spawn stdio MCP，
 *      验证 tools/list 公布税务工具，且「默认未配置」在后端与 MCP 两层都如实返回。
 *
 * 运行：node tax-contract-test.mjs
 * 不连接真实税务系统、不访问网络；全部适配器都是本进程内的假实现。
 * 退出时清理子进程与临时库。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { McpStdioClient } from "./mcp-stdio-client.mjs";
import { TOOLS } from "./tools.mjs";
import { TAX_TOOL_NAMES } from "./tax-tools.mjs";
import { TaxGateway, TaxError, MAINLAND_TAX_REGIONS, MAX_SECRETS, MAX_SESSION_SECRETS } from "../../../../06-workbench/server/tax-gateway.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..", "..");
const WORKBENCH = join(REPO, "06-workbench", "server", "server.mjs");

const GD = "440000";
const SH = "310000";
const SZ = "440300";
const CHALLENGE_SECRET = "975310";
const COOKIE_SECRET = "JSESSIONID=deadbeefcafe";
const PASSWORD_SECRET = "hunter2secret";
const TOKEN_SECRET = "eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl";

const OFFICIAL_REGION_SOURCE = "https://12366.chinatax.gov.cn/wap/pages/index.html";
const OFFICIAL_CITY_SOURCE = "https://12366.chinatax.gov.cn/wap/pages/form_common.html";

/** 任何异步拒绝都不允许漏成 unhandled rejection：收集起来在末尾断言为空。 */
const unhandled = [];
process.on("unhandledRejection", (reason) => { unhandled.push(reason); });

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.message}`); }
}
/** 断言 fn（同步抛或返回被拒 Promise）抛出 TaxError，且 code 命中预期；返回该错误。 */
async function assertTaxError(code, fn) {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof TaxError, `应抛 TaxError，实际 ${e?.name}: ${e?.message}`);
    assert.equal(e.code, code, `错误码应为 ${code}，实际 ${e.code}（${e.message}）`);
    return e;
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`);
}
/** 局部同步断言（注册等同步路径）。 */
function assertTaxErrorSync(code, fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof TaxError, `应抛 TaxError，实际 ${e?.name}: ${e?.message}`);
    assert.equal(e.code, code, `错误码应为 ${code}，实际 ${e.code}（${e.message}）`);
    return e;
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`);
}
const json = (v) => JSON.stringify(v ?? null);
/** 本地 deferred：用于「先挂起适配器调用，再退出/过期，最后 resolve」的并发用例。 */
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ------------------------------------------------------------------ 假适配器
const IDENTITY = {
  subjectId: "operator-1",
  name: "张三",
  idType: "居民身份证",
  idNumber: "110101199001011234",
  phone: "13800001234",
  roles: ["办税员", "财务负责人"],
  region: GD,
};

const CAPS = {
  resources: ["identity", "authorized_enterprises", "enterprise_profile", "tax_assessments", "declaration_status"],
  loginMethods: ["sms", "qrcode"],
  challengeActions: ["sms_code"],
};

/** 同步假适配器：验证「同步实现照样能被 await 兼容」。 */
function fakeAdapter(overrides = {}) {
  const state = new Map();
  const base = {
    adapterId: "demo-guangdong",
    region: GD,
    label: "本地测试适配器（非真实税局）",
    version: "test-1",
    capabilities: { ...CAPS },
    startLogin(ctx) {
      state.set(ctx.sessionId, { authenticated: false, accountSetId: ctx.accountSetId });
      return {
        status: "requires_action",
        challenge: { action: "sms_code", prompt: "请输入短信验证码", hint: "已发送至预留手机号" },
        expiresAt: Date.now() + 60000,
      };
    },
    getStatus(ctx) {
      const s = state.get(ctx.sessionId) || {};
      return { status: s.authenticated ? "authenticated" : "requires_action" };
    },
    submitChallenge(ctx, { action, response }) {
      const s = state.get(ctx.sessionId) || {};
      if (String(response) !== "123456") return { status: "requires_action", challenge: { action, prompt: "验证码不正确，请重试" } };
      s.authenticated = true;
      state.set(ctx.sessionId, s);
      return { status: "authenticated" };
    },
    logout(ctx) { state.delete(ctx.sessionId); return { status: "logged_out" }; },
    query(ctx, { resource }) {
      if (resource === "identity") return IDENTITY;
      if (resource === "authorized_enterprises") return [{ enterpriseId: "E1", name: "示例公司", taxpayerId: "91440100MA5XXXXX1A", role: "办税员", status: "正常", region: ctx.region }];
      return [];
    },
  };
  return { ...base, ...overrides, capabilities: { ...base.capabilities, ...(overrides.capabilities || {}) } };
}

/**
 * 异步假适配器：所有方法都返回 Promise（模拟真实适配器必然异步）。
 * login → 待验证 → 验证码正确才认证；查询/退出同样异步。
 */
function asyncFakeAdapter(overrides = {}) {
  const state = new Map();
  const tick = () => new Promise((r) => setImmediate(r));
  const base = {
    adapterId: "demo-guangdong-async",
    region: GD,
    label: "本地异步测试适配器（非真实税局）",
    version: "test-async-1",
    capabilities: { ...CAPS },
    async startLogin(ctx) {
      await tick();
      state.set(ctx.sessionId, { authenticated: false, accountSetId: ctx.accountSetId });
      return {
        status: "requires_action",
        challenge: { action: "sms_code", prompt: "请输入短信验证码（异步）" },
        expiresAt: Date.now() + 60000,
      };
    },
    async getStatus(ctx) {
      await tick();
      const s = state.get(ctx.sessionId) || {};
      return { status: s.authenticated ? "authenticated" : "requires_action" };
    },
    async submitChallenge(ctx, { action, response }) {
      await tick();
      const s = state.get(ctx.sessionId) || {};
      if (String(response) !== "123456") {
        return { status: "requires_action", challenge: { action, prompt: "验证码不正确，请重试（异步）" } };
      }
      s.authenticated = true;
      state.set(ctx.sessionId, s);
      return { status: "authenticated" };
    },
    async logout(ctx) { await tick(); state.delete(ctx.sessionId); return { status: "logged_out" }; },
    async query(ctx, { resource, params }) {
      await tick();
      if (resource === "identity") return { ...IDENTITY, region: ctx.region, seenParams: params };
      return [];
    },
  };
  return { ...base, ...overrides, capabilities: { ...base.capabilities, ...(overrides.capabilities || {}) } };
}

/** 走完「发起登录 → 提交验证码」拿到已认证会话。 */
async function authenticatedSession(gateway, args = { region: GD, accountSetId: 1 }) {
  const started = await gateway.startLogin(args);
  await gateway.submitChallenge({ sessionId: started.sessionId, action: "sms_code", response: "123456" });
  return started.sessionId;
}

const makeGateway = (opts = {}) => new TaxGateway({ accountSetExists: (id) => id === 1, ...opts });

// ================================================================== PART A
async function partA() {
  console.log("\nA. 网关契约（本地 fake adapter，不联网）\n");

  await test("默认未配置：无任何适配器、不创建会话、不伪造已认证", async () => {
    const gw = makeGateway();
    const regions = gw.listRegions();
    assert.equal(regions.nationwide.productTarget, true, "全国是产品目标");
    assert.equal(regions.nationwide.taxTarget, false, "全国不是税务服务地区");
    assert.equal(regions.nationwide.configured, false, "全国默认未接入");
    assert.equal(regions.nationwide.status, "not_configured");
    assert.deepEqual(regions.configuredRegions, [], "默认没有任何已接入地区");
    assert.equal(regions.summary.regionsConfigured, 0);
    assert.equal(regions.summary.adaptersTotal, 0);
    assert.equal(regions.regions.length, 36, "大陆目录 = 31 省级行政区 + 5 计划单列市");
    assert.ok(regions.contract.resources.some((r) => r.id === "declaration_status"), "契约应公布资源类型");
    assert.ok(regions.contract.states.includes("requires_action"), "契约应公布状态机");

    const caps = gw.listCapabilities({ region: GD });
    assert.equal(caps.configured, false);
    assert.deepEqual(caps.adapters, []);

    await assertTaxError("tax_region_not_configured", () => gw.startLogin({ region: GD }));
    assert.equal(gw.sessions.size, 0, "未配置时不得创建任何会话");
  });

  await test("大陆目录为 31+5：kind/parentRegion 齐全，计划单列市不与省混同", () => {
    const gw = makeGateway();
    const regions = gw.listRegions();
    const provinces = regions.regions.filter((r) => r.kind === "province");
    const cities = regions.regions.filter((r) => r.kind === "separately_planned_city");
    assert.equal(provinces.length, 31, "31 个省级行政区");
    assert.equal(cities.length, 5, "5 个计划单列市");
    assert.deepEqual(cities.map((c) => c.region).sort(), ["210200", "330200", "350200", "370200", "440300"]);
    for (const c of cities) {
      assert.ok(c.parentRegion, `${c.region} 应有 parentRegion`);
      assert.equal(c.taxTarget, true);
      assert.ok(c.note.includes("联调"), "计划单列市应说明路由键需实地联调确认");
    }
    assert.equal(regions.regions.find((r) => r.region === SZ).parentRegion, GD, "深圳的 parentRegion 是广东（仅归属信息）");
    assert.equal(regions.regions.find((r) => r.region === "210200").parentRegion, "210000");
    assert.equal(regions.regions.every((r) => r.configured === false), true, "默认全部未接入");
    assert.equal(MAINLAND_TAX_REGIONS.length, 36, "导出的目录常量应为 36 条");
  });

  await test("港澳台单列 out_of_scope：不同 jurisdiction，不是本期税务目标", async () => {
    const gw = makeGateway();
    const regions = gw.listRegions();
    assert.equal(regions.outOfScope.length, 3);
    assert.equal(regions.summary.outOfScopeTotal, 3);
    for (const row of regions.outOfScope) {
      assert.equal(row.taxTarget, false);
      assert.equal(row.outOfScope, true);
      assert.equal(row.kind, "out_of_scope");
      assert.ok(["TW", "HK", "MO"].includes(row.jurisdiction), `jurisdiction 应区分：${row.jurisdiction}`);
      assert.equal(row.configured, false);
    }
    // 不得混在 province 税务目标里
    assert.equal(regions.regions.some((r) => ["710000", "810000", "820000"].includes(r.region)), false);

    for (const code of ["710000", "810000", "820000"]) {
      await assertTaxError("tax_region_out_of_scope", () => gw.startLogin({ region: code }));
      await assertTaxError("tax_region_out_of_scope", () => gw.listCapabilities({ region: code }));
    }
    assert.equal(gw.sessions.size, 0, "域外地区不得创建会话");
  });

  await test("CN 只是产品入口：不能注册适配器、不能作为登录目标", async () => {
    const gw = makeGateway();
    assertTaxErrorSync("tax_region_not_a_tax_target", () => gw.registerAdapter(fakeAdapter({ region: "CN" })));
    assert.equal(gw.adapterCount(), 0);
    await assertTaxError("tax_region_not_a_tax_target", () => gw.startLogin({ region: "CN" }));
    // 目录里仍然汇报 CN，但明确 taxTarget=false
    const caps = gw.listCapabilities({ region: "CN" });
    assert.equal(caps.taxTarget, false);
    assert.equal(caps.configured, false);
    assert.equal(caps.kind, "nationwide");
  });

  await test("官方来源链接如实记录（12366 地区目录 / 计划单列市选市税务局）", () => {
    const gw = makeGateway();
    const sources = gw.listRegions().sources;
    assert.equal(sources.length, 2);
    assert.equal(sources[0].url, OFFICIAL_REGION_SOURCE);
    assert.equal(sources[1].url, OFFICIAL_CITY_SOURCE);
    assert.ok(sources[1].label.includes("勿选所在省"), "应写明计划单列市直接选市税务局");
  });

  await test("未知地区 / 缺地区 结构化失败", async () => {
    const gw = makeGateway();
    await assertTaxError("tax_region_required", () => gw.startLogin({}));
    await assertTaxError("tax_region_unknown", () => gw.listCapabilities({ region: "999999" }));
    await assertTaxError("tax_region_unknown", () => gw.startLogin({ region: "999999" }));
  });

  await test("注册适配器后 capabilities 如实反映声明；未注册 adapterId 报错", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter());
    const caps = gw.listCapabilities({ region: GD });
    assert.equal(caps.configured, true);
    assert.equal(caps.adapters[0].adapterId, "demo-guangdong");
    assert.deepEqual(caps.adapters[0].loginMethods, ["sms", "qrcode"]);
    assert.deepEqual(caps.adapters[0].challengeActions, ["sms_code"]);
    assert.equal(caps.adapters[0].implemented.query, true);
    assert.equal(gw.listRegions().summary.regionsConfigured, 1);
    assert.deepEqual(gw.listRegions().configuredRegions, [GD]);
    assertTaxErrorSync("tax_adapter_not_found", () => gw.listCapabilities({ region: GD, adapterId: "nope" }));
    await assertTaxError("tax_adapter_not_found", () => gw.startLogin({ region: GD, adapterId: "nope" }));
  });

  await test("非法适配器声明被拒绝（未定义资源/登录方式/非法 adapterId）", () => {
    const gw = makeGateway();
    assertTaxErrorSync("tax_adapter_invalid", () => gw.registerAdapter(fakeAdapter({ adapterId: "BAD ID" })));
    assertTaxErrorSync("tax_adapter_invalid", () => gw.registerAdapter(fakeAdapter({ capabilities: { resources: ["unknown_resource"] } })));
    assertTaxErrorSync("tax_adapter_invalid", () => gw.registerAdapter(fakeAdapter({ capabilities: { loginMethods: ["magic"] } })));
    assert.equal(gw.adapterCount(), 0, "非法适配器不得进入注册表");
  });

  await test("会话 ID 不可猜，且绑定 region + accountSetId", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter());
    const a = await gw.startLogin({ region: GD, accountSetId: 1 });
    const b = await gw.startLogin({ region: GD, accountSetId: 1 });
    assert.match(a.sessionId, /^taxs_[A-Za-z0-9_-]{32}$/, `会话 ID 形态异常：${a.sessionId}`);
    assert.notEqual(a.sessionId, b.sessionId, "会话 ID 不得重复");
    const seen = new Set([a.sessionId, b.sessionId]);
    for (let i = 0; i < 200; i += 1) seen.add((await gw.startLogin({ region: GD, accountSetId: 1 })).sessionId);
    assert.equal(seen.size, 202, "会话 ID 必须高熵且不重复");
    assert.equal(a.region, GD);
    assert.equal(a.accountSetId, 1);
    assert.equal(a.status, "requires_action");
    assert.equal(a.requiresAction, true);
    assert.equal(a.authenticated, false, "未完成人工验证前不得声称已认证");
    assert.equal(a.challenge.action, "sms_code");
    assert.ok(a.expiresAt, "应给出 expiresAt 供失效判断");
  });

  await test("账套校验：不存在/未接入校验一律拒绝，不绑定假账套", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter());
    await assertTaxError("account_set_not_found", () => gw.startLogin({ region: GD, accountSetId: 999 }));
    await assertTaxError("accountSetId_invalid", () => gw.startLogin({ region: GD, accountSetId: "abc" }));
    const noVerifier = new TaxGateway({ accountSetExists: null });
    noVerifier.registerAdapter(fakeAdapter());
    await assertTaxError("tax_account_set_verification_unavailable", () => noVerifier.startLogin({ region: GD, accountSetId: 1 }));
    // 不提供账套时不绑定，仍可发起（企业级会话）
    const s = await gw.startLogin({ region: GD, enterprise: { enterpriseId: "E1", name: "示例公司" } });
    assert.equal(s.accountSetId, null);
    assert.deepEqual(s.enterprise, { enterpriseId: "E1", name: "示例公司" });
  });

  await test("明文凭据被拒绝（顶层与嵌套），credentialRef 只留引用不回显", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter());
    for (const args of [
      { region: GD, password: "p@ss" },
      { region: GD, username: "admin" },
      { region: GD, credentials: { password: "p@ss" } },
      { region: GD, token: TOKEN_SECRET },
    ]) {
      await assertTaxError("tax_plaintext_credential_rejected", () => gw.startLogin(args));
    }
    const s = await gw.startLogin({ region: GD, credentialRef: "vault://tax/demo-operator" });
    assert.equal(s.hasCredentialRef, true);
    assert.equal(json(s).includes("vault://tax/demo-operator"), false, "credentialRef 明文不得回显");
  });

  await test("challenge 状态流转：动作不匹配/缺响应被拒；正确响应后 authenticated", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter());
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });

    await assertTaxError("tax_challenge_action_mismatch", () =>
      gw.submitChallenge({ sessionId: s.sessionId, action: "qrcode_scan", response: "x" }));
    await assertTaxError("tax_challenge_response_required", () =>
      gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: "" }));
    assert.equal((await gw.getStatus({ sessionId: s.sessionId })).status, "requires_action", "被拒后仍应停在待验证");

    const ok = await gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: "123456" });
    assert.equal(ok.status, "authenticated");
    assert.equal(ok.authenticated, true);
    assert.equal(ok.challenge, null, "认证后不应再有待处理挑战");
    assert.equal((await gw.getStatus({ sessionId: s.sessionId })).status, "authenticated");
  });

  await test("challenge 响应不回显、不落库；后续查询也看不到", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter());
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });
    const submitted = await gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: CHALLENGE_SECRET });
    const status = await gw.getStatus({ sessionId: s.sessionId });
    const stored = gw.sessions.get(s.sessionId);
    for (const [label, value] of [["challenge 返回", submitted], ["status 返回", status], ["会话对象", stored]]) {
      assert.equal(json(value).includes(CHALLENGE_SECRET), false, `${label} 不得回显验证响应`);
    }
  });

  await test("未认证会话不得查询；跨区域与跨账套一律拒绝", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter());
    gw.registerAdapter(fakeAdapter({ adapterId: "demo-shanghai", region: SH, label: "上海测试适配器" }));
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });
    await assertTaxError("tax_session_not_authenticated", () => gw.infoQuery({ sessionId: s.sessionId, resource: "identity" }));

    await gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: "123456" });
    const mine = await gw.infoQuery({ sessionId: s.sessionId, resource: "identity" });
    assert.equal(mine.region, GD);
    assert.equal(mine.accountSetId, 1);
    assert.equal(mine.data.item.subjectId, "operator-1");
    // 敏感字段一律掩码：只保留首尾，中间以 * 代替，且绝不等于原值
    const masked = (value, head, tail) =>
      value.startsWith(head) && (tail ? value.endsWith(tail) : true) && value.includes("*");
    assert.ok(masked(mine.data.item.name, "张", ""), `姓名应脱敏：${mine.data.item.name}`);
    assert.ok(masked(mine.data.item.idNumber, "110101", "1234"), `证件号应脱敏：${mine.data.item.idNumber}`);
    assert.ok(masked(mine.data.item.phone, "138", "1234"), `手机号应脱敏：${mine.data.item.phone}`);
    assert.notEqual(mine.data.item.idNumber, IDENTITY.idNumber);

    // 同一会话带另一地区 -> 拒绝（不得借会话读到别的地区）
    await assertTaxError("tax_region_mismatch", () => gw.infoQuery({ sessionId: s.sessionId, resource: "identity", region: SH }));
    // 同一会话带另一账套 -> 拒绝；带绑定账套 -> 允许
    await assertTaxError("tax_account_set_mismatch", () => gw.infoQuery({ sessionId: s.sessionId, resource: "identity", accountSetId: 2 }));
    assert.equal((await gw.infoQuery({ sessionId: s.sessionId, resource: "identity", accountSetId: 1 })).accountSetId, 1);
    // 未绑定账套的会话：任何账套参数都拒绝
    const free = await authenticatedSession(gw, { region: GD });
    await assertTaxError("tax_account_set_mismatch", () => gw.infoQuery({ sessionId: free, resource: "identity", accountSetId: 1 }));
  });

  await test("资源：未知类型/适配器未声明一律结构化失败", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({ capabilities: { resources: ["identity"] } }));
    const sid = await authenticatedSession(gw);
    await assertTaxError("tax_resource_unknown", () => gw.infoQuery({ sessionId: sid, resource: "bank_accounts" }));
    await assertTaxError("tax_resource_required", () => gw.infoQuery({ sessionId: sid, resource: "" }));
    await assertTaxError("tax_resource_unsupported", () => gw.infoQuery({ sessionId: sid, resource: "declaration_status" }));
    assert.equal((await gw.infoQuery({ sessionId: sid, resource: "identity" })).data.item.subjectId, "operator-1");
  });

  await test("未实现 query 的适配器：不返回假数据，结构化 tax_query_unsupported", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({ query: null }));
    const sid = await authenticatedSession(gw);
    const e = await assertTaxError("tax_query_unsupported", () => gw.infoQuery({ sessionId: sid, resource: "identity" }));
    assert.equal(e.details.resource, "identity");
  });

  await test("会话过期：状态转 expired 且查询被拒绝", async () => {
    let clock = 1_700_000_000_000;
    const gw = makeGateway({ now: () => clock, defaultSessionTtlMs: 60_000 });
    gw.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "authenticated" }),
      getStatus: () => ({ status: "authenticated" }),
    }));
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });
    assert.equal((await gw.getStatus({ sessionId: s.sessionId })).status, "authenticated");
    clock += 60_001;
    assert.equal((await gw.getStatus({ sessionId: s.sessionId })).status, "expired");
    await assertTaxError("tax_session_expired", () => gw.infoQuery({ sessionId: s.sessionId, resource: "identity" }));
    await assertTaxError("tax_session_expired", () => gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: "123456" }));
  });

  await test("退出：logged_out 且后续查询/再次验证均被拒绝；重复退出幂等", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter());
    const sid = await authenticatedSession(gw);
    const out = await gw.logout({ sessionId: sid });
    assert.equal(out.status, "logged_out");
    assert.equal(out.loggedOut, true);
    assert.equal(out.authenticated, false);
    assert.equal(out.hasCredentialRef, false, "退出应清掉凭据引用");
    await assertTaxError("tax_session_logged_out", () => gw.infoQuery({ sessionId: sid, resource: "identity" }));
    await assertTaxError("tax_session_logged_out", () => gw.submitChallenge({ sessionId: sid, action: "sms_code", response: "123456" }));
    assert.equal((await gw.logout({ sessionId: sid })).idempotent, true);
  });

  await test("未知会话 ID 一律 tax_session_not_found；缺 sessionId 单独报错", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter());
    const bogus = { sessionId: "taxs_doesnotexist" };
    await assertTaxError("tax_session_not_found", () => gw.getStatus(bogus));
    await assertTaxError("tax_session_not_found", () => gw.logout(bogus));
    await assertTaxError("tax_session_not_found", () => gw.infoQuery({ ...bogus, resource: "identity" }));
    await assertTaxError("tax_session_not_found", () => gw.submitChallenge({ ...bogus, action: "sms_code", response: "1" }));
    await assertTaxError("tax_session_id_required", () => gw.getStatus({}));
    await assertTaxError("tax_session_id_required", () => gw.infoQuery({ resource: "identity" }));
  });

  await test("适配器失败不伪造成功：登录失败直接结构化报错", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({ startLogin: () => { throw new Error("上游不可用"); } }));
    await assertTaxError("tax_login_failed", () => gw.startLogin({ region: GD }));
    const gw2 = makeGateway();
    gw2.registerAdapter(fakeAdapter({ submitChallenge: () => { throw new Error("验证服务异常"); } }));
    const s = await gw2.startLogin({ region: GD });
    await assertTaxError("tax_challenge_failed", () => gw2.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: "123456" }));
  });

  await test("适配器返回非法/缺失状态一律记为 failed，不猜已认证", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({ startLogin: () => ({ status: "totally_authenticated" }) }));
    await assertTaxError("tax_adapter_protocol_error", () => gw.startLogin({ region: GD }));
    assert.equal([...gw.sessions.values()][0].status, "failed");

    const gw2 = makeGateway();
    gw2.registerAdapter(fakeAdapter({ startLogin: () => "ok" }));
    await assertTaxError("tax_adapter_protocol_error", () => gw2.startLogin({ region: GD }));
  });

  await test("恶意适配器：错误里的凭据不得泄漏到接口响应", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({
      startLogin: () => { throw new Error(`login failed cookie=${COOKIE_SECRET}; password=${PASSWORD_SECRET}; Bearer ${TOKEN_SECRET}`); },
    }));
    const e = await assertTaxError("tax_login_failed", () => gw.startLogin({ region: GD }));
    const text = `${e.message} ${json(e.details)}`;
    for (const secret of [COOKIE_SECRET, PASSWORD_SECRET, TOKEN_SECRET, "deadbeefcafe"]) {
      assert.equal(text.includes(secret), false, `错误信息泄漏了：${secret}`);
    }
    assert.ok(text.includes("***"), "凭据应被替换为掩码");

    // 适配器把人工验证响应塞进错误里，同样不得回显
    const gw2 = makeGateway();
    gw2.registerAdapter(fakeAdapter({
      submitChallenge: () => { throw new Error(`verify rejected for code=${CHALLENGE_SECRET}`); },
    }));
    const s = await gw2.startLogin({ region: GD });
    const e2 = await assertTaxError("tax_challenge_failed", () =>
      gw2.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: CHALLENGE_SECRET }));
    assert.equal(`${e2.message} ${json(e2.details)}`.includes(CHALLENGE_SECRET), false, "验证响应不得回显");
  });

  await test("恶意适配器：查询结果只输出 DTO 白名单字段，原始凭据/内部结构被丢弃", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({
      query: () => ({
        ...IDENTITY,
        cookies: COOKIE_SECRET,
        access_token: TOKEN_SECRET,
        password: PASSWORD_SECRET,
        internal: { deep: "nested" },
        idNumber: "110101199001011234",
      }),
    }));
    const sid = await authenticatedSession(gw);
    const r = await gw.infoQuery({ sessionId: sid, resource: "identity" });
    const text = json(r);
    for (const secret of [COOKIE_SECRET, TOKEN_SECRET, PASSWORD_SECRET, "nested", "110101199001011234"]) {
      assert.equal(text.includes(secret), false, `查询响应泄漏了：${secret}`);
    }
    assert.deepEqual(Object.keys(r.data.item).sort(),
      ["idNumber", "idType", "name", "phone", "region", "roles", "subjectId"]);
  });

  await test("适配器只拿到本会话绑定的账套/地区，不能读到别的上下文", async () => {
    const seen = [];
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({
      query: (ctx) => { seen.push(ctx); return IDENTITY; },
    }));
    const sid = await authenticatedSession(gw);
    await gw.infoQuery({ sessionId: sid, resource: "identity" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].accountSetId, 1);
    assert.equal(seen[0].region, GD);
    assert.equal("response" in seen[0], false, "上下文不得携带验证响应");
  });

  // ---------------------------------------------------------------- 4. 异步适配器
  await test("异步适配器：登录/状态/验证/查询/退出全程 await，结果不丢", async () => {
    const gw = makeGateway();
    gw.registerAdapter(asyncFakeAdapter());
    const s = await gw.startLogin({ region: GD, accountSetId: 1, loginMethod: "sms" });
    assert.equal(s.status, "requires_action", "async startLogin 不得退化成无 challenge 的 requires_action");
    assert.equal(s.requiresAction, true);
    assert.equal(s.authenticated, false);
    assert.ok(s.challenge, "async requires_action 必须带 challenge");
    assert.equal(s.challenge.action, "sms_code");

    const st = await gw.getStatus({ sessionId: s.sessionId });
    assert.equal(st.status, "requires_action");

    const bad = await gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: "000000" });
    assert.equal(bad.status, "requires_action");
    assert.equal(bad.challenge.action, "sms_code");

    const ok = await gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: "123456" });
    assert.equal(ok.status, "authenticated");
    assert.equal(ok.authenticated, true);

    const q = await gw.infoQuery({ sessionId: s.sessionId, resource: "identity", params: { period: "2026-09" } });
    assert.equal(q.data.item.subjectId, "operator-1", "async query 结果不得丢失");
    assert.equal(q.data.item.region, GD);

    const out = await gw.logout({ sessionId: s.sessionId });
    assert.equal(out.status, "logged_out");
    assert.equal(out.loggedOut, true);
  });

  await test("异步适配器：异步拒绝结构化，不产生 unhandled rejection", async () => {
    const gwLogin = makeGateway();
    gwLogin.registerAdapter(asyncFakeAdapter({ async startLogin() { throw new Error(`async login down cookie=${COOKIE_SECRET}`); } }));
    const e = await assertTaxError("tax_login_failed", () => gwLogin.startLogin({ region: GD }));
    assert.equal(`${e.message} ${json(e.details)}`.includes(COOKIE_SECRET), false, "异步错误同样要脱敏");
    assert.equal([...gwLogin.sessions.values()][0].status, "failed", "异步登录失败必须记为 failed");

    const gwQuery = makeGateway();
    gwQuery.registerAdapter(asyncFakeAdapter({ async query() { throw new Error("async query down"); } }));
    const sQuery = await gwQuery.startLogin({ region: GD, accountSetId: 1 });
    await gwQuery.submitChallenge({ sessionId: sQuery.sessionId, action: "sms_code", response: "123456" });
    await assertTaxError("tax_query_failed", () => gwQuery.infoQuery({ sessionId: sQuery.sessionId, resource: "identity" }));

    const gwChallenge = makeGateway();
    gwChallenge.registerAdapter(asyncFakeAdapter({ async submitChallenge() { throw new Error("async verify down"); } }));
    const sChallenge = await gwChallenge.startLogin({ region: GD, accountSetId: 1 });
    await assertTaxError("tax_challenge_failed", () =>
      gwChallenge.submitChallenge({ sessionId: sChallenge.sessionId, action: "sms_code", response: "123456" }));

    // 适配器 logout 异步失败：本地照样立即终结，只记 warning，不抛错
    const gwLogout = makeGateway();
    gwLogout.registerAdapter(asyncFakeAdapter({ async logout() { throw new Error("async logout down"); } }));
    const sid = await authenticatedSession(gwLogout);
    const out = await gwLogout.logout({ sessionId: sid });
    assert.equal(out.status, "logged_out");
    assert.equal(out.loggedOut, true);
    assert.ok(out.warning, "适配器退出失败应记为 warning");
    assert.equal(out.warning.message.includes("async logout down"), true);
  });

  // ---------------------------------------------------------------- 5. 并发下的终态保护
  await test("并发：logout 后迟到的 getStatus 不得把会话复活", async () => {
    const gate = deferred();
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({ getStatus: () => gate.promise }));
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });

    const pending = gw.getStatus({ sessionId: s.sessionId }); // 挂起中的状态查询
    pending.catch(() => {});                                   // 由本用例断言，不产生 unhandled rejection
    const out = await gw.logout({ sessionId: s.sessionId });   // 先退出
    assert.equal(out.status, "logged_out");
    assert.equal(gw.sessions.get(s.sessionId).status, "logged_out", "logout 必须立即使本地会话不可用");

    gate.resolve({ status: "authenticated" });                 // 迟到的「已认证」
    const late = await pending;
    assert.equal(late.status, "logged_out", "迟到结果不得复活已退出会话");
    assert.equal(late.authenticated, false);
    assert.equal(gw.sessions.get(s.sessionId).status, "logged_out");
  });

  await test("并发：logout 后迟到的 submitChallenge 不得复活会话", async () => {
    const gate = deferred();
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({ submitChallenge: () => gate.promise }));
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });

    const pending = gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: "123456" });
    pending.catch(() => {});
    await gw.logout({ sessionId: s.sessionId });
    assert.equal(gw.sessions.get(s.sessionId).status, "logged_out");

    gate.resolve({ status: "authenticated" });
    const e = await assertTaxError("tax_session_logged_out", () => pending);
    assert.equal(e.details.status, "logged_out");
    assert.equal(gw.sessions.get(s.sessionId).status, "logged_out", "终态不得被验证结果改写");
  });

  await test("并发：logout 后迟到的 query 不输出任何数据", async () => {
    const gate = deferred();
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({ query: () => gate.promise }));
    const sid = await authenticatedSession(gw);

    const pending = gw.infoQuery({ sessionId: sid, resource: "identity" });
    pending.catch(() => {});
    await gw.logout({ sessionId: sid });
    gate.resolve(IDENTITY); // 迟到的数据

    const e = await assertTaxError("tax_session_logged_out", () => pending);
    assert.equal(e.details.status, "logged_out");
    assert.equal(json(e.details).includes("operator-1"), false, "错误详情也不得带出迟到数据");
    assert.equal(gw.sessions.get(sid).status, "logged_out");
  });

  await test("并发：查询期间会话过期，迟到结果不得输出", async () => {
    const gate = deferred();
    let clock = 1_700_000_000_000;
    const gw = makeGateway({ now: () => clock, defaultSessionTtlMs: 60_000 });
    gw.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "authenticated" }),
      query: () => gate.promise,
    }));
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });

    const pending = gw.infoQuery({ sessionId: s.sessionId, resource: "identity" });
    pending.catch(() => {});
    clock += 60_001;            // 等待期间会话过期
    gate.resolve(IDENTITY);     // 迟到的数据

    const e = await assertTaxError("tax_session_expired", () => pending);
    assert.equal(e.details.status, "expired");
    assert.equal(gw.sessions.get(s.sessionId).status, "expired");
  });

  await test("并发：logout 期间适配器退出很慢/失败，本地会话仍然立即不可用", async () => {
    const gate = deferred();
    const gw = makeGateway();
    gw.registerAdapter(asyncFakeAdapter({ logout: () => gate.promise }));
    const sid = await authenticatedSession(gw);

    const pendingLogout = gw.logout({ sessionId: sid });
    // logout 还没返回，本地会话就必须已经不可用
    assert.equal(gw.sessions.get(sid).status, "logged_out");
    await assertTaxError("tax_session_logged_out", () => gw.infoQuery({ sessionId: sid, resource: "identity" }));
    const st = await gw.getStatus({ sessionId: sid });
    assert.equal(st.status, "logged_out", "迟到的状态查询只能看到 logged_out");

    gate.reject(new Error("远端退出超时"));
    const out = await pendingLogout;
    assert.equal(out.status, "logged_out");
    assert.ok(out.warning, "适配器退出失败应记为 warning 而非抛错");
  });

  // ---------------------------------------------------------------- 6. 计划单列市独立路由
  await test("深圳(440300) 与 广东(440000) 适配器独立路由，互不串区", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter()); // 广东
    gw.registerAdapter(fakeAdapter({
      adapterId: "demo-shenzhen",
      region: SZ,
      label: "深圳测试适配器",
      query: (ctx, { resource }) => (resource === "identity" ? { ...IDENTITY, subjectId: "operator-sz", region: SZ } : []),
    }));

    const regions = gw.listRegions();
    assert.deepEqual(regions.configuredRegions.sort(), [GD, SZ]);
    assert.equal(regions.summary.regionsConfigured, 2);
    assert.equal(regions.regions.find((r) => r.region === SZ).configured, true);
    assert.equal(regions.regions.find((r) => r.region === "110000").parentRegion, null, "省级地区没有 parentRegion");

    const gdSession = await authenticatedSession(gw, { region: GD, accountSetId: 1 });
    const szSession = await authenticatedSession(gw, { region: SZ, accountSetId: 1 });
    const gd = await gw.infoQuery({ sessionId: gdSession, resource: "identity" });
    const sz = await gw.infoQuery({ sessionId: szSession, resource: "identity" });
    assert.equal(gd.data.item.subjectId, "operator-1");
    assert.equal(gd.region, GD);
    assert.equal(sz.data.item.subjectId, "operator-sz", "深圳会话必须走深圳适配器");
    assert.equal(sz.region, SZ);

    // 跨区读取一律拒绝（深圳会话不能借广东适配器）
    await assertTaxError("tax_region_mismatch", () => gw.infoQuery({ sessionId: szSession, resource: "identity", region: GD }));
    await assertTaxError("tax_region_mismatch", () => gw.infoQuery({ sessionId: gdSession, resource: "identity", region: SZ }));
    // 计划单列市与所在省各有各的适配器，按会话 region 精确选择，不会误用省适配器
    assert.equal(gw.sessions.get(szSession).adapterId, "demo-shenzhen");
    assert.equal(gw.sessions.get(gdSession).adapterId, "demo-guangdong");
  });

  // ---------------------------------------------------------------- 7. params 平面白名单
  await test("infoQuery params 平面白名单：禁止覆盖账套/地区/企业，嵌套也无从绕过", async () => {
    let seen = null;
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({ query: (ctx, { params }) => { seen = { ctx, params }; return IDENTITY; } }));
    const sid = await authenticatedSession(gw);

    const rejected = [
      ["tax_query_param_reserved", { accountSetId: 2 }],
      ["tax_query_param_reserved", { account_set_id: 2 }],
      ["tax_query_param_reserved", { region: SH }],
      ["tax_query_param_reserved", { enterpriseId: "E9" }],
      ["tax_query_param_reserved", { enterprise_id: "E9" }],
      ["tax_query_param_reserved", { taxpayerId: "91440100MA5XXXXX1A" }],
      ["tax_query_param_reserved", { sessionId: "taxs_x" }],
      ["tax_query_param_reserved", { credentialRef: "vault://x" }],
      // 嵌套绕过：外层键不在白名单
      ["tax_query_param_unknown", { filter: { accountSetId: 2 } }],
      ["tax_query_param_unknown", { scope: { region: SH } }],
      // 其它未知键
      ["tax_query_param_unknown", { foo: "bar" }],
      // 值必须是标量
      ["tax_query_param_invalid", { period: { nested: "2026-01" } }],
      ["tax_query_param_invalid", { period: ["2026-01"] }],
    ];
    for (const [code, params] of rejected) {
      await assertTaxError(code, () => gw.infoQuery({ sessionId: sid, resource: "identity", params }));
    }
    await assertTaxError("tax_query_params_invalid", () => gw.infoQuery({ sessionId: sid, resource: "identity", params: "period=2026-01" }));
    assert.equal(seen, null, "被拒的 params 不得触达适配器");

    // 合法：只透传与资源本身有关的标量参数
    const ok = await gw.infoQuery({ sessionId: sid, resource: "identity", params: { period: "2026-01", taxType: "VAT", page: 1, pageSize: 20 } });
    assert.equal(ok.data.item.subjectId, "operator-1");
    assert.deepEqual(Object.keys(seen.params).sort(), ["page", "pageSize", "period", "taxType"]);
    // 上下文里的企业/账套只来自会话，不受 params 影响
    assert.equal(seen.ctx.accountSetId, 1);
    assert.equal(seen.ctx.region, GD);
  });

  await test("infoQuery params 不能携带企业标识：绑定企业只来自会话上下文", async () => {
    const seen = [];
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({ query: (ctx, { params }) => { seen.push({ ctx, params }); return IDENTITY; } }));
    const started = await gw.startLogin({ region: GD, accountSetId: 1, enterprise: { enterpriseId: "E-MINE" } });
    await gw.submitChallenge({ sessionId: started.sessionId, action: "sms_code", response: "123456" });

    await gw.infoQuery({ sessionId: started.sessionId, resource: "identity", params: { period: "2026-01" } });
    assert.deepEqual(seen.at(-1).ctx.enterprise, { enterpriseId: "E-MINE", name: null }, "企业标识来自会话");
    assert.equal("enterpriseId" in seen.at(-1).params, false, "params 里不得出现企业标识");
    // 想通过 params 换企业 -> 直接拒绝
    await assertTaxError("tax_query_param_reserved", () =>
      gw.infoQuery({ sessionId: started.sessionId, resource: "identity", params: { enterpriseId: "E-OTHER" } }));
    assert.equal(seen.length, 1, "越权 params 不得触达适配器");
  });

  // ---------------------------------------------------------------- 8. 协议错误
  await test("协议：startLogin/submitChallenge 缺 status 或空对象 -> tax_adapter_protocol_error", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({ startLogin: () => ({}) }));
    const e = await assertTaxError("tax_adapter_protocol_error", () => gw.startLogin({ region: GD }));
    assert.equal(e.details.status, "failed");
    assert.equal([...gw.sessions.values()][0].status, "failed", "协议错误必须记为 failed，而不是无限等待");

    const gw2 = makeGateway();
    gw2.registerAdapter(fakeAdapter({ startLogin: () => null }));
    await assertTaxError("tax_adapter_protocol_error", () => gw2.startLogin({ region: GD }));

    const gw3 = makeGateway();
    gw3.registerAdapter(fakeAdapter({ submitChallenge: () => ({}) }));
    const s = await gw3.startLogin({ region: GD });
    await assertTaxError("tax_adapter_protocol_error", () => gw3.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: "123456" }));
  });

  await test("协议：requires_action 必须带合法 challenge，否则协议错误", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({ startLogin: () => ({ status: "requires_action" }) }));
    const e = await assertTaxError("tax_adapter_protocol_error", () => gw.startLogin({ region: GD }));
    assert.ok(e.message.includes("challenge"), `错误信息应说明缺 challenge：${e.message}`);

    const gw2 = makeGateway();
    gw2.registerAdapter(fakeAdapter({ startLogin: () => ({ status: "requires_action", challenge: { prompt: "没有 action" } }) }));
    await assertTaxError("tax_adapter_protocol_error", () => gw2.startLogin({ region: GD }));

    // 已 authenticated 的会话，getStatus 却回 requires_action 且不给 challenge -> failed
    const gw3 = makeGateway();
    gw3.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "authenticated" }),
      getStatus: () => ({ status: "requires_action" }),
    }));
    const s = await gw3.startLogin({ region: GD, accountSetId: 1 });
    const st = await gw3.getStatus({ sessionId: s.sessionId });
    assert.equal(st.status, "failed", "无 challenge 的 requires_action 不得让调用方无限等待");
    assert.equal(st.failure.code, "tax_adapter_protocol_error");
  });

  await test("协议：getStatus 允许明确的「无变更」约定（null/undefined/{}/仅局部字段）", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({ getStatus: () => undefined }));
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });
    const st = await gw.getStatus({ sessionId: s.sessionId });
    assert.equal(st.status, "requires_action", "无变更：状态保持");
    assert.equal(st.challenge.action, "sms_code", "无变更：challenge 保持");

    const gw2 = makeGateway();
    gw2.registerAdapter(fakeAdapter({ getStatus: () => ({}) }));
    const s2 = await gw2.startLogin({ region: GD, accountSetId: 1 });
    assert.equal((await gw2.getStatus({ sessionId: s2.sessionId })).status, "requires_action");

    let clock = 1_700_000_000_000;
    const gw3 = makeGateway({ now: () => clock, defaultSessionTtlMs: 60_000 });
    gw3.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "requires_action", challenge: { action: "sms_code" } }),
      getStatus: () => ({ expiresAt: clock + 120_000 }),
    }));
    const s3 = await gw3.startLogin({ region: GD, accountSetId: 1 });
    assert.equal((await gw3.getStatus({ sessionId: s3.sessionId })).status, "requires_action", "仅刷新 expiresAt 也视为无状态变更");
    clock += 90_000; // 超过默认 TTL，但适配器延长过有效期
    assert.equal((await gw3.getStatus({ sessionId: s3.sessionId })).status, "requires_action");
  });

  // ---------------------------------------------------------------- 9. 迟到登录 / 脱敏边界 / 明文暂存
  await test("迟到登录：async startLogin 超过会话 TTL，结果不采纳且不得冒充已认证", async () => {
    let clock = 1000;
    const gw = makeGateway({ now: () => clock, defaultSessionTtlMs: 50 });
    const gate = deferred();
    gw.registerAdapter(fakeAdapter({ startLogin: () => gate.promise }));

    const pending = gw.startLogin({ region: GD, accountSetId: 1 });
    pending.catch(() => {});
    clock = 2000; // 适配器比会话 TTL 还慢：等待期间会话已经过期
    gate.resolve({ status: "authenticated", expiresAt: 1050 });

    const e = await assertTaxError("tax_session_expired", () => pending);
    assert.equal(e.details.status, "expired");
    const stored = [...gw.sessions.values()][0];
    assert.equal(stored.status, "expired", "迟到的 authenticated 不得写回会话");
    assert.equal(stored.expiresAt, 1050, "迟到的 expiresAt 不得改写会话");
    assert.equal(stored.challenge, null);
    await assertTaxError("tax_session_expired", () => gw.infoQuery({ sessionId: stored.sessionId, resource: "identity" }));
  });

  await test("过期即终态：适配器给出的 expiresAt 已经过期时不得 authenticated", async () => {
    const base = 1_700_000_000_000;
    let clock = base;

    // (a) startLogin 直接返回已过期的 expiresAt
    const gw = makeGateway({ now: () => clock, defaultSessionTtlMs: 60_000 });
    gw.registerAdapter(fakeAdapter({ startLogin: () => ({ status: "authenticated", expiresAt: base - 1 }) }));
    const e = await assertTaxError("tax_session_expired", () => gw.startLogin({ region: GD, accountSetId: 1 }));
    assert.equal(e.details.status, "expired");
    assert.equal([...gw.sessions.values()][0].status, "expired");

    // (b) submitChallenge 的成功响应带已过期的 expiresAt：即时过期
    const gw2 = makeGateway({ now: () => clock, defaultSessionTtlMs: 60_000 });
    gw2.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "requires_action", challenge: { action: "sms_code" } }),
      submitChallenge: () => ({ status: "authenticated", expiresAt: base - 1 }),
    }));
    const s2 = await gw2.startLogin({ region: GD, accountSetId: 1 });
    assert.equal(s2.status, "requires_action");
    const e2 = await assertTaxError("tax_session_expired", () =>
      gw2.submitChallenge({ sessionId: s2.sessionId, action: "sms_code", response: "123456" }));
    assert.equal(e2.details.status, "expired");
    assert.equal(gw2.sessions.get(s2.sessionId).status, "expired", "成功响应带来的过期时间必须即时生效");

    // (c) 已过期的会话不能被适配器「延长 expiresAt」复活
    const gw3 = makeGateway({ now: () => clock, defaultSessionTtlMs: 60_000 });
    gw3.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "authenticated" }),
      getStatus: () => ({ status: "authenticated", expiresAt: clock + 600_000 }),
    }));
    const s3 = await gw3.startLogin({ region: GD, accountSetId: 1 });
    const originalExpiry = s3.expiresAt;
    clock += 60_001; // 会话过期
    const st = await gw3.getStatus({ sessionId: s3.sessionId });
    assert.equal(st.status, "expired");
    assert.equal(st.authenticated, false);
    assert.equal(st.expiresAt, originalExpiry, "已过期会话的 expiresAt 不得被适配器延长");
    assert.equal(gw3.sessions.get(s3.sessionId).expiresAt, base + 60_000);

    // (d) getStatus 返回 authenticated + 已过期的 expiresAt：也不能停留在已认证
    const gw4 = makeGateway({ now: () => clock, defaultSessionTtlMs: 600_000 });
    gw4.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "requires_action", challenge: { action: "sms_code" } }),
      getStatus: () => ({ status: "authenticated", expiresAt: clock - 1 }),
    }));
    const s4 = await gw4.startLogin({ region: GD, accountSetId: 1 });
    const st4 = await gw4.getStatus({ sessionId: s4.sessionId });
    assert.equal(st4.status, "expired", "适配器给出的过期时间要即时生效，不能留在 authenticated");
    assert.equal(st4.authenticated, false);
  });

  await test("challenge 不是秘密容器：prompt/hint/action 与 credentialRef 一律脱敏", async () => {
    const R = "FAKE_TEST_123456";
    const REF = "vault://tax/demo-operator";
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({
      // 发起登录时验证响应还没提交，只有 credentialRef 是已知明文：
      // 它同样不能借 challenge.prompt / hint 这样的「安全键名」回显。
      startLogin: (ctx) => ({
        status: "requires_action",
        challenge: { action: "sms_code", prompt: `请验证 ${ctx.credentialRef}`, hint: ctx.credentialRef },
      }),
      submitChallenge: (ctx, { response }) => ({
        status: "requires_action",
        challenge: { action: `code_${response}`, prompt: `上次输入 ${response}，请重试`, hint: response },
      }),
    }));

    const s = await gw.startLogin({ region: GD, accountSetId: 1, credentialRef: REF });
    assert.equal(s.hasCredentialRef, true);
    assert.equal(json(s).includes(REF), false, "credentialRef 不得出现在 challenge 提示里");
    assert.equal(s.challenge.hint, "***", "凭据引用不能借 challenge.hint 回显");
    assert.equal(s.challenge.prompt, "请验证 ***", "凭据引用不能借 challenge.prompt 回显");

    const r = await gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: R });
    assert.equal(json(r).includes(R), false, "challenge 任何字段都不得回显验证响应");
    assert.equal(r.challenge.hint, "***");
    assert.equal(r.challenge.action, "code_***", "action 也不能用来包装秘密");
    assert.equal(r.challenge.prompt.includes("***"), true, "prompt 不得原文回显");
    assert.equal(json(gw.sessions.get(s.sessionId)).includes(R), false);
  });

  await test("适配器错误码不得回显验证响应", async () => {
    const R = "FAKE_TEST_123456";
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "requires_action", challenge: { action: "sms_code" } }),
      submitChallenge: () => {
        const err = new Error(`verify rejected for ${R}`);
        err.code = `err_${R}`; // 形态合法但内容是秘密：不能当错误码带出去
        throw err;
      },
    }));
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });
    const e = await assertTaxError("tax_challenge_failed", () =>
      gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: R }));
    const failure = gw.sessions.get(s.sessionId).failure;
    assert.equal(failure.code, "tax_adapter_error", "命中已知明文的错误码必须换成通用码");
    assert.equal(json({ e, failure }).includes(R), false, "错误码与错误信息都不得回显验证响应");
  });

  await test("协议错误信息同样先脱敏再截断（非法 status 回带验证响应）", async () => {
    const R = "FAKE_TEST_123456";
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "requires_action", challenge: { action: "sms_code" } }),
      // 非法状态里带上响应，且前缀长到能被 40 字符截断切进秘密中间。
      submitChallenge: (_ctx, { response }) => ({ status: `${"p".repeat(35)}${response}` }),
    }));
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });
    const e = await assertTaxError("tax_adapter_protocol_error", () =>
      gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: R }));
    const failure = gw.sessions.get(s.sessionId).failure;
    assert.equal(`${e.message} ${json(failure)}`.includes(R), false, "协议错误信息不得回显验证响应");
    assert.equal(failure.message.includes("FAKE_TEST"), false, "截断前的脱敏不能把秘密片段漏出来");
    assert.ok(failure.message.includes("***"), "应替换为掩码");
  });

  await test("DTO 白名单字段不得回显验证响应与凭据引用（字符串 / 数组）", async () => {
    const R = "FAKE_TEST_123456";
    const REF = `vault://tax/${R}`;
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "requires_action", challenge: { action: "sms_code" } }),
      submitChallenge: () => ({ status: "authenticated" }),
      query: (ctx, { resource }) => (resource === "identity"
        ? { ...IDENTITY, subjectId: `op-${R}`, roles: [`role-${R}`, REF] }
        : { enterpriseId: "E1", name: "示例公司", industry: ctx.credentialRef, registeredAddress: R }),
    }));
    const s = await gw.startLogin({ region: GD, accountSetId: 1, credentialRef: REF });
    await gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: R });

    const q1 = await gw.infoQuery({ sessionId: s.sessionId, resource: "identity" });
    assert.equal(json(q1).includes(R), false, "白名单字符串/数组不得回显验证响应");
    assert.equal(q1.data.item.subjectId, "op-***");
    // 凭据引用是整体登记的已知明文，出现即整体替换。
    assert.deepEqual(q1.data.item.roles, ["role-***", "***"]);

    const q2 = await gw.infoQuery({ sessionId: s.sessionId, resource: "enterprise_profile" });
    const t2 = json(q2);
    assert.equal(t2.includes(R), false, "企业资料字段不得回显验证响应");
    assert.equal(t2.includes("vault://tax/"), false, "凭据引用不得出现在白名单输出里");
    assert.equal(q2.data.item.registeredAddress, "***");
    assert.equal(q2.data.item.industry, "***");
  });

  await test("数字型验证响应同样登记并脱敏（不再只认字符串）", async () => {
    const NUM = 246813;
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "requires_action", challenge: { action: "sms_code" } }),
      submitChallenge: () => ({ status: "authenticated" }),
      query: (ctx, { resource }) => (resource === "identity"
        ? { ...IDENTITY, subjectId: NUM, roles: [NUM] }
        : { enterpriseId: "E1", industry: `ref-${NUM}-end` }),
    }));
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });
    await gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: NUM });
    assert.equal(gw.secrets.has(String(NUM)), true, "数字响应应登记为已知明文");

    const q1 = await gw.infoQuery({ sessionId: s.sessionId, resource: "identity" });
    const t1 = json(q1);
    assert.equal(t1.includes(String(NUM)), false, "数字响应不得借数字字段/数组回显");
    assert.equal(q1.data.item.subjectId, "***", "数字字段命中已知明文时整体抹掉");
    assert.deepEqual(q1.data.item.roles, ["***"]);

    const q2 = await gw.infoQuery({ sessionId: s.sessionId, resource: "enterprise_profile" });
    assert.equal(json(q2).includes(String(NUM)), false, "字符串里嵌的数字响应同样要抹掉");
    assert.equal(q2.data.item.industry, "ref-***-end");
  });

  await test("时间戳字段也不能包装秘密：命中已知明文的 expiresAt 视为无效", async () => {
    const NUM = 1755000000000; // 13 位毫秒时间戳，恰好就是本次提交的验证响应
    const base = 1_700_000_000_000;
    const gw = makeGateway({ now: () => base, defaultSessionTtlMs: 60_000 });
    gw.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "requires_action", challenge: { action: "sms_code" }, expiresAt: base + 1_800_000 }),
      submitChallenge: () => ({
        status: "requires_action",
        challenge: { action: "sms_code", expiresAt: NUM },
        expiresAt: NUM,
      }),
    }));
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });
    const before = s.expiresAt;
    const r = await gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: NUM });
    assert.equal(r.expiresAt, before, "命中已知明文的 expiresAt 不得被采纳");
    assert.equal(json(r).includes(String(NUM)), false, "时间戳字段不得回显验证响应");
    assert.equal(r.challenge.expiresAt, null, "challenge.expiresAt 命中已知明文时应为 null");
  });

  await test("短验证码同样覆盖（阈值不再是 4）", async () => {
    const R = "972";
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "requires_action", challenge: { action: "sms_code" } }),
      submitChallenge: (_ctx, { action, response }) => ({
        status: "requires_action",
        challenge: { action, prompt: "验证码不正确，请重试", hint: `上次 ${response}` },
      }),
    }));
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });
    const r = await gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: R });
    assert.equal(r.challenge.hint, "上次 ***");
    assert.equal(json(r).includes(R), false, "3 位验证码也必须被抹掉");
  });

  await test("脱敏先于截断：跨过截断边界的秘密片段也不泄漏", async () => {
    const R = "FAKE_TEST_123456";
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "requires_action", challenge: { action: "sms_code" } }),
      submitChallenge: () => ({ status: "authenticated" }),
      // 秘密从第 291 / 51 / 191 个字符处开始：截断在前就会只漏出前几个字符。
      query: (ctx, { resource }) => (resource === "identity"
        ? { ...IDENTITY, subjectId: `${"x".repeat(290)}${R}`, roles: [`${"y".repeat(50)}${R}`] }
        : { enterpriseId: "E1", registeredAddress: `${"z".repeat(190)}${R}` }),
    }));
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });
    await gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: R });

    const q1 = await gw.infoQuery({ sessionId: s.sessionId, resource: "identity" });
    assert.equal(json(q1).includes("FAKE_TEST"), false, "标量 200 字符 / 数组 60 字符截断必须先脱敏");
    assert.equal(q1.data.item.roles[0].endsWith("***"), true);
    const q2 = await gw.infoQuery({ sessionId: s.sessionId, resource: "enterprise_profile" });
    assert.equal(json(q2).includes("FAKE_TEST"), false, "截断边界外的那一段秘密不得漏出");
  });

  await test("明文暂存生命周期：logout / 过期即清理，且总量有上限", async () => {
    // (a) logout 后清理该会话登记的明文
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter({ submitChallenge: () => ({ status: "authenticated" }) }));
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });
    await gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: "778899" });
    assert.equal(gw.secrets.has("778899"), true);
    await gw.logout({ sessionId: s.sessionId });
    assert.equal(gw.secrets.has("778899"), false, "logout 后应清理该会话登记的明文");
    assert.equal(gw.sessions.get(s.sessionId).secretKeys.size, 0);

    // (b) 会话过期即清理
    let clock = 1_700_000_000_000;
    const gw2 = makeGateway({ now: () => clock, defaultSessionTtlMs: 60_000 });
    gw2.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "requires_action", challenge: { action: "sms_code" } }),
      submitChallenge: () => ({ status: "authenticated" }),
    }));
    const s2 = await gw2.startLogin({ region: GD, accountSetId: 1 });
    await gw2.submitChallenge({ sessionId: s2.sessionId, action: "sms_code", response: "445566" });
    assert.equal(gw2.secrets.has("445566"), true);
    clock += 60_001;
    await assertTaxError("tax_session_expired", () => gw2.infoQuery({ sessionId: s2.sessionId, resource: "identity" }));
    assert.equal(gw2.secrets.has("445566"), false, "过期后应清理该会话登记的明文");

    // (c) 上限兜底：反复提交也不会无界累积
    const gw3 = makeGateway();
    gw3.registerAdapter(fakeAdapter({
      startLogin: () => ({ status: "requires_action", challenge: { action: "sms_code" } }),
      submitChallenge: () => ({ status: "requires_action", challenge: { action: "sms_code", hint: "重试" } }),
    }));
    const s3 = await gw3.startLogin({ region: GD, accountSetId: 1 });
    for (let i = 0; i < 700; i += 1) {
      await gw3.submitChallenge({ sessionId: s3.sessionId, action: "sms_code", response: `code-${i}-0000` });
    }
    assert.ok(gw3.secrets.size <= MAX_SECRETS, `全网关明文暂存应有上限，实际 ${gw3.secrets.size}`);
    assert.ok(gw3.sessions.get(s3.sessionId).secretKeys.size <= MAX_SESSION_SECRETS, "每会话明文暂存也应有上限");

    // (d) 清理不会造成泄漏：清理之后的迟到输出仍被终态保护拦下
    const gate = deferred();
    const gw4 = makeGateway();
    gw4.registerAdapter(fakeAdapter({ query: () => gate.promise }));
    const sid4 = await authenticatedSession(gw4);
    const pending = gw4.infoQuery({ sessionId: sid4, resource: "identity" });
    pending.catch(() => {});
    await gw4.logout({ sessionId: sid4 });
    assert.equal(gw4.secrets.size, 0, "该会话的明文已清理");
    gate.resolve(IDENTITY);
    await assertTaxError("tax_session_logged_out", () => pending);
  });

  await test("同步适配器保持可 await 兼容（回归）", async () => {
    const gw = makeGateway();
    gw.registerAdapter(fakeAdapter()); // 全部同步方法
    const s = await gw.startLogin({ region: GD, accountSetId: 1 });
    assert.equal(s.status, "requires_action");
    assert.equal((await gw.getStatus({ sessionId: s.sessionId })).status, "requires_action");
    const ok = await gw.submitChallenge({ sessionId: s.sessionId, action: "sms_code", response: "123456" });
    assert.equal(ok.status, "authenticated");
    assert.equal((await gw.infoQuery({ sessionId: s.sessionId, resource: "identity" })).data.item.subjectId, "operator-1");
    assert.equal((await gw.logout({ sessionId: s.sessionId })).status, "logged_out");
  });
}

// ================================================================== PART B
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitReady(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/meta`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error("backend_not_ready");
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function partB() {
  const dataDir = mkdtempSync(join(tmpdir(), "tax-contract-"));
  let backend = null;
  let client = null;
  try {
    const PORT = await freePort();
    const BASE = `http://127.0.0.1:${PORT}`;
    backend = spawn(process.execPath, [WORKBENCH], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(PORT), WORKBENCH_DATA_DIR: dataDir },
    });
    let backendErr = "";
    backend.stderr.on("data", (d) => { backendErr += d; });
    backend.on("exit", (code) => { if (code) backendErr += `\nbackend exited code=${code}`; });
    await waitReady(BASE);

    client = new McpStdioClient(join(here, "server.mjs"), {
      env: { FINANCE_API_BASE: BASE, FINANCE_API_TIMEOUT_MS: "10000" },
      timeoutMs: 20000,
    }).start();
    console.log(`\nB. 接线往返 @ ${BASE}（默认未配置真实后端）\n`);
    await client.initialize("tax-contract");

    await test("tools/list 公布 7 个税务工具，schema 为 object 且有描述", async () => {
      const list = await client.rpc("tools/list");
      const names = list.result.tools.map((t) => t.name);
      for (const n of TAX_TOOL_NAMES) assert.ok(names.includes(n), `缺少工具 ${n}`);
      assert.equal(new Set(names).size, names.length, "工具名不应重复");
      for (const t of list.result.tools.filter((t) => TAX_TOOL_NAMES.includes(t.name))) {
        assert.equal(t.inputSchema?.type, "object", `${t.name} 应有 object schema`);
        assert.ok(t.description.length > 10, `${t.name} 应有描述`);
      }
    });

    await test("税务工具标 origin=local（本地扩展，不冒充原站契约）", () => {
      const byName = new Map(TOOLS.map((t) => [t.name, t]));
      for (const n of TAX_TOOL_NAMES) assert.equal(byName.get(n)?.origin, "local", `${n} 应 origin=local`);
      assert.equal(byName.get("tax_login_start").description.includes("未接入"), true, "描述应说明默认未接入");
    });

    await test("tax_regions：全国为产品入口，大陆目录 31+5，港澳台单列 out_of_scope", async () => {
      const r = await client.call("tax_regions");
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.nationwide.productTarget, true);
      assert.equal(r.data.nationwide.taxTarget, false);
      assert.equal(r.data.nationwide.configured, false);
      assert.equal(r.data.summary.regionsConfigured, 0);
      assert.equal(r.data.summary.adaptersTotal, 0);
      assert.deepEqual(r.data.configuredRegions, []);
      assert.equal(r.data.regions.length, 36, "31 省级行政区 + 5 计划单列市");
      assert.equal(r.data.regions.filter((x) => x.kind === "separately_planned_city").length, 5);
      assert.equal(r.data.outOfScope.length, 3);
      assert.equal(r.data.outOfScope.every((x) => x.taxTarget === false), true);
      assert.equal(r.text.includes("已接入真实电子税务局"), false, "不得宣称已接入");
    });

    await test("tax_regions 记录官方 12366 来源链接", async () => {
      const r = await client.call("tax_regions");
      const urls = r.data.sources.map((s) => s.url);
      assert.ok(urls.includes(OFFICIAL_REGION_SOURCE), "应包含官方地区目录链接");
      assert.ok(urls.includes(OFFICIAL_CITY_SOURCE), "应包含计划单列市选市税务局说明链接");
    });

    await test("tax_capabilities：未接入地区 configured=false 且 adapters 为空", async () => {
      const r = await client.call("tax_capabilities", { region: GD });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.configured, false);
      assert.deepEqual(r.data.adapters, []);
      assert.equal(r.data.contract.resources.length, 5);
      const city = await client.call("tax_capabilities", { region: SZ });
      assert.equal(city.isError, false, city.text);
      assert.equal(city.data.kind, "separately_planned_city");
      assert.equal(city.data.parentRegion, GD);
      const bad = await client.call("tax_capabilities", { region: "999999" });
      assert.equal(bad.isError, true);
      assert.equal(bad.data.error, "tax_region_unknown");
      const missing = await client.call("tax_capabilities", {});
      assert.equal(missing.isError, true);
      assert.equal(missing.data.error, "invalid_arguments");
    });

    await test("tax_login_start：默认未接入直接结构化报错，不创建会话", async () => {
      const r = await client.call("tax_login_start", { region: GD, accountSetId: 1 });
      assert.equal(r.isError, true);
      assert.equal(r.data.error, "tax_region_not_configured");
      assert.ok(r.structured?.error === "tax_region_not_configured", "应有 structuredContent");
      const plain = await client.call("tax_login_start", { region: GD, password: "p@ss" });
      assert.equal(plain.isError, true);
      assert.equal(plain.data.error, "tax_plaintext_credential_rejected");
      // CN 与港澳台都不是税务目标
      const cn = await client.call("tax_login_start", { region: "CN" });
      assert.equal(cn.isError, true);
      assert.equal(cn.data.error, "tax_region_not_a_tax_target");
      const hk = await client.call("tax_login_start", { region: "810000" });
      assert.equal(hk.isError, true);
      assert.equal(hk.data.error, "tax_region_out_of_scope");
    });

    await test("会话类工具对未知会话返回结构化 tax_session_not_found", async () => {
      const bogus = "taxs_00000000000000000000000000000000";
      const cases = [
        ["tax_login_status", { sessionId: bogus }],
        ["tax_logout", { sessionId: bogus }],
        ["tax_info_query", { sessionId: bogus, resource: "identity" }],
        ["tax_login_challenge", { sessionId: bogus, action: "sms_code", response: "123456" }],
      ];
      for (const [name, args] of cases) {
        const r = await client.call(name, args);
        assert.equal(r.isError, true, `${name} 应 isError`);
        assert.equal(r.data.error, "tax_session_not_found", `${name} 错误码`);
      }
    });

    await test("参数运行时校验：缺 sessionId / 空 region 被拒绝", async () => {
      const a = await client.call("tax_login_status", {});
      assert.equal(a.isError, true);
      assert.equal(a.data.error, "invalid_arguments");
      const b = await client.call("tax_login_start", {});
      assert.equal(b.isError, true);
      assert.equal(b.data.error, "invalid_arguments");
    });

    await test("既有工具未受影响：account_context 模型信封携带真实账套事实，原站未实现声明仍报 not_implemented", async () => {
      // 普通工具现走固定模型通道：先在临时库建 1 个合成账套，再核对 account_context 的 projection
      // 是否如实反映该账套的业务事实（ID / 起始期间 / 纳税人类型 / 会计准则 / 名称存在标记），
      // 而不是旧的 raw account_sets 原文数组。
      const created = await client.call("account_set_create", {
        name: "合成税务契约账套名称", taxpayer_type: "小规模纳税人",
        accounting_standard: "小企业会计准则", start_period: "2026-01",
        enterprise: { enterpriseKey: "SYNTHETIC-TAX-CONTRACT-BOOK-001" },
      });
      assert.equal(created.isError, false, created.text);
      assert.equal(created.data.applied, true, "建账应真实落库");
      const setId = created.data.accountSetId;
      assert.ok(Number.isSafeInteger(setId) && setId > 0, "建账应返回真实账套 ID");

      const ctx = await client.call("account_context", {});
      assert.equal(ctx.isError, false, ctx.text);
      // 信封固定字段：模型通道 + 明确 global scope + 无原文 + 上下文不绑定单账套引用。
      assert.equal(ctx.data.ok, true);
      assert.equal(ctx.data.channel, "model");
      assert.equal(ctx.data.tool, "account_context");
      assert.equal(ctx.data.operation, "account_context");
      assert.equal(ctx.data.operationCategory, "context");
      assert.equal(ctx.data.scope, "global");
      assert.equal(ctx.data.accountSetId, null);
      assert.equal(ctx.data.rawValuesIncluded, false);
      assert.equal(ctx.data.localRef, null);
      assert.equal(ctx.data.refPersistence, "none");
      assert.equal(ctx.data.refUnavailable, "global_scope");
      assert.deepEqual(ctx.structured, ctx.data, "structuredContent 必须与 text 信封一致");
      // 真实账套业务事实：刚建的账套出现在可选列表，且只给受控枚举 / 期间 / 名称存在标记。
      const p = ctx.data.projection;
      assert.equal(p.scope, "global");
      assert.equal(p.accountSetCount, 1, "临时库只有刚建的 1 个账套");
      assert.equal(p.returnedCount, 1);
      assert.deepEqual(p.accountSetIds, [setId], "账套 ID 必须是真实结果里的那一个");
      assert.deepEqual(p.startPeriods, ["2026-01"]);
      assert.deepEqual(p.taxpayerTypes, ["small_scale"]);
      assert.deepEqual(p.accountingStandards, ["small_business"]);
      assert.deepEqual(p.displayNameFlags, [true]);
      assert.equal(p.pageOffset, 0);
      assert.equal(p.pageLimit, 10);
      assert.equal(p.truncated, false);
      assert.equal(p.hasNextPage, false);
      assert.equal(p.selectionRequirement, "explicit_account_set_id");
      assert.equal(p.persisted, false);
      assert.equal(ctx.data.projectionDropped, 0);
      // 旧 raw 形状必须消失：不再回 account_sets 原文数组 / 企业名 / 自由文本 note。
      assert.equal(Object.prototype.hasOwnProperty.call(ctx.data, "account_sets"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(ctx.data, "note"), false);
      assert.equal(ctx.text.includes("合成税务契约账套名称"), false, "模型通道不得回企业名原文");
      const decl = await client.call("declaration_query", {});
      assert.equal(decl.isError, true);
      assert.equal(decl.data.error, "not_implemented");
    });

    if (backendErr) console.log(`    （后端 stderr 摘要：${backendErr.slice(0, 200)}）`);
  } finally {
    if (client) await client.close();
    if (backend && !backend.killed) {
      const done = new Promise((r) => backend.once("exit", r));
      backend.kill();
      await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
      if (backend.exitCode === null && backend.signalCode === null) { try { backend.kill("SIGKILL"); } catch { /* ignore */ } }
    }
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
  }
}

try {
  await partA();
  await partB();
} catch (e) {
  results.push([false, "测试初始化"]);
  console.error("契约测试初始化失败：", e?.stack || e?.message);
}

// 异步拒绝不允许逃逸：给微任务队列一个清空的机会后断言为空。
await new Promise((r) => setTimeout(r, 20));
await test("全程无 unhandled rejection（异步适配器拒绝均被结构化捕获）", () => {
  assert.deepEqual(unhandled.map((r) => String(r?.message || r)), [], "不允许出现 unhandled rejection");
});

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过\n`);
process.exitCode = failed ? 1 : 0;
