// 固定汇总算术；不读取账库、不构建凭证、不推断实际支付或法定资格。
import {cents,money,roundRatio,rateAmount,quantity,calculateAgencyOutputVat} from './agency-tax-rules.mjs';
import {TAX_SOURCES} from './agency-rule-catalog.mjs';
export const FINANCE_SUMMARY_RULE_VERSION='finance-tax-summary/1';
const extraSources={
 urban:{url:'https://fgk.chinatax.gov.cn/zcfgk/c100009/c5193055/content.html',title:'中华人民共和国城市维护建设税法',locator:'第2至4条：国内两税计税基础及7%/5%/1%',from:'2021-09-01'},
 education:{url:'https://www.moe.gov.cn/jyb_xwfb/s271/201108/t20110811_123123.html',title:'财政部教育投入政策解读',locator:'教育费附加3%，地方教育附加2%',from:'2011-01-01'},
 fujianLocalEducation:{url:'https://zfgb.fujian.gov.cn/4166',title:'福建省人民政府闽政文〔2011〕230号',locator:'第二、六条：福建地方教育附加普通2%，不沿用营业税',from:'2011-01-01'},
 citPrepayment:{url:'https://fgk.chinatax.gov.cn/zcfgk/c100024/c5236888/content.html',title:'国家税务总局公告2023年第6号相关征管说明',locator:'预缴截至本期所属期末累计判断从业人数、资产及所得',from:'2023-01-01'},
 salaryException:{url:'https://www.chinatax.gov.cn/chinatax/n810214/n810641/n2985871/n2985888/n2985983/c5154972/content.html',title:'国家税务总局公告2020年第13号',locator:'首次取得工资薪金的减除费用例外；本工具普通分支不套用',from:'2020-07-01'},
};
const sourceKeys={vat_general:['vat'],vat_small:['vat','vatRelief','vatElection'],surcharges:['urban','education','educationRelief','localEducation','fujianLocalEducation','smallRelief','prepaymentSurcharge'],cit_prepayment:['corporate','corporateRules','smallRelief','citPrepayment'],salary_pit_cumulative:['income','withholding','salaryException'],stamp_sale:['stamp','smallRelief','sixTaxProcedure']};
export const summaryRules=kind=>(sourceKeys[kind]??[]).map(sourceId=>({sourceId,...(extraSources[sourceId]??TAX_SOURCES[sourceId]),supportedFrom:'2026-01-01',supportedThrough:'2027-12-31'}));
const max0=n=>n>0n?n:0n;
const min=(a,b)=>a<b?a:b;
const own=(o,k)=>Object.hasOwn(o,k);
const scalar=v=>typeof v==='number'?String(v):v;
function amount(v,{negative=false}={}){
 const rows=Array.isArray(v)?v:[v];let total=0n;
 for(const value of rows){const text=scalar(value);if(typeof text!=='string'||! /^-?\d+(\.\d{1,2})?$/.test(text)||typeof value==='number'&&!Number.isFinite(value))throw Object.assign(Error('finance_summary_amount_invalid'),{code:'finance_summary_amount_invalid'});const n=cents(text);if(!negative&&n<0n)throw Object.assign(Error('finance_summary_amount_invalid'),{code:'finance_summary_amount_invalid'});total+=n;}
 return total;
}
const decimalUnits=v=>quantity(scalar(v));
const salaryTable=Object.freeze([[3600000n,300,0n],[14400000n,1000,252000n],[30000000n,2000,1692000n],[42000000n,2500,3192000n],[66000000n,3000,5292000n],[96000000n,3500,8592000n],[null,4500,18192000n]]);
export function calculateFinanceSummary(kind,inputs,scope){
 const out={version:'finance-tax-summary-native/1',kind,scope,period:scope.period,method:'source_bound_summary_arithmetic',status:'conditional_calculated',amounts:{},steps:[],scenarios:[],conditions:[],needsInputs:[],rules:summaryRules(kind),ruleVersion:FINANCE_SUMMARY_RULE_VERSION,review:{accountantApproval:'pending',booksVerified:false,deductionVerified:false,qualificationVerified:false,submittable:false,posted:false,authorizesExecution:false},limitations:['汇总条件计算，不证明账目完整、抵扣合法、资格有效或税款已付。','支持2026—2027普通分支；正式底稿仍按原始事实独立校验。']};
 const condition=(code,meaning)=>{if(!out.conditions.some(c=>c.code===code))out.conditions.push({code,state:'unverified',meaning});};
 const need=keys=>{for(const k of keys)if(!own(inputs,k))out.needsInputs.push({field:k,reason:'source_bound_input_required'});return !out.needsInputs.length;};
 const step=(id,formula,values,result,target=out.steps)=>target.push({id,formula,operands:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,typeof v==='bigint'?money(v):v])),result:typeof result==='bigint'?money(result):result});
 const unsupported=code=>{out.status='unsupported';out.unsupportedReason=code;return out;};
 const read=(k,options)=>{const n=amount(inputs[k],options);if(Array.isArray(inputs[k]))step(`${k}_sum`,'sum(source_items)',{count:inputs[k].length},n);return n;};
 const optional=(k)=>{if(own(inputs,k))return read(k);condition(`${k}_zero_assumption`,`${k}未提供；所示结果以其为零为条件，非已核零值。`);return 0n;};
 const set=(o,values)=>{for(const [k,v]of Object.entries(values))o[k]=typeof v==='bigint'?money(v):v;};
 const quarter=Number(scope.period.slice(5))/3;
 const periodSupported=()=>inputs.periodType!=='quarterly'||Number.isInteger(quarter);
 const scopeCondition=()=>{if(inputs.ordinaryDomesticScopeConfirmed!==true)condition('ordinary_domestic_scope_unverified','仅在全部项目属于本分支普通境内交易、汇总期间和业务范围完整时成立。');return inputs.ordinaryDomesticScopeConfirmed!==false;};
 const reliefStates=()=>{
  if(inputs.sixTaxRelief==='ineligible')return [false];
  const from=inputs.periodType==='quarterly'?`${scope.period.slice(0,4)}-${String(Math.floor((Number(scope.period.slice(5))-1)/3)*3+1).padStart(2,'0')}-01`:`${scope.period}-01`,through=`${scope.period}-${new Date(Date.UTC(Number(scope.period.slice(0,4)),Number(scope.period.slice(5)),0)).getUTCDate()}`;
  if(inputs.reliefValidFrom||inputs.reliefValidThrough){
   if(inputs.reliefValidFrom&&inputs.reliefValidThrough&&inputs.reliefValidFrom>inputs.reliefValidThrough){out.status='unsupported';out.unsupportedReason='qualification_window_invalid';return [];}
   if(inputs.reliefValidFrom>through||inputs.reliefValidThrough<from){condition('six_tax_window_outside_period','已给资格适用窗口与本所属期完全不重叠，本次不适用该窗口减半；不据此伪造其他资格依据。');return [false];}
   if(inputs.reliefValidFrom>from||inputs.reliefValidThrough<through){out.status='unsupported';out.unsupportedReason='relief_window_requires_period_split';out.needsInputs.push({field:'periodSplitBases',reason:'qualification_window_does_not_cover_whole_period'});condition('six_tax_window_incomplete','已给资格窗口只覆盖部分所属期，不能将局部资格用于整期；需有来源的分期基数和各期资格分别核算。');return [];}
   if(inputs.sixTaxRelief==='eligible'&&inputs.reliefValidFrom&&inputs.reliefValidThrough){condition('six_tax_qualification_claim_unreviewed','按有来源资格声明及完整所属期窗口列减半条件，未代替官方年报/申报及更正窗口审定。');return [true];}
  }
  if(['small','individual_business'].includes(inputs.taxpayerCategory))return [true];
  condition('six_tax_qualification_unverified','六税两费资格或本期适用窗口未核；并列不减半/减半条件，不选择优惠。');return [false,true];
 };
 condition('source_summary_semantics_unreviewed','精确原件值绑定不证明字段映射、累计覆盖及资料真实性；以下均待人工核对。');
 if(kind==='vat_general'){
  if(own(inputs,'outputVat')&&(own(inputs,'goodsSalesDocuments')||own(inputs,'goodsReturnDocuments'))||own(inputs,'certifiedInputVat')&&(own(inputs,'goodsPurchaseDocuments')||own(inputs,'otherInputVatAmounts')))return unsupported('conflicting_alternative_inputs');
  const documentVat=key=>{let total=0n,totalNet=0n;for(const [index,document]of (inputs[key]??[]).entries()){let original=0n;for(const row of document.lines)original+=roundRatio(amount(row.unitPrice)*quantity(scalar(row.quantity)),1000000n);if(!own(document,'priceIncludesVat'))condition('goods_price_excludes_vat_assumption','货物明细单价未给含税标志，所示13%计算以不含税价为条件。');const net=document.priceIncludesVat===true?roundRatio(original*10000n,11300n):original,tax=document.priceIncludesVat===true?original-net:cents(calculateAgencyOutputVat({entity:{vatStatus:'general'},category:'goods',net:money(net),date:`${scope.period}-01`,invoiceKind:'special'}).tax);total+=tax;totalNet+=net;step(`${key}_${index}`,'document_sum(quantity × unitPrice), then statutory_goods_VAT_13_percent',{documentAmount:original,net},tax);}return {tax:total,net:totalNet};};
  if(!own(inputs,'outputVat')&&!own(inputs,'goodsSalesDocuments'))out.needsInputs.push({field:'outputVat_or_goodsSalesDocuments',reason:'source_bound_input_required'});
  if(!own(inputs,'certifiedInputVat')&&!own(inputs,'goodsPurchaseDocuments')&&!own(inputs,'otherInputVatAmounts'))out.needsInputs.push({field:'certifiedInputVat_or_purchase_inputs',reason:'source_bound_input_required'});
  if(out.needsInputs.length)out.status='needs_inputs';
  else if(!scopeCondition())return unsupported('nonordinary_vat_scope');
  else{let output,salesExcludingVat;if(own(inputs,'outputVat'))output=read('outputVat');else{const sales=documentVat('goodsSalesDocuments'),returns=documentVat('goodsReturnDocuments');output=sales.tax-returns.tax;salesExcludingVat=sales.net-returns.net;step('sales_excluding_vat','sum(sales_document_net) - sum(return_document_net)',{salesDocumentNet:sales.net,returnDocumentNet:returns.net},salesExcludingVat);}
   const input=own(inputs,'certifiedInputVat')?read('certifiedInputVat'):documentVat('goodsPurchaseDocuments').tax+(own(inputs,'otherInputVatAmounts')?read('otherInputVatAmounts'):0n),transfer=optional('inputVatTransferOut'),opening=optional('openingCarryCredit'),prepaid=optional('prepaidVat'),credit=input+opening-transfer;
   if(output<0n)return unsupported('negative_output_vat_special_handling');
   if(inputs.goodsReturnDocuments)condition('red_invoice_original_sale_unreviewed','退货数量/原销售单价及红字确认按有来源明细作条件，原单追溯/红字法定生效未审定。');
   if(credit<0n)return unsupported('negative_available_input_credit');const before=max0(output-credit),carry=max0(credit-output),used=min(before,prepaid),due=before-used;
   step('available_credit','certifiedInputVat + openingCarryCredit - inputVatTransferOut',{certifiedInputVat:input,openingCarryCredit:opening,inputVatTransferOut:transfer},credit);
   step('due_before_prepayment','max(outputVat - availableCredit, 0)',{outputVat:output,availableCredit:credit},before);step('due','dueBeforePrepayment - min(prepaidVat, dueBeforePrepayment)',{dueBeforePrepayment:before,prepaidVat:prepaid},due);
   set(out.amounts,{outputVat:output,certifiedInputVat:input,...(salesExcludingVat===undefined?{}:{salesExcludingVat}),availableCredit:credit,dueBeforePrepayment:before,prepaymentUsed:used,due,carryCredit:carry,unusedPrepayment:prepaid-used});condition('input_credit_eligibility_unreviewed','certifiedInputVat按有来源汇总作可抵扣条件，逐票资格/用途/认证及期初留抵未审定。');}
 }else if(kind==='vat_small'){
  if(!need(['periodType','salesExcludingVat','specialInvoiceSalesExcludingVat']))out.status='needs_inputs';
  else if(!own(inputs,'specialInvoiceVat')&&!own(inputs,'specialInvoiceRate')){out.needsInputs.push({field:'specialInvoiceVat_or_specialInvoiceRate',reason:'source_bound_input_required'});out.status='needs_inputs';}
  else if(!periodSupported())return unsupported('quarter_not_ended');
  else if(!scopeCondition()||inputs.noPropertyOrLandTransactions===false||inputs.taxpayerCategory==='general'||inputs.allSalesEligibleForOnePercentRelief===false)return unsupported('nonordinary_small_vat_scope');
  else{const sales=read('salesExcludingVat'),specialSales=read('specialInvoiceSalesExcludingVat');if(specialSales>sales)return unsupported('special_sales_exceed_total');
   const specialTax=own(inputs,'specialInvoiceVat')?read('specialInvoiceVat'):cents(calculateAgencyOutputVat({entity:{vatStatus:'small',vatReliefWaived:inputs.specialInvoiceRate===0.03},category:'goods',net:money(specialSales),date:`${scope.period}-01`,invoiceKind:'special'}).tax),threshold=inputs.periodType==='monthly'?10000000n:30000000n,below=sales<threshold;
   if(below&&inputs.remainingSalesEligibleForThresholdExemption===false||specialSales>0n&&inputs.specialInvoiceWaiverOfExemption===false)return unsupported('ordinary_small_vat_exemption_contradicted');
   if(own(inputs,'specialInvoiceVat')&&own(inputs,'specialInvoiceRate')){const checked=cents(calculateAgencyOutputVat({entity:{vatStatus:'small',vatReliefWaived:inputs.specialInvoiceRate===0.03},category:'goods',net:money(specialSales),date:`${scope.period}-01`,invoiceKind:'special'}).tax);if(checked!==specialTax)return unsupported('special_invoice_tax_rate_conflict');}
   const election=inputs.reliefElection??'unknown',elections=election==='unknown'?['waived','reduced']:[election];
   if(election==='unknown')condition('small_vat_relief_election_unverified','普通征收项目是否适用并选择1%减征未核；1%/3%分别列条件，不默选。');
   if(inputs.taxpayerCategory!=='small')condition('small_taxpayer_status_unverified','仅在该汇总主体本期为小规模纳税人时成立。');
   if(inputs.remainingSalesEligibleForThresholdExemption!==true&&below)condition('ordinary_exemption_eligibility_unverified','未达起征点时，非专票部分须实际符合普通免税条件。');
   if(inputs.specialInvoiceWaiverOfExemption!==true&&specialSales>0n)condition('special_invoice_exemption_election_unverified','专票税额仅在原件支持对应交易放弃免税/应税开票条件时保留，未据此认定全部交易放弃减征。');
   set(out.amounts,{salesExcludingVat:sales,specialInvoiceVat:specialTax,threshold});
   for(const e of elections){const ordinaryTax=below?0n:cents(calculateAgencyOutputVat({entity:{vatStatus:'small',vatReliefWaived:e==='waived'},category:'goods',net:money(sales-specialSales),date:`${scope.period}-01`,invoiceKind:'ordinary'}).tax),due=ordinaryTax+specialTax,scenario={scenario:`ordinary_${e}`,conditions:[below?'sales_strictly_below_threshold':'sales_at_or_above_threshold',`ordinary_relief_${e}`],amounts:{},steps:[]};
    set(scenario.amounts,{ordinaryTax,specialInvoiceVat:specialTax,due});step('small_vat_due','ordinaryTax + specialInvoiceVat',{ordinaryTax,specialInvoiceVat:specialTax},due,scenario.steps);out.scenarios.push(scenario);}
   if(out.scenarios.length===1||below)set(out.amounts,out.scenarios[0].amounts);out.thresholdComparison=below?'strictly_below':'at_or_above';}
 }else if(kind==='surcharges'){
  if(!need(['periodType','vatBase','salesExcludingVat']))out.status='needs_inputs';
  else if(!periodSupported())return unsupported('quarter_not_ended');
  else{const base=read('vatBase')+optional('consumptionTaxBase'),sales=read('salesExcludingVat'),educationExempt=sales<=(inputs.periodType==='monthly'?10000000n:30000000n),classification=inputs.classification??(inputs.cityCondition===true?'city':'unknown'),locations=classification==='unknown'?['city','county_town','other']:[classification];
   if(classification==='unknown')condition('tax_location_unverified','市区/县城镇/其他地区分类未核，分别列7%/5%/1%条件；不能按城市名猜税率。');
   condition('domestic_surcharge_base_unreviewed','给定基础须属于国内依法应缴两税；进口/境外代扣、免抵/留抵退税及异地预缴调整另核，不把税额汇总当实际缴款证据。');
   condition('local_education_standard_scope_unverified','地方教育附加按财综〔2010〕98号普通2%分支列示，福建执行依据并列；具体企业特殊批准减免未审定。');
   const reliefs=reliefStates();if(out.status==='unsupported')return out;
   for(const half of reliefs)for(const loc of locations){const urban=rateAmount(base,{city:700,county_town:500,other:100}[loc],half?20000:10000),education=educationExempt?0n:rateAmount(base,300,half?20000:10000),local=educationExempt?0n:rateAmount(base,200,half?20000:10000),scenario={scenario:`${loc}_${half?'half':'full'}`,conditions:[`tax_location_${loc}`,half?'six_tax_eligible':'six_tax_ineligible'],amounts:{},steps:[]};
    set(scenario.amounts,{urbanMaintenance:urban,educationSurcharge:education,localEducation:local,total:urban+education+local});step('urban_maintenance','base × statutory_location_rate × relief_fraction',{base,rateBasisPoints:{city:700,county_town:500,other:100}[loc],reliefDenominator:half?2:1},urban,scenario.steps);step('education_surcharge','sales <= exemption_threshold ? 0 : base × 3% × relief_fraction',{base,educationExempt},education,scenario.steps);step('local_education','sales <= exemption_threshold ? 0 : base × 2% × relief_fraction',{base,educationExempt},local,scenario.steps);out.scenarios.push(scenario);}
   set(out.amounts,{surchargeBase:base});if(out.scenarios.length===1)set(out.amounts,out.scenarios[0].amounts);out.educationExempt=educationExempt;}
 }else if(kind==='cit_prepayment'){
  if(!need(['profitTotalYtd','validPriorYearLossOffset','otherPrepaymentAdjustments','prepaidThisYear']))out.status='needs_inputs';
  else if(inputs.prepaymentMethod==='other')return unsupported('unsupported_cit_prepayment_method');
  else{const profit=read('profitTotalYtd',{negative:true}),adjust=read('otherPrepaymentAdjustments',{negative:true}),loss=read('validPriorYearLossOffset'),prepaid=read('prepaidThisYear'),base=max0(profit+adjust-loss),q=Math.ceil(Number(scope.period.slice(5))/3);let staff,assets,qualified,divisor=1n;
   if((own(inputs,'ytdAverageEmployees')||own(inputs,'ytdAverageAssetsYuan'))&&(own(inputs,'quarterAverageEmployees')||own(inputs,'quarterAverageAssetsYuan')||own(inputs,'quarterProfiles'))||own(inputs,'quarterProfiles')&&(own(inputs,'quarterAverageEmployees')||own(inputs,'quarterAverageAssetsYuan')))return unsupported('conflicting_alternative_inputs');
   if(own(inputs,'ytdAverageEmployees')||own(inputs,'ytdAverageAssetsYuan')){if(own(inputs,'ytdAverageEmployees'))staff=decimalUnits(inputs.ytdAverageEmployees);if(own(inputs,'ytdAverageAssetsYuan'))assets=amount(inputs.ytdAverageAssetsYuan);}
   else if(q===1&&(own(inputs,'quarterAverageEmployees')||own(inputs,'quarterAverageAssetsYuan'))){if(own(inputs,'quarterAverageEmployees'))staff=decimalUnits(inputs.quarterAverageEmployees);if(own(inputs,'quarterAverageAssetsYuan'))assets=amount(inputs.quarterAverageAssetsYuan);}
   else if(inputs.quarterProfiles?.length===q&&inputs.quarterProfiles.every((row,index)=>row.quarter===index+1)){staff=inputs.quarterProfiles.reduce((n,row)=>n+decimalUnits(row.averageEmployees),0n);assets=inputs.quarterProfiles.reduce((n,row)=>n+amount(row.averageAssetsYuan),0n);divisor=BigInt(q);}
   if(base>300000000n||inputs.restrictedOrProhibitedIndustry===true||staff!==undefined&&staff>300000000n*divisor||assets!==undefined&&assets>5000000000n*divisor)qualified=false;
   else if(staff!==undefined&&assets!==undefined&&inputs.restrictedOrProhibitedIndustry===false)qualified=true;
   if(qualified===undefined)condition('cit_ytd_small_profit_qualification_unverified','截至本期累计季度平均人数/资产或非限制禁止行业未核，不把单季均值冒充累计；并列普通25%和符合全部小微条件5%。');
   if(!inputs.prepaymentMethod)condition('cit_actual_profit_method_unverified','仅按实际利润额法预缴条件计算，原税种月/季及其他核定方法未核。');
   if(inputs.prepaymentMethod==='actual_profit_quarterly'&&!Number.isInteger(quarter))return unsupported('quarter_not_ended');
   step('cit_base','max(profitTotalYtd + otherPrepaymentAdjustments - validPriorYearLossOffset, 0)',{profitTotalYtd:profit,otherPrepaymentAdjustments:adjust,validPriorYearLossOffset:loss},base);set(out.amounts,{taxableBase:base,priorPrepaid:prepaid});
   for(const small of qualified===undefined?[false,true]:[qualified]){const cumulative=rateAmount(base,small?500:2500),due=max0(cumulative-prepaid),scenario={scenario:small?'small_low_profit_eligible':'ordinary_25_percent',conditions:[small?'all_small_profit_conditions_met':'small_profit_relief_not_applied'],amounts:{},steps:[]};set(scenario.amounts,{cumulativeTax:cumulative,due,overpaidForReconciliation:max0(prepaid-cumulative)});step('cit_cumulative_tax','taxableBase × statutory_effective_rate',{taxableBase:base,rateBasisPoints:small?500:2500},cumulative,scenario.steps);step('cit_current_due','max(cumulativeTax - priorPrepaid, 0)',{cumulativeTax:cumulative,priorPrepaid:prepaid},due,scenario.steps);out.scenarios.push(scenario);}
   if(out.scenarios.length===1)set(out.amounts,out.scenarios[0].amounts);condition('cit_profit_loss_adjustments_unreviewed','利润、可弥补亏损及其他调整按有来源预缴汇总作条件，不证明完整账链、亏损可用期限或年度纳调已核。');}
 }else if(kind==='salary_pit_cumulative'){
  if(own(inputs,'monthlyGrossSalary')&&['cumulativeIncome','cumulativeSpecialDeductions','cumulativeAdditionalDeductions','cumulativeTaxExemptIncome','cumulativeOtherDeductions','employmentMonths'].some(k=>own(inputs,k)))return unsupported('conflicting_alternative_inputs');
  const monthly=own(inputs,'monthlyGrossSalary'),keys=monthly?['monthlyGrossSalary','monthlyValidSpecialDeductions','monthlyValidAdditionalDeductions','monthsToPeriod','priorWithholding','otherRelief']:['cumulativeIncome','cumulativeSpecialDeductions','cumulativeAdditionalDeductions','employmentMonths','priorWithholding','otherRelief'];
  if(!need(keys))out.status='needs_inputs';
  else if(inputs.residentIndividual===false||inputs.specialFullYear60000DeductionApplicable===true||inputs.firstEmploymentExceptionApplicable===true||inputs.salaryPaidInSameMonth===false)return unsupported('nonordinary_salary_withholding');
  else{const months=monthly?inputs.monthsToPeriod:inputs.employmentMonths;if(months>Number(scope.period.slice(5)))return unsupported('employment_months_after_period');
   const factor=monthly?BigInt(months):1n,income=read(monthly?'monthlyGrossSalary':'cumulativeIncome')*factor,special=read(monthly?'monthlyValidSpecialDeductions':'cumulativeSpecialDeductions')*factor,additional=read(monthly?'monthlyValidAdditionalDeductions':'cumulativeAdditionalDeductions')*factor,exempt=optional(monthly?'monthlyTaxExemptIncome':'cumulativeTaxExemptIncome')*factor,other=optional(monthly?'monthlyOtherDeductions':'cumulativeOtherDeductions')*factor,basic=500000n*BigInt(months),prior=read('priorWithholding'),relief=read('otherRelief'),base=max0(income-exempt-special-additional-other-basic),bracket=salaryTable.find(([limit])=>limit===null||base<=limit),tax=max0(rateAmount(base,bracket[1])-bracket[2]),after=max0(tax-relief),due=max0(after-prior);
   if(inputs.residentIndividual!==true)condition('resident_salary_status_unverified','仅在居民个人普通连续任职工资分支成立。');
   if(inputs.specialFullYear60000DeductionApplicable!==false||inputs.firstEmploymentExceptionApplicable!==false)condition('salary_special_deduction_exceptions_unverified','按每实际任职月5000计算；首次就业及全年6万元特殊扣除未适用的条件须核对。');
   if(monthly)step('salary_income_cumulative','monthlyGrossSalary × monthsToPeriod',{monthlyGrossSalary:read('monthlyGrossSalary'),monthsToPeriod:months},income);
   step('salary_base','max(income - exempt - special - additional - other - 5000 × months, 0)',{income,exempt,special,additional,other,basic},base);step('salary_cumulative_tax','taxableBase × statutory_rate - statutory_quick_deduction',{taxableBase:base,rateBasisPoints:bracket[1],quickDeduction:bracket[2]},tax);step('salary_current_withholding','max(cumulativeTax - cumulativeRelief - priorWithholding, 0)',{cumulativeTax:tax,cumulativeRelief:relief,priorWithholding:prior},due);
   set(out.amounts,{cumulativeIncome:income,basicDeduction:basic,taxableBase:base,cumulativeTax:tax,currentWithholding:due,overwithheldNotRefunded:max0(prior-after)});out.withholdingRateBasisPoints=bracket[1];condition('salary_payment_deductions_unreviewed','工资取得所属期、连续任职、专项/附加/其他扣除及已预扣额按有来源汇总为条件；不生成工资支付或社保核定结果。');}
 }else if(kind==='stamp_sale'){
  if(!need(['amountIncludingVat']))out.status='needs_inputs';
  else if(!own(inputs,'separatelyStatedVat')&&!own(inputs,'vatAmount')){out.needsInputs.push({field:'separatelyStatedVat_or_vatAmount',reason:'source_bound_input_required'});out.status='needs_inputs';}
  else if(inputs.separatelyStatedVat&&!need(['vatAmount']))out.status='needs_inputs';
  else if(inputs.ordinaryMovableSaleContract===false)return unsupported('nonordinary_stamp_contract');
  else{const gross=read('amountIncludingVat'),sourceVat=own(inputs,'vatAmount')?read('vatAmount'):0n,statementKnown=own(inputs,'separatelyStatedVat'),statements=statementKnown?[inputs.separatelyStatedVat]:[false,true];if(sourceVat>gross)return unsupported('vat_exceeds_contract_amount');
   if(!statementKnown)condition('contract_vat_separate_statement_unverified','有来源VAT金额不自动证明合同已单列VAT；分别列未单列/已单列的计税基础，待核原合同列示。');
   for(const separatelyStated of statements){const vat=separatelyStated?sourceVat:0n,base=gross-vat,grossTax=rateAmount(base,3);if(statementKnown){step('stamp_base','separatelyStatedVat ? amountIncludingVat - vatAmount : amountIncludingVat',{amountIncludingVat:gross,vatAmount:vat},base);set(out.amounts,{taxableBase:base,grossTax});}
    const reliefs=reliefStates();if(out.status==='unsupported')return out;
    for(const half of reliefs){const due=rateAmount(base,3,half?20000:10000),scenario={scenario:`${statementKnown?'':separatelyStated?'vat_separately_stated_':'vat_not_separately_stated_'}${half?'six_tax_half':'six_tax_full'}`,conditions:[separatelyStated?'contract_vat_separately_stated':'contract_vat_not_separately_stated',half?'six_tax_eligible':'six_tax_ineligible'],amounts:{taxableBase:money(base),grossTax:money(grossTax),due:money(due)},steps:[]};step('stamp_base','separatelyStatedVat ? amountIncludingVat - vatAmount : amountIncludingVat',{amountIncludingVat:gross,vatAmount:vat},base,scenario.steps);step('stamp_due','taxableBase × 0.03% × relief_fraction',{taxableBase:base,reliefDenominator:half?2:1},due,scenario.steps);out.scenarios.push(scenario);}}
   if(out.scenarios.length===1)set(out.amounts,out.scenarios[0].amounts);if(inputs.ordinaryMovableSaleContract!==true)condition('ordinary_movable_sale_contract_unverified','仅动产买卖应税合同分支，不按合同名称推断税目或其他豁免。');}
 }else return unsupported('summary_kind_uncovered');
 return out;
}
