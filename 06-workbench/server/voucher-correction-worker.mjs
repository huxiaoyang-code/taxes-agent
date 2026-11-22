import {parentPort,workerData} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {resolveDirectFinanceTarget} from './direct-finance-target.mjs';
import {withRequestMetadata} from './local-audit-coordinator.mjs';

function amounts(v,scope){
  return {voucherId:v.id??v.voucherId,voucher_date:v.voucher_date,status:v.status,
    entries:v.entries.map((e,index)=>({lineNo:index+1,
      accountRef:createHash('sha256').update(JSON.stringify([scope.databaseInstanceId,scope.accountSetId,e.code])).digest('hex'),
      debit:e.debit,credit:e.credit}))};
}

async function run({args,context}){
  // 打开写连接前先以只读方式校验已有库的磁盘身份。会计层还要校验真正执行的句柄。
  const actual=resolveDirectFinanceTarget(args,context.dbPath).scope;
  if(['databaseInstanceId','enterpriseKey','accountSetId','period'].some(key=>actual[key]!==context.scope[key]))
    throw Object.assign(Error('finance_correction_scope_mismatch'),{code:'finance_correction_scope_mismatch'});
  const A=await import('./accounting.mjs');
  const inspect=()=>A.inspectVoucherCorrection(args.accountSetId,{voucherId:args.voucherId,period:args.period},context);
  if(args.action==='inspect'){
    const observed=inspect();
    return {...amounts(observed,context.scope),status:'inspected',voucherStatus:observed.status,period:args.period,fingerprint:observed.fingerprint};
  }
  const corrected=await withRequestMetadata({operationId:args.operationId,actor:'agent'},()=>A.correctVoucher(args.accountSetId,args,context));
  // 相同操作重试可发生在封账或后续人工更改之后。已提交回执与当前可更正状态分开返回。
  let readback;
  try{
    const current=inspect();
    readback={readbackStatus:'observed',currentFingerprint:current.fingerprint,
      readbackMatches:corrected.afterFingerprint===current.fingerprint};
  }catch{
    readback={readbackStatus:'unavailable',currentFingerprint:null,readbackMatches:null};
    try{
      const current=A.getVoucher(args.accountSetId,args.voucherId);
      readback={...readback,readbackStatus:'no_longer_eligible',currentVoucherStatus:current.status,
        current:amounts(current,context.scope)};
    }catch{ /* 原凭证可能已按其他有据操作处理，以原成功回执报告。 */ }
  }
  return {status:'posted',operationId:corrected.operationId,voucherId:corrected.voucherId,period:corrected.period,
    before:amounts(corrected.before,context.scope),after:amounts(corrected.after,context.scope),beforeFingerprint:corrected.beforeFingerprint,
    afterFingerprint:corrected.afterFingerprint,...readback};
}

try{parentPort.postMessage({result:await run(workerData)});}
catch(error){
  // 只返回程序错误码，业务文本、路径及原始错误保存在本机。
  const candidate=error.code??error.message;
  const code=/^[a-z][a-z0-9_]{1,100}$/.test(candidate??'')?candidate:'worker_failed';
  parentPort.postMessage({error:code.startsWith('finance_')?code:'finance_correction_'+code});
}
