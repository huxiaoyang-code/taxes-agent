// Dedicated-browser diagnostics only. A shape is not an authenticated tax session.
import { randomBytes } from "node:crypto";
import { createDedicatedBrowserTransport, TaxBrowserError } from "./tax-browser-transport.mjs";

export const FUJIAN_ORIGIN = "https://etax.fujian.chinatax.gov.cn:8443";
export const FUJIAN_LOGIN_ORIGIN = "https://tpass.fujian.chinatax.gov.cn:8443";
const KINDS = ["object", "array", "string", "number", "boolean", "null", "unknown"];
const STATUSES = ["login_required", "unsupported_page", "request_failed", "business_failed", "schema_unverified"];
const emptyShape = () => ({ json: false, rootKind: "unknown", rootFieldCount: null,
  hasResponse: false, hasData: false, dataKind: "unknown", dataFieldCount: null, dataCount: null, hasError: false,
  hasLowerData: false, hasResponseLowerData: false, userinfoObject: false, userinfoSource: "none",
  userIdString: false, userTypeString: false, userTypeNumber: false, regNumberString: false,
  businessCodeNumber: false, errorFieldPresent: false });

// No credentials, headers, arbitrary property names, text or business values leave
// the page. The backend receives only these fixed counters and structural flags.
export const IDENTITY_PROBE_SCRIPT = `(async () => {
  const shape = { json:false, rootKind:'unknown', rootFieldCount:null, hasResponse:false,
    hasData:false, dataKind:'unknown', dataFieldCount:null, dataCount:null, hasError:false,
    hasLowerData:false, hasResponseLowerData:false, userinfoObject:false, userinfoSource:'none',
    userIdString:false, userTypeString:false, userTypeNumber:false, regNumberString:false,
    businessCodeNumber:false, errorFieldPresent:false };
  const out = { status:'unsupported_page', requestPerformed:false, httpStatus:null,
    businessCode:null, responseShape:shape };
  const current = new URL(location.href);
  if (current.username || current.password) return out;
  if (current.origin === '${FUJIAN_LOGIN_ORIGIN}') return { ...out, status:'login_required' };
  if (current.origin !== '${FUJIAN_ORIGIN}') return out;
  const before = location.href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  out.requestPerformed = true;
  try {
    const response = await fetch('${FUJIAN_ORIGIN}/mhzx/api/mh/mhsy/getUserInfo?t=' + Date.now(), {
      method:'GET', credentials:'same-origin', redirect:'manual',
      headers:{ Accept:'application/json, text/plain, */*' }, signal:controller.signal
    });
    out.httpStatus = response.status;
    if (location.href !== before) return { ...out, scopeChanged:true };
    if (response.type === 'opaqueredirect' || response.status < 200 || response.status >= 300) {
      return { ...out, status:'request_failed' };
    }
    if (!response.body) return { ...out, status:'schema_unverified' };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '', bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) { await reader.cancel(); return { ...out, status:'schema_unverified' }; }
      text += decoder.decode(chunk.value, {stream:true});
    }
    text += decoder.decode();
    if (location.href !== before) return { ...out, scopeChanged:true };
    let body;
    try { body = JSON.parse(text); } catch { return { ...out, status:'schema_unverified' }; }
    const kind = (value) => value === null ? 'null' : Array.isArray(value) ? 'array'
      : ['object','string','number','boolean'].includes(typeof value) ? typeof value : 'unknown';
    const object = (value) => kind(value) === 'object';
    shape.json = true;
    shape.rootKind = kind(body);
    shape.rootFieldCount = object(body) ? Object.keys(body).length : null;
    shape.hasResponse = object(body) && Object.hasOwn(body, 'Response');
    const envelope = shape.hasResponse && object(body.Response) ? body.Response : null;
    shape.hasData = !!envelope && Object.hasOwn(envelope, 'Data');
    const data = shape.hasData ? envelope.Data : undefined;
    shape.dataKind = kind(data);
    shape.dataFieldCount = object(data) ? Object.keys(data).length : null;
    shape.dataCount = Array.isArray(data) ? data.length : null;
    shape.hasLowerData = object(body) && Object.hasOwn(body, 'data');
    shape.hasResponseLowerData = !!envelope && Object.hasOwn(envelope, 'data');
    const candidates = [['response_data', data], ['response_lower_data', envelope?.data],
      ['lower_data', object(body) ? body.data : undefined], ['root', body]];
    const userSource = candidates.find((pair) => object(pair[1]) && object(pair[1].userinfo));
    if (userSource) {
      const user = userSource[1].userinfo;
      shape.userinfoObject = true;
      shape.userinfoSource = userSource[0];
      shape.userIdString = typeof user.user_id === 'string';
      shape.userTypeString = typeof user.user_type === 'string';
      shape.userTypeNumber = typeof user.user_type === 'number';
      shape.regNumberString = typeof user.reg_number === 'string';
    }
    const codeSource = candidates.find((pair) => object(pair[1]) && Object.hasOwn(pair[1], 'code'));
    if (codeSource) {
      const code = codeSource[1].code;
      shape.businessCodeNumber = typeof code === 'number';
      if (Number.isSafeInteger(code) && code >= 0 && code <= 999999) out.businessCode = code;
    }
    const errors = [body, envelope, ...candidates.map((pair) => pair[1])].filter(object);
    shape.errorFieldPresent = errors.some((item) => Object.hasOwn(item, 'Error') || Object.hasOwn(item, 'error'));
    shape.hasError = errors.some((item) => ['Error','error'].some((key) => {
      if (!Object.hasOwn(item, key)) return false;
      const error = item[key];
      return error !== null && error !== undefined && error !== false && error !== ''
        && (!object(error) || Object.keys(error).length > 0);
    }));
    // No success code or identity schema has been verified yet. 9997 is not
    // interpreted as expiry or authorization failure.
    return { ...out, status:shape.hasError ? 'business_failed' : 'schema_unverified' };
  } catch { return { ...out, status:'request_failed' }; }
  finally { clearTimeout(timer); }
})()`;

function input(args, allowed) {
  if (!args || typeof args !== "object" || Array.isArray(args)
      || Object.keys(args).some((key) => !allowed.includes(key))) throw new TaxBrowserError("tax_browser_input_invalid");
}
function officialOrigin(raw) {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.protocol !== "https:") return null;
    return [FUJIAN_ORIGIN, FUJIAN_LOGIN_ORIGIN].includes(u.origin) ? u.origin : null;
  } catch { return null; }
}
function boundedCount(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 1048576; }
function sanitizeProbe(raw) {
  if (!raw || typeof raw !== "object" || raw.scopeChanged) throw new TaxBrowserError(raw?.scopeChanged
    ? "tax_browser_scope_changed" : "tax_browser_response_invalid");
  const s = raw.responseShape;
  if (!STATUSES.includes(raw.status) || typeof raw.requestPerformed !== "boolean" || !s
      || !["json", "hasResponse", "hasData", "hasError", "hasLowerData", "hasResponseLowerData",
        "userinfoObject", "userIdString", "userTypeString", "userTypeNumber", "regNumberString",
        "businessCodeNumber", "errorFieldPresent"].every((key) => typeof s[key] === "boolean")
      || !["none", "response_data", "response_lower_data", "lower_data", "root"].includes(s.userinfoSource)
      || !KINDS.includes(s.rootKind) || !KINDS.includes(s.dataKind)
      || !["rootFieldCount", "dataFieldCount", "dataCount"].every((key) => s[key] === null || boundedCount(s[key]))
      || !(raw.httpStatus === null || Number.isInteger(raw.httpStatus) && raw.httpStatus >= 0 && raw.httpStatus <= 599)
      || !(raw.businessCode === null || Number.isSafeInteger(raw.businessCode) && raw.businessCode >= 0 && raw.businessCode <= 999999)) {
    throw new TaxBrowserError("tax_browser_response_invalid");
  }
  if ((["login_required", "unsupported_page"].includes(raw.status) && raw.requestPerformed)
      || (["schema_unverified", "business_failed"].includes(raw.status)
        && (!raw.requestPerformed || raw.httpStatus < 200 || raw.httpStatus >= 300))) throw new TaxBrowserError("tax_browser_response_invalid");
  // Rebuild; never spread browser-returned objects across the tool boundary.
  return { status: raw.status, requestPerformed: raw.requestPerformed, httpStatus: raw.httpStatus,
    businessCode: raw.businessCode, responseShape: {
      json: s.json, rootKind: s.rootKind, rootFieldCount: s.rootFieldCount,
      hasResponse: s.hasResponse, hasData: s.hasData, dataKind: s.dataKind,
      dataFieldCount: s.dataFieldCount, dataCount: s.dataCount, hasError: s.hasError,
      hasLowerData: s.hasLowerData, hasResponseLowerData: s.hasResponseLowerData,
      userinfoObject: s.userinfoObject, userinfoSource: s.userinfoSource,
      userIdString: s.userIdString, userTypeString: s.userTypeString, userTypeNumber: s.userTypeNumber,
      regNumberString: s.regNumberString, businessCodeNumber: s.businessCodeNumber, errorFieldPresent: s.errorFieldPresent,
    } };
}

export class FujianBrowserSessions {
  constructor({ openTransport = createDedicatedBrowserTransport, timeoutMs = 15000 } = {}) {
    this.openTransport = openTransport;
    this.timeoutMs = timeoutMs;
    this.connections = new Map();
    this.opening = null;
    this.shuttingDown = false;
  }
  async open(args = {}) {
    input(args, ["region"]);
    if (args.region !== "350000") throw new TaxBrowserError("tax_browser_region_unsupported");
    if (this.shuttingDown) throw new TaxBrowserError("tax_browser_shutting_down");
    if (this.opening) return this.opening;
    const existing = [...this.connections.entries()].find(([, item]) => !item.cleaned);
    if (existing) return { connectionId: existing[0], status: existing[1].closed ? "cleanup_required" : "needs_login", region: "350000" };
    this.opening = this.openOne().finally(() => { this.opening = null; });
    return this.opening;
  }
  async openOne() {
    let transport;
    const connectionId = `taxb_${randomBytes(24).toString("hex")}`;
    try {
      transport = await this.openTransport();
      const state = { transport, closed: false, cleaned: false, busy: false, revision: 0 };
      state.offExit = transport.onExit(() => { state.closed = true; state.revision++; });
      state.offClosed = transport.cdp.on("closed", () => { state.closed = true; state.revision++; });
      this.connections.set(connectionId, state);
      return { connectionId, status: "needs_login", region: "350000" };
    } catch (error) {
      let retryCleanup = error instanceof TaxBrowserError ? error.retryCleanup : null;
      if (transport) {
        try { await transport.close(); }
        catch { retryCleanup = () => transport.close(); }
      }
      if (typeof retryCleanup === "function") {
        this.connections.set(connectionId, { transport: { close: retryCleanup }, closed: true,
          cleaned: false, busy: false, revision: 0 });
        return { connectionId, status: "cleanup_required", region: "350000" };
      }
      throw error instanceof TaxBrowserError ? error : new TaxBrowserError("tax_browser_internal");
    }
  }
  requireConnection(args) {
    input(args, ["connectionId"]);
    if (typeof args.connectionId !== "string" || !/^taxb_[a-f0-9]{48}$/.test(args.connectionId)) throw new TaxBrowserError("tax_browser_input_invalid");
    const state = this.connections.get(args.connectionId);
    if (!state) throw new TaxBrowserError("tax_browser_connection_not_found");
    return state;
  }
  async probe(args = {}) {
    const state = this.requireConnection(args);
    if (state.closed) throw new TaxBrowserError("tax_browser_connection_closed");
    if (state.busy) throw new TaxBrowserError("tax_browser_probe_busy");
    state.busy = true;
    const revision = state.revision;
    const cdp = state.transport.cdp;
    let attached, expired = false, timer;
    const offs = [];
    const assertCurrent = () => {
      if (expired || state.closed || state.revision !== revision) throw new TaxBrowserError("tax_browser_scope_changed");
    };
    const perform = async () => {
      const list = await cdp.send("Target.getTargets", {}, { timeoutMs: this.timeoutMs });
      assertCurrent();
      const pages = (Array.isArray(list.targetInfos) ? list.targetInfos : []).filter((target) => target.type === "page" && officialOrigin(target.url));
      if (pages.length !== 1) return { status: "unsupported_page", requestPerformed: false,
        httpStatus: null, businessCode: null, responseShape: emptyShape() };
      const target = pages[0];
      attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }, { timeoutMs: this.timeoutMs });
      if (!attached?.sessionId) throw new TaxBrowserError("tax_browser_response_invalid");
      // A timed-out attach can still finish. Release its late session as well.
      if (expired || state.closed || state.revision !== revision) {
        void cdp.send("Target.detachFromTarget", { sessionId: attached.sessionId }, { timeoutMs: 500 }).catch(() => {});
      }
      assertCurrent();
      const changed = (_params, context) => {
        if (context?.sessionId === attached.sessionId) state.revision++;
      };
      offs.push(cdp.on("Page.frameNavigated", (params, context) => { if (!params.frame?.parentId) changed(params, context); }));
      offs.push(cdp.on("Page.navigatedWithinDocument", changed));
      offs.push(cdp.on("Runtime.executionContextsCleared", changed));
      offs.push(cdp.on("Target.detachedFromTarget", (params) => { if (params.sessionId === attached.sessionId) state.revision++; }));
      const opts = { sessionId: attached.sessionId, timeoutMs: this.timeoutMs };
      await cdp.send("Page.enable", {}, opts);
      await cdp.send("Runtime.enable", {}, opts);
      assertCurrent();
      const result = await cdp.send("Runtime.evaluate", { expression: IDENTITY_PROBE_SCRIPT,
        awaitPromise: true, returnByValue: true, timeout: this.timeoutMs }, opts);
      assertCurrent();
      if (result.exceptionDetails || !Object.hasOwn(result.result || {}, "value")) throw new TaxBrowserError("tax_browser_response_invalid");
      return sanitizeProbe(result.result.value);
    };
    try {
      const result = await Promise.race([perform(), new Promise((_, no) => {
        timer = setTimeout(() => { expired = true; no(new TaxBrowserError("tax_browser_cdp_timeout")); }, this.timeoutMs);
      })]);
      assertCurrent();
      return { connectionId: args.connectionId, ...result };
    } catch (error) {
      if (error instanceof TaxBrowserError && error.code === "tax_browser_cdp_timeout") {
        // A protocol timeout may lose a late attach reply. Closing our dedicated
        // browser prevents both orphan attachments and an overlapping fetch.
        state.closed = true; state.revision++;
        void state.transport.close().then(() => { state.cleaned = true; }).catch(() => {});
      }
      throw error instanceof TaxBrowserError ? error : new TaxBrowserError("tax_browser_internal");
    } finally {
      clearTimeout(timer); expired = true;
      for (const off of offs) off();
      // Detach only our CDP session, without navigating or closing the user's page.
      if (attached?.sessionId) {
        let detachTimer;
        try {
          await Promise.race([cdp.send("Target.detachFromTarget", { sessionId: attached.sessionId }, { timeoutMs: 500 }),
            new Promise((done) => { detachTimer = setTimeout(done, 500); })]);
        } catch {} finally { clearTimeout(detachTimer); }
      }
      state.busy = false;
    }
  }
  async close(args = {}) {
    const state = this.requireConnection(args);
    state.closed = true; state.revision++;
    try {
      await state.transport.close();
      state.cleaned = true;
      state.offExit?.(); state.offClosed?.();
      return { connectionId: args.connectionId, status: "closed", closed: true };
    } catch (error) {
      throw error instanceof TaxBrowserError ? error : new TaxBrowserError("tax_browser_close_failed");
    }
  }
  async closeAll() {
    this.shuttingDown = true;
    if (this.opening) { try { await this.opening; } catch {} }
    const results = await Promise.allSettled([...this.connections.keys()].map((connectionId) => this.close({ connectionId })));
    if (results.some((result) => result.status === "rejected")) throw new TaxBrowserError("tax_browser_cleanup_failed");
  }
}
