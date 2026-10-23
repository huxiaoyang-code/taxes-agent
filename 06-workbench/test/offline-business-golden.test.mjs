#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertGoldenOutput } from './helpers/offline-business-golden-reference.mjs';

const workbench = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(workbench, 'test/fixtures/offline-business-golden-v1');
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));
const parent = resolve(workbench, '../.agent-runs'); mkdirSync(parent, { recursive: true });

// This execution function accepts only an actual raw directory. It never reads an
// expectation. Every case uses a fresh process, fresh DB and unchanged raw scope.
async function executeRaw(rawDirectory, temporaryDirectory) {
  process.env.WORKBENCH_DATA_DIR = join(temporaryDirectory, 'data');
  process.env.TEMP = temporaryDirectory; process.env.TMP = temporaryDirectory;
  mkdirSync(process.env.WORKBENCH_DATA_DIR);
  const A = await import('../server/accounting.mjs');
  const { db } = await import('../server/db.mjs');
  const IM = await import('../server/import-incremental.mjs');
  const { openOfflineActionInput, assertOfflineActionInputCurrent } = await import('../server/offline-action-input.mjs');
  const { buildOfflineCandidates } = await import('../server/offline-bookkeeping.mjs');
  const { openReadonlyLedgerSource, captureLedgerSnapshot, validateLedgerSnapshot } = await import('../server/offline-ledger-snapshot.mjs');
  const { calculateOfflineVat, VAT_SOURCE_SYSTEM } = await import('../server/tax-calculation.mjs');
  const { initMaterialStore, receiveMaterials, inspectMaterialStore } = await import('../server/offline-material-store.mjs');
  const { hash } = await import('../server/offline-material-adapters.mjs');
  const config = json(join(rawDirectory, 'config.json')), meta = json(join(rawDirectory, 'case.json'));
  let session, source;
  try {
    const set = A.createAccountSet({ name: config.scope.enterpriseKey, start_period: '2026-01', profileId: config.profileId, enterprise: { enterpriseKey: config.scope.enterpriseKey } });
    assert.equal(String(set.id), config.scope.accountSetId);
    for (const p of ['2026-01','2026-02','2026-03']) A.ensurePeriod(set.id, p);
    if (existsSync(join(rawDirectory, 'opening-facts.json'))) {
      const f = json(join(rawDirectory, 'opening-facts.json'));
      // Explicit test prerequisite derived from historical bank/capital facts.
      A.setOpeningBalances(set.id, [{ code: '1002', debit: Number(f.bankBalance) }, { code: '3001', credit: Number(f.contributedCapital) }]);
    }
    let inputPath = join(rawDirectory, 'config.json'), receipts;
    if (meta.receiptMode) {
      const store = join(temporaryDirectory, 'store'); await initMaterialStore(store, config.scope);
      const received = await receiveMaterials(store, join(rawDirectory, 'materials.json'));
      const receiptOutput = join(temporaryDirectory, 'reopened-receipts.json');
      const reopenCode = `import {inspectMaterialStore} from ${JSON.stringify(new URL('../server/offline-material-store.mjs', import.meta.url).href)}; import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2],JSON.stringify(await inspectMaterialStore(process.argv[1])));`;
      const reopen = spawnSync(process.execPath, ['--input-type=module','-e',reopenCode,store,receiptOutput], {encoding:'utf8',timeout:20000});
      assert.equal(reopen.status,0,reopen.stderr); assert.equal(reopen.signal,null); assert.equal(reopen.stderr,'');
      const reopened = json(receiptOutput); assert.equal(reopened.status, 'verified'); assert.ok(reopened.active.length > 0);
      assert.deepEqual((await inspectMaterialStore(store)).active, reopened.active);
      // A new reader below inspects actual persisted receipts and original files.
      const c = { ...config, declaration: join(rawDirectory, config.declaration), accountingFacts: join(rawDirectory, config.accountingFacts), materialStore: store }; delete c.materialsInput;
      inputPath = join(temporaryDirectory, 'store-config.json'); write(inputPath, c);
      receipts = { status: reopened.status, receiptIds: received.receiptIds, active: reopened.active, freshProcessReopen: true };
    }
    session = await openOfflineActionInput(inputPath);
    const candidateInput = (({ scope, profileId, reports, declaration, accountingFacts }) => ({ scope, profileId, reports, declaration, accountingFacts }))(session.rawInput);
    const candidates = buildOfflineCandidates(candidateInput);
    await assertOfflineActionInputCurrent(session);
    assert.ok(candidates.decisions.every(d => d.status === 'candidate'), JSON.stringify(candidates.decisions));
    // Test-only existing domain API bridge, identical to offline-vat's narrow
    // candidate-to-import adapter. No coordinator/permission/snapshot fabrication.
    const result = IM.importIncremental({ dryRun: false, confirmNewBinding: true, accountSetId: set.id, batchId: 'business-golden-' + meta.id, source: { system: VAT_SOURCE_SYSTEM, enterpriseKey: config.scope.enterpriseKey }, payload: { account_set: { name: config.scope.enterpriseKey, start_period: '2026-01', profileId: config.profileId }, vouchers: candidates.candidates.map(c => ({ period: c.date.slice(0, 7), date: c.date, sourceVoucherId: c.businessKey, summary: `offline:${c.businessKey}`, entries: c.entries.map(e => ({ code: e.accountCode, debit: e.debit, credit: e.credit, summary: e.detail ?? c.kind })) })) } });
    assert.equal(result.status, 'applied', JSON.stringify(result));
    const trials = ['2026-01','2026-02','2026-03'].map(p => A.trialBalance(set.id, p));
    source = openReadonlyLedgerSource(join(process.env.WORKBENCH_DATA_DIR, 'workbench.db'));
    const snapshot = captureLedgerSnapshot(source, { enterpriseKey: config.scope.enterpriseKey, accountSetId: set.id, fromPeriod: '2026-01', toPeriod: '2026-03' });
    const text = readFileSync(join(rawDirectory, 'tax.json'), 'utf8');
    const vatInput = { ...candidateInput, taxFacts: { text, fileSha256: hash(text) } };
    const vat = calculateOfflineVat(vatInput, source, snapshot);
    const output = { candidates: candidates.candidates, materialRecords: candidateInput.reports.flatMap(r => r.records), trials, snapshot, vat, receipts, diagnostics: {} };
    if (meta.id === 'G04') {
      const admin = candidates.candidates.find(c => c.kind === 'administrative_service');
      assert.equal(admin.date, '2026-02-20'); assert.equal(admin.entries[0].debit, '274.83');
      const invalid = [
        ['invoice_month', f => { f.benefitFrom = '2026-01-01'; f.benefitTo = '2026-01-31'; }],
        ['two_months', f => { f.benefitFrom = '2026-01-01'; }],
        ['completion_outside_scope', f => { f.completionDate = '2026-04-20'; f.benefitFrom = '2026-04-01'; f.benefitTo = '2026-04-30'; }],
        ['completion_outside_rule_year', f => { f.completionDate = '2027-02-20'; f.benefitFrom = '2027-02-01'; f.benefitTo = '2027-02-28'; }],
        ['completion_missing', f => { delete f.completionDate; }],
      ];
      for (const [name, mutate] of invalid) {
        const x = structuredClone(candidateInput), document = JSON.parse(x.accountingFacts.text);
        mutate(document.facts.find(f => f.kind === 'administrative_service'));
        x.accountingFacts.text = JSON.stringify(document); x.accountingFacts.fileSha256 = hash(x.accountingFacts.text);
        const rejected = buildOfflineCandidates(x); assert.equal(rejected.candidates.filter(c => c.kind === 'administrative_service').length, 0, name);
        assert.equal(rejected.candidates.filter(c => c.kind === 'service_sale').length, 1, name);
      }
      const conflicting = structuredClone(candidateInput), report = conflicting.reports.find(r => r.sources.some(s => s.kind === 'business_json')), raw = report.sources.find(s => s.kind === 'business_json');
      const original = JSON.parse(raw.rawContent); original.facts.find(f => f.invoiceRef?.sellerKey.startsWith('ADMIN')).benefitPeriod = { state: 'known', from: '2026-01-01', to: '2026-01-31' };
      const bytes = JSON.stringify(original);
      const { preflightMaterials } = await import('../server/offline-materials.mjs');
      conflicting.reports[conflicting.reports.indexOf(report)] = preflightMaterials({ scope: conflicting.scope, sources: [{ sourceId: raw.sourceId, kind: raw.kind, scope: raw.scope, mapping: raw.mapping, text: bytes, fileSha256: hash(bytes) }] });
      assert.equal(buildOfflineCandidates(conflicting).candidates.filter(c => c.kind === 'administrative_service').length, 0);
      output.diagnostics.adminMonthControls = [...invalid.map(([name]) => name), 'original_fact_conflict'];
    }
    if (meta.id === 'G01') {
      // Missing fact reopens admission; corrected facts change a stable business
      // version. These are extra controls, not additional business goldens.
      const less = structuredClone(candidateInput), facts = JSON.parse(less.accountingFacts.text); delete facts.facts[0].completionDate;
      less.accountingFacts.text = JSON.stringify(facts); less.accountingFacts.fileSha256 = hash(less.accountingFacts.text);
      assert.equal(buildOfflineCandidates(less).candidates.length, 0);
      const corrected = structuredClone(candidateInput), f = JSON.parse(corrected.accountingFacts.text); f.facts[0].basis = '合成更正合同依据'; corrected.accountingFacts.text = JSON.stringify(f); corrected.accountingFacts.fileSha256 = hash(corrected.accountingFacts.text);
      corrected.previousCandidates = candidates;
      assert.equal(buildOfflineCandidates(corrected).changes[0].state, 'newVersion');
      assert.throws(() => calculateOfflineVat(vatInput, source, JSON.parse(JSON.stringify(snapshot))), /ledger_snapshot_untrusted/);
      const cross = structuredClone(vatInput); cross.scope.enterpriseKey = 'SYNTHETIC-OTHER'; assert.throws(() => calculateOfflineVat(cross, source, snapshot), /scope_mismatch/);
      const period = structuredClone(vatInput); period.scope.period = '2026-Q2'; assert.throws(() => calculateOfflineVat(period, source, snapshot), /scope_mismatch/);
      const v = snapshot.vouchers[0]; A.unpostVoucher(set.id, v.id); assert.equal(validateLedgerSnapshot(source, snapshot).status, 'stale'); A.postVoucher(set.id, v.id);
      output.diagnostics.controls = ['missing_fact','corrected_fact_new_version','clone_rejected','cross_enterprise_rejected','cross_period_rejected','unpost_stales_snapshot'];
    }
    return output;
  } finally { session?.close(); source?.close(); db.close(); }
}

if (process.argv[2] === '--execute-raw') {
  try { write(process.argv[5], await executeRaw(resolve(process.argv[3]), resolve(process.argv[4]))); console.log('GOLDEN_RAW_EXECUTED DB_actualclose'); }
  catch (e) { console.error(e); process.exitCode = 1; }
} else {
  const root = mkdtempSync(join(parent, 'business-golden-synthetic-')); let failed = 0, passed = 0;
  const run = (raw, name) => {
    const tmp = join(root, name); mkdirSync(tmp); const output = join(tmp, 'actual.json');
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--execute-raw', raw, tmp, output], { cwd: workbench, encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stdout + child.stderr); assert.equal(child.stderr, ''); assert.match(child.stdout, /GOLDEN_RAW_EXECUTED DB_actualclose/);
    return json(output);
  };
  const test = (name, fn) => { try { fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } };
  const outputs = new Map();
  for (let i = 1; i <= 12; i++) {
    const id = 'G' + String(i).padStart(2, '0'), raw = join(fixtures, 'raw', id);
    test(id + ' independent raw -> domain ledger -> Jan/Feb/Mar trials -> VAT', () => {
      const actual = run(raw, id); outputs.set(id, actual);
      // The expected file is first read only after raw execution has completed.
      assertGoldenOutput(actual, json(join(fixtures, 'expected', id + '.json')), raw);
      if (id === 'G03') assert.equal(actual.candidates.length, 3);
      if (id === 'G05') { assert.equal(actual.receipts.status, 'verified'); assert.equal(actual.receipts.freshProcessReopen,true); assert.ok(actual.receipts.receiptIds.length > 0); }
    });
  }
  test('expected poison has zero influence on product execution', () => {
    const poison = json(join(fixtures, 'expected/G01.json')); poison.vouchers[0].entries[0].debit = '999999.99';
    const bundle = join(root,'poison-bundle'); mkdirSync(join(bundle,'expected'),{recursive:true});
    cpSync(join(fixtures,'raw/G01'),join(bundle,'raw/G01'),{recursive:true});
    write(join(bundle,'expected/G01.json'),poison);
    const actual = run(join(bundle,'raw/G01'), 'expected-isolation');
    assert.deepEqual(actual.candidates, outputs.get('G01').candidates);
    assert.deepEqual(actual.trials, outputs.get('G01').trials); assert.deepEqual(actual.vat.cells, outputs.get('G01').vat.cells);
    assert.throws(() => assertGoldenOutput(actual, poison, join(fixtures, 'raw/G01')));
  });
  test('raw corrections and red invoice cannot reuse original golden', () => {
    // Raw-only material replay probes, without any posting or expectation input.
    const probeScript = join(root, 'probe.mjs');
    writeFileSync(probeScript, `import {preflightMaterials} from ${JSON.stringify(new URL('../server/offline-materials.mjs', import.meta.url).href)}; import {buildOfflineCandidates} from ${JSON.stringify(new URL('../server/offline-bookkeeping.mjs', import.meta.url).href)}; import {openOfflineActionInput} from ${JSON.stringify(new URL('../server/offline-action-input.mjs', import.meta.url).href)}; import {hash} from ${JSON.stringify(new URL('../server/offline-material-adapters.mjs', import.meta.url).href)}; import {readFileSync,writeFileSync} from 'node:fs'; const s=await openOfflineActionInput(process.argv[2]);const i=(({scope,profileId,reports,declaration,accountingFacts})=>({scope,profileId,reports,declaration,accountingFacts}))(s.rawInput);const out=[]; for(const [from,to] of [['300000.00,3000.00,303000.00','300001.00,3000.01,303001.01'],['300000.00,3000.00,303000.00,blue','-300000.00,-3000.00,-303000.00,red']]){const x=structuredClone(i);const source=x.reports[0].sources[0];const text=source.rawContent.replace(from,to);x.reports[0]=preflightMaterials({scope:x.scope,sources:[{sourceId:source.sourceId,kind:source.kind,scope:source.scope,mapping:source.mapping,text,fileSha256:hash(text)}]});out.push(buildOfflineCandidates(x));} writeFileSync(process.argv[3],JSON.stringify(out));s.close();`);
    const path = join(root, 'probes.json'), c = spawnSync(process.execPath, [probeScript, join(fixtures,'raw/G01/config.json'), path], { encoding:'utf8',timeout:20000 });
    assert.equal(c.status,0,c.stderr); const [changed,red] = json(path);
    assert.equal(changed.candidates[0].entries[0].debit, '303001.01'); assert.notEqual(changed.candidates[0].contentVersion,outputs.get('G01').candidates[0].contentVersion);
    assert.equal(red.candidates.length,0); assert.ok(red.decisions.some(d=>d.status!=='candidate'));
  });
  test('fractional raw net keeps actual book tax but unsupported declaration fields null', () => {
    const raw = join(root, 'fractional-raw'); cpSync(join(fixtures, 'raw/G01'), raw, { recursive: true });
    const file = join(raw, 'sales.csv'); writeFileSync(file, readFileSync(file, 'utf8').replace('300000.00,3000.00,303000.00', '300000.01,3000.00,303000.01'));
    const meta = json(join(raw, 'case.json')); meta.id = 'fractional-control'; write(join(raw, 'case.json'), meta);
    const actual = run(raw, 'fractional-control'); assert.equal(actual.candidates[0].entries[2].credit, '3000.00');
    assert.equal(actual.vat.status, 'unsupported'); assert.ok(actual.vat.issues.some(i => i.code === 'fractional_net_requires_rounding_policy'));
    for (const cell of actual.vat.cells) assert.equal(cell.value, null);
  });
  console.log(`offline-business-golden ${passed}/${passed + failed}; 12 business cases; subprocess DB actualclose`);
  if (!failed && process.env.KEEP_FIXTURES !== '1') rmSync(root,{recursive:true,force:true}); else console.log('Synthetic fixtures retained: '+root);
  if (failed) process.exitCode=1;
}
