import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync,lstatSync,realpathSync,writeFileSync,readFileSync,unlinkSync,existsSync,readdirSync } from 'node:fs';
import { dirname,resolve,join,basename } from 'node:path';
import { spawn } from 'node:child_process';
const root=resolve('../../../.agent-runs','s-'+randomUUID());mkdirSync(root,{recursive:true});
for(let p=root;;p=dirname(p)){assert.equal(lstatSync(p).isSymbolicLink(),false);assert.equal(realpathSync.native(p).toLowerCase(),p.toLowerCase());if(dirname(p)===p)break;}
Object.assign(process.env,{TEMP:root,TMP:root,WORKBENCH_DATA_DIR:join(root,'d'),KEEP_FIXTURES:'1',WORKBENCH_TEST_KEEP_FIXTURES:'1'});
console.log('FIXTURES '+root);
function owned(args,{env=process.env,exe=process.execPath}={}){
 const child=spawn(exe,args,{cwd:process.cwd(),env:{...env},windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',exit=null;
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('exit',(code,signal)=>{exit={code,signal};});
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{assert.deepEqual(exit,{code,signal});console.log('CHILD_EXIT_CLOSE '+JSON.stringify({pid:child.pid,code,signal}));resolve({code,signal,stdout,stderr});});});return {child,done};
}
const selected=process.env.W3B_CASE??'';if(!['','real-chain','boundaries','source-evidence','source-case','auxiliary-evidence','auxiliary-case','resume-input-evidence','resume-input-case','publication-evidence','publication-case','source-completeness'].includes(selected))throw Error('unknown W3B_CASE');if(selected==='real-chain'&&process.env.W3B_SMOKE==='1')throw Error('real-chain requires all 20 companies');
let db;
try {
 const A=await import('../server/accounting.mjs');({db}=await import('../server/db.mjs'));
 const R=await import('../server/local-batch-runner.mjs'),S=await import('../server/local-batch-storage.mjs');
 if(!['boundaries','source-evidence','source-case','auxiliary-evidence','auxiliary-case','resume-input-evidence','resume-input-case','publication-evidence','publication-case','source-completeness'].includes(process.env.W3B_CASE)){
 const count=process.env.W3B_SMOKE==='1'?1:20;
 const companies=[];
 const kinds=['balance-sheet','income-statement','cash-flow-statement','trial-balance','ledger'];
 for(let i=0;i<count;i++){
  const standard=i%2?'企业会计准则':'小企业会计准则',key='W3B-'+(i+1),capital=i%2?'4001':'3001',revenue=i%2?'6001':'5001',expense=i%2?'6602':'5602';
  const set=A.createAccountSet({name:key,enterprise:{enterpriseKey:key},accounting_standard:standard,start_period:'2026-01'});
  A.setOpeningBalances(set.id,[{code:'1002',debit:10000},{code:'1601',debit:1200},{code:capital,credit:11200}]);
  A.addAssetCard(set.id,{kind:'fixed',name:'设备',original_cost:1200,residual_rate:0,useful_life_months:12,start_period:'2025-12',acquired_period:'2025-12',ledger_status:'booked',asset_account:'1601',accum_account:'1602',expense_account:expense});
  if(i===19)A.createVoucher(set.id,{period:'2026-01',voucher_date:'2026-01-23',number:99,summary:'待补齐真实草稿',entries:[{code:expense,debit:1},{code:'1002',credit:1}]});
  const periods=[];
  for(const [month,income,fee] of [['2026-01',2000,300],['2026-02',1500,250]]){
   const csv='期间,日期,凭证字,凭证号,摘要,科目编码,借方,贷方\n'+[
    [month,month+'-10','记',1,'收入','1002',income,''],[month,month+'-10','记',1,'收入',revenue,'',income],
    [month,month+'-20','记',2,'费用',expense,fee,''],[month,month+'-20','记',2,'费用','1002','',fee],
   ].map(r=>r.join(',')).join('\n');
   const csvPath=join(root,key+'-'+month+'.csv');writeFileSync(csvPath,csv);
   const payload=A.parseImportTexts({vouchers:readFileSync(csvPath,'utf8')},{name:key,accounting_standard:standard,start_period:'2026-01'});
   payload.account_set={name:key,accounting_standard:standard,start_period:'2026-01'};
   payload.vouchers.forEach((v,n)=>v.sourceVoucherId=key+'-'+month+'-'+(n+1));
   const payloadPath=join(root,key+'-'+month+'.json');writeFileSync(payloadPath,JSON.stringify(payload));
   periods.push({period:month,imports:[{batchId:key+'-'+month,mode:'append',confirmNewBinding:true,payloadFile:basename(payloadPath)}],post:{vouchers:payload.vouchers.map(v=>({sourceVoucherId:v.sourceVoucherId}))},depreciation:true,carryforward:{yearEnd:false},periodCheck:true,close:true,reports:(i<2?kinds:['balance-sheet']).map(kind=>({kind,formats:i<2?['csv','xlsx','pdf']:['csv'],...(kind==='ledger'?{code:'1002'}:{})}))});
  }
  companies.push({set,key,periods});
 }
 const validated=S.validateManifest({schemaVersion:1,jobKey:'w3b-real20',concurrency:4,items:companies.map((c,i)=>({itemKey:'e'+(i+1),source:{system:'w3b-csv',enterpriseKey:c.key},accountSetId:c.set.id,periods:c.periods}))});assert.equal(validated.ok,true,JSON.stringify(validated));
 const manifest=validated.manifest,manifestJson=S.canonicalJson(manifest),plan=S.buildPlan({manifest,manifestDir:root});
 writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest,null,2));
 let monitor;
 if(count===20){
  const code=`import {DatabaseSync} from 'node:sqlite';import {createBackup,verifyBackup,restoreNew} from './server/local-backup.mjs';import {writeFileSync,lstatSync,realpathSync,mkdirSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {dirname,resolve,join} from 'node:path';
  const root=process.env.TEMP;for(let p=resolve(root);;p=dirname(p)){if(lstatSync(p).isSymbolicLink()||realpathSync.native(p).toLowerCase()!==p.toLowerCase())throw Error('alias');if(dirname(p)===p)break;}
  const file=join(process.env.WORKBENCH_DATA_DIR,'workbench.db');let db;try{db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA busy_timeout=10000');const count=()=>db.prepare("SELECT COUNT(*) n FROM local_batch_stages WHERE status='succeeded'").get().n;const until=Date.now()+180000;while(count()<5){if(Date.now()>until)throw Error('wait stages timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
  const before=count(),started=Date.now();const backup=createBackup({dbPath:file,outDir:join(root,'live-backup')});const finished=Date.now(),after=count();let verify,restored;if(backup.ok){verify=verifyBackup({backupDir:backup.backupDir});mkdirSync(join(root,'ledger'));restored=restoreNew({backupDir:backup.backupDir,targetDir:join(root,'restore'),ledgerPath:join(root,'ledger','restore.db'),operationId:randomUUID()});}const result={before,after,started,finished,backup,verify,restored};writeFileSync(join(root,'live-backup-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}finally{db?.close();console.log('DB_CLOSED');}`;
  monitor=owned(['--input-type=module','-e',code]);
 }
 const result=await R.createAndRun({manifest,manifestJson,manifestHash:S.sha256(manifestJson),...plan,outputDir:join(root,'out'),hooks:{onStageError:({stage,error})=>console.log('STAGE_ERROR '+JSON.stringify({id:stage.id,key:stage.stage_key,code:error.code,message:error.message}))}});
 if(monitor){const observed=await monitor.done;writeFileSync(join(root,'backup-child.log'),observed.stdout+'\n'+observed.stderr);assert.equal(observed.code,0,observed.stdout+observed.stderr);const live=JSON.parse(readFileSync(join(root,'live-backup-result.json'),'utf8'));assert.equal(live.backup.ok,true,JSON.stringify(live));assert.equal(live.verify.ok,true);assert.equal(live.restored.ok,true);assert.equal(live.restored.receipt.receiptVersion,2);assert.equal(live.restored.receipt.target.writeState,'pending');assert.notEqual(live.restored.receipt.target.auditInstanceId,live.restored.receipt.source.auditInstanceId);assert.ok(live.after>live.before,'legal stages committed while official backup was running');
  const {DatabaseSync}=await import('node:sqlite');const restored=new DatabaseSync(join(root,'restore','workbench.db'),{readOnly:true});try{assert.equal(restored.prepare('SELECT write_state FROM restore_control_state').get().write_state,'pending');assert.equal(S.readBatchInstance(restored).write_state,'restore_pending');assert.equal(S.readBatchInstance(restored).parent_instance_id,live.restored.receipt.source.batchInstanceId);assert.equal(restored.prepare('SELECT COUNT(*) n FROM local_batch_locks').get().n,0);assert.equal(restored.prepare("SELECT COUNT(*) n FROM local_batch_job_bindings WHERE database_instance_id=(SELECT instance_id FROM local_batch_database_instances WHERE is_active=1) AND (output_state<>'disabled' OR output_root IS NOT NULL)").get().n,0);S.assertBatchSchema(restored);assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(restored.prepare('SELECT COUNT(*) n FROM account_sets').get().n,20);assert.ok(restored.prepare("SELECT COUNT(*) n FROM local_batch_stages WHERE status='succeeded'").get().n>=live.before);writeFileSync(join(root,'restored-readonly-facts.json'),JSON.stringify({stages:restored.prepare('SELECT status,COUNT(*) n FROM local_batch_stages GROUP BY status').all(),sources:restored.prepare('SELECT COUNT(*) n FROM import_voucher_sources').get().n,epochs:restored.prepare('SELECT * FROM local_batch_lock_epochs ORDER BY resource_key').all()}));}finally{restored.close();console.log('RESTORED_DB_CLOSED_READONLY');}}
 writeFileSync(join(root,'first-result.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({status:result.status,items:result.items.map(i=>({itemKey:i.itemKey,stopped:i.stopped,snapshotError:i.snapshotError})),results:result.results?.filter(r=>r.status!=='succeeded')}));
 assert.equal(result.status,count===20?'needs_review':'succeeded');
 for(const c of companies.slice(0,count===20?19:count)){
  assert.equal(A.periodStatus(c.set.id,'2026-02'),'closed');
  const bs=A.balanceSheet(c.set.id,'2026-02'),inc=A.incomeStatement(c.set.id,'2026-02'),cf=A.cashFlowStatement(c.set.id,'2026-02');
  assert.equal(bs.totals.assets,13950);assert.equal(bs.totals.equity,13950);assert.equal(cf.totals.net_increase,1250);
  assert.equal(inc.current['净利润'],1150);assert.equal(inc.ytd['净利润'],2750);
 }
 if(count===20){
  const {default:ExcelJS}=await import('exceljs');
  const artifacts=db.prepare('SELECT * FROM local_batch_artifacts WHERE item_id<=2 AND period=? ORDER BY item_id,kind,format').all('2026-02');assert.equal(artifacts.length,30);
  const expectedRows={
   'balance-sheet':[['固定资产账面价值',[1100,1000]],['资产总计',[12800,13950]],['所有者权益合计',[12800,13950]]],
   'income-statement':[['净利润',[1150,2750]]],
   'cash-flow-statement':[['现金净增加额',[1250,2950]],['现金期初余额',[11700,10000]],['现金期末余额',[12950,12950]]],
   'trial-balance':[['1002',[11700,0,1500,250,3500,550,12950,0]]],
   'ledger':[['本期发生',[1500,250]],['本年累计',[3500,550]],['期末',[12950,0]]],
  };
  function checkRows(kind,rows,format){for(const [label,expected] of expectedRows[kind])assert.ok(rows.some(row=>row.label.includes(label)&&JSON.stringify(row.numbers.slice(-expected.length))===JSON.stringify(expected)),format+' '+kind+' '+label+' '+JSON.stringify(expected));}
  const textRows=text=>text.split(/\r?\n/).map(label=>({label,numbers:(label.match(/-?\d+(?:\.\d+)?/g)??[]).map(Number)}));
  for(const artifact of artifacts){const file=join(root,'out',artifact.relative_path);assert.equal(S.sha256(readFileSync(file)),artifact.bytes_hash);if(artifact.format==='csv'){const csv=readFileSync(file,'utf8');assert.match(csv,/2026-02/);checkRows(artifact.kind,textRows(csv),'csv');}if(artifact.format==='xlsx'){const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(file);assert.ok(workbook.worksheets.length>0);const rows=[];workbook.eachSheet(sheet=>sheet.eachRow(row=>{const cells=[];row.eachCell({includeEmpty:true},cell=>cells.push(cell.value));rows.push({label:cells.map(String).join(' '),numbers:cells.filter(v=>typeof v==='number')});}));checkRows(artifact.kind,rows,'xlsx');}}
  const pdfArtifacts=artifacts.filter(a=>a.format==='pdf'),pdfs=pdfArtifacts.map(a=>join(root,'out',a.relative_path));
  const python=process.env.REPORT_OFFICE_PYTHON??'C:/Users/35007/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
  const extract=await owned(['-c','import json,sys,pdfplumber; result=[]\nfor file in sys.argv[1:]:\n with pdfplumber.open(file) as pdf: result.append({"file":file,"texts":[p.extract_text() or "" for p in pdf.pages]})\nprint(json.dumps(result,ensure_ascii=True))',...pdfs],{exe:python}).done;assert.equal(extract.code,0,extract.stderr);const texts=JSON.parse(extract.stdout);assert.equal(texts.length,10);for(const [i,text] of texts.entries()){const readable=text.texts.join('\n');assert.ok(readable.length>100);assert.match(readable,/2026-02/);checkRows(pdfArtifacts[i].kind,textRows(readable.replace(/,/g,'')),'pdf');}writeFileSync(join(root,'pdf-texts.json'),JSON.stringify(texts));
  const workers=db.prepare('SELECT item_id,worker_thread_id,render_started,render_finished FROM local_batch_artifacts WHERE worker_thread_id IS NOT NULL').all();assert.ok(workers.some(a=>workers.some(b=>a.item_id!==b.item_id&&a.worker_thread_id!==b.worker_thread_id&&a.render_started<b.render_finished&&b.render_started<a.render_finished)),'cross-enterprise actual worker intervals overlap');
  const before=db.prepare("SELECT id,attempt,input_hash,outcome_hash FROM local_batch_stages WHERE status IN ('succeeded','not_applicable') ORDER BY id").all();
  const successfulCounts=db.prepare('SELECT (SELECT COUNT(*) FROM vouchers WHERE account_set_id<20) vouchers,(SELECT COUNT(*) FROM import_voucher_sources WHERE account_set_id<20) sources,(SELECT COUNT(*) FROM asset_depreciation_runs WHERE account_set_id<20) runs').get();
  const blocked=companies[19];const draft=A.listVouchers(blocked.set.id,{period:'2026-01',status:'draft'}).find(v=>v.number===99);assert.ok(draft);
  A.deleteVoucher(blocked.set.id,draft.id);
  S.resetStagesForRetry(db,{jobKey:manifest.jobKey,itemKey:'e20'});
  const resumed=await R.resumeJob({jobKey:manifest.jobKey});writeFileSync(join(root,'resumed-result.json'),JSON.stringify(resumed,null,2));assert.equal(resumed.status,'succeeded');
  for(const row of before)assert.deepEqual({...db.prepare('SELECT id,attempt,input_hash,outcome_hash FROM local_batch_stages WHERE id=?').get(row.id)},{...row});
  assert.deepEqual({...db.prepare('SELECT (SELECT COUNT(*) FROM vouchers WHERE account_set_id<20) vouchers,(SELECT COUNT(*) FROM import_voucher_sources WHERE account_set_id<20) sources,(SELECT COUNT(*) FROM asset_depreciation_runs WHERE account_set_id<20) runs').get()},{...successfulCounts});
  console.log('retry only unfinished: '+before.length+' completed checkpoints unchanged');
 }
 console.log('local-batch-domain: chain passed '+count);
 }
 if(process.env.W3B_CASE==='real-chain'){}
 else if(process.env.W3B_CASE==='source-completeness')await sourceCompleteness(A,S,R,db);
 else if(process.env.W3B_CASE==='publication-case')await reportPublicationBoundary(A,S,R,db,process.env.R4_CASE);
 else if(process.env.W3B_CASE==='resume-input-case')await reportResumeInputBoundary(A,S,R,db,process.env.R3_CASE);
 else if(process.env.W3B_CASE==='auxiliary-case')await reportAuxiliaryBoundary(A,S,R,db,process.env.R2_CASE);
 else if(process.env.W3B_CASE==='source-case')await reportSourceBoundary(A,S,R,db,process.env.R1_CASE);
 else {
  if(!['source-evidence','auxiliary-evidence','resume-input-evidence','publication-evidence'].includes(process.env.W3B_CASE))await boundaries(A,S,R,db);
  if(!['auxiliary-evidence','resume-input-evidence','publication-evidence'].includes(process.env.W3B_CASE)){
  for(const mode of ['positive','source-before','inline-before','inline-type-before','source-after','inline-after','source-recover','inline-recover','report-only','report-only-delete']){
   const child=await owned(['test/local-batch-domain.test.mjs'],{env:{...process.env,W3B_CASE:'source-case',R1_CASE:mode}}).done;writeFileSync(join(root,'r1-'+mode+'.log'),child.stdout+'\n'+child.stderr);assert.equal(child.code,0,mode+' '+child.stdout+' '+child.stderr);
  }
  console.log('R1 report source evidence: ten real isolated cases passed');
  }
  if(!['resume-input-evidence','publication-evidence'].includes(process.env.W3B_CASE)){
  for(const mode of ['future-draft-xlsx','future-posted-pdf','foreign-xlsx','opening-xlsx','opening-pdf','current-xlsx','prior-pdf','entity-pdf','requirement-xlsx']){
   const child=await owned(['test/local-batch-domain.test.mjs'],{env:{...process.env,W3B_CASE:'auxiliary-case',R2_CASE:mode}}).done;writeFileSync(join(root,'r2-'+mode+'.log'),child.stdout+'\n'+child.stderr);assert.equal(child.code,0,mode+' '+child.stdout+' '+child.stderr);
  }
  console.log('R2 report auxiliary scope: nine real isolated cases passed');
  }
  if(process.env.W3B_CASE!=='publication-evidence'){
  for(const mode of ['import-changed','import-missing','report-only-changed','report-only-missing','report-pending-changed','saved-bytes','unrelated']){
   const child=await owned(['test/local-batch-domain.test.mjs'],{env:{...process.env,W3B_CASE:'resume-input-case',R3_CASE:mode}}).done;writeFileSync(join(root,'r3-'+mode+'.log'),child.stdout+'\n'+child.stderr);assert.equal(child.code,0,mode+' '+child.stdout+' '+child.stderr);
  }
  console.log('R3 completed report external input: seven real isolated cases passed');
  }
  for(const mode of ['positive-csv','positive-xlsx','new-job','new-kind','new-path','new-bytes','new-hash','new-snapshot-hash','new-snapshot-body','new-attempt','new-delete','new-status','new-snapshot-owner','terminal-owner','terminal-business','terminal-status','recover-job','recover-path','recover-file','recover-status','rerender-moved','rerender-delete','rerender-valid','old-published','old-publishing','old-csv-snapshot','completed-job','completed-kind','completed-path','completed-bytes','completed-hash','completed-snapshot-hash','completed-snapshot-body','completed-attempt','completed-delete','completed-snapshot-owner','completed-render','completed-file','completed-status','completed-cache-job','completed-late-file']){
   const child=await owned(['test/local-batch-domain.test.mjs'],{env:{...process.env,W3B_CASE:'publication-case',R4_CASE:mode}}).done;writeFileSync(join(root,'r4-'+mode+'.log'),child.stdout+'\n'+child.stderr);assert.equal(child.code,0,mode+' '+child.stdout+' '+child.stderr);
  }
  console.log('R4 current publication rows and file: forty-one real isolated cases passed');
  if(!process.env.W3B_CASE)await sourceCompleteness(A,S,R,db);
 }
}finally {if(db){db.close();console.log('DB_CLOSED');}}

async function boundaries(A,S,R,db){
 const create=(key,start='2026-01')=>A.createAccountSet({name:key,start_period:start,enterprise:{enterpriseKey:key}});
 async function run(key,set,periods,hooks={}){const v=S.validateManifest({schemaVersion:1,jobKey:key,concurrency:2,items:[{itemKey:key,source:{system:'boundary',enterpriseKey:key},accountSetId:set.id,periods}]});assert.equal(v.ok,true,JSON.stringify(v));const json=S.canonicalJson(v.manifest),plan=S.buildPlan({manifest:v.manifest,manifestDir:root});return R.createAndRun({manifest:v.manifest,manifestJson:json,manifestHash:S.sha256(json),...plan,outputDir:join(root,'boundaries'),hooks});}
 const imported=(key,period='2026-01',revenue=20)=>({account_set:{name:key,start_period:'2026-01'},accounts:[],opening_balances:[],vouchers:[{sourceVoucherId:key+'-'+period,period,date:period+'-03',word:'记',number:1,entries:[{code:'1002',debit:String(revenue)},{code:'5001',credit:String(revenue)}]}]});
 const I=await import('../server/import-incremental.mjs'),C=await import('../server/local-audit-coordinator.mjs');
 for(const [index,extra] of [{},{mode:' append '},{account_set_id:'alias'}].entries()){
  const key='NORMALIZED-'+index,set=create(key),operationId='normalized-'+randomUUID(),options={dryRun:false,accountSetId:index===1?String(set.id):set.id,source:{system:'boundary',enterpriseKey:key},payload:imported(key),batchId:key,confirmNewBinding:true,...extra};if(index===2){delete options.accountSetId;options.account_set_id=String(set.id);}
  const first=C.withRequestMetadata({operationId,actor:'domain'},()=>I.importIncremental(options));assert.equal(first.ok,true);const count=db.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?').get(set.id).n;const repeated=C.withRequestMetadata({operationId,actor:'domain'},()=>I.importIncremental(options));assert.deepEqual(repeated,first);assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?').get(set.id).n,count);const operation=db.prepare('SELECT action,scope_kind,targets_json FROM audit_operations WHERE operation_id=?').get(operationId);assert.equal(operation.action,'import.append');assert.equal(operation.scope_kind,'account_set');assert.equal(JSON.parse(operation.targets_json).accountSetId,set.id);
 }
 // Public aliases share static rejection before even a management epoch write.
 for(const [index,extra] of [{},{mode:' append '},{account_set_id:'alias'}].entries()){
  const key='STATIC-ALIASED-'+index,set=create(key),options={dryRun:false,accountSetId:String(set.id),source:{system:'boundary',enterpriseKey:key},payload:{account_set:{name:key,start_period:'2026-01'},accounts:[{code:'560201',name:'非法明细',category:'损益',direction:'credit'}]},batchId:key,confirmNewBinding:true,...extra};if(index===2){delete options.accountSetId;options.account_set_id=String(set.id);}
  const snapshot=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()])),before=snapshot(),changes=db.prepare('SELECT total_changes() n').get().n;
  const prepare=db.prepare,forbiddenReads=[];db.prepare=function(sql){if(/\b(?:import_enterprise_account_sets|import_source_bindings|periods|import_voucher_sources|import_batch_vouchers|vouchers|voucher_entries|fingerprint)\b/i.test(String(sql)))forbiddenReads.push(sql);return prepare.call(db,sql);};
  let rejected;try{rejected=I.importIncremental(options);}finally{db.prepare=prepare;}
  assert.deepEqual(forbiddenReads,[],'static rejection reads no canonical/source binding, period or financial fingerprint');assert.equal(rejected.status,I.STATUS.REJECTED);assert.equal(rejected.validation.profileError.code,'account_semantics_conflict');assert.equal(snapshot(),before);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
 }
 const lossKey='LOSS-IMPORT',loss=create(lossKey);let removed=false;
 const lossResult=await run(lossKey,loss,[{period:'2026-01',imports:[{batchId:lossKey,mode:'append',confirmNewBinding:true,payload:imported(lossKey)}]}],{afterImportCommit(){const lock=S.listLocks(db).find(l=>l.resource_key===`account-set:${loss.id}`);assert.ok(lock);S.releaseLock(db,{resourceKey:lock.resource_key,instance:lock.owner_instance,token:lock.fencing_token});removed=true;}});
 assert.equal(removed,true);assert.equal(lossResult.status,'needs_review');assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?').get(loss.id).n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM import_voucher_sources WHERE account_set_id=?').get(loss.id).n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.account_set_id=? AND s.status='succeeded'").get(loss.id).n,0);
 // Inject actual SQL AFTER the parent's terminal UPDATE and BEFORE its COMMIT.
 // The original authorizer and real SQLite transaction remain in force.
 const lateKey='LOSS-LATE',late=create(lateKey);const v=S.validateManifest({schemaVersion:1,jobKey:lateKey,concurrency:1,items:[{itemKey:lateKey,source:{system:'boundary',enterpriseKey:lateKey},accountSetId:late.id,periods:[{period:'2026-01',imports:[{batchId:lateKey,mode:'append',confirmNewBinding:true,payload:imported(lateKey)}]}]}]});assert.equal(v.ok,true);const json=S.canonicalJson(v.manifest),plan=S.buildPlan({manifest:v.manifest,manifestDir:root});const saved=S.createJob(db,{manifest:v.manifest,manifestJson:json,manifestHash:S.sha256(json),...plan,outputDir:join(root,'boundaries')});const stage=db.prepare('SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.job_id=?').get(saved.job.id),target='stage:'+stage.id+':1';
 const originalPrepare=db.prepare,rawPrepare=originalPrepare.bind(db);let lateInjected=false;
 db.prepare=function(sql){const statement=rawPrepare(sql);if(!String(sql).startsWith('UPDATE audit_operations SET state='))return statement;return new Proxy(statement,{get(object,property){if(property==='run')return (...args)=>{const result=object.run(...args);if(!lateInjected&&args[0]==='succeeded'&&args[5]===target){lateInjected=true;rawPrepare('UPDATE local_batch_lock_epochs SET last_token=last_token+1 WHERE resource_key=?').run(`account-set:${late.id}`);rawPrepare('UPDATE local_batch_locks SET fencing_token=fencing_token+1 WHERE resource_key=?').run(`account-set:${late.id}`);}return result;};const value=Reflect.get(object,property,object);return typeof value==='function'?value.bind(object):value;}});};
 let lateResult;try{lateResult=await R.executeJob({job:saved.job});}finally{db.prepare=originalPrepare;}
 assert.equal(lateInjected,true);assert.notEqual(lateResult.status,'succeeded');assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?').get(late.id).n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM import_voucher_sources WHERE account_set_id=?').get(late.id).n,0);assert.notEqual(S.getStage(db,stage.id).status,'succeeded');assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_operations WHERE (operation_id=? OR parent_operation_id=?) AND state IN ('succeeded','no_change')").get(target,target).n,0);
 const closeKey='LOSS-CLOSE',closeSet=create(closeKey);const closeResult=await run(closeKey,closeSet,[{period:'2026-01',periodCheck:true,close:true}],{nearCloseCommit(){const lock=S.listLocks(db).find(l=>l.resource_key==='book:'+closeKey);S.releaseLock(db,{resourceKey:lock.resource_key,instance:lock.owner_instance,token:lock.fencing_token});}});assert.equal(closeResult.status,'needs_review');assert.equal(A.periodStatus(closeSet.id,'2026-01'),'open');
 const postKey='LOSS-POST',postSet=create(postKey),draft=A.createVoucher(postSet.id,{period:'2026-01',voucher_date:'2026-01-03',entries:[{code:'1002',debit:9},{code:'5001',credit:9}]});const posted=await run(postKey,postSet,[{period:'2026-01',post:{vouchers:[{voucherId:draft.id}]}}],{inPostTransaction({stage}){db.prepare('UPDATE local_batch_stages SET attempt=attempt+1 WHERE id=?').run(stage.id);}});assert.equal(posted.status,'needs_review');assert.equal(A.getVoucher(postSet.id,draft.id).status,'draft');
 const AUX=await import('../server/auxiliary-storage.mjs'),X=await import('../server/auxiliary-accounting.mjs');await AUX.ensureAuxiliarySchema(db,{dbPath:join(process.env.WORKBENCH_DATA_DIR,'workbench.db'),outDir:join(root,'aux-boundary')});
 const reportCases=[];
 for(const mode of ['financial','identity','profile','auxiliary','source','snapshot','artifact']){
  const key='REPORT-'+mode,set=create(key);A.setOpeningBalances(set.id,[{code:'1002',debit:10000},{code:'3001',credit:10000}]);let changed=false;
  const file=join(root,key+'.json');writeFileSync(file,JSON.stringify(imported(key)));
  const periods=[{period:'2026-01',imports:[{batchId:key,mode:'append',confirmNewBinding:true,payloadFile:key+'.json'}],reports:[{kind:'balance-sheet',formats:['pdf']}]}];
  const mutate=({relativePath})=>{if(changed)return;changed=true;
   if(mode==='financial')A.createVoucher(set.id,{period:'2026-01',voucher_date:'2026-01-12',status:'posted',entries:[{code:'1002',debit:1},{code:'5001',credit:1}]});
   if(mode==='identity'){db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM import_source_bindings WHERE enterprise_key=?').run(key);db.prepare('UPDATE import_enterprise_account_sets SET enterprise_key=? WHERE account_set_id=?').run(key+'-CHANGED',set.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
   if(mode==='profile')db.prepare('UPDATE account_sets SET accounting_profile_id=? WHERE id=?').run('enterprise-2019-general-basic-v1',set.id);
   if(mode==='auxiliary')X.setAuxiliaryRequirement(db,{accountSetId:set.id,code:'1002',party:true,reason:'synthetic correction'});
   if(mode==='source')writeFileSync(file,'changed input');
   if(mode==='snapshot')db.prepare('UPDATE local_batch_snapshots SET csv_text=?,csv_hash=? WHERE item_id=(SELECT id FROM local_batch_items WHERE item_key=?)').run('changed',S.sha256('changed'),key);
   if(mode==='artifact')writeFileSync(join(root,'boundaries',relativePath),'tampered artifact');
  };
  const result=await run(key,set,periods,mode==='artifact'?{afterArtifactPublish:mutate}:{beforeArtifactPublish:mutate});assert.equal(changed,true,mode);assert.equal(result.status,'needs_review',mode+JSON.stringify(result));assert.equal(db.prepare("SELECT COUNT(*) n FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.account_set_id=? AND s.stage_key LIKE 'report:%' AND s.status='succeeded'").get(set.id).n,0);reportCases.push({mode,result:result.results});
 }
 // True year-end chain with the established profit rule, not a synthetic balance rewrite.
 const yearKey='YEAR-CROSS',year=create(yearKey,'2026-12');A.setOpeningBalances(year.id,[{code:'1002',debit:10000},{code:'3001',credit:10000}]);
 const periods=['2026-12','2027-01'].map((period,index)=>({period,imports:[{batchId:yearKey+'-'+period,mode:'append',confirmNewBinding:true,payload:{...imported(yearKey,period,index?1250:1700),account_set:{name:yearKey,start_period:'2026-12'}}}],post:{vouchers:[{sourceVoucherId:yearKey+'-'+period}]},depreciation:true,carryforward:{yearEnd:index===0},periodCheck:true,close:true,reports:[{kind:'income-statement',formats:['csv']},{kind:'balance-sheet',formats:['csv']}]}));
 const crossed=await run(yearKey,year,periods);assert.equal(crossed.status,'succeeded');assert.equal(A.incomeStatement(year.id,'2026-12').current['净利润'],1700);assert.equal(A.incomeStatement(year.id,'2027-01').ytd['净利润'],1250);assert.equal(A.balanceSheet(year.id,'2027-01').totals.equity,12950);
 const profitDecember=db.prepare("SELECT COALESCE(SUM(e.credit-e.debit),0) total FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? AND v.status='posted' AND v.period<=? AND e.code='3103'").get(year.id,'2026-12').total;assert.equal(profitDecember,0);
 writeFileSync(join(root,'boundaries-result.json'),JSON.stringify({lossResult,lateResult,closeResult,posted,reportCases,crossed},null,2));console.log('local-batch-domain boundaries: all-resource and stage fence rollback, actual pre-COMMIT loss, seven real worker mutation refusals, year-end continuation passed');
}

async function reportSourceBoundary(A,S,R,db,mode){
 const I=await import('../server/import-incremental.mjs'),B=await import('../server/local-batch-actions.mjs');
 const key='R1-'+mode,set=A.createAccountSet({name:key,start_period:'2026-01',enterprise:{enterpriseKey:key}}),period='2026-01',format=mode.startsWith('inline')?'xlsx':'pdf';
 A.setOpeningBalances(set.id,[{code:'1002',debit:1000},{code:'3001',credit:1000}]);
 const amount=mode==='report-only-delete'?12.34:20;
 const payload=(name,p='2026-01')=>({account_set:{name,start_period:'2026-01'},vouchers:[{sourceVoucherId:name+'-'+p,period:p,date:p+'-03',number:1,entries:[{code:'1002',debit:amount},{code:'5001',credit:amount}]}]});
 const request={dryRun:false,mode:'append',accountSetId:set.id,source:{system:'r1',enterpriseKey:key},batchId:key,confirmNewBinding:true,payload:payload(key)};
 if(mode.startsWith('report-only'))assert.equal(I.importIncremental(request).ok,true);
 const reports=[{kind:'income-statement',formats:mode==='positive'?['pdf','xlsx']:[format]}];
 const periods=[{period,...(mode.startsWith('report-only')?{}:{imports:[{batchId:key,mode:'append',confirmNewBinding:true,payload:request.payload}],post:{vouchers:[{sourceVoucherId:key+'-'+period}]},depreciation:true,carryforward:{yearEnd:false},periodCheck:true,close:true}),reports}];
 const v=S.validateManifest({schemaVersion:1,jobKey:key,concurrency:2,items:[{itemKey:key,source:request.source,accountSetId:set.id,periods}]});assert.equal(v.ok,true,JSON.stringify(v));
 const json=S.canonicalJson(v.manifest),plan=S.buildPlan({manifest:v.manifest,manifestDir:root}),out=join(root,'r1-out');
 const facts=()=>JSON.stringify({vouchers:db.prepare('SELECT * FROM vouchers WHERE account_set_id=? AND period<=? ORDER BY id').all(set.id,period),entries:db.prepare('SELECT e.* FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? AND v.period<=? ORDER BY e.id').all(set.id,period),batches:db.prepare('SELECT * FROM import_batches WHERE batch_id=?').all(key),links:db.prepare('SELECT * FROM import_batch_vouchers WHERE batch_id=? ORDER BY id').all(key)});
 let injected=false,before,importStage,stageBefore,file;
 const inject=()=>{if(injected)return;injected=true;before=facts();importStage=db.prepare("SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.account_set_id=? AND s.stage_key LIKE 'import:%'").get(set.id);if(importStage){assert.equal(importStage.status,'succeeded');stageBefore={id:importStage.id,attempt:importStage.attempt,input_hash:importStage.input_hash,outcome_hash:importStage.outcome_hash};}
  if(mode.startsWith('inline')){const row=db.prepare('SELECT * FROM local_batch_inputs WHERE batch_id=?').get(key);assert.equal(S.checkInputEvidence(row).ok,true);db.prepare('UPDATE local_batch_inputs SET content=? WHERE input_key=?').run(mode==='inline-type-before'?123:Buffer.from('tampered inline bytes'),row.input_key);const bad=db.prepare('SELECT * FROM local_batch_inputs WHERE input_key=?').get(row.input_key);assert.equal(S.checkInputEvidence(bad,{allowSnapshotOnly:true}).ok,false);assert.equal(S.checkInputEvidence(bad).savedValid,false);writeFileSync(join(root,'tampered-input.bin'),bad.content instanceof Uint8Array?Buffer.from(bad.content):Buffer.from(String(bad.content)));}
  else if(mode==='report-only-delete'){db.prepare('DELETE FROM import_batch_vouchers WHERE account_set_id=?').run(set.id);db.prepare('DELETE FROM import_voucher_sources WHERE account_set_id=?').run(set.id);assert.equal(db.prepare('SELECT COUNT(*) n FROM import_voucher_sources').get().n,0);assert.equal(db.prepare('SELECT SUM(e.debit-e.credit) n FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? AND e.code=\'1002\'').get(set.id).n,12.34);}
  else {db.prepare('UPDATE import_voucher_sources SET voucher_fingerprint=? WHERE account_set_id=?').run('f'.repeat(64),set.id);assert.ok(I.getImportBatch(key).sourceTrace.some(t=>t.state!=='ok'));if(importStage){const item=db.prepare('SELECT * FROM local_batch_items WHERE id=?').get(importStage.item_id);assert.deepEqual(B.verifyStageEvidence({stage:importStage,item}).reason,'import_source_trace_changed');}}
 };
 const positive=()=>{if(injected)return;injected=true;const future={...request,batchId:key+'-future',payload:payload(key,'2026-02')};assert.equal(I.importIncremental(future).ok,true);db.prepare("UPDATE import_voucher_sources SET voucher_fingerprint=? WHERE batch_id=?").run('e'.repeat(64),future.batchId);const other=A.createAccountSet({name:'unrelated',start_period:period,enterprise:{enterpriseKey:'R1-OTHER'}});const foreign={...request,accountSetId:other.id,batchId:'R1-OTHER',source:{system:'r1',enterpriseKey:'R1-OTHER'},payload:payload('R1-OTHER')};assert.equal(I.importIncremental(foreign).ok,true);db.prepare('UPDATE import_voucher_sources SET voucher_fingerprint=? WHERE account_set_id=?').run('d'.repeat(64),other.id);};
 const hooks=mode==='positive'?{beforeArtifactPublish:positive}:mode.endsWith('-before')||mode.startsWith('report-only')?{beforeArtifactPublish:inject}:mode.endsWith('-after')?{afterArtifactPublish(args){file=join(out,args.relativePath);assert.ok(readFileSync(file).length>0);inject();}}:{};
 let result=await R.createAndRun({manifest:v.manifest,manifestJson:json,manifestHash:S.sha256(json),...plan,outputDir:out,hooks,allowSnapshotOnly:mode.startsWith('inline')});
 if(mode.endsWith('-recover')){
  assert.equal(result.status,'succeeded');const report=db.prepare("SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.account_set_id=? AND s.stage_key LIKE 'report:%'").get(set.id),artifact=S.getArtifactByStage(db,{itemId:report.item_id,period,stageKey:report.stage_key});file=join(out,artifact.relative_path);assert.ok(readFileSync(file).length>0);const original=readFileSync(file);
  S.resetStage(db,{stageId:report.id,status:S.STAGE_STATUS.NEEDS_REVIEW,errorCode:'r1-controlled-recovery'});S.resetStagesForRetry(db,{jobKey:key});
  const prepare=db.prepare;db.prepare=function(sql){const stmt=prepare.call(db,sql);if(!String(sql).startsWith('SELECT * FROM local_batch_artifacts WHERE item_id=? AND period=? AND stage_key=?'))return stmt;return new Proxy(stmt,{get(target,property){if(property==='get')return (...args)=>{const row=target.get(...args);if(row?.id===artifact.id)inject();return row;};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});};
  try{result=await R.resumeJob({jobKey:key,allowSnapshotOnly:mode.startsWith('inline')});}finally{db.prepare=prepare;}assert.deepEqual(readFileSync(file),original,'recovery retains published bytes');
 }
 assert.equal(injected,true,mode);
 const stages=db.prepare('SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.account_set_id=? ORDER BY s.id').all(set.id),reportStages=stages.filter(s=>s.stage_key.startsWith('report:'));
 if(mode==='positive'){assert.equal(result.status,'succeeded',JSON.stringify(result));assert.ok(reportStages.every(s=>s.status==='succeeded'));assert.equal(A.incomeStatement(set.id,period).current['净利润'],20);}
 else {assert.equal(result.status,'needs_review',JSON.stringify(result));assert.ok(reportStages.every(s=>s.status==='needs_review'));if(mode==='report-only-delete'){const after=JSON.parse(facts()),original=JSON.parse(before);assert.deepEqual(after.links,[]);delete after.links;delete original.links;assert.deepEqual(after,original,'only the explicitly deleted source associations change; 12.34 finance never replayed');}else assert.equal(facts(),before,'completed finance and source-batch associations never replay');if(stageBefore){const old=S.getStage(db,stageBefore.id);assert.deepEqual({id:old.id,attempt:old.attempt,input_hash:old.input_hash,outcome_hash:old.outcome_hash},stageBefore);assert.equal(old.status,'succeeded');}if(mode.endsWith('-before')||mode.startsWith('report-only'))assert.equal(db.prepare('SELECT COUNT(*) n FROM local_batch_artifacts').get().n,0,'before publish drift leaves no successful artifact');if(file)assert.ok(readFileSync(file).length>0,'published drift retains actual file');}
 writeFileSync(join(root,'r1-result.json'),JSON.stringify({mode,result,stages,artifacts:db.prepare('SELECT * FROM local_batch_artifacts ORDER BY id').all(),sourceTrace:I.getImportBatch(key).sourceTrace,finance:JSON.parse(facts())},null,2));console.log('PASS R1 '+mode+' actual '+format+' worker / persisted source evidence');
}

async function reportAuxiliaryBoundary(A,S,R,db,mode){
 const X=await import('../server/auxiliary-accounting.mjs'),AS=await import('../server/auxiliary-storage.mjs'),B=await import('../server/local-batch-actions.mjs');
 const key='R2-'+mode,period='2026-01',format=mode.endsWith('pdf')?'pdf':'xlsx',set=A.createAccountSet({name:key,start_period:'2025-12',enterprise:{enterpriseKey:key}});
 A.setOpeningBalances(set.id,[{code:'1002',debit:1000},{code:'3001',credit:1000}]);
 const prior=A.createVoucher(set.id,{period:'2025-12',voucher_date:'2025-12-03',status:'posted',number:1,entries:[{code:'1002',debit:12.34},{code:'5001',credit:12.34}]});
 async function run(jobKey,periods,hooks={}){const v=S.validateManifest({schemaVersion:1,jobKey,concurrency:1,items:[{itemKey:key,source:{system:'r2',enterpriseKey:key},accountSetId:set.id,periods}]});assert.equal(v.ok,true);const json=S.canonicalJson(v.manifest);return R.createAndRun({manifest:v.manifest,manifestJson:json,manifestHash:S.sha256(json),...S.buildPlan({manifest:v.manifest,manifestDir:root}),outputDir:join(root,'r2-out'),hooks});}
 const seedKey=key+'-seed',payload={account_set:{name:key,start_period:'2025-12'},vouchers:[{sourceVoucherId:key,period,date:period+'-03',number:1,entries:[{code:'1002',debit:20},{code:'5001',credit:20}]}]};
 assert.equal((await run(seedKey,[{period,imports:[{batchId:seedKey,mode:'append',confirmNewBinding:true,payload}],post:{vouchers:[{sourceVoucherId:key}]}}])).status,'succeeded');
 await AS.ensureAuxiliarySchema(db,{dbPath:join(process.env.WORKBENCH_DATA_DIR,'workbench.db'),outDir:join(root,'before-r2-aux')});
 const entity=(id,code)=>X.createAuxiliaryEntity(db,{accountSetId:id,kind:'party',code,name:code,requestId:'entity-'+code}).id;
 const p=entity(set.id,'P'),q=entity(set.id,'Q'),entry=(id,code='1002')=>db.prepare('SELECT id FROM voucher_entries WHERE voucher_id=? AND code=?').get(id,code).id;
 const allocate=(id,target,party,debit,requestId)=>X.replaceAuxiliaryAllocations(db,{accountSetId:id,...target,allocations:[{partyId:party,debit}],requestId,reason:'R2 synthetic scope proof'});
 allocate(set.id,{openingCode:'1002'},p,1000,'opening-initial');allocate(set.id,{entryId:entry(prior.id)},p,12.34,'prior-initial');
 const current=db.prepare('SELECT voucher_id AS id FROM import_voucher_sources WHERE account_set_id=? AND source_voucher_id=?').get(set.id,key);assert.ok(current);allocate(set.id,{entryId:entry(current.id)},p,20,'current-initial');
 X.setAuxiliaryRequirement(db,{accountSetId:set.id,code:'1002',party:true,reason:'actual relevant requirement'});assert.equal(AS.auxiliaryCompletenessStep(db,set.id,period).status,'ok');
 let futureId,foreignId,foreignParty;
 if(mode.startsWith('future'))futureId=A.createVoucher(set.id,{period:'2026-02',voucher_date:'2026-02-03',status:mode.includes('posted')?'posted':'draft',number:1,entries:[{code:'1002',debit:10},{code:'5001',credit:10}]}).id;
 if(mode.startsWith('foreign')){const other=A.createAccountSet({name:'R2 OTHER',start_period:'2026-01',enterprise:{enterpriseKey:'R2-OTHER'}});foreignId=A.createVoucher(other.id,{period, voucher_date:period+'-04',status:'posted',number:1,entries:[{code:'1002',debit:10},{code:'5001',credit:10}]}).id;foreignParty={id:other.id,party:entity(other.id,'FOREIGN')};}
 const seedStages=()=>db.prepare('SELECT s.id,s.attempt,s.status,s.input_hash,s.outcome_hash FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id JOIN local_batch_jobs j ON j.id=i.job_id WHERE j.job_key=? ORDER BY s.id').all(seedKey);
 const finance=()=>JSON.stringify({vouchers:db.prepare('SELECT * FROM vouchers WHERE account_set_id=? ORDER BY id').all(set.id),entries:db.prepare('SELECT e.* FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? ORDER BY e.id').all(set.id),sources:db.prepare('SELECT * FROM import_voucher_sources WHERE account_set_id=? ORDER BY id').all(set.id),batches:db.prepare('SELECT * FROM import_batches WHERE batch_id=?').all(seedKey)});
 const oldStages=seedStages(),oldFinance=finance(),oldReport=JSON.stringify(A.balanceSheet(set.id,period));assert.equal(A.balanceSheet(set.id,period).totals.assets,1032.34);let changed=false,digests;
 const result=await run(key+'-report',[{period,reports:[{kind:'balance-sheet',formats:[format]}]}],{beforeArtifactPublish(){assert.equal(changed,false);changed=true;const before=B.reportBusinessDigest(db,set.id,period),financialBefore=B.businessDigest(db,set.id,period);
  if(mode.startsWith('future'))allocate(set.id,{entryId:entry(futureId)},p,10,'future-changed');
  else if(mode.startsWith('foreign'))allocate(foreignParty.id,{entryId:entry(foreignId)},foreignParty.party,10,'foreign-changed');
  else if(mode.startsWith('opening'))allocate(set.id,{openingCode:'1002'},q,1000,'opening-changed');
  else if(mode.startsWith('current'))allocate(set.id,{entryId:entry(current.id)},q,20,'current-changed');
  else if(mode.startsWith('prior'))allocate(set.id,{entryId:entry(prior.id)},q,12.34,'prior-changed');
  else if(mode.startsWith('entity'))X.updateAuxiliaryEntity(db,{accountSetId:set.id,entityId:p,active:false,reason:'actual readiness change'});
  else X.setAuxiliaryRequirement(db,{accountSetId:set.id,code:'1002',party:false,reason:'actual requirement change'});
  assert.equal(JSON.stringify(A.balanceSheet(set.id,period)),oldReport,'GL report JSON does not change when only auxiliary dependency changes');digests={before,after:B.reportBusinessDigest(db,set.id,period),financialBefore,financialAfter:B.businessDigest(db,set.id,period)};
 }});
 assert.equal(changed,true);const positive=/^(future|foreign)/.test(mode);assert.equal(result.status,positive?'succeeded':'needs_review',JSON.stringify(result));assert.equal(digests.before===digests.after,positive);if(mode.startsWith('future'))assert.notEqual(digests.financialBefore,digests.financialAfter,'original financial-stage digest still includes full auxiliary facts');assert.equal(finance(),oldFinance,'money and actual persistent sources never replay');assert.deepEqual(seedStages(),oldStages,'all completed seed stage attempts and evidence stay exact');
 const report=db.prepare("SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id JOIN local_batch_jobs j ON j.id=i.job_id WHERE j.job_key=? AND s.stage_key LIKE 'report:%'").get(key+'-report');assert.equal(report.status,positive?'succeeded':'needs_review');
 const artifacts=db.prepare('SELECT * FROM local_batch_artifacts WHERE item_id=?').all(report.item_id);if(positive){assert.equal(artifacts.length,1);assert.equal(artifacts[0].status,'published');assert.ok(artifacts[0].worker_thread_id>0);assert.ok(artifacts[0].render_finished>=artifacts[0].render_started);}else assert.equal(artifacts.length,0);
 if(mode.startsWith('entity'))assert.equal(AS.auxiliaryCompletenessStep(db,set.id,period).status,'blocked');
 writeFileSync(join(root,'r2-result.json'),JSON.stringify({mode,result,report,artifacts,digests,seedStages:oldStages,finance:JSON.parse(oldFinance),allocations:db.prepare('SELECT * FROM aux_allocations ORDER BY id').all()},null,2));console.log('PASS R2 '+mode+' actual '+format+' worker assets1032.34 / scoped auxiliary evidence');
}

async function reportResumeInputBoundary(A,S,R,db,mode){
 const B=await import('../server/local-batch-actions.mjs'),key='R3-'+mode,period='2026-01',set=A.createAccountSet({name:key,start_period:period,enterprise:{enterpriseKey:key}}),inputFile=join(root,'payload.json');
 const payload=(name,p,amount)=>({account_set:{name,start_period:period},vouchers:[{sourceVoucherId:name+'-'+p,period:p,date:p+'-03',number:1,entries:[{code:'1002',debit:amount},{code:'5001',credit:amount}]}]});
 writeFileSync(inputFile,JSON.stringify(payload(key,period,12.34)));const originalInput=readFileSync(inputFile);
 async function run(jobKey,target,periods,sourceKey=key){const v=S.validateManifest({schemaVersion:1,jobKey,concurrency:1,items:[{itemKey:sourceKey,source:{system:'r3',enterpriseKey:sourceKey},accountSetId:target.id,periods}]});assert.equal(v.ok,true);const json=S.canonicalJson(v.manifest);return R.createAndRun({manifest:v.manifest,manifestJson:json,manifestHash:S.sha256(json),...S.buildPlan({manifest:v.manifest,manifestDir:root}),outputDir:join(root,'r3-out')});}
 const importJob=key+'-import';assert.equal((await run(importJob,set,[{period,imports:[{batchId:importJob,mode:'append',confirmNewBinding:true,payloadFile:'payload.json'}],post:{vouchers:[{sourceVoucherId:key+'-'+period}]},reports:[{kind:'balance-sheet',formats:['csv']}]}])).status,'succeeded');
 let futureFile,foreignFile;
 if(mode==='unrelated'){
  futureFile=join(root,'future.json');writeFileSync(futureFile,JSON.stringify(payload(key,'2026-02',10)));assert.equal((await run(key+'-future',set,[{period:'2026-02',imports:[{batchId:key+'-future',mode:'append',confirmNewBinding:true,payloadFile:'future.json'}]}])).status,'succeeded');
  const foreignKey=key+'-FOREIGN',foreign=A.createAccountSet({name:foreignKey,start_period:period,enterprise:{enterpriseKey:foreignKey}});foreignFile=join(root,'foreign.json');writeFileSync(foreignFile,JSON.stringify(payload(foreignKey,period,10)));assert.equal((await run(key+'-foreign',foreign,[{period,imports:[{batchId:key+'-foreign',mode:'append',confirmNewBinding:true,payloadFile:'foreign.json'}]}],foreignKey)).status,'succeeded');
 }
 const reportJob=key+'-only',formats=mode==='report-pending-changed'?['csv','xlsx']:['xlsx'];assert.equal((await run(reportJob,set,[{period,reports:[{kind:'balance-sheet',formats}]}])).status,'succeeded');
 const target=mode.startsWith('import')?importJob:reportJob;
 const importTuple=()=>db.prepare("SELECT s.id,s.attempt,s.status,s.input_hash,s.outcome_hash FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.account_set_id=? AND s.stage_key NOT LIKE 'report:%' ORDER BY s.id").all(set.id);
 const finance=()=>JSON.stringify({vouchers:db.prepare('SELECT * FROM vouchers WHERE account_set_id=? ORDER BY id').all(set.id),entries:db.prepare('SELECT e.* FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? ORDER BY e.id').all(set.id),sources:db.prepare('SELECT * FROM import_voucher_sources WHERE account_set_id=? ORDER BY id').all(set.id),batches:db.prepare('SELECT * FROM import_batches WHERE account_set_id=? ORDER BY batch_id').all(set.id)});
 const oldTuple=importTuple(),oldFinance=finance(),artifacts=db.prepare('SELECT a.* FROM local_batch_artifacts a JOIN local_batch_items i ON i.id=a.item_id WHERE i.account_set_id=? ORDER BY a.id').all(set.id),artifactBytes=artifacts.map(a=>({id:a.id,file:join(root,'r3-out',a.relative_path),hash:S.sha256(readFileSync(join(root,'r3-out',a.relative_path)))}));
 assert.equal(A.balanceSheet(set.id,period).totals.assets,12.34);assert.equal((await R.resumeJob({jobKey:target})).status,'succeeded','normal unchanged source remains verified');
 let result,snapshotResult,cliResult,savedCheck;
 if(mode==='unrelated'){writeFileSync(futureFile,'future changed');unlinkSync(foreignFile);result=await R.resumeJob({jobKey:target});assert.equal(result.status,'succeeded','later period and foreign source do not affect current report');}
 else if(mode==='saved-bytes'){
  const prepare=db.prepare;let injected=false;
  db.prepare=function(sql){const stmt=prepare.call(db,sql);if(!String(sql).startsWith('SELECT n.* FROM local_batch_inputs n JOIN local_batch_items i ON i.id=n.item_id'))return stmt;return new Proxy(stmt,{get(object,property){if(property==='all')return (...args)=>{if(!injected){injected=true;prepare.call(db,'UPDATE local_batch_inputs SET content=? WHERE batch_id=?').run(Buffer.from('bad saved bytes'),importJob);}return object.all(...args);};const value=Reflect.get(object,property,object);return typeof value==='function'?value.bind(object):value;}});};
  try{result=await R.resumeJob({jobKey:target,allowSnapshotOnly:true});}finally{db.prepare=prepare;}assert.equal(injected,true);savedCheck=S.checkInputEvidence(db.prepare('SELECT * FROM local_batch_inputs WHERE batch_id=?').get(importJob),{allowSnapshotOnly:true});assert.equal(savedCheck.ok,false);assert.equal(savedCheck.savedValid,false);assert.equal(result.status,'needs_review','explicit snapshot mode never exempts saved bytes');
 }else{
  if(mode==='report-pending-changed'){const report=db.prepare("SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id JOIN local_batch_jobs j ON j.id=i.job_id WHERE j.job_key=? AND s.stage_key LIKE '%:xlsx'").get(target);S.resetStage(db,{stageId:report.id,status:S.STAGE_STATUS.NEEDS_REVIEW,errorCode:'r3-controlled-pending'});S.resetStagesForRetry(db,{jobKey:target});}
  if(mode.endsWith('missing'))unlinkSync(inputFile);else writeFileSync(inputFile,'changed external bytes');
  if(mode!=='report-pending-changed'){snapshotResult=await R.resumeJob({jobKey:target,allowSnapshotOnly:true});assert.equal(snapshotResult.status,'succeeded','explicit snapshot verifies already successful reports without financial replay');}
  if(mode==='import-changed'){
   const cli=await owned(['scripts/local-batch.mjs','resume','--data-dir',process.env.WORKBENCH_DATA_DIR,'--job-key',target]).done;assert.equal(cli.code,1,cli.stdout+cli.stderr);cliResult=JSON.parse(cli.stdout.trim());assert.equal(cliResult.ok,false);assert.equal(cliResult.status,'needs_review');result=cliResult;
  }else result=await R.resumeJob({jobKey:target});
  assert.equal(result.status,'needs_review','ordinary resume must refuse completed report external drift');
 }
 const reportStages=db.prepare("SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id JOIN local_batch_jobs j ON j.id=i.job_id WHERE j.job_key=? AND s.stage_key LIKE 'report:%' ORDER BY s.id").all(target);assert.ok(reportStages.every(s=>s.status===(mode==='unrelated'?'succeeded':'needs_review')));
 assert.deepEqual(importTuple(),oldTuple,'succeeded import/post stages never negated or replayed');assert.equal(finance(),oldFinance,'real posted money, batch and sourceTrace storage stay exact');for(const artifact of artifactBytes)assert.equal(S.sha256(readFileSync(artifact.file)),artifact.hash,'published file bytes retained');assert.deepEqual(db.prepare('SELECT a.* FROM local_batch_artifacts a JOIN local_batch_items i ON i.id=a.item_id WHERE i.account_set_id=? ORDER BY a.id').all(set.id),artifacts,'artifact registration is not republished');
 writeFileSync(join(root,'r3-result.json'),JSON.stringify({mode,result,snapshotResult,cliResult,savedCheck,reportStages,originalImportTuple:oldTuple,artifacts:artifactBytes,finance:JSON.parse(oldFinance)},null,2));console.log('PASS R3 '+mode+' completed report input / posted12.34 preserved');
}

async function reportPublicationBoundary(A,S,R,db,mode){
 const B=await import('../server/local-batch-actions.mjs'),key='R4-'+mode,period='2026-01',format=mode==='positive-xlsx'||mode==='old-publishing'?'xlsx':'csv';
 const set=A.createAccountSet({name:key,start_period:period,enterprise:{enterpriseKey:key}}),out=join(root,'r4-out');
 async function run(jobKey,periods,hooks={}){const v=S.validateManifest({schemaVersion:1,jobKey,concurrency:1,items:[{itemKey:key,source:{system:'r4',enterpriseKey:key},accountSetId:set.id,periods}]});assert.equal(v.ok,true);const json=S.canonicalJson(v.manifest);return R.createAndRun({manifest:v.manifest,manifestJson:json,manifestHash:S.sha256(json),...S.buildPlan({manifest:v.manifest,manifestDir:root}),outputDir:out,hooks});}
 const seed=key+'-seed',payload={account_set:{name:key,start_period:period},vouchers:[{sourceVoucherId:key,period,date:period+'-03',number:1,entries:[{code:'1002',debit:12.34},{code:'5001',credit:12.34}]}]};
 assert.equal((await run(seed,[{period,imports:[{batchId:seed,mode:'append',confirmNewBinding:true,payload}],post:{vouchers:[{sourceVoucherId:key}]}}])).status,'succeeded');
 const seedJob=S.getJobByKey(db,seed),financial=()=>JSON.stringify({vouchers:db.prepare('SELECT * FROM vouchers ORDER BY id').all(),entries:db.prepare('SELECT * FROM voucher_entries ORDER BY id').all(),sources:db.prepare('SELECT * FROM import_voucher_sources ORDER BY id').all(),batches:db.prepare('SELECT * FROM import_batches ORDER BY batch_id').all(),links:db.prepare('SELECT * FROM import_batch_vouchers ORDER BY id').all()}),tuples=()=>db.prepare("SELECT s.id,s.attempt,s.status,s.input_hash,s.outcome_hash FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.job_id=? ORDER BY s.id").all(seedJob.id);
 const oldFinance=financial(),oldTuples=tuples();let injected=false,file,originalBytes;
 const report=()=>db.prepare("SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id JOIN local_batch_jobs j ON j.id=i.job_id WHERE j.job_key=? AND s.stage_key LIKE 'report:%'").get(key);
 const artifact=()=>S.getArtifactByStage(db,{itemId:report().item_id,period,stageKey:report().stage_key});
 function mutate(){assert.equal(injected,false);injected=true;const a=artifact(),field=mode.replace(/^(new|recover|completed|rerender)-/,'').replace(/^(cache|late)-/,'');assert.ok(a);file=join(out,a.relative_path);originalBytes??=readFileSync(file);
  if(field==='delete')db.prepare('DELETE FROM local_batch_artifacts WHERE id=?').run(a.id);
  else if(field==='snapshot-owner')db.prepare('UPDATE local_batch_snapshots SET job_id=? WHERE item_id=?').run(seedJob.id,a.item_id);
  else if(field==='snapshot-body'){const snap=S.getSnapshot(db,{itemId:a.item_id,period,kind:a.kind}),json=JSON.stringify({...JSON.parse(snap.dto_json),r4Changed:true});db.prepare('UPDATE local_batch_snapshots SET dto_json=?,dto_hash=? WHERE snapshot_key=?').run(json,S.sha256(json),snap.snapshot_key);}
  else if(field==='file')writeFileSync(file,Buffer.from('real changed bytes after initial recovery file check'));
  else {const changes={job:['job_id',seedJob.id],kind:['kind','income-statement'],path:['relative_path','changed/retained.csv'],bytes:['bytes',a.bytes+1],hash:['bytes_hash','f'.repeat(64)],'snapshot-hash':['snapshot_hash','e'.repeat(64)],attempt:['attempt',a.attempt+1],render:['render_started',a.render_started+1],status:['status','invalid'],moved:['item_id',S.listItems(db,seedJob.id)[0].id]};const [column,value]=changes[field];db.prepare('UPDATE local_batch_artifacts SET '+column+'=? WHERE id=?').run(value,a.id);}
 }
 const terminal=mode.startsWith('terminal-'),initialPrepare=db.prepare;
 if(terminal)db.prepare=function(sql){const stmt=initialPrepare.call(db,sql);if(!/^UPDATE local_batch_stages\s+SET status=\?, outcome_hash=\?, evidence_json=\?/.test(String(sql)))return stmt;return new Proxy(stmt,{get(object,property){if(property==='run')return (...args)=>{const info=object.run(...args);if(!injected&&args[0]==='succeeded'&&args[7]===report().id){injected=true;const a=artifact();file=join(out,a.relative_path);originalBytes=readFileSync(file);if(mode==='terminal-status')initialPrepare.call(db,"UPDATE local_batch_stages SET status='needs_review' WHERE id=?").run(args[7]);else{const evidence=JSON.parse(args[2]);if(mode==='terminal-owner')evidence.accountSetId=set.id+1000;else evidence.businessHash='f'.repeat(64);initialPrepare.call(db,'UPDATE local_batch_stages SET evidence_json=? WHERE id=?').run(S.canonicalJson(evidence),args[7]);}}return info;};const value=Reflect.get(object,property,object);return typeof value==='function'?value.bind(object):value;}});};
 let result;try{result=await run(key,[{period,reports:[{kind:'balance-sheet',formats:[format]}]}],mode.startsWith('new-')?{afterArtifactPublish:mutate}:{});}finally{db.prepare=initialPrepare;}
 if(mode.startsWith('new-')||terminal){assert.equal(injected,true);assert.equal(result.status,'needs_review',JSON.stringify(result));assert.notEqual(report().status,'succeeded');}
 else {
  assert.equal(result.status,'succeeded',JSON.stringify(result));const oldArtifact=artifact(),oldReport=report();file=join(out,oldArtifact.relative_path);originalBytes=readFileSync(file);S.assertBatchSchema(db);
  if(format==='xlsx'){const {default:ExcelJS}=await import('exceljs'),workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(file);let found=false;workbook.eachSheet(sheet=>sheet.eachRow(row=>row.eachCell(cell=>{if(cell.value===12.34)found=true;})));assert.equal(found,true,'real XLSX contains posted12.34');assert.ok(oldArtifact.worker_thread_id>0);}
  if(mode.startsWith('recover-')||mode.startsWith('old-')||mode.startsWith('rerender-')){
   S.resetStage(db,{stageId:oldReport.id,status:S.STAGE_STATUS.NEEDS_REVIEW,errorCode:'r4-controlled-retry'});S.resetStagesForRetry(db,{jobKey:key});
   if(mode==='old-publishing')db.prepare("UPDATE local_batch_artifacts SET status='publishing' WHERE id=?").run(oldArtifact.id);
   if(mode.startsWith('rerender-'))db.prepare("UPDATE local_batch_artifacts SET status='invalid' WHERE id=?").run(oldArtifact.id);
   if(mode==='old-csv-snapshot'){const csv='new mutable CSV from later snapshot';db.prepare('UPDATE local_batch_snapshots SET csv_text=?,csv_hash=? WHERE item_id=?').run(csv,S.sha256(csv),oldReport.item_id);}
   // This targeted .all snapshot read occurs inside publishLocked, after the
   // cached artifact and initial exists/hash check. Mutate real rows/files here.
   const prepare=db.prepare;
   db.prepare=function(sql){const stmt=prepare.call(db,sql);if(!String(sql).startsWith('SELECT * FROM local_batch_snapshots WHERE item_id=? AND period=? AND kind=?'))return stmt;return new Proxy(stmt,{get(object,property){if(property==='all')return (...args)=>{if(!injected&&mode.startsWith('recover-'))mutate();return object.all(...args);};const value=Reflect.get(object,property,object);return typeof value==='function'?value.bind(object):value;}});};
   try{result=await R.resumeJob({jobKey:key,hooks:{beforeArtifactPublish(){if(mode==='rerender-valid')injected=true;else if(mode.startsWith('rerender-'))mutate();else assert.fail('recovery must not rerender or republish');}}});}finally{db.prepare=prepare;}
   if(mode.startsWith('old-')){assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.results[0].recovered,true);assert.ok(report().attempt>oldArtifact.attempt,'newer claim recovers old artifact');const current=artifact();for(const field of Object.keys(oldArtifact).filter(f=>!['status','updated_at'].includes(f)))assert.equal(current[field],oldArtifact[field],field);S.assertBatchSchema(db);assert.equal(B.verifyStageEvidence({stage:report(),item:S.getItem(db,report().item_id),outputDir:out}).ok,true);}
   else if(mode==='rerender-valid'){assert.equal(injected,true);assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(artifact().attempt,report().attempt);assert.ok(artifact().attempt>oldArtifact.attempt);S.assertBatchSchema(db);}
   else {assert.equal(injected,true);assert.equal(result.status,'needs_review',JSON.stringify(result));assert.notEqual(report().status,'succeeded');if(mode==='recover-file')S.assertBatchSchema(db);if(mode==='rerender-delete')assert.equal(db.prepare('SELECT * FROM local_batch_artifacts WHERE id=?').get(oldArtifact.id),undefined);if(mode==='rerender-moved')assert.equal(db.prepare('SELECT * FROM local_batch_artifacts WHERE id=?').get(oldArtifact.id).item_id,S.listItems(db,seedJob.id)[0].id);}
  }else if(mode.startsWith('completed-')){
   const prepare=db.prepare;let snapshotReads=0;
   if(mode.startsWith('completed-cache-')||mode.startsWith('completed-late-'))db.prepare=function(sql){const stmt=prepare.call(db,sql);const target=mode.startsWith('completed-cache-')?'SELECT * FROM local_batch_artifacts WHERE item_id=? AND period=? AND stage_key=?':'SELECT * FROM local_batch_snapshots WHERE item_id=? AND period=? AND kind=?';if(!String(sql).startsWith(target))return stmt;return new Proxy(stmt,{get(object,property){if(property==='all')return (...args)=>{const rows=object.all(...args);snapshotReads++;if(!injected&&(mode.startsWith('completed-cache-')||snapshotReads===2))mutate();return rows;};const value=Reflect.get(object,property,object);return typeof value==='function'?value.bind(object):value;}});};
   else mutate();
   let check;try{check=B.verifyStageEvidence({stage:oldReport,item:S.getItem(db,oldReport.item_id),outputDir:out});}finally{db.prepare=prepare;}assert.equal(injected,true);assert.equal(check.ok,false,mode+JSON.stringify(check));result=check;
  }
  else {assert.equal(B.verifyStageEvidence({stage:oldReport,item:S.getItem(db,oldReport.item_id),outputDir:out}).ok,true);assert.equal((await R.resumeJob({jobKey:key})).status,'succeeded');}
 }
 assert.equal(financial(),oldFinance,'posted money and persistent sourceTrace never replay');assert.deepEqual(tuples(),oldTuples,'original financial stage tuples retained');assert.equal(A.balanceSheet(set.id,period).totals.assets,12.34);
 if(!mode.endsWith('-file'))assert.deepEqual(readFileSync(file),originalBytes,'original actual published bytes retained');else assert.notDeepEqual(readFileSync(file),originalBytes,'intentional real file mutation retained');
 writeFileSync(join(root,'r4-result.json'),JSON.stringify({mode,result,injected,report:report(),artifact:artifact(),file,originalHash:S.sha256(originalBytes),actualHash:S.sha256(readFileSync(file)),originalFinancialTuples:oldTuples,finance:JSON.parse(oldFinance)},null,2));console.log('PASS R4 '+mode+' '+format+' persistent owners / final bytes / posted12.34');
}


async function sourceCompleteness(A,S,R,db){
 const I=await import('../server/import-incremental.mjs'),B=await import('../server/local-batch-actions.mjs'),period='2026-01',out=join(root,'r5-out');
 const create=key=>A.createAccountSet({name:key,start_period:period,enterprise:{enterpriseKey:key}});
 const payload=(key,p=period,offset=0)=>({account_set:{name:key,start_period:period},vouchers:[12.34,6.17].map((amount,i)=>({sourceVoucherId:key+'-'+p+'-'+i,period:p,date:p+'-03',number:offset+i+1,entries:[{code:'1002',debit:amount},{code:'5001',credit:amount}]}))});
 async function run(jobKey,set,source,periods,hooks={}){const v=S.validateManifest({schemaVersion:1,jobKey,concurrency:1,items:[{itemKey:source.enterpriseKey,source,accountSetId:set.id,periods}]});assert.equal(v.ok,true,JSON.stringify(v));const json=S.canonicalJson(v.manifest);return R.createAndRun({manifest:v.manifest,manifestJson:json,manifestHash:S.sha256(json),...S.buildPlan({manifest:v.manifest,manifestDir:root}),outputDir:out,hooks});}
 const importPeriod=(batchId,p)=>({period,imports:[{batchId,mode:'append',confirmNewBinding:true,payload:p}],reports:[{kind:'income-statement',formats:['csv']}]});
 const finance=set=>JSON.stringify({vouchers:db.prepare('SELECT * FROM vouchers WHERE account_set_id=? ORDER BY id').all(set.id),entries:db.prepare('SELECT e.* FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? ORDER BY e.id').all(set.id),batches:db.prepare('SELECT * FROM import_batches WHERE account_set_id=? ORDER BY batch_id').all(set.id),links:db.prepare('SELECT * FROM import_batch_vouchers WHERE account_set_id=? ORDER BY id').all(set.id),sources:db.prepare('SELECT * FROM import_voucher_sources WHERE account_set_id=? ORDER BY id').all(set.id)});
 const tuples=set=>db.prepare("SELECT s.id,s.attempt,s.input_hash,s.outcome_hash FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.account_set_id=? AND s.stage_key LIKE 'import:%' ORDER BY s.id").all(set.id);
 const mutations={
  'both-all':(set)=>{for(const t of ['import_batch_vouchers','import_voucher_sources'])db.prepare(`DELETE FROM ${t} WHERE account_set_id=?`).run(set.id);},
  'both-part':(set)=>{for(const t of ['import_batch_vouchers','import_voucher_sources'])db.prepare(`DELETE FROM ${t} WHERE account_set_id=? AND source_voucher_id LIKE '%-0'`).run(set.id);},
  'link-all':set=>db.prepare('DELETE FROM import_batch_vouchers WHERE account_set_id=?').run(set.id),
  'link-part':set=>db.prepare("DELETE FROM import_batch_vouchers WHERE account_set_id=? AND source_voucher_id LIKE '%-0'").run(set.id),
  fingerprint:set=>db.prepare("UPDATE import_batch_vouchers SET content_fingerprint=? WHERE account_set_id=? AND source_voucher_id LIKE '%-0'").run('a'.repeat(64),set.id),
  pointer:set=>db.prepare("UPDATE import_batch_vouchers SET voucher_id=(SELECT MAX(id) FROM vouchers WHERE account_set_id=?) WHERE account_set_id=? AND source_voucher_id LIKE '%-0'").run(set.id,set.id),
  'source-all':set=>db.prepare('DELETE FROM import_voucher_sources WHERE account_set_id=?').run(set.id),
  'source-part':set=>db.prepare("DELETE FROM import_voucher_sources WHERE account_set_id=? AND source_voucher_id LIKE '%-0'").run(set.id),
  'batch-fingerprint':set=>db.prepare("UPDATE import_batches SET content_fingerprint=? WHERE account_set_id=?").run('b'.repeat(64),set.id),
  action:set=>db.prepare("UPDATE import_batch_vouchers SET action='deduplicated' WHERE account_set_id=? AND source_voucher_id LIKE '%-0'").run(set.id),
  'extra-link':set=>db.prepare("INSERT INTO import_batch_vouchers(batch_id,source_system,enterprise_key,source_voucher_id,account_set_id,voucher_id,content_fingerprint,action,created_at) SELECT batch_id,source_system,enterprise_key,source_voucher_id||'-extra',account_set_id,voucher_id,content_fingerprint,action,created_at FROM import_batch_vouchers WHERE account_set_id=? LIMIT 1").run(set.id),
  'extra-source':set=>db.prepare("INSERT INTO import_voucher_sources(source_system,enterprise_key,source_voucher_id,account_set_id,voucher_id,content_fingerprint,batch_id,created_at,voucher_fingerprint) SELECT source_system,enterprise_key,source_voucher_id||'-extra',account_set_id,voucher_id,content_fingerprint,batch_id,created_at,voucher_fingerprint FROM import_voucher_sources WHERE account_set_id=? LIMIT 1").run(set.id),
 };
 for(const [mode,mutate] of Object.entries(mutations)){
  const key='R5-'+mode,set=create(key),source={system:'r5',enterpriseKey:key};
  assert.equal((await run(key,set,source,[importPeriod(key,payload(key))])).status,'succeeded');assert.equal(A.incomeStatement(set.id,period).current['净利润'],18.51);assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?').get(set.id).n,2);
  const beforeTuples=tuples(set),inputs=db.prepare('SELECT n.* FROM local_batch_inputs n JOIN local_batch_items i ON i.id=n.item_id WHERE i.account_set_id=? ORDER BY input_key').all(set.id),artifacts=db.prepare('SELECT a.* FROM local_batch_artifacts a JOIN local_batch_items i ON i.id=a.item_id WHERE i.account_set_id=?').all(set.id).map(a=>({file:join(out,a.relative_path),bytes:readFileSync(join(out,a.relative_path))}));
  mutate(set);const tampered=finance(set);
  assert.equal((await R.resumeJob({jobKey:key})).status,'needs_review',mode+' import resume');
  assert.equal((await run(key+'-report',set,{system:'report-reader',enterpriseKey:key},[{period,reports:[{kind:'income-statement',formats:['csv']}]}])).status,'needs_review',mode+' report-only');
  S.resetStagesForRetry(db,{jobKey:key});assert.equal((await R.resumeJob({jobKey:key})).status,'needs_review',mode+' retry does not recreate finance');
  assert.equal(finance(set),tampered,mode+' no repair or financial replay');assert.deepEqual(tuples(set),beforeTuples,mode+' original import attempt/input/outcome unchanged');assert.deepEqual(db.prepare('SELECT n.* FROM local_batch_inputs n JOIN local_batch_items i ON i.id=n.item_id WHERE i.account_set_id=? ORDER BY input_key').all(set.id),inputs);for(const a of artifacts)assert.deepEqual(readFileSync(a.file),a.bytes);assert.equal(A.incomeStatement(set.id,period).current['净利润'],18.51);
  console.log('PASS R5 '+mode+' resume/report/retry');
 }
 for(const mode of ['both-all','link-part','fingerprint','pointer']){
  const key='R5-hook-'+mode,set=create(key),source={system:'r5',enterpriseKey:key};let called=false;
  const result=await run(key,set,source,[importPeriod(key,payload(key))],{afterImportCommit(){called=true;mutations[mode](set);}});
  assert.equal(called,true);assert.equal(result.status,'needs_review');for(const t of ['vouchers','import_batch_vouchers','import_voucher_sources'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE account_set_id=?`).get(set.id).n,0,mode+' atomic '+t);assert.equal(db.prepare("SELECT COUNT(*) n FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.account_set_id=? AND s.status='succeeded'").get(set.id).n,0);console.log('PASS R5 checkpoint rollback '+mode);
 }
 const key='R5-positive',set=create(key),source={system:'r5',enterpriseKey:key},p=payload(key);
 assert.equal((await run(key,set,source,[importPeriod(key,p)])).status,'succeeded');assert.equal((await R.resumeJob({jobKey:key})).status,'succeeded');
 const before=finance(set);assert.equal((await run(key+'-replay',set,source,[importPeriod(key,p)])).status,'succeeded');assert.equal(finance(set),before,'same batch replay stays read-only');
 const dedup=key+'-dedup';assert.equal((await run(dedup,set,source,[importPeriod(dedup,p)])).status,'succeeded');assert.equal(I.getImportBatch(dedup).batch.result.vouchersCreated,0);assert.equal(I.getImportBatch(dedup).batch.result.vouchersDeduplicated,2);assert.equal((await R.resumeJob({jobKey:dedup})).status,'succeeded');assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?').get(set.id).n,2);
 const empty=key+'-empty';assert.equal((await run(empty,set,source,[importPeriod(empty,{account_set:p.account_set,vouchers:[]})])).status,'succeeded');assert.equal((await R.resumeJob({jobKey:empty})).status,'succeeded');assert.equal(I.getImportBatch(empty).voucherCount,0);
 // Older persisted results have counts only; saved bytes + checkpoint are sufficient.
 const old=I.getImportBatch(key).batch.result;delete old.sourceTrace;db.prepare('UPDATE import_batches SET result_json=? WHERE batch_id=?').run(JSON.stringify(old),key);const legacyStage=db.prepare("SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.account_set_id=? AND s.stage_key LIKE 'import:%' ORDER BY s.id LIMIT 1").get(set.id),legacyItem=db.prepare('SELECT * FROM local_batch_items WHERE id=?').get(legacyStage.item_id);assert.equal(B.verifyStageEvidence({stage:legacyStage,item:legacyItem}).ok,true,'legacy import checkpoint proves complete identities');assert.equal(I.getImportBatch(key).voucherCount,2);
 const future={dryRun:false,mode:'append',accountSetId:set.id,source,batchId:key+'-future',confirmNewBinding:true,payload:payload(key,'2026-02')};assert.equal(I.importIncremental(future).ok,true);
 const second={...future,batchId:key+'-other-system',source:{system:'r5-other',enterpriseKey:key},payload:payload(key+'-other',period,2)};assert.equal(I.importIncremental(second).ok,true);
 const foreignKey='R5-foreign',foreign=create(foreignKey);assert.equal(I.importIncremental({...future,accountSetId:foreign.id,source:{system:'r5',enterpriseKey:foreignKey},batchId:foreignKey,payload:payload(foreignKey)}).ok,true);mutations['both-all'](foreign);
 const stable=finance(set);assert.equal((await run(key+'-scoped-report',set,{system:'report-reader',enterpriseKey:key},[{period,reports:[{kind:'income-statement',formats:['csv']}]}])).status,'succeeded');assert.equal(finance(set),stable);assert.equal(A.incomeStatement(set.id,period).current['净利润'],37.02);
 assert.equal(B.verifyReportSourceEvidence({item:{account_set_id:set.id,enterprise_key:key,source_system:'reader'},period}).ok,true);
 const manualKey='R5-manual',manual=create(manualKey);A.createVoucher(manual.id,{period,voucher_date:period+'-03',number:1,status:'posted',entries:[{code:'1002',debit:4.56},{code:'5001',credit:4.56}]});assert.equal((await run(manualKey,manual,{system:'reader',enterpriseKey:manualKey},[{period,reports:[{kind:'income-statement',formats:['csv']}]}])).status,'succeeded');
 // Genuine upgrade: strip old result extensions BEFORE any local input/checkpoint.
 for(const mode of ['valid','missing-link','missing-source','bad-fingerprint']){
  const legacyKey='R6-first-create-'+mode,legacySource={system:'r6-create',enterpriseKey:legacyKey},legacyRequest={dryRun:false,mode:'create',source:legacySource,batchId:legacyKey,payload:payload(legacyKey)};
  const created=I.importIncremental(legacyRequest);assert.equal(created.ok,true);const legacySet={id:created.accountSetId};
  const oldResult=I.getImportBatch(legacyKey).batch.result;for(const field of ['sourceTrace','contentFingerprint','mode','accountSetId','source'])delete oldResult[field];db.prepare('UPDATE import_batches SET result_json=? WHERE batch_id=?').run(JSON.stringify(oldResult),legacyKey);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM local_batch_inputs WHERE batch_id=?').get(legacyKey).n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.account_set_id=?').get(legacySet.id).n,0);
  assert.equal(I.importIncremental(legacyRequest).status,'idempotent_replay','original direct replay precedes first local checkpoint');
  if(mode==='missing-link')mutations['link-part'](legacySet);if(mode==='missing-source')mutations['source-part'](legacySet);if(mode==='bad-fingerprint')mutations.fingerprint(legacySet);
  const untouched=finance(legacySet),first=await run(legacyKey,{},legacySource,[{period,imports:[{batchId:legacyKey,mode:'create',payload:legacyRequest.payload}]}]);
  assert.equal(first.status,mode==='valid'?'succeeded':'failed',mode+' first local legacy job');assert.equal(finance(legacySet),untouched,'first legacy job never repairs or redoes financial rows or result');
  if(mode==='valid'){assert.equal((await R.resumeJob({jobKey:legacyKey})).status,'succeeded');assert.equal(A.incomeStatement(legacySet.id,period).current['净利润'],18.51);assert.equal(I.getImportBatch(legacyKey).batch.contentFingerprint,created.batch.contentFingerprint);assert.equal(I.getImportBatch(legacyKey).voucherCount,2);}
  console.log('PASS R6 first legacy create '+mode);
 }
 const createKey='R5-old-create',createSource={system:'r5-create',enterpriseKey:createKey},createRequest={dryRun:false,mode:'create',source:createSource,batchId:createKey,payload:payload(createKey)};
 const created=I.importIncremental(createRequest);assert.equal(created.ok,true);const createdSet={id:created.accountSetId};
 assert.equal((await run(createKey,{},createSource,[{period,imports:[{batchId:createKey,mode:'create',payload:createRequest.payload}]}])).status,'succeeded');
 const legacyCreated=I.getImportBatch(createKey).batch.result;for(const field of ['sourceTrace','contentFingerprint','mode','accountSetId','source'])delete legacyCreated[field];db.prepare('UPDATE import_batches SET result_json=? WHERE batch_id=?').run(JSON.stringify(legacyCreated),createKey);
 const createStage=db.prepare("SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.account_set_id=? AND s.stage_key LIKE 'import:%'").get(createdSet.id),createItem=db.prepare('SELECT * FROM local_batch_items WHERE id=?').get(createStage.item_id);
 assert.equal(B.verifyStageEvidence({stage:createStage,item:createItem}).ok,true,'old create fingerprint uses its original checkpoint');const oldCreateMoney=finance(createdSet);assert.equal(I.importIncremental(createRequest).status,'idempotent_replay');assert.equal(finance(createdSet),oldCreateMoney,'old create replay does not recreate finance');
 for(const mode of ['raw-deleted','legacy-insufficient']){
  const rawKey='R5-'+mode,rawSet=create(rawKey),rawSource={system:'r5-direct',enterpriseKey:rawKey};
  assert.equal(I.importIncremental({dryRun:false,mode:'append',accountSetId:rawSet.id,source:rawSource,batchId:rawKey,confirmNewBinding:true,payload:payload(rawKey)}).ok,true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM local_batch_inputs WHERE batch_id=?').get(rawKey).n,0,'direct import has no local saved input/checkpoint');
  if(mode==='raw-deleted')mutations['both-all'](rawSet);else{const result=I.getImportBatch(rawKey).batch.result;delete result.sourceTrace;db.prepare('UPDATE import_batches SET result_json=? WHERE batch_id=?').run(JSON.stringify(result),rawKey);assert.equal(I.getImportBatch(rawKey).voucherCount,2,'legacy raw batch remains independently queryable');}
  const unchanged=finance(rawSet);assert.equal((await run(rawKey+'-report',rawSet,{system:'reader',enterpriseKey:rawKey},[{period,reports:[{kind:'income-statement',formats:['csv']}]}])).status,'needs_review',mode+' cannot infer missing source identities');assert.equal(finance(rawSet),unchanged);assert.equal(A.incomeStatement(rawSet.id,period).current['净利润'],18.51);console.log('PASS R5 '+mode+' report review without source repair');
 }
 // R9: scope is established from actual vouchers before excluding future tuples.
 const outputFiles=(dir=out)=>existsSync(dir)?readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?outputFiles(join(dir,e.name)):[{file:join(dir,e.name),hash:S.sha256(readFileSync(join(dir,e.name)))}]).sort((a,b)=>a.file.localeCompare(b.file)):[];
 const r9Cases=['raw-both','raw-link','raw-source','raw-period','raw-missing-voucher','raw-wrong-book','saved-period','saved-input-period','checkpoint-period','legacy-checkpoint-period'];
 for(const mode of r9Cases){
  const k='R9-'+mode,target=create(k),src={system:'r9',enterpriseKey:k},data={account_set:{name:k,start_period:period},vouchers:[{sourceVoucherId:k,period,date:period+'-03',number:1,entries:[{code:'1002',debit:14.73},{code:'5001',credit:14.73}]}]};
  if(mode.startsWith('raw-')){
   assert.equal(I.importIncremental({dryRun:false,mode:'append',accountSetId:target.id,source:src,batchId:k,confirmNewBinding:true,payload:data}).ok,true);
   assert.equal(db.prepare('SELECT COUNT(*) n FROM local_batch_inputs WHERE batch_id=?').get(k).n,0);assert.equal(tuples(target).length,0,'raw import has no successful local checkpoint');
  }else assert.equal((await run(k,target,src,[importPeriod(k,data)])).status,'succeeded');
  const scope={accountSetId:target.id,enterpriseKey:k,sourceSystem:src.system,period},item={account_set_id:target.id,enterprise_key:k,source_system:'report-reader'};
  assert.equal(I.verifyImportBatchSources(k,scope).ok,true);assert.equal(B.verifyReportSourceEvidence({item,period}).ok,true);assert.equal(A.incomeStatement(target.id,period).current['净利润'],14.73);
  let moved,inputOriginal,changeInput;
  if(mode==='raw-both')for(const table of ['import_batch_vouchers','import_voucher_sources'])db.prepare(`DELETE FROM ${table} WHERE batch_id=?`).run(k);
  if(mode==='raw-link')db.prepare('DELETE FROM import_batch_vouchers WHERE batch_id=?').run(k);
  if(mode==='raw-source')db.prepare('DELETE FROM import_voucher_sources WHERE batch_id=?').run(k);
  const result=I.getImportBatch(k).batch.result;
  if(['raw-both','raw-link','raw-source','raw-period','raw-missing-voucher','raw-wrong-book','saved-period'].includes(mode)){result.sourceTrace[0].period='2026-02';db.prepare('UPDATE import_batches SET result_json=? WHERE batch_id=?').run(JSON.stringify(result),k);}
  if(mode==='raw-missing-voucher'){const id=result.sourceTrace[0].voucherId;db.prepare('DELETE FROM voucher_entries WHERE voucher_id=?').run(id);db.prepare('DELETE FROM vouchers WHERE id=?').run(id);assert.equal(db.prepare('SELECT * FROM vouchers WHERE id=?').get(id),undefined);}
  if(mode==='raw-wrong-book'){moved=create(k+'-other');db.prepare('UPDATE vouchers SET account_set_id=? WHERE id=?').run(moved.id,result.sourceTrace[0].voucherId);}
  if(mode==='saved-input-period'){const input=db.prepare('SELECT * FROM local_batch_inputs WHERE batch_id=?').get(k),changed=JSON.parse(Buffer.from(input.content).toString('utf8'));changed.vouchers[0].period='2026-02';changed.vouchers[0].date='2026-02-03';const bytes=Buffer.from(JSON.stringify(changed));inputOriginal=input;changeInput=()=>db.prepare('UPDATE local_batch_inputs SET content=?,source_hash=? WHERE input_key=?').run(bytes,S.sha256(bytes),input.input_key);changeInput();}
  if(mode.includes('checkpoint-period')){const stage=db.prepare("SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.account_set_id=? AND s.stage_key LIKE 'import:%'").get(target.id),evidence=JSON.parse(stage.evidence_json);evidence.vouchers[0].period='2026-02';db.prepare('UPDATE local_batch_stages SET evidence_json=? WHERE id=?').run(JSON.stringify(evidence),stage.id);if(mode==='legacy-checkpoint-period'){for(const field of ['sourceTrace','contentFingerprint','mode','accountSetId','source'])delete result[field];db.prepare('UPDATE import_batches SET result_json=? WHERE batch_id=?').run(JSON.stringify(result),k);}}
  const input=db.prepare('SELECT * FROM local_batch_inputs WHERE batch_id=?').get(k),stage=db.prepare("SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.account_set_id=? AND s.stage_key LIKE 'import:%'").get(target.id),evidence=stage&&JSON.parse(stage.evidence_json),record=db.prepare('SELECT * FROM import_batches WHERE batch_id=?').get(k);
  const expectedSources=input?I.expectedImportSources(JSON.parse(Buffer.from(input.content).toString('utf8')),target.id,record).sources:undefined,checkpointTrace=evidence?.sourceTrace.map(t=>({...t,period:evidence.vouchers.find(v=>v.sourceVoucherId===t.sourceVoucherId)?.period}));
  const bad=I.verifyImportBatchSources(k,{...scope,expectedSources,checkpointTrace});assert.deepEqual(bad,{ok:false,reason:'import_source_trace_changed'},mode+' direct verifier');assert.deepEqual(B.verifyReportSourceEvidence({item,period}),bad,mode+' report verifier');
  const oldFinance=finance(target),otherFinance=moved&&finance(moved),oldInputs=input&&{...input},oldStage=stage&&{...stage},oldFiles=outputFiles(),oldArtifacts=db.prepare('SELECT * FROM local_batch_artifacts ORDER BY id').all();
  // Preserve the strict startup schema: inject saved-byte corruption only at
  // the real publish window, after the new report job has passed admission.
  if(inputOriginal)db.prepare('UPDATE local_batch_inputs SET content=?,source_hash=? WHERE input_key=?').run(inputOriginal.content,inputOriginal.source_hash,inputOriginal.input_key);
  const job=k+'-report',report=await run(job,target,{system:'reader',enterpriseKey:k},[{period,reports:[{kind:'income-statement',formats:['csv']}]}],changeInput?{beforeArtifactPublish:changeInput}:{});
  assert.equal(report.status,'needs_review',mode+' actual report-only runner');const reportStages=db.prepare("SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id JOIN local_batch_jobs j ON j.id=i.job_id WHERE j.job_key=? AND s.stage_key LIKE 'report:%'").all(job);assert.equal(reportStages.length,1);assert.equal(reportStages[0].status,'needs_review');assert.equal(reportStages[0].error_code,'report_evidence_changed');
  assert.deepEqual(db.prepare('SELECT * FROM local_batch_artifacts ORDER BY id').all(),oldArtifacts,'no new artifact or repaired historical artifact');assert.deepEqual(outputFiles(),oldFiles,'no externally published file, previous bytes retained');assert.equal(finance(target),oldFinance,'no source/finance repair or replay');if(moved)assert.equal(finance(moved),otherFinance,'no repair of moved actual voucher');if(input)assert.deepEqual({...db.prepare('SELECT * FROM local_batch_inputs WHERE input_key=?').get(input.input_key)},oldInputs);if(stage)assert.deepEqual({...S.getStage(db,stage.id)},oldStage,'successful original checkpoint is untouched');
  writeFileSync(join(root,k+'-result.json'),JSON.stringify({mode,direct:bad,report,reportStages,originalCheckpoint:oldStage,originalInput:inputOriginal,tamperedInput:inputOriginal&&oldInputs},null,2));
  // Only a fully successful test restores its own saved-input fixture so later
  // independent cases retain the schema contract. Failed scenes remain intact.
  if(inputOriginal){db.prepare('UPDATE local_batch_inputs SET content=?,source_hash=? WHERE input_key=?').run(inputOriginal.content,inputOriginal.source_hash,inputOriginal.input_key);assert.deepEqual({...db.prepare('SELECT * FROM local_batch_inputs WHERE input_key=?').get(inputOriginal.input_key)},{...inputOriginal});}
  console.log('PASS R9 '+mode+' actual scope before filtering / report-only needs_review / no publication or replay');
 }
 for(const saved of [false,true]){
  const k='R9-true-future-'+(saved?'saved':'raw'),target=create(k),src={system:'r9',enterpriseKey:k},data=payload(k,'2026-02');
  if(saved)assert.equal((await run(k,target,src,[{period:'2026-02',imports:[{batchId:k,mode:'append',confirmNewBinding:true,payload:data}]}])).status,'succeeded');else assert.equal(I.importIncremental({dryRun:false,mode:'append',accountSetId:target.id,source:src,batchId:k,confirmNewBinding:true,payload:data}).ok,true);
  db.prepare('UPDATE import_voucher_sources SET voucher_fingerprint=? WHERE batch_id=?').run('f'.repeat(64),k);assert.equal(I.verifyImportBatchSources(k,{accountSetId:target.id,enterpriseKey:k}).ok,false,'real future financial fingerprint is invalid');assert.equal(I.verifyImportBatchSources(k,{accountSetId:target.id,enterpriseKey:k,period}).ok,true,'future financial fingerprint is outside current report scope');
  const unchanged=finance(target),checkpoints=tuples(target);assert.equal(B.verifyReportSourceEvidence({item:{account_set_id:target.id,enterprise_key:k,source_system:'reader'},period}).ok,true);assert.equal((await run(k+'-report',target,{system:'reader',enterpriseKey:k},[{period,reports:[{kind:'income-statement',formats:['csv']}]}])).status,'succeeded');assert.equal(finance(target),unchanged);assert.deepEqual(tuples(target),checkpoints);assert.equal(A.incomeStatement(target.id,period).current['净利润'],0);assert.equal(A.incomeStatement(target.id,'2026-02').current['净利润'],18.51);console.log('PASS R9 true future '+(saved?'saved':'raw')+' bad financial fingerprint isolated / January report succeeds');
 }
 writeFileSync(join(root,'r9-result.json'),JSON.stringify({corruptions:r9Cases,passed:10,trueFutureFingerprintPositives:['raw','saved'],originalR5R6AssertionsRetained:true},null,2));
 writeFileSync(join(root,'r5-result.json'),JSON.stringify({mutations:Object.keys(mutations),positive:{normal:true,replay:true,dedup:true,empty:true,legacyCheckpoint:true,legacyCreateReplay:true,future:true,foreign:true,multipleSystems:true,manual:true,rawDeletedRefused:true,legacyInsufficientRefused:true},amounts:{twoVouchers:18.51,secondSystem:37.02}},null,2));console.log('R5 source-completeness: twelve corruptions, four atomic fault windows, empty/dedup/replay/legacy/scoped/manual positives and raw-deleted/legacy-insufficient review passed');
}
