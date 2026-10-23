import { assert, fs, join, DatabaseSync, harness, runChild } from './auxiliary-storage.test.mjs';
import { fileURLToPath } from 'node:url';
process.env.WORKBENCH_TEST_KEEP_FIXTURES = '1';
const h = await harness({ install: false });
const { db, dbPath, root, A, X, S, LB } = h;
const IM = await import('../server/import-incremental.mjs');
let count = 0;
function check(name, fn) { fn(); count++; console.log('ok ' + count + ' ' + name); }
function snapshot({ audit = true } = {}) {
  return JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .filter(r => audit || !['import_batches'].includes(r.name))
    .map(r => [r.name, db.prepare('SELECT * FROM "' + r.name + '" ORDER BY rowid').all()]));
}
const clone = value => structuredClone(value);
const part = (debit = 0, credit = 0, projectRef = 'P1', departmentRef = 'D1', partyRef = 'C1') => ({ projectRef, departmentRef, partyRef, debit, credit });
const entities = () => ['P1', 'P2', 'D1', 'D2', 'C1', 'C2'].map(ref => ({ ref, kind: ref[0] === 'P' ? 'project' : ref[0] === 'D' ? 'department' : 'party', code: ref, name: 'Same display' }));
const appendix = requestId => ({ version: 1, requestId, reason: 'Synthetic explicit source binding', entities: entities(), entries: [], openings: [] });
function voucher(sid, period, debitCode, creditCode, amount, number) {
  return { sourceVoucherId: sid, period, date: period + '-15', number, summary: 'Synthetic same summary',
    entries: [{ sourceEntryId: sid + '-debit', code: debitCode, summary: 'Same entry', debit: amount },
      { sourceEntryId: sid + '-credit', code: creditCode, summary: 'Same entry', credit: amount }] };
}
function fixture(label, multiplier = 1, profileId = 'small-2011-basic-v1') {
  const revenue = profileId === 'small-2011-basic-v1' ? '5001' : '6001';
  const capital = profileId === 'small-2011-basic-v1' ? '3001' : '4001';
  const input = { dryRun: false, mode: 'create', batchId: label + '-create', profileId,
    source: { system: 'synthetic', enterpriseKey: 'AUX-IMPORT-' + label },
    payload: { account_set: { name: 'Synthetic ' + label, start_period: '2025-12' },
      opening_balances: [{ code: '1122', debit: 1000 * multiplier }, { code: '1002', debit: 9000 * multiplier }, { code: capital, credit: 10000 * multiplier }],
      vouchers: [voucher('sale', '2025-12', '1122', revenue, 600 * multiplier, 1),
        voucher('receipt1', '2025-12', '1002', '1122', 300 * multiplier, 2),
        voucher('receipt2', '2025-12', '1002', '1122', 100 * multiplier, 3),
        voucher('unassigned', '2025-12', '1122', revenue, 200 * multiplier, 4)] }, auxiliaryAppendix: appendix(label + '-aux') };
  input.auxiliaryAppendix.openings = [{ openingCode: '1122', allocations: [part(1200 * multiplier), part(0, 200 * multiplier, 'P2', 'D2', 'C2')] }];
  input.auxiliaryAppendix.entries = [
    { sourceVoucherId: 'sale', sourceEntryId: 'sale-debit', allocations: [part(400 * multiplier), part(200 * multiplier, 0, 'P1', 'D2')] },
    { sourceVoucherId: 'receipt1', sourceEntryId: 'receipt1-credit', allocations: [part(0, 300 * multiplier)] },
    { sourceVoucherId: 'receipt2', sourceEntryId: 'receipt2-credit', allocations: [part(0, 100 * multiplier, 'P2', 'D2', 'C2')] }];
  return input;
}
function existingEntities(setId) {
  return entities().map(e => ({ ...e, existingId: X.listAuxiliaryEntities(db, { accountSetId: setId }).find(r => r.kind === e.kind && r.code === e.code).id }));
}
function assertRolledBack(input, pattern) {
  const before = snapshot({ audit: false });
  assert.throws(() => IM.importIncremental(input), pattern);
  assert.equal(snapshot({ audit: false }), before);
}
try {
  check('aux missing is rejected without writes', () => { const before = snapshot(); assert.throws(() => IM.importIncremental(fixture('missing')), /aux_not_installed/); assert.equal(snapshot(), before); });
  const cli = await runChild([fileURLToPath(new URL('../scripts/local-auxiliary.mjs', import.meta.url)), 'install', '--db', dbPath, '--out', join(root, 'cli-before-install')]);
  assert.equal(cli.code, 0, cli.stderr); assert.equal(cli.closed, true); S.assertAuxiliaryReady(db);
  console.log('actual install CLI close exit0');
  const inputs = [fixture('small'), fixture('enterprise', 2, 'enterprise-2019-general-basic-v1')], sets = [];
  for (const [i, input] of inputs.entries()) {
    const m = i + 1;
    check('create dryRun all tables unchanged profile ' + m, () => { const before = snapshot(); const preview = IM.importIncremental({ ...input, dryRun: true }); assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(snapshot(), before); });
    const result = IM.importIncremental(input); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.durability, 'committed'); assert.equal(result.auxiliary.status, 'applied'); sets.push(result.accountSetId);
    check('independent December gross/net and dimension aggregation profile ' + m, () => {
      const all = X.auxiliaryLedger(db, { accountSetId: result.accountSetId, period: '2025-12', code: '1122' });
      assert.deepEqual(all.totals, { opening: 1000 * m, debit: 800 * m, credit: 400 * m, closing: 1400 * m, debitBalance: 1700 * m, creditBalance: 300 * m });
      assert.equal(X.auxiliaryLedger(db, { accountSetId: result.accountSetId, period: '2025-12', code: '1002' }).totals.closing, 9400 * m);
      const party = X.auxiliaryLedger(db, { accountSetId: result.accountSetId, period: '2025-12', code: '1122', groupBy: ['party'] });
      const ids = new Map(X.listAuxiliaryEntities(db, { accountSetId: result.accountSetId, kind: 'party' }).map(r => [r.code, r.id]));
      assert.equal(party.groups.find(g => g.partyId === ids.get('C1')).closing, 1500 * m);
      assert.equal(party.groups.find(g => g.partyId === ids.get('C2')).closing, -300 * m);
    });
    check('same appendix replay writes zero tables profile ' + m, () => { const before = snapshot(); const replay = IM.importIncremental(input); assert.equal(replay.status, 'idempotent_replay'); assert.equal(replay.auxiliary.status, 'replayed'); assert.equal(snapshot(), before); });
    const next = { dryRun: false, mode: 'append', accountSetId: result.accountSetId, batchId: input.batchId + '-jan', source: input.source,
      payload: { account_set: clone(input.payload.account_set), vouchers: [voucher('jan-receipt', '2026-01', '1002', '1122', 500 * m, 1), voucher('reversal', '2026-01', m === 1 ? '5001' : '6001', '1122', 100 * m, 2)] },
      auxiliaryAppendix: { ...appendix('jan-' + m), entities: existingEntities(result.accountSetId), entries: [
        { sourceVoucherId: 'jan-receipt', sourceEntryId: 'jan-receipt-credit', allocations: [part(0, 300 * m), part(0, 200 * m, 'P1', 'D2')] },
        { sourceVoucherId: 'reversal', sourceEntryId: 'reversal-credit', allocations: [part(0, 100 * m)] }] } };
    check('append dryRun zero writes profile ' + m, () => { const before = snapshot(); const preview = IM.importIncremental({ ...next, dryRun: true }); assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(snapshot(), before); });
    assert.equal(IM.importIncremental(next).ok, true);
    check('independent January and bank carried balances profile ' + m, () => {
      const report = X.auxiliaryLedger(db, { accountSetId: result.accountSetId, period: '2026-01', code: '1122' });
      assert.equal(report.totals.opening, 1400 * m); assert.equal(report.totals.debit, 0); assert.equal(report.totals.credit, 600 * m); assert.equal(report.totals.closing, 800 * m);
      assert.equal(X.auxiliaryLedger(db, { accountSetId: result.accountSetId, period: '2026-01', code: '1002' }).totals.closing, 9900 * m);
      assert.deepEqual(report.groups.map(g => g.closing).sort((a, b) => a - b), [-300 * m, 0, 200 * m, 900 * m]);
    });
  }
  check('same entity codes are isolated between real profiles', () => { const a = X.listAuxiliaryEntities(db, { accountSetId: sets[0] }), b = X.listAuxiliaryEntities(db, { accountSetId: sets[1] }); assert.equal(a.some(x => b.some(y => y.id === x.id)), false); });
  check('changed same request conflicts and completed audit remains intact', () => { const changed = clone(inputs[0]); changed.auxiliaryAppendix.reason = 'Changed'; assertRolledBack(changed, /request_conflict/); assert.equal(IM.getImportBatch(inputs[0].batchId).batch.status, 'completed'); });
  check('legacy no appendix replay preserves core fingerprints and all auxiliary rows', () => { const old = clone(inputs[0]); delete old.auxiliaryAppendix; const before = snapshot(); assert.equal(IM.importIncremental(old).ok, true); assert.equal(snapshot(), before); });
  check('metadata does not change core content fingerprint', () => { const original = db.prepare('SELECT content_fingerprint,voucher_fingerprint FROM import_voucher_sources WHERE account_set_id=? ORDER BY source_voucher_id').all(sets[0]); const old = clone(inputs[0]); delete old.auxiliaryAppendix; old.payload.vouchers.forEach(v => v.entries.forEach(e => { delete e.sourceEntryId; })); assert.equal(IM.importIncremental(old).ok, true); assert.deepEqual(db.prepare('SELECT content_fingerprint,voucher_fingerprint FROM import_voucher_sources WHERE account_set_id=? ORDER BY source_voucher_id').all(sets[0]), original); });
  for (const [label, mutate, pattern] of [
    ['unknown shape', x => { x.auxiliaryAppendix.path = 'forbidden'; }, /aux_import_invalid/],
    ['wrong version', x => { x.auxiliaryAppendix.version = 2; }, /version_invalid/],
    ['missing raw source entry', x => { delete x.payload.vouchers[0].entries[0].sourceEntryId; }, /aux_import_invalid/],
    ['duplicate raw source entry', x => { x.payload.vouchers[0].entries[1].sourceEntryId = 'sale-debit'; }, /identity_duplicate/],
    ['derived voucher identity', x => { x.auxiliaryAppendix.entries[0].sourceVoucherId = 'derived:fake'; }, /explicit_identity/],
    ['duplicate appendix identity', x => { x.auxiliaryAppendix.entries.push(clone(x.auxiliaryAppendix.entries[0])); }, /identity_duplicate/],
    ['wrong dimension kind', x => { x.auxiliaryAppendix.entries[0].allocations[0].partyRef = 'D1'; }, /ref_invalid/],
    ['amount over GL', x => { x.auxiliaryAppendix.entries[0].allocations[0].debit = 9999; }, /exceeds_entry/],
    ['negative amount', x => { x.auxiliaryAppendix.entries[0].allocations[0].debit = -1; }, /amount_invalid/],
    ['subcent amount', x => { x.auxiliaryAppendix.entries[0].allocations[0].debit = 0.001; }, /amount_invalid/],
  ]) check(label + ' static rejection', () => { const input = fixture(label.replaceAll(' ', '-')); mutate(input); const before = snapshot(); assert.throws(() => IM.importIncremental(input), pattern); assert.equal(snapshot(), before); });
  check('prototype/accessor attacks refused without evaluation', () => { const x = fixture('prototype'); x.auxiliaryAppendix = JSON.parse('{"__proto__":{},"version":1}'); assert.throws(() => IM.importIncremental(x), /aux_import_invalid/); const y = fixture('getter'); Object.defineProperty(y.auxiliaryAppendix, 'reason', { get() { throw Error('getter executed'); }, enumerable: true }); assert.throws(() => IM.importIncremental(y), /aux_import_invalid/); });
  check('sparse arrays and extra properties refuse static shapes', () => {
    for (const mutate of [x => { x.auxiliaryAppendix.entities.length++; }, x => { x.auxiliaryAppendix.entries.extra = 'forbidden'; }, x => { Object.setPrototypeOf(x.auxiliaryAppendix.openings, null); }]) {
      const x = fixture('array-shape'); mutate(x); const before = snapshot(); assert.throws(() => IM.importIncremental(x), /aux_import_invalid/); assert.equal(snapshot(), before);
    }
  });
  check('data-only appendix rejects proxy callback surfaces', () => {
    const x = fixture('proxy'); x.auxiliaryAppendix = new Proxy(x.auxiliaryAppendix, { getPrototypeOf() { throw Error('proxy callback executed'); } }); const before = snapshot(); assert.throws(() => IM.importIncremental(x), /aux_import_invalid/); assert.equal(snapshot(), before);
  });
  check('unknown requested and persisted profiles reject without business writes', () => {
    const x = fixture('unknown-profile'); x.profileId = 'future-synthetic-profile'; const before = snapshot(); assert.equal(IM.importIncremental(x).ok, false); assert.equal(snapshot(), before);
    db.exec('BEGIN');
    try { db.prepare('UPDATE account_sets SET accounting_profile_id=? WHERE id=?').run('future-synthetic-profile', sets[0]); const mutated = snapshot(); assert.equal(IM.importIncremental(inputs[0]).ok, false); assert.equal(snapshot(), mutated); }
    finally { db.exec('ROLLBACK'); }
  });
  check('entity name and active edits cause old appendix replay conflict', () => {
    const entity = X.listAuxiliaryEntities(db, { accountSetId: sets[0], kind: 'party' })[0];
    for (const change of [{ name: 'Edited synthetic name' }, { active: false }]) {
      db.exec('BEGIN'); try { X.updateAuxiliaryEntity(db, { accountSetId: sets[0], entityId: entity.id, reason: 'synthetic state test', ...change }); assert.throws(() => IM.importIncremental(inputs[0]), /replay_state_conflict/); } finally { db.exec('ROLLBACK'); }
    }
  });
  // Inject only named write boundaries, retaining the real SQLite transaction and all real business calls.
  for (const [caseIndex, testCase] of ['create', 'append'].flatMap(mode => ['entity', 'second-map', 'allocation', 'request-receipt'].map(phase => ({ mode, phase }))).entries()) check(testCase.mode + ' ' + testCase.phase + ' failure rolls back every business table', () => {
    const { mode, phase } = testCase;
    const input = fixture('fault-' + mode + '-' + phase), prepare = db.prepare.bind(db); let maps = 0, fired = false;
    if (mode === 'append') {
      input.mode = 'append'; input.accountSetId = sets[0]; input.source = inputs[0].source;
      input.payload.account_set = clone(inputs[0].payload.account_set); input.payload.opening_balances = [];
      input.auxiliaryAppendix.openings = [];
      input.auxiliaryAppendix.entities.forEach(e => { e.code += '-fault-' + phase; });
      input.payload.vouchers.forEach((v, i) => { v.sourceVoucherId += '-fault-' + phase; v.number = 100 + caseIndex * 10 + i; v.entries.forEach(e => { e.sourceEntryId += '-fault-' + phase; }); });
      input.auxiliaryAppendix.entries.forEach(e => { e.sourceVoucherId += '-fault-' + phase; e.sourceEntryId += '-fault-' + phase; });
    }
    db.prepare = function(sql) {
      const statement = prepare(sql);
      if (/INSERT INTO aux_entities/.test(sql) && phase === 'entity') return { run() { fired = true; throw Error('synthetic entity boundary'); } };
      if (/INSERT INTO aux_allocations/.test(sql) && phase === 'allocation') return { run() { fired = true; throw Error('synthetic allocation boundary'); } };
      if (/INSERT INTO aux_receipts/.test(sql)) return { ...statement, run(...args) {
        if ((phase === 'second-map' && String(args[1]).startsWith('aux-import:map:') && ++maps === 2)
          || (phase === 'request-receipt' && String(args[1]).startsWith('aux-import:request:'))) { fired = true; throw Error('synthetic receipt boundary'); }
        return statement.run(...args);
      } };
      return statement;
    };
    try { assertRolledBack(input, /aux_import_failed/); assert.equal(fired, true); }
    finally { db.prepare = prepare; }
    assert.equal(IM.getImportBatch(input.batchId).batch.status, 'failed');
    assert.equal(IM.importIncremental(input).ok, true);
  });
  const legacy = fixture('legacy-late'); delete legacy.auxiliaryAppendix;
  legacy.payload.vouchers = [{ sourceVoucherId: 'twins', period: '2025-12', date: '2025-12-01', number: 1,
    entries: [{ code: '1122', summary: 'twin', debit: 50 }, { code: '1122', summary: 'twin', debit: 50 }, { code: '5001', credit: 100 }] }];
  legacy.payload.opening_balances = [];
  const legacySet = IM.importIncremental(legacy).accountSetId;
  const twins = X.listAuxiliaryEntries(db, { accountSetId: legacySet }).filter(e => e.code === '1122');
  const late = { ...clone(legacy), auxiliaryAppendix: { ...appendix('late'), entities: [entities()[4]], entries: [{ sourceVoucherId: 'twins', sourceEntryId: 'explicit-second-twin', allocations: [{ partyRef: 'C1', debit: 50 }] }] } };
  check('old completed twin entries require explicit actual ID', () => { const before = snapshot(); assert.throws(() => IM.importIncremental(late), /actual_entry_required/); assert.equal(snapshot(), before); });
  late.auxiliaryAppendix.entries[0].actualEntryId = twins[1].entryId;
  late.auxiliaryAppendix.entries.push({ sourceVoucherId: 'twins', sourceEntryId: 'unallocated-credit', actualEntryId: X.listAuxiliaryEntries(db, { accountSetId: legacySet }).find(e => e.code === '5001').entryId, allocations: [] });
  assert.equal(IM.importIncremental(late).auxiliary.status, 'applied');
  check('explicit second equal row bound; first remains unallocated; replay unchanged', () => { assert.equal(X.entryPartyAllocation(db, { accountSetId: legacySet, entryId: twins[0].entryId }).status, 'unknown'); assert.equal(X.entryPartyAllocation(db, { accountSetId: legacySet, entryId: twins[1].entryId }).status, 'confirmed'); const before = snapshot(); assert.equal(IM.importIncremental(late).auxiliary.status, 'replayed'); assert.equal(snapshot(), before); });
  check('new request cannot overwrite existing/manual allocation', () => { const x = clone(late); x.auxiliaryAppendix.requestId = 'overwrite'; x.auxiliaryAppendix.entities[0].existingId = X.listAuxiliaryEntities(db, { accountSetId: legacySet })[0].id; assertRolledBack(x, /allocation_exists/); });
  const extra = clone(late); extra.auxiliaryAppendix.requestId = 'extra'; extra.auxiliaryAppendix.entities[0].existingId = X.listAuxiliaryEntities(db, { accountSetId: legacySet })[0].id;
  extra.auxiliaryAppendix.entries[0].sourceEntryId = 'explicit-first-twin'; extra.auxiliaryAppendix.entries[0].actualEntryId = twins[0].entryId;
  check('different request explicitly adds previously unallocated target', () => { assert.equal(IM.importIncremental(extra).auxiliary.status, 'applied'); });
  check('same mapping cannot move to the other equal row', () => { const x = clone(late); x.auxiliaryAppendix.entries[0].actualEntryId = twins[0].entryId; assertRolledBack(x, /request_conflict|mapping_conflict/); });
  check('cross-batch dedupe reuses historical mapping, no core duplicates', () => { const x = clone(extra); x.mode = 'append'; x.accountSetId = legacySet; x.batchId = 'legacy-cross-batch'; x.auxiliaryAppendix.requestId = 'cross-batch'; x.auxiliaryAppendix.entries = [clone(late.auxiliaryAppendix.entries[1])]; delete x.auxiliaryAppendix.entries[0].actualEntryId; const core = db.prepare('SELECT * FROM import_voucher_sources ORDER BY id').all(); assert.equal(IM.importIncremental(x).ok, true); assert.deepEqual(db.prepare('SELECT * FROM import_voucher_sources ORDER BY id').all(), core); });
  check('cross-account entity IDs cannot bind', () => { const x = clone(extra); x.auxiliaryAppendix.requestId = 'cross-set'; x.auxiliaryAppendix.entries = []; x.auxiliaryAppendix.entities[0].existingId = X.listAuxiliaryEntities(db, { accountSetId: sets[1], kind: 'party' })[0].id; assertRolledBack(x, /entity_conflict/); });
  check('cross-account actual entry ID and reused source row identity refuse binding', () => {
    const x = clone(extra); x.auxiliaryAppendix.requestId = 'wrong-actual'; x.auxiliaryAppendix.entries = [{ sourceVoucherId: 'twins', sourceEntryId: 'new-identity', actualEntryId: X.listAuxiliaryEntries(db, { accountSetId: sets[1] })[0].entryId, allocations: [] }]; assertRolledBack(x, /mapping_conflict/);
    x.auxiliaryAppendix.entries[0].actualEntryId = twins[0].entryId; assertRolledBack(x, /mapping_conflict/);
  });
  check('native allocation receipt cannot collide with appendix namespace', () => {
    const x = clone(extra); x.auxiliaryAppendix.requestId = 'native-collision'; x.auxiliaryAppendix.entries = [];
    const scope = { protocol: 'aux-import/v1', sourceSystem: x.source.system, enterpriseKey: x.source.enterpriseKey };
    const requestId = 'aux-import:request:' + S.auxFingerprint([scope, x.auxiliaryAppendix.requestId]);
    const credit = X.listAuxiliaryEntries(db, { accountSetId: legacySet }).find(e => e.code === '5001').entryId;
    X.replaceAuxiliaryAllocations(db, { accountSetId: legacySet, entryId: credit, allocations: [], requestId, reason: 'synthetic reserved namespace collision' });
    assertRolledBack(x, /request_conflict/);
  });
  check('source unposting refuses replay and re-post restores same identity', () => { const vid = twins[0].voucherId; A.unpostVoucher(legacySet, vid); assert.equal(IM.importIncremental(late).ok, false); A.postVoucher(legacySet, vid); assert.equal(IM.importIncremental(late).ok, true); });
  check('closed source and later period reject appendix', () => { const vid = twins[0].voucherId; A.carryForwardProfit(legacySet, '2025-12', { yearEnd: true }); A.setPeriodStatus(legacySet, '2025-12', 'closed'); assert.throws(() => IM.importIncremental(late), /aux_period_closed/); A.setPeriodStatus(legacySet, '2025-12', 'open'); A.ensurePeriod(legacySet, '2026-01'); db.prepare("UPDATE periods SET status='closed' WHERE account_set_id=? AND period='2026-01'").run(legacySet); assert.throws(() => IM.importIncremental(late), /later_period_closed/); db.prepare("UPDATE periods SET status='open' WHERE account_set_id=? AND period='2026-01'").run(legacySet); assert.equal(db.prepare('SELECT status FROM vouchers WHERE id=?').get(vid).status, 'posted'); });
  check('two connections contention performs no partial writes', () => { const other = new DatabaseSync(dbPath); const before = snapshot(); try { other.exec('BEGIN IMMEDIATE'); assert.throws(() => IM.importIncremental(fixture('lock')), /aux_import_busy/); } finally { other.exec('ROLLBACK'); other.close(); } assert.equal(snapshot({ audit: false }), JSON.stringify(JSON.parse(before).filter(([name]) => name !== 'import_batches'))); });
  check('caller-owned transaction returns staged; rollback removes core and appendix', () => { const input = fixture('nested'), before = snapshot(); db.exec('BEGIN'); try { const result = IM.importIncremental(input); assert.equal(result.status, 'staged'); assert.equal(result.durability, 'pending_outer_commit'); assert.equal(result.auxiliary.status, 'staged'); } finally { db.exec('ROLLBACK'); } assert.equal(snapshot(), before); });
  check('completed core with new appendix respects caller savepoint durability', () => {
    const x = clone(extra); x.auxiliaryAppendix.requestId = 'late-nested'; x.auxiliaryAppendix.entries = [];
    const before = snapshot(); db.exec('BEGIN'); try { const result = IM.importIncremental(x); assert.equal(result.status, 'staged'); assert.equal(result.durability, 'pending_outer_commit'); assert.equal(result.auxiliary.status, 'staged'); } finally { db.exec('ROLLBACK'); } assert.equal(snapshot(), before);
  });
  check('saved mapping detects ID deletion/rebuild after explicit allocation removal', () => {
    const entry = twins[1], allocations = X.entryPartyAllocation(db, { accountSetId: legacySet, entryId: entry.entryId }); assert.equal(allocations.status, 'confirmed');
    X.replaceAuxiliaryAllocations(db, { accountSetId: legacySet, entryId: entry.entryId, allocations: [], requestId: 'clear-second', reason: 'synthetic old row rebuild' });
    const before = snapshot(); db.exec('BEGIN');
    try { db.prepare('DELETE FROM voucher_entries WHERE id=?').run(entry.entryId); db.prepare('INSERT INTO voucher_entries(voucher_id,line_no,code,summary,debit,credit) VALUES(?,?,?,?,?,?)').run(entry.voucherId, entry.lineNo, '1122', 'twin', 50, 0); assert.throws(() => IM.importIncremental(late), /mapping_conflict/); }
    finally { db.exec('ROLLBACK'); }
    assert.equal(snapshot(), before);
    db.exec('BEGIN'); try { db.prepare('UPDATE voucher_entries SET line_no=1 WHERE id=?').run(entry.entryId); assert.throws(() => IM.importIncremental(late), /mapping_conflict/); } finally { db.exec('ROLLBACK'); }
    assert.equal(snapshot(), before); assert.throws(() => IM.importIncremental(late), /replay_state_conflict/);
  });
  const backup = await LB.createBackup({ dbPath, outDir: join(root, 'official-appendix-backup') }); assert.equal(backup.ok, true, JSON.stringify(backup)); assert.equal((await LB.verifyBackup({ backupDir: backup.backupDir })).ok, true);
  const restored = await LB.restoreNew({ backupDir: backup.backupDir, targetDir: join(root, 'restored-appendix') }); assert.equal(restored.ok, true);
  const restoredDb = new DatabaseSync(join(restored.targetDir, 'workbench.db'));
  try { assert.deepEqual(restoredDb.prepare("SELECT * FROM aux_receipts WHERE request_id LIKE 'aux-import:%' ORDER BY account_set_id,request_id").all(), db.prepare("SELECT * FROM aux_receipts WHERE request_id LIKE 'aux-import:%' ORDER BY account_set_id,request_id").all()); assert.equal(restoredDb.prepare('PRAGMA foreign_key_check').all().length, 0); } finally { restoredDb.close(); }
  const moduleUrl = new URL('../server/import-incremental.mjs', import.meta.url).href, dbUrl = new URL('../server/db.mjs', import.meta.url).href;
  const continued = await runChild(['--input-type=module', '-e', `const {db}=await import(${JSON.stringify(dbUrl)});const I=await import(${JSON.stringify(moduleUrl)});try{const replay=I.importIncremental(${JSON.stringify(inputs[0])});if(!replay.ok||replay.auxiliary.status!=='replayed')throw Error('restored replay');const next=${JSON.stringify(fixture('restored-new'))};if(!I.importIncremental(next).ok)throw Error('restored continue');console.log('restored mapping replay and continued core+aux committed');}finally{db.close();}`], { env: { WORKBENCH_DATA_DIR: restored.targetDir } });
  assert.equal(continued.code, 0, continued.stderr); assert.equal(continued.closed, true); console.log(continued.stdout.trim());
  for (const boundary of ['begin-after', 'commit-after', 'rollback-before', 'release-after']) {
    const target = await LB.restoreNew({ backupDir: backup.backupDir, targetDir: join(root, 'unknown-' + boundary) }); assert.equal(target.ok, true);
    const child = await runChild(['--input-type=module', '-e', `import assert from 'node:assert/strict';const {db}=await import(${JSON.stringify(dbUrl)});const I=await import(${JSON.stringify(moduleUrl)});const exec=db.exec.bind(db);let injected=false;const mode=${JSON.stringify(boundary)};if(mode==='release-after')exec('BEGIN');db.exec=function(sql){const hit=mode==='begin-after'?sql==='BEGIN IMMEDIATE':mode==='commit-after'?sql==='COMMIT':mode==='rollback-before'?sql==='ROLLBACK':sql.startsWith('RELEASE aux_');if(!injected&&hit){injected=true;if(mode!=='rollback-before')exec(sql);throw Error('synthetic unknown boundary');}return exec(sql);};if(mode==='rollback-before'){const prepare=db.prepare.bind(db);db.prepare=sql=>/INSERT INTO aux_entities/.test(sql)?{run(){throw Error('synthetic body failure');}}:prepare(sql);}try{assert.throws(()=>I.importIncremental(${JSON.stringify(fixture('unknown-' + boundary))}),/aux_commit_unknown/);assert.equal(injected,true);assert.throws(()=>I.importIncremental(${JSON.stringify(inputs[0])}),/aux_connection_quarantined/);console.log(mode+' quarantined no automatic retry');}finally{if(db.isTransaction)exec('ROLLBACK');db.close();}`], { env: { WORKBENCH_DATA_DIR: target.targetDir } });
    assert.equal(child.code, 0, child.stderr); assert.equal(child.closed, true); console.log(child.stdout.trim());
  }
  console.log('auxiliary-import PASS ' + count + ' checks; actual CLI/restore/unknown children closed; fixtures retained');
} finally { db.close(); console.log('auxiliary-import database closed'); }
