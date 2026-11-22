// 恢复导航只取固定工具与文档，不读取原件、异常正文或自由 recordType。
import {BASELINE_FACT_VALUES,BASELINE_FIELDS} from '../../../../06-workbench/server/business-baseline-contracts.mjs';
import {isIdentitySourceCountError} from '../../../../06-workbench/server/business-evidence.mjs';
export const DIRECT_MATERIAL_DIAGNOSTIC_TOOLS=new Set(['finance_baseline_materials','finance_prebook_review','finance_calculation_run','finance_vat_plan','finance_rules']);
const baselineContract=()=>[{code:'inspect_baseline_observation_contract',tool:'finance_record_contract',arguments:{recordType:'baseline'}}];
const schemaHints={required:['required field','补齐该字段；业务事实须来自实际材料。'],additionalProperties:['only declared properties','删除未声明字段，按当前工具 schema 重试。'],type:['declared type','按 schema 使用声明类型，不自动转换原值。'],enum:['declared enum','选用当前 schema 声明的枚举。'],const:['declared constant','使用 schema 声明的固定标识。']};
// 路径只保留 schema 中声明的键与数组序号；未知键可能就是姓名、税号，不能回显。
export function directSchemaDiagnostics(schema,problems,root='arguments'){
 const names=new Set(),arrays=new Set();
 const walk=node=>{if(!node||typeof node!=='object')return;for(const [key,value]of Object.entries(node.properties??{})){names.add(key);if(value.type==='array')arrays.add(key);}for(const value of Object.values(node))if(value&&typeof value==='object')Array.isArray(value)?value.forEach(walk):walk(value);};walk(schema);
 const all=Array.isArray(problems)?problems:[],visible=all.slice(0,6).map(problem=>{
  const tokens=String(problem.inputPointer??'').split('/').slice(1),safe=[];let previous;
  for(const token of tokens.slice(0,12)){const key=token.replaceAll('~1','/').replaceAll('~0','~');if(names.has(key)){safe.push(token);previous=key;}else if(arrays.has(previous)&&/^\d{1,4}$/.test(key)){safe.push(key);previous=undefined;}else{safe.push('<undeclared>');break;}}
  const inputPointer=safe.length?'/'+safe.join('/'):'',keyword=Object.hasOwn(schemaHints,problem.keyword)?problem.keyword:['anyOf','oneOf','not','if','format','pattern','minItems','maxItems','minLength','maxLength','minimum','maximum','uniqueItems','additionalItems'].includes(problem.keyword)?problem.keyword:'schema';
  const [expected,hint]=schemaHints[keyword]??['declared schema constraints','查看当前 schema 的格式、范围及互斥条件；值未被修改。'];
  return {field:root+inputPointer,inputPointer,keyword,expected,hint};
 });
 return {problems:visible,errorInventory:{total:all.length,shown:visible.length,omitted:all.length-visible.length}};
}
export function directErrorCode(code){
 return code==='invalid_arguments'||/^(?:finance|agency)_[a-z0-9_]+$/.test(code??'')?code:'finance_direct_call_failed';
}
export function voucherCorrectionDiagnostics(schema,problems,args){
 const invalidSources=problems.filter(problem=>isIdentitySourceCountError(problem,args?.businessEvidence?.mappings));
 const diagnostics=directSchemaDiagnostics(schema,problems);
 if(!invalidSources.length) return diagnostics;
 // 同一字段可能同时超过通用上限和 identity 上限。仅返回有界、去重的实际参数位置。
 const pointers=[...new Set(invalidSources.map(problem=>problem.inputPointer))];
 return {...diagnostics,nextSteps:[{
   code:'repair_identity_source_count',inputPointers:pointers.slice(0,6),total:pointers.length,
   hint:'逐项修正列出的 sources，每条 identity 只保留直接产生该参数原值的一处来源。金额取原始金额字段，日期取原始日期字段。对方及业务身份在 proof 或相应字段中说明。修正后按已核实的原件重试。'
 }]};
}
export function directInterpretationDiagnostics(value){
 const boundedIndex=index=>Number.isInteger(index)&&index>=0&&index<1000;
 if(!boundedIndex(value?.recordIndex)||!boundedIndex(value?.fieldIndex)||!BASELINE_FIELDS.includes(value?.field)||!['invalid_enum','source_value_conflict','field_not_interpretable'].includes(value?.reason))return undefined;
 // 允许值来自共享固定合同，异常中夹带的任意样本和自由说明不会透出。
 return {interpretation:{recordIndex:value.recordIndex,fieldIndex:value.fieldIndex,field:value.field,reason:value.reason,allowedValues:value.field==='creates_asset'?[true,false]:[...(BASELINE_FACT_VALUES[value.field]??[])]}};
}
function projectionRecovery(args){
 const target=args?.target,validTarget=Number.isSafeInteger(target?.accountSetId)&&target.accountSetId>0&&/^202[67]-(0[1-9]|1[0-2])$/.test(target?.period??'');
 const refs=(Array.isArray(args?.materialRefs)?args.materialRefs:[]).filter(ref=>/^\d{8}T\d{9}Z_[a-f0-9-]{36}$/.test(ref?.materialRef??'')&&/^[a-f0-9]{64}$/.test(ref?.snapshotDigest??'')).slice(0,12).map(({materialRef,snapshotDigest})=>({materialRef,snapshotDigest}));
 if(validTarget&&refs.length)return [{code:'inspect_original_material_reference_in_bounded_section',tool:'finance_baseline_materials',arguments:{target:{accountSetId:target.accountSetId,period:target.period},materialRefs:refs,section:args?.section==='coverage'?'facts':'coverage',limit:1},hint:'保留原成功引用，先定位有界明细，再沿实际 pagination.next 续读；失败当前调用不能充作新材料引用。'}];
 return baselineContract().map(step=>({...step,hint:'保留已成功的材料引用。按合同选择更少的观察字段，或分次查询 coverage/facts 并沿实际 next 续读。'}));
}
const guides={
 finance_calculation_run:[{code:'inspect_original_calculation_locally_before_retry',tool:'finance_period_review',skill:'internal-control-review/references/audit-support.md'}],
 finance_prebook_review:[{code:'inspect_prebook_contract_and_source_bindings',tool:'finance_record_contract',arguments:{recordType:'prebook'},skill:'prebook-review/SKILL.md'}],
 finance_tax_summary_calculate:[{code:'inspect_summary_contract_and_source_bindings',tool:'finance_record_contract',arguments:{recordType:'tax_summary'},skill:'tax-review/SKILL.md'}],
 finance_workpaper:[{code:'inspect_native_record_contracts_and_missing_evidence',tool:'finance_record_contract',skill:'journal-entry/SKILL.md'}],
 finance_tax_calculate:[{code:'inspect_native_record_contracts_and_tax_scope',tool:'finance_record_contract',skill:'tax-review/SKILL.md'}],
 finance_annual_workpaper:[{code:'inspect_provided_months_and_native_record_contracts',tool:'finance_record_contract',skill:'tax-period/references/close-management.md'}]
};
export function directRecovery(name,{code,status,args}={}){
 if(name==='voucher_correct'){
  const guide={tool:'skills_read',arguments:{resource:'reconciliation/references/voucher-correction.md'}};
  if(code==='finance_correction_correction_tax_receipt_required')return [{
    ...guide,code:'reconcile_tax_receipt_and_bank_dates',
    hint:'在已授权原件中找到对应完税凭据或缴款回单，按税种、所属期、金额和凭证号匹配银行扣款与原账。分别核对扣款日、税款入库日及原凭证采用的日期依据。若金额和凭证日期均有依据，保留原凭证并在对账说明列明两个日期及清算时差。证据仍有缺口时记录具体缺件并继续其余核对；单凭银行扣款日不能改写税款凭证日期。'
  }];
  if(code==='finance_correction_posting_correction_required')return [{
    ...guide,code:'verify_correction_posting_evidence',
    hint:'复读原凭证及已委托的原件。逐项核对 voucher_date、科目、每条非零借贷金额与 businessEvidence 的来源行列、转换和收付方向，确认 proof 指向同一笔业务。原件支持原账时保留并说明；确有错账时，按已核实的字段修正映射和分录，重新 inspect，再以新操作号提交修正后的参数。证据不足时列明待核字段并继续其余凭证。'
  }];
 }
 if(name==='finance_vat_plan'&&(code||status==='needs_inputs'||status==='unsupported'))return [{code:'inspect_vat_planning_evidence',tool:'finance_record_contract',arguments:{recordType:'vat_planning'},skill:'tax-period/SKILL.md'}];
 if(name==='finance_rules'&&['invalid_arguments','finance_input_invalid'].includes(code)){
  return [{code:'choose_policy_operation',tool:'finance_rules',hint:'在线检索传 action=search 和公开政策 query，或传 action=open 与官方 url。旧目录的 ruleId、revision、filters 只用于本机计算支持范围和历史版本。'}];
 }
 if(name==='finance_rules'&&['no_results','partial','unavailable'].includes(status)){
  return [{tool:'skills_read',arguments:{resource:'tax-review/references/official-policy.md'},hint:'核实来源状态。有候选时打开正文，缺少可用结果时用文号或其他公开政策词重查，或直接打开已知官方链接。正文及适用效力仍缺时标明待核。'}];
 }
 if(name==='finance_baseline_materials'&&code==='finance_baseline_projection_item_limit')return projectionRecovery(args);
 if(name==='finance_baseline_materials'&&code==='finance_baseline_interpretation_invalid')return baselineContract().map(step=>({...step,hint:'按 details.interpretation 找到观察产物中 records 的字段，核对原件位置和允许枚举，修正本机产物后重试。'}));
 if(typeof code==='string'&&(code.startsWith('finance_target_')||code==='finance_period_review_scope_conflict'||code==='finance_period_review_scope_unverified'))
  return [{code:'verify_configured_database_identity_and_selected_calls_locally',tool:'finance_period_review',skill:'internal-control-review/references/audit-support.md'}];
 if(name==='finance_baseline_materials'){
  if(/source_(?:changed|forbidden)|material_changed|generated_not_original|owner|scope|finance_memory_/.test(code??''))return [{code:'verify_original_scope_permission_and_outcome',action:'inspect_existing_local_binding_and_call_before_retry',hint:'先核实实际账套、权限、原件 SHA 和原调用终态，再决定补充本机观察或重试。'}];
  if(['invalid_arguments','finance_input_invalid'].includes(code)||/^finance_baseline_(?:observations_|input_|locator_|original_missing|field_)/.test(code??'')){
   return baselineContract().map(step=>({...step,hint:'按当前合同核对参数及获准目录。用宿主读取原件后写入本机观察产物，并传 inputPath。保留已成功的材料引用。'}));
  }
  return [];
 }
 if(name==='finance_calculation_run'&&['invalid_arguments','finance_input_invalid'].includes(code))return [{code:'correct_declared_calculation_arguments',action:'repair_reported_fields_using_current_tool_schema',hint:'按本次字段诊断修正 title、engine、script、sources；不盲重跑原脚本。'}];
 if(name==='finance_calculation_run'&&status==='failed')return [{code:'inspect_failed_calculation_record_locally',action:'inspect_original_record_and_local_execution_logs',hint:/source_changed|source_forbidden|execution_input_changed|method_source_changed/.test(code??'')?'沿本次 recordPath 在获准本机核原件、输入与脚本版本；完整性未核前不重跑。':'沿本次 recordPath 在获准本机查执行记录及 stdout.txt/stderr.txt，修正实际脚本或运行时；保留已有输出，不回传日志原文或盲重跑。'}];
 if(name==='finance_prebook_review'&&/^(?:invalid_arguments|finance_(?:input_invalid|prebook_(?:prepared_.*|json_invalid|source_.*|original_changed)))$/.test(code??'')){
  return guides.finance_prebook_review.map(step=>({...step,hint:'按账前合同核对原件位置、SHA 和观察值。用宿主生成 finance-prebook-input/2 JSON，放入 FINANCE_AUDIT_DIR/agent-materials，提交其绝对路径。'}));
 }
 const knownError=['invalid_arguments','finance_input_invalid'].includes(code)||/^(?:finance_(?:prebook|summary|calculation)_[a-z0-9_]+|agency_[a-z0-9_]+)$/.test(code??'');
 if(guides[name]&&(knownError||['partial','needs_inputs','unsupported','incomplete','failed'].includes(status)))return structuredClone(guides[name]);
 return [];
}
