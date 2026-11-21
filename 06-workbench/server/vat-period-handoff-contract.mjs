const id = {type:'string', pattern:'^\\d{8}T\\d{9}Z_[a-f0-9-]{36}$'};
const text = {type:'string',minLength:1,maxLength:1200};
const pointer = {type:'string',minLength:1,maxLength:512,pattern:'^/(?:[^~]|~[01])*$'};
const date = {type:'string',format:'calendar-date'};
const object = (properties,required=[])=>({type:'object',additionalProperties:false,properties,required});

// 公开官文仅绑定已读取的片段。企业事实另从已核身份的当次 JSON 原件取值。
const condition = object({
 source:{type:'integer',minimum:0,maximum:63},valuePointer:pointer,
 equals:{anyOf:[text,{type:'boolean'},{type:'number'}]},knownAtPointer:pointer,
 validFromPointer:pointer,validThroughPointer:pointer,transactionDatePointer:pointer,
},['source','valuePointer','equals','knownAtPointer','validFromPointer','validThroughPointer']);
const review = object({
 callId:id,passage:text,question:text,interpretation:text,
 validity:object({from:date,fromPassage:text,through:date,throughPassage:text,transitionPassage:text},['from','fromPassage']),
 condition,appliesWhenMatched:{type:'boolean'},
},['callId','passage','question','interpretation']);
export const VAT_HANDOFF_SCHEMA = object({
 previousCallId:id,policyReviews:{type:'array',minItems:1,maxItems:24,items:review},
});
export const handoffGuidance = '首次查询及翻页只返回票簿。试算 baseline/plan 时自动生成会计交接；缺可选票或仅需当前资料时显式传 handoff:{}。交付时可传 handoff.previousCallId（同账套本期前版或前期规划）比较资料和金额，handoff.policyReviews 用 finance_rules 的 action=open 调用号和实际已读 passage 对照。question、interpretation 为待复核判断。condition 从本次已核身份的 JSON 原件按零起 source 及各 JSON Pointer 取企业事实、首次可知日、起止日；appliesWhenMatched 明示条件吻合/不吻合的含义。validity.from/fromPassage 与可选 through/throughPassage 须在已读原文中找到所指日期；transitionPassage 绑定过渡条款。条件依具体交易日判断时从同份原件绑定 transactionDatePointer。每次规划在本机保存独立版本，finance_period_review 可凭账套、期间与 callIds 取回。';
