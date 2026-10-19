// Preparation metadata only. No tax rates, obligation inference, submission or real values.
// Applicable forms/rules have not been verified: every package remains blocked.
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const REF = /^[A-Za-z0-9_.:-]{1,160}$/;
export const PREPARATION_RESOURCES = Object.freeze([
  'identity', 'authorized_enterprises', 'enterprise_profile', 'tax_assessments',
  'accounting_filing', 'current_obligations', 'declaration_status',
  'declaration_history', 'invoices', 'payments',
]);
const STATES = new Set(['success', 'no_records', 'not_acquired', 'unsupported', 'permission_denied', 'partial', 'failed', 'session_expired']);
const SOURCES = new Set(['tax_evidence', 'local_account_set', 'user_material', 'calculation_rule']);
const CONDITIONAL_RESOURCES = new Set(['declaration_history', 'invoices', 'payments']);
const invalid = () => { const e = new Error('Invalid preparation metadata'); e.code = 'tax_preparation_input_invalid'; throw e; };
const ref = (v) => typeof v === 'string' && REF.test(v);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function buildTaxPreparation({ companyRef, period, coverage = [], accountSet = null, fields = [] } = {}) {
  if (!ref(companyRef) || typeof period !== 'string' || !PERIOD.test(period) || !Array.isArray(coverage) || coverage.length > PREPARATION_RESOURCES.length || !Array.isArray(fields) || fields.length > 1000) invalid();
  if (accountSet !== null && (!object(accountSet) || typeof accountSet.linked !== 'boolean')) invalid();
  if (accountSet?.accountSetRef != null && !ref(accountSet.accountSetRef)) invalid();
  for (const key of ['accountCount', 'voucherCount']) {
    if (accountSet?.[key] != null && (!Number.isSafeInteger(accountSet[key]) || accountSet[key] < 0)) invalid();
  }
  const byResource = new Map();
  for (const item of coverage) {
    if (!object(item) || !PREPARATION_RESOURCES.includes(item.resource) || byResource.has(item.resource) || !STATES.has(item.status) || typeof item.complete !== 'boolean'
        || !(Number.isSafeInteger(item.count) && item.count >= 0 || item.count === null && !['success', 'no_records'].includes(item.status))) invalid();
    if (item.sourceRef != null && !ref(item.sourceRef)) invalid();
    if (item.status === 'no_records' && item.count !== 0) invalid();
    if (item.period != null && item.period !== period) invalid();
    if (item.companyRef != null && item.companyRef !== companyRef) invalid();
    byResource.set(item.resource, item);
  }
  const gaps = [];
  const coverageSummary = PREPARATION_RESOURCES.map((resource) => {
    const item = byResource.get(resource);
    const status = item?.status ?? 'not_acquired';
    // A synthetic result, count=0, or a success flag alone is never production evidence.
    const verified = item?.complete === true && ['success', 'no_records'].includes(status)
      && ['repeated', 'integrated'].includes(item?.evidenceLevel) && ref(item?.sourceRef)
      && item?.evidencePersisted === true && item?.metadataOnly === false
      && item?.period === period && item?.companyRef === companyRef;
    if (!verified && !CONDITIONAL_RESOURCES.has(resource)) gaps.push({ code: 'resource_not_verified', resource, status, source: 'official_tax_service' });
    return { resource, status, complete: verified, count: item?.count ?? null,
      applicability: CONDITIONAL_RESOURCES.has(resource) ? 'needs_assessment' : 'core_fact',
      evidencePersisted: item?.evidencePersisted === true, metadataOnly: item?.metadataOnly !== false,
      evidenceLevel: ['synthetic', 'observed', 'repeated', 'integrated'].includes(item?.evidenceLevel) ? item.evidenceLevel : 'unknown',
      sourceRef: ref(item?.sourceRef) ? item.sourceRef : null };
  });
  if (accountSet?.linked !== true) gaps.push({ code: 'existing_account_set_not_linked', source: 'existing_local_account_set' });
  else if (accountSet.periodAvailable !== true) gaps.push({ code: 'accounting_period_unavailable', source: 'existing_local_account_set' });
  if (accountSet?.linked === true && accountSet.identityMatched !== true) gaps.push({ code: 'account_set_enterprise_match_unverified', source: 'operator_material' });
  gaps.push(
    { code: 'applicable_official_rules_unverified', source: 'official_rules', blocks: 'obligation_determination' },
    { code: 'applicable_form_version_unverified', source: 'official_forms', blocks: 'field_mapping' },
    { code: 'enterprise_events_unverified', source: 'user_material', blocks: 'obligation_determination' },
    { code: 'historical_dependencies_unresolved', source: 'official_tax_service', blocks: 'carry_forward_and_benefits' },
  );
  const fieldIds = new Set();
  const fieldSummary = fields.map((field) => {
    if (!object(field) || !ref(field.fieldId) || fieldIds.has(field.fieldId)) invalid();
    fieldIds.add(field.fieldId);
    const provenance = SOURCES.has(field.sourceKind) && ref(field.sourceRef) && ref(field.sourceVersion);
    const samePeriod = field.period === period;
    const known = field.status === 'known' && Object.hasOwn(field, 'value') && field.value !== null && field.value !== undefined;
    if (!provenance) gaps.push({ code: 'field_source_missing', fieldId: field.fieldId, source: 'user_material' });
    if (!samePeriod) gaps.push({ code: 'field_period_mismatch', fieldId: field.fieldId, source: 'source_record' });
    if (!known) gaps.push({ code: 'field_value_unknown', fieldId: field.fieldId, source: 'existing_local_account_set_then_user_material' });
    // Explicit whitelist: real values, free text, identity and account names stay local.
    return { fieldId: field.fieldId, status: known && provenance && samePeriod ? 'requires_rule_validation' : 'incomplete',
      sourceKind: SOURCES.has(field.sourceKind) ? field.sourceKind : null,
      sourceRef: provenance ? field.sourceRef : null, sourceVersion: provenance ? field.sourceVersion : null,
      period: samePeriod ? period : null, ruleVersion: null };
  });
  if (!fields.length) gaps.push({ code: 'field_mapping_unavailable', source: 'verified_form_and_rules' });
  return {
    companyRef, period, status: 'blocked', submittable: false, obligationsComplete: false,
    coverage: coverageSummary, gaps, fields: fieldSummary,
    accounting: { linked: accountSet?.linked === true, accountSetRef: accountSet?.accountSetRef ?? null,
      identityMatched: accountSet?.identityMatched === true, periodAvailable: accountSet?.periodAvailable === true,
      accountCount: accountSet?.accountCount ?? null, voucherCount: accountSet?.voucherCount ?? null },
    ruleSet: { status: 'unsupported', version: null },
    validations: [
      { check: 'material_completeness', status: 'blocked' },
      ...['period', 'form_version', 'within_form', 'between_forms', 'book_tax_difference', 'carry_forward', 'benefit_eligibility']
        .map((check) => ({ check, status: 'not_evaluated', reason: 'verified_form_and_rules_required' })),
    ],
    filingStates: { financialStatements: 'unknown', taxDeclaration: 'unknown', payment: 'unknown' },
  };
}
