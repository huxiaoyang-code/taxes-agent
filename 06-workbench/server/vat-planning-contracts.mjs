// 只在本机保存原件位置、表头映射及宿主观察；MCP 用匿名票引用调整计划。
import {MEMORY_TARGET_SCHEMA} from './business-memory-contracts.mjs';
import {BASELINE_LOCATOR_SCHEMA} from './business-baseline-contracts.mjs';

const object=(properties,required=[])=>({type:'object',additionalProperties:false,properties,required});
const list=(items,maxItems,minItems=0)=>({type:'array',items,minItems,maxItems});
const text={type:'string',minLength:1,maxLength:2048};
const month={type:'string',pattern:'^202[67]-(0[1-9]|1[0-2])$'};
const index={type:'integer',minimum:1,maximum:10000};
const sha={type:'string',pattern:'^[a-f0-9]{64}$'};
const selection=object({invoiceRef:{type:'string',pattern:'^vat-[a-f0-9]{24}$'},period:month},['invoiceRef','period']);
export const VAT_PLANNING_SCHEMA=object({
 target:MEMORY_TARGET_SCHEMA,inputPath:text,asOf:{type:'string',format:'calendar-date'},through:month,
 baseline:list(selection,1500),plan:list(selection,1500),expectedBasis:sha,
 offset:{type:'integer',minimum:0,maximum:4000},limit:{type:'integer',minimum:1,maximum:100},
},['target','inputPath','asOf','through']);

const pointer={type:'string',maxLength:1024,pattern:'^(?:|/(?:[^~]|~[01])*)$'};
const cell=object({row:index,column:index},['row','column']);
const scalar={anyOf:[text,{type:'number'},{type:'boolean'}]};
const observed=object({locator:BASELINE_LOCATOR_SCHEMA,value:scalar},['locator','value']);
const location={oneOf:[object({jsonPointer:pointer},['jsonPointer']),cell,observed]};
const assumption=object({assume:scalar,reason:text},['assume','reason']);
const readField={oneOf:[...location.oneOf,object({key:text},['key']),object({column:index},['column']),assumption]};
export const VAT_FIELDS={
 opening:['period','knownAt','carryCredit','scope','inventoryCoverage'],
 invoice:['knownAt','invoiceNumber','issuer','taxAmount','receipt','issueDate','eligibility','eligibleFrom','eligibleThrough'],
 confirmation:['knownAt','invoiceNumber','issuer','taxPeriod','operationDate','issueDate','taxAmount'],
 filing:['period','knownAt'],
 month:['knownAt','period','basis','state','outputVat','inputVatTransferOut','prepaidVat','otherEffects'],
};
const fields=object(Object.fromEntries([...new Set(Object.values(VAT_FIELDS).flat())].map(k=>[k,readField])));
const table=object({
 kind:{enum:Object.keys(VAT_FIELDS)},fields,rowsPointer:pointer,firstRow:index,lastRow:index,
 statusFilter:object({location:readField,include:list(scalar,12,1),exclude:list(scalar,12,1)},['location','include','exclude']),
 // 例如用“可抵扣”映射成 eligible。金额、日期、票号不能映射。
 translations:object(Object.fromEntries(['scope','inventoryCoverage','eligibility','basis','state','otherEffects'].map(key=>[key,
  list(object({from:scalar,to:text},['from','to']),12)]))),
},['kind','fields']);
const source=object({path:text,sha256:sha,owner:location,availableAt:location,ownerField:{enum:['enterpriseKey','name']},
 sheetIndex:{type:'integer',minimum:0,maximum:7},tables:list(table,500,1)},['path','sha256','owner','ownerField','tables']);
export const VAT_INPUT_SCHEMA=object({
 version:{const:'finance-vat-planning-materials/1'},sources:list(source,64,1),
},['version','sources']);
export function vatPlanningContract(){return {
 recordType:'vat_planning',tool:'finance_vat_plan',schema:VAT_PLANNING_SCHEMA,inputSchema:VAT_INPUT_SCHEMA,fields:VAT_FIELDS,
 guidance:[
 '用获准宿主读取原件，整理位置映射到 FINANCE_AUDIT_DIR/agent-materials 下的 UTF-8 JSON。每份原件在 FINANCE_SOURCE_ROOT 内，绑定实际 SHA256 和主体（本企业/购方）。原件无内部企业键时绑定原件中的登记企业名称。',
 'JSON 的 rowsPointer 指向原数组，key 取该行的原字段，jsonPointer 取文件中固定位置。XLSX 用 sheetIndex、firstRow（首条数据行）、可选 lastRow 和 column（1 起），row+column 可引用全表表头的所属期或企业。一个表可产生多张票。其他格式由宿主给出 value 和实际 locator，结果标为宿主观察。映射与覆盖仍待业务复核。原件另有到件/可用日期时，以 availableAt 绑定，和逐行 knownAt 双重截止；不能把开票日用作收件可知日。',
 'opening.period 是 target 上月，carryCredit 为期末留抵；scope=monthly_general_domestic，inventoryCoverage=complete 表示提供者的范围声明覆盖以前未用票、本期资料、已确认/已申报事实。未用票逐张从资料归集，不能把进项票余额重复并入期初留抵。',
 'invoice 以 issuer（稳定销方标识）+invoiceNumber 唯一，taxAmount 为进项税额。receipt 可为可信收件日或 YYYY-MM；issueDate 可省略。eligibility=eligible/ineligible/unknown/red。eligibleFrom/eligibleThrough 为有依据的可用范围，默认最早收件月或更晚的开票月，未给终期时以测算窗口内持续有效为条件。',
 'confirmation 为不可改的已确认或已申报进项，taxPeriod 是原件明确的税款所属期，operationDate 是实际操作日，可跨月；仅有操作日不能推出所属期。每条资料用 knownAt（首次可知日/月），月精度在月末才作为当时已知。invoice 可用收件时间作为首次可知时间。较晚的确认应在单独的确认资料给出。',
 'month 逐月取 outputVat、inputVatTransferOut、prepaidVat；basis=actual/forecast，state=open/filed，otherEffects=none/unsupported。完整月份预测须来自决策日已知的预算或有据假设。可把历史或合同底稿的实际数额指向未来月份作为有据条件（basis 用预测依据中的 forecast）；只预测时不得把未来实绩改标签。未明确的预缴、转出、其他影响不可作零处理。',
 '原件没有内部标签时，Agent 可用 {assume,reason} 明示条件，适用于 scope/inventoryCoverage、预测月份及 basis=forecast、state=open、otherEffects=none、零转出/预缴。其他字段从定位取值。条件绑定同表原件及 knownAt，系统会列出假设字段，理由在本机映射。可按决策日已知的历史销项或合同预算推演多个未来月份，保持两方案预测一致。若缺件，仍可先查看候选和具体缺口。',
 '混合状态表用 statusFilter 绑定状态列，列出要采用和明确排除的状态（例如已勾选、未勾选、合计）。未知状态须核对。纯确认清单可不加筛选，使用 firstRow/lastRow 限定明细。确认清单有逐票税额时可直接采用，无需重复提供收件资料。',
 '日期接受 YYYYMM、YYYY-MM、YYYY-MM-DD 及本地日期时间，XLSX 支持常见日历日期格式。按原精度保留，月度事实不要求虚构日。已申报月份可从独立 filing 表取得（period/knownAt），即使月预测写为 open 也禁止改选。',
 '先省略 baseline/plan 查看候选。再把匿名 invoiceRef 和自选 period 组成任意两组选择；未指定即保留未用。固定确认在两方案中始终生效。复用 expectedBasis 锁定取数口径，offset/limit 翻阅候选。through 至少年末且尽量延至下一可用期；普通次月付款仅为预测条件。金额为元。',
 ],};
}
