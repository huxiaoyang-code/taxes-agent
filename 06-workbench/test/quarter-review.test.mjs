import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureBusinessEvidence,captureEvidenceSource,summaryBusinessEvidence} from '../server/business-evidence.mjs';
import {withFinanceCall,listFinanceCalls,readFinanceCall,annotateFinanceCall} from '../server/finance-call-chain.mjs';
import {buildQuarterCashFlow,SMALL_CASH_FLOW_ITEMS} from '../server/quarter-cash-flow.mjs';
import {registerWorkpaperDetails,workpaperDetails} from '../server/direct-finance-details.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {resolveDirectFinanceTarget as resolveTarget,nativeVoucherObservation} from '../server/direct-finance-target.mjs';
import {buildQuarterReview,renderQuarterReview} from '../server/quarter-review.mjs';
const root=mkdtempSync(join(tmpdir(),'quarter-review-synthetic-')); const originals=join(root,'originals');mkdirSync(originals);process.env.FINANCE_SOURCE_ROOT=originals;
const path=join(originals,'合同.csv');writeFileSync(path,'合同编号,不含税金额（元）,税额（元）,价税合计（元）\n合同一,100000,13000,113000\n');
const mapping=(column='不含税金额（元）')=>({inputPointer:'/inputs/amountIncludingVat',parameterLabel:'净价',transform:'identity',sources:[{path,row:2,column}]});
const evidence=mappings=>({businessLabel:'买卖合同计税',method:'核对合同列示金额',mappings});
test('净价错填含税时必须显露实际目标含义和完整原始行，数值一致不代表语义正确',()=>{
 const e=captureBusinessEvidence({inputs:{amountIncludingVat:100000}},evidence([mapping()]));
 assert.equal(e.mappings[0].target.label,'含税合同金额');assert.equal(e.mappings[0].parameterLabel,'净价');assert.equal(e.mappings[0].valueMatched,true);assert.equal(e.semanticStatus,'unreviewed');assert.deepEqual(e.mappings[0].sources[0].rows[0].values,['合同一','100000','13000','113000']);
});
test('原值不符在业务执行前拒绝且保留证据；基础校验拒绝优先于原件读取',async()=>{
 const auditDir=join(root,'audit');let executed=false;
 await assert.rejects(withFinanceCall({auditDir,tool:'voucher_create',args:{inputs:{amountIncludingVat:113000},businessEvidence:evidence([mapping()])}},async()=>{executed=true;}),{code:'finance_evidence_value_mismatch'});assert.equal(executed,false);
 const index=await listFinanceCalls({auditDir});const record=await readFinanceCall({auditDir,callId:index.calls[0].callId});assert.equal(record.status,'failed');assert.ok(record.end.metadata.businessEvidence);
 await assert.rejects(withFinanceCall({auditDir,tool:'unknown',args:{businessEvidence:{mappings:[{sources:[{path:'Z:/none.csv'}]}]}},validate:()=>{throw Object.assign(Error('非法工具'),{code:'unknown_tool'});}},async()=>{executed=true;}),{code:'unknown_tool'});assert.equal(executed,false);
});
test('链接、越界、表头顺序和重复字段不能绕过明确来源',()=>{
 const outside=join(root,'outside.csv');writeFileSync(outside,'a\n1\n');assert.throws(()=>captureEvidenceSource({path:outside,row:2,column:1}),{code:'finance_evidence_path_forbidden'});

 assert.throws(()=>captureEvidenceSource({path,row:2,column:1,headerRows:[2,1]}),{code:'finance_evidence_header_order'});
 const dup=join(originals,'重复.csv');writeFileSync(dup,'金额,金额\n1,2\n');assert.throws(()=>captureEvidenceSource({path:dup,row:2,column:'金额'}),{code:'finance_evidence_header_ambiguous'});
});
test('硬链接原件在文件系统支持时拒绝读取',t=>{const base=join(root,'link-target.csv'),hard=join(originals,'hard.csv');writeFileSync(base,'金额\n1\n');try{linkSync(base,hard);}catch(e){if(['EPERM','ENOTSUP','EACCES'].includes(e.code)){t.skip('当前文件系统禁止创建硬链接；越界及非链接路径负例另测。');return;}throw e;}assert.throws(()=>captureEvidenceSource({path:hard,row:2,column:1}),{code:'finance_evidence_path_forbidden'});});
test('已有汇总原件bindings自动展开，不额外要求重复审计输入',()=>{
 const p=join(originals,'税费.json');writeFileSync(p,JSON.stringify({合同:{价税合计:113000}}));const args={inputs:{amountIncludingVat:113000},originals:[{id:'合同',path:p}],bindings:[{inputPointer:'/amountIncludingVat',originalId:'合同',locator:{jsonPointer:'/合同/价税合计'}}]};const e=captureBusinessEvidence(args,summaryBusinessEvidence(args));assert.equal(e.mappings[0].actualValue,113000);assert.deepEqual(e.mappings[0].sources[0].headers,[['价税合计']]);
});
function cashFixture(){const entries=[{voucher_id:1,period:'2026-01',status:'posted',code:'2202',debit:63560,credit:0},{voucher_id:1,period:'2026-01',status:'posted',code:'1002',debit:0,credit:63560}];const periods=['2026-01','2026-02','2026-03'];return {periods,entries,months:periods.map((period,i)=>({period,reports:{'trial-balance':{data:{lines:[{code:'1002',opening_debit:i?36440:100000,opening_credit:0,closing_debit:36440,closing_credit:0}]}}}}))};}
const source=n=>[{sha256:'a'.repeat(64),location:'第'+n+'行'}];
test('同一供应商收付按原件拆设备和货款，缺分类/重复分配不自动净额或归经营',()=>{
 const s=cashFixture(),allocations=[{item:SMALL_CASH_FLOW_ITEMS[2][0],amount:50000,valueMatched:true,sources:source(1)},{item:SMALL_CASH_FLOW_ITEMS[11][0],amount:13560,valueMatched:true,sources:source(2)}];const g=[{accepted:true,voucherId:1,evidence:{cashFlowAllocations:allocations}}];const cf=buildQuarterCashFlow(s,g);assert.equal(cf.quarter.rows.length,22);assert.equal(cf.quarter.rows[2].value,50000);assert.equal(cf.quarter.rows[11].value,13560);assert.equal(cf.quarter.rows[20].value,100000);assert.equal(cf.quarter.rows[21].value,36440);assert.equal(cf.quarter.ledgerDifference,0);assert.equal(cf.quarter.complete,true);
 const missing=buildQuarterCashFlow(s,[]);assert.equal(missing.quarter.complete,false);assert.equal(missing.quarter.unknownOutgoing,63560);assert.equal(missing.quarter.rows[2].value,0);
 allocations[1].sources=source(1);assert.equal(buildQuarterCashFlow(s,g).quarter.complete,false);
});
test('实际临时账库一致快照产生中文四表，月度不是累计，未结账不能全绿',async()=>{
 const data=join(root,'ledger');mkdirSync(data);process.env.WORKBENCH_DATA_DIR=data;process.env.FINANCE_DATABASE_PATH=join(data,'workbench.db');const {db}=await import('../server/db.mjs');const A=await import('../server/accounting.mjs');
 try{const id=A.createAccountSet({enterprise:{enterpriseKey:'SYNTHETIC-QUARTER-ONLY'},name:'中文业务账套',start_period:'2026-01',accounting_standard:'小企业会计准则'}).id;A.setOpeningBalances(id,[{code:'1002',debit:100000,credit:0},{code:'3001',debit:0,credit:100000}]);
 for(const [period,amount]of [['2026-01',100],['2026-02',200],['2026-03',300]]){const originalPath=join(originals,period+'.json');writeFileSync(originalPath,JSON.stringify({收款:amount}));const sources=[{path:originalPath,jsonPointer:'/收款'}],args={accountSetId:id,period,status:'posted',entries:[{code:'1002',debit:amount,credit:0},{code:'5001',debit:0,credit:amount}],businessEvidence:{businessLabel:'销售收款',method:'按交付及收款记录入账',mappings:[{inputPointer:'/entries/0/debit',parameterLabel:'收款金额',sources,transform:'identity'}],cashFlowAllocations:[{item:SMALL_CASH_FLOW_ITEMS[0][0],amount,sources,reason:'销售商品实际收款'}]}};
 await withFinanceCall({tool:'voucher_create',args,auditDir:join(root,'audit-ledger')},()=>{const result=A.createVoucher(id,args);annotateFinanceCall({scope:resolveTarget({accountSetId:id,period}).scope});return {ok:true,projection:{voucherId:result.id}};});A.carryForwardProfit(id,period);}
 A.createVoucher(id,{period:'2026-01',status:'posted',entries:[{code:'1122',debit:1,credit:0},{code:'2202',debit:0,credit:1}]});
 const result=await buildQuarterReview({target:{accountSetId:id,period:'2026-03'},auditDir:join(root,'audit-ledger'),outputDir:join(root,'reports')});const bundle=JSON.parse(readFileSync(result.bundleRef,'utf8'));
 assert.deepEqual(bundle.sheets.find(s=>s.name==='利润表').rows.find(r=>r[0]==='营业收入').slice(1),[100,200,300,600]);assert.equal(bundle.sheets.filter(s=>s.name==='科目余额表').length,1);assert.equal(bundle.evidenceGroups.filter(g=>g.accepted&&g.voucherId).length,3);assert.equal(bundle.cashFlow.quarter.complete,true);assert.equal(bundle.cashFlow.quarter.rows[0].value,600);assert.ok(bundle.checks.some(c=>c.label==='月末结账状态'&&c.status==='未完成'));assert.ok(bundle.checks.some(c=>c.label==='业务凭证字段映射覆盖'&&c.status==='需要处理'));
 const table=bundle.months[0].preClose.lines.find(r=>r.code==='5001');assert.equal(table.closing_credit,100);assert.equal(bundle.months[0].reports['trial-balance'].data.lines.find(r=>r.code==='5001').closing_credit,0);
 bundle.accountSet.name='<script>alert(1)</script>';const html=renderQuarterReview(bundle);assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('现金流量表'));


 assert.equal(createHash('sha256').update(readFileSync(result.bundleRef)).digest('hex'),result.bundleSha256);assert.equal(readFileSync(result.bundleRef).length,result.bundleBytes);
 const periodPath=join(originals,'仅期间.json');writeFileSync(periodPath,JSON.stringify({期间:'2026-03'}));const partialArgs={accountSetId:id,period:'2026-03',status:'posted',entries:[{code:'1122',debit:999999,credit:0},{code:'5001',debit:0,credit:999999}],businessEvidence:{businessLabel:'仅映射期间不足以覆盖整凭证',method:'业务方法',mappings:[{inputPointer:'/period',parameterLabel:'期间',transform:'identity',sources:[{path:periodPath,jsonPointer:'/期间'}]}]}};
 await withFinanceCall({tool:'voucher_create',args:partialArgs,auditDir:join(root,'audit-ledger')},()=>{const v=A.createVoucher(id,partialArgs);annotateFinanceCall({scope:resolveTarget({accountSetId:id,period:'2026-03'}).scope});return {ok:true,projection:{voucherId:v.id}};});
 const partial=JSON.parse(readFileSync((await buildQuarterReview({target:{accountSetId:id,period:'2026-03'},auditDir:join(root,'audit-ledger'),outputDir:join(root,'reports')})).bundleRef,'utf8'));const group=partial.evidenceGroups.find(g=>g.evidence.businessLabel==='仅映射期间不足以覆盖整凭证');assert.equal(group.voucherCoverage.complete,false);assert.equal(group.voucherCoverage.fields.filter(f=>f.covered).length,0);assert.ok(partial.sheets.find(s=>s.name==='凭证参数覆盖').rows.some(r=>r[3]==='999999'&&r[4]==='缺少依据'));
 const fakeArgs={...partialArgs,businessEvidence:{...partialArgs.businessEvidence,businessLabel:'旧账库证据'}};await withFinanceCall({tool:'voucher_create',args:fakeArgs,auditDir:join(root,'audit-ledger')},()=>{const v=A.createVoucher(id,fakeArgs);annotateFinanceCall({scope:{...resolveTarget({accountSetId:id,period:'2026-03'}).scope,databaseInstanceId:'old-database-instance',enterpriseKey:'OLD-ENTERPRISE'}});return {ok:true,projection:{voucherId:v.id}};});
 const filtered=JSON.parse(readFileSync((await buildQuarterReview({target:{accountSetId:id,period:'2026-03'},auditDir:join(root,'audit-ledger'),outputDir:join(root,'reports')})).bundleRef,'utf8'));assert.equal(filtered.evidenceGroups.some(g=>g.evidence.businessLabel==='旧账库证据'),false);
 const {withRequestMetadata}=await import('../server/local-audit-coordinator.mjs');const operationId=randomUUID(),startedAt=new Date().toISOString(),native=withRequestMetadata({operationId},()=>A.createVoucher(id,{period:'2026-03',entries:[{code:'1122',debit:10,credit:0},{code:'5001',debit:0,credit:10}]})),observed=resolveTarget({accountSetId:id,period:'2026-03'});assert.equal(nativeVoucherObservation(observed,{operationId,voucherId:native.id,startedAt}),true,JSON.stringify({operationId,id:native.id,startedAt,row:db.prepare('SELECT operation_id,prepared_at FROM audit_operations ORDER BY prepared_at DESC LIMIT 1').get()}));assert.equal(nativeVoucherObservation(observed,{operationId:randomUUID(),voucherId:native.id,startedAt}),false);assert.equal(nativeVoucherObservation(observed,{operationId,voucherId:native.id,startedAt:'2099-01-01T00:00:00.000Z'}),false);
 const {resolveDirectFinanceTarget}=await import('../server/direct-finance-target.mjs');const scope=resolveDirectFinanceTarget({accountSetId:id,period:'2026-03'}).scope,detailDir=join(root,'detail');mkdirSync(detailDir);const detailPath=join(detailDir,'workpaper.json'),content='原生计算固定快照';writeFileSync(detailPath,content);const digest=createHash('sha256').update(content).digest('hex'),ref='finance-artifact:unit-projection/workpaper.json';
 await withFinanceCall({tool:'finance_workpaper',args:{},auditDir:join(root,'audit-details')},()=>{annotateFinanceCall({configuredTarget:{databasePath:process.env.FINANCE_DATABASE_PATH}});registerWorkpaperDetails({workpaper:{scope,accounting:{vouchers:[{factId:'PRIVATE-SOURCE-ID',date:'2026-03-01',period:'2026-03',summary:'PRIVATE-RAW-TEXT',entries:[{code:'1002',debit:'100.00',credit:'0.00'}]}]}},artifact:{dir:detailDir},descriptor:{artifactRef:ref,sha256:digest},records:[{id:'PRIVATE-SOURCE-ID'}]});return {};});
 const request={target:{accountSetId:id,period:'2026-03'},artifactRef:ref,section:'vouchers',limit:1},detail=workpaperDetails(request);assert.equal(detail.rows[0].sourceRecordIndex,0);assert.equal(detail.rows[0].entries[0].debit,100);assert.equal(JSON.stringify(detail).includes('PRIVATE-'),false);assert.equal(detail.posted,false);
 assert.throws(()=>workpaperDetails({...request,artifactRef:'finance-artifact:forged/workpaper.json'}),{code:'finance_details_reference_untrusted'});assert.throws(()=>workpaperDetails({...request,target:{accountSetId:id,period:'2026-02'}}),{code:'finance_details_scope_conflict'});assert.throws(()=>workpaperDetails({...request,limit:51}),{code:'finance_details_page_invalid'});
 writeFileSync(detailPath,'篡改');assert.throws(()=>workpaperDetails(request),{code:'finance_details_artifact_changed'});writeFileSync(detailPath,content);const originalNow=Date.now;try{Date.now=()=>originalNow()+3600001;assert.throws(()=>workpaperDetails(request),{code:'finance_details_reference_expired'});}finally{Date.now=originalNow;}
 const emptyId=A.createAccountSet({enterprise:{enterpriseKey:'SYNTHETIC-EMPTY-QUARTER'},name:'空账',start_period:'2026-01'}).id,emptyReport=JSON.parse(readFileSync((await buildQuarterReview({target:{accountSetId:emptyId,period:'2026-03'},auditDir:join(root,'empty-audit'),outputDir:join(root,'reports')})).bundleRef,'utf8'));assert.equal(emptyReport.checks.find(c=>c.label==='业务凭证字段映射覆盖').status,'无法判断');
 }finally{db.close();}
});


test('人读页面区分原生计算字段与上游原件表头',()=>{
 const raw=captureEvidenceSource({path,row:2,column:'不含税金额（元）'}),derived={kind:'native_calculation',fileName:'原生结果',location:'第1份草稿，第1条分录',selectedValue:100000,headers:[['科目','借方金额']],rows:[{values:['5401',100000]}],calculation:{ruleSources:[]},upstreamMappings:[{target:{label:'不含税金额'},actualValue:100000,sources:[raw]}]};
 const bundle={accountSet:{name:'中文企业'},periods:['2026-01','2026-02','2026-03'],evidenceGroups:[{businessReference:'2026-03 记-001',accepted:true,evidence:{businessLabel:'结转成本',method:'原生计算',rules:[],mappings:[{target:{label:'分录借方金额',accountCode:'5401'},parameterLabel:'成本',actualValue:100000,transform:'identity',valueMatched:true,sources:[derived]}]},voucherBinding:'实际凭证已关联'}],sheets:[{name:'复核总览',title:'复核总览',columns:['项目'],rows:[['待核']],notes:[]},{name:'科目余额表',title:'科目余额表',columns:['科目'],rows:[],notes:[]}]};
 const html=renderQuarterReview(bundle),calculationSection=html.split('原生计算结果字段（非原件）')[1].split('计算时的输入选择')[0];assert(html.includes('采用的计算金额'));assert(!calculationSection.includes('原始表头'));assert(!calculationSection.includes('选取原值'));assert(html.includes('原始表头第1层'));assert(html.includes('不含税金额（元）'));
});
