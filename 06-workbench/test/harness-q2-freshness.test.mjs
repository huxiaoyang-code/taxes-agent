// 合成原生 Q2 证明：计算被阻塞与观测不可用
// 是不同状态。不提供税费公式或调用者伪造的回执。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createQ2Fixture, createPublicNoopBatch } from './helpers/offline-vat-q2-fixture.mjs';
import { initHarness, registerHarnessSource, registerHarnessFacts, planHarness, inspectHarness, runHarnessTask, feedbackHarness } from '../server/harness-runtime.mjs';
import { loadHarness } from '../server/harness-store.mjs';
import { callHarnessAdapter } from '../server/harness-adapters.mjs';

mkdirSync(resolve('.agent-runs'),{recursive:true});
const root=mkdtempSync(resolve('.agent-runs/harness-q2-freshness-')),q=await createQ2Fixture(join(root,'fixture')),path=join(root,'state');
const scope={enterpriseKey:q.key,accountSetId:q.id,databaseInstanceId:q.instanceId,period:'2026-Q2',currency:'CNY'};
await initHarness(path,scope);
await registerHarnessSource(path,{sourceId:'raw',path:q.targetInputPath,locator:'Synthetic Q2 input; native worker independently reads Q1/Q2 originals and ledger',parsed:false,unrecognized:[],classification:'provided'});
const fact=(factId,value)=>({factId,state:'provided',reason:'Synthetic native Q2 regression',sourceRefs:['raw'],value});
const tasks=[{taskId:'tax',capabilityId:'offline.vat_q2',factIds:['request'],dependsOn:[],goal:'Existing native Q1/Q2 calculation and scoped ledger proof'}];
await registerHarnessFacts(path,[fact('request',q.request)]);await planHarness(path,tasks);
const run=async taskId=>{const t=(await inspectHarness(path)).tasks.find(t=>t.taskId===taskId);return runHarnessTask(path,{taskId,dependencyDigest:t.dependencyDigest});};
const calculated=await run('tax');assert.equal(calculated.status,'executed');assert.equal(calculated.receipt.actualImpact.q2CalculationReady,true);
assert.equal(calculated.receipt.actualImpact.computation.cells.find(c=>c.row===1&&c.column==='services'&&c.period==='current').value,'347291.00');
let current=(await inspectHarness(path)).tasks[0];
const feedback={taskId:'tax',targetVersion:current.receipt.targetVersion,dependencyDigest:current.dependencyDigest,decision:'accept',reason:'Synthetic native Q1/Q2 numerical review',reviewer:'SYNTHETIC-ACCOUNTANT',evidenceRefs:[]};
await feedbackHarness(path,feedback);

renameSync(q.request.priorInputPath,q.request.priorInputPath+'.unavailable');
try {
  const unreadable=(await inspectHarness(path)).tasks[0];assert.equal(unreadable.executionState,'executed');assert.equal(unreadable.dependencyDigest,current.dependencyDigest);assert.equal(unreadable.resultCurrent,null);assert.equal(unreadable.confirmationCurrent,null);assert.ok(unreadable.blockers.some(b=>b.retryable));assert.equal((await loadHarness(path)).invalidatedResults.size,0);
} finally {renameSync(q.request.priorInputPath+'.unavailable',q.request.priorInputPath);}
assert.equal((await inspectHarness(path)).tasks[0].confirmationCurrent,true);
const other=createPublicNoopBatch(q,{otherEnterprise:true});assert.notEqual(other.id,q.id);assert.equal((await inspectHarness(path)).tasks[0].reviewState,'accepted');
await feedbackHarness(path,{...feedback,decision:'reject',reason:'Synthetic accountant requires actual Q2 posting correction'});
const db=new DatabaseSync(q.dbPath,{readOnly:true});let voucherId;
try{voucherId=db.prepare("SELECT id FROM vouchers WHERE account_set_id=? AND period='2026-04' AND status='posted' AND kind='normal'").get(q.id).id;}finally{db.close();}
await registerHarnessFacts(path,[fact('correction',{target:q.request.target,voucherId,correctionOf:{taskId:'tax',targetVersion:calculated.receipt.targetVersion}})]);
tasks.push({taskId:'correction',capabilityId:'voucher.unpost',factIds:['correction'],dependsOn:['tax'],goal:'Existing native correction of the actually posted Q2 voucher'});await planHarness(path,tasks);
assert.equal((await run('correction')).status,'executed');
const saved=await loadHarness(path),attempt=saved.attempts.find(a=>a.taskId==='tax'&&a.result?.executionState==='executed');
const actual=await callHarnessAdapter({...attempt,phase:'execute',scope,priorResult:attempt.result.actualImpact});
assert.equal(actual.status,'blocked');assert.equal(actual.proof.status,'current');assert.notEqual(actual.binding.target.ledgerDigest,calculated.receipt.actualImpact.binding.target.ledgerDigest);assert.equal(actual.businessProofCurrent,false);
current=(await inspectHarness(path)).tasks[0];assert.equal(current.executionState,'stale');assert.equal(current.reviewState,'stale');assert.equal(current.operationState,'executed');assert.equal(current.historicalReceipt.targetVersion,calculated.receipt.targetVersion);assert.ok((await loadHarness(path)).invalidatedResults.has(calculated.receipt.targetVersion));await assert.rejects(()=>feedbackHarness(path,feedback),{code:'harness_feedback_stale'});

const accounting=pathToFileURL(resolve('server/accounting.mjs')).href,database=pathToFileURL(resolve('server/db.mjs')).href;
const restored=spawnSync(process.execPath,['--input-type=module','-e',`const A=await import(${JSON.stringify(accounting)}),{db}=await import(${JSON.stringify(database)});try{A.postVoucher(${q.id},${voucherId});}finally{db.close();}`],{encoding:'utf8',windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1',WORKBENCH_DATA_DIR:resolve(q.dbPath,'..')}});assert.equal(restored.status,0,restored.stderr);
assert.equal((await inspectHarness(path)).tasks[0].executionState,'stale','restoring the original posted state cannot revive observed-invalid confirmation');
const recalculated=await run('tax');assert.equal(recalculated.status,'executed');assert.notEqual(recalculated.receipt.targetVersion,calculated.receipt.targetVersion);assert.equal((await inspectHarness(path)).tasks[0].reviewState,'pending');
console.log('PASS Q2: temporary missing input retries without invalidation; other-company writes isolated; accepted/rejected result -> native unpost -> verified blocked binding invalidates; restore/recompute stays pending. Artifacts: '+root);
