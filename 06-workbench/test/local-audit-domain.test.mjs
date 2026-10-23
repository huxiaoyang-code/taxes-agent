import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {runChild} from './local-audit-http.test.mjs';
const root=fs.mkdtempSync(join(tmpdir(),'audit-domain-'));
for(let p=resolve(root);;p=dirname(p)){assert.equal(fs.lstatSync(p).isSymbolicLink(),false);assert.equal(fs.realpathSync.native(p).toLowerCase(),resolve(p).toLowerCase());if(dirname(p)===p)break;}
process.env.TEMP=root;process.env.TMP=root;process.env.WORKBENCH_DATA_DIR=join(root,'data');process.env.KEEP_FIXTURES='1';process.env.WORKBENCH_TEST_KEEP_FIXTURES='1';
const {db}=await import('../server/db.mjs');
const A=await import('../server/accounting.mjs');
const I=await import('../server/import-incremental.mjs');
const C=await import('../server/local-audit-coordinator.mjs');
const LA=await import('../server/local-audit.mjs');
const LS=await import('../server/local-audit-storage.mjs');
const op=(id,fn)=>C.withRequestMetadata({operationId:id,actor:'domain'},fn);
let groups=0;
try {
 const input={name:'合成甲',start_period:'2026-01',enterprise:{enterpriseKey:'SYN-AUDIT-A'}};
 const createId=randomUUID();const a=op(createId,()=>A.createAccountSet(input));assert.deepEqual(op(createId,()=>A.createAccountSet(input)),JSON.parse(JSON.stringify(a)));
 assert.throws(()=>op(createId,()=>A.createAccountSet({...input,name:'变更'})),/audit_operation_conflict/);groups++;
 const b=A.createAccountSet({...input,name:'合成乙',enterprise:{enterpriseKey:'SYN-AUDIT-B'},accounting_standard:'企业会计准则'});
 for(const s of [a,b]) {const income=s.accounting_standard==='企业会计准则'?'6001':'5001';const v=A.createVoucher(s.id,{period:'2026-01',voucher_date:'2026-01-03',status:'posted',entries:[{code:'1002',debit:200},{code:income,credit:200}]});assert.equal(v.status,'posted');assert.equal(A.trialBalance(s.id,'2026-01').lines.find(x=>x.code==='1002').closing_debit,200);}
 assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='voucher.create_posted' AND outcome='succeeded'").get().n,2);groups++;
 const before=db.prepare('SELECT COUNT(*) n FROM vouchers').get().n;
 for(const command of ['BEGIN','SAVEPOINT caller']) {db.exec(command);assert.throws(()=>A.createVoucher(a.id,{}),/audit_transaction_conflict/);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');}assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers').get().n,before);groups++;
 const v=A.createVoucher(a.id,{period:'2026-01',voucher_date:'2026-01-04',entries:[{code:'1002',debit:12.39},{code:'5001',credit:12.39}]});
 A.postVoucher(a.id,v.id);A.unpostVoucher(a.id,v.id);A.postVoucher(a.id,v.id);assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE voucher_id=? AND action IN ('voucher.post','voucher.unpost')").get(v.id).n,3);groups++;
 const gone=A.createAccountSet({...input,enterprise:{enterpriseKey:'GONE'}}),deleteId=randomUUID();assert.equal(op(deleteId,()=>A.deleteAccountSet(gone.id)),undefined);assert.equal(op(deleteId,()=>A.deleteAccountSet(gone.id)),undefined);assert.throws(()=>A.deleteAccountSet(gone.id),/audit_operation_invalid/);groups++;
 let getterCalls=0;
 const accessor={get debit(){getterCalls++;return 1;}};const proxy=new Proxy({},{get(){getterCalls++;throw Error('trap');},ownKeys(){getterCalls++;throw Error('trap');}});const cycle={};cycle.self=cycle;
 const totalBefore=db.prepare('SELECT total_changes() n').get().n;
 for(const bad of [accessor,proxy,cycle,{fn(){}}]){
  for(const call of [()=>A.setOpeningBalances(a.id,[bad]),()=>A.createVoucher(a.id,{period:'2026-01',entries:[bad]}),()=>A.addAssetCard(a.id,bad),()=>A.importAccountSet(bad,{enterprise:{enterpriseKey:'BAD-ADMISSION'}}),()=>A.importAccountSet({},bad)])assert.throws(call,/audit_result_invalid/);
 }
 assert.equal(getterCalls,0);assert.equal(db.prepare('SELECT total_changes() n').get().n,totalBefore);
 assert.throws(()=>A.setOpeningBalances(a.id,[{code:'1002',debit:NaN}]),/opening_rewrite_after_posting/);assert.equal(db.prepare('SELECT total_changes() n').get().n,totalBefore);groups++;
 const payload={account_set:{name:'首次合成',start_period:'2026-01'},vouchers:[{sourceVoucherId:'SOURCE1',period:'2026-01',date:'2026-01-02',entries:[{code:'1002',debit:42.37},{code:'5001',credit:42.37}]}]};
 const imported=I.importIncremental({mode:'create',batchId:'SYN-BATCH',source:{system:'synthetic',enterpriseKey:'SYN-I'},payload,dryRun:false});assert.equal(imported.status,'applied');groups++;
 const importOptions={mode:'create',batchId:'SYN-ID-CROSS',source:{system:'synthetic',enterpriseKey:'SYN-ID-CROSS'},payload,dryRun:false};
 const crossId=randomUUID();C.withRequestMetadata({operationId:crossId,actor:'domain'},()=>C.runDomainOperation(db,{action:'account_set.create',scope:{kind:'database',value:null},request:importOptions},()=>({synthetic:true})));
 const crossBefore=db.prepare('SELECT COUNT(*) n FROM account_sets').get().n;
 assert.throws(()=>op(crossId,()=>I.importIncremental(importOptions)),/audit_operation_conflict/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM account_sets').get().n,crossBefore);assert.equal(db.prepare("SELECT COUNT(*) n FROM import_batches WHERE batch_id='SYN-ID-CROSS'").get().n,0);groups++;
 for(const mode of ['batch','audit']) {
  const operationId=randomUUID(),batchId='I-FAULT-'+mode,enterpriseKey='I-FAULT-'+mode;
  const options={mode:'create',batchId,source:{system:'synthetic',enterpriseKey},payload,dryRun:false};
  const setsBefore=db.prepare('SELECT COUNT(*) n FROM account_sets').get().n;
  db.exec("CREATE TEMP TRIGGER fault_i_business BEFORE INSERT ON vouchers BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  db.exec(mode==='batch'?"CREATE TEMP TRIGGER fault_i_failure BEFORE INSERT ON import_batches WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'synthetic'); END":"CREATE TEMP TRIGGER fault_i_audit BEFORE INSERT ON audit_events WHEN NEW.action='import.create' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  try {
   assert.throws(()=>op(operationId,()=>I.importIncremental(options)),e=>C.operationErrorEvidence(e)?.applied==='unknown');
   assert.equal(db.prepare('SELECT COUNT(*) n FROM account_sets').get().n,setsBefore);
   assert.equal(db.prepare('SELECT COUNT(*) n FROM import_batches WHERE batch_id=?').get(batchId).n,0);
   assert.equal(db.prepare('SELECT COUNT(*) n FROM import_voucher_sources WHERE enterprise_key=?').get(enterpriseKey).n,0);
   assert.equal(db.prepare('SELECT state FROM audit_operations WHERE operation_id=?').get(operationId).state,'pending');
  } finally {db.exec('DROP TRIGGER fault_i_business');db.exec('DROP TRIGGER '+(mode==='batch'?'fault_i_failure':'fault_i_audit'));}
  assert.throws(()=>op(operationId,()=>I.importIncremental(options)),/audit_operation_pending/);
 }groups++;

 assert.notEqual(LA.auditResultDigest(undefined),LA.auditResultDigest(null));assert.equal(LA.auditResultDigest({x:undefined,n:12.39}),LA.auditResultDigest({n:12.39}));
 assert.equal(LA.serializeAuditResult({'2':2,'10':10}),'{"rootKind":"json","value":{"10":10,"2":2},"version":1}');
 for(const bad of [new Proxy({},{}),{get x(){throw Error('getter');}},[Infinity],{n:1n},new Date(),{f(){}}])assert.throws(()=>LA.auditResultDigest(bad),/audit_result_invalid/);groups++;
 const p=LS.prepareOperation(db,{context:{operationId:randomUUID(),actor:'domain',action:'batch.stage'},scope:{kind:'database',value:null},request:{}});
 const denied=LS.executePreparedOperation(db,p.authorization,()=>{assert.throws(()=>db.exec('SAVEPOINT injected'));assert.throws(()=>db.exec('PRAGMA foreign_keys=OFF'));assert.throws(()=>db.exec('CREATE TABLE injected(x)'));assert.throws(()=>db.exec("UPDATE audit_operations SET state='failed'"));LS.withAuditSavepoint(db,()=>{});return {state:'succeeded'};});assert.equal(denied.ok,true);assert.equal(LS.inspectAuditSchema(db).ok,true);groups++;
 const Batch=await import('../server/local-batch-storage.mjs');
 await Batch.installBatchSchema(db,{dbPath:join(process.env.WORKBENCH_DATA_DIR,'workbench.db'),outDir:join(root,'batch-install')});
 const Runner=await import('../server/local-batch-runner.mjs');
 const manifest=Batch.validateManifest({schemaVersion:1,jobKey:'audited-two',concurrency:1,items:['ONE','TWO'].map(key=>({itemKey:key,source:{system:'synthetic',enterpriseKey:'BATCH-'+key},periods:[{period:'2026-01',imports:[{batchId:'BATCH-'+key,mode:'create',payload:{account_set:{name:'批量合成',start_period:'2026-01'},vouchers:[{sourceVoucherId:'SALE',period:'2026-01',date:'2026-01-03',entries:[{code:'1002',debit:200},{code:'5001',credit:200}]}]}}],depreciation:true,carryforward:{yearEnd:false},periodCheck:true,close:true,reports:[{kind:'balance-sheet',formats:['csv']}]}]}))});
 assert.equal(manifest.ok,true,JSON.stringify(manifest.errors));const manifestJson=Batch.canonicalJson(manifest.manifest);
 const ran=await Runner.createAndRun({manifest:manifest.manifest,manifestJson,manifestHash:Batch.sha256(manifestJson),...Batch.buildPlan({manifest:manifest.manifest,manifestDir:root}),outputDir:join(root,'batch-output')});
 assert.equal(ran.finalStatus??ran.status,'succeeded',JSON.stringify(ran));
 for(const key of ['ONE','TWO']) {const s=db.prepare('SELECT account_set_id FROM import_enterprise_account_sets WHERE enterprise_key=?').get('BATCH-'+key);assert.equal(A.trialBalance(s.account_set_id,'2026-01').lines.find(x=>x.code==='1002').closing_debit,200);}
 assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='batch.stage' AND outcome='succeeded' AND stage_id IS NOT NULL AND operation_id NOT LIKE '%.report-%'").get().n,10);assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_operations WHERE parent_operation_id IS NOT NULL AND state='pending'").get().n,0);groups++;
 const again=await Runner.resumeJob({jobKey:'audited-two'});assert.equal(again.finalStatus??again.status,'succeeded');groups++;
 const fenceRaw={schemaVersion:1,jobKey:'fence-test',items:[{itemKey:'fence',source:{system:'synthetic',enterpriseKey:'FENCE-ENTERPRISE'},periods:[{period:'2026-01',imports:[{batchId:'FENCE-BATCH',mode:'create',payload:{account_set:{name:'合成锁',start_period:'2026-01'},vouchers:[]}}]}]}]};
 const fence=Batch.validateManifest(fenceRaw).manifest,fenceJson=Batch.canonicalJson(fence);const fenceResult=await Runner.createAndRun({manifest:fence,manifestJson:fenceJson,manifestHash:Batch.sha256(fenceJson),...Batch.buildPlan({manifest:fence,manifestDir:root}),outputDir:join(root,'fence-output'),hooks:{afterImportCommit(){db.exec('UPDATE local_batch_locks SET fencing_token=fencing_token+1');}}});
 assert.equal(fenceResult.status,'needs_review');assert.equal(db.prepare("SELECT COUNT(*) n FROM import_enterprise_account_sets WHERE enterprise_key='FENCE-ENTERPRISE'").get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM import_batches WHERE batch_id='FENCE-BATCH'").get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_operations WHERE parent_operation_id IS NOT NULL AND state='pending'").get().n,0);groups++;
 for(const failureMode of ['recorded','batch','audit']) {
  const jobKey='child-failure-'+failureMode,batchId='CHILD-FAIL-'+failureMode,enterpriseKey='CHILD-FAIL-'+failureMode;
  const raw={schemaVersion:1,jobKey,items:[{itemKey:'child',source:{system:'synthetic',enterpriseKey},periods:[{period:'2026-01',imports:[{batchId,mode:'create',payload}]}]}]};
  const manifest=Batch.validateManifest(raw).manifest,json=Batch.canonicalJson(manifest);
  db.exec("CREATE TEMP TRIGGER fault_child_business BEFORE INSERT ON vouchers BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  if(failureMode==='batch')db.exec("CREATE TEMP TRIGGER fault_child_failure BEFORE INSERT ON import_batches WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  if(failureMode==='audit')db.exec("CREATE TEMP TRIGGER fault_child_failure BEFORE INSERT ON audit_events WHEN NEW.action='batch.stage' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  let result;
  try {result=await Runner.createAndRun({manifest,manifestJson:json,manifestHash:Batch.sha256(json),...Batch.buildPlan({manifest,manifestDir:root}),outputDir:join(root,jobKey)});}
  finally {db.exec('DROP TRIGGER fault_child_business');if(failureMode!=='recorded')db.exec('DROP TRIGGER fault_child_failure');}
  const stage=db.prepare('SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON s.item_id=i.id JOIN local_batch_jobs j ON i.job_id=j.id WHERE j.job_key=? ORDER BY s.id LIMIT 1').get(jobKey);
  const operationId=Batch.stageAuditOperationId(stage),rows=db.prepare('SELECT state FROM audit_operations WHERE operation_id=? OR parent_operation_id=? ORDER BY operation_id').all(operationId,operationId);
  assert.equal(rows.length,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM import_enterprise_account_sets WHERE enterprise_key=?').get(enterpriseKey).n,0);
  const batch=db.prepare('SELECT * FROM import_batches WHERE batch_id=?').get(batchId);
  if(failureMode==='recorded'){assert.ok(rows.every(r=>r.state==='failed'));assert.equal(batch.status,'failed');assert.equal(batch.account_set_id,null);assert.equal(batch.attempts,1);}
  else {assert.ok(rows.every(r=>r.state==='pending'));assert.equal(batch,undefined);const oldAttempt=stage.attempt;Batch.resetStagesForRetry(db,{jobKey});assert.equal(db.prepare('SELECT attempt FROM local_batch_stages WHERE id=?').get(stage.id).attempt,oldAttempt);assert.equal(db.prepare('SELECT status FROM local_batch_stages WHERE id=?').get(stage.id).status,'needs_review');}
 }groups++;
 const BS=await import('../server/bank-storage.mjs'),B=await import('../server/bank-reconciliation.mjs'),LB=await import('../server/local-backup.mjs');
 const dbPath=join(process.env.WORKBENCH_DATA_DIR,'workbench.db');await BS.ensureBankSchema(db,{dbPath,dataDir:process.env.WORKBENCH_DATA_DIR,backupService:LB});
 B.registerBankAccount(db,{accountSetId:a.id,bankAccountId:'SYN-BANK',sourceId:'SYN',glAccountCode:'1002'});
 const bankOptions={accountSetId:a.id,bankAccountId:'SYN-BANK',sourceId:'SYN',period:'2026-01',mapping:{columns:{date:'date',summary:'summary',amount:'amount',direction:'direction',refId:'ref'},amountMode:'amount_direction',directionLabels:{inflow:['in'],outflow:['out']},currency:'CNY'}};
 const csv=amount=>`date,summary,amount,direction,ref\n2026-01-03,synthetic,${amount},in,SYN-REF\n`;
 B.importBankBatch(db,{...bankOptions,batchId:'SYN-ORIGINAL',csvText:csv(200)});
 for(let n=0;n<2;n++)assert.throws(()=>B.importBankBatch(db,{...bankOptions,batchId:'SYN-RETRY',csvText:csv(201)}),e=>e.code==='source_transaction_content_changed'&&e.auditRecorded===true);
 assert.equal(db.prepare("SELECT attempts FROM bank_batches WHERE batch_id='SYN-RETRY'").get().attempts,2);
 B.importBankBatch(db,{...bankOptions,batchId:'SYN-RETRY',csvText:csv(200)});assert.ok(db.prepare("SELECT attempts FROM bank_batches WHERE batch_id='SYN-RETRY'").get().attempts>=2);groups++;
 for(const mode of ['bank','audit']) {
  const operationId=randomUUID(),batchId='FAULT-'+mode;
  db.exec(mode==='bank'?"CREATE TEMP TRIGGER fault_bank BEFORE INSERT ON bank_batches WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'synthetic'); END":"CREATE TEMP TRIGGER fault_audit BEFORE INSERT ON audit_events WHEN NEW.action='bank.import' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  try {assert.throws(()=>op(operationId,()=>B.importBankBatch(db,{...bankOptions,batchId,csvText:csv(202)})),e=>C.operationErrorEvidence(e)?.applied==='unknown');assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_batches WHERE batch_id=?').get(batchId).n,0);assert.equal(db.prepare('SELECT state FROM audit_operations WHERE operation_id=?').get(operationId).state,'pending');}
  finally{db.exec('DROP TRIGGER '+(mode==='bank'?'fault_bank':'fault_audit'));}
  assert.throws(()=>op(operationId,()=>B.importBankBatch(db,{...bankOptions,batchId,csvText:csv(202)})),/audit_operation_pending/);
 }groups++;
 const target=db.prepare("SELECT v.id voucherId,e.id entryId FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id WHERE v.account_set_id=? AND v.status='posted' AND e.code='1002' AND e.debit=200 ORDER BY v.id LIMIT 1").get(a.id);
 const transaction=db.prepare('SELECT id FROM bank_transactions WHERE account_set_id=?').get(a.id);
 B.confirmMatch(db,{accountSetId:a.id,bankAccountId:'SYN-BANK',transactionId:transaction.id,...target,reason:'synthetic'});
 A.unpostVoucher(a.id,target.voucherId);assert.equal(B.listMatchesView(db,{accountSetId:a.id,bankAccountId:'SYN-BANK'}).invalidations.length,1);assert.equal(B.listMatchesView(db,{accountSetId:a.id,bankAccountId:'SYN-BANK'}).invalidations.length,0);groups++;
 assert.doesNotThrow(()=>B.reconcileBank(db,{accountSetId:a.id,bankAccountId:'SYN-BANK',period:'2026-01',asOf:'2026-01-31',coverageFrom:'2026-01-01',coverageTo:'2026-01-31',statementSource:'synthetic',statementOpenCents:0n,statementCloseCents:20000n}));groups++;
 const backed=LB.createBackup({dbPath,outDir:join(root,'roundtrip-backup')});assert.equal(backed.ok,true,JSON.stringify(backed));assert.equal(LB.verifyBackup({backupDir:backed.backupDir}).ok,true);
 const restored=join(root,'restored');assert.equal(LB.restoreNew({backupDir:backed.backupDir,targetDir:restored}).ok,true);assert.equal(LB.createBackup({dbPath:join(restored,'workbench.db'),outDir:join(root,'again-backup')}).ok,true);groups++;
 const restart=await runChild(['--input-type=module','-e',`import {db} from './server/db.mjs';import * as A from './server/accounting.mjs';import {withRequestMetadata} from './server/local-audit-coordinator.mjs';try{const out=withRequestMetadata({operationId:${JSON.stringify(deleteId)},actor:'domain'},()=>A.deleteAccountSet(${gone.id}));console.log(out===undefined?'undefined replay':'bad');}finally{db.close();console.log('DB actual close');}`],{env:{...process.env}});assert.equal(restart.code,0,restart.stderr);assert.match(restart.stdout,/undefined replay/);assert.match(restart.stdout,/DB actual close/);groups++;
 console.log(JSON.stringify({groups,root,amounts:[200,200],events:db.prepare('SELECT COUNT(*) n FROM audit_events').get().n}));
}finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();console.log('DB actual close');}
