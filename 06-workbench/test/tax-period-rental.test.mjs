// 纯合成租赁回归：真实 stdio MCP、独立手算金额；不启动模型，不触碰真实账库。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {resolveDirectFinanceTarget} from '../server/direct-finance-target.mjs';

const root=mkdtempSync(join(tmpdir(),'tax-period-rental-synthetic-'));
const dataDir=join(root,'database'),sourceRoot=join(root,'originals'),auditDir=join(root,'calls');
mkdirSync(sourceRoot);
process.env.WORKBENCH_DATA_DIR=dataDir;
const accounting=await import('../server/accounting.mjs');
const {db}=await import('../server/db.mjs');
const entity={kind:'company',industry:'rental_property',profileId:'enterprise-2019-general-basic-v1',businessStartDate:'2026-03-01',vatStatus:'general',vatPeriod:'monthly',vatReliefWaived:false,incomeLevyMethod:'actual_accounts',bookkeepingMethod:'double_entry'};
const set=accounting.createAccountSet({name:'合成两月租赁回归公司',start_period:'2026-03',profileId:entity.profileId,enterprise:{enterpriseKey:'SYNTHETIC-PERIOD-RENTAL'}});
const databasePath=join(dataDir,'workbench.db');
const server=fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url));
function client(){return new McpStdioClient(server,{cwd:root,timeoutMs:30000,env:{FINANCE_MCP_PROFILE:'direct',FINANCE_SOURCE_ROOT:sourceRoot,FINANCE_AUDIT_DIR:auditDir,FINANCE_DATABASE_PATH:databasePath,WORKBENCH_DATA_DIR:dataDir,FINANCE_API_BASE:'http://127.0.0.1:1'}}).start();}
function fact(id,type,date,fields={}){return {id,type,date,enterpriseKey:'SYNTHETIC-PERIOD-RENTAL',businessIdentity:{issuerKey:'SYNTHETIC-ISSUER',documentNumber:id,event:type},originalRefs:[{originalId:'original',locator:`记录 ${id}`,extractionReason:'合成原件明确记载此记录全部业务字段'}],...fields};}
function records(){return [
 fact('ENTITY','entity','2026-03-01',{entity}),
 fact('OPEN-VAT','opening_vat','2026-03-01',{asOfPeriod:'2026-03',declarationVerified:true,amount:'0.00'}),
 fact('RENT','rental','2026-03-01',{taxJurisdiction:'domestic',specialVatTreatment:'ordinary',assetKind:'real_estate',role:'lessor',classification:'operating',crossRegion:false,startDate:'2026-03-01',endDate:'2026-04-30',rentFreeDays:0,variableRent:false,totalContractRent:'6100.00',priceIncludesVat:false,invoiceKind:'ordinary',collectionSchedule:[{dueDate:'2026-03-15',amount:'6100.00',priceIncludesVat:false,invoiceKind:'ordinary'}]}),
 fact('RENT-RECEIPT','collection','2026-03-15',{relatedFactId:'RENT',bankAccountId:'SYNTHETIC-BANK',bankReference:'SYNTHETIC-RENT-BANK-0315',amount:'6649.00'}),
 fact('MARCH-EXPENSE','expense','2026-03-20',{use:'admin',gross:'4000.00',net:'4000.00',invoiceTax:'0.00',inputVatTreatment:'non_deductible',settlement:'paid',benefitPeriod:'2026-03',invoiceKind:'ordinary'}),
 ...['2026-03','2026-04'].map(period=>fact(`COVER-${period}`,'period_coverage',period==='2026-03'?'2026-03-31':'2026-04-30',{period,complete:true,accountsCovered:true,unbilledSalesCovered:true,bankCovered:true}))
];}
let sourceNumber=0;
function input(period,rows=records()){
 rows=rows.filter(row=>row.date.slice(0,7)<=period);
 const number=++sourceNumber,path=join(sourceRoot,`合成原始记录-${number}.json`);
 writeFileSync(path,JSON.stringify({synthetic:true,notes:['整个61日租期的经济利益明确按日均匀实现。','三月一次性约定应收6100元及VAT549元，并有6649元实际收款。','未提供其他税费义务、房产权属、所得税资格、亏损或税法选择资料。'],records:rows},null,2));
 if(period==='2026-03')return {target:{accountSetId:set.id,period},originals:[{id:'original',path}],records:rows};
 // 原生合同要求每份raw的业务事实与该raw同月；跨月必须逐月文件，不能改真实日期。
 const {scope}=resolveDirectFinanceTarget({accountSetId:set.id,period},databasePath),sources=[];
 for(const month of [...new Set(rows.map(row=>row.date.slice(0,7)))].sort()){
  const rawPath=join(sourceRoot,`整理记录-${number}-${month}.json`);
  writeFileSync(rawPath,JSON.stringify({version:'agency-raw-facts/1',scope:{...scope,period:month},records:rows.filter(row=>row.date.startsWith(month))}));
  sources.push({path:rawPath});
 }
 const manifestPath=join(sourceRoot,`资料目录-${number}.json`);
 writeFileSync(manifestPath,JSON.stringify({version:'agency-business-materials/1',scope,originals:[{id:'original',path}],sources}));
 return {manifestPath,dbPath:databasePath};
}
async function call(c,name,args){const response=await c.call(name,args);assert.equal(response.isError,false,response.text);assert(response.data);return response.data;}
function native(result){return JSON.parse(readFileSync(join(auditDir,'artifacts',result.evidence.callRef,'workpaper.json'),'utf8'));}
function due(workpaper,id){return workpaper.obligations.find(o=>o.obligationId===id);}
function entryCents(vouchers,period,code,side){return vouchers.filter(v=>v.period===period).flatMap(v=>v.entries).filter(e=>e.code===code).reduce((n,e)=>n+Math.round(Number(e[side])*100),0);}
function amounts(result,workpaper){return {ledger:result.ledgerAmounts,taxes:result.calculationResults.taxes,rent:workpaper.accounting.vouchers.filter(v=>v.factId==='RENT').map(({factId,period,date,entries})=>({factId,period,date,entries})),issues:result.review.issues};}
function incomplete(result,workpaper){
 assert.equal(result.review.submittable,false);assert.equal(result.review.periodComplete,false);
 const income=due(workpaper,'corporate_income');assert.equal(income.status,'missing');assert.equal(Object.hasOwn(income,'due'),false);
 assert.equal(Object.hasOwn(income,'smallLowProfit'),false,'缺资格资料不能补出小型微利资格');
 assert(result.review.issues.length>0,'缺其他义务资料仍须保留未完成');
}

test('租赁两月独立金额、税点、重复稳定与新进程接续',{timeout:120000},async t=>{
 const c=client();await c.initialize();let march,april,marchWork,aprilWork;
 try{
  await t.test('真实MCP发现并读取合同，披露缺口不伪装完整租赁示例',async()=>{
   const tools=(await c.rpc('tools/list')).result.tools;
   for(const name of ['finance_record_contract','finance_workpaper','finance_tax_calculate','finance_period_review'])assert(tools.some(tool=>tool.name===name));
   const inventory=await call(c,'finance_record_contract',{});assert(inventory.recordTypes.some(type=>type.recordType==='rental'));
   const guide=await call(c,'finance_record_contract',{recordType:'rental'});
   assert.equal(guide.recordType,'rental');assert.equal(guide.contractCompleteness,'common_schema_and_rule_references_only');
   assert.equal(Object.hasOwn(guide.examples,'rental'),false);assert(guide.rules.length>0);assert(guide.codeReferences.length>0);
  });
  await t.test('同一三月输入真实执行三次，收入3100及亏损900不随收款改为6100',async()=>{
   const args=input('2026-03'),results=[];
   for(let n=0;n<3;n++){
    const result=await call(c,'finance_workpaper',args),workpaper=native(result);results.push({result,workpaper});
    assert.equal(result.ledgerAmounts.scopeMeaning,'replay_range_cumulative_not_single_month');
    assert.equal(result.ledgerAmounts.revenue,3100);assert.equal(result.ledgerAmounts.profitBeforeTax,-900);
    assert.equal(entryCents(workpaper.accounting.vouchers,'2026-03','6001','credit'),310000);
    assert.equal(entryCents(workpaper.accounting.vouchers,'2026-03','6602','debit'),400000);
    assert.equal(result.ledgerAmounts.bank,2649,'6649实际收款减4000实际费用支付');
    assert.equal(due(workpaper,'vat').due,'549.00');incomplete(result,workpaper);
   }
   ({result:march,workpaper:marchWork}=results[0]);
   assert.deepEqual(amounts(results[1].result,results[1].workpaper),amounts(results[0].result,results[0].workpaper));
   assert.deepEqual(amounts(results[2].result,results[2].workpaper),amounts(results[0].result,results[0].workpaper));
   assert.equal(new Set(results.map(({result})=>result.evidence.callRef)).size,3,'重复执行各自留痕');
  });
  await t.test('四月当月3000、累计6100，VAT三月549四月0；会计拆分不证明所得税节税',async()=>{
   april=await call(c,'finance_tax_calculate',{...input('2026-04'),obligationIds:['vat','corporate_income']});aprilWork=native(april);
   // 独立手算：6100÷61=100元/日；三月31日、四月30日；全合同6100。
   assert.equal(april.ledgerAmounts.scopeMeaning,'replay_range_cumulative_not_single_month');
   assert.equal(april.ledgerAmounts.revenue,6100,'四月投影是累计，不能标作四月收入');
   assert.equal(entryCents(aprilWork.accounting.vouchers,'2026-04','6001','credit'),300000);
   assert.equal(entryCents(marchWork.accounting.vouchers,'2026-03','6001','credit')+entryCents(aprilWork.accounting.vouchers,'2026-04','6001','credit'),610000);
   assert.equal(april.ledgerAmounts.profitBeforeTax,2100,'合同累计6100减三月真实费用4000');
   assert.deepEqual(marchWork.accounting.vatTransactions.map(row=>({date:row.date,net:row.net,tax:row.tax})),[{date:'2026-03-15',net:'6100.00',tax:'549.00'}]);
   const marchVat=due(marchWork,'vat'),aprilVat=due(aprilWork,'vat');
   assert.equal(marchVat.status,'calculated');assert.equal(marchVat.due,'549.00');assert.equal(marchVat.paymentState,'payment_evidence_missing');
   assert.equal(aprilVat.status,'calculated');assert.equal(aprilVat.due,'0.00');
   assert.deepEqual(aprilVat.replay.map(row=>({through:row.through,outputTax:row.outputTax,due:row.due})),[{through:'2026-03',outputTax:'549.00',due:'549.00'},{through:'2026-04',outputTax:'0.00',due:'0.00'}]);
   assert.equal(april.calculationResults.taxes.find(row=>row.obligationId==='corporate_income').status,'missing');
   incomplete(april,aprilWork);
  });
  await t.test('缺期初VAT或覆盖资料保留已知租金，不补零税/资格/全期完成',async()=>{
   for(const missingType of ['opening_vat','period_coverage']){
    const rows=records().filter(row=>row.type!==missingType),result=await call(c,'finance_tax_calculate',{...input('2026-03',rows),obligationIds:['vat','corporate_income']}),workpaper=native(result);
    assert.equal(result.ledgerAmounts.revenue,3100);
    const vat=due(workpaper,'vat');assert.equal(vat.status,'missing');assert.equal(Object.hasOwn(vat,'due'),false);
    incomplete(result,workpaper);
   }
  });
  await t.test('缺约定应收日期不以收款日猜填租约税点或选择优惠',async()=>{
   const rows=records();delete rows.find(row=>row.type==='rental').collectionSchedule;
   const result=await call(c,'finance_workpaper',input('2026-03',rows)),workpaper=native(result);
   assert(workpaper.accounting.issues.some(issue=>issue.code==='agency_lease_complexity_uncovered'));
   assert.equal(workpaper.accounting.vouchers.some(v=>v.factId==='RENT'),false);
   assert.equal(due(workpaper,'vat').status,'missing');incomplete(result,workpaper);
  });
 }finally{await c.close();}
 try{
  await t.test('新MCP进程用既有调用接续，真实身份相符仍保持缺件和未完成',async()=>{
   const fresh=client();await fresh.initialize();
   try{
    for(const [period,result] of [['2026-03',march],['2026-04',april]]){
     const bound=period==='2026-03';
     if(!bound){const rejected=await fresh.call('finance_period_review',{target:{accountSetId:set.id,period},callIds:[result.evidence.callRef]});assert.equal(rejected.isError,true);assert.match(rejected.text,/finance_period_review_scope_unverified/);}
     const review=await call(fresh,'finance_period_review',bound?{target:{accountSetId:set.id,period},callIds:[result.evidence.callRef]}:{unboundCalls:{callIds:[result.evidence.callRef]}});
     assert.equal(review.mode,bound?'bound_period_review':'unbound_call_review');assert.equal(review.scopeVerified,bound);assert.equal(review.periodComplete,false);
     assert.equal(review.businessStatus,bound?'requires_goal_review':'identity_unverified');assert.equal(review.pagination.coverage,'selected_calls_only');
     assert.equal(review.records.length,1);const record=review.records[0];
     assert.equal(record.callId,result.evidence.callRef);assert.equal(record.kind,'native_workpaper');assert.equal(record.scopeVerified,bound);
     assert.equal(record.execution.status,'returned');assert.equal(record.businessStatus,'needs_inputs');assert(record.evidence.unresolvedCount>0);
     assert.equal(record.artifactIntegrity,'verified');assert.equal(record.sources.state,'unchanged');
     assert.equal(record.evidence.approvalVerified,false);assert.equal(record.evidence.postedVerified,false);assert.equal(record.evidence.filingVerified,false);
     assert.equal(Object.hasOwn(record,'ledgerAmounts'),false,'固定接续投影本身不提供当月金额复核证据');
    }
   }finally{await fresh.close();}
  });
 }finally{db.close();}
});
