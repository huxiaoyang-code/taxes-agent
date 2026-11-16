// 恢复导航只取固定工具与文档，不读取参数、原件、异常正文或自由 recordType。
const guides={
 finance_calculation_run:[{code:'inspect_original_calculation_locally_before_retry',tool:'finance_period_review',skill:'audit-support/SKILL.md'}],
 finance_prebook_review:[{code:'inspect_prebook_contract_and_source_bindings',tool:'finance_record_contract',arguments:{recordType:'prebook'},skill:'prebook-review/SKILL.md'}],
 finance_tax_summary_calculate:[{code:'inspect_summary_contract_and_source_bindings',tool:'finance_record_contract',arguments:{recordType:'tax_summary'},skill:'tax-review/SKILL.md'}],
 finance_workpaper:[{code:'inspect_native_record_contracts_and_missing_evidence',tool:'finance_record_contract',skill:'journal-entry/SKILL.md'}],
 finance_tax_calculate:[{code:'inspect_native_record_contracts_and_tax_scope',tool:'finance_record_contract',skill:'tax-review/SKILL.md'}],
 finance_annual_workpaper:[{code:'inspect_provided_months_and_native_record_contracts',tool:'finance_record_contract',skill:'close-management/SKILL.md'}]
};
export function directRecovery(name,{code,status}={}){
 if(typeof code==='string'&&(code.startsWith('finance_target_')||code==='finance_period_review_scope_conflict'||code==='finance_period_review_scope_unverified'))
  return [{code:'verify_configured_database_identity_and_selected_calls_locally',tool:'finance_period_review',skill:'audit-support/SKILL.md'}];
 const knownError=['invalid_arguments','finance_input_invalid'].includes(code)||/^(?:finance_(?:prebook|summary|calculation)_[a-z0-9_]+|agency_[a-z0-9_]+)$/.test(code??'');
 if(guides[name]&&(knownError||['partial','needs_inputs','unsupported','incomplete','failed'].includes(status)))return structuredClone(guides[name]);
 return [];
}
