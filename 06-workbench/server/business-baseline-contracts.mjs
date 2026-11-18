// 本机材料观察只接受受限业务字段和原件位置。
import { MEMORY_TARGET_SCHEMA } from './business-memory-contracts.mjs';

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
export const BASELINE_MATERIAL_REFS_SCHEMA={type:'array',minItems:1,maxItems:12,items:{type:'object',additionalProperties:false,required:['materialRef','snapshotDigest'],properties:{materialRef:{type:'string',pattern:'^\\d{8}T\\d{9}Z_[a-f0-9-]{36}$'},snapshotDigest:digest}}};
export const BUSINESS_BASELINE_SCHEMAS = Object.freeze({
 finance_baseline_materials: object({
  target:MEMORY_TARGET_SCHEMA,inputPath:text,materialRefs:BASELINE_MATERIAL_REFS_SCHEMA,
  section:{enum:['overview','facts','tax','coverage','calculation']},
  historyOffset:{type:'integer',minimum:0,maximum:100000},historyLimit:{type:'integer',minimum:1,maximum:50},
  ...page,
 },['target']),
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
  '同一记录组织字段。历史提供有实际业务号的选中行，缺日保留月份。用历史材料支持业务判断时，核对独立业务原件。',
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
