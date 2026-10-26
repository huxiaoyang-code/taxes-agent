// Fixed, reject-only evidence fence. No DB opening, callbacks, model execution or IO writes.
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, parse, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const sessions = new WeakMap(), context = new AsyncLocalStorage();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (v, code) => { if (!v) fail(code); };
const digest = value => createHash('sha256').update(value).digest('hex');
const stable = v => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const inside = (base, path) => { const rel = relative(base, path); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel); };
function fixedFile(path) {
  check(typeof path === 'string' && isAbsolute(path), 'agency_absolute_path_required');
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const part of relative(current, absolute).split(/[\\/]/).filter(Boolean)) { current = join(current, part); const s = lstatSync(current); check(!s.isSymbolicLink() && (current === absolute ? s.isFile() && s.nlink === 1 : s.isDirectory()), 'agency_source_path_rejected'); }
  check(realpathSync(absolute).toLowerCase() === absolute.toLowerCase(), 'agency_source_path_changed');
  const before = lstatSync(absolute); check(before.size <= 5 * 1024 * 1024, 'agency_source_too_large');
  const bytes = readFileSync(absolute); const after = lstatSync(absolute);
  check(before.ino === after.ino && before.dev === after.dev && before.size === bytes.length && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'agency_source_changed');
  return { path: absolute, bytes, digest: digest(bytes), identity: stable([after.dev, after.ino, after.birthtimeMs]) };
}
function readJson(file) { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes).replace(/^\uFEFF/, '')); } catch { fail('agency_source_json_invalid'); } }
function sameScope(a, b) { return a && b && ['enterpriseKey', 'accountSetId', 'databaseInstanceId', 'currency'].every(k => a[k] === b[k]); }
function validateScope(scope) { check(scope && typeof scope === 'object' && typeof scope.enterpriseKey === 'string' && scope.enterpriseKey === scope.enterpriseKey.normalize('NFKC').trim() && scope.enterpriseKey.length > 0 && Number.isSafeInteger(scope.accountSetId) && scope.accountSetId > 0 && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(scope.databaseInstanceId) && /^202[67]-(0[1-9]|1[0-2])$/.test(scope.period) && scope.currency === 'CNY', 'agency_scope_invalid'); }
export function captureAgencyCode() {
  const files = new Map(), root = dirname(fileURLToPath(import.meta.url));
  const visit = path => {
    const absolute = resolve(path); if (files.has(absolute)) return;
    check(inside(root, absolute), 'agency_code_outside_root');
    const file = fixedFile(absolute), code = file.bytes.toString('utf8'); files.set(absolute, file.digest);
    for (const m of code.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"\n]+\.mjs)['"]/g)) visit(resolve(dirname(absolute), m[1]));
  };
  visit(resolve(root, 'agency-business.mjs'));
  const inventory = [...files].map(([path, sha256]) => ({ path: relative(root, path).replaceAll('\\', '/'), sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  return { version: 'agency-code/1', files: inventory, digest: digest(stable(inventory)) };
}
export function loadAgencyEvidence(manifestPath) {
  const manifestFile = fixedFile(resolve(manifestPath)), manifest = readJson(manifestFile); validateScope(manifest.scope);
  check(manifest.version === 'agency-business-materials/1' && Array.isArray(manifest.sources) && manifest.sources.length > 0 && manifest.sources.length <= 1000, 'agency_manifest_invalid');
  check(Object.keys(manifest).every(k => ['version', 'scope', 'sources', 'originals'].includes(k)), 'agency_manifest_fields_invalid');
  check(Array.isArray(manifest.originals) && manifest.originals.length > 0 && manifest.originals.length <= 1000, 'agency_originals_required');
  const files = [manifestFile], records = [], ids = new Set(), originals = new Map();
  for (const descriptor of manifest.originals) {
    check(descriptor && typeof descriptor.id === 'string' && descriptor.id.length > 0 && !originals.has(descriptor.id) && typeof descriptor.path === 'string' && Object.keys(descriptor).every(k => ['id', 'path', 'sha256'].includes(k)), 'agency_original_descriptor_invalid');
    const file = fixedFile(isAbsolute(descriptor.path) ? descriptor.path : resolve(dirname(manifestFile.path), descriptor.path));
    check(descriptor.sha256 === undefined || descriptor.sha256 === file.digest, 'agency_original_digest_mismatch');
    originals.set(descriptor.id, file); files.push(file);
  }
  for (const source of manifest.sources) {
    check(source && Object.keys(source).every(k => ['path', 'sha256'].includes(k)) && typeof source.path === 'string', 'agency_source_descriptor_invalid');
    const path = isAbsolute(source.path) ? source.path : resolve(dirname(manifestFile.path), source.path); const file = fixedFile(path); check(!ids.has(file.path.toLowerCase()), 'agency_source_duplicate'); ids.add(file.path.toLowerCase());
    check(![...originals.values()].some(original=>original.path.toLowerCase()===file.path.toLowerCase()||original.digest===file.digest),'agency_original_cannot_be_agent_facts');
    if (source.sha256 !== undefined) check(source.sha256 === file.digest, 'agency_source_digest_mismatch');
    const raw = readJson(file); validateScope(raw.scope); check(raw.version === 'agency-raw-facts/1' && sameScope(raw.scope, manifest.scope) && raw.scope.period <= manifest.scope.period && Array.isArray(raw.records), 'agency_source_scope_mismatch');
    check(Object.keys(raw).every(k => ['version', 'scope', 'records'].includes(k)), 'agency_source_fields_invalid');
    raw.records.forEach((r, index) => {
      check(r && typeof r === 'object' && !Array.isArray(r) && !Object.hasOwn(r, 'sourceRefs') && r.enterpriseKey === manifest.scope.enterpriseKey && typeof r.id === 'string' && typeof r.date === 'string', 'agency_raw_record_invalid');
      check(Array.isArray(r.originalRefs) && r.originalRefs.length > 0 && r.originalRefs.every(ref => originals.has(ref.originalId) && typeof ref.locator === 'string' && ref.locator.length > 0 && typeof ref.extractionReason === 'string' && ref.extractionReason.length > 0), 'agency_original_record_reference_required');
      check(r.type === 'opening_inventory' || r.type === 'opening_balance' || ['entity','owner'].includes(r.type) && r.date.slice(0,7)<=raw.scope.period || r.date.slice(0, 7) === raw.scope.period, 'agency_record_period_mismatch');
      const sourceRefs = [{ kind: 'source', locator: `${file.path}#/records/${index}`, digest: file.digest }, ...r.originalRefs.map(ref => ({ kind: 'source', locator: `${originals.get(ref.originalId).path}#${ref.locator}`, digest: originals.get(ref.originalId).digest }))];
      const record = { ...r, sourceRefs };
      if (record.type === 'obligation_inventory') record.activities = Object.fromEntries(Object.entries(record.activities ?? {}).map(([id, fact]) => [id, { ...fact, sourceRefs: [{ kind: 'source', locator: `${file.path}#/records/${index}/activities/${id}`, digest: file.digest },...sourceRefs.slice(1)] }]));
      records.push(record);
    }); files.push(file);
  }
  const entities = records.filter(r => r.type === 'entity'); check(entities.length === 1 && entities[0].entity && typeof entities[0].entity === 'object', 'agency_entity_record_required');
  const document = { scope: manifest.scope, entity: entities[0].entity, records };
  const sourceRefs = files.map(f => ({ kind: 'source', locator: f.path, digest: f.digest }));
  const code = captureAgencyCode(); check(code.digest === loadedAgencyCodeDigest, 'agency_code_restart_required');
  const dependencyDigest = digest(stable({ sourceRefs, codeDigest: code.digest, scope: document.scope }));
  const session = freeze({ version: 'agency-material-session/1', scope: structuredClone(document.scope), dependencyDigest, sourceRefs: structuredClone(sourceRefs), codeDigest: code.digest });
  sessions.set(session, { document: freeze(document), files, archives: [], manifestPath: manifestFile.path, dependencyDigest, codeDigest: code.digest }); return session;
}
export function readAgencySession(session) { const cap = sessions.get(session); check(cap, 'agency_session_untrusted'); assertAgencyEvidenceCurrent(session); return structuredClone(cap.document); }
export function agencyEvidenceArchiveRecords(session) {
  const cap = sessions.get(session); check(cap, 'agency_session_untrusted'); assertAgencyEvidenceCurrent(session);
  const root = dirname(fileURLToPath(import.meta.url)), code = captureAgencyCode();
  return [...cap.files.map(f => ({ name: f.path, bytes: Buffer.from(f.bytes) })), ...code.files.map(f => ({ name: `code/${f.path}`, bytes: fixedFile(resolve(root, f.path)).bytes }))];
}
export function assertAgencyEvidenceCurrent(session) {
  const cap = sessions.get(session); check(cap, 'agency_session_untrusted');
  for (const original of [...cap.files, ...cap.archives.flat()]) { const now = fixedFile(original.path); check(now.digest === original.digest && now.identity === original.identity, 'agency_source_changed'); }
  check(captureAgencyCode().digest === cap.codeDigest && cap.codeDigest === loadedAgencyCodeDigest, 'agency_code_changed'); return true;
}
export function bindAgencyArchive(session, archive) {
  const cap = sessions.get(session); check(cap, 'agency_session_untrusted');
  const file = fixedFile(resolve(archive.path, 'archive.json')); check(file.digest === archive.archiveId, 'agency_archive_changed'); const manifest = readJson(file), files = [file];
  check(manifest.version === 'material-evidence-archive/1' && Array.isArray(manifest.entries), 'agency_archive_invalid');
  manifest.entries.forEach((entry, index) => { check(entry.blob === `${index}.blob`, 'agency_archive_invalid'); const blob = fixedFile(resolve(archive.path, entry.blob)); check(blob.digest === entry.sha256 && blob.bytes.length === entry.size, 'agency_archive_changed'); files.push(blob); });
  cap.archives.push(files);
}
export function assertAgencyLoadedCode() { const code = captureAgencyCode(); check(code.digest === loadedAgencyCodeDigest, 'agency_code_restart_required'); return code; }
export function agencyTargetSnapshot(db,scope){validateScope(scope);return scopedAccountingTargetSnapshot(db,scope);}
// Shared fixed read for native period controls; agency keeps its own supported years.
export function scopedAccountingTargetSnapshot(db, scope) {
  check(scope&&typeof scope.enterpriseKey==='string'&&scope.enterpriseKey===scope.enterpriseKey.normalize('NFKC').trim()&&Number.isSafeInteger(scope.accountSetId)&&scope.accountSetId>0&&typeof scope.databaseInstanceId==='string'&&/^20\d\d-(0[1-9]|1[0-2])$/.test(scope.period)&&scope.currency==='CNY','period_scope_invalid');
  const instance = db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get();
  const binding = db.prepare('SELECT enterprise_key FROM import_enterprise_account_sets WHERE account_set_id=?').get(scope.accountSetId);
  check(instance?.instance_id === scope.databaseInstanceId && binding?.enterprise_key === scope.enterpriseKey, 'agency_target_identity_mismatch');
  const set = db.prepare('SELECT * FROM account_sets WHERE id=?').get(scope.accountSetId); check(set, 'agency_target_missing');
  const tables = ['accounts', 'opening_balances', 'periods', 'vouchers','asset_cards','asset_depreciation_runs'];
  const snapshot = { set, instance: instance.instance_id, binding: binding.enterprise_key };
  for (const table of tables) snapshot[table] = db.prepare(`SELECT * FROM ${table} WHERE account_set_id=? ORDER BY rowid`).all(scope.accountSetId);
  snapshot.entries = db.prepare('SELECT e.* FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? ORDER BY e.id').all(scope.accountSetId);
  snapshot.sources = db.prepare('SELECT * FROM import_voucher_sources WHERE account_set_id=? ORDER BY rowid').all(scope.accountSetId);
  return digest(stable(snapshot));
}
export function withAgencyEvidence(session, targetDigest, fn) {
  check(sessions.has(session) && /^[a-f0-9]{64}$/.test(targetDigest) && typeof fn === 'function' && !context.getStore(), 'agency_evidence_context_invalid');
  assertAgencyEvidenceCurrent(session);
  return context.run({ session, targetDigest, admitted: false }, fn);
}
export function assertAgencyAdmissionEvidence(db) {
  const current = context.getStore(); if (!current || current.admitted) return;
  assertAgencyEvidenceCurrent(current.session);
  check(agencyTargetSnapshot(db, sessions.get(current.session).document.scope) === current.targetDigest, 'agency_target_changed'); current.admitted = true;
}
export function assertAgencyCommitEvidence(db) {
  const current = context.getStore(); if (!current) return;
  check(current.admitted, 'agency_admission_missing'); assertAgencyEvidenceCurrent(current.session);
  // A commit changes target contents; identity still must match the same database/enterprise.
  agencyTargetSnapshot(db, sessions.get(current.session).document.scope);
}
// Bind execution to the files present when this process imported its fixed
// business closure. A later disk edit requires a new process, even before load.
const loadedAgencyCodeDigest = (() => { try { return captureAgencyCode().digest; } catch { return null; } })();
