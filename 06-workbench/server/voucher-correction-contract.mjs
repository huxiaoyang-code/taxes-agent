import {BUSINESS_EVIDENCE_SCHEMA} from './business-evidence.mjs';
import {CORRECTION_PROOF_SCHEMA} from './voucher-correction-proof.mjs';

const money={type:'number',minimum:0};
const entry={
  type:'object',additionalProperties:false,required:['code'],
  properties:{code:{type:'string',minLength:1},summary:{type:'string'},debit:money,credit:money},
};

export const VOUCHER_CORRECTION_SCHEMA={
  type:'object',additionalProperties:false,required:['action','accountSetId','period','voucherId'],
  properties:{
    action:{enum:['inspect','apply']},accountSetId:{type:'integer',minimum:1},
    period:{type:'string',pattern:'^202[67]-(0[1-9]|1[0-2])$'},voucherId:{type:'integer',minimum:1},
    operationId:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'},
    expectedFingerprint:{type:'string',pattern:'^[a-f0-9]{64}$'},voucher_date:{type:'string',format:'calendar-date'},
    summary:{type:'string',maxLength:1000},entries:{type:'array',minItems:2,maxItems:400,items:entry},
    businessEvidence:BUSINESS_EVIDENCE_SCHEMA,proof:CORRECTION_PROOF_SCHEMA,
  },
  oneOf:[
    {properties:{action:{const:'inspect'}},maxProperties:4},
    {properties:{action:{const:'apply'}},required:['operationId','expectedFingerprint','voucher_date','summary','entries','businessEvidence','proof']},
  ],
};
