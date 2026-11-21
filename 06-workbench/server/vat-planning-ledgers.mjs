// 客户约定、逐期累计与真实业务回执，均按来源取值。
import {cents,money,roundRatio} from './agency-tax-rules.mjs';
import {digest} from './finance-prebook-evidence.mjs';
import {isMonth,cutoff} from './vat-planning-evidence.mjs';

export const VAT_SALES_FIELDS=new Set(['salesExcludingVat','invoicedSales','uninvoicedSales','ytdSalesExcludingVat']);
export function amount(value,signed=false){
 if(!['string','number'].includes(typeof value)||!/^[-]?\d{1,12}(\.\d{1,2})?$/.test(String(value))||!signed&&String(value).startsWith('-'))return null;
 return money(cents(String(value)));
}
const sameValue=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function salesByPeriod(facts,start,gaps){
 const documents=new Map(),totals=new Map(),returns=new Map();
 const issue=(code,period,sources)=>gaps.push({code,period:period??start,sources});
 for(const {data,source,issue:unread} of facts.filter(f=>f.kind==='sale')){
  if(unread)continue;
  const {transactionId,originalTransactionId,taxPointDate,billingDate}=data;
  const period=taxPointDate?.slice(0,7),sales=amount(data.salesExcludingVat),tax=amount(data.outputVat);
  if(!isMonth(period)||typeof transactionId!=='string'||!transactionId.trim()||sales===null||tax===null||
     originalTransactionId!==undefined&&(typeof originalTransactionId!=='string'||!originalTransactionId.trim())||billingDate&&billingDate<taxPointDate){
   issue('transaction_tax_point_or_amount_unverified',period,[source]);continue;
  }
  const identity={taxPointDate,sales,tax,originalTransactionId};
  const prior=documents.get(transactionId);
  if(prior){
   prior.sources.push(source);
   if(!sameValue(prior.identity,identity)||prior.billingDate&&billingDate&&prior.billingDate!==billingDate){
    issue('conflicting_recognition_of_same_transaction',[prior.period,period].sort()[0],prior.sources);continue;
   }
   prior.billingDate??=billingDate;
  }else documents.set(transactionId,{period,identity,billingDate,sources:[source]});
 }
 for(const entry of [...documents.values()].sort((a,b)=>a.identity.taxPointDate.localeCompare(b.identity.taxPointDate))){
  const {period,identity,billingDate,sources}=entry;
  const {sales,tax,originalTransactionId}=identity;
  const sign=originalTransactionId?-1n:1n;
  if(originalTransactionId){
   const origin=documents.get(originalTransactionId);
   const subtotal=returns.get(originalTransactionId)??{tax:0n,sales:0n};
   subtotal.tax+=cents(tax);subtotal.sales+=cents(sales);returns.set(originalTransactionId,subtotal);
   if(!origin||origin.identity.originalTransactionId||origin.identity.taxPointDate>identity.taxPointDate||
      subtotal.tax>cents(origin.identity.tax)||subtotal.sales>cents(origin.identity.sales)){
    issue('red_sale_original_or_amount_unverified',period,sources);continue;
   }
  }
  const sum=totals.get(period)??{invoicedSales:0n,uninvoicedSales:0n,invoicedOutputVat:0n,uninvoicedOutputVat:0n,sources:[]};
  const invoiced=billingDate?.slice(0,7)===period;
  sum[invoiced?'invoicedSales':'uninvoicedSales']+=sign*cents(sales);
  sum[invoiced?'invoicedOutputVat':'uninvoicedOutputVat']+=sign*cents(tax);
  sum.sources.push(...sources);totals.set(period,sum);
 }
 return totals;
}
const approvedTypes=new Set(['payment','prepayment','refund_requested','refund_approved','refund_received','red_input','transfer_out','tax_credit_increase']);
export function readActivity(facts,scope,start,book,refFor,gaps){
 const events=new Map(),replacement=new Map();
 const hash=(value)=>digest([scope.databaseInstanceId,scope.enterpriseKey,scope.accountSetId,value]).slice(0,24);
 for(const {data,source,issue} of facts.filter(r=>r.kind==='event')){
  if(issue)continue;
  const {eventId,eventType,period,operationDate,caseId,supersedes}=data;
  const problem=(code)=>gaps.push({code,period:isMonth(period)?period:start,sources:[source]});
  const value=amount(data.amount);
  if(typeof eventId!=='string'||!eventId.trim()||!approvedTypes.has(eventType)||!isMonth(period)||!operationDate||!value||cents(value)<=0n){
   problem('event_identity_date_or_amount_unverified');continue;
  }
  const eventRef=hash(eventId),isAdjustment=['red_input','transfer_out','tax_credit_increase'].includes(eventType);
  const invoiceRef=isAdjustment?refFor(data,scope):undefined;
  if(isAdjustment&&!book.get(invoiceRef)?.resolved){gaps.push({code:'event_original_invoice_unverified',invoiceRef,invoiceRow:true,sources:[source]});continue;}
  if(eventType.startsWith('refund_')&&(typeof caseId!=='string'||!caseId.trim())){problem('refund_case_unverified');continue;}
  const event={eventRef,eventType,period,operationDate,amount:value,...(caseId?{caseRef:hash(caseId)}:{}),...(invoiceRef?{invoiceRef}:{}),...(supersedes?{supersedes:hash(supersedes)}:{})};
  const existing=events.get(eventRef);
  if(existing&&!sameValue(existing.event,event)){problem('conflicting_event_receipt');continue;}
  if(existing)existing.sources.push(source);
  else events.set(eventRef,{event,sources:[source]});
 }
 for(const [id,{event,sources}] of events){
  if(!event.supersedes)continue;
  const prior=events.get(event.supersedes)?.event;
  if(!prior||prior.eventType!==event.eventType||prior.invoiceRef!==event.invoiceRef||prior.caseRef!==event.caseRef||prior.operationDate>event.operationDate||replacement.has(event.supersedes)){
   gaps.push({code:'correction_chain_unverified',period:start,sources});continue;
  }
  replacement.set(event.supersedes,id);
 }
 for(const id of replacement.keys()){
  const seen=new Set([id]);let next=replacement.get(id);
  while(next){
   if(seen.has(next)){gaps.push({code:'correction_cycle',period:start,sources:events.get(id).sources});break;}
   seen.add(next);next=replacement.get(next);
  }
 }
 const active=[...events].filter(([id])=>!replacement.has(id)).map(([,entry])=>({...entry.event,sources:entry.sources}));
 const adjustments=active.filter(e=>e.invoiceRef).sort((a,b)=>a.period.localeCompare(b.period)||a.operationDate.localeCompare(b.operationDate));
 for(const e of adjustments){
  const bill=book.get(e.invoiceRef);
  bill.adjustments??=[];
  bill.adjustments.push(e);
  const net=adjustedInput(bill,e.period);
  if(e.eventType==='tax_credit_increase'&&(!bill.fixedPeriod||bill.fixedPeriod>e.period)||bill.issueDate&&e.period<bill.issueDate.slice(0,7)||net<0n||net>cents(bill.taxAmount)){
   gaps.push({code:'adjustment_original_state_unverified',invoiceRef:e.invoiceRef,sources:e.sources});bill.resolved=false;
  }
 }
 const refunds=new Map();
 for(const e of active.filter(e=>e.eventType.startsWith('refund_')).sort((a,b)=>a.operationDate.localeCompare(b.operationDate)||a.eventType.localeCompare(b.eventType))){
  const balance=refunds.get(e.caseRef)??0n;
  if(e.eventType==='refund_approved')refunds.set(e.caseRef,balance+cents(e.amount));
  if(e.eventType==='refund_received'){
   if(cents(e.amount)>balance)gaps.push({code:'refund_receipt_without_sufficient_approval',period:start,sources:e.sources});
   refunds.set(e.caseRef,balance-cents(e.amount));
  }
 }
 return active;
}
export function adjustedInput(bill,period){
 let available=cents(bill.taxAmount);
 for(const e of bill.adjustments??[])if(e.period<=period)available+=(e.eventType==='tax_credit_increase'?1n:-1n)*cents(e.amount);
 return available;
}
export function openingHistory(opening,facts,start){
 const year=start.slice(0,4);
 if(start.endsWith('-01'))return {sales:0n,due:0n,sources:[]};
 const snapshot=opening.ytdComparable===true&&opening.ytdSalesExcludingVat!==undefined&&opening.ytdDueBeforePrepayment!==undefined;
 const rows=facts.filter(f=>f.kind==='history'&&f.data.period>=year+'-01'&&f.data.period<start);
 const sources=[];let sales=0n,due=0n,complete=true;
 for(let m=1;m<Number(start.slice(5));m++){
  const period=year+'-'+String(m).padStart(2,'0'),observed=rows.filter(f=>f.data.period===period);
  sources.push(...observed.map(r=>r.source));
  const pairs=observed.map(({data})=>[amount(data.salesExcludingVat,true),amount(data.dueBeforePrepayment)]);
  if(!pairs.length){complete=false;continue;}
  if(observed.some(r=>r.issue||r.data.ytdComparable!==true)||pairs.some(p=>p.includes(null)||!sameValue(p,pairs[0])))return {sources,reason:'history_not_comparable'};
  sales+=cents(pairs[0][0]);due+=cents(pairs[0][1]);
 }
 if(snapshot){
  const src=[...opening.sources,...sources];
  if(complete&&(cents(opening.ytdSalesExcludingVat)!==sales||cents(opening.ytdDueBeforePrepayment)!==due))return {sources:src,reason:'history_snapshot_conflict'};
  return {sales:cents(opening.ytdSalesExcludingVat),due:cents(opening.ytdDueBeforePrepayment),sources:src};
 }
 return complete?{sales,due,sources}:{sources,reason:'comparable_opening_ytd_required'};
}
function ratio(due,sales,reason){
 const percent=sales>0n&&due!==null?Number(roundRatio(due*1000000n,sales))/10000:null;
 return {salesExcludingVat:sales===null?null:money(sales),dueBeforePrepayment:due===null?null:money(due),percent,reason:percent===null?reason??(sales<0n?'negative_sales':'zero_sales'):null};
}
function assignBurdens(months,opening,field){
 let {sales,due,reason}=opening,containsForecast=false;
 for(const row of months){
  if(row.period.endsWith('-01')){sales=0n;due=0n;reason=null;containsForecast=false;}
  if(row.basis==='forecast')containsForecast=true;
  const useFiling=field==='burden'&&row.state==='filed';
  const taxValue=useFiling?row.filingReconciliation.burdenNumerator:row.dueBeforePrepayment;
  const tax=taxValue===null?null:cents(taxValue),current=row.salesExcludingVat==null?null:cents(row.salesExcludingVat);
  const monthReason=tax===null?'filed_pre_offset_tax_unverified':current===null?'sales_required':null;
  if(tax===null)reason??=monthReason;
  if(current===null)reason??='sales_required';
  due=due==null||tax===null?null:due+tax;
  sales=sales==null||current===null?null:sales+current;
  row[field]={monthly:{...ratio(tax,current,monthReason),basis:useFiling?'filing':row.basis==='forecast'?'forecast':'simulated_from_actual_inputs'},
   ytd:{...ratio(due,sales,reason),basis:containsForecast?'includes_forecast':field==='simulatedBurden'?'simulated_from_actual_inputs':'to_date'}};
 }
}
export function addBurdens(months,opening){
 assignBurdens(months,opening,'burden');
 assignBurdens(months,opening,'simulatedBurden');
}
export function readAgreement(facts,start,horizon){
 const rows=facts.filter(r=>r.kind==='agreement'&&(r.issue||!r.data.period||r.data.period<=horizon));
 const sources=rows.map(r=>r.source);
 if(!rows.length)return {status:'unspecified',sources};
 const normalized=rows.map(({data,issue})=>{
  const minimum=amount(data.minimumPercent);
  if(issue||!isMonth(data.period)||data.effectiveThrough&&!isMonth(data.effectiveThrough)||!minimum||cents(minimum)>10000n||!['monthly','ytd',undefined].includes(data.burdenMode))return null;
  return {burdenMode:data.burdenMode??null,minimumPercent:minimum,from:data.period,through:data.effectiveThrough??null};
 });
 if(normalized.some(r=>!r||r.through&&r.through<r.from))return {status:'unverified',sources};
 const versions=[...new Map(normalized.map(v=>[JSON.stringify(v),v])).values()].sort((a,b)=>a.from.localeCompare(b.from));
 for(let i=1;i<versions.length;i++)if(versions[i-1].from===versions[i].from||versions[i-1].through>=versions[i].from)return {status:'unverified',sources};
 const latest=versions.filter(v=>v.from<=start).at(-1);
 const current=latest?.through&&latest.through<start?null:latest;
 const schedule=versions.filter(v=>v===current||v.from>start);
 if(!schedule.length)return {status:'unspecified',sources};
 return {status:'active',...(current??schedule[0]),schedule,sources};
}
const cmp=(a,b)=>a<b?-1:a>b?1:0;
function cashMetrics(sim,yearEnd){
 const cashThrough=end=>sim.cashByMonth.filter(r=>r.paymentMonth<=end).reduce((n,r)=>n+cents(r.netCashOutflow),0n);
 const beyond=sim.months.filter(r=>r.period<=yearEnd&&r.paymentMonth>yearEnd);
 return {start:sim.months[0].period,yearEnd,simulationThrough:sim.horizon.through,throughYearEnd:sim.yearEnd?money(cashThrough(yearEnd)):null,
  throughLastPayment:money(cashThrough('9999-12')),yearEndCarryCredit:sim.yearEnd?.carryCredit??null,yearEndUnusedInput:sim.yearEnd?.unusedVat??null,
  yearEndSelectableUnusedInput:sim.yearEnd?.selectableUnusedVat??null,
  yearEndPrepayment:sim.yearEnd?.endingPrepayment??null,yearEndYtdBurden:sim.yearEnd?.burden??null,
  yearAccruedOutstandingAfterYearEnd:sim.yearEnd?money(beyond.reduce((sum,r)=>sum+cents(r.expectedPayment),0n)):null};
}
function compareCash(baseline,plan){
 const yearEnd=baseline.months[0].period.slice(0,4)+'-12';
 const left=cashMetrics(baseline,yearEnd),right=cashMetrics(plan,yearEnd);
 const times=[...new Set([...baseline.cashByMonth,...plan.cashByMonth].map(r=>r.paymentMonth))].sort();
 let firstDifference=null,firstRecovery=null,cumulative=0n;
 for(const date of times){
  const cash=s=>cents(s.cashByMonth.find(r=>r.paymentMonth===date)?.netCashOutflow??'0');
  const difference=cash(baseline)-cash(plan);
  if(difference!==0n&&!firstDifference)firstDifference={paymentMonth:date,planCashRetained:money(difference)};
  cumulative+=difference;
  if(firstDifference&&!firstRecovery&&cumulative===0n)firstRecovery=date;
 }
 const yearDifference=left.throughYearEnd===null?null:cents(left.throughYearEnd)-cents(right.throughYearEnd);
 const result={baseline:left,plan:right,firstDifference,firstRecovery,planYearEndCashRetained:yearDifference===null?null:money(yearDifference),
  planCashRetainedThroughLastPayment:money(cumulative),equivalentThroughLastPayment:cumulative===0n};
 if(yearDifference)return {...result,criterion:'year_end_cash',choice:yearDifference>0n?'plan':'baseline'};
 if(firstDifference)return {...result,criterion:'earliest_payment_cash',choice:cents(firstDifference.planCashRetained)>0n?'plan':'baseline'};
 for(let i=0;i<plan.months.length;i++){
  const sign=cmp(cents(baseline.months[i].selectedAndFixedInput),cents(plan.months[i].selectedAndFixedInput));
  if(sign)return {...result,criterion:'earliest_input_use',choice:sign>0?'baseline':'plan'};
 }
 return {...result,criterion:'equivalent_options',choice:'baseline'};
}
function burdenCheck(row,mode,minimum){
 const b=row.burden[mode];
 if(b.percent===null)return {state:'unknown',percent:null,reason:b.reason,shortfall:null};
 const target=(cents(b.salesExcludingVat)*minimum+9999n)/10000n;
 const shortfall=target-cents(b.dueBeforePrepayment);
 return {state:shortfall>0n?'below':'meets',percent:b.percent,shortfall:money(shortfall>0n?shortfall:0n)};
}
export function recommend(baseline,plan,agreement,cashComparison=compareCash(baseline,plan)){
 const cashChoice=cashComparison.choice;
 const base={scope:'submitted_options',choice:null,reason:null,agreement,cashChoice,cashComparison};
 const filingDifferences=[...new Set([...baseline.months,...plan.months].filter(r=>r.filingReconciliation.status==='difference').map(r=>r.period))];
 if(filingDifferences.length)return {...base,reason:'filing_reconciliation_required',periods:filingDifferences,provisional:true};
 if(agreement.status!=='active')return {...base,reason:agreement.status==='unverified'?'agreement_unverified':'cash_comparison_without_confirmed_target',choice:agreement.status==='unspecified'?cashChoice:null};
 const unknownModes=agreement.schedule.filter(rule=>!rule.burdenMode);
 if(unknownModes.length>1)return {...base,reason:'clarify_multiple_customer_burden_modes'};
 if(unknownModes.length===1){
  const byMode=Object.fromEntries(['monthly','ytd'].map(mode=>{
   const schedule=agreement.schedule.map(rule=>rule.burdenMode?rule:{...rule,burdenMode:mode});
   return [mode,recommend(baseline,plan,{...agreement,schedule},cashComparison).choice];
  }));
  if(!byMode.monthly||!byMode.ytd)return {...base,reason:'agreement_basis_incomplete',byMode};
  if(byMode.monthly!==byMode.ytd)return {...base,reason:'clarify_customer_burden_mode',byMode,paymentDifference:money(cents(baseline.months[0].expectedPayment)-cents(plan.months[0].expectedPayment))};
  return {...base,reason:'same_choice_under_both_burden_modes',choice:byMode.monthly,byMode};
 }
 const checks=[];
 const versions=agreement.schedule.toReversed();
 for(const [i,row] of baseline.months.entries()){
  const rule=versions.find(v=>v.from<=row.period);
  if(!rule||rule.through&&rule.through<row.period)continue;
  const minimum=cents(rule.minimumPercent),mode=rule.burdenMode;
  checks.push({period:row.period,basis:row.basis,burdenMode:mode,minimumPercent:rule.minimumPercent,sources:row.sources,
   baseline:burdenCheck(row,mode,minimum),plan:burdenCheck(plan.months[i],mode,minimum)});
 }
 const through=versions[0].through??baseline.horizon.through,checkedThrough=checks.at(-1)?.period??null;
 const summary={...base,checks,checkedThrough,uncoveredThrough:!checkedThrough||checkedThrough<through?through:null};
 const known=checks.filter(r=>r.baseline.state!=='unknown'&&r.plan.state!=='unknown');
 const missingBasis=checks.some(r=>[r.baseline,r.plan].some(b=>b.state==='unknown'&&!['negative_sales','zero_sales'].includes(b.reason)));
 if(!known.length||missingBasis)return {...summary,reason:'agreement_basis_incomplete'};
 const shortfalls=['baseline','plan'].map(key=>known.map(r=>cents(r[key].shortfall)));
 const largest=shortfalls.map(series=>series.reduce((max,v)=>v>max?v:max,0n));
 const meets=largest.map(v=>v===0n);
 const provisional=known.length<checks.length||summary.uncoveredThrough!==null;
 if(meets[0]!==meets[1])return {...summary,choice:meets[0]?'baseline':'plan',reason:'meets_customer_minimum',meets,provisional};
 if(meets[0])return {...summary,choice:cashChoice,reason:'cash_within_customer_minimum',meets,provisional};
 const sign=cmp(largest[0],largest[1]);
 return {...summary,choice:sign===0?cashChoice:sign<0?'baseline':'plan',reason:'customer_minimum_unattained_among_options',meets,provisional};
}
export function paymentEvidence(facts,events,scope,period,asOf){
 const reports=facts.filter(f=>f.kind==='paymentCoverage'&&f.data.period===period&&f.data.coverageScope===scope);
 const dates=reports.filter(r=>!r.issue&&r.data.coveredThrough&&cutoff(r.data.coveredThrough)<=cutoff(r.data.knownAt)).map(r=>cutoff(r.data.coveredThrough)).sort();
 const coveredThrough=dates.at(-1)??null;
 const lastDay=cutoff(period),required=scope==='cash_month'&&lastDay<asOf?lastDay:asOf;
 const receipts=events.filter(e=>e.eventType==='payment'&&(scope==='tax_period'?e.period:e.operationDate.slice(0,7))===period);
 let status='not_provided';
 if(period>asOf.slice(0,7))status='future_payment_month';
 else if(coveredThrough&&coveredThrough>=required)status='complete_as_of';
 else if(receipts.length)status='documented_receipts_only';
 else if(reports.length)status='coverage_incomplete';
 return {scope,period,asOf,coveredThrough,status,sources:[...reports.map(f=>f.source),...receipts.flatMap(e=>e.sources)]};
}
export function cashLedger(rows,events,start,through,payments,asOf){
 const ledger=new Map();
 const get=period=>{
  if(!ledger.has(period))ledger.set(period,{paymentMonth:period,actualPaid:0n,prepaid:0n,refundReceived:0n,expectedOutstanding:0n,scheduled:false,conditionalPayment:false,sources:[]});
  return ledger.get(period);
 };
 const fields={payment:'actualPaid',prepayment:'prepaid',refund_received:'refundReceived'};
 for(const event of events){
  const month=event.operationDate.slice(0,7);
  if(!fields[event.eventType]||month<start)continue;
  if(month>through&& !rows.some(r=>r.period===event.period))continue;
  const entry=get(month);entry[fields[event.eventType]]+=cents(event.amount);entry.sources.push(...event.sources);
 }
 for(const row of rows){
  const entry=get(row.paymentMonth);entry.scheduled=true;entry.expectedOutstanding+=cents(row.expectedPayment);entry.sources.push(...row.sources);
  if(row.expectedPaymentBasis==='assuming_no_additional_payments')entry.conditionalPayment=true;
 }
 return [...ledger.values()].sort((a,b)=>a.paymentMonth.localeCompare(b.paymentMonth)).map(r=>({
  paymentMonth:r.paymentMonth,actualPaid:money(r.actualPaid),actualPaidEvidence:paymentEvidence(payments,events,'cash_month',r.paymentMonth,asOf),
  expectedPaymentBasis:!r.scheduled?'no_scheduled_payment':r.conditionalPayment?'assuming_no_additional_payments':'verified_payments_at_cutoff',
  prepaid:money(r.prepaid),refundReceived:money(r.refundReceived),expectedOutstanding:money(r.expectedOutstanding),
  netCashOutflow:money(r.actualPaid+r.prepaid+r.expectedOutstanding-r.refundReceived),sources:r.sources,
 }));
}
