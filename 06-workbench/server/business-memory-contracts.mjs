// 企业方法只披露结构化业务含义；原科目码、文件名、自由正文和脚本保留在本机。
import { CALCULATION_SCHEMA } from './finance-calculation.mjs';

const text={type:'string',minLength:1,maxLength:8000};
const period={type:'string',pattern:'^202[67]-(0[1-9]|1[0-2])$'};
const ref={type:'string',pattern:'^bm:[a-f0-9-]{36}$'};
const digest={type:'string',pattern:'^[a-f0-9]{64}$'};
const programField={type:'string',pattern:'^[a-z][a-z0-9_]{0,63}$'};
const objectRef={type:'string',pattern:'^bo:[a-f0-9]{64}$'};
export const MEMORY_TOPICS=['depreciation','amortization','voucher_mapping','carry_forward','inventory_cost','expense_allocation','reconciliation','tax_calculation','calculation','accounting_configuration','rental_income','revenue_recognition','vat_treatment','income_tax_treatment','other'];
export const MEMORY_DATE_FIELDS=['invoice_date','payment_date','receipt_date','service_period','posting_date','document_date','acquisition_period','depreciation_start_period','source_date','current_period','unknown'];
export const MEMORY_AMOUNT_BASES=['tax_exclusive','tax_inclusive','net','gross','debit','credit','balance','original_cost','depreciable_amount','quantity','unknown'];
export const MEMORY_DEDUPLICATION=['invoice_number','document_number','source_row','business_key','voucher_number','none','unknown'];
export const MEMORY_ALLOCATION=['fixed_ratio','amount','quantity','revenue','area','headcount','equal','daily_accrual','monthly_accrual','contract_period','direct','none','unknown'];
export const MEMORY_ACCOUNT_ROLES=['cash','bank','receivable','payable','inventory','main_income','main_cost','fixed_asset','accumulated_depreciation','intangible_asset','accumulated_amortization','sales_expense','management_expense','finance_expense','tax_payable','current_profit','retained_profit','other','unknown'];
export const MEMORY_INPUT_MEANINGS=['amount','rate','ratio','quantity','period','date','rows','mapping','source_data','asset_configuration','account_mapping','opening_balance','current_period_parameters','other','unknown'];
export const MEMORY_INPUT_FIELDS=['gross_rent','net_rent','tax_amount','rental_rate','allocation_ratio','contract_start','contract_end','contract_due_date','service_start','service_end','invoice_date','payment_date','receipt_date','document_number','invoice_number','business_key','rows','ledger_balance','asset_cost','useful_life_months','residual_rate','current_period','other','unknown'];
export const MEMORY_SOURCE_ROLES=['lease_contract','invoices','bank_receipts','payment_records','ledger','asset_cards','current_parameters','other','unknown'];
export const MEMORY_TRANSFORMATIONS=['straight_line','weighted_average','fifo','specific_identification','proportional_allocation','direct_mapping','carry_forward','native_calculation','script','unknown'];
export const MEMORY_CONDITIONS=['contract_overlaps_period','contract_active','monthly_accounting','vat_general','vat_small_scale','vat_receipt_basis','vat_invoice_basis','income_tax_accrual_basis','income_tax_contract_due_basis','source_rows_required','operator_policy_unverified'];
export const MEMORY_STEP_OPERATIONS=['select','filter_period','deduplicate','sum','allocate','date_overlap','day_count','month_count','divide','multiply','round','preserve_unknown','native'];
const step={type:'object',additionalProperties:false,required:['op'],properties:{op:choiceStep(),inputs:{type:'array',maxItems:16,items:programField},output:programField,field:programField,keys:{type:'array',maxItems:8,items:programField},fromField:programField,throughField:programField,periodField:programField,amountField:programField,ratio:{type:'number',minimum:0,maximum:1},unit:{enum:['days','months','fixed_ratio','currency','unknown']},amountBasis:{enum:MEMORY_AMOUNT_BASES}}};
function choiceStep(){return {enum:MEMORY_STEP_OPERATIONS};}
export const MEMORY_GAPS=['execution_missing','algorithm_unknown','parameters_missing','constant_value_missing','source_unverified','source_version_unverified','source_access_unavailable','posting_content_changed','import_voucher_changed','posting_source_evidence_unknown','business_result_unreviewed','historical_review_issues','not_successful_history','execution_version_unknown','mapping_unverified','policy_unverified','historical_only','unrecognized_detail'];
const choice=values=>({enum:values});
export const MEMORY_TARGET_SCHEMA={type:'object',additionalProperties:false,required:['accountSetId','period'],properties:{accountSetId:{type:'integer',minimum:1},period}};
export const NATIVE_METHOD_TOOLS=Object.freeze({
 account_context:'flat',account_list:'flat',opening_balance_get:'flat',period_list:'flat',ledger_query:'period',asset_list:'flat',period_end_check:'period',
 depreciation_run:'period',carry_forward_profit:'period',voucher_check:'flat',voucher_create:'period',voucher_post:'flat',asset_create:'flat',asset_update:'flat',
 finance_workpaper:'target',finance_tax_calculate:'target',finance_tax_summary_calculate:'target',finance_quarter_review:'target',
});
const execution={oneOf:[
 {type:'object',additionalProperties:false,required:['kind','tool'],properties:{kind:{const:'native'},tool:{enum:Object.keys(NATIVE_METHOD_TOOLS)},argsTemplate:{type:'object'}}},
 {type:'object',additionalProperties:false,required:['kind','engine','script'],properties:{kind:{const:'script'},engine:{enum:['python','javascript']},script:CALCULATION_SCHEMA.properties.script,timeoutMs:CALCULATION_SCHEMA.properties.timeoutMs}},
 {type:'object',additionalProperties:false,required:['kind','runId'],properties:{kind:{const:'calculation_record'},runId:CALCULATION_SCHEMA.properties.rerunOf}},
]};
export const MEMORY_DEFINITION_SCHEMA={type:'object',additionalProperties:false,properties:{
 title:text,notes:{type:'array',maxItems:40,items:text},
 applicability:{type:'object',additionalProperties:false,properties:{dateField:choice(MEMORY_DATE_FIELDS),amountBasis:choice(MEMORY_AMOUNT_BASES),deduplicateBy:choice(MEMORY_DEDUPLICATION),businessView:{enum:['accounting','vat','income_tax','cash','unknown']},objectScope:{enum:['account_set','business_object']},matchConditions:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['sourceIndex','jsonPointer','operator','expected'],properties:{sourceIndex:{type:'integer',minimum:0,maximum:63},jsonPointer:{type:'string',minLength:1,maxLength:1024,pattern:'^/'},operator:{const:'equals'},expected:{type:['string','number','boolean']},field:choice(MEMORY_INPUT_FIELDS)}}},requiredConditions:{type:'array',maxItems:20,items:choice(MEMORY_CONDITIONS)},scope:text,conditions:{type:'array',maxItems:40,items:text}}},
 inputs:{type:'array',maxItems:64,items:{type:'object',additionalProperties:false,required:['key','meaning','type'],properties:{key:programField,meaning:choice(MEMORY_INPUT_MEANINGS),field:choice(MEMORY_INPUT_FIELDS),sourceRole:choice(MEMORY_SOURCE_ROLES),type:{enum:['number','integer','string','boolean','object','array','null']},required:{type:'boolean'},source:{enum:['current_parameters','ledger','source_snapshot','constant','unknown']},sourceIndex:{type:'integer',minimum:0,maximum:63},dateField:choice(MEMORY_DATE_FIELDS),amountBasis:choice(MEMORY_AMOUNT_BASES),default:{type:['number','boolean','string','null']}}}},
 transformation:{type:'object',additionalProperties:false,properties:{kind:choice(MEMORY_TRANSFORMATIONS),allocationBasis:choice(MEMORY_ALLOCATION),deduplicateBy:choice(MEMORY_DEDUPLICATION),rounding:{enum:['half_up_cent','half_even_cent','native','script_defined','unknown']},missingValues:{enum:['preserve_unknown','reject','native','unknown']},steps:{type:'array',maxItems:64,items:step},formula:text}},
 accounts:{type:'array',maxItems:100,items:{type:'object',additionalProperties:false,required:['role'],properties:{role:choice(MEMORY_ACCOUNT_ROLES),code:text,side:{enum:['debit','credit','both','unknown']}}}},
 execution,gaps:{type:'array',maxItems:40,items:text},
}};
const evidence={oneOf:[
 {type:'object',additionalProperties:false,required:['caseRef'],properties:{caseRef:{type:'string',pattern:'^bc:[a-f0-9]{64}$'},sha256:digest}},
 {type:'object',additionalProperties:false,required:['ref','sha256'],properties:{ref:text,sha256:digest}},
 {type:'object',additionalProperties:false,required:['path','sha256'],properties:{path:text,sha256:digest}},
]};
const page={offset:{type:'integer',minimum:0,maximum:1000000},limit:{type:'integer',minimum:1,maximum:50}};
const schema=(properties,required)=>({type:'object',additionalProperties:false,properties:{target:MEMORY_TARGET_SCHEMA,...properties},required:['target',...required]});
export const BUSINESS_MEMORY_SCHEMAS={
 finance_memory_prepare:schema({},[]),
 finance_company_context:schema({task:text,topics:{type:'array',maxItems:20,items:choice(MEMORY_TOPICS)},objectRef,sources:CALCULATION_SCHEMA.properties.sources,...page},[]),
 finance_method_read:schema({methodRef:ref,objectRef,sources:CALCULATION_SCHEMA.properties.sources},['methodRef']),
 finance_case_search:schema({topic:choice(MEMORY_TOPICS),objectKey:text,objectRef,...page},[]),
 finance_memory_propose:schema({topic:choice(MEMORY_TOPICS),objectKey:text,effectiveFrom:period,effectiveTo:period,definition:MEMORY_DEFINITION_SCHEMA,evidenceRefs:{type:'array',maxItems:100,items:evidence},expectedRevision:{type:'integer',minimum:0},reason:text},['topic','effectiveFrom','definition','evidenceRefs']),
 finance_method_run:schema({methodRef:ref,objectRef,parameters:{type:'object'},sources:CALCULATION_SCHEMA.properties.sources},['methodRef']),
};
