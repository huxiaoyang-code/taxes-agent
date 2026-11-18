// 短企业基线只接受受限业务语义；客户原文、主体名称和自由解释不进入模型常驻正文。
import { MEMORY_TARGET_SCHEMA } from './business-memory-contracts.mjs';

export const BASELINE_INTERFACE = 'business-baseline/1';
export const BASELINE_TOPIC = 'business_baseline';
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
const valueSlice={type:'object',additionalProperties:false,required:['after'],properties:{after:{type:'string',minLength:1,maxLength:200},before:{type:'string',minLength:1,maxLength:200}}};
export const BASELINE_LOCATOR_SCHEMA = {type:'object',additionalProperties:false,properties:{valueSlice,start:{type:'integer',minimum:0,maximum:2000000},end:{type:'integer',minimum:1,maximum:2000000},fieldRef:{type:'string',pattern:'^(bl|md):[a-f0-9]{64}$'},jsonPointer:{type:'string',maxLength:1024,pattern:'^(|/.*)$'},row:{type:'integer',minimum:1,maximum:10000},column:{anyOf:[text,{type:'integer',minimum:1,maximum:256}]},sheet:text,sheetIndex:{type:'integer',minimum:0,maximum:63},headerRows:{type:'array',minItems:1,maxItems:8,uniqueItems:true,items:{type:'integer',minimum:1,maximum:10000}},page:{type:'integer',minimum:1,maximum:10000},line:{type:'integer',minimum:1,maximum:10000}},oneOf:[{required:['fieldRef']},{required:['jsonPointer']},{required:['row','column']},{required:['page','line']}]};
const locator=BASELINE_LOCATOR_SCHEMA;
export const BASELINE_OWNER_SCHEMA={type:'object',additionalProperties:false,required:['role','name'],properties:{role:{enum:['enterprise','buyer','seller']},name:locator,taxId:locator}};

const interpretation={type:'object',additionalProperties:false,required:['value','reason'],properties:{value:{anyOf:[{type:'string',maxLength:100},{type:'boolean'}]},reason:{type:'string',minLength:1,maxLength:1000}}};
const page = {offset:{type:'integer',minimum:0,maximum:100000},limit:{type:'integer',minimum:1,maximum:50}};
const gap = {type:'object',additionalProperties:false,required:['code'],properties:{code:{enum:BASELINE_GAPS},kind:{enum:Object.keys(BASELINE_VALUES)}}};
const common = (properties,required=[])=>({type:'object',additionalProperties:false,required:['target',...required],properties:{target:MEMORY_TARGET_SCHEMA,...properties}});
export const BASELINE_MATERIAL_REFS_SCHEMA={type:'array',minItems:1,maxItems:12,items:{type:'object',additionalProperties:false,required:['materialRef','snapshotDigest'],properties:{materialRef:{type:'string',pattern:'^\\d{8}T\\d{9}Z_[a-f0-9-]{36}$'},snapshotDigest:digest}}};
const typedPrinciple={type:'object',additionalProperties:false,required:['kind','value','evidenceRefs'],properties:{kind:{enum:Object.keys(BASELINE_VALUES)},value:{enum:[...new Set(Object.values(BASELINE_VALUES).flat())]},when:{enum:BASELINE_WHEN},allocationBasis:{enum:['monthly_equal']},evidenceRefs:{type:'array',minItems:1,maxItems:40,uniqueItems:true,items:{type:'string',pattern:'^bf:[a-f0-9]{64}$'}}}};
export const BUSINESS_BASELINE_SCHEMAS = Object.freeze({
 finance_baseline_read: common({}),
 finance_baseline_materials: common({
  originals:{type:'array',maxItems:32,items:{type:'object',additionalProperties:false,required:['id'],oneOf:[{required:['path']},{required:['originalRef']}],properties:{id,path:text,originalRef:{type:'string',pattern:'^bs:[a-f0-9]{64}$'},sha256:digest,owner:locator,ownerIdentity:BASELINE_OWNER_SCHEMA,structureOffset:{type:'integer',minimum:0,maximum:1000000},pageOffset:{type:'integer',minimum:0,maximum:10000},maxPages:{type:'integer',minimum:1,maximum:40}}}},
  selections:{type:'array',maxItems:400,items:{type:'object',additionalProperties:false,required:['id','field','originalId','locator'],properties:{id,field:{enum:BASELINE_FIELDS},originalId:id,group:id,locator,ownerIdentity:BASELINE_OWNER_SCHEMA,valueSlice,interpretation}}},
  historicalRows:{type:'array',maxItems:400,items:{type:'object',additionalProperties:false,required:['id','originalId','period','businessReference','debit','credit'],properties:{id,originalId:id,period:locator,date:locator,businessReference:locator,code:locator,accountName:locator,debit:locator,credit:locator,ownerIdentity:BASELINE_OWNER_SCHEMA}}},
  extractKnownFields:{type:'boolean'},materialRefs:BASELINE_MATERIAL_REFS_SCHEMA,sourceCursor:BASELINE_MATERIAL_REFS_SCHEMA.items,
  section:{enum:['overview','structure','facts','tax','coverage','calculation']},historyOffset:{type:'integer',minimum:0,maximum:100000},historyLimit:{type:'integer',minimum:1,maximum:50},
  ...page,
 }),
 finance_baseline_save: common({
  materialRefs:BASELINE_MATERIAL_REFS_SCHEMA,
  expectedRevision:{type:'integer',minimum:0}, effectiveFrom:MEMORY_TARGET_SCHEMA.properties.period,effectiveTo:MEMORY_TARGET_SCHEMA.properties.period,
  principles:{type:'array',minItems:1,maxItems:24,items:{oneOf:[typedPrinciple,{type:'object',additionalProperties:false,required:['supportRef'],properties:{supportRef:{type:'string',pattern:'^bp:[a-f0-9]{64}$'}}}]}},
  unresolved:{type:'array',maxItems:3,uniqueItems:true,items:gap},
 },['materialRefs','expectedRevision','effectiveFrom','principles']),
});

export function baselineMaterialContract(){return {
 version:'finance-baseline-material-contract/1',recordType:'baseline',tool:'finance_baseline_materials',
 requirements:{principles:'会计准则、业务归集、成本方法、税会所属期和有效选择按证据范围提炼；只有配置不算历史基线已生成。',history:'历史只在原件中时用historicalRows定位实际业务号、期间和分录；只形成来源观察，不导入账库或声称已过账。',tax:'历史税负需税种、应纳/实缴、所属/缴款期、本期/累计、税额阶段及可比税额和分母。',missing:'工具未读入、缺少映射与客户未提供分别报告。'},
 mapping:{fields:BASELINE_FIELDS,locator:BASELINE_LOCATOR_SCHEMA,ownerIdentity:BASELINE_OWNER_SCHEMA,interpretation:'仅受限枚举/布尔的模型解释，必须有原值位置和reason；金额、日期、业务号不能由解释覆写。',historicalRows:BUSINESS_BASELINE_SCHEMAS.finance_baseline_materials.properties.historicalRows.items},
 workflow:['无材料引用时用section:structure列出原件，再按sourceInventory.items[].next读不透明originalRef对应的结构。','按实际fieldRef/页行/表格位置选择字段，不依赖固定表头词典；原值在本机读取，结构分页沿真实next继续。','主体未核时先看identity.registeredNameAvailable与reason；registered_identity_missing表示账库受信主体名/税号尚无登记，source_owner_unmatched才表示已有登记但原件匹配未成。先核实已有企业绑定，不在空名单上反复换表头；显示账套名和opaque enterpriseKey不自证税号或登记名称。','把归属核实、来源观察、模型解释和人工确认分开；单一真实业务号可关联同原件跨页字段，多业务保持歧义。','selections/historicalRows保存的是读取与映射方式，原件SHA、提取器和实际位置随事实留存；正常计算仍复用现有工具。'],
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
