#!/usr/bin/env node
// Synthetic temporary databases only; domain and actual REST/Agent entry points.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const dataDir = mkdtempSync(join(tmpdir(), 'voucher-amount-'));
process.env.WORKBENCH_DATA_DIR = dataDir;
const results = [];
let db;
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); }
  catch (error) { results.push(false); console.error(`  ✗ ${name}\n    ${error.stack}`); }
}
// Snapshot every stored column in every table, including sequence and unrelated data.
function snapshot(connection) {
  return Object.fromEntries(connection.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => {
    const rows = connection.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return [name, rows];
  }));
}
const pair = (amount = 100) => [{ code: '1002', debit: amount, credit: 0 }, { code: '1001', debit: 0, credit: amount }];
// Invalid values on the unused side expose silent coercion even when both rows remain nonzero and balanced.
const unusedSide = (bad) => [{ code: '1002', debit: 100, credit: bad }, { code: '1001', debit: 0, credit: 100 }];
const badAmounts = [
  ['garbage', 'bad-amount'], ['partial number', '12abc'], ['internal space', '1 000'],
  ['exponent text', '1e2'], ['hex text', '0x64'], ['comma text', '1,000'],
  ['NaN number', NaN], ['Infinity number', Infinity], ['negative Infinity', -Infinity],
  ['NaN text', 'NaN'], ['Infinity text', 'Infinity'], ['boolean false', false], ['boolean true', true],
  ['empty array', []], ['numeric array', [100]], ['object', {}],
  ['tiny negative', -0.001], ['tiny negative text', '-0.001'], ['negative underflow text', '-0.' + '0'.repeat(330) + '1'],
];
const shapeCases = [
  ['null entries', null], ['string entries', 'invalid'], ['object entries', {}], ['boolean entries', false],
  ['null entry', [null, ...pair()]], ['undefined entry', [undefined, ...pair()]],
  ['array entry', [[], ...pair()]], ['string entry', ['1002', ...pair()]],
  ['numeric entry', [100, ...pair()]], ['sparse entries', [, ...pair()]],
];
const assertCheck = (A, setId, entries) => {
  const checked = A.checkVoucher(setId, entries);
  assert.equal(checked.ok, false, 'invalid voucher must fail preflight');
  assert.ok(checked.errors.some((error) => typeof error === 'string' && error.length));
  assert.ok(Number.isFinite(checked.total_debit));
  assert.ok(Number.isFinite(checked.total_credit));
};
const assertCreate = (A, setId, entries) => {
  const before = snapshot(db);
  try {
    assert.throws(() => A.createVoucher(setId, { period: '2026-03', entries }), (error) => {
      assert.equal(error.message, 'voucher_invalid');
      assert.equal(error.details.ok, false);
      assert.ok(error.details.errors.length);
      return true;
    });
  } finally { assert.deepEqual(snapshot(db), before, 'failed creation must preserve ALL stored contents'); }
};
async function deadline(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}
try {
  ({ db } = await import('../server/db.mjs'));
  const A = await import('../server/accounting.mjs');
  const setId = A.createAccountSet({ name: 'synthetic voucher guards', start_period: '2026-01' }).id;
  A.setOpeningBalances(setId, [{ code: '1002', debit: 1000 }, { code: '3001', credit: 1000 }]);
  A.createVoucher(setId, { period: '2026-01', status: 'posted', summary: 'existing content sentinel', entries: pair(7) });
  for (const [label, bad] of badAmounts) {
    await test(`check: ${label} on unused side`, () => assertCheck(A, setId, unusedSide(bad)));
    await test(`create atomicity: ${label} on unused side`, () => assertCreate(A, setId, unusedSide(bad)));
  }
  // Nonzero coercions must also fail on the used side, where old balancing rules would accept them.
  for (const [label, bad] of [['boolean true', true], ['numeric array', [100]], ['exponent text', '1e2'], ['hex text', '0x64']]) {
    await test(`check: ${label} on used side`, () => assertCheck(A, setId, pair(bad)));
    await test(`create atomicity: ${label} on used side`, () => assertCreate(A, setId, pair(bad)));
  }
  for (const bad of [1e13, '1000000000000', 999999999999.994, '999999999999.994', '999999999999.99001', Number.MAX_VALUE]) {
    await test(`check and create: over limit ${bad}`, () => { assertCheck(A, setId, pair(bad)); assertCreate(A, setId, pair(bad)); });
  }
  for (const [label, entries] of shapeCases) {
    await test(`shape check: ${label}`, () => assertCheck(A, setId, entries));
    await test(`shape create atomicity: ${label}`, () => assertCreate(A, setId, entries));
  }
  await test('zero rows remain invalid', () => { assertCheck(A, setId, pair(0)); assertCreate(A, setId, pair(0)); });
  await test('legitimate number/text/empty columns persist exact expected cents', () => {
    for (const empty of [undefined, null, '', '  ']) {
      const entries = [{ code: '1002', debit: ' 1720.35 ', credit: empty }, { code: '1001', debit: empty, credit: 1720.35 }];
      const check = A.checkVoucher(setId, entries);
      assert.equal(check.ok, true, JSON.stringify(check.errors));
      assert.equal(check.total_debit, 1720.35); assert.equal(check.total_credit, 1720.35);
      const voucher = A.createVoucher(setId, { period: '2026-01', entries });
      assert.equal(voucher.status, 'draft');
      assert.equal(voucher.total_debit, 1720.35); assert.equal(voucher.total_credit, 1720.35);
      const stored = A.getVoucher(setId, voucher.id);
      assert.deepEqual(stored.entries.map(({ debit, credit }) => [debit, credit]), [[1720.35, 0], [0, 1720.35]]);
    }
  });
  await test('plain decimal forms and per-entry rounding agree with storage', () => {
    const entries = [{ code: '1002', debit: '+.125' }, { code: '1002', debit: '1.' }, { code: '1001', credit: 1.13 }];
    const check = A.checkVoucher(setId, entries);
    assert.equal(check.ok, true, JSON.stringify(check.errors));
    assert.equal(check.total_debit, 1.13); assert.equal(check.total_credit, 1.13);
    const voucher = A.createVoucher(setId, { period: '2026-01', entries });
    assert.deepEqual(voucher.entries.map(({ debit, credit }) => [debit, credit]), [[0.13, 0], [1, 0], [0, 1.13]]);
    assert.equal(voucher.total_debit, 1.13); assert.equal(voucher.total_credit, 1.13);
  });
  await test('boundary amount remains legal and finite', () => {
    const check = A.checkVoucher(setId, pair(999999999999.99));
    assert.equal(check.ok, true, JSON.stringify(check.errors));
    const voucher = A.createVoucher(setId, { period: '2026-01', entries: pair('999999999999.99') });
    assert.equal(voucher.total_debit, 999999999999.99); assert.equal(voucher.total_credit, 999999999999.99);
  });
  await test('many fractional rows sum to independently known 100 and persist consistently', () => {
    const entries = Array.from({ length: 1000 }, () => ({ code: '1002', debit: 0.1 }));
    entries.push({ code: '1001', credit: 100 });
    const check = A.checkVoucher(setId, entries);
    assert.equal(check.ok, true, JSON.stringify(check.errors)); assert.equal(check.total_debit, 100);
    const voucher = A.createVoucher(setId, { period: '2026-01', entries });
    assert.equal(voucher.entries.length, 1001); assert.equal(voucher.total_debit, 100); assert.equal(voucher.total_credit, 100);
  });
  await test('direct posted and draft-to-post remain operational', () => {
    assert.equal(A.createVoucher(setId, { period: '2026-01', status: 'posted', entries: pair(25) }).status, 'posted');
    const draft = A.createVoucher(setId, { period: '2026-01', entries: pair(30) });
    assert.equal(A.postVoucher(setId, draft.id).status, 'posted');
  });
  for (const [label, bad] of [['garbage unused side', 'abc'], ['tiny negative unused side', -0.001], ['Infinity unused side', Infinity]]) {
    await test(`post rejects existing corrupt draft: ${label}`, () => {
      const voucher = A.createVoucher(setId, { period: '2026-02', entries: pair(10) });
      db.prepare('UPDATE voucher_entries SET credit=? WHERE voucher_id=? AND line_no=1').run(bad, voucher.id);
      const before = snapshot(db);
      try { assert.throws(() => A.postVoucher(setId, voucher.id), /voucher_invalid/); }
      finally { assert.deepEqual(snapshot(db), before, 'post failure must preserve every table'); }
      assert.equal(A.getVoucher(setId, voucher.id).status, 'draft');
    });
  }
  await test('internal profit carryforward still posts known 300 expense', () => {
    const derivedId = A.createAccountSet({ name: 'synthetic carryforward', start_period: '2026-01' }).id;
    A.createVoucher(derivedId, { period: '2026-01', status: 'posted', entries: [{ code: '5602', debit: 300 }, { code: '1002', credit: 300 }] });
    const out = A.carryForwardProfit(derivedId, '2026-01');
    assert.equal(out.voucher.status, 'posted'); assert.equal(out.voucher.total_debit, 300); assert.equal(out.voucher.total_credit, 300);
  });
  await test('strict import still rejects illegal amount without any writes', () => {
    const before = snapshot(db);
    const out = A.importAccountSet({ account_set: { name: 'synthetic rejected import', start_period: '2026-01' }, vouchers: [{ period: '2026-01', entries: unusedSide('bad-amount') }] }, { dryRun: false });
    assert.equal(out.validation.ok, false); assert.equal(out.created, null); assert.deepEqual(snapshot(db), before);
  });

  const httpDataDir = mkdtempSync(join(tmpdir(), 'voucher-amount-http-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/server.mjs', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', WORKBENCH_DATA_DIR: httpDataDir },
  });
  let httpDb;
  const exit = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { output += chunk; const match = /127\.0\.0\.1:(\d+)\//.exec(output); if (match) resolve(`http://127.0.0.1:${match[1]}`); });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exited ${code}: ${output}`)));
  });
  try {
    const base = await deadline(ready, 10000, 'HTTP startup timeout');
    httpDb = new DatabaseSync(join(httpDataDir, 'workbench.db'), { readOnly: true });
    const api = async (path, body, method = 'POST') => {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      return { status: response.status, data: await response.json() };
    };
    const created = await api('/api/account-sets', { name: 'synthetic HTTP guards', start_period: '2026-01' });
    assert.equal(created.status, 201); const httpId = created.data.id;
    const voucherPath = `/api/account-sets/${httpId}/vouchers`;
    const initial = await api(voucherPath, { period: '2026-01', entries: pair(7) });
    assert.equal(initial.status, 201);
    // JSON cannot represent NaN/Infinity; their text spellings exercise the wire protocol instead.
    for (const [label, bad] of badAmounts.filter(([, value]) => typeof value !== 'number' || Number.isFinite(value))) {
      await test(`REST rejects ${label} with complete database unchanged`, async () => {
        const before = snapshot(httpDb);
        try { const r = await api(voucherPath, { period: '2026-03', entries: unusedSide(bad) }); assert.equal(r.status, 400); assert.equal(r.data.error, 'voucher_invalid'); assert.ok(r.data.details.errors.length); }
        finally { assert.deepEqual(snapshot(httpDb), before); }
      });
    }
    await test('Agent check/create reject bad amount and malformed rows without writes', async () => {
      for (const entries of [unusedSide('abc'), unusedSide('-0.001'), unusedSide(false), unusedSide([]), unusedSide('Infinity'), [null, ...pair()], 'not-array']) {
        const before = snapshot(httpDb);
        try {
          const check = await api('/agent/tools/voucher_check', { accountSetId: httpId, entries });
          const create = await api('/agent/tools/voucher_create', { accountSetId: httpId, period: '2026-03', entries });
          if (entries === 'not-array') {
            // Agent argument validation rejects non-arrays before calling the domain layer.
            assert.equal(check.status, 400); assert.equal(check.data.error, 'entries_required');
            assert.equal(create.status, 400); assert.equal(create.data.error, 'entries_required');
          } else {
            assert.equal(check.status, 200); assert.equal(check.data.ok, false); assert.ok(check.data.errors.length);
            assert.ok(Number.isFinite(check.data.total_debit)); assert.ok(Number.isFinite(check.data.total_credit));
            assert.equal(create.status, 400); assert.equal(create.data.error, 'voucher_invalid');
          }
        } finally { assert.deepEqual(snapshot(httpDb), before); }
      }
    });
    await test('REST malformed rows return voucher_invalid and preserve all tables', async () => {
      const before = snapshot(httpDb);
      try { const r = await api(voucherPath, { period: '2026-03', entries: [null, ...pair()] }); assert.equal(r.status, 400); assert.equal(r.data.error, 'voucher_invalid'); }
      finally { assert.deepEqual(snapshot(httpDb), before); }
    });
    await test('Agent legitimate check/create persist known rounded amount and post', async () => {
      const entries = [{ code: '1002', debit: '2500.125', credit: null }, { code: '1001', debit: '', credit: 2500.13 }];
      const check = await api('/agent/tools/voucher_check', { accountSetId: httpId, entries });
      assert.equal(check.status, 200); assert.equal(check.data.ok, true); assert.equal(check.data.total_debit, 2500.13);
      const create = await api('/agent/tools/voucher_create', { accountSetId: httpId, period: '2026-01', entries });
      assert.equal(create.status, 200); assert.equal(create.data.status, 'draft');
      const stored = await api(`${voucherPath}/${create.data.id}`, undefined, 'GET');
      assert.equal(stored.status, 200); assert.equal(stored.data.total_debit, 2500.13); assert.equal(stored.data.total_credit, 2500.13);
      assert.deepEqual(stored.data.entries.map(({ debit, credit }) => [debit, credit]), [[2500.13, 0], [0, 2500.13]]);
      const post = await api('/agent/tools/voucher_post', { accountSetId: httpId, voucherId: create.data.id });
      assert.equal(post.status, 200); assert.equal(post.data.status, 'posted');
    });
    await test('REST legitimate direct posted voucher persists expected cents', async () => {
      const result = await api(voucherPath, { period: '2026-01', status: 'posted', entries: pair('123.45') });
      assert.equal(result.status, 201); assert.equal(result.data.status, 'posted'); assert.equal(result.data.total_debit, 123.45); assert.equal(result.data.total_credit, 123.45);
      assert.equal(httpDb.prepare('SELECT debit FROM voucher_entries WHERE voucher_id=? AND line_no=1').get(result.data.id).debit, 123.45);
    });
  } finally {
    httpDb?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await deadline(exit, 5000, 'HTTP child exit timeout; temporary directory retained');
    rmSync(httpDataDir, { recursive: true, force: true });
  }
} catch (error) { results.push(false); console.error('Fixture/infrastructure failure:', error); }
finally { db?.close(); rmSync(dataDir, { recursive: true, force: true }); }
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exitCode = results.every(Boolean) ? 0 : 1;
