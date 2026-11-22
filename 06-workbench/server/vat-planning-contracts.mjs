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
 baseline:list(selection,1500),plan:{oneOf:[list(selection,1500),object({strategy:{const:'earliest_eligible'}},['strategy'])]},expectedBasis:sha,
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
 opening:['period','knownAt','carryCredit','scope','inventoryCoverage','ytdSalesExcludingVat','ytdDueBeforePrepayment','ytdComparable','prepaymentBalance'],
 history:['period','knownAt','salesExcludingVat','dueBeforePrepayment','ytdComparable'],
 agreement:['period','effectiveThrough','knownAt','burdenMode','minimumPercent'],
 invoice:['knownAt','invoiceNumber','issuer','taxAmount','receipt','issueDate','eligibility','eligibleFrom','eligibleThrough'],
 portal:['knownAt','invoiceNumber','issuer','period','portalStatus'],
 confirmation:['knownAt','invoiceNumber','issuer','taxPeriod','operationDate','issueDate','taxAmount','receiptId','supersedes','confirmationState'],
 filing:['period','knownAt','declaredDue','declaredDueBeforePrepayment','receiptId','supersedes'],
 paymentCoverage:['period','knownAt','coveredThrough','coverageScope'],
 event:['knownAt','eventId','eventType','period','operationDate','amount','issuer','invoiceNumber','caseId','supersedes'],
 sale:['knownAt','transactionId','originalTransactionId','taxPointDate','salesExcludingVat','outputVat','billingDate'],
 month:['knownAt','period','basis','state','outputVat','invoicedOutputVat','uninvoicedOutputVat','salesExcludingVat','invoicedSales','uninvoicedSales','salesCoverage','inputVatTransferOut','otherInputVatTransferOut','prepaidVat','otherEffects','paymentDate'],
};
export const VAT_NUMERIC_FIELDS=new Set(['carryCredit','taxAmount','outputVat','inputVatTransferOut','otherInputVatTransferOut','prepaidVat','declaredDue','declaredDueBeforePrepayment','invoicedOutputVat','uninvoicedOutputVat','salesExcludingVat','invoicedSales','uninvoicedSales','amount','prepaymentBalance','dueBeforePrepayment','ytdSalesExcludingVat','ytdDueBeforePrepayment','minimumPercent']);
const fields=object(Object.fromEntries([...new Set(Object.values(VAT_FIELDS).flat())].map(k=>[k,readField])));
const table=object({
 kind:{enum:Object.keys(VAT_FIELDS)},fields,rowsPointer:pointer,firstRow:index,lastRow:index,
 statusFilter:object({location:readField,include:list(scalar,12,1),exclude:list(scalar,12,1)},['location','include','exclude']),
 // 例如用“可抵扣”映射成 eligible。金额、日期、票号不能映射。
 translations:object(Object.fromEntries(['scope','inventoryCoverage','eligibility','basis','state','otherEffects','portalStatus','eventType','burdenMode'].map(key=>[key,
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
 '部分票据或后续月份待核时，knownSubset.recommendation 仅比较已核票据在连续可测期间的两种已提交方案。excludedInvoices 分页列出冲突票的各份报送额；这些数值为同一张票的不同来源。依据不足时返回差额、可核月份和需补的材料。',
 '逐交易核对销项时，月报用 salesCoverage=complete_transactions 替代销售额及销项汇总。sale.transactionId 绑定同一合同履约/成交明细，taxPointDate 取依法核实的纳税义务发生日，销售额和销项为正向绝对额。补开票保留原交易号、原税点和原金额，只新增 billingDate；同笔业务只入原期一次。红字调整用新交易号、originalTransactionId 指向原业务和已核调整日期。多笔冲减不得超过原额。同一期若还提供汇总数，工具拒绝叠加。',
 '用 plan:{strategy:"earliest_eligible"} 与 baseline 对比时，程序按每张已核可抵票实际开放的首个可选所属期试算。已确认、已锁和条件不明的票按原状态处理。',
 '有正式用途确认撤销或更正时，用 confirmation.receiptId、supersedes 绑定原确认回执和新回执；撤销用 confirmationState=revoked、原税期和实际操作日期，核实的替代确认用 confirmed。更正申报的 filing 可同样依 receiptId/supersedes 替代原申报金额。无更正链、已申报或其他冲突状态保留锁或待核。',
 '单月及累计税负的分子是预缴抵减前应纳，分母为同口径不含税销售额；各期以原件绑定 salesExcludingVat。年中起点可用上月底 opening.ytdSalesExcludingVat/ytdDueBeforePrepayment、ytdComparable=true，或用 history 按当年一月至上月的每期已核发生额、ytdComparable=true。零销售与历史口径不齐时仍计算各期可核金额。跨年重新累计。',
 'agreement 从确认的客户约定读取 period（生效所属期）、可选 effectiveThrough、burdenMode=monthly/ytd、minimumPercent（百分数例如 3）。本工具专用于一般计税增值税应纳/可比不含税销售的内部最低参考；其他税种、分子或分母另行核对。两方案由 Agent 分别传入，按明确适用期逐期复核门槛及预测条件。未注明终期的约定跨月跨年沿用，直至下一版生效；仅一个月适用时须以来源绑定相同的起止月份。可行方案先比较年底尚保留的现金，再比较近期付款及较早使用进项。均未达时显示缺额，按最大单期缺额较小者比较。单月和累计会改变推荐且约定未明确时列缺口。',
 'yearEnd.unusedVat 表示截至年末已经持有且可继续结转的未用票额。selectableUnusedVat 单列在本次决策日仍可选该年末所属期、尚未使用的票额，包含次年收件并有该期门户窗口证据的原票。',
 'filing.declaredDue 为申报应补（预缴抵减后），declaredDueBeforePrepayment 为申报抵减前应纳。分别与同口径测算额核对。已申报期进入税负的分子来自申报原额，或在可核零预缴时取申报应补。月度和累计 simulatedBurden 单列方案值。出现同口径差额时保留资料和条件现金测算，查清并更正后再推荐。',
 'actualPaid 为已提供的支付回执小计。依据完税及缴付清单确有完整覆盖时，以 paymentCoverage 绑定 period、knownAt、coveredThrough、coverageScope（tax_period 为税款所属期全量支付；cash_month 为付款月全量支付）。无声明或只覆盖较早日期时，零笔回执和实际零缴付分别标明，预计尚待付款以无其他已付为条件。',
 'portal 与原票通过 issuer/invoiceNumber 关联，period 是门户明示可选择的纳税所属期，portalStatus=selectable/closed；按 knownAt 取截止日最近状态。上期已开、下月收件，原票日期和门户可选记录齐备，才可提前到相应所属期。实际确认、已报及不可抵用途继续锁定。',
 'month 的 outputVat 与 invoicedOutputVat+uninvoicedOutputVat 互斥，salesExcludingVat 与 invoicedSales+uninvoicedSales 互斥。拆分形式的两项均需提供，分项包含当期义务已发生的未开票业务及后续开票对原所属期的核销。paymentDate 可从缴款安排读取，默认次月预测。',
 'event 需有单据唯一 eventId、eventType、period（影响所属期）、operationDate（真实操作日期）、knownAt 和正金额 amount。payment 是已缴本期应补，prepayment 是有完税凭证、已核实可抵该主体普通增值税的预缴，refund_approved 是核准且本所属期应冲减留抵，refund_received 是到账（同一退税 caseId），refund_requested 为已申请尚待核准；tax_credit_increase、red_input、transfer_out 需绑定原票 issuer 和 invoiceNumber，按核实适用的所属期和调整税额出具。eventId 重复只计一次；有更正单时以新 eventId 和 supersedes 指向被替代的同类单据。事件与月报的同一金额只选一个来源，冲减进项有逐笔事件时其余转出另绑 otherInputVatTransferOut 或显式零。原始材料应保留调整前后版本。',
 '有跨期预缴时绑定 opening.prepaymentBalance（包括已核零）及逐笔 prepayment 完税凭证；month.prepaidVat 仅用于原有单月已核可抵额，不能与凭证重叠，余额结转需核实适用范围。实际缴付、预缴和退税到账按 operationDate 归集，期前所属期在本期支付亦可入账。留抵退税核准冲余额，到账才计入现金。filing.declaredDue 取申报表应补数；与模拟金额分别保留。',
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
