// 全部为合成原件。进程 A 规划，关掉进程后由进程 B 接续，打开真实 HTML 和原生账表。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ExcelJS from 'exceljs';
import {syntheticVoucherEvidence} from './helpers/synthetic-posting-evidence.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const ptr=jsonPointer=>({jsonPointer});
const keys=(...names)=>Object.fromEntries(names.map(name=>[name,{key:name}]));
const json=(f,data)=>writeFileSync(f,JSON.stringify(data));
test('规划、次月新进程、会计四表、政策窗口配对及补证留版',async()=>{
 const root=mkdtempSync(join(tmpdir(),'synthetic-vat-handoff-')),originals=join(root,'originals'),ledger=join(root,'books');
 for(const d of [originals,ledger])mkdirSync(d,{recursive:true});
 process.env.WORKBENCH_DATA_DIR=ledger;process.env.FINANCE_SOURCE_ROOT=originals;
 const {db}=await import('../server/db.mjs'),A=await import('../server/accounting.mjs');
 const enterpriseKey='SYNTHETIC-VAT-HANDOFF',period='2026-06';
 const set=A.createAccountSet({enterprise:{enterpriseKey},name:'交接合成企业',taxpayer_type:'一般纳税人',start_period:period,accounting_standard:'小企业会计准则'});
 A.createVoucher(set.id,syntheticVoucherEvidence({period,status:'posted',entries:[{code:'1002',debit:1000},{code:'5001',credit:1000}]},originals));
 const target={accountSetId:set.id,period},actualKey=db.prepare('SELECT enterprise_key FROM import_enterprise_account_sets WHERE account_set_id=?').get(set.id).enterprise_key;
 const other=A.createAccountSet({enterprise:{enterpriseKey:'OTHER-HANDOFF'},name:'另一合成账套',start_period:period});
 db.close();
 const dbPath=join(ledger,'workbench.db'),generator=fileURLToPath(new URL('../scripts/finance-host-config.mjs',import.meta.url));
 const run=(script,...args)=>JSON.parse(execFileSync(process.execPath,[script,...args],{encoding:'utf8',windowsHide:true}));
 const workspace=(name,boundTarget,extra=[],preboundMaterials=false)=>{
  const dir=join(root,name);
  run(generator,'--host','claude-code','--node',process.execPath,'--api-base','http://127.0.0.1:1','--database',dbPath,'--source-root',originals,'--out',dir,...extra);
  const launcher=join(dir,'start-business-session.mjs');
  if(preboundMaterials)mkdirSync(join(dir,'finance-call-records','agent-materials'),{recursive:true});
  const bound=run(launcher,'--account-set-id',String(boundTarget.accountSetId),'--period',boundTarget.period,'--prepare-only');
  assert.equal(run(launcher,'--check').auditDir,bound.auditDir);
  return {auditDir:bound.auditDir,env:JSON.parse(readFileSync(join(dir,'.mcp.json'))).mcpServers.finance.env};
 };
 const june=workspace('六月工作区',target),audit=june.auditDir,prepared=join(audit,'agent-materials');
 mkdirSync(prepared,{recursive:true});
 const source=join(originals,'交易与试点资料.json'),inputPath=join(prepared,'定位.json');
 const doc={owner:actualKey,knownAt:'2026-06-30',prior:'2026-05',scope:'monthly_general_domestic',inventoryCoverage:'complete',credit:0,
  validFrom:'2026-05-01',validThrough:'2026-06-30',participant:false,transaction:'2026-06-15',
  months:[{period,basis:'actual',knownAt:'2026-06-30',state:'open',otherEffects:'none',inputVatTransferOut:0,prepaidVat:0,outputVat:100}],
  bills:[{issuer:'合成卖方',invoiceNumber:'TEST-1',receipt:'2026-06-01',issueDate:'2026-06-01',eligibility:'eligible',taxAmount:30}]};
 for(let month=7;month<=12;month++)doc.months.push({...doc.months[0],period:'2026-'+String(month).padStart(2,'0'),basis:'forecast'});
 const tables=[
  {kind:'opening',fields:{period:ptr('/prior'),scope:ptr('/scope'),inventoryCoverage:ptr('/inventoryCoverage'),carryCredit:ptr('/credit'),knownAt:ptr('/knownAt')}},
  {kind:'month',rowsPointer:'/months',fields:keys('period','basis','knownAt','state','otherEffects','inputVatTransferOut','prepaidVat','outputVat')},
  {kind:'invoice',rowsPointer:'/bills',fields:keys('issuer','invoiceNumber','receipt','issueDate','eligibility','taxAmount')},
 ];
 // 同一份原件另有期初承接和试点名单。首张工作表为封面，名单在已核的第二张表。
 const xlsx=join(originals,'承接与试点.xlsx'),wb=new ExcelJS.Workbook();
 wb.addWorksheet('封面').addRow(['封面']);
 const sh=wb.addWorksheet('企业登记'),day=s=>new Date(s+'T00:00:00Z');
 sh.addRow([actualKey,'2026-06-30','2026-05',0,'monthly_general_domestic','complete']);
 sh.addRow(['企业键','是否试点','首次可知日','有效起日','有效止日','业务日','备注','备注']);
 for(const [owner,known,from] of [[actualKey,'2026-06-29','2026-06-01'],['OTHER-ENTITY','2026-06-29','2026-06-01'],[actualKey,'2026-06-29','2026-07-01'],[actualKey,'2026-07-02','2026-06-01']]){
  const r=sh.addRow([owner,'已纳入',day(known),day(from),day('2026-08-31'),day('2026-06-15'),'A','B']);
  for(const col of [3,4,5,6])r.getCell(col).numFmt='yyyy-mm-dd';
 }
 await wb.xlsx.writeFile(xlsx);
 const at=column=>({row:1,column});
 const xSource={path:xlsx,sha256:sha(readFileSync(xlsx)),sheetIndex:1,ownerField:'enterpriseKey',owner:at(1),tables:[{kind:'opening',fields:{knownAt:at(2),period:at(3),carryCredit:at(4),scope:at(5),inventoryCoverage:at(6)}}]};
 const refresh=()=>{json(source,doc);json(inputPath,{version:'finance-vat-planning-materials/1',sources:[{path:source,sha256:sha(readFileSync(source)),ownerField:'enterpriseKey',owner:ptr('/owner'),tables},xSource]});};
 refresh();
 const server=fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url));
 const transport=fileURLToPath(new URL('./helpers/official-policy-stdio.mjs',import.meta.url));
 const start=(workspace,entry=server)=>new McpStdioClient(entry,{cwd:root,env:workspace.env}).start();
 const ok=async(c,tool,args)=>{const r=await c.call(tool,args);assert.equal(r.isError,false,r.text);return r.data;};
 const args={target,through:'2026-12',asOf:'2026-06-30',inputPath},one=start(june,transport);
 const condition={source:0,valuePointer:'/participant',equals:true,knownAtPointer:'/knownAt',validFromPointer:'/validFrom',validThroughPointer:'/validThrough',transactionDatePointer:'/transaction'};
 let first,firstDoc,choice,policy;
 try{
  await one.initialize();
  const url='https://www.gov.cn/zhengce/synthetic-vat-pilot.htm';
  const opened=await one.rpc('tools/call',{name:'finance_rules',arguments:{action:'open',url}});
  assert.notEqual(opened.result.isError,true);
  const article=opened.result.structuredContent,callId=opened.result._meta.financeCall.callId;
  assert.equal(article.status,'read');assert.equal(article.source.requestedUrl,url);
  assert.equal(sha(readFileSync(join(audit,callId,'result.json'))),JSON.parse(readFileSync(join(audit,callId,'end.json'))).output.sha256);
  policy={callId,passage:'合成试点实施',question:'试点是否适用',interpretation:'按原件试点名单判断',condition,appliesWhenMatched:true,validity:{from:'2026-06-01',fromPassage:'自2026年6月1日施行'}};
  const invalid=await one.rpc('tools/call',{name:'finance_rules',arguments:{action:'open'}});
  assert.equal(invalid.result.isError,true);
  const invalidId=invalid.result._meta.financeCall.callId;
  assert.deepEqual(JSON.parse(readFileSync(join(audit,invalidId,'input.json'))),{inputRedacted:true});
  const policies=[policy,{...policy,validity:{from:'2026-07-01',fromPassage:'第二阶段自2026年7月1日施行'}},{...policy,passage:'原文没有这段话'},{...policy,callId:invalidId}];
  const columns={owner:'企业键',value:{header:'是否试点',column:2},knownAt:'首次可知日',validFrom:'有效起日',validThrough:'有效止日',transactionDate:'业务日'};
  const sheetReview=(row,override={})=>({...policy,condition:{source:1,equals:'已纳入',sheet:{sheetIndex:1,row,headerRow:2,columns,...override}}});
  policies.push(sheetReview(3),sheetReview(4),sheetReview(5),sheetReview(6),sheetReview(3,{columns:{...columns,value:'名单中缺少的列'}}),sheetReview(3,{sheetIndex:0}),sheetReview(3,{columns:{...columns,value:'备注'}}));
  const inventory=await ok(one,'finance_vat_plan',args);
  assert.equal(inventory.delivery,'invoice_inventory');assert.equal(inventory.handoff,undefined);assert.equal(inventory.recommendation,null);
  const withoutPlan=await ok(one,'finance_vat_plan',{...args,handoff:{}});
  const inventoryPack=JSON.parse(readFileSync(withoutPlan.handoff.dataPath));
  assert.equal(inventoryPack.recommendation,null);assert.equal(inventoryPack.invoices[0].recommendedPeriod,null);
  choice=[{invoiceRef:inventory.invoices[0].invoiceRef,period}];
  first=await ok(one,'finance_vat_plan',{...args,plan:choice,handoff:{policyReviews:policies}});
  firstDoc=JSON.parse(readFileSync(first.handoff.dataPath));
  assert.equal(firstDoc.scope.enterpriseKey,actualKey);assert.equal(firstDoc.invoices[0].invoiceNumber,'TEST-1');assert.equal(firstDoc.invoices[0].plan,period);
  assert.equal(firstDoc.scenarios.plan.months[0].due,'70.00');assert.equal(firstDoc.months[0].filingStatus,'缺申报回执');
  assert(firstDoc.cash.length);assert(firstDoc.cash.every(row=>row.observedActualPaid===null));
  assert(firstDoc.yearHistory.months.every(m=>m.payments.length===0));
  assert.equal(firstDoc.books.sales,1000);assert.equal(Object.keys(firstDoc.books.reports).length,4);
  assert.match(readFileSync(join(dirname(first.handoff.dataPath),'income-statement.csv'),'utf8'),/营业收入/);
  assert.match(firstDoc.policy[0].state,/判断不适用/);assert.equal(firstDoc.policy[0].source.sha256,article.source.sha256);
  const timing=article.source.retrievedAt.slice(0,10)>args.asOf?'事后取得':'决策日前已读取';
  assert(firstDoc.policy[0].timing.startsWith(timing));assert.match(firstDoc.policy[1].state,/不在该规则/);
  assert.equal(firstDoc.policy[2].state,'引用片段未读或不匹配');assert.equal(firstDoc.policy[3].state,'引用待核');assert.equal(firstDoc.policy[3].source,undefined);assert.equal(firstDoc.yearHistory.months.length,12);
  const [yes,wrongOwner,early,late,noColumn,wrongSheet,duplicate]=firstDoc.policy.slice(4);
  assert.match(yes.state,/判断适用/);assert.equal(yes.condition.known,'2026-06-29');assert.equal(yes.condition.event,'2026-06-15');
  assert.equal(yes.condition.sha256,xSource.sha256);assert.equal(yes.condition.sheetIndex,1);assert.equal(yes.condition.columns.value,2);
  for(const pending of [wrongOwner,early,late,noColumn,wrongSheet,duplicate]){assert.match(pending.state,/企业适用性待核/);assert.equal(pending.condition.matched,undefined);}
  assert.match(wrongOwner.condition.state,/主体不匹配/);assert.match(early.condition.state,/判断窗口/);assert.match(late.condition.state,/判断窗口/);assert.match(noColumn.condition.state,/表头/);assert.match(duplicate.condition.state,/重复/);assert.match(wrongSheet.condition.state,/工作表/);
  const html=readFileSync(first.handoff.reportPath,'utf8');for(const content of ['TEST-1','合成卖方','70.00','income-statement.csv','税后现金变化','实际缴付日期','有据已缴','预计付款依据','所属期可选未用金额','工作表 2／第 3 行／第 2 列',timing])assert(html.includes(content),content);
 }finally{await one.close();}
 const next={...target,period:'2026-07'};
 const july=workspace('七月新工作区',next);assert.equal(july.auditDir,audit);
 assert.notEqual(workspace('同库第二账套',{...next,accountSetId:other.id}).auditDir,audit);
 // 保留未绑定工作区的已有整理件，旧目录可按生成器 --audit-dir 原址交给次月。
 const legacy=workspace('先行账前调查',target,[],true);
 assert.equal(legacy.auditDir,join(root,'先行账前调查','finance-call-records'));
 const legacyInput=join(legacy.auditDir,'agent-materials','旧定位.json');writeFileSync(legacyInput,readFileSync(inputPath));
 const oldClient=start(legacy);
 let oldHandoff;
 try{await oldClient.initialize();oldHandoff=await ok(oldClient,'finance_vat_plan',{...args,inputPath:legacyInput,plan:choice});}
 finally{await oldClient.close();}
 const successor=workspace('旧现场七月',next,['--audit-dir',legacy.auditDir]);
 assert.equal(successor.auditDir,legacy.auditDir);
 const oldReview=start(successor);
 try{
  await oldReview.initialize();
  const page=await ok(oldReview,'finance_period_review',{target:next,precedingPlanPeriod:period});
  assert.equal(page.records.find(r=>r.callId===oldHandoff.callRef)?.planning.reportPath,oldHandoff.handoff.reportPath);
 }finally{await oldReview.close();}
 const two=start(july);try{
  await two.initialize();
  const found=[];
  let offset=0;
  do{
   const page=await ok(two,'finance_period_review',{target:next,precedingPlanPeriod:period,offset,limit:2});
   found.push(...page.records);offset=page.pagination.nextOffset;
  }while(offset!==null);
  const resumed=found.find(record=>record.callId===first.callRef);
  assert.equal(resumed?.planning.reportPath,first.handoff.reportPath);assert.equal(resumed.planning.books,'unchanged');
  const review=async(extra={})=>(await ok(two,'finance_period_review',{target,callIds:[first.callRef],...extra})).records[0];
  const fresh=await review({target:{...target,period:'2026-07'},precedingPlanPeriod:period});assert.equal(fresh.kind,'vat_planning');assert.equal(fresh.artifactIntegrity,'verified');assert.equal(fresh.versions.code,'unchanged');assert.equal(fresh.planning.reportPath,first.handoff.reportPath);assert.equal(fresh.evidence.filingVerified,false);
  const unbound=await ok(two,'finance_period_review',{unboundCalls:{callIds:[first.callRef]}});assert.equal(unbound.records[0].planning,undefined);
  doc.bills[0].taxAmount=40;doc.participant=true;refresh();
  const stale=await review();assert(stale.flags.stale);assert(stale.nextSteps.some(s=>s.tool==='finance_vat_plan'));
  const second=await ok(two,'finance_vat_plan',{...args,plan:choice,handoff:{previousCallId:first.callRef,policyReviews:[policy]}});
  const newer=JSON.parse(readFileSync(second.handoff.dataPath));assert.notEqual(first.handoff.dataPath,second.handoff.dataPath);assert.equal(newer.previous.status,'verified_record');assert.equal(newer.previous.changes[0].dueChange,'-10.00');assert.match(newer.policy[0].state,/判断适用/);assert.equal(newer.previous.policyChanges[0].oldState,firstDoc.policy[0].state);
  assert.equal(sha(readFileSync(first.handoff.dataPath)),first.handoff.digests.data);
  // 另一张票冲突且七月资料缺失，六月已核票的暂定选择仍可跨进程查阅。
  const uncertain={...doc.bills[0],invoiceNumber:'PENDING',taxAmount:10};
  doc.bills.push(uncertain,{...uncertain,taxAmount:11});
  doc.months[1].otherEffects='unsupported';refresh();
  const partial=await ok(two,'finance_vat_plan',{...args,plan:choice});
  assert.equal(partial.status,'partial_known_invoices');
  const partialPack=JSON.parse(readFileSync(partial.handoff.dataPath));
  assert.equal(partialPack.recommendationScope,'known_subset');assert.equal(partialPack.recommendation.choice,'plan');
  assert.equal(partialPack.recommendation.comparedThrough,period);
  assert.equal(partialPack.invoices.find(i=>i.invoiceNumber==='PENDING').recommendedPeriod,null);
  assert.equal(partialPack.invoices.find(i=>i.invoiceNumber==='TEST-1').recommendedPeriod,period);
  assert(readFileSync(partial.handoff.reportPath,'utf8').includes('截至 '+period+' 的连续可核月份'));
  const scopedReview=await review({callIds:[partial.callRef]});assert.equal(scopedReview.planning.recommendation,null);assert.equal(scopedReview.planning.knownSubsetRecommendation.choice,'plan');
  writeFileSync(first.handoff.reportPath,'替换');const altered=await review();assert.equal(altered.artifactIntegrity,'changed');assert.equal(altered.planning.reportPath,undefined);
 }finally{await two.close();}
});

test('同日同额银行流水只作候选，按单号核到批次、行和同账套凭证',async()=>{
 const {DatabaseSync}=await import('node:sqlite'),{bookSnapshot}=await import('../server/vat-handoff-versions.mjs');
 const root=mkdtempSync(join(tmpdir(),'synthetic-vat-bank-')),databasePath=join(root,'synthetic.sqlite'),db=new DatabaseSync(databasePath);
 db.exec(`
 CREATE TABLE audit_database_instances(instance_id,is_active);
 INSERT INTO audit_database_instances VALUES ('instance-a',1);
 CREATE TABLE import_enterprise_account_sets(account_set_id,enterprise_key);
 INSERT INTO import_enterprise_account_sets VALUES (1,'synthetic');
 CREATE TABLE vouchers(id,account_set_id,period,voucher_date,word,number,status);
 INSERT INTO vouchers VALUES (88,1,'2026-12','2026-12-10','记',1,'posted');
 CREATE TABLE bank_batches(account_set_id,bank_account_id,batch_id,content_sha256);
 INSERT INTO bank_batches VALUES (1,'acct','batch','synthetic-sha');
 CREATE TABLE bank_transactions(id,account_set_id,bank_account_id,batch_id,currency,txn_date,bank_ref_id,amount_cents,direction,row_index);
 INSERT INTO bank_transactions VALUES (4,1,'acct','batch','CNY','2026-12-10','receipt-confirmed',3000,'outflow',3);
 INSERT INTO bank_transactions VALUES (5,2,'acct','batch','CNY','2026-12-10','other',3000,'outflow',4);
 CREATE TABLE bank_accounts(account_set_id,bank_account_id,gl_account_code,currency);
 INSERT INTO bank_accounts VALUES(1,'acct','1002','CNY');
 CREATE TABLE voucher_entries(id,voucher_id,code,debit,credit);
 INSERT INTO voucher_entries VALUES(12,88,'1002',0,30);
 CREATE TABLE bank_matches(account_set_id,bank_account_id,transaction_id,status,voucher_id,entry_id,currency);
 INSERT INTO bank_matches VALUES (1,'acct',4,'confirmed',88,12,'CNY');
 `);db.close();
 const scope={databaseInstanceId:'instance-a',accountSetId:1,enterpriseKey:'synthetic',period:'2026-12'};
 const check={eventRef:'test',day:'2026-12-10',amount:'30.00',direction:'outflow'};
 const books=bookSnapshot({databasePath,scope},[{...check,receiptId:'receipt-confirmed'},{...check,receiptId:'other'},{...check,receiptId:'wrong',direction:'inflow'}]);
 assert.equal(books.bank[0].match.voucher_id,88);assert.equal(books.bank[0].match.row_index,3);assert.equal(books.bank[0].match.id,4);
 assert.deepEqual(books.bank[1].candidates,[4]);assert.equal(books.bank[1].match,null);assert.match(books.bank[1].state,/单号待核/);
 assert.deepEqual(books.bank[2].candidates,[]);assert.equal(books.entries,null);
});
