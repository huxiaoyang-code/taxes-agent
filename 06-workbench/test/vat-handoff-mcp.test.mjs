// 全部为合成原件。进程 A 规划，关掉进程后由进程 B 接续，打开真实 HTML 和原生账表。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {withFinanceCall,currentFinanceCall} from '../server/finance-call-chain.mjs';
import {syntheticVoucherEvidence} from './helpers/synthetic-posting-evidence.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const ptr=jsonPointer=>({jsonPointer});
const keys=(...names)=>Object.fromEntries(names.map(name=>[name,{key:name}]));
const json=(f,data)=>writeFileSync(f,JSON.stringify(data));
test('规划、次月新进程、会计四表、政策窗口配对及补证留版',async()=>{
 const root=mkdtempSync(join(tmpdir(),'synthetic-vat-handoff-')),audit=join(root,'audit'),originals=join(root,'originals'),ledger=join(root,'books');
 const prepared=join(audit,'agent-materials');for(const d of [prepared,originals,ledger])mkdirSync(d,{recursive:true});
 process.env.WORKBENCH_DATA_DIR=ledger;process.env.FINANCE_SOURCE_ROOT=originals;
 const {db}=await import('../server/db.mjs'),A=await import('../server/accounting.mjs');
 const enterpriseKey='SYNTHETIC-VAT-HANDOFF',period='2026-12';
 const set=A.createAccountSet({enterprise:{enterpriseKey},name:'交接合成企业',taxpayer_type:'一般纳税人',start_period:period,accounting_standard:'小企业会计准则'});
 A.createVoucher(set.id,syntheticVoucherEvidence({period,status:'posted',entries:[{code:'1002',debit:1000},{code:'5001',credit:1000}]},originals));
 const target={accountSetId:set.id,period},actualKey=db.prepare('SELECT enterprise_key FROM import_enterprise_account_sets WHERE account_set_id=?').get(set.id).enterprise_key;
 db.close();
 const dbPath=join(ledger,'workbench.db'),source=join(originals,'交易与试点资料.json'),inputPath=join(prepared,'定位.json');
 const doc={owner:actualKey,knownAt:'2026-12-31',prior:'2026-11',scope:'monthly_general_domestic',inventoryCoverage:'complete',credit:0,
  validFrom:'2026-11-01',validThrough:'2026-12-31',participant:false,transaction:'2026-12-15',
  months:[{period,basis:'actual',knownAt:'2026-12-31',state:'open',otherEffects:'none',inputVatTransferOut:0,prepaidVat:0,outputVat:100}],
  bills:[{issuer:'合成卖方',invoiceNumber:'TEST-1',receipt:'2026-12-01',issueDate:'2026-12-01',eligibility:'eligible',taxAmount:30}]};
 const tables=[
  {kind:'opening',fields:{period:ptr('/prior'),scope:ptr('/scope'),inventoryCoverage:ptr('/inventoryCoverage'),carryCredit:ptr('/credit'),knownAt:ptr('/knownAt')}},
  {kind:'month',rowsPointer:'/months',fields:keys('period','basis','knownAt','state','otherEffects','inputVatTransferOut','prepaidVat','outputVat')},
  {kind:'invoice',rowsPointer:'/bills',fields:keys('issuer','invoiceNumber','receipt','issueDate','eligibility','taxAmount')},
 ];
 const refresh=()=>{json(source,doc);json(inputPath,{version:'finance-vat-planning-materials/1',sources:[{path:source,sha256:sha(readFileSync(source)),ownerField:'enterpriseKey',owner:ptr('/owner'),tables}]});};
 refresh();
 const server=fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url));
 const start=()=>new McpStdioClient(server,{cwd:root,env:{FINANCE_MCP_PROFILE:'direct',FINANCE_SOURCE_ROOT:originals,FINANCE_DATABASE_PATH:dbPath,FINANCE_AUDIT_DIR:audit,FINANCE_API_BASE:'http://127.0.0.1:1'}}).start();
 const ok=async(c,tool,args)=>{const r=await c.call(tool,args);assert.equal(r.isError,false,r.text);return r.data;};
 const args={target,through:period,asOf:'2026-12-31',inputPath},one=start();
 const text='合成试点实施。自2026年12月1日施行。第二阶段自2027年1月1日施行。';
 // 用可校验的本机 open 调用记录测交接消费者，网络读取器由其专用回归覆盖。
 let callId;
 await withFinanceCall({tool:'finance_rules',args:{action:'open'},auditDir:audit},()=>{
  callId=currentFinanceCall().callId;return {status:'read',source:{url:'https://www.mof.gov.cn/synthetic',title:'合成公告',sha256:sha('fixture'),retrievedAt:'2027-01-03T12:00:00Z',publishedOn:'2026-11-08',observedStatus:'有效'},text,offset:0};
 });
 const condition={source:0,valuePointer:'/participant',equals:true,knownAtPointer:'/knownAt',validFromPointer:'/validFrom',validThroughPointer:'/validThrough',transactionDatePointer:'/transaction'};
 const policy={callId,passage:'合成试点实施',question:'试点是否适用',interpretation:'合成交易按名单判断',condition,appliesWhenMatched:true,validity:{from:'2026-12-01',fromPassage:'自2026年12月1日施行'}};
 const policies=[policy,{...policy,validity:{from:'2027-01-01',fromPassage:'第二阶段自2027年1月1日施行'}},{...policy,passage:'原文没有这段话'}];
 let first,firstDoc,choice;
 try{
  await one.initialize();const inventory=await ok(one,'finance_vat_plan',args);
  assert.equal(inventory.delivery,'invoice_inventory');assert.equal(inventory.handoff,undefined);assert.equal(inventory.recommendation,null);
  choice=[{invoiceRef:inventory.invoices[0].invoiceRef,period}];
  first=await ok(one,'finance_vat_plan',{...args,plan:choice,handoff:{policyReviews:policies}});
  firstDoc=JSON.parse(readFileSync(first.handoff.dataPath));
  assert.equal(firstDoc.scope.enterpriseKey,actualKey);assert.equal(firstDoc.invoices[0].invoiceNumber,'TEST-1');assert.equal(firstDoc.invoices[0].plan,period);
  assert.equal(firstDoc.scenarios.plan.months[0].due,'70.00');assert.equal(firstDoc.months[0].filingStatus,'缺申报回执');
  assert.equal(firstDoc.books.sales,1000);assert.equal(Object.keys(firstDoc.books.reports).length,4);
  assert.match(readFileSync(join(dirname(first.handoff.dataPath),'income-statement.csv'),'utf8'),/营业收入/);
  assert.match(firstDoc.policy[0].state,/判断不适用/);assert.match(firstDoc.policy[0].timing,/事后/);assert.match(firstDoc.policy[1].state,/不在该规则/);
  assert.equal(firstDoc.policy[2].state,'引用片段未读或不匹配');assert.equal(firstDoc.yearHistory.months.length,12);
  const html=readFileSync(first.handoff.reportPath,'utf8');for(const content of ['TEST-1','合成卖方','70.00','income-statement.csv','税后现金变化','实际缴付日期','事后取得'])assert(html.includes(content),content);
 }finally{await one.close();}
 const two=start();try{
  await two.initialize();
  const review=async(extra={})=>(await ok(two,'finance_period_review',{target,callIds:[first.callRef],...extra})).records[0];
  const fresh=await review({target:{...target,period:'2027-01'},precedingPlanPeriod:period});assert.equal(fresh.kind,'vat_planning');assert.equal(fresh.artifactIntegrity,'verified');assert.equal(fresh.versions.code,'unchanged');assert.equal(fresh.planning.reportPath,first.handoff.reportPath);assert.equal(fresh.evidence.filingVerified,false);
  const unbound=await ok(two,'finance_period_review',{unboundCalls:{callIds:[first.callRef]}});assert.equal(unbound.records[0].planning,undefined);
  doc.bills[0].taxAmount=40;doc.participant=true;refresh();
  const stale=await review();assert(stale.flags.stale);assert(stale.nextSteps.some(s=>s.tool==='finance_vat_plan'));
  const second=await ok(two,'finance_vat_plan',{...args,plan:choice,handoff:{previousCallId:first.callRef,policyReviews:[policy]}});
  const newer=JSON.parse(readFileSync(second.handoff.dataPath));assert.notEqual(first.handoff.dataPath,second.handoff.dataPath);assert.equal(newer.previous.status,'verified_record');assert.equal(newer.previous.changes[0].dueChange,'-10.00');assert.match(newer.policy[0].state,/判断适用/);assert.equal(newer.previous.policyChanges[0].oldState,firstDoc.policy[0].state);
  assert.equal(sha(readFileSync(first.handoff.dataPath)),first.handoff.digests.data);
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
