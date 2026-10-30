import { MATERIAL_PROPERTIES, MATERIAL_CHOICE } from '../../../../06-workbench/server/direct-finance-contracts.mjs';
import { FINANCE_SUMMARY_INPUT_SCHEMA } from '../../../../06-workbench/server/finance-summary-contracts.mjs';
const str={type:'string',minLength:1};
const spec=(name,description,properties={},required=[],extra={})=>({name,description,status:'available',origin:'local',inputSchema:{type:'object',additionalProperties:false,properties,required,...extra},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true}});
export const DIRECT_TOOLS=[
 { ...spec('finance_tax_summary_calculate','依据精确来源绑定的税务汇总数据进行独立条件试算；先用finance_record_contract(recordType=tax_summary)读取支持分支和字段。不证明完整账务、资格真实性或申报完成。'),inputSchema:FINANCE_SUMMARY_INPUT_SCHEMA },
 spec('finance_record_contract','按需发现所有现有原生类型、已核字段和规则引用；明确示例/字段披露完整度，不把无示例说成算法不支持。',{recordType:{type:'string',pattern:'^[a-z][a-z0-9_]{0,79}$'}}),
 spec('finance_rules','查询实际规则目录、有效期、适用条件和官方出处；目录存在不等于客户适用。',{ruleId:str,revision:str,filters:{type:'object',additionalProperties:false,properties:{obligationId:str,kind:str,region:str,entityKind:str,from:str,through:str,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:50}}}}),
 spec('finance_workpaper','从原件及业务记录直接生成中国会计/税费底稿。只读计算，返回金额、凭证计数和规则摘要，完整输入结果保存在本机证据索引；无需Store/事实登记/DAG。',{...MATERIAL_PROPERTIES},[],{oneOf:MATERIAL_CHOICE}),
 spec('finance_annual_workpaper','直接重放全年原始月份资料进行既有年度税会调整。月份缺口明确拒绝；不做正式汇算提交或关账。',{manifestPaths:{type:'array',minItems:1,maxItems:12,items:str},dbPath:str},['manifestPaths']),
 spec('finance_tax_calculate','从原始业务材料调用实际中国税费算法，按obligationIds返回应纳/实缴/差异及缺件状态。交易税额不冒充法定应纳。',{...MATERIAL_PROPERTIES,obligationIds:{type:'array',minItems:1,uniqueItems:true,items:{type:'string',enum:['vat','vat_prepayment','corporate_income','business_income','salary_withholding','other_withholding','urban_maintenance','education_surcharge','local_education','stamp','property','urban_land','vehicle_vessel','consumption','resource','water_resource','environment','deed','land_appreciation','farmland_occupation','vehicle_purchase','customs','cultural_construction','union_funds','tobacco','vessel_tonnage','social_insurance','housing_fund','disability_fund']}}},[],{oneOf:MATERIAL_CHOICE}),
];
export const DIRECT_TOOL_NAMES=new Set(DIRECT_TOOLS.map(t=>t.name));
