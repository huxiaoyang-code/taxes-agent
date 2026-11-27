const callIds={type:'array',minItems:1,maxItems:20,uniqueItems:true,items:{type:'string',pattern:'^\\d{8}T\\d{9}Z_[a-f0-9-]{36}$'}};
const filename={type:'string',minLength:1,maxLength:128};
const materialId={type:'string',minLength:2,maxLength:100,pattern:'^[^\\r\\n]+$'};
const month={type:'string',pattern:'^202[67]-(0[1-9]|1[0-2])$'};
const digest={type:'string',pattern:'^[a-f0-9]{32}$'};
const delivery={type:'object',additionalProperties:false,properties:{
 version:digest,reviewVersion:digest,since:digest,evidence:{const:true},issue:{type:'string',pattern:'^[a-z][a-z0-9_]{0,119}$'},
 role:{enum:['bookkeeper','product','accountant']},offset:{type:'integer',minimum:0,maximum:1000000}
},allOf:[{not:{required:['reviewVersion','version']}},{not:{required:['reviewVersion','since']}},
 {if:{anyOf:[{required:['issue']},{required:['evidence']}]},then:{anyOf:[{required:['version']},{required:['reviewVersion']}] }},
 {not:{required:['issue','since']}},{not:{required:['evidence','since']}},
 {if:{required:['offset']},then:{anyOf:[{required:['version']},{required:['reviewVersion']},{required:['role']}]}}]};
const amountMapping={type:'object',additionalProperties:false,required:['column','value'],properties:{
 column:{type:'string',minLength:1,maxLength:80},value:{type:'string',minLength:1,maxLength:32},
}};
const reference={type:'object',additionalProperties:false,required:['file','line','id','disposition'],properties:{
 file:filename,line:{type:'integer',minimum:1,maximum:100000},id:materialId,disposition:{enum:['explained','outstanding']},
 amounts:{type:'array',maxItems:10,items:amountMapping},
}};
const missingMaterial={type:'object',additionalProperties:false,required:['id','period','impact'],properties:{
 id:materialId,period:month,impact:{type:'string',minLength:2,maxLength:160},
}};
const deliveryCheck={type:'object',additionalProperties:false,required:['balanceFile','handoffFile'],properties:{
 balanceFile:filename,handoffFile:filename,missingMaterials:{type:'array',maxItems:50,items:missingMaterial},
 references:{type:'array',maxItems:50,items:reference},
}};
export const FINANCE_PERIOD_REVIEW_SCHEMA={type:'object',additionalProperties:false,properties:{
 target:{type:'object',additionalProperties:false,required:['accountSetId','period'],properties:{accountSetId:{type:'integer',minimum:1},period:{type:'string',pattern:'^202[67]-(0[1-9]|1[0-2])$'}}},
 precedingPlanPeriod:{type:'string',pattern:'^202[67]-(0[1-9]|1[0-2])$'},beforeCallId:callIds.items,callIds,offset:{type:'integer',minimum:0,maximum:1000000},limit:{type:'integer',minimum:1,maximum:50},
 deliveryCheck,delivery,
 unboundCalls:{type:'object',additionalProperties:false,required:['callIds'],properties:{callIds}}
},oneOf:[{required:['target'],not:{anyOf:[{required:['unboundCalls']},{required:['delivery']}]}},
 {required:['delivery'],maxProperties:1},
 {required:['unboundCalls'],not:{anyOf:['target','callIds','offset','limit','precedingPlanPeriod','deliveryCheck','delivery'].map(key=>({required:[key]}))}}],
 allOf:[{not:{required:['deliveryCheck','precedingPlanPeriod']}},{not:{allOf:[{required:['callIds']},{anyOf:[{required:['offset']},{required:['limit']}]}]}},
 {if:{required:['beforeCallId']},then:{required:['target','precedingPlanPeriod'],not:{anyOf:[{required:['offset']},{required:['callIds']}]}}}]};
