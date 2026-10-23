// Candidate admission only. Replays #78 and #79; never authorizes execution.
import { assessCompleteness, replayReports } from './material-completeness.mjs';
import { planOffline } from './offline-task-planner.mjs';
import { fields, requirePlainJson, requireValue, identifier, validateScope, stable, hash } from './offline-material-adapters.mjs';
import { parseDateByFormat } from './bank-import.mjs';

export const FACTS_VERSION = 'offline-accounting-facts/1';
export const sameRef = (a, b) => a && b && ['sellerKey', 'code', 'number'].every(k => a[k] === b[k]);
export const sameBank = (a, b) => a && b && a.bankAccountId === b.bankAccountId && a.refId === b.refId;
const text = v => requireValue(typeof v === 'string' && v.trim().length > 0 && v === v.trim() && v.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(v));
const date = v => requireValue(typeof v === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(v) && parseDateByFormat(v, 'YYYY-MM-DD').ok);
const enumValue = (v, values) => requireValue(values.includes(v));
function confirmer(c) { fields(c, ['name', 'role']); text(c.name); enumValue(c.role, ['owner', 'business_operator', 'accountant']); }
function invoiceRef(r) {
  fields(r, ['sellerKey', 'code', 'number']); text(r.sellerKey);
  requireValue(typeof r.code === 'string' && (r.code === '' || /^\d{1,30}$/.test(r.code)) && typeof r.number === 'string' && /^\d{1,30}$/.test(r.number));
}
function bankRef(r) { fields(r, ['bankAccountId', 'refId']); identifier(r.bankAccountId); text(r.refId); }
export function parseAccountingFacts(source, scope) {
  requirePlainJson(source); fields(source, ['text', 'fileSha256']);
  requireValue(typeof source.text === 'string' && Buffer.byteLength(source.text, 'utf8') <= 5 * 1024 * 1024 && hash(source.text) === source.fileSha256, 'source_digest_invalid');
  const doc = JSON.parse(source.text.replace(/^\uFEFF/, '')); requirePlainJson(doc);
  fields(doc, ['version', 'scope', 'facts']); requireValue(doc.version === FACTS_VERSION);
  validateScope(doc.scope); requireValue(stable(doc.scope) === stable(scope), 'scope_mismatch');
  requireValue(Array.isArray(doc.facts) && doc.facts.length <= 1000);
  const sourceVersion = hash(stable({ version: FACTS_VERSION, scope, fileSha256: source.fileSha256 }));
  const facts = doc.facts.map((f, i) => {
    fields(f, ['factId', 'kind', 'confirmedBy', 'basis'], ['invoiceRef', 'bankRef', 'contractId', 'serviceStartDate', 'completionDate', 'collectionRightDate', 'mainService', 'purpose', 'nonAsset', 'nonProjectCost', 'benefitFrom', 'benefitTo', 'benefitBasis', 'supplierKey', 'serviceEndDate', 'ordinaryService', 'performanceThroughPeriodEnd', 'refundThroughPeriodEnd', 'paymentCount', 'otherRecognitionInProvidedMaterials', 'relatedInvoiceRefs']);
    identifier(f.factId); enumValue(f.kind, ['service_sale', 'administrative_service', 'service_prepayment']); confirmer(f.confirmedBy); text(f.basis);
    const allowed = {
      service_sale: ['invoiceRef', 'contractId', 'serviceStartDate', 'completionDate', 'collectionRightDate', 'mainService', 'ordinaryService'],
      administrative_service: ['invoiceRef', 'contractId', 'completionDate', 'purpose', 'nonAsset', 'nonProjectCost', 'benefitFrom', 'benefitTo', 'benefitBasis'],
      service_prepayment: ['bankRef', 'contractId', 'supplierKey', 'serviceStartDate', 'serviceEndDate', 'ordinaryService', 'performanceThroughPeriodEnd', 'refundThroughPeriodEnd', 'paymentCount', 'otherRecognitionInProvidedMaterials', 'relatedInvoiceRefs'],
    }[f.kind];
    requireValue(Object.keys(f).every(k => ['factId', 'kind', 'confirmedBy', 'basis', ...allowed].includes(k)));
    if (Object.hasOwn(f, 'invoiceRef')) invoiceRef(f.invoiceRef); if (Object.hasOwn(f, 'bankRef')) bankRef(f.bankRef);
    for (const k of ['contractId', 'supplierKey', 'benefitBasis']) if (k in f) text(f[k]);
    for (const k of ['serviceStartDate', 'completionDate', 'collectionRightDate', 'benefitFrom', 'benefitTo', 'serviceEndDate']) if (k in f) date(f[k]);
    for (const k of ['mainService', 'nonAsset', 'nonProjectCost', 'ordinaryService']) if (k in f) requireValue(typeof f[k] === 'boolean');
    if ('purpose' in f) enumValue(f.purpose, ['organizational_administration', 'project', 'asset', 'personal', 'unknown']);
    if ('performanceThroughPeriodEnd' in f) enumValue(f.performanceThroughPeriodEnd, ['not_started', 'partial', 'completed', 'unknown']);
    if ('refundThroughPeriodEnd' in f) enumValue(f.refundThroughPeriodEnd, ['none', 'refunded', 'unknown']);
    if ('otherRecognitionInProvidedMaterials' in f) enumValue(f.otherRecognitionInProvidedMaterials, ['none', 'exists', 'unknown']);
    if ('paymentCount' in f) requireValue(Number.isSafeInteger(f.paymentCount) && f.paymentCount >= 0 && f.paymentCount <= 100000);
    if ('relatedInvoiceRefs' in f) { requireValue(Array.isArray(f.relatedInvoiceRefs) && f.relatedInvoiceRefs.length <= 100); f.relatedInvoiceRefs.forEach(invoiceRef); }
    return { data: f, source: { kind: 'accounting_business_facts', fileSha256: source.fileSha256, sourceVersion, pointer: `/facts/${i}`, fields: Object.fromEntries(Object.keys(f).map(k => [k, { pointer: `/facts/${i}/${k}` }])) } };
  });
  return { facts, sourceVersion, fileSha256: source.fileSha256, rawContent: source.text };
}

// Only the specific old purchase-use gap may be resolved by new business facts.
// It cannot turn other unknown, invalid, conflicting or missing evidence into ready.
export function assessAccountingReadiness(input) {
  const base = { scope: input.scope, reports: input.reports, declaration: input.declaration };
  const assessment = assessCompleteness(base), plan = planOffline(base), replay = replayReports(input.scope, input.reports);
  const supplement = parseAccountingFacts(input.accountingFacts, input.scope);
  const row = id => assessment.rows.find(r => r.id === id);
  function gates(record, kind) {
    const ids = ['enterprise', ...(kind === 'service_prepayment' ? [] : ['tax']), record.kind === 'invoice' ? `invoice:${record.docId}` : `bank:${record.docId}`];
    if (record.kind === 'invoice') ids.push(`business:${record.docId}`);
    else ids.push('bank-accounts');
    const linkedFacts = assessment.records.filter(r => r.kind === 'business_fact' && sameRef(r.data.invoiceRef, record.data));
    const raw = linkedFacts[0]?.data;
    return ids.flatMap(id => {
      const r = row(id);
      const resolvablePurchase = kind === 'administrative_service' && id.startsWith('business:') && r?.status === 'unknown'
        && r.reason === 'purchase_use_service_beneficiary_and_benefit_period_need_detail' && linkedFacts.length > 0
        && raw.nature === 'service' && raw.performance === 'completed' && raw.settlement === 'unpaid'
        && ['unknown', 'operating_service'].includes(raw.purpose);
      const bankStatements = (assessment.declaration.bankFacts ?? []).filter(f => sameBank(f, record.data));
      const resolvableBankNature = kind === 'service_prepayment' && id.startsWith('bank:') && r?.status === 'unknown'
        && r.reason === 'bank_nature_requires_explicit_statement_not_summary_inference' && record.data.refId && record.data.direction === 'outflow'
        && !['conflict', 'suspected_duplicate'].includes(record.duplicateStatus)
        && bankStatements.every(f => ['unknown', 'operating_payment'].includes(f.nature));
      const invalidSameSource = assessment.rows.some(x => x.status === 'provided_invalid' && /^source:\d+:\d+$/.test(x.id) && (() => { const [, i, j] = x.id.split(':'); return input.reports[Number(i)]?.sources?.[Number(j)]?.sourceId === record.sourceId; })());
      if (id === (record.kind === 'invoice' ? `invoice:${record.docId}` : `bank:${record.docId}`) && invalidSameSource) return [{ code: 'planning_provided_invalid', field: id, requestedFact: '同一来源另有原文摘要或映射重验失败的版本，请修复并核对有效版本', reason: 'same_source_invalid_version' }];
      return r?.status === 'provided_valid' || resolvablePurchase || resolvableBankNature ? [] : [{ code: `planning_${r?.status ?? 'missing'}`, field: id, requestedFact: r?.requestedFields?.join('；') || r?.acceptedMaterials?.join('；') || '提供相同范围的有效原始资料及确认依据', reason: r?.reason ?? 'required_row_missing' }];
    });
  }
  return { assessment, plan, supplement, gates, row, replayIssues: replay.issues };
}
