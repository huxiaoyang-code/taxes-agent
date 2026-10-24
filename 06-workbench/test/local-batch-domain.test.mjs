import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync,lstatSync,realpathSync,writeFileSync,readFileSync } from 'node:fs';
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
let db;
try {
 const A=await import('../server/accounting.mjs');({db}=await import('../server/db.mjs'));
 const R=await import('../server/local-batch-runner.mjs'),S=await import('../server/local-batch-storage.mjs');
 if(process.env.W3B_CASE!=='boundaries'){
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
  const code=`import {DatabaseSync} from 'node:sqlite';import {createBackup,verifyBackup,restoreNew} from './server/local-backup.mjs';import {writeFileSync,lstatSync,realpathSync} from 'node:fs';import {dirname,resolve,join} from 'node:path';
  const root=process.env.TEMP;for(let p=resolve(root);;p=dirname(p)){if(lstatSync(p).isSymbolicLink()||realpathSync.native(p).toLowerCase()!==p.toLowerCase())throw Error('alias');if(dirname(p)===p)break;}
  const file=join(process.env.WORKBENCH_DATA_DIR,'workbench.db');let db;try{db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA busy_timeout=10000');const count=()=>db.prepare("SELECT COUNT(*) n FROM local_batch_stages WHERE status='succeeded'").get().n;const until=Date.now()+180000;while(count()<5){if(Date.now()>until)throw Error('wait stages timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
  const before=count(),started=Date.now();const backup=createBackup({dbPath:file,outDir:join(root,'live-backup')});const finished=Date.now(),after=count();let verify,restored;if(backup.ok){verify=verifyBackup({backupDir:backup.backupDir});restored=restoreNew({backupDir:backup.backupDir,targetDir:join(root,'restore')});}const result={before,after,started,finished,backup,verify,restored};writeFileSync(join(root,'live-backup-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}finally{db?.close();console.log('DB_CLOSED');}`;
  monitor=owned(['--input-type=module','-e',code]);
 }
 const result=await R.createAndRun({manifest,manifestJson,manifestHash:S.sha256(manifestJson),...plan,outputDir:join(root,'out'),hooks:{onStageError:({stage,error})=>console.log('STAGE_ERROR '+JSON.stringify({id:stage.id,key:stage.stage_key,code:error.code,message:error.message}))}});
 if(monitor){const observed=await monitor.done;writeFileSync(join(root,'backup-child.log'),observed.stdout+'\n'+observed.stderr);assert.equal(observed.code,0,observed.stdout+observed.stderr);const live=JSON.parse(readFileSync(join(root,'live-backup-result.json'),'utf8'));assert.equal(live.backup.ok,true,JSON.stringify(live));assert.equal(live.verify.ok,true);assert.equal(live.restored.ok,true);assert.ok(live.after>live.before,'legal stages committed while official backup was running');
  const {DatabaseSync}=await import('node:sqlite');const restored=new DatabaseSync(join(root,'restore','workbench.db'),{readOnly:true});try{S.assertBatchSchema(restored);assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(restored.prepare('SELECT COUNT(*) n FROM account_sets').get().n,20);assert.ok(restored.prepare("SELECT COUNT(*) n FROM local_batch_stages WHERE status='succeeded'").get().n>=live.before);writeFileSync(join(root,'restored-readonly-facts.json'),JSON.stringify({stages:restored.prepare('SELECT status,COUNT(*) n FROM local_batch_stages GROUP BY status').all(),sources:restored.prepare('SELECT COUNT(*) n FROM import_voucher_sources').get().n,epochs:restored.prepare('SELECT * FROM local_batch_lock_epochs ORDER BY resource_key').all()}));}finally{restored.close();console.log('RESTORED_DB_CLOSED_READONLY');}}
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
 await boundaries(A,S,R,db);
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
