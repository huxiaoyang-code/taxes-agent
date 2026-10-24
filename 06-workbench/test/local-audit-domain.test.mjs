import { randomUUID as restoreUUID } from 'node:crypto';
import { mkdirSync as restoreMkdir,copyFileSync as restoreCopy,existsSync as restoreExists } from 'node:fs';
import {DatabaseSync as RestoreDb} from 'node:sqlite';
import {assertRestoreOpenPath as pending4} from '../server/local-restore-control.mjs';
import { tmpdir as restoreTmpdir } from 'node:os';
import { join as restoreJoin } from 'node:path';
const restoreSeedMap=new Map(),restoreSeedCache=new Map();
function R4(input){const root=restoreJoin(restoreTmpdir(),restoreUUID());restoreMkdir(root);if(input.backupDir&&input.targetDir)restoreSeedMap.set(input.targetDir,input.backupDir);return {...input,ledgerPath:restoreJoin(root,'ledger.db'),operationId:restoreUUID()};}
function seed4(backupDir){const dir=restoreJoin(restoreTmpdir(),restoreUUID());restoreMkdir(dir);restoreCopy(restoreJoin(backupDir,'workbench.db.snapshot'),restoreJoin(dir,'workbench.db'));return dir;}
function businessSeed4(dataDir){if(!restoreSeedMap.has(dataDir)||!restoreExists(restoreJoin(dataDir,'restore.json')))return dataDir;if(restoreSeedCache.has(dataDir))return restoreSeedCache.get(dataDir);
 let code;try{pending4(restoreJoin(dataDir,'workbench.db'));}catch(e){code=e.code;}if(code!=='restore_target_pending')throw Error('expected real pending target');
 const source=new RestoreDb(restoreJoin(restoreSeedMap.get(dataDir),'workbench.db.snapshot'),{readOnly:true}),target=new RestoreDb(restoreJoin(dataDir,'workbench.db'),{readOnly:true});try{for(const {name} of source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){if(['audit_database_instances','local_batch_database_instances','local_batch_job_bindings','local_batch_input_bindings','local_batch_stages','local_batch_locks','local_batch_lock_epochs','restore_control_component','restore_control_state'].includes(name))continue;if(JSON.stringify(source.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all())!==JSON.stringify(target.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()))throw Error('restored historical row mismatch '+name);}}finally{source.close();target.close();}
 const seed=seed4(restoreSeedMap.get(dataDir));restoreSeedCache.set(dataDir,seed);return seed;
}
function cli4(input){if(input[0]!=='restore-new'||!input.includes('--backup')||!input.includes('--target')||input.includes('--ledger'))return input;const r=R4({backupDir:input[input.indexOf('--backup')+1],targetDir:input[input.indexOf('--target')+1]});return [...input,'--ledger',r.ledgerPath,'--operation',r.operationId];}
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
 // All-table snapshots include audit rows and sqlite_sequence, not just bank data.
 const allTables=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all().map(row=>JSON.stringify(row)).sort()]));
 const AS=await import('../server/auxiliary-storage.mjs'),X=await import('../server/auxiliary-accounting.mjs');
 await AS.ensureAuxiliarySchema(db,{dbPath,outDir:join(root,'aux-install')});
 let admissionCallbacks=0,rejectedAdmissions=0;
 const getter=()=>{admissionCallbacks++;return admissionCallbacks===1?a.id:b.id;};
 const unsafeOptions=()=>{
  const cycle={};cycle.self=cycle;
  const inherited=Object.create({get accountSetId(){return getter();}});
  const hidden=Object.defineProperty({accountSetId:a.id},'displayName',{get:getter});
  return [
   {get accountSetId(){return getter();},bankAccountId:'SYN-UNSAFE',sourceId:'SYN',glAccountCode:'1002'},
   {accountSetId:a.id,get displayName(){admissionCallbacks++;return admissionCallbacks===1?'DIGEST VALUE':'EXECUTED VALUE';}},
   new Proxy({accountSetId:a.id},{get(){admissionCallbacks++;throw Error('get trap');},getPrototypeOf(){admissionCallbacks++;throw Error('prototype trap');},ownKeys(){admissionCallbacks++;throw Error('keys trap');},getOwnPropertyDescriptor(){admissionCallbacks++;throw Error('descriptor trap');}}),
   inherited,hidden,{accountSetId:a.id,mapping:{get columns(){return getter();}}},
   {accountSetId:a.id,get persist(){admissionCallbacks++;return false;}},
   {accountSetId:a.id,persist:false,get bankAccountId(){return getter();}},
   {accountSetId:a.id,nested:{statementOpenCents:1n}},
   {accountSetId:a.id,otherCents:1n},{accountSetId:a.id,[Symbol('unsafe')]:1},
   {accountSetId:a.id,cycle},{accountSetId:a.id,fn(){}},new Date(),
  ];
 };
 const admissions=[...['registerBankAccount','importBankBatch','refreshMatchStates','listTransactionsView','listCandidates','confirmMatch','listMatchesView','cancelMatch','resolveAmbiguity','reconcileBank','getBankStatus'].map(key=>options=>B[key](db,options)),...['createAuxiliaryEntity','updateAuxiliaryEntity','replaceAuxiliaryAllocations','setAuxiliaryRequirement'].map(key=>options=>X[key](db,options))];
 for(const call of admissions)for(const bad of unsafeOptions()) {
  const before=allTables(),changes=db.prepare('SELECT total_changes() n').get().n;
  assert.throws(()=>call(bad),/audit_result_invalid/);
  assert.equal(admissionCallbacks,0);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);assert.deepEqual(allTables(),before);rejectedAdmissions++;
 }
 const data=Object.create(null);data.accountSetId=b.id;data.ownUndefined=undefined;data.holes=new Array(3);data.holes[1]=undefined;
 Object.defineProperty(data,'__proto__',{value:{safe:true},enumerable:true});
 const copied=C.copyDomainRequest(data);assert.equal(Object.getPrototypeOf(copied),null);assert.equal(Object.hasOwn(copied,'ownUndefined'),true);assert.equal(copied.holes.length,3);assert.equal(Object.hasOwn(copied.holes,0),false);assert.equal(Object.hasOwn(copied.holes,1),true);assert.deepEqual(copied.__proto__.safe,true);assert.equal({}.safe,undefined);
 const metadataInput={...data,operationId:randomUUID()};const extracted=C.extractOperationMetadata(metadataInput);assert.equal(extracted.metadata.operationId,metadataInput.operationId);assert.equal(Object.hasOwn(extracted.payload,'ownUndefined'),true);assert.equal(Object.hasOwn(extracted.payload.holes,0),false);assert.equal(Object.hasOwn(extracted.payload.holes,1),true);assert.equal(extracted.payload.__proto__.safe,true);
 assert.throws(()=>C.extractOperationMetadata({accountSetId:a.id,get operationId(){return getter();}}),/audit_result_invalid/);assert.equal(admissionCallbacks,0);
 assert.throws(()=>C.copyDomainRequest({statementOpenCents:0n}),/audit_result_invalid/);assert.throws(()=>LA.auditResultDigest({statementOpenCents:0n}),/audit_result_invalid/);
 const normal=Object.assign(Object.create(null),{accountSetId:b.id,bankAccountId:'SYN-BANK-B',sourceId:'SYN',glAccountCode:'1002',displayName:'SAFE VALUE',currency:undefined});
 Object.defineProperty(normal,'__proto__',{value:undefined,enumerable:true});
 const normalId=randomUUID(),registered=op(normalId,()=>B.registerBankAccount(db,normal));assert.equal(registered.created,true);assert.equal(registered.account.account_set_id,b.id);assert.equal(registered.account.display_name,'SAFE VALUE');
 const normalAudit=db.prepare('SELECT * FROM audit_operations WHERE operation_id=?').get(normalId),normalReceipt=JSON.parse(normalAudit.receipt_json);
 assert.equal(normalAudit.scope_kind,'account_set');assert.equal(JSON.parse(normalAudit.targets_json).accountSetId,b.id);assert.equal(normalReceipt.targets.accountSetId,b.id);assert.equal(normalReceipt.state,'succeeded');assert.equal(db.prepare('SELECT account_set_id FROM bank_accounts WHERE bank_account_id=?').get('SYN-BANK-B').account_set_id,b.id);
 const expectedRequestDigest=LA.auditCanonicalDigest(['audit-request-v1','bank.account.register',{domainRequestDigest:LA.auditResultDigest({...normal,entry:'registerBankAccount'})}]);assert.equal(normalAudit.request_digest,expectedRequestDigest);
 const readBefore=allTables(),readChanges=db.prepare('SELECT total_changes() n').get().n;B.refreshMatchStates(db,{accountSetId:b.id,bankAccountId:'SYN-BANK-B',persist:false});assert.deepEqual(allTables(),readBefore);assert.equal(db.prepare('SELECT total_changes() n').get().n,readChanges);
 const spoofedEntry={accountSetId:b.id,bankAccountId:'SYN-BANK-B',entry:'caller-entry'},entryId=randomUUID();op(entryId,()=>B.getBankStatus(db,spoofedEntry));const entryBefore=allTables(),entryChanges=db.prepare('SELECT total_changes() n').get().n;assert.throws(()=>op(entryId,()=>B.listMatchesView(db,spoofedEntry)),/audit_operation_conflict/);assert.deepEqual(allTables(),entryBefore);assert.equal(db.prepare('SELECT total_changes() n').get().n,entryChanges);
 const party=X.createAuxiliaryEntity(db,{accountSetId:b.id,kind:'party',code:'R4-PARTY',name:'Synthetic party',requestId:'R4-CREATE'});assert.equal(db.prepare('SELECT account_set_id FROM aux_entities WHERE id=?').get(party.id).account_set_id,b.id);
 assert.equal(X.updateAuxiliaryEntity(db,{accountSetId:b.id,entityId:party.id,name:'Updated party',reason:'synthetic'}).name,'Updated party');
 const auxEntry=db.prepare("SELECT e.id FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? AND e.code='1002' AND e.debit=200").get(b.id).id;
 const allocated=X.replaceAuxiliaryAllocations(db,{accountSetId:b.id,entryId:auxEntry,allocations:[{partyId:party.id,debit:137.29}],requestId:'R4-ALLOCATE',reason:'synthetic'});assert.equal(allocated.allocations[0].debitCents,13729);assert.equal(db.prepare('SELECT debit_cents FROM aux_allocations WHERE entry_id=?').get(auxEntry).debit_cents,13729);
 assert.equal(X.setAuxiliaryRequirement(db,{accountSetId:b.id,code:'1002',party:true,reason:'synthetic'}).party,true);
 for(const begin of ['BEGIN','SAVEPOINT r4_caller']) {
  const before=allTables();db.exec(begin);
  try {
   assert.throws(()=>B.registerBankAccount(db,normal),error=>error.code==='bank_transaction_conflict');assert.equal(db.isTransaction,true);
   for(const key of ['createAuxiliaryEntity','updateAuxiliaryEntity','replaceAuxiliaryAllocations','setAuxiliaryRequirement']){assert.throws(()=>X[key](db,{accountSetId:b.id}),/audit_transaction_conflict/);assert.equal(db.isTransaction,true);}
   assert.deepEqual(allTables(),before);
  }finally{db.exec('ROLLBACK');}
 }
 console.log(JSON.stringify({rejectedAdmissions,admissionCallbacks,allTableChanges:0,normalBankAccountSet:b.id,auditAccountSet:normalReceipt.targets.accountSetId,receiptAccountSet:normalReceipt.targets.accountSetId}));groups++;
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
 B.importBankBatch(db,{...bankOptions,accountSetId:b.id,bankAccountId:'SYN-BANK-B',batchId:'SYN-BIGINT-B',csvText:csv(200)});
 const bigintReconcile=B.reconcileBank(db,{accountSetId:b.id,bankAccountId:'SYN-BANK-B',period:'2026-01',asOf:'2026-01-31',coverageFrom:'2026-01-01',coverageTo:'2026-01-31',statementSource:'synthetic',statementOpenCents:0n,statementCloseCents:20000n});
 assert.equal(bigintReconcile.statement.openCents,0);assert.equal(bigintReconcile.statement.closeCents,20000);assert.equal(bigintReconcile.book.closingCents,20000);assert.equal(bigintReconcile.statement.differenceCents,0);console.log('BigInt top-level cents: open 0, close 20000; enterprise book 20000; statement difference 0');groups++;
 const backed=LB.createBackup({dbPath,outDir:join(root,'roundtrip-backup')});assert.equal(backed.ok,true,JSON.stringify(backed));assert.equal(LB.verifyBackup({backupDir:backed.backupDir}).ok,true);
 const restored=join(root,'restored');assert.equal(LB.restoreNew(R4({backupDir:backed.backupDir,targetDir:restored})).ok,true);assert.equal(LB.createBackup({dbPath:join(restored,'workbench.db'),outDir:join(root,'again-backup')}).ok,true);groups++;
 const restart=await runChild(['--input-type=module','-e',`import {db} from './server/db.mjs';import * as A from './server/accounting.mjs';import {withRequestMetadata} from './server/local-audit-coordinator.mjs';try{const out=withRequestMetadata({operationId:${JSON.stringify(deleteId)},actor:'domain'},()=>A.deleteAccountSet(${gone.id}));console.log(out===undefined?'undefined replay':'bad');}finally{db.close();console.log('DB actual close');}`],{env:{...process.env}});assert.equal(restart.code,0,restart.stderr);assert.match(restart.stdout,/undefined replay/);assert.match(restart.stdout,/DB actual close/);groups++;
 // Private parent IDs alone do not make a child part of the bound fixed plan.
 const planSet=A.createAccountSet({name:'R5 fixed plan synthetic',start_period:'2026-01',enterprise:{enterpriseKey:'SYN-R5-PLAN'}});
 const preparePlan=(action,parentOperationId)=>{
  const operationId=randomUUID(),prepared=LS.prepareOperation(db,{context:{operationId,actor:'domain',action,attempt:1,accountSetId:planSet.id,...(parentOperationId?{parentOperationId,parentAttempt:1}:{})},scope:{kind:'account_set',value:planSet.id},request:{}});
  assert.equal(prepared.code,'prepared');return {operationId,...prepared};
 };
 const planBusiness=()=>Object.fromEntries(Object.entries(allTables()).filter(([name])=>!name.startsWith('audit_')).map(([name,rows])=>[name,name==='sqlite_sequence'?rows.filter(row=>!JSON.parse(row).name.startsWith('audit_')):rows]));
 let unplannedCalls=0;
 for(const [mode,period] of [['unbound','2026-09'],['empty','2026-10'],['excluded','2026-11']]) {
  const parent=preparePlan('batch.stage'),child=preparePlan('period.ensure',parent.operationId);
  if(mode==='empty')LS.bindPreparedChildren(db,parent.authorization,[]);
  let included;if(mode==='excluded'){included=preparePlan('period.ensure',parent.operationId);LS.bindPreparedChildren(db,parent.authorization,[included.authorization]);}
  const before=planBusiness();
  const terminal=LS.executePreparedOperation(db,parent.authorization,()=>{
   const allBefore=allTables(),changes=db.prepare('SELECT total_changes() n').get().n;
   for(let attempt=0;attempt<2;attempt++)assert.throws(()=>LS.executePreparedChild(db,child.authorization,()=>{unplannedCalls++;db.prepare('INSERT INTO periods(account_set_id,period) VALUES(?,?)').run(planSet.id,period);return {state:'succeeded'};}),/audit_authorization_invalid/);
   assert.equal(unplannedCalls,0);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);assert.deepEqual(allTables(),allBefore);return {state:'no_change'};
  });
  assert.equal(terminal.state,'no_change');assert.deepEqual(planBusiness(),before);assert.equal(db.prepare('SELECT COUNT(*) n FROM periods WHERE account_set_id=? AND period=?').get(planSet.id,period).n,0);
  const saved=db.prepare('SELECT state,receipt_json,terminal_event_id FROM audit_operations WHERE operation_id=?').get(child.operationId);assert.equal(saved.state,'pending');assert.equal(saved.receipt_json,null);assert.equal(saved.terminal_event_id,null);
  if(included)assert.equal(db.prepare('SELECT state FROM audit_operations WHERE operation_id=?').get(included.operationId).state,'pending');
  console.log(JSON.stringify({planRejection:mode,callbackCalls:0,childState:saved.state,businessChanges:0}));
 }groups++;
 const parent=preparePlan('batch.stage'),foreignParent=preparePlan('batch.stage'),bound=preparePlan('period.ensure',parent.operationId);LS.bindPreparedChildren(db,parent.authorization,[bound.authorization]);LS.bindPreparedChildren(db,foreignParent.authorization,[]);
 let boundCalls=0;
 const boundEffect=()=>{boundCalls++;db.prepare('INSERT INTO periods(account_set_id,period) VALUES(?,?)').run(planSet.id,'2026-08');return {state:'succeeded'};};
 assert.equal(LS.executePreparedOperation(db,foreignParent.authorization,()=>{const before=allTables();assert.throws(()=>LS.executePreparedChild(db,bound.authorization,boundEffect),/audit_authorization_invalid/);assert.deepEqual(allTables(),before);assert.equal(boundCalls,0);return {state:'no_change'};}).state,'no_change');
 const {DatabaseSync}=await import('node:sqlite'),otherHandle=new DatabaseSync(dbPath);
 try {
  assert.equal(LS.executePreparedOperation(db,parent.authorization,()=>{
   const before=allTables();assert.throws(()=>LS.executePreparedChild(otherHandle,bound.authorization,boundEffect),/audit_authorization_invalid/);assert.deepEqual(allTables(),before);assert.equal(boundCalls,0);
   const childResult=LS.executePreparedChild(db,bound.authorization,boundEffect);assert.equal(childResult.state,'succeeded');assert.equal(boundCalls,1);
   const usedBefore=allTables();assert.throws(()=>LS.executePreparedChild(db,bound.authorization,boundEffect),/audit_authorization_invalid/);assert.equal(boundCalls,1);assert.deepEqual(allTables(),usedBefore);return {state:'succeeded'};
  }).state,'succeeded');
 }finally{otherHandle.close();console.log('R5 other handle DB actual close');}
 assert.equal(db.prepare('SELECT COUNT(*) n FROM periods WHERE account_set_id=? AND period=?').get(planSet.id,'2026-08').n,1);
 for(const operationId of [parent.operationId,bound.operationId]){const saved=db.prepare('SELECT state,receipt_json FROM audit_operations WHERE operation_id=?').get(operationId);assert.equal(saved.state,'succeeded');assert.equal(JSON.parse(saved.receipt_json).targets.accountSetId,planSet.id);}
 assert.equal(boundCalls,1);groups++;
 const planVoucher={period:'2026-01',voucher_date:'2026-01-05',status:'posted',entries:[{code:'1002',debit:137.29},{code:'5001',credit:137.29}]};
 const runVoucherPlan=operationId=>C.runAuditedBatchStage(db,{operationId,action:'batch.stage',scope:{kind:'account_set',value:planSet.id},request:{stage:'synthetic-fixed-voucher'}},[{action:'voucher.create_posted',scope:{kind:'account_set',value:planSet.id},request:[planSet.id,planVoucher]}],()=>A.createVoucher(planSet.id,planVoucher));
 const voucherPlanId=randomUUID(),plannedVoucher=runVoucherPlan(voucherPlanId);assert.equal(plannedVoucher.status,'posted');assert.equal(A.trialBalance(planSet.id,'2026-01').lines.find(row=>row.code==='1002').closing_debit,137.29);assert.equal(db.prepare('SELECT debit FROM voucher_entries WHERE voucher_id=? AND code=?').get(plannedVoucher.id,'1002').debit,137.29);
 const voucherReceipts=db.prepare('SELECT state,receipt_json FROM audit_operations WHERE operation_id=? OR parent_operation_id=?').all(voucherPlanId,voucherPlanId);assert.equal(voucherReceipts.length,2);for(const row of voucherReceipts){assert.equal(row.state,'succeeded');assert.equal(JSON.parse(row.receipt_json).receiptVersion,2);}
 const failedPlanId=randomUUID(),vouchersBefore=db.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?').get(planSet.id).n;
 db.exec("CREATE TEMP TRIGGER fault_r5_parent_terminal BEFORE INSERT ON audit_events WHEN NEW.action='batch.stage' AND NEW.outcome='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 try{assert.throws(()=>runVoucherPlan(failedPlanId));}finally{db.exec('DROP TRIGGER fault_r5_parent_terminal');}
 assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?').get(planSet.id).n,vouchersBefore);assert.equal(A.trialBalance(planSet.id,'2026-01').lines.find(row=>row.code==='1002').closing_debit,137.29);
 const failedPlanRows=db.prepare('SELECT state,receipt_json FROM audit_operations WHERE operation_id=? OR parent_operation_id=?').all(failedPlanId,failedPlanId);assert.equal(failedPlanRows.length,2);assert.ok(failedPlanRows.every(row=>row.state==='failed'&&JSON.parse(row.receipt_json).state==='failed'));
 console.log(JSON.stringify({unplannedCalls,boundCalls,boundPeriod:'2026-08',boundVoucherAmountCents:13729,failedPlanBusinessRollback:true,failedParentAndChild:2}));groups++;
 console.log(JSON.stringify({groups,root,amounts:[200,200],events:db.prepare('SELECT COUNT(*) n FROM audit_events').get().n}));
}finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();console.log('DB actual close');}
