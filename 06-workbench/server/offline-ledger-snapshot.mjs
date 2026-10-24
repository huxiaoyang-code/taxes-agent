// Explicit local read capability. Never import the application's default db.mjs.
import { openSync, closeSync, fstatSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { openAuditDatabase, inspectAuditSchema } from './local-audit-storage.mjs';
import { withReadSnapshot } from './local-batch-storage.mjs';
import { getAccountingProfile } from './accounting-profiles.mjs';
import { persistedVoucherFingerprint } from './import-storage.mjs';
import { canonicalEnterpriseKey } from './enterprise-identity.mjs';

const sources = new WeakMap(), products = new WeakMap(), pairs = new WeakMap();
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
  if (state.retired) fail('ledger_pair_retired');
  try {
    if (fileIdentity(state.file) !== state.identity || identity(fstatSync(state.fd, { bigint: true })) !== state.identity) fail('ledger_source_replaced');
  } catch { if (state.pairOwned) state.retired = true; fail('ledger_source_replaced'); }
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
const Q2_BATCH_POLICY = 'q2-target-batch-inventory/1';
function validVoucherPeriodDate(v) {
  if (typeof v.period !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(v.period) || typeof v.voucher_date !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v.voucher_date) || v.voucher_date.slice(0, 7) !== v.period) return false;
  const time = Date.parse(v.voucher_date + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === v.voucher_date;
}
/** Pure strict wire-result parser; actual relations are supplied by the same
 * private read snapshot. An incomplete enriched result is never legacy data.
 */
export function parseImportBatchResult(text, {header,headers=[],links=[],sources=[],vouchers=[],entries=[]} = {}) {
  try {
    const value=JSON.parse(text),legacy=['accountSetCreated','accountsAdded','openingBalancesApplied','vouchersCreated','vouchersDeduplicated'];
    const exact=(object,keys)=>object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).length===keys.length&&keys.every(k=>Object.hasOwn(object,k));
    const enriched=[...legacy,'contentFingerprint','mode','accountSetId','source','sourceTrace'];
    if(!exact(value,legacy)&&!exact(value,enriched))return null;
    if(typeof value.accountSetCreated!=='boolean'||legacy.slice(1).some(k=>!Number.isSafeInteger(value[k])||value[k]<0))return null;
    if(exact(value,legacy))return {value,associationsValid:true};
    const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
    const id=v=>Number.isSafeInteger(v)&&v>0;
    const textId=(v,max)=>typeof v==='string'&&v===v.trim()&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
    if(!header||!hash(value.contentFingerprint)||value.contentFingerprint!==header.content_fingerprint
      ||!['create','append'].includes(value.mode)||value.mode!==header.mode||value.accountSetCreated!==(value.mode==='create')
      ||!id(value.accountSetId)||value.accountSetId!==header.account_set_id
      ||!exact(value.source,['system','enterpriseKey'])||!textId(value.source.system,64)||!textId(value.source.enterpriseKey,128)
      ||value.source.system!==header.source_system||value.source.enterpriseKey!==header.enterprise_key||!Array.isArray(value.sourceTrace))return null;
    const invalidRows=()=>({value,associationsValid:false});
    const trace=value.sourceTrace,batchLinks=links.filter(r=>r.batch_id===header.batch_id),ownSources=sources.filter(r=>r.batch_id===header.batch_id);
    const unique=(rows,key)=>new Set(rows.map(r=>r[key])).size===rows.length;
    const same=(row,t)=>row&&row.source_system===value.source.system&&row.enterprise_key===value.source.enterpriseKey
      &&row.account_set_id===value.accountSetId&&row.source_voucher_id===t.sourceVoucherId&&row.voucher_id===t.voucherId&&row.content_fingerprint===t.contentFingerprint;
    for(const t of trace){
      if(!exact(t,['sourceVoucherId','voucherId','accountSetId','contentFingerprint','action','status','state','period'])
        ||!textId(t.sourceVoucherId,128)||!id(t.voucherId)||t.accountSetId!==value.accountSetId||!hash(t.contentFingerprint)
        ||!['created','deduplicated'].includes(t.action)||t.status!==t.action||t.state!=='ok'
        ||typeof t.period!=='string'||!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(t.period))return null;
    }
    if(!unique(trace,'sourceVoucherId')||!unique(trace,'voucherId'))return null;
    if(!unique(batchLinks,'source_voucher_id')||batchLinks.length!==trace.length)return invalidRows();
    for(const t of trace){
      const link=batchLinks.filter(r=>same(r,t)),registered=sources.filter(r=>same(r,t)),v=vouchers.find(r=>r.id===t.voucherId),es=entries.filter(r=>r.voucher_id===t.voucherId);
      if(link.length!==1||link[0].action!==t.action||registered.length!==1||!v||v.account_set_id!==value.accountSetId||v.status!=='posted'||v.kind!=='normal'
        ||v.period!==t.period||!validVoucherPeriodDate(v)||!es.length||es.some(e=>minorUnits(e.debit)===null||minorUnits(e.credit)===null)
        ||!hash(registered[0].voucher_fingerprint)||registered[0].voucher_fingerprint!==persistedVoucherFingerprint(v,es))return invalidRows();
      const source=registered[0],owner=headers.find(h=>h.batch_id===source.batch_id);
      if(t.action==='created'&&source.batch_id!==header.batch_id)return invalidRows();
      if(t.action==='deduplicated'&&(source.batch_id===header.batch_id||!owner||owner.status!=='completed'||owner.account_set_id!==value.accountSetId
        ||owner.enterprise_key!==value.source.enterpriseKey||owner.source_system!==value.source.system
        ||links.filter(r=>r.batch_id===source.batch_id&&r.action==='created'&&same(r,t)).length!==1))return invalidRows();
    }
    if(value.vouchersCreated!==trace.filter(t=>t.action==='created').length||value.vouchersDeduplicated!==trace.filter(t=>t.action==='deduplicated').length
      ||ownSources.length!==value.vouchersCreated||ownSources.some(r=>!trace.some(t=>t.action==='created'&&same(r,t))))return invalidRows();
    return {value,associationsValid:true};
  }catch{return null;}
}

function readTargetBatchInventory(db, scope, presence) {
  const all = (sql, ...params) => db.prepare(sql).all(...params).map(row => ({ ...row }));
  const { enterpriseKey: key, accountSetId: id, toPeriod: to } = scope;
  const baseHeaders = presence.import_batches ? all('SELECT * FROM import_batches WHERE account_set_id=? OR enterprise_key=? ORDER BY batch_id', id, key) : [];
  const scopedRelations = name => presence[name] ? all(`SELECT * FROM ${name} WHERE account_set_id=? OR enterprise_key=? OR voucher_id IN (SELECT id FROM vouchers WHERE account_set_id=?) ORDER BY id`, id, key, id) : [];
  const baseLinks = scopedRelations('import_batch_vouchers'), baseSources = scopedRelations('import_voucher_sources');
  const headerIds = [...new Set([...baseHeaders, ...baseLinks, ...baseSources].map(r => r.batch_id))].sort();
  const relevantHeaders = presence.import_batches ? headerIds.flatMap(batch => all('SELECT * FROM import_batches WHERE batch_id=?', batch)) : [];
  const relations = (name, base) => {
    const rows = presence[name] ? [...base, ...headerIds.flatMap(batch => all(`SELECT * FROM ${name} WHERE batch_id=?`, batch))] : [];
    return [...new Map(rows.map(r => [r.id, r])).values()].sort((a, b) => a.id - b.id);
  };
  const relevantLinks = relations('import_batch_vouchers', baseLinks), relevantSources = relations('import_voucher_sources', baseSources);
  const referenceIds = [...new Set([...relevantLinks, ...relevantSources].map(r => r.voucher_id))].sort((a, b) => a - b);
  const vouchers = referenceIds.flatMap(voucher => all('SELECT * FROM vouchers WHERE id=?', voucher));
  const entries = referenceIds.flatMap(voucher => all('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY line_no,id', voucher));
  const future = new Set();
  // Exclude only a fully explained, posted future batch. Neither timestamps nor
  // an absent voucher/ambiguous result are evidence of a future business period.
  for (const h of relevantHeaders) {
    const parsed = parseImportBatchResult(h.result_json,{header:h,headers:relevantHeaders,links:relevantLinks,sources:relevantSources,vouchers,entries}), result=parsed?.associationsValid?parsed.value:null, bs = relevantLinks.filter(r => r.batch_id === h.batch_id), ss = relevantSources.filter(r => r.batch_id === h.batch_id);
    const identity = r => r.account_set_id === id && r.enterprise_key === key && r.source_system === h.source_system;
    if (!Object.values(presence).every(Boolean) || !identity(h) || h.mode !== 'append' || h.status !== 'completed' || h.error_code !== null || h.error_message !== null || !Number.isSafeInteger(h.attempts) || h.attempts < 1 || !/^[a-f0-9]{64}$/.test(h.content_fingerprint) || !result || result.accountSetCreated || result.accountsAdded || result.openingBalancesApplied || !bs.length || result.vouchersCreated !== bs.filter(r => r.action === 'created').length || result.vouchersDeduplicated !== bs.filter(r => r.action === 'deduplicated').length) continue;
    const coherent = bs.every(r => {
      const v = vouchers.find(v => v.id === r.voucher_id), es = entries.filter(e => e.voucher_id === r.voucher_id);
      const matching = relevantSources.filter(s => ['source_system', 'enterprise_key', 'source_voucher_id', 'account_set_id', 'voucher_id', 'content_fingerprint'].every(k => s[k] === r[k]));
      return identity(r) && ['created', 'deduplicated'].includes(r.action) && v?.account_set_id === id && v.status === 'posted' && v.kind === 'normal' && validVoucherPeriodDate(v) && v.period > to && es.length > 0 && es.every(e => minorUnits(e.debit) !== null && minorUnits(e.credit) !== null) && matching.length === 1 && (r.action !== 'created' || matching[0].batch_id === h.batch_id) && matching[0].voucher_fingerprint === persistedVoucherFingerprint(v, es);
    });
    if (coherent && ss.every(s => bs.some(r => r.voucher_id === s.voucher_id && r.source_voucher_id === s.source_voucher_id && identity(s)))) future.add(h.batch_id);
  }
  const keptHeaders = relevantHeaders.filter(h => !future.has(h.batch_id));
  const keptLinks = relevantLinks.filter(r => !future.has(r.batch_id));
  const keptSources = relevantSources.filter(r => !future.has(r.batch_id));
  const voucherIds = new Set([...keptLinks, ...keptSources].map(r => r.voucher_id));
  return { version: Q2_BATCH_POLICY, coverage: 'all_target_related_batches_except_fully_explained_posted_future_batches', headers: keptHeaders, batchVouchers: keptLinks, voucherSources: keptSources, vouchers: vouchers.filter(v => voucherIds.has(v.id)), entries: entries.filter(e => voucherIds.has(e.voucher_id)) };
}
function readScope(db, scope, policy) {
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
    sources: { schemaStatus: sourceSchemaPresent ? 'present' : 'unknown', tablePresence, missingTables: sourceTables.filter(name => !tablePresence[name]), sourceBindings, voucherSources, batchVouchers, batches, checks: sourceChecks, ...(policy === Q2_BATCH_POLICY ? { targetBatchInventory: readTargetBatchInventory(db, scope, tablePresence) } : {}) },
    completeness: { requestedPeriods: scope.requestedPeriods, missingPeriods, coverage: 'unverified', openingCompleteness: 'unverified', priorHistoryCompleteness: 'unverified', realWorldAuthenticity: 'unverified', originalFiles: 'unverified', zeroDeclaration: 'not_assessed', moneyIssues, unknownStatuses, vouchersWithoutRegisteredSource: vouchers.filter(v => !voucherSources.some(s => s.voucher_id === v.id)).map(v => v.id) },
    counts: { posted: posted.length, draft: drafts.length, otherStatus: requested.length - posted.length - drafts.length, postedEntries: posted.reduce((n, v) => n + entryMap.get(v.id).length, 0), priorVouchers: vouchers.length - requested.length },
    calculationReady: false, submittable: false, authorizesExecution: false,
  };
}
function captureData(state, scope, policy) {
  try {
    const value = withReadSnapshot(state.db, () => { const data = readScope(state.db, scope, policy); assertFiniteNumbers(data); return data; });
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
    const current = captureData(state, product.scope, product.policy);
    return freeze({ status: digest(current) === product.contentDigest ? 'current' : 'stale', calculationReady: false, submittable: false });
  } catch (error) {
    if (['ledger_binding_mismatch', 'ledger_scope_missing'].includes(error.code)) return freeze({ status: 'stale', calculationReady: false, submittable: false });
    throw error;
  }
}

// Two products from one SQLite read transaction and one physically held source.
// The public digests are diagnostics; membership and capture identity stay private.
export function captureLedgerSnapshotPair(source, priorScope, targetScope, targetPolicy) {
  if (targetPolicy !== undefined && targetPolicy !== Q2_BATCH_POLICY) fail('ledger_pair_policy_invalid');
  const state = sourceState(source), scopes = [normalizeScope(priorScope), normalizeScope(targetScope)];
  const policies = [undefined, targetPolicy];
  state.pairOwned = true;
  let data;
  try {
    data = withReadSnapshot(state.db, () => scopes.map((scope, i) => {
      const value = readScope(state.db, scope, policies[i]); assertFiniteNumbers(value); return value;
    }));
    sourceState(source);
  } catch (e) { state.retired = true; throw e; }
  const snapshots = data.map((value, i) => {
    const contentDigest = digest(value), snapshot = freeze({ ...value, contentDigest, exportTrust: 'diagnostic_only_not_restorable' });
    products.set(snapshot, { source, scope: scopes[i], contentDigest, policy: policies[i] }); return snapshot;
  });
  const pair = Object.freeze({ prior: snapshots[0], target: snapshots[1] });
  pairs.set(pair, { source, scopes, policies, digests: snapshots.map(s => s.contentDigest) });
  return pair;
}
export function assertLedgerSourcePath(source, path) {
  const state = sourceState(source);
  if (typeof path !== 'string' || !samePath(resolve(path), state.file) || fileIdentity(resolve(path)) !== state.identity) fail('ledger_target_file_mismatch');
}
export function validateLedgerSnapshotPair(source, pair) {
  const state = sourceState(source), record = pairs.get(pair);
  if (!record || record.source !== source || products.get(pair.prior)?.source !== source || products.get(pair.target)?.source !== source) fail('ledger_pair_untrusted');
  try {
    const current = withReadSnapshot(state.db, () => record.scopes.map((scope, i) => {
      const value = readScope(state.db, scope, record.policies[i]); assertFiniteNumbers(value); return digest(value);
    }));
    sourceState(source);
    if (current.some((d, i) => d !== record.digests[i])) { state.retired = true; fail('ledger_pair_changed'); }
    return freeze({ status: 'current', relationship: 'same_held_readonly_source_same_capture', priorDigest: record.digests[0], targetDigest: record.digests[1], proofDigest: digest({ scopes: record.scopes, digests: record.digests, identity: state.identity }), authorizesExecution: false });
  } catch (e) { state.retired = true; throw e; }
}
