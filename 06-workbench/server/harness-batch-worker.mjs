// Fixed adapter around the existing batch storage/runner. No alternate queue.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync } from 'node:fs';
import { dirname, basename, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { checkedPath } from './offline-material-store.mjs';
import { captureHarnessCode } from './harness-code.mjs';
import { scopeContainsMonth } from './harness-contract.mjs';
import * as storage from './local-batch-storage.mjs';
import { openReadonlyLedgerSource, captureLedgerSnapshot } from './offline-ledger-snapshot.mjs';
const check=(v,code)=>{if(!v)throw Object.assign(new Error(code),{code});};
let db,started=false;
try {
 const r=JSON.parse(readFileSync(0,'utf8'));check(['batch.start','batch.resume','batch.status'].includes(r.action),'harness_batch_action_invalid');
 check(captureHarnessCode(['./harness-batch-worker.mjs']).digest===r.codeDigest,'harness_code_changed');
 const path=await checkedPath(r.request.target.dbPath);check(basename(path)==='workbench.db','harness_db_invalid');const before=statSync(path);
 const verify=d=>{check(d.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get()?.instance_id===r.scope.databaseInstanceId,'harness_instance_mismatch');check(d.prepare('SELECT enterprise_key FROM import_enterprise_account_sets WHERE account_set_id=?').get(r.scope.accountSetId)?.enterprise_key===r.scope.enterpriseKey,'harness_enterprise_mismatch');storage.assertBatchRunnable(d);};
 db=new DatabaseSync(path,{readOnly:true});verify(db);
 let manifest,file,plans,inputs;
 if(r.action==='batch.start') {
   file=storage.readManifestFile(await checkedPath(r.request.manifestPath));const v=storage.validateManifest(file.manifest);check(v.ok,'harness_batch_manifest_invalid');manifest=v.manifest;
   check(manifest.jobKey===r.request.jobKey&&manifest.items.every(i=>i.accountSetId===r.scope.accountSetId&&i.source.enterpriseKey===r.scope.enterpriseKey&&i.periods.every(p=>scopeContainsMonth(r.scope,p.period))),'harness_batch_scope_mismatch');
   ({plans,inputs}=storage.buildPlan({manifest,manifestDir:dirname(r.request.manifestPath)}));
 } else {
   const report=storage.readJobStatus(db,r.request.jobKey);check(report&&report.items.every(i=>i.accountSetId===r.scope.accountSetId&&i.enterpriseKey===r.scope.enterpriseKey&&i.stages.every(t=>!t.period||scopeContainsMonth(r.scope,t.period))),'harness_batch_scope_mismatch');
 }
 const prove=async report=>{
   const artifacts=[];
   for(const i of report.items)for(const a of i.artifacts){if(a.status!=='published'){artifacts.push([a.artifactKey,a.status]);continue;}const file=resolve(report.outputDir,a.relativePath);check(file.startsWith(resolve(report.outputDir)+sep),'harness_artifact_path_invalid');const bytes=readFileSync(await checkedPath(file)),digest=createHash('sha256').update(bytes).digest('hex');check(digest===a.bytesHash&&bytes.length===a.bytes,'harness_artifact_changed');artifacts.push([a.artifactKey,digest]);}
   const months=report.items.flatMap(i=>i.stages.map(t=>t.period).filter(Boolean)).sort();let ledgerDigest=null;
   if(months.length){const source=openReadonlyLedgerSource(path);try{ledgerDigest=captureLedgerSnapshot(source,{enterpriseKey:r.scope.enterpriseKey,accountSetId:r.scope.accountSetId,fromPeriod:months[0],toPeriod:months.at(-1)}).contentDigest;}finally{source.close();}}
   return createHash('sha256').update(JSON.stringify({report,artifacts,ledgerDigest})).digest('hex');
 };
 if(r.phase==='query'||r.action==='batch.status') {
   const report=storage.readJobStatus(db,r.request.jobKey),proofDigest=await prove(report);process.stdout.write(JSON.stringify({status:report.status==='succeeded'?'recovered':'blocked',applied:report.status==='succeeded',report,proofDigest,partialEffects:report.status!=='succeeded'&&report.items.some(i=>i.stages.some(t=>t.status==='succeeded')),code:report.items.find(i=>i.errorCode)?.errorCode??null}));
 } else {
   db.close();db=null;process.env.WORKBENCH_DATA_DIR=dirname(path);const runner=await import('./local-batch-runner.mjs');db=runner.database;
   const after=statSync(await checkedPath(path));check(before.dev===after.dev&&before.ino===after.ino,'harness_path_changed');verify(db);check(captureHarnessCode(['./harness-batch-worker.mjs']).digest===r.codeDigest,'harness_code_changed');started=true;
   const result=r.action==='batch.start'?await runner.createAndRun({manifest,manifestJson:storage.canonicalJson(manifest),manifestHash:storage.sha256(storage.canonicalJson(manifest)),plans,inputs,outputDir:r.request.outputDir}):await runner.resumeJob({jobKey:r.request.jobKey});
   const report=storage.readJobStatus(db,r.request.jobKey),proofDigest=await prove(report);process.stdout.write(JSON.stringify({status:report.status==='succeeded'?'executed':'blocked',applied:report.status==='succeeded',result,report,proofDigest,partialEffects:report.status!=='succeeded'&&report.items.some(i=>i.stages.some(t=>t.status==='succeeded')),code:report.items.find(i=>i.errorCode)?.errorCode??null}));
 }
}catch(e){process.stdout.write(JSON.stringify({status:started?'unknown':'blocked',applied:started?'unknown':false,code:/^[a-z][a-z0-9_]+$/.test(e?.code)?e.code:'harness_batch_failed',recoveryPath:'Use existing local-batch status/resume or restore-check/restore-activate; never copy a database to claim recovery'}));}
finally{try{db?.close();}catch{}}
