// tax-browser.mjs — 电子税务局「用户人工登录 + 本地浏览器只读采集」服务
//
// 边界（详见 docs/TAX-BROWSER.md）：
//   - 本期只支持福建省漳州市（region 350000 / city 350600）真实浏览器人工登录；
//     其他地区一律返回结构化「未支持」，不伪造接入状态；全国接入仍是后续目标。
//   - 浏览器窗口由用户自己操作登录（账号/密码/验证码/扫码都不经过本服务）；
//     打开窗口 ≠ 已登录；只有识别到带标签的企业记录才返回数据，否则明确失败。
//   - 只允许固定白名单来源（https://etax.fujian.chinatax.gov.cn，443/8443）页面执行
//     一段「代码内固定」的只读 DOM 脚本：按「企业名称/纳税人名称」+「统一社会信用代码/
//     纳税人识别号」标签配对识别企业。不抓 cookies / token / localStorage / 密码，
//     不监听网络响应，不在任意 URL 上执行脚本。
//   - 浏览器进程用 execFile/spawn（shell:false）启动本机已安装的官方 Edge/Chrome
//     （固定路径探测，可执行文件路径不接受请求传入），使用独立随机临时 profile + incognito，
//     不读取用户常用 profile。CDP 只连 ws://127.0.0.1:<随机端口>，ws endpoint 不出现在任何响应里。
//   - 会话 id / 登录令牌均随机不可猜；有总量、TTL、读取超时限制；关闭/超时/浏览器退出都会
//     清理会话数据（销毁已识别企业候选）并删除本程序创建的临时 profile（严格校验路径）。
//     并发关闭后的迟到读取结果一律丢弃，不得恢复数据。
//   - 本模块不依赖数据库；导入落库在 tax-import.mjs（通过 importer 注入，便于独立测试）。

import { spawn, execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, rmdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const iso = (ms) => new Date(ms).toISOString();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 日志脱敏：日志一律使用调用方给定的固定失败文案，绝不从外部异常提取或拼接
 * code/message/details（外部异常可能含页面内容或凭据，属敏感信息）。
 */
const safeErrorCode = (_e, fallback) => fallback;

export class TaxBrowserError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = "TaxBrowserError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------- 地区白名单
/**
 * 当前支持的地区。entryUrl 与 allowedOrigins 是代码内固定值，不接受请求传入；
 * 官网入口为 https://etax.fujian.chinatax.gov.cn/，本机实测登录会跳转
 * https://etax.fujian.chinatax.gov.cn:8443/（页面标题「国家税务总局电子税务局」），
 * 两个来源都允许，其余 hostname/端口/协议一律拒绝读取。
 */
export const SUPPORTED_REGIONS = [
  {
    key: "fujian-zhangzhou",
    region: "350000",
    provinceLabel: "福建省",
    city: "350600",
    cityLabel: "漳州市",
    label: "福建省漳州市",
    entryUrl: "https://etax.fujian.chinatax.gov.cn/",
    allowedOrigins: ["https://etax.fujian.chinatax.gov.cn", "https://etax.fujian.chinatax.gov.cn:8443"],
  },
];

const SUPPORTED_LABELS = SUPPORTED_REGIONS.map((r) => r.label).join("、");

export function listSupportedRegions() {
  return SUPPORTED_REGIONS.map((r) => ({
    region: r.region, provinceLabel: r.provinceLabel, city: r.city, cityLabel: r.cityLabel,
    label: r.label, entryUrl: r.entryUrl, allowedOrigins: [...r.allowedOrigins], kind: "manual-browser",
  }));
}

export function resolveSupportedRegion(region, city) {
  const hit = SUPPORTED_REGIONS.find((r) => r.region === str(region) && r.city === str(city));
  if (hit) return hit;
  throw new TaxBrowserError(
    "tax_browser_region_not_supported",
    `当前仅支持 ${SUPPORTED_LABELS} 的浏览器人工登录导入；其他地区明确未支持。全国电子税务局接入仍是后续目标，尚未实现。`,
    { region: str(region), city: str(city), supported: listSupportedRegions().map((r) => `${r.region}/${r.city}`) }
  );
}

// ---------------------------------------------------------------- 税号严格校验
const USCC_CHARS = "0123456789ABCDEFGHJKLMNPQRTUWXY";
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

/** GB 32100-2015 统一社会信用代码第 18 位校验码；输入非法字符返回 null。 */
export function usccCheckChar(first17) {
  const s = String(first17 ?? "");
  if (s.length !== 17) return null;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const idx = USCC_CHARS.indexOf(s[i]);
    if (idx < 0) return null;
    sum += idx * USCC_WEIGHTS[i];
  }
  return USCC_CHARS[(31 - (sum % 31)) % 31];
}

/**
 * 企业税号严格校验：18 位统一社会信用代码（校验码必须正确）或 15 位旧纳税人识别号
 * （6 位数字行政区划 + 9 位组织机构代码）。返回规范化大写值，非法返回 null。
 */
export function validateTaxpayerId(raw) {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!/^[0-9A-Z]{15}$|^[0-9A-Z]{18}$/.test(s)) return null;
  if (s.length === 18) {
    if (!/^\d{6}/.test(s)) return null; // 登记管理部门+区划必须以数字区划开头
    const check = usccCheckChar(s.slice(0, 17));
    if (!check || check !== s[17]) return null;
    return s;
  }
  if (!/^\d{6}[0-9A-Z]{9}$/.test(s)) return null;
  return s;
}

export function maskTaxpayerId(raw) {
  const s = String(raw ?? "");
  if (!s) return "(空)";
  if (s.length <= 8) return "*".repeat(s.length);
  return `${s.slice(0, 4)}${"*".repeat(Math.max(2, s.length - 8))}${s.slice(-4)}`;
}

// ---------------------------------------------------------------- 页面行 → 企业（可单测的纯函数）
const NAME_LABELS = ["企业名称", "纳税人名称", "单位名称"];
const CODE_LABELS = ["统一社会信用代码", "纳税人识别号", "社会信用代码", "纳税人识别码"];
const labelRe = (labels) => new RegExp(`^(?:${labels.join("|")})\\s*[：:]?\\s*$`);
const inlineRe = (labels) => new RegExp(`^(?:${labels.join("|")})\\s*[：:]\\s*(\\S.*)$`);
const NAME_LABEL_RE = labelRe(NAME_LABELS);
const CODE_LABEL_RE = labelRe(CODE_LABELS);
const NAME_INLINE_RE = inlineRe(NAME_LABELS);
const CODE_INLINE_RE = inlineRe(CODE_LABELS);
const isAnyLabelCell = (cell) => NAME_LABEL_RE.test(cell) || CODE_LABEL_RE.test(cell);

/**
 * 一「行」单元格数组里配对企业名称与税号。
 * 只有出现明确的名称标签与税号标签（值紧跟其后，或同一单元格「标签：值」）才配对；
 * 页面上裸露的税号（没有标签对应）绝不认作授权企业。
 */
function pairRow(cells) {
  let name = null;
  let taxpayerId = null;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (name === null) {
      const inline = NAME_INLINE_RE.exec(cell);
      if (inline) { name = inline[1]; continue; }
      if (NAME_LABEL_RE.test(cell) && i + 1 < cells.length && !isAnyLabelCell(cells[i + 1])) {
        name = cells[i + 1]; i++; continue;
      }
    }
    if (taxpayerId === null) {
      const inline = CODE_INLINE_RE.exec(cell);
      if (inline) { taxpayerId = inline[1]; continue; }
      if (CODE_LABEL_RE.test(cell) && i + 1 < cells.length && !isAnyLabelCell(cells[i + 1])) {
        taxpayerId = cells[i + 1]; i++; continue;
      }
    }
  }
  if (!name || !taxpayerId) return null;
  return { name: name.trim(), taxpayerId: taxpayerId.trim() };
}

/**
 * 由页面快照的行单元格提取企业（服务端纯函数，可用 fixtures 单测）。
 * rows: Array<Array<string>>。返回 { items, matchedRows, totalRows, rowsWithInvalidTaxId }。
 * items 按税号合并（多次读取/翻页同一企业只保留一条，occurrences 计数）。
 */
export function extractEnterprisesFromCells(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let matched = 0;
  let invalidTaxId = 0;
  const byId = new Map();
  for (const row of list) {
    if (!Array.isArray(row)) continue;
    const cells = row.map((c) => (typeof c === "string" ? c : String(c ?? ""))).filter((c) => c !== "").slice(0, 24);
    const pair = pairRow(cells);
    if (!pair) continue;
    matched++;
    const taxpayerId = validateTaxpayerId(pair.taxpayerId);
    if (!taxpayerId) { invalidTaxId++; continue; }
    const name = pair.name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (name.length < 2 || name.length > 80) continue;
    const existing = byId.get(taxpayerId);
    if (existing) { existing.occurrences++; continue; }
    byId.set(taxpayerId, { taxpayerId, name, occurrences: 1 });
  }
  return { items: [...byId.values()], matchedRows: matched, totalRows: list.length, rowsWithInvalidTaxId: invalidTaxId };
}

// ---------------------------------------------------------------- 页内只读脚本（代码内固定，不接受请求传入）
/**
 * 在电子税务局页面上执行的固定只读脚本：
 *   1) 收集所有 <tr> 的 td/th 文本；
 *   2) 收集 class 含 item/card/row/list 等关键词的块级元素的叶子文本（卡片式布局）；
 *   3) 返回 { href, title, rows }（rows 是「行 → 单元格文本数组」快照）。
 * 标签配对、税号校验、合并去重全部在服务端做（extractEnterprisesFromCells），
 * 页内脚本只做纯文本快照，不修改 DOM、不读 cookies/localStorage、不发网络请求。
 * 行/单元格数量都有上限，防止超大页面拖垮读取。
 */
const ALLOWED_ORIGINS_JSON = JSON.stringify(SUPPORTED_REGIONS.flatMap((r) => r.allowedOrigins));

export const READ_PAGE_SCRIPT = `(() => {
  const ALLOWED_ORIGINS = ${ALLOWED_ORIGINS_JSON};
  const readOrigin = () => {
    try {
      const loc = typeof location !== "undefined" && location ? location : null;
      if (!loc) return "";
      if (loc.origin) return String(loc.origin);
      const href = String(loc.href || "");
      return href ? new URL(href).origin : "";
    } catch (e) { return ""; }
  };
  const origin = readOrigin();
  if (ALLOWED_ORIGINS.indexOf(origin) < 0) return { allowed: false, origin: origin, href: "", title: "", rows: [] };
  const MAX_ROWS = 400, MAX_CELLS = 24, MAX_CELL_TEXT = 120;
  const clean = (t) => String(t == null ? "" : t).replace(/\\s+/g, " ").trim().slice(0, MAX_CELL_TEXT);
  const push = (out, t) => { if (t && out.length < MAX_CELLS && out.indexOf(t) < 0) out.push(t); };
  const rows = [];
  const seen = Object.create(null);
  const addRow = (cells) => {
    if (!cells || !cells.length || rows.length >= MAX_ROWS) return;
    const key = cells.join("\\u2502");
    if (!key || seen[key]) return;
    seen[key] = true;
    rows.push(cells);
  };
  for (const tr of document.querySelectorAll("tr")) {
    const cells = [];
    for (const cell of tr.querySelectorAll("td,th")) push(cells, clean(cell.textContent));
    addRow(cells);
  }
  const blockClassRe = /item|card|row|ent|company|taxpayer|firm|unit|info|list|panel|grid|cell|desc|detail|result|content/i;
  for (const el of document.querySelectorAll("[class]")) {
    const cls = String(el.getAttribute("class") || "");
    if (!blockClassRe.test(cls)) continue;
    const cells = [];
    const walk = (node) => {
      let own = "";
      if (node.childNodes) {
        for (const n of node.childNodes) if (n.nodeType === 3) own += n.textContent;
      }
      if (own) push(cells, clean(own));
      const kids = node.children || [];
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
    };
    walk(el);
    addRow(cells);
  }
  return { allowed: true, href: String(location.href || ""), title: String(document.title || "").slice(0, 120), rows };
})()`;

// ---------------------------------------------------------------- 浏览器探测 / 启动（真实实现）
/** 固定探测路径：只认本机官方安装位置，绝不由请求传入可执行文件路径。 */
export const DEFAULT_BROWSER_CANDIDATES = [
  {
    kind: "edge", label: "Microsoft Edge", paths: [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe") : null,
    ],
  },
  {
    kind: "chrome", label: "Google Chrome", paths: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : null,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ],
  },
];

export function findBrowserExecutable({ candidates = DEFAULT_BROWSER_CANDIDATES, exists = existsSync } = {}) {
  for (const group of candidates) {
    for (const p of group.paths) {
      if (p && exists(p)) return { found: true, kind: group.kind, label: group.label, path: p };
    }
  }
  return { found: false, kind: null, label: null, path: null };
}

const execFileP = (cmd, args) => new Promise((res, rej) => {
  execFile(cmd, args, { shell: false, timeout: 8000, windowsHide: true }, (e, stdout, stderr) => {
    if (e) rej(e); else res({ stdout: String(stdout || ""), stderr: String(stderr || "") });
  });
});

/**
 * 启动独立浏览器窗口（真实实现）。
 *   - execFile/spawn（shell:false）启动本机官方 Edge/Chrome，可执行文件路径只来自
 *     固定探测列表，绝不由请求传入；
 *   - --remote-debugging-port=0：调试端口由浏览器随机挑选，且默认只监听 127.0.0.1；
 *   - 独立随机临时 profile + incognito：不读用户常用 profile；
 *   - --edge-skip-compat-layer-relaunch：避免 Edge 兼容层把启动移交给新进程树
 *     （否则原进程立即退出、拿不到调试地址，且失去进程树父子关系无法定向清理）；
 *   - 调试地址双通道获取：stderr 的「DevTools listening on ws://127.0.0.1:...」
 *     与 profile 目录下的 DevToolsActivePort 文件（内容为 port + /devtools/browser/...）。
 *     endpoint 只在服务内部使用，不回传给任何调用方。
 * 返回进程句柄 { pid, profileDir, devtoolsUrl(), onExit(cb), kill() }。
 */
export function spawnBrowserProcess({ exePath, profileDir, entryUrl, timeoutMs = 30000 }) {
  if (!exePath || !profileDir || !entryUrl) {
    throw new TaxBrowserError("tax_browser_launch_failed", "浏览器启动参数不完整");
  }
  const args = [
    entryUrl,
    "--new-window",
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--incognito",
    "--no-first-run",
    "--no-default-browser-check",
    "--edge-skip-compat-layer-relaunch",
  ];
  let child;
  try {
    child = spawn(exePath, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    throw new TaxBrowserError("tax_browser_launch_failed", "无法启动本机浏览器窗口");
  }
  let wsUrl = null;
  let settled = false;
  let wsResolve = null;
  let wsReject = null;
  const wsPromise = new Promise((res, rej) => { wsResolve = res; wsReject = rej; });
  let stderrBuf = "";
  let exited = false;
  const exitWaiters = [];
  let pollTimer = null;
  let launchTimer = null;
  const settle = (url) => {
    if (settled) return;
    if (!isLoopbackDevtoolsUrl(url)) return; // 只认 ws://127.0.0.1:<port>/...
    settled = true;
    wsUrl = url;
    clearTimeout(launchTimer);
    if (pollTimer) clearInterval(pollTimer);
    wsResolve(wsUrl);
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (settled) return;
    stderrBuf = (stderrBuf + chunk).slice(-16384);
    const url = extractDevtoolsUrlFromStderr(stderrBuf);
    if (url) settle(url);
  });
  child.on("exit", (code, signal) => {
    exited = true;
    if (pollTimer) clearInterval(pollTimer);
    if (!settled) wsReject(new TaxBrowserError("tax_browser_browser_exited", "浏览器窗口在启动完成前已退出"));
    for (const w of exitWaiters.splice(0)) w({ code, signal });
  });
  child.on("error", () => {
    if (!settled) wsReject(new TaxBrowserError("tax_browser_launch_failed", "无法启动本机浏览器窗口"));
  });
  launchTimer = setTimeout(() => {
    if (!settled) wsReject(new TaxBrowserError("tax_browser_launch_timeout", `浏览器启动超时（未在 ${Math.round(timeoutMs / 1000)} 秒内就绪）`));
  }, timeoutMs);
  launchTimer.unref?.();
  // 双通道兜底：浏览器就绪后会把 port + 浏览器 WS 路径写入 <user-data-dir>/DevToolsActivePort。
  const activePortFile = join(profileDir, "DevToolsActivePort");
  pollTimer = setInterval(() => {
    if (settled || exited) { clearInterval(pollTimer); return; }
    try {
      const content = readFileSync(activePortFile, "utf8").trim().split(/\r?\n/);
      const port = Number(content[0]);
      const browserPath = String(content[1] || "");
      if (Number.isInteger(port) && port > 0 && port < 65536
        && /^\/devtools\/browser\/[0-9a-fA-F-]+$/.test(browserPath)) {
        settle(`ws://127.0.0.1:${port}${browserPath}`);
      }
    } catch { /* 文件尚未写好或不可读：继续轮询 */ }
  }, 150);
  pollTimer.unref?.();
  const exitPromise = new Promise((res) => { if (exited) res({}); else exitWaiters.push(res); });
  return {
    pid: child.pid,
    profileDir,
    devtoolsUrl: () => wsPromise,
    onExit: (cb) => { child.on("exit", cb); },
    kill: async () => {
      if (exited) return;
      try { child.kill(); } catch { /* ignore */ }
      let done = await Promise.race([exitPromise, delay(4000).then(() => null)]);
      if (!done && process.platform === "win32" && child.pid) {
        // 只杀本程序自己启动的那个进程树（/PID + /T），绝不批量清理用户的其他浏览器进程。
        await execFileP("taskkill", ["/PID", String(child.pid), "/T", "/F"]).catch(() => {});
        done = await Promise.race([exitPromise, delay(4000).then(() => null)]);
      }
    },
  };
}

// ---------------------------------------------------------------- CDP 连接（真实实现）
/**
 * 从浏览器 stderr 中提取 DevTools 调试地址。
 * 注意：仅匹配 `ws://127.0.0.1:<port>/...`（`ws:` 后必须带冒号），不匹配 `ws//`。
 */
export function extractDevtoolsUrlFromStderr(text) {
  const m = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s'"]+)/.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/**
 * 校验 CDP endpoint：必须是 ws://127.0.0.1:<有效端口>/<非空路径>。
 * 明确拒绝 localhost/0.0.0.0 等其它主机、非 ws 协议、userinfo（user:pass@）、
 * 缺失或越界端口，以及只有根路径的地址。
 */
export function isLoopbackDevtoolsUrl(wsUrl) {
  const raw = String(wsUrl ?? "");
  if (!raw || /\s/.test(raw)) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "ws:") return false;
  if (u.hostname !== "127.0.0.1") return false;
  if (u.username || u.password) return false;
  if (!u.port) return false;
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (!u.pathname || u.pathname === "/") return false;
  return true;
}

/**
 * 极简 CDP 客户端（Node >= 22 内置 WebSocket，无第三方依赖）。
 * 只用 Target/Runtime/Page 的少量只读命令；不启用 Network/Storage/DOMStorage 等域，
 * 从根上不抓 cookies / localStorage / 网络响应。
 */
export class CdpConnection {
  #ws = null;
  #WebSocketImpl = null;
  #nextId = 1;
  #pending = new Map();
  #closed = false;
  #openPromise = null;

  constructor(wsUrl, { openTimeoutMs = 8000, responseTimeoutMs = 20000, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.wsUrl = String(wsUrl ?? "");
    this.responseTimeoutMs = responseTimeoutMs;
    this.openTimeoutMs = openTimeoutMs;
    this.#WebSocketImpl = WebSocketImpl;
    if (typeof this.#WebSocketImpl !== "function") {
      throw new TaxBrowserError("tax_browser_connect_failed", "当前运行时没有可用的 WebSocket 客户端（需要 Node >= 22）");
    }
  }

  open() {
    if (this.#openPromise) return this.#openPromise;
    this.#openPromise = new Promise((resolveOpen, rejectOpen) => {
      let settled = false;
      let ws = null;
      const fail = (err) => { if (!settled) { settled = true; clearTimeout(timer); rejectOpen(err); } };
      const ok = () => { if (!settled) { settled = true; clearTimeout(timer); resolveOpen(this); } };
      let timer = null;
      try {
        ws = new this.#WebSocketImpl(this.wsUrl);
      } catch {
        rejectOpen(new TaxBrowserError("tax_browser_connect_failed", "无法建立本地浏览器调试连接"));
        return;
      }
      this.#ws = ws;
      timer = setTimeout(() => {
        fail(new TaxBrowserError("tax_browser_connect_failed", "连接本地浏览器调试通道超时"));
        try { ws.close(); } catch { /* ignore */ }
      }, this.openTimeoutMs);
      ws.addEventListener("open", ok);
      ws.addEventListener("error", () => fail(new TaxBrowserError("tax_browser_connect_failed", "本地浏览器调试连接失败（浏览器可能已退出）")));
      ws.addEventListener("close", () => {
        this.#markClosed();
        fail(new TaxBrowserError("tax_browser_cdp_closed", "本地浏览器调试连接已关闭"));
      });
      ws.addEventListener("message", (ev) => {
        let msg = null;
        try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
        if (!msg || msg.id === undefined || !this.#pending.has(msg.id)) return;
        const p = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          // 不携带浏览器返回的原始错误内容（可能含页面/凭据信息）；只返回固定安全文案。
          p.reject(new TaxBrowserError("tax_browser_cdp_error", `CDP 命令失败（${p.method}）`));
        } else {
          p.resolve(msg.result ?? {});
        }
      });
    });
    return this.#openPromise;
  }

  #markClosed() {
    this.#closed = true;
    const err = new TaxBrowserError("tax_browser_cdp_closed", "本地浏览器调试连接已关闭");
    for (const [, p] of this.#pending) { clearTimeout(p.timer); p.reject(err); }
    this.#pending.clear();
  }

  send(method, params = {}, { sessionId } = {}) {
    if (this.#closed) return Promise.reject(new TaxBrowserError("tax_browser_cdp_closed", "本地浏览器调试连接已关闭"));
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolveMsg, rejectMsg) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectMsg(new TaxBrowserError("tax_browser_cdp_timeout", `CDP 命令超时（${method}）`));
      }, this.responseTimeoutMs);
      this.#pending.set(id, { resolve: resolveMsg, reject: rejectMsg, timer, method });
      try {
        this.#ws.send(JSON.stringify(message));
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        rejectMsg(new TaxBrowserError("tax_browser_cdp_closed", "本地浏览器调试连接已关闭"));
      }
    });
  }

  close() {
    if (this.#closed) return;
    this.#markClosed();
    try { this.#ws?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 超时工具
function withTimeout(promise, ms, makeError) {
  let timer = null;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(makeError()), ms); });
  // 被放弃的 promise 稍后 reject 也不能变成 unhandledRejection
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function originOf(href) {
  try {
    return new URL(String(href)).origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 服务本体
export const DEFAULT_TAX_BROWSER_LIMITS = {
  maxSessions: 3,             // 同时打开的采集会话上限
  sessionTtlMs: 30 * 60 * 1000, // 会话绝对存活时间
  readTimeoutMs: 20 * 1000,   // 单次页面读取超时
  launchTimeoutMs: 30 * 1000, // 浏览器启动就绪超时
  loginTokenTtlMs: 10 * 60 * 1000, // 登录令牌（CSRF 同源令牌）有效期
  maxLoginTokens: 64,         // 未消费登录令牌上限
  maxCandidates: 200,         // 单会话累计候选企业上限
  keepClosedSessions: 32,     // 已关闭会话的内存保留条数（便于查询终态）
};

/**
 * TaxBrowserService：会话、浏览器、读取、关闭与导入编排。
 * 依赖均可注入（launchBrowser / connectBrowser / importer / now / exists），
 * 生产 server.mjs 用真实实现；测试用假浏览器 + fixtures，生产 HTTP 无任何 fake 开关。
 */
export class TaxBrowserService {
  #ownProfileRoot = false;
  #ownProfileRootPath = null; // 构造器自建根的不可变绝对路径（注入外部 root 时为 null）
  #createdProfileDirs = new Set();
  #destroyed = false;

  constructor({
    now = () => Date.now(),
    launchBrowser = spawnBrowserProcess,
    connectBrowser = async (wsUrl, opts) => {
      if (!isLoopbackDevtoolsUrl(wsUrl)) throw new TaxBrowserError("tax_browser_connect_failed", "浏览器调试地址不合法（仅允许本机回环）");
      const conn = new CdpConnection(wsUrl, { responseTimeoutMs: (opts?.responseTimeoutMs ?? 20000) + 5000 });
      await conn.open();
      return conn;
    },
    browserCandidates = DEFAULT_BROWSER_CANDIDATES,
    fileExists = existsSync,
    profileRootDir = null,
    importer = null,
    limits = {},
    log = () => {},
  } = {}) {
    this.now = now;
    this.launchBrowser = launchBrowser;
    this.connectBrowser = connectBrowser;
    this.browserCandidates = browserCandidates;
    this.fileExists = fileExists;
    this.importer = importer;
    this.log = log;
    this.limits = { ...DEFAULT_TAX_BROWSER_LIMITS, ...limits };
    this.#ownProfileRoot = profileRootDir === null;
    this.profileRoot = profileRootDir ?? mkdtempSync(join(tmpdir(), "youshu-tax-browser-"));
    // 冻结自建根的绝对路径：后续 profileRoot 被改写也不影响对「哪个根可删」的判断。
    this.#ownProfileRootPath = this.#ownProfileRoot ? resolve(this.profileRoot) : null;
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    /** @type {Map<string, {expiresAt:number}>} 登录令牌（CSRF）：单次使用、短 TTL */
    this.loginTokens = new Map();
  }

  /** 测试/诊断用：当前由本程序创建、尚未清理的 profile 目录列表（只读副本）。 */
  listCreatedProfileDirs() { return [...this.#createdProfileDirs]; }

  // ------------------------------------------------------------ 只读配置
  describeConfig() {
    const browser = findBrowserExecutable({ candidates: this.browserCandidates, exists: this.fileExists });
    return {
      mode: "manual-browser",
      productTarget: "全国电子税务局接入是长期目标；本期实现福建省漳州市的「浏览器人工登录 + 本地只读采集」导入，其他地区明确未支持。",
      supported: listSupportedRegions(),
      unsupportedNote: "除上列地区外均未支持（未接入、不可登录）；全国覆盖目标保留，后续按地区逐一联调。",
      browser: {
        found: browser.found,
        kind: browser.found ? browser.kind : null,
        label: browser.found ? `本机已安装 ${browser.label}` : "未找到本机 Chrome/Edge：请安装官方浏览器后重试",
      },
      limits: {
        maxSessions: this.limits.maxSessions,
        sessionTtlMinutes: Math.round(this.limits.sessionTtlMs / 60000),
        readTimeoutSeconds: Math.round(this.limits.readTimeoutMs / 1000),
        loginTokenTtlSeconds: Math.round(this.limits.loginTokenTtlMs / 1000),
      },
      privacy: {
        credentials: "本服务不接收、不存储账号/密码/验证码/扫码结果；登录全部由用户在官方窗口自行完成。",
        pageAccess: "只在固定白名单来源页面执行一段固定的只读 DOM 脚本；不抓 cookies/token/localStorage/密码，不监听网络响应。",
        preview: "返回内容仅含企业名称、纳税人识别号、读取计数与不含 query/fragment 的来源，用于本地建账。",
        close: "关闭会话只结束本地采集并清理临时 profile，不代表已从税局服务端退出。",
      },
      note: "GET 只读：本接口不启动浏览器、不读取税局页面。",
    };
  }

  // ------------------------------------------------------------ 登录令牌（同源 CSRF 令牌）
  issueLoginToken() {
    if (this.#destroyed) {
      throw new TaxBrowserError("tax_browser_service_stopped", "服务已停止：不能签发新的登录令牌");
    }
    const token = `taxlt_${randomBytes(24).toString("base64url")}`;
    this.loginTokens.set(token, { expiresAt: this.now() + this.limits.loginTokenTtlMs });
    while (this.loginTokens.size > this.limits.maxLoginTokens) {
      this.loginTokens.delete(this.loginTokens.keys().next().value);
    }
    return token;
  }

  #consumeLoginToken(token) {
    const key = str(token);
    if (!key) return false;
    const entry = this.loginTokens.get(key);
    if (!entry) return false;
    this.loginTokens.delete(key); // 单次使用
    if (this.now() >= entry.expiresAt) return false;
    return true;
  }

  // ------------------------------------------------------------ 会话生命周期
  async openSession({ region, city, loginToken } = {}) {
    if (this.#destroyed) {
      throw new TaxBrowserError("tax_browser_service_stopped", "服务已停止：不能打开新的采集会话");
    }
    const spec = resolveSupportedRegion(region, city); // 先校验地区，再消费令牌（可重试）
    if (!this.#consumeLoginToken(loginToken)) {
      throw new TaxBrowserError("tax_browser_login_token_invalid", "登录令牌无效或已过期：请先 GET /api/tax-browser/config 获取（仅本地合法来源可取得）");
    }
    this.#sweep();
    const openCount = [...this.sessions.values()].filter((s) => s.status === "open").length;
    if (openCount >= this.limits.maxSessions) {
      throw new TaxBrowserError("tax_browser_limit_reached", `同时进行的采集会话已达上限（${this.limits.maxSessions}）：请先关闭已有会话`);
    }
    const browser = findBrowserExecutable({ candidates: this.browserCandidates, exists: this.fileExists });
    if (!browser.found) {
      throw new TaxBrowserError("tax_browser_not_installed", "未找到本机 Chrome/Edge：请安装官方 Chrome 或 Edge 后重试");
    }
    const profileDir = mkdtempSync(join(this.profileRoot, "profile-"));
    this.#createdProfileDirs.add(profileDir);
    const sessionId = `taxb_${randomBytes(24).toString("base64url")}`;
    const nowMs = this.now();
    const session = {
      sessionId, spec, region: spec.region, city: spec.city,
      status: "open", closeReason: null, cleaned: false,
      createdAt: nowMs, updatedAt: nowMs, expiresAt: nowMs + this.limits.sessionTtlMs,
      browserKind: browser.kind,
      proc: null, conn: null, pageTargetId: null, cdpSessionId: null,
      profileDir,
      collected: new Map(), candidateSeq: 0,
      pagesRead: 0, lastReadAt: null, source: null,
      ttlTimer: null, cleanupPromise: null, removeAttempts: 0, launchSettled: false,
    };
    this.sessions.set(sessionId, session);
    this.#pruneClosed();
    this.#armTtl(session);
    try {
      if (this.#destroyed) {
        throw new TaxBrowserError("tax_browser_service_stopped", "服务已停止：不能打开新的采集会话");
      }
      const proc = await this.launchBrowser({
        exePath: browser.path,
        profileDir,
        entryUrl: spec.entryUrl,
        timeoutMs: this.limits.launchTimeoutMs,
      });
      session.proc = proc; // 先绑定句柄再复核终态，保证任何后续清理都杀得到这个进程
      proc.onExit?.(() => this.#onBrowserExit(session));
      if (session.status !== "open") {
        throw new TaxBrowserError("tax_browser_session_closed", "会话在启动完成前已被关闭或过期");
      }
      const wsUrl = await proc.devtoolsUrl();
      if (session.status !== "open") {
        throw new TaxBrowserError("tax_browser_session_expired", "会话在等待调试地址期间已被关闭或过期");
      }
      if (!isLoopbackDevtoolsUrl(wsUrl)) {
        throw new TaxBrowserError("tax_browser_connect_failed", "浏览器调试地址不合法（仅允许本机回环）");
      }
      const conn = await this.connectBrowser(wsUrl, { responseTimeoutMs: this.limits.readTimeoutMs });
      session.conn = conn; // 先绑定连接再复核终态，迟到连接不会泄漏
      if (session.status !== "open") {
        throw new TaxBrowserError("tax_browser_session_closed", "会话在建立调试连接期间已被关闭或过期");
      }
      await this.#attachPage(session);
      if (session.status !== "open") {
        throw new TaxBrowserError("tax_browser_session_closed", "会话在附加页面期间已被关闭或过期");
      }
    } catch (e) {
      session.launchSettled = true;
      const lateTerminal = session.status !== "open"; // 提前 close/expire/destroy：保留终态，不当作启动失败
      if (!lateTerminal) {
        session.status = "closed";
        session.closeReason = "launch_failed";
      }
      this.log(`[tax-browser] session ${sessionId.slice(0, 10)} 启动未完成：${lateTerminal ? session.closeReason : safeErrorCode(e, "tax_browser_launch_failed")}`);
      await this.#cleanup(session, { kill: true }).catch(() => {});
      if (lateTerminal) {
        // 关闭/过期/停止优先：绝不把已关闭的会话当成功返回
        if (session.status === "expired") {
          throw new TaxBrowserError("tax_browser_session_expired", "会话在启动过程中已过期（数据已销毁），请重新打开官方登录窗口");
        }
        throw new TaxBrowserError("tax_browser_session_closed", `会话已关闭，未返回成功（${this.#closedMessage(session)}）`);
      }
      this.sessions.delete(sessionId); // 启动失败：不保留无资源的失败会话
      if (e instanceof TaxBrowserError) throw e;
      throw new TaxBrowserError("tax_browser_launch_failed", "浏览器窗口启动失败，请重试");
    }
    // 最后一次终态复核：close/expire/destroy 在 await 之间已接管资源时不得返回成功。
    session.launchSettled = true;
    if (session.status !== "open") {
      await this.#cleanup(session, { kill: true }).catch(() => {});
      if (session.status === "expired") {
        throw new TaxBrowserError("tax_browser_session_expired", "会话已过期（数据已销毁），请重新打开官方登录窗口");
      }
      throw new TaxBrowserError("tax_browser_session_closed", `会话已关闭（${this.#closedMessage(session)}）`);
    }
    session.updatedAt = this.now();
    this.#armTtl(session);
    this.log(`[tax-browser] session ${sessionId.slice(0, 10)} 已打开官方登录窗口（${browser.kind}）`);
    return {
      ...this.#view(session),
      manualLogin: {
        instructions: [
          `已在新窗口打开 ${spec.entryUrl}（官方电子税务局入口）。`,
          "请在该窗口中自行完成登录（账号/验证码/扫码均可）；本服务不接收任何凭据。",
          `只有 ${spec.allowedOrigins.join("、")} 来源的页面才会被读取；其它域名一律拒绝。`,
          "登录后进入「办税员可访问企业」或身份切换的企业列表页，再回到本页点击「读取当前企业页」。",
          "可手动翻页并多次读取，系统按税号合并；仅记录已读取页面，不代表全部企业。",
        ],
        note: "打开窗口不代表已登录；只有成功读取到带标签的企业列表才返回数据。",
      },
    };
  }

  async #attachPage(session) {
    const spec = session.spec;
    const { targetInfos = [] } = await session.conn.send("Target.getTargets");
    const pages = targetInfos.filter((t) => t && t.type === "page");
    let info = pages.find((t) => this.#isAllowedUrl(session, t.url));
    let needNavigate = false;
    if (!info && pages.length > 0) { info = pages[0]; needNavigate = true; }
    if (!info) {
      const created = await session.conn.send("Target.createTarget", { url: spec.entryUrl });
      info = { targetId: created.targetId };
    }
    const attached = await session.conn.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
    session.pageTargetId = info.targetId;
    session.cdpSessionId = attached.sessionId;
    if (needNavigate) {
      await session.conn.send("Page.navigate", { url: spec.entryUrl }, { sessionId: session.cdpSessionId });
    }
  }

  #isAllowedUrl(session, url) {
    const origin = originOf(url);
    return !!origin && session.spec.allowedOrigins.includes(origin);
  }

  #onBrowserExit(session) {
    if (session.status !== "open") return;
    session.status = "closed";
    session.closeReason = "browser_exit";
    session.updatedAt = this.now();
    this.log(`[tax-browser] session ${session.sessionId.slice(0, 10)} 浏览器窗口被用户关闭`);
    this.#cleanup(session, { kill: false }).catch(() => {}); // 浏览器已退出，无需再杀
  }

  async #evaluate(session, expression) {
    const result = await session.conn.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: false },
      { sessionId: session.cdpSessionId }
    );
    if (result && result.exceptionDetails) {
      throw new TaxBrowserError("tax_browser_read_failed", "页面脚本执行失败：页面可能正在跳转或已关闭，请稍后重试");
    }
    return result?.result?.value;
  }

  async #evaluateWithTimeout(session, expression) {
    try {
      return await withTimeout(
        this.#evaluate(session, expression),
        this.limits.readTimeoutMs,
        () => new TaxBrowserError("tax_browser_read_timeout", `读取超时（${Math.round(this.limits.readTimeoutMs / 1000)} 秒）：页面可能仍在加载，请稍后重试`)
      );
    } catch (e) {
      if (e instanceof TaxBrowserError) {
        if (e.code === "tax_browser_cdp_timeout") {
          throw new TaxBrowserError("tax_browser_read_timeout", `读取超时（${Math.round(this.limits.readTimeoutMs / 1000)} 秒）：页面可能仍在加载，请稍后重试`);
        }
        if (e.code === "tax_browser_cdp_closed" || e.code === "tax_browser_browser_exited") {
          throw new TaxBrowserError("tax_browser_read_failed", "浏览器连接已关闭：请确认浏览器窗口仍打开着企业列表页，必要时重新打开会话");
        }
        if (e.code === "tax_browser_cdp_error") {
          throw new TaxBrowserError("tax_browser_read_failed", "页面读取失败：页面可能正在跳转或已关闭，请稍后重试");
        }
      }
      throw e;
    }
  }

  /** 读取当前页面的企业列表（仅允许白名单来源页面）。 */
  async readCurrentPage({ sessionId } = {}) {
    const session = this.#requireSession(sessionId);
    this.#refreshExpiry(session);
    this.#assertUsable(session, "读取");

    let href;
    try {
      href = await this.#evaluateWithTimeout(session, "location.href");
    } catch (e) {
      this.#guardLate(session, e); // 终态优先；否则抛原始读取错误
    }
    this.#guardLate(session);
    const hrefOrigin = originOf(href);
    if (!hrefOrigin || !session.spec.allowedOrigins.includes(hrefOrigin)) {
      throw new TaxBrowserError("tax_browser_page_not_supported", "当前页面不在允许来源（电子税务局官方域名）内：请先在浏览器窗口打开「办税员可访问企业」列表页，再读取", { allowed: [...session.spec.allowedOrigins] });
    }

    let snapshot;
    try {
      snapshot = await this.#evaluateWithTimeout(session, READ_PAGE_SCRIPT);
    } catch (e) {
      this.#guardLate(session, e); // 终态优先；否则抛原始读取错误
    }
    // 并发关闭/超时/浏览器退出：迟到结果一律丢弃，绝不把数据写回会话。
    this.#guardLate(session);

    // 脚本内已先校验白名单 origin（错误 origin 根本不访问 document）；这里再复核一次。
    if (snapshot && snapshot.allowed === false) {
      throw new TaxBrowserError("tax_browser_page_not_supported", "当前页面不在允许来源（电子税务局官方域名）内：请先在浏览器窗口打开「办税员可访问企业」列表页，再读取", { allowed: [...session.spec.allowedOrigins] });
    }
    const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
    const snapshotOrigin = originOf(snapshot?.href) || hrefOrigin;
    if (!session.spec.allowedOrigins.includes(snapshotOrigin)) {
      throw new TaxBrowserError("tax_browser_page_not_supported", "读取期间页面发生跳转且不在允许来源内，本次结果已丢弃；请回到企业列表页后重试");
    }
    const extracted = extractEnterprisesFromCells(rows);
    if (extracted.items.length === 0) {
      if (extracted.matchedRows > 0) {
        throw new TaxBrowserError("tax_browser_no_valid_records", "识别到疑似企业记录，但税号严格校验未通过：请确认页面是企业列表（统一社会信用代码/纳税人识别号完整可见）后重读");
      }
      throw new TaxBrowserError("tax_browser_layout_unrecognized", "当前页面未识别到带「企业名称/纳税人名称」+「统一社会信用代码/纳税人识别号」标签的企业记录：请打开办税员可访问企业列表页后重读（不猜测、不伪造企业数据）");
    }

    let newCount = 0;
    for (const item of extracted.items) {
      if (session.collected.size >= this.limits.maxCandidates) break;
      const existing = session.collected.get(item.taxpayerId);
      if (existing) {
        existing.occurrences += item.occurrences;
        existing.lastSeenAt = this.now();
        continue;
      }
      newCount++;
      session.collected.set(item.taxpayerId, {
        candidateId: `c_${++session.candidateSeq}`,
        taxpayerId: item.taxpayerId,
        name: item.name,
        occurrences: item.occurrences,
        firstSeenAt: this.now(),
        lastSeenAt: this.now(),
      });
    }
    session.pagesRead++;
    session.lastReadAt = this.now();
    session.source = snapshotOrigin; // 不含 query/fragment
    session.updatedAt = this.now();
    return { session: this.#view(session), read: this.#preview(session), newCount };
  }

  /** 查询会话状态与已累积的企业预览（只读）。 */
  getSession({ sessionId } = {}) {
    const session = this.#requireSession(sessionId);
    this.#sweep();
    this.#refreshExpiry(session);
    if (session.status === "closed") {
      throw new TaxBrowserError("tax_browser_session_closed", this.#closedMessage(session));
    }
    if (session.status === "expired") {
      throw new TaxBrowserError("tax_browser_session_expired", "会话已过期（数据已销毁），请重新打开官方登录窗口");
    }
    return { session: this.#view(session), preview: this.#preview(session) };
  }

  /**
   * 导入：只接受本服务端会话采集结果中的候选 ID；请求里的企业对象一律忽略。
   * items 由会话数据重建（含税号），importer 再做一次严格校验。
   * 注意：请求体的 mode/create/accountSetId/dryRun/confirmNameChange 之外的字段
   * （尤其 items/region/city/source）一律不透传，防止伪造企业对象或溯源字段。
   */
  async importCandidates({ sessionId, candidateIds, mode, create, accountSetId, dryRun = false, confirmNameChange = false, ...ignored } = {}) {
    if (this.#destroyed) {
      throw new TaxBrowserError("tax_browser_service_stopped", "服务已停止：不能导入");
    }
    if (Object.keys(ignored).some((k) => ["items", "region", "city", "source"].includes(k))) {
      throw new TaxBrowserError("tax_browser_request_field_rejected", `不支持的字段：${Object.keys(ignored).filter((k) => ["items", "region", "city", "source"].includes(k)).join("/")}；企业对象与溯源信息只能来自服务端会话采集结果`);
    }
    const session = this.#requireSession(sessionId);
    this.#refreshExpiry(session);
    this.#assertUsable(session, "导入");
    if (!Array.isArray(candidateIds) || candidateIds.length === 0 || candidateIds.length > this.limits.maxCandidates) {
      throw new TaxBrowserError("tax_browser_candidates_invalid", "candidateIds 必须是非空数组（来自读取结果），且不超过会话候选上限");
    }
    const items = candidateIds.map((rawId) => {
      const candidateId = str(rawId);
      const hit = session.collected.get(candidateId)
        ?? [...session.collected.values()].find((c) => c.candidateId === candidateId);
      if (!hit) {
        throw new TaxBrowserError("tax_browser_candidate_not_found", `候选 ${maskTaxpayerId(candidateId)} 不在本会话采集结果中：导入只接受服务端会话返回的候选 ID，不接受前端伪造的企业对象`);
      }
      return {
        candidateId: hit.candidateId,
        name: hit.name,
        taxpayerId: hit.taxpayerId,
        firstSeenAt: iso(hit.firstSeenAt),
        lastSeenAt: iso(hit.lastSeenAt),
      };
    });
    if (typeof this.importer !== "function") {
      throw new TaxBrowserError("tax_browser_import_unavailable", "当前服务未接入导入实现");
    }
    try {
      const result = await this.importer({
        items,
        region: session.region,
        city: session.city,
        source: `tax-browser:${session.spec.key}`,
        mode,
        create,
        accountSetId,
        dryRun: dryRun === true,
        confirmNameChange: confirmNameChange === true,
      });
      session.updatedAt = this.now();
      return result;
    } catch (e) {
      this.log(`[tax-browser] session ${session.sessionId.slice(0, 10)} 导入失败：${safeErrorCode(e, "tax_browser_import_failed")}`);
      throw e;
    }
  }

  /** 关闭本地采集会话：终止浏览器进程、销毁候选数据、删除临时 profile。幂等。 */
  async closeSession({ sessionId } = {}) {
    const session = this.#requireSession(sessionId);
    if (session.status === "open") {
      session.status = "closed";
      session.closeReason = "user";
      session.updatedAt = this.now();
    }
    await this.#cleanup(session, { kill: session.closeReason !== "browser_exit" });
    this.log(`[tax-browser] session ${session.sessionId.slice(0, 10)} 已关闭（${session.closeReason}）`);
    return this.#view(session);
  }

  /** 服务销毁（进程退出时调用）：关闭全部会话并清理本程序创建的 profile；之后拒绝新会话/令牌。 */
  async destroy() {
    this.#destroyed = true;
    this.loginTokens.clear();
    for (const session of [...this.sessions.values()]) {
      if (session.status === "open") {
        session.status = "closed";
        session.closeReason = "shutdown";
        session.updatedAt = this.now();
      }
      this.#disarmTtl(session);
      await this.#cleanup(session, { kill: true }).catch(() => {});
    }
    this.sessions.clear();
    // 自建根只做「非递归删除空目录」：仍登记的 profile（含未决 launch）必须保留，
    // 等迟到清理结束 → 子目录删除 → 空根删除；注入的外部 root 永不删除。
    this.#removeEmptyOwnRoot();
  }

  /**
   * 尝试删除构造器自建的空 profile 根（非递归、只删空目录）。
   *   - 使用构造时保存的不可变绝对路径，绝不对后来被改写的 public profileRoot 删除根；
   *   - 仍有登记 profile（如未决 launch）或根非空时保留，等待迟到清理再次调用；
   *   - 删除失败只写固定安全日志，不抛出路径原文，也不丢弃不可变路径这一可重试引用。
   */
  #removeEmptyOwnRoot() {
    const root = this.#ownProfileRootPath;
    if (!root) return; // 注入的外部 root：永不删除
    if (this.#createdProfileDirs.size > 0) return; // 尚有登记 profile：保留
    if (!existsSync(root)) return;
    try {
      rmdirSync(root); // 非递归：只删除空目录；根非空会抛错并被捕获
    } catch {
      this.log("[tax-browser] 自建 profile 根暂未清空，保留待重试：tax_browser_profile_root_deferred");
    }
  }

  // ------------------------------------------------------------ 内部
  #requireSession(raw) {
    const sessionId = str(raw);
    if (!sessionId) throw new TaxBrowserError("tax_browser_session_id_required", "缺少 sessionId");
    const session = this.sessions.get(sessionId);
    if (!session) throw new TaxBrowserError("tax_browser_session_not_found", "未知或已清理的会话：请重新打开官方登录窗口");
    return session;
  }

  #assertUsable(session, action) {
    if (session.status === "closed") {
      throw new TaxBrowserError("tax_browser_session_closed", `会话已关闭，不能${action}：${this.#closedMessage(session)}`);
    }
    if (session.status === "expired") {
      throw new TaxBrowserError("tax_browser_session_expired", `会话已过期（数据已销毁），不能${action}：请重新打开官方登录窗口`);
    }
  }

  /** await 之后的终态复核：关闭/过期后迟到的一律失败，数据不得恢复。 */
  #guardLate(session, caughtError) {
    this.#refreshExpiry(session);
    if (session.status === "closed") {
      throw new TaxBrowserError("tax_browser_session_closed", `会话已关闭，本次读取结果已丢弃（${this.#closedMessage(session)}）`);
    }
    if (session.status === "expired") {
      throw new TaxBrowserError("tax_browser_session_expired", "会话已过期，本次读取结果已丢弃：请重新打开官方登录窗口");
    }
    if (caughtError) throw caughtError;
  }

  #closedMessage(session) {
    const reasons = {
      user: "本地采集会话已被用户关闭（不代表已从税局服务端退出）",
      browser_exit: "浏览器窗口已关闭",
      shutdown: "服务已停止",
    };
    return reasons[session.closeReason] || "本地采集会话已关闭";
  }

  #refreshExpiry(session) {
    if (session.status !== "open") return;
    if (this.now() >= session.expiresAt) {
      this.#expire(session);
    }
  }

  /** 标记过期并异步清理；幂等。 */
  #expire(session) {
    if (session.status !== "open") return;
    session.status = "expired";
    session.updatedAt = this.now();
    this.#disarmTtl(session);
    this.log(`[tax-browser] session ${session.sessionId.slice(0, 10)} 已过期`);
    this.#cleanup(session, { kill: true }).catch(() => {}); // 过期同样清理浏览器与 profile
  }

  /** 会话 TTL 到点主动清理（timer unref，不阻滞进程退出；关闭/destroy 会清 timer）。 */
  #armTtl(session) {
    this.#disarmTtl(session);
    if (session.status !== "open" || this.#destroyed) return;
    const ms = Math.max(0, session.expiresAt - this.now());
    session.ttlTimer = setTimeout(() => { session.ttlTimer = null; this.#expire(session); }, ms);
    session.ttlTimer.unref?.();
  }

  #disarmTtl(session) {
    if (session.ttlTimer) {
      try { clearTimeout(session.ttlTimer); } catch { /* ignore */ }
      session.ttlTimer = null;
    }
  }

  #sweep() {
    for (const session of this.sessions.values()) this.#refreshExpiry(session);
  }

  #pruneClosed() {
    const closed = [...this.sessions.values()].filter((s) => s.status !== "open");
    if (closed.length > this.limits.keepClosedSessions) {
      for (const s of closed.slice(0, closed.length - this.limits.keepClosedSessions)) this.sessions.delete(s.sessionId);
    }
  }

  /**
   * 资源清理：销毁候选数据、关 CDP、杀进程、删本程序创建的 profile（严格校验路径）。
   * 并发幂等：同一会话并发调用共享同一个 promise，不重复/漏杀；先按捕获句柄清理
   * 再置 null，不会因提前置 null 而漏 kill。
   */
  #cleanup(session, { kill }) {
    this.#disarmTtl(session);
    if (session.cleanupPromise) return session.cleanupPromise;
    session.collected.clear(); // 销毁已识别企业候选
    session.pagesRead = 0;
    session.source = null;
    // 循环清理：启动/连接正在 await 时，句柄可能在清理后又落到会话上，循环保证不漏杀。
    session.cleanupPromise = (async () => {
      for (;;) {
        const proc = session.proc;
        const conn = session.conn;
        // 先尝试 CDP Browser.close 优雅关闭（对 relaunch/进程树异常的情况也能关掉整个浏览器）
        if (kill && conn) {
          try {
            await withTimeout(
              conn.send("Browser.close", {}, {}),
              3000,
              () => new TaxBrowserError("tax_browser_cdp_timeout", "Browser.close 超时")
            );
          } catch { /* 优雅关闭失败时退回强制终止 */ }
        }
        try { conn?.close?.(); } catch { /* ignore */ }
        if (session.conn === conn) session.conn = null;
        if (kill && proc) {
          try { await proc.kill?.(); } catch { /* ignore */ }
        }
        if (session.proc === proc) session.proc = null;
        if (session.proc || session.conn) continue; // 清理期间又来了迟到句柄，再清一轮
        // 启动尚未落定时不删 profile：浏览器可能正在写入；启动复核会再次调用清理。
        if (session.launchSettled) await this.#removeProfile(session);
        break;
      }
      session.cleaned = true;
    })().finally(() => { session.cleanupPromise = null; }); // 允许后续（迟到句柄/重试）再次清理
    return session.cleanupPromise;
  }

  async #removeProfile(session) {
    const dir = session.profileDir;
    // 只删除本程序在指定根下创建、且登记在案的目录；路径不合法一律不动。
    if (!dir || !this.#createdProfileDirs.has(dir)) {
      if (dir) session.profileDir = null;
      if (this.#destroyed) this.#removeEmptyOwnRoot();
      return;
    }
    const root = resolve(this.profileRoot);
    const target = resolve(dir);
    const inRoot = target !== root && target.startsWith(root + sep);
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        if (inRoot) rmSync(target, { recursive: true, force: true });
        // 删除成功，或路径不在本程序根内（外部 root）：停止跟踪，不删除外部 root。
        if (session.profileDir === dir) session.profileDir = null;
        this.#createdProfileDirs.delete(dir);
        // 定向子目录清理完成后，再尝试删除已 destroyed 服务自己的空根目录。
        if (this.#destroyed) this.#removeEmptyOwnRoot();
        return;
      } catch {
        // 失败则保留登记，允许后续再次重试（不执行 rm -rf 之外的破坏操作）。
        session.removeAttempts = (session.removeAttempts || 0) + 1;
        if (session.removeAttempts >= 60) {
          this.log("[tax-browser] profile 清理重试上限，保留待重试：tax_browser_profile_remove_deferred");
          return;
        }
        await delay(400);
      }
    }
  }

  #view(session) {
    return {
      sessionId: session.sessionId,
      status: session.status,
      closeReason: session.closeReason,
      region: session.region,
      city: session.city,
      regionLabel: session.spec.label,
      entryUrl: session.spec.entryUrl,
      browser: { kind: session.browserKind },
      createdAt: iso(session.createdAt),
      updatedAt: iso(session.updatedAt),
      expiresAt: iso(session.expiresAt),
      pagesRead: session.pagesRead,
      collectedCount: session.collected.size,
      lastReadAt: session.lastReadAt ? iso(session.lastReadAt) : null,
      source: session.source,
      note: "会话仅存在于本地进程内存；关闭只结束本地采集并清理临时 profile，不代表已从税局服务端退出。",
    };
  }

  #preview(session) {
    const items = [...session.collected.values()];
    return {
      count: items.length,
      pagesRead: session.pagesRead,
      source: session.source,
      lastReadAt: session.lastReadAt ? iso(session.lastReadAt) : null,
      items: items.map((c) => ({
        candidateId: c.candidateId,
        name: c.name,
        taxpayerId: c.taxpayerId,
        occurrences: c.occurrences,
        firstSeenAt: iso(c.firstSeenAt),
        lastSeenAt: iso(c.lastSeenAt),
      })),
      note: "仅包含已读取页面中识别到的企业（按税号合并）；未翻到的页面不在其中，不代表税局返回的全部企业。",
    };
  }
}
