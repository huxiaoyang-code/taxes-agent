// Local receipt journal only. No ledger, network, default directory or accounting authority.
import { open, lstat, realpath, readdir, mkdir, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, basename, join, parse, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { preflightMaterials } from './offline-materials.mjs';
import { MATERIAL_VERSION, hash, stable, fields, validateScope, identifier } from './offline-material-adapters.mjs';

const VERSION = 'offline-material-store/1', LIMIT = 5 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (condition, code = 'store_corrupt') => { if (!condition) fail(code); };
const same = (a, b) => stable(a) === stable(b);
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const json = bytes => JSON.parse(decode(bytes).replace(/^\uFEFF/, ''));
const inside = (root, path) => { const p = relative(root, path); return p === '' || (!p.startsWith('..') && !isAbsolute(p)); };
const identity = s => `${s.dev}:${s.ino}:${s.birthtimeMs}`;

// Reject links at every existing component, not merely at the final filename.
export async function checkedPath(path, directory = false) {
  check(typeof path === 'string' && path.length > 0 && path.length <= 32768, 'path_rejected');
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const s = await lstat(current);
    check(!s.isSymbolicLink(), 'path_rejected');
    check(current === absolute || s.isDirectory(), 'path_rejected');
    if (current === absolute) check(directory ? s.isDirectory() : s.isFile() && s.nlink === 1, 'path_rejected');
  }
  check(resolve(await realpath(absolute)).toLowerCase() === absolute.toLowerCase(), 'path_rejected');
  return absolute;
}
export async function readLocalFile(path, limit = LIMIT) {
  const canonicalPath = await checkedPath(path), before = await lstat(canonicalPath);
  check(before.size <= limit, 'file_too_large');
  const h = await open(canonicalPath, 'r');
  try {
    const held = await h.stat();
    check(identity(before) === identity(held) && held.nlink === 1 && held.size <= limit, 'path_changed');
    // Bounded read even if an external writer grows the file after stat.
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length <= limit) { const r = await h.read(buffer, length, buffer.length - length, null); if (!r.bytesRead) break; length += r.bytesRead; }
    check(length <= limit, 'file_too_large');
    const after = await h.stat(), named = await lstat(canonicalPath);
    await checkedPath(canonicalPath);
    check(identity(named) === identity(held) && identity(after) === identity(held) && after.size === length && before.size === length && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs, 'path_changed');
    return { canonicalPath, bytes: buffer.subarray(0, length) };
  } finally { await h.close(); }
}
async function writeNew(path, bytes) {
  const h = await open(path, 'wx', 0o600);
  try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
}
async function rootInfo(path) {
  const root = await checkedPath(path, true), s = await lstat(root);
  return { root, id: identity(s) };
}
async function rootStill(info) { check((await rootInfo(info.root)).id === info.id, 'path_changed'); }

export async function initMaterialStore(path, scope) {
  validateScope(scope);
  const root = resolve(path), parent = await checkedPath(dirname(root), true);
  check(basename(root) !== '' && root !== parent, 'path_rejected');
  // Never adopt an existing empty/unknown directory. Interrupted init remains diagnostic.
  await mkdir(root, { mode: 0o700 });
  const metadata = { version: VERSION, storeId: randomUUID(), scope, normalizationVersion: MATERIAL_VERSION };
  await writeNew(join(root, 'store.json'), stable(metadata) + '\n');
  return { version: VERSION, status: 'initialized', authorizesExecution: false, completeness: 'not_assessed' };
}

async function loadStore(path) {
  const info = await rootInfo(path);
  const metaFile = await readLocalFile(join(info.root, 'store.json'));
  const meta = json(metaFile.bytes);
  fields(meta, ['version', 'storeId', 'scope', 'normalizationVersion']); validateScope(meta.scope);
  check(meta.version === VERSION && meta.normalizationVersion === MATERIAL_VERSION && /^[a-f0-9-]{36}$/.test(meta.storeId));
  const names = (await readdir(info.root)).sort();
  check(names.length <= 3002, 'store_limit');
  const commits = [], active = new Map(), history = [];
  let previous = hash(metaFile.bytes), sequence = 0;
  for (const name of names) {
    if (name === 'store.json') continue;
    if (name === 'lock.json' || name === 'recovery.guard') { await checkedPath(join(info.root, name)); continue; }
    if (/^pending-[a-f0-9-]{36}$/.test(name)) { await checkedPath(join(info.root, name), true); continue; }
    const match = /^(\d{6})-([a-f0-9]{64})$/.exec(name);
    check(match && Number(match[1]) === ++sequence && sequence <= 1000);
    const dir = join(info.root, name); await checkedPath(dir, true);
    const raw = await readLocalFile(join(dir, 'manifest.json'));
    check(hash(raw.bytes) === match[2]);
    const m = json(raw.bytes);
    fields(m, ['version', 'storeId', 'sequence', 'previous', 'normalizationVersion', 'entries']);
    check(m.version === VERSION && m.storeId === meta.storeId && m.sequence === sequence && m.previous === previous && m.normalizationVersion === MATERIAL_VERSION);
    check(Array.isArray(m.entries) && m.entries.length > 0 && m.entries.length <= 100);
    const expectedFiles = ['manifest.json'], ids = new Set();
    for (let i = 0; i < m.entries.length; i++) {
      const e = m.entries[i];
      fields(e, ['sourceId', 'kind', 'scope', 'mapping', 'fileSha256', 'sourceVersion', 'originPath', 'configPath', 'blob', 'supersedes']);
      identifier(e.sourceId); check(!ids.has(e.sourceId)); ids.add(e.sourceId);
      check(same(e.scope, meta.scope) && e.blob === `${i}.blob` && typeof e.originPath === 'string' && isAbsolute(e.originPath) && typeof e.configPath === 'string' && isAbsolute(e.configPath));
      check(DIGEST.test(e.fileSha256) && DIGEST.test(e.sourceVersion)); expectedFiles.push(e.blob);
      const old = active.get(e.sourceId);
      check(old ? e.supersedes === old.sourceVersion && e.sourceVersion !== old.sourceVersion : e.supersedes === null);
      const blob = await readLocalFile(join(dir, e.blob)); check(hash(blob.bytes) === e.fileSha256, 'blob_corrupt');
      const source = { sourceId: e.sourceId, kind: e.kind, scope: e.scope, mapping: e.mapping, text: decode(blob.bytes), fileSha256: e.fileSha256 };
      const report = preflightMaterials({ scope: meta.scope, sources: [source] });
      check(report.status !== 'rejected' && report.sources[0].sourceVersion === e.sourceVersion, 'store_corrupt');
      const entry = { ...e, source, receiptId: match[2], sequence };
      history.push({ ...e, receiptId: match[2], sequence }); active.set(e.sourceId, entry);
    }
    check(same((await readdir(dir)).sort(), expectedFiles.sort()));
    commits.push({ receiptId: match[2], sequence, sourceIds: m.entries.map(e => e.sourceId) }); previous = match[2];
  }
  check(active.size <= 100, 'store_limit');
  check(same(names, (await readdir(info.root)).sort()), 'store_changed'); await rootStill(info);
  return { info, meta, sequence, previous, active, history, commits, writerBlocked: names.includes('lock.json') || names.includes('recovery.guard') };
}
async function originIssues(state, except = new Set()) {
  const stale = [];
  for (const [sourceId, entry] of state.active) {
    if (except.has(sourceId)) continue;
    try { check(hash((await readLocalFile(entry.originPath)).bytes) === entry.fileSha256, 'origin_changed'); }
    catch { stale.push({ sourceId, code: 'origin_changed' }); }
  }
  return stale;
}
function fresh(state) {
  const sources = [...state.active.values()].map(e => e.source);
  const report = sources.length ? preflightMaterials({ scope: state.meta.scope, sources }) : null;
  check(!report || report.status !== 'rejected', 'store_corrupt');
  return { version: VERSION, status: 'verified', authorizesExecution: false, completeness: 'not_assessed', authenticity: 'unverified', scope: state.meta.scope,
    writerBlocked: state.writerBlocked, receipts: state.commits, history: state.history, active: [...state.active.values()].map(({ source, ...e }) => e), reports: report ? [report] : [],
    counts: { sources: state.active.size, records: report?.counts.records ?? 0, receipts: state.commits.length } };
}
export async function inspectMaterialStore(path) {
  const state = await loadStore(path), stale = await originIssues(state);
  await rootStill(state.info);
  if (!stale.length) return fresh(state);
  const ids = new Set(stale.map(s => s.sourceId));
  const result = fresh({ ...state, active: new Map([...state.active].filter(([id]) => !ids.has(id))) });
  return { ...result, status: 'blocked_origin_changed', staleSourceIds: [...ids], errors: stale,
    active: [...state.active.values()].map(({ source, ...e }) => ({ ...e, originStatus: ids.has(e.sourceId) ? 'stale' : 'current' })),
    counts: { ...result.counts, activeSources: state.active.size, staleSources: stale.length } };
}
async function guardAbsent(info) {
  try { await lstat(join(info.root, 'recovery.guard')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  fail('recovery_blocked');
}
async function lockStore(info, storeId) {
  await guardAbsent(info);
  const path = join(info.root, 'lock.json'), lock = { version: VERSION, storeId, pid: process.pid, token: randomUUID() }, bytes = stable(lock) + '\n';
  try { await writeNew(path, bytes); } catch (e) { if (e.code === 'EEXIST') fail('store_locked'); throw e; }
  const release = async () => { await rootStill(info); const current = await readLocalFile(path); check(current.bytes.equals(Buffer.from(bytes)), 'lock_changed'); await unlink(path); };
  // A recovery guard that appeared after our first check owns this interval.
  try { await guardAbsent(info); } catch (e) { await release(); throw e; }
  return release;
}
// Explicit recovery only: a valid own-store lock whose OS PID is proven absent.
// PID reuse/EPERM/uncertain liveness blocks recovery; there is no age-based deletion.
export async function recoverMaterialStoreLock(path) {
  const state = await loadStore(path), lockPath = join(state.info.root, 'lock.json');
  const guardPath = join(state.info.root, 'recovery.guard');
  const guardBytes = stable({ version: VERSION, storeId: state.meta.storeId, pid: process.pid, token: randomUUID() }) + '\n';
  try { await writeNew(guardPath, guardBytes); } catch (e) { if (e.code === 'EEXIST') fail('recovery_blocked'); throw e; }
  try {
    const raw = await readLocalFile(lockPath), lock = json(raw.bytes);
    fields(lock, ['version', 'storeId', 'pid', 'token']);
    check(lock.version === VERSION && lock.storeId === state.meta.storeId && Number.isSafeInteger(lock.pid) && lock.pid > 0 && /^[a-f0-9-]{36}$/.test(lock.token), 'lock_unknown');
    let absent = false;
    try { process.kill(lock.pid, 0); } catch (e) { absent = e.code === 'ESRCH'; }
    check(absent, 'lock_live_or_uncertain');
    await rootStill(state.info); check((await readLocalFile(lockPath)).bytes.equals(raw.bytes), 'lock_changed');
    await unlink(lockPath); return { version: VERSION, status: 'lock_recovered', authorizesExecution: false, counts: { receipts: state.commits.length } };
  } finally {
    await rootStill(state.info); check((await readLocalFile(guardPath)).bytes.equals(Buffer.from(guardBytes)), 'lock_changed'); await unlink(guardPath);
  }
}
async function readConfig(configPath, storeRoot) {
  const file = await readLocalFile(configPath); check(!inside(storeRoot, file.canonicalPath), 'path_rejected');
  const config = json(file.bytes); fields(config, ['scope', 'sources']); validateScope(config.scope);
  check(Array.isArray(config.sources) && config.sources.length > 0 && config.sources.length <= 100, 'sources_invalid');
  const sources = [], inputs = [];
  for (const s of config.sources) {
    fields(s, ['sourceId', 'kind', 'scope', 'path', 'mapping'], ['supersedes', 'expectedSourceVersion']); identifier(s.sourceId);
    check(typeof s.path === 'string' && s.path.length > 0, 'path_rejected');
    const correction = Object.hasOwn(s, 'supersedes') || Object.hasOwn(s, 'expectedSourceVersion');
    check(!correction || DIGEST.test(s.supersedes) && s.expectedSourceVersion === s.supersedes, 'correction_invalid');
    const f = await readLocalFile(resolve(dirname(file.canonicalPath), s.path)); check(!inside(storeRoot, f.canonicalPath), 'path_rejected');
    sources.push({ sourceId: s.sourceId, kind: s.kind, scope: s.scope, text: decode(f.bytes), fileSha256: hash(f.bytes), mapping: s.mapping });
    inputs.push({ bytes: f.bytes, originPath: f.canonicalPath, configPath: file.canonicalPath, correction: correction ? s.supersedes : null });
  }
  const report = preflightMaterials({ scope: config.scope, sources });
  check(report.status !== 'rejected', 'material_rejected'); check(report.ok, 'material_conflict');
  return { scope: config.scope, report, inputs };
}
export async function receiveMaterials(path, configPath) {
  const initial = await loadStore(path), release = await lockStore(initial.info, initial.meta.storeId);
  try {
    const state = await loadStore(path), input = await readConfig(configPath, state.info.root);
    check(same(state.meta.scope, input.scope), 'scope_mismatch');
    const entries = [], blobs = [], receipts = new Set();
    for (let i = 0; i < input.report.sources.length; i++) {
      const s = input.report.sources[i], f = input.inputs[i], old = state.active.get(s.sourceId);
      if (old?.sourceVersion === s.sourceVersion) {
        // A retry of a committed correction must still name that correction's predecessor.
        check(!f.correction || f.correction === old.supersedes, 'correction_cas_conflict');
        check(f.originPath === old.originPath, 'source_origin_conflict'); receipts.add(old.receiptId); continue;
      }
      if (old) check(f.correction === old.sourceVersion, 'source_version_conflict');
      else check(!f.correction, 'correction_cas_conflict');
      const { rawContent, mappingDigest, ...metadata } = s;
      entries.push({ ...metadata, originPath: f.originPath, configPath: f.configPath, blob: `${entries.length}.blob`, supersedes: old?.sourceVersion ?? null }); blobs.push(f.bytes);
      state.active.set(s.sourceId, { ...entries.at(-1), source: { sourceId: s.sourceId, kind: s.kind, scope: s.scope, mapping: s.mapping, text: rawContent, fileSha256: s.fileSha256 } });
    }
    check(state.active.size <= 100, 'store_limit');
    const combined = preflightMaterials({ scope: state.meta.scope, sources: [...state.active.values()].map(e => e.source) });
    check(combined.status !== 'rejected' && combined.ok, 'material_conflict');
    if (entries.length) {
      check(state.sequence < 1000, 'store_limit');
      const manifest = { version: VERSION, storeId: state.meta.storeId, sequence: state.sequence + 1, previous: state.previous, normalizationVersion: MATERIAL_VERSION, entries };
      const bytes = Buffer.from(stable(manifest) + '\n'), receiptId = hash(bytes);
      const staging = join(state.info.root, `pending-${randomUUID()}`); await mkdir(staging, { mode: 0o700 });
      for (let i = 0; i < blobs.length; i++) await writeNew(join(staging, `${i}.blob`), blobs[i]);
      await writeNew(join(staging, 'manifest.json'), bytes);
      await rootStill(state.info);
      // New unique journal directory: no mutation/overwrite of previously committed state.
      await rename(staging, join(state.info.root, `${String(manifest.sequence).padStart(6, '0')}-${receiptId}`));
      receipts.add(receiptId);
    }
    const result = await inspectMaterialStore(path);
    const receiveStatus = entries.length ? 'received' : 'replayed';
    return { ...result, writerBlocked: false, status: result.status === 'blocked_origin_changed' ? result.status : receiveStatus, receiveStatus, receiptIds: [...receipts] };
  } finally { await release(); }
}

const SAFE = new Set(['store_corrupt', 'blob_corrupt', 'origin_changed', 'store_locked', 'recovery_blocked', 'store_changed', 'store_limit', 'path_rejected', 'path_changed', 'file_too_large', 'lock_changed', 'lock_unknown', 'lock_live_or_uncertain', 'material_rejected', 'material_conflict', 'sources_invalid', 'scope_mismatch', 'correction_invalid', 'correction_cas_conflict', 'source_version_conflict', 'source_origin_conflict']);
export const safeStoreError = error => SAFE.has(error?.code) ? error.code : 'io_or_config_rejected';
