// Read-only VAT workpaper. Capability arguments cannot be replaced by JSON/digests.
import { fields, requirePlainJson, requireValue, validateScope, stable, hash } from './offline-material-adapters.mjs';
import { buildOfflineCandidates } from './offline-bookkeeping.mjs';
import { assessAccountingReadiness, sameRef } from './offline-accounting-readiness.mjs';
import { validateLedgerSnapshot, validateLedgerSnapshotPair, parseImportBatchResult } from './offline-ledger-snapshot.mjs';
import { assertVatInputPayload, assertVatInputPairCurrent, assertVatInputSessionCurrent } from './offline-vat-input.mjs';
import { voucherFingerprint, persistedVoucherFingerprint } from './import-storage.mjs';
import { offlineMoneyToCents } from './offline-contracts.mjs';
import { VAT_RULE_VERSION, getVatRules, VAT_Q2_RULE_VERSION, getVatQ2Rules } from './tax-rule-registry.mjs';

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
  return calculatePeriod(input, source, snapshot);
}
function calculatePeriod(input, source, snapshot, bridge) {
  // Authenticate before examining caller-provided data. Never accept arbitrary DBs/JSON snapshots.
  const initial = validateLedgerSnapshot(source, snapshot);
  requirePlainJson(input); fields(input, ['scope', 'reports', 'declaration', 'profileId', 'accountingFacts', 'taxFacts'], ['previousComputation']);
  const ledgerScope = scopeFor(input.scope);
  const ledgerComparable = (({ requestedPeriods, ...s }) => s)(snapshot.scope);
  requireValue(same(ledgerComparable, ledgerScope), 'tax_ledger_scope_mismatch');
  const raw = { scope: input.scope, reports: input.reports, declaration: input.declaration, profileId: input.profileId, accountingFacts: input.accountingFacts };
  const rebuilt = buildOfflineCandidates(raw), replay = assessAccountingReadiness(raw), facts = parseTaxFacts(input.taxFacts, input, replay), rules = bridge ? getVatQ2Rules() : getVatRules();
  const ruleVersion = bridge ? VAT_Q2_RULE_VERSION : VAT_RULE_VERSION;
  const issues = [], problem = (code, field, status = 'blocked', classification = status === 'unsupported' ? 'unsupported' : /conflict|mismatch|invalid/.test(code) ? 'conflict' : /unknown/.test(code) ? 'unknown' : 'missing', detail = {}) => issues.push({ code, field, status, classification,
    requestedFact: status === 'unsupported' ? null : code.startsWith('missing_exclusion_') ? '提供该类业务是否发生的完整本期登记、会计确认人及依据；未知不能当无业务' : field === 'declaration.tax' ? '提供实际增值税身份、申报周期及会计核对的税种资格登记依据，不填计算税额' : field.includes('establishedOn') ? '提供企业实际设立日期、登记依据及会计确认' : code === 'missing_invoice_tax_business_facts' ? '逐票补充普通或专用类别、境内消费及实际服务种类、确认人及原始依据' : code.includes('ledger') || code.includes('posted') || code.includes('source') ? '核对实际账套、已过账凭证、原始来源关联及完整期间；更正后重新读取，不提供客户预制分录或最终税额' : '补充对应原始业务、整期覆盖或不适用的实际确认人和依据，核对矛盾有效版本', ...detail });
  for (const i of bridge?.issues ?? []) { problem(i.code, i.field, i.status, i.classification); Object.assign(issues.at(-1), structuredClone(i)); }
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
    else if (d[area].state !== (bridge ? area === 'opening' ? 'balances_required' : 'prior_required' : area === 'opening' ? 'new_zero' : 'first_period')) problem(`historical_${area}_unsupported`, `declaration.${area}`, 'unsupported');
  }
  for (const row of replay.assessment.rows) {
    const resolved = row.id.startsWith('business:') && rebuilt.decisions.some(x => x.subjectKey === row.id.slice(9) && x.status === 'candidate') || row.id.startsWith('bank:') && rebuilt.decisions.some(x => x.subjectKey === row.id.slice(5) && x.status === 'candidate') || bridge?.admitted && ['opening', 'history'].includes(row.id) && row.status === 'missing' && row.reason === (row.id === 'opening' ? 'opening_balances_or_supported_new_zero_required' : 'prior_period_history_or_supported_first_period_required');
    if (!['provided_valid', 'not_applicable'].includes(row.status) && !resolved) {
      problem(`materials_${row.status}`, row.id, row.status === 'unsupported' ? 'unsupported' : 'blocked', row.status === 'provided_invalid' ? 'conflict' : row.status);
      if (bridge && ['opening', 'history'].includes(row.id) && row.status === 'missing') Object.assign(issues.at(-1), { audience: 'operator_engineering', customerActionRequired: false, requestedFact: '先处理已列明的真实历史桥或上游具体问题；已提供的Q1原件不重复索取，不要求客户算前期数或分录' });
    }
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
  if (snapshot.openingBalances.some(e => e.debitMinor !== 0 || e.creditMinor !== 0) || !bridge && snapshot.counts.priorVouchers) problem('opening_or_prior_history_unsupported', 'ledger.openingBalances', 'unsupported');
  if (snapshot.completeness.missingPeriods.length) problem('ledger_months_missing', 'ledger.periods');
  if (snapshot.completeness.moneyIssues.length || snapshot.completeness.unknownStatuses.length) problem('ledger_data_invalid', 'ledger.completeness');
  if (snapshot.counts.draft) problem('draft_not_posted', 'ledger.vouchers');
  if (snapshot.sources.schemaStatus !== 'present') problem('ledger_source_schema_missing', 'ledger.sources');
  const reconciled = [], used = new Set(bridge?.priorExplained ? bridge.priorVoucherIds : []), sales = [];
  if (bridge) for (const v of snapshot.vouchers) {
    if (v.status === 'draft') problem('draft_not_posted', `voucher:${v.id}`);
    if (v.kind !== 'normal') problem('ledger_voucher_kind_unsupported', `voucher:${v.id}`, 'unsupported');
  }
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
      sales.push({ ...trace, invoice: structuredClone(inv), taxFact: structuredClone(f), taxFactSource: { fileSha256: input.taxFacts.fileSha256, pointer: `/invoices/${facts.invoices.indexOf(f)}` }, revenueNetMinor: String(net), initialLedgerVatMinor: String(v.entries[2].creditMinor), taxableBaseMinor: String(net), adjustmentMinor: '0', noAdjustmentBasis: 'whole_yuan_net_exact_original_invoice_one_percent_and_identical_posted_initial_vat', ruleVersion });
    }
  }
  for (const v of snapshot.vouchers) if (v.status === 'posted' && !used.has(v.id)) problem('unexplained_posted_business_or_carryforward', `voucher:${v.id}`, 'unsupported');
  for (const link of snapshot.sources.voucherSources) if (!(bridge?.priorExplained && bridge.priorSourceIds.includes(link.id)) && (link.source_system !== VAT_SOURCE_SYSTEM || !rebuilt.candidates.some(c => c.businessKey === link.source_voucher_id))) problem('unexplained_source_association', `source:${link.id}`);
  if (bridge) checkAllSourceRows(snapshot, used, problem, bridge.batchProof);
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
  if (bridge) {
    for (const cell of cells.filter(c => c.period === 'yearToDate' && c.column === 'services' && ![21, 22].includes(c.row) && c.row in rowNode)) {
      cell.basis = null;
      if (!ready) continue;
      const priorCell = bridge.prior.cells.find(c => c.row === cell.row && c.column === cell.column && c.period === 'current');
      const id = `ytd_${cell.row}`, minor = String(BigInt(priorCell.minor) + BigInt(cell.minor));
      nodes.push({ id, formula: 'actual_recomputed_Q1_current+actual_Q2_current', minor, dependencies: [`Q1:${priorCell.calculationNode}`, cell.calculationNode], ruleSources: ['instructions'], engineeringInference: rules.yearToDate.inference, accountantApproval: 'pending' });
      cell.minor = minor; cell.value = money(BigInt(minor)); cell.calculationNode = id; cell.basis = rules.yearToDate.inference;
    }
    if (ready) for (const node of bridge.prior.calculationNodes) nodes.push({ ...structuredClone(node), id: `Q1:${node.id}`, dependencies: node.dependencies.map(id => `Q1:${id}`), provenance: { scope: bridge.prior.scope, contentDigest: bridge.prior.contentDigest } });
  }
  const product = { version: bridge ? 'offline-vat-q2-workpaper/1' : VAT_VERSION, scope: structuredClone(input.scope), status: ready ? 'selected_fields_calculated' : issues.some(i => i.status === 'blocked') ? 'blocked' : 'unsupported', inputHash, ruleVersion, ruleDigest: hash(stable(rules)), ledgerSnapshotDigest: snapshot.contentDigest, rules, issues, selectedFields: Object.keys(rowNode).map(Number), cells, calculationNodes: nodes, reconciledBusinesses: reconciled, sales,
    taxFactsEvidence: { fileSha256: input.taxFacts.fileSha256, enterprise: facts.enterprise, period: facts.period }, declarationDigest: replay.assessment.declarationProvenance.rawDigest,
    calculationReady: ready, reviewReady: ready, readinessScope: 'selected_services_fields_only', periodComplete: false, accountantApproval: 'pending', submittable: false, onlineCompatibility: 'unverified', authorizesExecution: false, sourceAuthenticity: 'unverified', evidenceLevel: 'provided_materials_and_local_accountant_statements_only', freshness: 'given_input_bytes_and_in_process_ledger_at_call_only',
    limitations: ['not_full_return_or_period_completion', 'no_online_upload_compatibility_claim', 'no_exemption_or_rounding_or_other_taxes', 'no_posting_or_coordinator_bypass', 'accountant_review_and_82_confirmation_chain_pending', 'public_hashes_are_not_authentication_or_reusable_approval'] };
  if (bridge) product.historyBridge = { status: bridge.admitted ? 'same_capture_Q1_history_explained' : 'blocked', priorAccountingExplained: bridge.priorExplained, priorContentDigest: bridge.prior.contentDigest, priorVoucherIds: bridge.priorVoucherIds, priorSourceIds: bridge.priorSourceIds, priorBusinesses: bridge.prior.reconciledBusinesses, proof: bridge.proof, accountantApproval: 'pending', doesNotAssertPriorFilingOrPayment: true };
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

// This extra integrity check is deliberately confined to the new historical bridge.
// Existing v1 output and admission policy remain byte-for-byte compatible.
function checkAllSourceRows(snapshot, used, problem, batchProof) {
  const issue = (code, field) => problem(code, field, 'blocked', 'conflict', { audience: 'operator_engineering', customerActionRequired: false, requestedFact: '操作者核对实际导入批次、创建/去重关联及已过账来源，修复后重新读取；不要求客户重复提供已核对原件或预制税额/分录' });
  for (const link of snapshot.sources.voucherSources) if (!used.has(link.voucher_id)) problem('unexplained_source_association', `source:${link.id}`);
  const explained = new Set();
  for (const row of snapshot.sources.batchVouchers) {
    const links = snapshot.sources.voucherSources.filter(s => ['voucher_id', 'enterprise_key', 'account_set_id', 'source_system', 'source_voucher_id', 'content_fingerprint'].every(k => s[k] === row[k]));
    // The complete target inventory authenticates counts even when this is the
    // Q1 projection of a single batch containing both Q1 and Q2 deduplications.
    const authenticated = batchProof?.headers.has(row.batch_id) && same(batchProof.links.get(row.id), row);
    if (authenticated && used.has(row.voucher_id) && links.length === 1 && (row.action === 'deduplicated' || row.action === 'created' && links[0].batch_id === row.batch_id)) explained.add(row.batch_id);
    else issue('unexplained_import_batch_association', `batchVoucher:${row.id ?? row.voucher_id}`);
  }
  for (const batch of snapshot.sources.batches) if (!explained.has(batch.batch_id) || !same(batchProof?.headers.get(batch.batch_id), batch)) issue('unexplained_import_batch', `batch:${batch.batch_id}`);
  // Current normalized bindings carry enterprise identity; the real account set
  // is authenticated by snapshot.binding, not a nonexistent binding column.
  for (const binding of snapshot.sources.sourceBindings) if (binding.source_system !== VAT_SOURCE_SYSTEM || binding.enterprise_key !== snapshot.scope.enterpriseKey) problem('unexplained_source_binding', `binding:${binding.id}`);
}

function checkTargetBatchInventory(snapshot, problem) {
  const inv = snapshot.sources.targetBatchInventory;
  requireValue(inv?.version === 'q2-target-batch-inventory/1', 'q2_private_batch_inventory_required');
  let faultCount = 0;
  const proof = { headers: new Map(), links: new Map() };
  const issue = (code, field, classification = 'conflict') => { faultCount++; problem(code, field, 'blocked', classification, { audience: 'operator_engineering', customerActionRequired: false, requestedFact: '操作者核对本机真实导入批次、结果与凭证/来源关联，修复后重新读取；不要求客户补算税额、前期数或预制分录' }); };
  const identity = (r, h) => r.account_set_id === snapshot.scope.accountSetId && r.enterprise_key === snapshot.scope.enterpriseKey && r.source_system === h.source_system;
  const moneyValid = n => typeof n === 'number' && Number.isFinite(n) && /^\d+(?:\.\d{1,2})?$/.test(String(n));
  for (const v of inv.vouchers) {
    const date = v.voucher_date, time = typeof date === 'string' ? Date.parse(date + 'T00:00:00Z') : NaN;
    const valid = typeof v.period === 'string' && /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(v.period) && typeof date === 'string' && /^[1-9]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date) && date.slice(0, 7) === v.period && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
    if (!valid) issue('target_batch_voucher_period_date_invalid', `ledger.targetBatchInventory.voucher:${v.id}`, !v.period || !date ? 'unknown' : 'conflict');
  }
  for (const h of inv.headers) {
    const initialFaults = faultCount;
    const field = `ledger.targetBatchInventory.batch:${h.batch_id}`, links = inv.batchVouchers.filter(r => r.batch_id === h.batch_id), sources = inv.voucherSources.filter(r => r.batch_id === h.batch_id);
    if (!identity(h, h) || !['append', 'create'].includes(h.mode) || !/^[a-f0-9]{64}$/.test(h.content_fingerprint) || !Number.isSafeInteger(h.attempts) || h.attempts < 1 || ![h.created_at, h.updated_at].every(s => typeof s === 'string' && Number.isFinite(Date.parse(s)))) issue('target_batch_metadata_conflict', field);
    if (h.source_system !== VAT_SOURCE_SYSTEM) issue('target_batch_source_unsupported', field, 'unsupported');
    if (h.status !== 'completed') issue('target_batch_not_completed', field, h.status === 'failed' ? 'conflict' : 'unknown');
    if (h.status === 'completed' && (h.error_code !== null || h.error_message !== null)) issue('target_batch_completed_error_conflict', field);
    const parsed=parseImportBatchResult(h.result_json,{header:h,headers:inv.headers,links:inv.batchVouchers,sources:inv.voucherSources,vouchers:inv.vouchers,entries:inv.entries}),result=parsed?.value??null;
    if(!parsed?.associationsValid)issue('target_batch_result_missing_or_invalid',field,'unknown');
    if (!links.length && !sources.length) {
      const noop = result && h.mode === 'append' && result.accountSetCreated === false && ['accountsAdded', 'openingBalancesApplied', 'vouchersCreated', 'vouchersDeduplicated'].every(k => result[k] === 0);
      if (result && !noop) issue('unexplained_nonzero_import_batch', field);
    } else if (result && (result.vouchersCreated !== links.filter(r => r.action === 'created').length || result.vouchersDeduplicated !== links.filter(r => r.action === 'deduplicated').length)) issue('target_batch_result_association_conflict', field);
    for (const r of links) {
      const v = inv.vouchers.find(v => v.id === r.voucher_id), es = inv.entries.filter(e => e.voucher_id === r.voucher_id);
      const ss = inv.voucherSources.filter(s => ['source_system', 'enterprise_key', 'source_voucher_id', 'account_set_id', 'voucher_id', 'content_fingerprint'].every(k => s[k] === r[k]));
      const match = identity(r, h) && ['created', 'deduplicated'].includes(r.action) && v?.account_set_id === snapshot.scope.accountSetId && v.status === 'posted' && v.kind === 'normal' && es.length && es.every(e => moneyValid(e.debit) && moneyValid(e.credit)) && ss.length === 1 && (r.action !== 'created' || ss[0].batch_id === h.batch_id) && ss[0].voucher_fingerprint === persistedVoucherFingerprint(v, es);
      if (!match) issue('target_batch_voucher_source_conflict', `ledger.targetBatchInventory.association:${r.id}`);
    }
    for (const s of sources) if (!links.some(r => r.action === 'created' && ['source_system', 'enterprise_key', 'source_voucher_id', 'account_set_id', 'voucher_id', 'content_fingerprint'].every(k => s[k] === r[k]))) issue('target_batch_unexplained_source', `ledger.targetBatchInventory.source:${s.id}`);
    if (faultCount === initialFaults) { proof.headers.set(h.batch_id, h); for (const r of links) proof.links.set(r.id, r); }
  }
  for (const r of [...inv.batchVouchers, ...inv.voucherSources]) if (!inv.headers.some(h => h.batch_id === r.batch_id)) issue('target_batch_header_missing', `ledger.targetBatchInventory.batch:${r.batch_id}`, 'missing');
  return proof;
}

/** Only a live, private, same-source file-backed pair can enter the Q2 bridge.
 * No previous computation, public snapshot JSON, receipt digest or client number
 * is accepted. Q1 is actually recomputed here on every invocation. */
export async function calculateOfflineVatQ2(session) {
  const before = await assertVatInputPairCurrent(session);
  const { source, snapshots, prior: priorSession, target: targetSession } = session;
  const proof = validateLedgerSnapshotPair(source, snapshots);
  requireValue(snapshots.target.sources.targetBatchInventory?.version === 'q2-target-batch-inventory/1', 'q2_private_batch_inventory_required');
  for (const [part, snapshot] of [[priorSession, snapshots.prior], [targetSession, snapshots.target]]) {
    requireValue(part.source === source && part.snapshot === snapshot, 'q2_session_mismatch');
    assertVatInputPayload(part.rawInput, source, snapshot);
    await assertVatInputSessionCurrent(part, part.rawInput, source, snapshot);
  }
  const prior = calculateOfflineVat(priorSession.rawInput, source, snapshots.prior);
  const input = targetSession.rawInput, snapshot = snapshots.target, issues = [];
  const problem = (code, field, status = 'blocked', classification = status === 'unsupported' ? 'unsupported' : 'conflict', detail = {}) => issues.push({ code, field, status, classification, ...detail });
  if (!prior.calculationReady) for (const cause of prior.issues) problem('actual_Q1_calculation_not_ready', `prior.${cause.field}`, cause.status, cause.classification, { requestedFact: cause.requestedFact, upstream: { period: '2026-Q1', code: cause.code, field: cause.field } });
  const establishedOn = prior.taxFactsEvidence.enterprise.establishedOn;
  if (typeof establishedOn === 'string' && !/^2026-01-(?:0[1-9]|[12]\d|3[01])$/.test(establishedOn)) problem('prior_january_establishment_required', 'prior.taxFacts.enterprise.establishedOn', 'unsupported');
  const batchProof = checkTargetBatchInventory(snapshot, problem);
  requireValue(priorSession.rawInput.scope.period === '2026-Q1' && input.scope.period === '2026-Q2', 'q2_quarter_mismatch');
  const raw = { scope: input.scope, reports: input.reports, declaration: input.declaration, profileId: input.profileId, accountingFacts: input.accountingFacts };
  const replay = assessAccountingReadiness(raw), facts = parseTaxFacts(input.taxFacts, input, replay);
  for (const k of ['form', 'establishedOn']) {
    const a = prior.taxFactsEvidence.enterprise[k], b = facts.enterprise[k];
    if (a !== null && b !== null && a !== 'unknown' && b !== 'unknown' && a !== b) problem(`cross_quarter_enterprise_${k}_conflict`, `taxFacts.enterprise.${k}`);
  }
  for (const area of ['opening', 'history']) {
    const value = input.declaration[area], state = area === 'opening' ? 'balances_required' : 'prior_required';
    if (value?.state !== state) problem('explicit_Q2_history_dependency_required', `declaration.${area}`, 'blocked', value?.state === 'unknown' ? 'unknown' : value ? 'conflict' : 'missing');
    if (!(value?.evidenceIds ?? []).some(id => input.declaration.evidence?.some(e => e.evidenceId === id && e.kind !== 'attachment_reference' && e.confirmedBy.role === 'accountant' && e.basis))) problem('accountant_Q2_history_dependency_required', `declaration.${area}`, 'blocked', 'missing');
    // An external history/balance attachment is outside this bridge. Its meaning
    // must be resolved rather than erasing the old unsupported/conflict status.
    if (input.declaration.materials?.some(m => m.area === area)) problem('external_history_material_not_supported_by_bridge', `declaration.${area}`, 'unsupported');
  }
  const a = snapshots.prior, b = snapshots.target;
  if (!same(a.accountSet, b.accountSet) || !same(a.profile, b.profile) || !same(a.binding, b.binding) || !same(a.instance, b.instance) || !same(a.openingBalances, b.openingBalances) || input.profileId !== priorSession.rawInput.profileId) problem('cross_quarter_ledger_identity_conflict', 'ledger');
  if (a.accountSet.start_period !== '2026-01' || a.openingBalances.some(e => e.debitMinor !== 0 || e.creditMinor !== 0)) problem('january_zero_initial_ledger_required', 'ledger.openingBalances', 'unsupported');
  const stripRange = ({ range, ...v }) => v;
  const history = b.vouchers.filter(v => v.range === 'prior_history');
  const priorVoucherIds = prior.reconciledBusinesses.map(v => v.voucherId);
  const historySame = same(history.map(stripRange), a.vouchers.map(stripRange)) && history.length === priorVoucherIds.length && history.every(v => priorVoucherIds.includes(v.id));
  if (!historySame) problem('unexplained_prior_vouchers', 'ledger.history', 'unsupported');
  const priorSourceIds = a.sources.voucherSources.map(s => s.id);
  const sourcesSame = same(a.sources.voucherSources, b.sources.voucherSources.filter(s => priorSourceIds.includes(s.id)));
  const batchLinksSame = same(a.sources.batchVouchers, b.sources.batchVouchers.filter(s => priorVoucherIds.includes(s.voucher_id)));
  if (!sourcesSame) problem('prior_source_content_conflict', 'ledger.sources');
  if (!batchLinksSame) problem('prior_batch_content_conflict', 'ledger.sources');
  const priorBatchIds = a.sources.batches.map(s => s.batch_id);
  const batchesSame = same(a.sources.batches, b.sources.batches.filter(s => priorBatchIds.includes(s.batch_id)));
  if (!batchesSame) problem('prior_batch_metadata_conflict', 'ledger.sources');
  let priorSourceIssue = false;
  checkAllSourceRows(a, new Set(priorVoucherIds), (...args) => { priorSourceIssue = true; problem(...args); }, batchProof);
  // Explanation of already reconciled accounting is independent of whether a
  // tax fact is unknown or another target batch blocks the overall tax bridge.
  // This changes no admission condition: every upstream/target issue remains.
  const priorExplained = historySame && sourcesSame && batchLinksSame && batchesSame && !priorSourceIssue && a.sources.schemaStatus === 'present' && a.accountSet.start_period === '2026-01' && a.openingBalances.every(e => e.debitMinor === 0 && e.creditMinor === 0) && !a.counts.priorVouchers && !a.completeness.moneyIssues.length && !a.completeness.unknownStatuses.length && !a.completeness.missingPeriods.length && priorVoucherIds.length === a.vouchers.length && new Set(priorVoucherIds).size === priorVoucherIds.length;
  const bridge = { admitted: issues.length === 0, priorExplained, prior, issues, priorVoucherIds, priorSourceIds, proof, batchProof };
  const computation = calculatePeriod(input, source, snapshot, bridge);
  const after = await assertVatInputPairCurrent(session);
  requireValue(same(before, after) && same(proof, validateLedgerSnapshotPair(source, snapshots)), 'q2_context_stale');
  return freeze({ priorComputation: prior, computation, proof, inputFiles: after.inputFiles });
}
