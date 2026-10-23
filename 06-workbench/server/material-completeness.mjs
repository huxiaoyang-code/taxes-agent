// Pure, local planning evidence. No accounting, filesystem, authority or receipts.
import { preflightMaterials } from './offline-materials.mjs';
import { MATERIAL_VERSION, fields, requirePlainJson, requireValue, identifier, validateScope, hash, stable } from './offline-material-adapters.mjs';

export const COMPLETENESS_VERSION = 'material-completeness/1';
const same = (a, b) => stable(a) === stable(b);
const list = (v, max = 1000) => requireValue(Array.isArray(v) && v.length <= max, 'declaration_invalid');
const text = v => requireValue(typeof v === 'string' && v.trim().length > 0 && v.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(v), 'declaration_invalid');
const enumValue = (v, values) => requireValue(values.includes(v), 'declaration_invalid');
const unique = values => requireValue(new Set(values).size === values.length, 'declaration_invalid');

// A declaration is a raw local JSON document, not a claim that its attachments were verified.
export function validateDeclaration(raw, scope) {
  requirePlainJson(raw);
  fields(raw, ['version', 'scope'], ['profile', 'businessScope', 'enterpriseEvidenceIds', 'evidence', 'applicability', 'coverage', 'bankAccounts', 'tax', 'opening', 'history', 'bankFacts', 'materials']);
  requireValue(raw.version === 'offline-declaration/1'); validateScope(raw.scope); requireValue(same(raw.scope, scope), 'scope_mismatch');
  for (const key of ['profile', 'businessScope']) if (key in raw) text(raw[key]);
  for (const key of ['evidence', 'applicability', 'coverage', 'bankFacts', 'materials']) if (key in raw) list(raw[key]);
  const evidence = raw.evidence ?? [];
  for (const e of evidence) {
    fields(e, ['evidenceId', 'kind', 'scope', 'confirmedBy', 'basis']); identifier(e.evidenceId);
    enumValue(e.kind, ['customer_declaration', 'registration_reference', 'attachment_reference']);
    validateScope(e.scope); requireValue(same(e.scope, scope), 'scope_mismatch');
    fields(e.confirmedBy, ['name', 'role']); text(e.confirmedBy.name);
    enumValue(e.confirmedBy.role, ['owner', 'business_operator', 'accountant']); text(e.basis);
  }
  unique(evidence.map(e => e.evidenceId));
  const refs = ids => { list(ids, 100); unique(ids); ids.forEach(identifier); requireValue(ids.every(id => evidence.some(e => e.evidenceId === id)), 'declaration_invalid'); };
  if ('enterpriseEvidenceIds' in raw) refs(raw.enterpriseEvidenceIds);
  for (const a of raw.applicability ?? []) {
    fields(a, ['area', 'present', 'evidenceIds']); enumValue(a.area, ['payroll', 'assets']); requireValue(typeof a.present === 'boolean'); refs(a.evidenceIds);
  }
  unique((raw.applicability ?? []).map(a => a.area));
  for (const c of raw.coverage ?? []) {
    fields(c, ['kind', 'accountId', 'from', 'to', 'state', 'sourceIds', 'evidenceIds']);
    enumValue(c.kind, ['sales', 'purchase', 'bank']); enumValue(c.state, ['complete', 'partial', 'no_activity']);
    if (c.kind === 'bank') identifier(c.accountId); else requireValue(c.accountId === null);
    requireValue(typeof c.from === 'string' && typeof c.to === 'string' && /^20\d\d-(0[1-9]|1[0-2])$/.test(c.from) && /^20\d\d-(0[1-9]|1[0-2])$/.test(c.to) && c.from <= c.to);
    list(c.sourceIds, 100); unique(c.sourceIds); c.sourceIds.forEach(identifier); refs(c.evidenceIds);
  }
  unique((raw.coverage ?? []).map(c => `${c.kind}:${c.accountId}`));
  if (raw.bankAccounts) { fields(raw.bankAccounts, ['accountIds', 'evidenceIds']); list(raw.bankAccounts.accountIds, 100); unique(raw.bankAccounts.accountIds); raw.bankAccounts.accountIds.forEach(identifier); refs(raw.bankAccounts.evidenceIds); }
  if (raw.tax) { fields(raw.tax, ['vatStatus', 'filingFrequency', 'evidenceIds']); enumValue(raw.tax.vatStatus, ['small_scale', 'general', 'unknown']); enumValue(raw.tax.filingFrequency, ['monthly', 'quarterly', 'unknown']); refs(raw.tax.evidenceIds); }
  if (raw.opening) { fields(raw.opening, ['state', 'evidenceIds']); enumValue(raw.opening.state, ['new_zero', 'balances_required', 'unknown']); refs(raw.opening.evidenceIds); }
  if (raw.history) { fields(raw.history, ['state', 'evidenceIds']); enumValue(raw.history.state, ['first_period', 'prior_required', 'unknown']); refs(raw.history.evidenceIds); }
  for (const b of raw.bankFacts ?? []) {
    fields(b, ['bankAccountId', 'refId', 'nature', 'evidenceIds']); identifier(b.bankAccountId); text(b.refId);
    enumValue(b.nature, ['service_receipt', 'operating_payment', 'payroll', 'asset', 'unknown']); refs(b.evidenceIds);
  }
  // Multiple statements for one bank ID are retained for conflict detection.
  for (const m of raw.materials ?? []) { fields(m, ['area', 'format', 'evidenceIds']); enumValue(m.area, ['payroll', 'assets', 'opening', 'history']); text(m.format); refs(m.evidenceIds); }
  return raw;
}

export function replayReports(scope, reports) {
  validateScope(scope); list(reports, 100);
  const candidates = [], issues = [];
  for (let i = 0; i < reports.length; i++) {
    const report = reports[i];
    if (!report || report.version !== MATERIAL_VERSION || !same(report.scope, scope) || !Array.isArray(report.sources) || report.sources.length > 100) {
      issues.push({ id: `report:${i}`, status: 'provided_invalid', reason: 'report_scope_or_structure_invalid', inputs: [hash(stable(report))] }); continue;
    }
    for (let j = 0; j < report.sources.length; j++) {
      const s = report.sources[j]; let source;
      try {
        identifier(s.sourceId);
        requireValue(typeof s.rawContent === 'string' && hash(s.rawContent) === s.fileSha256, 'source_digest_invalid');
        source = { sourceId: s.sourceId, kind: s.kind, scope: s.scope, text: s.rawContent, fileSha256: hash(s.rawContent), mapping: s.mapping };
        const result = preflightMaterials({ scope, sources: [source] });
        requireValue(result.status !== 'rejected', result.errors[0]?.code);
        candidates.push(source);
      } catch (error) {
        issues.push({ id: `source:${i}:${j}`, sourceId: typeof s?.sourceId === 'string' ? s.sourceId : null, kind: s?.kind ?? null, status: error.code === 'material_kind_unsupported' ? 'unsupported' : 'provided_invalid', reason: 'source_replay_rejected', inputs: [hash(stable(s ?? null))] });
      }
    }
  }
  const groups = new Map();
  for (const s of candidates) { const group = groups.get(s.sourceId) ?? []; group.push(s); groups.set(s.sourceId, group); }
  const sources = [];
  for (const [id, group] of groups) {
    if (new Set(group.map(s => hash(stable(s)))).size > 1) {
      const affected = group.flatMap(s => preflightMaterials({ scope, sources: [s] }).records);
      issues.push({ id: `source-id:${id}`, sourceId: id, status: 'conflict', reason: 'source_id_has_multiple_versions', inputs: group.map(s => hash(stable(s))).sort(), affectedDocIds: [...new Set(affected.map(r => r.docId))], affectedInvoiceRefs: affected.filter(r => r.kind === 'business_fact').map(r => r.data.invoiceRef) });
    } else sources.push(group[0]);
  }
  requireValue(sources.length <= 100, 'sources_invalid');
  const result = sources.length ? preflightMaterials({ scope, sources }) : { sources: [], records: [] };
  requireValue(result.status !== 'rejected', 'sources_invalid');
  return { sources: result.sources, records: result.records, issues };
}

export function assessCompleteness(input) {
  requirePlainJson(input); fields(input, ['scope', 'reports', 'declaration']); validateScope(input.scope);
  const scope = input.scope, range = validateScope(scope), replay = replayReports(scope, input.reports);
  let declaration = {}, declarationError = false;
  if (input.declaration !== null) {
    try { declaration = validateDeclaration(input.declaration, scope); } catch { declarationError = true; }
  }
  const d = declaration, rows = [], evidence = d.evidence ?? [];
  const evidenceFor = v => (v?.evidenceIds ?? []).map(id => evidence.find(e => e.evidenceId === id)).filter(Boolean);
  const supportedEvidence = v => evidenceFor(v).some(e => e.kind !== 'attachment_reference');
  const ref = r => ({ sourceId: r.sourceId, sourceVersion: r.sourceVersion, docId: r.docId, semanticDigest: r.semanticDigest });
  const declarationRef = (name, v) => ({ declarationField: name, digest: hash(stable([v ?? null, evidenceFor(v)])) });
  const add = (id, status, reason, inputs = [], accepted = [], expectedCoverage = range, detail = {}) => {
    const row = { id, status, reason, inputs, acceptedMaterials: accepted, expectedCoverage, evidenceLevel: 'local_structural_or_declared_only', ...detail };
    rows.push(row); return row;
  };
  const context = { profile: d.profile ?? null, businessScope: d.businessScope ?? null, evidenceIds: d.enterpriseEvidenceIds ?? [] };
  const basic = declarationError ? 'provided_invalid' : !d.profile || !d.businessScope ? 'missing' : d.profile !== 'small-2011' || d.businessScope !== 'service-company' ? 'unsupported' : !supportedEvidence(context) ? 'unknown' : 'provided_valid';
  add('enterprise', basic, declarationError ? 'declaration_invalid_or_scope_mismatch' : 'explicit_enterprise_profile_and_business_scope_required', [declarationRef('enterprise', context), ...(declarationError ? [hash(stable(input.declaration))] : [])], ['本期企业身份、账套、service-company业务范围及small-2011准则的带确认者与依据的基础情况JSON']);
  for (const issue of replay.issues) add(issue.id, issue.status, issue.reason, issue.inputs, ['修复原CSV/业务JSON及显式映射后重新生成本机预检报告'], range, { subject: issue.sourceId ? `资料来源${issue.sourceId}` : '指定预检报告', requestedFields: ['有效原文、对应映射及范围；多版本时说明哪版有效及更正依据'], alternativeEvidence: ['原始登记和更正说明可辅助定位，不能替代来源重新预检'] });
  const accounts = d.bankAccounts;
  add('bank-accounts', !accounts ? 'missing' : !supportedEvidence(accounts) ? 'unknown' : 'provided_valid', 'all_bank_accounts_inventory_required', [declarationRef('bankAccounts', accounts)], ['本期全部银行账户清单或无银行账户的带依据声明']);
  const knownAccounts = new Set([...(accounts?.accountIds ?? []), ...replay.records.filter(r => r.kind === 'bank_activity').map(r => r.data.bankAccountId)]);
  for (const [kind, accountId] of [['sales', null], ['purchase', null], ...[...knownAccounts].sort().map(id => ['bank', id])]) {
    const c = (d.coverage ?? []).find(c => c.kind === kind && c.accountId === accountId);
    const relevant = replay.sources.filter(s => kind === 'bank' ? s.kind === 'bank_csv' && s.mapping.bankAccountId === accountId : s.kind === 'invoice_csv' && s.mapping.role === kind);
    const scoped = c && c.from === range.from && c.to === range.to;
    const refsValid = c && c.sourceIds.every(id => relevant.some(s => s.sourceId === id)) && relevant.every(s => c.sourceIds.includes(s.sourceId));
    let status = !c ? 'missing' : !supportedEvidence(c) ? 'unknown' : !scoped || !refsValid ? 'provided_invalid' : c.state === 'partial' ? 'missing' : c.state === 'no_activity' && relevant.length ? 'conflict' : c.state === 'complete' && !relevant.length ? 'missing' : 'provided_valid';
    const accountConflict = kind === 'bank' && accounts && !accounts.accountIds.includes(accountId);
    if (accountConflict) status = 'conflict';
    add(`coverage:${kind}:${accountId ?? 'all'}`, status, accountConflict ? 'bank_account_inventory_conflict' : 'rows_do_not_establish_full_period_coverage', [declarationRef('coverage', c), ...relevant.map(s => ({ sourceId: s.sourceId, sourceVersion: s.sourceVersion }))], ['覆盖完整申报期间的销项/进项清单或逐账户银行对账单'], range, { subject: kind === 'bank' ? `银行账户${accountId}的整期覆盖` : kind === 'sales' ? '本期销项资料覆盖' : '本期进项资料覆盖', requestedFields: ['覆盖起止月份、是否完整或无业务、对应来源编号及确认依据'], alternativeEvidence: ['注明期间和业务范围的登记清单；无业务时提供确认人及具体依据的声明'] });
  }
  const records = replay.records;
  const invoices = [...new Map(records.filter(r => r.kind === 'invoice').map(r => [r.docId, r])).values()];
  for (const inv of invoices) {
    const variants = records.filter(r => r.docId === inv.docId);
    const facts = records.filter(r => r.kind === 'business_fact' && ['sellerKey', 'code', 'number'].every(k => r.data.invoiceRef[k] === inv.data[k]));
    const meanings = facts.map(f => { const { factId, invoiceRef, ...meaning } = f.data; return stable(meaning); });
    const noActivity = (d.coverage ?? []).find(c => c.kind === inv.data.role && c.state === 'no_activity');
    const sourceConflicts = replay.issues.filter(i => i.affectedDocIds?.some(id => [inv.docId, ...facts.map(f => f.docId)].includes(id)) || i.affectedInvoiceRefs?.some(ref => ['sellerKey', 'code', 'number'].every(k => ref[k] === inv.data[k])));
    const conflict = noActivity || sourceConflicts.length > 0 || variants.some(r => r.duplicateStatus === 'conflict') || facts.some(f => f.duplicateStatus === 'conflict') || new Set(meanings).size > 1;
    const subject = `发票${inv.data.code ? inv.data.code + '/' : ''}${inv.data.number}（销方${inv.data.sellerKey}）`;
    add(`invoice:${inv.docId}`, conflict ? 'conflict' : 'provided_valid', noActivity ? 'no_activity_declaration_conflicts_with_records' : conflict ? 'invoice_or_business_statements_conflict' : 'invoice_structurally_valid_not_authenticity_verified', [...variants, ...facts].map(ref).concat(sourceConflicts.map(i => ({ sourceConflict: i.id, inputs: i.inputs })), noActivity ? [declarationRef('coverage', noActivity)] : []), ['原始发票CSV及同票事实更正说明，不要求会计分录'], range, { subject, requestedFields: [noActivity ? '核对无业务声明与已提供发票的矛盾，说明有效版本及依据' : '确认有效的票面版本及相互矛盾的业务事实，说明更正依据'], alternativeEvidence: ['对应原票和业务登记的核对说明；无法替代原始发票解析'] });
    const f = facts[0]?.data;
    let status = conflict ? 'conflict' : !f ? 'missing' : ['nature', 'performance', 'settlement'].some(k => f[k] === 'unknown') ? 'unknown' : f.nature !== 'service' ? 'unsupported' : 'provided_valid';
    if (inv.data.role === 'sales' && f?.settlement === 'paid' || inv.data.role === 'purchase' && f?.settlement === 'received') status = 'conflict';
    if (inv.data.role === 'purchase' && status === 'provided_valid') status = 'unknown';
    let reason = inv.data.role === 'purchase' ? 'purchase_use_service_beneficiary_and_benefit_period_need_detail' : 'service_nature_performance_date_and_settlement_required';
    if (inv.data.role === 'sales' && status === 'provided_valid' && (f.performance !== 'completed' || f.settlement !== 'unpaid')) {
      status = 'unknown'; reason = f.performance !== 'completed' ? 'performance_not_completed_recognition_requires_review' : 'settlement_allocation_bank_link_and_cross_period_details_required';
    }
    const requestedFields = !f ? ['实际业务日期、性质、履约状态、结算状态'] : conflict ? ['同票不同声明的日期、性质、履约或结算冲突及有效版本'] : ['nature', 'performance', 'settlement'].filter(k => f[k] === 'unknown').map(k => ({ nature: '业务性质', performance: '履约状态', settlement: '结算状态' })[k]);
    if (inv.data.role === 'purchase') requestedFields.push('实际用途、服务对象（办公日常或具体项目）、受益起止日');
    if (f && f.performance !== 'completed') requestedFields.push('实际完成日期、尚未完成的服务范围及验收情况');
    if (f && ['received', 'paid'].includes(f.settlement)) requestedFields.push('逐笔银行流水分配、部分结算与跨期情况');
    add(`business:${inv.docId}`, status, reason, facts.map(ref), ['business-facts/1原始业务事实JSON；按实际业务填报，不填写科目或税额'], range, { subject: `${subject}的${inv.data.role === 'sales' ? '销售' : '采购'}业务事实`, requestedFields, alternativeEvidence: ['注明对应票号、具体业务、确认人及依据的合同/验收/业务登记说明，供本机人员核对并录入事实；本片不自动解析附件'] });
    if (inv.data.status === 'red') add(`red:${inv.docId}`, 'unknown', 'original_invoice_and_prior_posting_not_verified', variants.map(ref), ['原票、红字对应关系及既有入账/红冲记录；本片尚不核验既有账务'], range, { subject: `${subject}的红字对应关系`, requestedFields: ['原票身份、原来源版本、既有入账及红冲情况'], alternativeEvidence: ['注明原票及红字票关系、确认人和依据的核对登记'] });
  }
  for (const f of records.filter(r => r.kind === 'business_fact' && r.referenceVerification === 'missing')) add(`unmatched:${f.docId}`, 'missing', 'referenced_invoice_missing', [ref(f)], ['明确引用票号/代码/销方的原始发票CSV'], range, { subject: `业务声明${f.data.factId}引用的发票${f.data.invoiceRef.number}（销方${f.data.invoiceRef.sellerKey}）`, requestedFields: ['被引用发票原始资料'], alternativeEvidence: ['对应发票登记清单可辅助核对；仍需本片支持的发票CSV'] });
  const banks = [...new Map(records.filter(r => r.kind === 'bank_activity').map(r => [r.docId, r])).values()];
  for (const b of banks) {
    const variants = records.filter(r => r.docId === b.docId);
    const facts = (d.bankFacts ?? []).filter(f => f.bankAccountId === b.data.bankAccountId && f.refId === b.data.refId);
    const accountConflict = accounts && !accounts.accountIds.includes(b.data.bankAccountId);
    const noActivity = (d.coverage ?? []).find(c => c.kind === 'bank' && c.accountId === b.data.bankAccountId && c.state === 'no_activity');
    const sourceConflicts = replay.issues.filter(i => i.affectedDocIds?.includes(b.docId));
    const conflict = accountConflict || noActivity || sourceConflicts.length > 0 || variants.some(r => r.duplicateStatus === 'conflict') || new Set(facts.map(f => f.nature)).size > 1;
    const f = facts[0];
    let status = conflict ? 'conflict' : !b.data.refId || b.duplicateStatus === 'suspected_duplicate' ? 'unknown' : !f || f.nature === 'unknown' || !supportedEvidence(f) ? 'unknown' : 'provided_valid';
    if (f && (f.nature === 'service_receipt' && b.data.direction !== 'inflow' || ['payroll', 'asset', 'operating_payment'].includes(f.nature) && b.data.direction !== 'outflow')) status = 'conflict';
    add(`bank:${b.docId}`, status, accountConflict ? 'bank_account_inventory_conflict' : noActivity ? 'no_activity_declaration_conflicts_with_records' : !b.data.refId ? 'bank_stable_id_missing_possible_duplicate' : 'bank_nature_requires_explicit_statement_not_summary_inference', [...variants.map(ref), ...facts.map(f => declarationRef('bankFact', f)), ...sourceConflicts.map(i => ({ sourceConflict: i.id, inputs: i.inputs })), ...(noActivity ? [declarationRef('coverage', noActivity)] : []), declarationRef('bankAccountMembership', { accountId: b.data.bankAccountId, listed: accounts ? accounts.accountIds.includes(b.data.bankAccountId) : null, evidenceIds: accounts?.evidenceIds ?? [] })], ['含稳定流水号的原始银行CSV及逐笔业务性质声明'], range, { subject: `银行账户${b.data.bankAccountId}、流水${b.data.refId || '编号缺失'}（${b.data.date}）`, requestedFields: accountConflict ? ['核对该账户为何未列入全部银行账户清单，确认归属并更正矛盾资料'] : noActivity ? ['核对无业务声明与已提供流水的矛盾，说明有效版本及依据'] : !b.data.refId ? ['银行稳定流水号及重复记录核对依据'] : ['逐笔收付业务性质、对应业务及确认依据'], alternativeEvidence: ['银行业务登记或收付款说明，注明账户、流水号、具体业务、确认人和依据；不根据流水摘要猜测性质'] });
  }
  for (const f of d.bankFacts ?? []) if (!banks.some(b => b.data.bankAccountId === f.bankAccountId && b.data.refId === f.refId)) add(`unmatched-bank:${hash(stable([f.bankAccountId, f.refId]))}`, 'missing', 'declared_payment_bank_record_missing', [declarationRef('bankFact', f)], ['与声明账户及流水号匹配的银行CSV'], range, { subject: `已声明银行账户${f.bankAccountId}、流水${f.refId}`, requestedFields: ['对应的原始银行流水记录'], alternativeEvidence: ['注明账户、流水号及确认依据的支付登记可辅助核对，仍需支持的银行CSV'] });
  for (const area of ['payroll', 'assets']) {
    const a = (d.applicability ?? []).find(a => a.area === area);
    const paymentFacts = (d.bankFacts ?? []).filter(f => f.nature === (area === 'assets' ? 'asset' : 'payroll'));
    const invoiceFacts = records.filter(r => r.kind === 'business_fact' && area === 'assets' && r.data.purpose === 'asset_related');
    const m = (d.materials ?? []).filter(m => m.area === area);
    const present = paymentFacts.length > 0 || invoiceFacts.length > 0;
    const status = a?.present === false && present ? 'conflict' : a?.present === false && supportedEvidence(a) ? 'not_applicable' : m.length ? 'unsupported' : a?.present || present ? 'missing' : 'unknown';
    add(area, status, area === 'payroll' ? 'payroll_payment_requires_payroll_register' : 'asset_payment_requires_use_acquisition_and_depreciation_basis', [declarationRef(area, a), ...paymentFacts.map(f => declarationRef('bankFact', f)), ...invoiceFacts.map(ref), ...m.map(x => declarationRef('material', x))], area === 'payroll' ? ['工资表、人员及期间明细、支付对应关系；或本期无雇员无工资的带依据声明（附件解析待后续）'] : ['资产用途、取得凭证、启用日期及折旧基础资料；或本期无资产的带依据声明（附件解析待后续）']);
  }
  const t = d.tax;
  const taxEvidence = evidenceFor(t).some(e => e.kind !== 'attachment_reference' && e.confirmedBy.role === 'accountant');
  add('tax', !t ? 'missing' : !taxEvidence || t.vatStatus === 'unknown' || t.filingFrequency === 'unknown' ? 'unknown' : 'provided_valid', 'accountant_tax_attributes_required_no_default', [declarationRef('tax', t)], ['会计确认的增值税身份及申报周期，税种/资格登记信息或明确登记依据；不要求先算税额'], range, { subject: '本期税务属性', requestedFields: [...(!t || t.vatStatus === 'unknown' ? ['增值税身份'] : []), ...(!t || t.filingFrequency === 'unknown' ? ['申报周期'] : []), ...(!taxEvidence ? ['会计确认人、角色及具体登记依据'] : [])], alternativeEvidence: ['税种或资格登记信息；会计注明登记来源和依据的确认说明，不限定税局下载'] });
  for (const area of ['opening', 'history']) {
    const v = d[area], materials = (d.materials ?? []).filter(m => m.area === area);
    const zero = v?.state === (area === 'opening' ? 'new_zero' : 'first_period');
    let status = !v ? 'missing' : !supportedEvidence(v) || v.state === 'unknown' ? 'unknown' : zero ? 'not_applicable' : materials.length ? 'unsupported' : 'missing';
    if (area === 'history' && zero && d.opening?.state !== 'new_zero' || area === 'opening' && zero && d.history?.state === 'prior_required') status = 'conflict';
    add(area, status, area === 'opening' ? 'opening_balances_or_supported_new_zero_required' : 'prior_period_history_or_supported_first_period_required', [declarationRef(area, v), ...(zero ? [declarationRef(area === 'opening' ? 'history' : 'opening', d[area === 'opening' ? 'history' : 'opening'])] : []), ...materials.map(m => declarationRef('material', m))], area === 'opening' ? ['首次建账期初余额及依据，或新设企业无期初资产负债的本机原始声明'] : ['前期结账/申报与调整登记依据，或新设首期无历史的本机原始声明；不限定税局下载']);
  }
  return { version: COMPLETENESS_VERSION, scope, rows, sources: replay.sources, records, declaration: d, declarationProvenance: { rawDigest: input.declaration === null ? null : hash(stable(input.declaration)), verification: 'local_declaration_only_attachments_unverified' }, validationOnly: true, authorizesExecution: false };
}
