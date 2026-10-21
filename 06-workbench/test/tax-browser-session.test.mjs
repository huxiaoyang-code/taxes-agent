// No Edge process, user profile, live CDP endpoint or tax-service request is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { FujianBrowserSessions, FUJIAN_ORIGIN, FUJIAN_LOGIN_ORIGIN, IDENTITY_PROBE_SCRIPT } from '../server/tax-fujian-session.mjs';
import { CdpConnection, TaxBrowserError, createDedicatedBrowserTransport, createPrivateProfile, findEdgeExecutable, isLoopbackDevtoolsUrl, spawnBrowserProcess } from '../server/tax-browser-transport.mjs';

const SECRET = 'PRIVATE_SYNTHETIC_BROWSER_SECRET';
const responseShape = {
  json: true, rootKind: 'object', rootFieldCount: 1, hasResponse: true, hasData: true,
  dataKind: 'object', dataFieldCount: 2, dataCount: null, hasError: false,
  hasLowerData: false, hasResponseLowerData: false, userinfoObject: false, userinfoSource: 'none',
  userIdString: false, userTypeString: false, userTypeNumber: false, regNumberString: false,
  businessCodeNumber: true, errorFieldPresent: false,
};
const safeProbe = () => ({ status: 'schema_unverified', requestPerformed: true, httpStatus: 200, businessCode: 9997, responseShape });
const safeOutput = (value) => assert.doesNotMatch(JSON.stringify(value), /PRIVATE_SYNTHETIC|webSocketDebuggerUrl|recordKey|cookie|authorization/i);
const browserError = (error) => {
  assert.equal(typeof error.code, 'string');
  assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, /PRIVATE_SYNTHETIC/);
  return true;
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeTransport({ targets = [{ targetId: 'synthetic-page', type: 'page', url: `${FUJIAN_ORIGIN}/loginb/` }], evaluate = safeProbe } = {}) {
  const calls = [], listeners = new Map(), exitListeners = new Set();
  let closes = 0;
  const transport = {
    cdp: {
      async send(method, params = {}, options = {}) {
        calls.push({ method, params, options });
        if (method === 'Target.getTargets') return { targetInfos: targets };
        if (method === 'Target.attachToTarget') return { sessionId: 'synthetic-cdp-session' };
        if (method === 'Runtime.evaluate') return { result: { type: 'object', value: await evaluate({ method, params, options }) } };
        return {};
      },
      on(method, callback) {
        const set = listeners.get(method) || new Set(); set.add(callback); listeners.set(method, set);
        return () => set.delete(callback);
      },
    },
    async close() { closes++; },
    onExit(callback) { exitListeners.add(callback); return () => exitListeners.delete(callback); },
  };
  return { transport, calls, targets, get closes() { return closes; },
    emit(method, params = {}, sessionId = 'synthetic-cdp-session') {
      for (const callback of listeners.get(method) || []) callback(params, { sessionId });
    },
    exit() { for (const callback of exitListeners) callback(); },
  };
}

test('repeated opens recover the same owned connection and reopening after close isolates handles', async () => {
  const first = fakeTransport(), second = fakeTransport(); let opens = 0;
  const sessions = new FujianBrowserSessions({ openTransport: async () => [first, second][opens++].transport });
  const a = await sessions.open({ region: '350000' });
  assert.equal((await sessions.open({ region: '350000' })).connectionId, a.connectionId);
  assert.equal(opens, 1);
  assert.match(a.connectionId, /^taxb_[a-f0-9]{48}$/);
  assert.equal(a.status, 'needs_login'); assert.equal(a.region, '350000'); safeOutput(a);
  const closed = await sessions.close({ connectionId: a.connectionId });
  assert.equal(closed.closed, true); assert.equal(first.closes, 1); assert.equal(second.closes, 0);
  const b = await sessions.open({ region: '350000' });
  assert.notEqual(a.connectionId, b.connectionId);
  await sessions.probe({ connectionId: b.connectionId });
  await assert.rejects(() => sessions.probe({ connectionId: a.connectionId }), browserError);
  await sessions.close({ connectionId: b.connectionId }); assert.equal(second.closes, 1);
});

test('browser tool arguments reject injected parameters before opening any process', async () => {
  let opens = 0;
  const sessions = new FujianBrowserSessions({ openTransport: async () => { opens++; throw Error(SECRET); } });
  for (const args of [undefined, null, [], {}, { region: '350100' }, { region: '350000', url: SECRET },
    { region: '350000', port: 9222 }, { region: '350000', headers: {} }, { region: '350000', profileDir: SECRET }]) {
    await assert.rejects(() => sessions.open(args), browserError);
  }
  assert.equal(opens, 0);
});

test('malformed and unknown opaque handles never issue CDP commands', async () => {
  const fake = fakeTransport();
  const sessions = new FujianBrowserSessions({ openTransport: async () => fake.transport });
  const opened = await sessions.open({ region: '350000' });
  for (const connectionId of [undefined, null, 1, {}, '', ` ${opened.connectionId}`, `${opened.connectionId} `, 'taxb_' + '0'.repeat(48)]) {
    for (const method of ['probe', 'close']) await assert.rejects(() => sessions[method]({ connectionId }), browserError);
  }
  for (const extra of [{ url: SECRET }, { headers: { cookie: SECRET } }, { script: SECRET }, { targetId: SECRET }, { method: 'POST' }]) {
    await assert.rejects(() => sessions.probe({ connectionId: opened.connectionId, ...extra }), browserError);
  }
  assert.equal(fake.calls.length, 0);
  await sessions.close({ connectionId: opened.connectionId });
});

test('separate managers cannot use each other\'s opaque handles or close each other\'s process', async () => {
  const one = fakeTransport(), two = fakeTransport();
  const a = new FujianBrowserSessions({ openTransport: async () => one.transport });
  const b = new FujianBrowserSessions({ openTransport: async () => two.transport });
  const first = await a.open({ region: '350000' }), second = await b.open({ region: '350000' });
  await assert.rejects(() => a.probe({ connectionId: second.connectionId }), (error) => error.code === 'tax_browser_connection_not_found');
  await assert.rejects(() => b.close({ connectionId: first.connectionId }), (error) => error.code === 'tax_browser_connection_not_found');
  await a.close({ connectionId: first.connectionId }); assert.equal(two.closes, 0);
  assert.equal((await b.probe({ connectionId: second.connectionId })).status, 'schema_unverified');
  await b.close({ connectionId: second.connectionId });
});

test('concurrent opens cannot launch a second owned process before the first settles', async () => {
  const pending = deferred(), fake = fakeTransport(); let opens = 0;
  const sessions = new FujianBrowserSessions({ openTransport: () => { opens++; return pending.promise; } });
  const first = sessions.open({ region: '350000' });
  const second = sessions.open({ region: '350000' });
  assert.equal(opens, 1); pending.resolve(fake.transport);
  const opened = await first; assert.equal((await second).connectionId, opened.connectionId);
  await sessions.close({ connectionId: opened.connectionId });
});

test('fixed identity probe never returns response values or claims business verification', async () => {
  const fake = fakeTransport({ evaluate: () => ({ ...safeProbe(), token: SECRET, data: { name: SECRET }, message: SECRET }) });
  const sessions = new FujianBrowserSessions({ openTransport: async () => fake.transport });
  const opened = await sessions.open({ region: '350000' });
  try {
    const result = await sessions.probe({ connectionId: opened.connectionId });
    assert.notEqual(result.status, 'verified'); assert.notEqual(result.status, 'success');
    assert.equal(result.requestPerformed, true); assert.equal(result.httpStatus, 200); safeOutput(result);
    const evaluation = fake.calls.find((call) => call.method === 'Runtime.evaluate');
    assert.equal(evaluation.params.expression, IDENTITY_PROBE_SCRIPT);
    assert.equal(evaluation.params.awaitPromise, true); assert.equal(evaluation.params.returnByValue, true);
    assert.equal(evaluation.options.sessionId, 'synthetic-cdp-session');
    assert.ok(fake.calls.some((call) => call.method === 'Target.detachFromTarget'));
  } finally { await sessions.close({ connectionId: opened.connectionId }); }
});

test('malformed page summaries fail closed and cannot smuggle text through scalar fields', async () => {
  for (const change of [
    (value) => { value.status = SECRET; }, (value) => { value.businessCode = SECRET; },
    (value) => { value.httpStatus = SECRET; }, (value) => { value.responseShape.userinfoSource = SECRET; },
    (value) => { value.responseShape.rootKind = SECRET; }, (value) => { value.responseShape.dataCount = SECRET; },
    (value) => { value.responseShape.userIdString = SECRET; }, (value) => { value.responseShape.rootFieldCount = 1048577; },
    (value) => { value.requestPerformed = false; }, (value) => { value.scopeChanged = true; },
  ]) {
    const fake = fakeTransport({ evaluate: () => { const value = structuredClone(safeProbe()); change(value); return value; } });
    const sessions = new FujianBrowserSessions({ openTransport: async () => fake.transport });
    const opened = await sessions.open({ region: '350000' });
    try { await assert.rejects(() => sessions.probe({ connectionId: opened.connectionId }), browserError); }
    finally { await sessions.close({ connectionId: opened.connectionId }); }
  }
});

test('ambiguous official tabs do not choose an arbitrary target', async () => {
  const fake = fakeTransport({ targets: [
    { targetId: 'synthetic-one', type: 'page', url: `${FUJIAN_ORIGIN}/loginb/` },
    { targetId: 'synthetic-two', type: 'page', url: `${FUJIAN_ORIGIN}/another` },
  ] });
  const sessions = new FujianBrowserSessions({ openTransport: async () => fake.transport });
  const opened = await sessions.open({ region: '350000' });
  try {
    assert.equal((await sessions.probe({ connectionId: opened.connectionId })).status, 'unsupported_page');
    assert.equal(fake.calls.some((call) => call.method === 'Target.attachToTarget'), false);
  } finally { await sessions.close({ connectionId: opened.connectionId }); }
});

for (const target of [
  { type: 'page', url: 'https://evil.invalid/loginb/' },
  { type: 'page', url: 'http://etax.fujian.chinatax.gov.cn:8443/loginb/' },
  { type: 'page', url: 'https://etax.fujian.chinatax.gov.cn:8444/loginb/' },
  { type: 'page', url: 'https://etax.fujian.chinatax.gov.cn.evil.invalid:8443/loginb/' },
  { type: 'page', url: `https://user:password@etax.fujian.chinatax.gov.cn:8443/loginb/` },
  { type: 'service_worker', url: `${FUJIAN_ORIGIN}/worker.js` },
]) test(`unsupported target does not execute probe: ${target.type} ${target.url}`, async () => {
  const fake = fakeTransport({ targets: [{ targetId: 'synthetic-unsupported', ...target }] });
  const sessions = new FujianBrowserSessions({ openTransport: async () => fake.transport });
  const opened = await sessions.open({ region: '350000' });
  try {
    const result = await sessions.probe({ connectionId: opened.connectionId });
    assert.equal(result.status, 'unsupported_page'); assert.equal(result.requestPerformed, false);
    assert.equal(fake.calls.some((call) => call.method === 'Runtime.evaluate'), false);
  } finally { await sessions.close({ connectionId: opened.connectionId }); }
});

test('official login page reports login required without an identity request', async () => {
  const fake = fakeTransport({ targets: [{ targetId: 'synthetic-login', type: 'page', url: `${FUJIAN_LOGIN_ORIGIN}/login` }],
    evaluate: () => ({ ...safeProbe(), status: 'login_required', requestPerformed: false, httpStatus: null, businessCode: null }) });
  const sessions = new FujianBrowserSessions({ openTransport: async () => fake.transport });
  const opened = await sessions.open({ region: '350000' });
  try {
    const result = await sessions.probe({ connectionId: opened.connectionId });
    assert.equal(result.status, 'login_required'); assert.equal(result.requestPerformed, false);
    assert.equal(fake.calls.find((call) => call.method === 'Runtime.evaluate').params.expression, IDENTITY_PROBE_SCRIPT);
  } finally { await sessions.close({ connectionId: opened.connectionId }); }
});

for (const [event, params] of [
  ['Page.frameNavigated', { frame: { id: 'synthetic-main-frame', url: 'https://evil.invalid/' } }],
  ['Runtime.executionContextsCleared', {}],
  ['Page.navigatedWithinDocument', { frameId: 'synthetic-main-frame', url: `${FUJIAN_ORIGIN}/different` }],
  ['Target.detachedFromTarget', { sessionId: 'synthetic-cdp-session' }],
]) test(`in-flight probe rejects results after ${event}`, async () => {
  const entered = deferred(), late = deferred();
  const fake = fakeTransport({ evaluate: () => { entered.resolve(); return late.promise; } });
  const sessions = new FujianBrowserSessions({ openTransport: async () => fake.transport });
  const opened = await sessions.open({ region: '350000' });
  try {
    const pending = sessions.probe({ connectionId: opened.connectionId });
    const rejected = assert.rejects(pending, (error) => { assert.equal(error.code, 'tax_browser_scope_changed'); return browserError(error); });
    await entered.promise; fake.emit(event, params); late.resolve(safeProbe());
    await rejected;
  } finally { await sessions.close({ connectionId: opened.connectionId }); }
});

test('owned browser process exit invalidates its opaque connection', async () => {
  const fake = fakeTransport();
  const sessions = new FujianBrowserSessions({ openTransport: async () => fake.transport });
  const opened = await sessions.open({ region: '350000' });
  fake.exit();
  await assert.rejects(() => sessions.probe({ connectionId: opened.connectionId }), (error) => error.code === 'tax_browser_connection_closed');
});

test('timed-out attachment closes its owned transport and discards its late session', async () => {
  const entered = deferred(), late = deferred(), detached = deferred();
  const fake = fakeTransport(); const send = fake.transport.cdp.send;
  fake.transport.cdp.send = async (method, params, options) => {
    if (method === 'Target.attachToTarget') { entered.resolve(); return late.promise; }
    if (method === 'Target.detachFromTarget') detached.resolve(params);
    return send(method, params, options);
  };
  const sessions = new FujianBrowserSessions({ openTransport: async () => fake.transport, timeoutMs: 15 });
  const opened = await sessions.open({ region: '350000' });
  try {
    const pending = sessions.probe({ connectionId: opened.connectionId });
    const rejected = assert.rejects(pending, (error) => error.code === 'tax_browser_cdp_timeout');
    await entered.promise; await rejected;
    await assert.rejects(() => sessions.probe({ connectionId: opened.connectionId }), (error) => error.code === 'tax_browser_connection_closed');
    assert.ok(fake.closes >= 1, 'owned transport must close before another probe is allowed');
    late.resolve({ sessionId: 'synthetic-late-session' });
    let timer;
    try {
      const params = await Promise.race([detached.promise, new Promise((_, no) => { timer = setTimeout(() => no(Error('late attachment was not detached')), 500); })]);
      assert.equal(params.sessionId, 'synthetic-late-session');
      assert.equal(fake.calls.some((call) => call.method === 'Runtime.evaluate'), false);
    } finally { clearTimeout(timer); }
  } finally { late.resolve({ sessionId: 'synthetic-late-session' }); await sessions.close({ connectionId: opened.connectionId }); }
});

test('closing a connection during evaluation rejects its late result', async () => {
  const entered = deferred(), late = deferred();
  const fake = fakeTransport({ evaluate: () => { entered.resolve(); return late.promise; } });
  const sessions = new FujianBrowserSessions({ openTransport: async () => fake.transport });
  const opened = await sessions.open({ region: '350000' });
  const pending = sessions.probe({ connectionId: opened.connectionId });
  const rejected = assert.rejects(pending, (error) => error.code === 'tax_browser_scope_changed');
  await entered.promise; await sessions.close({ connectionId: opened.connectionId }); late.resolve(safeProbe()); await rejected;
});

test('startup cleanup failure preserves a recoverable owner and prevents a second launch', async () => {
  const fixture = transportLifecycle({ failConnect: true, failKillOnce: true });
  let opens = 0;
  const sessions = new FujianBrowserSessions({ openTransport: () => { opens++; return createDedicatedBrowserTransport(fixture.dependencies); } });
  const opened = await sessions.open({ region: '350000' });
  assert.equal(opened.status, 'cleanup_required'); safeOutput(opened);
  assert.equal(fixture.calls.includes('cleanup'), false);
  assert.equal((await sessions.open({ region: '350000' })).connectionId, opened.connectionId); assert.equal(opens, 1);
  await assert.rejects(() => sessions.probe({ connectionId: opened.connectionId }), (error) => error.code === 'tax_browser_connection_closed');
  await sessions.close({ connectionId: opened.connectionId });
  assert.equal(fixture.calls.at(-1), 'cleanup');
  const fake = fakeTransport(); sessions.openTransport = async () => fake.transport;
  const next = await sessions.open({ region: '350000' }); assert.notEqual(next.connectionId, opened.connectionId);
  await sessions.close({ connectionId: next.connectionId });
});

test('closeAll waits for a pending open and closes its resulting owned transport', async () => {
  const pending = deferred(), fake = fakeTransport(); let opens = 0;
  const sessions = new FujianBrowserSessions({ openTransport: () => { opens++; return pending.promise; } });
  const opening = sessions.open({ region: '350000' }); const closing = sessions.closeAll();
  const denied = assert.rejects(() => sessions.open({ region: '350000' }), (error) => error.code === 'tax_browser_shutting_down');
  pending.resolve(fake.transport); const opened = await opening; await closing;
  await denied; assert.equal(opens, 1);
  assert.equal(fake.closes, 1);
  await assert.rejects(() => sessions.probe({ connectionId: opened.connectionId }), (error) => error.code === 'tax_browser_connection_closed');
  await assert.rejects(() => sessions.open({ region: '350000' }), (error) => error.code === 'tax_browser_shutting_down');
  assert.equal(opens, 1);
});

test('closeAll blocks new opens while cleanup is pending and after completion', async () => {
  const cleanup = deferred(), entered = deferred(), fake = fakeTransport(); let opens = 0;
  fake.transport.close = async () => { entered.resolve(); await cleanup.promise; };
  const sessions = new FujianBrowserSessions({ openTransport: async () => { opens++; return fake.transport; } });
  await sessions.open({ region: '350000' }); const closing = sessions.closeAll();
  try {
    await entered.promise;
    await assert.rejects(() => sessions.open({ region: '350000' }), (error) => error.code === 'tax_browser_shutting_down');
    assert.equal(opens, 1);
  } finally { cleanup.resolve(); await closing; }
  await assert.rejects(() => sessions.open({ region: '350000' }), (error) => error.code === 'tax_browser_shutting_down');
  assert.equal(opens, 1);
});

test('closeAll on an empty manager permanently blocks new profile creation', async () => {
  let opens = 0;
  const sessions = new FujianBrowserSessions({ openTransport: async () => { opens++; return fakeTransport().transport; } });
  await sessions.closeAll();
  await assert.rejects(() => sessions.open({ region: '350000' }), (error) => error.code === 'tax_browser_shutting_down');
  assert.equal(opens, 0);
});

test('closeAll reports cleanup failure and the original handle remains retryable', async () => {
  const fake = fakeTransport(); let attempts = 0;
  fake.transport.close = async () => { if (++attempts === 1) throw Error(SECRET); };
  const sessions = new FujianBrowserSessions({ openTransport: async () => fake.transport });
  const opened = await sessions.open({ region: '350000' });
  await assert.rejects(() => sessions.closeAll(), (error) => { assert.equal(error.code, 'tax_browser_cleanup_failed'); return browserError(error); });
  await assert.rejects(() => sessions.open({ region: '350000' }), (error) => error.code === 'tax_browser_shutting_down');
  await sessions.close({ connectionId: opened.connectionId }); assert.equal(attempts, 2);
});

async function runProbeScript({ href = `${FUJIAN_ORIGIN}/loginb/`, body = { Response: { Data: { code: 9997, msg: SECRET } } }, status = 200, fetchImpl, timerDelay } = {}) {
  const calls = [], location = { href };
  const context = {
    URL, AbortController, TextDecoder, location, clearTimeout,
    setTimeout: timerDelay === undefined ? setTimeout : (fn) => setTimeout(fn, timerDelay),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (fetchImpl) return fetchImpl(url, options, location);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  };
  const result = await runInNewContext(IDENTITY_PROBE_SCRIPT, context, { timeout: 1000 });
  safeOutput(result); return { result, calls };
}

test('actual probe script issues only the fixed same-origin GET and keeps 9997 unverified', async () => {
  const { result, calls } = await runProbeScript();
  assert.equal(calls.length, 1); const call = calls[0], url = new URL(call.url);
  assert.equal(url.origin, FUJIAN_ORIGIN); assert.equal(url.pathname, '/mhzx/api/mh/mhsy/getUserInfo');
  assert.deepEqual([...url.searchParams.keys()], ['t']);
  assert.equal(call.options.method, 'GET'); assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.redirect, 'manual');
  assert.equal(result.status, 'schema_unverified'); assert.equal(result.businessCode, 9997);
  assert.equal(result.responseShape.userinfoObject, false); assert.equal(result.responseShape.dataFieldCount, 2);
});

test('actual probe script does not fetch on login or unsupported origins', async () => {
  for (const [href, expected] of [[`${FUJIAN_LOGIN_ORIGIN}/login`, 'login_required'], ['https://evil.invalid/', 'unsupported_page'], ['https://user:pass@etax.fujian.chinatax.gov.cn:8443/loginb/', 'unsupported_page']]) {
    const { result, calls } = await runProbeScript({ href });
    assert.equal(result.status, expected); assert.equal(result.requestPerformed, false); assert.equal(calls.length, 0);
  }
});

for (const source of ['response_data', 'response_lower_data', 'lower_data', 'root']) test(`actual script exposes userinfo types but no values from ${source}`, async () => {
  const data = { userinfo: { user_id: SECRET, user_type: 1, reg_number: SECRET }, code: 0, token: SECRET };
  const body = source === 'response_data' ? { Response: { Data: data } } : source === 'response_lower_data' ? { Response: { data } } : source === 'lower_data' ? { data } : data;
  const { result } = await runProbeScript({ body });
  assert.equal(result.status, 'schema_unverified'); assert.equal(result.responseShape.userinfoObject, true);
  assert.equal(result.responseShape.userinfoSource, source); assert.equal(result.responseShape.userIdString, true);
  assert.equal(result.responseShape.userTypeString, false); assert.equal(result.responseShape.userTypeNumber, true);
  assert.equal(result.responseShape.regNumberString, true); assert.equal(result.businessCode, 0);
});

test('actual probe distinguishes explicit errors and transport failure without exposing text', async () => {
  const error = await runProbeScript({ body: { Response: { Data: { code: 0 }, Error: { message: SECRET } } } });
  assert.equal(error.result.status, 'business_failed'); assert.equal(error.result.responseShape.hasError, true);
  const http = await runProbeScript({ status: 500 }); assert.equal(http.result.status, 'request_failed');
  const text = await runProbeScript({ fetchImpl: () => new Response(SECRET) });
  assert.equal(text.result.status, 'schema_unverified'); assert.equal(text.result.responseShape.json, false);
  const thrown = await runProbeScript({ fetchImpl: () => { throw Error(SECRET); } });
  assert.equal(thrown.result.status, 'request_failed');
});

test('actual probe cancels oversized response streams and does not parse their contents', async () => {
  let cancelled = false;
  const { result } = await runProbeScript({ fetchImpl: () => ({ status: 200, body: { getReader: () => ({
    read: async () => ({ done: false, value: new Uint8Array(1048577) }), cancel: async () => { cancelled = true; },
  }) } }) });
  assert.equal(cancelled, true); assert.equal(result.status, 'schema_unverified'); assert.equal(result.responseShape.json, false);
});

test('actual probe aborts a stalled request and flags a page change during fetch', async () => {
  const timeout = await runProbeScript({ timerDelay: 5, fetchImpl: (_url, { signal }) => new Promise((_, no) => signal.addEventListener('abort', () => no(Error(SECRET)), { once: true })) });
  assert.equal(timeout.result.status, 'request_failed');
  const changed = await runProbeScript({ fetchImpl: (_url, _options, location) => { location.href = 'https://evil.invalid/'; return new Response('{}'); } });
  assert.equal(changed.result.scopeChanged, true);
});

const WS = 'ws://127.0.0.1:19222/devtools/browser/synthetic-browser';
test('DevTools websocket whitelist excludes remote, credentialed and arbitrary endpoints', () => {
  assert.equal(isLoopbackDevtoolsUrl(WS), true);
  for (const url of [null, {}, '', 'http://127.0.0.1:19222/devtools/browser/id',
    'wss://127.0.0.1:19222/devtools/browser/id', 'ws://localhost:19222/devtools/browser/id',
    'ws://[::1]:19222/devtools/browser/id', 'ws://192.168.1.2:19222/devtools/browser/id',
    'ws://127.0.0.1.evil.invalid:19222/devtools/browser/id', 'ws://user:pass@127.0.0.1:19222/devtools/browser/id',
    'ws://127.0.0.1:0/devtools/browser/id', 'ws://127.0.0.1:65536/devtools/browser/id',
    'ws://127.0.0.1:19222/devtools/page/id', `${WS}?token=${SECRET}`, `${WS}#fragment`, `${WS} `]) {
    assert.equal(isLoopbackDevtoolsUrl(url), false);
    assert.throws(() => new CdpConnection(url), (error) => error.code === 'tax_browser_connect_failed');
  }
});

test('Edge resolution uses only explicit candidates and never searches a shell PATH', () => {
  const searched = [];
  assert.equal(findEdgeExecutable({ candidates: ['missing', null, 'synthetic-edge'], exists(path) { searched.push(path); return path === 'synthetic-edge'; } }), 'synthetic-edge');
  assert.deepEqual(searched, ['missing', 'synthetic-edge']);
  assert.equal(findEdgeExecutable({ candidates: [], exists() { throw Error('not called'); } }), null);
});

test('private empty profile has independently verified current-user permissions and cleans up', async () => {
  const profile = await createPrivateProfile();
  try {
    const info = await stat(profile.path); assert.equal(info.isDirectory(), true);
    if (process.platform === 'win32') {
      const script = `
        $ErrorActionPreference='Stop'
        $acl=[System.IO.Directory]::GetAccessControl($env:SYNTHETIC_PROFILE_CHECK)
        $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
        $bad=@($rules | Where-Object { $_.IdentityReference.Value -notin @($sid,'S-1-5-18') -or $_.IsInherited -or $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl' -or $_.InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or $_.PropagationFlags -ne 'None' })
        [pscustomobject]@{protected=$acl.AreAccessRulesProtected;currentUserOwner=($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid);ruleCount=$rules.Count;badRules=$bad.Count} | ConvertTo-Json -Compress
      `;
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        shell: false, windowsHide: true, timeout: 10000, env: { ...process.env, SYNTHETIC_PROFILE_CHECK: profile.path },
      });
      assert.deepEqual(JSON.parse(stdout), { protected: true, currentUserOwner: true, ruleCount: 2, badRules: 0 });
    } else {
      assert.equal(info.mode & 0o777, 0o700); assert.equal(info.uid, process.getuid());
    }
  } finally { await profile.cleanup(); }
  await assert.rejects(() => stat(profile.path), (error) => error.code === 'ENOENT');
  await profile.cleanup();
});

test('browser launch uses a private profile and terminates only its owned process', async () => {
  const child = new EventEmitter(); child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
  child.pid = 424242; child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); return true; };
  let launch, killCall;
  const proc = spawnBrowserProcess({ exePath: 'synthetic-edge', profileDir: join(tmpdir(), 'synthetic-owned-browser-profile'), entryUrl: `${FUJIAN_ORIGIN}/`, timeoutMs: 100,
    spawnImpl(exe, args, options) { launch = { exe, args, options }; return child; },
    execFileImpl(exe, args, options, callback) { killCall = { exe, args, options }; child.kill(); callback(null, ''); },
  });
  child.stderr.emit('data', `DevTools listening on ${WS}\n`);
  assert.equal(await proc.devtoolsUrl(), WS);
  assert.equal(launch.options.shell, false); assert.equal(launch.options.windowsHide, true);
  assert.ok(launch.args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(launch.args.includes('--remote-debugging-port=0'));
  assert.ok(launch.args.includes(`--user-data-dir=${join(tmpdir(), 'synthetic-owned-browser-profile')}`));
  assert.equal(launch.args.includes('--inprivate'), false);
  assert.equal(launch.args.some((arg) => arg === '--guest' || arg.startsWith('--guest=')), false);
  assert.equal(launch.args.some((arg) => arg === '--headless' || arg.startsWith('--headless=')), false);
  assert.equal(launch.args.includes('--disable-web-security'), false);
  let exits = 0; proc.onExit(() => { exits++; });
  await proc.kill(); await proc.kill(); assert.equal(exits, 1);
  if (process.platform === 'win32') {
    assert.equal(killCall.exe, 'taskkill.exe'); assert.deepEqual(killCall.args, ['/PID', '424242', '/T', '/F']);
    assert.equal(killCall.options.shell, false);
  }
});

function transportLifecycle({ endpoint = WS, failProfile = false, failConnect = false, failKillOnce = false, failCleanupOnce = false } = {}) {
  const calls = []; let alive = true, killAttempts = 0, cleanupAttempts = 0;
  const dependencies = {
    findExecutable: () => 'synthetic-edge',
    async createProfile() {
      calls.push('profile'); if (failProfile) throw new TaxBrowserError('tax_browser_profile_failed');
      return { path: 'synthetic-private-profile', async cleanup() {
        calls.push('cleanup'); cleanupAttempts++; assert.equal(alive, false, 'never clean an owned live browser profile');
        if (failCleanupOnce && cleanupAttempts === 1) throw new TaxBrowserError('tax_browser_cleanup_failed');
      } };
    },
    launchBrowser(args) {
      calls.push('launch'); assert.equal(args.profileDir, 'synthetic-private-profile'); assert.equal(args.entryUrl, `${FUJIAN_ORIGIN}/loginb/`);
      return { devtoolsUrl: async () => endpoint, onExit: () => () => {}, async kill() {
        calls.push('kill'); killAttempts++;
        if (failKillOnce && killAttempts === 1) throw new TaxBrowserError('tax_browser_close_failed');
        alive = false;
      } };
    },
    async connectBrowser(url) {
      calls.push('connect'); assert.equal(url, WS);
      if (failConnect) throw Error(SECRET);
      return { close() { calls.push('cdp-close'); } };
    },
  };
  return { dependencies, calls };
}

test('transport requires verified profile before launch and validates owned DevTools endpoint', async () => {
  const noProfile = transportLifecycle({ failProfile: true });
  await assert.rejects(() => createDedicatedBrowserTransport(noProfile.dependencies), browserError);
  assert.deepEqual(noProfile.calls, ['profile']);
  const nonlocal = transportLifecycle({ endpoint: 'ws://evil.invalid:19222/devtools/browser/id' });
  await assert.rejects(() => createDedicatedBrowserTransport(nonlocal.dependencies), browserError);
  assert.deepEqual(nonlocal.calls, ['profile', 'launch', 'kill', 'cleanup']);
  const failed = transportLifecycle({ failConnect: true });
  await assert.rejects(() => createDedicatedBrowserTransport(failed.dependencies), browserError);
  assert.deepEqual(failed.calls, ['profile', 'launch', 'connect', 'kill', 'cleanup']);
});

test('transport cleanup waits for owned process termination and is idempotent', async () => {
  const fixture = transportLifecycle();
  const transport = await createDedicatedBrowserTransport(fixture.dependencies);
  await transport.close(); await transport.close();
  assert.deepEqual(fixture.calls, ['profile', 'launch', 'connect', 'cdp-close', 'kill', 'cleanup']);
});

for (const failure of ['failKillOnce', 'failCleanupOnce']) test(`transport close can retry ${failure} without removing a live profile`, async () => {
  const fixture = transportLifecycle({ [failure]: true });
  const transport = await createDedicatedBrowserTransport(fixture.dependencies);
  await assert.rejects(() => transport.close(), browserError);
  if (failure === 'failKillOnce') assert.equal(fixture.calls.includes('cleanup'), false);
  await transport.close();
  assert.equal(fixture.calls.at(-1), 'cleanup');
});

function fakeSocketClass() {
  return class FakeSocket extends EventTarget {
    static instances = [];
    constructor(url) { super(); this.url = url; this.sent = []; this.closed = false; this.constructor.instances.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) { this.sent.push(JSON.parse(text)); }
    respond(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
    close() { if (!this.closed) { this.closed = true; this.dispatchEvent(new Event('close')); } }
  };
}

test('CDP timeout ignores late results and leaves later requests usable', async () => {
  const Socket = fakeSocketClass();
  const cdp = new CdpConnection(WS, { WebSocketImpl: Socket, responseTimeoutMs: 10 }); await cdp.open();
  const socket = Socket.instances[0];
  try {
    await assert.rejects(() => cdp.send('Target.getTargets'), (error) => error.code === 'tax_browser_cdp_timeout');
    assert.equal(cdp.pending.size, 0);
    const next = cdp.send('Target.getTargets');
    socket.respond({ id: socket.sent[0].id, result: { secret: SECRET } });
    socket.respond({ id: socket.sent[1].id, result: { targetInfos: [] } });
    assert.deepEqual(await next, { targetInfos: [] });
  } finally { cdp.close(); }
});

test('CDP connections isolate matching request IDs and scrub protocol errors', async () => {
  const Socket = fakeSocketClass();
  const first = new CdpConnection(WS, { WebSocketImpl: Socket }), second = new CdpConnection(WS, { WebSocketImpl: Socket });
  await Promise.all([first.open(), second.open()]);
  try {
    const a = first.send('Target.getTargets'), b = second.send('Target.getTargets');
    const failed = assert.rejects(a, browserError);
    Socket.instances[0].respond({ id: 1, error: { message: SECRET, data: SECRET } });
    Socket.instances[1].respond({ id: 1, result: { targetInfos: [] } });
    await failed; assert.deepEqual(await b, { targetInfos: [] });
    let event;
    second.on('Page.frameNavigated', (params, context) => { event = { params, context }; });
    Socket.instances[1].respond({ method: 'Page.frameNavigated', params: { frame: { id: 'synthetic-frame' } }, sessionId: 'synthetic-session' });
    assert.equal(event.context.sessionId, 'synthetic-session');
    const pending = second.send('Target.getTargets'); const closed = assert.rejects(pending, (error) => error.code === 'tax_browser_cdp_closed');
    second.close(); await closed;
  } finally { first.close(); second.close(); }
});
