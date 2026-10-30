import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, writeFileSync, readFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { prepareAnnualScenario } from './annual-close-harness.test.mjs';
import { initHarness, registerHarnessSource, registerHarnessFacts, planHarness, inspectHarness, runHarnessTask, feedbackHarness, recoverHarnessLock } from '../server/harness-runtime.mjs';
import { withHarness, loadHarness, continuation } from '../server/harness-store.mjs';
import { validateHarnessTaskState } from '../server/harness-contract.mjs';
assert.throws(()=>validateHarnessTaskState({operationState:'executed',resultCurrent:false,confirmationCurrent:true,reviewState:'accepted'}),{code:'harness_task_state_invalid'});
function prepare(directory){
 const f=prepareAnnualScenario(directory,{empty:true});
 writeFileSync(join(f.root,'goal.txt'),'全部为合成资料。使用scenario.json的空账目标及原始逐月资料，通过Harness自行规划、重算、准备、请求验收者明确模拟确认、执行与query。重启后恢复同一operation；客户补件或更正后识别受影响依赖，关联原凭证准备更正，不能重复unchanged业务。不得自行制造会计确认；新结果待复核。');
 return f;
}
if(process.argv[2]==='prepare'){console.log(JSON.stringify(prepare(process.argv[3]),null,2));process.exit(0);}
mkdirSync(resolve('.agent-runs'), {recursive:true});
const root=mkdtempSync(resolve('.agent-runs/harness-recovery-')), f=prepare(join(root,'fixture'));
const month=join(root,'month'),year=join(root,'year');
const fact=(factId,value)=>({factId,state:'provided',reason:'Synthetic recovery regression',sourceRefs:['raw'],value});
const task=(taskId,capabilityId,externalDependencies)=>({taskId,capabilityId,factIds:['request'],dependsOn:[],goal:'Synthetic recovery regression',...(externalDependencies?{externalDependencies}:{})});
async function voucherProofChanges(){
 const fixture=prepareAnnualScenario(join(root,'voucher-proof'),{empty:true}),path=join(root,'voucher-proof-state'),target=fixture.target;
 await initHarness(path,{...fixture.scope,period:'2026-01'});await registerHarnessSource(path,{sourceId:'raw',path:fixture.sourcePath,locator:'Synthetic native voucher proof probe',parsed:false,unrecognized:[],classification:'provided'});
 const voucher=status=>({period:'2026-01',voucher_date:'2026-01-10',status,entries:[{code:'1122',debit:5.17,credit:0},{code:'5001',debit:0,credit:5.17}]});
 await registerHarnessFacts(path,[fact('posted',{target,voucher:voucher('posted')}),fact('draft',{target,voucher:voucher('draft')})]);
 await planHarness(path,[{...task('posted','voucher.create'),factIds:['posted']},{...task('draft','voucher.create'),factIds:['draft']}]);
 const call=async id=>{const t=(await inspectHarness(path)).tasks.find(t=>t.taskId===id);return runHarnessTask(path,{taskId:id,dependencyDigest:t.dependencyDigest});};
 const accept=async id=>{const t=(await inspectHarness(path)).tasks.find(t=>t.taskId===id);return feedbackHarness(path,{taskId:id,targetVersion:t.receipt.targetVersion,dependencyDigest:t.dependencyDigest,decision:'accept',reason:'Synthetic native proof observation fixture',reviewer:'SYNTHETIC-ACCOUNTANT',evidenceRefs:[]});};
 const accountingModule=pathToFileURL(resolve('server/accounting.mjs')).href,dbModule=pathToFileURL(resolve('server/db.mjs')).href;
 const native=(action,id)=>{const p=spawnSync(process.execPath,['--input-type=module','-e',`const A=await import(${JSON.stringify(accountingModule)}),{db}=await import(${JSON.stringify(dbModule)});try{A[${JSON.stringify(action)}](${target.accountSetId},${id});}finally{db.close();}`],{encoding:'utf8',windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1',WORKBENCH_DATA_DIR:resolve(target.dbPath,'..')}});assert.equal(p.status,0,p.stderr);};
 const posted=await call('posted'),postedId=posted.receipt.actualImpact.current.voucherId;assert.equal(posted.status,'executed');await accept('posted');
 native('unpostVoucher',postedId);try{const changed=(await inspectHarness(path)).tasks.find(t=>t.taskId==='posted');assert.equal(changed.executionState,'stale');assert.equal(changed.operationState,'executed');assert.ok((await loadHarness(path)).invalidatedResults.has(posted.receipt.targetVersion));}finally{native('postVoucher',postedId);}
 assert.equal((await inspectHarness(path)).tasks.find(t=>t.taskId==='posted').reviewState,'stale','restored native status cannot revive a known-changed result/confirmation');
 const draft=await call('draft'),draftId=draft.receipt.actualImpact.current.voucherId;assert.equal(draft.status,'executed');await accept('draft');native('deleteVoucher',draftId);
 const missing=(await inspectHarness(path)).tasks.find(t=>t.taskId==='draft');assert.equal(missing.executionState,'stale');assert.equal(missing.operationState,'executed');assert.equal(missing.historicalReceipt.targetVersion,draft.receipt.targetVersion);assert.ok((await loadHarness(path)).invalidatedResults.has(draft.receipt.targetVersion));
 console.log('PASS read native voucher changes/missing rows durably invalidate results, preserve execution and never revive acceptance after restore: '+root);
}
if(process.argv.includes('--proof-changes')){await voucherProofChanges();process.exit(0);}
for(const [path,scope] of [[month,{...f.scope,period:'2026-01'}],[year,f.scope]]){
 await initHarness(path,scope);await registerHarnessSource(path,{sourceId:'raw',path:f.sourcePath,locator:'whole synthetic original',parsed:false,unrecognized:[],classification:'provided'});
}
await registerHarnessFacts(month,[fact('request',{target:f.target,manifestPath:f.manifestPaths[0]})]);
await planHarness(month,[task('month','agency.workpaper')]);
const run=async(path,id,phase='execute')=>{const t=(await inspectHarness(path)).tasks.find(t=>t.taskId===id);return runHarnessTask(path,{taskId:id,phase,dependencyDigest:t.dependencyDigest});};
await run(month,'month');const mt=(await inspectHarness(month)).tasks[0];
await registerHarnessFacts(year,[fact('request',{target:f.target})]);
await planHarness(year,[task('year','annual.inspect',[{storePath:month,taskId:'month',period:'2026-01',targetVersion:mt.receipt.targetVersion,dependencyDigest:mt.dependencyDigest}])]);
await run(year,'year');const baseline=(await inspectHarness(year)).tasks[0];
async function postingRecovery(){
 const rows=()=>{const db=new DatabaseSync(f.target.dbPath,{readOnly:true});try{return {vouchers:db.prepare('SELECT * FROM vouchers WHERE account_set_id=? ORDER BY id').all(f.target.accountSetId),balances:Object.fromEntries(db.prepare('SELECT e.code,ROUND(SUM(e.debit-e.credit)*100) cents FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? AND v.status=\'posted\' GROUP BY e.code').all(f.target.accountSetId).map(r=>[r.code,r.cents])),other:db.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?').get(f.otherId).n};}finally{db.close();}};
 // 销售更正后，另一笔未改动费用必须恰好保留一次。
 const inputPath=join(f.root,'customer-originals','2026-01.facts.json'),initialRaw=JSON.parse(readFileSync(inputPath)),service=initialRaw.records.find(r=>r.type==='service_complete');
 initialRaw.records.push({...service,id:'admin',type:'expense',businessIdentity:{issuerKey:'SYNTHETIC-SUPPLIER',documentNumber:'ADMIN-1',event:'expense'},work:undefined,use:'admin',gross:'37.23',net:'37.23',invoiceTax:'0.00',inputVatTreatment:'non_deductible',settlement:'unpaid',benefitPeriod:'2026-01',taxNature:'ordinary'});writeFileSync(inputPath,JSON.stringify(initialRaw));writeFileSync(f.sourcePath,readFileSync(f.sourcePath,'utf8')+' 合成独立原始费用收据ADMIN-1：当月行政服务37.23元，零税额，未付款，不含可抵扣税；仅当月受益。');
 await registerHarnessSource(month,{sourceId:'raw',path:f.sourcePath,locator:'service and separate administrative receipt',parsed:false,unrecognized:[],classification:'provided'});await run(month,'month');
 const request={target:f.target,manifestPath:f.manifestPaths[0],batchId:'recovery-original',evidenceDir:join(root,'evidence'),feedbackPath:join(root,'confirmation.json')};mkdirSync(request.evidenceDir);
 await registerHarnessFacts(month,[fact('posting',request)]);await planHarness(month,[task('month','agency.workpaper'),{taskId:'posting',capabilityId:'agency.posting',factIds:['posting'],dependsOn:['month'],goal:'Synthetic dependent posting recovery'}]);
 const proposal=(await run(month,'posting','prepare')).receipt.actualImpact.proposal;
 writeFileSync(request.feedbackPath,JSON.stringify({decision:'accept',reviewer:'SYNTHETIC-ACCOUNTANT',targetVersion:proposal.targetVersion,dependencyDigest:proposal.dependencyDigest,planDigest:proposal.planDigest}));
 const posted=await run(month,'posting');assert.equal(posted.status,'executed',JSON.stringify(posted));
 const first=rows();assert.ok(first.vouchers.length>0);assert.equal(first.other,0);
 renameSync(f.target.dbPath,f.target.dbPath+'.unavailable');
 try{const unavailable=await runHarnessTask(month,{taskId:'posting',phase:'execute'});assert.equal(unavailable.status,'replayed');assert.equal(unavailable.receipt.targetVersion,posted.receipt.targetVersion);assert.equal(unavailable.operationState,'executed');assert.equal(unavailable.currentBinding,false);assert.ok(['blocked','unknown'].includes(unavailable.observation.status));assert.equal(unavailable.observation.retryable,true);}finally{renameSync(f.target.dbPath+'.unavailable',f.target.dbPath);}
 const recovered=await run(month,'posting');assert.equal(recovered.status,'replayed');assert.equal(recovered.receipt.operationId,posted.receipt.operationId);assert.equal(recovered.receipt.targetVersion,posted.receipt.targetVersion);assert.equal(recovered.currentBinding,false);assert.deepEqual(rows(),first);
 let state=await inspectHarness(month);const postState=state.tasks.find(t=>t.taskId==='posting');assert.equal(postState.operationState,'executed');assert.equal(postState.resultCurrent,false);assert.equal(postState.confirmationCurrent,false);assert.equal(postState.historicalReceipt.targetVersion,posted.receipt.targetVersion);
 const knownInvalidated=[...(await loadHarness(month)).invalidatedResults];
 renameSync(request.feedbackPath,request.feedbackPath+'.unavailable');
 try{state=await inspectHarness(month);assert.ok(state.tasks.find(t=>t.taskId==='posting').blockers.some(b=>b.retryable));assert.deepEqual([...(await loadHarness(month)).invalidatedResults],knownInvalidated);const again=await run(month,'posting');assert.equal(again.receipt.targetVersion,posted.receipt.targetVersion);assert.equal(again.observation.evidenceCurrent,null);}finally{renameSync(request.feedbackPath+'.unavailable',request.feedbackPath);}
 const accountingModule=pathToFileURL(resolve('server/accounting.mjs')).href,dbModule=pathToFileURL(resolve('server/db.mjs')).href;
 const nativeStatus=action=>{const p=spawnSync(process.execPath,['--input-type=module','-e',`const A=await import(${JSON.stringify(accountingModule)}),{db}=await import(${JSON.stringify(dbModule)});try{A[${JSON.stringify(action)}](${f.target.accountSetId},${first.vouchers[0].id});}finally{db.close();}`],{encoding:'utf8',windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1',WORKBENCH_DATA_DIR:resolve(f.target.dbPath,'..')}});assert.equal(p.status,0,p.stderr);};
 nativeStatus('unpostVoucher');try{const mismatch=(await inspectHarness(month)).tasks.find(t=>t.taskId==='posting');assert.equal(mismatch.operationState,'executed');assert.equal(mismatch.resultCurrent,false);assert.ok((await loadHarness(month)).invalidatedResults.has(posted.receipt.targetVersion),'a read committed native fingerprint mismatch must durably invalidate the old result');}finally{nativeStatus('postVoucher');}
 assert.ok((await loadHarness(month)).invalidatedResults.has(posted.receipt.targetVersion),'restoring posted fingerprints must not revive an observed-invalid result');assert.deepEqual(rows(),first);
 await run(month,'month');const observed=await run(month,'posting','query');assert.equal(observed.currentBinding,false,'query cannot bind old native confirmation to the refreshed upstream workpaper');assert.equal(observed.receipt.operationId,posted.receipt.operationId);assert.deepEqual(rows(),first);
 await registerHarnessFacts(month,[fact('posting',{...request,manifestPath:f.manifestPaths[1]})]);await assert.rejects(()=>run(month,'posting'),{code:'harness_agency_identity_changed'});await registerHarnessFacts(month,[fact('posting',request)]);
 const reviewed=(await inspectHarness(month)).tasks.find(t=>t.taskId==='month');
 const feedback={taskId:'month',targetVersion:reviewed.receipt.targetVersion,dependencyDigest:reviewed.dependencyDigest,decision:'reject',reviewer:'SYNTHETIC-ACCOUNTANT',reason:'Synthetic corrected original service quantities required',evidenceRefs:[]};
 const rejected=await feedbackHarness(month,feedback);assert.deepEqual(rejected.affectedTasks,['month','posting']);assert.ok(rejected.nextSteps.some(s=>s.taskId==='month'&&s.action==='correct_with_existing_business_tools'));assert.equal(rejected.periodComplete,false);
 const raw=JSON.parse(readFileSync(inputPath));raw.records.find(r=>r.type==='service_complete').work[0].units='3';writeFileSync(inputPath,JSON.stringify(raw));writeFileSync(f.sourcePath,readFileSync(f.sourcePath,'utf8').replace('2小时','3小时'));
 const supplement=await registerHarnessSource(month,{sourceId:'raw',path:f.sourcePath,locator:'whole corrected synthetic original',parsed:false,unrecognized:[],classification:'provided'});assert.deepEqual(supplement.affectedTasks,['month','posting']);assert.ok(supplement.invalidatedResults.some(r=>r.taskId==='month'));assert.ok(supplement.nextSteps.some(s=>s.taskId==='month'&&s.action==='recompute_task'));
 await assert.rejects(()=>feedbackHarness(month,feedback),{code:'harness_feedback_stale'});
 const recalculated=await run(month,'month');assert.equal(recalculated.status,'executed');assert.equal(recalculated.receipt.actualImpact.domain.accounting.yearRevenue,'300.00');
 const correction={postingDate:'2026-01-26',reason:'Synthetic corrected original hours, preserve original vouchers',previousEvidence:[{archivePath:proposal.identity.archivePath,archiveId:proposal.identity.archiveId}],previousSourceIds:proposal.plannedVouchers.map(v=>v.sourceVoucherId)};
 const correctionRequest={...request,batchId:'recovery-correction',feedbackPath:join(root,'correction-confirmation.json'),correction};
 await registerHarnessFacts(month,[fact('correction',correctionRequest)]);await planHarness(month,[task('month','agency.workpaper'),{taskId:'posting',capabilityId:'agency.posting',factIds:['posting'],dependsOn:['month'],goal:'Retain original execution'},{taskId:'correction',capabilityId:'agency.posting',factIds:['correction'],dependsOn:['month'],goal:'Link original vouchers using existing correction'}]);
 const prepared=await run(month,'correction','prepare');assert.equal(prepared.status,'prepared',JSON.stringify(prepared));const cp=prepared.receipt.actualImpact.proposal;assert.ok(cp.impact.length);assert.ok(cp.plannedVouchers.every(v=>v.sourceVoucherId));
 assert.equal(cp.plannedVouchers.length,6,'only three changed voucher pairs may be reversed/replaced');
 assert.ok(!cp.plannedVouchers.some(v=>v.entries.some(e=>e.code==='5602')),'unchanged administrative expense cannot be reversed or posted again');
 const storeModule=pathToFileURL(resolve('server/harness-store.mjs')).href,adapterModule=pathToFileURL(resolve('server/harness-adapters.mjs')).href;
 const beforeWrite=spawnSync(process.execPath,['--input-type=module','-e',`import{withHarness,appendHarness,harnessView}from ${JSON.stringify(storeModule)};import{harnessCapabilities}from ${JSON.stringify(adapterModule)};await withHarness(${JSON.stringify(month)},async s=>{const caps=harnessCapabilities(),t=(await harnessView(s,caps)).tasks.find(t=>t.taskId==='correction'),c=caps.get(t.capabilityId),request=s.facts.get('correction').value,p=s.attempts.filter(a=>a.taskId===t.taskId&&a.phase==='prepare'&&a.result?.executionState==='prepared').at(-1);await appendHarness(s,'intent',{taskId:t.taskId,capabilityId:t.capabilityId,effect:'write',phase:'execute',dependencyDigest:t.dependencyDigest,operationId:'agency-'+request.batchId,ruleVersion:c.ruleVersion,codeDigest:c.codeDigest,request,prepared:p.result.actualImpact});process.exit(75);});`],{encoding:'utf8',windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1'}});assert.equal(beforeWrite.status,75,beforeWrite.stderr);await recoverHarnessLock(month);assert.deepEqual(rows(),first);await assert.rejects(()=>run(month,'correction'),{code:'harness_task_blocked'});
 const notStarted=await run(month,'correction','query');assert.equal(notStarted.receipt.actualImpact.status,'not_started');assert.equal(notStarted.receipt.executionState,'failed');assert.deepEqual(rows(),first);
 writeFileSync(correctionRequest.feedbackPath,JSON.stringify({decision:'accept',reviewer:'SYNTHETIC-ACCOUNTANT',targetVersion:proposal.targetVersion,dependencyDigest:proposal.dependencyDigest,planDigest:proposal.planDigest}));
 const oldConfirmation=await run(month,'correction');assert.equal(oldConfirmation.status,'failed');assert.equal(oldConfirmation.receipt.actualImpact.code,'agency_confirmation_stale');assert.deepEqual(rows(),first);
 writeFileSync(correctionRequest.feedbackPath,JSON.stringify({decision:'accept',reviewer:'SYNTHETIC-ACCOUNTANT',targetVersion:cp.targetVersion,dependencyDigest:cp.dependencyDigest,planDigest:cp.planDigest}));
 const corrected=await run(month,'correction');assert.equal(corrected.status,'executed',JSON.stringify(corrected));const correctedRows=rows();assert.equal(correctedRows.vouchers.length,first.vouchers.length+6);assert.deepEqual(correctedRows.vouchers.slice(0,first.vouchers.length),first.vouchers);assert.equal(correctedRows.other,0);assert.equal(correctedRows.balances['1122'],30300);assert.equal(correctedRows.balances['5602'],3723);assert.equal(correctedRows.balances['5801'],1329);assert.equal(correctedRows.balances['5001'],-30000);
 const runtime=pathToFileURL(resolve('server/harness-runtime.mjs')).href;
 const restart=spawnSync(process.execPath,['--input-type=module','-e',`import{runHarnessTask}from ${JSON.stringify(runtime)};console.log(JSON.stringify(await runHarnessTask(${JSON.stringify(month)},{taskId:'correction',phase:'query'})));`],{encoding:'utf8',windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1'}});assert.equal(restart.status,0,restart.stderr);const restored=JSON.parse(restart.stdout);assert.equal(restored.receipt.operationId,corrected.receipt.operationId);const native=restored.receipt.actualImpact.domain.evidence;assert.ok(native.actualVouchers.length>0);assert.deepEqual(native.actualVouchers.map(v=>v.voucherId),corrected.receipt.actualImpact.domain.evidence.actualVouchers.map(v=>v.voucherId));assert.equal(native.operation.receipt.eventId,corrected.receipt.actualImpact.domain.evidence.operation.receipt.eventId);assert.deepEqual(rows(),correctedRows);
 await run(month,'month');state=await inspectHarness(month);assert.equal(state.tasks.find(t=>t.taskId==='month').reviewState,'pending');assert.equal(state.tasks.find(t=>t.taskId==='month').confirmationCurrent,false);assert.equal((await run(month,'correction')).status,'replayed');assert.deepEqual(rows(),correctedRows);
 console.log('PASS original posting recovery, retryable native feedback read, identity conflict, reject/supplement DAG continuation, current proposal/old confirmation refusal, linked native correction, restart and pending new review: '+root);
}
if(process.argv.includes('--posting')){await postingRecovery();process.exit(0);}
let release,locked;const ready=new Promise(r=>locked=r),hold=withHarness(month,async()=>{locked();await new Promise(r=>release=r);});await ready;
let blocked;try{blocked=(await inspectHarness(year)).tasks[0];}finally{release();await hold;}
assert.equal(blocked.executionState,'executed','temporary lock must preserve the execution fact');
assert.equal(blocked.dependencyDigest,baseline.dependencyDigest,'temporary lock must not create a dependency revision');
assert.ok(blocked.blockers.some(b=>b.retryable));
assert.equal(blocked.resultCurrent,null);
assert.deepEqual(continuation({tasks:[blocked]},['year']).invalidatedResults,[],'temporary verification failure is not an invalidated result');
assert.equal((await inspectHarness(year)).tasks[0].executionState,'executed','released lock must recover without recomputation');
assert.equal((await loadHarness(year)).invalidatedResults.size,0);
renameSync(f.sourcePath,f.sourcePath+'.unavailable');
try{const unreadable=(await inspectHarness(year)).tasks[0];assert.equal(unreadable.dependencyDigest,baseline.dependencyDigest);assert.ok(unreadable.blockers.some(b=>b.retryable));assert.equal((await loadHarness(year)).invalidatedSources.size,0);}finally{renameSync(f.sourcePath+'.unavailable',f.sourcePath);}
assert.equal((await inspectHarness(year)).tasks[0].executionState,'executed');
// 原生 API 在观测时抛错：三个公开入口均保留
// 已知执行和已接受复核，不凭空制造修订版本。
const materials=join(root,'native-materials'),stateStore=join(root,'native-state');await initHarness(stateStore,{...f.scope,period:'2026-Q1'});await registerHarnessSource(stateStore,{sourceId:'raw',path:f.sourcePath,locator:'whole original',parsed:false,unrecognized:[],classification:'provided'});await registerHarnessFacts(stateStore,[fact('request',{path:materials})]);await planHarness(stateStore,[task('init','materials.init')]);
const initialized=await run(stateStore,'init'),initial=(await inspectHarness(stateStore)).tasks[0];await feedbackHarness(stateStore,{taskId:'init',targetVersion:initial.receipt.targetVersion,dependencyDigest:initial.dependencyDigest,decision:'accept',reason:'Synthetic scoped material Store creation reviewed',reviewer:'SYNTHETIC-ACCOUNTANT',evidenceRefs:[]});
renameSync(materials,materials+'.unavailable');
try{
 const temporarily=await inspectHarness(stateStore);assert.equal(temporarily.tasks[0].operationState,'executed');assert.equal(temporarily.tasks[0].resultCurrent,null);assert.equal(temporarily.tasks[0].confirmationCurrent,null);assert.deepEqual(continuation(temporarily,['init']).invalidatedResults,[]);
 for(const phase of ['execute','query']){const response=await runHarnessTask(stateStore,{taskId:'init',phase});assert.equal(response.receipt.targetVersion,initialized.receipt.targetVersion);assert.equal(response.operationState,'executed');assert.equal(response.resultCurrent,null);assert.equal(response.confirmationCurrent,null);assert.equal(response.observation.retryable,true);}
 assert.equal((await loadHarness(stateStore)).invalidatedResults.size,0);
}finally{renameSync(materials+'.unavailable',materials);}
assert.equal((await inspectHarness(stateStore)).tasks[0].confirmationCurrent,true);
const yearCurrent=(await inspectHarness(year)).tasks[0];await feedbackHarness(year,{taskId:'year',targetVersion:yearCurrent.receipt.targetVersion,dependencyDigest:yearCurrent.dependencyDigest,decision:'accept',reason:'Synthetic baseline before target replacement',reviewer:'SYNTHETIC-ACCOUNTANT',evidenceRefs:[]});
const replacement=prepareAnnualScenario(join(root,'replacement'),{empty:true});renameSync(f.target.dbPath,f.target.dbPath+'.original');copyFileSync(replacement.target.dbPath,f.target.dbPath);
try{assert.equal((await inspectHarness(year)).tasks[0].executionState,'stale');}finally{unlinkSync(f.target.dbPath);renameSync(f.target.dbPath+'.original',f.target.dbPath);}
assert.equal((await inspectHarness(year)).tasks[0].confirmationCurrent,false,'observed target replacement and restore cannot revive old accountant confirmation');assert.equal((await inspectHarness(year)).tasks[0].executionState,'stale');
console.log('PASS temporary child lock and unreadable source preserve versions and recover; fixture: '+root);
await postingRecovery();
await voucherProofChanges();
