const callIds={type:'array',minItems:1,maxItems:20,uniqueItems:true,items:{type:'string',pattern:'^\\d{8}T\\d{9}Z_[a-f0-9-]{36}$'}};
export const FINANCE_PERIOD_REVIEW_SCHEMA={type:'object',additionalProperties:false,properties:{
 target:{type:'object',additionalProperties:false,required:['accountSetId','period'],properties:{accountSetId:{type:'integer',minimum:1},period:{type:'string',pattern:'^202[67]-(0[1-9]|1[0-2])$'}}},
 callIds,offset:{type:'integer',minimum:0,maximum:1000000},limit:{type:'integer',minimum:1,maximum:50},
 unboundCalls:{type:'object',additionalProperties:false,required:['callIds'],properties:{callIds}}
},oneOf:[{required:['target'],not:{required:['unboundCalls']}},{required:['unboundCalls'],not:{anyOf:['target','callIds','offset','limit'].map(key=>({required:[key]}))}}],
 allOf:[{not:{allOf:[{required:['callIds']},{anyOf:[{required:['offset']},{required:['limit']}]}]}}]};
