// 恢复导航只取固定工具与文档，不读取原件、异常正文或自由 recordType。
import {BASELINE_FACT_VALUES,BASELINE_FIELDS} from '../../../../06-workbench/server/business-baseline-contracts.mjs';
const baselineTools=new Set(['finance_baseline_materials','finance_baseline_save','finance_baseline_read']);
export const DIRECT_MATERIAL_DIAGNOSTIC_TOOLS=new Set([...baselineTools,'finance_calculation_run']);
const baselineContract=(adaptation=false)=>[{code:adaptation?'inspect_local_history_adaptation_contract':'inspect_baseline_material_mapping_contract',tool:'finance_record_contract',arguments:{recordType:adaptation?'baseline_adaptation':'baseline'}}];
const schemaHints={required:['required field','补齐该字段；业务事实须来自实际材料。'],additionalProperties:['only declared properties','删除未声明字段，按当前工具 schema 重试。'],type:['declared type','按 schema 使用声明类型，不自动转换原值。'],enum:['declared enum','选用当前 schema 声明的枚举。'],const:['declared constant','使用 schema 声明的固定标识。']};
// 路径只保留 schema 中声明的键与数组序号；未知键可能就是姓名、税号，不能回显。
export function directSchemaDiagnostics(schema,problems){
 const names=new Set(),arrays=new Set();
 const walk=node=>{if(!node||typeof node!=='object')return;for(const [key,value]of Object.entries(node.properties??{})){names.add(key);if(value.type==='array')arrays.add(key);}for(const value of Object.values(node))if(value&&typeof value==='object')Array.isArray(value)?value.forEach(walk):walk(value);};walk(schema);
 const all=Array.isArray(problems)?problems:[],visible=all.slice(0,6).map(problem=>{
  const tokens=String(problem.inputPointer??'').split('/').slice(1),safe=[];let previous;
  for(const token of tokens.slice(0,12)){const key=token.replaceAll('~1','/').replaceAll('~0','~');if(names.has(key)){safe.push(token);previous=key;}else if(arrays.has(previous)&&/^\d{1,4}$/.test(key)){safe.push(key);previous=undefined;}else{safe.push('<undeclared>');break;}}
  const inputPointer=safe.length?'/'+safe.join('/'):'',keyword=Object.hasOwn(schemaHints,problem.keyword)?problem.keyword:['anyOf','oneOf','not','if','format','pattern','minItems','maxItems','minLength','maxLength','minimum','maximum','uniqueItems','additionalItems'].includes(problem.keyword)?problem.keyword:'schema';
  const [expected,hint]=schemaHints[keyword]??['declared schema constraints','查看当前 schema 的格式、范围及互斥条件；值未被修改。'];
  return {field:'arguments'+inputPointer,inputPointer,keyword,expected,hint};
 });
 return {problems:visible,errorInventory:{total:all.length,shown:visible.length,omitted:all.length-visible.length}};
}
export function directErrorCode(code){
 return /^(?:(?:finance|agency|material_document|xlsx|ocr)_[a-z0-9_]+)$/.test(code??'')?code:'finance_direct_call_failed';
}
export function directInterpretationDiagnostics(value){
 if(!Number.isInteger(value?.selectionIndex)||value.selectionIndex<0||value.selectionIndex>=400||!BASELINE_FIELDS.includes(value?.field)||!['invalid_enum','source_value_conflict','field_not_interpretable'].includes(value?.reason))return undefined;
 // 允许值来自共享固定合同，异常中夹带的任意样本和自由说明不会透出。
 return {interpretation:{selectionIndex:value.selectionIndex,field:value.field,reason:value.reason,allowedValues:value.field==='creates_asset'?[true,false]:[...(BASELINE_FACT_VALUES[value.field]??[])]}};
}
function projectionRecovery(args){
 const target=args?.target,validTarget=Number.isSafeInteger(target?.accountSetId)&&target.accountSetId>0&&/^202[67]-(0[1-9]|1[0-2])$/.test(target?.period??'');
 const refs=[...(Array.isArray(args?.materialRefs)?args.materialRefs:[]),...(args?.sourceCursor?[args.sourceCursor]:[])].filter(ref=>/^\d{8}T\d{9}Z_[a-f0-9-]{36}$/.test(ref?.materialRef??'')&&/^[a-f0-9]{64}$/.test(ref?.snapshotDigest??'')).slice(0,12).map(({materialRef,snapshotDigest})=>({materialRef,snapshotDigest}));
 if(validTarget&&refs.length)return [{code:'inspect_original_material_reference_in_bounded_section',tool:'finance_baseline_materials',arguments:{target:{accountSetId:target.accountSetId,period:target.period},materialRefs:refs,section:args?.section==='coverage'?'facts':'coverage',limit:1},hint:'保留原成功引用，先定位有界明细，再沿实际 pagination.next 续读；失败当前调用不能充作新材料引用。'}];
 const original=(Array.isArray(args?.originals)?args.originals:[]).find(item=>/^bs:[a-f0-9]{64}$/.test(item?.originalRef??''));
 if(validTarget&&original)return [{code:'inspect_original_structure_with_bounded_page',tool:'finance_baseline_materials',arguments:{target:{accountSetId:target.accountSetId,period:target.period},originals:[{id:'source',originalRef:original.originalRef}],section:'structure',limit:1},hint:'原调用引用保持不变，先查单份原件结构并沿实际 next 续页；不重建或删减成功事实。'}];
 return baselineContract().map(step=>({...step,hint:'单项投影仍超预算。保留原调用的成功引用，按合同改查 coverage/facts 或单份原件结构并沿真实 next 续读；不把失败调用当新材料引用。'}));
}
const guides={
 finance_calculation_run:[{code:'inspect_original_calculation_locally_before_retry',tool:'finance_period_review',skill:'audit-support/SKILL.md'}],
 finance_prebook_review:[{code:'inspect_prebook_contract_and_source_bindings',tool:'finance_record_contract',arguments:{recordType:'prebook'},skill:'prebook-review/SKILL.md'}],
 finance_tax_summary_calculate:[{code:'inspect_summary_contract_and_source_bindings',tool:'finance_record_contract',arguments:{recordType:'tax_summary'},skill:'tax-review/SKILL.md'}],
 finance_workpaper:[{code:'inspect_native_record_contracts_and_missing_evidence',tool:'finance_record_contract',skill:'journal-entry/SKILL.md'}],
 finance_tax_calculate:[{code:'inspect_native_record_contracts_and_tax_scope',tool:'finance_record_contract',skill:'tax-review/SKILL.md'}],
 finance_annual_workpaper:[{code:'inspect_provided_months_and_native_record_contracts',tool:'finance_record_contract',skill:'close-management/SKILL.md'}]
};
export function directRecovery(name,{code,status,args}={}){
 if(name==='finance_baseline_materials'&&code==='finance_baseline_projection_item_limit')return projectionRecovery(args);
 if(name==='finance_baseline_materials'&&code==='finance_baseline_interpretation_invalid')return baselineContract().map(step=>({...step,hint:'按 details.interpretation.selectionIndex 定位原 selections，核对 field、reason 及 allowedValues；仅映射受限语义，不改原值或自填金额、日期。'}));
 if(typeof code==='string'&&(code.startsWith('finance_target_')||code==='finance_period_review_scope_conflict'||code==='finance_period_review_scope_unverified'))
  return [{code:'verify_configured_database_identity_and_selected_calls_locally',tool:'finance_period_review',skill:'audit-support/SKILL.md'}];
 if(baselineTools.has(name)||name==='finance_calculation_run'&&/^(?:finance_baseline_|material_document_|xlsx_|ocr_)/.test(code??'')){
  if(/commit_unknown|revision_conflict|restore_unverified|readonly|source_(?:changed|forbidden)|material_changed|generated_not_original|reading_restricted|owner|scope|finance_memory_/.test(code??''))return [{code:'verify_original_scope_permission_and_outcome',action:'inspect_existing_local_binding_and_call_before_retry',hint:'先核实实际账套、权限、原件SHA及原调用终态；不盲重试保存或以适配绕过。'}];
  if(['invalid_arguments','finance_input_invalid'].includes(code)||/^(?:material_document_|xlsx_|ocr_|finance_baseline_(?:adaptation_|input_|locator_|selection_|original_missing|field_|principle_|evidence_missing|support_not_returned|effective_period_invalid))/.test(code??'')){
   const hint=/adaptation_/.test(code??'')?'按合同核对实际成功调用、固定产物、原件位置及失配行；只重试失败部分。':/locator|selection|field|input|arguments|principle|evidence|support|effective/.test(code??'')?'按当前 schema 与实际结构修正所列字段或位置；金额、日期不自填。':'内置读取失败可按合同使用已有本机计算工具适配；保留成功材料。';
   return baselineContract(/^(?:material_document_|xlsx_|ocr_|finance_baseline_adaptation_)/.test(code??'')).map(step=>({...step,hint}));
  }
  return [];
 }
 if(name==='finance_calculation_run'&&['invalid_arguments','finance_input_invalid'].includes(code))return [{code:'correct_declared_calculation_arguments',action:'repair_reported_fields_using_current_tool_schema',hint:'按本次字段诊断修正 title、engine、script、sources；不盲重跑原脚本。'}];
 if(name==='finance_calculation_run'&&status==='failed')return [{code:'inspect_failed_calculation_record_locally',action:'inspect_original_record_and_local_execution_logs',hint:/source_changed|source_forbidden|execution_input_changed|method_source_changed/.test(code??'')?'沿本次 recordPath 在获准本机核原件、输入与脚本版本；完整性未核前不重跑。':'沿本次 recordPath 在获准本机查执行记录及 stdout.txt/stderr.txt，修正实际脚本或运行时；保留已有输出，不回传日志原文或盲重跑。'}];
 const knownError=['invalid_arguments','finance_input_invalid'].includes(code)||/^(?:finance_(?:prebook|summary|calculation)_[a-z0-9_]+|agency_[a-z0-9_]+)$/.test(code??'');
 if(guides[name]&&(knownError||['partial','needs_inputs','unsupported','incomplete','failed'].includes(status)))return structuredClone(guides[name]);
 return [];
}
