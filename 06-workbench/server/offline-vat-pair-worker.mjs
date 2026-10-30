// 原生依赖引导：应用导入前先比较父进程在启动子进程前捕获的闭包。
import { assertOfflineVatPairCodeCurrent } from './offline-vat-pair-code.mjs';
let session, digest, closed = false, queue = Promise.resolve(), application;
const send = message => new Promise((ok, no) => {
  if (!process.send || !process.connected) return no(new Error('disconnected'));
  process.send({ version: 'offline-vat-pair-ipc/1', ...message }, e => e ? no(e) : ok());
});
function closeSession() { try { session?.close(); } finally { session = undefined; closed = true; } }
function shutdown() { try { closeSession(); } finally { process.exit(0); } }
process.on('disconnect', shutdown); process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
let expected;
try {
  expected = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
  assertOfflineVatPairCodeCurrent(expected);
  application = await Promise.all([
    import('./offline-vat-input.mjs'), import('./tax-calculation.mjs'),
    import('./offline-accounting-readiness.mjs'), import('./offline-bookkeeping.mjs'),
    import('./offline-material-adapters.mjs'), import('./import-storage.mjs'), import('./offline-contracts.mjs'),
  ]);
  assertOfflineVatPairCodeCurrent(expected);
} catch {
  if (process.send && process.connected) await send({ type: 'ready', codeBinding: { restartRequired: true } }).catch(() => {});
  shutdown();
}
const [loader, calculator, readiness, bookkeeping, adapters, storage, contracts] = application;
const { fields, requirePlainJson, requireValue, stable, hash } = adapters;
const { VAT_EXCLUSIONS, VAT_SOURCE_SYSTEM, calculateOfflineVat } = calculator;
const text = s => requireValue(typeof s === 'string' && s === s.trim() && s.length > 0 && s.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(s), 'tax_fact_invalid');
const same = (a, b) => stable(a) === stable(b);
function pointerValue(doc, pointer) {
  requireValue(typeof pointer === 'string' && /^\/(?:[^~]|~[01])*$/.test(pointer), 'tax_reference_invalid');
  let v = doc;
  for (const p of pointer.slice(1).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'))) { requireValue(v !== null && typeof v === 'object' && Object.hasOwn(v, p), 'tax_reference_invalid'); v = v[p]; }
  requireValue(v !== null && v !== '' && v !== undefined, 'tax_reference_invalid');
}
function parseTaxFacts(raw, input, replay) {
  requirePlainJson(raw); fields(raw, ['text', 'fileSha256']); requireValue(typeof raw.text === 'string' && Buffer.byteLength(raw.text) <= 5 * 1024 * 1024 && hash(raw.text) === raw.fileSha256, 'tax_source_digest_invalid');
  const doc = JSON.parse(raw.text.replace(/^\uFEFF/, '')); requirePlainJson(doc);
  fields(doc, ['version', 'scope', 'enterprise', 'period', 'invoices']); requireValue(doc.version === 'offline-tax-facts/1' && same(doc.scope, input.scope), 'tax_scope_mismatch');
  const confirm = (f, required) => {
    fields(f, [...required, 'confirmedBy', 'basis', 'sourceRefs']); fields(f.confirmedBy, ['name', 'role']); text(f.confirmedBy.name); text(f.basis);
    requireValue(['accountant', 'owner', 'business_operator'].includes(f.confirmedBy.role), 'tax_fact_invalid');
    requireValue(Array.isArray(f.sourceRefs) && f.sourceRefs.length > 0 && f.sourceRefs.length <= 50, 'tax_reference_invalid');
    for (const r of f.sourceRefs) {
      fields(r, ['kind', 'fileSha256', 'pointer'], ['sourceId']); let value, sha;
      if (r.kind === 'declaration') { requireValue(!('sourceId' in r), 'tax_reference_invalid'); value = input.declaration; sha = hash(stable(value)); }
      else if (r.kind === 'accounting_facts') { requireValue(!('sourceId' in r), 'tax_reference_invalid'); value = JSON.parse(input.accountingFacts.text.replace(/^\uFEFF/, '')); sha = input.accountingFacts.fileSha256; }
      else if (r.kind === 'business_json') { const source = replay.assessment.sources.find(s => s.sourceId === r.sourceId && s.kind === 'business_json'); requireValue(source, 'tax_reference_invalid'); value = JSON.parse(source.rawContent.replace(/^\uFEFF/, '')); sha = source.fileSha256; }
      else requireValue(false, 'tax_reference_invalid');
      requireValue(r.fileSha256 === sha, 'tax_reference_digest_mismatch'); pointerValue(value, r.pointer);
    }
  };
  confirm(doc.enterprise, ['form', 'establishedOn']); requireValue(['enterprise', 'individual_business', 'natural_person', 'unknown'].includes(doc.enterprise.form), 'tax_fact_invalid');
  requireValue(doc.enterprise.establishedOn === null || typeof doc.enterprise.establishedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(doc.enterprise.establishedOn) && new Date(doc.enterprise.establishedOn + 'T00:00:00Z').toISOString().slice(0, 10) === doc.enterprise.establishedOn, 'tax_fact_invalid');
  confirm(doc.period, ['exclusions']); requireValue(Array.isArray(doc.period.exclusions) && doc.period.exclusions.length <= VAT_EXCLUSIONS.length, 'tax_fact_invalid');
  const seen = new Set();
  for (const f of doc.period.exclusions) { confirm(f, ['area', 'state']); requireValue(VAT_EXCLUSIONS.includes(f.area) && !seen.has(f.area) && ['none', 'present', 'unknown'].includes(f.state), 'tax_fact_invalid'); seen.add(f.area); }
  requireValue(Array.isArray(doc.invoices) && doc.invoices.length <= 1000, 'tax_fact_invalid');
  for (const f of doc.invoices) {
    confirm(f, ['invoiceRef', 'invoiceClass', 'domesticConsumption', 'serviceCategory']); fields(f.invoiceRef, ['sellerKey', 'code', 'number']);
    text(f.invoiceRef.sellerKey); requireValue(typeof f.invoiceRef.code === 'string' && /^(?:|\d{1,30})$/.test(f.invoiceRef.code) && typeof f.invoiceRef.number === 'string' && /^\d{1,30}$/.test(f.invoiceRef.number), 'tax_fact_invalid');
    requireValue(['ordinary', 'special', 'unknown'].includes(f.invoiceClass) && ['domestic', 'cross_border', 'unknown'].includes(f.domesticConsumption) && ['ordinary_main_service', 'real_estate', 'land', 'construction', 'other', 'unknown'].includes(f.serviceCategory), 'tax_fact_invalid');
  }
  return doc;
}

function diagnoseTarget(priorAdmitted, priorEnterprise) {
  const { rawInput: input, snapshot } = session.target;
  const raw = { scope: input.scope, reports: input.reports, declaration: input.declaration, profileId: input.profileId, accountingFacts: input.accountingFacts };
  const replay = readiness.assessAccountingReadiness(raw), rebuilt = bookkeeping.buildOfflineCandidates(raw);
  let facts; try { facts = parseTaxFacts(input.taxFacts, input, replay); } catch { throw Object.assign(new Error('pair_tax_facts_invalid'), { code: 'pair_tax_facts_invalid' }); }
  const issues = [], legacyHistoryIssues = [], reconciled = [], used = new Set();
  const issue = (code, field, classification = 'conflict') => issues.push({ code, field, classification });
  for (const row of replay.assessment.rows) if (!['provided_valid', 'not_applicable'].includes(row.status)) {
    if (['opening', 'history'].includes(row.id)) legacyHistoryIssues.push({ code: `materials_${row.status}`, field: row.id, classification: row.status, audience: 'operator_engineering', customerActionRequired: false });
    else issue(`materials_${row.status}`, row.id, row.status);
  }
  for (const decision of rebuilt.decisions) if (decision.status !== 'candidate') issue('accounting_business_not_admitted', decision.businessKey ?? decision.subjectKey, decision.status);
  if (snapshot.completeness.moneyIssues.length) issue('ledger_stored_money_invalid', 'ledger');
  if (snapshot.completeness.unknownStatuses.length) issue('ledger_unknown_status', 'ledger', 'unknown');
  if (snapshot.completeness.missingPeriods.length) issue('ledger_months_missing', 'ledger', 'missing');
  if (snapshot.counts.draft) issue('ledger_draft_not_posted', 'ledger');
  if (snapshot.sources.schemaStatus !== 'present') issue('ledger_source_schema_missing', 'ledger', 'missing');
  for (const c of rebuilt.candidates) {
    const links = snapshot.sources.voucherSources.filter(s => s.source_system === VAT_SOURCE_SYSTEM && s.source_voucher_id === c.businessKey);
    if (links.length !== 1) { issue('candidate_posted_source_missing_or_ambiguous', c.businessKey, 'missing'); continue; }
    const link = links[0], v = snapshot.vouchers.find(v => v.id === link.voucher_id), check = snapshot.sources.checks.find(x => x.sourceId === link.id);
    const batch = snapshot.sources.batches.find(b => b.batch_id === link.batch_id);
    const entries = c.entries.map(e => ({ code: e.accountCode, debit: e.debit, credit: e.credit, summary: e.detail ?? c.kind }));
    const expected = { period: c.date.slice(0, 7), date: c.date, summary: `offline:${c.businessKey}`, entries };
    const match = v && !used.has(v.id) && v.status === 'posted' && v.range === 'requested' && v.account_set_id === snapshot.scope.accountSetId && v.period === expected.period && v.voucher_date === expected.date && v.summary === expected.summary && v.kind === 'normal'
      && link.enterprise_key === input.scope.enterpriseKey && link.account_set_id === snapshot.scope.accountSetId
      && snapshot.sources.sourceBindings.some(s => s.source_system === VAT_SOURCE_SYSTEM && s.enterprise_key === input.scope.enterpriseKey)
      && batch?.status === 'completed' && batch.enterprise_key === input.scope.enterpriseKey && batch.account_set_id === snapshot.scope.accountSetId && batch.source_system === VAT_SOURCE_SYSTEM
      && check?.status === 'matches_persisted_content' && check.batchAssociation === 'registered' && link.content_fingerprint === storage.voucherFingerprint(expected)
      && v.entries.length === entries.length && v.entries.every((e, i) => e.line_no === i + 1 && e.code === entries[i].code && e.summary === entries[i].summary && BigInt(e.debitMinor ?? -1) === contracts.offlineMoneyToCents(c.entries[i].debit) && BigInt(e.creditMinor ?? -1) === contracts.offlineMoneyToCents(c.entries[i].credit));
    if (!match) { issue('posted_candidate_content_or_source_mismatch', c.businessKey); continue; }
    used.add(v.id);
    reconciled.push({ businessKey: c.businessKey, date: c.date, kind: c.kind, voucherId: v.id, candidateVersion: c.contentVersion, sourceStatus: check.status, entries: v.entries.map(e => ({ accountCode: e.code, debitMinor: String(e.debitMinor), creditMinor: String(e.creditMinor) })) });
  }
  for (const v of snapshot.vouchers.filter(v => v.range === 'requested')) {
    if (v.kind !== 'normal') issue('ledger_voucher_kind_unsupported', `voucher:${v.id}`, 'unsupported');
    if (v.status === 'posted' && !used.has(v.id)) issue('unexplained_posted_business', `voucher:${v.id}`, 'unsupported');
  }
  for (const f of facts.period.exclusions) if (f.state !== 'none' || f.confirmedBy.role !== 'accountant') issue(f.state === 'unknown' ? 'tax_exclusion_unknown' : 'tax_exclusion_not_admitted', f.area, f.state === 'unknown' ? 'unknown' : 'unsupported');
  for (const area of VAT_EXCLUSIONS) if (!facts.period.exclusions.some(f => f.area === area)) issue('tax_exclusion_missing', area, 'missing');
  if (facts.enterprise.form !== 'enterprise') issue('tax_enterprise_form_' + (facts.enterprise.form === 'unknown' ? 'unknown' : 'unsupported'), 'taxFacts.enterprise.form', facts.enterprise.form === 'unknown' ? 'unknown' : 'unsupported');
  if (facts.enterprise.establishedOn === null) issue('tax_establishment_unknown', 'taxFacts.enterprise.establishedOn', 'unknown');
  // 物理同来源绑定不能解决企业事实互相矛盾的问题。
  // unknown 仍为 unknown，只有两个明确不同的值才构成 conflict。
  if (facts.enterprise.form !== 'unknown' && priorEnterprise.form !== 'unknown' && facts.enterprise.form !== priorEnterprise.form) issue('cross_quarter_enterprise_form_conflict', 'taxFacts.enterprise.form', 'conflict');
  if (facts.enterprise.establishedOn !== null && priorEnterprise.establishedOn !== null && facts.enterprise.establishedOn !== priorEnterprise.establishedOn) issue('cross_quarter_establishment_date_conflict', 'taxFacts.enterprise.establishedOn', 'conflict');
  for (const f of facts.invoices) {
    if ([f.invoiceClass, f.domesticConsumption, f.serviceCategory].includes('unknown')) issue('invoice_tax_business_unknown', f.invoiceRef.number, 'unknown');
    else if (f.invoiceClass !== 'ordinary' || f.domesticConsumption !== 'domestic' || f.serviceCategory !== 'ordinary_main_service') issue('invoice_tax_business_unsupported', f.invoiceRef.number, 'unsupported');
  }
  for (const r of replay.assessment.records.filter(r => r.kind === 'invoice' && r.data.role === 'sales')) if (facts.invoices.filter(f => readiness.sameRef(f.invoiceRef, r.data)).length !== 1) issue('invoice_tax_facts_missing_or_ambiguous', r.docId, 'missing');
  return { scope: structuredClone(input.scope), materialStatus: 'diagnostic_only', priorEvidenceProvided: priorAdmitted, actualQ1Recomputed: priorAdmitted, historyReadinessIntegration: 'not_implemented', engineeringIssues: [{ code: 'historical_readiness_integration_not_implemented', classification: 'engineering_integration_pending', audience: 'operator_engineering', customerActionRequired: false }], legacyHistoryIssues, issues, rows: replay.assessment.rows.map(r => ({ id: r.id, status: r.status, reason: r.reason ?? null, ...(['opening', 'history'].includes(r.id) ? { legacyHistoryGate: true, customerActionRequired: false } : {}) })), ledger: { snapshotDigest: snapshot.contentDigest, counts: snapshot.counts, missingPeriods: snapshot.completeness.missingPeriods, moneyIssues: snapshot.completeness.moneyIssues, requestedVoucherIds: snapshot.vouchers.filter(v => v.range === 'requested').map(v => v.id) }, reconciled, history: { opening: input.declaration.opening, history: input.declaration.history, priorVoucherIds: snapshot.vouchers.filter(v => v.range === 'prior_history').map(v => v.id) }, calculationImplemented: false, q2CalculationReady: false, authorizesExecution: false };
}
async function recompute() {
  const codeBinding = assertOfflineVatPairCodeCurrent(expected);
  const before = await loader.assertVatInputPairCurrent(session);
  const priorComputation = calculateOfflineVat(session.prior.rawInput, session.source, session.snapshots.prior);
  const priorAdmitted = priorComputation.calculationReady === true && /^2026-01-(?:0[1-9]|[12]\d|3[01])$/.test(priorComputation.taxFactsEvidence.enterprise.establishedOn);
  const targetDiagnostics = diagnoseTarget(priorAdmitted, priorComputation.taxFactsEvidence.enterprise);
  const after = await loader.assertVatInputPairCurrent(session);
  requireValue(same(before, after), 'pair_context_stale');
  assertOfflineVatPairCodeCurrent(expected);
  const binding = { relationship: before.proof.relationship, proofDigest: before.proof.proofDigest, databaseInstanceId: session.snapshots.prior.instance.instanceId, enterpriseKey: session.snapshots.prior.scope.enterpriseKey, accountSetId: session.snapshots.prior.scope.accountSetId, prior: { scope: session.prior.rawInput.scope, ledgerDigest: before.proof.priorDigest, inputDigest: hash(stable(session.prior.rawInput)) }, target: { scope: session.target.rawInput.scope, ledgerDigest: before.proof.targetDigest, inputDigest: hash(stable(session.target.rawInput)) } };
  binding.bindingDigest = hash(stable(binding));
  return { priorComputation, targetDiagnostics, binding, inputFiles: before.inputFiles, codeBinding };
}
async function handle(message) {
  fields(message, ['version', 'type', 'sequence', 'command'], ['request']);
  requireValue(message.version === 'offline-vat-pair-ipc/1' && message.type === 'command' && Number.isSafeInteger(message.sequence) && message.sequence >= 0 && ['open', 'current', 'close'].includes(message.command));
  if (message.command === 'close') { closeSession(); await send({ type: 'closed', sequence: message.sequence }); shutdown(); return; }
  let reply;
  try {
    requireValue(!closed);
    assertOfflineVatPairCodeCurrent(expected);
    if (message.command === 'open') { requireValue(!session); session = await loader.openVatInputPairFiles(message.request); }
    else requireValue(session && digest && !('request' in message));
    const result = await recompute(), prior = result.priorComputation;
    if (!prior.calculationReady) reply = { status: prior.status === 'unsupported' ? 'unsupported' : 'blocked', code: prior.status === 'unsupported' ? 'pair_calculation_unsupported' : 'pair_calculation_blocked', result };
    else if (!/^2026-01-(?:0[1-9]|[12]\d|3[01])$/.test(prior.taxFactsEvidence.enterprise.establishedOn)) reply = { status: 'unsupported', code: 'pair_january_establishment_required', result };
    else if (digest && digest !== hash(stable(result))) reply = { status: 'stale', code: 'pair_context_stale' };
    else { digest ??= hash(stable(result)); reply = { status: 'pair_bound_prior_q1_recomputed', code: null, result }; }
    if (reply.status !== 'pair_bound_prior_q1_recomputed') closeSession();
  } catch (e) {
    closeSession();
    const codes = ['pair_scope_mismatch', 'pair_instance_mismatch', 'pair_profile_mismatch', 'pair_quarter_mismatch', 'pair_account_set_invalid', 'pair_tax_facts_invalid', 'pair_code_restart_required'];
    const code = e?.code === 'pair_code_restart_required' ? e.code : message.command !== 'open' ? 'pair_context_stale' : codes.includes(e?.code) ? e.code : e?.code === 'ledger_target_file_mismatch' ? 'pair_target_mismatch' : ['material_store_not_current', 'material_store_changed'].includes(e?.code) ? 'pair_material_store_not_current' : /^tax_/.test(e?.code) ? 'pair_tax_facts_invalid' : /^ledger_/.test(e?.code) ? 'pair_ledger_invalid' : 'pair_input_rejected';
    reply = { status: code === 'pair_code_restart_required' ? 'restart_required' : message.command === 'open' ? 'blocked' : 'stale', code };
  }
  await send({ type: 'result', sequence: message.sequence, reply });
}
if (process.send && process.connected) {
  process.on('message', message => { queue = queue.then(() => handle(message)).catch(shutdown); });
  send({ type: 'ready', codeBinding: assertOfflineVatPairCodeCurrent(expected) }).catch(shutdown);
}
