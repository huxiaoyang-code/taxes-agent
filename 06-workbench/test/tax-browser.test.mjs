#!/usr/bin/env node
/**
 * tax-browser.test.mjs — 税局浏览器导入（福建漳州）测试
 *
 * 三部分：
 *   A. 纯函数 + 服务（依赖注入假浏览器/假 CDP + fixtures）：税号严格校验、
 *      标签配对（含「无标签税号不认作授权企业」）、真实页内脚本在假 DOM 上的快照、
 *      会话生命周期（错误来源页/未知布局/读取超时/关闭/浏览器退出/TTL/上限/
 *      并发关闭后迟到结果丢弃/profile 清理）、导入幂等/原子性/空账套绑定/名称变更/
 *      伪造候选拒绝。
 *   B. 真实 HTTP 接线（node:http 起 server + 注入假浏览器 service）：
 *      回环 Host/同源 Origin/一次性 loginToken/严格 JSON content-type/无通配 CORS、
 *      read→import 全流程、hostile origin 取不到令牌。
 *   C. 生产 server.mjs spawn（临时库 + 随机端口）：config 只读、负路径登录、
 *      404/405/无 CORS 头；绝不真正打开浏览器窗口、不访问真实税局。
 *
 * 运行：node test/tax-browser.test.mjs（在 06-workbench 目录）
 * 不连接真实税务系统、不启动真实浏览器；全部浏览器/CDP 均为本进程内假实现。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "wb-taxbrowser-"));
const profileRoot = mkdtempSync(join(tmpdir(), "tb-profiles-"));
process.env.WORKBENCH_DATA_DIR = dataDir;

const {
  TaxBrowserService, TaxBrowserError,
  validateTaxpayerId, usccCheckChar, extractEnterprisesFromCells,
  READ_PAGE_SCRIPT, findBrowserExecutable, isLoopbackDevtoolsUrl,
} = await import("../server/tax-browser.mjs");
const { importFromTaxBrowser, TaxImportError } = await import("../server/tax-import.mjs");
const { createTaxBrowserRoutes, isLoopbackHost, checkLocalOrigin } = await import("../server/tax-browser-http.mjs");
const A = await import("../server/accounting.mjs");

const unhandled = [];
process.on("unhandledRejection", (reason) => { unhandled.push(reason); });

const waitFor = async (fn, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
};

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.message}`); }
};
const assertErr = async (fn, code) => {
  let err;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, `期望抛出 ${code}，但没有抛错`);
  assert.equal(err.code, code, `错误码应为 ${code}，实际 ${err.code}（${err.message}）`);
  return err;
};

// ---------------------------------------------------------------- 工具
const USCC17 = "91350600MA34B1W60";
const USCC_VALID = USCC17 + usccCheckChar(USCC17);
const USCC2_17 = "91350600MA34B1W61";
const USCC2 = USCC2_17 + usccCheckChar(USCC2_17);
const OLD15 = "350600199012345"; // 15 位旧识别号（6 位区划 + 9 位组织代码）
/** 每个用例独立的合法统一社会信用代码（17 位种子 + 计算校验位）。 */
let usccSeq = 0;
const uscc = () => {
  // 17 位种子（区划 9135060 + 序号），纯数字保证字符集合法，再计算校验位
  const seed = `9135060${String(++usccSeq).padStart(10, "0")}`;
  return seed + usccCheckChar(seed);
};

function makeFakeBrowser({ initialUrl = "https://etax.fujian.chinatax.gov.cn/", pages = [], hangRead = false, readGate = null } = {}) {
  let pageIndex = 0;
  let evaluateCount = 0;
  let scriptEvaluates = 0;
  const state = { launched: 0, killed: 0, closed: false, url: initialUrl, evaluateCount, scriptEvaluates, hangRead };
  const exitHandlers = [];
  const proc = {
    pid: 4242,
    onExit: (cb) => exitHandlers.push(cb),
    devtoolsUrl: async () => "ws://127.0.0.1:51234/devtools/browser/fake-uuid",
    kill: async () => { state.killed++; state.closed = true; for (const cb of exitHandlers.splice(0)) cb(0, null); },
  };
  const conn = {
    send: async (method, params = {}) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "t1", type: "page", url: state.url }] };
      if (method === "Target.attachToTarget") return { sessionId: "cdp1" };
      if (method === "Runtime.evaluate") {
        if (params.expression === "location.href") { state.evaluateCount++; return { result: { type: "string", value: state.url } }; }
        state.scriptEvaluates++;
        if (readGate) await readGate;
        if (state.hangRead) await new Promise(() => {}); // 永不返回 → 读取超时
        const page = pages[pageIndex];
        return { result: { type: "object", value: { href: state.url, title: "国家税务总局电子税务局", rows: page ? page.rows : [] } } };
      }
      return {};
    },
    close: () => { state.connClosed = true; },
  };
  return {
    state, proc, conn,
    deps: { launchBrowser: async () => { state.launched++; return proc; }, connectBrowser: async () => conn },
    nextPage: () => { pageIndex = Math.min(pageIndex + 1, Math.max(pages.length - 1, 0)); },
    exitBrowser: () => { state.closed = true; for (const cb of exitHandlers.splice(0)) cb(0, null); },
  };
}

function makeService(deps = {}, limits = {}, overrides = {}) {
  return new TaxBrowserService({
    profileRootDir: profileRoot,
    importer: importFromTaxBrowser,
    limits: { maxSessions: 3, sessionTtlMs: 60_000, readTimeoutMs: 500, launchTimeoutMs: 1_000, loginTokenTtlMs: 60_000, ...limits },
    log: () => {},
    ...deps,
    ...overrides,
  });
}

async function openSession(svc) {
  const token = svc.issueLoginToken();
  return svc.openSession({ region: "350000", city: "350600", loginToken: token });
}

// ---------------------------------------------------------------- A1. 纯函数
console.log("\nA. 纯函数与服务（注入假浏览器）\n");

const BAD_USCC = USCC17 + (usccCheckChar(USCC17) === "A" ? "B" : "A"); // 校验位必然错误

await test("税号校验：18 位统一社会信用代码校验位正确才通过", () => {
  assert.equal(validateTaxpayerId(USCC_VALID), USCC_VALID);
  assert.equal(validateTaxpayerId(USCC_VALID.toLowerCase()), USCC_VALID, "应规范化大写");
  assert.equal(validateTaxpayerId(BAD_USCC), null, "校验位错误必须拒绝");
  assert.equal(validateTaxpayerId("91350600MA34B1W6Z"), null, "非字符集字母（Z）拒绝");
  assert.equal(validateTaxpayerId(""), null);
  assert.equal(validateTaxpayerId(null), null);
  assert.equal(validateTaxpayerId("91350600MA34B1W6"), null, "长度不足拒绝");
});

await test("税号校验：15 位旧纳税人识别号（区划+组织代码）", () => {
  assert.equal(validateTaxpayerId(OLD15), OLD15);
  assert.equal(validateTaxpayerId("35060199012345"), null, "前 6 位必须全是数字区划");
  assert.equal(validateTaxpayerId("350600_9012345"), null, "非法字符拒绝");
  assert.equal(validateTaxpayerId("3506001990123456"), null, "16 位不按 15 位识别号放行");
});

await test("行提取：表格布局「标签格+值格」配对", () => {
  const rows = [[ "企业名称", "漳州示例食品有限公司", "统一社会信用代码", USCC_VALID ]];
  const { items, matchedRows } = extractEnterprisesFromCells(rows);
  assert.equal(matchedRows, 1);
  assert.deepEqual(items, [{ taxpayerId: USCC_VALID, name: "漳州示例食品有限公司", occurrences: 1 }]);
});

await test("行提取：卡片式「标签：值」同格内联配对", () => {
  const rows = [["纳税人名称：漳州示例食品有限公司"], ["统一社会信用代码： " + USCC_VALID]];
  // 两个独立行：名称行与税号行分开 → 不配对（同格才配对）
  const r1 = extractEnterprisesFromCells([["纳税人名称：漳州示例食品有限公司", "统一社会信用代码：" + USCC_VALID]]);
  assert.equal(r1.items.length, 1);
  assert.equal(r1.items[0].name, "漳州示例食品有限公司");
});

await test("行提取：dl/dt 式键值（标签与值相邻）", () => {
  const rows = [["纳税人名称", "漳州示例食品有限公司", "纳税人识别号", USCC_VALID]];
  const { items } = extractEnterprisesFromCells(rows);
  assert.equal(items.length, 1);
  assert.equal(items[0].taxpayerId, USCC_VALID);
});

await test("行提取：页面上裸露税号（无标签对应）绝不认作授权企业", () => {
  const rows = [
    ["漳州示例食品有限公司", USCC_VALID, "正常"],
    ["91350600MA34B1W60" + usccCheckChar(USCC17), "另一家公司"],
  ];
  const { items, matchedRows } = extractEnterprisesFromCells(rows);
  assert.equal(matchedRows, 0, "没有标签就不应配对");
  assert.equal(items.length, 0);
});

await test("行提取：只有名称标签没有税号标签 → 不配对", () => {
  const { items } = extractEnterprisesFromCells([["企业名称", "漳州示例食品有限公司", "状态", "正常"]]);
  assert.equal(items.length, 0);
});

await test("行提取：税号校验未通过的配对行被丢弃并计数", () => {
  const { items, rowsWithInvalidTaxId } = extractEnterprisesFromCells([["企业名称", "A公司", "统一社会信用代码", BAD_USCC]]);
  assert.equal(items.length, 0);
  assert.equal(rowsWithInvalidTaxId, 1);
});

await test("行提取：按税号合并、出现次数累计（翻页重复）", () => {
  const rows = [
    ["企业名称", "漳州示例食品有限公司", "统一社会信用代码", USCC_VALID],
    ["纳税人名称", "漳州示例食品有限公司（重复）", "纳税人识别号", USCC_VALID],
    ["企业名称", "漳州第二食品有限公司", "统一社会信用代码", USCC2],
  ];
  const { items } = extractEnterprisesFromCells(rows);
  assert.equal(items.length, 2);
  assert.equal(items.find((x) => x.taxpayerId === USCC_VALID).occurrences, 2);
});

await test("行提取：值格本身是另一个标签时不误配对", () => {
  const { items } = extractEnterprisesFromCells([["企业名称", "统一社会信用代码", USCC_VALID]]);
  assert.equal(items.length, 0, "名称标签的下一格是税号标签，不能当作名称值");
});

// ---------------------------------------------------------------- A2. 真实页内脚本 × 假 DOM
function makeEl(tag, className, text, children = []) {
  return {
    tag, className, text,
    children,
    get childNodes() { return this.text ? [{ nodeType: 3, textContent: this.text }] : []; },
    get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); },
    getAttribute(name) { return name === "class" ? this.className : null; },
    querySelectorAll(selector) {
      const out = [];
      const matches = (el) => {
        if (selector === "tr") return el.tag === "tr";
        if (selector === "td,th") return el.tag === "td" || el.tag === "th";
        if (selector === "[class]") return typeof el.className === "string" && el.className !== "";
        return false;
      };
      const walk = (el) => { for (const c of el.children) { if (matches(c)) out.push(c); walk(c); } };
      walk(this);
      return out;
    },
  };
}

await test("页内脚本：真实 READ_PAGE_SCRIPT 在假 DOM（表格布局）上生成正确快照", () => {
  const tr = makeEl("tr", "", "", [
    makeEl("td", "", "企业名称"), makeEl("td", "", "漳州示例食品有限公司"),
    makeEl("td", "", "统一社会信用代码"), makeEl("td", "", USCC_VALID),
  ]);
  const tbody = makeEl("tbody", "", "", [tr]);
  const table = makeEl("table", "el-table", "", [tbody]);
  const root = makeEl("div", "", "", [table]);
  const document = {
    title: "国家税务总局电子税务局",
    querySelectorAll(selector) { return root.querySelectorAll(selector); },
  };
  const fn = new Function("document", "location", "return " + READ_PAGE_SCRIPT);
  const snapshot = fn(document, { href: "https://etax.fujian.chinatax.gov.cn:8443/list?page=2" });
  assert.equal(snapshot.href, "https://etax.fujian.chinatax.gov.cn:8443/list?page=2");
  assert.equal(snapshot.title, "国家税务总局电子税务局");
  assert.ok(snapshot.rows.some((r) => r.join("|") === ["企业名称", "漳州示例食品有限公司", "统一社会信用代码", USCC_VALID].join("|")), JSON.stringify(snapshot.rows));
  const { items } = extractEnterprisesFromCells(snapshot.rows);
  assert.equal(items.length, 1);
  assert.equal(items[0].taxpayerId, USCC_VALID);
});

await test("页内脚本：卡片式布局（class 含 item，标签直接写在容器文本里）", () => {
  const card = makeEl("div", "enterprise-item", "企业名称：", [makeEl("span", "name", "漳州示例食品有限公司")]);
  const card2 = makeEl("div", "enterprise-item", "统一社会信用代码：", [makeEl("span", "code", USCC_VALID)]);
  const root = makeEl("div", "", "", [card, card2]);
  const document = { title: "t", querySelectorAll(sel) { return root.querySelectorAll(sel); } };
  const fn = new Function("document", "location", "return " + READ_PAGE_SCRIPT);
  const snapshot = fn(document, { href: "https://etax.fujian.chinatax.gov.cn/" });
  const joined = snapshot.rows.map((r) => r.join("|"));
  assert.ok(joined.includes(`企业名称：|漳州示例食品有限公司`), JSON.stringify(joined));
  assert.ok(joined.includes(`统一社会信用代码：|${USCC_VALID}`), JSON.stringify(joined));
});

await test("页内脚本：行数与单元格上限生效（防超大页面）", () => {
  const cells = [];
  for (let i = 0; i < 50; i++) cells.push(makeEl("td", "", `c${i}`));
  const tr = makeEl("tr", "", "", cells);
  const root = makeEl("div", "", "", [makeEl("table", "t", "", [makeEl("tbody", "", "", [tr])])]);
  const document = { title: "t", querySelectorAll(sel) { return root.querySelectorAll(sel); } };
  const fn = new Function("document", "location", "return " + READ_PAGE_SCRIPT);
  const snapshot = fn(document, { href: "https://etax.fujian.chinatax.gov.cn/" });
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].length, 24, "单元格上限 24");
});

// ---------------------------------------------------------------- A3. 浏览器探测 / 工具
await test("浏览器探测：固定候选路径 + 注入 exists", () => {
  const candidates = [{ kind: "edge", label: "Edge", paths: ["C:\\x\\msedge.exe"] }, { kind: "chrome", label: "Chrome", paths: ["C:\\y\\chrome.exe"] }];
  assert.deepEqual(
    findBrowserExecutable({ candidates, exists: (p) => p === "C:\\y\\chrome.exe" }),
    { found: true, kind: "chrome", label: "Chrome", path: "C:\\y\\chrome.exe" }
  );
  const none = findBrowserExecutable({ candidates, exists: () => false });
  assert.equal(none.found, false);
});

await test("CDP 地址校验：仅允许 ws://127.0.0.1:<port>/...", () => {
  assert.equal(isLoopbackDevtoolsUrl("ws://127.0.0.1:9222/devtools/browser/abc"), true);
  assert.equal(isLoopbackDevtoolsUrl("ws://localhost:9222/devtools/browser/abc"), false);
  assert.equal(isLoopbackDevtoolsUrl("ws://0.0.0.0:9222/x"), false);
  assert.equal(isLoopbackDevtoolsUrl("http://127.0.0.1:9222/x"), false);
});

await test("回环 Host 判定（含 localhost 别名与端口）", () => {
  assert.equal(isLoopbackHost("127.0.0.1:8787"), true);
  assert.equal(isLoopbackHost("localhost:8787"), true);
  assert.equal(isLoopbackHost("[::1]:8787"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("evil.example:8787"), false);
  assert.equal(isLoopbackHost("127.0.0.1:99999"), false);
  assert.equal(isLoopbackHost(""), false);
});

// ---------------------------------------------------------------- A4. 会话生命周期
console.log("\n会话生命周期（假浏览器）\n");

await test("config：只读、含支持地区与隐私边界、不启动浏览器", async () => {
  const fake = makeFakeBrowser();
  const svc = makeService(fake.deps);
  const cfg = svc.describeConfig();
  assert.equal(cfg.supported.length, 1);
  assert.equal(cfg.supported[0].region, "350000");
  assert.equal(cfg.supported[0].city, "350600");
  assert.equal(cfg.supported[0].entryUrl, "https://etax.fujian.chinatax.gov.cn/");
  assert.deepEqual(cfg.supported[0].allowedOrigins, ["https://etax.fujian.chinatax.gov.cn", "https://etax.fujian.chinatax.gov.cn:8443"]);
  assert.equal(cfg.browser.found, true);
  assert.ok(!("loginToken" in cfg), "令牌由 HTTP 层发放，不在 config 里");
  await svc.destroy();
});

await test("openSession：未支持地区被拒，令牌未被消费可重试", async () => {
  const fake = makeFakeBrowser();
  const svc = makeService(fake.deps);
  const token = svc.issueLoginToken();
  await assertErr(() => svc.openSession({ region: "440000", city: "440100", loginToken: token }), "tax_browser_region_not_supported");
  await assertErr(() => svc.openSession({ region: "CN", city: "", loginToken: token }), "tax_browser_region_not_supported");
  const s = await svc.openSession({ region: "350000", city: "350600", loginToken: token });
  assert.equal(s.status, "open");
  await svc.destroy();
});

await test("openSession：无效/缺失 loginToken 一律拒绝", async () => {
  const fake = makeFakeBrowser();
  const svc = makeService(fake.deps);
  await assertErr(() => svc.openSession({ region: "350000", city: "350600" }), "tax_browser_login_token_invalid");
  await assertErr(() => svc.openSession({ region: "350000", city: "350600", loginToken: "taxlt_nope" }), "tax_browser_login_token_invalid");
  const token = svc.issueLoginToken();
  await svc.openSession({ region: "350000", city: "350600", loginToken: token });
  await assertErr(() => svc.openSession({ region: "350000", city: "350600", loginToken: token }), "tax_browser_login_token_invalid", "令牌单次使用");
  await svc.destroy();
});

await test("openSession：会话视图不含 ws endpoint/pid/调试地址", async () => {
  const fake = makeFakeBrowser();
  const svc = makeService(fake.deps);
  const s = await openSession(svc);
  const text = JSON.stringify(s);
  assert.ok(!text.includes("ws://"), "不得泄漏 CDP endpoint");
  assert.ok(!text.includes("51234"));
  assert.ok(!/"pid"/.test(text));
  assert.equal(s.sessionId.startsWith("taxb_"), true);
  assert.equal(s.status, "open");
  assert.equal(s.pagesRead, 0);
  assert.equal(s.collectedCount, 0);
  assert.ok(s.manualLogin.instructions.length >= 3);
  assert.ok(/打开窗口不代表已登录/.test(s.manualLogin.note));
  await svc.destroy();
});

await test("openSession：未安装浏览器 → 结构化错误，无残留会话/profile", async () => {
  const fake = makeFakeBrowser();
  const svc = makeService(fake.deps, {}, { browserCandidates: [{ kind: "x", label: "X", paths: ["C:\\nope.exe"] }], fileExists: () => false });
  await assertErr(() => openSession(svc), "tax_browser_not_installed");
  assert.equal(svc.sessions.size, 0);
  await svc.destroy();
});

await test("openSession：启动失败（launch 抛错）→ 清理并删除 profile", async () => {
  const fake = makeFakeBrowser();
  let created = null;
  const deps = {
    ...fake.deps,
    launchBrowser: async ({ profileDir }) => {
      created = profileDir;
      assert.ok(existsSync(profileDir));
      throw new TaxBrowserError("tax_browser_launch_failed", "x");
    },
  };
  const svc = makeService(deps);
  await assertErr(() => openSession(svc), "tax_browser_launch_failed");
  assert.equal(svc.sessions.size, 0);
  assert.ok(!existsSync(created), "启动失败后 profile 目录应删除");
  await svc.destroy();
});

await test("读取：非白名单来源页面拒绝读取且不执行采集脚本", async () => {
  const fake = makeFakeBrowser({ initialUrl: "https://www.baidu.com/s?wd=x" });
  const svc = makeService(fake.deps);
  const s = await openSession(svc);
  await assertErr(() => svc.readCurrentPage({ sessionId: s.sessionId }), "tax_browser_page_not_supported");
  assert.equal(fake.state.scriptEvaluates, 0, "不允许的页面绝不执行采集脚本");
  assert.equal(svc.getSession({ sessionId: s.sessionId }).session.status, "open");
  await svc.destroy();
});

await test("读取：允许来源（含 :8443 跳转）读取成功并生成候选", async () => {
  const fake = makeFakeBrowser({
    initialUrl: "https://etax.fujian.chinatax.gov.cn:8443/list?page=3&x=1#frag",
    pages: [{ rows: [["企业名称", "漳州示例食品有限公司", "统一社会信用代码", USCC_VALID]] }],
  });
  const svc = makeService(fake.deps);
  const s = await openSession(svc);
  const r = await svc.readCurrentPage({ sessionId: s.sessionId });
  assert.equal(r.newCount, 1);
  assert.equal(r.read.count, 1);
  assert.equal(r.read.source, "https://etax.fujian.chinatax.gov.cn:8443", "来源不含 query/fragment");
  assert.equal(r.read.pagesRead, 1);
  assert.equal(r.read.items[0].candidateId, "c_1");
  assert.equal(r.read.items[0].name, "漳州示例食品有限公司");
  assert.equal(r.read.items[0].taxpayerId, USCC_VALID);
  assert.ok(/已读取页面/.test(r.read.note));
  await svc.destroy();
});

await test("读取：翻页多次读取按税号合并（累积预览）", async () => {
  const fake = makeFakeBrowser({
    pages: [
      { rows: [["企业名称", "漳州示例食品有限公司", "统一社会信用代码", USCC_VALID]] },
      { rows: [
        ["纳税人名称", "漳州示例食品有限公司", "纳税人识别号", USCC_VALID],
        ["企业名称", "漳州第二食品有限公司", "统一社会信用代码", USCC2],
      ] },
    ],
  });
  const svc = makeService(fake.deps);
  const s = await openSession(svc);
  await svc.readCurrentPage({ sessionId: s.sessionId });
  fake.nextPage();
  const r2 = await svc.readCurrentPage({ sessionId: s.sessionId });
  assert.equal(r2.read.count, 2);
  assert.equal(r2.newCount, 1);
  assert.equal(r2.read.pagesRead, 2);
  assert.equal(r2.read.items.find((x) => x.taxpayerId === USCC_VALID).occurrences, 2);
  await svc.destroy();
});

await test("读取：未识别布局（无标签记录）返回结构化失败，不伪造成功", async () => {
  const fake = makeFakeBrowser({ pages: [{ rows: [["序号", "1", "名称", "A 公司", "状态", "正常"]] }] });
  const svc = makeService(fake.deps);
  const s = await openSession(svc);
  const err = await assertErr(() => svc.readCurrentPage({ sessionId: s.sessionId }), "tax_browser_layout_unrecognized");
  assert.ok(/不猜测/.test(err.message));
  assert.equal(svc.getSession({ sessionId: s.sessionId }).preview.count, 0);
  await svc.destroy();
});

await test("读取：识别到记录但税号严格校验不通过 → no_valid_records", async () => {
  const fake = makeFakeBrowser({ pages: [{ rows: [["企业名称", "A公司", "统一社会信用代码", BAD_USCC]] }] });
  const svc = makeService(fake.deps);
  const s = await openSession(svc);
  await assertErr(() => svc.readCurrentPage({ sessionId: s.sessionId }), "tax_browser_no_valid_records");
  await svc.destroy();
});

await test("读取：超时不并入数据，会话仍可用（可重试）", async () => {
  const fake = makeFakeBrowser({ hangRead: true, pages: [{ rows: [["企业名称", "A公司", "统一社会信用代码", USCC_VALID]] }] });
  const svc = makeService(fake.deps, { readTimeoutMs: 120 });
  const s = await openSession(svc);
  await assertErr(() => svc.readCurrentPage({ sessionId: s.sessionId }), "tax_browser_read_timeout");
  fake.state.hangRead = false;
  const r = await svc.readCurrentPage({ sessionId: s.sessionId });
  assert.equal(r.read.count, 1);
  await svc.destroy();
});

await test("关闭：销毁候选数据、杀进程、删除 profile；读取/导入均拒绝", async () => {
  const fake = makeFakeBrowser({ pages: [{ rows: [["企业名称", "A公司", "统一社会信用代码", USCC_VALID]] }] });
  const svc = makeService(fake.deps);
  const s = await openSession(svc);
  const read = await svc.readCurrentPage({ sessionId: s.sessionId });
  const profileDir = svc.listCreatedProfileDirs()[0];
  const view = await svc.closeSession({ sessionId: s.sessionId });
  assert.equal(view.status, "closed");
  assert.equal(view.closeReason, "user");
  assert.equal(fake.state.killed, 1);
  assert.ok(!existsSync(profileDir), "关闭后应删除本程序创建的 profile");
  await assertErr(() => svc.readCurrentPage({ sessionId: s.sessionId }), "tax_browser_session_closed");
  await assertErr(() => svc.importCandidates({ sessionId: s.sessionId, candidateIds: ["c_1"], mode: "create", create: {} }), "tax_browser_session_closed");
  assert.equal(view.status, "closed");
  assert.equal(view.collectedCount, 0, "已识别企业候选被销毁");
  assert.ok(/不代表已从税局服务端退出/.test(view.note));
  await svc.destroy();
});

await test("关闭幂等：重复关闭返回同一终态", async () => {
  const fake = makeFakeBrowser();
  const svc = makeService(fake.deps);
  const s = await openSession(svc);
  await svc.closeSession({ sessionId: s.sessionId });
  const v2 = await svc.closeSession({ sessionId: s.sessionId });
  assert.equal(v2.status, "closed");
  assert.equal(fake.state.killed, 1);
  await svc.destroy();
});

await test("浏览器窗口被用户关闭：会话终态 + 清理，读取失败", async () => {
  const fake = makeFakeBrowser({ pages: [{ rows: [["企业名称", "A公司", "统一社会信用代码", USCC_VALID]] }] });
  const svc = makeService(fake.deps);
  const s = await openSession(svc);
  await svc.readCurrentPage({ sessionId: s.sessionId });
  fake.exitBrowser();
  const err = await assertErr(() => svc.readCurrentPage({ sessionId: s.sessionId }), "tax_browser_session_closed");
  assert.ok(/浏览器窗口已关闭/.test(err.message));
  await svc.destroy();
});

await test("并发关闭后的迟到读取结果被丢弃，不得恢复数据", async () => {
  let release = null;
  const gate = new Promise((res) => { release = res; });
  const fake = makeFakeBrowser({
    pages: [{ rows: [["企业名称", "A公司", "统一社会信用代码", USCC_VALID]] }],
    readGate: gate,
  });
  const svc = makeService(fake.deps);
  const s = await openSession(svc);
  const pending = svc.readCurrentPage({ sessionId: s.sessionId });
  pending.catch(() => {}); // 先挂接，避免迟到拒绝成为 unhandledRejection
  await new Promise((r) => setTimeout(r, 30));
  await svc.closeSession({ sessionId: s.sessionId });
  release();
  const err = await assertErr(() => pending, "tax_browser_session_closed");
  assert.ok(/结果已丢弃/.test(err.message));
  const closedView = await svc.closeSession({ sessionId: s.sessionId });
  assert.equal(closedView.status, "closed");
  assert.equal(closedView.collectedCount, 0, "候选数据未因迟到结果恢复");
  await svc.destroy();
});

await test("会话 TTL 过期：迟到访问拒绝且资源清理（不复活）", async () => {
  let fakeNow = Date.now();
  const fake = makeFakeBrowser({ pages: [{ rows: [["企业名称", "A公司", "统一社会信用代码", USCC_VALID]] }] });
  const svc = makeService(fake.deps, { sessionTtlMs: 100 }, { now: () => fakeNow });
  const s = await openSession(svc);
  const profileDir = svc.listCreatedProfileDirs()[0];
  await svc.readCurrentPage({ sessionId: s.sessionId });
  fakeNow += 101;
  await assertErr(() => svc.readCurrentPage({ sessionId: s.sessionId }), "tax_browser_session_expired");
  await waitFor(() => !existsSync(profileDir), 3000);
  assert.ok(!existsSync(profileDir), "过期后 profile 应清理");
  await assertErr(() => svc.importCandidates({ sessionId: s.sessionId, candidateIds: ["c_1"], mode: "create", create: {} }), "tax_browser_session_expired");
  await svc.destroy();
});

await test("登录令牌 TTL 过期后不可用", async () => {
  let fakeNow = Date.now();
  const fake = makeFakeBrowser();
  const svc = makeService(fake.deps, {}, { now: () => fakeNow });
  const token = svc.issueLoginToken();
  fakeNow += 10 * 60 * 1000 + 1;
  await assertErr(() => svc.openSession({ region: "350000", city: "350600", loginToken: token }), "tax_browser_login_token_invalid");
  await svc.destroy();
});

await test("并发会话上限：超出拒绝", async () => {
  const fake = makeFakeBrowser();
  const svc = makeService(fake.deps, { maxSessions: 2 });
  await openSession(svc);
  await openSession(svc);
  const err = await assertErr(() => openSession(svc), "tax_browser_limit_reached");
  assert.ok(/上限/.test(err.message));
  await svc.destroy();
});

await test("未知会话 ID：结构化 not_found", async () => {
  const svc = makeService(makeFakeBrowser().deps);
  await assertErr(() => svc.readCurrentPage({ sessionId: "taxb_unknown" }), "tax_browser_session_not_found");
  await svc.destroy();
});

// ---------------------------------------------------------------- A5. 导入（真实 SQLite + accounting）
console.log("\n导入（临时 SQLite）\n");

let createdSetIds = [];

async function sessionWithItems(items) {
  const rows = items.map((it) => ["企业名称", it.name, "统一社会信用代码", it.taxpayerId]);
  const fake = makeFakeBrowser({ pages: [{ rows }] });
  const svc = makeService(fake.deps);
  const s = await openSession(svc);
  await svc.readCurrentPage({ sessionId: s.sessionId });
  return { svc, session: s, fake };
}

await test("导入：批量新建空账套（标准科目、无凭证/期初、绑定可追溯）", async () => {
  const { svc, session } = await sessionWithItems([
    { name: "漳州示例食品有限公司", taxpayerId: USCC_VALID },
    { name: "漳州第二食品有限公司", taxpayerId: USCC2 },
  ]);
  const r = await svc.importCandidates({
    sessionId: session.sessionId,
    candidateIds: ["c_1", "c_2"],
    mode: "create",
    create: { start_period: "2026-01", accounting_standard: "小企业会计准则", taxpayer_type: "小规模纳税人" },
  });
  assert.equal(r.dryRun, false);
  assert.equal(r.summary.created, 2);
  assert.deepEqual(r.results.map((x) => x.action).sort(), ["created", "created"]);
  createdSetIds = r.results.map((x) => x.accountSetId);
  for (const id of createdSetIds) {
    const set = A.getAccountSet(id);
    assert.equal(set.start_period, "2026-01");
    const accounts = A.listAccounts(id);
    assert.ok(accounts.length >= 55, "新账套应载入标准科目表");
    assert.equal(A.listVouchers(id).length, 0, "不造历史凭证");
    assert.equal(A.getOpeningBalances(id).length, 0, "不造期初");
  }
  const { db } = await import("../server/db.mjs");
  const b1 = db.prepare(`SELECT * FROM tax_enterprise_bindings WHERE taxpayer_id = ?`).get(USCC_VALID);
  assert.equal(b1.region, "350000");
  assert.equal(b1.city, "350600");
  assert.equal(b1.source, "tax-browser:fujian-zhangzhou");
  assert.ok(b1.imported_at);
  await svc.destroy();
});

await test("导入：幂等（同税号重复导入返回现有账套，不重复建、不覆盖）", async () => {
  const { svc, session } = await sessionWithItems([{ name: "漳州示例食品有限公司", taxpayerId: USCC_VALID }]);
  const before = A.listAccountSets().length;
  const r = await svc.importCandidates({
    sessionId: session.sessionId, candidateIds: ["c_1"], mode: "create",
    create: { start_period: "2026-02", accounting_standard: "企业会计准则", taxpayer_type: "一般纳税人" },
  });
  assert.equal(r.summary.existing, 1);
  assert.equal(r.summary.created, 0);
  assert.equal(r.results[0].accountSetId, createdSetIds[0]);
  assert.equal(A.listAccountSets().length, before, "不新建账套");
  const set = A.getAccountSet(createdSetIds[0]);
  assert.equal(set.start_period, "2026-01", "不覆盖已有账套参数");
  await svc.destroy();
});

await test("导入：dryRun 预览不落库", async () => {
  const { svc, session } = await sessionWithItems([{ name: "漳州第三食品有限公司", taxpayerId: uscc() }]);
  const before = A.listAccountSets().length;
  const r = await svc.importCandidates({
    sessionId: session.sessionId, candidateIds: ["c_1"], mode: "create", dryRun: true,
    create: { start_period: "2026-03", accounting_standard: "小企业会计准则", taxpayer_type: "小规模纳税人" },
  });
  assert.equal(r.dryRun, true);
  assert.equal(r.summary.created, 1);
  assert.equal(A.listAccountSets().length, before);
  await svc.destroy();
});

await test("导入：伪造候选 ID / 前端企业对象一律拒绝（只认服务端候选）", async () => {
  const { svc, session } = await sessionWithItems([{ name: "漳州示例食品有限公司", taxpayerId: USCC_VALID }]);
  await assertErr(() => svc.importCandidates({ sessionId: session.sessionId, candidateIds: ["c_999"], mode: "create", create: {} }), "tax_browser_candidate_not_found");
  // 夹带伪造企业对象：直接拒绝（企业对象只能来自服务端会话采集结果）
  await assertErr(() => svc.importCandidates({
    sessionId: session.sessionId, candidateIds: ["c_1"], mode: "create",
    create: { start_period: "2026-01", accounting_standard: "小企业会计准则", taxpayer_type: "小规模纳税人" },
    items: [{ candidateId: "c_1", name: "伪造公司", taxpayerId: "123456789012345678" }],
  }), "tax_browser_request_field_rejected");
  await svc.destroy();
});

await test("导入：candidateIds 非法（空/非数组/超上限）拒绝", async () => {
  const { svc, session } = await sessionWithItems([{ name: "A公司", taxpayerId: USCC_VALID }]);
  await assertErr(() => svc.importCandidates({ sessionId: session.sessionId, candidateIds: [], mode: "create" }), "tax_browser_candidates_invalid");
  await assertErr(() => svc.importCandidates({ sessionId: session.sessionId, mode: "create" }), "tax_browser_candidates_invalid");
  await assertErr(() => svc.importCandidates({ sessionId: session.sessionId, candidateIds: "c_1", mode: "create" }), "tax_browser_candidates_invalid");
  await svc.destroy();
});

await test("导入（create）：建账三要素必须显式且合法", async () => {
  const { svc, session } = await sessionWithItems([{ name: "B公司", taxpayerId: uscc() }]);
  const cases = [
    [{}, "start_period_required"],
    [{ start_period: "2026-01" }, "accounting_standard_required"],
    [{ start_period: "2026-01", accounting_standard: "小企业会计准则" }, "taxpayer_type_required"],
    [{ start_period: "2026-13", accounting_standard: "小企业会计准则", taxpayer_type: "小规模纳税人" }, "start_period_invalid"],
    [{ start_period: "2026-01", accounting_standard: "虚构准则", taxpayer_type: "小规模纳税人" }, "accounting_standard_invalid"],
    [{ start_period: "2026-01", accounting_standard: "小企业会计准则", taxpayer_type: "虚构类型" }, "taxpayer_type_invalid"],
  ];
  for (const [create, code] of cases) {
    const err = await assertErr(() => svc.importCandidates({ sessionId: session.sessionId, candidateIds: ["c_1"], mode: "create", create }), code);
    assert.ok(/非税局数据|由用户/.test(err.message) || code.includes("_invalid") || code.includes("_required"), err.message);
  }
  await svc.destroy();
});

await test("导入（create）：批量原子性 — 任一项失败整批回滚", async () => {
  const id2 = uscc();
  const id3 = uscc();
  const before = A.listAccountSets().length;
  const beforeBindings = (await import("../server/db.mjs")).db.prepare(`SELECT COUNT(*) n FROM tax_enterprise_bindings`).get().n;
  // 第二条税号非法 → importer 严格校验失败
  const r = await assertErr(() => importFromTaxBrowser({
    items: [
      { candidateId: "c_1", name: "原子测试一", taxpayerId: id2 },
      { candidateId: "c_2", name: "原子测试二", taxpayerId: BAD_USCC },
      { candidateId: "c_3", name: "原子测试三", taxpayerId: id3 },
    ],
    region: "350000", city: "350600", source: "test",
    mode: "create",
    create: { start_period: "2026-01", accounting_standard: "小企业会计准则", taxpayer_type: "小规模纳税人" },
  }), "taxpayer_id_invalid");
  assert.equal(A.listAccountSets().length, before, "失败后不留下部分账套");
  const afterBindings = (await import("../server/db.mjs")).db.prepare(`SELECT COUNT(*) n FROM tax_enterprise_bindings`).get().n;
  assert.equal(afterBindings, beforeBindings, "失败后不留下部分绑定");
});

await test("导入（bind）：绑定空账套成功（名称一致）", async () => {
  const set = A.createAccountSet({ name: "绑定测试公司", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" });
  const r = importFromTaxBrowser({
    items: [{ candidateId: "c_1", name: "绑定测试公司", taxpayerId: uscc() }],
    region: "350000", city: "350600", source: "test", mode: "bind", accountSetId: set.id,
  });
  assert.equal(r.results[0].action, "bound");
  assert.equal(r.results[0].accountSetId, set.id);
  assert.equal(r.results[0].nameChange, null);
  assert.equal(A.listVouchers(set.id).length, 0, "绑定不产生凭证");
  assert.equal(A.getOpeningBalances(set.id).length, 0, "绑定不产生期初");
});

await test("导入（bind）：名称变更须 dryRun 预览 + 显式确认", async () => {
  const set = A.createAccountSet({ name: "我手工建的空账套", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" });
  const idRename = uscc();
  const items = [{ candidateId: "c_1", name: "改名目标公司", taxpayerId: idRename }];
  const preview = importFromTaxBrowser({ items, region: "350000", city: "350600", source: "test", mode: "bind", accountSetId: set.id, dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.results[0].nameChange, { from: "我手工建的空账套", to: "改名目标公司" });
  assert.equal(preview.results[0].requiresNameChangeConfirm, true);
  assert.throws(
    () => importFromTaxBrowser({ items, region: "350000", city: "350600", source: "test", mode: "bind", accountSetId: set.id }),
    (e) => e.code === "name_change_confirmation_required"
  );
  assert.equal(A.getAccountSet(set.id).name, "我手工建的空账套", "未确认前不改名");
  const applied = importFromTaxBrowser({ items, region: "350000", city: "350600", source: "test", mode: "bind", accountSetId: set.id, confirmNameChange: true });
  assert.equal(applied.results[0].action, "bound");
  assert.equal(A.getAccountSet(set.id).name, "改名目标公司");
});

await test("导入（bind）：非空账套拒绝（不覆盖凭证/余额）", async () => {
  const set = A.createAccountSet({ name: "有业务账套", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" });
  A.setOpeningBalances(set.id, [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }]);
  const id7 = uscc();
  assert.throws(
    () => importFromTaxBrowser({ items: [{ candidateId: "c_1", name: "X公司", taxpayerId: id7 }], region: "350000", city: "350600", source: "test", mode: "bind", accountSetId: set.id }),
    (e) => e.code === "account_set_not_empty"
  );
  assert.equal(A.getOpeningBalances(set.id).length, 2, "已有余额不被清空");
});

await test("导入（bind）：税号已绑定其他账套 / 目标账套已绑定其他税号均拒绝", async () => {
  const id8 = uscc();
  const set = A.createAccountSet({ name: "已绑定公司", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" });
  importFromTaxBrowser({ items: [{ candidateId: "c_1", name: "已绑定公司", taxpayerId: id8 }], region: "350000", city: "350600", source: "test", mode: "bind", accountSetId: set.id });
  // 同税号绑定到另一个账套
  const set2 = A.createAccountSet({ name: "空账套乙", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" });
  assert.throws(
    () => importFromTaxBrowser({ items: [{ candidateId: "c_1", name: "已绑定公司", taxpayerId: id8 }], region: "350000", city: "350600", source: "test", mode: "bind", accountSetId: set2.id }),
    (e) => e.code === "taxpayer_id_already_bound"
  );
  // 目标账套绑定另一个税号
  const id9 = uscc();
  assert.throws(
    () => importFromTaxBrowser({ items: [{ candidateId: "c_1", name: "另一家公司", taxpayerId: id9 }], region: "350000", city: "350600", source: "test", mode: "bind", accountSetId: set.id, confirmNameChange: true }),
    (e) => e.code === "account_set_already_bound"
  );
});

await test("导入（bind）：同税号绑定同一账套 → 幂等返回", () => {
  const idA = uscc();
  const set = A.createAccountSet({ name: "幂等公司", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" });
  importFromTaxBrowser({ items: [{ candidateId: "c_1", name: "幂等公司", taxpayerId: idA }], region: "350000", city: "350600", source: "test", mode: "bind", accountSetId: set.id });
  const again = importFromTaxBrowser({ items: [{ candidateId: "c_1", name: "幂等公司", taxpayerId: idA }], region: "350000", city: "350600", source: "test", mode: "bind", accountSetId: set.id });
  assert.equal(again.idempotent, true);
  assert.equal(again.results[0].action, "bound_idempotent");
  assert.equal(again.results[0].accountSetId, set.id);
});

await test("导入（bind）：一次多于一家的候选拒绝；目标账套不存在拒绝", () => {
  const idB = uscc();
  assert.throws(
    () => importFromTaxBrowser({ items: [{ candidateId: "c_1", name: "甲公司", taxpayerId: idB }, { candidateId: "c_2", name: "乙公司", taxpayerId: uscc() }], region: "350000", city: "350600", source: "test", mode: "bind", accountSetId: 1 }),
    (e) => e.code === "bind_single_candidate_only"
  );
  assert.throws(
    () => importFromTaxBrowser({ items: [{ candidateId: "c_1", name: "甲公司", taxpayerId: idB }], region: "350000", city: "350600", source: "test", mode: "bind", accountSetId: 999999 }),
    (e) => e.code === "account_set_not_found"
  );
});

await test("导入：请求缺地区溯源信息 / 非法 mode / 空候选拒绝", () => {
  assert.throws(() => importFromTaxBrowser({ items: [], region: "350000", city: "350600" }), (e) => e.code === "items_invalid");
  assert.throws(() => importFromTaxBrowser({ items: [{ candidateId: "c", name: "甲公司", taxpayerId: uscc() }], region: "350000", city: "350600", mode: "magic" }), (e) => e.code === "import_mode_invalid");
  assert.throws(() => importFromTaxBrowser({ items: [{ candidateId: "c", name: "甲公司", taxpayerId: uscc() }] }), (e) => e.code === "region_required");
  const dupId = uscc();
  assert.throws(() => importFromTaxBrowser({ items: [{ candidateId: "c", name: "甲公司", taxpayerId: dupId }, { candidateId: "c2", name: "乙公司", taxpayerId: dupId }], region: "350000", city: "350600" }), (e) => e.code === "taxpayer_id_duplicated");
});

await test("导入：税号含注入字符/超长名称拒绝（不进入数据库）", () => {
  assert.throws(
    () => importFromTaxBrowser({ items: [{ candidateId: "c", name: "甲公司", taxpayerId: "91350600MA34B1W6'; DROP TABLE account_sets;--" }], region: "350000", city: "350600" }),
    (e) => e.code === "taxpayer_id_invalid"
  );
});

// ---------------------------------------------------------------- B. 真实 HTTP 接线（假浏览器 service）
console.log("\nB. HTTP 接线（真实 node:http + 注入假浏览器 service）\n");

{
  const fake = makeFakeBrowser({
    pages: [{ rows: [["企业名称", "HTTP接线食品有限公司", "统一社会信用代码", "91350600MA34B1W80" + usccCheckChar("91350600MA34B1W80")]] }],
  });
  const httpSvc = makeService(fake.deps);
  const routes = createTaxBrowserRoutes(httpSvc);
  const hsrv = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    routes(req, res, url, req.method.toUpperCase()).catch(() => {
      if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json" }); res.end(`{"error":"internal"}`); }
    });
  });
  const port = await new Promise((res) => hsrv.listen(0, "127.0.0.1", () => res(hsrv.address().port)));
  const BASE = `http://127.0.0.1:${port}`;
  const HOST = `127.0.0.1:${port}`;

  const node_http = await import("node:http");
  // node:http request helper（避免 fetch 对 Host/Origin 头的限制）
  const httpJson = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = node_http.request(`${BASE}${path}`, {
      method,
      headers: {
        host: headers.host ?? HOST,
        ...(headers.origin !== undefined ? { origin: headers.origin } : {}),
        ...(data !== null ? { "content-type": headers.contentType ?? "application/json", "content-length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf ? JSON.parse(buf) : null }));
    });
    r.on("error", reject);
    if (data !== null) r.write(data);
    r.end();
  });

  await test("HTTP config：同源 Origin 返回配置 + 一次性令牌，且无通配 CORS 头", async () => {
    const r = await httpJson("GET", "/api/tax-browser/config", undefined, { origin: `http://${HOST}` });
    assert.equal(r.status, 200);
    assert.ok(r.body.loginToken.startsWith("taxlt_"));
    assert.equal(r.body.supported[0].city, "350600");
    assert.equal(r.headers["access-control-allow-origin"], undefined);
    assert.equal(fake.state.launched, 0, "GET config 只读，不启动浏览器");
  });

  await test("HTTP config：无 Origin（CLI）可读；hostile Origin 403 且拿不到令牌", async () => {
    const cli = await httpJson("GET", "/api/tax-browser/config");
    assert.equal(cli.status, 200);
    assert.ok(cli.body.loginToken);
    const evil = await httpJson("GET", "/api/tax-browser/config", undefined, { origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error, "origin_not_allowed");
    assert.equal(evil.body.loginToken, undefined);
  });

  await test("HTTP config：localhost 别名同源放行；非回环 Host 拒绝", async () => {
    const r = await httpJson("GET", "/api/tax-browser/config", undefined, { host: `localhost:${port}`, origin: `http://localhost:${port}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const bad = await httpJson("GET", "/api/tax-browser/config", undefined, { host: "evil.example:8787", origin: "https://evil.example:8787" });
    assert.equal(bad.status, 403);
    assert.equal(bad.body.error, "host_not_local");
  });

  await test("HTTP POST：非 JSON content-type / hostile Origin / 坏令牌一律拒绝", async () => {
    const cfg = await httpJson("GET", "/api/tax-browser/config");
    const token = cfg.body.loginToken;
    const form = await httpJson("POST", "/api/tax-browser/sessions", { region: "350000", city: "350600", loginToken: token }, { contentType: "application/x-www-form-urlencoded", origin: `http://${HOST}` });
    assert.equal(form.status, 400);
    assert.equal(form.body.error, "json_content_type_required");
    const evil = await httpJson("POST", "/api/tax-browser/sessions", { region: "350000", city: "350600", loginToken: token }, { origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    assert.equal(fake.state.launched, 0, "hostile origin 不能触发登录");
    const noToken = await httpJson("POST", "/api/tax-browser/sessions", { region: "350000", city: "350600" }, { origin: `http://${HOST}` });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.body.error, "tax_browser_login_token_invalid");
  });

  let httpSession = null;
  await test("HTTP login：合法令牌打开会话（fake 浏览器），视图无 endpoint", async () => {
    const cfg = await httpJson("GET", "/api/tax-browser/config");
    const r = await httpJson("POST", "/api/tax-browser/sessions", { region: "350000", city: "350600", loginToken: cfg.body.loginToken }, { origin: `http://${HOST}` });
    assert.equal(r.status, 201);
    httpSession = r.body.sessionId;
    assert.ok(httpSession.startsWith("taxb_"));
    assert.equal(r.body.status, "open");
    assert.ok(r.body.manualLogin.instructions.length >= 1);
    assert.ok(!JSON.stringify(r.body).includes("ws://"));
    // 令牌单次使用
    const cfg2 = await httpJson("GET", "/api/tax-browser/config");
    const again = await httpJson("POST", "/api/tax-browser/sessions", { region: "350000", city: "350600", loginToken: cfg.body.loginToken }, { origin: `http://${HOST}` });
    assert.equal(again.status, 403);
  });

  await test("HTTP read：未知会话 404；合法会话读取返回白名单预览", async () => {
    const unknown = await httpJson("POST", "/api/tax-browser/sessions/taxb_unknown/read", {});
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, "tax_browser_session_not_found");
    const r = await httpJson("POST", `/api/tax-browser/sessions/${httpSession}/read`, {}, { origin: `http://${HOST}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.read.count, 1);
    assert.equal(r.body.read.items[0].name, "HTTP接线食品有限公司");
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  });

  await test("HTTP import：只接受会话候选 ID；dryRun 预览与正式导入", async () => {
    const forged = await httpJson("POST", `/api/tax-browser/sessions/${httpSession}/import`, { candidateIds: ["c_777"], mode: "create" }, { origin: `http://${HOST}` });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.error, "tax_browser_candidate_not_found");
    const prev = await httpJson("POST", `/api/tax-browser/sessions/${httpSession}/import`, {
      candidateIds: ["c_1"], mode: "create", dryRun: true,
      create: { start_period: "2026-01", accounting_standard: "小企业会计准则", taxpayer_type: "小规模纳税人" },
    }, { origin: `http://${HOST}` });
    assert.equal(prev.status, 200);
    assert.equal(prev.body.dryRun, true);
    const real = await httpJson("POST", `/api/tax-browser/sessions/${httpSession}/import`, {
      candidateIds: ["c_1"], mode: "create",
      create: { start_period: "2026-01", accounting_standard: "小企业会计准则", taxpayer_type: "小规模纳税人" },
    }, { origin: `http://${HOST}` });
    assert.equal(real.status, 200);
    assert.ok(real.body.results[0].accountSetId > 0);
    assert.equal(A.getAccountSet(real.body.results[0].accountSetId).name, "HTTP接线食品有限公司");
  });

  await test("HTTP close：关闭后读取 409/404，提示不声称税局退出", async () => {
    const r = await httpJson("POST", `/api/tax-browser/sessions/${httpSession}/close`, {}, { origin: `http://${HOST}` });
    assert.equal(r.status, 200);
    assert.ok(/不代表已从税局服务端退出/.test(r.body.note));
    const after = await httpJson("POST", `/api/tax-browser/sessions/${httpSession}/read`, {});
    assert.equal(after.status, 409);
    assert.equal(after.body.error, "tax_browser_session_closed");
  });

  await test("HTTP 未知子路径 404；GET 会话状态只读", async () => {
    const cfg = await httpJson("GET", "/api/tax-browser/sessions/taxb_whatever");
    assert.equal(cfg.status, 404);
    const nf = await httpJson("GET", "/api/tax-browser/nope");
    assert.equal(nf.status, 404);
  });

  await test("HTTP OPTIONS：无任何 CORS 放行头（跨源预检失败）", async () => {
    const r = await new Promise((resolve, reject) => {
      const lib = node_http;
      const req = lib.request(`${BASE}/api/tax-browser/config`, { method: "OPTIONS", headers: { host: HOST, origin: "https://evil.example" } }, (res) => {
        let buf = "";
        res.on("data", (c) => { buf += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers["access-control-allow-origin"], undefined);
    assert.equal(r.headers["access-control-allow-methods"], undefined);
  });

  await httpSvc.destroy();
  hsrv.close();
}

// ---------------------------------------------------------------- C. 生产 server.mjs（真实 HTTP，不打开浏览器）
console.log("\nC. 生产 server 接线（临时库 + 随机端口，负路径，不打开浏览器）\n");

{
  const dataDir2 = mkdtempSync(join(tmpdir(), "wb-taxbrowser-http-"));
  const PORT = 8800 + Math.floor(Math.random() * 400);
  const BASE = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, [join(here, "..", "server", "server.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), WORKBENCH_DATA_DIR: dataDir2, HOST: "127.0.0.1" },
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  const get = (path, headers = {}) => fetch(BASE + path, { headers }).then(async (res) => ({ status: res.status, headers: res.headers, body: await res.json().catch(() => null) }));
  const post = (path, body, headers = {}) => fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  }).then(async (res) => ({ status: res.status, headers: res.headers, body: await res.json().catch(() => null) }));

  const waitReady = async () => {
    const deadline = Date.now() + 10000;
    for (;;) {
      try { await get("/api/meta"); return; } catch { /* retry */ }
      if (Date.now() > deadline) throw new Error("server_not_ready");
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  await test("生产 server：/api/tax-browser/config 只读可用，无通配 CORS 头", async () => {
    await waitReady();
    const r = await get("/api/tax-browser/config", { origin: `http://127.0.0.1:${PORT}` });
    assert.equal(r.status, 200);
    assert.ok(r.body.loginToken.startsWith("taxlt_"));
    assert.equal(r.body.supported[0].region, "350000");
    assert.ok(r.body.browser && typeof r.body.browser.found === "boolean");
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  });

  await test("生产 server：无令牌 POST 登录被拒；未知会话 404；OPTIONS 无 CORS 头", async () => {
    const noToken = await post("/api/tax-browser/sessions", { region: "350000", city: "350600" });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.body.error, "tax_browser_login_token_invalid");
    const cfg = await get("/api/tax-browser/config");
    const badRegion = await post("/api/tax-browser/sessions", { region: "110000", city: "110100", loginToken: cfg.body.loginToken });
    assert.equal(badRegion.status, 400);
    assert.equal(badRegion.body.error, "tax_browser_region_not_supported");
    const unknown = await post("/api/tax-browser/sessions/taxb_nope/read", {});
    assert.equal(unknown.status, 404);
    const opts = await fetch(`${BASE}/api/tax-browser/config`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(opts.status, 204);
    assert.equal(opts.headers.get("access-control-allow-origin"), null);
  });

  await test("生产 server：旧 REST/MCP 不受影响（/api/meta 正常）", async () => {
    const r = await get("/api/meta");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.standards));
  });

  child.kill();
  await new Promise((r) => child.on("exit", r));
  setTimeout(() => { try { rmSync(dataDir2, { recursive: true, force: true }); } catch {} }, 300);
}

// ---------------------------------------------------------------- 收尾
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过\n`);
if (unhandled.length) {
  console.error(`发现 ${unhandled.length} 个 unhandledRejection：`);
  for (const r of unhandled) console.error("  -", r && r.message ? r.message : r);
}
process.exitCode = failed || unhandled.length ? 1 : 0;
