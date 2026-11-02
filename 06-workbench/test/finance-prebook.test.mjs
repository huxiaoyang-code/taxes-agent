import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {runPrebookReview} from '../server/finance-prebook.mjs';
import {prebookFacts,writePrebookFixture} from './helpers/prebook-fixture.mjs';
import {digest} from '../server/finance-prebook-evidence.mjs';
const root=mkdtempSync(join(tmpdir(),'prebook-synthetic-')),audit=join(root,'audit');process.env.FINANCE_SOURCE_ROOT=root;
let counter=0;
const fixture=(facts=prebookFacts())=>writePrebookFixture(root,facts,`case-${++counter}`);
const run=(input,extra={})=>runPrebookReview({inputPath:input.inputPath,...extra},{auditDir:audit});
const full=result=>JSON.parse(readFileSync(join(dirname(result.evidence.reviewPath),'prebook.json'),'utf8'));
test('一般纳税人无本期账库即可核对，非零VAT及库存/资金独立预期',async()=>{
 const input=fixture(),before=digest(readFileSync(input.originalPath)),r=await run(input),local=full(r);assert.equal(r.status,'ready_for_bookkeeping_review');assert.equal(r.tax.amounts.due,1200);assert.equal(r.tax.burdenPercent,6);assert.equal(local.funds[0].difference,'0.00');assert.equal(local.inventory[0].calculatedClosingUnits,'25000000');assert.equal(r.review.posted,false);assert.equal(r.review.submittable,false);assert.equal(digest(readFileSync(input.originalPath)),before);
 const html=readFileSync(r.evidence.reviewPath,'utf8');for(const text of ['库存数量核对','上期往来','本期条件应纳额','1200.00'])assert(html.includes(text));const handoff=JSON.parse(readFileSync(r.evidence.handoffPath));assert.equal(handoff.version,'finance-prebook-handoff/1');assert(handoff.sourceRefs.length>30);assert(local.tax.rules.length);assert(local.tax.conditions.length);
 const projected=JSON.stringify(r);for(const text of ['SYNTHETIC-ENTERPRISE','SUPPLIER-A','CUSTOMER-A',input.originalPath,'INPUT-001'])assert(!projected.includes(text));assert.equal(JSON.parse(readFileSync(join(audit,r.evidence.callRef,'end.json'))).status,'returned');
});
test('小规模包含未开票销售，非零税额按原生条件规则计算',async()=>{
 const facts=prebookFacts('small');facts.sales.push({id:'S2',businessId:'SELL-2',date:'2026-03-11',netAmount:'10000.00',invoiceKind:'uninvoiced',status:'valid'});const r=await run(fixture(facts));assert.equal(r.tax.amounts.due,2100);assert.equal(r.tax.amounts.salesExcludingVat,210000);assert.equal(r.tax.burdenPercent,1);assert.equal(r.status,'ready_for_bookkeeping_review');
});
test('缺进项、未知抵扣及留抵不得当作零或全部可抵扣',async()=>{
 const facts=prebookFacts();delete facts.invoices[0].deductionStatus;delete facts.opening.carryCredit;const r=await run(fixture(facts));assert.equal(r.status,'needs_inputs');assert.equal(r.tax.status,'needs_inputs');assert(!own(r.tax.amounts,'due'));assert(r.issues.some(i=>i.code==='input_vat_status_missing'));assert(r.issues.some(i=>i.code==='vat_carry_inputs_missing'));
});
const own=(o,k)=>Object.hasOwn(o,k);
test('相同发票重复导入不重复税额；冲突版本不计算',async()=>{
 const facts=prebookFacts();facts.invoices.push({...facts.invoices[0],id:'COPY'});const r=await run(fixture(facts));assert.equal(r.tax.amounts.due,1200);assert.equal(r.deduplicatedCount,1);facts.invoices.at(-1).grossAmount='11301.00';const conflict=await run(fixture(facts));assert.equal(conflict.status,'needs_inputs');assert.equal(conflict.tax.status,'needs_inputs');assert(conflict.issues.some(i=>i.code==='duplicate_conflict'));
});
test('老板回复只记录声明，补件后旧回复失效、原产物保留',async()=>{
 const facts=prebookFacts();facts.invoices.shift();const first=await run(fixture(facts)),issue=first.issues.find(i=>i.code==='purchase_invoice_missing'),repliesPath=join(root,'replies.json');writeFileSync(repliesPath,JSON.stringify({version:'finance-prebook-replies/1',enterpriseKey:facts.scope.enterpriseKey,period:facts.scope.period,inputDigest:first.inputDigest,responses:[{issueId:issue.issueId,statement:'已联系供应商补票 <script>bad</script>',respondent:'老板',respondedAt:'2026-04-02T00:00:00.000Z'}]}));
 const same=await run(fixture(facts),{repliesPath});assert.equal(same.responses.recorded,1);assert.equal(same.status,'needs_inputs');assert(readFileSync(same.evidence.reviewPath,'utf8').includes('&lt;script&gt;bad&lt;/script&gt;'));
 const fixed=await run(fixture(),{repliesPath});assert.equal(fixed.responses.stale,1);assert.equal(fixed.status,'ready_for_bookkeeping_review');assert.equal(fixed.tax.amounts.due,1200);assert.notEqual(fixed.inputDigest,first.inputDigest);assert(readFileSync(first.evidence.reviewPath,'utf8').includes('采购业务尚未找到发票'));
});
test('缺资金余额/流水覆盖、错期/跨企业、作废及红字状态保留',async()=>{
 const facts=prebookFacts();delete facts.fundsAccounts[0].openingBalance;facts.coverage.bankTransactions='partial';let r=await run(fixture(facts));assert.equal(r.status,'needs_inputs');assert.equal(full(r).funds[0].calculatedClosing,null);
 const cross=prebookFacts();cross.bankTransactions[0].enterpriseKey='OTHER';await assert.rejects(run(fixture(cross)),{code:'finance_prebook_original_scope_conflict'});
 const prior=prebookFacts();prior.sales[0].date='2026-02-28';await assert.rejects(run(fixture(prior)),{code:'finance_prebook_record_period_conflict'});
 const red=prebookFacts();red.invoices[0].status='red';r=await run(fixture(red));assert.equal(r.tax.status,'needs_inputs');assert(r.issues.some(i=>i.code==='red_document_review'));
 const voided=prebookFacts();voided.invoices.push({...voided.invoices[0],id:'VOID',invoiceNumber:'VOID',status:'void'});r=await run(fixture(voided));assert.equal(r.tax.amounts.due,1200);
});
test('销售与销项税额矛盾、孤立收货均明确核实',async()=>{
 const facts=prebookFacts();facts.sales[0].taxAmount='100.00';facts.receipts.push({id:'ORPHAN',businessId:'UNKNOWN',date:'2026-03-05',itemId:'ITEM-A',quantity:'1'});const r=await run(fixture(facts));assert.equal(r.tax.status,'needs_inputs');assert(r.issues.some(i=>i.code==='sale_invoice_difference'));assert(r.issues.some(i=>i.code==='receipt_purchase_missing'));
});
test('同业务多行采购按组核对；上期应付结清不要求本期进项',async()=>{
 const facts=prebookFacts();facts.purchases[0].quantity='5';facts.purchases[0].grossAmount='5650.00';facts.purchases.push({...facts.purchases[0],id:'P2'});facts.opening.payables=[{id:'AP-OLD',businessId:'OLD-BUY',counterpartyId:'SUPPLIER-OLD',amount:'5000.00'}];facts.bankTransactions.push({id:'B2',date:'2026-03-07',businessId:'OLD-BUY',accountId:'BANK-A',direction:'outflow',amount:'5000.00',category:'business',counterpartyId:'SUPPLIER-OLD'});facts.fundsAccounts[0].closingBalance='33700.00';const r=await run(fixture(facts));assert.equal(r.status,'ready_for_bookkeeping_review');assert.equal(full(r).priorSettlements[0].remainingAmount,'0.00');assert(!r.issues.some(i=>i.code==='payment_business_missing'));assert.equal(full(r).relations.length,1);
});
test('原件金额不符、无来源金额、跨目录及跨期回复不通过',async()=>{
 const input=fixture();input.input.facts.sales[0].netAmount='999.00';writeFileSync(input.inputPath,JSON.stringify(input.input));await assert.rejects(run(input),{code:'finance_prebook_source_value_mismatch'});
 const missing=fixture();missing.input.bindings=[];writeFileSync(missing.inputPath,JSON.stringify(missing.input));const r=await run(missing);assert.equal(r.status,'needs_inputs');assert.equal(r.tax.status,'needs_inputs');
 await assert.rejects(runPrebookReview({inputPath:join(tmpdir(),'outside.json')},{auditDir:audit}),{code:'finance_prebook_source_outside_root'});
 const replyPath=join(root,'wrong-replies.json');writeFileSync(replyPath,JSON.stringify({version:'finance-prebook-replies/1',enterpriseKey:'OTHER',period:'2026-03',inputDigest:r.inputDigest,responses:[]}));await assert.rejects(run(fixture(),{repliesPath:replyPath}),{code:'finance_prebook_reply_scope_conflict'});
});
test('交易对方不一致及上期重复业务不得标为可交接',async()=>{
 const facts=prebookFacts();facts.bankTransactions[0].counterpartyId='OTHER';facts.invoices[1].counterpartyId='OTHER-CUSTOMER';let r=await run(fixture(facts));assert.equal(r.status,'needs_inputs');assert(r.issues.some(i=>i.code==='payment_counterparty_mismatch'));assert(r.issues.some(i=>i.code==='sale_counterparty_mismatch'));
 const repeated=prebookFacts();repeated.opening.payables=[{id:'A1',businessId:'BUY-1',counterpartyId:'SUPPLIER-A',amount:'5650.00'},{id:'A2',businessId:'BUY-1',counterpartyId:'SUPPLIER-A',amount:'5650.00'}];r=await run(fixture(repeated));assert.equal(r.status,'needs_inputs');assert(r.issues.some(i=>i.code==='prior_business_ambiguous'));assert(full(r).priorSettlements.every(p=>p.settledAmount===null&&p.remainingAmount===null));assert.equal(full(r).relations[0].paymentIds.length,0);
});
test('缺整类明细即使声明完整也不产生零额税务结论',async()=>{
 const small=prebookFacts('small');delete small.sales;small.invoices=small.invoices.filter(i=>i.direction!=='sale');let r=await run(fixture(small));assert.equal(r.tax.status,'needs_inputs');assert(!own(r.tax.amounts,'due'));assert.equal(r.tax.burdenPercent,null);
 const general=prebookFacts();delete general.invoices;general.sales[0].invoiceKind='uninvoiced';r=await run(fixture(general));assert.equal(r.tax.status,'needs_inputs');assert(!own(r.tax.amounts,'certifiedInputVat'));assert(!own(r.tax.amounts,'due'));
});
test('中文CSV逐值适配与上期来源正常衔接，不要求原件包含内部id',async()=>{
 const facts=prebookFacts('small');facts.coverage.inventory='not_applicable';facts.coverage.bankTransactions='not_applicable';facts.opening.inventory=[];for(const field of ['purchases','receipts','invoices','bankTransactions','fundsAccounts','inventoryCounts'])facts[field]=[];facts.sales=[{id:'generated-1',businessId:'ORDER-A',date:'2026-03-12',netAmount:'200000.00',invoiceKind:'uninvoiced',status:'valid'}];
 const csvPath=join(root,'中文销售.csv');writeFileSync(csvPath,'业务编号,日期,不含税金额,开票性质,状态\nORDER-A,2026-03-12,200000.00,未开票,有效\n');
 const priorPath=join(root,'上期余额.json');writeFileSync(priorPath,JSON.stringify({scope:{enterpriseKey:facts.scope.enterpriseKey,period:'2026-02'},opening:facts.opening}));
 const metadata={...facts};delete metadata.sales;delete metadata.opening;const metadataPath=join(root,'企业资料.json');writeFileSync(metadataPath,JSON.stringify(metadata));
 const input={version:'finance-prebook-input/1',facts,originals:[{id:'meta',path:metadataPath,scope:{enterpriseKey:facts.scope.enterpriseKey,from:'2026-03-01',through:'2026-03-31'}},{id:'prior',path:priorPath,scope:{enterpriseKey:facts.scope.enterpriseKey,from:'2026-02-01',through:'2026-02-28'}},{id:'sales',path:csvPath,scope:{enterpriseKey:facts.scope.enterpriseKey,from:'2026-03-01',through:'2026-03-31'}}],bindings:[...Object.keys(metadata).map(k=>({inputPointer:`/${k}`,originalId:'meta',jsonPointer:`/${k}`})),{inputPointer:'/opening',originalId:'prior',jsonPointer:'/opening'},...Object.entries({businessId:'业务编号',date:'日期',netAmount:'不含税金额',invoiceKind:'开票性质',status:'状态'}).map(([key,column])=>({inputPointer:`/sales/0/${key}`,originalId:'sales',csvRow:2,column,...(key==='invoiceKind'?{valueMap:{未开票:'uninvoiced'}}:key==='status'?{valueMap:{有效:'valid'}}:{})}))]};
 const inputPath=join(root,'csv-prepared-input.json');writeFileSync(inputPath,JSON.stringify(input));const r=await run({inputPath});assert.equal(r.status,'ready_for_bookkeeping_review');assert.equal(r.tax.amounts.due,2000);assert(full(r).internalIds.includes('/sales/0/id'));assert(full(r).sourceRefs.some(ref=>ref.column==='不含税金额'&&ref.csvRow===2));assert(!readFileSync(csvPath,'utf8').includes('generated-1'));
 const prior=JSON.parse(readFileSync(priorPath));prior.scope.period='2025-12';writeFileSync(priorPath,JSON.stringify(prior));await assert.rejects(run({inputPath}),{code:'finance_prebook_source_period_conflict'});
});
test('原件嵌套主体/期间不能仅因金额一致跨企或错期取值',async()=>{
 const input=fixture(),facts=input.input.facts;const source=JSON.parse(readFileSync(input.originalPath));source.hidden={enterpriseKey:'OTHER',amount:'100.00'};writeFileSync(input.originalPath,JSON.stringify(source));input.input.bindings=[{inputPointer:'/opening/carryCredit',originalId:'original',jsonPointer:'/hidden/amount'}];writeFileSync(input.inputPath,JSON.stringify(input.input));await assert.rejects(run(input),{code:'finance_prebook_original_scope_conflict'});
 source.hidden={period:'2025-12',amount:'100.00'};writeFileSync(input.originalPath,JSON.stringify(source));await assert.rejects(run(input),{code:'finance_prebook_source_period_conflict'});
});
test('来源仅有日期而无period时也不能拿历史金额冒充本期发生',async()=>{
 const input=fixture(),path=join(root,'history-amount.json');writeFileSync(path,JSON.stringify({enterpriseKey:input.input.facts.scope.enterpriseKey,date:'2025-01-01',net:'20000.00'}));input.input.originals.push({id:'history',path,scope:{enterpriseKey:input.input.facts.scope.enterpriseKey,from:'2025-01-01',through:'2026-03-31'}});input.input.bindings=[{inputPointer:'/sales/0/netAmount',originalId:'history',jsonPointer:'/net'}];writeFileSync(input.inputPath,JSON.stringify(input.input));await assert.rejects(run(input),{code:'finance_prebook_source_period_conflict'});
 writeFileSync(path,JSON.stringify({net:'20000.00'}));input.input.originals.at(-1).scope.through='2025-01-31';writeFileSync(input.inputPath,JSON.stringify(input.input));await assert.rejects(run(input),{code:'finance_prebook_source_period_conflict'});
});
test('上期往来缺失不等于零；有来源空集合才明确无往来',async()=>{
 const facts=prebookFacts();delete facts.opening.receivables;delete facts.opening.payables;const r=await run(fixture(facts));assert.equal(r.status,'needs_inputs');assert.equal(r.issues.filter(i=>i.code==='prior_balances_missing').length,2);assert(readFileSync(r.evidence.reviewPath,'utf8').includes('未提供不能视为空'));
});
test('两类纳税人季度边界明确，跨年期初正常；非季末拒绝',async()=>{
 for(const vatStatus of ['general','small']){const facts=prebookFacts(vatStatus);facts.scope.periodType='quarterly';facts.opening.asOf='2025-12-31';facts.fundsAccounts[0].openingDate='2025-12-31';const r=await run(fixture(facts));assert.equal(r.status,'ready_for_bookkeeping_review');assert.equal(r.tax.amounts.due,vatStatus==='general'?1200:0);assert.equal(full(r).bounds.from,'2026-01-01');}
 const bad=prebookFacts();bad.scope.period='2026-02';bad.scope.periodType='quarterly';await assert.rejects(run(fixture(bad)),{code:'finance_prebook_quarter_not_ended'});
});
test('未开票销售只给净额与业务税目即可派生原生税额，缺税目仍待补',async()=>{
 const facts=prebookFacts();facts.sales[0].invoiceKind='uninvoiced';delete facts.sales[0].taxAmount;facts.sales[0].vatCategory='goods';facts.invoices=facts.invoices.filter(i=>i.direction!=='sale');let r=await run(fixture(facts));assert.equal(r.tax.amounts.outputVat,2600);assert.equal(r.tax.amounts.due,1200);assert.equal(r.status,'ready_for_bookkeeping_review');const trace=full(r).tax.salesTaxDerivations;assert.equal(trace[0].taxAmount,'2600.00');assert.equal(trace[0].rateBasisPoints,1300);assert(trace[0].sources.length);assert(r.tax.conditionCodes.includes('sales_vat_category_unreviewed'));
 delete facts.sales[0].vatCategory;r=await run(fixture(facts));assert.equal(r.tax.status,'needs_inputs');assert(!own(r.tax.amounts,'due'));assert(r.issues.some(i=>i.code==='sale_tax_basis_missing'));
});
test('派生产品结果不能重新登记为客户原件',async()=>{
 const input=fixture();const raw=JSON.parse(readFileSync(input.originalPath));raw.version='finance-prebook-handoff/1';writeFileSync(input.originalPath,JSON.stringify(raw));await assert.rejects(run(input),{code:'finance_prebook_generated_not_original'});
});
test('上期普通CSV无需内部id；上期业务及商品映射声明仍待核，金额不能声明替代',async()=>{
 const facts=prebookFacts();facts.opening.payables=[{id:'generated-ap',businessId:'OLD-P',counterpartyId:'SUPPLIER-OLD',amount:'5000.00'}];facts.opening.receivables=[{id:'generated-ar',businessId:'OLD-S',counterpartyId:'CUSTOMER-OLD',amount:'6000.00'}];
 const input=fixture(facts),csvPath=join(root,'上期普通往来.csv');writeFileSync(csvPath,'类型,原业务单号,对方,余额\n应付,OLD-P,SUPPLIER-OLD,5000.00\n应收,OLD-S,CUSTOMER-OLD,6000.00\n');
 const original=JSON.parse(readFileSync(input.originalPath));delete original.opening.payables;delete original.opening.receivables;writeFileSync(input.originalPath,JSON.stringify(original));
 input.input.originals.push({id:'prior-csv',path:csvPath,scope:{enterpriseKey:facts.scope.enterpriseKey,from:'2026-02-01',through:'2026-02-28'}});
 input.input.bindings=[...Object.keys(facts).filter(k=>k!=='opening').map(k=>({inputPointer:`/${k}`,originalId:'original',jsonPointer:`/${k}`})),...Object.keys(original.opening).map(k=>({inputPointer:`/opening/${k}`,originalId:'original',jsonPointer:`/opening/${k}`}))];
 for(const [kind,csvRow] of [['payables',2],['receivables',3]])for(const [field,column] of Object.entries({businessId:'原业务单号',counterpartyId:'对方',amount:'余额'}))input.input.bindings.push({inputPointer:`/opening/${kind}/0/${field}`,originalId:'prior-csv',csvRow,column});
 writeFileSync(input.inputPath,JSON.stringify(input.input));let r=await run(input);assert.equal(r.status,'ready_for_bookkeeping_review');assert(full(r).internalIds.includes('/opening/payables/0/id'));assert(full(r).internalIds.includes('/opening/receivables/0/id'));assert(!readFileSync(csvPath,'utf8').includes('generated-'));assert.equal(full(r).priorSettlements[0].remainingAmount,'6000.00');
 const declare=inputPointer=>({inputPointer,kind:'operator_mapping',reason:'根据客户说明映射，尚需业务核实',declaredBy:'合成操作者',declaredAt:'2026-04-02T00:00:00.000Z'});
 input.input.bindings=input.input.bindings.filter(b=>!['/opening/payables/0/businessId','/opening/inventory'].includes(b.inputPointer));input.input.bindings.push({inputPointer:'/opening/inventory/0/quantity',originalId:'original',jsonPointer:'/opening/inventory/0/quantity'});input.input.declarations=[declare('/opening/payables/0/businessId'),declare('/opening/inventory/0/itemId')];writeFileSync(input.inputPath,JSON.stringify(input.input));r=await run(input);assert.equal(r.status,'needs_inputs');assert.equal(r.issues.filter(i=>i.code==='mapping_semantics_unreviewed').length,2);assert(!r.issues.some(i=>i.code==='source_binding_missing'));
 input.input.bindings=input.input.bindings.filter(b=>b.inputPointer!=='/opening/payables/0/amount');input.input.declarations.push(declare('/opening/payables/0/amount'));writeFileSync(input.inputPath,JSON.stringify(input.input));await assert.rejects(run(input),{code:'finance_prebook_declaration_invalid'});
});
test('原件无记录说明及真空CSV可绑定空集；零净额、非空表、缺范围与声明不能替代',async()=>{
 const input=fixture(),original=JSON.parse(readFileSync(input.originalPath));original.opening.receivables='无往来';original.opening.payables='无记录';writeFileSync(input.originalPath,JSON.stringify(original));
 input.input.bindings=[...Object.keys(original).filter(k=>k!=='opening').map(k=>({inputPointer:`/${k}`,originalId:'original',jsonPointer:`/${k}`})),...Object.keys(original.opening).map(k=>({inputPointer:`/opening/${k}`,originalId:'original',jsonPointer:`/opening/${k}`,...(['receivables','payables'].includes(k)?{transform:'empty_set'}:{})}))];writeFileSync(input.inputPath,JSON.stringify(input.input));let r=await run(input);assert.equal(r.status,'ready_for_bookkeeping_review');assert.equal(full(r).sourceRefs.find(x=>x.inputPointer==='/opening/receivables').transform,'empty_set');
 original.opening.receivables='0.00';writeFileSync(input.originalPath,JSON.stringify(original));await assert.rejects(run(input),{code:'finance_prebook_empty_set_invalid'});original.opening.receivables='无往来';writeFileSync(input.originalPath,JSON.stringify(original));
 const csvPath=join(root,'空往来明细.csv');writeFileSync(csvPath,'原业务单号,对方,余额\n');input.input.originals.push({id:'empty-csv',path:csvPath,scope:{enterpriseKey:original.scope.enterpriseKey,from:'2026-02-01',through:'2026-02-28'}});const binding=input.input.bindings.find(b=>b.inputPointer==='/opening/receivables');Object.assign(binding,{originalId:'empty-csv'});delete binding.jsonPointer;writeFileSync(input.inputPath,JSON.stringify(input.input));r=await run(input);assert.equal(r.status,'ready_for_bookkeeping_review');assert.equal(full(r).sourceRefs.find(x=>x.inputPointer==='/opening/receivables').csvEmpty,true);assert(readFileSync(r.evidence.reviewPath,'utf8').includes('CSV表头后无数据行'));
 writeFileSync(csvPath,'原业务单号,对方,余额\nOLD-1,CUSTOMER-A,0.00\n');await assert.rejects(run(input),{code:'finance_prebook_empty_set_invalid'});writeFileSync(csvPath,'原业务单号,对方,余额\n');
 const emptyFacts=prebookFacts();for(const k of ['purchases','receipts','sales','invoices','bankTransactions','inventoryCounts'])emptyFacts[k]=[];emptyFacts.opening.inventory=[];emptyFacts.fundsAccounts[0].closingBalance=emptyFacts.fundsAccounts[0].openingBalance;const emptyInput=fixture(emptyFacts);emptyInput.input.originals.push({id:'empty-current',path:csvPath,scope:{enterpriseKey:emptyFacts.scope.enterpriseKey,from:'2026-03-01',through:'2026-03-31'}});emptyInput.input.bindings=Object.keys(emptyFacts).map(k=>k==='sales'?{inputPointer:'/sales',originalId:'empty-current',transform:'empty_set'}:{inputPointer:`/${k}`,originalId:'original',jsonPointer:`/${k}`});writeFileSync(emptyInput.inputPath,JSON.stringify(emptyInput.input));r=await run(emptyInput);assert.equal(r.status,'ready_for_bookkeeping_review');assert.equal(r.tax.amounts.outputVat,0);
 emptyInput.input.originals[1].scope.from='2026-03-02';writeFileSync(emptyInput.inputPath,JSON.stringify(emptyInput.input));await assert.rejects(run(emptyInput),{code:'finance_prebook_empty_set_coverage_missing'});emptyInput.input.originals[1].scope.from='2026-03-01';emptyInput.input.bindings=emptyInput.input.bindings.filter(b=>b.inputPointer!=='/sales');emptyInput.input.declarations=[{inputPointer:'/sales',kind:'provider_statement',reason:'无业务',declaredBy:'合成操作者',declaredAt:'2026-04-02T00:00:00.000Z'}];writeFileSync(emptyInput.inputPath,JSON.stringify(emptyInput.input));await assert.rejects(run(emptyInput),{code:'finance_prebook_declaration_invalid'});
});
test('经营流水须匹配同方向业务及销售客户，合法销售收款可交接',async()=>{
 for(const directionCase of ['purchase-inflow','sale-outflow','wrong-customer','missing-customer','valid']){
  const facts=prebookFacts();if(directionCase==='purchase-inflow'){facts.bankTransactions[0].direction='inflow';facts.fundsAccounts[0].closingBalance='61300.00';}
  else if(directionCase==='sale-outflow'){facts.bankTransactions[0].businessId='SELL-1';facts.bankTransactions[0].counterpartyId='CUSTOMER-A';}
  else{facts.bankTransactions.push({id:'B2',date:'2026-03-10',businessId:'SELL-1',accountId:'BANK-A',direction:'inflow',amount:'22600.00',category:'business',counterpartyId:directionCase==='wrong-customer'?'OTHER':'CUSTOMER-A'});facts.fundsAccounts[0].closingBalance='61300.00';if(directionCase==='missing-customer')delete facts.sales[0].customerId;}
  const r=await run(fixture(facts));assert.equal(r.status,directionCase==='valid'?'ready_for_bookkeeping_review':'needs_inputs');if(directionCase==='purchase-inflow'||directionCase==='sale-outflow')assert(r.issues.some(i=>i.code==='payment_business_missing'));else if(directionCase!=='valid')assert(r.issues.some(i=>i.code==='receipt_counterparty_mismatch'));
 }
});
