// Explicit local files only. This module never imports a ledger or default DB.
import { resolve, dirname, join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { readLocalFile, inspectMaterialStore } from './offline-material-store.mjs';
import { preflightMaterials } from './offline-materials.mjs';
import { fields, requireValue, hash, stable, sourceText, validateScope, safeMaterialError } from './offline-material-adapters.mjs';

const sessions = new WeakMap(), payloads = new WeakMap();
export function offlineActionSessionPayload(session) {
  const state = sessions.get(session), descriptor = Object.getOwnPropertyDescriptor(session, 'rawInput');
  requireValue(state && descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === state.rawInput, 'action_session_untrusted');
  return state.rawInput;
}
export function offlineActionSessionEvidence(session) {
  offlineActionSessionPayload(session); return JSON.parse(JSON.stringify(sessions.get(session).evidence));
}
export async function assertOfflineActionInputCurrent(session) {
  offlineActionSessionPayload(session); await sessions.get(session).assertCurrent();
}
export function assertOfflineActionPayload(input) { payloads.get(input)?.assertPayload(); }
export async function openOfflineActionInput(inputPath) {
  const reads = [], failedReads = [], diagnostics = [], rejectedRecords = [], inventory = [];
  const fileState = async path => {
    try { const s = await lstat(path); return { dev: s.dev, ino: s.ino, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs, birthtime: s.birthtimeMs, mode: s.mode, nlink: s.nlink }; }
    catch (e) { return { error: typeof e.code === 'string' ? e.code : 'read_rejected' }; }
  };
  const read = async (path, kind, limit) => {
    let f; try { f = await readLocalFile(path, limit); }
    catch (e) { failedReads.push({ path, state: await fileState(path), code: e.code ?? 'read_rejected', limit }); throw e; }
    const digest = hash(f.bytes);
    reads.push({ path: f.canonicalPath, fileSha256: digest });
    return { path: f.canonicalPath, text: sourceText(kind, f.bytes), fileSha256: digest };
  };
  const json = async path => { const f = await read(path); return { ...f, value: JSON.parse(f.text.replace(/^\uFEFF/, '')) }; };
  const config = await json(resolve(inputPath)), c = config.value, base = dirname(config.path);
  fields(c, ['version', 'scope'], ['profileId', 'declaration', 'accountingFacts', 'materialsInput', 'materialStore', 'previousPlan']);
  requireValue(c.version === 'offline-action-input/1' && ('materialsInput' in c) !== ('materialStore' in c), 'action_input_invalid'); validateScope(c.scope);
  const pathString = p => requireValue(typeof p === 'string' && p.length > 0, 'action_input_invalid');
  const reports = []; let storePath, storeDigest, storeFailure;
  if ('materialsInput' in c) {
    pathString(c.materialsInput); const m = await json(resolve(base, c.materialsInput));
    fields(m.value, ['scope', 'sources']); requireValue(stable(m.value.scope) === stable(c.scope) && Array.isArray(m.value.sources) && m.value.sources.length <= 100, 'scope_mismatch');
    for (const s of m.value.sources) {
      let f;
      try {
        fields(s, ['sourceId', 'kind', 'scope', 'path', 'mapping']); pathString(s.path);
        f = await read(resolve(dirname(m.path), s.path), s.kind);
        const source = { sourceId: s.sourceId, kind: s.kind, scope: s.scope, mapping: s.mapping, text: f.text, fileSha256: f.fileSha256 };
        const result = preflightMaterials({ scope: c.scope, sources: [source] });
        if (result.status === 'rejected') {
          diagnostics.push({ sourceId: s.sourceId, kind: s.kind, status: 'provided_invalid', reason: 'source_preflight_rejected', errors: result.errors, input: source });
        } else reports.push(result);
        inventory.push({ sourceId: s.sourceId, kind: s.kind, path: f.path, fileSha256: f.fileSha256, sourceVersion: result.sources[0]?.sourceVersion ?? null, receiptId: null });
      } catch (e) {
        diagnostics.push({ sourceId: typeof s?.sourceId === 'string' ? s.sourceId : null, kind: s?.kind ?? null, status: 'provided_invalid', reason: 'source_read_or_mapping_rejected', error: safeMaterialError(e), ...(f ? { fileSha256: f.fileSha256 } : {}) });
      }
    }
  } else {
    pathString(c.materialStore); storePath = resolve(base, c.materialStore);
    try {
      const store = await inspectMaterialStore(storePath); storeDigest = hash(stable(store));
      requireValue(stable(store.scope) === stable(c.scope), 'scope_mismatch');
      const stale = new Set(store.staleSourceIds ?? []);
      // A lock blocks current candidate admission, not visibility of known receipt evidence.
      reports.push(...store.reports);
      for (const e of store.active) {
        inventory.push({ ...e });
        if (stale.has(e.sourceId) || store.writerBlocked) {
          // Receipt blob is diagnostic evidence only when its original is stale/locked.
          const blob = await read(join(storePath, `${String(e.sequence).padStart(6, '0')}-${e.receiptId}`, e.blob), e.kind);
          const result = preflightMaterials({ scope: c.scope, sources: [{ sourceId: e.sourceId, kind: e.kind, scope: e.scope, mapping: e.mapping, text: blob.text, fileSha256: blob.fileSha256 }] });
          rejectedRecords.push(...result.records);
          diagnostics.push({ sourceId: e.sourceId, kind: e.kind, status: 'provided_invalid', reason: stale.has(e.sourceId) ? 'receipt_original_stale' : 'receipt_store_locked', receipt: e, records: result.records });
        }
      }
      if (store.status !== 'verified' || store.writerBlocked) diagnostics.push({ sourceId: null, status: 'provided_invalid', reason: 'receipt_store_not_current', statusDetail: store.status, writerBlocked: store.writerBlocked, errors: store.errors ?? [] });
    } catch (e) { storeFailure = e.code ?? 'store_rejected'; diagnostics.push({ sourceId: null, status: 'provided_invalid', reason: 'receipt_store_invalid', error: safeMaterialError(e) }); }
  }
  const optional = async (key, asSource = false) => {
    if (c[key] == null) return null;
    pathString(c[key]);
    try { const f = await read(resolve(base, c[key]), undefined, asSource ? 5 * 1024 * 1024 : undefined); return asSource ? { text: f.text, fileSha256: f.fileSha256 } : JSON.parse(f.text.replace(/^\uFEFF/, '')); }
    catch (e) { if (key === 'previousPlan') throw e; diagnostics.push({ sourceId: null, status: 'provided_invalid', reason: `${key}_read_invalid`, error: safeMaterialError(e) }); return key === 'declaration' ? {} : null; }
  };
  const declaration = await optional('declaration'), accountingFacts = await optional('accountingFacts', true), previousPlan = await optional('previousPlan');
  const rawInput = { scope: c.scope, profileId: c.profileId ?? null, reports, declaration, accountingFacts, previousPlan, diagnostics, rejectedRecords };
  const rawDigest = hash(stable(rawInput)); let closed = false;
  const assertPayload = () => { requireValue(!closed, 'action_session_closed'); requireValue(hash(stable(rawInput)) === rawDigest, 'action_payload_changed'); };
  const assertCurrent = async () => {
    assertPayload();
    for (const f of reads) requireValue(hash((await readLocalFile(f.path)).bytes) === f.fileSha256, 'action_input_changed');
    for (const f of failedReads) {
      requireValue(stable(await fileState(f.path)) === stable(f.state), 'action_input_changed');
      let code; try { await readLocalFile(f.path, f.limit); code = 'now_readable'; } catch (e) { code = e.code ?? 'read_rejected'; }
      requireValue(code === f.code, 'action_input_changed');
    }
    if (storeDigest) requireValue(hash(stable(await inspectMaterialStore(storePath))) === storeDigest, 'action_store_changed');
    else if (storeFailure) { let code; try { await inspectMaterialStore(storePath); code = 'now_valid'; } catch (e) { code = e.code ?? 'store_rejected'; } requireValue(code === storeFailure, 'action_store_changed'); }
  };
  const session = { rawInput, inventory: structuredClone(inventory), assertCurrent, close() { closed = true; } };
  sessions.set(session, { rawInput, assertCurrent, evidence: { inputPath: config.path, files: reads, origins: inventory, failedReads, materialStore: storePath ? { path: storePath, inspectionDigest: storeDigest ?? null, failure: storeFailure ?? null } : null } }); payloads.set(rawInput, { assertPayload }); return session;
}
