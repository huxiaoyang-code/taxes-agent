import {resolveDirectFinanceTarget} from './direct-finance-target.mjs';
import {currentFinanceCall,financeAuditDirectory} from './finance-call-chain.mjs';
import {digest} from './finance-prebook-evidence.mjs';
import {calculateFinanceSummary,summaryRules,FINANCE_SUMMARY_RULE_VERSION} from './finance-summary-engine.mjs';
import {money,cents} from './agency-tax-rules.mjs';
import {currentReceipts} from './vat-receipt-chain.mjs';
import {readVatFacts,fail,isMonth,cutoff} from './vat-planning-evidence.mjs';
import {VAT_NUMERIC_FIELDS} from './vat-planning-contracts.mjs';
import {amount,VAT_SALES_FIELDS,salesByPeriod,readActivity,adjustedInput,openingHistory,addBurdens,readAgreement,recommend,cashLedger,paymentEvidence} from './vat-planning-ledgers.mjs';

export const VAT_PLAN_ALL_INVOICES=Symbol('vat_plan_all_invoices');

const monthOffset=(period,n)=>{
 const [y,m]=period.split('-').map(Number);
 return new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,7);
};
function refFor(row,scope){
 if(![row.invoiceNumber,row.issuer].every(v=>typeof v==='string'&&v.trim()===v&&v.length>0))return null;
 return 'vat-'+digest([scope.databaseInstanceId,scope.enterpriseKey,scope.accountSetId,row.issuer,row.invoiceNumber]).slice(0,24);
}
const latest=(...periods)=>periods.filter(Boolean).sort().at(-1);
function observationRange(time){
 const day=cutoff(time),clock=time.slice(11).replace(/[:.]/g,'');
 return {from:day+clock.padEnd(9,'0'),through:day+clock.padEnd(9,'9')};
}
function latestPortalObservations(reports){
 // 月度资料到月末可知。仅记录到日或分钟时，保留所有可能为最后一条的观察。
 const intervals=reports.map(row=>({row,...observationRange(row.data.knownAt)}));
 const lastStart=latest(...intervals.map(range=>range.from));
 return intervals.filter(range=>range.through>=lastStart).map(range=>range.row);
}
function portalCoversReceipt(observed,receipt){
 // 双方均记录时刻时，较粗的精度不能证明同一分钟内的先后。仅到日或月的原件沿用日期口径。
 if(observed.length<=10||receipt.length<=10)return cutoff(observed)>=cutoff(receipt);
 return observed===receipt||observationRange(observed).from>=observationRange(receipt).through;
}
function coalesce(rows,key,gaps){
 const result={sources:[]};
 for(const row of rows){
  result.sources.push(row.source);
  for(const [name,raw] of Object.entries(row.data)){
   if(['knownAt','issuer','invoiceNumber'].includes(name))continue;
   const value=VAT_NUMERIC_FIELDS.has(name)?amount(raw,VAT_SALES_FIELDS.has(name)):raw;
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
function calendar(rows,filings,periods,asOf,sales,gaps){
 const byPeriod=groups(rows,r=>r.data.period),months=new Map();
 for(const period of periods){
  const records=byPeriod.get(period)??[],actual=records.filter(r=>r.data.basis==='actual');
  const selected=actual.length?actual:records;
  const month=coalesce(selected,{period},gaps);
  const detail=sales.get(period);
  if(month.salesCoverage!==undefined||detail){
   const components=['invoicedSales','uninvoicedSales','invoicedOutputVat','uninvoicedOutputVat'];
   if(month.salesCoverage!=='complete_transactions'||month.basis!=='actual'||[...components,'salesExcludingVat','outputVat'].some(k=>month[k]!==undefined)){
    gaps.push({code:'transaction_coverage_or_overlapping_month_total',period,sources:[...month.sources,...(detail?.sources??[])]});
   }else{
    for(const key of components)month[key]=money(detail?.[key]??0n);
    month.sources.push(...(detail?.sources??[]));
   }
  }
  const filed=filings.filter(f=>f.data.period===period);
  if(filed.length){
   const summary=coalesce(currentReceipts(filed,{period},gaps),{period},gaps);
   month.state='filed';month.declaredDue=summary.declaredDue;month.declaredDueBeforePrepayment=summary.declaredDueBeforePrepayment;
   month.sources.push(...filed.map(f=>f.source));
  }
  for(const [total,invoiced,uninvoiced] of [['outputVat','invoicedOutputVat','uninvoicedOutputVat'],['salesExcludingVat','invoicedSales','uninvoicedSales']]){
   if(month[invoiced]===undefined&&month[uninvoiced]===undefined)continue;
   if(month[total]!==undefined||month[invoiced]===undefined||month[uninvoiced]===undefined){
    gaps.push({code:'vat_month_total_or_disjoint_components_required',field:total,period,sources:month.sources});
   }else month[total]=money(cents(month[invoiced])+cents(month[uninvoiced]));
  }
  if(month.otherInputVatTransferOut!==undefined){
   if(month.inputVatTransferOut!==undefined)gaps.push({code:'duplicate_transfer_out_bases',period,sources:month.sources});
   month.inputVatTransferOut=month.otherInputVatTransferOut;
  }
  if(month.paymentDate&&month.paymentDate.slice(0,7)<period)gaps.push({code:'payment_schedule_before_tax_period',period,sources:month.sources});
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
 const observations=facts.filter(f=>['invoice','confirmation','portal'].includes(f.kind));
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
  const confirmationHistory=rows.filter(r=>r.kind==='confirmation');
  const activeRows=currentReceipts(confirmationHistory,{invoiceRef},gaps);
  const confirmedRows=activeRows.filter(r=>r.data.confirmationState!=='revoked');
  if(confirmedRows.length&&confirmedRows.length!==activeRows.length)gaps.push({code:'confirmation_or_window_unresolved',invoiceRef,sources:activeRows.map(r=>r.source)});
  const fixed=coalesce(confirmedRows,{invoiceRef},gaps);
  const confirmed=confirmedRows.length>0;
  if(confirmed&&fixed.taxAmount!==undefined&&bill.taxAmount!==undefined&&fixed.taxAmount!==bill.taxAmount)gaps.push({code:'source_conflict',field:'taxAmount',invoiceRef,sources:fixed.sources});
  if(bill.issueDate&&fixed.issueDate){
   const precision=isMonth(bill.issueDate)||isMonth(fixed.issueDate)?7:10;
   if(bill.issueDate.slice(0,precision)!==fixed.issueDate.slice(0,precision)){
    gaps.push({code:'source_conflict',field:'issueDate',invoiceRef,sources:[...bill.sources,...fixed.sources]});
   }
  }
  const taxAmount=bill.taxAmount??fixed.taxAmount,eligibility=bill.eligibility??(confirmed?'eligible':undefined);
  const reportedTaxAmounts=[...new Set([...rows.filter(r=>r.kind==='invoice'),...confirmedRows].map(r=>amount(r.data.taxAmount)).filter(v=>v!==null))].sort();
  const receiptPeriod=bill.receipt?.slice(0,7),issued=(bill.issueDate??fixed.issueDate)?.slice(0,7);
  if(taxAmount===undefined||!['eligible','ineligible'].includes(eligibility)||(!confirmed&&!isMonth(receiptPeriod))||
   (bill.eligibleFrom!==undefined&&!isMonth(bill.eligibleFrom))||(bill.eligibleThrough!==undefined&&!isMonth(bill.eligibleThrough)))gaps.push({code:'invoice_missing_or_unsupported',invoiceRef,sources:bill.sources});
  const regularFrom=latest(receiptPeriod,issued,bill.eligibleFrom);
  const portal={},early=[];
  const windows=groups(rows.filter(r=>r.kind==='portal'),r=>r.data.period);
  for(const [period,reports] of windows){
   const current=latestPortalObservations(reports);
   const states=new Set(current.map(r=>r.data.portalStatus));
   if(!isMonth(period)||states.size!==1||!['selectable','closed'].includes([...states][0])){
    gaps.push({code:'portal_window_unverified',invoiceRef,sources:current.map(r=>r.source)});continue;
   }
   portal[period]=[...states][0];
   if(portal[period]==='selectable'&&bill.receipt&&issued&&issued<=period&&current.some(r=>portalCoversReceipt(r.data.knownAt,bill.receipt))&&
      (!bill.eligibleFrom||bill.eligibleFrom<=period)&&(!bill.eligibleThrough||bill.eligibleThrough>=period))early.push(period);
  }
  const firstPeriod=[regularFrom,...early].filter(Boolean).sort()[0];
  // 实际操作可在次月；明确的开票/适用窗口却不能晚于其税款所属期。
  const fixedOutside=confirmed&&((issued&&fixed.taxPeriod<issued)||(bill.eligibleFrom&&fixed.taxPeriod<bill.eligibleFrom)||(bill.eligibleThrough&&fixed.taxPeriod>bill.eligibleThrough)||confirmedRows.some(r=>fixed.taxPeriod>(r.data.operationDate??r.data.knownAt).slice(0,7)));
  if(confirmed&&(!isMonth(fixed.taxPeriod)||eligibility!=='eligible'||fixedOutside)||bill.eligibleThrough&&bill.eligibleThrough<firstPeriod)gaps.push({code:'confirmation_or_window_unresolved',invoiceRef,sources:[...bill.sources,...fixed.sources]});
  invoices.set(invoiceRef,{invoiceRef,taxAmount,eligibility:['eligible','ineligible','red'].includes(eligibility)?eligibility:'unknown',receipt:bill.receipt,issueDate:bill.issueDate??fixed.issueDate,
   resolved:gaps.length===initialGaps,reportedTaxAmounts,
   firstPeriod,regularFrom,portal,earlyPeriods:early.sort(),lastPeriod:bill.eligibleThrough??null,fixedPeriod:fixed.taxPeriod??null,operationDate:fixed.operationDate??null,
   confirmationState:confirmed?'confirmed':activeRows.length?'revoked':null,
   sources:[...bill.sources,...confirmationHistory.map(r=>r.source),...rows.filter(r=>r.kind==='portal').map(r=>r.source)]});
 }
 return invoices;
}
function selectable(bill,period,month){
 return month?.state==='open'&&!bill.fixedPeriod&&bill.eligibility==='eligible'&&bill.firstPeriod<=period&&(!bill.lastPeriod||period<=bill.lastPeriod)&&
  bill.portal[period]!=='closed'&&(period>=bill.regularFrom||bill.earlyPeriods.includes(period))&&adjustedInput(bill,period)>0n;
}
function selections(entries,book,months){
 const choices=new Map();
 for(const {invoiceRef,period} of entries){
  const bill=book.get(invoiceRef);
  if(!bill||choices.has(invoiceRef))fail('finance_vat_selection_unknown_or_duplicate');
  if(bill.fixedPeriod||months.get(period)?.state==='filed')fail('finance_vat_selection_already_fixed');
  if(!selectable(bill,period,months.get(period)))fail('finance_vat_selection_period_unavailable');
  choices.set(invoiceRef,period);
 }
 return choices;
}
function remaining(book,choices,period,month){
 let count=0,total=0n,expired=0n,unknownCount=0,unknown=0n,selectableUnusedCount=0,selectableUnused=0n;
 for(const bill of book.values()){
  const used=bill.fixedPeriod??choices.get(bill.invoiceRef);
  if((!used||used>period)&&selectable(bill,period,month)){
   selectableUnusedCount++;selectableUnused+=adjustedInput(bill,period);
  }
  const arrived=latest(bill.receipt?.slice(0,7),bill.issueDate?.slice(0,7));
  if(bill.eligibility!=='eligible'||arrived>period||used&&used<=period)continue;
  if(!bill.receipt&&!(bill.operationDate&&bill.operationDate.slice(0,7)<=period)){
   unknownCount++;unknown+=cents(bill.taxAmount);continue;
  }
  const available=adjustedInput(bill,period);
  if(available===0n)continue;
  if(bill.lastPeriod&&bill.lastPeriod<=period){expired+=available;continue;}
  count++;total+=available;
 }
 return {unusedCount:count,unusedVat:money(total),selectableUnusedCount,selectableUnusedVat:money(selectableUnused),
  expiredUnusedVat:money(expired),holdingUnknownCount:unknownCount,holdingUnknownVat:money(unknown)};
}
function reconcileFiling(month,due,before,zeroPrepaymentVerified){
 const declared=month.declaredDue,declaredBefore=month.declaredDueBeforePrepayment;
 const balanceDifference=declared===undefined?null:money(cents(declared)-cents(due));
 const beforeDifference=declaredBefore===undefined?null:money(cents(declaredBefore)-cents(before));
 const inconsistent=declared!==undefined&&declaredBefore!==undefined&&
  (cents(declaredBefore)<cents(declared)||zeroPrepaymentVerified&&declaredBefore!==declared);
 const mismatch=inconsistent||[balanceDifference,beforeDifference].some(n=>n!==null&&cents(n)!==0n);
 const verifiedZero=zeroPrepaymentVerified&&declared!==undefined;
 const burdenNumerator=inconsistent?null:declaredBefore??(verifiedZero?declared:null);
 const numeratorBasis=burdenNumerator===null?'unverified':declaredBefore!==undefined?'declared_before_prepayment':'declared_balance_with_verified_zero_prepayment';
 return {status:month.state!=='filed'?'unfiled':mismatch?'difference':declared===undefined&&declaredBefore===undefined?'declared_amount_missing':'matched',
  balanceDifference,beforeDifference,burdenNumerator,numeratorBasis,
  balanceStatus:balanceDifference===null?'missing':cents(balanceDifference)===0n?'matched':'difference',
  beforeStatus:beforeDifference===null?'missing':cents(beforeDifference)===0n?'matched':'difference'};
}
function simulate(months,book,choices,opening,history,activity,yearEnd,payments,asOf){
 let carry=opening.carryCredit,prepayment=cents(opening.prepaymentBalance??'0'),yearDue=0n,yearPaid=0n,totalDue=0n,atYearEnd=null,firstCarryUse=null;
 let zeroPrepaymentVerified=opening.prepaymentBalance==='0.00';
 const rows=[];
 for(const [period,month] of months){
  let input=0n,adjustedTransfer=0n;
  const events=activity.filter(e=>e.period===period);
  const sum=type=>events.filter(e=>e.eventType===type).reduce((n,e)=>n+cents(e.amount),0n);
  for(const bill of book.values()){
   const used=bill.fixedPeriod??choices.get(bill.invoiceRef);
   if(used===period)input+=adjustedInput(bill,period);
   if(used&&used<period)for(const e of bill.adjustments??[]){
    if(e.period!==period)continue;
    if(e.eventType==='tax_credit_increase')input+=cents(e.amount);
    else adjustedTransfer+=cents(e.amount);
   }
  }
  if(events.some(e=>['transfer_out','red_input'].includes(e.eventType))&&month.otherInputVatTransferOut===undefined&&cents(month.inputVatTransferOut)>0n)return {gap:{code:'duplicate_transfer_out_bases',period}};
  const prepaidReceipt=sum('prepayment'),legacyPrepaid=cents(month.prepaidVat),refund=sum('refund_approved');
  if(prepaidReceipt>0n&&(legacyPrepaid>0n||opening.prepaymentBalance===undefined))return {gap:{code:'prepayment_opening_or_disjoint_receipts_required',period}};
  if(opening.prepaymentBalance!==undefined&&legacyPrepaid>0n)return {gap:{code:'use_prepayment_receipts_with_opening_balance',period}};
  const availablePrepayment=prepayment+prepaidReceipt+legacyPrepaid;
  const transfer=cents(month.inputVatTransferOut)+adjustedTransfer+refund;
  if(cents(month.outputVat)<0n)return {gap:{code:'negative_output_vat_special_handling',period}};
  if(cents(carry)+input<refund)return {gap:{code:'refund_exceeds_supported_credit',period}};
  const result=calculateFinanceSummary('vat_general',{outputVat:month.outputVat,certifiedInputVat:money(input),openingCarryCredit:carry,
   prepaidVat:money(availablePrepayment),inputVatTransferOut:money(transfer),tracedTransferOut:adjustedTransfer>0n&&transfer-adjustedTransfer<=cents(carry)+input,ordinaryDomesticScopeConfirmed:true},{period});
  if(result.status!=='conditional_calculated'||opening.prepaymentBalance===undefined&&cents(result.amounts.unusedPrepayment)!==0n)return {gap:{code:result.unsupportedReason??'unused_prepayment_requires_separate_carry',period}};
  const {due,dueBeforePrepayment,carryCredit,prepaymentUsed,unusedPrepayment}=result.amounts,paymentMonth=month.paymentDate?.slice(0,7)??monthOffset(period,1);
  const paid=sum('payment'),obligation=cents(month.declaredDue??due);
  const outstanding=obligation>paid?obligation-paid:0n;
  const actualPaidEvidence=paymentEvidence(payments,events,'tax_period',period,asOf);
  zeroPrepaymentVerified=zeroPrepaymentVerified&&availablePrepayment===0n&&!month.sources.some(source=>source.assumptions.includes('prepaidVat'));
  const filingReconciliation=reconcileFiling(month,due,dueBeforePrepayment,zeroPrepaymentVerified);
  rows.push({period,basis:month.basis,state:month.state,outputVat:month.outputVat,openingCarryCredit:carry,selectedAndFixedInput:money(input),
   salesExcludingVat:month.salesExcludingVat??null,invoicedOutputVat:month.invoicedOutputVat,uninvoicedOutputVat:month.uninvoicedOutputVat,
   inputVatTransferOut:money(transfer),refundApproved:money(refund),refundRequested:money(sum('refund_requested')),openingPrepayment:money(prepayment),
   prepaidVat:money(legacyPrepaid+prepaidReceipt),prepaymentUsed,endingPrepayment:unusedPrepayment,dueBeforePrepayment,due,declaredDue:month.declaredDue??null,
   declaredDifference:filingReconciliation.balanceDifference,declaredDueBeforePrepayment:month.declaredDueBeforePrepayment??null,filingReconciliation,
   actualPaidEvidence,expectedPaymentBasis:actualPaidEvidence.status==='complete_as_of'?'verified_payments_at_cutoff':'assuming_no_additional_payments',
   actualPaid:money(paid),excessPaidPendingReview:money(paid>obligation?paid-obligation:0n),paymentMonth,expectedPayment:money(outstanding),
   endingCarryCredit:carryCredit,sources:[...month.sources,...events.flatMap(e=>e.sources)]});
  prepayment=cents(unusedPrepayment);
  if(period>yearEnd&&atYearEnd&&cents(atYearEnd.carryCredit)>0n&&!firstCarryUse&&cents(carryCredit)<cents(atYearEnd.carryCredit))firstCarryUse=period;
  carry=carryCredit;totalDue+=cents(due);
  if(period<=yearEnd)yearDue+=cents(due);
  if(paymentMonth<=yearEnd)yearPaid+=outstanding;
  for(const e of events)if(['payment','prepayment'].includes(e.eventType)&&e.operationDate.slice(0,7)<=yearEnd)yearPaid+=cents(e.amount);
  if(period===yearEnd)atYearEnd={period,dueFromStart:money(yearDue),paymentsFromSimulatedPeriods:money(yearPaid),carryCredit:carry,...remaining(book,choices,period,month)};
 }
 const through=rows.at(-1).period;
 addBurdens(rows,history);
 if(atYearEnd){
  const december=rows.find(row=>row.period===yearEnd);
  atYearEnd.burden=december.burden.ytd;atYearEnd.endingPrepayment=december.endingPrepayment;
 }
 return {months:rows,cashByMonth:cashLedger(rows,activity,rows[0].period,through,payments,asOf),yearEnd:atYearEnd,horizon:{through,dueFromStart:money(totalDue),carryCredit:carry,endingPrepayment:money(prepayment),...remaining(book,choices,through,months.get(through))},
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
 for(const f of facts.filter(f=>f.issue&&!['invoice','confirmation','portal','history','agreement','paymentCoverage'].includes(f.kind)))gaps.push({code:f.issue,period:isMonth(f.data.period)?f.data.period:start,sources:[f.source]});
 const periods=[];
 for(let p=start;p<=args.through;p=monthOffset(p,1))periods.push(p);
 const openingGaps=[];
 const opening=coalesce(facts.filter(f=>f.kind==='opening'&&f.data.period===monthOffset(start,-1)),{period:monthOffset(start,-1)},openingGaps);
 const historyConflicts=openingGaps.filter(g=>g.field?.startsWith('ytd'));
 gaps.push(...openingGaps.filter(g=>!g.field?.startsWith('ytd')));
 if(opening.carryCredit===undefined||opening.scope!=='monthly_general_domestic')gaps.push({code:'opening_balance_or_scope_unverified',period:monthOffset(start,-1),sources:opening.sources});
 if(opening.inventoryCoverage!=='complete')gaps.push({code:'invoice_inventory_incomplete',invoiceRow:true,sources:opening.sources});
 const sales=salesByPeriod(facts,start,gaps);
 const months=calendar(facts.filter(f=>f.kind==='month'),facts.filter(f=>f.kind==='filing'),periods,args.asOf,sales,gaps),book=inventory(facts,binding.scope,gaps);
 const history=historyConflicts.length?{reason:'conflicting_ytd_opening',sources:opening.sources}:openingHistory(opening,facts,start);
 const agreement=readAgreement(facts,start,args.through),activity=readActivity(facts,binding.scope,start,book,refFor,gaps);
 const basis=digest({scope:binding.scope,asOf:args.asOf,through:args.through,facts});
 if(args.expectedBasis&&args.expectedBasis!==basis)fail('finance_vat_basis_changed');
 const offset=args.offset??0,limit=args.limit??50;
 const common={version:'finance-vat-planning/1',basis,asOf:args.asOf,start,through:args.through,ruleVersion:FINANCE_SUMMARY_RULE_VERSION,
  activity,agreement,history:{reason:history.reason??null,sources:history.sources},decisions:{baseline:args.baseline??[],plan:args.plan??[]},
  earliestEligibleOption:{plan:{strategy:'earliest_eligible'}},
  rules:summaryRules('vat_general'),openingSources:opening.sources,callRef:currentFinanceCall()?.callId,localEvidence:'vat-planning-evidence.json',
  invoices:[...book.values()].slice(offset,offset+limit),pagination:{total:book.size,offset,next:offset+limit<book.size?offset+limit:null},
  conditions:['月度境内一般计税，逐票用途、未用票覆盖、身份与预测取决于来源。','应纳在抵预缴前；应补和实缴分别按测算、申报及付款回执取数。未给付款安排时按次月估计。客户约定仅用于方案比较。','期末留抵及未用票不计作现金。跨期累计含标明的预测期，企业现金另需其他收支与期初余额。'],
  posted:false,submittable:false};
 const finish=result=>Object.defineProperty(result,VAT_PLAN_ALL_INVOICES,{value:[...book.values()]});
 const firstGap=gaps.filter(g=>!g.invoiceRef&&!g.invoiceRow).map(g=>g.period).sort()[0];
 const comparable=new Map([...months].filter(([period])=>!firstGap||period<firstGap));
 if(!comparable.size)return finish({...common,status:'needs_inputs',gaps});
 const resolved=new Map([...book].filter(([,bill])=>bill.resolved));
 const payments=facts.filter(f=>f.kind==='paymentCoverage');
 const earliest=args.plan?.strategy==='earliest_eligible';
 function compare(periods){
  const earlyChoices=new Map();
  for(const bill of resolved.values()){
   const first=[...periods].find(([period,month])=>selectable(bill,period,month));
   bill.earliestSelectablePeriod=first?.[0]??null;
   if(first)earlyChoices.set(bill.invoiceRef,first[0]);
  }
  const choices=[selections(args.baseline??[],resolved,months),earliest?earlyChoices:selections(args.plan??[],resolved,months)];
  return choices.map(choice=>simulate(periods,resolved,choice,opening,history,activity,yearEnd,payments,args.asOf));
 }
 let [baseline,plan]=compare(comparable);
 if(baseline.gap||plan.gap){
  const problems=[baseline.gap,plan.gap].filter(Boolean);
  const stop=problems.map(g=>g.period).sort()[0];
  gaps.push(...problems);
  const prefix=new Map([...comparable].filter(([period])=>period<stop));
  if(!prefix.size)return finish({...common,status:'unsupported',gaps});
  [baseline,plan]=compare(prefix);
 }
 const yearly=(field,reverse=false)=>!baseline.yearEnd?null:reverse?difference(baseline.yearEnd[field],plan.yearEnd[field]):difference(plan.yearEnd[field],baseline.yearEnd[field]);
 const cashByMonth=[...new Set([...baseline.cashByMonth,...plan.cashByMonth].map(r=>r.paymentMonth))].sort().map(paymentMonth=>({
  paymentMonth,afterVatCash:difference(baseline.cashByMonth.find(r=>r.paymentMonth===paymentMonth)?.netCashOutflow??'0',plan.cashByMonth.find(r=>r.paymentMonth===paymentMonth)?.netCashOutflow??'0')}));
 const yearVat=sim=>sim.months.filter(r=>r.period<=yearEnd).reduce((sum,r)=>sum+cents(r.dueBeforePrepayment),0n);
 const delta={yearEndAfterVatCash:baseline.yearEnd?money(cashByMonth.filter(r=>r.paymentMonth<=yearEnd).reduce((sum,r)=>sum+cents(r.afterVatCash),0n)):null,
  yearAttributedVat:baseline.yearEnd?money(yearVat(plan)-yearVat(baseline)):null,yearEndCarryCredit:yearly('carryCredit'),
  yearEndUnusedVat:yearly('unusedVat'),yearEndSelectableUnusedVat:yearly('selectableUnusedVat'),horizonDue:difference(plan.horizon.dueFromStart,baseline.horizon.dueFromStart),
  byPaymentMonth:cashByMonth};
 const recommendation=Object.hasOwn(args,'baseline')||Object.hasOwn(args,'plan')?recommend(baseline,plan,agreement):{choice:null,reason:'awaiting_agent_options',agreement};
 if(gaps.length){
  const excluded=[...book.values()].filter(b=>!b.resolved);
  const subsetRecommendation={...recommendation,scope:'submitted_options_on_known_invoices_only',provisional:true,
   knownInvoices:resolved.size,excludedInvoiceCount:excluded.length,excludedInvoices:excluded.slice(offset,offset+limit).map(b=>({
    invoiceRef:b.invoiceRef,reportedTaxAmounts:b.reportedTaxAmounts,amountStatus:b.reportedTaxAmounts.length>1?'conflicting_reports':b.reportedTaxAmounts.length?'unverified':'missing'})),
   unidentifiedSourceRows:facts.filter(f=>['invoice','portal','confirmation'].includes(f.kind)&&(!refFor(f.data,binding.scope)||f.issue)).length,
   comparedThrough:plan.horizon.through,requestedThrough:args.through,
   limitations:['仅比较已提交的两组选择和已核明细。待核进项可能改变应纳、累计门槛、留抵与现金差额。',
    '所列待核票金额为原件各自报告的票面额。抵扣资格、可用额与总影响仍待核。缺失期间之后的累计及付款另行重算。']};
  return finish({...common,status:'partial_known_invoices',gaps,knownSubset:{baseline,plan,delta,recommendation:subsetRecommendation,
   condition:'仅反映已核票据和连续可测期间。待核票被排除，后续缺口前截断，完整应纳、留抵及实际差额仍待核实。'}});
 }
 return finish({...common,status:'conditional_calculated',baseline,plan,delta,recommendation});
}
