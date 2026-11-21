import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {currentFinanceCall,annotateFinanceCall} from './finance-call-chain.mjs';
import {baselineBytes} from './business-baseline-materials.mjs';
import {digest,pointer} from './finance-prebook-evidence.mjs';
import {cents,money} from './agency-tax-rules.mjs';
import {loadRecord,safeFile} from './finance-period-review.mjs';
import {handoffFiles,hashBytes,vatCodeVersion,bookSnapshot} from './vat-handoff-versions.mjs';
import {renderVatHandoff} from './vat-handoff-html.mjs';

function datesIn(text){
 return [...String(text).matchAll(/\d{4}[-年/.]\d{1,2}[-月/.]\d{1,2}日?/g)].map(m=>date(m[0]));
}
const date = raw=>{
 const m=String(raw??'').match(/^(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})(?:日|T|$|\s)/);
 if(!m)return null;
 const d=m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
 return Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d?d:null;
};
const difference=(a,b)=>a==null||b==null?null:money(cents(String(a))-cents(String(b)));
const scoped=(a,b)=>['databaseInstanceId','enterpriseKey','accountSetId','currency'].every(k=>a[k]===b[k]);
const simulation=(result,choice)=>result[choice]??result.knownSubset?.[choice]??null;
const labels={plan:'比较方案',baseline:'基准方案'};
function conditionAt(condition,evidence,period,asOf){
 if(!condition)return {state:'企业适用条件待核'};
 const source=evidence.mappings.find(m=>m.source===condition.source);
 if(!source?.path||!source.owner?.jsonPointer)return {state:'缺少已核主体的结构化原件'};
 try{
  const bytes=baselineBytes(source.path,process.env.FINANCE_SOURCE_ROOT);
  if(digest(bytes)!==source.sha256)return {state:'原件版本变更'};
  const doc=JSON.parse(bytes),known=date(pointer(doc,condition.knownAtPointer)),from=date(pointer(doc,condition.validFromPointer)),through=date(pointer(doc,condition.validThroughPointer));
  const last=new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5)),0)).toISOString().slice(0,10);
  const event=condition.transactionDatePointer?date(pointer(doc,condition.transactionDatePointer)):null;
  if(condition.transactionDatePointer&&(!event||event.slice(0,7)!==period||event>asOf))return {state:'业务发生日未核'};
  if(!known||!from||!through||known>asOf||from>(event??period+'-01')||through<(event??last))return {state:'事实的可知日或有效期未覆盖判断窗口'};
  const originalOwner=pointer(doc,source.owner.jsonPointer);
  const parts=condition.valuePointer.split('/');
  for(let n=1;n<parts.length;n++){
   const parent=pointer(doc,parts.slice(0,n).join('/'));
   if(parent&&typeof parent==='object'&&(
    parent.enterpriseKey!==undefined&&parent.enterpriseKey!==evidence.scope.enterpriseKey||
    parent.owner!==undefined&&parent.owner!==originalOwner))return {state:'原件行主体不匹配'};
  }
  const value=pointer(doc,condition.valuePointer);
  if(!['boolean','number','string'].includes(typeof value))return {state:'适用事实值缺失'};
  return {state:'已定位企业原件',matched:value===condition.equals,source:source.source,path:source.path,sha256:source.sha256,locator:condition,value,known,from,through,event};
 }catch{return {state:'无法核对适用原件'};}
}
async function reviewPolicy(args,evidence,audit){
 const rows=[];
 for(const r of args.handoff?.policyReviews??[]){
  const row={callId:r.callId,question:r.question,interpretation:r.interpretation,state:'引用待核',condition:conditionAt(r.condition,evidence,args.target.period,args.asOf)};
  try{
   const header=JSON.parse(safeFile(join(audit,r.callId,'begin.json'),256*1024));
   if(header.tool!=='finance_rules')throw Error();
   const rec=await loadRecord(audit,r.callId),o=rec.output,src=o?.source;
   if(rec.tool!=='finance_rules'||rec.integrity!=='verified'||rec.status!=='returned'||rec.input?.action!=='open')throw Error();
   const url=new URL(src.url);
   if(url.protocol!=='https:'||!url.hostname.endsWith('.gov.cn')||url.username||url.password)throw Error();
   row.source=src;
   if(o.status==='read'&&/^[a-f0-9]{64}$/.test(src.sha256)&&typeof o.text==='string'&&o.text.includes(r.passage)){
    const issued=date(src.publishedOn)??date(src.issuedOn);
    Object.assign(row,{passage:r.passage,offset:o.offset+o.text.indexOf(r.passage),unreadAttachments:o.attachmentCount??0,unreadImages:o.inlineImageCount??0});
    const v=r.validity,period=args.target.period,start=row.condition.event??period+'-01',end=row.condition.event??new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5)),0)).toISOString().slice(0,10);
    row.timing=date(src.retrievedAt)&&date(src.retrievedAt)<=args.asOf?'决策日前已读取':'事后取得的官文，历史版本与修订沿革需另核';
    if(!issued||issued>args.asOf)row.state='公布时间未核或晚于决策日';
    else if(!v||!o.text.includes(v.fromPassage)||!datesIn(v.fromPassage).includes(v.from)||
        (v.through||v.throughPassage)&&(!v.through||!v.throughPassage||!o.text.includes(v.throughPassage)||!datesIn(v.throughPassage).includes(v.through))||
        v.through&&v.through<v.from||v.transitionPassage&&!o.text.includes(v.transitionPassage))row.state='生效、失效或过渡条款待核';
    else{
     row.validity=v;
     if(v.from>end||v.through&&v.through<start)row.state='不在该规则适用期间';
     else if(v.from>start||v.through&&v.through<end)row.state='期间内效力变化，须按交易日分段';
     else if(/废止|失效|修改|修订/.test((src.observedStatus??'')+(src.annotation??''))&&!v.transitionPassage)row.state='变更或过渡依据待核';
     else if(row.condition.matched===undefined||typeof r.appliesWhenMatched!=='boolean')row.state='条文已定位，企业适用性待核';
     else row.state=(row.condition.matched===r.appliesWhenMatched?'按所列条件判断适用，待会计复核':'按所列条件判断不适用，待会计复核');
    }
   }else row.state=o.status==='attachment_unread'?'附件正文未读':'引用片段未读或不匹配';
  }catch{/* 保留可查的其他政策和业务分支。 */}
  rows.push(row);
 }
 return rows;
}
function invoiceRows(invoices,evidence,scope,result,args){
 const byRef=new Map();
 for(const row of evidence.facts.filter(r=>['invoice','confirmation'].includes(r.kind)&&!r.issue&&r.data.issuer&&r.data.invoiceNumber)){
  const ref='vat-'+digest([scope.databaseInstanceId,scope.enterpriseKey,scope.accountSetId,row.data.issuer,row.data.invoiceNumber]).slice(0,24);
  byRef.set(ref,{issuer:row.data.issuer,invoiceNumber:row.data.invoiceNumber});
 }
 const choice=result.recommendation?.choice,selection=Object.fromEntries(Object.keys(labels).map(k=>[k,new Map((result.decisions?.[k]??args[k]??[]).map(x=>[x.invoiceRef,x.period]))]));
 return invoices.map(row=>{
  const moves={baseline:selection.baseline.get(row.invoiceRef)??null,plan:selection.plan.get(row.invoiceRef)??null};
  const target=moves[choice]??null;
  const reason=!row.resolved?'票据来源或用途有未决问题':row.fixedPeriod?'沿用原确认所属期':row.eligibility!=='eligible'?'未满足可抵条件':!labels[choice]?'比较方案待选，可选窗口见原件':target?'按'+labels[choice]+'列入 '+target+(target>scope.period?'，延后期间见现金比较':' 所属期'):'推荐方案保留此票，后续结合窗口和应纳复算';
  return {...row,...byRef.get(row.invoiceRef),...moves,recommendedPeriod:row.fixedPeriod??target,reason};
 });
}
function monthlyRows(result,evidence,books,choice){
 const sim=simulation(result,choice);
 const periods=new Set([...(sim?.months??[]).map(r=>r.period),...evidence.facts.filter(f=>!f.issue&&f.kind==='filing').map(f=>f.data.period),result.start]);
 return [...periods].filter(Boolean).sort().map(period=>{
  const m=sim?.months.find(r=>r.period===period)??{},current=period===result.start;
  const filings=evidence.facts.filter(f=>f.kind==='filing'&&!f.issue&&f.data.period===period);
  const boundFilings=filings.filter(f=>f.source.verification==='source_value_bound');
  const replaced=new Set(boundFilings.map(f=>f.data.supersedes).filter(Boolean));
  const amounts=[...new Set(boundFilings.filter(f=>!replaced.has(f.data.receiptId)&&/^\d{1,12}(?:\.\d{1,2})?$/.test(String(f.data.declaredDue))).map(f=>money(cents(String(f.data.declaredDue)))))];
  const declared=amounts.length===1&&(!Object.hasOwn(m,'declaredDue')||m.declaredDue===amounts[0])?amounts[0]:null;
  const output=current?books.taxAccounts.find(r=>r.type==='outputVat')?.amount??null:null;
  const input=current?books.taxAccounts.find(r=>r.type==='inputVat')?.amount??null:null;
  return {...m,period,ledgerOutputVat:output,ledgerInputVat:input,
   outputDifference:difference(output,m.outputVat),inputDifference:difference(input,m.selectedAndFixedInput),
   reportedRevenue:current?books.sales:null,revenueDifference:current?difference(books.sales,m.salesExcludingVat):null,
   filingEvidence:filings.map(f=>f.source),declaredDue:declared,filingDifference:difference(declared,m.due),filingStatus:filings.length?'有独立申报资料，核对回执类型与所属期':'缺申报回执',
   filedAmountConflict:amounts.length>1};
 });
}
async function previousVersion(id,current,root){
 if(!id)return null;
 try{
  const header=JSON.parse(safeFile(join(root,id,'begin.json'),256*1024));
  if(header.tool!=='finance_vat_plan')throw Error();
  const r=await loadRecord(root,id),scope=r.end?.scope,observed=r.end?.metadata?.configuredTarget;
  if(!scope||!scoped(scope,current.scope)||r.integrity!=='verified'||r.end.scopeState!=='observed'||observed?.bindingOrigin!=='existing_database_identity'||observed.period!==scope.period||observed.accountSetId!==scope.accountSetId||scope.period>current.scope.period||r.output?.asOf>current.asOf||r.output?.version!=='finance-vat-planning/1'||r.status!=='returned')throw Error();
  let old=null;
  if(r.output.handoff){
   const bytes=safeFile(join(root,id,handoffFiles.data),48*1024*1024);
   if(hashBytes(bytes)!==r.output.handoff.digests?.data)throw Error();
   old=JSON.parse(bytes);
  }
  const amounts=old?.months??simulation(r.output,r.output.recommendation?.choice??'plan')?.months??[];
  const changes=current.months.map(n=>{
   const o=amounts.find(m=>m.period===n.period);
   return {period:n.period,oldDue:o?.due??null,newDue:n.due??null,dueChange:difference(n.due,o?.due),oldCarry:o?.endingCarryCredit??null,newCarry:n.endingCarryCredit??null,carryChange:difference(n.endingCarryCredit,o?.endingCarryCredit),oldPaymentMonth:o?.paymentMonth??null,newPaymentMonth:n.paymentMonth??null,expectedPaymentChange:difference(n.expectedPayment,o?.expectedPayment)};
  });
  const policyKey=p=>JSON.stringify([p.source?.url,p.question,p.passage,p.validity?.from,p.validity?.through]);
  const oldByUrl=new Map((old?.policy??[]).filter(p=>p.source).map(p=>[policyKey(p),p]));
  const policyChanges=current.policy.map(p=>{const prior=oldByUrl.get(policyKey(p));return {question:p.question,oldState:prior?.state??null,newState:p.state,rawVersionChanged:prior&&p.source?prior.source.sha256!==p.source.sha256:null};});
  const oldSources=new Map((old?.originals??[]).map(s=>[s.path,s.sha256]));
  const sourceChanges=current.originals.filter(s=>oldSources.get(s.path)!==s.sha256).map(s=>({path:s.path,state:oldSources.has(s.path)?'版本改变':'本版新来源'}));
  for(const path of oldSources.keys())if(!current.originals.some(s=>s.path===path))sourceChanges.push({path,state:'本版未采用'});
  const oldCash=new Map((old?.cash??[]).map(r=>[r.paymentMonth,r.netCashOutflow]));
  const newCash=new Map(current.cash.map(r=>[r.paymentMonth,r.netCashOutflow]));
  const cashChanges=[...new Set([...oldCash.keys(),...newCash.keys()])].sort().map(paymentMonth=>({paymentMonth,previous:oldCash.get(paymentMonth)??null,current:newCash.get(paymentMonth)??null,change:difference(newCash.get(paymentMonth),oldCash.get(paymentMonth))}));
  return {cashChanges,callId:id,status:'verified_record',scopePeriod:scope.period,sourceCurrentness:r.sourceCurrentness,basisChanged:r.output.basis!==current.basis,sourceChanges,policyChanges,changes};
 }catch{return {callId:id,status:'版本或账套未核对，未引用前版数据'};}
}
export async function saveVatHandoff(args,result,allInvoices){
 const call=currentFinanceCall();if(!call)return result;
 const evidenceBytes=safeFile(join(call.recordPath,handoffFiles.evidence),48*1024*1024);
 const proposed=Array.isArray(args.baseline)||Array.isArray(args.plan);
 if(!proposed)result={...result,recommendation:null};
 if(!args.handoff&&(!proposed||args.offset>0)){
  return {...result,delivery:'invoice_inventory',evidenceDigest:hashBytes(evidenceBytes),codeDigest:vatCodeVersion()};
 }
 const evidence=JSON.parse(evidenceBytes);
 const {scope,configuredTarget}=call.metadata,bankQueries=[];
 for(const event of result.activity??[]){
  if(!['payment','prepayment','refund_received'].includes(event.eventType))continue;
  const row=evidence.facts.find(f=>f.kind==='event'&&!f.issue&&f.source.verification==='source_value_bound'&&event.sources.some(s=>s.source===f.source.source&&s.table===f.source.table&&s.row===f.source.row));
  if(row)bankQueries.push({eventRef:event.eventRef,receiptId:row.data.eventId,day:event.operationDate.slice(0,10),amount:event.amount,direction:event.eventType==='refund_received'?'inflow':'outflow'});
 }
 const books=bookSnapshot({...configuredTarget,scope},bankQueries);
 const invoices=invoiceRows(allInvoices??result.invoices,evidence,scope,result,args);
 const recommended=result.recommendation?.choice,choice=Object.hasOwn(labels,recommended)?recommended:'plan';
 const sim=simulation(result,choice),policy=await reviewPolicy(args,evidence,call.auditDir);
 const save=(file,bytes)=>{writeFileSync(join(call.recordPath,file),bytes,{flag:'wx',mode:0o600});return hashBytes(bytes);};
 const bookDigest=digest(books),reports={};
 for(const [kind,report] of Object.entries(books.reports)){
  const {csv,...metadata}=report,file=kind+'.csv';
  reports[kind]={file,sha256:save(file,csv),...metadata};
 }
 books.reports=reports;
 const originals=[...new Map(evidence.mappings.map(({source,path,sha256})=>[source,{source,path,sha256}])).values()];
 const pack={version:'vat-accountant-handoff/1',callId:call.callId,scope,asOf:result.asOf,basis:result.basis,through:result.through,status:result.status,
  originals,sourceMappings:evidence.mappings,invoices,inventoryTotal:result.pagination.total,books,bookDigest,bankQueries,policy,formulas:result.rules,
  scenarios:{baseline:simulation(result,'baseline'),plan:simulation(result,'plan')},deltas:result.delta??result.knownSubset?.delta??null,conditions:result.conditions,
  recommendation:result.recommendation??null,displayChoice:choice,months:monthlyRows(result,evidence,books,choice),activities:result.activity??[],cash:(sim?.cashByMonth??[]).map(row=>{
   const has=type=>{
    const relevant=(result.activity??[]).filter(e=>e.eventType===type&&e.operationDate?.slice(0,7)===row.paymentMonth);
    return relevant.length>0&&relevant.every(e=>e.sources.some(s=>s.verification==='source_value_bound'));
   };
   return {...row,observedActualPaid:has('payment')?row.actualPaid:null,observedPrepaid:has('prepayment')?row.prepaid:null,observedRefund:has('refund_received')?row.refundReceived:null};
  }),
  gaps:result.gaps??[],yearEnd:sim?.yearEnd??null,nextYear:sim?.nextYear??null,nextYearUse:sim?.nextYearUse??null,
  yearHistory:{year:result.start.slice(0,4),opening:evidence.facts.filter(f=>!f.issue&&f.kind==='opening'),historic:evidence.facts.filter(f=>!f.issue&&f.kind==='history'),months:[]},
  filingHistory:evidence.facts.filter(f=>!f.issue&&f.kind==='filing'),previous:null};
 for(let month=1;month<=12;month++){
  const period=pack.yearHistory.year+'-'+String(month).padStart(2,'0');
  const history=pack.yearHistory.historic.filter(f=>f.data.period===period);
  const returns=pack.filingHistory.filter(f=>f.data.period===period);
  const payments=pack.activities.filter(a=>a.eventType==='payment'&&a.period===period);
  const simulation=pack.months.find(m=>m.period===period);
  pack.yearHistory.months.push({period,history,returns,payments,simulation:simulation??null,status:history.length?'历史发生额资料':simulation?.basis==='forecast'?'预算或预测':simulation?.basis==='actual'?'本期实际资料基础':returns.length||payments.length?'仅取得申报或收付资料':'缺逐月明细'});
 }
 pack.yearHistory.coverage={
  openingHistoryCheck:result.history?.reason??null,openingSources:result.history?.sources??[],
  observedPeriods:pack.yearHistory.months.filter(m=>m.history.length||m.simulation?.basis==='actual').map(m=>m.period),
  forecastPeriods:pack.yearHistory.months.filter(m=>m.simulation?.basis==='forecast').map(m=>m.period),
  missingHistoricalDetail:pack.yearHistory.months.filter(m=>m.period<result.start&&!m.history.length).map(m=>m.period),
 };
 pack.previous=await previousVersion(args.handoff?.previousCallId,pack,call.auditDir);
 const data=save(handoffFiles.data,JSON.stringify(pack,null,2)+'\n'),report=save(handoffFiles.report,renderVatHandoff(pack)),codeDigest=vatCodeVersion();
 const digests={data,report,evidence:hashBytes(evidenceBytes)};
 annotateFinanceCall({codeDigest,artifactRefs:Object.values(handoffFiles).map(name=>'finance-vat:'+call.callId+'/'+name)});
 return {...result,codeDigest,handoff:{version:pack.version,digests,bookDigest,reportPath:join(call.recordPath,handoffFiles.report),dataPath:join(call.recordPath,handoffFiles.data),previousCallId:pack.previous?.status==='verified_record'?pack.previous.callId:null}};
}
