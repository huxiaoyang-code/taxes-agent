// Read-only VAT workpaper. Capability arguments cannot be replaced by JSON/digests.
import { fields, requirePlainJson, requireValue, validateScope, stable, hash } from './offline-material-adapters.mjs';
import { buildOfflineCandidates } from './offline-bookkeeping.mjs';
import { assessAccountingReadiness, sameRef } from './offline-accounting-readiness.mjs';
import { validateLedgerSnapshot } from './offline-ledger-snapshot.mjs';
import { voucherFingerprint } from './import-storage.mjs';
import { offlineMoneyToCents } from './offline-contracts.mjs';
import { VAT_RULE_VERSION, getVatRules } from './tax-rule-registry.mjs';

export const VAT_VERSION = 'offline-vat-workpaper/1';
// Reserved bridge contract. This module never performs this import; tests use the core importer.
export const VAT_SOURCE_SYSTEM = 'offline-bookkeeping-candidates-v1';
export const VAT_EXCLUSIONS = Object.freeze(['otherSales', 'realEstateSalesAndLeasing', 'landUseRights', 'constructionPrepayments', 'differentialTaxation', 'crossBorder', 'deemedSales', 'exemptions', 'otherReliefsAndCredits', 'waivedReduction', 'prepayments', 'priorAdjustments', 'nonMonetaryOrAbnormalPricing', 'mixedTransactions', 'withholdingOrImports']);
const same = (a, b) => stable(a) === stable(b);
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const money = n => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
const text = s => requireValue(typeof s === 'string' && s === s.trim() && s.length > 0 && s.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(s), 'tax_fact_invalid');
const scopeFor = s => { const range = validateScope(s); requireValue(/^[1-9]\d*$/.test(s.accountSetId) && Number.isSafeInteger(Number(s.accountSetId)), 'tax_account_set_id_invalid'); return { enterpriseKey: s.enterpriseKey, accountSetId: Number(s.accountSetId), fromPeriod: range.from, toPeriod: range.to }; };
const digestProduct = p => { const { contentDigest, comparison, ...content } = p; return hash(stable(content)); };
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

export function calculateOfflineVat(input, source, snapshot) {
  // Authenticate before examining caller-provided data. Never accept arbitrary DBs/JSON snapshots.
  const initial = validateLedgerSnapshot(source, snapshot);
  requirePlainJson(input); fields(input, ['scope', 'reports', 'declaration', 'profileId', 'accountingFacts', 'taxFacts'], ['previousComputation']);
  const ledgerScope = scopeFor(input.scope);
  const ledgerComparable = (({ requestedPeriods, ...s }) => s)(snapshot.scope);
  requireValue(same(ledgerComparable, ledgerScope), 'tax_ledger_scope_mismatch');
  const raw = { scope: input.scope, reports: input.reports, declaration: input.declaration, profileId: input.profileId, accountingFacts: input.accountingFacts };
  const rebuilt = buildOfflineCandidates(raw), replay = assessAccountingReadiness(raw), facts = parseTaxFacts(input.taxFacts, input, replay), rules = getVatRules();
  const issues = [], problem = (code, field, status = 'blocked', classification = status === 'unsupported' ? 'unsupported' : /conflict|mismatch|invalid/.test(code) ? 'conflict' : /unknown/.test(code) ? 'unknown' : 'missing') => issues.push({ code, field, status, classification,
    requestedFact: status === 'unsupported' ? null : code.startsWith('missing_exclusion_') ? '提供该类业务是否发生的完整本期登记、会计确认人及依据；未知不能当无业务' : field === 'declaration.tax' ? '提供实际增值税身份、申报周期及会计核对的税种资格登记依据，不填计算税额' : field.includes('establishedOn') ? '提供企业实际设立日期、登记依据及会计确认' : code === 'missing_invoice_tax_business_facts' ? '逐票补充普通或专用类别、境内消费及实际服务种类、确认人及原始依据' : code.includes('ledger') || code.includes('posted') || code.includes('source') ? '核对实际账套、已过账凭证、原始来源关联及完整期间；更正后重新读取，不提供客户预制分录或最终税额' : '补充对应原始业务、整期覆盖或不适用的实际确认人和依据，核对矛盾有效版本' });
  if (initial.status !== 'current') problem('ledger_snapshot_stale', 'ledger');
  if (input.scope.period !== rules.engineeringScope.period) problem('engineering_period_unsupported', 'scope.period', 'unsupported');
  const d = replay.assessment.declaration;
  if (!d.tax) problem('missing_tax_attributes', 'declaration.tax');
  else {
    if (d.tax.vatStatus === 'unknown') problem('unknown_vat_status', 'declaration.tax', 'blocked', 'unknown');
    else if (d.tax.vatStatus !== 'small_scale') problem('vat_status_unsupported', 'declaration.tax', 'unsupported');
    if (d.tax.filingFrequency === 'unknown') problem('unknown_filing_frequency', 'declaration.tax', 'blocked', 'unknown');
    else if (d.tax.filingFrequency !== 'quarterly') problem('filing_frequency_unsupported', 'declaration.tax', 'unsupported');
  }
  const accountantEvidence = v => (v?.evidenceIds ?? []).some(id => d.evidence?.some(e => e.evidenceId === id && e.kind !== 'attachment_reference' && e.confirmedBy.role === 'accountant' && e.basis));
  if (!accountantEvidence(d.tax)) problem('accountant_tax_registration_evidence_required', 'declaration.tax');
  for (const area of ['opening', 'history']) {
    if (!d[area] || d[area].state === 'unknown' || !accountantEvidence(d[area])) problem('new_enterprise_first_period_evidence_required', `declaration.${area}`, 'blocked', d[area]?.state === 'unknown' ? 'unknown' : 'missing');
    else if (d[area].state !== (area === 'opening' ? 'new_zero' : 'first_period')) problem(`historical_${area}_unsupported`, `declaration.${area}`, 'unsupported');
  }
  for (const row of replay.assessment.rows) {
    const resolved = row.id.startsWith('business:') && rebuilt.decisions.some(x => x.subjectKey === row.id.slice(9) && x.status === 'candidate') || row.id.startsWith('bank:') && rebuilt.decisions.some(x => x.subjectKey === row.id.slice(5) && x.status === 'candidate');
    if (!['provided_valid', 'not_applicable'].includes(row.status) && !resolved) problem(`materials_${row.status}`, row.id, row.status === 'unsupported' ? 'unsupported' : 'blocked', row.status === 'provided_invalid' ? 'conflict' : row.status);
  }
  for (const dec of rebuilt.decisions) if (dec.status !== 'candidate') {
    const onlyUnsupportedVatStatus = d.tax?.vatStatus === 'general' && dec.requirements.every(r => r.code === 'small_scale_required');
    problem('accounting_business_not_admitted', dec.businessKey ?? dec.subjectKey, onlyUnsupportedVatStatus ? 'unsupported' : 'blocked', onlyUnsupportedVatStatus ? 'unsupported' : dec.status === 'conflict' ? 'conflict' : 'missing');
  }
  if (facts.enterprise.form === 'unknown') problem('missing_enterprise_form', 'taxFacts.enterprise.form', 'blocked', 'unknown');
  else if (facts.enterprise.form !== 'enterprise') problem('enterprise_form_unsupported', 'taxFacts.enterprise.form', 'unsupported');
  if (facts.enterprise.establishedOn === null) problem('missing_establishment_date', 'taxFacts.enterprise.establishedOn', 'blocked', 'unknown');
  else if (facts.enterprise.establishedOn < '2026-01-01' || facts.enterprise.establishedOn > '2026-03-31') problem('new_enterprise_date_unsupported', 'taxFacts.enterprise.establishedOn', 'unsupported');
  if (facts.enterprise.confirmedBy.role !== 'accountant') problem('accountant_enterprise_evidence_required', 'taxFacts.enterprise');
  if (facts.period.confirmedBy.role !== 'accountant') problem('accountant_period_inventory_required', 'taxFacts.period');
  for (const area of VAT_EXCLUSIONS) {
    const f = facts.period.exclusions.find(f => f.area === area);
    if (!f || f.state === 'unknown' || f.confirmedBy.role !== 'accountant') problem(`missing_exclusion_${area}`, `taxFacts.period.${area}`, 'blocked', f?.state === 'unknown' ? 'unknown' : 'missing');
    else if (f.state !== 'none') problem(`unsupported_${area}`, `taxFacts.period.${area}`, 'unsupported');
  }
  if (snapshot.accountSet.start_period !== '2026-01' || snapshot.profile.status !== 'registered' || snapshot.profile.definition.id !== input.profileId) problem('ledger_initial_profile_unsupported', 'ledger.accountSet', 'unsupported');
  if (snapshot.accountSet.accounting_standard !== snapshot.profile.definition?.declaredStandard) problem('ledger_profile_standard_mismatch', 'ledger.accountSet.accounting_standard');
  if (snapshot.openingBalances.some(e => e.debitMinor !== 0 || e.creditMinor !== 0) || snapshot.counts.priorVouchers) problem('opening_or_prior_history_unsupported', 'ledger.openingBalances', 'unsupported');
  if (snapshot.completeness.missingPeriods.length) problem('ledger_months_missing', 'ledger.periods');
  if (snapshot.completeness.moneyIssues.length || snapshot.completeness.unknownStatuses.length) problem('ledger_data_invalid', 'ledger.completeness');
  if (snapshot.counts.draft) problem('draft_not_posted', 'ledger.vouchers');
  if (snapshot.sources.schemaStatus !== 'present') problem('ledger_source_schema_missing', 'ledger.sources');
  const reconciled = [], used = new Set(), sales = [];
  for (const c of rebuilt.candidates) {
    if (c.date < facts.enterprise.establishedOn) problem('business_before_establishment', c.businessKey);
    const links = snapshot.sources.voucherSources.filter(s => s.source_system === VAT_SOURCE_SYSTEM && s.source_voucher_id === c.businessKey);
    if (links.length !== 1) { problem('candidate_posted_source_missing_or_ambiguous', c.businessKey); continue; }
    const link = links[0], v = snapshot.vouchers.find(v => v.id === link.voucher_id), check = snapshot.sources.checks.find(x => x.sourceId === link.id);
    const batch = snapshot.sources.batches.find(b => b.batch_id === link.batch_id);
    if (batch?.status !== 'completed' || batch.enterprise_key !== input.scope.enterpriseKey || batch.account_set_id !== ledgerScope.accountSetId || batch.source_system !== VAT_SOURCE_SYSTEM) { problem('source_import_batch_not_completed', c.businessKey); continue; }
    const expectedEntries = c.entries.map(e => ({ code: e.accountCode, debit: e.debit, credit: e.credit, summary: e.detail ?? c.kind }));
    const expected = { period: c.date.slice(0, 7), date: c.date, summary: `offline:${c.businessKey}`, entries: expectedEntries };
    const sourceBound = snapshot.binding.enterprise_key === input.scope.enterpriseKey && snapshot.binding.account_set_id === ledgerScope.accountSetId && snapshot.sources.sourceBindings.some(s => s.source_system === VAT_SOURCE_SYSTEM && s.enterprise_key === input.scope.enterpriseKey);
    const match = v && !used.has(v.id) && v.status === 'posted' && v.range === 'requested' && v.account_set_id === ledgerScope.accountSetId && v.period === expected.period && v.voucher_date === expected.date && v.summary === expected.summary && v.kind === 'normal'
      && link.enterprise_key === input.scope.enterpriseKey && link.account_set_id === ledgerScope.accountSetId && sourceBound
      && check?.status === 'matches_persisted_content' && check.batchAssociation === 'registered' && link.content_fingerprint === voucherFingerprint(expected)
      && v.entries.length === c.entries.length && v.entries.every((e, i) => e.line_no === i + 1 && e.code === expectedEntries[i].code && e.summary === expectedEntries[i].summary && BigInt(e.debitMinor ?? -1) === offlineMoneyToCents(c.entries[i].debit) && BigInt(e.creditMinor ?? -1) === offlineMoneyToCents(c.entries[i].credit));
    if (!match) { problem('posted_candidate_content_or_source_mismatch', c.businessKey); continue; }
    used.add(v.id);
    const trace = { businessKey: c.businessKey, candidateVersion: c.contentVersion, kind: c.kind, date: c.date, scope: structuredClone(c.scope), voucherId: v.id, entries: v.entries.map((e, i) => ({ entryId: e.id, lineNo: e.line_no, accountCode: e.code, debitMinor: String(e.debitMinor), creditMinor: String(e.creditMinor), candidateSources: c.entries[i] })), sourceAssociation: structuredClone(link), sourceCheck: structuredClone(check), sourceBatch: structuredClone(batch), materials: structuredClone(c.evidence), recognition: structuredClone(c.recognition) };
    reconciled.push(trace);
    if (c.kind === 'service_sale') {
      const inv = replay.assessment.records.find(r => r.kind === 'invoice' && c.evidence.materials.some(e => e.docId === r.docId));
      requireValue(inv, 'tax_internal_invoice_missing');
      const fs = facts.invoices.filter(f => sameRef(f.invoiceRef, inv.data));
      if (fs.length !== 1) { problem('invoice_tax_facts_missing_or_ambiguous', c.businessKey, 'blocked', fs.length === 0 ? 'missing' : 'conflict'); continue; }
      const f = fs[0];
      if ([f.invoiceClass, f.domesticConsumption, f.serviceCategory].includes('unknown')) problem('missing_invoice_tax_business_facts', c.businessKey, 'blocked', 'unknown');
      else if (f.invoiceClass !== 'ordinary' || f.domesticConsumption !== 'domestic' || f.serviceCategory !== 'ordinary_main_service') problem('invoice_type_or_tax_business_unsupported', c.businessKey, 'unsupported');
      const net = offlineMoneyToCents(inv.data.net), tax = offlineMoneyToCents(inv.data.tax);
      if (net <= 0n || tax <= 0n) problem('zero_or_exemption_path_unsupported', c.businessKey, 'unsupported');
      if (net % 100n !== 0n) problem('fractional_net_requires_rounding_policy', c.businessKey, 'unsupported');
      if (net % 100n === 0n && tax !== net / 100n) problem('invoice_one_percent_or_book_tax_adjustment_required', c.businessKey, 'unsupported');
      sales.push({ ...trace, invoice: structuredClone(inv), taxFact: structuredClone(f), taxFactSource: { fileSha256: input.taxFacts.fileSha256, pointer: `/invoices/${facts.invoices.indexOf(f)}` }, revenueNetMinor: String(net), initialLedgerVatMinor: String(v.entries[2].creditMinor), taxableBaseMinor: String(net), adjustmentMinor: '0', noAdjustmentBasis: 'whole_yuan_net_exact_original_invoice_one_percent_and_identical_posted_initial_vat', ruleVersion: VAT_RULE_VERSION });
    }
  }
  for (const v of snapshot.vouchers) if (v.status === 'posted' && !used.has(v.id)) problem('unexplained_posted_business_or_carryforward', `voucher:${v.id}`, 'unsupported');
  for (const link of snapshot.sources.voucherSources) if (link.source_system !== VAT_SOURCE_SYSTEM || !rebuilt.candidates.some(c => c.businessKey === link.source_voucher_id)) problem('unexplained_source_association', `source:${link.id}`);
  for (const f of facts.invoices) if (!replay.assessment.records.some(r => r.kind === 'invoice' && r.data.role === 'sales' && sameRef(f.invoiceRef, r.data))) problem('unmatched_invoice_tax_fact', `invoice:${f.invoiceRef.number}`);
  const sum = sales.reduce((n, s) => n + BigInt(s.taxableBaseMinor), 0n), initialVat = sales.reduce((n, s) => n + BigInt(s.initialLedgerVatMinor), 0n);
  if (!sales.length) problem('zero_or_no_sales_path_unsupported', 'sales', 'unsupported');
  if (sum < 30000000n) problem('below_threshold_exemption_path_unsupported', 'sales', 'unsupported');
  if (validateLedgerSnapshot(source, snapshot).status !== 'current') problem('ledger_snapshot_stale', 'ledger');
  const ready = issues.length === 0;
  if (!ready) for (const s of sales) { s.taxableBaseMinor = null; s.adjustmentMinor = null; s.noAdjustmentBasis = null; }
  const nodes = ready ? [
    { id: 'taxable_base', formula: 'sum(reconciled_invoice_net)', minor: String(sum), dependencies: sales.map(s => s.businessKey), ruleSources: ['law', 'relief'] },
    { id: 'initial_book_vat', formula: 'sum(reconciled_posted_initial_vat)', minor: String(initialVat), dependencies: sales.map(s => s.businessKey), ruleSources: ['law'] },
    { id: 'no_adjustment', formula: 'each_original_tax=net/100=actual_posted_vat', minor: '0', dependencies: ['taxable_base', 'initial_book_vat'], ruleSources: ['relief'], evidence: sales.map(s => ({ businessKey: s.businessKey, basis: s.noAdjustmentBasis })) },
    { id: 'standard_vat', formula: 'taxable_base*3/100', minor: String(sum * 3n / 100n), dependencies: ['taxable_base'], ruleSources: ['law', 'instructions'] },
    { id: 'relief', formula: 'taxable_base*2/100', minor: String(sum * 2n / 100n), dependencies: ['taxable_base'], ruleSources: ['relief', 'instructions'] },
    { id: 'payable', formula: 'standard_vat-relief', minor: String(sum / 100n), dependencies: ['standard_vat', 'relief', 'no_adjustment'], ruleSources: ['blankForm'] },
    { id: 'prepaid', formula: 'evidenced_no_prepayments', minor: '0', dependencies: [], ruleSources: ['instructions'], evidence: facts.period.exclusions.find(f => f.area === 'prepayments') },
    { id: 'due', formula: 'payable-prepaid', minor: String(sum / 100n), dependencies: ['payable', 'prepaid'], ruleSources: ['blankForm'] },
  ] : [];
  const rowNode = { 1: 'taxable_base', 2: 'ordinary_only', 3: 'taxable_base', 15: 'standard_vat', 16: 'relief', 20: 'payable', 21: 'prepaid', 22: 'due' };
  if (ready) nodes.push({ id: 'ordinary_only', formula: 'all_sales_individually_confirmed_ordinary', minor: '0', dependencies: sales.map(s => s.businessKey), ruleSources: ['instructions'], evidence: sales.map(s => s.taxFactSource) });
  const cells = [];
  for (let row = 1; row <= 25; row++) for (const column of ['goods', 'services']) for (const period of ['current', 'yearToDate']) {
    const selected = column === 'services' && row in rowNode;
    const na = period === 'yearToDate' && [21, 22].includes(row);
    const node = selected && ready ? nodes.find(n => n.id === rowNode[row]) : null;
    cells.push({ row, column, period, status: na ? 'not_applicable' : node ? 'computed' : selected ? 'blocked' : 'not_computed', value: !na && node ? money(BigInt(node.minor)) : null, minor: !na && node ? node.minor : null, calculationNode: !na && node ? node.id : null, basis: na ? 'official_blank_form_year_to_date_dash' : node && period === 'yearToDate' ? 'accountant_evidenced_first_period_full_Q1_same_as_current' : null, ruleReferences: selected ? structuredClone(rules.selectedRows[row]) : na ? structuredClone(rules.sources.blankForm) : null });
  }
  const inputHash = hash(stable({ scope: input.scope, profileId: input.profileId, materials: replay.assessment.sources, replayIssues: replay.replayIssues, declaration: input.declaration, accountingFacts: input.accountingFacts, taxFacts: input.taxFacts }));
  const product = { version: VAT_VERSION, scope: structuredClone(input.scope), status: ready ? 'selected_fields_calculated' : issues.some(i => i.status === 'blocked') ? 'blocked' : 'unsupported', inputHash, ruleVersion: VAT_RULE_VERSION, ruleDigest: hash(stable(rules)), ledgerSnapshotDigest: snapshot.contentDigest, rules, issues, selectedFields: Object.keys(rowNode).map(Number), cells, calculationNodes: nodes, reconciledBusinesses: reconciled, sales,
    taxFactsEvidence: { fileSha256: input.taxFacts.fileSha256, enterprise: facts.enterprise, period: facts.period }, declarationDigest: replay.assessment.declarationProvenance.rawDigest,
    calculationReady: ready, reviewReady: ready, readinessScope: 'selected_services_fields_only', periodComplete: false, accountantApproval: 'pending', submittable: false, onlineCompatibility: 'unverified', authorizesExecution: false, sourceAuthenticity: 'unverified', evidenceLevel: 'provided_materials_and_local_accountant_statements_only', freshness: 'given_input_bytes_and_in_process_ledger_at_call_only',
    limitations: ['not_full_return_or_period_completion', 'no_online_upload_compatibility_claim', 'no_exemption_or_rounding_or_other_taxes', 'no_posting_or_coordinator_bypass', 'accountant_review_and_82_confirmation_chain_pending', 'public_hashes_are_not_authentication_or_reusable_approval'] };
  product.contentDigest = digestProduct(product);
  product.comparison = { status: 'new', oldApprovalReusable: false, meaning: 'local_summary_only_not_authentication' };
  if (input.previousComputation !== undefined) {
    const previous = input.previousComputation; fields(previous, ['version', 'scope', 'contentDigest', 'inputHash', 'ruleVersion', 'ruleDigest', 'ledgerSnapshotDigest']);
    requireValue(previous.version === VAT_VERSION && same(previous.scope, input.scope) && ['contentDigest', 'inputHash', 'ruleDigest', 'ledgerSnapshotDigest'].every(k => typeof previous[k] === 'string' && /^[a-f0-9]{64}$/.test(previous[k])) && typeof previous.ruleVersion === 'string', 'previous_computation_invalid');
    const changed = ['inputHash', 'ruleVersion', 'ruleDigest', 'ledgerSnapshotDigest'].filter(k => previous[k] !== product[k]);
    product.comparison = { status: previous.contentDigest === product.contentDigest && !changed.length ? 'unchanged' : 'stale_previous_new_version', oldApprovalReusable: false, meaning: 'local_summary_only_not_authentication', previousDigest: previous.contentDigest, changed };
  }
  return freeze(product);
}
export function vatComparisonSummary(p) { return Object.fromEntries(['version', 'scope', 'contentDigest', 'inputHash', 'ruleVersion', 'ruleDigest', 'ledgerSnapshotDigest'].map(k => [k, structuredClone(p[k])])); }
