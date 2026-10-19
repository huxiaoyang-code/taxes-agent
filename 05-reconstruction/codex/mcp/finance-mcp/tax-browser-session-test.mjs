// Actual stdio MCP -> HTTP -> Agent tools; only synthetic transports and temporary DBs.
// The production singleton is injected in this test child before the HTTP server starts.
// This test never launches Edge or contacts a real CDP/tax endpoint.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { McpStdioClient } from './mcp-stdio-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../..');
const moduleUrl = (file) => JSON.stringify(pathToFileURL(join(root, '06-workbench/server', file)).href);
const names = ['tax_browser_open', 'tax_browser_probe', 'tax_browser_close'];
const safe = (value) => assert.doesNotMatch(JSON.stringify(value), /PRIVATE_SYNTHETIC|webSocketDebuggerUrl|cookie|authorization/i);

async function withBackend(run, { slowOpen = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tax-browser-mcp-'));
  let child, client, stopped;
  try {
    const fixture = `
      const {taxBrowserSessions} = await import(${moduleUrl('agent-tools.mjs')});
      let count = 0;
      taxBrowserSessions.openTransport = async () => {
        const instance = ++count;
        process.send?.({type:'synthetic-browser-opened'});
        ${slowOpen ? 'await new Promise((done)=>setTimeout(done,100));' : ''}
        return {
          close: async () => {process.send?.({type:'synthetic-browser-closed'});}, onExit: () => () => {},
          cdp: {on: () => () => {}, async send(method, params, options) {
            if (method === 'Target.getTargets') return {targetInfos:[{
              type:'page',targetId:'PRIVATE_SYNTHETIC_TARGET_'+instance,
              url:instance === 1 ? 'https://tpass.fujian.chinatax.gov.cn:8443/login' : 'https://etax.fujian.chinatax.gov.cn:8443/loginb/'
            }]};
            if (method === 'Target.attachToTarget') return {sessionId:'PRIVATE_SYNTHETIC_CDP_SESSION_'+instance};
            if (method === 'Runtime.evaluate') return {result:{type:'object',value:{
              status:instance === 1 ? 'login_required' : 'schema_unverified',requestPerformed:instance !== 1,httpStatus:instance === 1 ? null : 200,businessCode:instance === 1 ? null : 9997,
              responseShape:{json:true,rootKind:'object',rootFieldCount:1,hasResponse:true,hasData:true,dataKind:'object',dataFieldCount:2,dataCount:null,hasError:false,
                hasLowerData:false,hasResponseLowerData:false,userinfoObject:false,userinfoSource:'none',userIdString:false,userTypeString:false,userTypeNumber:false,regNumberString:false,businessCodeNumber:true,errorFieldPresent:false},
              token:'PRIVATE_SYNTHETIC_TOKEN',msg:'PRIVATE_SYNTHETIC_MESSAGE',data:{name:'PRIVATE_SYNTHETIC_NAME'}
            }}};
            return {};
          }}
        };
      };
      process.on('message',(message)=>{if(message?.type==='synthetic-shutdown') process.emit('SIGTERM');});
      await import(${moduleUrl('server.mjs')});`;
    child = spawn(process.execPath, ['--input-type=module', '-e', fixture], {
      env: { ...process.env, WORKBENCH_DATA_DIR: directory, PORT: '0', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const events = []; child.on('message', (message) => { events.push(message); });
    stopped = new Promise((done) => { child.once('exit', done); child.once('error', done); });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const port = await new Promise((done, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Synthetic browser backend startup timeout')), 15000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(Error(`Synthetic backend exit ${code}: ${stderr}`)); });
      child.stdout.on('data', (chunk) => {
        output += chunk.toString(); const match = output.match(/127\.0\.0\.1:(\d+)\//);
        if (match) { clearTimeout(timer); done(Number(match[1])); }
      });
    });
    client = new McpStdioClient(join(here, 'server.mjs'), {
      env: { FINANCE_API_BASE: `http://127.0.0.1:${port}` }, cwd: here,
    }).start();
    await client.initialize('tax-browser-synthetic-test');
    await run(client, `http://127.0.0.1:${port}`, { child, stopped, events });
    safe(stderr);
  } finally {
    if (client) await client.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (stopped) await stopped;
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()), 'only remove this generated temporary directory');
    assert.match(directory.split(/[\\/]/).at(-1), /^tax-browser-mcp-/);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function ok(client, name, args) {
  const result = await client.call(name, args);
  assert.equal(result.isError, false, result.text); safe(result);
  return result.data;
}
async function rejected(client, name, args) {
  const result = await client.call(name, args);
  assert.equal(result.isError, true, `${name} accepted invalid input`); safe(result);
  return result;
}

test('browser tools run through stdio, HTTP and Agent with isolated synthetic connections', async () => {
  await withBackend(async (client, base) => {
    const listed = await client.rpc('tools/list');
    for (const name of names) assert.ok(listed.result.tools.some((tool) => tool.name === name), name);
    const regions = await ok(client, 'tax_regions', {});
    assert.equal(regions.summary.adaptersTotal, 0, 'browser discovery does not register a real business adapter');
    const first = await ok(client, 'tax_browser_open', { region: '350000' });
    assert.equal((await ok(client, 'tax_browser_open', { region: '350000' })).connectionId, first.connectionId);
    assert.match(first.connectionId, /^taxb_[a-f0-9]{48}$/);
    assert.equal(first.status, 'needs_login');
    const login = await ok(client, 'tax_browser_probe', { connectionId: first.connectionId });
    assert.equal(login.status, 'login_required'); assert.equal(login.requestPerformed, false);
    await ok(client, 'tax_browser_close', { connectionId: first.connectionId });
    const second = await ok(client, 'tax_browser_open', { region: '350000' });
    assert.notEqual(first.connectionId, second.connectionId);
    const observed = await ok(client, 'tax_browser_probe', { connectionId: second.connectionId });
    assert.equal(observed.requestPerformed, true); assert.equal(observed.httpStatus, 200);
    assert.notEqual(observed.status, 'verified'); assert.notEqual(observed.status, 'success');
    await rejected(client, 'tax_session_verify', { sessionId: second.connectionId });
    await rejected(client, 'tax_browser_probe', { connectionId: first.connectionId });
    assert.equal((await ok(client, 'tax_browser_probe', { connectionId: second.connectionId })).requestPerformed, true);
    // HTTP bypass of MCP schema still reaches the same strict Agent argument validator.
    const response = await fetch(`${base}/agent/tools/tax_browser_probe`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId: second.connectionId, url: 'PRIVATE_SYNTHETIC_INJECTION' }),
    });
    const body = await response.json();
    assert.ok(response.status >= 400 || body.error || body.ok === false); safe(body);
    await ok(client, 'tax_browser_close', { connectionId: second.connectionId });
  });
});

test('a lost MCP open response can be retried without launching a second browser', async () => {
  await withBackend(async (client, _base, { events }) => {
    client.timeoutMs = 25;
    await assert.rejects(() => client.call('tax_browser_open', { region: '350000' }), /mcp_timeout/);
    client.timeoutMs = 2000;
    const opened = await ok(client, 'tax_browser_open', { region: '350000' });
    assert.match(opened.connectionId, /^taxb_[a-f0-9]{48}$/);
    assert.equal(events.filter((event) => event.type === 'synthetic-browser-opened').length, 1);
    assert.equal((await ok(client, 'tax_browser_open', { region: '350000' })).connectionId, opened.connectionId);
    await ok(client, 'tax_browser_close', { connectionId: opened.connectionId });
  }, { slowOpen: true });
});

test('backend graceful shutdown closes its synthetic owned browser before exiting', async () => {
  await withBackend(async (client, _base, { child, stopped, events }) => {
    await ok(client, 'tax_browser_open', { region: '350000' });
    child.send({ type: 'synthetic-shutdown' });
    let timer;
    try { await Promise.race([stopped, new Promise((_, no) => { timer = setTimeout(() => no(Error('backend did not shut down')), 3000); })]); }
    finally { clearTimeout(timer); }
    assert.equal(child.exitCode, 0);
    assert.ok(events.some((event) => event.type === 'synthetic-browser-closed'));
  });
});

test('browser MCP input cannot supply endpoints, headers, scripts, profiles or opaque-handle aliases', async () => {
  await withBackend(async (client) => {
    for (const extra of [{ url: 'PRIVATE_SYNTHETIC_ENDPOINT' }, { port: 9222 }, { profileDir: 'PRIVATE_SYNTHETIC_PROFILE' },
      { headers: { cookie: 'PRIVATE_SYNTHETIC_COOKIE' } }, { script: 'PRIVATE_SYNTHETIC_SCRIPT' }]) {
      await rejected(client, 'tax_browser_open', { region: '350000', ...extra });
    }
    await rejected(client, 'tax_browser_open', { region: '440000' });
    const opened = await ok(client, 'tax_browser_open', { region: '350000' });
    for (const name of ['tax_browser_probe', 'tax_browser_close']) {
      for (const connectionId of ['unknown', 'taxb_' + '0'.repeat(48), ` ${opened.connectionId}`, `${opened.connectionId} `]) {
        await rejected(client, name, { connectionId });
      }
      await rejected(client, name, { connectionId: opened.connectionId, headers: {} });
    }
    await ok(client, 'tax_browser_close', { connectionId: opened.connectionId });
  });
});
