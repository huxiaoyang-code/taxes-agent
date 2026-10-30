// 仅生成可转发的本机文本，绝不发送消息。
const REASONS = Object.freeze({
  declaration_invalid_or_scope_mismatch: '基础声明的格式或企业、账套、期间范围不一致，需要更正后核对',
  explicit_enterprise_profile_and_business_scope_required: '企业身份、业务范围、适用准则或确认依据尚未明确',
  report_scope_or_structure_invalid: '指定预检报告无法读取或其结构、企业账套期间不匹配',
  source_replay_rejected: '来源原文的摘要、映射或内容校验未通过',
  source_id_has_multiple_versions: '同一资料来源存在不同版本，尚未确认有效版本',
  all_bank_accounts_inventory_required: '尚缺本期全部银行账户的明确清单或确认依据',
  bank_account_inventory_conflict: '已有流水的账户未列入全部银行账户清单，账户归属声明相互矛盾',
  no_activity_declaration_conflicts_with_records: '无业务声明与已提供的票据或流水相互矛盾',
  rows_do_not_establish_full_period_coverage: '现有明细不能证明覆盖本期全部业务，需核对期间、来源或无业务依据',
  invoice_or_business_statements_conflict: '同一发票的票面内容或对应业务声明相互矛盾',
  service_nature_performance_date_and_settlement_required: '实际业务日期、性质、履约或结算情况尚有缺项或矛盾',
  purchase_use_service_beneficiary_and_benefit_period_need_detail: '采购用途、服务对象或受益期间尚不明确，无法判断资料所属业务',
  performance_not_completed_recognition_requires_review: '服务尚未完成，需澄清实际履约范围和日期',
  settlement_allocation_bank_link_and_cross_period_details_required: '已收付情况尚缺逐笔流水分配、部分结算或跨期说明',
  original_invoice_and_prior_posting_not_verified: '红字票对应的原票及既有入账、红冲情况尚未核对',
  referenced_invoice_missing: '业务声明所引用的发票尚未提供',
  bank_stable_id_missing_possible_duplicate: '流水缺少稳定编号，尚不能排除重复记录',
  bank_nature_requires_explicit_statement_not_summary_inference: '银行流水的业务性质或确认依据尚不明确，或现有声明相互矛盾',
  declared_payment_bank_record_missing: '已声明的收付款缺少对应银行流水',
  payroll_payment_requires_payroll_register: '需核对本期是否有工资业务；存在工资支付时仍需工资明细，附件也须人工核对',
  asset_payment_requires_use_acquisition_and_depreciation_basis: '需核对本期资产情况；存在资产取得或付款时仍需用途、启用及折旧基础资料',
  accountant_tax_attributes_required_no_default: '缺少会计确认的增值税身份、申报周期或登记依据，不能采用默认值',
  opening_balances_or_supported_new_zero_required: '缺少期初余额依据或新设无期初资产负债的确认，不能把缺资料当零',
  prior_period_history_or_supported_first_period_required: '缺少前期结账、申报及调整依据，或首期无历史的确认',
});
const BASICS = Object.freeze({
  enterprise: ['企业基础情况', ['企业身份、账套、期间、业务范围、适用准则及确认依据']],
  'bank-accounts': ['本期全部银行账户清单', ['所有账户编号，或无银行账户的具体依据']],
  payroll: ['本期工资业务', ['是否有雇员和工资业务；有业务时提供工资期间、人员明细及支付对应关系']],
  assets: ['本期资产业务', ['是否持有或取得资产；有业务时提供用途、取得凭证、启用日期及折旧基础']],
  tax: ['本期税务属性', ['会计确认的增值税身份、申报周期、税种资格登记依据']],
  opening: ['本账套期初资料', ['首次建账期初余额及依据，或新设无期初资产负债的具体依据']],
  history: ['本账套历史资料', ['前期结账、申报和调整记录，或新设首期无历史的具体依据']],
});
const CLASSIFICATIONS = Object.freeze({ provided_invalid: '资料校验未通过', missing: '缺少资料', conflict: '资料相互矛盾', unknown: '待澄清', unsupported: '当前格式或业务不支持' });

export function buildCustomerDataRequest(scope, matrix, tasks) {
  const requests = matrix.filter(row => !['provided_valid', 'not_applicable'].includes(row.status)).map(row => {
    const affected = tasks.filter(t => t.requirements.includes(row.id)), basic = BASICS[row.id];
    return {
      requestId: row.id, scope, classification: row.status, missingFactOrMaterial: row.subject ?? basic?.[0] ?? '指定业务资料',
      requestedFields: row.requestedFields?.length ? row.requestedFields : basic?.[1] ?? ['核对具体缺项及确认依据'],
      reason: row.reason, reasonText: REASONS[row.reason] ?? '现有资料尚不能完成本机完整性核对',
      affectedTaskIds: affected.map(t => t.taskId), affectedTasks: affected.map(t => ({ taskId: t.taskId, goal: t.goal })),
      acceptedMaterials: row.acceptedMaterials,
      alternativeEvidence: row.alternativeEvidence ?? ['带确认人、角色、具体业务范围和依据的登记说明；本机人员核对后按支持格式录入，附件不视为已解析'],
      expectedCoverage: row.expectedCoverage,
      verification: row.status === 'unsupported' ? 'format_not_parsed_attachments_unverified' : 'requires_local_review',
    };
  });
  return { version: 'customer-data-request/1', scope, requests, delivery: 'local_only_not_sent',
    forwardableText: [`企业：${scope.enterpriseKey}；账套：${scope.accountSetId}；期间：${typeof scope.period === 'string' ? scope.period : `${scope.period.from}至${scope.period.to}`}。`,
      '请补充下列原始业务资料或带确认人和依据的情况声明；不需要先制作会计分录、凭证或计算税额。',
      ...requests.map((r, i) => `${i + 1}. ${r.missingFactOrMaterial}（${CLASSIFICATIONS[r.classification]}）。需补充或澄清：${r.requestedFields.join('；')}。原因：${r.reasonText}。可接收资料：${r.acceptedMaterials.join('；')}。登记替代依据：${r.alternativeEvidence.join('；')}。期望覆盖：${r.expectedCoverage.from}至${r.expectedCoverage.to}。影响：${[...new Set(r.affectedTasks.map(t => t.goal))].join('、') || '整期完整性核对'}。`),
      '上述清单仅在本机生成，尚未发送；不表示附件真实性已经核验或会计已审定。'].join('\n') };
}
