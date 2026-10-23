// Explicit input loader shared by VAT and accountant review; never imports the default DB.
import { resolve, dirname } from 'node:path';
import { fields, requireValue, hash, sourceText, stable, validateScope } from './offline-material-adapters.mjs';
import { preflightMaterials } from './offline-materials.mjs';
import { readLocalFile, inspectMaterialStore } from './offline-material-store.mjs';
import { openReadonlyLedgerSource, captureLedgerSnapshot, validateLedgerSnapshot } from './offline-ledger-snapshot.mjs';

const sessions = new WeakMap(), rawSessions = new WeakMap();
export function assertVatInputPayload(rawInput, source, snapshot) {
  const state = rawSessions.get(rawInput);
  if (!state) return;
  requireValue(state.source === source && state.snapshot === snapshot, 'input_session_untrusted');
  state.assertPayload();
}
export async function assertVatInputSessionCurrent(session, rawInput, source, snapshot) {
  const state = sessions.get(session);
  requireValue(state && state.rawInput === rawInput && state.source === source && state.snapshot === snapshot, 'input_session_untrusted');
  await state.assertCurrent();
  return structuredClone(state.inventory);
}

// File-backed raw inputs retain their private guard even when a caller omits the facade.
export async function assertVatInputCurrent(rawInput, source, snapshot, session) {
  if (session !== undefined) return assertVatInputSessionCurrent(session, rawInput, source, snapshot);
  const state = rawSessions.get(rawInput);
  if (!state) return [];
  requireValue(state.source === source && state.snapshot === snapshot, 'input_session_untrusted');
  await state.assertCurrent();
  return structuredClone(state.inventory);
}

export async function openVatInputFiles(inputPath) {
  let source;
  try {
    const reads = [], origins = [];
    const read = async (path, limit, kind) => { const f = await readLocalFile(path, limit); reads.push({ path: f.canonicalPath, hash: hash(f.bytes) }); return { path: f.canonicalPath, text: sourceText(kind, f.bytes), fileSha256: hash(f.bytes) }; };
    const json = async (path, limit) => { const f = await read(path, limit); return { ...f, value: JSON.parse(f.text.replace(/^\uFEFF/, '')) }; };
    const input = await json(resolve(inputPath)), c = input.value, base = dirname(input.path);
    fields(c, ['version', 'scope', 'profileId', 'declaration', 'accountingFacts', 'taxFacts', 'db'], ['materialsInput', 'materialStore', 'previousComputation']);
    requireValue(c.version === 'offline-vat-input/1' && ('materialsInput' in c) !== ('materialStore' in c));
    for (const k of ['declaration', 'accountingFacts', 'taxFacts', 'db', ...('materialsInput' in c ? ['materialsInput'] : ['materialStore']), ...('previousComputation' in c ? ['previousComputation'] : [])]) requireValue(typeof c[k] === 'string' && c[k].length > 0);
    let reports, storeDigest;
    if ('materialsInput' in c) {
      const m = await json(resolve(base, c.materialsInput)); fields(m.value, ['scope', 'sources']); requireValue(stable(m.value.scope) === stable(c.scope) && Array.isArray(m.value.sources) && m.value.sources.length <= 100);
      const sources = [];
      for (const s of m.value.sources) {
        fields(s, ['sourceId', 'kind', 'scope', 'path', 'mapping']); requireValue(typeof s.path === 'string' && s.path.length > 0);
        const f = await read(resolve(dirname(m.path), s.path), undefined, s.kind);
        origins.push({ sourceId: s.sourceId, kind: s.kind, path: f.path, hash: f.fileSha256, fileSha256: f.fileSha256, receiptId: null, sourceVersion: null });
        sources.push({ sourceId: s.sourceId, kind: s.kind, scope: s.scope, mapping: s.mapping, text: f.text, fileSha256: f.fileSha256 });
      }
      reports = sources.length ? [preflightMaterials({ scope: c.scope, sources })] : [];
      for (const origin of origins) origin.sourceVersion = reports.flatMap(r => r.sources).find(s => s.sourceId === origin.sourceId)?.sourceVersion ?? null;
    } else {
      const store = await inspectMaterialStore(resolve(base, c.materialStore)); requireValue(store.status === 'verified' && !store.writerBlocked && stable(store.scope) === stable(c.scope), 'material_store_not_current');
      reports = store.reports; storeDigest = hash(stable(store));
      for (const e of store.active) origins.push({ sourceId: e.sourceId, kind: e.kind, path: e.originPath, hash: e.fileSha256, fileSha256: e.fileSha256, sourceVersion: e.sourceVersion, receiptId: e.receiptId, originStatus: e.originStatus, configPath: e.configPath });
    }
    const declaration = (await json(resolve(base, c.declaration))).value;
    const accounting = await read(resolve(base, c.accountingFacts)), tax = await read(resolve(base, c.taxFacts));
    const previous = c.previousComputation ? (await json(resolve(base, c.previousComputation))).value : undefined;
    source = openReadonlyLedgerSource(resolve(base, c.db));
    const range = validateScope(c.scope);
    const snapshot = captureLedgerSnapshot(source, { enterpriseKey: c.scope.enterpriseKey, accountSetId: Number(c.scope.accountSetId), fromPeriod: range.from, toPeriod: range.to });
    const rawInput = { scope: c.scope, reports, declaration, profileId: c.profileId, accountingFacts: { text: accounting.text, fileSha256: hash(accounting.text) }, taxFacts: { text: tax.text, fileSha256: hash(tax.text) }, ...(previous === undefined ? {} : { previousComputation: previous }) };
    const rawDigest = hash(stable(rawInput));
    let closed = false;
    const assertPayload = () => {
      requireValue(!closed, 'input_session_closed');
      requireValue(hash(stable(rawInput)) === rawDigest, 'input_payload_changed');
    };
    const assertCurrent = async () => {
      assertPayload();
      for (const f of reads) requireValue(hash((await readLocalFile(f.path, 64 * 1024 * 1024)).bytes) === f.hash, 'input_changed');
      if (storeDigest) requireValue(hash(stable(await inspectMaterialStore(resolve(base, c.materialStore)))) === storeDigest, 'material_store_changed');
      requireValue(validateLedgerSnapshot(source, snapshot).status === 'current', 'ledger_changed');
    };
    const close = () => { if (!closed) { closed = true; source.close(); } };
    const session = { rawInput, source, snapshot, assertCurrent, close };
    const state = { rawInput, source, snapshot, inventory: [...reads, ...origins].map(f => ({ ...f })), assertCurrent, assertPayload };
    sessions.set(session, state); rawSessions.set(rawInput, state);
    return session;
  } catch (e) { source?.close(); throw e; }
}
