#!/usr/bin/env node
// Explicit files/store + fresh private read capability on EVERY invocation.
import { open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fields, requireValue, hash, stable, validateScope } from '../server/offline-material-adapters.mjs';
import { preflightMaterials } from '../server/offline-materials.mjs';
import { readLocalFile, inspectMaterialStore } from '../server/offline-material-store.mjs';
import { openReadonlyLedgerSource, captureLedgerSnapshot, validateLedgerSnapshot } from '../server/offline-ledger-snapshot.mjs';
import { calculateOfflineVat } from '../server/tax-calculation.mjs';

export async function runCli(args) {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output' || !args[1] || !args[3]) return { exitCode: 2, message: 'OFFLINE_VAT_USAGE_ERROR' };
  let source;
  try {
    const reads = [], decode = b => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);
    const read = async (path, limit) => { const f = await readLocalFile(path, limit); reads.push({ path: f.canonicalPath, hash: hash(f.bytes) }); return { path: f.canonicalPath, text: decode(f.bytes) }; };
    const json = async (path, limit) => { const f = await read(path, limit); return { ...f, value: JSON.parse(f.text.replace(/^\uFEFF/, '')) }; };
    const input = await json(resolve(args[1])), c = input.value, base = dirname(input.path);
    fields(c, ['version', 'scope', 'profileId', 'declaration', 'accountingFacts', 'taxFacts', 'db'], ['materialsInput', 'materialStore', 'previousComputation']);
    requireValue(c.version === 'offline-vat-input/1' && ('materialsInput' in c) !== ('materialStore' in c));
    for (const k of ['declaration', 'accountingFacts', 'taxFacts', 'db', ...('materialsInput' in c ? ['materialsInput'] : ['materialStore']), ...('previousComputation' in c ? ['previousComputation'] : [])]) requireValue(typeof c[k] === 'string' && c[k].length > 0);
    let reports, storeDigest;
    if ('materialsInput' in c) {
      const m = await json(resolve(base, c.materialsInput)); fields(m.value, ['scope', 'sources']); requireValue(stable(m.value.scope) === stable(c.scope) && Array.isArray(m.value.sources) && m.value.sources.length <= 100);
      const sources = [];
      for (const s of m.value.sources) {
        fields(s, ['sourceId', 'kind', 'scope', 'path', 'mapping']); requireValue(typeof s.path === 'string' && s.path.length > 0);
        const f = await read(resolve(dirname(m.path), s.path)); sources.push({ sourceId: s.sourceId, kind: s.kind, scope: s.scope, mapping: s.mapping, text: f.text, fileSha256: hash(f.text) });
      }
      reports = sources.length ? [preflightMaterials({ scope: c.scope, sources })] : [];
    } else {
      const store = await inspectMaterialStore(resolve(base, c.materialStore)); requireValue(store.status === 'verified' && !store.writerBlocked && stable(store.scope) === stable(c.scope), 'material_store_not_current');
      reports = store.reports; storeDigest = hash(stable(store));
    }
    const declaration = (await json(resolve(base, c.declaration))).value;
    const accounting = await read(resolve(base, c.accountingFacts)), tax = await read(resolve(base, c.taxFacts));
    const previous = c.previousComputation ? (await json(resolve(base, c.previousComputation))).value : undefined;
    source = openReadonlyLedgerSource(resolve(base, c.db));
    const range = validateScope(c.scope);
    const snapshot = captureLedgerSnapshot(source, { enterpriseKey: c.scope.enterpriseKey, accountSetId: Number(c.scope.accountSetId), fromPeriod: range.from, toPeriod: range.to });
    const result = calculateOfflineVat({ scope: c.scope, reports, declaration, profileId: c.profileId, accountingFacts: { text: accounting.text, fileSha256: hash(accounting.text) }, taxFacts: { text: tax.text, fileSha256: hash(tax.text) }, ...(previous === undefined ? {} : { previousComputation: previous }) }, source, snapshot);
    for (const f of reads) requireValue(hash((await readLocalFile(f.path, 64 * 1024 * 1024)).bytes) === f.hash, 'input_changed');
    if (storeDigest) requireValue(hash(stable(await inspectMaterialStore(resolve(base, c.materialStore)))) === storeDigest, 'material_store_changed');
    requireValue(validateLedgerSnapshot(source, snapshot).status === 'current', 'ledger_changed');
    const output = resolve(args[3]), handle = await open(output, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(result, null, 2) + '\n', 'utf8'); }
    catch (e) { await handle.close(); await unlink(output); throw e; }
    await handle.close();
    return { exitCode: result.calculationReady ? 0 : 3, message: `OFFLINE_VAT_WRITTEN ready=${result.calculationReady ? 1 : 0} issues=${result.issues.length}` };
  } catch { return { exitCode: 4, message: 'OFFLINE_VAT_REJECTED' }; }
  finally { source?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCli(process.argv.slice(2)); process.stdout.write(result.message + '\n'); process.exitCode = result.exitCode;
}
