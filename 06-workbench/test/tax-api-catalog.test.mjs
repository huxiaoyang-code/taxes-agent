#!/usr/bin/env node
// 税务 API 目录、分类器及就绪层的纯合成单元测试。
// 无网络、浏览器、凭据、税务端点或账套数据。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG, CATALOG_SOURCE, ENVELOPES, MODULES, catalogStats, completenessGaps, contractCompleteness,
  entryDetail, getCatalogEntry, listModules, moduleStats, searchCatalog, validateParams,
} from "../server/tax-api-catalog.mjs";
import {
  OUTCOMES, aggregateOutcomes, classifyOutcome, retryAdviceFor, retryPolicyFor, timeoutFor,
} from "../server/tax-api-catalog-classify.mjs";
import { prepareCatalogCall } from "../server/tax-api-catalog-readiness.mjs";

const PRIVATE = "PRIVATE_SYNTHETIC_SECRET_TRIPWIRE";
const safe = (value, extra = []) => {
  const text = JSON.stringify(value);
  for (const needle of [/PRIVATE_SYNTHETIC/, /https?:\/\//i, ...extra.map((n) => (n instanceof RegExp ? n : new RegExp(n)))]) {
    assert.doesNotMatch(text, needle);
  }
};

// ------------------------------------------------------------------ 目录结构与诚实性
test("every catalog entry carries a stable unique id and the required contract fields", () => {
  const ids = CATALOG.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "目录 id 必须唯一");
  const required = ["id", "module", "service", "purpose", "method", "risk", "evidence", "evidenceLabel", "envelope",
    "params", "paramsEvidence", "paramGaps", "responseEvidence", "responseNotes", "errorNotes", "pagination",
    "download", "identityDependency", "enterpriseDependency", "permissionDependency", "reportLines", "autoExecutable"];
  for (const entry of CATALOG) {
    for (const key of required) assert.ok(Object.hasOwn(entry, key), `${entry.id} 缺少 ${key}`);
    assert.deepEqual([...entry.reportLines].every((line) => Number.isInteger(line) && line > 0 && line <= 153), true,
      `${entry.id} 报告行号必须落在报告范围内`);
    assert.equal(entry.autoExecutable, false, "任何条目都不允许默认自动执行");
    assert.equal(entry.purpose.trim().length > 0, true);
    assert.ok(["GET", "POST", "unknown"].includes(entry.method));
    assert.ok(["read_only", "state_changing", "authentication", "unknown"].includes(entry.risk));
    assert.ok(["observed", "static", "inferred", "unknown"].includes(entry.evidence));
    assert.ok(entry.pathKnown === (typeof entry.pathTemplate === "string" && entry.pathTemplate.startsWith("/")));
    assert.equal(entry.paramGaps.length > 0, true, `${entry.id} 必须显式说明参数缺口`);
  }
});

test("static path templates contain no runtime identifiers, hosts, ports or query strings", () => {
  for (const entry of CATALOG.filter((e) => e.pathKnown)) {
    assert.doesNotMatch(entry.pathTemplate, /^[a-z]+:\/\//i);
    assert.doesNotMatch(entry.pathTemplate, /\?|#|=|@|:/, `${entry.id} 路径模板不得含运行时/动态部分`);
  }
});

test("unknown method and unknown parameter structure are never presented as 'no parameters'", () => {
  const sample = getCatalogEntry("portal.mhzx.identity.nsrjbxx_query");
  assert.equal(sample.method, "unknown");
  assert.equal(sample.params.length, 0);
  assert.equal(sample.paramsEvidence, "unknown");
  assert.ok(sample.paramGaps.some((gap) => gap.includes("不能当作")));
  const detail = entryDetail(sample);
  assert.equal(detail.paramsKnown === true, false);
  assert.ok(detail.paramGaps.length > 0);

  const envelope = getCatalogEntry("identity.basic.dict_query");
  assert.equal(envelope.paramsEvidence, "envelope_only");
  assert.ok(envelope.paramGaps.some((gap) => gap.includes("信封")));
  assert.deepEqual(ENVELOPES[envelope.envelope].fields.map((f) => f.name),
    ["zipCode", "encryptCode", "datagram", "timestamp", "access_token", "signtype", "signature"]);
});

test("inferred parameter structure is never marked observed or full contract", () => {
  const callback = getCatalogEntry("portal.mhzx.sso.code_callback");
  assert.equal(callback.paramsEvidence, "inferred");
  assert.equal(callback.paramsKnown, undefined);
  assert.ok(callback.params.every((p) => p.source === "report_inferred"));
  assert.equal(callback.responseEvidence, "inferred");
  assert.notEqual(contractCompleteness(callback), "full_contract");
  assert.ok(callback.paramGaps.some((gap) => gap.includes("推断")));
  // 授权码类参数只登记依赖，不接受值
  assert.equal(callback.params[0].sensitive, true);
  assert.equal(callback.params[0].valueAccepted, false);
  // 目录里不存在“参数 inferred 却声称 observed”的条目
  for (const entry of CATALOG) {
    if (entry.paramsEvidence === "observed") {
      assert.ok(entry.params.every((p) => p.source === "report_observed"), `${entry.id} 把推断参数标成 observed`);
    }
  }
});

test("observed entries keep their evidence class apart from static-only listings", () => {
  const observed = CATALOG.filter((e) => e.evidence === "observed");
  const statics = CATALOG.filter((e) => e.evidence === "static");
  assert.ok(observed.length >= 20 && statics.length >= 100);
  for (const id of ["behavior.config.query", "portal.mhzx.home.get_user_info", "portal.mhzx.menu.hdrymd",
    "portal.message.reminder.list_wntj", "identity.oauth2.get_public_key", "identity.white.send_sm4",
    "identity.qrcode.verify", "service_desk.entry.sp_handler"]) {
    assert.equal(getCatalogEntry(id).evidence, "observed", id);
  }
  for (const id of ["identity.password.single_account_login", "identity.captcha.get", "portal.mhzx.home.logout"]) {
    assert.equal(getCatalogEntry(id).evidence, "static", id);
  }
});

test("catalog statistics report coverage honestly, including the un-catalogued tpass remainder", () => {
  const stats = catalogStats();
  assert.equal(CATALOG_SOURCE.reportSha256, "0d2f4b8f729b34014315507510bc9aa07d35f8f8d3c04af2fe6f961e87eb4a1c");
  assert.equal(CATALOG_SOURCE.reportLines, 153);
  assert.equal(CATALOG_SOURCE.copiedIntoRepository, false);
  assert.equal(stats.entryCount, CATALOG.length);
  assert.equal(stats.moduleCount, MODULES.length);
  // 报告明确列出的数量 = 登记数，不把 200+ 宣称当契约数
  assert.equal(stats.reportListedEntries, stats.entryCount);
  assert.equal(stats.reportListedModules, stats.moduleCount);
  assert.equal(stats.entriesNotListedByReport, 0);
  assert.equal(stats.entriesWithStaticPath + stats.entriesWithoutStaticPath, stats.entryCount);
  assert.equal(stats.entriesWithReportedPath + stats.entriesWithInferredPath, stats.entriesWithStaticPath);
  assert.equal(stats.entriesWithInferredPath, CATALOG.filter((e) => e.pathEvidence === "inferred_from_name").length);
  assert.equal(stats.entriesWithKnownMethod + stats.entriesWithUnknownMethod, stats.entryCount);
  assert.equal(stats.entriesWithDocumentedParams, CATALOG.filter((e) => e.paramsEvidence === "observed").length);
  assert.equal(stats.entriesWithInferredParams, CATALOG.filter((e) => e.paramsEvidence === "inferred").length);
  assert.equal(stats.entriesWithoutDocumentedParamContract, CATALOG.length - stats.entriesWithDocumentedParams);
  assert.equal(stats.entriesWithDocumentedResponse + stats.entriesWithUnknownResponse, stats.entryCount);
  // 参数键计数：只有 observed 算“已载明”，推断单列，declared 为两者之和
  assert.equal(stats.documentedParamCount, CATALOG.filter((e) => e.paramsEvidence === "observed")
    .reduce((n, e) => n + e.params.length, 0));
  assert.equal(stats.inferredParamCount, CATALOG.filter((e) => e.paramsEvidence === "inferred")
    .reduce((n, e) => n + e.params.length, 0));
  assert.equal(stats.declaredParamCount, stats.documentedParamCount + stats.inferredParamCount);
  assert.equal(stats.declaredParamCount, CATALOG.reduce((n, e) => n + e.params.length, 0));
  assert.equal(stats.documentedParamCount, 20);
  assert.equal(stats.inferredParamCount, 1);
  assert.equal(stats.declaredParamCount, 21);
  assert.equal(stats.documentedSensitiveParamCount + stats.inferredSensitiveParamCount, 5);
  assert.ok(stats.documentedSensitiveParamCount < stats.declaredParamCount, "推断参数不得计入已载明");
  assert.equal(stats.entriesWithUnknownPermissionRequirement, CATALOG.length);
  assert.equal(stats.entriesWithResolvedPermissionRequirement, 0);
  assert.equal(stats.autoExecutableCount, 0);
  assert.equal(stats.liveCallVerifiedCount, 0);
  assert.ok(stats.reportClaimedIdentityEndpoints >= stats.reportClaimedIdentityEndpointsCatalogued,
    "报告自报的端点数不得小于已登记数，且不得被当作已完整登记");
  assert.equal(stats.reportClaimIsNotCoverage, true);
  // 用途推断单独计数，不混入接口观察证据
  assert.equal(stats.byPurposeEvidence.inferred_from_name,
    CATALOG.filter((e) => /推断/.test(e.purpose)).length);
  assert.equal(stats.byPurposeEvidence.reported + stats.byPurposeEvidence.inferred_from_name, stats.entryCount);
  assert.match(stats.coverageScopeNote, /参数计数区分 observed \/ inferred \/ declared/);
  assert.match(stats.timeoutNote, /不是税局 SLA/);
  assert.match(stats.note, /不把未列名的端点当作已登记/);
  safe(stats);
});

test("every path the report states in its observed/static lists is present in the catalog", () => {
  const paths = new Set(CATALOG.filter((e) => e.pathKnown).map((e) => e.pathTemplate));
  // 报告 3 / 4.1–4.4 / 6.1 / 6.2 / 6.3 中写出的静态路径（不含运行时主机与参数值）。
  const reported = [
    "/loginb/",
    "/mhzx/api/mh/mhsy/index", "/mhzx/api/mh/tpass/ssoLogin", "/mhzx/api/mh/tpass/code",
    "/api/v1.0/auth/oauth2/login",
    "/xwcjsjjs/api/xwcjsjjs/api/v1.0/extend/queryGgpz", "/xwcjsjjs/api/xwcjsjjs/api/v1.0/extend/accept",
    "/mhzx/api/mh/mhsy/getUserInfo", "/mhzx/api/mh/gncdgsrd/v1/hdrymd", "/mhzx/api/mh/nsryhsygnzs/v1/jsSbqx",
    "/mhzx/api/mh/wdsc/v1/initView", "/mhzx/api/mh/bqxx/getMhsydbBqxx", "/mhzx/api/mh/szzh/getSzzhUrl",
    "/mhzx/api/mh/gncdgsrd/v1/loginbackquerygncd", "/mhzx/api/mh/znhd/v1/getznhdfwdz",
    "/xxzx/api/nsrxxzx/txzx/wntj/v1/listWntj",
    "/sys-api/v1.0/auth/oauth2/getPublicKey", "/sys-api/v1.0/auth/white/sendSm4",
    "/sys-api/v1.0/auth/wh/oauth2/checkRedirectUrlByClientId", "/sys-api/v1.0/acl/login/config/area",
    "/sys-api/v1.0/basic/dict/query", "/sys-api/v1.0/auth/qrcodeLogin/createQRCode",
    "/sys-api/v1.0/auth/qrcodeLogin/verifyQRCode", "/sys-api/v1.0/acl/app/relationType/getIdCardtype",
    "/hdjl/spHandler",
  ];
  const missing = reported.filter((p) => !paths.has(p));
  // /loginb/ 是登录页静态资源，不是接口，单独登记为已排除项。
  assert.deepEqual(missing, ["/loginb/"], `未登记的已写出路径：${missing.join(",")}`);
  assert.ok(CATALOG.some((e) => e.id === "identity.oauth2.login" && e.evidence === "observed"));
});

test("module listing groups entries by domain module with counts", () => {
  const modules = listModules();
  assert.equal(modules.length, MODULES.length);
  assert.equal(modules.reduce((n, m) => n + m.entryCount, 0), CATALOG.length);
  assert.ok(modules.some((m) => m.service === "identity" && m.entryCount > 0));
  assert.ok(modules.some((m) => m.service === "portal" && m.entryCount > 0));
  const single = moduleStats("identity.white");
  assert.equal(single.module.id, "identity.white");
  assert.equal(single.entries.length, 3);
  for (const row of single.entries) {
    assert.equal(row.catalogManaged, true);
    assert.equal(row.liveCallVerified, false);
  }
  assert.throws(() => moduleStats("unknown.module"), (e) => e.code === "catalog_module_unknown");
  safe(modules);
});

test("contract completeness distinguishes full, method+params, path-only and unknown tiers", () => {
  assert.equal(contractCompleteness(getCatalogEntry("behavior.config.query")), "method_and_params_documented");
  // 方法已知、参数结构未载明：method tier（不能因为路径或方法已知就当完整合同）
  assert.equal(contractCompleteness(getCatalogEntry("portal.mhzx.home.get_user_info")), "method_documented");
  // 方法与参数都未知，只知路径
  assert.equal(contractCompleteness(getCatalogEntry("portal.mhzx.favorite.insert")), "path_only");
  assert.equal(contractCompleteness(getCatalogEntry("identity.quick.entrance_wildcard")), "unknown");
  // 报告只给 passwordLogin(ForUser) 分组、没给独立路径：不得补造路径，归入 unknown 层
  const forUser = getCatalogEntry("identity.password.enterprise_password_login_for_user");
  assert.equal(forUser.pathTemplate, null);
  assert.equal(forUser.pathEvidence, "unknown");
  assert.equal(contractCompleteness(forUser), "unknown");
  assert.ok(forUser.paramGaps.some((g) => /分组|未给出独立路径/.test(g)));
  // 同组的 passwordLogin 仍按报告列名登记
  assert.equal(getCatalogEntry("identity.password.enterprise_password_login").pathTemplate,
    "/sys-api/v1.0/auth/enterprise/passwordLogin");
  // 参数有记录不等于完整可调用契约：响应/前置条件缺失时不得标 full_contract
  assert.equal(contractCompleteness(getCatalogEntry("identity.oauth2.login")), "method_and_params_documented");
  const buckets = catalogStats().byCompleteness;
  assert.equal(Object.values(buckets).reduce((a, b) => a + b, 0), CATALOG.length);
  assert.equal(buckets.full_contract, 0, "当前目录没有同时具备路径/方法/参数/响应/前置条件的接口");
  // 每个层级都能作为检索条件命中（不能有枚举里没列的 tier）
  for (const tier of Object.keys(buckets)) {
    assert.equal(searchCatalog({ completeness: tier, pageSize: 50 }).total, buckets[tier], tier);
  }
  assert.ok(completenessGaps(getCatalogEntry("behavior.config.query")).includes("response") === false);
  assert.ok(completenessGaps(getCatalogEntry("behavior.config.query")).includes("permission_precondition"));
});

// ------------------------------------------------------------------ 检索与分页
test("search paginates deterministically and never leaks a request capability", () => {
  const first = searchCatalog({ page: 1, pageSize: 10 });
  const second = searchCatalog({ page: 2, pageSize: 10 });
  assert.equal(first.total, CATALOG.length);
  assert.equal(first.items.length, 10);
  assert.equal(first.hasMore, true);
  assert.equal(first.pageCount, Math.ceil(CATALOG.length / 10));
  assert.notDeepEqual(first.items.map((i) => i.id), second.items.map((i) => i.id));
  const all = searchCatalog({ pageSize: 50 });
  const collected = [];
  for (let page = 1; page <= all.pageCount; page += 1) {
    const chunk = searchCatalog({ page, pageSize: 50 });
    collected.push(...chunk.items.map((i) => i.id));
    assert.equal(chunk.hasMore, page < all.pageCount);
  }
  assert.equal(collected.length, CATALOG.length);
  assert.equal(new Set(collected).size, CATALOG.length);
  const beyond = searchCatalog({ page: all.pageCount + 1, pageSize: 50 });
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.hasMore, false);
  for (const row of first.items) {
    assert.equal(row.catalogManaged, true);
    assert.equal(row.liveCallVerified, false);
  }
  assert.match(first.note, /目录已管理 ≠ 线上调用已验证/);
  safe(first);
});

test("path evidence is reported or explicit, and unpinned paths stay unknown", () => {
  // 报告只给分组/省略时不补造路径：推断路径不得被当成已报告路径
  const inferred = CATALOG.filter((e) => e.pathEvidence === "inferred_from_name");
  for (const entry of inferred) {
    assert.notEqual(contractCompleteness(entry), "full_contract");
    assert.ok(completenessGaps(entry).includes("path_inferred"), entry.id);
  }
  for (const entry of CATALOG.filter((e) => e.pathKnown)) {
    assert.ok(["reported", "inferred_from_name"].includes(entry.pathEvidence), entry.id);
  }
  // 无路径条目必须显式标 unknown，且不得混入 path_only
  const unknownPath = CATALOG.filter((e) => !e.pathKnown);
  assert.ok(unknownPath.length > 0);
  for (const entry of unknownPath) {
    assert.equal(entry.pathEvidence, "unknown", entry.id);
    assert.equal(contractCompleteness(entry), "unknown", entry.id);
    assert.ok(completenessGaps(entry).includes("path"), entry.id);
  }
});

test("search applies fixed structural filters only", () => {
  const observed = searchCatalog({ evidence: "observed", pageSize: 50 });
  assert.ok(observed.items.every((i) => i.evidence === "observed"));
  const auth = searchCatalog({ risk: "authentication", pageSize: 50 });
  assert.ok(auth.total > 0 && auth.items.every((i) => i.risk === "authentication"));
  assert.equal(searchCatalog({ method: "unknown", pageSize: 1 }).total >= 100, true);
  assert.equal(searchCatalog({ module: "identity.quick" }).total, 3);
  assert.equal(searchCatalog({ service: "service_desk" }).total, 1);
  assert.equal(searchCatalog({ completeness: "unknown", pageSize: 50 }).total, 4);
  assert.equal(searchCatalog({ completeness: "full_contract" }).total, 0);
  assert.ok(searchCatalog({ text: "收藏" }).total >= 4);
  // filters 只回显“是否用过文本检索”和长度，不回显自由文本本身
  const echoed = searchCatalog({ text: " 收藏 ", page: 1 }).filters;
  assert.deepEqual(echoed, { textProvided: true, textLength: 2, textApplied: true, page: 1, pageSize: 20 });
});

test("search never echoes caller input objects or unbounded keys", () => {
  const secret = "SYNTHETIC_SECRET_DO_NOT_ECHO";
  for (const bad of [
    { completeness: { password: secret } }, { module: { password: secret } }, { service: { password: secret } },
    { method: { password: secret } }, { evidence: { password: secret } }, { text: secret, extra: secret },
    { page: "2" }, { pageSize: null }, { risk: secret }, { completeness: secret },
  ]) {
    assert.throws(() => searchCatalog(bad), (e) => /^catalog_/.test(e.code), JSON.stringify(Object.keys(bad)));
  }
  // 合法请求的 filters 不得回显任何对象/数组，且不含 caller 额外键
  const okResult = searchCatalog({ module: "identity.white", page: 2, pageSize: 5 });
  assert.deepEqual(okResult.filters, { textProvided: false, textLength: 0, textApplied: false, module: "identity.white", page: 2, pageSize: 5 });
  // 调用方自由文本不回显（即使是合法关键词）
  const textResult = searchCatalog({ text: "收藏" });
  assert.doesNotMatch(JSON.stringify(textResult.filters), /收藏/);
  assert.doesNotMatch(JSON.stringify(okResult), /SYNTHETIC_SECRET/);
  // 错误消息不回显键名
  try {
    searchCatalog({ [secret]: 1 });
    assert.fail("应当拒绝未知条件");
  } catch (e) {
    assert.equal(e.code, "catalog_filter_invalid");
    assert.doesNotMatch(e.message, /SYNTHETIC_SECRET/);
  }
});

test("search rejects arbitrary URLs, extra keys and out-of-range paging", () => {
  for (const bad of [
    { text: "https://example.invalid/x" }, { text: "/mhzx/api/mh/mhsy/getUserInfo" }, { text: "host:8443" },
    { text: "" }, { text: "x".repeat(65) }, { page: 0 }, { page: 1001 }, { page: 1.5 }, { pageSize: 0 }, { pageSize: 51 },
    { method: "PUT" }, { risk: "danger" }, { evidence: "guess" }, { url: "https://example.invalid" },
    { id: "portal.mhzx.home.index" }, { regex: "^/mhzx" },
  ]) {
    assert.throws(() => searchCatalog(bad), (e) => /^catalog_/.test(e.code), JSON.stringify(bad));
  }
  assert.throws(() => searchCatalog(null), (e) => e.code === "catalog_filter_invalid");
  assert.throws(() => getCatalogEntry("not-a-catalog-id"), (e) => e.code === "catalog_id_unknown");
  assert.throws(() => getCatalogEntry("https://example.invalid/x"), (e) => e.code === "catalog_id_unknown");
});

// ------------------------------------------------------------------ 参数校验
test("parameter validation accepts declared params, rejects outsiders and missing required ones", () => {
  const ok = validateParams("portal.mhzx.sso.sso_login", { requestPath: "/synthetic" });
  assert.equal(ok.valid, true);
  assert.equal(ok.contractVerified, true);

  const missing = validateParams("portal.mhzx.sso.sso_login", {});
  assert.equal(missing.valid, false);
  assert.ok(missing.problems.some((p) => p.code === "required_parameter_missing" && p.field === "requestPath"));

  const unknownField = validateParams("behavior.config.query", { t: 1, somethingElse: "x" });
  assert.equal(unknownField.valid, false);
  // 未登记键名不作为 field 回显
  assert.ok(unknownField.problems.some((p) => p.code === "parameter_not_in_contract" && p.field === null));
  assert.doesNotMatch(JSON.stringify(unknownField), /somethingElse/);

  const wrongType = validateParams("behavior.config.query", { t: 1, sffhClientid: true });
  assert.ok(wrongType.problems.some((p) => p.code === "parameter_type_mismatch" && p.field === "sffhClientid"));

  const unknownContract = validateParams("portal.mhzx.identity.nsrjbxx_query", { queryId: "synthetic" });
  assert.equal(unknownContract.valid, false);
  assert.equal(unknownContract.contractVerified, false);
  assert.ok(unknownContract.problems.some((p) => p.code === "parameter_contract_unknown" && p.field === null));
  assert.doesNotMatch(JSON.stringify(unknownContract), /queryId/);

  assert.equal(validateParams("portal.mhzx.identity.nsrjbxx_query", { valid: true }).valid, false,
    "无合同可对照时不能返回 valid=true");
  assert.equal(validateParams("portal.mhzx.sso.code_callback", { code: "SYNTHETIC" }).valid, false,
    "推断参数合同 + 授权码值都不能通过");
  safe(ok); safe(missing); safe(unknownContract);
});

test("parameter validation rejects credentials, session material and runtime URLs without echoing values", () => {
  for (const params of [
    { t: 1, cookie: PRIVATE }, { t: 1, access_token: PRIVATE }, { t: 1, signature: PRIVATE },
    { t: 1, password: PRIVATE }, { t: `Bearer ${PRIVATE}` }, { t: `eyJhbGciOi.${PRIVATE}.synthetic` },
    { t: `https://example.invalid/${PRIVATE}` }, { t: "x".repeat(600) },
  ]) {
    const result = validateParams("behavior.config.query", params);
    assert.equal(result.valid, false);
    safe(result);
  }
  // 未登记键名不得出现在 field / 消息中
  const keyEcho = validateParams("behavior.config.query", { [PRIVATE]: 1, anotherUnknownKey: 2 });
  safe(keyEcho);
  assert.ok(keyEcho.problems.every((p) => p.field === null || typeof p.field === "string"));
  assert.doesNotMatch(JSON.stringify(keyEcho), /anotherUnknownKey/);

  const notObject = validateParams("behavior.config.query", null);
  assert.equal(notObject.valid, false);
  assert.ok(notObject.problems.some((p) => p.code === "params_not_object"));
  assert.throws(() => validateParams("nope", {}), (e) => e.code === "catalog_id_unknown");
});

// ------------------------------------------------------------------ 调用准备
test("prepare blocks login and write endpoints regardless of context", () => {
  const login = prepareCatalogCall({ id: "identity.password.single_account_login", context: {
    enterpriseRef: "ent_0123456789abcdef", loginSessionRef: "loginsession_0123456789abcdef",
    permissions: ["tax.login"], operatorConfirmed: true,
  } });
  assert.equal(login.state, "blocked_by_policy");
  assert.equal(login.readyToInvoke, false);
  assert.ok(login.notReadyReasons.some((r) => r.code === "policy_authentication_blocked"));

  const write = prepareCatalogCall({ id: "portal.mhzx.favorite.insert" });
  assert.equal(write.state, "blocked_by_policy");
  assert.ok(write.notReadyReasons.some((r) => r.code === "policy_state_changing_blocked"));

  const unknownRisk = prepareCatalogCall({ id: "portal.declaration.mhtj" });
  assert.equal(unknownRisk.state, "blocked_by_policy");
  assert.ok(unknownRisk.notReadyReasons.some((r) => r.code === "policy_unknown_blocked"));
});

test("prepare reports explicit gaps instead of claiming a company is ready", () => {
  const result = prepareCatalogCall({ id: "portal.mhzx.home.get_user_info" });
  assert.equal(result.state, "not_ready");
  assert.equal(result.readyToInvoke, false);
  assert.equal(result.adapterBinding, "missing");
  const codes = result.notReadyReasons.map((r) => r.code);
  // 已观察过但参数结构未载明（门户无信封）→ 合同级缺口必须出现
  assert.ok(codes.includes("parameter_contract_unknown"), codes.join(","));
  // 登录后门户接口缺 session 引用、企业/权限要求未知，一律报缺项
  for (const code of ["identity_context_missing", "enterprise_requirement_unknown", "permission_requirement_unknown"]) {
    assert.ok(codes.includes(code), code);
  }
  // 已观察条目不应被标成“未观察过实际调用”
  assert.equal(codes.includes("not_observed_live"), false);
  // 静态列举条目必须提示「未被观察过实际调用」
  const staticEntry = prepareCatalogCall({ id: "portal.mhzx.identity.nsrjbxx_query" });
  assert.ok(staticEntry.notReadyReasons.some((r) => r.code === "not_observed_live"));
  assert.ok(staticEntry.contractGaps.length > 1);
});

test("prepare validates account/enterprise/login/session references and never echoes values", () => {
  let looked = null;
  const withResolver = prepareCatalogCall(
    { id: "portal.mhzx.home.get_user_info", context: { accountSetId: 7 } },
    { accountSetExists: (id) => { looked = id; return true; } },
  );
  assert.equal(looked, 7);
  assert.equal(withResolver.contextRefs.accountSetId, 7);
  assert.equal(withResolver.contextVerification.accountSetExistsChecked, true);
  // 引用与权限声明只做格式校验，明确 unverified
  assert.equal(withResolver.contextVerification.userDeclaredRefsFormatOnly, true);
  assert.equal(withResolver.contextVerification.enterpriseOwnershipChecked, false);
  assert.equal(withResolver.contextVerification.permissionGrantChecked, false);
  assert.match(withResolver.contextVerification.note, /未核实|不核实/);

  // resolver 返回 false 也必须拒绝，不能默认“存在”
  const falseResolver = prepareCatalogCall({ id: "portal.mhzx.home.get_user_info", context: { accountSetId: 11 } },
    { accountSetExists: () => false });
  assert.ok(falseResolver.notReadyReasons.some((r) => r.code === "account_set_not_found"));
  assert.equal(falseResolver.contextRefs.accountSetId, null);
  assert.equal(falseResolver.contextVerification.accountSetExistsChecked, false);

  const missing = prepareCatalogCall({ id: "portal.mhzx.home.get_user_info", context: { accountSetId: 999 } },
    { accountSetExists: () => { throw new Error("account_set_not_found"); } });
  assert.ok(missing.notReadyReasons.some((r) => r.code === "account_set_not_found"));

  // 严格正整数：布尔/浮点/科学计数法/非数字串都不能变相通过
  for (const badId of [true, false, "1e3", "0x10", 1.5, -1, 0, " 7", "7 ", "", null, [], {}]) {
    const result = prepareCatalogCall({ id: "portal.mhzx.home.get_user_info", context: { accountSetId: badId } });
    assert.ok(result.notReadyReasons.some((r) => r.code === "account_set_ref_invalid"), String(badId));
    assert.equal(result.contextRefs.accountSetId, null, String(badId));
  }
  // 数字串是显式允许的（JSON 传输友好）
  assert.equal(prepareCatalogCall({ id: "portal.mhzx.home.get_user_info", context: { accountSetId: "12" } },
    { accountSetExists: () => true }).contextRefs.accountSetId, 12);

  for (const context of [
    { enterpriseRef: "合成企业有限公司" }, { enterpriseRef: PRIVATE }, { loginSessionRef: PRIVATE },
    { period: "2026-13" }, { permissions: ["Bad Permission"] }, { cookie: PRIVATE },
    { operatorConfirmed: "yes" }, { accountSetId: -1 },
  ]) {
    const result = prepareCatalogCall({ id: "portal.mhzx.home.get_user_info", context });
    assert.equal(result.state, "not_ready");
    safe(result);
  }
  // 未知上下文键名不回显
  const unknownKey = prepareCatalogCall({ id: "portal.mhzx.home.get_user_info", context: { [PRIVATE]: 1 } });
  assert.ok(unknownKey.notReadyReasons.some((r) => r.code === "context_field_rejected"));
  safe(unknownKey);

  const contextOnlyButPolicy = prepareCatalogCall({ id: "identity.sms.message_send", context: { cookie: PRIVATE } });
  assert.equal(contextOnlyButPolicy.state, "blocked_by_policy");
  safe(contextOnlyButPolicy);
});

test("prepare stays contract-only: missing adapter is explicit and result is never 'verified'", () => {
  const result = prepareCatalogCall({
    id: "behavior.config.query",
    params: { t: 1, sjbbh: null, gnbbh: null, sffhClientid: "Y" },
    context: {
      enterpriseRef: "ent_0123456789abcdef", loginSessionRef: "loginsession_0123456789abcdef",
      permissions: ["behavior.config"], operatorConfirmed: true,
    },
  });
  assert.equal(result.adapterBinding, "missing");
  assert.equal(result.liveCallVerified, false);
  assert.equal(result.catalogManaged, true);
  assert.equal(result.readyToInvoke, false);
  assert.equal(result.state, "not_ready");
  assert.deepEqual(result.transport.retryCapability, retryPolicyFor("read_only"));
  assert.equal(result.transport.retryAdvice.allowed, false, "本层未发请求，本次重试建议恒为 false");
  assert.equal(result.transport.timeoutPolicy, "local_policy_default_not_tax_sla");
  assert.equal(result.transport.autoRetryForLoginOrWrite, false);
  safe(result);

  const rejected = prepareCatalogCall({ id: "behavior.config.query", params: { cookie: PRIVATE } });
  assert.ok(rejected.notReadyReasons.some((r) => r.code.startsWith("param_credential")));
  safe(rejected);
});

test("prepare input contract rejects arbitrary fields, ids and non-object context", () => {
  assert.throws(() => prepareCatalogCall({ id: "behavior.config.query", url: "https://example.invalid" }),
    (e) => e.code === "catalog_prepare_input_invalid");
  assert.throws(() => prepareCatalogCall({ id: "not-a-catalog-id" }), (e) => e.code === "catalog_id_unknown");
  assert.throws(() => prepareCatalogCall(null), (e) => e.code === "catalog_prepare_input_invalid");
  // 未知顶层键名不回显
  try {
    prepareCatalogCall({ id: "behavior.config.query", [PRIVATE]: PRIVATE });
    assert.fail("应当拒绝未知输入字段");
  } catch (e) {
    assert.equal(e.code, "catalog_prepare_input_invalid");
    assert.doesNotMatch(e.message, /PRIVATE_SYNTHETIC/);
  }
  const badContext = prepareCatalogCall({ id: "behavior.config.query", context: "synthetic" });
  assert.ok(badContext.notReadyReasons.some((r) => r.code === "context_invalid"));
});

// ------------------------------------------------------------------ 结果分类
test("classifier separates not-sent, timeout, transport failure and received-but-unparsed", () => {
  assert.equal(classifyOutcome({ requestIssued: false }).outcome, "not_sent");
  assert.equal(classifyOutcome({ requestIssued: true, transportError: "timeout" }, { risk: "read_only" }).outcome, "transport_timeout");
  assert.equal(classifyOutcome({ requestIssued: true, transportError: "network" }).outcome, "transport_failed");
  assert.equal(classifyOutcome({ requestIssued: true, responseReceived: true }).outcome, "response_unparsed");
  assert.equal(classifyOutcome({ requestIssued: true, bodyParsed: false }).outcome, "response_unparsed");
  const timeout = classifyOutcome({ requestIssued: true, transportError: "timeout" }, { risk: "authentication" });
  assert.equal(timeout.retryAdvice.allowed, false);
  assert.equal(timeout.retryCapability.allowed, false);
  assert.equal(timeout.timeoutMs, timeoutFor("authentication"));
  assert.equal(timeout.timeoutPolicy, "local_policy_default_not_tax_sla");
  assert.equal(timeout.globalSessionState, "unknown");
  // 超时不等于无权限 / 全局登录失效
  assert.equal(timeout.outcome, "transport_timeout");
  assert.notEqual(timeout.outcome, "permission_denied");
});

test("classifier strictly validates every known field type, enum and range", () => {
  const secret = "SYNTHETIC_SECRET_INPUT";
  const bad = [
    // 字符串/对象真值不得被当成 true
    { requestIssued: "true" }, { requestIssued: 1 }, { schemaRecognized: "false" }, { schemaRecognized: {} },
    { bodyParsed: "yes" }, { responseReceived: [] }, { businessCodePresent: "true" }, { authSignal: "1" },
    { permissionSignal: 1 }, { emptinessEvidence: "true" },
    // 枚举/范围
    { httpStatus: 99 }, { httpStatus: 600 }, { httpStatus: "200" }, { httpStatus: 200.5 },
    { resultCount: -1 }, { resultCount: 1.5 }, { resultCount: "0" },
    { elapsedMs: -1 }, { elapsedMs: Infinity }, { elapsedMs: "10" }, { elapsedMs: 4_000_000 },
    { retryAttempt: -1 }, { retryAttempt: 1.5 }, { retryAttempt: 11 }, { retryAttempt: "1" },
    { transportError: "panic" }, { phase: "synthetic" }, { businessCodeFamily: secret },
    // 已删除的全局推断入口
    { sessionProbe: true },
  ];
  for (const observation of bad) {
    assert.throws(() => classifyOutcome({ requestIssued: true, ...observation }, { risk: "read_only" }),
      (e) => ["classify_input_invalid", "classify_field_rejected"].includes(e.code), JSON.stringify(observation));
  }
  // 字符串 'false' 不能制造成功
  const truthyString = () => classifyOutcome({
    requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200, schemaRecognized: "false",
    businessCodeFamily: "success", businessCodePresent: true, resultCount: 1,
  }, { risk: "read_only" });
  assert.throws(truthyString, (e) => e.code === "classify_input_invalid");
});

test("contradictory metadata can never produce success", () => {
  const base = { requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200 };
  const contradictions = [
    { ...base, schemaRecognized: true, businessCodeFamily: "success", businessCodePresent: true, authSignal: true },
    { ...base, schemaRecognized: true, businessCodeFamily: "success", businessCodePresent: true, permissionSignal: true },
    { ...base, schemaRecognized: true, businessCodeFamily: "success", businessCodePresent: true, emptinessEvidence: true, resultCount: 5 },
    { ...base, schemaRecognized: true, businessCodeFamily: "empty", businessCodePresent: true, resultCount: 4 },
    { ...base, schemaRecognized: true, businessCodeFamily: "success", businessCodePresent: true, httpStatus: 500 },
    { ...base, schemaRecognized: true, businessCodeFamily: "auth", businessCodePresent: true, authSignal: false },
    // 未发出却带来响应/业务结果；有传输错误却声称收到响应
    { requestIssued: false, responseReceived: true, bodyParsed: true },
    { requestIssued: true, transportError: "timeout", responseReceived: true, bodyParsed: true,
      schemaRecognized: true, businessCodeFamily: "success", businessCodePresent: true, resultCount: 1 },
    // 显式 responseReceived=false 却给出解析/结构/业务码/计数证据
    { requestIssued: true, responseReceived: false, bodyParsed: true },
    { requestIssued: true, responseReceived: false, bodyParsed: true, schemaRecognized: true },
    { requestIssued: true, responseReceived: false, bodyParsed: true, businessCodePresent: true },
    { requestIssued: true, responseReceived: false, bodyParsed: true, resultCount: 2 },
    { requestIssued: true, responseReceived: false, schemaRecognized: true },
    // 成功族业务码与非 2xx 状态冲突
    { requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 302, schemaRecognized: true,
      businessCodeFamily: "success", businessCodePresent: true },
    { requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 401, schemaRecognized: true,
      businessCodeFamily: "success", businessCodePresent: true },
    // 空结果族同属成功类：与非 2xx 状态同样矛盾
    { requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 401, schemaRecognized: true,
      businessCodeFamily: "empty", businessCodePresent: true, resultCount: 0 },
    { requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 403, schemaRecognized: true,
      businessCodeFamily: "empty", businessCodePresent: true, resultCount: 0 },
    { requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 500, schemaRecognized: true,
      businessCodeFamily: "empty", businessCodePresent: true, resultCount: 0 },
  ];
  for (const observation of contradictions) {
    const result = classifyOutcome(observation, { risk: "read_only" });
    assert.equal(result.outcome, "structure_unrecognized", JSON.stringify(observation));
    assert.notEqual(result.outcome, "success");
    assert.ok(result.contradictionCodes.length > 0);
  }
});

test("HTTP 200 alone is never success and zero events are never empty data", () => {
  const bare200 = classifyOutcome({ requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200 },
    { risk: "read_only" });
  assert.equal(bare200.httpStatus, 200);
  assert.equal(bare200.outcome, "structure_unrecognized");
  assert.equal(bare200.retryAdvice.allowed, false);

  const zeroRows = classifyOutcome({
    requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200, schemaRecognized: true,
    businessCodeFamily: "success", businessCodePresent: true, resultCount: 0,
  }, { risk: "read_only" });
  assert.equal(zeroRows.outcome, "structure_unrecognized", "无显式无记录证据的零结果不得判定为空");

  const provenEmpty = classifyOutcome({
    requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200, schemaRecognized: true,
    businessCodeFamily: "success", businessCodePresent: true, resultCount: 0, emptinessEvidence: true,
  }, { risk: "read_only" });
  assert.equal(provenEmpty.outcome, "business_empty");

  const success = classifyOutcome({
    requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200, schemaRecognized: true,
    businessCodeFamily: "success", businessCodePresent: true, resultCount: 3,
  }, { risk: "read_only" });
  assert.equal(success.outcome, "success");
  assert.equal(success.httpStatusIsSuccessAlone, false);
  assert.deepEqual(success.contradictionCodes, []);
});

test("auth requirement, permission denial and business error are distinct on any HTTP status", () => {
  const base = { requestIssued: true, responseReceived: true, bodyParsed: true, schemaRecognized: true };
  assert.equal(classifyOutcome({ ...base, httpStatus: 200, businessCodeFamily: "auth" }, { risk: "read_only" }).outcome, "auth_required");
  assert.equal(classifyOutcome({ ...base, httpStatus: 200, authSignal: true }, { risk: "read_only" }).outcome, "auth_required");
  assert.equal(classifyOutcome({ ...base, httpStatus: 403, businessCodeFamily: "permission" }, { risk: "read_only" }).outcome, "permission_denied");
  assert.equal(classifyOutcome({ ...base, httpStatus: 200, permissionSignal: true }, { risk: "read_only" }).outcome, "permission_denied");
  assert.equal(classifyOutcome({ ...base, httpStatus: 200, businessCodeFamily: "error" }, { risk: "read_only" }).outcome, "business_error");
  assert.equal(classifyOutcome({ ...base, httpStatus: 500, businessCodeFamily: "error" }, { risk: "read_only" }).outcome, "business_error");
  assert.equal(classifyOutcome({ ...base, httpStatus: 200, businessCodeFamily: "unknown" }, { risk: "read_only" }).outcome,
    "structure_unrecognized");
  assert.equal(classifyOutcome({ requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200 },
    { risk: "read_only" }).outcome, "structure_unrecognized");
});

test("explicit responseReceived=false without evidence is transport_failed, not response_unparsed", () => {
  // 显式未收到响应 + 未解析 + 无其他矛盾证据：传输失败
  const absent = classifyOutcome({ requestIssued: true, responseReceived: false, bodyParsed: false }, { risk: "read_only" });
  assert.equal(absent.outcome, "transport_failed");
  assert.deepEqual(absent.contradictionCodes, []);
  assert.equal(absent.globalSessionState, "unknown");
  // 省略 responseReceived 保持旧兼容：仍为 response_unparsed
  const omitted = classifyOutcome({ requestIssued: true, bodyParsed: false }, { risk: "read_only" });
  assert.equal(omitted.outcome, "response_unparsed");
  // 矛盾组合一律结构不识别：不得据此判登录失效
  for (const observation of [
    { requestIssued: true, responseReceived: false, bodyParsed: true },
    { requestIssued: true, responseReceived: false, bodyParsed: true, schemaRecognized: true, businessCodePresent: true },
    { requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 502, schemaRecognized: true,
      businessCodeFamily: "success", businessCodePresent: true },
  ]) {
    const result = classifyOutcome(observation, { risk: "read_only" });
    assert.equal(result.outcome, "structure_unrecognized", JSON.stringify(observation));
    assert.ok(result.contradictionCodes.length > 0);
    assert.equal(result.globalSessionState, "unknown");
    assert.notEqual(result.outcome, "auth_required");
    assert.equal(result.retryAdvice.allowed, false);
  }
  // 非 2xx 但业务码为 auth 族仍只算 call_only 认证要求，不升级为全局登录失效
  const authOn401 = classifyOutcome({ requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 401,
    schemaRecognized: true, businessCodeFamily: "auth", businessCodePresent: true }, { risk: "read_only" });
  assert.equal(authOn401.outcome, "auth_required");
  assert.equal(authOn401.globalSessionState, "unknown");
});

test("empty family on non-2xx is structure_unrecognized, not a global login failure", () => {
  const base = { requestIssued: true, responseReceived: true, bodyParsed: true, schemaRecognized: true,
    businessCodeFamily: "empty", businessCodePresent: true, resultCount: 0 };
  const bad = [401, 403, 500].map((httpStatus) =>
    classifyOutcome({ ...base, httpStatus }, { risk: "read_only" }));
  for (const result of bad) {
    assert.equal(result.outcome, "structure_unrecognized");
    assert.deepEqual(result.contradictionCodes, ["empty_family_on_non_2xx_status"]);
    assert.equal(result.retryAdvice.allowed, false);
    assert.equal(result.globalSessionState, "unknown");
    assert.equal(result.sessionScope, "call_only");
    assert.notEqual(result.outcome, "auth_required");
    assert.notEqual(result.outcome, "permission_denied");
  }
  // 不再被计为 successLike
  const aggregates = aggregateOutcomes([...bad, { outcome: "success" }]);
  assert.equal(aggregates.counts.structure_unrecognized, 3);
  assert.equal(aggregates.counts.business_empty, 0);
  assert.equal(aggregates.successLike, 1);
  assert.equal(aggregates.globalSessionState, "unknown");

  // empty + 2xx 仍是有效空结果
  for (const httpStatus of [200, 204]) {
    const ok = classifyOutcome({ ...base, httpStatus }, { risk: "read_only" });
    assert.equal(ok.outcome, "business_empty");
    assert.deepEqual(ok.contradictionCodes, []);
    assert.equal(ok.retryAdvice.allowed, false);
    assert.equal(ok.globalSessionState, "unknown");
  }
});

test("a single call cannot by itself declare a global login failure", () => {
  const perCall = classifyOutcome({
    requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200, schemaRecognized: true,
    businessCodeFamily: "auth", businessCodePresent: true,
  }, { risk: "read_only" });
  assert.equal(perCall.outcome, "auth_required");
  assert.equal(perCall.sessionScope, "call_only");
  assert.equal(perCall.globalSessionState, "unknown");
  assert.match(perCall.globalSessionNote, /tax_session_verify/);
  const aggregates = aggregateOutcomes([perCall, { outcome: "success" }]);
  assert.equal(aggregates.counts.auth_required, 1);
  assert.equal(aggregates.counts.success, 1);
  assert.equal(aggregates.globalSessionState, "unknown");
  assert.equal(aggregates.sessionScope, "call_only");
});

test("no public entry can infer a global login state from a caller boolean", async () => {
  const module = await import("../server/tax-api-catalog-classify.mjs");
  assert.equal(Object.hasOwn(module, "classifySession"), false, "不应存在公开的全局会话推断入口");
  // 即使调用方传 sessionProbe 也不能影响结论：它现在是未登记字段
  assert.throws(() => classifyOutcome({ requestIssued: true, sessionProbe: true }, { risk: "read_only" }),
    (e) => e.code === "classify_field_rejected");
});

test("classifier records safe metadata only and rejects raw payload or error text", () => {
  const result = classifyOutcome({
    requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200, schemaRecognized: true,
    businessCodeFamily: "success", businessCodePresent: true, resultCount: 2, elapsedMs: 41.6, retryAttempt: 1,
  }, { risk: "read_only" });
  assert.equal(result.elapsedMs, 42);
  assert.equal(result.businessCodePresent, true);
  assert.equal(result.retryAttempt, 1);
  assert.equal(result.phase, "interpret");
  assert.equal(result.liveCallVerified, false);
  safe(result);

  for (const observation of [
    { requestIssued: true, body: PRIVATE }, { requestIssued: true, message: PRIVATE }, { requestIssued: true, raw: PRIVATE },
    { requestIssued: true, url: "https://example.invalid" }, { requestIssued: true, businessCode: "2001" },
    { requestIssued: true, businessCodeFamily: PRIVATE }, { requestIssued: true, phase: "synthetic" },
  ]) {
    assert.throws(() => classifyOutcome(observation, { risk: "read_only" }), (e) => e.code === "classify_field_rejected"
      || e.code === "classify_input_invalid");
  }
  assert.throws(() => classifyOutcome({ requestIssued: true }, { risk: "danger" }), (e) => e.code === "classify_risk_invalid");
  assert.throws(() => aggregateOutcomes([{ outcome: PRIVATE }]), (e) => e.code === "classify_input_invalid");
  assert.doesNotMatch(JSON.stringify(OUTCOMES), /PRIVATE/);
});

test("retry distinguishes static capability from this-call advice and never retries decided outcomes", () => {
  assert.equal(retryPolicyFor("read_only").allowed, true);
  for (const risk of ["authentication", "state_changing", "unknown"]) {
    assert.equal(retryPolicyFor(risk).allowed, false, risk);
    assert.equal(retryPolicyFor(risk).maxAttempts, 0);
  }
  // 只读瞬时传输失败 → 第一次调用后仍可再试一次
  const timeoutFirst = classifyOutcome({ requestIssued: true, transportError: "timeout" }, { risk: "read_only" });
  assert.equal(timeoutFirst.retryAdvice.allowed, true);
  assert.equal(timeoutFirst.retryAdvice.nextAttempt, 1);
  // 已用尽（retryAttempt=1 时 maxAttempts=2）
  const exhausted = classifyOutcome({ requestIssued: true, transportError: "timeout", retryAttempt: 1 },
    { risk: "read_only" });
  assert.equal(exhausted.retryAdvice.allowed, false);
  assert.equal(exhausted.retryAdvice.reason.includes("用尽"), true);
  // 非瞬时/已定论的结果一律不重试
  const decided = [
    { risk: "read_only", observation: { requestIssued: false } },
    { risk: "read_only", observation: { requestIssued: true, responseReceived: true, bodyParsed: true,
      httpStatus: 200, schemaRecognized: true, businessCodeFamily: "success", businessCodePresent: true, resultCount: 1 } },
    { risk: "read_only", observation: { requestIssued: true, responseReceived: true, bodyParsed: true,
      httpStatus: 200, schemaRecognized: true, businessCodeFamily: "auth", businessCodePresent: true } },
    { risk: "read_only", observation: { requestIssued: true, responseReceived: true, bodyParsed: true,
      httpStatus: 403, schemaRecognized: true, businessCodeFamily: "permission", businessCodePresent: true } },
    { risk: "read_only", observation: { requestIssued: true, responseReceived: true, bodyParsed: true,
      httpStatus: 200, schemaRecognized: true, businessCodeFamily: "success", businessCodePresent: true,
      resultCount: 0, emptinessEvidence: true } },
    { risk: "read_only", observation: { requestIssued: true, responseReceived: true, bodyParsed: true,
      httpStatus: 200, schemaRecognized: true, businessCodeFamily: "error", businessCodePresent: true } },
    { risk: "read_only", observation: { requestIssued: true, responseReceived: true } },
  ];
  for (const { risk, observation } of decided) {
    const result = classifyOutcome(observation, { risk });
    assert.equal(result.retryAdvice.allowed, false, `${result.outcome} 不应建议重试`);
  }
  // 静态能力可重试但本次结果不重试时，两者必须分开呈现
  const success = classifyOutcome({ requestIssued: true, responseReceived: true, bodyParsed: true, httpStatus: 200,
    schemaRecognized: true, businessCodeFamily: "success", businessCodePresent: true, resultCount: 1 }, { risk: "read_only" });
  assert.equal(success.retryCapability.allowed, true);
  assert.equal(success.retryAdvice.allowed, false);
  assert.equal(retryAdviceFor("transport_timeout", { risk: "state_changing" }).allowed, false);
  assert.equal(retryAdviceFor("transport_timeout", { risk: "unknown" }).allowed, false);
  assert.equal(retryAdviceFor("transport_timeout", { risk: "authentication" }).allowed, false);
});
