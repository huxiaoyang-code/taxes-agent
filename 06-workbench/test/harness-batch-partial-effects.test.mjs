import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {preparePeriodScenario} from './period-business.test.mjs';
import {initHarness,registerHarnessSource,registerHarnessFacts,planHarness,inspectHarness,runHarnessTask} from '../server/harness-runtime.mjs';
import {harnessCapabilities,callHarnessAdapter} from '../server/harness-adapters.mjs';
import {captureHarnessCode} from '../server/harness-code.mjs';
import {committedBridgeObservation,batchPartialEffects} from '../server/harness-batch-effects.mjs';
import {queryOperation} from '../server/local-audit-operation.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';

// Real native posting + actual batch checkpoint race, not a fabricated report.
// Every source, review and database below is synthetic and remains in this run.
mkdirSync(resolve('.agent-runs'),{recursive:true});
const root=mkdtempSync(resolve('.agent-runs/batch-partial-'));
console.log('Synthetic partial-effects reproduction: '+root);
const json=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2));
const fact=(factId,value,state='provided')=>({factId,state,reason:'Synthetic original-operation batch regression',sourceRefs:state==='provided'?['raw']:[],...(state==='provided'?{value}:{})});
const task=(taskId,capabilityId,factId)=>({taskId,capabilityId,requestFactId:factId,factIds:[factId],dependsOn:[],goal:'Preserve original effects independently of current review'});
const caps=harnessCapabilities();
assert.ok(captureHarnessCode(['./harness-batch-worker.mjs','./local-batch-harness-worker.mjs']).files.some(f=>f.path==='harness-batch-effects.mjs'),'new projection participates in transitive code identity');

async function scenario(name,{missing=false}={}){
 const f=preparePeriodScenario(join(root,name)),store=join(f.root,'month');
 await initHarness(store,{...f.scope,period:'2026-01'});
 await registerHarnessSource(store,{sourceId:'raw',path:f.sourcePath,locator:'Synthetic business originals',parsed:false,unrecognized:[],classification:'provided'});
 const request={target:f.target,manifestPath:f.manifestPaths[0],batchId:name+'-posting',evidenceDir:join(f.root,'evidence'),feedbackPath:join(f.root,'posting-feedback.json')};
 mkdirSync(request.evidenceDir);
 await registerHarnessFacts(store,[fact('request',request,missing?'missing':'provided')]);
 await planHarness(store,[task('posting','agency.posting','request')]);
 if(!missing){
  const t=(await inspectHarness(store)).tasks[0],prepared=await runHarnessTask(store,{taskId:t.taskId,phase:'prepare',dependencyDigest:t.dependencyDigest});
  assert.equal(prepared.status,'prepared',JSON.stringify(prepared));
  const proposal=prepared.receipt.actualImpact.proposal;
  json(request.feedbackPath,{decision:'accept',reviewer:'SYNTHETIC-TEST-ONLY',...Object.fromEntries(['targetVersion','dependencyDigest','planDigest'].map(k=>[k,proposal[k]]))});
 }
 const t=(await inspectHarness(store)).tasks[0];
 const manifest={schemaVersion:1,jobKey:name,items:[{itemKey:'enterprise-a',accountSetId:f.target.accountSetId,source:{system:'agency',enterpriseKey:f.target.enterpriseKey},periods:[{period:'2026-01',harnessTasks:[{storePath:store,taskId:t.taskId,capabilityId:t.capabilityId,dependencyDigest:t.dependencyDigest}]}]}]};
 const manifestPath=join(f.root,'batch.json');json(manifestPath,manifest);
 return {...f,store,request,manifest,manifestPath};
}
function nativeState(f){
 const db=new DatabaseSync(f.target.dbPath,{readOnly:true});
 try{return {vouchers:db.prepare('SELECT * FROM vouchers ORDER BY id').all(),entries:db.prepare('SELECT * FROM voucher_entries ORDER BY id').all(),otherCount:db.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?').get(f.otherId).n,operation:queryOperation(db,{databaseInstanceId:f.target.databaseInstanceId,operationId:'agency-'+f.request.batchId})};}
 finally{db.close();}
}
const adapter=(f,capabilityId,phase='execute',extra={})=>callHarnessAdapter({capabilityId,phase,scope:{...f.scope,period:'2026'},request:{target:f.target,jobKey:f.manifest.jobKey,...(capabilityId==='batch.start'?{manifestPath:f.manifestPath,outputDir:join(f.root,'batch-output')}:{}),...extra},operationId:'harness-batch-'+f.manifest.jobKey,codeDigest:caps.get(capabilityId).codeDigest});
function startWithRace(f,{workerUnavailable=false}={}){
 const runnerUrl=new URL('../server/local-batch-runner.mjs',import.meta.url).href,storageUrl=new URL('../server/local-batch-storage.mjs',import.meta.url).href;
 const unavailableHook=workerUnavailable?"childProcess.spawnSync=(file,args,...rest)=>args?.[0]?.endsWith('local-batch-harness-worker.mjs')?{status:1,stdout:'',stderr:''}:originalSpawn(file,args,...rest);syncBuiltinESMExports();":'';
 const script=`import childProcess from'node:child_process';import{syncBuiltinESMExports}from'node:module';const originalSpawn=childProcess.spawnSync;import{readFileSync,writeFileSync,renameSync}from'node:fs';import{dirname}from'node:path';import*as storage from ${JSON.stringify(storageUrl)};const runner=await import(${JSON.stringify(runnerUrl)});try{const file=storage.readManifestFile(${JSON.stringify(f.manifestPath)}),v=storage.validateManifest(file.manifest);if(!v.ok)throw Error(JSON.stringify(v));const manifest=v.manifest,{plans,inputs}=storage.buildPlan({manifest,manifestDir:dirname(${JSON.stringify(f.manifestPath)})});await runner.createAndRun({manifest,manifestJson:storage.canonicalJson(manifest),manifestHash:storage.sha256(storage.canonicalJson(manifest)),plans,inputs,outputDir:${JSON.stringify(join(f.root,'batch-output'))},hooks:{afterHarnessEffect({bridge}){writeFileSync(${JSON.stringify(join(f.root,'before-feedback-race.json'))},JSON.stringify(bridge,null,2));renameSync(${JSON.stringify(f.request.feedbackPath)},${JSON.stringify(f.request.feedbackPath+'.unavailable')});${unavailableHook}}}});writeFileSync(${JSON.stringify(join(f.root,'first-report.json'))},JSON.stringify(storage.readJobStatus(runner.database,manifest.jobKey),null,2));}finally{runner.database.close();}`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,WORKBENCH_DATA_DIR:dirname(f.target.dbPath),NODE_NO_WARNINGS:'1'},encoding:'utf8',windowsHide:true});
 assert.equal(child.status,0,child.stderr);return JSON.parse(readFileSync(join(f.root,'first-report.json'),'utf8'));
}

const f=await scenario('committed-review-missing'),first=startWithRace(f),stage=first.items[0].stages[0];
assert.equal(stage.status,'needs_review');assert.equal(stage.evidence.bridge.operationState,'executed');
assert.equal(stage.evidence.bridge.observation.observation.applied,true);
assert.equal(stage.evidence.bridge.observation.observation.evidenceCurrent,null);
assert.equal(first.items.some(i=>i.stages.some(s=>s.status==='succeeded')),false,'the pre-fix projection incorrectly reported false in this real chain');
const initialNative=nativeState(f);assert.equal(initialNative.vouchers.length,3);assert.equal(initialNative.otherCount,0);assert.equal(initialNative.operation.state,'succeeded');assert.ok(initialNative.operation.receipt.eventId);
json(join(f.root,'initial-native-proof.json'),initialNative);
const historical=await inspectHarness(f.store);assert.equal(historical.tasks[0].operationState,'executed');assert.equal(historical.tasks[0].confirmationCurrent,false);assert.ok(historical.history.some(a=>a.result?.executionState==='executed'));
const status=await adapter(f,'batch.status');assert.equal(status.applied,false);assert.equal(status.partialEffects,true);assert.equal(status.report.items[0].stages[0].status,'needs_review');
assert.match(status.partialEffectsMeaning,/null means effects cannot yet be established/);
const execute=await adapter(f,'batch.start');assert.equal(execute.applied,false);assert.equal(execute.partialEffects,true);assert.deepEqual(nativeState(f),initialNative);
const retry={itemKey:'enterprise-a',period:'2026-01',stageKey:stage.stageKey,reason:'Synthetic exact retry after checking the original operation'};
const stillMissing=await adapter(f,'batch.resume','execute',{retry});assert.equal(stillMissing.applied,false);assert.equal(stillMissing.partialEffects,true);assert.equal(stillMissing.report.items[0].stages[0].status,'needs_review');assert.deepEqual(nativeState(f),initialNative);
// A later unavailable Store must not erase a proven original commit at checkpoint.
renameSync(f.store,f.store+'.unavailable');
try{const unavailable=await adapter(f,'batch.resume','execute',{retry});assert.equal(unavailable.partialEffects,true);assert.ok(unavailable.report.items[0].stages[0].evidence.bridge.priorCommittedObservation);assert.equal((await adapter(f,'batch.status')).partialEffects,true);}
finally{renameSync(f.store+'.unavailable',f.store);}
assert.deepEqual(nativeState(f),initialNative);

// Actual stdio presentation: immediate run, original query, task status and full.
const batchStore=join(f.root,'batch-harness');await initHarness(batchStore,{...f.scope,period:'2026'});
await registerHarnessSource(batchStore,{sourceId:'raw',path:f.sourcePath,locator:'Synthetic original for explicit batch request',parsed:false,unrecognized:[],classification:'provided'});
await registerHarnessFacts(batchStore,[fact('start',{target:f.target,jobKey:f.manifest.jobKey,manifestPath:f.manifestPath,outputDir:join(f.root,'batch-output')}),fact('status',{target:f.target,jobKey:f.manifest.jobKey}),fact('resume',{target:f.target,jobKey:f.manifest.jobKey,retry})]);
await planHarness(batchStore,[task('start','batch.start','start'),task('status','batch.status','status'),task('resume','batch.resume','resume')]);
const client=new McpStdioClient(resolve('../05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{env:{NODE_NO_WARNINGS:'1'},timeoutMs:120000}).start();
const call=async(name,args={})=>{const r=await client.call(name,{storePath:batchStore,...args});assert.ok(!r.rpcError,r.text);assert.ok(r.structured,r.text);return r.structured;};
const run=async(taskId,args={})=>{const t=(await inspectHarness(batchStore)).tasks.find(t=>t.taskId===taskId);return call('harness_run',{taskId,dependencyDigest:t.dependencyDigest,...args});};
try{
 await client.initialize();
 const immediate=await run('start');assert.equal(immediate.receipt.actualImpact.partialEffects,true,JSON.stringify(immediate));assert.equal(immediate.receipt.actualImpact.applied,false);
 const summary=await run('status');assert.equal(summary.receipt.actualImpact.partialEffects,true);assert.equal(summary.receipt.actualImpact.applied,false);
 const full=await run('status',{responseMode:'full'});assert.equal(full.receipt.actualImpact.partialEffects,true);assert.equal(full.receipt.actualImpact.report.items[0].stages[0].status,'needs_review');
 const resume=await run('resume');assert.equal(resume.receipt.actualImpact.partialEffects,true);assert.equal(resume.receipt.actualImpact.applied,false);
 for(const responseMode of ['summary','full']){const queried=await run('resume',{phase:'query',responseMode});assert.equal(queried.observation.partialEffects,true);assert.equal(queried.observation.applied,false);}
 const view=await call('harness_status');for(const t of view.tasks){const receipt=t.receipt??t.historicalReceipt;assert.equal(receipt.actualImpact.partialEffects,true,JSON.stringify(t));}
 // Receipt detail pointer returns original report and flags, not the bounded preview.
 const pointer=summary.receipt.actualImpact.details;
 const detail=await call('harness_receipt_read',{receiptRef:pointer.receiptRef,pointer:'/receipt/actualImpact/partialEffects'});assert.equal(JSON.parse(detail.fragment),true,JSON.stringify(detail));
 renameSync(f.request.feedbackPath+'.unavailable',f.request.feedbackPath);
 const completed=await run('resume',{responseMode:'full'});assert.equal(completed.receipt.actualImpact.applied,true,JSON.stringify(completed));assert.equal(completed.receipt.actualImpact.partialEffects,false);assert.equal(completed.receipt.actualImpact.report.items[0].stages[0].status,'succeeded');
 const replay=await run('resume');assert.equal(replay.status,'replayed');assert.equal(replay.observation.partialEffects,false);assert.equal(replay.observation.applied,true);
 assert.deepEqual(nativeState(f),initialNative,'resume/query/replay preserve all three vouchers, entries and original audit receipt/event');
 const originalView=await inspectHarness(f.store);assert.equal(originalView.tasks[0].operationState,'executed');assert.equal(originalView.tasks[0].confirmationCurrent,false,'native completion is not Harness accountant acceptance');assert.ok(originalView.history.some(a=>a.result?.executionState==='executed'));
}finally{await client.close();}
console.log('PASS real 3-voucher commit -> missing feedback/needs_review -> unavailable Store history -> exact resume; same native event/count; MCP run/query/replay/status summary/full retain effect flags');

async function verifyMcpEffects(f,report,expected){
 const storePath=join(f.root,'effect-probe');await initHarness(storePath,{...f.scope,period:'2026'});
 await registerHarnessSource(storePath,{sourceId:'raw',path:f.sourcePath,locator:'Synthetic original for batch probe',parsed:false,unrecognized:[],classification:'provided'});
 const retry={itemKey:'enterprise-a',period:'2026-01',stageKey:report.items[0].stages[0].stageKey,reason:'Synthetic retry preserves false versus unknown'};
 await registerHarnessFacts(storePath,[fact('status',{target:f.target,jobKey:f.manifest.jobKey}),fact('resume',{target:f.target,jobKey:f.manifest.jobKey,retry})]);
 await planHarness(storePath,[task('status','batch.status','status'),task('resume','batch.resume','resume')]);
 const client=new McpStdioClient(resolve('../05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{env:{NODE_NO_WARNINGS:'1'},timeoutMs:120000}).start();
 const call=async(name,args)=>{const r=await client.call(name,{storePath,...args});assert.ok(!r.rpcError,r.text);assert.ok(r.structured,r.text);return r.structured;};
 const run=async(taskId,args)=>{const t=(await inspectHarness(storePath)).tasks.find(t=>t.taskId===taskId);return call('harness_run',{taskId,dependencyDigest:t.dependencyDigest,...args});};
 try{
  await client.initialize();
  for(const responseMode of ['summary','full']){
   for(const id of ['status','resume']){const value=await run(id,{responseMode});assert.equal(value.receipt.actualImpact.partialEffects,expected,JSON.stringify(value));assert.equal(value.receipt.actualImpact.applied,false);assert.ok(Object.hasOwn(value.receipt.actualImpact,'partialEffects'));}
   const query=await run('resume',{phase:'query',responseMode});assert.equal(query.observation.partialEffects,expected,JSON.stringify(query));assert.equal(query.observation.applied,false);assert.ok(Object.hasOwn(query.observation,'partialEffects'));
   const status=await call('harness_status',{responseMode});for(const t of status.tasks){const impact=(t.receipt??t.historicalReceipt).actualImpact;assert.equal(impact.partialEffects,expected);assert.ok(Object.hasOwn(impact,'partialEffects'));}
  }
 }finally{await client.close();}
}

// After the actual commit, a synthetic child-transport failure exercises the
// real no-identity query return. Only the already-verified ctx-bound prior receipt
// supplies the retained identity; no source files or production workers change.
const unavailableWorker=await scenario('committed-worker-unavailable'),workerReport=startWithRace(unavailableWorker,{workerUnavailable:true}),workerStage=workerReport.items[0].stages[0];
assert.equal(workerStage.status,'needs_review');assert.equal(workerStage.evidence.bridge.code,'batch_harness_worker_unavailable');assert.ok(workerStage.evidence.bridge.priorCommittedObservation);
assert.equal(workerStage.evidence.bridge.taskIdentity.dependencyDigest,workerStage.evidence.bridge.priorCommittedObservation.taskIdentity.dependencyDigest);
assert.ok(committedBridgeObservation(workerStage.evidence.bridge));
const workerNative=nativeState(unavailableWorker);assert.equal(workerNative.vouchers.length,3);assert.equal(workerNative.operation.state,'succeeded');
assert.equal((await adapter(unavailableWorker,'batch.status')).partialEffects,true);
renameSync(unavailableWorker.request.feedbackPath+'.unavailable',unavailableWorker.request.feedbackPath);
const workerResume=await adapter(unavailableWorker,'batch.resume','execute',{retry:{itemKey:'enterprise-a',period:'2026-01',stageKey:workerStage.stageKey,reason:'Synthetic original commit retained across failed current worker response'}});
assert.equal(workerResume.applied,true);assert.equal(workerResume.partialEffects,false);assert.deepEqual(nativeState(unavailableWorker),workerNative);
console.log('PASS actual commit with injected child transport failure: ctx-bound identity/prior effect retained, original native event and 3 vouchers unchanged after recovery');

// A task's historical executed state is not proof that its new request ran.
// Reuse the committed book, change the request identity, and start a new version
// job without preparing or executing that new native posting operation.
const newRequest={...f.request,batchId:'new-version-never-executed'};
await registerHarnessFacts(f.store,[fact('request',newRequest)]);
const changedTask=(await inspectHarness(f.store)).tasks[0];
assert.equal(changedTask.operationState,'executed');assert.notEqual(changedTask.dependencyDigest,stage.evidence.bridge.taskIdentity.dependencyDigest);
const newManifest={...f.manifest,jobKey:'new-request-no-native-operation',items:[{...f.manifest.items[0],periods:[{period:'2026-01',harnessTasks:[{storePath:f.store,taskId:changedTask.taskId,capabilityId:changedTask.capabilityId,dependencyDigest:changedTask.dependencyDigest}]}]}]};
const newManifestPath=join(f.root,'new-request-batch.json');json(newManifestPath,newManifest);
const newVersion={...f,request:newRequest,manifest:newManifest,manifestPath:newManifestPath};
const newResult=await adapter(newVersion,'batch.start');json(join(f.root,'new-version-report.json'),newResult);
assert.equal(newResult.applied,false);assert.equal(newResult.partialEffects,null,JSON.stringify(newResult));
const newStage=newResult.report.items[0].stages[0],newBridge=newStage.evidence.bridge;
assert.equal(newStage.status,'needs_review');assert.equal(newBridge.operationState,'executed');
assert.notEqual(newBridge.historicalReceipt.dependencyDigest,newBridge.taskIdentity.dependencyDigest);
assert.equal(committedBridgeObservation(newBridge),null);
assert.equal(committedBridgeObservation({...newBridge,priorCommittedObservation:stage.evidence.bridge}),null,'retained evidence from a different manifest version cannot establish this request');
assert.equal(batchPartialEffects({...newResult.report,items:[{...newResult.report.items[0],stages:[{...newStage,status:'succeeded'}]}]},{complete:false}),null,'a Harness bridge with mismatched receipt version is not rescued by a stage label');
const catchChild=spawnSync(process.execPath,[resolve('server/local-batch-harness-worker.mjs')],{input:JSON.stringify({scope:{...f.scope,period:'2026'},period:'2026-01',phase:'execute',spec:newManifest.items[0].periods[0].harnessTasks[0],bridgeCodeDigest:'0'.repeat(64)}),env:{...process.env,NODE_NO_WARNINGS:'1'},encoding:'utf8',windowsHide:true});
assert.equal(catchChild.status,0,catchChild.stderr);const catchBridge=JSON.parse(catchChild.stdout);assert.equal(catchBridge.code,'harness_code_changed');assert.equal(catchBridge.operationState,'executed');assert.equal(committedBridgeObservation(catchBridge),null,'catch-state history uses the same manifest receipt binding');
const noNewNative=()=>{const db=new DatabaseSync(f.target.dbPath,{readOnly:true});try{return db.prepare('SELECT COUNT(*) n FROM audit_operations WHERE operation_id=?').get('agency-'+newRequest.batchId).n;}finally{db.close();}};
assert.equal(noNewNative(),0);assert.deepEqual(nativeState(f),initialNative);
assert.equal((await adapter(newVersion,'batch.status')).partialEffects,null);
await verifyMcpEffects(newVersion,newResult.report,null);
assert.equal(noNewNative(),0);assert.deepEqual(nativeState(f),initialNative);
assert.ok((await inspectHarness(f.store)).history.some(a=>a.result?.operationId===initialNative.operation.receipt.operationId&&a.result.executionState==='executed'),'old successful history remains observable');
console.log('PASS actual old write -> new same-task request/version/job remains unknown; normal/catch/prior-history bindings exclude old receipt, new native operation count=0, old 3 vouchers/event remain; MCP summary/full retain null');

// Distinct real jobs prove no execution vs unavailable evidence, rather than
// deriving false solely from the fact that no stage says succeeded.
const zero=await scenario('known-not-executed',{missing:true}),zeroResult=await adapter(zero,'batch.start');
assert.equal(zeroResult.applied,false);assert.equal(zeroResult.partialEffects,false,JSON.stringify(zeroResult));assert.equal(zeroResult.report.items[0].stages[0].evidence.bridge.operationState,'not_started');assert.equal(nativeState(zero).vouchers.length,0);assert.equal((await adapter(zero,'batch.status')).partialEffects,false);await verifyMcpEffects(zero,zeroResult.report,false);
const unknown=await scenario('unavailable-before-observation');renameSync(unknown.store,unknown.store+'.unavailable');
try{const result=await adapter(unknown,'batch.start');assert.equal(result.applied,false);assert.equal(result.partialEffects,null,JSON.stringify(result));assert.equal(result.report.items[0].stages[0].status,'needs_review');assert.equal((await adapter(unknown,'batch.status')).partialEffects,null);assert.equal(nativeState(unknown).vouchers.length,0);await verifyMcpEffects(unknown,result.report,null);}
finally{renameSync(unknown.store+'.unavailable',unknown.store);}
console.log('PASS real blocked original-operation state=false versus unavailable Store=null; exact MCP summary/full run/query/status retain both properties without implying permission to retry');
