// 账前接收宿主整理的业务事实及有位置的原件观察。
import {AGENT_MATERIALS_SUBDIRECTORY,BASELINE_LOCATOR_SCHEMA} from './business-baseline-contracts.mjs';
const text={type:'string',minLength:1,maxLength:200};
const amount={type:'string',pattern:'^-?\\d{1,12}(\\.\\d{1,2})?$'};
const quantity={type:'string',pattern:'^(0|[1-9]\\d{0,9})(\\.\\d{1,6})?$'};
const date={type:'string',format:'calendar-date'};
const obj=(properties,required=[])=>({type:'object',additionalProperties:false,properties,required});
const rows=items=>({type:'array',maxItems:2000,items});
const bool={type:'boolean'};
const period={type:'string',pattern:'^202[67]-(0[1-9]|1[0-2])$'};
const path={type:'string',minLength:1,maxLength:4096};
const base={id:text,businessId:text,date,enterpriseKey:text};
export const PREBOOK_FACTS_SCHEMA=obj({
 scope:obj({enterpriseKey:text,period,periodType:{enum:['monthly','quarterly']},currency:{const:'CNY'}},['enterpriseKey','period','periodType','currency']),
 taxpayer:obj({vatStatus:{enum:['general','small','unknown']},ordinaryDomesticScopeConfirmed:bool,reliefElection:{enum:['reduced','waived','unknown']},noPropertyOrLandTransactions:bool,remainingSalesEligibleForThresholdExemption:bool,allSalesEligibleForOnePercentRelief:bool,specialInvoiceWaiverOfExemption:bool},['vatStatus']),
 coverage:obj(Object.fromEntries(['sales','invoices','purchases','receipts','bankTransactions','inventory'].map(k=>[k,{enum:['complete','partial','missing','not_applicable']}]))),
 opening:obj({asOf:date,carryCredit:amount,inputVatTransferOut:amount,prepaidVat:amount,inventory:rows(obj({itemId:text,quantity},['itemId','quantity'])),receivables:rows(obj({id:text,businessId:text,counterpartyId:text,amount},['id','businessId','counterpartyId','amount'])),payables:rows(obj({id:text,businessId:text,counterpartyId:text,amount},['id','businessId','counterpartyId','amount']))}),
 purchases:rows(obj({...base,supplierId:text,itemId:text,quantity,netAmount:amount,taxAmount:amount,grossAmount:amount},['id','businessId','date','supplierId','grossAmount'])),
 receipts:rows(obj({...base,itemId:text,quantity},['id','businessId','date','itemId','quantity'])),
 sales:rows(obj({...base,customerId:text,itemId:text,quantity,netAmount:amount,taxAmount:amount,vatCategory:{enum:['goods','processing','movable_lease','transport','construction','real_estate_lease','service','catering','property_management']},invoiceKind:{enum:['ordinary','special','uninvoiced']},status:{enum:['valid','void','red']},originalId:text},['id','businessId','date','netAmount','invoiceKind','status'])),
 invoices:rows(obj({...base,invoiceNumber:text,direction:{enum:['purchase','sale']},counterpartyId:text,netAmount:amount,taxAmount:amount,grossAmount:amount,status:{enum:['valid','void','red']},originalInvoiceId:text,redConfirmed:bool,deductionStatus:{enum:['eligible','ineligible','unknown']}},['id','invoiceNumber','direction','date','counterpartyId','netAmount','taxAmount','grossAmount','status'])),
 bankTransactions:rows(obj({...base,bankReference:text,accountId:text,direction:{enum:['inflow','outflow']},amount,category:{enum:['business','transfer','owner_advance','loan','other','unknown']},counterpartyId:text},['id','date','accountId','direction','amount','category'])),
 fundsAccounts:rows(obj({id:text,kind:{enum:['bank','cash']},openingBalance:amount,openingDate:date,closingBalance:amount,closingDate:date},['id','kind'])),
 inventoryCounts:rows(obj({itemId:text,quantity,asOf:date},['itemId','quantity','asOf'])),
},['scope','taxpayer','coverage']);
export const PREBOOK_INPUT_VERSION='finance-prebook-input/2';
const observedLocator={oneOf:[
 BASELINE_LOCATOR_SCHEMA,
 obj({jsonPointer:{const:''}},['jsonPointer']),
 obj({headerRow:{type:'integer',minimum:1},sheetIndex:{type:'integer',minimum:0}},['headerRow']),
]};
const observedContext=obj({enterpriseKey:text,period:{type:'string',pattern:'^\\d{4}-(0[1-9]|1[0-2])$'},date,asOf:date,openingDate:date,closingDate:date});
export const PREBOOK_INPUT_SCHEMA=obj({
 version:{const:PREBOOK_INPUT_VERSION},facts:PREBOOK_FACTS_SCHEMA,
 originals:rows(obj({id:text,path,sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},scope:obj({enterpriseKey:text,from:date,through:date},['enterpriseKey','from','through'])},['id','path','sha256','scope'])),
 bindings:rows(obj({inputPointer:{type:'string',maxLength:500},originalId:text,locator:observedLocator,observedValue:{},observedContext,transform:{enum:['identity','decimal','boolean','empty_set']},valueMap:{type:'object',maxProperties:20,additionalProperties:{anyOf:[{type:'string'},{type:'boolean'}]}}},['inputPointer','originalId','locator','observedValue'])),
 declarations:rows(obj({inputPointer:{type:'string',maxLength:500},kind:{enum:['provider_statement','operator_mapping']},reason:{type:'string',minLength:1,maxLength:2000},declaredBy:text,declaredAt:{type:'string',format:'utc-timestamp'}},['inputPointer','kind','reason','declaredBy','declaredAt'])),
},['version','facts','originals','bindings']);
export const PREBOOK_REPLIES_SCHEMA=obj({version:{const:'finance-prebook-replies/1'},enterpriseKey:text,period:text,inputDigest:{type:'string',pattern:'^[a-f0-9]{64}$'},responses:rows(obj({issueId:{type:'string',pattern:'^pbi-[a-f0-9]{20}$'},statement:{type:'string',minLength:1,maxLength:4000},respondent:text,respondedAt:{type:'string',format:'utc-timestamp'}},['issueId','statement','respondent','respondedAt']))},['version','enterpriseKey','period','inputDigest','responses']);
export const PREBOOK_TOOL_SCHEMA=obj({inputPath:path,repliesPath:path},['inputPath']);
export function prebookContract(){return {version:'finance-prebook-contract/2',recordType:'prebook',tool:'finance_prebook_review',schema:PREBOOK_TOOL_SCHEMA,inputSchema:PREBOOK_INPUT_SCHEMA,repliesSchema:PREBOOK_REPLIES_SCHEMA,statuses:['ready_for_bookkeeping_review','needs_inputs','unsupported'],guidance:[
 `Agent用宿主现有授权自主解析原件。将少量所需字段整理成${PREBOOK_INPUT_VERSION} JSON，和可选回复文件一起放在FINANCE_AUDIT_DIR/${AGENT_MATERIALS_SUBDIRECTORY}，以绝对路径提交。原件须在FINANCE_SOURCE_ROOT内的原位置保存。`,
 'originals需含原件绝对路径、SHA-256和企业期间范围。bindings附实际位置及observedValue，可补充原件位置中实际观察的主体或日期observedContext。服务校验原件字节摘要、观察与facts的一致性及期间范围，留证标为Agent观察。整对象或数组需要值完全一致，decimal严格转整数分，boolean限true/false。缺少有出处值的事实列待补证。',
 '内部记录id无需客户原件，系统身份与金额事实分开。分类可通过binding.valueMap明确翻译原件枚举（仅类别字段，不能改金额/日期/票号/对方）；declarations仅承载scope、coverage、taxpayer和业务分类/关联的提供者说明或操作者映射。此类声明不冒充原件事实；关联或抵扣等声明仍要求业务核实。',
 '覆盖范围complete是有来源的提供者声明。empty_set用于原件明确写明无记录，或Agent实际核对空表后的表头定位加observedValue:[]。本期须覆盖完整期间，上期须覆盖结转日。季度period用季度末月，opening.asOf和资金openingDate为期间开始前一天。',
 'sales覆盖已开票及未开票销售；invoiceKind为原业务开票性质，不能仅凭税局发票推定销售完整。一般VAT优先使用原件taxAmount，缺少时可用有来源netAmount及vatCategory调用现有原生交易税额函数派生，保留计算轨迹与分类条件；分类也缺失则needs_inputs，不要求客户算最终税。eligible进项是有来源抵扣声明，仍待会计核实。',
 'invoiceNumber与direction/counterpartyId用于去重，冲突不得自动合并。businessId是显式业务关联，不以金额相等自动匹配；采购、收货、税务发票与银行收付是不同记录。红字销售及红字票单独标需要原单复核，本期不自动净额抵减。',
 '税额复用现有finance-summary原生规则，保留conditions/needsInputs/unsupported；不支持的业务或期间不以零通过。税负为本期VAT应纳/本期不含税销售额，仅在分子分母已返回时显示。',
 '老板回复文件绑定inputDigest/issueId，只记录声明；不关闭证据缺口、不修改计算事实、不授权记账。补件须修改facts及来源后重跑；旧inputDigest回复列stale，不沿用。',
 '输出prebook.json/review.html/handoff.json/evidence-index.json；handoff是带来源的业务整理资料，不是凭证导入文件。现有做账流程按其合同再整理消费，正式写账与人审规则独立。',
 '首版只条件测算增值税。所得税、附加及其他税种按已有独立工具继续处理，不将VAT税负称综合税负。',
 ]};}
