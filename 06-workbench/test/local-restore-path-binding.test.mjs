import {assert,fs,join,resolve,DatabaseSync,randomUUID,ROOT,S,LB,AS,fresh,job,logical,hash,child,suite,C,RB,explicitRestore,readDb,planFor,cli} from './local-restore-batch.test.mjs';
import {spawn} from 'node:child_process';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const WB=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const makeDir=()=>{const p=join(dirname(ROOT),randomUUID());fs.mkdirSync(p);C.plainRestorePath(p,{directory:true});return p;};
function owned(args,{env={},message}={}){
 const processChild=spawn(process.execPath,args,{cwd:WB,env:{...process.env,...env},stdio:['ignore','pipe','pipe','ipc']});let out='',err='',exit;
 const deadline=setTimeout(()=>{if(processChild.exitCode===null&&processChild.signalCode===null)processChild.kill('SIGTERM');},60000);
 let readyResolve,readyReject;const ready=new Promise((yes,no)=>{readyResolve=yes;readyReject=no;});
 processChild.stdout.on('data',b=>out+=b);processChild.stderr.on('data',b=>err+=b);processChild.on('message',m=>{message?.(m);if(m.type==='ready')readyResolve(m);});
 const done=new Promise((yes,no)=>{processChild.on('error',e=>{readyReject(e);no(e);});processChild.on('exit',(code,signal)=>exit={code,signal});processChild.on('close',(code,signal)=>{clearTimeout(deadline);assert.deepEqual(exit,{code,signal});console.log('owned actual exit+close '+code+'/'+signal);if(!exit||code!==0)readyReject(Error(out+err));yes({code,signal,out,err});});});
 return {processChild,ready,done};
}
const seedCode=String.raw`
import fs from 'node:fs';import {join,basename} from 'node:path';import assert from 'node:assert/strict';
const root=process.env.W4B_ROOT;process.env.WORKBENCH_DATA_DIR=join(root,'data');
const A=await import('./server/accounting.mjs'),{db}=await import('./server/db.mjs'),S=await import('./server/local-batch-storage.mjs'),R=await import('./server/local-batch-runner.mjs');
const oldInputs=join(root,'old-inputs'),oldOutput=join(root,'old-output');fs.mkdirSync(oldInputs);fs.mkdirSync(oldOutput);const sets=[],inputs=[];
try{
for(const [i,standard] of ['小企业会计准则','企业会计准则'].entries()){
 const key='W4B-SYNTH-'+i,capital=i?'4001':'3001',revenue=i?'6001':'5001',expense=i?'6602':'5602';
 const set=A.createAccountSet({name:key,enterprise:{enterpriseKey:key},accounting_standard:standard,start_period:'2026-01'});sets.push({id:set.id,key,standard});
 A.setOpeningBalances(set.id,[{code:'1002',debit:100000},{code:capital,credit:100000}]);
 A.createVoucher(set.id,{period:'2026-02',voucher_date:'2026-02-28',number:999,summary:'Synthetic excluded draft',entries:[{code:expense,debit:999},{code:'1002',credit:999}]});
 for(const period of ['2026-01','2026-02']){
  const entries=period==='2026-01'?[['1002',10000,0],[revenue,0,10000],[expense,2000,0],['1002',0,2000]]:[['1002',3000,0],['1122',2000,0],[revenue,0,5000],[expense,2000,0],['1002',0,2000]];
  const lines=entries.map((e,n)=>[period,period+'-10','记',n<(period==='2026-01'?2:3)?1:2,'Synthetic',...e.map(v=>v===0?'':v)]);
  const csv='期间,日期,凭证字,凭证号,摘要,科目编码,借方,贷方\n'+lines.map(r=>r.join(',')).join('\n');
  const payload=A.parseImportTexts({vouchers:csv},{name:key,accounting_standard:standard,start_period:'2026-01'});payload.account_set={name:key,accounting_standard:standard,start_period:'2026-01'};payload.vouchers.forEach((v,n)=>v.sourceVoucherId=key+'-'+period+'-'+n);
  const file=join(oldInputs,key+'-'+period+'.json'),bytes=JSON.stringify(payload);fs.writeFileSync(file,bytes);inputs.push({key,period,file,bytes});
 }
}
function make(period,key){
 const v=S.validateManifest({schemaVersion:1,jobKey:key,concurrency:2,items:sets.map(s=>({itemKey:s.key,source:{system:'w4b-synthetic',enterpriseKey:s.key},accountSetId:s.id,periods:[{period,imports:[{batchId:s.key+'-'+period,mode:'append',confirmNewBinding:true,payloadFile:basename(inputs.find(i=>i.key===s.key&&i.period===period).file)}],reports:[{kind:'balance-sheet',formats:['csv']},{kind:'income-statement',formats:['csv','xlsx','pdf']},{kind:'cash-flow-statement',formats:['csv']}]}]}))});assert.equal(v.ok,true,JSON.stringify(v));
 const manifest=v.manifest,manifestJson=S.canonicalJson(manifest),plan=S.buildPlan({manifest,manifestDir:oldInputs});return {manifest,manifestJson,manifestHash:S.sha256(manifestJson),...plan,outputDir:join(oldOutput,key)};
}
const jan=await R.createAndRun(make('2026-01','w4b-jan'));assert.equal(jan.status,'succeeded',JSON.stringify(jan));
const feb=S.createJob(db,make('2026-02','w4b-feb'));assert.equal(feb.created,true);
const artifacts=db.prepare('SELECT * FROM local_batch_artifacts ORDER BY id').all().map(a=>({...a,bytesBase64:fs.readFileSync(join(oldOutput,'w4b-jan',a.relative_path)).toString('base64')}));
const amount=period=>sets.map(s=>{const b=A.balanceSheet(s.id,period),i=A.incomeStatement(s.id,period),c=A.cashFlowStatement(s.id,period);return {id:s.id,assets:b.totals.assets,profit:i.current['净利润'],ytd:i.ytd['净利润'],cash:c.totals.net_increase};});
process.send({type:'ready',sets,inputs,oldInputs,oldOutput,artifacts,jan:amount('2026-01'),dbPath:join(root,'data','workbench.db')});
process.on('message',async m=>{if(m==='finish'){try{const r=await R.resumeJob({jobKey:'w4b-feb'});assert.equal(r.status,'succeeded',JSON.stringify(r));process.send({type:'finished',amount:amount('2026-02')});db.close();console.log('source DB actualclose');process.disconnect();}catch(e){console.error(e);db.close();process.exitCode=1;process.disconnect();}}});
}catch(e){console.error(e);db.close();process.exitCode=1;process.disconnect();}
`;
async function spiedCli(command,args,{plan,outDir,jobKey,oldRoots}={}) {
 const argv=['node','scripts/local-batch.mjs',command,'--data-dir',args.targetDir];
 if(command.startsWith('restore-'))argv.push('--backup',args.backupDir,'--ledger',args.ledgerPath,'--operation',args.operationId);
 if(plan){const file=join(dirname(args.targetDir),randomUUID()+'.json');fs.writeFileSync(file,JSON.stringify(plan));argv.push('--plan',file);}
 if(outDir)argv.push('--out-dir',outDir);if(jobKey)argv.push('--job-key',jobKey);
 const code=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {resolve,sep} from 'node:path';const roots=${JSON.stringify(oldRoots??[])}.map(p=>resolve(p).toLowerCase());let reads=0;const forbidden=p=>{if(typeof p!=='string')return false;const v=resolve(p).toLowerCase();return roots.some(r=>v===r||v.startsWith(r+sep));};for(const k of ['readFileSync','statSync','lstatSync','openSync','existsSync','readdirSync','realpathSync']){const old=fs[k],native=old.native;const wrap=function(p,...a){if(forbidden(p)){reads++;throw new Error('OLD_PATH_SPY');}return old.call(this,p,...a);};if(native)wrap.native=function(p,...a){if(forbidden(p)){reads++;throw new Error('OLD_PATH_SPY');}return native.call(this,p,...a);};fs[k]=wrap;}syncBuiltinESMExports();process.argv=${JSON.stringify(argv)};await import('./scripts/local-batch.mjs');console.log('OLD_PATH_READS='+reads);`;
 const r=await child(['--input-type=module','-e',code]);assert.match(r.out,/OLD_PATH_READS=0/);const line=r.out.trim().split(/\r?\n/).find(l=>l.startsWith('{'));return {...r,result:JSON.parse(line)};
}

await suite('two profiles two months real CLI binding, report-only rebuild and explicit resume leave source alive and finance unique',async()=>{
 const root=makeDir(),source=owned(['--input-type=module','-e',seedCode],{env:{W4B_ROOT:root}});let finished;
 source.processChild.on('message',m=>{if(m.type==='finished')finished=m;});
 try{
  const seed=await source.ready;assert.equal(source.processChild.exitCode,null);for(const a of seed.jan){assert.equal(a.assets,108000);assert.equal(a.profit,8000);assert.equal(a.cash,8000);}
  const backupDir=join(root,'official'),targetDir=join(root,'target'),ledgerRoot=makeDir(),args={backupDir,targetDir,ledgerPath:join(ledgerRoot,'restore.db'),operationId:randomUUID()};
  assert.equal(LB.createBackup({dbPath:seed.dbPath,outDir:backupDir}).ok,true);assert.equal(LB.restoreNew(args).ok,true);
  const file=join(targetDir,'workbench.db'),beforeFinance=readDb(file,d=>d.prepare("SELECT id,status,attempt,input_hash,outcome_hash,evidence_json FROM local_batch_stages WHERE stage_key NOT LIKE 'report:%' AND status='succeeded' ORDER BY id").all()),beforeSource=readDb(seed.dbPath,logical),oldRoots=[seed.oldInputs,seed.oldOutput];
  const plan=planFor(file,{reportAction:'preserve'}),jan=plan.jobs.find(j=>j.jobKey==='w4b-jan'),feb=plan.jobs.find(j=>j.jobKey==='w4b-feb');
  for(const j of plan.jobs){fs.mkdirSync(j.outputRoot);for(const i of j.inputs){if(j.jobKey==='w4b-feb'){const saved=readDb(file,d=>d.prepare('SELECT * FROM local_batch_inputs WHERE input_key=?').get(i.inputKey));i.mode='source';i.source=join(root,randomUUID()+'.json');fs.writeFileSync(i.source,Buffer.from(saved.content));}}}
  let selected,missing,corrupt;
  for(const artifact of seed.artifacts){const report=jan.reports.find(r=>r.stageId===readDb(file,d=>d.prepare('SELECT id FROM local_batch_stages WHERE item_id=? AND period=? AND stage_key=?').get(artifact.item_id,artifact.period,artifact.stage_key)).id);
   if(!selected&&artifact.format==='xlsx'){report.action='rebuild';selected={stageId:report.stageId,attempt:artifact.attempt};continue;}
   if(!missing&&artifact.format==='csv'){missing=report.stageId;continue;}
   const dest=resolve(jan.outputRoot,artifact.relative_path);fs.mkdirSync(dirname(dest),{recursive:true});fs.writeFileSync(dest,Buffer.from(artifact.bytesBase64,'base64'));
   if(!corrupt&&artifact.format==='csv'){fs.appendFileSync(dest,'CORRUPT');corrupt=report.stageId;}
  }
  const crossOld=structuredClone(plan);crossOld.jobs[0].inputs[0].mode='source';crossOld.jobs[0].inputs[0].source=seed.inputs[0].file;
  const oldDenied=await spiedCli('restore-check',args,{plan:crossOld,oldRoots});assert.equal(oldDenied.code,2,oldDenied.out+oldDenied.err);assert.equal(oldDenied.result.code,'restore_path_conflict');
  const oldInputRoot=structuredClone(plan);oldInputRoot.jobs[0].outputRoot=seed.oldInputs;
  const oldRootDenied=await spiedCli('restore-check',args,{plan:oldInputRoot,oldRoots});assert.equal(oldRootDenied.code,2,oldRootDenied.out+oldRootDenied.err);assert.equal(oldRootDenied.result.code,'restore_path_conflict');
  const outDir=join(root,'protection'),check=await spiedCli('restore-check',args,{plan,oldRoots});assert.equal(check.code,0,check.out+check.err);
  const activated=await spiedCli('restore-activate',args,{plan,outDir,oldRoots});assert.equal(activated.code,0,activated.out+activated.err);
  readDb(file,d=>{for(const id of [missing,corrupt,selected.stageId])assert.equal(d.prepare('SELECT status FROM local_batch_stages WHERE id=?').get(id).status,'needs_review');});
  const janResume=await spiedCli('resume',args,{jobKey:'w4b-jan',oldRoots});assert.equal(janResume.code,1,janResume.out+janResume.err);
  readDb(file,d=>{const rebuilt=d.prepare('SELECT * FROM local_batch_stages WHERE id=?').get(selected.stageId);assert.equal(rebuilt.status,'succeeded',JSON.stringify(rebuilt));assert.equal(rebuilt.attempt,selected.attempt+1);const artifact=d.prepare('SELECT * FROM local_batch_artifacts WHERE item_id=? AND period=? AND stage_key=?').get(rebuilt.item_id,rebuilt.period,rebuilt.stage_key);assert.equal(hash(resolve(jan.outputRoot,artifact.relative_path)),artifact.bytes_hash);for(const id of [missing,corrupt])assert.equal(d.prepare('SELECT status FROM local_batch_stages WHERE id=?').get(id).status,'needs_review');assert.deepEqual(d.prepare("SELECT id,status,attempt,input_hash,outcome_hash,evidence_json FROM local_batch_stages WHERE stage_key NOT LIKE 'report:%' AND status='succeeded' ORDER BY id").all(),beforeFinance);});
  const febResume=await spiedCli('resume',args,{jobKey:'w4b-feb',oldRoots});assert.equal(febResume.code,0,febResume.out+febResume.err);
  const amount=await child(['--input-type=module','-e',`import assert from 'node:assert/strict';const A=await import('./server/accounting.mjs'),{db}=await import('./server/db.mjs');try{for(const s of ${JSON.stringify(seed.sets)}){const bs=A.balanceSheet(s.id,'2026-02'),i=A.incomeStatement(s.id,'2026-02'),c=A.cashFlowStatement(s.id,'2026-02');assert.equal(bs.totals.assets,111000);assert.equal(i.current['净利润'],3000);assert.equal(i.ytd['净利润'],11000);assert.equal(c.totals.net_increase,1000);const balances=db.prepare("SELECT e.code,SUM(e.debit-e.credit) amount FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? AND v.status='posted' AND v.period<=? GROUP BY e.code").all(s.id,'2026-02');assert.equal(100000+balances.find(r=>r.code==='1002').amount,109000);assert.equal(balances.find(r=>r.code==='1122').amount,2000);assert.equal(db.prepare("SELECT COUNT(*) n FROM vouchers WHERE account_set_id=? AND number=999 AND status='draft'").get(s.id).n,1);}console.log('INDEPENDENT_AMOUNTS_OK');}finally{db.close();console.log('target amount DB actualclose');}`],{env:{WORKBENCH_DATA_DIR:targetDir}});assert.equal(amount.code,0,amount.out+amount.err);
  assert.equal(LB.reconcileRestore(args).ok,true,'ready after legal financial writes');assert.equal(readDb(seed.dbPath,logical),beforeSource);assert.equal(source.processChild.exitCode,null);
  // 后续普通作业不得改变先前激活的重放集合。
  const newer=await child(['--input-type=module','-e',`const {db}=await import('./server/db.mjs'),S=await import('./server/local-batch-storage.mjs');try{const v=S.validateManifest({schemaVersion:1,jobKey:'later-normal',items:[{itemKey:'a',source:{system:'w4b-synthetic',enterpriseKey:${JSON.stringify(seed.sets[0].key)}},accountSetId:${seed.sets[0].id},periods:[{period:'2026-03',reports:[{kind:'balance-sheet',formats:['csv']}]}]}]});const manifest=v.manifest,manifestJson=S.canonicalJson(manifest),p=S.buildPlan({manifest,manifestDir:${JSON.stringify(root)}});S.createJob(db,{manifest,manifestJson,manifestHash:S.sha256(manifestJson),...p,outputDir:${JSON.stringify(join(root,'later-output'))}});}finally{db.close();}`],{env:{WORKBENCH_DATA_DIR:targetDir}});assert.equal(newer.code,0,newer.out+newer.err);
  const replay=await spiedCli('restore-activate',args,{plan,outDir,oldRoots});assert.equal(replay.code,0,replay.out+replay.err);assert.equal(replay.result.replayed,true);
  const nextBackup=join(root,'next-backup'),nextTarget=join(root,'next-target'),nextArgs={backupDir:nextBackup,targetDir:nextTarget,ledgerPath:args.ledgerPath,operationId:randomUUID()};assert.equal(LB.createBackup({dbPath:file,outDir:nextBackup}).ok,true);const next=LB.restoreNew(nextArgs);assert.equal(next.ok,true,JSON.stringify(next));assert.notEqual(next.receipt.targetInstanceId,plan.targetInstanceId);readDb(join(nextTarget,'workbench.db'),d=>assert.equal(C.assertRestoreControl(d).row.write_state,'pending'));
 }finally{if(source.processChild.connected)source.processChild.send('finish');const done=await source.done;assert.equal(done.code,0,done.out+done.err);assert.ok(finished);for(const a of finished.amount){assert.equal(a.assets,111000);assert.equal(a.profit,3000);assert.equal(a.ytd,11000);assert.equal(a.cash,1000);}}
});

await suite('new source mapping, hardlink/junction, unknown output/sidecar and duplicate keys fail closed',async()=>{
 const h=await fresh({audit:2,batch:3});try{
  job(h,{file:true});const r=explicitRestore(h),before=hash(r.file),plan=planFor(r.file),entry=plan.jobs[0].inputs[0],newFile=join(h.dir,randomUUID()+'.json');const saved=readDb(r.file,d=>Buffer.from(d.prepare('SELECT content FROM local_batch_inputs WHERE input_key=?').get(entry.inputKey).content));fs.writeFileSync(newFile,saved);entry.mode='source';entry.source=newFile;
  const link=join(h.dir,randomUUID()+'.json');fs.linkSync(newFile,link);assert.equal((await RB.activateRestoreBatch({...r.args,plan,outDir:join(h.dir,randomUUID())})).ok,false);fs.unlinkSync(link);
  const junction=join(h.dir,randomUUID());fs.symlinkSync(dirname(newFile),junction,'junction');const linked=structuredClone(plan);linked.jobs[0].inputs[0].source=join(junction,newFile.split(/[\\/]/).at(-1));assert.equal((await RB.activateRestoreBatch({...r.args,plan:linked,outDir:join(h.dir,randomUUID())})).ok,false);fs.unlinkSync(junction);
  const oldPath=readDb(r.file,d=>d.prepare('SELECT source_path FROM local_batch_inputs WHERE input_key=?').get(entry.inputKey).source_path),wrong=structuredClone(plan);wrong.jobs[0].inputs[0].source=oldPath;assert.equal((await RB.activateRestoreBatch({...r.args,plan:wrong,outDir:join(h.dir,randomUUID())})).code,'restore_path_conflict');
  const duplicate=join(h.dir,randomUUID()+'.json');fs.writeFileSync(duplicate,'{"version":1,"version":1}');assert.throws(()=>RB.readRestorePlanFile(duplicate),/restore_plan_invalid/);
  const unknownRoot=plan.jobs[0].outputRoot;fs.mkdirSync(unknownRoot);const unrelated=join(unknownRoot,'operator-owned.txt');fs.writeFileSync(unrelated,'PRESERVE');const outputDenied=await RB.activateRestoreBatch({...r.args,plan,outDir:join(h.dir,randomUUID())});assert.equal(outputDenied.code,'restore_output_unknown_file');assert.equal(fs.readFileSync(unrelated,'utf8'),'PRESERVE');fs.unlinkSync(unrelated);
  const unknown=join(r.args.targetDir,C.RESTORE_ACTIVATION_FILE);fs.writeFileSync(unknown,'{"unknown":"operator-file"}\n');const unknownHash=hash(unknown),failed=await RB.activateRestoreBatch({...r.args,plan,outDir:join(h.dir,randomUUID())});assert.equal(failed.ok,false);assert.equal(hash(unknown),unknownHash);assert.equal(hash(r.file),before);
 }finally{h.close();}
});
await suite('same-byte source replacement at the real protection boundary rolls back and owned orphan retry succeeds',async()=>{
 const h=await fresh({audit:2,batch:3});try{
  job(h,{file:true});const r=explicitRestore(h),before=hash(r.file),plan=planFor(r.file),entry=plan.jobs[0].inputs[0],file=join(h.dir,randomUUID()+'.json'),bytes=readDb(r.file,d=>Buffer.from(d.prepare('SELECT content FROM local_batch_inputs WHERE input_key=?').get(entry.inputKey).content));
  fs.writeFileSync(file,bytes);entry.mode='source';entry.source=file;const outDir=join(h.dir,randomUUID()),sync=fs.fsyncSync;let changed=false;
  fs.fsyncSync=(...args)=>{const result=sync(...args);if(!changed){changed=true;fs.renameSync(file,file+'.retired');fs.writeFileSync(file,bytes);}return result;};let result;
  try{result=await RB.activateRestoreBatch({...r.args,plan,outDir});}finally{fs.fsyncSync=sync;}
  assert.equal(changed,true);assert.equal(result.ok,false);assert.equal(hash(r.file),before);assert.equal(LB.verifyBackup({backupDir:outDir}).ok,true);readDb(r.file,d=>assert.equal(C.assertRestoreControl(d).row.write_state,'pending'));
  const retried=await cli('restore-activate',r.args,{plan,outDir});assert.equal(retried.code,0,retried.out+retried.err);assert.equal(LB.reconcileRestore(r.args).ok,true);
  // 已释放绑定记住的是实际输入身份，不仅是其字节。
  fs.renameSync(file,file+'.bound-retired');fs.writeFileSync(file,bytes);readDb(r.file,d=>{assert.equal(S.verifyInputEvidence(d,{jobId:1}).ok,false);const input=d.prepare('SELECT * FROM local_batch_inputs LIMIT 1').get();assert.equal(S.checkInputEvidence(input,{db:d,allowSnapshotOnly:true}).ok,false);});
  assert.equal((await RB.activateRestoreBatch({...r.args,plan,outDir})).ok,false,'ready replay also pins the original bound input inode');
 }finally{h.close();}
});
await suite('copied running finance stays unknown through retry, source rights remain intact and damaged saved bytes never activate',async()=>{
 const h=await fresh({audit:2,batch:3});try{
  const j=job(h,{file:true}),stage=h.db.prepare('SELECT * FROM local_batch_stages LIMIT 1').get(),owner='live-synthetic-'+randomUUID(),lock=S.acquireLock(h.db,{resourceKey:'job:'+j.job.id,instance:owner,pid:process.pid});
  assert.equal(S.claimStage(h.db,{stageId:stage.id,instance:owner,token:lock.token,inputHash:stage.input_hash}).claimed,true);const original=logical(h.db),r=explicitRestore(h),plan=planFor(r.file),outDir=join(h.dir,randomUUID());
  assert.equal((await cli('restore-activate',r.args,{plan,outDir})).code,0);readDb(r.file,d=>{const before=d.prepare('SELECT * FROM local_batch_stages WHERE id=?').get(stage.id);assert.equal(before.status,'needs_review');assert.equal(before.error_code,'restore_financial_unknown');const retry=S.resetStagesForRetry(d,{jobKey:j.job.job_key,allowSnapshotOnly:true});assert.equal(retry.reopened.length,0);assert.equal(d.prepare('SELECT attempt FROM local_batch_stages WHERE id=?').get(stage.id).attempt,before.attempt);assert.equal(d.prepare('SELECT COUNT(*) n FROM local_batch_locks').get().n,0);},{write:true});assert.equal(logical(h.db),original);
  const damaged=explicitRestore(h),badPlan=planFor(damaged.file);readDb(damaged.file,d=>d.prepare('UPDATE local_batch_inputs SET content=?').run(Buffer.from('{"damaged":true}')),{write:true});assert.equal((await RB.activateRestoreBatch({...damaged.args,plan:badPlan,outDir:join(h.dir,randomUUID())})).ok,false);readDb(damaged.file,d=>assert.equal(C.assertRestoreControl(d).row.write_state,'pending'));assert.equal(logical(h.db),original);
 }finally{h.close();}
});
await suite('actual completed depreciation carryforward period-check close survive activation and report-only attempt unchanged',async()=>{
 const root=makeDir(),code=String.raw`
 import fs from 'node:fs';import {join} from 'node:path';import assert from 'node:assert/strict';
 const root=process.env.W4B_FULL_ROOT;process.env.WORKBENCH_DATA_DIR=join(root,'data');
 const A=await import('./server/accounting.mjs'),{db}=await import('./server/db.mjs'),S=await import('./server/local-batch-storage.mjs'),R=await import('./server/local-batch-runner.mjs');
 try{
  const key='W4B-FULL-FINANCE',set=A.createAccountSet({name:key,enterprise:{enterpriseKey:key},accounting_standard:'小企业会计准则',start_period:'2026-01'});
  A.setOpeningBalances(set.id,[{code:'1002',debit:100000},{code:'1601',debit:1200},{code:'3001',credit:101200}]);
  A.addAssetCard(set.id,{kind:'fixed',name:'Synthetic equipment',original_cost:1200,residual_rate:0,useful_life_months:12,start_period:'2025-12',acquired_period:'2025-12',ledger_status:'booked',asset_account:'1601',accum_account:'1602',expense_account:'5602'});
  const csv='期间,日期,凭证字,凭证号,摘要,科目编码,借方,贷方\n2026-01,2026-01-10,记,1,Synthetic,1002,10000,\n2026-01,2026-01-10,记,1,Synthetic,5001,,10000\n2026-01,2026-01-20,记,2,Synthetic,5602,1900,\n2026-01,2026-01-20,记,2,Synthetic,1002,,1900';
  const payload=A.parseImportTexts({vouchers:csv},{name:key,accounting_standard:'小企业会计准则',start_period:'2026-01'});payload.account_set={name:key,accounting_standard:'小企业会计准则',start_period:'2026-01'};payload.vouchers.forEach((v,i)=>v.sourceVoucherId=key+'-'+i);
  const v=S.validateManifest({schemaVersion:1,jobKey:'full-finance',items:[{itemKey:key,source:{system:'w4b-full',enterpriseKey:key},accountSetId:set.id,periods:[{period:'2026-01',imports:[{batchId:key,mode:'append',confirmNewBinding:true,payload}],post:{vouchers:payload.vouchers.map(v=>({sourceVoucherId:v.sourceVoucherId}))},depreciation:true,carryforward:{yearEnd:false},periodCheck:true,close:true,reports:[{kind:'balance-sheet',formats:['csv']}]}]}]});assert.equal(v.ok,true,JSON.stringify(v));
  const manifest=v.manifest,manifestJson=S.canonicalJson(manifest),result=await R.createAndRun({manifest,manifestJson,manifestHash:S.sha256(manifestJson),...S.buildPlan({manifest,manifestDir:root}),outputDir:join(root,'old-output')});assert.equal(result.status,'succeeded',JSON.stringify(result));
  assert.equal(A.periodStatus(set.id,'2026-01'),'closed');assert.equal(A.balanceSheet(set.id,'2026-01').totals.assets,109200);assert.equal(A.incomeStatement(set.id,'2026-01').current['净利润'],8000);assert.equal(A.cashFlowStatement(set.id,'2026-01').totals.net_increase,8100);
  const runs=db.prepare('SELECT * FROM asset_depreciation_runs').all();assert.equal(runs.length,1);assert.equal(runs[0].amount,100);console.log('FULL_FINANCIAL_SOURCE_OK');
 }finally{db.close();console.log('full source DB actualclose');}
 `;
 const created=await child(['--input-type=module','-e',code],{env:{W4B_FULL_ROOT:root}});assert.equal(created.code,0,created.out+created.err);
 const h={dir:root,file:join(root,'data','workbench.db')},r=explicitRestore(h),plan=planFor(r.file,{reportAction:'rebuild'}),outDir=join(root,'protection');
 const financial=d=>JSON.stringify({tables:['opening_balances','vouchers','voucher_entries','asset_cards','asset_depreciation_runs','periods','import_batches','import_voucher_sources','import_batch_vouchers'].map(t=>({table:t,rows:d.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()})),stages:d.prepare("SELECT * FROM local_batch_stages WHERE stage_key NOT LIKE 'report:%' ORDER BY id").all()});
 const before=readDb(r.file,financial),oldReport=readDb(r.file,d=>d.prepare("SELECT * FROM local_batch_stages WHERE stage_key LIKE 'report:%'").get());
 readDb(r.file,d=>{const stages=d.prepare("SELECT stage_key,status,attempt FROM local_batch_stages WHERE stage_key NOT LIKE 'report:%'").all();assert.equal(stages.length,6);for(const s of stages){assert.equal(s.status,'succeeded');assert.equal(s.attempt,1);}});
 const a=await cli('restore-activate',r.args,{plan,outDir});assert.equal(a.code,0,a.out+a.err);assert.equal(readDb(r.file,financial),before);
 const pendingStatus=await child(['scripts/local-batch.mjs','status','--data-dir',r.args.targetDir,'--job-key','full-finance']);assert.equal(pendingStatus.code,1,pendingStatus.out+pendingStatus.err);
 const resumed=await child(['scripts/local-batch.mjs','resume','--data-dir',r.args.targetDir,'--job-key','full-finance']);assert.equal(resumed.code,0,resumed.out+resumed.err);assert.equal(readDb(r.file,financial),before);
 readDb(r.file,d=>{const report=d.prepare('SELECT * FROM local_batch_stages WHERE id=?').get(oldReport.id);assert.equal(report.status,'succeeded');assert.equal(report.attempt,oldReport.attempt+1);assert.equal(d.prepare('SELECT COUNT(*) n FROM asset_depreciation_runs').get().n,1);assert.equal(d.prepare('SELECT status FROM periods WHERE period=?').get('2026-01').status,'closed');const artifact=d.prepare('SELECT * FROM local_batch_artifacts').get();assert.equal(hash(resolve(plan.jobs[0].outputRoot,artifact.relative_path)),artifact.bytes_hash);});
 assert.equal(LB.reconcileRestore(r.args).ok,true);
});
console.log('local-restore-path-binding PASS retained '+ROOT);
