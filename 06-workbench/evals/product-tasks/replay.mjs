// 评分器校准专用，逐次调用真实产品。其痕迹必须标成程序回放。
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {operatorStage} from './bank.mjs';
import {note,read,save,stdio} from './fixture.mjs';
import {next,planArgs,targetPeriod} from './vat.mjs';

const f=read(join(resolve(process.argv[2]),'reviewer','fixture.json'));
save(join(f.reviewer,'program-replay.json'),{modelInvoked:false,mode:'scripted_product_replay'});
if(f.task==='bank'){
  await stdio(f,async call=>{
    await call('ledger_query',{accountSetId:f.accountSetId,period:f.period,code:'1002'});
    note(f.host,'核对表.csv','流水号,核对结论\nR1,已核上\nR2,已核上\nR3,待查\nR4,待查');
    for(const [stage,tool] of [['preview','bank_import_preview'],['import','bank_import'],['confirm','bank_confirm'],['readback','bank_matches']]){
      const draft=await operatorStage(f,stage);
      const args={accountSetId:f.accountSetId,draftRef:draft.draftRef};
      await call(tool,args);
      if(stage==='confirm')await call(tool,args);
    }
  });
} else {
  const current=await stdio(f,async call=>{
    const args=planArgs(f);
    if(f.task==='handoff'){
      const page=await call('finance_period_review',{target:{accountSetId:f.accountSetId,period:next},precedingPlanPeriod:targetPeriod});
      assert(page.records.some(r=>r.callId===f.previous));
    }
    const inventory=await call('finance_vat_plan',args);
    const select=(amount,period)=>({invoiceRef:inventory.invoices.find(r=>r.taxAmount===amount).invoiceRef,period});
    const options=f.task==='handoff'?{baseline:[],plan:[select('220.00',targetPeriod)],handoff:{previousCallId:f.previous}}:{
      baseline:[select('200.00',targetPeriod),select('150.00',targetPeriod),select('70.00',next)],
      plan:[select('200.00',targetPeriod),select('150.00',next),select('70.00',next)],handoff:{}
    };
    return call('finance_vat_plan',{...args,...options});
  });
  console.log(current.handoff.dataPath);
  if(f.task==='handoff'){
    // 再开干净进程、独立工作区，通过下一期入口取上版。评分者另读此处的产品调用记录。
    execFileSync(process.execPath,[fileURLToPath(new URL('./verify-handoff.mjs',import.meta.url)),f.root,current.callRef],{windowsHide:true});
  }
}
