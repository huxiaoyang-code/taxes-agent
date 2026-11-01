import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,renameSync,symlinkSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {syntheticVoucherEvidence} from './helpers/synthetic-posting-evidence.mjs';
import {spawnSync} from 'node:child_process';
const dataDir=mkdtempSync(join(tmpdir(),'posting-guard-'));
process.env.WORKBENCH_DATA_DIR=dataDir;
process.env.FINANCE_SOURCE_ROOT=join(dataDir,'originals');mkdirSync(process.env.FINANCE_SOURCE_ROOT);
const A=await import('../server/accounting.mjs');
const {db}=await import('../server/db.mjs');
const G=await import('../server/posting-evidence-guard.mjs');
const C=await import('../server/local-audit-coordinator.mjs');
const {committedPostingEvidence}=await import('../server/posting-evidence-index.mjs');
const {callAgentTool}=await import('../server/agent-tools.mjs');
const {callModelTool}=await import('../server/finance-model-entry.mjs');
const set=A.createAccountSet({name:'合成入账保护',start_period:'2026-01',enterprise:{enterpriseKey:'SYNTHETIC-POSTING-GUARD'}}).id;
const pair=amount=>[{code:'1002',debit:amount,credit:0},{code:'1001',debit:0,credit:amount}];
const raw=(extras={})=>({period:'2026-02',voucher_date:'2026-02-28',summary:'合成凭证',entries:pair(100),...extras});
let sequence=0;
function sourced(v=raw(),transform='identity') {
 const path=join(process.env.FINANCE_SOURCE_ROOT,`原件-${++sequence}.json`);writeFileSync(path,JSON.stringify({日期:v.voucher_date,金额:v.entries[0].debit}));
 const map=(inputPointer,jsonPointer)=>({inputPointer,parameterLabel:'原件字段',sources:[{path,jsonPointer}],transform,reason:'按原件字段采用，不自行改变金额或日期。'});
 return {...v,businessEvidence:{businessLabel:'凭证录入',method:'根据银行收付款原件记账',mappings:[map('/voucher_date','/日期'),map('/entries/0/debit','/金额'),map('/entries/1/credit','/金额')]}};
}
const count=()=>db.prepare("SELECT count(*) n FROM vouchers WHERE account_set_id=? AND status='posted'").get(set).n;
const records=()=>readdirSync(join(dataDir,'posting-attempts')).filter(n=>/^[a-f0-9-]{36}$/.test(n)&&lstatSync(join(dataDir,'posting-attempts',n,'result.json')).isFile()).map(id=>({id,begin:JSON.parse(readFileSync(join(dataDir,'posting-attempts',id,'begin.json'))),end:JSON.parse(readFileSync(join(dataDir,'posting-attempts',id,'result.json')))}));
function errorOf(fn){let caught;try{fn();}catch(e){caught=e;}assert.ok(caught,'必须拒绝');return caught;}
test('真实日期完整映射与合理大额直接通过',()=>{
 for(const amount of [100,900000000]){assert.equal(A.createVoucher(set,sourced(raw({entries:pair(amount),status:'posted'}))).status,'posted');}
});
test('不存在日期与跨期日期拒绝且留原输入',()=>{
 for(const date of ['2026-02-31','2026-02-29','2026-04-01','invalid']){const before=count(),v=sourced(raw({voucher_date:date,status:'posted'})),e=errorOf(()=>A.createVoucher(set,v));assert.equal(G.postingFailureProjection(e).nextAction,'correct_input');assert.equal(count(),before);assert.ok(records().some(r=>r.begin.input.voucher_date===date&&r.end.state==='correction_required'));}
});
test('缺省日期草稿为空，不能正式入账',()=>{
 const draft=A.createVoucher(set,raw({voucher_date:undefined}));assert.equal(draft.voucher_date,'');assert.equal(draft.postingGuard.status,'needs_review');const e=errorOf(()=>A.postVoucher(set,draft.id));assert.equal(G.postingFailureProjection(e).nextAction,'human_review');assert.equal(A.getVoucher(set,draft.id).status,'draft');
});
test('非法金额保留原始类型和具体行定位',()=>{
 const e=errorOf(()=>A.createVoucher(set,raw({entries:pair(NaN),status:'posted'})));assert.equal(G.postingFailureProjection(e).nextAction,'correct_input');assert.ok(e.details.postingGuard.issues.some(i=>i.field==='/entries/0/debit'));assert.ok(records().some(r=>r.begin.input.entries?.[0]?.debit?.value==='NaN'));
});
test('原值不符或非法路径均不可人工放行',()=>{
 const v=sourced(raw({status:'posted'}));v.entries=pair(101);let e=errorOf(()=>A.createVoucher(set,v));assert.equal(e.details.postingGuard.status,'correction_required');assert.throws(()=>G.readPostingReview(db,set,e.details.postingGuard.attemptId));
 const bad=sourced(raw({status:'posted'}));bad.businessEvidence.mappings[0].sources[0].path=join(dataDir,'outside.json');e=errorOf(()=>A.createVoucher(set,bad));assert.equal(e.details.postingGuard.status,'correction_required');
});
test('缺证据保留候选，模型审批字段与伪造kind无效',()=>{
 for(const extra of [{approved:true},{reviewed:true,reason:'我已核对'},{kind:'depreciation'}]){const before=count(),e=errorOf(()=>A.createVoucher(set,raw({status:'posted',...extra})));assert.equal(e.details.postingGuard.status,'needs_review');assert.equal(count(),before);assert.equal(G.readPostingReview(db,set,e.details.postingGuard.attemptId).validation.content.voucher_date,'2026-02-28');}
});
test('post继承真实草稿证据，也能补充新映射',async()=>{
 const draft=A.createVoucher(set,sourced());assert.equal(A.postVoucher(set,draft.id).status,'posted');
 const draft2=A.createVoucher(set,raw());assert.equal((await callAgentTool('voucher_post',{accountSetId:set,voucherId:draft2.id,businessEvidence:sourced().businessEvidence})).status,'posted');
});
test('selection审核绑定原件版本和业务内容',()=>{
 const v=sourced(raw({status:'posted'}),'selection'),e=errorOf(()=>A.createVoucher(set,v)),id=e.details.postingGuard.attemptId;
 assert.throws(()=>G.savePostingReview(db,set,id,{operator:'测试审核员',reason:'核对原件'},'yes'));
 const review=G.savePostingReview(db,set,id,{operator:'测试审核员',reason:'确认这个版本的原件选取'},`确认 ${id}`);
 assert.equal(C.withRequestMetadata({operationId:review.approvedOperationId},()=>A.createVoucher(set,v)).status,'posted');
 assert.equal(errorOf(()=>A.createVoucher(set,v)).details.postingGuard.status,'needs_review');
 assert.equal(errorOf(()=>A.createVoucher(set,{...v,summary:'变更'})).details.postingGuard.status,'needs_review');
 writeFileSync(v.businessEvidence.mappings[0].sources[0].path,JSON.stringify({日期:v.voucher_date,金额:100,备注:'已改变'}));assert.equal(errorOf(()=>A.createVoucher(set,v)).details.postingGuard.status,'needs_review');
});
test('同类读取失败换路径不能沿用审批',()=>{
 const v=sourced(raw({status:'posted'}));for(const m of v.businessEvidence.mappings)m.sources[0].path=join(process.env.FINANCE_SOURCE_ROOT,'缺失A.json');const e=errorOf(()=>A.createVoucher(set,v)),id=e.details.postingGuard.attemptId;G.savePostingReview(db,set,id,{operator:'测试审核员',reason:'核对这个缺失项'},`确认 ${id}`);
 for(const m of v.businessEvidence.mappings)m.sources[0].path=join(process.env.FINANCE_SOURCE_ROOT,'缺失B.json');assert.equal(errorOf(()=>A.createVoucher(set,v)).details.postingGuard.status,'needs_review');
});
test('相同operationId重放不重复入账，改参数仍冲突',()=>{
 const v=sourced(raw({status:'posted'})),operationId='posting-replay-synthetic';const first=C.withRequestMetadata({operationId},()=>A.createVoucher(set,v)),before=count();const again=C.withRequestMetadata({operationId},()=>A.createVoucher(set,v));assert.equal(first.id,again.id);assert.equal(count(),before);assert.throws(()=>C.withRequestMetadata({operationId},()=>A.createVoucher(set,{...v,summary:'变更'})),/audit_operation_conflict/);
});
test('模型收到正确的纠正动作',async()=>{
 const r=await callModelTool('voucher_create',{accountSetId:set,...sourced(raw({voucher_date:'2026-02-31',status:'posted'}))});assert.equal(r.applied,false);assert.equal(r.nextAction,'correct_input');assert.equal(r.needsLocalReview,false);
});
test('非交互CLI不能批准',()=>{
 const r=spawnSync(process.execPath,['scripts/review-posting.mjs',String(set),'00000000-0000-0000-0000-000000000000'],{cwd:new URL('..',import.meta.url),encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/posting_review_interactive_required/);
});
test('留证目录不可用时先阻断',()=>{
 const root=join(dataDir,'posting-attempts'),saved=join(dataDir,'posting-attempts-saved');renameSync(root,saved);writeFileSync(root,'blocked');const before=count();assert.throws(()=>A.createVoucher(set,sourced(raw({status:'posted'}))),/posting_record_unavailable/);assert.equal(count(),before);renameSync(root,join(dataDir,'blocking-file'));renameSync(saved,root);
});
test('红字原方向保留，余额与现金净变动按符号计，现金分类不猜',()=>{
 const v=sourced(raw({status:'posted',entries:pair(-25)}));const result=A.createVoucher(set,v);assert.equal(result.entries[0].debit,-25);assert.equal(result.entries[1].credit,-25);assert.equal(A.checkVoucher(set,pair(-25)).ok,true);
 assert.equal(A.checkVoucher(set,[{code:'1002',debit:-25,credit:25},{code:'1001',debit:25,credit:-25}]).ok,false);
 const report=A.cashFlowStatement(set,'2026-02');assert.equal(report.classificationComplete,false);assert.ok(report.unknown.some(x=>x.reason==='red-voucher-cash-evidence-required'));
});
test('既存草稿非法日期不能绕过post守卫',()=>{
 const v=A.createVoucher(set,sourced());db.prepare("UPDATE vouchers SET voucher_date='2026-02-31' WHERE id=?").run(v.id);
 const e=errorOf(()=>A.postVoucher(set,v.id));assert.equal(e.details.postingGuard.status,'correction_required');assert.equal(A.getVoucher(set,v.id).status,'draft');
});
test('结束记录失败保留unknown，原操作回查/重放不会重复账务',()=>{
 const v=sourced(raw({status:'posted'})),operationId='posting-finish-failure-synthetic',before=count();
 const e=errorOf(()=>C.withRequestMetadata({operationId},()=>G.withPostingAttempt(db,set,'voucher.create',v,()=>{const result=A.createVoucher(set,v);const r=readdirSync(join(dataDir,'posting-attempts')).find(id=>/^[a-f0-9-]{36}$/.test(id)&&!readdirSync(join(dataDir,'posting-attempts',id)).includes('result.json'));mkdirSync(join(dataDir,'posting-attempts',r,'result.json'));return result;})));
 assert.equal(count(),before+1);assert.equal(C.operationErrorEvidence(e).applied,'unknown');assert.equal(G.postingFailureProjection(e).nextAction,'query_original_operation');assert.equal(C.withRequestMetadata({operationId},()=>A.createVoucher(set,v)).status,'posted');assert.equal(count(),before+1);
});
test('金额归一化不丢原值，草稿post复用原来源并识别原件变化',()=>{
 for(const amount of ['100.00','1.005']){const v=sourced(raw({entries:pair(amount)})),draft=A.createVoucher(set,v);assert.equal(A.postVoucher(set,draft.id).status,'posted');assert.equal(A.getVoucher(set,draft.id).entries[0].debit,amount==='1.005'?1.01:100);}
 const replacement=A.createVoucher(set,sourced(raw({entries:pair('1.005')})));assert.equal(A.postVoucher(set,replacement.id,{businessEvidence:sourced(raw({entries:pair('1.01')})).businessEvidence}).status,'posted');
 const v=sourced(raw({entries:pair('1.005')})),draft=A.createVoucher(set,v);writeFileSync(v.businessEvidence.mappings[0].sources[0].path,JSON.stringify({日期:v.voucher_date,金额:'1.006'}));assert.equal(errorOf(()=>A.postVoucher(set,draft.id)).details.postingGuard.status,'correction_required');
});
test('draft原返回、同ID重放及重启恢复的摘要完全一致',()=>{
 const operationId='posting-draft-replay-synthetic',v=raw();const first=C.withRequestMetadata({operationId},()=>A.createVoucher(set,v));const again=C.withRequestMetadata({operationId},()=>A.createVoucher(set,v));assert.deepEqual(JSON.parse(JSON.stringify(again)),JSON.parse(JSON.stringify(first)));
 const script=`const A=await import('./server/accounting.mjs');const C=await import('./server/local-audit-coordinator.mjs');const r=C.withRequestMetadata({operationId:${JSON.stringify(operationId)}},()=>A.createVoucher(${set},${JSON.stringify(v)}));console.log(JSON.stringify(r));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:process.env,encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout.trim()),JSON.parse(JSON.stringify(first)));
});
test('新企业导入失败保留候选；审批不能复用到另一企业；批准固定操作可完成',()=>{
 const payload={account_set:{name:'合成导入甲',start_period:'2026-01',accounting_standard:'小企业会计准则'},opening_balances:[],vouchers:[{...raw(),date:'2026-02-28'}]};
 const options={dryRun:false,enterprise:{enterpriseKey:'SYNTHETIC-IMPORT-REVIEW-A'}};const e=errorOf(()=>A.importAccountSet(payload,options)),id=e.details.postingGuard.attemptId;
 const entry=records().find(r=>r.id===id);const pendingSet=entry.begin.accountSetId;assert.equal(db.prepare('SELECT id FROM account_sets WHERE id=?').get(pendingSet),undefined);
 const reviewed=G.savePostingReview(db,pendingSet,id,{operator:'测试审核员',reason:'核对该合成企业候选的完整凭证'},`确认 ${id}`);
 const wrong=errorOf(()=>C.withRequestMetadata({operationId:'another-enterprise'},()=>A.importAccountSet(payload,{...options,enterprise:{enterpriseKey:'SYNTHETIC-IMPORT-REVIEW-B'}})));assert.equal(wrong.details.postingGuard.status,'needs_review');
 const result=C.withRequestMetadata({operationId:reviewed.approvedOperationId},()=>A.importAccountSet(payload,options));assert.equal(result.created.vouchers,1);
});
test('导入可直接使用真实字段映射且内部记录不提前宣称提交',()=>{
 const v=syntheticVoucherEvidence(raw({entries:pair('1.005')}),process.env.FINANCE_SOURCE_ROOT);const payload={account_set:{name:'合成映射导入',start_period:'2026-01'},opening_balances:[],vouchers:[{...v,date:v.voucher_date}]};
 const imported=A.importAccountSet(payload,{dryRun:false,enterprise:{enterpriseKey:'SYNTHETIC-IMPORT-MAPPED'}});assert.equal(imported.created.vouchers,1);
 const record=records().find(r=>r.begin.accountSetId===imported.created.id&&r.end.contentDigest);assert.equal(record.end.state,'staged');assert.ok(record.end.operationId);assert.equal(db.prepare('SELECT state FROM audit_operations WHERE operation_id=?').get(record.end.operationId).state,'succeeded');
});
test('销售部分红字影响科目、损益与资产负债；反向正数余额相同发生额不同',()=>{
 const create=name=>A.createAccountSet({name,start_period:'2026-01',enterprise:{enterpriseKey:'SYNTHETIC-RED-'+name}}).id;
 const red=create('红字'),reverse=create('反向');const original=[{code:'1122',debit:1130},{code:'5001',credit:1000},{code:'2221',credit:130}];
 const returned=[{code:'1122',debit:-452},{code:'5001',credit:-400},{code:'2221',credit:-52}];
 const post=(id,entries)=>A.createVoucher(id,syntheticVoucherEvidence(raw({status:'posted',entries}),process.env.FINANCE_SOURCE_ROOT));
 post(red,original);post(red,returned);post(reverse,original);post(reverse,[{code:'1122',credit:452},{code:'5001',debit:400},{code:'2221',debit:52}]);
 const rt=A.trialBalance(red,'2026-02'),bt=A.trialBalance(reverse,'2026-02'),rr=rt.lines.find(r=>r.code==='1122'),br=bt.lines.find(r=>r.code==='1122');
 assert.equal(rr.period_debit,678);assert.equal(rr.period_credit,0);assert.equal(br.period_debit,1130);assert.equal(br.period_credit,452);assert.equal(rr.closing_debit,678);assert.equal(br.closing_debit,678);
 assert.equal(A.incomeStatement(red,'2026-02').current['营业收入'],600);assert.equal(A.incomeStatement(reverse,'2026-02').current['营业收入'],600);
 const bs=A.balanceSheet(red,'2026-02');assert.equal(bs.totals.assets,678);assert.equal(bs.totals.liabilities,78);assert.equal(bs.totals.equity,600);
});
test('原始输入getter与Proxy不执行，拒绝仍先留记录',()=>{
 let touched=0;const value=raw();Object.defineProperty(value,'correctionOf',{enumerable:true,get(){touched++;return 'fake';}});assert.throws(()=>A.createVoucher(set,value));assert.equal(touched,0);
 const proxy=new Proxy(raw(),{get(){touched++;throw Error('不应调用');},ownKeys(){touched++;throw Error('不应反射');}});assert.throws(()=>A.createVoucher(set,proxy));assert.equal(touched,0);
 assert.ok(records().some(r=>r.begin.input?.$type==='proxy'));
});
test('纠正链接按实际企业账套核对，不接受跨作用域ID',()=>{
 const prior=errorOf(()=>A.createVoucher(set,raw({status:'posted'}))).details.postingGuard.attemptId;
 const other=A.createAccountSet({name:'合成另一企业',start_period:'2026-01',enterprise:{enterpriseKey:'SYNTHETIC-CORRECTION-OTHER'}}).id;
 const e=errorOf(()=>A.createVoucher(other,sourced(raw({status:'posted',correctionOf:prior}))));assert.equal(e.details.postingGuard.issues[0].code,'correction_scope_invalid');
});
test('导入复用既有千分位、币符和符号解析，原字符串与采用金额分开保留',()=>{
 const examples=[['1,000.00',1000],['￥ 1,000.00',1000],['¥ +1,000.005',1000.01],['-1,000.00',-1000],['￥ -1,000.00',-1000]];
 for(const [amount,want] of examples){const v=sourced(raw({entries:pair(amount)}));const payload={account_set:{name:'合成格式导入',start_period:'2026-01'},accounts:[{code:'190101',name:'合成自定义科目',category:'资产',direction:'debit'}],opening_balances:[],vouchers:[{...v,date:v.voucher_date}]};
  assert.equal(A.validateImportPayload(payload,{enterprise:{enterpriseKey:'SYNTHETIC-FORMAT-VALIDATE'}}).ok,true,JSON.stringify(A.validateImportPayload(payload,{enterprise:{enterpriseKey:'SYNTHETIC-FORMAT-VALIDATE'}}).errors));const imported=A.importAccountSet(payload,{dryRun:false,enterprise:{enterpriseKey:'SYNTHETIC-FORMAT-'+(++sequence)}});const voucher=A.listVouchers(imported.created.id,{period:'2026-02'})[0];assert.equal(A.getVoucher(imported.created.id,voucher.id).entries[0].debit,want);
  const r=records().find(r=>r.begin.accountSetId===imported.created.id&&r.end.validation);const validation=JSON.parse(readFileSync(join(dataDir,'posting-attempts',r.id,r.end.validation.file)));assert.equal(validation.amountNormalization.originalEntries[0].debit,amount);assert.equal(validation.amountNormalization.adoptedEntries[0].debit,want.toFixed(2));
  assert.equal(errorOf(()=>A.createVoucher(set,v)).message,'voucher_invalid','直接凭证不接受导入格式');
 }
 for(const amount of ['1,00.00','￥1,2','RMB100','1e3','-￥100']){const payload={account_set:{name:'合成非法导入',start_period:'2026-01'},opening_balances:[],vouchers:[{...raw({entries:pair(amount)}),date:'2026-02-28'}]};const invalid=A.validateImportPayload(payload,{enterprise:{enterpriseKey:'SYNTHETIC-INVALID-FORMAT'}});assert.equal(invalid.ok,false);assert.ok(invalid.errors.some(e=>e.includes('金额非法')));}
});
test('批次子操作记录可信父子身份，外层回滚不能进入已提交证据索引',()=>{
 const v=sourced(raw({status:'posted'}));const scope={kind:'account_set',value:set};
 const invoke=(operationId,rollback=false)=>C.runAuditedBatchStage(db,{operationId,action:'batch.stage',scope,request:{operationId}},[{action:'voucher.create_posted',scope,request:[set,v]}],()=>{const result=A.createVoucher(set,v);if(rollback)throw Error('synthetic_outer_rollback');return result;});
 const result=invoke('posting-batch-child');const record=records().find(r=>r.end.voucherId===result.id&&r.end.operationId==='posting-batch-child.c1');assert.ok(record);assert.equal(record.end.operationAttempt,1);assert.equal(record.end.parentOperationId,'posting-batch-child');assert.equal(record.end.parentAttempt,1);assert.equal(record.end.state,'staged');
 assert.throws(()=>invoke('posting-batch-rollback',true),/synthetic_outer_rollback/);const rollbackRecord=records().find(r=>r.end.operationId==='posting-batch-rollback.c1');assert.ok(rollbackRecord);
 const index=committedPostingEvidence(join(dataDir,'workbench.db'),record.begin);assert.ok(index.some(r=>r.operationId==='posting-batch-child.c1'));assert.ok(!index.some(r=>r.operationId==='posting-batch-rollback.c1'));
});
test('失败后第二次业务attempt只核对真实第二次回执',()=>{
 const v=sourced(raw({status:'posted'})),operationId='posting-domain-attempt-two',options={action:'import.append',scope:{kind:'account_set',value:set},request:{voucher:v}};
 assert.throws(()=>C.withRequestMetadata({operationId},()=>C.runDomainOperation(db,{...options,context:{attempt:1}},()=>{throw Error('synthetic_first_failure');})),/synthetic_first_failure/);
 const result=C.withRequestMetadata({operationId},()=>C.runDomainOperation(db,{...options,context:{attempt:2}},()=>A.createVoucher(set,v)));
 const record=records().find(r=>r.end.voucherId===result.id&&r.end.operationId===operationId);assert.equal(record.end.operationAttempt,2);const index=committedPostingEvidence(join(dataDir,'workbench.db'),record.begin);assert.ok(index.some(r=>r.operationId===operationId));
});
test('无显式operationId的领域写入结束留证失败仍提供实际回查身份',()=>{
 const v=sourced(raw({status:'posted'}));const e=errorOf(()=>G.withPostingAttempt(db,set,'voucher.create',v,()=>{const result=A.createVoucher(set,v);const id=readdirSync(join(dataDir,'posting-attempts')).find(id=>/^[a-f0-9-]{36}$/.test(id)&&!readdirSync(join(dataDir,'posting-attempts',id)).includes('result.json'));mkdirSync(join(dataDir,'posting-attempts',id,'result.json'));return result;}));
 const proof=C.operationErrorEvidence(e);assert.equal(proof.applied,'unknown');assert.equal(typeof proof.operationId,'string');assert.equal(proof.attempt,1);assert.equal(db.prepare('SELECT state FROM audit_operations WHERE operation_id=? AND attempt=?').get(proof.operationId,proof.attempt).state,'succeeded');
});
test('原子导入两票连续人审可合并成明确范围的新组，旧失败执行不改终态',()=>{
 const payload={account_set:{name:'合成两票组审',start_period:'2026-01'},opening_balances:[],vouchers:[1,2].map((number)=>({...raw({number,summary:'组审凭证'+number,entries:pair(number*100)}),date:'2026-02-28'}))};const options={dryRun:false,enterprise:{enterpriseKey:'SYNTHETIC-GROUP-REVIEW'}};
 const approve=(e,reason)=>{const id=e.details.postingGuard.attemptId,r=records().find(r=>r.id===id);return G.savePostingReview(db,r.begin.accountSetId,id,{operator:'测试审核员',reason},`确认 ${id}`);};
 const first=errorOf(()=>A.importAccountSet(payload,options)),one=approve(first,'核对第一张候选');
 const second=errorOf(()=>C.withRequestMetadata({operationId:one.approvedOperationId},()=>A.importAccountSet(payload,options)));assert.equal(records().find(r=>r.id===second.details.postingGuard.attemptId).begin.input.number,2);
 const attemptsBefore=db.prepare('SELECT count(*) n FROM audit_operations WHERE operation_id=?').get(one.approvedOperationId).n;assert.throws(()=>C.withRequestMetadata({operationId:one.approvedOperationId},()=>A.importAccountSet(payload,options)));assert.equal(db.prepare('SELECT count(*) n FROM audit_operations WHERE operation_id=?').get(one.approvedOperationId).n,attemptsBefore,'没有新审批不生成下一attempt');
 const two=approve(second,'明确同意沿用第一张并接受第二张');assert.notEqual(two.approvedOperationId,one.approvedOperationId);assert.equal(two.executionIntent.digest,one.executionIntent.digest);assert.equal(two.members.length,2);assert.ok(two.members.some(m=>m.priorReason==='核对第一张候选'));
 const changed=structuredClone(payload);changed.vouchers[1].entries=pair(999);assert.throws(()=>C.withRequestMetadata({operationId:one.approvedOperationId},()=>A.importAccountSet(changed,options)),/audit_operation_conflict/);
 assert.throws(()=>C.withRequestMetadata({operationId:one.approvedOperationId},()=>A.importAccountSet(payload,{...options,enterprise:{enterpriseKey:'SYNTHETIC-GROUP-OTHER'}})),/audit_operation_conflict/);
 const result=C.withRequestMetadata({operationId:two.approvedOperationId},()=>A.importAccountSet(payload,options));assert.equal(result.created.vouchers,2);assert.equal(A.listVouchers(result.created.id,{period:'2026-02'}).length,2);
 const again=C.withRequestMetadata({operationId:two.approvedOperationId},()=>A.importAccountSet(payload,options));assert.equal(again.created.id,result.created.id);assert.equal(A.listVouchers(result.created.id,{period:'2026-02'}).length,2);
 assert.equal(db.prepare('SELECT state FROM audit_operations WHERE operation_id=? AND attempt=1').get(one.approvedOperationId).state,'failed');assert.equal(db.prepare('SELECT count(*) n FROM audit_operations WHERE operation_id=?').get(two.approvedOperationId).n,1);
 const extra=structuredClone(payload);extra.vouchers.push({...raw({number:3}),date:'2026-02-28'});assert.throws(()=>C.withRequestMetadata({operationId:two.approvedOperationId},()=>A.importAccountSet(extra,options)),/audit_operation_conflict/);
});
test('组审后首票来源版本改变使整个未执行组失效，不凭第二票授权入账',()=>{
 const vouchers=[1,2].map(number=>{const v=sourced(raw({number,summary:'来源组'+number}),'selection');return {...v,date:v.voucher_date};});const payload={account_set:{name:'合成来源组审',start_period:'2026-01'},opening_balances:[],vouchers},options={dryRun:false,enterprise:{enterpriseKey:'SYNTHETIC-GROUP-SOURCE'}};
 const approve=e=>{const id=e.details.postingGuard.attemptId,r=records().find(r=>r.id===id);return G.savePostingReview(db,r.begin.accountSetId,id,{operator:'测试审核员',reason:'核对当前原件版本及组范围'},`确认 ${id}`);};
 const one=approve(errorOf(()=>A.importAccountSet(payload,options)));const two=approve(errorOf(()=>C.withRequestMetadata({operationId:one.approvedOperationId},()=>A.importAccountSet(payload,options))));
 writeFileSync(vouchers[0].businessEvidence.mappings[0].sources[0].path,JSON.stringify({日期:'2026-02-28',金额:100,修订:'原件新版本'}));
 const e=errorOf(()=>C.withRequestMetadata({operationId:two.approvedOperationId},()=>A.importAccountSet(payload,options)));assert.equal(e.details.postingGuard.status,'needs_review');assert.equal(records().find(r=>r.id===e.details.postingGuard.attemptId).begin.input.number,1);assert.equal(db.prepare('SELECT account_set_id FROM import_enterprise_account_sets WHERE enterprise_key=?').get(options.enterprise.enterpriseKey),undefined);
});
test('来源暂时改变导致已审操作失败，恢复后可经再次人工确认签发新组',()=>{
 const v=sourced(raw({status:'posted',summary:'来源恢复组审'}),'selection'),path=v.businessEvidence.mappings[0].sources[0].path,original=readFileSync(path),before=count();
 const approve=e=>{const id=e.details.postingGuard.attemptId;return G.savePostingReview(db,set,id,{operator:'测试审核员',reason:'复核原件恢复后的事实及完整候选'},`确认 ${id}`);};
 const one=approve(errorOf(()=>A.createVoucher(set,v)));writeFileSync(path,Buffer.concat([original,Buffer.from('\n')]));
 errorOf(()=>C.withRequestMetadata({operationId:one.approvedOperationId},()=>A.createVoucher(set,v)));assert.equal(count(),before);writeFileSync(path,original);
 const pending=errorOf(()=>A.createVoucher(set,v)),two=approve(pending);assert.notEqual(two.approvedOperationId,one.approvedOperationId);assert.equal(two.executionIntent.digest,one.executionIntent.digest);assert.equal(two.members.length,1);assert.ok(two.members[0].priorReason);
 assert.equal(C.withRequestMetadata({operationId:two.approvedOperationId},()=>A.createVoucher(set,v)).status,'posted');assert.equal(count(),before+1);
 assert.throws(()=>C.withRequestMetadata({operationId:one.approvedOperationId},()=>A.createVoucher(set,v)));assert.equal(count(),before+1);assert.equal(db.prepare('SELECT count(*) n FROM audit_operations WHERE operation_id=?').get(one.approvedOperationId).n,1);
});
test('凭证日志链接目录不能被读取或签署',t=>{
 const e=errorOf(()=>A.createVoucher(set,raw({status:'posted'}))),id=e.details.postingGuard.attemptId,root=join(dataDir,'posting-attempts'),saved=join(dataDir,'moved-attempt');renameSync(join(root,id),saved);try{symlinkSync(saved,join(root,id),'junction');}catch(error){if(error.code==='EPERM'){t.skip('当前Windows沙箱不能创建junction；拒链逻辑需在有权限环境复核');return;}throw error;}assert.throws(()=>G.readPostingReview(db,set,id),/posting_record_path_forbidden/);
});
test.after(()=>db.close());
