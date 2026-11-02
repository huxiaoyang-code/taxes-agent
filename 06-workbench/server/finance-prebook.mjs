// 账前核对适配器：资料、问询与条件试算独立于正式账务。
import {mkdirSync,writeFileSync,lstatSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {PREBOOK_INPUT_SCHEMA,PREBOOK_REPLIES_SCHEMA,PREBOOK_TOOL_SCHEMA} from './finance-prebook-contracts.mjs';
import {validateSchemaValue} from './harness-schema-validation.mjs';
import {readSource,parseJson,bindEvidence,digest,stable,reject} from './finance-prebook-evidence.mjs';
import {cents,money,quantity,calculateAgencyOutputVat} from './agency-tax-rules.mjs';
import {calculateFinanceSummary,FINANCE_SUMMARY_RULE_VERSION} from './finance-summary-engine.mjs';
import {currentFinanceCall,withFinanceCall,annotateFinanceCall} from './finance-call-chain.mjs';
import {PROJECTION_NUMBER_LIMIT} from './finance-output-policy.mjs';

const arrays=['purchases','receipts','sales','invoices','bankTransactions','fundsAccounts','inventoryCounts'];
const own=(o,k)=>Object.hasOwn(o??{},k);
const sum=(rows,key)=>rows.reduce((total,row)=>total+cents(row[key]),0n);
const check=(schema,value)=>{if(validateSchemaValue(schema,value).length)reject('finance_prebook_input_invalid');};
// 固定模块加载时的计算与规则版本；长驻MCP不能让旧逻辑配上新文件摘要。
const codePaths=['finance-prebook.mjs','finance-prebook-evidence.mjs','finance-prebook-contracts.mjs','finance-summary-engine.mjs','agency-tax-rules.mjs','agency-rule-catalog.mjs','agency-extended-tax-rules.mjs','agency-regional-rules.mjs','money.mjs','offline-material-adapters.mjs','accounting-profiles.mjs','bank-import.mjs','harness-schema-validation.mjs','finance-output-policy.mjs','finance-call-chain.mjs','../package-lock.json'];
const codeSnapshot=()=>codePaths.map(name=>{const path=fileURLToPath(new URL(name,import.meta.url)),bytes=readFileSync(path);return {path,bytes,sha256:digest(bytes),kind:'code'};});
const loadedCode=codeSnapshot();
function periodBounds(scope){const [year,month]=scope.period.split('-').map(Number);if(scope.periodType==='quarterly'&&month%3!==0)reject('finance_prebook_quarter_not_ended');const startMonth=scope.periodType==='quarterly'?month-2:month,from=`${year}-${String(startMonth).padStart(2,'0')}-01`,through=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10),prior=new Date(Date.UTC(year,startMonth-1,0)).toISOString().slice(0,10);return {from,through,prior};}
const escape=value=>String(value??'未知').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const number=value=>{const n=Number(value);return Number.isFinite(n)&&Math.abs(n)<=PROJECTION_NUMBER_LIMIT?n:null;};

export function inspectPrebookFacts(facts,evidence){
 const {scope}=facts,bounds=periodBounds(scope),issues=[],deduplicated=[],records={},sourceRefs=evidence.sourceRefs;
 const issue=(code,request,ids=[],extra={})=>{const issueId=`pbi-${digest({code,ids}).slice(0,20)}`;if(!issues.some(i=>i.issueId===issueId))issues.push({issueId,code,severity:'blocking',state:'open',request,recordIds:ids,...extra});};
 for(const path of evidence.unbound)issue('source_binding_missing','请补充该字段的原件及精确定位。',[path]);
 for(const declaration of evidence.declarations??[])if(/\/(businessId|deductionStatus|direction|category|status|invoiceKind|accountId|itemId|vatCategory)$/.test(declaration.inputPointer))issue('mapping_semantics_unreviewed','该业务关联或分类仅有声明，请补充证据或核实，不能按声明自动销差。',[declaration.inputPointer]);
 for(const key of ['sales','invoices','purchases','receipts','bankTransactions','inventory']){
  if(!['complete','not_applicable'].includes(facts.coverage[key]))issue('coverage_missing','请确认该类资料覆盖完整期间，或补齐缺少资料。',[key]);
  const field=key==='inventory'?'inventoryCounts':key;
  if(facts.coverage[key]==='not_applicable'&&(facts[field]?.length||key==='inventory'&&(facts.opening?.inventory?.length||(facts.receipts??[]).length||(facts.sales??[]).some(r=>r.itemId))))issue('coverage_conflict','声明不适用但已提供相关业务，请核实资料范围。',[key]);
  if(facts.coverage[key]==='complete'&&!Array.isArray(facts[field]))issue('collection_missing','请提供该类明细；确无业务时提供有来源的空集合。',[key]);
 }
 for(const name of arrays){
  const byId=new Map();records[name]=[];
  for(const [index,row] of (facts[name]??[]).entries()){
   const key=name==='invoices'?`${row.direction}:${row.counterpartyId}:${row.invoiceNumber}`:name==='bankTransactions'&&row.bankReference?`${row.accountId}:${row.bankReference}`:name==='inventoryCounts'?row.itemId:row.id;
   if(row.enterpriseKey!==undefined&&row.enterpriseKey!==scope.enterpriseKey)reject('finance_prebook_record_scope_conflict');
   if(row.date&&(row.date<bounds.from||row.date>bounds.through))reject('finance_prebook_record_period_conflict');
   for(const field of ['date','asOf','openingDate','closingDate'])if(row[field])for(const ref of sourceRefs.filter(r=>r.inputPointer===`/${name}/${index}/${field}`))if(row[field]<ref.scope.from||row[field]>ref.scope.through)reject('finance_prebook_source_period_conflict');
   const prior=byId.get(key),shape={...row};delete shape.id;
   if(prior){const priorShape={...prior};delete priorShape.id;if(stable(shape)!==stable(priorShape))issue('duplicate_conflict','同一单据标识存在不同内容，需核实正确版本，不能自动合并。',[name,key]);else deduplicated.push({collection:name,id:row.id??key,keptId:prior.id??key});continue;}
   byId.set(key,row);records[name].push(row);
  }
  if(new Set(records[name].map(r=>r.id??r.itemId)).size!==records[name].length)issue('record_id_conflict','同一集合存在重复内部标识，请按原件更正。',[name]);
 }
 const {purchases,receipts,sales,invoices,bankTransactions,fundsAccounts,inventoryCounts}=records;
 for(const row of bankTransactions.filter(r=>!r.bankReference))if(bankTransactions.filter(r=>!r.bankReference&&r.accountId===row.accountId&&r.date===row.date&&r.direction===row.direction&&r.amount===row.amount&&r.counterpartyId===row.counterpartyId).length>1)issue('bank_duplicate_candidate','多笔流水日期、账户、对方及金额相同且缺银行流水号，请核实是否重复；未自动合并。',[row.id]);
 const priorRows=[...(facts.opening?.receivables??[]),...(facts.opening?.payables??[])],ambiguousPrior=new Set();
 for(const row of priorRows)if(priorRows.filter(x=>x.businessId===row.businessId).length!==1||[...purchases,...sales].some(x=>x.businessId===row.businessId)){ambiguousPrior.add(row.businessId);issue('prior_business_ambiguous','同一业务编号重复出现在上期往来或本期业务，无法确定收付归属；请提供唯一关联或分摊依据。',[row.businessId]);}
 if(!facts.opening?.asOf)issue('opening_missing','请提供上期账、截至日期及本期承接信息。',['opening']);
 else if(facts.opening.asOf!==bounds.prior)issue('opening_date_mismatch','上期结转日期应为本期开始前一天，请核实期间衔接。',['opening']);
 for(const kind of ['receivables','payables'])if(!Array.isArray(facts.opening?.[kind]))issue('prior_balances_missing','请提供上期应收/应付往来；未提供不能视为空，确无往来请提供有来源的空集合。',[`opening.${kind}`]);
 for(const invoice of invoices){
  if(cents(invoice.netAmount)+cents(invoice.taxAmount)!==cents(invoice.grossAmount))issue('invoice_total_mismatch','发票不含税金额加税额与价税合计不符，请核实。',[invoice.id]);
  if(invoice.status==='red')issue('red_document_review','红字票需核实原票及生效期间；首版不自动作抵减，请交会计复核。',[invoice.id]);
  else if(invoice.status==='valid'&&[invoice.netAmount,invoice.taxAmount,invoice.grossAmount].some(v=>cents(v)<0n))issue('negative_document_review','负数单据必须明确红字或退货性质。',[invoice.id]);
  if(invoice.status==='valid'&&!invoice.businessId)issue('invoice_business_missing','请说明该发票对应采购或销售业务，不能只按金额匹配。',[invoice.id]);
 }
 for(const sale of sales){
  if(sale.status==='red'||cents(sale.netAmount)<0n||own(sale,'taxAmount')&&cents(sale.taxAmount)<0n)issue('red_document_review','退货或负销售额需核实原业务及归属期，首版不自动净额抵减。',[sale.id]);
  if(sale.status==='valid'&&sale.invoiceKind!=='uninvoiced'&&!invoices.some(i=>i.direction==='sale'&&i.status==='valid'&&i.businessId===sale.businessId))issue('sale_invoice_missing','已开票销售缺对应销项票，请补票或更正开票性质。',[sale.id]);
 }
 for(const businessId of new Set(sales.filter(s=>s.status==='valid'&&s.invoiceKind!=='uninvoiced').map(s=>s.businessId))){
  const relatedSales=sales.filter(s=>s.status==='valid'&&s.invoiceKind!=='uninvoiced'&&s.businessId===businessId),relatedInvoices=invoices.filter(i=>i.status==='valid'&&i.direction==='sale'&&i.businessId===businessId);
  if(relatedInvoices.some(invoice=>relatedSales.some(sale=>!sale.customerId||invoice.counterpartyId!==sale.customerId)))issue('sale_counterparty_mismatch','销项票对方与销售客户缺失或不一致，请核实。',[businessId]);
  if(relatedInvoices.length&&(sum(relatedSales,'netAmount')!==sum(relatedInvoices,'netAmount')||relatedSales.every(s=>own(s,'taxAmount'))&&sum(relatedSales,'taxAmount')!==sum(relatedInvoices,'taxAmount')))issue('sale_invoice_difference','销售业务与关联销项票的不含税金额或税额不一致，请核实分批、红冲或重复。',[businessId]);
 }
 for(const receipt of receipts)if(!purchases.some(p=>p.businessId===receipt.businessId&&p.itemId===receipt.itemId))issue('receipt_purchase_missing','收货单缺同业务、同商品的采购资料，请补充或核实上期在途采购。',[receipt.id]);
 const relations=[];
 for(const businessId of new Set(purchases.map(p=>p.businessId))){
  const purchaseRows=purchases.filter(p=>p.businessId===businessId),purchase={...purchaseRows[0],grossAmount:money(sum(purchaseRows,'grossAmount'))};
  if(new Set(purchaseRows.map(p=>p.supplierId)).size!==1)issue('purchase_link_ambiguous','同一业务编号关联多个供应商，请拆分或核实关联。',[businessId]);
  const matchedInvoices=invoices.filter(i=>i.direction==='purchase'&&i.status==='valid'&&i.businessId===purchase.businessId),matchedReceipts=receipts.filter(r=>r.businessId===purchase.businessId),payments=bankTransactions.filter(b=>!ambiguousPrior.has(b.businessId)&&b.businessId===purchase.businessId&&b.direction==='outflow'&&b.category==='business');
  relations.push({businessId:purchase.businessId,purchaseId:purchase.id,purchaseIds:purchaseRows.map(r=>r.id),invoiceIds:matchedInvoices.map(r=>r.id),receiptIds:matchedReceipts.map(r=>r.id),paymentIds:payments.map(r=>r.id)});
  if(!matchedInvoices.length)issue('purchase_invoice_missing','采购业务尚未找到发票，请确认是否未开票、跨期或资料遗漏。',[purchase.id]);
  else if(sum(matchedInvoices,'grossAmount')!==cents(purchase.grossAmount))issue('purchase_invoice_difference','采购与关联发票金额不一致，请核实分批开票、退货或价差。',[purchase.id],{difference:money(sum(matchedInvoices,'grossAmount')-cents(purchase.grossAmount))});
  if(matchedInvoices.some(i=>i.counterpartyId!==purchase.supplierId))issue('counterparty_mismatch','发票对方与采购供应商不一致，请核实。',[purchase.id]);
  if(payments.some(payment=>payment.counterpartyId!==purchase.supplierId))issue('payment_counterparty_mismatch','采购付款对方与供应商缺失或不一致，请核实。',[purchase.id]);
  for(const itemId of new Set(purchaseRows.filter(p=>p.itemId).map(p=>p.itemId))){const itemRows=purchaseRows.filter(p=>p.itemId===itemId);if(itemRows.some(p=>!own(p,'quantity')))issue('receiving_quantity_missing','商品采购缺数量，无法核对收货。',[businessId,itemId]);else{const received=matchedReceipts.filter(r=>r.itemId===itemId).reduce((n,r)=>n+quantity(r.quantity),0n),ordered=itemRows.reduce((n,r)=>n+quantity(r.quantity),0n);if(received!==ordered)issue('receiving_difference','采购数量与收货数量不符，请核实未到货、分批到货或退货。',[businessId,itemId]);}}
  if(payments.length&&sum(payments,'amount')!==cents(purchase.grossAmount))issue('payment_difference','付款与采购金额不同，请核实预付、部分付款或结清上期欠款。',[purchase.id],{difference:money(sum(payments,'amount')-cents(purchase.grossAmount))});
 }
 for(const row of invoices.filter(i=>i.direction==='purchase'&&i.status==='valid'))if(!purchases.some(p=>p.businessId===row.businessId))issue('invoice_purchase_missing','该进项票缺采购业务资料，请补充用途及采购/收货说明。',[row.id]);
 for(const row of invoices.filter(i=>i.direction==='sale'&&i.status==='valid'))if(!sales.some(s=>s.status==='valid'&&s.businessId===row.businessId))issue('invoice_sale_missing','该销项票缺销售业务资料，请核实收入归属与重复。',[row.id]);
 const funds=[];
 if(!fundsAccounts.length&&facts.coverage.bankTransactions!=='not_applicable')issue('funds_balance_missing','请提供银行及现金的期初和实际期末余额与日期。',['fundsAccounts']);
 for(const account of fundsAccounts){
  const movements=bankTransactions.filter(b=>b.accountId===account.id),complete=['openingBalance','openingDate','closingBalance','closingDate'].every(k=>own(account,k));
  if(!complete)issue('funds_balance_missing','资金核对缺期初/期末余额或日期；缺失不能作为零。',[account.id]);
  if(own(account,'openingDate')&&account.openingDate!==bounds.prior||own(account,'closingDate')&&account.closingDate!==bounds.through)issue('funds_date_mismatch','资金余额日期与本期边界不同，请提供同口径余额。',[account.id]);
  const inflows=sum(movements.filter(b=>b.direction==='inflow'),'amount'),outflows=sum(movements.filter(b=>b.direction==='outflow'),'amount'),expected=own(account,'openingBalance')?cents(account.openingBalance)+inflows-outflows:null,difference=expected!==null&&own(account,'closingBalance')?cents(account.closingBalance)-expected:null;
  if(difference!==null&&difference!==0n)issue('funds_difference','期初余额加收支与实际期末余额不一致，请补流水或解释差异。',[account.id],{difference:money(difference)});
  funds.push({accountId:account.id,kind:account.kind,opening:account.openingBalance??null,inflows:money(inflows),outflows:money(outflows),calculatedClosing:expected===null?null:money(expected),actualClosing:account.closingBalance??null,difference:difference===null?null:money(difference),coverage:facts.coverage.bankTransactions??'missing'});
 }
 const priorSettlements=[];
 for(const [kind,direction] of [['receivables','inflow'],['payables','outflow']])for(const balance of facts.opening?.[kind]??[]){
  if(ambiguousPrior.has(balance.businessId)){priorSettlements.push({kind,id:balance.id,businessId:balance.businessId,openingAmount:balance.amount,settledAmount:null,remainingAmount:null,paymentIds:[],state:'ambiguous'});continue;}
  const payments=bankTransactions.filter(row=>row.businessId===balance.businessId&&row.direction===direction&&row.category==='business'),settled=sum(payments,'amount');
  if(cents(balance.amount)<0n||settled>cents(balance.amount))issue('prior_settlement_difference','本期收付超出上期往来余额或余额为负，请核实拆分与预收预付。',[balance.id]);
  if(payments.some(row=>row.counterpartyId!==balance.counterpartyId))issue('prior_counterparty_mismatch','结清上期往来的收付对象缺失或不一致，请核实。',[balance.id]);
  priorSettlements.push({kind,id:balance.id,businessId:balance.businessId,openingAmount:balance.amount,settledAmount:money(settled),remainingAmount:money(cents(balance.amount)-settled),paymentIds:payments.map(row=>row.id)});
 }
 for(const row of bankTransactions){
  if(cents(row.amount)<0n)issue('negative_bank_amount','流水金额应非负，收支方向由direction明确。',[row.id]);
  if(!fundsAccounts.some(a=>a.id===row.accountId))issue('bank_account_missing','该流水没有对应资金账户和余额资料。',[row.id]);
  if(row.category==='unknown')issue('bank_purpose_unknown','请老板说明这笔收付款用途，区分货款、借还款、垫款及内部转账。',[row.id]);
  const priorBalances=facts.opening?.[row.direction==='inflow'?'receivables':'payables']??[];
  const currentBusinesses=row.direction==='inflow'?sales.filter(sale=>sale.status==='valid'):purchases;
  if(row.category==='business'&&(!row.businessId||![...currentBusinesses,...priorBalances].some(x=>x.businessId===row.businessId)))issue('payment_business_missing','经营收付款缺同方向对应业务，请核实本期销售收款、采购付款、预收预付或上期往来。',[row.id]);
  if(row.category==='business'&&row.direction==='inflow'&&currentBusinesses.some(sale=>sale.businessId===row.businessId&&(!sale.customerId||sale.customerId!==row.counterpartyId)))issue('receipt_counterparty_mismatch','销售收款对方与客户缺失或不一致，请核实。',[row.id]);
 }
 const inventory=[];const items=new Set([...(facts.opening?.inventory??[]).map(r=>r.itemId),...receipts.map(r=>r.itemId),...sales.filter(r=>r.itemId).map(r=>r.itemId),...inventoryCounts.map(r=>r.itemId)]);
 for(const itemId of items){
  const openings=(facts.opening?.inventory??[]).filter(r=>r.itemId===itemId),count=inventoryCounts.find(r=>r.itemId===itemId),sold=sales.filter(r=>r.itemId===itemId&&r.status==='valid');
  if(openings.length!==1||sold.some(r=>!own(r,'quantity')))issue('inventory_inputs_missing','库存缺唯一上期数量或销售数量，请补充原件。',[itemId]);
  const received=receipts.filter(r=>r.itemId===itemId).reduce((n,r)=>n+quantity(r.quantity),0n),out=sold.filter(r=>own(r,'quantity')).reduce((n,r)=>n+quantity(r.quantity),0n),expected=openings.length===1&&!sold.some(r=>!own(r,'quantity'))?quantity(openings[0].quantity)+received-out:null;
  if(!count)issue('inventory_count_missing','请提供期末盘点或库存明细，账面推算不能冒称实盘。',[itemId]);
  else if(count.asOf!==bounds.through)issue('inventory_date_mismatch','库存数量截止日与本期不一致。',[itemId]);
  const difference=expected!==null&&count?quantity(count.quantity)-expected:null;
  if(difference!==null&&difference!==0n)issue('inventory_difference','上期库存加收货减销售与期末数量不符，请核实损耗、退货和漏单。',[itemId]);
  inventory.push({itemId,openingQuantity:openings.length===1?openings[0].quantity:null,receivedUnits:received.toString(),soldUnits:out.toString(),calculatedClosingUnits:expected?.toString()??null,actualClosingQuantity:count?.quantity??null,differenceUnits:difference?.toString()??null,quantityUnitScale:1000000});
 }
 const activeSales=sales.filter(s=>s.status==='valid'&&cents(s.netAmount)>=0n),salesTotal=sum(activeSales,'netAmount'),taxInputs={},taxpayer=facts.taxpayer,salesTaxDerivations=[];
 for(const [key,value] of Object.entries(taxpayer))if(key!=='vatStatus')taxInputs[key]=value;
 let tax;
 const sourceValid=!evidence.unbound.length&&!issues.some(i=>['duplicate_conflict','record_id_conflict','red_document_review','negative_document_review','invoice_total_mismatch','invoice_sale_missing','sale_invoice_difference'].includes(i.code));
 if(taxpayer.vatStatus==='unknown')tax={status:'needs_inputs',amounts:{},conditions:[],needsInputs:[{field:'taxpayer.vatStatus'}],rules:[]};
 else{
  const kind=taxpayer.vatStatus==='general'?'vat_general':'vat_small';
  if(facts.coverage.sales==='complete'&&Array.isArray(facts.sales)&&sourceValid){
   if(kind==='vat_general'){
    const derivedSales=activeSales.map(sale=>{if(own(sale,'taxAmount'))return sale;if(!sale.vatCategory)return sale;const calculated=calculateAgencyOutputVat({entity:{vatStatus:'general'},category:sale.vatCategory,net:sale.netAmount,date:sale.date,invoiceKind:sale.invoiceKind==='uninvoiced'?'unissued':sale.invoiceKind});salesTaxDerivations.push({recordId:sale.id,netAmount:sale.netAmount,category:sale.vatCategory,taxAmount:calculated.tax,rateBasisPoints:calculated.rateBasisPoints,sources:calculated.sources,meaning:'原生交易税额派生，业务分类及税务归属待会计复核'});return {...sale,taxAmount:calculated.tax};});
    let conflict=false;for(const businessId of new Set(derivedSales.filter(s=>s.invoiceKind!=='uninvoiced').map(s=>s.businessId))){const group=derivedSales.filter(s=>s.businessId===businessId&&s.invoiceKind!=='uninvoiced'),bills=invoices.filter(i=>i.status==='valid'&&i.direction==='sale'&&i.businessId===businessId);if(bills.length&&group.every(s=>own(s,'taxAmount'))&&sum(group,'taxAmount')!==sum(bills,'taxAmount')){conflict=true;issue('sale_invoice_difference','销售计算税额与关联销项票税额不一致，请核实业务分类、舍入或重复。',[businessId]);}}
    if(derivedSales.every(s=>own(s,'taxAmount'))&&!conflict)taxInputs.outputVat=money(sum(derivedSales,'taxAmount'));else if(!conflict)issue('sale_tax_basis_missing','一般纳税人销售缺税额且缺业务税目，请补基础业务分类，系统按原生规则计算。',['sales']);
   }
   else{taxInputs.periodType=scope.periodType;taxInputs.salesExcludingVat=money(salesTotal);taxInputs.specialInvoiceSalesExcludingVat=money(sum(activeSales.filter(s=>s.invoiceKind==='special'),'netAmount'));if(activeSales.filter(s=>s.invoiceKind==='special').every(s=>own(s,'taxAmount')))taxInputs.specialInvoiceVat=money(sum(activeSales.filter(s=>s.invoiceKind==='special'),'taxAmount'));taxInputs.taxpayerCategory='small';}
  }
  if(kind==='vat_general'){
   const purchaseInvoices=invoices.filter(i=>i.direction==='purchase'&&i.status==='valid');
   if(facts.coverage.invoices==='complete'&&Array.isArray(facts.invoices)&&sourceValid){if(purchaseInvoices.some(i=>!['eligible','ineligible'].includes(i.deductionStatus)))issue('input_vat_status_missing','请核实进项票用途及抵扣状态，未知不能全部计入抵扣。',['invoices']);else taxInputs.certifiedInputVat=money(sum(purchaseInvoices.filter(i=>i.deductionStatus==='eligible'),'taxAmount'));}
   for(const key of ['carryCredit','inputVatTransferOut','prepaidVat'])if(own(facts.opening,key)&&sourceValid&&(key!=='carryCredit'||facts.opening.asOf===bounds.prior))taxInputs[key==='carryCredit'?'openingCarryCredit':key]=facts.opening[key];else issue('vat_carry_inputs_missing','请补充上期留抵、本期转出和预缴依据；缺失只作明确条件，不证明为零。',[key]);
  }
  tax=calculateFinanceSummary(kind,taxInputs,scope);
  if(salesTaxDerivations.length)tax.conditions.push({code:'sales_vat_category_unreviewed',state:'unverified',meaning:'逐笔销项税额由原生交易函数按净额及业务税目派生，分类适用与归属期间仍待会计复核。'});
 }
 if(tax.status==='needs_inputs')issue('tax_inputs_missing','税费试算缺少必要资料，详见税费缺件清单。',['tax']);
 if(tax.status==='unsupported')issue('tax_scope_unsupported','本期业务超出普通增值税条件试算范围，需按独立税务流程核实。',['tax']);
 if(taxpayer.ordinaryDomesticScopeConfirmed!==true)issue('tax_scope_unconfirmed','请核实普通境内业务适用范围，不按默认条件视为已确认。',['taxpayer']);
 const due=tax.amounts?.due,burden=due!==undefined&&salesTotal>0n&&facts.coverage.sales==='complete'&&sourceValid?{numerator:'VAT_due',denominator:'sales_excluding_VAT',salesExcludingVat:money(salesTotal),due,percent:Number(cents(due)*1000000n/salesTotal)/10000}:null;
 return {scope,bounds,records,sourceRefs,declarations:evidence.declarations??[],internalIds:evidence.internalIds??[],deduplicated,issues,relations,priorSettlements,funds,inventory,tax:{...tax,derivedInputs:taxInputs,salesTaxDerivations,burden},status:tax.status==='unsupported'?'unsupported':issues.length?'needs_inputs':'ready_for_bookkeeping_review',review:{booksVerified:false,accountantApproval:'pending',posted:false,submittable:false,authorizesExecution:false}};
}

function renderReview(result){
 const table=(headers,rows)=>`<table><thead><tr>${headers.map(x=>`<th>${escape(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(x=>`<td>${escape(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
 const states={ready_for_bookkeeping_review:'可交会计继续整理做账',needs_inputs:'待补件或核实',unsupported:'需转独立税务处理',conditional_calculated:'条件试算，待会计复核'};
 const labels={outputVat:'销项税额',certifiedInputVat:'条件可抵扣进项',availableCredit:'可用抵扣额',dueBeforePrepayment:'预缴抵减前应纳额',prepaymentUsed:'本期使用预缴',due:'本期条件应纳额',carryCredit:'期末留抵',unusedPrepayment:'未使用预缴',salesExcludingVat:'不含税销售额',specialInvoiceVat:'专票税额',threshold:'起征点比较金额',ordinaryTax:'普通销售税额'};
 const units=value=>{if(value===null)return '未知';let n=BigInt(value);const sign=n<0n?'-':'';if(n<0n)n=-n;return sign+`${n/1000000n}.${String(n%1000000n).padStart(6,'0')}`.replace(/\.?0+$/,'');};
 const refs=result.sourceRefs.map(r=>({field:r.inputPointer,original:r.originalId,location:r.csvEmpty?'CSV表头后无数据行':r.jsonPointer??`CSV行${r.csvRow}，列${r.column}`,sha256:r.sha256}));
 const body=[`<h1>账前资料核对</h1><p>企业：${escape(result.scope.enterpriseKey)}；期间：${escape(result.bounds.from)} 至 ${escape(result.bounds.through)}；${escape(states[result.status])}。金额单位：人民币元。</p><p>未记账、未申报。老板说明、原件值核对和会计审核分别保留。资料齐备状态只表示可交会计继续处理，不表示真实性或税务资格已审定。</p>`,
 '<h2>资金核对</h2>',table(['账户','类别','期初','收入','支出','计算期末','实际期末','差额'],result.funds.map(r=>[r.accountId,r.kind==='cash'?'现金':'银行',r.opening,r.inflows,r.outflows,r.calculatedClosing,r.actualClosing,r.difference])),
 '<h2>采购、发票和付款关联</h2>',`<p>已去重 ${result.deduplicated.length} 条；按显式业务编号关联。</p>`,table(['采购单','业务','发票','收货','付款'],result.relations.map(r=>[r.purchaseIds.join('、'),r.businessId,r.invoiceIds.join('、'),r.receiptIds.join('、'),r.paymentIds.join('、')])),
 '<h2>上期往来与本期收付</h2>',table(['类型','上期业务','上期余额','本期收付','剩余余额','流水'],result.priorSettlements.map(r=>[r.kind==='payables'?'应付':'应收',r.businessId,r.openingAmount,r.settledAmount,r.remainingAmount,r.paymentIds.join('、')])),
 '<h2>库存数量核对</h2>',table(['商品','上期数量','收货','销售','推算期末','实际期末','数量差异'],result.inventory.map(r=>[r.itemId,r.openingQuantity,units(r.receivedUnits),units(r.soldUnits),units(r.calculatedClosingUnits),r.actualClosingQuantity,units(r.differenceUnits)])),
 '<h2>增值税条件试算</h2>',`<p>${escape(states[result.tax.status])}。税负口径为增值税应纳额／不含税销售额：${result.tax.burden?escape(result.tax.burden.percent)+'%':'资料不足或无适用分母'}。</p>`,table(['项目','金额'],Object.entries(result.tax.amounts??{}).map(([k,v])=>[labels[k]??k,v])),
 ...(result.tax.salesTaxDerivations.length?['<h3>原生销项税额计算</h3>',table(['销售记录','净额','业务税目','原生税率','派生税额'],result.tax.salesTaxDerivations.map(r=>[r.recordId,r.netAmount,r.category,`${r.rateBasisPoints/100}%`,r.taxAmount]))]:[]),
 ...(result.tax.scenarios??[]).map(s=>`<h3>${escape(s.scenario==='ordinary_reduced'?'适用减征条件':s.scenario==='ordinary_waived'?'放弃减征条件':s.scenario)}</h3>${table(['项目','金额'],Object.entries(s.amounts).map(([k,v])=>[labels[k]??k,v]))}`),
 '<h3>成立条件及缺件</h3>',table(['事项','说明'],[...(result.tax.conditions??[]).map(c=>[c.code,c.meaning]),...(result.tax.needsInputs??[]).map(c=>[c.field,'缺少有来源的输入，不能视作零'])]),
 '<h2>老板问询及补件</h2>',table(['问题编号','具体业务或字段','所需说明/资料','差额','回复状态'],result.issues.map(r=>[r.issueId,r.recordIds.join('、'),r.request,r.difference??'待核',r.ownerStatement?'已有说明，证据仍待核':'待回复/补件'])),
 '<h3>业务定位</h3>',table(['集合','记录','业务','对方','日期'],Object.entries(result.records).flatMap(([kind,rows])=>rows.map(r=>[kind,r.id??r.itemId,r.businessId??'',r.counterpartyId??r.supplierId??r.customerId??'',r.date??r.asOf??'']))),
 '<h2>老板说明</h2>',table(['问题','回复人','时间','说明','有效状态'],result.responses.map(r=>[r.issueId,r.respondent,r.respondedAt,r.statement,r.state==='stale'?'资料已变更，旧回复失效':r.state==='unknown_issue'?'问题不在本版':'声明已记录，非审核批准'])),
 '<h2>税务规则依据</h2>',table(['来源','定位','地址'],(result.tax.rules??[]).map(r=>[r.title,r.locator,r.url])),
 '<h2>交接与深入核查</h2><p>handoff.json 是业务整理资料，由现有做账流程按其合同继续处理；不是凭证导入或入账批准。</p><p><a href="prebook.json">完整核对结果</a> · <a href="handoff.json">交接资料</a> · <a href="evidence-index.json">原件索引</a></p>',
 `<p>资料版本：${escape(result.inputDigest)}；来源哈希只证明字节对应，不证明业务真实性。</p><details><summary>字段与原件定位</summary>${table(['字段','原件','原件位置','摘要'],refs.map(r=>[r.field,r.original,r.location,r.sha256]))}</details>`];
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>账前资料核对</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:16px;color:#172333}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border:1px solid #ccd5df;padding:9px;text-align:left;overflow-wrap:anywhere}h1,h2{color:#204a70}</style>${body.join('\n')}</html>`;
}
export async function runPrebookReview(args,options={}){
 if(!currentFinanceCall())return withFinanceCall({tool:'finance_prebook_review',args,auditDir:options.auditDir},()=>runPrebookReview(args,options));
 check(PREBOOK_TOOL_SCHEMA,args);
 const inputSource=readSource(args.inputPath),input=parseJson(inputSource);check(PREBOOK_INPUT_SCHEMA,input);
 const evidence=bindEvidence(input),code=codeSnapshot();if(code.some((file,index)=>file.sha256!==loadedCode[index].sha256))reject('finance_prebook_runtime_code_changed');
 const inputDigest=digest({facts:input.facts,bindings:input.bindings,declarations:input.declarations??[],sources:evidence.files.map(s=>({id:s.id,sha256:s.sha256,scope:s.scope})),code:code.map(s=>s.sha256)});
 const result={version:'finance-prebook-result/1',inputDigest,...inspectPrebookFacts(input.facts,evidence),responses:[]};let replySource;
 if(args.repliesPath){replySource=readSource(args.repliesPath);const replies=parseJson(replySource);check(PREBOOK_REPLIES_SCHEMA,replies);if(replies.enterpriseKey!==result.scope.enterpriseKey||replies.period!==result.scope.period)reject('finance_prebook_reply_scope_conflict');const ids=new Set();for(const reply of replies.responses){if(ids.has(reply.issueId))reject('finance_prebook_reply_duplicate');ids.add(reply.issueId);const issue=result.issues.find(i=>i.issueId===reply.issueId),state=replies.inputDigest!==inputDigest?'stale':!issue?'unknown_issue':'statement_recorded';result.responses.push({...reply,state});if(state==='statement_recorded')issue.ownerStatement={...reply,meaning:'老板声明，仍需补证或业务核实'};}}
 const call=currentFinanceCall(),runId=call.callId??randomUUID(),dir=join(call.auditDir,'prebook',runId);
 for(let p=resolve(dir);;p=dirname(p)){try{if(lstatSync(p).isSymbolicLink())reject('finance_prebook_output_path_invalid');}catch(error){if(error.code!=='ENOENT')throw error;}if(dirname(p)===p)break;}mkdirSync(dir,{recursive:true});
 const files=[{...inputSource,kind:'prepared_input'},...evidence.files.map(s=>({...s,kind:'original'})),...(replySource?[{...replySource,kind:'owner_statement'}]:[]),...code],index=[];
 mkdirSync(join(dir,'evidence'));
 for(const [i,file] of files.entries()){const snapshot=`evidence/${i}.blob`;writeFileSync(join(dir,snapshot),file.bytes,{flag:'wx'});index.push({path:file.path,snapshot,sha256:file.sha256,bytes:file.bytes.length,kind:file.kind});}
 const save=(name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
 save('prebook.json',result);save('evidence-index.json',{version:'finance-prebook-evidence/1',files:index,bindings:evidence.sourceRefs});
 save('handoff.json',{version:'finance-prebook-handoff/1',scope:result.scope,inputDigest,status:result.status,meaning:'业务整理资料；由现有做账流程按其输入合同继续处理，不是凭证导入文件。',facts:input.facts,sourceRefs:evidence.sourceRefs,declarations:result.declarations,internalIds:result.internalIds,records:result.records,ownerStatements:result.responses,unresolvedIssues:result.issues,taxConditions:result.tax.conditions??[],review:result.review});
 writeFileSync(join(dir,'review.html'),renderReview(result),{flag:'wx'});
 const artifactRef=`finance-prebook:${runId}`;annotateFinanceCall({scope:result.scope,businessOutcome:result.status,ruleVersion:FINANCE_SUMMARY_RULE_VERSION,sources:files.filter(f=>f.kind!=='code').map(f=>({path:f.path,sha256:f.sha256})),artifactRefs:[`${artifactRef}/prebook.json`,`${artifactRef}/handoff.json`,`${artifactRef}/review.html`]});
 return {version:'finance-prebook-projection/1',status:result.status,period:result.scope.period,periodType:result.scope.periodType,taxpayerType:input.facts.taxpayer.vatStatus,inputDigest,issueCount:result.issues.length,issues:result.issues.map(i=>({issueId:i.issueId,code:i.code,state:i.ownerStatement?'statement_recorded':'open'})),deduplicatedCount:result.deduplicated.length,tax:{status:result.tax.status,amounts:Object.fromEntries(Object.entries(result.tax.amounts??{}).map(([k,v])=>[k,number(v)])),scenarios:(result.tax.scenarios??[]).map(s=>({scenario:s.scenario,amounts:Object.fromEntries(Object.entries(s.amounts).map(([k,v])=>[k,number(v)]))})),conditionCodes:(result.tax.conditions??[]).map(c=>c.code),needsInputs:(result.tax.needsInputs??[]).map(c=>c.field),burdenPercent:result.tax.burden?.percent??null,ruleVersion:result.tax.ruleVersion??null},responses:{recorded:result.responses.filter(r=>r.state==='statement_recorded').length,stale:result.responses.filter(r=>r.state==='stale').length,unknown:result.responses.filter(r=>r.state==='unknown_issue').length},review:result.review,evidence:{callRef:runId,artifactRef,reviewPath:join(dir,'review.html'),handoffPath:join(dir,'handoff.json'),reviewRef:`${artifactRef}/review.html`,handoffRef:`${artifactRef}/handoff.json`,indexRef:`${artifactRef}/evidence-index.json`},modelBoundary:{rawValues:'local_only',mode:'fixed_business_projection',paths:'generated_artifacts_only'}};
}
