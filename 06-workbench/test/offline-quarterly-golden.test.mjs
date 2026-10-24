import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { child, json, writeJson, sha, row, databaseState, assertQuarterlyOutput, inspect } from './helpers/offline-quarterly-golden.mjs';
const wb = resolve(dirname(fileURLToPath(import.meta.url)), '..'), fixtures = join(wb, 'test/fixtures/offline-quarterly-golden-v1');
const parent = join(wb, '.agent-runs'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'quarterly-golden-')); let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } }
const outputs = new Map();
await test('frozen raw and independent literal expectation inventory', () => {
  const manifest = json(join(fixtures, 'manifest.json')); assert.equal(manifest.frozenBeforeDriver, true); assert.equal(manifest.syntheticOnly, true); assert.equal(manifest.files.length, 34);
  for (const f of manifest.files) assert.equal(sha(readFileSync(join(fixtures, f.path))), f.sha256, f.path);
});
for (const id of ['QG01', 'QG02']) await test(id + ' six actual monthly originals -> formal prepare/execute -> 6 vouchers/18 entries -> six unclosed as-of trials -> actual Q1/Q2', () => {
  const actual = child('execute', join(root, id), join(fixtures, 'raw', id)); outputs.set(id, actual);
  writeJson(join(root, id, 'actual-output.json'), actual);
  // Expected literals first enter the test AFTER all product execution has ended.
  assertQuarterlyOutput(actual, json(join(fixtures, 'expected', id + '.json')), join(fixtures, 'raw', id));
});
if (outputs.size === 2 && !failed) {
  for (const id of ['QG01', 'QG02']) {
    const original = outputs.get(id), expected = json(join(fixtures, 'expected', id + '.json')), raw = join(fixtures, 'raw', id);
    const rejects = mutate => { const copy = structuredClone(original); mutate(copy); assert.throws(() => assertQuarterlyOutput(copy, expected, raw)); };
    await test(id + ' trial oracle rejects missing account, duplicate account and corrupt report totals for every month', () => {
      assertQuarterlyOutput(original, expected, raw);
      for (let month = 0; month < 6; month++) {
        for (const code of ['1122', '5001', '2221']) rejects(a => { a.trials[month].lines = a.trials[month].lines.filter(l => l.code !== code); });
        for (const code of ['1122', original.trials[month].lines.find(l => !['1122', '5001', '2221'].includes(l.code)).code]) rejects(a => { a.trials[month].lines.push(structuredClone(a.trials[month].lines.find(l => l.code === code))); });
        for (const field of ['opening_debit', 'opening_credit', 'period_debit', 'period_credit', 'closing_debit', 'closing_credit']) rejects(a => { a.trials[month].totals[field] += 1; });
      }
      rejects(a => { for (const t of a.trials) t.lines = t.lines.filter(l => l.code !== '5001'); });
      rejects(a => { for (const t of a.trials) t.lines.push(structuredClone(t.lines.find(l => l.code === '1122'))); });
    });
    await test(id + ' tax oracle rejects duplicate selected cell and missing uncomputed cell in both quarters', () => {
      for (const key of ['priorComputation', 'computation']) {
        rejects(a => { const p = a.diagnostic[key]; p.cells.push(structuredClone(row(p, 20))); });
        rejects(a => { a.diagnostic[key].cells = a.diagnostic[key].cells.filter(c => !(c.row === 4 && c.column === 'goods' && c.period === 'current')); });
      }
    });
    await test(id + ' tax trace oracle rejects duplicate or missing original sale and reconciled business in both quarters', () => {
      for (const key of ['priorComputation', 'computation']) {
        rejects(a => { a.diagnostic[key].sales[1] = structuredClone(a.diagnostic[key].sales[0]); });
        rejects(a => { a.diagnostic[key].sales.pop(); });
        rejects(a => { a.diagnostic[key].reconciledBusinesses[1] = structuredClone(a.diagnostic[key].reconciledBusinesses[0]); });
        rejects(a => { a.diagnostic[key].reconciledBusinesses.pop(); });
      }
    });
    await test(id + ' cumulative graph oracle requires both exact dependencies and actual prior-node provenance', () => {
      for (const n of [1, 2, 3, 15, 16, 20]) {
        const ytd = a => a.diagnostic.computation.calculationNodes.find(node => node.id === `ytd_${n}`);
        rejects(a => { ytd(a).dependencies.pop(); });
        rejects(a => { ytd(a).dependencies.shift(); });
        rejects(a => { ytd(a).dependencies.reverse(); });
        rejects(a => { ytd(a).dependencies[1] = ytd(a).dependencies[0]; });
        rejects(a => { ytd(a).dependencies[1] = 'missing_node'; });
        rejects(a => { ytd(a).dependencies[1] = 'initial_book_vat'; });
        rejects(a => { ytd(a).formula = 'Q1_only'; });
        rejects(a => { ytd(a).minor = '1'; });
        rejects(a => { row(a.diagnostic.computation, n, 'yearToDate').calculationNode = 'payable'; });
      }
      for (const key of ['priorComputation', 'computation']) {
        rejects(a => { a.diagnostic[key].calculationNodes.push(structuredClone(a.diagnostic[key].calculationNodes[0])); });
        rejects(a => { a.diagnostic[key].calculationNodes = a.diagnostic[key].calculationNodes.filter(node => node.id !== 'taxable_base'); });
        rejects(a => { a.diagnostic[key].calculationNodes.find(node => node.id === 'taxable_base').formula = 'unrelated_formula'; });
        rejects(a => { a.diagnostic[key].calculationNodes.find(node => node.id === 'payable').minor = '1'; });
      }
      const copied = a => a.diagnostic.computation.calculationNodes.find(node => node.id === 'Q1:taxable_base');
      rejects(a => { copied(a).provenance.scope.period = '2026-Q2'; });
      rejects(a => { copied(a).provenance.contentDigest = '0'.repeat(64); });
      rejects(a => { copied(a).dependencies = copied(a).dependencies.map(id => id.replace('Q1:', '')); });
      rejects(a => { copied(a).formula = 'unrelated_formula'; });
      rejects(a => { copied(a).minor = '1'; });
    });
  }
  const f = outputs.get('QG01'), directory = join(root, 'QG01');
  const { runOfflineVatQ2: run, checkOfflineVatQ2Current: current } = await import('../server/offline-vat-q2.mjs');
  const blocked = d => { assert.equal(d.q2CalculationReady, false, JSON.stringify(d)); assert.equal(d.authorizesExecution, false); if (d.computation) assert.ok(d.computation.cells.every(c => c.value === null)); };
  const noWrites = async fn => { const before = databaseState(f.request.target.dbPath); try { return await fn(); } finally { assert.deepEqual(databaseState(f.request.target.dbPath), before); } };
  async function changeFile(path, mutate, fn) { const before = readFileSync(path); try { const d = json(path); mutate(d); writeJson(path, d); return await fn(); } finally { writeFileSync(path, before); } }
  for (const id of ['QG01', 'QG02']) await test(id + ' fresh real process reopens/replays all six existing operations without duplicate or schema/table writes', () => {
    const original = outputs.get(id), reopened = child('reopen', join(root, id));
    assert.deepEqual(reopened.diagnostic, original.diagnostic); assert.equal(reopened.actualProcessExit, 0); assert.equal(reopened.replay.length, 6);
  });
  await test('missing basic materials explicitly block; restored originals recover after fresh reread without writes', () => noWrites(async () => {
    const path = join(directory, 'raw/q2/business.json'); renameSync(path, path + '.held');
    try { blocked(await run(f.request)); } finally { renameSync(path + '.held', path); }
    assert.equal((await run(f.request)).contentDigest, f.diagnostic.contentDigest);
  }));
  await test('non-amount accounting basis correction stales old digest, keeps actual tax and cannot duplicate posting', () => noWrites(() => changeFile(join(directory, 'raw/q2/accounting.json'), d => { d.facts[1].basis += ' 合成补充合同复核说明'; }, async () => {
    const c = await current(f.request, f.diagnostic.contentDigest); assert.equal(c.status, 'stale'); assert.equal(c.diagnostic.q2CalculationReady, true); assert.equal(row(c.diagnostic.computation, 20).value, '3869.13');
    assert.equal(inspect(f.request.target.dbPath, db => db.prepare('SELECT COUNT(*) n FROM vouchers').get().n), 6);
    const { runOfflinePosting } = await import('../server/offline-posting.mjs');
    const r = f.requests.find(r => r.selected.businessKey === f.plans[1].plan.tasks.find(t => t.candidate?.date === '2026-05-17').businessKey);
    const query = { ...r, command: 'query' }; delete query.confirmation;
    const outcome = runOfflinePosting(query); assert.equal(outcome.status, 'conflict', JSON.stringify(outcome)); assert.equal(outcome.code, 'posting_semantic_conflict'); assert.equal(outcome.applied, true);
  })));
  await test('amount correction disagrees with existing posted original and blocks until an explicit accounting correction dependency', () => noWrites(async () => {
    const path = join(directory, 'raw/q2/sales.csv'), before = readFileSync(path);
    try {
      writeFileSync(path, before.toString().replace('151463.00,1514.63,152977.63', '151464.00,1514.64,152978.64'));
      const d = await run(f.request); blocked(d); assert.ok(d.computation.issues.some(i => i.code === 'posted_candidate_content_or_source_mismatch'));
      const { runOfflinePosting } = await import('../server/offline-posting.mjs');
      const k = f.plans[1].plan.tasks.find(t => t.candidate?.date === '2026-04-17').businessKey;
      const outcome = runOfflinePosting(f.requests.find(r => r.selected.businessKey === k));
      assert.equal(outcome.status, 'conflict', JSON.stringify(outcome)); assert.equal(outcome.code, 'posting_semantic_conflict'); assert.equal(outcome.applied, true);
    }
    finally { writeFileSync(path, before); }
  }));
  await test('cross enterprise and swapped quarter cannot borrow private successful computation', () => noWrites(async () => {
    blocked(await run({ ...f.request, target: { ...f.request.target, enterpriseKey: 'SYNTHETIC-OTHER' } }));
    blocked(await run({ ...f.request, priorInputPath: f.request.targetInputPath, targetInputPath: f.request.priorInputPath }));
  }));
  await test('public JSON cannot authenticate a private pair; all actual pair/source handles close', async () => {
    const { openVatInputPairFiles } = await import('../server/offline-vat-input.mjs');
    const { calculateOfflineVatQ2 } = await import('../server/tax-calculation.mjs');
    const { validateLedgerSnapshotPair } = await import('../server/offline-ledger-snapshot.mjs');
    const before = databaseState(f.request.target.dbPath), session = await openVatInputPairFiles(f.request);
    try { assert.throws(() => validateLedgerSnapshotPair(session.source, structuredClone(session.snapshots))); await assert.rejects(calculateOfflineVatQ2(JSON.parse(JSON.stringify(session)))); }
    finally { session.close(); }
    await assert.rejects(calculateOfflineVatQ2(session));
    assert.deepEqual(databaseState(f.request.target.dbPath), before);
  });
  await test('poisoned expected changes only acceptance assertion, never raw execution input or product output', () => {
    const bundle = join(root, 'poison'); cpSync(join(fixtures, 'raw/QG02'), join(bundle, 'raw'), { recursive: true }); mkdirSync(join(bundle, 'expected'));
    const expected = json(join(fixtures, 'expected/QG02.json')); expected.movements[0].expectedEntries[0].debit = '999999.99'; writeJson(join(bundle, 'expected/QG02.json'), expected);
    const actual = child('execute', join(root, 'poison-run'), join(bundle, 'raw')), original = outputs.get('QG02');
    assert.deepEqual(actual.plans.map(p => p.plan.tasks.map(t => t.candidate)), original.plans.map(p => p.plan.tasks.map(t => t.candidate)));
    assert.deepEqual(actual.trials, original.trials); assert.deepEqual(actual.diagnostic.computation.cells, original.diagnostic.computation.cells); assert.deepEqual(actual.diagnostic.priorComputation.cells, original.diagnostic.priorComputation.cells);
    assert.throws(() => assertQuarterlyOutput(actual, expected, join(bundle, 'raw')));
  });
} else { failed++; console.error('FAIL required follow-on acceptance cannot run before both mandatory main chains pass'); }
console.log(`offline-quarterly-golden ${passed}/${passed + failed}; two synthetic legal quarterly tax periods per case; unclosed accounting only; actual subprocess exit`);
if (!failed && process.env.KEEP_FIXTURES !== '1') rmSync(root, { recursive: true, force: true }); else console.log('Synthetic evidence retained: ' + root);
if (failed) process.exitCode = 1;
