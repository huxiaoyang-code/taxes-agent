// 合成账前演示：只创建虚构资料，经真实 direct MCP 核对；不打开或写入账库。
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {McpStdioClient} from '../../../../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../..');
const json=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});

export function generalFacts(){
 return {
  scope:{enterpriseKey:'synthetic-general-demo',period:'2026-03',periodType:'monthly',currency:'CNY'},
  taxpayer:{vatStatus:'general',ordinaryDomesticScopeConfirmed:true},
  coverage:{sales:'complete',invoices:'complete',purchases:'complete',receipts:'complete',bankTransactions:'complete',inventory:'complete'},
  opening:{asOf:'2026-02-28',carryCredit:'100.00',inputVatTransferOut:'0.00',prepaidVat:'0.00',receivables:[],payables:[],inventory:[{itemId:'DEMO-ITEM',quantity:'10'}]},
  purchases:[{id:'P1',businessId:'purchase-1',date:'2026-03-05',supplierId:'demo-supplier',itemId:'DEMO-ITEM',quantity:'5',netAmount:'5000.00',taxAmount:'650.00',grossAmount:'5650.00'}],
  receipts:[{id:'R1',businessId:'purchase-1',date:'2026-03-06',itemId:'DEMO-ITEM',quantity:'5'}],
  sales:[{id:'S1',businessId:'sale-1',date:'2026-03-15',customerId:'demo-customer',itemId:'DEMO-ITEM',quantity:'3',netAmount:'10000.00',taxAmount:'1300.00',invoiceKind:'ordinary',status:'valid'}],
  invoices:[
   {id:'I-S1',invoiceNumber:'DEMO-S-001',businessId:'sale-1',direction:'sale',date:'2026-03-15',counterpartyId:'demo-customer',netAmount:'10000.00',taxAmount:'1300.00',grossAmount:'11300.00',status:'valid'},
   {id:'I-P1',invoiceNumber:'DEMO-P-001',businessId:'purchase-1',direction:'purchase',date:'2026-03-05',counterpartyId:'demo-supplier',netAmount:'5000.00',taxAmount:'650.00',grossAmount:'5650.00',status:'valid',deductionStatus:'eligible'},
  ],
  bankTransactions:[
   {id:'B1',businessId:'purchase-1',date:'2026-03-07',accountId:'demo-bank',direction:'outflow',amount:'5650.00',category:'business',counterpartyId:'demo-supplier'},
   {id:'B2',businessId:'sale-1',date:'2026-03-20',accountId:'demo-bank',direction:'inflow',amount:'11300.00',category:'business',counterpartyId:'demo-customer'},
  ],
  fundsAccounts:[{id:'demo-bank',kind:'bank',openingBalance:'10000.00',openingDate:'2026-02-28',closingBalance:'15650.00',closingDate:'2026-03-31'}],
  inventoryCounts:[{itemId:'DEMO-ITEM',quantity:'12',asOf:'2026-03-31'}],
 };
}

export function smallFacts(){
 return {
  scope:{enterpriseKey:'synthetic-small-demo',period:'2026-03',periodType:'quarterly',currency:'CNY'},
  taxpayer:{vatStatus:'small',ordinaryDomesticScopeConfirmed:true,reliefElection:'reduced',noPropertyOrLandTransactions:true,remainingSalesEligibleForThresholdExemption:true,allSalesEligibleForOnePercentRelief:true,specialInvoiceWaiverOfExemption:false},
  coverage:{sales:'complete',invoices:'complete',purchases:'complete',receipts:'complete',bankTransactions:'complete',inventory:'not_applicable'},
  opening:{asOf:'2025-12-31',receivables:[],payables:[],inventory:[]},purchases:[],receipts:[],
  sales:[{id:'S2',businessId:'service-1',date:'2026-03-15',customerId:'demo-customer',netAmount:'400000.00',taxAmount:'4000.00',invoiceKind:'ordinary',status:'valid'}],
  invoices:[{id:'I-S2',invoiceNumber:'DEMO-S-002',businessId:'service-1',direction:'sale',date:'2026-03-15',counterpartyId:'demo-customer',netAmount:'400000.00',taxAmount:'4000.00',grossAmount:'404000.00',status:'valid'}],
  bankTransactions:[{id:'B3',businessId:'service-1',date:'2026-03-20',accountId:'demo-bank',direction:'inflow',amount:'404000.00',category:'business',counterpartyId:'demo-customer'}],
  fundsAccounts:[{id:'demo-bank',kind:'bank',openingBalance:'10000.00',openingDate:'2025-12-31',closingBalance:'414000.00',closingDate:'2026-03-31'}],
  inventoryCounts:[],
 };
}

export function writeDemoInput(root,label,facts){
 const source=join(root,`${label}-合成原件.json`),inputPath=join(root,`${label}-适配输入.json`);
 const bankPath=join(root,`${label}-中文银行流水.csv`),originalId=`demo-${label}`,bankId=`bank-${label}`;
 const otherFacts=structuredClone(facts);delete otherFacts.bankTransactions;
 // 其余合成资料集中为JSON；流水保持中文表头，不要求客户提供内部记录ID或枚举。
 json(source,{scope:facts.scope,facts:otherFacts,业务关联:facts.bankTransactions.map(row=>({回单:row.id,业务单据:row.businessId}))});
 const csvCell=value=>`"${String(value).replaceAll('"','""')}"`;
 const csv=[['日期','收支','金额','对方','账户','用途'],...facts.bankTransactions.map(row=>[row.date,row.direction==='inflow'?'收入':'支出',row.amount,row.counterpartyId,row.accountId,'经营收支'])].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
 writeFileSync(bankPath,csv,{flag:'wx'});
 const bindings=Object.keys(otherFacts).map(key=>({inputPointer:`/${key}`,originalId,jsonPointer:`/facts/${key}`}));
 for(const [i,row] of facts.bankTransactions.entries()){
  const columns={date:'日期',direction:'收支',amount:'金额',counterpartyId:'对方',accountId:'账户',category:'用途'};
  for(const [key,column] of Object.entries(columns))bindings.push({inputPointer:`/bankTransactions/${i}/${key}`,originalId:bankId,csvRow:i+2,column,...(key==='amount'?{transform:'decimal'}:key==='direction'?{valueMap:{收入:'inflow',支出:'outflow'}}:key==='category'?{valueMap:{经营收支:'business'}}:{})});
  bindings.push({inputPointer:`/bankTransactions/${i}/businessId`,originalId,jsonPointer:`/业务关联/${i}/业务单据`});
 }
 const scope={enterpriseKey:facts.scope.enterpriseKey,from:facts.opening.asOf,through:'2026-03-31'};
 json(inputPath,{
  version:'finance-prebook-input/1',facts,
  originals:[{id:originalId,path:source,scope},{id:bankId,path:bankPath,scope}],bindings,
 });
 return inputPath;
}

export async function runPrebookDemo(outputDirectory){
 if(!outputDirectory)throw new Error('请提供一个全新的演示输出目录。');
 const root=resolve(outputDirectory);
 mkdirSync(root); // 存在即拒绝，不覆盖旧演示或用户资料。
 const audit=join(root,'运行记录');
 const client=new McpStdioClient(join(repo,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{
  cwd:repo,timeoutMs:30000,
  env:{FINANCE_MCP_PROFILE:'direct',FINANCE_SKILLS_DIR:undefined,FINANCE_SOURCE_ROOT:root,FINANCE_AUDIT_DIR:audit,FINANCE_DATABASE_PATH:join(root,'未打开账库.db'),FINANCE_API_BASE:'http://127.0.0.1:1'},
 }).start();
 const runs=[];
 try{
  await client.initialize('prebook-synthetic-demo');
  const contract=await client.call('finance_record_contract',{recordType:'prebook'});
  if(contract.isError)throw new Error(`账前合同读取失败：${contract.text}`);
  json(join(root,'实际输入合同.json'),contract.data);
  const run=async(label,inputPath,repliesPath)=>{
   const response=await client.call('finance_prebook_review',{inputPath,...(repliesPath?{repliesPath}:{})});
   if(response.isError)throw new Error(`${label}失败：${response.text}`);
   const projection=response.data;
   const callRef=projection?.evidence?.callRef;
   if(typeof callRef!=='string'||!/^\w[\w-]*$/.test(callRef))throw new Error('工具没有返回可定位的运行记录。');
   const directory=join(audit,'prebook',callRef);
   const result=JSON.parse(readFileSync(join(directory,'prebook.json'),'utf8'));
   const entry={label,inputPath,projection,result,directory,reviewPath:projection.evidence.reviewPath,handoffPath:projection.evidence.handoffPath};
   runs.push(entry);
   return entry;
  };
  const missing=generalFacts();missing.coverage.invoices='partial';missing.invoices=missing.invoices.filter(row=>row.direction==='sale');
  const firstInput=writeDemoInput(root,'一般纳税人-缺票',missing);
  const first=await run('一般纳税人：缺进项票',firstInput);
  const question=first.result.issues.find(issue=>issue.code==='purchase_invoice_missing');
  if(!question)throw new Error('合成缺票资料未产生预期问询。');
  const repliesPath=join(root,'老板回复-合成.json');
  json(repliesPath,{version:'finance-prebook-replies/1',enterpriseKey:missing.scope.enterpriseKey,period:missing.scope.period,inputDigest:first.projection.inputDigest,responses:[{issueId:question.issueId,statement:'演示说明：这笔采购已经收货付款，发票稍后补交。',respondent:'合成演示老板',respondedAt:'2026-04-01T01:00:00.000Z'}]});
  await run('一般纳税人：只有老板说明，仍待补票',firstInput,repliesPath);
  const supplemented=writeDemoInput(root,'一般纳税人-补件',generalFacts());
  await run('一般纳税人：补件重算，旧回复失效',supplemented,repliesPath);
  await run('小规模：季度资料核对',writeDemoInput(root,'小规模',smallFacts()));
  if(existsSync(join(root,'未打开账库.db')))throw new Error('账前演示不应创建正式账库。');
  const summary={meaning:'全部为合成资料；条件试算不代表真实资格或会计审定。',root,runs:runs.map(({label,projection,reviewPath,handoffPath})=>({label,status:projection.status,tax:projection.tax,responses:projection.responses,reviewPath,handoffPath}))};
  json(join(root,'演示结果.json'),summary);
  return {root,runs,summary};
 }finally{await client.close();}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 runPrebookDemo(process.argv[2]).then(({summary})=>console.log(JSON.stringify(summary,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
