// Selected launch/CDP primitives from PR #19, with private-profile verification.
// No endpoint, process ID, profile path or browser response is returned by tools.
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, chmod, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";

const MESSAGES = Object.freeze({
  tax_browser_input_invalid: "参数不符合本机浏览器工具契约",
  tax_browser_region_unsupported: "当前只支持福建地区",
  tax_browser_not_installed: "未找到本机 Microsoft Edge",
  tax_browser_profile_failed: "未能创建并验证受限临时浏览器目录",
  tax_browser_cleanup_failed: "本次浏览器临时目录尚未安全清理",
  tax_browser_launch_failed: "专用浏览器启动失败",
  tax_browser_launch_timeout: "专用浏览器启动超时",
  tax_browser_connect_failed: "无法建立本机浏览器连接",
  tax_browser_cdp_error: "本机浏览器命令执行失败",
  tax_browser_cdp_timeout: "本机浏览器命令超时",
  tax_browser_cdp_closed: "本机浏览器连接已关闭",
  tax_browser_close_failed: "专用浏览器尚未确认关闭",
  tax_browser_connection_not_found: "本机浏览器连接不存在",
  tax_browser_connection_closed: "本机浏览器连接已关闭",
  tax_browser_limit_reached: "已有专用浏览器连接，请先关闭",
  tax_browser_probe_busy: "当前连接已有读取操作",
  tax_browser_shutting_down: "本机浏览器服务正在关闭，不再接受新连接",
  tax_browser_scope_changed: "页面或连接发生变化，已丢弃读取结果",
  tax_browser_response_invalid: "浏览器返回的安全摘要不符合契约",
  tax_browser_internal: "本机浏览器操作失败",
});

export class TaxBrowserError extends Error {
  constructor(code) {
    const safe = Object.hasOwn(MESSAGES, code) ? code : "tax_browser_internal";
    super(MESSAGES[safe]);
    this.name = "TaxBrowserError";
    this.code = safe;
  }
}

export function isLoopbackDevtoolsUrl(value) {
  if (typeof value !== "string" || /\s/.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === "ws:" && u.hostname === "127.0.0.1"
      && !u.username && !u.password && !u.search && !u.hash
      && /^\d+$/.test(u.port) && Number(u.port) > 0 && Number(u.port) <= 65535
      && /^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(u.pathname);
  } catch { return false; }
}

export function findEdgeExecutable({ exists = existsSync, candidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe") : null,
] } = {}) {
  return candidates.find((path) => typeof path === "string" && exists(path)) || null;
}

function runFile(executable, args, options = {}, execFileImpl = execFile) {
  return new Promise((accept, reject) => {
    execFileImpl(executable, args, { shell: false, windowsHide: true, timeout: 10000,
      maxBuffer: 16384, ...options }, (error, stdout) => error ? reject(error) : accept(String(stdout || "")));
  });
}

// The ACL is set before Edge is launched and then read back, not merely assumed.
const PROFILE_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = $env:TAX_BROWSER_PRIVATE_PROFILE
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if ([System.IO.Directory]::GetAccessControl($target).GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner-before' }
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
# The freshly created directory must already be owned by this user (checked below).
# Do not request WRITE_OWNER merely to set the same owner again; only set its DACL.
$acl.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagate = [System.Security.AccessControl.PropagationFlags]::None
foreach ($allowed in @($sid, $systemSid)) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($allowed, 'FullControl', $inherit, $propagate, 'Allow')
  $acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($target, $acl)
$actual = [System.IO.Directory]::GetAccessControl($target)
if (-not $actual.AreAccessRulesProtected) { throw 'acl' }
if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2) { throw 'rules' }
foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18') -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne $propagate) { throw 'rule' }
}
[Console]::Write('private-profile-ok')
`;

export async function createPrivateProfile() {
  let profile, root;
  const cleanup = async () => {
    if (!profile) return;
    try {
      const actual = await realpath(profile);
      // Only this generated, direct child of the resolved OS temp directory.
      if (actual !== profile || dirname(actual) !== root || !basename(actual).startsWith("youshu-tax-edge-")) {
        throw new Error("not-owned");
      }
      await rm(actual, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
      profile = null;
    } catch (error) {
      if (error.code === "ENOENT") { profile = null; return; }
      throw new TaxBrowserError("tax_browser_cleanup_failed");
    }
  };
  try {
    root = await realpath(tmpdir());
    const created = await mkdtemp(join(root, "youshu-tax-edge-"));
    profile = await realpath(created);
    if (dirname(profile) !== root || resolve(created) !== profile) throw new Error("unexpected-path");
    if (process.platform === "win32") {
      const command = Buffer.from(PROFILE_ACL_SCRIPT, "utf16le").toString("base64");
      const output = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", command],
        { env: { ...process.env, TAX_BROWSER_PRIVATE_PROFILE: profile } });
      if (output !== "private-profile-ok") throw new Error("acl-not-verified");
    } else {
      await chmod(profile, 0o700);
      const info = await stat(profile);
      if ((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid()) throw new Error("mode-not-verified");
    }
    return { path: profile, cleanup };
  } catch {
    if (profile) {
      try { await cleanup(); }
      catch {
        const failure = new TaxBrowserError("tax_browser_cleanup_failed");
        Object.defineProperty(failure, "retryCleanup", { value: cleanup });
        throw failure;
      }
    }
    throw new TaxBrowserError("tax_browser_profile_failed");
  }
}

export function spawnBrowserProcess({ exePath, profileDir, entryUrl, timeoutMs = 30000,
  spawnImpl = spawn, execFileImpl = execFile }) {
  let child;
  try {
    child = spawnImpl(exePath, [entryUrl, "--new-window", `--user-data-dir=${profileDir}`,
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--inprivate",
      "--no-first-run", "--no-default-browser-check", "--edge-skip-compat-layer-relaunch"],
    { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  } catch { throw new TaxBrowserError("tax_browser_launch_failed"); }
  let exited = false, settled = false, endpoint = null, stderr = "", poll, timer;
  const listeners = new Set();
  let accept, reject, acceptExit;
  const exitPromise = new Promise((done) => { acceptExit = done; });
  const ready = new Promise((yes, no) => { accept = yes; reject = no; });
  ready.catch(() => {}); // Launch may fail while the owning caller is still connecting.
  const finish = (url, code) => {
    if (settled) return;
    settled = true; clearTimeout(timer); clearInterval(poll);
    if (url) { endpoint = url; accept(url); }
    else reject(new TaxBrowserError(code));
  };
  const acceptEndpoint = (url) => { if (isLoopbackDevtoolsUrl(url)) finish(url); };
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    if (settled) return;
    stderr = (stderr + chunk).slice(-4096);
    const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-zA-Z0-9_-]+)/.exec(stderr);
    if (match) acceptEndpoint(match[1]);
  });
  child.once("error", () => { finish(null, "tax_browser_launch_failed"); });
  child.once("exit", () => {
    exited = true; clearInterval(poll); clearTimeout(timer); acceptExit();
    finish(null, "tax_browser_cdp_closed");
    for (const callback of listeners) { try { callback(); } catch {} }
  });
  timer = setTimeout(() => finish(null, "tax_browser_launch_timeout"), timeoutMs);
  let reading = false;
  poll = setInterval(async () => {
    if (settled || exited || reading) return;
    reading = true;
    try {
      const info = await readFile(join(profileDir, "DevToolsActivePort"), "utf8");
      const [port, path] = info.trim().split(/\r?\n/);
      if (/^\d{1,5}$/.test(port || "")) acceptEndpoint(`ws://127.0.0.1:${port}${path}`);
    } catch {} finally { reading = false; }
  }, 150);
  let killing;
  return {
    devtoolsUrl: () => ready,
    onExit(callback) { listeners.add(callback); if (exited) queueMicrotask(callback); return () => listeners.delete(callback); },
    kill() {
      if (killing) return killing;
      killing = (async () => {
        if (exited || child.exitCode !== null && child.exitCode !== undefined) return;
        // A failed spawn has no process to terminate.
        if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
        if (process.platform === "win32") {
          try { await runFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {}, execFileImpl); } catch {}
        } else { try { child.kill("SIGTERM"); } catch {} }
        let waitTimer;
        try {
          await Promise.race([exitPromise, new Promise((_, no) => {
            waitTimer = setTimeout(() => no(new TaxBrowserError("tax_browser_close_failed")), 8000);
          })]);
        } finally { clearTimeout(waitTimer); }
      })().catch((error) => { killing = null; throw error; });
      return killing;
    },
  };
}

export class CdpConnection {
  constructor(wsUrl, { WebSocketImpl = globalThis.WebSocket, openTimeoutMs = 8000, responseTimeoutMs = 15000 } = {}) {
    if (!isLoopbackDevtoolsUrl(wsUrl) || typeof WebSocketImpl !== "function") throw new TaxBrowserError("tax_browser_connect_failed");
    this.wsUrl = wsUrl; this.WebSocketImpl = WebSocketImpl;
    this.openTimeoutMs = openTimeoutMs; this.responseTimeoutMs = responseTimeoutMs;
    this.pending = new Map(); this.listeners = new Map(); this.nextId = 1; this.closed = false;
  }
  on(method, callback) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(callback);
    return () => this.listeners.get(method)?.delete(callback);
  }
  emit(method, params, context = {}) {
    for (const callback of this.listeners.get(method) || []) { try { callback(params, context); } catch {} }
  }
  open() {
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise((yes, no) => {
      let settled = false, timer;
      const fail = () => { if (!settled) { settled = true; clearTimeout(timer); no(new TaxBrowserError("tax_browser_connect_failed")); } };
      try { this.ws = new this.WebSocketImpl(this.wsUrl); } catch { fail(); return; }
      timer = setTimeout(() => { fail(); this.close(); }, this.openTimeoutMs);
      this.ws.addEventListener("open", () => { if (!settled) { settled = true; clearTimeout(timer); yes(this); } });
      this.ws.addEventListener("error", () => { fail(); this.close(); });
      this.ws.addEventListener("close", () => { fail(); this.close(); });
      this.ws.addEventListener("message", ({ data }) => {
        let message;
        try { message = JSON.parse(String(data)); } catch { return; }
        if (message.id === undefined) {
          if (typeof message.method === "string") this.emit(message.method, message.params || {}, { sessionId: message.sessionId });
          return;
        }
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id); clearTimeout(item.timer);
        message.error ? item.no(new TaxBrowserError("tax_browser_cdp_error")) : item.yes(message.result || {});
      });
    });
    return this.openPromise;
  }
  send(method, params = {}, { sessionId, timeoutMs = this.responseTimeoutMs } = {}) {
    if (this.closed || !this.ws) return Promise.reject(new TaxBrowserError("tax_browser_cdp_closed"));
    const id = this.nextId++;
    return new Promise((yes, no) => {
      const timer = setTimeout(() => { this.pending.delete(id); no(new TaxBrowserError("tax_browser_cdp_timeout")); }, timeoutMs);
      this.pending.set(id, { yes, no, timer });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); this.pending.delete(id); no(new TaxBrowserError("tax_browser_cdp_closed")); }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.no(new TaxBrowserError("tax_browser_cdp_closed")); }
    this.pending.clear();
    try { this.ws?.close(); } catch {}
    this.emit("closed", {});
    this.listeners.clear();
  }
}

const defaultConnect = async (url) => { const connection = new CdpConnection(url); await connection.open(); return connection; };
export async function createDedicatedBrowserTransport({ createProfile = createPrivateProfile,
  findExecutable = findEdgeExecutable, launchBrowser = spawnBrowserProcess, connectBrowser = defaultConnect } = {}) {
  let profile, proc, cdp, closing;
  const listeners = new Set();
  const close = () => {
    if (!closing) closing = Promise.resolve().then(async () => {
      cdp?.close();
      // Never remove a profile until its owned browser process has exited.
      await proc?.kill();
      await profile?.cleanup();
    }).catch((error) => { closing = null; throw error; });
    return closing;
  };
  try {
    const exePath = findExecutable();
    if (!exePath) throw new TaxBrowserError("tax_browser_not_installed");
    profile = await createProfile();
    proc = launchBrowser({ exePath, profileDir: profile.path, entryUrl: "https://etax.fujian.chinatax.gov.cn:8443/loginb/" });
    let exited = false;
    proc.onExit(() => {
      exited = true;
      for (const callback of listeners) { try { callback(); } catch {} }
      // Do not log private filesystem or browser failures. close() remains retryable by its owner.
      void close().catch(() => {});
    });
    const endpoint = await proc.devtoolsUrl();
    if (!isLoopbackDevtoolsUrl(endpoint) || exited) throw new TaxBrowserError("tax_browser_connect_failed");
    cdp = await connectBrowser(endpoint);
    if (exited) { cdp.close(); throw new TaxBrowserError("tax_browser_cdp_closed"); }
    return { cdp, close, onExit(callback) { listeners.add(callback); if (exited) queueMicrotask(callback); return () => listeners.delete(callback); } };
  } catch (error) {
    try { await close(); }
    catch {
      const failure = new TaxBrowserError("tax_browser_cleanup_failed");
      // Kept only by the in-process owner, never enumerable or in tool details.
      Object.defineProperty(failure, "retryCleanup", { value: close });
      throw failure;
    }
    throw error instanceof TaxBrowserError ? error : new TaxBrowserError("tax_browser_internal");
  }
}
