#!/usr/bin/env node
// Real local HTTP -> Agent tool integration for the tax API catalog.
// Only a temporary database and an ephemeral loopback port are used.
// No tax endpoint, browser, credential or account data is touched.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "wb-tax-api-catalog-"));
process.env.WORKBENCH_DATA_DIR = directory;
const { db } = await import("../server/db.mjs");
const A = await import("../server/accounting.mjs");
const set = A.createAccountSet({ name: "合成目录测试账套", start_period: "2026-01" });

let child, exited, base;

before(async () => {
  child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "../server/server.mjs")], {
    env: { ...process.env, PORT: "0", WORKBENCH_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"],
  });
  exited = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const port = await new Promise((resolve, reject) => {
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
  base = `http://127.0.0.1:${port}`;
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

const PRIVATE = "PRIVATE_HTTP_TRIPWIRE_VALUE";
async function tool(name, args = {}) {
  const response = await fetch(`${base}/agent/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json();
  return { status: response.status, body };
}
async function ok(name, args) {
  const result = await tool(name, args);
  assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300));
  return result.body;
}

test("modules tool returns grouped coverage counts and never claims live verification", async () => {
  const data = await ok("tax_api_catalog_modules", {});
  assert.ok(Array.isArray(data.modules) && data.modules.length > 10);
  assert.equal(data.modules.reduce((n, m) => n + m.entryCount, 0), data.stats.entryCount);
  assert.equal(data.stats.autoExecutableCount, 0);
  assert.equal(data.stats.liveCallVerifiedCount, 0);
  assert.equal(data.stats.reportListedEntries, data.stats.entryCount);
  assert.equal(data.stats.reportListedModules, data.stats.moduleCount);
  assert.equal(data.stats.byCompleteness.full_contract, 0);
  assert.equal(data.stats.entriesWithUnknownResponse + data.stats.entriesWithDocumentedResponse,
    data.stats.entryCount);
  assert.equal(data.stats.entriesWithUnknownPermissionRequirement, data.stats.entryCount);
  assert.equal(data.stats.reportClaimIsNotCoverage, true);
  assert.match(data.stats.timeoutNote, /不是税局 SLA/);
  assert.equal(data.catalogManaged, true);
  assert.equal(data.liveCallVerified, false);
  assert.match(data.source.reportSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_HTTP|https?:\/\//i);

  const single = await ok("tax_api_catalog_modules", { moduleId: data.modules[0].id });
  assert.equal(single.module.id, data.modules[0].id);
  assert.equal(single.entries.length, data.modules[0].entryCount);
});

test("search paginates over real HTTP and marks every row as catalog-only", async () => {
  const first = await ok("tax_api_catalog_search", { pageSize: 5, page: 1 });
  const second = await ok("tax_api_catalog_search", { pageSize: 5, page: 2 });
  assert.equal(first.items.length, 5);
  assert.equal(first.hasMore, true);
  assert.notDeepEqual(first.items.map((i) => i.id), second.items.map((i) => i.id));
  for (const row of [...first.items, ...second.items]) {
    assert.equal(row.catalogManaged, true);
    assert.equal(row.liveCallVerified, false);
    assert.ok(row.reportLines.length > 0);
  }
  const auth = await ok("tax_api_catalog_search", { risk: "authentication", pageSize: 50 });
  assert.ok(auth.total > 0 && auth.items.every((i) => i.risk === "authentication"));
});

test("search rejects arbitrary URLs, unknown ids and bad paging without echoing input", async () => {
  for (const [args, code] of [
    [{ text: "https://example.invalid/api" }, "catalog_arbitrary_input_rejected"],
    [{ url: "https://example.invalid/api" }, "catalog_filter_invalid"],
    [{ pageSize: 999 }, "catalog_filter_invalid"],
    [{ page: 0 }, "catalog_filter_invalid"],
    [{ method: "PUT" }, "catalog_filter_invalid"],
    [{ id: "portal.mhzx.home.index" }, "catalog_filter_invalid"],
    // 对象/数组真值不得被当成合法过滤条件，也不得回显
    [{ module: { password: PRIVATE } }, "catalog_module_unknown"],
    [{ service: { password: PRIVATE } }, "catalog_filter_invalid"],
    [{ completeness: { password: PRIVATE } }, "catalog_filter_invalid"],
  ]) {
    const result = await tool("tax_api_catalog_search", args);
    assert.equal(result.status, 400, JSON.stringify(args));
    assert.equal(result.body.error, code);
    assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_HTTP|password/);
  }
  const unknown = await tool("tax_api_catalog_entry", { id: "https://example.invalid/api" });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, "catalog_id_unknown");
  const missing = await tool("tax_api_catalog_entry", {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "catalog_id_required");
  // 合法请求只回显规范化 filters
  const ordered = await ok("tax_api_catalog_search", { module: "identity.white", page: 1, pageSize: 2 });
  assert.deepEqual(ordered.filters, { textProvided: false, textLength: 0, textApplied: false, module: "identity.white", page: 1, pageSize: 2 });
});

test("entry detail exposes contract fields, unknown gaps and report line numbers", async () => {
  const detail = await ok("tax_api_catalog_entry", { id: "identity.white.send_sm4" });
  assert.equal(detail.method, "POST");
  assert.equal(detail.risk, "authentication");
  assert.equal(detail.evidence, "observed");
  assert.equal(detail.autoExecutable, false);
  assert.ok(detail.params.some((p) => p.name === "uuid"));
  assert.ok(detail.params.every((p) => p.source === "report_observed"));
  assert.ok(detail.reportLines.includes(98));
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_HTTP/);

  const unknown = await ok("tax_api_catalog_entry", { id: "identity.password.single_account_login" });
  assert.equal(unknown.method, "unknown");
  assert.deepEqual(unknown.params, []);
  assert.ok(unknown.paramGaps.length > 0);
  assert.match(unknown.paramGaps.join("|"), /不能当作/);
});

test("validate tool rejects unknown fields, credentials and runtime URLs without echoing values", async () => {
  const good = await ok("tax_api_catalog_validate", { id: "portal.mhzx.sso.sso_login", params: { requestPath: "/synthetic" } });
  assert.equal(good.valid, true);
  const bad = await ok("tax_api_catalog_validate", {
    id: "behavior.config.query", params: { t: 1, cookie: PRIVATE, extraField: PRIVATE },
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.problems.some((p) => p.code === "credential_or_session_field_rejected" && p.field === null));
  assert.ok(bad.problems.some((p) => p.code === "parameter_not_in_contract" && p.field === null));
  assert.doesNotMatch(JSON.stringify(bad), /PRIVATE_HTTP|extraField/);

  const url = await ok("tax_api_catalog_validate", { id: "behavior.config.query", params: { t: `https://example.invalid/${PRIVATE}` } });
  assert.equal(url.valid, false);
  assert.ok(url.problems.some((p) => p.code === "runtime_url_rejected"));
  assert.doesNotMatch(JSON.stringify(url), /PRIVATE_HTTP/);

  // 授权码类参数值不接受，也不回流
  const callback = await ok("tax_api_catalog_validate", { id: "portal.mhzx.sso.code_callback", params: { code: PRIVATE } });
  assert.equal(callback.valid, false);
  assert.equal(callback.contractVerified, false);
  assert.equal(callback.paramsEvidence, "inferred");
  assert.ok(callback.problems.some((p) => p.code === "sensitive_parameter_value_rejected"));
  assert.doesNotMatch(JSON.stringify(callback), /PRIVATE_HTTP/);

  // 无合同可对照时不能返回 valid=true
  const noContract = await ok("tax_api_catalog_validate", { id: "portal.mhzx.identity.nsrjbxx_query", params: { x: 1 } });
  assert.equal(noContract.valid, false);
  assert.equal(noContract.contractVerified, false);
});

test("prepare tool answers not_ready / blocked_by_policy with explicit gaps", async () => {
  const login = await ok("tax_api_catalog_prepare", { id: "identity.captcha.verify" });
  assert.equal(login.state, "blocked_by_policy");
  assert.equal(login.readyToInvoke, false);
  assert.equal(login.adapterBinding, "missing");
  assert.equal(login.transport.retryCapability.allowed, false);
  assert.equal(login.transport.retryAdvice.allowed, false);

  const read = await ok("tax_api_catalog_prepare", {
    id: "portal.mhzx.home.get_user_info",
    context: { accountSetId: set.id, enterpriseRef: "ent_0123456789abcdef", loginSessionRef: "loginsession_0123456789abcdef" },
  });
  assert.equal(read.state, "not_ready");
  assert.equal(read.contextRefs.accountSetId, set.id);
  assert.equal(read.contextVerification.accountSetExistsChecked, true);
  assert.equal(read.contextVerification.permissionGrantChecked, false);
  assert.ok(read.notReadyReasons.some((r) => r.code === "parameter_contract_unknown"));
  assert.equal(read.liveCallVerified, false);

  const missingSet = await ok("tax_api_catalog_prepare", {
    id: "portal.mhzx.home.get_user_info", context: { accountSetId: 999999 },
  });
  assert.ok(missingSet.notReadyReasons.some((r) => r.code === "account_set_not_found"));

  // 布尔 true 不得变成 accountSetId=1
  const booleanId = await ok("tax_api_catalog_prepare", {
    id: "portal.mhzx.home.get_user_info", context: { accountSetId: true },
  });
  assert.equal(booleanId.state, "not_ready");
  assert.equal(booleanId.contextRefs.accountSetId, null);
  assert.ok(booleanId.notReadyReasons.some((r) => r.code === "account_set_ref_invalid"));

  const secret = await ok("tax_api_catalog_prepare", {
    id: "portal.mhzx.home.get_user_info", context: { enterpriseRef: PRIVATE, cookie: PRIVATE },
  });
  assert.equal(secret.state, "not_ready");
  assert.doesNotMatch(JSON.stringify(secret), /PRIVATE_HTTP|cookie/);
});

test("classify tool separates outcomes and refuses raw payload fields", async () => {
  const notSent = await ok("tax_api_catalog_classify", { risk: "read_only", observation: { requestIssued: false } });
  assert.equal(notSent.outcome, "not_sent");
  const timeout = await ok("tax_api_catalog_classify", {
    risk: "authentication", observation: { requestIssued: true, transportError: "timeout" },
  });
  assert.equal(timeout.outcome, "transport_timeout");
  assert.equal(timeout.retryAdvice.allowed, false);
  assert.equal(timeout.globalSessionState, "unknown");
  const bare = await ok("tax_api_catalog_classify", {
    risk: "read_only", observation: { requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200 },
  });
  assert.equal(bare.outcome, "structure_unrecognized");
  assert.equal(bare.globalSessionState, "unknown");
  // 空结果族与非 2xx 状态冲突：结构不识别，不重试，也不推断全局登录失效
  const emptyOn401 = await ok("tax_api_catalog_classify", {
    risk: "read_only", observation: {
      requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 401, schemaRecognized: true,
      businessCodeFamily: "empty", businessCodePresent: true, resultCount: 0,
    },
  });
  assert.equal(emptyOn401.outcome, "structure_unrecognized");
  assert.equal(emptyOn401.retryAdvice.allowed, false);
  assert.equal(emptyOn401.globalSessionState, "unknown");
  // 同一 summary 换成 2xx 仍是有效空结果
  const emptyOn200 = await ok("tax_api_catalog_classify", {
    risk: "read_only", observation: {
      requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200, schemaRecognized: true,
      businessCodeFamily: "empty", businessCodePresent: true, resultCount: 0,
    },
  });
  assert.equal(emptyOn200.outcome, "business_empty");
  assert.equal(emptyOn200.globalSessionState, "unknown");
  const auth = await ok("tax_api_catalog_classify", {
    risk: "read_only", observation: {
      requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200, schemaRecognized: true, businessCodeFamily: "auth",
    },
  });
  assert.equal(auth.outcome, "auth_required");
  assert.equal(auth.sessionScope, "call_only");
  assert.equal(auth.globalSessionState, "unknown");

  const rejected = await tool("tax_api_catalog_classify", {
    risk: "read_only", observation: { requestIssued: true, body: PRIVATE },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, "classify_field_rejected");
  assert.doesNotMatch(JSON.stringify(rejected.body), /PRIVATE_HTTP/);

  // 字符串真值不能制造 success
  const stringy = await tool("tax_api_catalog_classify", {
    risk: "read_only",
    observation: { requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200,
      schemaRecognized: "false", businessCodeFamily: "success", businessCodePresent: true, resultCount: 1 },
  });
  assert.equal(stringy.status, 400);
  assert.equal(stringy.body.error, "classify_input_invalid");

  // 全局会话推断入口已移除：sessionProbe 属于未登记字段
  const probe = await tool("tax_api_catalog_classify", { risk: "read_only", observation: { requestIssued: true }, sessionProbe: true });
  assert.equal(probe.status, 400);
  assert.equal(probe.body.error, "catalog_filter_invalid");
});

test("outcomes tool documents the classification rules", async () => {
  const data = await ok("tax_api_catalog_outcomes", {});
  assert.equal(data.outcomes.length, 10);
  assert.ok(data.outcomes.some((o) => o.id === "business_empty"));
  assert.ok(data.rules.some((r) => r.includes("HTTP 200 不等于成功")));
  assert.ok(data.rules.some((r) => r.includes("零事件不等于空数据")));
  assert.ok(data.rules.some((r) => r.includes("tax_session_verify")));
  assert.ok(data.rules.some((r) => r.includes("不是税局 SLA")));
  assert.equal(data.globalSessionState, "unknown");
});

test("catalog tools require JSON content type like other tax tools", async () => {
  const response = await fetch(`${base}/agent/tools/tax_api_catalog_search`, {
    method: "POST", headers: { "content-type": "text/plain" }, body: "{}", signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).error, "json_content_type_required");
});

test("catalog tools reject any extra argument instead of ignoring it, without echoing keys or values", async () => {
  for (const [name, args] of [
    ["tax_api_catalog_entry", { id: "portal.mhzx.home.index", url: "https://example.invalid/x" }],
    ["tax_api_catalog_modules", { moduleId: "identity.white", source: "/private/x" }],
    ["tax_api_catalog_outcomes", { regex: "^/mhzx" }],
    ["tax_api_catalog_validate", { id: "behavior.config.query", params: {}, source: "x" }],
    ["tax_api_catalog_classify", { risk: "read_only", observation: { requestIssued: false }, message: PRIVATE }],
    ["tax_api_catalog_prepare", { id: "behavior.config.query", url: "https://example.invalid/x" }],
    ["tax_api_catalog_prepare", { id: "behavior.config.query", [PRIVATE]: PRIVATE }],
  ]) {
    const result = await tool(name, args);
    assert.equal(result.status, 400, `${name} 应拒绝额外字段`);
    assert.ok(["catalog_filter_invalid", "catalog_prepare_input_invalid"].includes(result.body.error), result.body.error);
    assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_HTTP|url|source|regex/);
  }
});
