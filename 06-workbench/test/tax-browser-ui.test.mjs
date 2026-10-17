#!/usr/bin/env node
/**
 * tax-browser-ui.test.mjs — 前端 UI 行为回归（rc-a0 第2c步）
 *
 * 本套件用 node:vm + 合成 DOM 在进程内真实执行 public/app.js 的既有函数
 * （newSetDialog / taxBrowserDialog / tbOpenSession / tbRead / tbClose / tbApi …），
 * 不用静态字符串断言伪装功能测试，也不启动真实浏览器、不访问税局、不使用任何凭据。
 *
 * 覆盖：
 *  1. 新建账套内部 create 用正常返回/抛错的 async 函数，最外层 handler 处理错误；
 *     普通创建、创建后税局导入两条成功路径；失败不继续 loadSets、不弹税局 dialog、不重复创建。
 *  2. 税局全局单一 dialog + 串行 busy：重复打开复用同一窗口、不覆盖 sessionId；
 *     已开会话不能重复 open；关闭按钮 / Esc 结束本地会话、清空 preview/勾选、移除 dialog；
 *     启动中取消后迟到的会话立即关闭；关闭后不因按钮状态恢复更新旧 dialog。
 *  3. tbApi 保留结构化 error.code；终态 404/409closed/410 清空本地会话与预览；
 *     普通暂时错误保留可重试的 sessionId。
 *  4. 文案明确「福建漳州试用，登录与企业读取尚未实测」与建账边界，并保留报表下载按钮接线。
 *
 * 运行：node test/tax-browser-ui.test.mjs（在 06-workbench 目录）
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, "..", "public", "app.js"), "utf8");

// 同脚本末尾导出内部绑定，供测试真实调用（const 绑定在脚本词法域内可见）。
const EPILOGUE = `
;globalThis.__APP__ = {
  newSetDialog, taxBrowserDialog, tbApi, tbClose, tbOpenSession, tbRead, tbImport, tbRenderPreview,
  loadMeta, loadSets, api, toast, downloadReport, runReport,
  snap: () => ({ SET_ID, SETS, SET, TB, META, ACCOUNTS }),
};
`;

// ---------------------------------------------------------------- 合成 DOM / 响应
class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  _sync() { this.el._className = [...this.set].join(" "); }
  add(...c) { for (const x of c) this.set.add(x); this._sync(); }
  remove(...c) { for (const x of c) this.set.delete(x); this._sync(); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) { const on = force === undefined ? !this.set.has(c) : !!force; if (on) this.set.add(c); else this.set.delete(c); this._sync(); return on; }
}

class El {
  constructor(doc, tag = "div") {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
    this._listeners = new Map();
    this._q = new Map(); // 同一根下同一选择器返回稳定元素，便于读取/触发已绑定的 handler
    this._connected = this.tagName !== "DIALOG";
    this.open = false;
    this.disabled = false;
    this.value = "";
    this.checked = false;
    this.textContent = "";
    this.files = [];
    this.classList = new ClassList(this);
    this._className = "";
    this._html = "";
  }
  get className() { return this._className; }
  set className(v) { this._className = String(v); this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get isConnected() { return this._connected; }
  set innerHTML(v) { this._html = String(v); this._q.clear(); }
  get innerHTML() { return this._html; }
  appendChild(c) { c.parentNode = this; c._connected = true; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c._connected = false; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); this._connected = false; if (this.tagName === "DIALOG") this.open = false; }
  insertAdjacentHTML(_pos, html) { this._html += html; }
  querySelector(sel) {
    if (!this._q.has(sel)) {
      const el = new El(this.ownerDocument, "div");
      el.parentNode = this;
      el._connected = true;
      this._q.set(sel, el);
    }
    return this._q.get(sel);
  }
  querySelectorAll() { return []; }
  addEventListener(type, fn) { if (!this._listeners.has(type)) this._listeners.set(type, []); this._listeners.get(type).push(fn); }
  removeEventListener() {}
  dispatchEvent(ev) { for (const fn of (this._listeners.get(ev.type) || [])) fn(ev); return true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent({ type: "close" }); }
  closest(sel) {
    let n = this;
    while (n) {
      if (sel === "dialog" && n.tagName === "DIALOG") return n;
      if (sel.startsWith("#") && n.id === sel.slice(1)) return n;
      n = n.parentNode;
    }
    return null;
  }
  click() { if (typeof this.onclick === "function") return this.onclick({ target: this }); }
}

function makeDocument() {
  const doc = {
    _q: new Map(),
    body: null,
    createElement: (tag) => new El(doc, tag),
    querySelector(sel) { if (!doc._q.has(sel)) doc._q.set(sel, new El(doc, "div")); return doc._q.get(sel); },
    querySelectorAll: () => [],
  };
  doc.body = new El(doc, "body");
  return doc;
}

const res = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
  headers: { get: () => null },
  blob: async () => ({}),
});

const tick = (n = 1) => new Promise((resolve) => {
  let i = 0;
  const step = () => { if (++i >= n) return resolve(); setImmediate(step); };
  setImmediate(step);
});
const waitFor = async (fn, ms = 1000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await tick(1); }
  return fn();
};

function defaultHandler(path) {
  if (path === "/api/meta") return res(200, { coa: [], standards: ["小企业会计准则"] });
  if (path === "/api/account-sets") return res(200, []);
  if (/^\/api\/account-sets\/\d+$/.test(path)) return res(200, { id: Number(path.split("/").pop()), name: "账套", start_period: "2026-01", accounting_standard: "小企业会计准则" });
  return res(200, []);
}

async function newApp(handler) {
  const doc = makeDocument();
  const calls = [];
  const confirms = [];
  let current = handler || defaultHandler;
  const sandbox = {
    document: doc,
    console,
    confirm: (msg) => { confirms.push(String(msg)); return true; },
    alert: () => {},
    URLSearchParams,
    URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
    setTimeout: (fn, ms, ...a) => { const h = setTimeout(fn, ms, ...a); h.unref?.(); return h; },
    clearTimeout,
    fetch: (path, opts = {}) => {
      calls.push({ path, method: opts.method || "GET", opts });
      return Promise.resolve().then(() => current(path, opts));
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(appSource + EPILOGUE, context, { filename: "public/app.js" });
  await tick(6); // 等 boot() 完成
  return { ctx: context, app: context.__APP__, doc, calls, confirms, setHandler: (h) => { current = h; } };
}

const dialogs = (doc) => doc.body.children.filter((c) => c.tagName === "DIALOG");

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.message}`); }
};

// 成功的账套创建/载入 handler。
const setsHandler = (path, opts) => {
  if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
  if (path === "/api/account-sets" && opts.method === "POST") return res(201, { id: 7, name: "新公司" });
  if (path === "/api/account-sets") return res(200, [{ id: 7, name: "新公司", taxpayer_type: "小规模纳税人" }]);
  if (path === "/api/account-sets/7") return res(200, { id: 7, name: "新公司", start_period: "2026-01", accounting_standard: "小企业会计准则" });
  return res(200, []);
};
const countCreate = (calls) => calls.filter((c) => c.method === "POST" && c.path === "/api/account-sets").length;
const countListSets = (calls) => calls.filter((c) => c.method === "GET" && c.path === "/api/account-sets").length;

console.log("\nUI. public/app.js 行为（vm 合成 DOM，真实执行）\n");

// ---------------------------------------------------------------- 1. 新建账套
await test("新建账套：普通创建成功，仅 1 次 POST 并载入账套", async () => {
  const a = await newApp(setsHandler);
  a.app.newSetDialog();
  const d = dialogs(a.doc).at(-1);
  assert.ok(d, "应打开新建账套 dialog");
  d.querySelector("#nsName").value = "新公司";
  d.querySelector("#nsOk").click();
  await tick(8);

  assert.equal(countCreate(a.calls), 1, "成功路径应恰好创建一次");
  assert.equal(a.app.snap().SET_ID, 7, "应载入新账套");
  assert.equal(a.app.snap().SETS.length, 1);
  assert.equal(d.isConnected, false, "创建成功后新建面板应关闭移除");
  assert.equal(a.app.snap().TB.dialog, null, "普通创建不应弹税局对话框");
  const toast = a.doc.querySelector("#toast");
  assert.match(toast.textContent, /账套已创建/);
  assert.ok(!toast.classList.contains("err"), "成功不应报错");
});

await test("新建账套：创建后从税局导入，创建成功且打开税局 dialog（bindSetId）", async () => {
  const a = await newApp(setsHandler);
  a.app.newSetDialog();
  const ns = dialogs(a.doc).at(-1);
  ns.querySelector("#nsName").value = "新公司";
  ns.querySelector("#nsTaxBrowser").click();
  await tick(8);

  assert.equal(countCreate(a.calls), 1, "创建后导入应恰好创建一次");
  assert.equal(a.app.snap().SET_ID, 7);
  const tb = a.app.snap().TB;
  assert.ok(tb.dialog, "应打开税局导入 dialog");
  assert.equal(dialogs(a.doc).length, 1, "新建面板应已让位给税局 dialog，不得叠加");
  assert.equal(ns.isConnected, false);
  assert.match(tb.dialog.innerHTML, /福建漳州试用/);
});

await test("新建账套：创建失败不继续 loadSets、不弹税局 dialog、不重复创建", async () => {
  const failHandler = (path, opts) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path === "/api/account-sets" && opts.method === "POST") return res(500, { error: "创建失败" });
    return res(200, []);
  };
  const a = await newApp(failHandler);
  a.app.newSetDialog();
  const d = dialogs(a.doc).at(-1);
  const listBefore = countListSets(a.calls);
  d.querySelector("#nsName").value = "新公司";
  d.querySelector("#nsOk").click();
  await tick(8);

  assert.equal(countCreate(a.calls), 1, "一次点击只创建一次");
  assert.equal(countListSets(a.calls), listBefore, "失败不得继续 loadSets");
  assert.equal(a.app.snap().SET_ID, null, "失败不得切换账套");
  assert.ok(d.open && d.isConnected, "失败时新建面板保留供用户重试");
  const toast = a.doc.querySelector("#toast");
  assert.match(toast.textContent, /创建失败/);
  assert.ok(toast.classList.contains("err"), "失败必须提示为错误");

  // 失败后点「创建后从税局导入」同：只 POST 一次，且绝不打开税局 dialog
  d.querySelector("#nsTaxBrowser").click();
  await tick(8);
  assert.equal(countCreate(a.calls), 2, "第二次点击只对应一次创建");
  assert.equal(countListSets(a.calls), listBefore, "失败仍不得 loadSets");
  assert.equal(a.app.snap().TB.dialog, null, "创建失败不得弹税局 dialog");
});

// ---------------------------------------------------------------- 2. 单一 dialog / 串行
await test("税局 dialog：重复打开复用同一窗口，不覆盖 sessionId、不重复 open", async () => {
  let sessionsPosts = 0;
  const a = await newApp((path, opts) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path === "/api/tax-browser/config") return res(200, { loginToken: "tok-1" });
    if (path === "/api/tax-browser/sessions" && opts.method === "POST") { sessionsPosts++; return res(201, { sessionId: "s1", manualLogin: { instructions: ["请登录"] } }); }
    if (path.endsWith("/close")) return res(200, { closed: true, note: "已关闭" });
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d = a.app.snap().TB.dialog;
  assert.ok(d);
  d.querySelector("#tbLogin").click();
  await tick(6);
  assert.equal(a.app.snap().TB.sessionId, "s1", "登录应记录 sessionId");
  assert.equal(sessionsPosts, 1);

  // 再次打开：复用同一 dialog，不得新增或覆盖
  const again = a.app.taxBrowserDialog();
  assert.equal(again, d, "重复打开必须复用同一 dialog");
  assert.equal(dialogs(a.doc).length, 1, "不得叠加 dialog");
  assert.equal(a.app.snap().TB.sessionId, "s1", "重复打开不得覆盖 sessionId");

  // 已开会话再点「打开官方登录窗口」：串行守卫生效，不再发会话请求
  d.querySelector("#tbLogin").click();
  await tick(4);
  assert.equal(sessionsPosts, 1, "已开会话不得重复 open");
  assert.equal(a.app.snap().TB.sessionId, "s1");
});

await test("税局 dialog：关闭按钮清空本地会话/预览/勾选并移除 dialog", async () => {
  const a = await newApp((path) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path.endsWith("/close")) return res(200, { closed: true, note: "已关闭" });
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d = a.app.snap().TB.dialog;
  const tb = a.app.snap().TB;
  tb.sessionId = "s1";
  tb.preview = [{ candidateId: "c1", name: "甲公司" }];
  tb.checked = new Set(["c1"]);
  d.querySelector("#tbImportResult").classList.remove("hidden");

  d.querySelector("#tbCloseBtn").click();
  await tick(6);

  assert.equal(a.app.snap().TB.sessionId, null, "关闭后不得留下 sessionId");
  assert.equal(a.app.snap().TB.preview.length, 0, "关闭后不得留下企业预览");
  assert.equal(a.app.snap().TB.checked.size, 0, "关闭后不得留下勾选");
  assert.equal(a.app.snap().TB.dialog, null, "关闭后应移除 dialog 引用");
  assert.equal(d.isConnected, false, "关闭后 dialog 应从 DOM 移除");
  assert.ok(d.querySelector("#tbImportResult").classList.contains("hidden"), "关闭后不得留下导入结果");
  assert.ok(a.calls.some((c) => c.method === "POST" && c.path === "/api/tax-browser/sessions/s1/close"), "应通知服务端关闭会话");
});

await test("税局 dialog：Esc(cancel) 同样关闭本地会话并移除 dialog", async () => {
  const a = await newApp((path) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path.endsWith("/close")) return res(200, { closed: true, note: "已关闭" });
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d = a.app.snap().TB.dialog;
  const tb = a.app.snap().TB;
  tb.sessionId = "s2";
  tb.preview = [{ candidateId: "c9", name: "乙公司" }];
  tb.checked = new Set(["c9"]);

  d.dispatchEvent({ type: "cancel", preventDefault() {} });
  await tick(6);

  assert.equal(a.app.snap().TB.sessionId, null);
  assert.equal(a.app.snap().TB.preview.length, 0);
  assert.equal(a.app.snap().TB.dialog, null);
  assert.equal(d.isConnected, false);
  assert.ok(a.calls.some((c) => c.path === "/api/tax-browser/sessions/s2/close"), "取消也应关闭服务端会话");
});

await test("税局 dialog：启动中取消，迟到的 session 返回后立即关闭，不留孤儿；旧 dialog 不再更新", async () => {
  let resolveLogin = null;
  const a = await newApp((path, opts) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path === "/api/tax-browser/config") return res(200, { loginToken: "tok-1" });
    if (path === "/api/tax-browser/sessions" && opts.method === "POST") {
      return new Promise((resolve) => { resolveLogin = () => resolve(res(201, { sessionId: "late-1", manualLogin: { instructions: [] } })); });
    }
    if (path.endsWith("/close")) return res(200, { closed: true, note: "已关闭" });
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d = a.app.snap().TB.dialog;
  const loginBtn = d.querySelector("#tbLogin");
  loginBtn.click();
  assert.ok(await waitFor(() => !!resolveLogin, 1000), "会话创建请求应已发出");

  void a.app.tbClose(d);           // 启动中取消（移除 dialog、标记 closed）
  resolveLogin();                  // 迟到的会话返回
  await tick(8);

  assert.ok(a.calls.some((c) => c.method === "POST" && c.path === "/api/tax-browser/sessions/late-1/close"),
    "迟到返回的会话必须被关闭，不能成为孤儿");
  assert.equal(a.app.snap().TB.sessionId, null, "取消后不得把迟到会话写入本地状态");
  assert.equal(a.app.snap().TB.dialog, null);
  assert.equal(d.isConnected, false);
  assert.equal(loginBtn.textContent, "处理中…", "旧 dialog 的按钮状态不得被恢复更新");
  assert.equal(loginBtn.disabled, true);
});

// ---------------------------------------------------------------- 3. tbApi 结构化错误 / 状态清理
await test("tbApi：错误保留结构化 code 与 status，不靠中文正则", async () => {
  const a = await newApp(() => res(409, { error: "tax_browser_session_closed", message: "会话已关闭" }));
  let err;
  try { await a.app.tbApi("/api/x", { method: "POST", body: {} }); } catch (e) { err = e; }
  assert.ok(err, "非 2xx 必须抛错");
  assert.equal(err.code, "tax_browser_session_closed");
  assert.equal(err.status, 409);
});

await test("tbOpenSession：仅按 error.code=login_token_invalid 重取令牌（非中文正则）", async () => {
  let posts = 0;
  const a = await newApp((path, opts) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path === "/api/tax-browser/config") return res(200, { loginToken: "tok" });
    if (path === "/api/tax-browser/sessions" && opts.method === "POST") {
      posts++;
      if (posts === 1) return res(403, { error: "tax_browser_login_token_invalid", message: "登录令牌无效或已过期" });
      return res(201, { sessionId: "s9", manualLogin: { instructions: [] } });
    }
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d = a.app.snap().TB.dialog;
  d.querySelector("#tbLogin").click();
  await tick(6);
  assert.equal(posts, 2, "令牌失效应重取一次");
  assert.equal(a.app.snap().TB.sessionId, "s9");
});

await test("读取终态 404：清空 sessionId/preview/勾选与导入结果", async () => {
  let failNext = false;
  const a = await newApp((path, opts) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path.endsWith("/read")) {
      if (failNext) return res(404, { error: "tax_browser_session_not_found", message: "未知或已清理的会话" });
      return res(200, {
        session: { sessionId: "s1" },
        read: { items: [{ candidateId: "c1", name: "甲公司", taxpayerId: "91350600MA34B1W601", occurrences: 1, firstSeenAt: "2026-01-01T00:00:00Z" }], pagesRead: 1, count: 1, source: "page", note: "" },
        newCount: 1,
      });
    }
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d = a.app.snap().TB.dialog;
  a.app.snap().TB.sessionId = "s1";
  d.querySelector("#tbRead").click();
  await tick(6);
  assert.equal(a.app.snap().TB.preview.length, 1, "正常读取应写入预览");

  failNext = true;
  d.querySelector("#tbRead").click();
  await tick(6);
  assert.equal(a.app.snap().TB.sessionId, null, "终态应清空 sessionId");
  assert.equal(a.app.snap().TB.preview.length, 0, "终态应清空预览");
  assert.equal(a.app.snap().TB.checked.size, 0, "终态应清空勾选");
  assert.ok(d.querySelector("#tbImportResult").classList.contains("hidden"), "终态应清空导入结果");
  assert.match(d.querySelector("#tbError").textContent, /未知或已清理的会话/);
});

await test("暂时性读取错误：保留可重试的 sessionId 与预览/勾选", async () => {
  const a = await newApp((path) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path.endsWith("/read")) return res(400, { error: "tax_browser_read_failed", message: "页面读取失败，请稍后重试" });
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d = a.app.snap().TB.dialog;
  const tb = a.app.snap().TB;
  tb.sessionId = "s1";
  tb.preview = [{ candidateId: "c1", name: "甲公司" }];
  tb.checked = new Set(["c1"]);

  d.querySelector("#tbRead").click();
  await tick(6);
  assert.equal(a.app.snap().TB.sessionId, "s1", "普通错误不得丢失可重试的 sessionId");
  assert.equal(a.app.snap().TB.preview.length, 1, "普通错误不得清空预览");
  assert.equal(a.app.snap().TB.checked.has("c1"), true, "普通错误不得清空勾选");
  assert.match(d.querySelector("#tbError").textContent, /页面读取失败/);
});

// ---------------------------------------------------------------- 3b. 关闭与迟到异步写回
const tbPostCount = (calls, suffix) => calls.filter((c) => c.method === "POST" && c.path.endsWith(suffix)).length;

await test("close→resolve read：关闭后迟到的读取响应不得写回 TB.session/preview/checked", async () => {
  let resolveRead = null;
  const a = await newApp((path) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path.endsWith("/read")) {
      return new Promise((resolve) => { resolveRead = () => resolve(res(200, {
        session: { sessionId: "s1" },
        read: { items: [{ candidateId: "c1", name: "甲公司", taxpayerId: "91350600MA34B1W601", occurrences: 1, firstSeenAt: "2026-01-01T00:00:00Z" }], pagesRead: 1, count: 1, source: "page", note: "" },
        newCount: 1,
      })); });
    }
    if (path.endsWith("/close")) return res(200, { closed: true });
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d = a.app.snap().TB.dialog;
  const tb = a.app.snap().TB;
  tb.sessionId = "s1"; tb.preview = []; tb.checked = new Set();
  d.querySelector("#tbRead").click();
  assert.ok(await waitFor(() => !!resolveRead, 1000), "读取请求应已发出");

  await a.app.tbClose(d);        // 读取未完成时关闭：清空 TB
  resolveRead();                 // 迟到的读取响应
  await tick(6);

  assert.equal(tb.sessionId, null, "关闭后迟到读取不得复活 sessionId");
  assert.equal(tb.preview.length, 0, "关闭后迟到读取不得写回 preview");
  assert.equal(tb.checked.size, 0, "关闭后迟到读取不得写回 checked");
  assert.equal(tb.session, null, "关闭后迟到读取不得写回 session");
});

await test("close→reopen→late success：旧读取成功不得污染新 dialog/session", async () => {
  let resolveRead = null;
  const a = await newApp((path) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path.endsWith("/read")) return new Promise((resolve) => { resolveRead = () => resolve(res(200, { session: { sessionId: "s1" }, read: { items: [{ candidateId: "old", name: "旧企业" }], pagesRead: 1, count: 1, source: "page", note: "" }, newCount: 1 })); });
    if (path.endsWith("/close")) return res(200, { closed: true });
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d1 = a.app.snap().TB.dialog;
  const tb = a.app.snap().TB;
  tb.sessionId = "s1";
  d1.querySelector("#tbRead").click();
  assert.ok(await waitFor(() => !!resolveRead, 1000));
  await a.app.tbClose(d1);

  const d2 = a.app.taxBrowserDialog(); // 重新打开新 dialog
  tb.sessionId = "s2"; tb.preview = [{ candidateId: "new", name: "新企业" }]; tb.checked = new Set(["new"]);
  resolveRead();
  await tick(6);

  assert.equal(tb.sessionId, "s2", "迟到旧读取不得覆盖新 sessionId");
  assert.equal(tb.preview.length, 1, "迟到旧读取不得覆盖新 preview");
  assert.equal(tb.preview[0].candidateId, "new");
  assert.equal(a.app.snap().TB.dialog, d2, "新 dialog 应保持");
  assert.ok(d2.isConnected, "新 dialog 不得被旧请求移除");
});

await test("close→reopen→late error：旧请求终态错误不得清理新 dialog/session", async () => {
  let rejectRead = null;
  const a = await newApp((path) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path.endsWith("/read")) return new Promise((resolve) => { rejectRead = () => resolve(res(404, { error: "tax_browser_session_not_found", message: "未知或已清理的会话" })); });
    if (path.endsWith("/close")) return res(200, { closed: true });
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d1 = a.app.snap().TB.dialog;
  const tb = a.app.snap().TB;
  tb.sessionId = "s1";
  d1.querySelector("#tbRead").click();
  assert.ok(await waitFor(() => !!rejectRead, 1000));
  await a.app.tbClose(d1);

  const d2 = a.app.taxBrowserDialog();
  tb.sessionId = "s2"; tb.preview = [{ candidateId: "new", name: "新企业" }]; tb.checked = new Set(["new"]);
  rejectRead();
  await tick(6);

  assert.equal(tb.sessionId, "s2", "旧请求终态错误不得清理新 sessionId");
  assert.equal(tb.preview.length, 1, "旧请求终态错误不得清空新预览");
  assert.equal(tb.checked.has("new"), true, "旧请求终态错误不得清空新勾选");
  assert.equal(a.app.snap().TB.dialog, d2, "新 dialog 应保持");
  assert.ok(d2.isConnected);
});

await test("tbImport：dryRun 返回时已关闭 → 不再弹确认、不实际导入", async () => {
  let resolveDry = null;
  let actualImports = 0;
  const a = await newApp((path, opts) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path.endsWith("/import")) {
      const body = JSON.parse(opts.body || "{}");
      if (body.dryRun) return new Promise((resolve) => { resolveDry = () => resolve(res(200, { summary: { created: 1, existing: 0 }, results: [] })); });
      actualImports++;
      return res(200, { summary: { created: 1, existing: 0, bound: 0 }, results: [] });
    }
    if (path.endsWith("/close")) return res(200, { closed: true });
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d = a.app.snap().TB.dialog;
  const tb = a.app.snap().TB;
  tb.sessionId = "s1"; tb.checked = new Set(["c1"]); tb.preview = [{ candidateId: "c1", name: "甲公司" }];
  d.querySelector("#tbMode").value = "create";
  d.querySelector("#tbStart").value = "2026-01";
  d.querySelector("#tbImport").click();
  assert.ok(await waitFor(() => !!resolveDry, 1000), "dryRun 请求应已发出");

  await a.app.tbClose(d); // dryRun 返回前关闭
  resolveDry();
  await tick(8);

  assert.equal(a.confirms.length, 0, "已关闭后 dryRun 返回不得再弹确认");
  assert.equal(actualImports, 0, "已关闭后不得调用实际 import");
});

await test("tbImport：实际导入成功但 dialog 已关闭/换新 → 结果不回填", async () => {
  let resolveActual = null;
  let accountSetGets = 0;
  const a = await newApp((path, opts) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path === "/api/account-sets") { accountSetGets++; return res(200, []); }
    if (path.endsWith("/import")) {
      const body = JSON.parse(opts.body || "{}");
      if (body.dryRun) return res(200, { summary: { created: 1, existing: 0 }, results: [] });
      return new Promise((resolve) => { resolveActual = () => resolve(res(200, { summary: { created: 1, existing: 0, bound: 0 }, results: [{ action: "created", name: "甲公司", taxpayerId: "91350600MA34B1W601", accountSetId: 5 }] })); });
    }
    if (path.endsWith("/close")) return res(200, { closed: true });
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d1 = a.app.snap().TB.dialog;
  const tb = a.app.snap().TB;
  tb.sessionId = "s1"; tb.checked = new Set(["c1"]); tb.preview = [{ candidateId: "c1", name: "甲公司" }];
  d1.querySelector("#tbMode").value = "create";
  d1.querySelector("#tbStart").value = "2026-01";
  d1.querySelector("#tbImport").click();
  assert.ok(await waitFor(() => !!resolveActual, 1000), "实际 import 应已发出");

  await a.app.tbClose(d1);
  const d2 = a.app.taxBrowserDialog();
  // 合成 DOM 不解析 innerHTML：按真实初始状态给新 dialog 的导入结果补上 hidden 类
  d2.querySelector("#tbImportResult").classList.add("hidden");
  const getsBefore = accountSetGets;
  resolveActual();
  await tick(8);

  assert.ok(d2.querySelector("#tbImportResult").classList.contains("hidden"), "迟到成功不得回填新 dialog 结果");
  assert.equal(d2.querySelector("#tbImportResult").textContent, "", "迟到成功不得写入文本");
  assert.equal(accountSetGets, getsBefore, "迟到成功不得触发 loadSets");
});

// ---------------------------------------------------------------- 3c. 关闭失败的安全重试
await test("close 网络失败：保留 pendingClose 安全引用，重新打开后重试并成功", async () => {
  let closeCalls = 0;
  const a = await newApp((path, opts) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path === "/api/tax-browser/config") return res(200, { loginToken: "tok-1" });
    if (path === "/api/tax-browser/sessions" && opts.method === "POST") return res(201, { sessionId: "s2", manualLogin: { instructions: [] } });
    if (path.endsWith("/close")) { closeCalls++; return closeCalls === 1 ? res(500, { error: "tax_browser_close_failed", message: "服务端关闭失败" }) : res(200, { closed: true }); }
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d1 = a.app.snap().TB.dialog;
  const tb = a.app.snap().TB;
  tb.sessionId = "s1"; tb.preview = [{ candidateId: "c1", name: "甲公司" }]; tb.checked = new Set(["c1"]);

  await a.app.tbClose(d1);
  assert.equal(tb.sessionId, null, "关闭失败仍应清空本地会话");
  assert.equal(tb.preview.length, 0, "关闭失败仍应清空预览");
  assert.equal(d1.isConnected, false, "关闭失败仍应移除 dialog");
  assert.equal(tb.pendingClose.has("s1"), true, "关闭失败必须保留安全重试引用（普通错误）");

  const d2 = a.app.taxBrowserDialog();
  d2.querySelector("#tbLogin").click();
  await tick(8);

  assert.equal(closeCalls, 2, "重新打开时应重试关闭旧会话");
  assert.equal(tb.pendingClose.has("s1"), false, "重试成功后应清除安全引用");
  assert.equal(tb.sessionId, "s2", "清理确认后才开启新会话");
});

await test("close 失败后新开会话前重试仍失败：明确阻止，不静默开新会话", async () => {
  let sessionPosts = 0;
  const a = await newApp((path, opts) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path === "/api/tax-browser/config") return res(200, { loginToken: "tok-1" });
    if (path === "/api/tax-browser/sessions" && opts.method === "POST") { sessionPosts++; return res(201, { sessionId: "s2", manualLogin: { instructions: [] } }); }
    if (path.endsWith("/close")) return res(500, { error: "tax_browser_close_failed", message: "服务端关闭失败" });
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d1 = a.app.snap().TB.dialog;
  const tb = a.app.snap().TB;
  tb.sessionId = "s1";
  await a.app.tbClose(d1);

  const d2 = a.app.taxBrowserDialog();
  d2.querySelector("#tbLogin").click();
  await tick(8);

  assert.equal(sessionPosts, 0, "旧会话清理未确认时不得静默开新会话");
  assert.equal(tb.pendingClose.has("s1"), true, "仍应保留安全引用");
  assert.equal(tb.sessionId, null, "不得开启新会话");
  assert.match(d2.querySelector("#tbError").textContent, /尚未确认关闭/);
});

await test("late-open 自动 close 失败：不吞掉失败，记录 pendingClose 安全引用", async () => {
  let resolveLogin = null;
  const a = await newApp((path, opts) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path === "/api/tax-browser/config") return res(200, { loginToken: "tok-1" });
    if (path === "/api/tax-browser/sessions" && opts.method === "POST") {
      return new Promise((resolve) => { resolveLogin = () => resolve(res(201, { sessionId: "late-2", manualLogin: { instructions: [] } })); });
    }
    if (path.endsWith("/close")) return res(500, { error: "tax_browser_close_failed", message: "服务端关闭失败" });
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d = a.app.snap().TB.dialog;
  d.querySelector("#tbLogin").click();
  assert.ok(await waitFor(() => !!resolveLogin, 1000));

  void a.app.tbClose(d);
  resolveLogin();
  await tick(8);

  const tb = a.app.snap().TB;
  assert.equal(tb.sessionId, null, "迟到会话不得写入本地状态");
  assert.equal(tb.pendingClose.has("late-2"), true, "迟到会话自动关闭失败必须记录安全引用，不得静默留孤儿");
  const toast = a.doc.querySelector("#toast");
  assert.match(toast.textContent, /关闭未确认/);
  assert.ok(toast.classList.contains("err"));
});

await test("暂时性 close 错误：保留可重试安全引用，不因普通网络错误永久丢失", async () => {
  const a = await newApp((path) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path.endsWith("/close")) return res(503, { error: "tax_browser_close_failed", message: "临时不可用" });
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d = a.app.snap().TB.dialog;
  const tb = a.app.snap().TB;
  tb.sessionId = "sx";
  await a.app.tbClose(d);
  assert.equal(tb.pendingClose.has("sx"), true, "普通 close 失败应保留安全 sid 供重试");
  assert.equal(tb.pendingClose.get("sx").attempts, 1, "记录尝试次数用于避免无界自动重试");
});

await test("close 在途→重开：close 确认前不得发 sessions POST，同 sid 不并发重复 close", async () => {
  let closeCalls = 0, resolveClose = null, sessionPosts = 0;
  const a = await newApp((path, opts) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path === "/api/tax-browser/config") return res(200, { loginToken: "tok-1" });
    if (path === "/api/tax-browser/sessions" && opts.method === "POST") { sessionPosts++; return res(201, { sessionId: "s2", manualLogin: { instructions: [] } }); }
    if (path.endsWith("/close")) { // 关闭请求保持挂起（未确认）
      closeCalls++;
      return new Promise((resolve) => { resolveClose = () => resolve(res(200, { closed: true })); });
    }
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d1 = a.app.snap().TB.dialog;
  const tb = a.app.snap().TB;
  tb.sessionId = "s1"; tb.preview = [{ candidateId: "c1", name: "甲公司" }]; tb.checked = new Set(["c1"]);

  void a.app.tbClose(d1); // 关闭已发请求但仍挂起（pendingClose 中已有在途引用）
  assert.ok(await waitFor(() => closeCalls === 1, 1000), "close 请求应已发出且在途");
  assert.equal(tb.pendingClose.has("s1"), true, "close 发请求前就应登记在途引用");

  const d2 = a.app.taxBrowserDialog(); // 用户在新 dialog 重开
  d2.querySelector("#tbLogin").click();
  await tick(6);
  assert.equal(sessionPosts, 0, "close 未确认前不得发 sessions POST");
  assert.equal(closeCalls, 1, "同一 sid 在途期间不得并发重复 close");
  assert.equal(tb.sessionId, null);

  resolveClose(); // close 确认成功
  await tick(8);
  assert.equal(tb.pendingClose.has("s1"), false, "close 成功后应清除安全引用");
  assert.equal(sessionPosts, 1, "close 确认后才允许开启新会话");
  assert.equal(tb.sessionId, "s2");
});

await test("close 在途失败→重开：继续阻止新会话，不无界重试", async () => {
  let closeCalls = 0, resolveClose = null, sessionPosts = 0;
  const a = await newApp((path, opts) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path === "/api/tax-browser/config") return res(200, { loginToken: "tok-1" });
    if (path === "/api/tax-browser/sessions" && opts.method === "POST") { sessionPosts++; return res(201, { sessionId: "s2", manualLogin: { instructions: [] } }); }
    if (path.endsWith("/close")) {
      closeCalls++;
      return new Promise((resolve) => { resolveClose = () => resolve(res(500, { error: "tax_browser_close_failed", message: "服务端关闭失败" })); });
    }
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d1 = a.app.snap().TB.dialog;
  const tb = a.app.snap().TB;
  tb.sessionId = "s1";

  void a.app.tbClose(d1);
  assert.ok(await waitFor(() => closeCalls === 1, 1000));

  const d2 = a.app.taxBrowserDialog();
  d2.querySelector("#tbLogin").click();
  await tick(6);
  assert.equal(sessionPosts, 0, "close 未确认前不得开新会话");

  resolveClose(); // close 确认失败
  await tick(8);
  assert.equal(tb.pendingClose.has("s1"), true, "close 失败应保留安全引用");
  assert.equal(sessionPosts, 0, "close 失败必须继续阻止新开，不得静默放行");
  assert.equal(tb.sessionId, null);
  assert.equal(closeCalls, 1, "不得对同一 sid 无界重试（仅等待已发出的在途请求）");
  assert.match(d2.querySelector("#tbError").textContent, /尚未确认关闭/);
});

await test("tbOpenSession 挂起在 flush→取消：清理/取令牌完成后不得再开新浏览器", async () => {
  let resolveFlush = null, sessionPosts = 0;
  const a = await newApp((path, opts) => {
    if (path === "/api/meta") return res(200, { standards: ["小企业会计准则"] });
    if (path === "/api/tax-browser/config") return res(200, { loginToken: "tok-1" });
    if (path === "/api/tax-browser/sessions" && opts.method === "POST") { sessionPosts++; return res(201, { sessionId: "s2", manualLogin: { instructions: [] } }); }
    if (path.endsWith("/close")) return new Promise((resolve) => { resolveFlush = () => resolve(res(200, { closed: true })); });
    return res(200, []);
  });
  a.app.taxBrowserDialog();
  const d1 = a.app.snap().TB.dialog;
  const tb = a.app.snap().TB;
  tb.sessionId = "sold";
  void a.app.tbClose(d1); // 旧会话 close 在途，pendingClose 已登记
  assert.ok(await waitFor(() => !!resolveFlush, 1000), "close 请求应已发出");

  const d2 = a.app.taxBrowserDialog(); // 打开新 dialog 后立刻点击登录
  d2.querySelector("#tbLogin").click();
  await tick(6);
  assert.equal(sessionPosts, 0, "flush 挂起期间不得发 sessions POST");
  assert.equal(tb.pendingClose.has("sold"), true);

  await a.app.tbClose(d2); // 清理完成前取消（移除新 dialog）
  resolveFlush();          // 旧 close 确认成功、flush 完成
  await tick(8);

  assert.equal(tb.pendingClose.has("sold"), false, "close 成功后应清除安全引用");
  assert.equal(sessionPosts, 0, "取消期间 flush 完成后不得再开新浏览器");
  assert.equal(tb.sessionId, null);
  assert.equal(a.app.snap().TB.dialog, null);
  assert.equal(d2.isConnected, false);
});

// ---------------------------------------------------------------- 4. 文案与报表保留
await test("文案：明确福建漳州试用/登录与企业读取尚未实测，并保留报表下载按钮", async () => {
  const a = await newApp();
  a.app.taxBrowserDialog();
  const html = a.app.snap().TB.dialog.innerHTML;
  assert.match(html, /福建漳州试用/);
  assert.match(html, /登录与企业读取尚未实测/);
  assert.match(html, /本次只建立企业档案\/空账套/);
  assert.match(html, /凭证与期初余额需另行导入/);
  assert.match(html, /福建省 · 漳州市/);

  // 同事的报表 UI / 下载按钮接线不得被改动
  assert.equal(typeof a.doc.querySelector("#btnExportReport").onclick, "function", "下载 CSV 按钮接线应保留");
  assert.equal(typeof a.doc.querySelector("#btnRunReport").onclick, "function", "生成报表按钮接线应保留");
});

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r[0]).length;
console.log(`\n=== 汇总 ===`);
for (const [ok, name] of results) console.log(`${ok ? "✓" : "✗"} ${name}`);
console.log(failed ? `${failed} 个用例未通过` : `全部 ${results.length} 个用例通过（${results.length - failed}/${results.length}）`);
process.exitCode = failed ? 1 : 0;
