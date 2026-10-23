import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withBackend } from './enterprise-identity-http.test.mjs';
for(const [tag,standard,profile,revenue,expense,capital,profit] of [['small','小企业会计准则','small-2011-basic-v1','5001','5602','3001','3103'],['enterprise','企业会计准则','enterprise-2019-general-basic-v1','6001','6602','4001','4103']]){
 test(`${tag} HTTP manual create → monthly append → depreciation not applicable → carry/close → reports and CSV`,async()=>withBackend(async({http})=>{
 const enterprise={enterpriseKey:'HTTP-PROFILE-'+tag};const meta={name:'合成HTTP准则',accounting_standard:standard,start_period:'2026-01'};
 const r=await http('POST','/agent/tools/account_set_create',{...meta,enterprise,profileId:profile});assert.equal(r.status,200);const id=r.data.id;assert.equal(r.data.accounting_profile_id,profile);
 assert.equal((await http('PUT',`/api/account-sets/${id}/opening-balances`,{items:[{code:'1002',debit:1000},{code:capital,credit:1000}]})).status,200);
 for(const [period,income,cost,net,cash] of [['2026-01',300,100,200,1200],['2026-02',200,50,150,1350]]){
  const body={payload:{account_set:meta,vouchers:[{period,sourceVoucherId:tag+'-'+period,entries:[{code:'1002',debit:income},{code:revenue,credit:income}]},{period,sourceVoucherId:tag+'-expense-'+period,entries:[{code:expense,debit:cost},{code:'1002',credit:cost}]}]},mode:'append',accountSetId:id,source:{system:'http-profile',...enterprise},batchId:tag+'-'+period,confirmNewBinding:true,dryRun:false,profileId:profile};
  const append=await http('POST','/api/import/incremental',body);assert.equal(append.status,201,JSON.stringify(append.data));
  assert.equal((await http('POST','/api/import/incremental',body)).data.status,'idempotent_replay');
  const check=(await http('GET',`/api/account-sets/${id}/period-end-check?period=${period}`)).data;assert.equal(check.steps.find(s=>s.id==='depreciation').status,'not_applicable');
  const carry=await http('POST',`/api/account-sets/${id}/carry-forward`,{period});assert.equal(carry.status,201,JSON.stringify(carry.data));
  const ready=(await http('GET',`/api/account-sets/${id}/period-end-check?period=${period}`)).data;assert.equal(ready.ready,true);assert.equal(ready.steps.length,7);
  assert.equal((await http('POST',`/api/account-sets/${id}/periods`,{period,status:'closed'})).status,200);
  const is=(await http('GET',`/api/account-sets/${id}/reports/income-statement?period=${period}`)).data;assert.equal(is.current['净利润'],net);assert.equal(is.accountingContext.profileId,profile);assert.equal(is.reportStatus.complete,true);
  const tb=(await http('GET',`/api/account-sets/${id}/reports/trial-balance?period=${period}`)).data;assert.equal(tb.lines.find(l=>l.code==='1002').closing_debit,cash);assert.equal(tb.lines.find(l=>l.code===profit).closing_credit,period==='2026-01'?200:350);
  for(const kind of ['balance-sheet','income-statement','cash-flow-statement','trial-balance','ledger']){
   const q=`period=${period}&format=csv`+(kind==='ledger'?'&code=1002':'');const out=await http('GET',`/api/account-sets/${id}/reports/${kind}/export?${q}`);assert.equal(out.status,200,out.text);assert.ok(out.text.includes(profile));
  }
  for(const kind of ['balance-sheet','cash-flow-statement']){const out=(await http('GET',`/api/account-sets/${id}/reports/${kind}?period=${period}`)).data;assert.equal(out.reportStatus.complete,true);}
 }
 console.log('independent HTTP amounts',tag,'Jan net200/cash1200; Feb net150/cash1350');
 }));
}
