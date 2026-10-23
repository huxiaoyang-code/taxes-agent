// Pure draft entries. No DB, network, posting, period completion or ledger assertions.
import { fields, requirePlainJson, requireValue, hash, stable, validateScope } from './offline-material-adapters.mjs';
import { assessAccountingReadiness, sameRef, sameBank } from './offline-accounting-readiness.mjs';
import { candidateAccounts, createEntries, RULE_CATALOG, BOOKKEEPING_RULE_VERSION } from './offline-voucher-rules.mjs';
import { offlineMoneyToCents } from './offline-contracts.mjs';

export const BOOKKEEPING_VERSION = 'offline-bookkeeping-candidates/1';
const missing = (code, field, requestedFact) => ({ code, field, requestedFact });
const sourceRef = r => ({ kind: r.kind, sourceId: r.sourceId, sourceVersion: r.sourceVersion, fileSha256: r.fileSha256, docId: r.docId, semanticDigest: r.semanticDigest, location: r.location });
const same = (a, b) => stable(a) === stable(b);
const unique = values => [...new Map(values.map(v => [stable(v), v])).values()];
const versionOf = c => { const { contentVersion, ...rest } = c; return hash(stable(rest)); };
const digestOf = p => { const { documentDigest, ...rest } = p; return hash(stable(rest)); };
function invoiceKey(scope, ref) { return `invoice:${hash(stable([scope.enterpriseKey, scope.accountSetId, ref.sellerKey, ref.code, ref.number]))}`; }
function paymentKey(scope, ref) { return `prepayment:${hash(stable([scope.enterpriseKey, scope.accountSetId, ref.bankAccountId, ref.refId]))}`; }
function businessMeaning(f) {
  const { factId, confirmedBy, basis, ...meaning } = f;
  return meaning;
}
function comparePrevious(previous, current) {
  if (previous === null) return current.candidates.map(c => ({ businessKey: c.businessKey, state: 'new' }));
  requirePlainJson(previous);
  fields(previous, ['version', 'scope', 'status', 'validationOnly', 'authorizesExecution', 'profile', 'ruleVersion', 'plan', 'sources', 'decisions', 'candidates', 'changes', 'limitations', 'documentDigest']);
  requireValue(previous.version === BOOKKEEPING_VERSION && same(previous.scope, current.scope) && previous.status === 'candidates_only' && previous.validationOnly === true && previous.authorizesExecution === false && digestOf(previous) === previous.documentDigest, 'previous_candidates_invalid');
  requireValue(Array.isArray(previous.candidates) && previous.candidates.length <= 1000 && new Set(previous.candidates.map(c => c.businessKey)).size === previous.candidates.length, 'previous_candidates_invalid');
  for (const c of previous.candidates) {
    fields(c, ['businessKey', 'contentVersion', 'kind', 'scope', 'date', 'status', 'authorizesExecution', 'rule', 'profile', 'evidence', 'entries', 'recognition']);
    requireValue(c.status === 'candidate' && c.authorizesExecution === false && versionOf(c) === c.contentVersion, 'previous_candidates_invalid');
  }
  const old = new Map(previous.candidates.map(c => [c.businessKey, c]));
  return [
    ...current.candidates.map(c => ({ businessKey: c.businessKey, state: !old.has(c.businessKey) ? 'new' : old.get(c.businessKey).contentVersion === c.contentVersion ? 'unchanged' : 'newVersion' })),
    ...previous.candidates.filter(c => !current.candidates.some(n => n.businessKey === c.businessKey)).map(c => ({ businessKey: c.businessKey, state: current.decisions.some(d => d.businessKey === c.businessKey && d.status === 'conflict') ? 'conflict' : 'withdrawn' })),
  ];
}

export function buildOfflineCandidates(input) {
  requirePlainJson(input);
  fields(input, ['scope', 'reports', 'declaration', 'profileId', 'accountingFacts'], ['previousCandidates']);
  const range = validateScope(input.scope), profile = candidateAccounts(input.profileId);
  const ready = assessAccountingReadiness(input), { assessment, supplement, plan } = ready;
  const monthEnd = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const end = monthEnd(range.to), start = range.from + '-01';
  const futureEnd = monthEnd(`${Number(range.to.slice(0, 4)) + 1}-${range.to.slice(5)}`);
  const records = [...new Map(assessment.records.filter(r => ['invoice', 'bank_activity'].includes(r.kind)).map(r => [r.docId, r])).values()];
  const decisions = [], candidates = [], used = new Set();
  function evaluate(record, group) {
    const inv = record.kind === 'invoice', r = record.data;
    const defaultKind = inv ? r.role === 'sales' ? 'service_sale' : 'administrative_service' : 'service_prepayment';
    const f = group[0]?.data, kind = f?.kind ?? defaultKind;
    const recognitionDate = kind === 'administrative_service' ? f?.completionDate : r.date;
    const businessKey = inv ? invoiceKey(input.scope, r) : r.refId ? paymentKey(input.scope, r) : null;
    const problems = ready.gates(record, kind);
    const ask = (condition, code, field, message) => { if (!condition) problems.push(missing(code, field, message)); };
    const conflict = (condition, field, message) => { if (condition) problems.push(missing('business_conflict', field, message)); };
    ask(recognitionDate >= RULE_CATALOG[kind].productSupportedFrom && recognitionDate <= RULE_CATALOG[kind].productSupportedThrough, 'unsupported_rule_date', kind === 'administrative_service' ? 'completionDate' : 'date', '当前工程规则仅支持2026-01-01至2026-12-31的实际候选确认日；行政服务取实际完成日，历史或未来日期需先核对该期适用规则，这不是法律失效日');
    const linked = inv ? assessment.records.filter(x => x.kind === 'business_fact' && sameRef(x.data.invoiceRef, r)) : [];
    const raw = linked[0]?.data;
    ask(group.length, 'missing_business_facts', 'facts', inv ? '提供对应发票的原始服务日期、合同关系、实际用途及确认人依据' : '提供该账户流水对应供应商、合同、未来服务日期及期末履约/退款事实');
    if (f) {
      group.forEach(x => used.add(x));
      conflict(new Set(group.map(x => stable(businessMeaning(x.data)))).size > 1, 'facts', '同一票据或流水存在不同事实，请核对有效版本与原始依据');
      conflict(supplement.facts.some(x => x.data.factId === f.factId && !same(x.data, f)), 'factId', '同事实编号的内容不同，请核对有效版本');
      ask(kind === defaultKind, 'unsupported_fact_kind', 'kind', '提供与原始发票角色或银行支付一致的服务事实');
      ask(f.contractId, 'missing_contract', 'contractId', '提供真实合同/订单或业务登记编号，用于核对同一业务的票据和支付关系');
      const counterparty = inv ? r.role === 'sales' ? r.buyerKey : r.sellerKey : f.supplierKey;
      if (f.contractId && counterparty) {
        const related = supplement.facts.filter(x => x.data.contractId === f.contractId && (x.data.supplierKey === counterparty || x.data.invoiceRef?.sellerKey === counterparty));
        const prepaid = related.filter(x => x.data.kind === 'service_prepayment');
        const bankIds = new Set(prepaid.map(x => stable(x.data.bankRef ?? null)));
        conflict(bankIds.size > 1 || prepaid.length > 0 && related.some(x => x.data.kind !== 'service_prepayment'), 'contractId', '同一合同存在多次支付或费用/预付的履约矛盾，需要逐笔支付、已接受服务和退款明细');
      }
      if (inv) {
        ask(r.status === 'blue', 'red_invoice_review', 'status', '红字须核对原票和既有入账/红冲记录，本片不自动处理');
        ask(raw?.nature === 'service' && raw?.performance === 'completed' && raw?.settlement === 'unpaid', 'complex_performance_or_settlement', 'performance/settlement', '提供实际已完成服务范围及尚未结算的确认，已收/付或部分结算需逐笔分配');
        ask(f.completionDate, 'missing_completion', 'completionDate', '提供服务实际完成日及验收/业务登记依据');
        conflict(f.completionDate && raw && f.completionDate !== raw.date, 'completionDate', '补充完成日与原始业务事实日期不一致，请核对有效版本');
        ask(f.completionDate >= start && f.completionDate <= end, 'completion_outside_scope', 'completionDate', '提供本期实际完成日；跨期业务需要后续规则');
        if (kind === 'service_sale') {
          ask(f.serviceStartDate, 'missing_service_start', 'serviceStartDate', '提供合同服务实际开始日，核对是否本期开始并完成');
          ask(f.serviceStartDate >= start && f.serviceStartDate <= f.completionDate && f.serviceStartDate?.slice(0, 4) === f.completionDate?.slice(0, 4), 'unsupported_service_span', 'serviceStartDate', '仅支持同一会计年度且本scope内开始并完成的服务；跨年或跨期需进度和履约明细');
          ask(f.collectionRightDate, 'missing_collection_right', 'collectionRightDate', '提供已取得收款权利的实际日期及合同/验收索款依据');
          ask(f.collectionRightDate === r.date && f.completionDate === r.date, 'unsupported_different_dates', 'collectionRightDate/completionDate', '本片仅支持开票、实际完成及取得收款权利同日，异日需具体合同、索款和收款事实');
          ask(f.mainService === true && f.ordinaryService === true, 'unsupported_service_nature', 'mainService/ordinaryService', '确认该服务为企业主营的普通服务，其他或复杂业务需单独规则');
          ask(r.tax !== '0.00' && r.net !== '0.00', 'zero_tax_or_net_review', 'tax/net', '零票税或零净额须核对实际业务与适用处理，本片不判断免税或收益结转');
          ask(r.date >= '2026-01-01', 'vat_trigger_rule_date_unsupported', 'date', '本片同日纳税义务规则仅支持2026-01-01及以后');
        } else {
          conflict(raw && (!['unknown', 'operating_service'].includes(raw.purpose) || raw.nature !== 'service'), 'purpose', '新行政用途与原始事实已明确的资产、个人、存货或非服务性质矛盾，请核对有效版本');
          ask(f.purpose === 'organizational_administration' && f.nonAsset === true && f.nonProjectCost === true, 'missing_administrative_use', 'purpose/nonAsset/nonProjectCost', '说明为组织行政日常用途、服务对象以及非资产非项目成本的实际依据');
          ask(f.benefitFrom && f.benefitTo && f.benefitBasis, 'missing_benefit_period', 'benefitFrom/benefitTo/benefitBasis', '提供全部受益起止日及仅当月受益的业务依据');
          ask(f.completionDate && f.benefitFrom <= f.benefitTo && f.benefitFrom?.slice(0, 7) === f.completionDate.slice(0, 7) && f.benefitTo?.slice(0, 7) === f.completionDate.slice(0, 7), 'unsupported_benefit_span', 'benefitFrom/benefitTo', '跨月或部分受益须提供具体服务范围，当前不按月份自动均摊');
          conflict(raw?.benefitPeriod?.state === 'known' && (raw.benefitPeriod.from !== f.benefitFrom || raw.benefitPeriod.to !== f.benefitTo), 'benefitPeriod', '新旧受益期不一致，请核对原始依据及有效版本');
        }
        conflict(supplement.facts.some(x => x.data.kind === 'service_prepayment' && x.data.relatedInvoiceRefs?.some(ref => sameRef(ref, r))), 'relatedInvoiceRefs', '该发票又关联期末未履约预付款，请核对同一合同履约与费用确认，避免重复候选');
      } else {
        conflict((assessment.declaration.bankFacts ?? []).some(b => sameBank(b, r) && !['unknown', 'operating_payment'].includes(b.nature)), 'bankFacts.nature', '预付服务合同与既有逐笔工资、资产或收款性质声明矛盾，请核对有效版本');
        ask(r.direction === 'outflow' && r.refId, 'unsupported_bank_payment', 'bankRef', '提供企业视角流出、具有稳定账户与流水编号的实际支付');
        ask(f.supplierKey, 'missing_supplier', 'supplierKey', '提供合同供应商身份及与该支付的对应依据');
        ask(f.serviceStartDate && f.serviceEndDate, 'missing_future_service_dates', 'serviceStartDate/serviceEndDate', '提供合同未来服务起止日');
        ask(f.serviceStartDate > end && f.serviceEndDate >= f.serviceStartDate && f.serviceEndDate <= futureEnd, 'unsupported_future_service_span', 'serviceStartDate/serviceEndDate', '仅支持期末后开始且未来12个月内结束的服务；更长期需分类规则');
        ask(f.ordinaryService === true, 'unsupported_prepaid_nature', 'ordinaryService', '说明预付对象为普通短期服务，复杂资产或项目不在本片');
        ask(f.performanceThroughPeriodEnd === 'not_started', 'performance_review', 'performanceThroughPeriodEnd', '明确本期期末尚未接受任何合同服务；部分履约需服务分配明细');
        ask(f.refundThroughPeriodEnd === 'none', 'refund_review', 'refundThroughPeriodEnd', '明确截至期末未退款；退款或未知需相应流水及核对依据');
        ask(f.paymentCount === 1, 'multiple_payments_review', 'paymentCount', '核对合同支付次数；本片仅支持单次支付，多次支付需全部逐笔关系');
        ask(f.otherRecognitionInProvidedMaterials === 'none', 'duplicate_recognition_review', 'otherRecognitionInProvidedMaterials', '核对已提供资料是否另有该合同的费用/资产确认；不代替核验既存账簿');
        ask(Array.isArray(f.relatedInvoiceRefs), 'missing_invoice_relationship', 'relatedInvoiceRefs', '列明该合同关联发票；无对应发票时明确空清单及核对依据');
        for (const ref of f.relatedInvoiceRefs ?? []) {
          const matches = assessment.records.filter(x => x.kind === 'invoice' && sameRef(x.data, ref));
          ask(matches.length > 0, 'missing_related_invoice', 'relatedInvoiceRefs', '提供关联发票原始材料以核对预付与费用关系');
          const relatedFacts = assessment.records.filter(x => x.kind === 'business_fact' && sameRef(x.data.invoiceRef, ref));
          conflict(matches.some(x => x.data.role !== 'purchase' || x.data.sellerKey !== f.supplierKey), 'relatedInvoiceRefs', '预付款关联票须是相同供应商开给本企业的采购票，销项或其他供应商关系矛盾须核对');
          ask(matches.every(x => x.data.status === 'blue'), 'red_related_invoice_review', 'relatedInvoiceRefs', '关联红字须核对原票及既有红冲关系，本片不自动处理');
          ask(relatedFacts.length > 0, 'missing_related_service_facts', 'relatedInvoiceRefs', '提供关联采购票的原始服务性质、尚未履约及用途事实');
          conflict(matches.some(x => ready.row(`invoice:${x.docId}`)?.status !== 'provided_valid') || relatedFacts.some(x => x.data.performance === 'completed' || x.data.nature === 'goods' || !['unknown', 'operating_service'].includes(x.data.purpose) || x.data.settlement === 'received'), 'relatedInvoiceRefs', '关联票的已履约、货物或资产/存货/个人用途与普通未来服务预付矛盾，请核对有效版本');
          ask(relatedFacts.every(x => x.data.performance === 'not_completed' && x.data.nature === 'service'), 'unknown_related_service_facts', 'relatedInvoiceRefs', '确认关联采购票实际为服务且期末尚未履约，未知性质/履约需要原始合同或验收依据');
          conflict(relatedFacts.some(x => x.data.benefitPeriod.state === 'known' && (x.data.benefitPeriod.from !== f.serviceStartDate || x.data.benefitPeriod.to !== f.serviceEndDate)), 'relatedInvoiceRefs.benefitPeriod', '关联票已知受益期与预付合同服务起止日不一致，请核对合同及原始声明');
        }
      }
    }
    if (kind !== 'service_prepayment') ask(assessment.declaration.tax?.vatStatus === 'small_scale', 'small_scale_required', 'tax.vatStatus', '由会计结合登记依据确认本期小规模身份，其他身份不适用本片规则');
    const status = problems.some(p => p.code.includes('conflict')) ? 'conflict' : problems.length ? 'needs_review' : 'candidate';
    const evidence = { materials: unique([record, ...linked, ...assessment.records.filter(x => x.docId === record.docId)].map(sourceRef)), businessFacts: group.map(x => x.source), declaration: { digest: assessment.declarationProvenance.rawDigest, fields: ['profile', 'businessScope', 'tax', 'evidence'], verification: 'local_statements_not_authenticated' }, planning: plan.tasks.find(t => t.taskId === `prepare:${inv ? record.docId : `bank:${record.docId}`}`)?.inputDigest ?? null };
    decisions.push({ subjectKey: record.docId, businessKey, kind, status, requirements: unique(problems), evidence, authorizesExecution: false });
    if (status !== 'candidate') return;
    const rule = structuredClone(RULE_CATALOG[kind]);
    const entries = createEntries(kind, r, profile.accounts, { amountSource: sourceRef(record) }).map(e => ({ ...e, factSources: evidence.businessFacts, declaration: evidence.declaration, ruleSources: structuredClone(rule.sources) }));
    const debit = entries.reduce((n, e) => n + offlineMoneyToCents(e.debit), 0n), credit = entries.reduce((n, e) => n + offlineMoneyToCents(e.credit), 0n);
    requireValue(debit === credit && debit > 0n, 'candidate_unbalanced');
    const candidate = { businessKey, kind, scope: input.scope, date: recognitionDate, status: 'candidate', authorizesExecution: false, rule, profile: profile.provenance, evidence, entries,
      recognition: { dateSource: kind === 'administrative_service' ? { kind: 'accounting_business_facts', field: 'completionDate', references: group.map(x => ({ fileSha256: x.source.fileSha256, sourceVersion: x.source.sourceVersion, pointer: x.source.fields.completionDate.pointer })) } : { kind: record.kind, field: 'date', references: [{ ...sourceRef(record), location: record.location.fields.date }] }, vatTriggerDate: kind === 'service_sale' ? r.date : null, vatAmountMeaning: kind === 'service_sale' ? 'initial_invoice_vat_not_final_return_or_exemption_transfer' : null, expenseRecognition: kind === 'service_prepayment' ? 'none_period_end_prepayment_asset' : kind === 'administrative_service' ? 'current_month_only' : null, existingLedgerVerified: false, targetDetailAndAuxiliarySelection: 'pending_formal_integration' } };
    candidate.contentVersion = versionOf(candidate); candidates.push(candidate);
  }
  for (const r of records) {
    const group = supplement.facts.filter(f => r.kind === 'invoice' ? sameRef(f.data.invoiceRef, r.data) : sameBank(f.data.bankRef, r.data));
    evaluate(r, group);
  }
  for (const fact of supplement.facts.filter(f => !used.has(f))) {
    const f = fact.data, key = f.invoiceRef ? invoiceKey(input.scope, f.invoiceRef) : f.bankRef ? paymentKey(input.scope, f.bankRef) : null;
    const docId = f.invoiceRef ? hash(stable(['invoice', input.scope.enterpriseKey, input.scope.accountSetId, stable([f.invoiceRef.sellerKey, f.invoiceRef.code, f.invoiceRef.number])])) : f.bankRef ? hash(stable(['bank_activity', input.scope.enterpriseKey, input.scope.accountSetId, stable([f.bankRef.bankAccountId, f.bankRef.refId])])) : null;
    const conflicts = ready.replayIssues.filter(i => i.status === 'conflict' && (i.affectedDocIds?.includes(docId) || i.affectedInvoiceRefs?.some(ref => sameRef(ref, f.invoiceRef))));
    decisions.push({ subjectKey: `fact:${f.factId}`, businessKey: key, kind: f.kind, status: conflicts.length ? 'conflict' : 'needs_review', requirements: [missing(conflicts.length ? 'planning_conflict' : 'referenced_material_missing_or_rejected', f.invoiceRef ? 'invoiceRef' : 'bankRef', conflicts.length ? '对应原始来源存在同一身份多个版本冲突，请核对有效原始版本及更正依据' : '补充相同范围且通过原文摘要和映射重验的对应原始发票/银行材料；损坏来源不能由业务声明替代')], evidence: { businessFacts: [fact.source], sourceConflicts: conflicts }, authorizesExecution: false });
  }
  // A collision never creates a second business ID or silently chooses one version.
  for (const key of new Set(candidates.map(c => c.businessKey))) {
    if (candidates.filter(c => c.businessKey === key).length < 2) continue;
    for (const d of decisions.filter(d => d.businessKey === key)) { d.status = 'conflict'; d.requirements.push(missing('business_key_conflict', 'contractId', '同一业务出现多个候选，请提供有效合同及逐笔关系')); }
    for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].businessKey === key) candidates.splice(i, 1);
  }
  const result = { version: BOOKKEEPING_VERSION, scope: input.scope, status: 'candidates_only', validationOnly: true, authorizesExecution: false, profile: profile.provenance, ruleVersion: BOOKKEEPING_RULE_VERSION, plan,
    sources: { materials: assessment.sources, accountingFacts: supplement }, decisions, candidates, changes: [], limitations: ['candidate_only_no_posting_or_period_completion', 'no_db_network_or_coordinator_bypass', 'ledger_not_read_or_verified', 'local_content_digests_not_authentication', 'accountant_production_rule_approval_pending', 'no_final_tax_or_exemption_income', 'detail_auxiliary_and_formal_idempotent_import_pending'] };
  result.changes = comparePrevious(input.previousCandidates ?? null, result);
  result.documentDigest = digestOf(result);
  return result;
}
