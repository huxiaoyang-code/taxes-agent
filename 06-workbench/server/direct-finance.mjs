// 直接业务适配：复用固定中国核算模块，不经过 Harness 的事实、任务或依赖图。
import { mkdirSync, writeFileSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadAgencyMaterials, buildAgencyWorkpaper, buildAgencyAnnualWorkpaper } from './agency-business.mjs';
import { readAgencySession, agencyEvidenceArchiveRecords } from './agency-business-evidence.mjs';
import { listAgencyRules, getAgencyRuleDetail, resolveAgencyRuleTrace } from './agency-rule-catalog.mjs';
import { validateDirectInput, DIRECT_RECORD, directRecordContract } from './direct-finance-contracts.mjs';
import { currentFinanceCall, financeAuditDirectory, annotateFinanceCall } from './finance-call-chain.mjs';
import { PROJECTION_NUMBER_LIMIT } from './finance-output-policy.mjs';
import { resolveDirectFinanceTarget } from './direct-finance-target.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,details)=>{throw Object.assign(new Error(code),{code,details});};
const json=value=>JSON.stringify(value,null,2)+'\n';
function newArtifact(){const call=currentFinanceCall(),id=call?.callId??randomUUID(),root=resolve(call?.auditDir??financeAuditDirectory()),dir=join(root,'artifacts',id);mkdirSync(dir,{recursive:true});return {id,dir,ref:`finance-artifact:${id}`};}
function save(artifact,name,value){const bytes=Buffer.from(json(value));writeFileSync(join(artifact.dir,name),bytes,{flag:'wx'});return {artifactRef:`${artifact.ref}/${name}`,sha256:hash(bytes),bytes:bytes.length};}
function absoluteFile(path){if(!isAbsolute(path))fail('finance_absolute_path_required');const p=resolve(path),s=lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>5*1024*1024||realpathSync(p).toLowerCase()!==p.toLowerCase())fail('finance_source_path_rejected');return p;}
function validateRecords(records){for(const [index,record] of records.entries())try{validateDirectInput(DIRECT_RECORD,record);}catch(error){if(error.details?.problems)error.details.problems=error.details.problems.map(p=>({...p,inputPointer:`/records/${index}${p.inputPointer}`,field:`arguments/records/${index}${p.inputPointer}`}));throw error;}}
function loadInput(args,artifact){
 let manifestPath;
 if(args.manifestPath){manifestPath=absoluteFile(args.manifestPath);const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));for(const s of manifest.sources??[]){const p=isAbsolute(s.path)?s.path:resolve(dirname(manifestPath),s.path);const raw=JSON.parse(readFileSync(absoluteFile(p),'utf8'));validateRecords(raw.records??[]);}}
 else{
  const binding=args.target?resolveDirectFinanceTarget(args.target,args.dbPath):null,scope=binding?.scope??args.scope;
  const records=args.records.map(record=>{if(!binding&&record.enterpriseKey===undefined)fail('finance_record_scope_required');if(record.enterpriseKey!==undefined&&record.enterpriseKey!==scope.enterpriseKey)fail('finance_record_scope_conflict');return {...record,enterpriseKey:scope.enterpriseKey};});
  validateRecords(records);
  if(binding){save(artifact,'target-binding.json',{scope,bindingOrigin:binding.bindingOrigin,meaning:'内部企业/实例ID来自现库绑定，不声称客户原件提供内部ID。'});annotateFinanceCall({scope,configuredTarget:{databasePath:binding.dbPath,accountSetId:scope.accountSetId,period:scope.period,bindingOrigin:binding.bindingOrigin}});}
  const originals=args.originals.map(o=>({...o,path:absoluteFile(o.path)}));
  const raw={version:'agency-raw-facts/1',scope,records};
  const source=save(artifact,'business-input.json',raw);
  const manifest={version:'agency-business-materials/1',scope,originals,sources:[{path:join(artifact.dir,'business-input.json'),sha256:source.sha256}]};
  save(artifact,'manifest.json',manifest);manifestPath=join(artifact.dir,'manifest.json');
 }
 const session=loadAgencyMaterials(manifestPath);
 validateRecords(readAgencySession(session).records.map(({sourceRefs,...record})=>record));
 // 原件、适配输入和固定代码均保存字节快照；索引只供本机人工核验。
 const evidence=agencyEvidenceArchiveRecords(session),snapshotDir=join(artifact.dir,'evidence');mkdirSync(snapshotDir);
 const index=evidence.map((e,i)=>{const name=`${i}.blob`;writeFileSync(join(snapshotDir,name),e.bytes,{flag:'wx'});return {originalPath:e.name,snapshot:`evidence/${name}`,sha256:hash(e.bytes),bytes:e.bytes.length};});
 save(artifact,'evidence-index.json',{version:'finance-evidence-index/1',files:index});
 const loaded=session.sourceRefs.map(ref=>({path:ref.locator,locator:'native_material_file',sha256:ref.digest,bytes:index.find(f=>f.originalPath===ref.locator)?.bytes??null}));
 const before=currentFinanceCall()?.metadata?.sources??[];annotateFinanceCall({sources:[...new Map([...before,...loaded].map(s=>[`${s.path}:${s.sha256}`,s])).values()]});
 return session;
}
const sumMoney=values=>{let n=0n;for(const v of values){if(typeof v!=='string'||!/^[-]?\d+\.\d{2}$/.test(v))return null;const neg=v.startsWith('-'),s=neg?v.slice(1):v;n+=(neg?-1n:1n)*BigInt(s.replace('.',''));}const sign=n<0n?'-':'';if(n<0n)n=-n;return `${sign}${n/100n}.${String(n%100n).padStart(2,'0')}`;};
// 与既有模型通道一致：只选择固定字段和有限数值；原名、原文、来源路径、逐笔分录不外发。
const modelMoney=value=>{if(value===null||value===undefined)return null;const n=typeof value==='string'&&/^-?\d+(\.\d{1,2})?$/.test(value)?Number(value):NaN;return Number.isFinite(n)&&Math.abs(n)<=PROJECTION_NUMBER_LIMIT?n:null;};
function roleAmount(accounting,role,{flow=false,credit=false}={}){const draft=accounting.reportDraftInputs,code=draft?.accountRoles?.[role],rows=flow?draft?.incomeAmounts:draft?.amounts;if(!code||!Array.isArray(rows))return null;const selected=rows.filter(row=>row.code===code||row.code.startsWith(code));if(!selected.length)return null;let total=0n;for(const row of selected)total+=BigInt(row.netMinor);if(credit)total=-total;const n=Number(total)/100;return Number.isFinite(n)&&Math.abs(n)<=PROJECTION_NUMBER_LIMIT?n:null;}
function taxSummary(obligations,ids){return (obligations??[]).filter(o=>!ids||ids.includes(o.obligationId)).map(o=>({obligationId:o.obligationId,status:o.status,...Object.fromEntries(['due','paid','difference'].filter(k=>Object.hasOwn(o,k)).map(k=>[k,modelMoney(o[k])])),...(Object.hasOwn(o,'paymentState')?{paymentState:o.paymentState}:{}),evidenceState:o.status==='ready'?'native_calculated':'check_native_status'}));}
const cell=value=>String(value??'未知').replaceAll('|','\\|').replaceAll('\n',' ');
function humanReport(w,artifact,{annual=false,ruleSelection}={}){
 const a=w.accounting??{},vouchers=annual?[...(a.historicalVouchers??[]),...(a.vouchers??[])]:a.vouchers??[],out=['# 账目与税费核对','',`期间：${cell(w.scope?.period)}；CNY，金额单位元。以下为原生工作底稿和凭证草稿，未正式过账。`,'',`计算重放范围：${cell(a.replayFrom)} 至 ${cell(w.scope?.period)}；账务覆盖：${a.accountingCoverageVerified===true?'已声明覆盖（仅题定范围）':'未完成'}；全年覆盖：${a.yearCoverageVerified===true?'已声明覆盖':'未完成'}。`,'','## 账本金额','','| 项目 | 原生计算金额 |','|---|---:|',`| 库存成本（存在库存行时的合计） | ${(a.inventory??[]).length?sumMoney(a.inventory.map(i=>i.cost)):'未知，原生未列库存行'} |`,`| 重放范围累计收入 | ${cell(a.yearRevenue)} |`,`| 重放范围累计利润 | ${cell(a.yearProfitBeforeTax)} |`,`| 主营业务成本（重放范围累计） | ${cell(roleAmount(a,'mainCost',{flow:true}))} |`,`| 应收账款（已给记录草稿） | ${cell(roleAmount(a,'receivable'))} |`,`| 应付账款（已给记录草稿，含费用往来） | ${cell(roleAmount(a,'payable',{credit:true}))} |`,`| 银行存款（已给记录草稿） | ${cell(roleAmount(a,'bank'))} |`,`| 销售费用（重放范围累计） | ${cell(roleAmount(a,'salesExpense',{flow:true}))} |`,'','空行或缺件不代表现实为零；累计字段不得冒充单月数。金额来自该profile的原生accountRoles，不以题库硬编码科目。','','| 科目 | 科目名称 | 草稿借方净额（元） |','|---|---|---:|',...(a.reportDraftInputs?.amounts??[]).map(row=>`| ${cell(row.code)} | ${cell(a.reportDraftInputs.accounts.find(c=>c.code===row.code)?.name)} | ${(row.netMinor/100).toFixed(2)} |`),'','| 商品 | 期末数量（百万分之一单位） | 成本 |','|---|---:|---:|',...(a.inventory??[]).map(i=>`| ${cell(i.itemId)} | ${cell(i.quantityUnits)} | ${cell(i.cost)} |`),'','## 凭证与计算结果','',`凭证范围：${annual?'全部已提供年度月份':'当前计算月'}；共${vouchers.length}份草稿。来源和原件位置可沿 factId/sourceRefs 在 workpaper.json 核对。`,'','| 业务 | 日期 | 分录 |','|---|---|---|'];
 for(const v of vouchers)out.push(`| ${cell(v.factId)} | ${cell(v.date)} | ${(v.entries??[]).map(e=>`${cell(e.code??e.accountCode)} 借${cell(e.debit)} / 贷${cell(e.credit)}`).join('；')} |`);
 out.push('','| 税费 | 状态 | 应纳 | 实缴（仅工具已登记证据） | 差额 |','|---|---|---:|---:|---:|',...(w.obligations??[]).map(o=>`| ${cell(o.obligationId)} | ${cell(o.status)} | ${Object.hasOwn(o,'due')?cell(o.due):'未知，未返回'} | ${Object.hasOwn(o,'paid')?cell(o.paid):'未知，未返回'} | ${Object.hasOwn(o,'difference')?cell(o.difference):'未知，未返回'} |`),'','## 规则依据','');
 if(w.yearEndAdjustments!==undefined)out.splice(out.indexOf('## 规则依据'),0,'### 年度调整与次年承接','',`原生年度状态：${cell(w.status)}；以下为计算草稿，不代表年度关账或正式汇算已完成。`,'','```json',JSON.stringify({yearEndAdjustments:w.yearEndAdjustments,adjustments:w.adjustments,nextYearCarryState:w.nextYearCarryState},null,2),'```','');
 const calculationSections=[];for(const o of w.obligations??[]){const values=Object.fromEntries(Object.entries(o).filter(([k])=>!['obligationId','status','sourceRefs','sources','reason'].includes(k)));calculationSections.push(`### ${cell(o.obligationId)}：${cell(o.status)}`,'',cell(o.reason),'','原生计算字段（原样展示；缺字段不补额）：','```json',JSON.stringify(values,null,2),'```','');}
 if(w.taxWorkpaper??w.adjustments)calculationSections.push('### 所得税利润与调整底稿','```json',JSON.stringify(w.taxWorkpaper??w.adjustments,null,2),'```','');
 out.splice(out.indexOf('## 规则依据'),0,...calculationSections);
 for(const rule of (ruleSelection??w.ruleSelection)?.trace??[]){out.push(`- ${cell(rule.ruleId)}：${cell(rule.state)}。${cell(rule.reason)}`);try{const detail=getAgencyRuleDetail(rule.ruleId,rule.revision??'1').rule;for(const s of detail.sources??[])out.push(`  - ${cell(s.title)}：${cell(s.locator??'')} ${s.url??''}`);}catch{}}
 out.push('','## 待核与缺件','',...(w.issues??[]).map(i=>`- ${cell(i.code)}：${cell(i.request??i.reason)}（业务 ${cell(i.factId)}）`),'','## 深入核查：调用和输入原件','',`- 调用：${artifact.id}`,'- 完整原生结果：[workpaper.json](workpaper.json)','- 原件/适配输入/代码快照索引：[evidence-index.json](evidence-index.json)','- 文件摘要只证明对应字节版本，不能证明原件真实性或模型语义判断正确。');
 writeFileSync(join(artifact.dir,'review.md'),out.join('\n')+'\n',{flag:'wx'});
}
function workpaperSummary(workpaper,artifact,ids,{annual=false,ruleSelection,codeDigest}={}){
 const a=workpaper.accounting??{},full=save(artifact,'workpaper.json',workpaper),issues=workpaper.issues??[];
 const allRules=(ruleSelection??workpaper.ruleSelection)?.trace??[],actualCodeDigest=codeDigest??workpaper.codeDigest??null;
 humanReport(workpaper,artifact,{annual,ruleSelection});
 if(ruleSelection)save(artifact,'adapter-result.json',{version:'finance-native-adaptation/1',nativeResultRef:full.artifactRef,nativeContentDigest:workpaper.contentDigest??null,nativeContentDigestScope:'native_workpaper_without_contentDigest_property',ruleSelection,codeDigest:actualCodeDigest});
 annotateFinanceCall({scope:workpaper.scope,ruleVersion:workpaper.ruleVersion??null,codeDigest:actualCodeDigest,catalogDigest:workpaper.ruleCatalogDigest??null,artifactRefs:[full.artifactRef,`${artifact.ref}/review.md`,`${artifact.ref}/evidence-index.json`]});
 return {version:'finance-business-result/1',status:issues.length?'partial':'calculated_draft',resultOrigin:'native_engine',currency:'CNY',unit:'yuan',period:workpaper.scope?.period??null,
  ledgerAmounts:{inventory:(a.inventory??[]).length?modelMoney(sumMoney(a.inventory.map(i=>i.cost))):null,revenue:modelMoney(a.yearRevenue),profitBeforeTax:modelMoney(a.yearProfitBeforeTax),mainCost:roleAmount(a,'mainCost',{flow:true}),receivable:roleAmount(a,'receivable'),payable:roleAmount(a,'payable',{credit:true}),bank:roleAmount(a,'bank'),salesExpense:roleAmount(a,'salesExpense',{flow:true}),outputVat:(a.vatTransactions??[]).length?modelMoney(sumMoney(a.vatTransactions.map(v=>v.tax))):null,replayFrom:a.replayFrom??null,through:workpaper.scope?.period??null,coverageVerified:a.accountingCoverageVerified===true,scopeMeaning:'replay_range_cumulative_not_single_month'},
  vouchers:{count:(a.vouchers??[]).length+(annual?(a.historicalVouchers??[]).length:0),scope:annual?'provided_annual_months':'current_month',state:'draft',posted:false,detailRef:full.artifactRef},
  calculationResults:{taxes:taxSummary(workpaper.obligations,ids),amountMeaning:'obligations.due为原生应纳；交易VAT与凭证进项不代表已完成法定抵扣审核。'},
  rules:{ruleVersion:workpaper.ruleVersion??null,codeDigest:actualCodeDigest,catalogDigest:workpaper.ruleCatalogDigest??null,trace:allRules.map(r=>({ruleId:r.ruleId,state:r.state,calculationStatus:r.calculationStatus??null,composedRuleIds:r.composedRuleIds??[r.ruleId]}))},
  modelBoundary:{mode:'fixed_business_projection',rawValues:'local_only',numberLimit:PROJECTION_NUMBER_LIMIT,unknownAmounts:'null_or_absent'},
  review:{accountantApproval:workpaper.accountantApproval??'pending',submittable:workpaper.submittable??false,periodComplete:workpaper.periodComplete??false,issueCount:issues.length,issues:issues.map(i=>({code:i.code,state:i.state??'missing'}))},
  evidence:{result:full,callRef:currentFinanceCall()?.callId??null,indexRef:`${artifact.ref}/evidence-index.json`,humanReviewRef:`${artifact.ref}/review.md`,sourceSemantics:'原件哈希和位置匹配不证明模型提取含义正确；完整原值仅留本机。'}};
}
export async function callDirectFinanceTool(name,args){
 if(name==='finance_record_contract')return directRecordContract(args.recordType);
 if(name==='finance_rules'){const result=args.ruleId?getAgencyRuleDetail(args.ruleId,args.revision??'1'):listAgencyRules(args.filters??{});annotateFinanceCall({ruleVersion:result.version,catalogDigest:result.catalogDigest});return result;}
 if(name==='finance_workpaper'||name==='finance_tax_calculate'){
  const artifact=newArtifact(),session=loadInput(args,artifact),dbPath=args.dbPath??(args.target?process.env.FINANCE_DATABASE_PATH:undefined),workpaper=buildAgencyWorkpaper(session,{...(dbPath?{dbPath}:{})});
  return workpaperSummary(workpaper,artifact,name==='finance_tax_calculate'?args.obligationIds:undefined);
 }
 if(name==='finance_annual_workpaper'){
  const artifact=newArtifact(),sessions=args.manifestPaths.map((manifestPath,index)=>{const child={...artifact,dir:join(artifact.dir,`month-${index}`)};mkdirSync(child.dir);return loadInput({manifestPath},child);});
  const result=await buildAgencyAnnualWorkpaper(sessions,{...(args.dbPath?{dbPath:args.dbPath}:{})});
  const documents=sessions.map(readAgencySession),records=[...new Map(documents.flatMap(d=>d.records).map(r=>[r.id,r])).values()];
  const ruleSelection=resolveAgencyRuleTrace({scope:result.scope,entity:documents[0].entity,records,obligations:result.obligations,accounting:result.accounting}),codeDigests=[...new Set(result.dependencies.filter(d=>d.codeDigest).map(d=>d.codeDigest))];
  const index=sessions.flatMap((_,i)=>JSON.parse(readFileSync(join(artifact.dir,`month-${i}`,'evidence-index.json'),'utf8')).files.map(f=>({...f,snapshot:`month-${i}/${f.snapshot}`})));
  save(artifact,'evidence-index.json',{version:'finance-evidence-index/1',files:index});
  const summary=workpaperSummary(result,artifact,undefined,{annual:true,ruleSelection,codeDigest:codeDigests.length===1?codeDigests[0]:null});return {...summary,version:'finance-annual-result/1',status:result.status,period:readAgencySession(sessions[0]).scope.period.slice(0,4),annualCalculation:{status:result.status,yearEndAdjustmentsPresent:result.yearEndAdjustments!==undefined,nextYearCarryPresent:result.nextYearCarryState!==undefined}};
 }
 fail('finance_direct_tool_unknown');
}
