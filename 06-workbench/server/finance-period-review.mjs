// 从既有调用目录重建只读复核；不登记事实、不建立任务库、不写回关闭状态。
import {readFileSync,lstatSync,realpathSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readFinanceCall,financeAuditDirectory,annotateFinanceCall,currentFinanceCall} from './finance-call-chain.mjs';
import {resolveDirectFinanceTarget} from './direct-finance-target.mjs';
import {validateSchemaValue} from './harness-schema-validation.mjs';
import {reviewDeliveryFiles} from './finance-delivery-check.mjs';
import {FINANCE_PERIOD_REVIEW_SCHEMA} from './finance-period-review-contracts.mjs';
import {digest as vatDigest} from './finance-prebook-evidence.mjs';
import {handoffFiles,vatCodeVersion,bookSnapshot} from './vat-handoff-versions.mjs';
import {captureAgencyCode} from './agency-business-evidence.mjs';
import {workpaperBookState} from './direct-finance-details.mjs';
import {workpaperLedgerAmounts,taxSummary} from './direct-finance.mjs';
import {AGENCY_RULE_VERSION} from './agency-business.mjs';
import {FINANCE_SUMMARY_RULE_VERSION} from './finance-summary-engine.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const stable=v=>Array.isArray(v)?`[${v.map(stable).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`:JSON.stringify(v);
const serverRoot=dirname(fileURLToPath(import.meta.url));
const idPattern=/^\d{8}T\d{9}Z_[a-f0-9-]{36}$/;
const fail=code=>{throw Object.assign(Error(code),{code});};
const array=value=>Array.isArray(value)?value:[];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const states=new Set(['partial','partial_known_invoices','calculated_draft','conditional_calculated','needs_inputs','unsupported','ready_for_bookkeeping_review','executed','failed']);
const tools={finance_vat_plan:'vat_planning',finance_workpaper:'native_workpaper',finance_annual_workpaper:'annual_workpaper',finance_tax_calculate:'native_workpaper',finance_tax_summary_calculate:'tax_summary',finance_prebook_review:'prebook',finance_calculation_run:'calculation'};
const summaryFiles=['finance-summary.mjs','finance-summary-contracts.mjs','finance-summary-engine.mjs','agency-tax-rules.mjs','agency-rule-catalog.mjs','money.mjs','direct-finance-target.mjs','finance-call-chain.mjs'];
// 代码只允许来自固定生产模块中的常量。保存记录中的任意新字符串不能成为模型输出。
const issueCodes=new Set();
for(const name of ['agency-business-rules.mjs','agency-tax-rules.mjs','agency-extended-tax-rules.mjs','agency-regional-rules.mjs','agency-business.mjs','finance-prebook.mjs','finance-summary-engine.mjs']){
 const code=readFileSync(join(serverRoot,name),'utf8');
 for(const m of code.matchAll(/['"]([a-z][a-z0-9_]{2,100})['"]/g))issueCodes.add(m[1]);
}
for(const code of [...issueCodes])for(const suffix of ['missing','unknown','uncovered','payment_allocation_missing','zero_assumption'])issueCodes.add(`${code}_${suffix}`);
function codeCounts(values){
 const counts=new Map();for(const value of values){const code=issueCodes.has(value)?value:'unrecognized_issue';counts.set(code,(counts.get(code)??0)+1);}
 return [...counts].sort(([a],[b])=>a.localeCompare(b)).map(([code,count])=>({code,count}));
}
export function safeFile(path,maxBytes=10*1024*1024){
 const absolute=resolve(path);
 for(let p=absolute;;p=dirname(p)){if(lstatSync(p).isSymbolicLink())throw Error('unsafe_file');if(dirname(p)===p)break;}
 const before=lstatSync(absolute);if(!before.isFile()||before.nlink!==1||before.size>maxBytes||realpathSync(absolute).toLowerCase()!==absolute.toLowerCase())throw Error('unsafe_file');
 const bytes=readFileSync(absolute),after=lstatSync(absolute);
 if(before.ino!==after.ino||before.dev!==after.dev||before.size!==bytes.length||before.mtimeMs!==after.mtimeMs)throw Error('changed_file');
 return bytes;
}
function checkDirectory(path){for(let p=resolve(path);;p=dirname(p)){if(lstatSync(p).isSymbolicLink())throw Error('unsafe_directory');if(dirname(p)===p)break;}if(!lstatSync(path).isDirectory())throw Error('unsafe_directory');}
function currentVersions(){
 try{return {recorder:sha(safeFile(join(serverRoot,'finance-call-chain.mjs'))),native:captureAgencyCode().digest,vat:vatCodeVersion(),
  summary:sha(stable(summaryFiles.map(name=>({path:join(serverRoot,name),sha256:sha(safeFile(join(serverRoot,name)))}))))};}
 catch{return {};}
}
const compare=(old,current)=>typeof old!=='string'||!current?'unknown':old===current?'unchanged':'changed';
function versionState(record,kind,versions){
 const expectedRule=['native_workpaper','annual_workpaper'].includes(kind)?AGENCY_RULE_VERSION:['tax_summary','prebook','vat_planning'].includes(kind)?FINANCE_SUMMARY_RULE_VERSION:null;
 return {recorder:compare(record.begin.recorderCodeDigest,versions.recorder),code:compare(record.end?.codeDigest,['native_workpaper','annual_workpaper'].includes(kind)?versions.native:kind==='tax_summary'?versions.summary:kind==='vat_planning'?versions.vat:null),
  rules:compare(record.end?.ruleVersion,expectedRule),environment:'unknown',meaning:'recorded_versions_only_not_business_correctness'};
}
function recognized(record){
 const o=record.output,kind=tools[record.tool];if(!object(o))return null;
 if(kind==='annual_workpaper'){
  const scope=record.end?.scope;
  return o.version==='finance-annual-result/1'&&o.resultOrigin==='native_engine'&&/^(2026|2027)$/.test(o.period)&&scope?.period===o.period+'-12'&&
   ['annual_calculation_draft','incomplete'].includes(o.status)&&o.annualCalculation?.status===o.status&&o.review?.submittable===false&&o.vouchers?.scope==='provided_annual_months'&&
   o.evidence?.callRef===record.callId&&Array.isArray(o.review.issues)&&Array.isArray(o.calculationResults?.taxes)&&o.calculationResults.taxes.every(t=>object(t)&&typeof t.status==='string')?kind:null;
 }
 if(!states.has(o.status))return null;
 if(kind==='native_workpaper'&&o.version==='finance-business-result/1'&&o.resultOrigin==='native_engine'&&object(o.review)&&Array.isArray(o.review.issues)&&object(o.calculationResults)&&Array.isArray(o.calculationResults.taxes)&&o.calculationResults.taxes.every(t=>object(t)&&typeof t.status==='string'))return kind;
 if(kind==='tax_summary'&&o.version==='finance-tax-summary-result/1'&&o.resultOrigin==='conditional_summary_engine'&&Array.isArray(o.conditions)&&Array.isArray(o.needsInputs))return kind;
 if(kind==='prebook'&&o.version==='finance-prebook-projection/1'&&Array.isArray(o.issues)&&o.tax&&o.review)return kind;
 if(kind==='vat_planning'&&o.version==='finance-vat-planning/1'&&o.callRef===record.callId&&/^[a-f0-9]{64}$/.test(o.basis??'')&&o.start===record.end?.scope?.period&&/^20\d\d-\d\d-\d\d$/.test(o.asOf)&&/^20\d\d-\d\d$/.test(o.through)&&Array.isArray(o.invoices)&&Number.isSafeInteger(o.pagination?.total)&&o.posted===false&&o.submittable===false)return kind;
 if(kind==='calculation'&&o.kind==='derived_calculation'&&/^[a-f0-9-]{36}$/.test(o.runId??'')&&o.businessStatus==='unreviewed'&&Array.isArray(o.outputs))return kind;
 return null;
}
function annualMatches(record,paper){
 const o=record.output,ref='finance-artifact:'+record.callId+'/workpaper.json',scope=record.end.scope;
 const {contentDigest,...body}=paper;
 const months=array(paper.dependencies).filter(d=>d.kind!=='native_asset_context');
 return paper.entrypoint==='buildAgencyAnnualWorkpaper'&&contentDigest===sha(stable(body))&&stable(paper.scope)===stable(scope)&&
  paper.year===o.period&&paper.status===o.status&&o.evidence.result.artifactRef===ref&&o.vouchers.detailRef===ref&&
  months.length>0&&months.every(d=>d.codeDigest===record.end.codeDigest&&d.period?.startsWith(o.period+'-'))&&
  paper.ruleVersion===record.end.ruleVersion&&paper.ruleVersion===o.rules?.ruleVersion&&o.rules.codeDigest===record.end.codeDigest&&
  stable(workpaperLedgerAmounts(paper))===stable(o.ledgerAmounts)&&stable(taxSummary(paper.obligations))===stable(o.calculationResults.taxes)&&
  o.vouchers.count===array(paper.accounting?.vouchers).length+array(paper.accounting?.historicalVouchers).length&&
  o.annualCalculation.yearEndAdjustmentsPresent===(paper.yearEndAdjustments!==undefined)&&o.annualCalculation.nextYearCarryPresent===(paper.nextYearCarryState!==undefined);
}
// 工件路径只由已验证 callId/runId 和固定文件名构造，不消费记录内的自由路径。
function artifactState(root,record,kind,verified){
 if(!kind)return 'unknown';
 const o=record.output;
 try{
  let path,expected;
  if(kind==='vat_planning'){
   const h=o.handoff;
   if(!h&&o.delivery==='invoice_inventory'&&/^[a-f0-9]{64}$/.test(o.evidenceDigest))return sha(safeFile(join(root,record.callId,handoffFiles.evidence),48*1024*1024))===o.evidenceDigest?'verified':'changed';
   if(!h||h.version!=='vat-accountant-handoff/1')return 'unverified';
   let pack;
   for(const [key,name] of Object.entries(handoffFiles)){
    const bytes=safeFile(join(root,record.callId,name),48*1024*1024);
    if(sha(bytes)!==h.digests?.[key])return 'changed';
    if(key==='data')pack=JSON.parse(bytes);
   }
   if(pack?.callId!==record.callId||pack.basis!==o.basis||stable(pack.scope)!==stable(record.end.scope)||pack.asOf!==o.asOf||pack.through!==o.through)return 'changed';
   for(const kind of ['trial-balance','balance-sheet','income-statement','cash-flow-statement']){
    const report=pack.books?.reports?.[kind];
    if(report&&sha(safeFile(join(root,record.callId,kind+'.csv'),48*1024*1024))!==report.sha256)return 'changed';
   }
   verified.handoff=pack;
   return 'verified';
  }
  if(['native_workpaper','annual_workpaper','tax_summary'].includes(kind)){
   path=join(root,'artifacts',record.callId,kind==='tax_summary'?'summary.json':'workpaper.json');expected=o.evidence?.result?.sha256;
   const bytes=safeFile(path);if(!/^[a-f0-9]{64}$/.test(expected??''))return 'unverified';
   if(sha(bytes)!==expected)return 'changed';
   if(kind!=='tax_summary'){
    const paper=JSON.parse(bytes);
    if(kind==='annual_workpaper'&&(bytes.length!==o.evidence.result.bytes||!annualMatches(record,paper)))return 'changed';
    verified.nativeAssetContext=paper.nativeAssetContext;
    if(kind==='annual_workpaper'){
     const changed=new Set([...record.changedSources,...record.unverifiedSources,...array(record.end.sourceChanges).map(s=>s.path)]);
     verified.affectedInputMonths=periodList(paper.dependencies.filter(d=>array(d.sourceRefs).some(s=>changed.has(s.locator))).map(d=>d.period)).sort();
    }
   }
   return 'verified';
  }
  path=kind==='prebook'?join(root,'prebook',record.callId,'prebook.json'):join(root,'calculations',o.runId,'record.json');
  const saved=JSON.parse(safeFile(path));
  if(kind==='prebook'&&(saved.version!=='finance-prebook-result/1'||saved.inputDigest!==o.inputDigest||saved.status!==o.status||array(saved.issues).length!==o.issueCount))return 'changed';
  if(kind==='calculation'&&(saved.version!=='finance-calculation/1'||saved.callId!==record.callId||saved.runId!==o.runId||saved.status!==o.status))return 'changed';
  // 这些旧工件没有锚定到调用记录的完整摘要，存在不等于版本已核。
  return 'unverified';
 }catch(error){return error.code==='ENOENT'?'missing':'unverified';}
}
function sourceState(record){
 const sources=record.currentSources,missing=sources.filter(s=>s.reason==='ENOENT').length;
 const baselines=[...array(record.begin.sources),...array(record.end?.loadedSources)],unknownBaselines=baselines.filter(s=>s.state!=='observed'||!/^[a-f0-9]{64}$/.test(s.sha256??'')).length;
 return {state:record.changedSources.length||array(record.end?.sourceChanges).length?'changed':record.unverifiedSources.length||unknownBaselines?'unverified':sources.length?'unchanged':'unknown',
  observed:sources.filter(s=>s.state==='observed').length,changed:record.changedSources.length,missing,unverified:record.unverifiedSources.length,
  unverifiedBaselines:unknownBaselines,
  meaning:'file_bytes_only_not_authenticity'};
}
const periodList=values=>array(values).filter(p=>typeof p==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(p)).slice(0,25);
const yuan=value=>typeof value==='string'&&/^-?\d{1,13}\.\d{2}$/.test(value)?value:null;
function planningReadback(pack){
 const current=array(pack.months).find(r=>r.period===pack.scope.period);
 const cash=array(pack.cash).find(r=>r.paymentMonth===pack.scope.period);
 const filings=array(pack.filingHistory).filter(f=>f.data?.period===pack.scope.period);
 const receipts=filings.filter(f=>f.source?.verification==='source_value_bound');
 const amount=receipts.length&&receipts.length===filings.length?yuan(current?.declaredDue):null;
 const burden=current?.burden,impact=pack.previous?.impact;
 const supportedOutputs=['invoice_inventory','monthly_tax_calculation','payment_month_cash','receipt_reconciliation','planning_recommendation','year_end_forecast'];
 return {decisionBasis:{
  observedPeriods:periodList(pack.yearHistory?.coverage?.observedPeriods),forecastPeriods:periodList(pack.yearHistory?.coverage?.forecastPeriods),
  agreementMode:['monthly','ytd'].includes(pack.recommendation?.agreement?.burdenMode)?pack.recommendation.agreement.burdenMode:null,
  monthlyBurdenPercent:Number.isFinite(burden?.monthly?.percent)?burden.monthly.percent:null,ytdBurdenPercent:Number.isFinite(burden?.ytd?.percent)?burden.ytd.percent:null,
  projectedYearEndDueFromStart:yuan(pack.yearEnd?.dueFromStart),expectedPaymentForPeriod:yuan(current?.expectedPayment),expectedPaymentMonth:periodList([current?.paymentMonth])[0]??null,
  declaredDue:amount,filingReceiptCount:receipts.length,filingAmountMatched:amount!==null&&current?.filingReconciliation?.balanceStatus==='matched',
  observedPaidInCashMonth:yuan(cash?.observedActualPaid),paymentCoverage:['complete_as_of','documented_receipts_only','coverage_incomplete','future_payment_month'].includes(cash?.actualPaidEvidence?.status)?cash.actualPaidEvidence.status:'not_provided',
 },...(impact?{recalculation:{taxPeriods:periodList(impact.taxPeriods),cashMonths:periodList(impact.cashMonths),receiptPeriods:periodList(impact.receiptPeriods),
  changedInvoiceCount:array(impact.invoiceRefs).length,outputs:array(impact.outputs).filter(o=>supportedOutputs.includes(o)),policyChanged:impact.policyChanged===true,agreementChanged:impact.agreementChanged===true}}:{})};
}
function projection(root,record,versions,binding,currentBooks){
 const scopeVerified=!!binding;
 const verified={},kind=recognized(record),o=record.output??{},sources=sourceState(record),versionsState=versionState(record,kind,versions),artifact=artifactState(root,record,kind,verified);
 let codes=[],unresolved=0,business='unrecognized',conditions=0,needsInputs=0,unrecognizedTaxStatuses=0,taxStatusUnverified=false;
 if(kind==='native_workpaper'||kind==='annual_workpaper'){
  codes=array(o.review.issues).map(i=>i?.code);unresolved=Math.max(codes.length,count(o.review.issueCount));
  const taxes=o.calculationResults.taxes;
  unrecognizedTaxStatuses=taxes.filter(t=>!['calculated','not_applicable','missing','unknown','uncovered','pending_period_end'].includes(t.status)).length;
  needsInputs=taxes.filter(t=>t.status==='missing').length;
  const pending=taxes.filter(t=>t.status==='pending_period_end').length,uncovered=taxes.filter(t=>t.status==='uncovered').length,unknown=taxes.filter(t=>t.status==='unknown').length+unrecognizedTaxStatuses;
  taxStatusUnverified=pending+uncovered+unknown>0;
  business=unresolved||needsInputs?'needs_inputs':uncovered?'unsupported':pending?'pending_period_end':unknown?'unverified':'draft';
  unresolved=Math.max(unresolved,needsInputs+pending+uncovered+unknown);
  if(kind==='annual_workpaper'&&o.status==='incomplete'){business='needs_inputs';unresolved=Math.max(unresolved,1);}
 }else if(kind==='tax_summary'){
  conditions=o.conditions.length;needsInputs=o.needsInputs.length;codes=o.conditions.map(i=>i?.code);unresolved=needsInputs+conditions+(o.status==='unsupported'?1:0);
  business=o.status==='unsupported'?'unsupported':needsInputs?'needs_inputs':o.delivery==='invoice_inventory'?'inventory_read':'conditional';
 }else if(kind==='prebook'){
  codes=o.issues.map(i=>i?.code);conditions=array(o.tax.conditionCodes).length;needsInputs=array(o.tax.needsInputs).length;
  unresolved=Math.max(codes.length,count(o.issueCount))+conditions+needsInputs;codes.push(...array(o.tax.conditionCodes));
  business=o.status==='unsupported'?'unsupported':unresolved?'needs_inputs':'awaiting_bookkeeping_review';
 }else if(kind==='vat_planning'){
  needsInputs=array(o.gaps).length;unresolved=needsInputs;
  business=o.status==='unsupported'?'unsupported':needsInputs?'needs_inputs':o.delivery==='invoice_inventory'?'inventory_read':'conditional';
 }else if(kind==='calculation'){business='unreviewed';}
 if(record.status==='incomplete')business='incomplete';else if(record.status==='unknown')business='unknown';else if(['failed','rejected','tool_error'].includes(record.status)||o.status==='failed')business='failed';
 let books='unknown';
 if(binding&&['native_workpaper','annual_workpaper'].includes(kind)&&artifact==='verified')books=workpaperBookState(binding,verified.nativeAssetContext);
 if(kind==='vat_planning'&&scopeVerified&&artifact==='verified'&&o.handoff?.bookDigest&&currentBooks){
  const snapshot=currentBooks(verified.handoff);
  books=snapshot?compare(o.handoff.bookDigest,vatDigest(snapshot)):'unknown';
 }
 const stale=books==='changed'||sources.state==='changed'||sources.missing>0||['changed','missing'].includes(artifact)||Object.values(versionsState).includes('changed');
 const unverified=!scopeVerified||books==='unverified'||taxStatusUnverified||business==='unverified'||record.integrity!=='verified'||['unverified','unknown'].includes(sources.state)||artifact!=='verified'||['code','rules','recorder'].some(k=>versionsState[k]==='unknown');
 return {callId:record.callId,tool:Object.hasOwn(tools,record.tool)?record.tool:'unrecognized_tool',kind:kind??'unrecognized',scopeVerified,
  execution:{status:['returned','failed','unknown','rejected','tool_error','incomplete'].includes(record.status)?record.status:'unknown',completed:record.end?.executionCompleted===true},
  ...(scopeVerified&&['annual_workpaper','native_workpaper'].includes(kind)?{books}:{}),
  ...(kind==='annual_workpaper'&&scopeVerified&&record.integrity==='verified'&&artifact==='verified'?{annual:{
   year:o.period,through:o.ledgerAmounts.through,replayFrom:periodList([o.ledgerAmounts.replayFrom])[0]??null,affectedInputMonths:verified.affectedInputMonths,recordedAmounts:{revenue:o.ledgerAmounts.revenue,profitBeforeTax:o.ledgerAmounts.profitBeforeTax,inventory:o.ledgerAmounts.inventory},
   currentness:stale||books==='unverified'||sources.state!=='unchanged'?'recheck_before_use':'recorded_snapshot',detailRef:o.vouchers.detailRef,
   yearEndAdjustmentsPresent:o.annualCalculation.yearEndAdjustmentsPresent,nextYearCarryPresent:o.annualCalculation.nextYearCarryPresent}}:{}),
  ...(kind==='vat_planning'&&scopeVerified&&record.integrity==='verified'?{planning:{
   books,basis:o.basis,asOf:o.asOf,through:o.through,period:o.start,invoiceCount:o.pagination.total,
   ...(verified.handoff?planningReadback(verified.handoff):{}),
   recommendation:['baseline','plan'].includes(o.recommendation?.choice)?o.recommendation.choice:null,
   ...(o.status==='partial_known_invoices'&&o.knownSubset?.recommendation?{knownSubsetRecommendation:{
    choice:['baseline','plan'].includes(o.knownSubset.recommendation.choice)?o.knownSubset.recommendation.choice:null,
    through:/^20\d{2}-(0[1-9]|1[0-2])$/.test(o.knownSubset.plan?.horizon?.through)?o.knownSubset.plan.horizon.through:null,
    coverage:'known_invoices_and_contiguous_periods_only',
   }}:{}),
   previousCallId:idPattern.test(o.handoff?.previousCallId??'')?o.handoff.previousCallId:null,
   ...(artifact==='verified'&&o.handoff?.version==='vat-accountant-handoff/1'?{reportPath:join(root,record.callId,handoffFiles.report),dataPath:join(root,record.callId,handoffFiles.data)}:{}),
   currentness:stale||books==='unknown'||sources.state!=='unchanged'||artifact!=='verified'?'recheck_before_use':'recorded_snapshot',executed:false,
  }}:{}),recordIntegrity:record.integrity,artifactIntegrity:artifact,sources,versions:versionsState,businessStatus:business,...(!kind?{diagnostic:'result_shape_unrecognized'}:{}),
  flags:{stale,unverified,incomplete:record.status==='incomplete',failed:business==='failed'},
  evidence:{coverage:'recorded_local_result_only',unresolvedCount:unresolved,issueCodes:codeCounts(codes),conditionCount:conditions,needsInputCount:needsInputs,unrecognizedTaxStatusCount:unrecognizedTaxStatuses,
   accountingCoverageDeclared:['native_workpaper','annual_workpaper'].includes(kind)&&o.ledgerAmounts?.coverageVerified===true,approvalVerified:false,postedVerified:false,filingVerified:false},
  nextSteps:nextSteps(kind,{stale,unverified,business,unresolved,executionUncertain:record.status!=='returned'||record.end?.executionCompleted!==true||record.integrity!=='verified'})};
}
function nextSteps(kind,{stale,unverified,business,unresolved,executionUncertain}){
 const steps=[];
 // 失败或未核执行可能已有副作用；来源变更不能成为直接重跑原操作的依据。
 if(executionUncertain||['incomplete','failed','unknown','unrecognized'].includes(business)){
  steps.push({code:'inspect_original_execution_locally_before_retry',tool:'finance_period_review'});
  if(unverified||stale)steps.push({code:'verify_local_sources_and_business_scope',skill:'internal-control-review/references/audit-support.md'});
  return steps;
 }
 if(business==='inventory_read')steps.push({code:'compare_invoice_period_choices',tool:'finance_vat_plan'});
 if(stale)steps.push({code:'recompute_after_source_or_version_change',tool:kind==='vat_planning'?'finance_vat_plan':kind==='tax_summary'?'finance_tax_summary_calculate':kind==='prebook'?'finance_prebook_review':kind==='calculation'?'finance_calculation_run':kind==='annual_workpaper'?'finance_annual_workpaper':'finance_workpaper'});
 if(unresolved)steps.push({code:'supplement_evidence_then_recompute',tool:kind==='vat_planning'?'finance_vat_plan':kind==='prebook'?'finance_prebook_review':kind==='tax_summary'?'finance_tax_summary_calculate':'finance_record_contract',skill:kind==='prebook'?'prebook-review/SKILL.md':'tax-review/SKILL.md'});
 if(unverified)steps.push({code:'verify_local_sources_and_business_scope',skill:'internal-control-review/references/audit-support.md'});
 if(!steps.length)steps.push({code:'continue_remaining_goal_checks',skill:'tax-period/references/close-management.md'});
 return steps;
}
function bindingState(record,binding,root){
 const scope=binding.scope;
 const recorded=record.end?.scope??record.begin.scope;
 if(!recorded||['enterpriseKey','accountSetId','databaseInstanceId','period'].some(k=>recorded[k]===undefined))return 'unverified';
 if(['enterpriseKey','accountSetId','databaseInstanceId','period','currency'].some(k=>recorded[k]!==scope[k]))return 'conflict';
 const observed=record.end?.metadata?.configuredTarget;
 if(record.end?.scopeState!=='observed'||record.integrity!=='verified')return 'unverified';
 const path=observed?.databasePath??record.input?.dbPath??record.begin.configuredTarget?.databasePath;
 if(typeof path!=='string')return 'unverified';
 if(resolve(path).toLowerCase()!==resolve(binding.dbPath).toLowerCase())return 'conflict';
 if(observed?.bindingOrigin==='existing_database_identity'&&observed.accountSetId===scope.accountSetId&&observed.period===scope.period)return 'matched';
 // 旧年度调用仅留账库路径及原生年度工件。按当前账库解析身份，并核验原生范围、依赖、金额和版本。
 if(!observed&&recognized(record)==='annual_workpaper'&&artifactState(root,record,'annual_workpaper',{})==='verified')return 'matched';
 return 'unverified';
}
export async function loadRecord(root,callId){
 // 重用既有绑定/摘要/原件校验前先限制核心记录大小，坏记录仅生成固定诊断。
 const begin=JSON.parse(safeFile(join(root,callId,'begin.json')));safeFile(join(root,callId,'input.json'));
 for(const name of ['end.json','result.json','error.json']){try{safeFile(join(root,callId,name));}catch(e){if(e.code!=='ENOENT')throw e;}}
 let end;try{end=JSON.parse(safeFile(join(root,callId,'end.json')));}catch(e){if(e.code!=='ENOENT')throw e;}
 const sources=[...array(begin.sources),...array(end?.loadedSources)];if(sources.length>2000)throw Error('source_scan_limit');
 let total=0;for(const source of sources){try{total+=lstatSync(source.path).size;}catch{}if(total>50*1024*1024)throw Error('source_scan_limit');}
 return readFinanceCall({auditDir:root,callId});
}
export async function reviewFinancePeriod(args){
 if(validateSchemaValue(FINANCE_PERIOD_REVIEW_SCHEMA,args).length)fail('finance_period_review_input_invalid');
 const unbound=!!args.unboundCalls,binding=unbound?null:resolveDirectFinanceTarget(args.target),root=financeAuditDirectory();
 if(args.precedingPlanPeriod&&args.precedingPlanPeriod>=args.target.period)fail('finance_period_review_input_invalid');
 const selectedBinding=args.precedingPlanPeriod?{...binding,scope:{...binding.scope,period:args.precedingPlanPeriod}}:binding;
 if(binding)annotateFinanceCall({scope:binding.scope});
 const explicit=args.unboundCalls?.callIds??args.callIds,offset=args.offset??0,limit=args.limit??20;
 const newestFirst=!!args.precedingPlanPeriod&&!explicit;
 const inventoryLimit=10000;
 // 目录名用于排序和定位。游标页只检查本页及最多五十个被排除的调用，偏移页保留既有检查上限。
 const inspectionLimit=newestFirst?Math.min(inventoryLimit,offset+limit+50):inventoryLimit;
 let names=[],excludedSelfCalls=0,unscannedDirectories=0,totalCandidateDirectories=0,lastExamined=null,examined=0;
 try{checkDirectory(root);const candidates=readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&idPattern.test(e.name)&&(!args.beforeCallId||e.name<args.beforeCallId)).map(e=>e.name).sort();
  if(newestFirst)candidates.reverse();
  totalCandidateDirectories=candidates.length;
  for(const id of candidates.slice(0,inspectionLimit)){
   examined++;lastExamined=id;
   if(id===currentFinanceCall()?.callId){excludedSelfCalls++;continue;}
   // 名称只是筛选候选；仅完整校验的历史自身调用可排除，损坏/未结束记录继续呈现。
   try{if(JSON.parse(safeFile(join(root,id,'begin.json'),256*1024)).tool==='finance_period_review'){
    const historical=await loadRecord(root,id);
    if(historical.tool==='finance_period_review'&&historical.integrity==='verified'){excludedSelfCalls++;continue;}
   }}catch{}
   names.push(id);
   if(newestFirst&&names.length>=offset+limit)break;
  }
  unscannedDirectories=totalCandidateDirectories-examined;
 }
 catch(error){if(error.code!=='ENOENT')fail('finance_period_review_records_unavailable');}
 const selected=explicit??names.slice(offset,offset+limit);
 const remaining=explicit?null:newestFirst?unscannedDirectories:Math.max(0,names.length-offset-selected.length),records=[],excluded={scopeConflict:0,scopeUnverified:0,unreadable:0,incomplete:0,integrityUnverified:0};
 const versions=currentVersions();
 const books=new Map();
 const currentBooks=pack=>{
  const queries=pack.bankQueries??[],key=vatDigest(queries);
  if(!books.has(key)){
   const raw=bookSnapshot({databasePath:selectedBinding.dbPath,scope:selectedBinding.scope},queries);
   books.set(key,raw.entries===null&&!Object.keys(raw.reports).length?null:raw);
  }
  return books.get(key);
 };
 for(const callId of selected){
  let record;try{record=await loadRecord(root,callId);}catch{
   excluded.unreadable++;excluded.integrityUnverified++;records.push({callId,kind:'unrecognized',scopeVerified:false,recordIntegrity:'unverified',businessStatus:'unknown',flags:{stale:false,unverified:true,incomplete:false,failed:false},diagnostic:'record_unreadable',nextSteps:[{code:'inspect_original_record_locally',tool:'finance_period_review'}]});continue;
  }
  if(!unbound){const state=args.precedingPlanPeriod&&record.tool!=='finance_vat_plan'?'conflict':bindingState(record,selectedBinding,root);
   if(state!=='matched'){if(explicit)fail(state==='conflict'?'finance_period_review_scope_conflict':'finance_period_review_scope_unverified');excluded[state==='conflict'?'scopeConflict':'scopeUnverified']++;if(record.status==='incomplete')excluded.incomplete++;if(record.integrity!=='verified')excluded.integrityUnverified++;continue;}
  }
  records.push(projection(root,record,versions,selectedBinding,currentBooks));
 }
 const pagination={selection:explicit?'explicit_calls':'directory_page',totalDirectories:newestFirst?totalCandidateDirectories:names.length,totalCandidateDirectories,excludedSelfCalls,unscannedDirectories,offset:explicit||args.beforeCallId?null:offset,scanned:selected.length,remainingDirectories:remaining,
  nextOffset:!explicit&&remaining&&!args.beforeCallId&&(!newestFirst||selected.length&&examined<inspectionLimit)?offset+selected.length:null,
  ...(newestFirst?{nextBeforeCallId:remaining?lastExamined:null,directoryCountBasis:'candidate_directories_before_self_verification',examined}:{}),
  coverage:explicit?'selected_calls_only':remaining||offset||args.beforeCallId||unscannedDirectories?'partial_scan':'all_current_directories',directoryOrder:newestFirst?'call_id_descending':'call_id_ascending',snapshotStableAcrossPages:false,excluded,
  limits:{directoryInventory:inventoryLimit,recordsPerPage:50,recordFileBytes:10485760,sourcesPerRecord:2000,sourceBytesPerRecord:52428800}};
 const base={version:'finance-period-review/1',mode:unbound?'unbound_call_review':'bound_period_review',executionStatus:'reviewed',scopeVerified:!unbound,
  businessStatus:unbound?'identity_unverified':'requires_goal_review',periodComplete:false,authorizesExecution:false,pagination,records,
  limitations:['local_record_hashes_do_not_prove_business_correctness','older_issues_retained_without_verified_supersession','user_goal_coverage_not_asserted','environment_lock_unknown']};
 if(unbound)return base;
 return {...base,...(args.deliveryCheck?{delivery:reviewDeliveryFiles(binding,args.deliveryCheck,safeFile)}:{}),...(args.precedingPlanPeriod?{precedingPlanPeriod:args.precedingPlanPeriod}:{}),target:{accountSetId:args.target.accountSetId,period:args.target.period},
  coverage:{matchedRecords:records.filter(r=>r.scopeVerified).length,unresolvedCount:records.reduce((n,r)=>n+(r.evidence?.unresolvedCount??0),0),stale:records.filter(r=>r.flags.stale).length,unverified:records.filter(r=>r.flags.unverified).length,incomplete:records.filter(r=>r.flags.incomplete).length,failed:records.filter(r=>r.flags.failed).length,
   meaning:'this_page_only_not_period_completion'}};
}
