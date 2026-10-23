// Real stdio MCP -> production HTTP server -> Agent tools. Synthetic isolated DB only.
// The synthetic adapter is registered in a test child process, never via a production API/env hook.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { McpStdioClient } from './mcp-stdio-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../..');
const serverPath = join(root, '06-workbench/server/server.mjs');
const moduleUrl = (file) => JSON.stringify(pathToFileURL(join(root, '06-workbench/server', file)).href);
const names = ['tax_session_verify', 'tax_resource_collect', 'tax_resource_coverage', 'tax_account_set_link', 'tax_preparation_build'];
const period = '2026-09';

async function withBackend(synthetic, run) {
  const directory = mkdtempSync(join(tmpdir(), 'tax-acquisition-mcp-'));
  let child, client, stopped;
  try {
    const fixture = `
      const {taxGateway} = await import(${moduleUrl('agent-tools.mjs')});
      const A = await import(${moduleUrl('accounting.mjs')});
      A.createAccountSet({name:'PRIVATE_SYNTHETIC_BOOK',start_period:'2026-09',enterprise:{enterpriseKey:'SYNTHETIC-TAX-ACQUISITION-BOOK-001'}});
      let calls = 0;
      taxGateway.registerAdapter({
        adapterId:'synthetic-readonly',region:'350000',version:'test',label:'Synthetic test only',
        capabilities:{resources:['tax_assessments'],loginMethods:['sms'],challengeActions:[]},
        readonlyEvidence:{tax_assessments:{sideEffectFree:true,evidenceLevel:'synthetic',contractVersion:'v1'}},
        startLogin(){return {status:'authenticated'};}, logout(){return {status:'logged_out'};},
        verifyScope(ctx){return {scopeRevision:'synthetic-rev-1',httpStatus:200,schemaValidated:true,businessCodeValidated:true,businessOk:true,authorized:true,enterpriseId:ctx.enterprise.enterpriseId};},
        queryPage(ctx,p){ const n=++calls; return {scopeRevision:'synthetic-rev-1',httpStatus:200,schemaValidated:true,businessCodeValidated:true,businessOk:true,enterpriseId:ctx.enterprise.enterpriseId,period:p.period,
          data:Array.from({length:n},(_,i)=>({taxType:'PRIVATE_SYNTHETIC_TAX_'+i})),
          pagination:{page:p.page,pageSize:p.pageSize,total:n,hasMore:false}};}
      });
      await import(${moduleUrl('server.mjs')});`;
    child = spawn(process.execPath, synthetic ? ['--input-type=module', '-e', fixture] : [serverPath], {
      env: { ...process.env, WORKBENCH_DATA_DIR: directory, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    stopped = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error(`startup timeout: ${stderr}`)), 15000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(Error(`startup exit ${code}: ${stderr}`)); });
      child.stdout.on('data', (chunk) => { output += chunk.toString(); const match = output.match(/127\.0\.0\.1:(\d+)\//); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    });
    client = new McpStdioClient(join(here, 'server.mjs'), { env: { FINANCE_API_BASE: `http://127.0.0.1:${port}` }, cwd: here }).start();
    await client.initialize('tax-acquisition-synthetic-test');
    await run(client, `http://127.0.0.1:${port}`);
  } finally {
    if (client) await client.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (stopped) await stopped;
    rmSync(directory, { recursive: true, force: true });
  }
}
async function ok(client, name, args) {
  const r = await client.call(name, args); assert.equal(r.isError, false, r.text); return r.data;
}
async function fails(client, name, args, expected) {
  const r = await client.call(name, args); assert.equal(r.isError, true); assert.match(r.text, expected); return r;
}

test('production MCP advertises tools but keeps real adapter registry empty', async () => {
  await withBackend(false, async (client) => {
    const list = await client.rpc('tools/list');
    for (const name of names) assert.ok(list.result.tools.some((tool) => tool.name === name), name);
    const regions = await ok(client, 'tax_regions', {}); assert.equal(regions.summary.adaptersTotal, 0);
    await fails(client, 'tax_login_start', { region: '350000' }, /tax_region_not_configured/);
    for (const name of names) {
      const args = { sessionId: 'synthetic-not-a-session', ...(name.includes('coverage') || name.includes('collect') || name.includes('preparation') ? { period } : {}),
        ...(name === 'tax_resource_collect' ? { resource: 'tax_assessments' } : {}), ...(name === 'tax_account_set_link' ? { accountSetId: 1 } : {}) };
      await fails(client, name, args, /tax_session_not_found/);
    }
  });
});
test('MCP repeat collection, existing-book linkage, isolation and blocked preparation', async () => {
  await withBackend(true, async (client, base) => {
    const session = await ok(client, 'tax_login_start', { region: '350000', enterprise: { enterpriseId: 'PRIVATE_SYNTHETIC_E1' } });
    const sessionId = session.sessionId;
    const verified = await ok(client, 'tax_session_verify', { sessionId }); assert.equal(verified.status, 'verified');
    for (const name of names) {
      const malformed = { sessionId: ` ${sessionId} `,
        ...(name.includes('coverage') || name.includes('collect') || name.includes('preparation') ? { period } : {}),
        ...(name === 'tax_resource_collect' ? { resource: 'tax_assessments' } : {}),
        ...(name === 'tax_account_set_link' ? { accountSetId: 1 } : {}) };
      await fails(client, name, malformed, /tax_acquisition_input_invalid/);
    }
    const args = { sessionId, period, resource: 'tax_assessments' };
    const one = await ok(client, 'tax_resource_collect', args);
    const two = await ok(client, 'tax_resource_collect', args);
    assert.equal(one.count, 1); assert.equal(two.count, 2); assert.notEqual(one.sourceRef, two.sourceRef);
    assert.equal(two.evidenceLevel, 'synthetic'); assert.equal(two.complete, true);
    for (const value of [verified, one, two]) assert.doesNotMatch(JSON.stringify(value), /PRIVATE_SYNTHETIC/);
    const cov = await ok(client, 'tax_resource_coverage', { sessionId, period });
    assert.equal(cov.resources.find((row) => row.resource === 'tax_assessments').count, 2);
    await fails(client, 'tax_resource_collect', { ...args, resource: 'invoices' }, /tax_resource_unsupported/);
    const before = await (await fetch(`${base}/api/account-sets`)).json();
    const link = await ok(client, 'tax_account_set_link', { sessionId, accountSetId: 1 });
    assert.equal(link.linked, true); assert.equal(link.identityMatched, false);
    const after = await (await fetch(`${base}/api/account-sets`)).json(); assert.deepEqual(after, before);
    const prep = await ok(client, 'tax_preparation_build', { sessionId, period });
    assert.equal(prep.status, 'blocked'); assert.equal(prep.submittable, false); assert.equal(prep.obligationsComplete, false);
    assert.ok(prep.gaps.some((g) => g.code === 'applicable_official_rules_unverified'));
    assert.doesNotMatch(JSON.stringify(prep), /PRIVATE_SYNTHETIC/);
    await fails(client, 'tax_resource_collect', { ...args, url: 'https://example.invalid' }, /tax_acquisition_input_invalid|invalid/);
    await fails(client, 'tax_preparation_build', { sessionId, period, fields: [{ value: 100 }] }, /tax_acquisition_input_invalid|invalid/);
    const other = await ok(client, 'tax_login_start', { region: '350000', enterprise: { enterpriseId: 'PRIVATE_SYNTHETIC_E2' } });
    const otherCov = await ok(client, 'tax_resource_coverage', { sessionId: other.sessionId, period });
    assert.notEqual(otherCov.companyRef, cov.companyRef); assert.ok(otherCov.resources.every((r) => !r.complete));
    const otherPrep = await ok(client, 'tax_preparation_build', { sessionId: other.sessionId, period });
    assert.ok(otherPrep.gaps.some((g) => g.code === 'existing_account_set_not_linked'));
    await ok(client, 'tax_logout', { sessionId });
    await fails(client, 'tax_preparation_build', { sessionId, period }, /tax_session_logged_out/);
  });
});
