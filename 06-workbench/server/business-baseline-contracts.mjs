// 短企业基线只接受受限业务语义；客户原文、主体名称和自由解释不进入模型常驻正文。
import { MEMORY_TARGET_SCHEMA } from './business-memory-contracts.mjs';

export const BASELINE_INTERFACE = 'business-baseline/1';
export const BASELINE_TOPIC = 'business_baseline';
export const AGENT_MATERIALS_SUBDIRECTORY = 'agent-materials';
export const BASELINE_VALUES = Object.freeze({
 accounting_standard: ['enterprise','small_enterprise'],
 enterprise_class: ['trade','manufacturing','services','rental','mixed'],
 business_classification: ['main_income','other_income','actual_use_expense'],
 inventory_cost: ['periodic_weighted_average','moving_weighted_average','fifo','specific_identification'],
 revenue_period: ['service_period','delivery_acceptance','contract_due','invoice_date','receipt_date'],
 expense_period: ['benefit_period','incurred_period'],
 vat_output_period: ['advance_invoice_period'],
 vat_input_period: ['confirmation_period'],
 income_tax_period: ['accrual_period','contract_due','service_period'],
 cost_treatment: ['expense_current','allocate_benefit_period','capitalize_then_depreciate','capitalize_then_amortize'],
 tax_choice: ['vat_standard','vat_simplified','cit_small_low_profit','no_tax_preference'],
});
export const BASELINE_WHEN = ['account_set','lease','service','repair','goods','maintenance','inventory','fixed_asset','intangible_asset'];
export const BASELINE_FACT_VALUES = Object.freeze({
 ...BASELINE_VALUES, taxpayer_type: ['vat_general','vat_small_scale'],
 business_kind: BASELINE_WHEN.filter(k=>k!=='account_set'), service_pattern: ['even_service','point_in_time'],
 tax_type: ['vat','cit'], tax_measure: ['payable','paid'], tax_stage:['payable_before_relief','payable_after_relief','balance_due','paid'], period_basis: ['attribution','payment'], accumulation: ['current','cumulative'],
});
export const BASELINE_DATE_FIELDS = ['service_start','service_end','invoice_date','receipt_date','payment_date','contract_due_date','confirmation_date','delivery_date','choice_valid_from','choice_valid_through'];
export const BASELINE_PERIOD_FIELDS = ['period_start','period_end'];
export const BASELINE_AMOUNT_FIELDS = ['amount_net','amount_tax','amount_gross','tax_amount','sales_ex_vat','revenue','opening_unit_price','receipt_unit_price'];
export const BASELINE_QUANTITY_FIELDS = ['opening_quantity','receipt_quantity','issue_quantity'];
export const BASELINE_FIELDS = [...Object.keys(BASELINE_FACT_VALUES),...BASELINE_DATE_FIELDS,...BASELINE_PERIOD_FIELDS,...BASELINE_AMOUNT_FIELDS,...BASELINE_QUANTITY_FIELDS,'creates_asset','business_reference'];
export const BASELINE_GAPS = ['materials_missing','owner_unverified','historical_conflict','policy_unverified','tax_history_missing','tax_basis_incomplete','source_changed','source_missing','source_unavailable','outside_effective_period','scope_conflict','unsupported_material','historical_evidence_missing'];
export const BASELINE_LABELS = Object.freeze({
 enterprise:'企业会计准则',small_enterprise:'小企业会计准则',trade:'商贸',manufacturing:'制造',services:'服务',rental:'租赁',mixed:'混合经营',
 periodic_weighted_average:'月末一次加权平均',moving_weighted_average:'移动加权平均',fifo:'先进先出',specific_identification:'个别计价',
 main_income:'收入归主营业务',other_income:'收入归其他业务',actual_use_expense:'日常费用按实际用途归集，改变用途另核',
 service_period:'按服务所属期确认',delivery_acceptance:'按交付验收期确认',contract_due:'按合同约定应付期确认',invoice_date:'按开票期确认',receipt_date:'按收款期确认',
 benefit_period:'按受益期分摊',incurred_period:'按实际发生期确认',invoice_or_receipt_earlier:'按开票与收款孰先所属期确认',invoice_or_contract_due_earlier:'按开票与合同到期孰先所属期确认',
 advance_invoice_period:'预收并提前开票的同类租赁销项归开票期',confirmation_period:'在具备抵扣条件的用途确认期抵扣，费用分摊不重复抵扣',accrual_period:'按权责发生所属期确认',
 expense_current:'满足费用条件的计入当期',allocate_benefit_period:'跨期等量服务按受益期分摊',capitalize_then_depreciate:'符合资产条件的资本化后折旧',capitalize_then_amortize:'符合无形资产条件的资本化后摊销',
 vat_general:'一般纳税人',vat_small_scale:'小规模纳税人',vat_standard:'已核范围采用一般计税',vat_simplified:'已核范围采用简易计税',cit_small_low_profit:'已核有效范围采用小型微利企业优惠',no_tax_preference:'本范围不采用优惠',
 lease:'租赁',service:'服务',repair:'维修',goods:'商品',maintenance:'维保',inventory:'存货',fixed_asset:'固定资产',intangible_asset:'无形资产',account_set:'本账套',
});
const text = {type:'string',minLength:1,maxLength:2000};
const id = {type:'string',pattern:'^[A-Za-z][A-Za-z0-9_-]{0,63}$'};
const digest = {type:'string',pattern:'^[a-f0-9]{64}$'};
const object=(properties,required=[])=>({type:'object',additionalProperties:false,required,properties});
const index={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER};
const zeroIndex={...index,minimum:0};
export const BASELINE_LOCATOR_SCHEMA={type:'object',oneOf:[
 object({sheetIndex:zeroIndex,row:index,column:index},['row','column']),
 object({jsonPointer:{type:'string',maxLength:1024,pattern:'^/(?:[^~]|~[01])*$'}},['jsonPointer']),
 {...object({page:index,line:index,start:zeroIndex,end:index},['page','line']),dependencies:{start:['end'],end:['start']}},
]};
const ref=name=>({$ref:'#/$defs/'+name});
const locatedValue=ref('locatedValue');
const interpretation=object({
 value:{anyOf:[{type:'string',maxLength:100},{type:'boolean'}]},reason:{type:'string',minLength:1,maxLength:1000},
},['value','reason']);
const observationValue={anyOf:[{type:'string',maxLength:2000},{type:'number'},{type:'boolean'},{type:'null'}]};
export const BASELINE_OBSERVATIONS_SCHEMA={
 ...object({
  version:{const:'finance-baseline-observations/1'},target:MEMORY_TARGET_SCHEMA,
  originals:{type:'array',maxItems:32,items:object({
   id,path:text,sha256:digest,owner:ref('owner'),extractor:object({name:text,version:text,encoding:text},['name']),
  },['id','path','sha256'])},
  records:{type:'array',maxItems:400,items:object({
   id,originalId:id,owner:ref('owner'),fields:{type:'array',minItems:1,maxItems:64,items:ref('field')},
  },['id','originalId','fields'])},
  historicalRows:{type:'array',maxItems:400,items:object({
   id,originalId:id,owner:ref('owner'),period:locatedValue,businessReference:locatedValue,debit:locatedValue,
   credit:locatedValue,date:locatedValue,code:locatedValue,accountName:locatedValue,
  },['id','originalId','period','businessReference','debit','credit'])},
 },['version','target','originals']),
 $defs:{
  locator:BASELINE_LOCATOR_SCHEMA,value:observationValue,
  locatedValue:object({value:ref('value'),locator:ref('locator')},['value','locator']),
  owner:{
   ...object({role:{enum:['enterprise','buyer','seller']},name:locatedValue,taxId:locatedValue,enterpriseKey:locatedValue},['role']),
   anyOf:[{required:['name']},{required:['enterpriseKey']}],
   dependencies:{enterpriseKey:{properties:{role:{const:'enterprise'}}}},
  },
  field:object({field:{enum:BASELINE_FIELDS},value:ref('value'),locator:ref('locator'),interpretation},['field','value','locator']),
 },
};

const page = {offset:{type:'integer',minimum:0,maximum:100000},limit:{type:'integer',minimum:1,maximum:50}};
const gap = {type:'object',additionalProperties:false,required:['code'],properties:{code:{enum:BASELINE_GAPS},kind:{enum:Object.keys(BASELINE_VALUES)}}};
const common = (properties,required=[])=>({type:'object',additionalProperties:false,required:['target',...required],properties:{target:MEMORY_TARGET_SCHEMA,...properties}});
export const BASELINE_MATERIAL_REFS_SCHEMA={type:'array',minItems:1,maxItems:12,items:{type:'object',additionalProperties:false,required:['materialRef','snapshotDigest'],properties:{materialRef:{type:'string',pattern:'^\\d{8}T\\d{9}Z_[a-f0-9-]{36}$'},snapshotDigest:digest}}};
const typedPrinciple={type:'object',additionalProperties:false,required:['kind','value','evidenceRefs'],properties:{kind:{enum:Object.keys(BASELINE_VALUES)},value:{enum:[...new Set(Object.values(BASELINE_VALUES).flat())]},when:{enum:BASELINE_WHEN},allocationBasis:{enum:['monthly_equal']},evidenceRefs:{type:'array',minItems:1,maxItems:40,uniqueItems:true,items:{type:'string',pattern:'^bf:[a-f0-9]{64}$'}}}};
export const BUSINESS_BASELINE_SCHEMAS = Object.freeze({
 finance_baseline_read: common({}),
 finance_baseline_materials: common({
  inputPath:text,materialRefs:BASELINE_MATERIAL_REFS_SCHEMA,
  section:{enum:['overview','facts','tax','coverage','calculation']},
  historyOffset:{type:'integer',minimum:0,maximum:100000},historyLimit:{type:'integer',minimum:1,maximum:50},
  ...page,
 }),
 finance_baseline_save: common({
  materialRefs:BASELINE_MATERIAL_REFS_SCHEMA,
  expectedRevision:{type:'integer',minimum:0}, effectiveFrom:MEMORY_TARGET_SCHEMA.properties.period,effectiveTo:MEMORY_TARGET_SCHEMA.properties.period,
  principles:{type:'array',minItems:1,maxItems:24,items:{oneOf:[typedPrinciple,{type:'object',additionalProperties:false,required:['supportRef'],properties:{supportRef:{type:'string',pattern:'^bp:[a-f0-9]{64}$'}}}]}},
  unresolved:{type:'array',maxItems:3,uniqueItems:true,items:gap},
 },['materialRefs','expectedRevision','effectiveFrom','principles']),
});

export function baselineHostObservationNext(){return {
 tool:'finance_record_contract',arguments:{recordType:'baseline'},action:'prepare_host_observations',
 hint:'用宿主已获准的本机能力读取原件，选取所需事实并写入合同产物。',
};}
export function baselineMaterialContract(){return {
 version:'finance-baseline-material-contract/2',recordType:'baseline',tool:'finance_baseline_materials',
 inputSchema:BASELINE_OBSERVATIONS_SCHEMA,
 artifactDirectory:'FINANCE_AUDIT_DIR/'+AGENT_MATERIALS_SUBDIRECTORY,
 guidance:[
  '用获准宿主直接读原件，自选解析器和编码。提交所需观察的UTF-8 JSON绝对路径。省略inputPath只取账库或给定材料引用。',
  '原件用绝对路径和SHA，主体取源实际位置。真实企业标识只用于enterprise。表与字符从0起，行列和页行从1起。',
  '同一记录组织字段。历史提供有实际业务号的选中行，缺日保留月份，持久原则须有独立业务原件共证。',
  'Agent观察保留证据出处。后端核原件字节和账套范围。',
 ],
};}

// 中文业务别名是固定词典，不接受调用者任意 valueMap 把无关原文解释成政策。
export const BASELINE_ALIASES = Object.freeze({
 accounting_standard:{'企业会计准则':'enterprise','小企业会计准则':'small_enterprise'},
 enterprise_class:{'商贸':'trade','贸易':'trade','制造业':'manufacturing','制造':'manufacturing','服务业':'services','服务':'services','租赁':'rental','混合经营':'mixed'},
 inventory_cost:{'月末一次加权平均法':'periodic_weighted_average','月末加权平均法':'periodic_weighted_average','加权平均法':'periodic_weighted_average','移动加权平均法':'moving_weighted_average','先进先出法':'fifo','个别计价法':'specific_identification'},
 business_kind:{'租赁':'lease','出租':'lease','服务':'service','维修':'repair','一次性设备维修':'repair','闲置房屋仓库经营出租':'lease','年度维保':'maintenance','维保':'maintenance','维护':'maintenance','商品':'goods','存货':'inventory','固定资产':'fixed_asset','无形资产':'intangible_asset'},
 service_pattern:{'等量连续服务':'even_service','每月等量连续维护':'even_service','均匀连续服务':'even_service','一次完工':'point_in_time','一次交付':'point_in_time'},
 tax_type:{'增值税':'vat','企业所得税':'cit'},tax_measure:{'应纳':'payable','应纳税额':'payable','实缴':'paid','已缴':'paid'},tax_stage:{'优惠前应纳':'payable_before_relief','减免后应纳':'payable_after_relief','应补':'balance_due','实缴':'paid'},period_basis:{'所属期':'attribution','缴款期':'payment'},accumulation:{'本期':'current','累计':'cumulative'},
 taxpayer_type:{'一般纳税人':'vat_general','小规模纳税人':'vat_small_scale'},
 tax_choice:{'一般计税':'vat_standard','简易计税':'vat_simplified','小型微利企业':'cit_small_low_profit','不采用优惠':'no_tax_preference'},
 revenue_period:{'服务所属期':'service_period','交付验收期':'delivery_acceptance','合同约定应付期':'contract_due','开票期':'invoice_date','收款期':'receipt_date'},
 expense_period:{'受益期':'benefit_period','实际发生期':'incurred_period'},
 vat_output_period:{'预收并提前开票租赁归开票期':'advance_invoice_period'},
 vat_input_period:{'用途确认期':'confirmation_period'},income_tax_period:{'权责发生所属期':'accrual_period','合同约定应付期':'contract_due','服务所属期':'service_period'},
 cost_treatment:{'当期费用':'expense_current','按受益期分摊':'allocate_benefit_period','资本化后折旧':'capitalize_then_depreciate','资本化后摊销':'capitalize_then_amortize'},
});
