import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withMcp,ok,local } from './enterprise-identity-test.mjs';
for(const [tag,standard,profile,revenue,expense,capital] of [['small','小企业会计准则','small-2011-basic-v1','5001','5602','3001'],['enterprise','企业会计准则','enterprise-2019-general-basic-v1','6001','6602','4001']]){
 test(`${tag} stdio explicit profile create → append two months → period close → safe model reports`,async()=>withMcp(async({client,http})=>{
 const enterprise={enterpriseKey:'STDIO-PROFILE-'+tag}; const meta={name:'MCP profile synthetic',accounting_standard:standard,start_period:'2026-01'};
 const set=await ok(client,'account_set_create',{...meta,enterprise,profileId:profile});const id=set.accountSetId;assert.equal((await local(http,set)).accounting_profile_id,profile);
 await ok(client,'opening_balance_set',{accountSetId:id,items:[{code:'1002',debit:1000},{code:capital,credit:1000}]});
 for(const [period,income,cost,net,cash] of [['2026-01',300,100,200,1200],['2026-02',200,50,150,1350]]){
  const args={payload:{account_set:meta,vouchers:[{period,sourceVoucherId:tag+period,entries:[{code:'1002',debit:income},{code:revenue,credit:income}]},{period,sourceVoucherId:tag+'expense'+period,entries:[{code:expense,debit:cost},{code:'1002',credit:cost}]}]},source:{system:'stdio-profile',...enterprise},accountSetId:id,mode:'append',batchId:'STDIO-'+tag+'-'+period,confirmNewBinding:true,dryRun:false,profileId:profile};
  const append=await ok(client,'book_import_incremental',args);assert.equal(append.projection.status,'applied');const replay=await ok(client,'book_import_incremental',args);assert.equal(replay.projection.status,'idempotent_replay');
  const check=await local(http,await ok(client,'period_end_check',{accountSetId:id,period}));assert.equal(check.steps.find(x=>x.id==='depreciation').status,'not_applicable');
  await ok(client,'carry_forward_profit',{accountSetId:id,period});const ready=await local(http,await ok(client,'period_end_check',{accountSetId:id,period}));assert.equal(ready.ready,true);assert.equal(ready.steps.length,7);
  await ok(client,'period_set_status',{accountSetId:id,period,status:'closed'});
  const isEnvelope=await ok(client,'finance_query',{nodeId:'report.income_statement',accountSetId:id,period});const is=await local(http,isEnvelope);assert.equal(is.current['净利润'],net);assert.equal(is.reportStatus.complete,true);
  for(const nodeId of ['report.balance_sheet','report.cash_flow_statement']){const env=await ok(client,'finance_query',{nodeId,accountSetId:id,period});assert.equal((await local(http,env)).reportStatus.complete,true);}
  const tb=await local(http,await ok(client,'finance_query',{nodeId:'report.trial_balance',accountSetId:id,period}));assert.equal(tb.lines.find(x=>x.code==='1002').closing_debit,cash);
  await ok(client,'ledger_query',{accountSetId:id,period,code:'1002'});
 }
 console.log('independent MCP amounts',tag,'Jan net200/cash1200; Feb net150/cash1350');
 }));
}
