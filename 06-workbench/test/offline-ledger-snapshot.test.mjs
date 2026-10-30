#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, copyFileSync, renameSync, writeFileSync, statSync, linkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openReadonlyLedgerSource, captureLedgerSnapshot, validateLedgerSnapshot } from '../server/offline-ledger-snapshot.mjs';

// 只在隔离后导入写入器。不使用生产/默认数据库。
const fixtureParent = resolve('..', '.agent-runs'); mkdirSync(fixtureParent, { recursive: true });
const root = mkdtempSync(join(fixtureParent, 'offline-ledger-synthetic-'));
process.env.TEMP = root; process.env.TMP = root;
process.env.WORKBENCH_DATA_DIR = join(root, 'seed');
mkdirSync(process.env.WORKBENCH_DATA_DIR);
let legacyDb,legacySource,setupCompleted=false;
let db, source, failed = 0, passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name, error); }
};
const checksum = file => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
const logical = () => JSON.stringify(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all().concat(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => ({ name, rows: db.prepare('SELECT * FROM "' + name + '"').all() }))));
try {
  ({ db } = await import('../server/db.mjs'));
  const A = await import('../server/accounting.mjs'), IM = await import('../server/import-incremental.mjs');
  const file = join(process.env.WORKBENCH_DATA_DIR, 'workbench.db');
  const key = 'SYNTHETIC-SNAPSHOT-PRIVATE-137';
  const result = IM.importIncremental({ dryRun: false, batchId: 'synthetic-snapshot-batch', source: { system: 'synthetic-local', enterpriseKey: key, enterpriseName: '合成快照企业' }, payload: {
    account_set: { name: '合成快照账套', start_period: '2026-01', profileId: 'small-2011-basic-v1' },
    opening_balances: [{ code: '1002', debit: 837.19 }, { code: '3001', credit: 837.19 }],
    vouchers: [{ period: '2026-01', date: '2026-01-13', sourceVoucherId: 'SYNTH-SRC-1', summary: '合成服务收入', entries: [{ code: '1122', debit: 1297.43 }, { code: '5001', credit: 1284.58 }, { code: '2221', credit: 12.85 }] }],
  } });
  assert.equal(result.status, 'applied', JSON.stringify(result));
  const id = result.created.accountSetId;
  const postedId = A.listVouchers(id, { period: '2026-01' })[0].id;
  const draft = A.createVoucher(id, { period: '2026-02', voucher_date: '2026-02-17', summary: '合成草稿', entries: [{ code: '5602', debit: 74.29 }, { code: '1002', credit: 74.29 }] });
  const other = A.createAccountSet({ name: '合成乙', start_period: '2026-01', enterprise: { enterpriseKey: 'SYNTHETIC-SNAPSHOT-OTHER' } });
  const scope = { enterpriseKey: key, accountSetId: id, fromPeriod: '2026-01', toPeriod: '2026-03' };
  // 私有的精确 15 表历史核心/导入副本；默认种子保留 audit2。
  const LB=await import('../server/local-backup.mjs');
  const tables=LB.backupContract().requiredTables;
  assert.equal(tables.length,15);
  const legacyDir=join(root,'legacy-core');mkdirSync(legacyDir);const legacyFile=join(legacyDir,'workbench.db');
  let reader;
  try {
    reader=new DatabaseSync(file,{readOnly:true});reader.exec('BEGIN');LB.assertSupportedDatabaseConnection(reader);
    const facts=()=>JSON.stringify(tables.map(name=>({name,sql:reader.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name).sql,rows:reader.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()})));
    const before=facts(),sourceLogical=logical();
    legacyDb=new DatabaseSync(legacyFile);legacyDb.exec('PRAGMA foreign_keys=OFF; BEGIN');
    const objects=reader.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid').all().filter(o=>tables.includes(o.tbl_name));
    for(const object of objects.filter(o=>o.type==='table'))legacyDb.exec(object.sql);
    for(const name of tables){const rows=reader.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all();for(const row of rows){const keys=Object.keys(row);legacyDb.prepare('INSERT INTO "'+name+'" ('+keys.map(k=>'"'+k+'"').join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k]));}}
    legacyDb.exec('DELETE FROM sqlite_sequence');
    const sequence=reader.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY rowid').all().filter(r=>tables.includes(r.name));
    for(const row of sequence)legacyDb.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq);
    for(const object of objects.filter(o=>o.type!=='table')){assert.ok(!/\b(?:audit_|local_batch_|aux_|bank_)/i.test(object.sql));legacyDb.exec(object.sql);}
    legacyDb.exec('COMMIT; PRAGMA foreign_keys=ON');
    assert.deepEqual(legacyDb.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(legacyDb.prepare('PRAGMA integrity_check').get().integrity_check,'ok');LB.assertSupportedDatabaseConnection(legacyDb);
    assert.equal(JSON.stringify(tables.map(name=>({name,sql:legacyDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name).sql,rows:legacyDb.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()}))),before);
    assert.deepEqual(legacyDb.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY rowid').all(),sequence);
    assert.deepEqual(legacyDb.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r=>r.version),[1,2,3,4,5]);
    assert.equal(legacyDb.prepare("SELECT debit FROM opening_balances WHERE account_set_id=? AND code='1002'").get(id).debit,837.19);
    assert.deepEqual(legacyDb.prepare('SELECT debit,credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no').all(postedId).map(r=>[r.debit,r.credit]),[[1297.43,0],[0,1284.58],[0,12.85]]);
    assert.equal(legacyDb.prepare('SELECT debit FROM voucher_entries WHERE voucher_id=? AND line_no=1').get(draft.id).debit,74.29);
    assert.equal(facts(),before);assert.equal(logical(),sourceLogical);
    reader.exec('ROLLBACK');
  } finally {if(reader){if(reader.isTransaction)reader.exec('ROLLBACK');reader.close();console.log('legacy seed reader actualclose');}}
  legacySource=openReadonlyLedgerSource(legacyFile);
  const captureLegacy=()=>captureLedgerSnapshot(legacySource,scope);
  const currentLegacy=s=>assert.equal(validateLedgerSnapshot(legacySource,s).status,'current');
  const staleLegacy=s=>assert.equal(validateLedgerSnapshot(legacySource,s).status,'stale');
  assert.equal((await import('../server/local-audit-storage.mjs')).inspectAuditSchema(legacyDb).state,'not_installed');
  assert.equal((await import('../server/local-batch-storage.mjs')).inspectBatchSchema(legacyDb).state,'not_installed');
  setupCompleted=true;
  source = openReadonlyLedgerSource(file);
  const capture = () => captureLedgerSnapshot(source, scope);
  const current = snapshot => assert.equal(validateLedgerSnapshot(source, snapshot).status, 'current');
  const stale = snapshot => assert.equal(validateLedgerSnapshot(source, snapshot).status, 'stale');

  await test('actual imported posted entries retain IDs, date, line order and independent exact cents; draft excluded from posted counts', () => {
    const s = capture(), p = s.vouchers.find(v => v.id === postedId);
    assert.equal(p.status, 'posted'); assert.equal(p.voucher_date, '2026-01-13');
    assert.deepEqual(p.entries.map(e => [e.line_no, e.code, e.debitMinor, e.creditMinor]), [[1, '1122', 129743, 0], [2, '5001', 0, 128458], [3, '2221', 0, 1285]]);
    assert.ok(p.entries.every(e => Number.isInteger(e.id) && e.voucher_id === postedId));
    assert.deepEqual(s.counts, { posted: 1, draft: 1, otherStatus: 0, postedEntries: 3, priorVouchers: 0 });
    assert.equal(s.vouchers.find(v => v.id === draft.id).entries[0].debitMinor, 7429);
    assert.equal(s.openingBalances.find(o => o.code === '1002').debitMinor, 83719);
    assert.equal(s.profile.status, 'registered'); assert.equal(s.profile.definition.id, 'small-2011-basic-v1');
    assert.equal(s.sources.checks[0].status, 'matches_persisted_content'); assert.equal(s.sources.checks[0].batchAssociation, 'registered');
    assert.equal(s.sources.checks[0].originalFileVerification, 'unverified'); current(s);
  });
  await test('default product audit2 remains verified with exact amounts and repeated capture is readonly', async()=>{
    const audit=await import('../server/local-audit-storage.mjs');assert.equal(audit.inspectAuditSchema(db).version,2);assert.equal(audit.inspectAuditSchema(db).ok,true);
    const before=logical(),snapshot=capture();assert.equal(snapshot.instance.status,'verified_local_audit_instance');assert.equal(snapshot.instance.instanceId,audit.currentAuditInstanceId(db));
    assert.equal(snapshot.openingBalances.find(r=>r.code==='1002').debitMinor,83719);assert.equal(snapshot.vouchers.find(r=>r.id===postedId).entries[0].debitMinor,129743);assert.equal(snapshot.vouchers.find(r=>r.id===draft.id).entries[0].debitMinor,7429);current(snapshot);capture();assert.equal(logical(),before);
  });
  await test('three months are enumerated and missing March/coverage/history are never a zero-declaration conclusion', () => {
    const s = captureLegacy(); assert.deepEqual(s.scope.requestedPeriods, ['2026-01', '2026-02', '2026-03']);
    assert.deepEqual(s.completeness.missingPeriods, ['2026-03']);
    assert.equal(s.completeness.zeroDeclaration, 'not_assessed'); assert.equal(s.completeness.coverage, 'unverified');
    assert.equal(s.completeness.priorHistoryCompleteness, 'unverified'); assert.equal(s.completeness.openingCompleteness, 'unverified');
    assert.equal(s.calculationReady, false); assert.equal(s.submittable, false); assert.equal(s.authorizesExecution, false);
    assert.equal(s.instance.status, 'unverified'); assert.equal(s.instance.instanceId, null);
  });
  await test('empty real book is explicitly incomplete and never ready or zero', () => {
    const s = captureLedgerSnapshot(source, { ...scope, enterpriseKey: 'SYNTHETIC-SNAPSHOT-OTHER', accountSetId: other.id });
    assert.equal(s.counts.posted, 0); assert.equal(s.openingBalances.length, 0); assert.equal(s.calculationReady, false);
    assert.deepEqual(s.completeness.missingPeriods, ['2026-02', '2026-03']); assert.equal(s.completeness.zeroDeclaration, 'not_assessed');
  });
  await test('scope is strict, bound, ordered and limited to 120 months', () => {
    for (const s of [{ ...scope, accountSetId: other.id }, { ...scope, enterpriseKey: 'other' }]) assert.throws(() => captureLedgerSnapshot(source, s), /ledger_binding_mismatch/);
    for (const s of [null, { ...scope, extra: true }, { ...scope, accountSetId: String(id) }, { ...scope, fromPeriod: '2026-04' }, { ...scope, fromPeriod: '2026-00' }, { ...scope, fromPeriod: '2016-01' }]) assert.throws(() => captureLedgerSnapshot(source, s), /ledger_scope_invalid/);
  });
  await test('deep frozen product, upload/JSON/clone/digest and arbitrary db handles cannot authorize reads', () => {
    const s = capture(); assert.throws(() => { s.vouchers[0].entries[0].debit = 1; }, TypeError);
    assert.throws(() => { s.profile.definition.roles.bank = 'bad'; }, TypeError);
    for (const forged of [JSON.parse(JSON.stringify(s)), structuredClone(s), { ...s, producer: 'trusted', status: 'posted' }, { contentDigest: s.contentDigest }]) assert.throws(() => validateLedgerSnapshot(source, forged), /ledger_snapshot_untrusted/);
    assert.throws(() => captureLedgerSnapshot(db, scope), /ledger_source_unavailable/);
    const another = openReadonlyLedgerSource(file); try { assert.throws(() => validateLedgerSnapshot(another, s), /ledger_snapshot_untrusted/); } finally { another.close(); }
  });
  await test('independent status change via real post/unpost makes snapshot stale', () => {
    const s = capture(); A.postVoucher(id, draft.id); stale(s);
    const after = capture(); assert.equal(after.counts.posted, 2); A.unpostVoucher(id, draft.id); stale(after);
  });
  await test('stored amount correction stales and current import fingerprint reports mismatch', () => {
    const s = capture(); db.prepare('UPDATE voucher_entries SET debit=1297.44 WHERE voucher_id=? AND line_no=1').run(postedId);
    try { stale(s); assert.equal(capture().sources.checks[0].status, 'fingerprint_mismatch'); }
    finally { db.prepare('UPDATE voucher_entries SET debit=1297.43 WHERE voucher_id=? AND line_no=1').run(postedId); }
  });
  await test('illegal subcent stored value is retained and never rounded into valid minor units or fingerprint proof', () => {
    db.prepare('UPDATE voucher_entries SET debit=1297.431 WHERE voucher_id=? AND line_no=1').run(postedId);
    try { const s = capture(); assert.equal(s.vouchers[0].entries[0].debit, 1297.431); assert.equal(s.vouchers[0].entries[0].debitMinor, null); assert.equal(s.completeness.moneyIssues.length, 1); assert.equal(s.sources.checks[0].status, 'stored_money_invalid'); }
    finally { db.prepare('UPDATE voucher_entries SET debit=1297.43 WHERE voucher_id=? AND line_no=1').run(postedId); }
  });
  await test('actual SQLite nonfinite amounts reject capture and revalidation; optional raw numeric columns cannot collide with null', () => {
    const s = capture();
    try {
      for (const value of [Infinity, -Infinity]) {
        db.prepare('UPDATE voucher_entries SET debit=? WHERE voucher_id=? AND line_no=1').run(value, postedId);
        assert.equal(db.prepare('SELECT debit FROM voucher_entries WHERE voucher_id=? AND line_no=1').get(postedId).debit, value);
        assert.throws(() => capture(), /ledger_stored_number_invalid/); assert.throws(() => validateLedgerSnapshot(source, s), /ledger_stored_number_invalid/);
      }
    } finally { db.prepare('UPDATE voucher_entries SET debit=1297.43 WHERE voucher_id=? AND line_no=1').run(postedId); }
    current(s);
    // 核心创建副本上的损坏/前向列测试样本：原始非金额
    // 数字证据也接受相同检查，包括实际 SQL NULL。
    const copy = join(root, 'nonfinite-column.db'); db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    const writer = new DatabaseSync(copy); let h;
    try {
      writer.exec('ALTER TABLE accounts ADD COLUMN synthetic_nullable REAL');
      h = openReadonlyLedgerSource(copy); const before = captureLedgerSnapshot(h, scope);
      assert.equal(before.accounts.find(a => a.code === '1002').synthetic_nullable, null);
      for (const value of [Infinity, -Infinity]) {
        writer.prepare("UPDATE accounts SET synthetic_nullable=? WHERE account_set_id=? AND code='1002'").run(value, id);
        assert.throws(() => captureLedgerSnapshot(h, scope), /ledger_stored_number_invalid/); assert.throws(() => validateLedgerSnapshot(h, before), /ledger_stored_number_invalid/);
      }
      writer.prepare("UPDATE accounts SET synthetic_nullable=NULL WHERE account_set_id=? AND code='1002'").run(id);
      assert.equal(validateLedgerSnapshot(h, before).status, 'current');
    } finally { h?.close(); writer.close(); }
  });
  await test('source registration/content change stales; manual draft remains missing-source evidence', () => {
    const s = capture(); assert.ok(s.completeness.vouchersWithoutRegisteredSource.includes(draft.id));
    const old = db.prepare('SELECT * FROM import_voucher_sources WHERE voucher_id=?').get(postedId);
    db.prepare("UPDATE import_voucher_sources SET content_fingerprint='corrected-source' WHERE id=?").run(old.id);
    try { stale(s); } finally { db.prepare('UPDATE import_voucher_sources SET content_fingerprint=? WHERE id=?').run(old.content_fingerprint, old.id); }
    db.prepare("UPDATE import_voucher_sources SET voucher_fingerprint='' WHERE id=?").run(old.id);
    try { assert.equal(capture().sources.checks[0].status, 'fingerprint_missing'); } finally { db.prepare('UPDATE import_voucher_sources SET voucher_fingerprint=? WHERE id=?').run(old.voucher_fingerprint, old.id); }
  });
  await test('profile missing/unknown has no fallback and any profile correction stales', () => {
    const original = db.prepare('SELECT accounting_profile_id p FROM account_sets WHERE id=?').get(id).p;
    const s = capture(); db.prepare("UPDATE account_sets SET accounting_profile_id='unknown-synthetic' WHERE id=?").run(id);
    try { stale(s); const broken = capture(); assert.equal(broken.profile.status, 'unknown'); assert.equal(broken.profile.definition, null); }
    finally { db.prepare('UPDATE account_sets SET accounting_profile_id=? WHERE id=?').run(original, id); }
  });
  await test('opening/account/period metadata changes each stale', () => {
    for (const [sql, undo] of [
      ["UPDATE opening_balances SET debit=837.20 WHERE account_set_id=" + id + " AND code='1002'", "UPDATE opening_balances SET debit=837.19 WHERE account_set_id=" + id + " AND code='1002'"],
      ["UPDATE accounts SET name='Synthetic corrected' WHERE account_set_id=" + id + " AND code='1002'", null],
      ["UPDATE periods SET status='closed' WHERE account_set_id=" + id + " AND period='2026-02'", "UPDATE periods SET status='open' WHERE account_set_id=" + id + " AND period='2026-02'"],
    ]) {
      const accountName = db.prepare("SELECT name FROM accounts WHERE account_set_id=? AND code='1002'").get(id).name;
      const s = capture(); db.exec(sql); stale(s);
      if (undo) db.exec(undo); else db.prepare("UPDATE accounts SET name=? WHERE account_set_id=? AND code='1002'").run(accountName, id);
    }
  });
  await test('canonical binding correction invalidates old target', () => {
    const s = capture(); db.prepare('UPDATE import_enterprise_account_sets SET enterprise_name=? WHERE account_set_id=?').run('合成更正', id);
    stale(s);
    // 空账簿没有受外键绑定的已导入来源行；重新绑定它可覆盖
    // 作用域消失，同时不削弱 SQLite 有效导入外键契约。
    const now = captureLedgerSnapshot(source, { ...scope, enterpriseKey: 'SYNTHETIC-SNAPSHOT-OTHER', accountSetId: other.id });
    db.prepare('UPDATE import_enterprise_account_sets SET enterprise_key=? WHERE account_set_id=?').run('SYNTHETIC-REBOUND', other.id);
    try { stale(now); } finally { db.prepare('UPDATE import_enterprise_account_sets SET enterprise_key=? WHERE account_set_id=?').run('SYNTHETIC-SNAPSHOT-OTHER', other.id); }
  });
  await test('other enterprise and future target period changes do not stale selected range', () => {
    const s = capture(); A.createVoucher(other.id, { period: '2026-01', entries: [{ code: '1002', debit: 19.37 }, { code: '3001', credit: 19.37 }] }); current(s);
    A.createVoucher(id, { period: '2026-04', entries: [{ code: '5602', debit: 29.51 }, { code: '1002', credit: 29.51 }] }); current(s);
    assert.equal(capture().vouchers.some(v => v.period === '2026-04'), false);
  });
  await test('earlier posted history is captured separately and corrections stale a later range', () => {
    const s = captureLedgerSnapshot(source, { ...scope, fromPeriod: '2026-02' });
    assert.equal(s.counts.priorVouchers, 1); assert.equal(s.counts.posted, 0); assert.equal(s.vouchers.find(v => v.id === postedId).range, 'prior_history');
    const summary = db.prepare('SELECT summary FROM vouchers WHERE id=?').get(postedId).summary;
    db.prepare("UPDATE vouchers SET summary='synthetic corrected history' WHERE id=?").run(postedId);
    try { stale(s); } finally { db.prepare('UPDATE vouchers SET summary=? WHERE id=?').run(summary, postedId); }
  });
  await test('all reads use one SQLite transaction despite a real committed writer between queries', () => {
    const original = DatabaseSync.prototype.prepare; let committed = false;
    DatabaseSync.prototype.prepare = function(sql, ...args) {
      const statement = original.call(this, sql, ...args);
      if (sql === 'SELECT * FROM account_sets WHERE id=?' && this !== db) {
        const all = statement.all.bind(statement);
        statement.all = (...params) => {
          const rows = all(...params);
          if (!committed) { committed = true; A.createVoucher(id, { period: '2026-03', entries: [{ code: '5602', debit: 31.67 }, { code: '1002', credit: 31.67 }] }); }
          return rows;
        };
      }
      return statement;
    };
    let s;
    try { s = capture(); } finally { DatabaseSync.prototype.prepare = original; }
    assert.equal(committed, true); assert.equal(s.vouchers.some(v => v.period === '2026-03'), false); assert.deepEqual(s.completeness.missingPeriods, ['2026-03']);
    stale(s); assert.equal(capture().vouchers.some(v => v.period === '2026-03'), true);
  });
  await test('production capture/validate issue no DB/schema writes and leave main/WAL bytes unchanged', () => {
    const before = logical(), hashes = [checksum(file), checksum(file + '-wal')], changes = db.prepare('SELECT total_changes() n').get().n;
    for (let i = 0; i < 3; i++) current(capture());
    assert.equal(logical(), before); assert.deepEqual([checksum(file), checksum(file + '-wal')], hashes); assert.equal(db.prepare('SELECT total_changes() n').get().n, changes);
    assert.deepEqual(Object.keys(source), ['close']);
  });
  await test('CLI real output is diagnostic, stdout fixed/safe, rejects overwrite and never creates default or missing DB', () => {
    const output = join(root, 'snapshot.json'), absent = join(root, 'PRIVATE-MISSING.db'), defaultDir = join(root, 'must-not-create');
    const cli = resolve('scripts/offline-ledger-snapshot.mjs');
    const args = ['--db', file, '--enterprise-key', key, '--account-set-id', String(id), '--from', '2026-01', '--to', '2026-03', '--output', output];
    const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', WORKBENCH_DATA_DIR: defaultDir } });
    const before = logical(), r = run(args); assert.equal(r.status, 0, r.stderr); assert.equal(r.signal, null); assert.equal(r.stderr, ''); assert.match(r.stdout, /^OFFLINE_LEDGER_SNAPSHOT_WRITTEN posted=1 draft=2 missingPeriods=0\n$/);
    const exported = JSON.parse(readFileSync(output, 'utf8')); assert.equal(exported.exportTrust, 'diagnostic_only_not_restorable'); assert.throws(() => validateLedgerSnapshot(source, exported), /ledger_snapshot_untrusted/);
    const hash = checksum(output); assert.equal(run(args).status, 4); assert.equal(checksum(output), hash);
    for (const badArgs of [[], [...args, '--extra', key], ['--db', absent, ...args.slice(2)], [...args.slice(0, 3), 'PRIVATE-BAD-KEY', ...args.slice(4)]]) {
      const bad = run(badArgs); assert.ok([2, 4].includes(bad.status)); assert.equal(bad.signal, null); assert.equal(bad.stderr, ''); assert.match(bad.stdout, /^OFFLINE_LEDGER_SNAPSHOT_(USAGE_ERROR|REJECTED)\n$/);
    }
    assert.equal(logical(), before); assert.equal(existsSync(defaultDir), false); assert.equal(existsSync(absent), false);
  });
  await test('official batch instance installation/change stales even while audit remains absent', async () => {
    const before = captureLegacy(); assert.equal(before.batchInstance.status, 'unknown');
    const batch = await import('../server/local-batch-storage.mjs');
    await batch.installBatchSchema(legacyDb, { dbPath: legacyFile, outDir: join(root, 'before-batch') });
    staleLegacy(before); const s = captureLegacy(); assert.equal(s.instance.status, 'unverified'); assert.equal(s.batchInstance.status, 'persisted_unverified');
    const original = s.batchInstance.rows.find(r => r.is_active === 1).instance_id;
    legacyDb.prepare('UPDATE local_batch_database_instances SET instance_id=? WHERE instance_id=?').run('synthetic-new-batch-instance', original);
    try { staleLegacy(s); assert.equal(captureLegacy().batchInstance.rows.find(r => r.is_active === 1).instance_id, 'synthetic-new-batch-instance'); }
    finally { legacyDb.prepare('UPDATE local_batch_database_instances SET instance_id=? WHERE instance_id=?').run(original, 'synthetic-new-batch-instance'); }
  });
  await test('existing official audit instance is bound when present; installation invalidates old instance-less product', async () => {
    const s = captureLegacy(); const audit = await import('../server/local-audit-storage.mjs');
    await audit.installAuditSchema(legacyDb, { dbPath: legacyFile, outDir: join(root, 'before-audit') });
    staleLegacy(s); const withAudit = captureLegacy(); assert.equal(withAudit.instance.status, 'verified_local_audit_instance');
    assert.equal(withAudit.instance.instanceId, audit.currentAuditInstanceId(legacyDb)); currentLegacy(withAudit);
  });
  await test('invalid audit schema never authenticates an instance but active persisted row changes still stale', () => {
    legacyDb.exec('DROP TRIGGER audit_events_no_update');
    const auditId = legacyDb.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get().instance_id;
    const s = captureLegacy(); assert.equal(s.instance.status, 'unverified'); assert.equal(s.instance.instanceId, null);
    assert.equal(s.instance.rows.find(r => r.is_active === 1).instance_id, auditId);
    legacyDb.exec('PRAGMA foreign_keys=OFF');
    legacyDb.prepare('UPDATE audit_database_instances SET instance_id=? WHERE instance_id=?').run('synthetic-new-unverified-instance', auditId);
    try { staleLegacy(s); const next = captureLegacy(); assert.equal(next.instance.status, 'unverified'); assert.equal(next.instance.rows.find(r => r.is_active === 1).instance_id, 'synthetic-new-unverified-instance'); }
    finally {try {legacyDb.prepare('UPDATE audit_database_instances SET instance_id=? WHERE instance_id=?').run(auditId, 'synthetic-new-unverified-instance');}finally{legacyDb.exec('PRAGMA foreign_keys=ON');}assert.deepEqual(legacyDb.prepare('PRAGMA foreign_key_check').all(),[]);}
  });
  await test('path replacement either rejects old connection or is explicitly blocked by unchanged Windows sharing', () => {
    const directory = join(root, 'replacement-dir'); mkdirSync(directory);
    const copy = join(directory, 'workbench.db'); db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    const h = openReadonlyLedgerSource(copy), s = captureLedgerSnapshot(h, scope), renamed = directory + '.old';
    const beforeStat = statSync(copy, { bigint: true }), beforeHash = checksum(copy);
    try {
      let replaced = false;
      try { renameSync(directory, renamed); replaced = true; }
      catch (error) {
        assert.equal(process.platform, 'win32'); assert.ok(['EPERM', 'EBUSY', 'EACCES'].includes(error.code));
        const afterStat = statSync(copy, { bigint: true });
        assert.equal(afterStat.dev, beforeStat.dev); assert.equal(afterStat.ino, beforeStat.ino); assert.equal(afterStat.birthtimeNs, beforeStat.birthtimeNs);
        assert.equal(checksum(copy), beforeHash); assert.equal(existsSync(renamed), false);
        assert.equal(validateLedgerSnapshot(h, s).status, 'current');
        console.log('OS_BLOCKED_PATH_REPLACEMENT ' + error.code + '; actual replacement not executed');
      }
      if (replaced) { mkdirSync(directory); copyFileSync(join(renamed, 'workbench.db'), copy); assert.throws(() => validateLedgerSnapshot(h, s), /ledger_source_replaced/); assert.throws(() => captureLedgerSnapshot(h, scope), /ledger_source_replaced/); }
    }
    finally { h.close(); }
  });
  await test('actual hardlink alias on held synthetic DB invalidates source identity; removal restores current', () => {
    const alias = join(root, 'synthetic-held-alias.db'), s = capture();
    linkSync(file, alias);
    try { assert.equal(statSync(file).nlink, 2); assert.throws(() => capture(), /ledger_source_replaced/); assert.throws(() => validateLedgerSnapshot(source, s), /ledger_source_replaced/); }
    finally { unlinkSync(alias); }
    current(s);
  });
  await test('missing/invalid input does not create or migrate any DB', () => {
    const missing = join(root, 'not-a-db'), junk = join(root, 'junk.db'); writeFileSync(junk, 'synthetic not sqlite'); const old = checksum(junk);
    for (const target of [missing, junk, root]) assert.throws(() => openReadonlyLedgerSource(target), /ledger_source_invalid/);
    assert.equal(existsSync(missing), false); assert.equal(checksum(junk), old);
  });
  await test('missing batch association table preserves remaining source facts and their changes still stale', () => {
    const copy = join(root, 'partial-source.db'); db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    const writer = new DatabaseSync(copy); let h;
    try {
      writer.exec('PRAGMA foreign_keys=ON; DROP TABLE import_batch_vouchers');
      h = openReadonlyLedgerSource(copy); const s = captureLedgerSnapshot(h, scope);
      assert.equal(s.sources.schemaStatus, 'unknown'); assert.equal(s.sources.tablePresence.import_batch_vouchers, false);
      assert.deepEqual(s.sources.missingTables, ['import_batch_vouchers']); assert.equal(s.sources.voucherSources.length, 1);
      assert.equal(s.sources.sourceBindings.length, 1); assert.equal(s.sources.batches.length, 1);
      assert.equal(s.sources.checks[0].status, 'matches_persisted_content'); assert.equal(s.sources.checks[0].batchAssociation, 'unverified');
      assert.equal(validateLedgerSnapshot(h, s).status, 'current');
      writer.exec("UPDATE import_voucher_sources SET content_fingerprint='synthetic-partial-corrected'");
      assert.equal(validateLedgerSnapshot(h, s).status, 'stale'); assert.equal(s.calculationReady, false);
    } finally { h?.close(); writer.close(); }
  });
  await test('closed handle and all its genuine snapshots become unusable', () => {
    const s = capture(); source.close(); source.close();
    assert.throws(() => capture(), /ledger_source_unavailable/); assert.throws(() => validateLedgerSnapshot(source, s), /ledger_source_unavailable/);
  });
} finally {
  const closeErrors=[];
  for(const close of [()=>legacySource?.close(),()=>{if(legacyDb){if(legacyDb.isTransaction)legacyDb.exec('ROLLBACK');legacyDb.close();}},()=>source?.close(),()=>db?.close()]){try{close();console.log('snapshot handle actualclose');}catch(error){closeErrors.push(error);}}
  console.log(`offline-ledger-snapshot ${passed}/${passed + failed}; DB actualclose`);
  if (setupCompleted&&!failed&&!closeErrors.length&&process.env.KEEP_FIXTURES!=='1'&&process.env.WORKBENCH_TEST_KEEP_FIXTURES!=='1')rmSync(root,{recursive:true,force:true});
  else console.log('Synthetic fixtures retained: '+root);
  if(closeErrors.length)throw new AggregateError(closeErrors,'snapshot_close_failed');
}

if (failed) process.exitCode = 1;
