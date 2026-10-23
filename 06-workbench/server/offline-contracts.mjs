// OFFLINE-00 v1. Pure, fail-closed boundary; no files, database, clock, environment or network.
// Validation does not establish material completeness, posting permission or accountant approval.
import { canonicalEnterpriseKey } from './enterprise-identity.mjs';

export const OFFLINE_CONTRACT_VERSION = 'offline-close-loop/1';
export const OFFLINE_KINDS = Object.freeze(['manifest', 'evidence', 'questionnaire', 'task-plan', 'data-request', 'voucher-candidate', 'tax-computation', 'review-bundle', 'review-decision']);
export const FACT_STATES = Object.freeze(['known', 'zero', 'missing', 'unknown', 'conflict', 'unsupported', 'not_applicable']);
export const FACT_TYPES = Object.freeze(['sales', 'service_expense', 'payroll', 'bank_activity', 'opening_balance', 'asset_purchase', 'inventory', 'non_deductible_expense_fact', 'business_scope']);
// Normal supplementation requests can ask for source materials, never customer-made entries/tax.
export const OFFLINE_MATERIAL_IDS = Object.freeze([
  'invoice_csv', 'invoice_xlsx', 'invoice_json', 'invoice_pdf',
  'bank_statement_csv', 'bank_statement_xlsx', 'bank_statement_json', 'bank_signed_statement_pdf',
  'payroll_csv', 'payroll_xlsx', 'payroll_json', 'asset_register_csv', 'asset_register_xlsx', 'asset_register_json',
  'inventory_record_csv', 'inventory_record_xlsx', 'inventory_record_json',
  'contract_pdf', 'contract_json', 'business_declaration_json', 'business_declaration_pdf',
  'opening_report_csv', 'opening_report_xlsx', 'opening_report_json', 'opening_report_pdf',
  'historical_return_pdf', 'historical_return_json',
]);
const BASE = ['kind', 'version', 'id', 'scope', 'sourceVersion'];
const MAX = 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MONEY = /^-?(?:0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
const CODES = Object.freeze({ invalid: 'offline_contract_invalid', fields: 'offline_fields_invalid', scope: 'offline_scope_invalid', reference: 'offline_reference_invalid', duplicate: 'offline_duplicate', state: 'offline_state_invalid', amount: 'offline_amount_invalid', date: 'offline_date_invalid', rules: 'offline_rules_unverified', context: 'offline_context_required', cycle: 'offline_dependency_cycle' });
const fail = (type = 'invalid') => { throw Object.assign(new Error(CODES[type]), { code: CODES[type] }); };
const check = (condition, type) => { if (!condition) fail(type); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function fields(value, required, optional = []) {
  check(isObject(value), 'fields');
  check(Object.keys(value).every(k => required.includes(k) || optional.includes(k)) && required.every(k => Object.hasOwn(value, k)), 'fields');
}
const id = value => check(typeof value === 'string' && ID.test(value), 'fields');
const text = value => check(typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value), 'fields');
const choice = (value, values) => check(values.includes(value), 'fields');
function list(value, min = 0) { check(Array.isArray(value) && value.length >= min && value.length <= MAX, 'fields'); }
function unique(values) { check(new Set(values).size === values.length, 'duplicate'); }
function refs(value, min = 0) { list(value, min); value.forEach(id); unique(value); }
function date(value) {
  check(typeof value === 'string' && /^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value), 'date');
  const parsed = new Date(`${value}T00:00:00Z`);
  check(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value, 'date');
}
function bounds(period) {
  check(typeof period === 'string' && /^20\d{2}-Q[1-4]$/.test(period), 'scope');
  const year = period.slice(0, 4), quarter = Number(period.at(-1));
  return [`${year}-${String(quarter * 3 - 2).padStart(2, '0')}-01`, new Date(Date.UTC(Number(year), quarter * 3, 0)).toISOString().slice(0, 10)];
}
function scope(value) {
  fields(value, ['enterpriseKey', 'accountSetId', 'period', 'currency']);
  check(typeof value.enterpriseKey === 'string' && value.enterpriseKey.length > 0 && value.enterpriseKey.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value.enterpriseKey) && canonicalEnterpriseKey(value.enterpriseKey) === value.enterpriseKey, 'scope');
  id(value.accountSetId); bounds(value.period); check(value.currency === 'CNY', 'scope');
}
const sameScope = (a, b) => check(['enterpriseKey', 'accountSetId', 'period', 'currency'].every(k => a[k] === b[k]), 'scope');
function inPeriod(value, period) { date(value); const [start, end] = bounds(period); check(value >= start && value <= end, 'date'); }
export function offlineMoneyToCents(value) {
  check(typeof value === 'string' && MONEY.test(value) && value !== '-0.00', 'amount');
  return BigInt(value.replace('.', ''));
}
function evidenceRefs(value, manifest, min = 0) {
  list(value, min);
  for (const ref of value) {
    fields(ref, ['evidenceId', 'sourceVersion']); id(ref.evidenceId); id(ref.sourceVersion);
    if (manifest) check(manifest.evidence.some(e => e.id === ref.evidenceId && e.sourceVersion === ref.sourceVersion && e.status === 'provided'), 'reference');
  }
  unique(value.map(r => `${r.evidenceId}/${r.sourceVersion}`));
}
function header(doc) {
  check(isObject(doc) && OFFLINE_KINDS.includes(doc.kind) && doc.version === OFFLINE_CONTRACT_VERSION);
  id(doc.id); id(doc.sourceVersion); scope(doc.scope);
}
function evidence(doc) {
  header(doc); check(doc.kind === 'evidence');
  fields(doc, [...BASE, 'category', 'format', 'locator', 'sourceLocation', 'coveragePeriod', 'sha256', 'documentDate', 'status']);
  choice(doc.category, ['invoice', 'bank_statement', 'contract', 'payroll', 'asset_register', 'inventory_record', 'opening_report', 'business_declaration', 'historical_return']);
  choice(doc.format, ['json', 'csv', 'xlsx', 'pdf']);
  // Locator is an opaque local registry key. It is never a path or remote URL.
  id(doc.locator); check(typeof doc.sha256 === 'string' && DIGEST.test(doc.sha256), 'fields');
  fields(doc.sourceLocation, ['sheet', 'row', 'field']);
  if (doc.sourceLocation.sheet !== null) text(doc.sourceLocation.sheet);
  if (doc.sourceLocation.row !== null) check(typeof doc.sourceLocation.row === 'string' && /^[1-9][0-9]{0,7}$/.test(doc.sourceLocation.row), 'fields');
  if (doc.sourceLocation.field !== null) text(doc.sourceLocation.field);
  bounds(doc.coveragePeriod);
  date(doc.documentDate); choice(doc.status, ['provided', 'conflict', 'unsupported']);
}
function facts(items, manifest) {
  list(items); unique(items.map(f => f?.factId));
  for (const fact of items) {
    fields(fact, ['factId', 'type', 'state', 'date', 'amount', 'evidenceRefs', 'reasonCode'], ['correctionOf', 'answer', 'business']);
    id(fact.factId); choice(fact.type, FACT_TYPES); choice(fact.state, FACT_STATES);
    if (fact.date !== null) inPeriod(fact.date, manifest.scope.period);
    const resolved = ['known', 'zero', 'not_applicable'].includes(fact.state);
    evidenceRefs(fact.evidenceRefs, manifest, resolved ? 1 : 0);
    check(fact.evidenceRefs.every(r => manifest.evidence.some(e => e.id === r.evidenceId && e.coveragePeriod === manifest.scope.period)), 'scope');
    if (Object.hasOwn(fact, 'correctionOf')) {
      fields(fact.correctionOf, ['factId', 'sourceVersion']); id(fact.correctionOf.factId); id(fact.correctionOf.sourceVersion);
      check(fact.correctionOf.sourceVersion !== manifest.sourceVersion && fact.state === 'known' && fact.type === 'sales', 'state');
    }
    if (Object.hasOwn(fact, 'answer')) check(fact.type === 'business_scope' && fact.state === 'known', 'state');
    if (Object.hasOwn(fact, 'business')) {
      check(['sales', 'service_expense'].includes(fact.type), 'fields');
      fields(fact.business, ['nature', 'performance', 'settlement', 'vatTreatment']);
      choice(fact.business.nature, ['service', 'goods', 'unknown']);
      choice(fact.business.performance, ['completed', 'not_completed', 'unknown']);
      choice(fact.business.settlement, ['received', 'paid', 'unpaid', 'unknown']);
      choice(fact.business.vatTreatment, ['unknown', 'missing', 'conflict', 'not_applicable']);
    }
    if (['sales', 'service_expense'].includes(fact.type) && fact.state === 'known') check(Object.hasOwn(fact, 'business'), 'fields');
    if (fact.state === 'known' || fact.state === 'zero') {
      check(fact.date !== null, 'date');
      if (fact.type === 'business_scope') {
        check(fact.state === 'known' && fact.amount === null, 'state');
        choice(fact.answer, ['service_company', 'trading_company', 'other']);
      } else {
        const cents = offlineMoneyToCents(fact.amount);
        check(fact.state === 'zero' ? cents === 0n : cents !== 0n, 'state');
        if (cents < 0n) check(Object.hasOwn(fact, 'correctionOf') && fact.evidenceRefs.some(r => manifest.evidence.some(e => e.id === r.evidenceId && e.category === 'invoice')), 'state');
      }
      check(fact.reasonCode === null, 'state');
    } else {
      check(fact.amount === null, 'state'); id(fact.reasonCode);
    }
    if (fact.state === 'conflict') check(fact.evidenceRefs.length >= 2, 'state');
  }
}
function manifest(doc) {
  fields(doc, [...BASE, 'mode', 'profileId', 'taxpayerStatus', 'region', 'evidence', 'facts', 'history', 'supersedes']);
  check(doc.mode === 'business_materials', 'fields');
  check(doc.profileId === 'small-2011-basic-v1' && ['small_scale_candidate', 'missing', 'unknown', 'conflict', 'unsupported'].includes(doc.taxpayerStatus) && doc.region === 'CN-FJ-ZZ', 'scope');
  list(doc.evidence); unique(doc.evidence.map(e => e?.id));
  for (const item of doc.evidence) { evidence(item); sameScope(item.scope, doc.scope); }
  facts(doc.facts, doc); list(doc.history); unique(doc.history.map(h => h?.period));
  for (const h of doc.history) {
    fields(h, ['period', 'enterpriseKey', 'accountSetId', 'resultVersion', 'status', 'evidenceRefs']);
    bounds(h.period); check(h.period < doc.scope.period && h.enterpriseKey === doc.scope.enterpriseKey && h.accountSetId === doc.scope.accountSetId, 'scope');
    choice(h.status, ['available', 'missing', 'unknown', 'conflict']);
    if (h.status === 'available') {
      id(h.resultVersion); evidenceRefs(h.evidenceRefs, doc, 1);
      check(h.evidenceRefs.every(r => doc.evidence.some(e => e.id === r.evidenceId && e.coveragePeriod === h.period && ['historical_return', 'opening_report'].includes(e.category))), 'scope');
    }
    else { check(h.resultVersion === null, 'state'); evidenceRefs(h.evidenceRefs, doc); }
  }
  if (doc.supersedes !== null) { fields(doc.supersedes, ['manifestId', 'sourceVersion', 'reason']); id(doc.supersedes.manifestId); id(doc.supersedes.sourceVersion); choice(doc.supersedes.reason, ['correction', 'supplement']); check(doc.supersedes.sourceVersion !== doc.sourceVersion, 'state'); }
}
function requireContext(doc, context) {
  check(context !== undefined, 'context'); header(context); check(context.kind === 'manifest'); manifest(context);
  sameScope(doc.scope, context.scope); check(doc.sourceVersion === context.sourceVersion, 'reference'); return context;
}
function factRefs(value, context, min = 0) { refs(value, min); check(value.every(r => context.facts.some(f => f.factId === r)), 'reference'); }
function lineage(value, context) {
  fields(value, ['manifestId', 'inputVersion', 'ledgerVersion', 'ruleVersion']);
  check(value.manifestId === context.id && value.inputVersion === context.sourceVersion, 'reference'); id(value.ledgerVersion); id(value.ruleVersion);
}
function taskPlan(doc, context) {
  fields(doc, [...BASE, 'tasks', 'periodStatus']); choice(doc.periodStatus, ['partial', 'blocked', 'ready_for_review']);
  list(doc.tasks, 1); unique(doc.tasks.map(t => t?.taskId));
  const byId = new Map(doc.tasks.map(t => [t?.taskId, t]));
  for (const task of doc.tasks) {
    fields(task, ['taskId', 'operation', 'dependencies', 'factIds', 'state', 'blockerCodes']);
    id(task.taskId); choice(task.operation, ['normalize', 'assess', 'post', 'close', 'compute_tax', 'review']); refs(task.dependencies); factRefs(task.factIds, context); refs(task.blockerCodes);
    choice(task.state, ['ready', 'blocked_missing_data', 'blocked_conflict', 'blocked_unknown', 'unsupported', 'stale', 'completed', 'not_applicable']);
    check(task.dependencies.every(r => byId.has(r)), 'reference');
    if (['blocked_missing_data', 'blocked_conflict', 'blocked_unknown', 'unsupported', 'stale'].includes(task.state)) check(task.blockerCodes.length > 0, 'state');
    else check(task.blockerCodes.length === 0, 'state');
    if (['ready', 'completed'].includes(task.state)) {
      // Completion requires an execution receipt, not a customer-controlled state flag.
      check(task.state !== 'completed', 'state');
      check(task.dependencies.every(r => byId.get(r).state === 'completed' || byId.get(r).state === 'not_applicable'), 'state');
      check(task.factIds.every(r => ['known', 'zero', 'not_applicable'].includes(context.facts.find(f => f.factId === r).state)), 'state');
      if (task.operation === 'compute_tax') fail('rules');
    }
    if (task.state === 'not_applicable') check(task.factIds.length > 0 && task.factIds.every(r => context.facts.find(f => f.factId === r).state === 'not_applicable'), 'state');
  }
  const visiting = new Set(), visited = new Set();
  function visit(key) { check(!visiting.has(key), 'cycle'); if (visited.has(key)) return; visiting.add(key); byId.get(key).dependencies.forEach(visit); visiting.delete(key); visited.add(key); }
  doc.tasks.forEach(t => visit(t.taskId));
  // Full-period readiness is deliberately not attested by a shape validator.
  check(doc.periodStatus !== 'ready_for_review', 'state');
}
function dataRequest(doc, context) {
  fields(doc, [...BASE, 'items', 'delivery']); check(doc.delivery === 'local_only', 'fields'); list(doc.items, 1); unique(doc.items.map(i => i?.requestId));
  for (const item of doc.items) {
    fields(item, ['requestId', 'factIds', 'reason', 'affectedTasks', 'acceptedMaterials', 'alternativeEvidence']);
    id(item.requestId); factRefs(item.factIds, context, 1); text(item.reason); refs(item.affectedTasks, 1); refs(item.acceptedMaterials, 1); refs(item.alternativeEvidence);
    check([...item.acceptedMaterials, ...item.alternativeEvidence].every(material => OFFLINE_MATERIAL_IDS.includes(material)), 'fields');
    check(item.factIds.every(r => !['known', 'zero', 'not_applicable'].includes(context.facts.find(f => f.factId === r).state)), 'state');
  }
}
function voucher(doc, context) {
  fields(doc, [...BASE, 'date', 'factIds', 'evidenceRefs', 'ruleId', 'ruleVersion', 'status', 'entries', 'idempotencyKey']);
  inPeriod(doc.date, doc.scope.period); factRefs(doc.factIds, context, 1); evidenceRefs(doc.evidenceRefs, context, 1); id(doc.ruleId); id(doc.ruleVersion); id(doc.idempotencyKey); check(doc.status === 'candidate', 'state');
  check(doc.factIds.every(r => context.facts.find(f => f.factId === r).state === 'known'), 'state');
  const requiredEvidence = context.facts.filter(f => doc.factIds.includes(f.factId)).flatMap(f => f.evidenceRefs);
  const referenceKey = ref => `${ref.evidenceId}/${ref.sourceVersion}`;
  const expected = new Set(requiredEvidence.map(referenceKey));
  const actual = new Set(doc.evidenceRefs.map(referenceKey));
  check(expected.size === actual.size && [...expected].every(key => actual.has(key)), 'reference');
  list(doc.entries, 2); let debit = 0n, credit = 0n;
  for (const row of doc.entries) { fields(row, ['accountCode', 'debit', 'credit']); check(typeof row.accountCode === 'string' && /^[1-6][0-9]{3,9}$/.test(row.accountCode), 'fields'); const d = offlineMoneyToCents(row.debit), c = offlineMoneyToCents(row.credit); check((d > 0n && c === 0n) || (c > 0n && d === 0n), 'amount'); debit += d; credit += c; }
  check(debit === credit, 'amount');
}
function tax(doc, context) {
  fields(doc, [...BASE, 'taxType', 'status', 'ruleStatus', 'lineage', 'fields', 'blockerCodes']);
  check(doc.taxType === 'vat_small_scale', 'fields'); lineage(doc.lineage, context);
  // This milestone has no accountant-approved, executable rule catalogue.
  check(doc.status === 'blocked' && ['unknown', 'source_checked_accountant_pending', 'unsupported'].includes(doc.ruleStatus), 'rules');
  refs(doc.blockerCodes, 1); list(doc.fields, 1); unique(doc.fields.map(f => f?.fieldId));
  for (const field of doc.fields) { fields(field, ['fieldId', 'amount', 'state', 'factIds', 'voucherIds', 'adjustmentIds', 'evidenceRefs']); id(field.fieldId); check(field.amount === null && field.state === 'unknown', 'rules'); factRefs(field.factIds, context); refs(field.voucherIds); refs(field.adjustmentIds); evidenceRefs(field.evidenceRefs, context); }
}
function review(doc, context) {
  if (doc.kind === 'review-bundle') {
    fields(doc, [...BASE, 'resultVersion', 'lineage', 'voucherIds', 'taxComputationIds', 'unresolvedCodes', 'status']);
    id(doc.resultVersion); lineage(doc.lineage, context); refs(doc.voucherIds); refs(doc.taxComputationIds); refs(doc.unresolvedCodes); choice(doc.status, ['blocked', 'pending_review']);
    check(doc.status !== 'pending_review' || doc.unresolvedCodes.length === 0, 'state');
  } else {
    fields(doc, [...BASE, 'bundleId', 'resultVersion', 'lineage', 'decision', 'reviewerRef', 'feedback']);
    id(doc.bundleId); id(doc.resultVersion); lineage(doc.lineage, context); id(doc.reviewerRef); choice(doc.decision, ['request_correction', 'reject', 'confirm']);
    // #82 must supply the actual immutable bundle/current versions before confirm can be accepted.
    check(doc.decision !== 'confirm', 'state');
    list(doc.feedback, doc.decision === 'confirm' ? 0 : 1);
    for (const item of doc.feedback) { fields(item, ['factId', 'reasonCode', 'comment']); factRefs([item.factId], context, 1); id(item.reasonCode); text(item.comment); }
    check(doc.decision !== 'confirm' || doc.feedback.length === 0, 'state');
  }
}

/** Accept only bounded JSON data, including when called from JS instead of a JSON parser. */
function plainData(value, seen = new Set(), depth = 0, budget = { count: 0 }) {
  check(depth <= 20 && ++budget.count <= 50000);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { check(value.length <= 1000); return; }
  // No numeric JSON values in this v1: amounts are exact decimal strings.
  check(typeof value === 'object' && (Array.isArray(value) || isObject(value)) && !seen.has(value));
  seen.add(value);
  check(Reflect.ownKeys(value).every(k => typeof k === 'string'));
  if (Array.isArray(value)) check(Object.keys(value).length === value.length && Object.keys(value).every((k, i) => k === String(i)));
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
    plainData(descriptor.value, seen, depth + 1, budget);
  }
  seen.delete(value);
}

/** Returns only fixed error codes. Never returns raw values, paths or customer identifiers. */
export function validateOfflineContract(doc, options = {}) {
  try {
    fields(options, [], ['manifest']);
    check(Reflect.ownKeys(options).every(key => key === 'manifest'), 'fields');
    const manifestDescriptor = Object.getOwnPropertyDescriptor(options, 'manifest');
    if (manifestDescriptor) check(Object.hasOwn(manifestDescriptor, 'value') && manifestDescriptor.enumerable, 'fields');
    const context = manifestDescriptor?.value;
    plainData(doc); if (context !== undefined) plainData(context);
    header(doc);
    if (doc.kind === 'manifest') manifest(doc);
    else if (doc.kind === 'evidence') evidence(doc);
    else {
      const m = requireContext(doc, context);
      if (doc.kind === 'questionnaire') { fields(doc, [...BASE, 'facts']); facts(doc.facts, m); }
      else if (doc.kind === 'task-plan') taskPlan(doc, m);
      else if (doc.kind === 'data-request') dataRequest(doc, m);
      else if (doc.kind === 'voucher-candidate') voucher(doc, m);
      else if (doc.kind === 'tax-computation') tax(doc, m);
      else review(doc, m);
    }
    return { valid: true, validationOnly: true, authorizesExecution: false, errors: [] };
  } catch (error) {
    return { valid: false, validationOnly: true, authorizesExecution: false, errors: [{ code: Object.values(CODES).includes(error?.code) ? error.code : CODES.invalid }] };
  }
}
