// Explicit local read capability. Never import the application's default db.mjs.
import { openSync, closeSync, fstatSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { openAuditDatabase, inspectAuditSchema } from './local-audit-storage.mjs';
import { withReadSnapshot } from './local-batch-storage.mjs';
import { getAccountingProfile } from './accounting-profiles.mjs';
import { persistedVoucherFingerprint } from './import-storage.mjs';
import { canonicalEnterpriseKey } from './enterprise-identity.mjs';

const sources = new WeakMap(), products = new WeakMap();
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function assertFiniteNumbers(value) {
  // JSON would collapse +Infinity/-Infinity to null. Reject before any digest or
  // export, including numeric evidence outside the monetary columns.
  if (typeof value === 'number' && !Number.isFinite(value)) fail('ledger_stored_number_invalid');
  if (value && typeof value === 'object') for (const child of Object.values(value)) assertFiniteNumbers(child);
}
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
function fileIdentity(file) {
  // Reject aliases, links and non-files, including linked ancestor directories.
  for (let p = file;; p = dirname(p)) {
    if (lstatSync(p).isSymbolicLink() || !samePath(realpathSync.native(p), p)) fail('ledger_source_invalid');
    if (dirname(p) === p) break;
  }
  const st = statSync(file, { bigint: true });
  if (!st.isFile() || st.nlink !== 1n) fail('ledger_source_invalid');
  return identity(st);
}
function sourceState(source) {
  const state = sources.get(source);
  if (!state || state.closed) fail('ledger_source_unavailable');
  try {
    if (fileIdentity(state.file) !== state.identity || identity(fstatSync(state.fd, { bigint: true })) !== state.identity) fail('ledger_source_replaced');
  } catch { fail('ledger_source_replaced'); }
  return state;
}
export function openReadonlyLedgerSource(file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) fail('ledger_source_invalid');
  let fd, db;
  try {
    const full = resolve(file), initial = fileIdentity(full);
    fd = openSync(full, 'r');
    if (identity(fstatSync(fd, { bigint: true })) !== initial) fail('ledger_source_replaced');
    db = openAuditDatabase(full, { readOnly: true });
    if (fileIdentity(full) !== initial) fail('ledger_source_replaced');
    const state = { file: full, identity: initial, fd, db, closed: false };
    const source = Object.freeze({ close() {
      if (state.closed) return;
      state.closed = true;
      try { state.db.close(); } finally { closeSync(state.fd); }
    } });
    sources.set(source, state);
    return source;
  } catch {
    try { db?.close(); } catch { /* cleanup */ }
    try { if (fd !== undefined) closeSync(fd); } catch { /* cleanup */ }
    fail('ledger_source_invalid');
  }
}
function normalizeScope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'accountSetId,enterpriseKey,fromPeriod,toPeriod') fail('ledger_scope_invalid');
  const { enterpriseKey, accountSetId, fromPeriod, toPeriod } = input;
  if (typeof enterpriseKey !== 'string' || !enterpriseKey || canonicalEnterpriseKey(enterpriseKey) !== enterpriseKey || /[\u0000-\u001f\u007f]/.test(enterpriseKey) || enterpriseKey.length > 128 || !Number.isSafeInteger(accountSetId) || accountSetId <= 0) fail('ledger_scope_invalid');
  const month = value => typeof value === 'string' && /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value);
  if (!month(fromPeriod) || !month(toPeriod) || fromPeriod > toPeriod) fail('ledger_scope_invalid');
  const index = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1;
  const start = index(fromPeriod), end = index(toPeriod);
  if (end - start >= 120) fail('ledger_scope_invalid');
  const requestedPeriods = [];
  for (let n = start; n <= end; n++) requestedPeriods.push(`${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, '0')}`);
  return { enterpriseKey, accountSetId, fromPeriod, toPeriod, requestedPeriods };
}
// Do not use parseMoney here: its intentional input rounding must not repair bad stored evidence.
function minorUnits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}
function readScope(db, scope) {
  const { enterpriseKey: key, accountSetId: id, fromPeriod: from, toPeriod: to } = scope;
  const all = (sql, ...params) => db.prepare(sql).all(...params).map(row => ({ ...row }));
  const table = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const bindingRows = all('SELECT * FROM import_enterprise_account_sets WHERE enterprise_key=? OR account_set_id=? ORDER BY enterprise_key', key, id);
  if (bindingRows.length !== 1 || bindingRows[0].enterprise_key !== key || bindingRows[0].account_set_id !== id) fail('ledger_binding_mismatch');
  const accountSet = all('SELECT * FROM account_sets WHERE id=?', id)[0];
  if (!accountSet) fail('ledger_scope_missing');
  let profile = null;
  try { profile = structuredClone(getAccountingProfile(accountSet.accounting_profile_id)); } catch { /* explicit unknown, no fallback */ }
  const accounts = all('SELECT * FROM accounts WHERE account_set_id=? ORDER BY code,id', id);
  const openings = all('SELECT * FROM opening_balances WHERE account_set_id=? ORDER BY code', id);
  const periods = all('SELECT * FROM periods WHERE account_set_id=? AND period<=? ORDER BY period', id, to);
  // Include earlier history because it can affect later tax calculations. No balance engine is added.
  const vouchers = all('SELECT * FROM vouchers WHERE account_set_id=? AND period<=? ORDER BY period,voucher_date,id', id, to);
  const entries = all('SELECT e.* FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? AND v.period<=? ORDER BY v.id,e.line_no,e.id', id, to);
  const moneyIssues = [];
  const moneyRows = (rows, kind) => rows.map(row => {
    const debitMinor = minorUnits(row.debit), creditMinor = minorUnits(row.credit);
    if (debitMinor === null || creditMinor === null) moneyIssues.push({ kind, id: row.id ?? row.code, code: 'stored_money_invalid' });
    return { ...row, debitMinor, creditMinor };
  });
  const monetaryEntries = moneyRows(entries, 'entry'), monetaryOpenings = moneyRows(openings, 'opening');
  const entryMap = new Map(vouchers.map(v => [v.id, []]));
  for (const entry of monetaryEntries) entryMap.get(entry.voucher_id).push(entry);
  const sourceTables = ['import_source_bindings', 'import_voucher_sources', 'import_batch_vouchers', 'import_batches'];
  const tablePresence = Object.fromEntries(sourceTables.map(name => [name, table(name)]));
  const sourceSchemaPresent = sourceTables.every(name => tablePresence[name]);
  let sourceBindings = [], voucherSources = [], batchVouchers = [], batches = [];
  if (tablePresence.import_source_bindings) {
    sourceBindings = all('SELECT * FROM import_source_bindings WHERE enterprise_key=? ORDER BY id', key);
  }
  // A missing optional association table must never erase known evidence from
  // the remaining tables or hide a later change to it.
  if (tablePresence.import_voucher_sources) {
    voucherSources = all(`SELECT s.* FROM import_voucher_sources s LEFT JOIN vouchers v ON v.id=s.voucher_id WHERE (s.account_set_id=? OR v.account_set_id=?) AND (v.id IS NULL OR v.period<=?) ORDER BY s.id`, id, id, to);
  }
  if (tablePresence.import_batch_vouchers) {
    batchVouchers = all(`SELECT s.* FROM import_batch_vouchers s LEFT JOIN vouchers v ON v.id=s.voucher_id WHERE (s.account_set_id=? OR v.account_set_id=?) AND (v.id IS NULL OR v.period<=?) ORDER BY s.id`, id, id, to);
  }
  if (tablePresence.import_batches) {
    const batchIds = [...new Set([...voucherSources, ...batchVouchers].map(s => s.batch_id))].sort();
    // Without either relation, existing batch metadata is still known local
    // evidence; retain target metadata conservatively rather than call it absent.
    batches = !tablePresence.import_voucher_sources || !tablePresence.import_batch_vouchers
      ? all('SELECT * FROM import_batches WHERE account_set_id=? OR enterprise_key=? ORDER BY batch_id', id, key)
      : batchIds.flatMap(batch => all('SELECT * FROM import_batches WHERE batch_id=?', batch));
  }
  const sourceChecks = voucherSources.map(s => {
    const v = vouchers.find(v => v.id === s.voucher_id), rows = entryMap.get(s.voucher_id);
    let status = 'unverified';
    if (!v || s.enterprise_key !== key || s.account_set_id !== id) status = 'association_mismatch';
    else if (rows.some(e => e.debitMinor === null || e.creditMinor === null)) status = 'stored_money_invalid';
    else if (!s.voucher_fingerprint) status = 'fingerprint_missing';
    else status = persistedVoucherFingerprint(v, rows) === s.voucher_fingerprint ? 'matches_persisted_content' : 'fingerprint_mismatch';
    const batch = batches.find(b => b.batch_id === s.batch_id);
    const batchLinked = batch?.account_set_id === id && batch.enterprise_key === key && batch.source_system === s.source_system
      && batchVouchers.some(b => b.batch_id === s.batch_id && b.voucher_id === s.voucher_id && b.account_set_id === id && b.enterprise_key === key && b.source_system === s.source_system && b.source_voucher_id === s.source_voucher_id && b.content_fingerprint === s.content_fingerprint);
    return { sourceId: s.id, voucherId: s.voucher_id, status, batchAssociation: batchLinked ? 'registered' : 'unverified', originalFileVerification: 'unverified' };
  });
  const audit = inspectAuditSchema(db);
  // Unverified is not an excuse to discard persisted instance changes. Keep diagnostics
  // in the content binding even when the component cannot authenticate an instance.
  const instanceRows = table('audit_database_instances') ? all('SELECT * FROM audit_database_instances ORDER BY instance_id') : [];
  const instance = { status: audit.ok && audit.activeInstanceCount === 1 ? 'verified_local_audit_instance' : 'unverified', instanceId: audit.ok && audit.activeInstanceCount === 1 ? audit.activeInstanceId : null,
    schema: { state: audit.state, version: audit.version, problems: audit.problems, activeInstanceCount: audit.activeInstanceCount }, rows: instanceRows };
  const batchInstance = { status: table('local_batch_database_instances') ? 'persisted_unverified' : 'unknown',
    rows: table('local_batch_database_instances') ? all('SELECT * FROM local_batch_database_instances ORDER BY instance_id') : [],
    componentRows: table('local_batch_component') ? all('SELECT * FROM local_batch_component ORDER BY component') : [] };
  const requested = vouchers.filter(v => v.period >= from);
  const missingPeriods = scope.requestedPeriods.filter(p => !periods.some(row => row.period === p));
  const unknownStatuses = vouchers.filter(v => !['posted', 'draft'].includes(v.status)).map(v => v.id);
  const posted = requested.filter(v => v.status === 'posted'), drafts = requested.filter(v => v.status === 'draft');
  const voucherData = vouchers.map(v => ({ ...v, range: v.period < from ? 'prior_history' : 'requested', entries: entryMap.get(v.id) }));
  return {
    version: 'offline-ledger-snapshot/1', scope, binding: bindingRows[0], instance, batchInstance, accountSet,
    profile: { status: profile ? 'registered' : 'unknown', definition: profile }, accounts,
    openingBalances: monetaryOpenings, periods, vouchers: voucherData,
    sources: { schemaStatus: sourceSchemaPresent ? 'present' : 'unknown', tablePresence, missingTables: sourceTables.filter(name => !tablePresence[name]), sourceBindings, voucherSources, batchVouchers, batches, checks: sourceChecks },
    completeness: { requestedPeriods: scope.requestedPeriods, missingPeriods, coverage: 'unverified', openingCompleteness: 'unverified', priorHistoryCompleteness: 'unverified', realWorldAuthenticity: 'unverified', originalFiles: 'unverified', zeroDeclaration: 'not_assessed', moneyIssues, unknownStatuses, vouchersWithoutRegisteredSource: vouchers.filter(v => !voucherSources.some(s => s.voucher_id === v.id)).map(v => v.id) },
    counts: { posted: posted.length, draft: drafts.length, otherStatus: requested.length - posted.length - drafts.length, postedEntries: posted.reduce((n, v) => n + entryMap.get(v.id).length, 0), priorVouchers: vouchers.length - requested.length },
    calculationReady: false, submittable: false, authorizesExecution: false,
  };
}
function captureData(state, scope) {
  try {
    const value = withReadSnapshot(state.db, () => { const data = readScope(state.db, scope); assertFiniteNumbers(data); return data; });
    // Check identity after all reads as well; a removed old connection is never current at its path.
    if (fileIdentity(state.file) !== state.identity) fail('ledger_source_replaced');
    return value;
  } catch (error) {
    if (['ledger_source_replaced', 'ledger_binding_mismatch', 'ledger_scope_missing', 'ledger_stored_number_invalid'].includes(error.code)) throw error;
    fail('ledger_read_failed');
  }
}
export function captureLedgerSnapshot(source, input) {
  const state = sourceState(source), scope = normalizeScope(input);
  const data = captureData(state, scope), contentDigest = digest(data);
  const snapshot = freeze({ ...data, contentDigest, exportTrust: 'diagnostic_only_not_restorable' });
  products.set(snapshot, { source, scope, contentDigest });
  return snapshot;
}
export function validateLedgerSnapshot(source, snapshot) {
  const state = sourceState(source), product = products.get(snapshot);
  if (!product || product.source !== source) fail('ledger_snapshot_untrusted');
  try {
    const current = captureData(state, product.scope);
    return freeze({ status: digest(current) === product.contentDigest ? 'current' : 'stale', calculationReady: false, submittable: false });
  } catch (error) {
    if (['ledger_binding_mismatch', 'ledger_scope_missing'].includes(error.code)) return freeze({ status: 'stale', calculationReady: false, submittable: false });
    throw error;
  }
}
