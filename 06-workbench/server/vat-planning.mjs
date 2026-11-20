import {resolveDirectFinanceTarget} from './direct-finance-target.mjs';
import {currentFinanceCall,financeAuditDirectory} from './finance-call-chain.mjs';
import {digest} from './finance-prebook-evidence.mjs';
import {calculateFinanceSummary,summaryRules,FINANCE_SUMMARY_RULE_VERSION} from './finance-summary-engine.mjs';
import {money,cents} from './agency-tax-rules.mjs';
import {readVatFacts,fail,isMonth} from './vat-planning-evidence.mjs';

const monthOffset=(period,n)=>{
 const [y,m]=period.split('-').map(Number);
 return new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,7);
};
function amount(value){
 if(!['string','number'].includes(typeof value)||!/^\d{1,12}(\.\d{1,2})?$/.test(String(value)))return null;
 return money(cents(String(value)));
}
function refFor(row,scope){
 if(![row.invoiceNumber,row.issuer].every(v=>typeof v==='string'&&v.trim()===v&&v.length>0))return null;
 return 'vat-'+digest([scope.databaseInstanceId,scope.enterpriseKey,scope.accountSetId,row.issuer,row.invoiceNumber]).slice(0,24);
}
const latest=(...periods)=>periods.filter(Boolean).sort().at(-1);
function coalesce(rows,key,gaps){
 const result={sources:[]};
 for(const row of rows){
  result.sources.push(row.source);
  for(const [name,raw] of Object.entries(row.data)){
   if(['knownAt','issuer','invoiceNumber'].includes(name))continue;
   const value=['taxAmount','carryCredit','outputVat','prepaidVat','inputVatTransferOut'].includes(name)?amount(raw):raw;
   if(value===null){gaps.push({code:'invalid_amount',field:name,...key,source:row.source});continue;}
   if(result[name]!==undefined&&result[name]!==value){gaps.push({code:'source_conflict',field:name,...key,sources:result.sources.slice()});continue;}
   result[name]=value;
  }
 }
 return result;
}
function groups(rows,key){
 const out=new Map();
 for(const row of rows){
  const id=key(row);
  if(!out.has(id))out.set(id,[]);
  out.get(id).push(row);
 }
 return out;
}
function calendar(rows,filings,periods,asOf,gaps){
 const byPeriod=groups(rows,r=>r.data.period),months=new Map();
 for(const period of periods){
  const records=byPeriod.get(period)??[],actual=records.filter(r=>r.data.basis==='actual');
  const selected=actual.length?actual:records;
  const month=coalesce(selected,{period},gaps);
  const filed=filings.filter(f=>f.data.period===period);
  if(filed.length){month.state='filed';month.sources.push(...filed.map(f=>f.source));}
  const lastDay=new Date(Date.parse(monthOffset(period,1)+'-01')-86400000).toISOString().slice(0,10);
  if(!['open','filed'].includes(month.state)||!['actual','forecast'].includes(month.basis)||
   month.state==='filed'&&month.basis!=='actual'||month.basis==='actual'&&asOf<lastDay||
   ![month.outputVat,month.inputVatTransferOut,month.prepaidVat].every(v=>v!==undefined)||
   month.otherEffects!=='none')gaps.push({code:'month_incomplete_or_unsupported',period,sources:month.sources});
  months.set(period,month);
 }
 return months;
}
function inventory(facts,scope,gaps){
 const observations=facts.filter(f=>['invoice','confirmation'].includes(f.kind));
 const incomplete=observations.filter(f=>f.issue||!refFor(f.data,scope));
 for(const row of incomplete)gaps.push({code:row.issue??'invoice_identity_incomplete',invoiceRow:true,sources:[row.source]});
 const grouped=groups(observations.filter(f=>!incomplete.includes(f)),r=>refFor(r.data,scope));
 const invoices=new Map();
 for(const [invoiceRef,rows] of grouped){
  const initialGaps=gaps.length;
  for(const partial of incomplete){
   const key=partial.data;
   if((key.invoiceNumber||key.issuer)&&(!key.invoiceNumber||key.invoiceNumber===rows[0].data.invoiceNumber)&&(!key.issuer||key.issuer===rows[0].data.issuer)){
    gaps.push({code:'possible_unresolved_duplicate',invoiceRef,sources:[partial.source]});
   }
  }
  const bill=coalesce(rows.filter(r=>r.kind==='invoice'),{invoiceRef},gaps);
  const confirmedRows=rows.filter(r=>r.kind==='confirmation');
  const fixed=coalesce(confirmedRows,{invoiceRef},gaps);
  const confirmed=confirmedRows.length>0;
  if(confirmed&&fixed.taxAmount!==undefined&&bill.taxAmount!==undefined&&fixed.taxAmount!==bill.taxAmount)gaps.push({code:'source_conflict',field:'taxAmount',invoiceRef,sources:fixed.sources});
  const taxAmount=bill.taxAmount??fixed.taxAmount,eligibility=bill.eligibility??(confirmed?'eligible':undefined);
  const receiptPeriod=bill.receipt?.slice(0,7),issued=(bill.issueDate??fixed.issueDate)?.slice(0,7);
  if(taxAmount===undefined||!['eligible','ineligible'].includes(eligibility)||(!confirmed&&!isMonth(receiptPeriod))||
   (bill.eligibleFrom!==undefined&&!isMonth(bill.eligibleFrom))||(bill.eligibleThrough!==undefined&&!isMonth(bill.eligibleThrough)))gaps.push({code:'invoice_missing_or_unsupported',invoiceRef,sources:bill.sources});
  const firstPeriod=latest(receiptPeriod,issued,bill.eligibleFrom);
  // 实际操作可在次月；明确的开票/适用窗口却不能晚于其税款所属期。
  const fixedOutside=confirmed&&((issued&&fixed.taxPeriod<issued)||(bill.eligibleFrom&&fixed.taxPeriod<bill.eligibleFrom)||(bill.eligibleThrough&&fixed.taxPeriod>bill.eligibleThrough)||confirmedRows.some(r=>fixed.taxPeriod>(r.data.operationDate??r.data.knownAt).slice(0,7)));
  if(confirmed&&(!isMonth(fixed.taxPeriod)||eligibility!=='eligible'||fixedOutside)||bill.eligibleThrough&&bill.eligibleThrough<firstPeriod)gaps.push({code:'confirmation_or_window_unresolved',invoiceRef,sources:[...bill.sources,...fixed.sources]});
  invoices.set(invoiceRef,{invoiceRef,taxAmount,eligibility:['eligible','ineligible','red'].includes(eligibility)?eligibility:'unknown',receipt:bill.receipt,issueDate:bill.issueDate??fixed.issueDate,
   resolved:gaps.length===initialGaps,
   firstPeriod,lastPeriod:bill.eligibleThrough??null,fixedPeriod:fixed.taxPeriod??null,operationDate:fixed.operationDate??null,sources:[...bill.sources,...fixed.sources]});
 }
 return invoices;
}
function selections(entries,book,months){
 const choices=new Map();
 for(const {invoiceRef,period} of entries){
  const bill=book.get(invoiceRef);
  if(!bill||choices.has(invoiceRef))fail('finance_vat_selection_unknown_or_duplicate');
  if(bill.fixedPeriod||months.get(period)?.state==='filed')fail('finance_vat_selection_already_fixed');
  if(bill.eligibility!=='eligible'||!months.has(period)||bill.firstPeriod>period||bill.lastPeriod&&period>bill.lastPeriod)fail('finance_vat_selection_period_unavailable');
  choices.set(invoiceRef,period);
 }
 return choices;
}
function remaining(book,choices,period){
 let count=0,total=0n,expired=0n,unknownCount=0,unknown=0n;
 for(const bill of book.values()){
  const used=bill.fixedPeriod??choices.get(bill.invoiceRef);
  const arrived=latest(bill.receipt?.slice(0,7),bill.issueDate?.slice(0,7));
  if(bill.eligibility!=='eligible'||arrived>period||used&&used<=period)continue;
  if(!bill.receipt&&!(bill.operationDate&&bill.operationDate.slice(0,7)<=period)){
   unknownCount++;unknown+=cents(bill.taxAmount);continue;
  }
  if(bill.lastPeriod&&bill.lastPeriod<=period){expired+=cents(bill.taxAmount);continue;}
  count++;total+=cents(bill.taxAmount);
 }
 return {unusedCount:count,unusedVat:money(total),expiredUnusedVat:money(expired),holdingUnknownCount:unknownCount,holdingUnknownVat:money(unknown)};
}
function simulate(months,book,choices,opening,yearEnd){
 let carry=opening,yearDue=0n,yearPaid=0n,totalDue=0n,atYearEnd=null,firstCarryUse=null;
 const rows=[];
 for(const [period,month] of months){
  let input=0n;
  for(const bill of book.values())if((bill.fixedPeriod??choices.get(bill.invoiceRef))===period)input+=cents(bill.taxAmount);
  const result=calculateFinanceSummary('vat_general',{outputVat:month.outputVat,certifiedInputVat:money(input),openingCarryCredit:carry,
   prepaidVat:month.prepaidVat,inputVatTransferOut:month.inputVatTransferOut,ordinaryDomesticScopeConfirmed:true},{period});
  if(result.status!=='conditional_calculated'||cents(result.amounts.unusedPrepayment)!==0n)return {gap:{code:result.unsupportedReason??'unused_prepayment_requires_separate_carry',period}};
  const {due,carryCredit}=result.amounts,paymentMonth=monthOffset(period,1);
  rows.push({period,basis:month.basis,state:month.state,outputVat:month.outputVat,openingCarryCredit:carry,selectedAndFixedInput:money(input),
   inputVatTransferOut:month.inputVatTransferOut,prepaidVat:month.prepaidVat,due,paymentMonth,expectedPayment:due,endingCarryCredit:carryCredit,sources:month.sources});
  if(period>yearEnd&&atYearEnd&&cents(atYearEnd.carryCredit)>0n&&!firstCarryUse&&cents(carryCredit)<cents(atYearEnd.carryCredit))firstCarryUse=period;
  carry=carryCredit;totalDue+=cents(due);
  if(period<=yearEnd)yearDue+=cents(due);
  if(paymentMonth<=yearEnd)yearPaid+=cents(due);
  if(period===yearEnd)atYearEnd={period,dueFromStart:money(yearDue),paymentsFromSimulatedPeriods:money(yearPaid),carryCredit:carry,...remaining(book,choices,period)};
 }
 const through=rows.at(-1).period;
 return {months:rows,yearEnd:atYearEnd,horizon:{through,dueFromStart:money(totalDue),carryCredit:carry,...remaining(book,choices,through)},
  nextYear:rows.find(r=>r.period>yearEnd)??null,
  nextYearUse:{through,firstNetOutputUsingCarry:firstCarryUse,firstScheduledInvoiceUse:[...choices.values()].filter(p=>p>yearEnd&&p<=through).sort()[0]??null,
   coverage:through>yearEnd?'forecast_window':yearEnd==='2027-12'?'beyond_supported_rule_window':'not_simulated'}};
}
const difference=(a,b)=>money(cents(a)-cents(b));
export function runVatPlanning(args){
 const {period:start}=args.target,yearEnd=start.slice(0,4)+'-12';
 if(args.through<yearEnd||args.asOf.slice(0,7)<start)fail('finance_vat_planning_range_invalid');
 const binding=resolveDirectFinanceTarget(args.target);
 const facts=readVatFacts(args,binding,financeAuditDirectory()),gaps=[];
 for(const f of facts.filter(f=>f.issue&&!['invoice','confirmation'].includes(f.kind)))gaps.push({code:f.issue,period:start,sources:[f.source]});
 const periods=[];
 for(let p=start;p<=args.through;p=monthOffset(p,1))periods.push(p);
 const opening=coalesce(facts.filter(f=>f.kind==='opening'&&f.data.period===monthOffset(start,-1)),{period:monthOffset(start,-1)},gaps);
 if(opening.carryCredit===undefined||opening.scope!=='monthly_general_domestic')gaps.push({code:'opening_balance_or_scope_unverified',period:monthOffset(start,-1),sources:opening.sources});
 if(opening.inventoryCoverage!=='complete')gaps.push({code:'invoice_inventory_incomplete',invoiceRow:true,sources:opening.sources});
 const months=calendar(facts.filter(f=>f.kind==='month'),facts.filter(f=>f.kind==='filing'),periods,args.asOf,gaps),book=inventory(facts,binding.scope,gaps);
 const basis=digest({scope:binding.scope,asOf:args.asOf,through:args.through,facts});
 if(args.expectedBasis&&args.expectedBasis!==basis)fail('finance_vat_basis_changed');
 const offset=args.offset??0,limit=args.limit??50;
 const common={version:'finance-vat-planning/1',basis,asOf:args.asOf,start,through:args.through,ruleVersion:FINANCE_SUMMARY_RULE_VERSION,
  rules:summaryRules('vat_general'),openingSources:opening.sources,callRef:currentFinanceCall()?.callId,localEvidence:'vat-planning-evidence.json',
  invoices:[...book.values()].slice(offset,offset+limit),pagination:{total:book.size,offset,next:offset+limit<book.size?offset+limit:null},
  conditions:['月度境内一般计税，逐票用途、未用票覆盖、身份与预测取决于来源。','税款以次月付款为条件。年度现金差仅含本次模拟所属期的增值税，其他收支、税费及期初付款须相同。','期末留抵及未用票不计作现金，跨年税款时间差不能计作永久节税。'],
  posted:false,submittable:false};
 const firstGap=gaps.filter(g=>!g.invoiceRef&&!g.invoiceRow).map(g=>g.period).sort()[0];
 const comparable=new Map([...months].filter(([period])=>!firstGap||period<firstGap));
 if(!comparable.size)return {...common,status:'needs_inputs',gaps};
 const resolved=new Map([...book].filter(([,bill])=>bill.resolved));
 const compare=periods=>[args.baseline,args.plan].map(entries=>simulate(periods,resolved,selections(entries??[],resolved,months),opening.carryCredit,yearEnd));
 let [baseline,plan]=compare(comparable);
 if(baseline.gap||plan.gap){
  const problems=[baseline.gap,plan.gap].filter(Boolean);
  const stop=problems.map(g=>g.period).sort()[0];
  gaps.push(...problems);
  const prefix=new Map([...comparable].filter(([period])=>period<stop));
  if(!prefix.size)return {...common,status:'unsupported',gaps};
  [baseline,plan]=compare(prefix);
 }
 const yearly=(field,reverse=false)=>!baseline.yearEnd?null:reverse?difference(baseline.yearEnd[field],plan.yearEnd[field]):difference(plan.yearEnd[field],baseline.yearEnd[field]);
 const delta={yearEndAfterVatCash:yearly('paymentsFromSimulatedPeriods',true),
  yearAttributedVat:yearly('dueFromStart'),yearEndCarryCredit:yearly('carryCredit'),
  yearEndUnusedVat:yearly('unusedVat'),horizonDue:difference(plan.horizon.dueFromStart,baseline.horizon.dueFromStart),
  byPaymentMonth:plan.months.map((row,index)=>({paymentMonth:row.paymentMonth,afterVatCash:difference(baseline.months[index].expectedPayment,row.expectedPayment)}))};
 if(gaps.length)return {...common,status:'partial_known_invoices',gaps,knownSubset:{baseline,plan,delta,
  condition:'仅反映已核票据和连续可测期间。待核票被排除，后续缺口前截断，完整应纳、留抵及实际差额仍待核实。'}};
 return {...common,status:'conditional_calculated',baseline,plan,delta};
}
