// Pure batch preflight; never a receipt for posting or period completeness.
import { MATERIAL_VERSION, hash, stable, fields, identifier, requireValue, validateScope, normalizeMaterial, safeMaterialError, requirePlainJson } from './offline-material-adapters.mjs';

export function preflightMaterials(input) {
  const base = { version: MATERIAL_VERSION, validationOnly: true, authorizesExecution: false, completeness: 'not_assessed', assessment: { issue: 79, status: 'not_implemented' } };
  let sourceIndex;
  try {
    requirePlainJson(input);
    fields(input, ['scope', 'sources']); validateScope(input.scope);
    requireValue(Array.isArray(input.sources) && input.sources.length > 0 && input.sources.length <= 100, 'sources_invalid');
    const sources = [], records = [], sourceIds = new Set();
    for (const source of input.sources) {
      sourceIndex = sources.length;
      fields(source, ['sourceId', 'kind', 'scope', 'text', 'fileSha256', 'mapping']); identifier(source.sourceId);
      requireValue(!sourceIds.has(source.sourceId), 'source_id_conflict'); sourceIds.add(source.sourceId);
      requireValue(stable(source.scope) === stable(input.scope), 'scope_mismatch');
      const rows = normalizeMaterial(source);
      const mappingDigest = hash(stable(source.mapping));
      const sourceVersion = hash(stable({ version: MATERIAL_VERSION, kind: source.kind, scope: input.scope, fileSha256: source.fileSha256, mappingDigest }));
      sources.push({ sourceId: source.sourceId, kind: source.kind, scope: source.scope, fileSha256: source.fileSha256, mapping: source.mapping, mappingDigest, sourceVersion, rawContent: source.text });
      for (const row of rows) {
        const semanticDigest = hash(stable(row.semantic));
        records.push({ kind: row.kind, scope: input.scope, sourceId: source.sourceId, sourceVersion, fileSha256: source.fileSha256, docId: hash(stable([row.kind, input.scope.enterpriseKey, input.scope.accountSetId, row.identity])), semanticDigest, reliability: row.reliability, duplicateStatus: 'unique', location: row.location, raw: row.raw, data: row.semantic });
      }
    }
    sourceIndex = undefined;
    const groups = new Map();
    for (const r of records) { const group = groups.get(r.docId) ?? []; group.push(r); groups.set(r.docId, group); }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const status = group[0].reliability === 'suspected_only' ? 'suspected_duplicate'
        : new Set(group.map(r => r.semanticDigest)).size === 1 ? 'duplicate' : 'conflict';
      group.forEach(r => { r.duplicateStatus = status; });
    }
    const unresolvedReferences = [];
    for (const r of records.filter(r => r.kind === 'business_fact')) {
      const ref = r.data.invoiceRef;
      const matches = records.filter(x => x.kind === 'invoice' && x.data.sellerKey === ref.sellerKey && x.data.code === ref.code && x.data.number === ref.number);
      r.referenceVerification = matches.length ? 'matched_in_batch' : 'missing';
      if (!matches.length) unresolvedReferences.push({ sourceId: r.sourceId, docId: r.docId, reasonCode: 'invoice_reference_missing' });
      if (matches.some(x => x.duplicateStatus === 'conflict')) { r.duplicateStatus = 'conflict'; r.referenceVerification = 'conflict'; }
    }
    sourceIndex = undefined;
    const missingKinds = ['invoice_csv', 'bank_csv', 'business_json'].filter(k => !sources.some(s => s.kind === k || k === 'invoice_csv' && s.kind === 'invoice_xlsx' || k === 'bank_csv' && s.kind === 'bank_xlsx'));
    const conflictCount = records.filter(r => r.duplicateStatus === 'conflict').length;
    return { ...base, ok: conflictCount === 0, status: conflictCount ? 'blocked_conflict' : missingKinds.length || unresolvedReferences.length ? 'partial' : 'preflight_only', scope: input.scope,
      batchVersion: hash(stable(sources.map(s => [s.sourceId, s.sourceVersion]).sort())), sources, records, missingKinds, unresolvedReferences,
      counts: { sources: sources.length, records: records.length, conflicts: conflictCount, duplicates: records.filter(r => r.duplicateStatus === 'duplicate').length, suspectedDuplicates: records.filter(r => r.duplicateStatus === 'suspected_duplicate').length },
      errors: conflictCount ? [{ code: 'material_conflict' }] : [] };
  } catch (error) {
    // Never expose raw parser messages, identifiers, paths or arbitrary error codes.
    return { ...base, ok: false, status: 'rejected', sources: [], records: [], counts: { sources: 0, records: 0, conflicts: 0, duplicates: 0, suspectedDuplicates: 0 }, errors: [safeMaterialError(error, sourceIndex)] };
  }
}
