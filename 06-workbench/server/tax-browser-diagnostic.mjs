// Local administrative registration only. Never expose PID/path/endpoint inputs through MCP.
// The original backend remains the lifecycle owner. This module never launches, kills,
// navigates, or removes a browser/profile, and never reads cookies or credentials.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, lstat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpConnection, TaxBrowserError, isLoopbackDevtoolsUrl } from "./tax-browser-transport.mjs";

const WORKSPACE = fileURLToPath(new URL("../../", import.meta.url));
export const DEFAULT_REGISTRATION_ROOT = join(WORKSPACE, ".agent-runs", "tax-browser-registry");
const REF = /^taxr_[a-f0-9]{48}$/;
const fail = (code = "tax_browser_registration_invalid") => new TaxBrowserError(code);
function run(exe, args, env = {}) {
  return new Promise((yes, no) => execFile(exe, args, {
    shell: false, windowsHide: true, timeout: 10000, maxBuffer: 32768,
    env: { ...process.env, ...env },
  }, (error, stdout) => error ? no(fail()) : yes(String(stdout))));
}
async function powershell(script, env = {}) {
  if (process.platform !== "win32") throw fail();
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from("$ErrorActionPreference='Stop'\n" + script, "utf16le").toString("base64")], env);
}

// Windows argv decoding, rather than substring tests that could accept a forged flag.
export function splitWindowsCommandLine(text) {
  const args = []; let at = 0;
  while (at < text.length) {
    while (/\s/.test(text[at] || "") && at < text.length) at++;
    if (at >= text.length) break;
    let token = "", quoted = false;
    while (at < text.length && (quoted || !/\s/.test(text[at]))) {
      let slashes = 0;
      while (text[at] === "\\") { slashes++; at++; }
      if (text[at] === '"') {
        token += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) token += '"';
        else quoted = !quoted;
        at++;
      } else {
        token += "\\".repeat(slashes);
        if (at < text.length) token += text[at++];
      }
    }
    if (quoted) throw fail();
    args.push(token);
  }
  return args;
}

const PATH_SCRIPT = `
$path=$env:TAX_REG_PATH
$item=Get-Item -LiteralPath $path -Force
$cursor=$item
while ($null -ne $cursor) {
  if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
  if ($cursor -is [IO.FileInfo]) { $cursor=$cursor.Directory } else { $cursor=$cursor.Parent }
}
if (($env:TAX_REG_DIRECTORY -eq '1') -ne $item.PSIsContainer) { throw 'kind' }
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
if ($item.PSIsContainer) { $acl=[IO.Directory]::GetAccessControl($path) } else { $acl=[IO.File]::GetAccessControl($path) }
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
if ($item.PSIsContainer -and -not $acl.AreAccessRulesProtected) { throw 'inheritance' }
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2) { throw 'rules' }
foreach($rule in $rules) {
  if ($rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18') -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { throw 'rule' }
  if ($item.PSIsContainer -and ($rule.IsInherited -or $rule.InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or $rule.PropagationFlags -ne 'None')) { throw 'directory-rule' }
}
[Console]::Write('ok')
`;
async function privatePath(path, directory) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
    || await realpath(path) !== resolve(path)) throw fail();
  const answer = await powershell(PATH_SCRIPT, {
    TAX_REG_PATH: path, TAX_REG_DIRECTORY: directory ? "1" : "0",
  });
  if (answer !== "ok") throw fail();
}
// Local storage consumers may reuse the same strict ACL boundary. Existing
// directories are only verified, never silently re-permissioned.
export const verifyPrivateDirectory = (path) => privatePath(path, true);
export const verifyPrivateFile = (path) => privatePath(path, false);
async function inspectProcesses(ownerPid, browserPid) {
  const text = await powershell(`
$owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:TAX_REG_OWNER)
$browser=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:TAX_REG_BROWSER)
if ($null -eq $owner -or $null -eq $browser) { throw 'missing' }
@{
 owner=@{pid=[int]$owner.ProcessId;createdAt=$owner.CreationDate.ToUniversalTime().ToString('o');exePath=$owner.ExecutablePath}
 browser=@{pid=[int]$browser.ProcessId;parentPid=[int]$browser.ParentProcessId;createdAt=$browser.CreationDate.ToUniversalTime().ToString('o');exePath=$browser.ExecutablePath;commandLine=$browser.CommandLine}
}|ConvertTo-Json -Compress -Depth 4`, { TAX_REG_OWNER: String(ownerPid), TAX_REG_BROWSER: String(browserPid) });
  const result = JSON.parse(text);
  const allowed = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
  const actual = await realpath(result.browser.exePath);
  result.browserExeVerified = false;
  for (const path of allowed) {
    try { if ((await realpath(path)).toLowerCase() === actual.toLowerCase()) result.browserExeVerified = true; } catch {}
  }
  result.browser.args = splitWindowsCommandLine(result.browser.commandLine);
  delete result.browser.commandLine;
  return result;
}
async function inspectListener(port) {
  const text = await powershell(`
$items=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:TAX_REG_PORT))
@($items|ForEach-Object { @{pid=[int]$_.OwningProcess;address=$_.LocalAddress} })|ConvertTo-Json -Compress`,
  { TAX_REG_PORT: String(port) });
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}
function dependencies(overrides) {
  return {
    inspectProcesses, inspectListener,
    verifyDirectory: (path) => privatePath(path, true),
    verifyFile: (path) => privatePath(path, false),
    tempRoot: () => realpath(tmpdir()),
    registrationBase: resolve(WORKSPACE, ".agent-runs"),
    connectBrowser: async (url) => { const cdp = new CdpConnection(url); await cdp.open(); return cdp; },
    ...overrides,
  };
}
async function boundedFile(path, limit, d) {
  await d.verifyFile(path);
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw fail();
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw fail();
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}
async function rootDirectory(raw, d) {
  const root = resolve(raw || DEFAULT_REGISTRATION_ROOT);
  // One canonical root per checkout: changing subdirectories cannot bypass the browser claim.
  if (root !== resolve(d.registrationBase, "tax-browser-registry")) throw fail();
  await d.verifyDirectory(root);
  return root;
}
function processIdentity(snapshot, ownerPid, browserPid) {
  const { owner, browser } = snapshot || {};
  if (!owner || !browser || owner.pid !== ownerPid || browser.pid !== browserPid
    || browser.parentPid !== ownerPid || snapshot.browserExeVerified !== true
    || !/(^|[\\/])node\.exe$/i.test(owner.exePath || "")
    || !/(^|[\\/])msedge\.exe$/i.test(browser.exePath || "")
    || typeof owner.createdAt !== "string" || typeof browser.createdAt !== "string"
    || !Number.isFinite(Date.parse(owner.createdAt)) || !Number.isFinite(Date.parse(browser.createdAt))
    || Date.parse(owner.createdAt) > Date.parse(browser.createdAt)
    || !Array.isArray(browser.args) || !browser.args.every((arg) => typeof arg === "string")) throw fail();
  const flags = ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    "--new-window", "--edge-skip-compat-layer-relaunch"];
  for (const flag of flags) if (browser.args.filter((arg) => arg === flag).length !== 1) throw fail();
  // Legacy owned launches used InPrivate; the current launch runs a normal window.
  // Accept either, but reject malformed or duplicated InPrivate switches.
  const inprivate = browser.args.filter((arg) => arg === "--inprivate" || arg.startsWith("--inprivate"));
  if (inprivate.length > 1 || inprivate.some((arg) => arg !== "--inprivate")) throw fail();
  // A normal dedicated browser must not be impersonated by guest/unsafe modes.
  const forbidden = ["--guest", "--headless", "--disable-web-security", "--no-sandbox"];
  if (browser.args.some((arg) => forbidden.some((flag) => arg === flag || arg.startsWith(flag + "=")))) throw fail();
  for (const prefix of ["--remote-debugging-address", "--remote-debugging-port", "--user-data-dir"]) {
    if (browser.args.filter((arg) => arg === prefix || arg.startsWith(prefix + "=")).length !== 1) throw fail();
  }
  const profiles = browser.args.filter((arg) => arg.startsWith("--user-data-dir="));
  if (profiles.length !== 1 || browser.args.some((arg) => /^--(type|remote-debugging-pipe|remote-allow-origins)(=|$)/.test(arg))) throw fail();
  if (!browser.args.includes("https://etax.fujian.chinatax.gov.cn:8443/loginb/")) throw fail();
  return {
    owner: { pid: ownerPid, createdAt: owner.createdAt, exePath: owner.exePath },
    browser: { pid: browserPid, createdAt: browser.createdAt, parentPid: ownerPid, exePath: browser.exePath },
    profilePath: resolve(profiles[0].slice("--user-data-dir=".length)),
  };
}
async function verifyLive(ownerPid, browserPid, d, expected, stage = () => {}) {
  stage("process_identity");
  const identity = processIdentity(await d.inspectProcesses(ownerPid, browserPid), ownerPid, browserPid);
  const temp = await d.tempRoot();
  const profile = identity.profilePath;
  if (dirname(profile) !== temp || !/^youshu-tax-edge-[A-Za-z0-9_-]+$/.test(basename(profile))) throw fail();
  stage("profile_acl");
  await d.verifyDirectory(profile);
  stage("devtools_file");
  const contents = await boundedFile(join(profile, "DevToolsActivePort"), 512, d);
  const lines = contents.trim().split(/\r?\n/);
  if (lines.length !== 2 || !/^\d{1,5}$/.test(lines[0])) throw fail();
  const endpoint = `ws://127.0.0.1:${lines[0]}${lines[1]}`;
  if (!isLoopbackDevtoolsUrl(endpoint)) throw fail();
  stage("port_owner");
  const listeners = await d.inspectListener(Number(lines[0]));
  if (!Array.isArray(listeners) || listeners.length === 0
    || listeners.some((item) => item.pid !== browserPid || item.address !== "127.0.0.1")) throw fail();
  stage("process_recheck");
  const after = processIdentity(await d.inspectProcesses(ownerPid, browserPid), ownerPid, browserPid);
  if (JSON.stringify(after) !== JSON.stringify(identity)) throw fail();
  const verified = { ...identity, endpoint };
  if (expected && JSON.stringify(verified) !== JSON.stringify(expected)) throw fail();
  return verified;
}
function browserKey(verified) {
  return createHash("sha256").update(JSON.stringify(verified.browser)).digest("hex");
}
async function jsonFile(path, d) {
  try { return JSON.parse(await boundedFile(path, 8192, d)); }
  catch (error) { throw error instanceof TaxBrowserError ? error : fail(); }
}
export async function openRegisteredBrowserDiagnostic({ registrationRef, registrationRoot, onPhase } = {}, overrides = {}) {
  const d = dependencies(overrides);
  let cdp;
  const step = async (phase, action) => {
    const started = Date.now(); let timer, ended = false;
    try { onPhase?.({ phase, event: "start", elapsedMs: 0 }); } catch {}
    try {
      const result = await Promise.race([
        Promise.resolve().then(action).then((value) => {
          if (ended && phase === "connect") { try { value?.close(); } catch {} }
          return value;
        }),
        new Promise((_, no) => { timer = setTimeout(() => { ended = true; no(fail()); }, 5000); }),
      ]);
      try { onPhase?.({ phase, event: "complete", elapsedMs: Date.now() - started }); } catch {}
      return result;
    } catch {
      const error = fail();
      Object.defineProperty(error, "diagnostics", { value: { phase, elapsedMs: Date.now() - started } });
      throw error;
    } finally { ended = true; clearTimeout(timer); }
  };
  const raw = { ...d };
  d.verifyDirectory = (path) => step("directory_acl", () => raw.verifyDirectory(path));
  d.verifyFile = (path) => step("file_acl", () => raw.verifyFile(path));
  d.inspectProcesses = (...args) => step("process_identity", () => raw.inspectProcesses(...args));
  d.inspectListener = (...args) => step("port_owner", () => raw.inspectListener(...args));
  try {
    if (!REF.test(registrationRef || "")) throw fail();
    const root = await rootDirectory(registrationRoot, d);
    const record = await jsonFile(join(root, `${registrationRef}.json`), d);
    if (record.version !== 1 || record.registrationRef !== registrationRef
      || !["issued", "leased", "released", "quarantined"].includes(record.state)
      || !record.verified || !/^[a-f0-9]{64}$/.test(record.key || "")
      || record.key !== browserKey(record.verified)) throw fail();
    const claim = await jsonFile(join(root, `${record.key}.claim.json`), d);
    if (claim.registrationRef !== registrationRef) throw fail();
    await verifyLive(record.verified.owner.pid, record.verified.browser.pid, d, record.verified);
    cdp = await step("connect", async () => {
      if (overrides.connectBrowser) return overrides.connectBrowser(record.verified.endpoint);
      const connection = new CdpConnection(record.verified.endpoint, { openTimeoutMs: 5000, responseTimeoutMs: 5000 });
      await connection.open(); return connection;
    });
    const transport = { cdp, close() { cdp.close(); } };
    // Non-enumerable local-only capability for the explicit collector lock.
    Object.defineProperty(transport, 'localScope', {value:{profilePath:record.verified.profilePath,browserKey:record.key,
      registrationState:record.state,async currentRegistrationState(){
        const current=await jsonFile(join(root,`${registrationRef}.json`),d);
        if(current.registrationRef!==registrationRef||current.key!==record.key)throw fail();
        return current.state;
      }}});
    return transport;
  } catch (error) {
    try { cdp?.close(); } catch {}
    throw error instanceof TaxBrowserError ? error : fail();
  }
}


