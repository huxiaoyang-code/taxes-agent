// An explanatory preparation DAG, deliberately separate from #77 execution contracts.
import { assessCompleteness } from './material-completeness.mjs';
import { buildCustomerDataRequest } from './customer-data-request.mjs';
import { fields, requirePlainJson, requireValue, hash, stable } from './offline-material-adapters.mjs';

export const PLAN_VERSION = 'offline-preparation-plan/1';
export const RULE_VERSIONS = Object.freeze({ core: '1', sales: '1', purchase: '1', bank: '1', payroll: '1', assets: '1', opening: '1', history: '1', tax: '1', post: '1', close: '1', compute_tax: '1', review: '1', period: '1' });
const statusFor = rows => rows.some(r => r.status === 'conflict') ? 'blocked_conflict'
  : rows.some(r => r.status === 'provided_invalid') ? 'blocked_invalid_data'
    : rows.some(r => r.status === 'unsupported') ? 'blocked_unsupported'
      : rows.some(r => r.status === 'missing') ? 'blocked_missing_data'
        : rows.some(r => r.status === 'unknown') ? 'blocked_unknown' : 'ready';
const signature = p => hash(stable({ version: p.version, scope: p.scope, tasks: p.tasks.map(t => [t.taskId, t.inputDigest]) }));

export function comparePlans(previous, current) {
  if (previous === null) return { invalidated: [], unchanged: [], added: current.tasks.map(t => ({ taskId: t.taskId, reason: 'new_task' })), removed: [] };
  requirePlainJson(previous);
  requireValue(previous.version === PLAN_VERSION && stable(previous.scope) === stable(current.scope) && previous.authorizesExecution === false && previous.validationOnly === true && !('executionReceipt' in previous), 'previous_plan_invalid');
  requireValue(Array.isArray(previous.tasks) && previous.tasks.length <= 10000, 'previous_plan_invalid');
  requireValue(previous.tasks.every(t => typeof t.taskId === 'string' && /^[a-f0-9]{64}$/.test(t.inputDigest) && ['ready', 'not_applicable', 'blocked_conflict', 'blocked_invalid_data', 'blocked_unsupported', 'blocked_missing_data', 'blocked_unknown'].includes(t.status) && !('executionReceipt' in t)), 'previous_plan_invalid');
  requireValue(new Set(previous.tasks.map(t => t.taskId)).size === previous.tasks.length && signature(previous) === previous.planVersion, 'previous_plan_invalid');
  const old = new Map(previous.tasks.map(t => [t.taskId, t])), now = new Map(current.tasks.map(t => [t.taskId, t]));
  return {
    invalidated: current.tasks.filter(t => old.has(t.taskId) && old.get(t.taskId).inputDigest !== t.inputDigest).map(t => ({ taskId: t.taskId, reason: 'local_evidence_scope_rule_or_dependency_changed' })),
    unchanged: current.tasks.filter(t => old.get(t.taskId)?.inputDigest === t.inputDigest).map(t => ({ taskId: t.taskId, reason: 'same_inputs_no_completion_reused' })),
    added: current.tasks.filter(t => !old.has(t.taskId)).map(t => ({ taskId: t.taskId, reason: 'new_task' })),
    removed: previous.tasks.filter(t => !now.has(t.taskId)).map(t => ({ taskId: t.taskId, reason: 'input_removed' })),
  };
}

export function planOffline(input, options = {}) {
  requirePlainJson(input); fields(input, ['scope', 'reports', 'declaration'], ['previousPlan']);
  requirePlainJson(options); fields(options, [], ['ruleVersions']);
  const rules = { ...RULE_VERSIONS };
  if (options.ruleVersions) { fields(options.ruleVersions, [], Object.keys(rules)); for (const [k, v] of Object.entries(options.ruleVersions)) { requireValue(typeof v === 'string' && /^\d+$/.test(v)); rules[k] = v; } }
  const assessment = assessCompleteness({ scope: input.scope, reports: input.reports, declaration: input.declaration });
  const matrix = assessment.rows, byId = new Map(matrix.map(r => [r.id, r])), tasks = [];
  const add = (taskId, operation, goal, requirements, deps, reason, rule, extraRisks = []) => {
    const selected = requirements.map(id => byId.get(id)); requireValue(selected.every(Boolean), 'requirements_invalid');
    const parents = deps.map(id => tasks.find(t => t.taskId === id)); requireValue(parents.every(Boolean), 'dependencies_invalid');
    const classifications = { blocked_conflict: 'conflict', blocked_invalid_data: 'provided_invalid', blocked_unsupported: 'unsupported', blocked_missing_data: 'missing', blocked_unknown: 'unknown' };
    const status = statusFor([...selected, ...parents.map(t => ({ status: classifications[t.status] ?? 'provided_valid' }))]);
    const task = { taskId, operation, goal, requirements, inputs: selected.flatMap(r => r.inputs), deps, applicabilityReason: reason,
      missing: selected.filter(r => !['provided_valid', 'not_applicable'].includes(r.status)).map(r => ({ requirementId: r.id, classification: r.status, reason: r.reason })),
      risks: ['declarations_not_independently_verified', 'preparation_only_no_execution_authority', ...extraRisks],
      artifact: { kind: operation === 'assess_period' ? 'unexecuted_period_plan' : 'business_evidence_packet', produced: false }, accountingEligibility: 'not_assessed',
      status, blockedByTasks: parents.filter(t => !['ready', 'not_applicable'].includes(t.status)).map(t => ({ taskId: t.taskId, status: t.status })), inputDigest: hash(stable({ scope: input.scope, rule: [rule, rules[rule]], requirements: selected, deps: parents.map(t => [t.taskId, t.inputDigest]) })), ruleVersion: rules[rule], authorizesExecution: false };
    tasks.push(task); return task;
  };
  add('enterprise', 'prepare_enterprise_context', '核对企业、业务范围及准则', ['enterprise'], [], '所有分支需要明确本企业本账套本期范围', 'core');
  add('tax', 'prepare_tax_attributes', '准备会计确认的税务属性', ['enterprise', 'tax'], ['enterprise'], '不预设小规模或申报周期', 'tax');
  const invoices = [...new Map(assessment.records.filter(r => r.kind === 'invoice').map(r => [r.docId, r])).values()];
  for (const inv of invoices) {
    const sales = inv.data.role === 'sales';
    const reqs = ['enterprise', 'tax', `invoice:${inv.docId}`, `business:${inv.docId}`];
    if (inv.data.status === 'red') reqs.push(`red:${inv.docId}`);
    add(`prepare:${inv.docId}`, sales ? 'prepare_service_sale_materials' : 'clarify_purchase_use', sales ? '整理已履约未结算服务销售资料包' : '澄清采购实际用途及受益对象', reqs, ['enterprise', 'tax'], '逐票资料可独立整理；收款权利、主营性质及纳税义务等会计规则事实另待评估', sales ? 'sales' : 'purchase', sales ? ['collection_right_main_or_other_business_and_vat_trigger_not_assessed'] : []);
  }
  for (const row of matrix.filter(r => r.id.startsWith('bank:'))) {
    const record = assessment.records.find(r => r.docId === row.id.slice(5));
    const facts = (assessment.declaration.bankFacts ?? []).filter(f => f.bankAccountId === record.data.bankAccountId && f.refId === record.data.refId);
    const reqs = ['enterprise', row.id];
    if (facts.some(f => f.nature === 'payroll')) reqs.push('payroll');
    if (facts.some(f => f.nature === 'asset')) reqs.push('assets');
    add(`prepare:${row.id}`, 'prepare_bank_activity', '整理已明确性质的银行业务候选', reqs, ['enterprise'], '只采用明确的业务声明，不猜测摘要', 'bank', ['no_invoice_payment_allocation_implemented']);
  }
  for (const area of ['payroll', 'assets', 'opening', 'history']) {
    const t = add(area, `prepare_${area}`, `准备${({ payroll: '工资', assets: '资产', opening: '期初', history: '历史' })[area]}资料分支`, ['enterprise', area], ['enterprise'], '由本期事实及带依据适用性声明决定', area);
    if (byId.get(area).status === 'not_applicable' && byId.get('enterprise').status === 'provided_valid') t.status = 'not_applicable';
  }
  const preparationIds = tasks.map(t => t.taskId);
  const future = (id, goal, requirements, deps) => {
    const t = add(id, id, goal, requirements, deps, '后续会计阶段尚未实现，资料包可整理不授予执行权限', id, [`${id}_not_implemented`]);
    if (t.status === 'ready') t.status = 'blocked_unknown';
    t.implementationStatus = 'not_implemented';
    t.artifact = { kind: `${id}_not_produced`, produced: false };
    t.missing.push({ requirementId: `implementation:${id}`, classification: 'unknown', reason: `${id}_not_implemented_no_authority_or_receipt` });
  };
  future('post', '等待会计规则评估与真实过账', ['enterprise', 'tax', 'opening', 'history'], preparationIds);
  future('close', '等待真实结转与结账', ['enterprise', 'opening', 'history'], ['post', 'opening', 'history']);
  future('compute_tax', '等待真实税务计算', ['enterprise', 'tax', 'history'], ['post', 'tax', 'history']);
  future('review', '等待真实结果复核与版本确认', ['enterprise'], ['close', 'compute_tax']);
  const final = add('period', 'assess_period', '核对整期材料并等待后续真实执行', matrix.map(r => r.id), ['review', ...preparationIds], '整期必须同时满足覆盖、历史、税属性及全部业务分支', 'period', ['accounting_execution_not_implemented', 'coordinator_lock_recovery_dependencies_pending']);
  if (final.status === 'ready') final.status = 'blocked_unknown';
  final.missing.push({ requirementId: 'execution', classification: 'unknown', reason: 'no_accounting_execution_or_receipt_implemented' });
  const plan = { version: PLAN_VERSION, scope: input.scope, validationOnly: true, authorizesExecution: false, status: 'planning_only', rules,
    matrix, tasks, normalization: { performed: true, sources: assessment.sources.length, records: assessment.records.length, verification: 'report_snapshot_replayed_not_live_original_file' },
    declarationProvenance: assessment.declarationProvenance };
  plan.planVersion = signature(plan);
  for (const t of tasks) t.planVersion = plan.planVersion;
  plan.changes = comparePlans(input.previousPlan ?? null, plan);
  plan.customerRequest = buildCustomerDataRequest(input.scope, matrix, tasks);
  return plan;
}
