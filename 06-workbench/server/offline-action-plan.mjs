// Candidate preparation façade. No accounting rules, DB, network or execution receipts.
import { assessCompleteness, replayReports } from './material-completeness.mjs';
import { planOffline } from './offline-task-planner.mjs';
import { buildOfflineCandidates } from './offline-bookkeeping.mjs';
import { parseAccountingFacts, sameRef, sameBank } from './offline-accounting-readiness.mjs';
import { BOOKKEEPING_RULE_VERSION, RULE_CATALOG } from './offline-voucher-rules.mjs';
import { buildCustomerDataRequest } from './customer-data-request.mjs';
import { assertOfflineActionPayload, assertOfflineActionInputCurrent, offlineActionSessionPayload, offlineActionSessionEvidence } from './offline-action-input.mjs';
import { fields, requirePlainJson, requireValue, stable, hash, validateScope } from './offline-material-adapters.mjs';

export const ACTION_PLAN_VERSION = 'offline-action-plan/1';
const ordered = xs => xs.map(x => stable(x)).sort().map(x => JSON.parse(x));
const unique = xs => [...new Map(xs.map(x => [stable(x), x])).values()];
const semanticRecord = r => ({ kind: r.kind, docId: r.docId, data: r.data, duplicateStatus: r.duplicateStatus, referenceVerification: r.referenceVerification ?? null });
const digestDocument = p => { const { planVersion, ...rest } = p; return hash(stable(rest)); };
const taskStatuses = ['candidate_preparation_ready', 'needs_review', 'conflict', 'unsupported', 'provided_invalid', 'missing', 'unknown', 'not_applicable', 'blocked_not_implemented'];
const request = (code, field, requestedFact) => ({ code, field, requestedFact });
const factLabels = { benefitFrom: '全部受益开始日', benefitTo: '全部受益结束日', benefitBasis: '仅当月受益的业务依据', purpose: '实际用途', nonAsset: '是否属于资产及判断依据', nonProjectCost: '是否属于项目成本及判断依据', mainService: '是否属于企业主营服务', ordinaryService: '是否属于普通服务', serviceStartDate: '服务开始日', serviceEndDate: '服务结束日', completionDate: '实际完成日', collectionRightDate: '取得收款权利的实际日期', refundThroughPeriodEnd: '截至期末是否退款及对应依据', performanceThroughPeriodEnd: '截至期末实际履约情况', otherRecognitionInProvidedMaterials: '已提供资料中是否另有该合同的费用或资产确认', paymentCount: '合同实际支付次数', relatedInvoiceRefs: '合同关联发票清单（无票也请明确）' };
function specificProblem(p, own) {
  const keys = p.field.split('/'), f = own[0]?.data;
  if (!f) return p;
  const missingKeys = keys.filter(k => f[k] === undefined || f[k] === 'unknown');
  if (!missingKeys.length || !missingKeys.every(k => factLabels[k])) return p;
  return { ...p, field: missingKeys.join('/'), requestedFact: `请补充${missingKeys.map(k => factLabels[k]).join('、')}及确认人和原始依据` };
}
const kindGoal = { service_sale: '准备普通主营服务销售候选', administrative_service: '准备当月行政服务采购候选', service_prepayment: '准备未来服务预付款候选', related_purchase_evidence: '核对预付合同关联采购票' };
function identity(scope, r) {
  return r.kind === 'invoice' ? `invoice:${hash(stable([scope.enterpriseKey, scope.accountSetId, r.data.sellerKey, r.data.code, r.data.number]))}`
    : `prepayment:${hash(stable([scope.enterpriseKey, scope.accountSetId, r.data.bankAccountId, r.data.refId]))}`;
}
function classification(p, facts, record, declaration, materials) {
  if (p.code.includes('conflict')) return 'conflict';
  if (p.code === 'planning_provided_invalid' || p.code === 'source_not_current') return 'provided_invalid';
  if (p.code === 'planning_unsupported' || p.code === 'profile_unsupported') return 'unsupported';
  if (p.code === 'planning_unknown' || p.code === 'unknown_related_service_facts') return 'unknown';
  if (p.code === 'planning_missing' || p.code === 'missing_business_facts' || p.code === 'referenced_material_missing_or_rejected' || p.code === 'profile_missing') return 'missing';
  if (['missing_related_invoice', 'missing_related_service_facts'].includes(p.code)) return 'missing';
  if (p.code === 'small_scale_required') return !declaration.tax || declaration.tax.vatStatus === 'unknown' ? 'unknown' : 'unsupported';
  if (p.code === 'complex_performance_or_settlement') {
    const raw = materials.filter(x => x.kind === 'business_fact' && record?.kind === 'invoice' && sameRef(x.data.invoiceRef, record.data));
    if (!raw.length) return 'missing';
    return raw.some(x => ['nature', 'performance', 'settlement'].some(k => x.data[k] === 'unknown')) ? 'unknown' : 'unsupported';
  }
  // Old requirements mix missing facts with known unsupported values. Inspect actual values.
  const keys = p.field.split('/');
  const values = keys.map(k => facts[0]?.data[k] ?? record?.data[k]);
  if (values.some(v => v === undefined)) return 'missing';
  if (values.some(v => v === 'unknown')) return 'unknown';
  if (p.code === 'missing_administrative_use') return 'unsupported';
  if (p.code.startsWith('unsupported_') || ['red_invoice_review', 'zero_tax_or_net_review', 'complex_performance_or_settlement', 'completion_outside_scope', 'performance_review', 'refund_review', 'multiple_payments_review', 'duplicate_recognition_review'].includes(p.code)) return 'unsupported';
  return 'needs_review';
}
function compare(previous, current) {
  if (previous === null) return { added: current.tasks.map(t => t.taskId), removed: [], invalidated: [], unchanged: [] };
  requirePlainJson(previous);
  requireValue(previous.version === ACTION_PLAN_VERSION && stable(previous.scope) === stable(current.scope) && previous.authorizesExecution === false && previous.periodComplete === false && previous.validationOnly === true && previous.status === 'preparation_only' && !('executionReceipt' in previous) && digestDocument(previous) === previous.planVersion, 'previous_action_plan_invalid');
  requireValue(Array.isArray(previous.tasks) && previous.tasks.length <= 10000 && new Set(previous.tasks.map(t => t.taskId)).size === previous.tasks.length, 'previous_action_plan_invalid');
  for (const t of previous.tasks) requireValue(typeof t.taskId === 'string' && /^[a-f0-9]{64}$/.test(t.dependencyDigest) && taskStatuses.includes(t.status) && t.authorizesExecution === false && t.periodComplete === false && t.completed === false && !('executionReceipt' in t), 'previous_action_plan_invalid');
  const old = new Map(previous.tasks.map(t => [t.taskId, t])), now = new Set(current.tasks.map(t => t.taskId));
  return { added: current.tasks.filter(t => !old.has(t.taskId)).map(t => t.taskId), removed: previous.tasks.filter(t => !now.has(t.taskId)).map(t => t.taskId), invalidated: current.tasks.filter(t => old.has(t.taskId) && old.get(t.taskId).dependencyDigest !== t.dependencyDigest).map(t => t.taskId), unchanged: current.tasks.filter(t => old.get(t.taskId)?.dependencyDigest === t.dependencyDigest).map(t => t.taskId) };
}

export function buildOfflineActionPlan(input) {
  assertOfflineActionPayload(input); requirePlainJson(input);
  fields(input, ['scope', 'reports', 'declaration', 'accountingFacts', 'profileId'], ['previousPlan', 'diagnostics', 'rejectedRecords']);
  const range = validateScope(input.scope), base = { scope: input.scope, reports: input.reports, declaration: input.declaration };
  const assessment = assessCompleteness(base), oldPlan = planOffline(base), replay = replayReports(input.scope, input.reports);
  const diagnostics = structuredClone(input.diagnostics ?? []); let supplement;
  if (input.accountingFacts !== null) {
    try { supplement = parseAccountingFacts(input.accountingFacts, input.scope); }
    catch { diagnostics.push({ status: 'provided_invalid', reason: 'accounting_facts_invalid', source: input.accountingFacts }); }
  }
  const facts = supplement?.facts ?? [], d = assessment.declaration, matrix = structuredClone(assessment.rows);
  const emptyText = JSON.stringify({ version: 'offline-accounting-facts/1', scope: input.scope, facts: [] });
  const profileSupported = input.profileId === 'small-2011-basic-v1';
  const candidatesResult = profileSupported ? buildOfflineCandidates({ ...base, profileId: input.profileId, accountingFacts: supplement ? input.accountingFacts : { text: emptyText, fileSha256: hash(emptyText) } }) : null;
  const evidenceFor = value => (value?.evidenceIds ?? []).map(id => d.evidence?.find(e => e.evidenceId === id)).filter(Boolean);
  const withEvidence = value => ({ value: value ?? null, evidence: ordered(evidenceFor(value)) });
  const enterprise = { profileId: input.profileId, profile: d.profile ?? null, businessScope: d.businessScope ?? null, evidence: ordered((d.enterpriseEvidenceIds ?? []).map(id => d.evidence?.find(e => e.evidenceId === id)).filter(Boolean)), status: matrix.find(r => r.id === 'enterprise').status };
  const tasks = [];
  const add = (taskId, operation, goal, status, requirements, deps, local, details = {}) => {
    const parents = deps.map(id => tasks.find(t => t.taskId === id)); requireValue(parents.every(Boolean), 'action_dependencies_invalid');
    const task = { taskId, operation, goal, status, requirements, deps, blockedByTasks: parents.filter(t => !['candidate_preparation_ready', 'not_applicable'].includes(t.status)).map(t => t.taskId), authorizesExecution: false, periodComplete: false, completed: false,
      dependencyDigest: hash(stable({ version: ACTION_PLAN_VERSION, scope: input.scope, local, deps: parents.map(t => [t.taskId, t.dependencyDigest]) })), ...details };
    tasks.push(task); return task;
  };
  const contextStatus = matrix.find(r => r.id === 'enterprise').status;
  add('enterprise', 'prepare_enterprise_context', '核对企业、业务范围与准则', !profileSupported ? input.profileId == null ? 'missing' : 'unsupported' : contextStatus === 'provided_valid' ? 'candidate_preparation_ready' : contextStatus, ['enterprise', ...(!profileSupported ? ['profile'] : [])], [], enterprise);
  if (!profileSupported) matrix.push({ id: 'profile', status: input.profileId == null ? 'missing' : 'unsupported', reason: 'explicit_profile_required', subject: '企业适用的会计准则及科目方案', requestedFields: ['由会计根据企业实际情况确认适用的准则与科目方案；不要求制作分录'], acceptedMaterials: ['带会计确认人和登记依据的基础情况JSON'], expectedCoverage: range, inputs: [input.profileId] });
  const tax = matrix.find(r => r.id === 'tax');
  add('tax', 'prepare_tax_attributes', '核对会计确认的税务属性', tax.status === 'provided_valid' ? 'candidate_preparation_ready' : tax.status, ['tax'], [], withEvidence(d.tax));

  const allRecords = [...assessment.records, ...(input.rejectedRecords ?? [])];
  const records = [...new Map(allRecords.filter(r => ['invoice', 'bank_activity'].includes(r.kind)).map(r => [r.docId, r])).values()];
  const decisions = candidatesResult?.decisions ?? records.map(r => {
    const ids = r.kind === 'invoice' ? ['enterprise', 'tax', `invoice:${r.docId}`, `business:${r.docId}`] : ['enterprise', 'bank-accounts', `bank:${r.docId}`];
    const gates = ids.map(id => matrix.find(row => row.id === id)).filter(row => row && !['provided_valid', 'not_applicable'].includes(row.status));
    return { businessKey: identity(input.scope, r), subjectKey: r.docId, kind: r.kind === 'invoice' ? r.data.role === 'sales' ? 'service_sale' : 'administrative_service' : 'service_prepayment', status: gates.some(row => row.status === 'conflict') ? 'conflict' : 'needs_review', requirements: [request(input.profileId == null ? 'profile_missing' : 'profile_unsupported', 'profileId', '请会计按企业实际情况确认适用的准则与科目方案'), ...gates.map(row => request(`planning_${row.status}`, row.id, row.requestedFields?.join('；') || '提供对应原始资料及确认依据'))] };
  });
  // Rejected receipt branches remain visible even when no valid source yields a decision.
  for (const r of records) if (!decisions.some(x => x.businessKey === identity(input.scope, r))) decisions.push({ businessKey: identity(input.scope, r), subjectKey: r.docId, kind: r.kind === 'invoice' ? r.data.role === 'sales' ? 'service_sale' : 'administrative_service' : 'service_prepayment', status: 'needs_review', requirements: [] });
  const candidates = [];
  for (const key of [...new Set(decisions.map(x => x.businessKey ?? x.subjectKey))].sort()) {
    const ds = decisions.filter(x => (x.businessKey ?? x.subjectKey) === key), r = records.find(x => identity(input.scope, x) === key), own = facts.filter(f => r ? r.kind === 'invoice' ? sameRef(f.data.invoiceRef, r.data) : sameBank(f.data.bankRef, r.data) : ds.some(x => x.subjectKey === `fact:${f.data.factId}`));
    const linkedPrepay = r?.kind === 'invoice' && r.data.role === 'purchase' ? facts.filter(f => f.data.kind === 'service_prepayment' && f.data.relatedInvoiceRefs?.some(ref => sameRef(ref, r.data))) : [];
    const kind = linkedPrepay.length ? 'related_purchase_evidence' : ds[0].kind;
    const seeds = unique([...own, ...linkedPrepay]);
    const sameFactIds = new Set(seeds.map(f => f.data.factId));
    // One-hop actual relationships match the existing admission gates; no whole-file hashes.
    const relatedFacts = facts.filter(f => sameFactIds.has(f.data.factId) || seeds.some(o => o.data.contractId && f.data.contractId === o.data.contractId && (f.data.supplierKey === (o.data.kind === 'service_prepayment' ? o.data.supplierKey : r?.kind === 'invoice' ? r.data.role === 'sales' ? r.data.buyerKey : r.data.sellerKey : o.data.supplierKey) || f.data.invoiceRef?.sellerKey === (o.data.kind === 'service_prepayment' ? o.data.supplierKey : r?.kind === 'invoice' ? r.data.role === 'sales' ? r.data.buyerKey : r.data.sellerKey : o.data.supplierKey))) || r?.kind === 'invoice' && f.data.relatedInvoiceRefs?.some(ref => sameRef(ref, r.data)));
    const refs = relatedFacts.flatMap(f => [...(f.data.relatedInvoiceRefs ?? []), ...(f.data.invoiceRef ? [f.data.invoiceRef] : [])]);
    const materials = allRecords.filter(x => r && x.docId === r.docId || x.kind === 'business_fact' && r?.kind === 'invoice' && sameRef(x.data.invoiceRef, r.data) || x.kind === 'invoice' && refs.some(ref => sameRef(ref, x.data)) || x.kind === 'business_fact' && refs.some(ref => sameRef(ref, x.data.invoiceRef)) || x.kind === 'bank_activity' && relatedFacts.some(f => sameBank(f.data.bankRef, x.data)));
    const sourceIds = new Set(materials.map(x => x.sourceId));
    const issues = replay.issues.filter(i => sourceIds.has(i.sourceId) || i.affectedDocIds?.some(id => materials.some(x => x.docId === id)) || i.affectedInvoiceRefs?.some(ref => refs.some(rf => sameRef(ref, rf))));
    const localDiagnostics = diagnostics.filter(x => sourceIds.has(x.sourceId) || x.reason === 'accounting_facts_invalid' || x.reason === 'accountingFacts_read_invalid');
    let problems = unique(ds.flatMap(x => x.requirements));
    if (linkedPrepay.length) {
      // A future-service purchase supports its payment. Administrative completion/use
      // questions are inapplicable even while the payment needs a specific fact.
      problems = unique(linkedPrepay.flatMap(f => {
        const bankRecord = records.find(x => x.kind === 'bank_activity' && sameBank(f.data.bankRef, x.data));
        const ownerKey = identity(input.scope, bankRecord ?? { kind: 'bank_activity', data: f.data.bankRef });
        return decisions.filter(x => x.businessKey === ownerKey).flatMap(x => x.requirements).map(p => ({ ...p, requestBusinessKey: ownerKey }));
      }));
      const invoiceRow = matrix.find(row => row.id === `invoice:${r.docId}`);
      if (invoiceRow && invoiceRow.status !== 'provided_valid') problems.push({ ...request(`planning_${invoiceRow.status}`, invoiceRow.id, invoiceRow.requestedFields?.join('；') || '核对关联发票原件及更正依据'), classification: invoiceRow.status });
    }
    if (localDiagnostics.length) problems.push(request('source_not_current', 'originals', '对应原始资料或业务事实当前校验未通过，请核对有效原件、范围和更正依据'));
    const currentCandidate = candidatesResult?.candidates.find(x => x.businessKey === key);
    const relatedReady = linkedPrepay.length && !localDiagnostics.length && !issues.length && linkedPrepay.every(f => candidatesResult?.candidates.some(c => c.kind === 'service_prepayment' && sameBank(f.data.bankRef, records.find(x => identity(input.scope, x) === c.businessKey)?.data)));
    if (relatedReady) problems = [];
    const classified = problems.map(p => {
      const effectiveFacts = p.requestBusinessKey ? linkedPrepay.filter(f => identity(input.scope, { kind: 'bank_activity', data: f.data.bankRef }) === p.requestBusinessKey) : own;
      const effectiveRecord = p.requestBusinessKey ? records.find(x => identity(input.scope, x) === p.requestBusinessKey) : r;
      const specific = specificProblem(p, effectiveFacts);
      return { ...specific, ...(p.code === 'small_scale_required' && d.tax?.vatStatus === 'general' ? { requestedFact: '已声明的一般纳税人身份不适用当前票据候选规则，请会计按实际身份另行处理并保留登记依据' } : {}), classification: classification(specific, effectiveFacts, effectiveRecord, d, materials) };
    });
    let status = currentCandidate && !problems.length || relatedReady ? 'candidate_preparation_ready' : ['conflict', 'provided_invalid', 'unsupported', 'missing', 'unknown', 'needs_review'].find(s => classified.some(p => p.classification === s)) ?? 'needs_review';
    if (ds.some(x => x.status === 'conflict')) status = 'conflict';
    if (linkedPrepay.length && !relatedReady && status === 'candidate_preparation_ready') status = 'needs_review';
    const reqs = ['enterprise', ...(!profileSupported ? ['profile'] : []), ...(r?.kind === 'invoice' ? [...(linkedPrepay.length ? ['bank-accounts'] : ['tax']), `invoice:${r.docId}`, `business:${r.docId}`] : ['bank-accounts', ...(r ? [`bank:${r.docId}`] : [])])];
    const taskId = `prepare:${key}`;
    const bankFacts = (d.bankFacts ?? []).filter(b => materials.some(x => x.kind === 'bank_activity' && sameBank(b, x.data)));
    const noActivity = (d.coverage ?? []).filter(c => c.state === 'no_activity' && materials.some(x => x.kind === 'invoice' ? c.kind === x.data.role : x.kind === 'bank_activity' && c.kind === 'bank' && c.accountId === x.data.bankAccountId));
    const memberships = materials.filter(x => x.kind === 'bank_activity').map(x => ({ accountId: x.data.bankAccountId, listed: d.bankAccounts ? d.bankAccounts.accountIds.includes(x.data.bankAccountId) : null, evidence: evidenceFor(d.bankAccounts) }));
    const local = { kind, profileId: input.profileId, rule: RULE_CATALOG[ds[0].kind], ruleVersion: BOOKKEEPING_RULE_VERSION, materials: ordered(materials.map(semanticRecord)), facts: ordered(relatedFacts.map(f => f.data)), bankFacts: ordered(bankFacts.map(withEvidence)), memberships: ordered(memberships), noActivity: ordered(noActivity.map(withEvidence)), issues, diagnostics: localDiagnostics, status, problems: ordered(classified) };
    const t = add(taskId, 'prepare_candidate', kindGoal[kind], status, reqs, r?.kind === 'invoice' && !linkedPrepay.length ? ['enterprise', 'tax'] : ['enterprise'], local, { businessKey: key, kind, subject: r?.kind === 'invoice' ? `发票${r.data.number}（销方${r.data.sellerKey}）` : r ? `银行账户${r.data.bankAccountId}、流水${r.data.refId}` : `业务事实${own.map(f => f.data.factId).join('、')}`, reasons: classified, trace: { materials, accountingFacts: relatedFacts, decisionEvidence: ds.map(x => x.evidence ?? null), sourceIssues: issues, diagnostics: localDiagnostics }, candidate: status === 'candidate_preparation_ready' && !linkedPrepay.length ? currentCandidate ?? null : null, artifact: { kind: linkedPrepay.length ? 'related_purchase_evidence' : 'bookkeeping_candidate', produced: !!currentCandidate && status === 'candidate_preparation_ready' && !linkedPrepay.length } });
    if (t.candidate) candidates.push(t.candidate);
    const resolvedRow = r && matrix.find(row => row.id === (r.kind === 'invoice' ? `business:${r.docId}` : `bank:${r.docId}`));
    if (resolvedRow && linkedPrepay.length) { resolvedRow.accountingPurpose = 'prepayment_related_evidence'; resolvedRow.customerRequestSuperseded = true; }
    if (resolvedRow && resolvedRow.status === 'unknown' && status === 'candidate_preparation_ready' && (resolvedRow.reason === 'purchase_use_service_beneficiary_and_benefit_period_need_detail' || resolvedRow.reason === 'bank_nature_requires_explicit_statement_not_summary_inference')) {
      resolvedRow.originalAssessment = structuredClone(resolvedRow); resolvedRow.status = 'provided_valid'; resolvedRow.reason = linkedPrepay.length ? 'related_prepayment_evidence_currently_valid' : 'complete_current_accounting_facts_admitted'; resolvedRow.requestedFields = []; resolvedRow.resolvedByTaskId = taskId; resolvedRow.accountingFactTrace = relatedFacts;
    }
    // Replace the broad old use/nature question with the exact current requirements.
    const originalBusiness = allRecords.filter(x => x.kind === 'business_fact' && r?.kind === 'invoice' && sameRef(x.data.invoiceRef, r.data));
    const resolvableUse = originalBusiness.length && originalBusiness.every(x => x.data.nature === 'service' && x.data.performance === 'completed' && x.data.settlement === 'unpaid' && ['unknown', 'operating_service'].includes(x.data.purpose));
    if (resolvedRow?.status === 'unknown' && own.length && (resolvedRow.reason === 'purchase_use_service_beneficiary_and_benefit_period_need_detail' && resolvableUse || resolvedRow.reason === 'bank_nature_requires_explicit_statement_not_summary_inference' && r?.data.direction === 'outflow' && r.data.refId)) {
      resolvedRow.originalAssessment = structuredClone(resolvedRow); resolvedRow.requestedFields = unique(classified.filter(p => !p.code.startsWith('planning_')).map(p => p.requestedFact));
      if (resolvedRow.requestedFields.length) { resolvedRow.reason = 'current_specific_business_facts_required'; resolvedRow.customerRequestSuperseded = true; }
    }
    for (let i = 0; i < classified.length; i++) {
      const p = classified[i]; if (p.code.startsWith('planning_') && matrix.some(row => row.id === p.field)) continue;
      if (['profile_missing', 'profile_unsupported'].includes(p.code)) continue;
      if (p.code === 'source_not_current') { t.requirements.push(...localDiagnostics.map(x => `input-diagnostic:${diagnostics.indexOf(x)}`)); continue; }
      if (p.code === 'small_scale_required' && (!d.tax || d.tax.vatStatus === 'unknown')) {
        tax.sharedConditions ??= []; tax.sharedConditions.push({ taskId, reason: p.code, actualVatStatus: d.tax?.vatStatus ?? null, trace: t.trace }); continue;
      }
      const requestKey = p.requestBusinessKey ?? key;
      const id = `prepare:${requestKey}:request:${hash(stable([p.code, p.field]))}`; t.requirements.push(id);
      const operatorOnly = localDiagnostics.length > 0 && localDiagnostics.every(x => x.reason === 'receipt_store_locked');
      matrix.push({ id, businessKey: requestKey, requestedFieldKey: p.field.split('/').sort().join('/'), operatorOnly, status: p.classification === 'needs_review' ? 'unknown' : p.classification, reason: p.code, subject: t.subject, requestedFields: [p.classification === 'unsupported' ? `请保留实际业务事实并提供核对依据：${p.requestedFact}；现有明确事实不适用当前自动候选规则，需要会计另行处理` : p.requestedFact], acceptedMaterials: ['原始发票CSV或受限XLSX、银行CSV、原始业务JSON及带确认人和依据的事实JSON（按所涉业务提供）'], alternativeEvidence: ['注明票号或账户流水、合同、实际情况、确认人和依据的合同/验收/登记说明，供本机人员核对录入；附件未自动解析'], expectedCoverage: range, inputs: [t.trace] });
    }
  }
  for (const area of ['bank-accounts', 'payroll', 'assets', 'opening', 'history']) {
    const row = matrix.find(r => r.id === area);
    // These are period context gates, not dependencies of independent transactions.
    add(area, `prepare_${area}`, ({ 'bank-accounts': '核对全部银行账户', payroll: '核对工资资料', assets: '核对资产资料', opening: '核对期初资料', history: '核对历史资料' })[area], row.status === 'provided_valid' ? 'candidate_preparation_ready' : row.status, [area], [], row);
  }
  for (let i = 0; i < diagnostics.length; i++) {
    const x = diagnostics[i], id = `input-diagnostic:${i}`;
    matrix.push({ id, status: 'provided_invalid', reason: x.reason, subject: x.sourceId ? `资料来源${x.sourceId}` : '指定本机资料', requestedFields: [x.reason.includes('locked') || x.writerBlocked ? '本机操作者核对资料接收状态后重新读取；已有锁不由客户处理' : '核对当前原始资料、企业期间、映射及有效版本；补充更正依据'], acceptedMaterials: ['相同企业期间的有效原始CSV/XLSX/JSON及原始登记说明'], expectedCoverage: range, inputs: [x], operatorOnly: x.reason.includes('locked') || !!x.writerBlocked });
  }
  const preparationIds = tasks.map(t => t.taskId);
  for (const [id, deps, goal] of [['post', preparationIds, '等待正式过账实现及真实回执'], ['close', ['post'], '等待正式结转结账'], ['compute_tax', ['post', 'tax', 'history'], '等待账务结果及本计划接入税务计算'], ['review', ['close', 'compute_tax'], '等待账务结果及本计划接入结果复核']]) add(id, id, goal, 'blocked_not_implemented', [], deps, { implementation: 'not_integrated_in_action_plan' }, { implementationStatus: 'not_integrated_in_action_plan', implementationScope: 'this_preparation_facade_only', externalCapability: ['compute_tax', 'review'].includes(id) ? 'existing_narrow_vat_and_review_apis_require_separate_fresh_ledger_workflow' : 'formal_post_close_chain_pending', artifact: { produced: false, kind: `${id}_not_produced` } });
  add('period', 'assess_period', '核对整期资料及真实后续结果', 'blocked_not_implemented', matrix.map(r => r.id), ['review', ...preparationIds], { matrix, execution: 'not_implemented' }, { implementationStatus: 'not_implemented' });
  // Old plan remains diagnostic trace; its old customer requests are never presented as current.
  const requestRows = [], requestGroups = new Map();
  for (const row of matrix.filter(r => !r.operatorOnly && !r.customerRequestSuperseded)) {
    const key = row.businessKey ? stable([row.businessKey, row.requestedFieldKey, row.expectedCoverage]) : row.id;
    if (!requestGroups.has(key)) { const group = { ...row, requirementIds: [row.id], reasons: [row.reason, ...(row.sharedConditions ?? []).map(x => x.reason)], inputs: [...row.inputs, ...(row.sharedConditions ?? [])] }; requestGroups.set(key, group); requestRows.push(group); }
    else { const group = requestGroups.get(key); group.requirementIds.push(row.id); group.reasons.push(row.reason); group.inputs.push(...row.inputs); group.requestedFields = unique([...group.requestedFields, ...row.requestedFields]); }
  }
  const customerRequest = buildCustomerDataRequest(input.scope, requestRows, tasks);
  for (const r of customerRequest.requests) {
    const row = requestRows.find(x => x.id === r.requestId); r.requirementIds = row.requirementIds; r.reasonCodes = unique(row.reasons); r.inputs = row.inputs;
  }
  const result = { version: ACTION_PLAN_VERSION, scope: input.scope, status: 'preparation_only', validationOnly: true, authorizesExecution: false, periodComplete: false, authenticity: 'unverified', matrix, tasks, candidates, customerRequest, diagnostics,
    sources: { materials: assessment.sources, accountingFacts: supplement ?? input.accountingFacts, declaration: input.declaration }, provenance: { mode: 'supplied_bytes_replayed_not_live_files', oldAssessment: assessment.rows, oldPreparationTasks: oldPlan.tasks, rawDeclarationDigest: assessment.declarationProvenance.rawDigest }, changes: null };
  result.changes = compare(input.previousPlan ?? null, result); result.planVersion = digestDocument(result); return result;
}

export async function buildOfflineActionPlanFromFiles(session) {
  const input = offlineActionSessionPayload(session);
  await assertOfflineActionInputCurrent(session); const result = buildOfflineActionPlan(input); await assertOfflineActionInputCurrent(session);
  result.provenance.mode = 'explicit_local_files_revalidated_at_call'; result.provenance.fileEvidence = offlineActionSessionEvidence(session); result.planVersion = digestDocument(result); return result;
}
