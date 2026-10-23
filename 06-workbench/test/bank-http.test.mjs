import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
export const BANK_MARK='SYNTHETIC-BANK-PRIVATE-04B';
export const noBankLeak=value=>assert.equal(JSON.stringify(value).includes(BANK_MARK),false);
export async function bankHttpHarness(){
 const work=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const verify=path=>{for(let x=path;;x=dirname(x)){assert.equal(fs.lstatSync(x).isSymbolicLink(),false);assert.equal(fs.realpathSync.native(x).toLowerCase(),resolve(x).toLowerCase());if(dirname(x)===x)break;}};
 verify(work);const baseRoot=process.env.LOCAL04B_FIXTURE_PARENT||join(work,'..','.agent-runs');fs.mkdirSync(baseRoot,{recursive:true});verify(baseRoot);
 const root=join(baseRoot,'bank-entry-'+randomUUID());fs.mkdirSync(root);verify(root);const data=join(root,'data');fs.mkdirSync(data);verify(data);
 process.env.TEMP=root;process.env.TMP=root;process.env.WORKBENCH_DATA_DIR=data;process.env.KEEP_FIXTURES='1';process.env.WORKBENCH_TEST_KEEP_FIXTURES='1';
 const child=spawn(process.execPath,[join(work,'server/server.mjs')],{cwd:work,windowsHide:true,env:{...process.env,PORT:'0',HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
 const childEvidence={pid:child.pid,command:[process.execPath,join(work,'server/server.mjs')],startedAt:new Date().toISOString(),actualClose:false};fs.writeFileSync(join(root,'backend-child.json'),JSON.stringify(childEvidence,null,2));
 let logs='',closed=false;const done=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;Object.assign(childEvidence,{code,signal,actualClose:true,closedAt:new Date().toISOString()});fs.writeFileSync(join(root,'backend-child.json'),JSON.stringify(childEvidence,null,2));resolve({code,signal});}));child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 const deadline=Date.now()+20000;while(!/http:\/\/127\.0\.0\.1:\d+/.test(logs)){if(closed||Date.now()>deadline){if(!closed)child.kill();await done;throw new Error('bank backend start failed '+logs);}await new Promise(r=>setTimeout(r,30));}
 const base=logs.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
 const q=async(path,body,method='POST')=>{const res=await fetch(base+path,{method,headers:{'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});return {status:res.status,data:await res.json()};};
 const dbPath=join(data,'workbench.db'),db=new DatabaseSync(dbPath);db.exec('PRAGMA busy_timeout=5000');
 const prepare=async(set,tool,payload={},write=false)=>{const r=await q('/api/account-sets/'+set+'/bank-drafts',{tool,payload,...(write?{confirm:true}:{})});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.draftRef;};
 const approve=async(set,previewRef)=>{const r=await q('/api/account-sets/'+set+'/bank-drafts/approve-import',{previewRef});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.draftRef;};
 const close=async()=>{try{if(!closed)child.kill();const result=await done;assert.equal(closed,true);noBankLeak(logs);console.log('bank backend actualclose '+JSON.stringify(result));}finally{db.close();console.log('bank SQLite actualclose; fixtures '+root);}};
 return {root,data,dbPath,db,base,q,prepare,approve,close,getLogs:()=>logs};
}
export async function bankFixture(h,label,profileId='small-2011-basic-v1',cent=0){
 const enterprise=profileId==='enterprise-2019-general-basic-v1',capital=enterprise?'4001':'3001';
 const setResponse=await h.q('/api/account-sets',{name:BANK_MARK,start_period:'2026-01',profileId,enterprise:{enterpriseKey:'SYNTH-'+label,enterpriseName:BANK_MARK}});assert.equal(setResponse.status,201,JSON.stringify(setResponse.data));const set=setResponse.data.id;
 assert.equal((await h.q('/api/account-sets/'+set+'/opening-balances',{items:[{code:'1002',debit:1000+cent/100},{code:capital,credit:1000+cent/100}]},'PUT')).status,200);
 const vouchers=[];for(const [date,amount,inflow]of [['2026-01-05',200,true],['2026-01-06',70,false],['2026-01-07',30,true],['2026-01-08',30,false]]){
 const r=await h.q('/api/account-sets/'+set+'/vouchers',{period:'2026-01',voucher_date:date,status:'posted',summary:BANK_MARK,entries:inflow?[{code:'1002',debit:amount,summary:BANK_MARK},{code:'1122',credit:amount}]:[{code:'1122',debit:amount},{code:'1002',credit:amount,summary:BANK_MARK}]});assert.equal(r.status,201,JSON.stringify(r.data));vouchers.push(r.data);
 }
 const bankAccountId='bank-'+label,sourceId='source-'+label;const s={bankAccountId};
 const mapping={columns:{date:'日期',summary:'摘要',debit:'收入',credit:'支出',refId:'流水号'},amountMode:'debit_credit',currency:'CNY'};
 const csvText='日期,摘要,收入,支出,流水号\n2026-01-05,'+BANK_MARK+',200,,R1\n2026-01-06,'+BANK_MARK+',,70,R2\n2026-01-09,'+BANK_MARK+',5,,R3\n2026-01-10,'+BANK_MARK+',,5,R4';
 return {set,s,bankAccountId,sourceId,mapping,csvText,vouchers,cent,period:'2026-01'};
}
export async function exerciseBank(h,f,invoke){
 const {set,s,sourceId,mapping,csvText}=f;const used=new Set();
 const run=async(tool,payload={},write=false)=>{const ref=await h.prepare(set,tool,payload,write),out=await invoke(tool,{accountSetId:set,draftRef:ref});used.add(tool);await h.q('/api/account-sets/'+set+'/bank-drafts/revoke',{draftRef:ref});return out;};
 await run('bank_accounts');const registered=await run('bank_account_register',{...s,sourceId,glAccountCode:'1002',currency:'CNY',displayName:BANK_MARK,bankAccountNo:BANK_MARK},true);
 const payload={...s,sourceId,batchId:'first-'+set,period:'2026-01',csvText,mapping};
 const preview=await h.prepare(set,'bank_import_preview',payload),pv=await invoke('bank_import_preview',{accountSetId:set,draftRef:preview});used.add('bank_import_preview');
 const impRef=await h.approve(set,preview),imp=await invoke('bank_import',{accountSetId:set,draftRef:impRef});used.add('bank_import');
 assert.equal(h.db.prepare('SELECT COUNT(*) n FROM bank_transactions WHERE account_set_id=?').get(set).n,4);
 const replay=await invoke('bank_import',{accountSetId:set,draftRef:impRef});assert.equal(h.db.prepare('SELECT COUNT(*) n FROM bank_transactions WHERE account_set_id=?').get(set).n,4);
 const rawImport=async(p)=>{const pre=await h.prepare(set,'bank_import_preview',p);await invoke('bank_import_preview',{accountSetId:set,draftRef:pre});const ref=await h.approve(set,pre);const result=await invoke('bank_import',{accountSetId:set,draftRef:ref});await h.q('/api/account-sets/'+set+'/bank-drafts/revoke',{draftRef:pre});await h.q('/api/account-sets/'+set+'/bank-drafts/revoke',{draftRef:ref});return result;};
 await h.q('/api/account-sets/'+set+'/bank-drafts/revoke',{draftRef:preview});await h.q('/api/account-sets/'+set+'/bank-drafts/revoke',{draftRef:impRef});
 const sameBatch=await rawImport(payload),newBatch=await rawImport({...payload,batchId:'new-file-'+set});
 assert.equal(h.db.prepare('SELECT COUNT(*) n FROM bank_batches WHERE account_set_id=?').get(set).n,2);
 assert.equal(h.db.prepare('SELECT COUNT(*) n FROM bank_transactions WHERE account_set_id=?').get(set).n,4);
 const txs=h.db.prepare('SELECT id,amount_cents FROM bank_transactions WHERE account_set_id=? ORDER BY id').all(set);
 await run('bank_batches',s);await run('bank_transactions',s);await run('bank_ambiguities',s);
 await run('bank_candidates',{...s,transactionId:txs[0].id,period:'2026-01'});
 const entry=h.db.prepare("SELECT e.id,e.voucher_id FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? AND e.code='1002' AND e.debit=200").get(set);
 const confirmed=await run('bank_confirm',{...s,transactionId:txs[0].id,voucherId:entry.voucher_id,entryId:entry.id,reason:BANK_MARK},true);
 const match=h.db.prepare("SELECT id FROM bank_matches WHERE account_set_id=? AND status='confirmed'").get(set).id;
 await run('bank_matches',s);await run('bank_cancel',{...s,matchId:match,reason:BANK_MARK},true);
 await run('bank_confirm',{...s,transactionId:txs[0].id,voucherId:entry.voucher_id,entryId:entry.id,reason:BANK_MARK},true);
 const noRefMapping={...mapping,columns:{date:'日期',summary:'摘要',debit:'收入',credit:'支出'}};
 const ambiguousCsv='日期,摘要,收入,支出\n2026-01-11,'+BANK_MARK+',0.01,';
 await rawImport({...payload,batchId:'amb1-'+set,csvText:ambiguousCsv,mapping:noRefMapping});
 await rawImport({...payload,batchId:'amb2-'+set,csvText:ambiguousCsv+'\n2026-01-12,another,0.02,',mapping:noRefMapping});
 const ambiguity=h.db.prepare("SELECT id FROM bank_ambiguities WHERE account_set_id=? AND status='pending'").get(set);assert.ok(ambiguity);
 await run('bank_ambiguity_resolve',{...s,ambiguityId:ambiguity.id,decision:'distinct',reason:BANK_MARK},true);
 await run('bank_status',s);await run('bank_audit',s);
 const reconcile=await run('bank_reconcile',{...s,period:'2026-01',asOf:'2026-01-10',coverageFrom:'2026-01-01',coverageTo:'2026-01-31',statementSource:BANK_MARK,statementOpenCents:100000+f.cent,statementCloseCents:113000+f.cent,currency:'CNY'},true);
 const persisted=h.db.prepare('SELECT book_close_cents,statement_close_cents,difference_cents FROM bank_reconcile_runs WHERE account_set_id=? ORDER BY id DESC').get(set);
 assert.equal(persisted.book_close_cents,113000+f.cent);assert.equal(persisted.statement_close_cents,113000+f.cent);assert.equal(persisted.difference_cents,0);
 assert.equal(used.size,15);
 const oneCent=await run('bank_reconcile',{...s,period:'2026-01',asOf:'2026-01-10',coverageFrom:'2026-01-01',coverageTo:'2026-01-31',statementSource:BANK_MARK,statementOpenCents:100000+f.cent,statementCloseCents:113001+f.cent,currency:'CNY'},true);
 // Overlapping stable IDs reuse four originals and add exactly three cents.
 const overlap=await rawImport({...payload,batchId:'overlap-'+set,csvText:csvText+'\n2026-01-15,'+BANK_MARK+',0.03,,R5'});
 const overlapBatch=h.db.prepare("SELECT imported_rows,reused_rows FROM bank_batches WHERE account_set_id=? AND batch_id=?").get(set,'overlap-'+set);assert.equal(overlapBatch.imported_rows,1);assert.equal(overlapBatch.reused_rows,4);
 // No stable ID: the operator explicitly selects an existing candidate (same).
 await rawImport({...payload,batchId:'amb3-'+set,csvText:ambiguousCsv+'\n2026-01-12,another,0.02,\n2026-01-13,third,0.03,',mapping:noRefMapping});
 for(const a of h.db.prepare("SELECT id,candidate_transaction_ids FROM bank_ambiguities WHERE account_set_id=? AND status='pending'").all(set)){const selected=JSON.parse(a.candidate_transaction_ids)[0];await run('bank_ambiguity_resolve',{...s,ambiguityId:a.id,decision:'same',transactionId:selected,reason:BANK_MARK},true);}
 assert.equal(h.db.prepare("SELECT COUNT(*) n FROM bank_ambiguities WHERE account_set_id=? AND status='pending'").get(set).n,0);
 // Two equal posted January entries are both candidates for a February bank row.
 const crossVouchers=[];for(let j=0;j<2;j++){const v=await h.q('/api/account-sets/'+set+'/vouchers',{period:'2026-01',voucher_date:'2026-01-31',status:'posted',entries:[{code:'1002',debit:0.07},{code:'1122',credit:0.07}]});assert.equal(v.status,201);crossVouchers.push(v.data.id);}
 await rawImport({...payload,batchId:'cross-'+set,period:'2026-02',csvText:'日期,摘要,收入,支出,流水号\n2026-02-01,'+BANK_MARK+',0.07,,CROSS'});
 const crossTxn=h.db.prepare("SELECT id FROM bank_transactions WHERE account_set_id=? AND bank_ref_id='CROSS'").get(set).id;
 const candidates=await run('bank_candidates',{...s,transactionId:crossTxn,period:'2026-01',dateToleranceDays:1});
 const entryId=h.db.prepare("SELECT id FROM voucher_entries WHERE voucher_id=? AND code='1002'").get(crossVouchers[0]).id;
 const crossConfirmed=await run('bank_confirm',{...s,transactionId:crossTxn,voucherId:crossVouchers[0],entryId,reason:BANK_MARK,dateToleranceDays:1},true);
 assert.equal(h.db.prepare("SELECT status FROM bank_matches WHERE account_set_id=? AND transaction_id=?").get(set,crossTxn).status,'confirmed');
 return {registered,pv,imp,replay,sameBatch,newBatch,confirmed,reconcile,oneCent,used,candidates,crossConfirmed};
}
if(resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)){
 const h=await bankHttpHarness();try{
  for(const [i,profile]of ['small-2011-basic-v1','enterprise-2019-general-basic-v1'].entries()){
   const f=await bankFixture(h,'http-'+i,profile,i),mode=i?'raw':'rest';
   if(i===0){assert.equal(h.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='bank_accounts'").get().n,0);assert.notEqual((await h.q('/api/account-sets/'+f.set+'/bank-drafts',{tool:'bank_accounts',payload:{path:'arbitrary'}})).status,200);assert.equal(h.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='bank_accounts'").get().n,0);}
   const invoke=async(tool,args)=>{const action=tool.slice(5).replaceAll('_','-'),r=await h.q(mode==='raw'?'/agent/tools/'+tool:'/api/account-sets/'+f.set+'/bank/'+action,mode==='raw'?args:{draftRef:args.draftRef});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
   const out=await exerciseBank(h,f,invoke);assert.equal(out.imp.evidence.performed,true);assert.equal(out.replay.evidence.performed,false);assert.equal(out.sameBatch.evidence.performed,false);assert.equal(out.newBatch.evidence.performed,true);
   assert.equal(out.reconcile.result.book.closingCents,113000+i);assert.equal(out.reconcile.result.adjusted.differenceCents,0);
   const raw=out.reconcile.result;assert.equal(raw.status,'reconciled');assert.equal(raw.adjusted.bookCents,106000+i);assert.equal(raw.adjusted.bankCents,106000+i);
   for(const [key,total,count]of [['bookReceivedBankMissing',3000,1],['bookPaidBankMissing',10000,2],['bankReceivedBookMissing',500,1],['bankPaidBookMissing',7500,2]]){assert.equal(raw.outstanding.totals[key+'Cents'],total);assert.equal(raw.outstanding[key].length,count);}
   assert.equal(out.oneCent.result.adjusted.differenceCents,-1);assert.equal(out.oneCent.result.statement.differenceCents,1);assert.equal(out.oneCent.result.status,'pending_review');
   assert.equal(out.candidates.result.candidates.length,2);assert.equal(out.candidates.result.selection,'requires_manual_choice');
   const unknown=await h.prepare(f.set,'bank_confirm',{...f.s,transactionId:999999,voucherId:999999,entryId:999999,reason:BANK_MARK},true);assert.equal((await h.q('/agent/tools/bank_confirm',{accountSetId:f.set,draftRef:unknown})).data.error,'bank_local_operation_failed');assert.equal((await h.q('/agent/tools/bank_confirm',{accountSetId:f.set,draftRef:unknown})).data.error,'bank_draft_outcome_unknown');
   const entry=h.db.prepare("SELECT voucher_id FROM bank_matches WHERE account_set_id=? AND status='confirmed' ORDER BY id").get(f.set);await h.q('/api/account-sets/'+f.set+'/vouchers/'+entry.voucher_id+'/unpost',{});
   const draft=await h.prepare(f.set,'bank_matches',f.s),invalid=await invoke('bank_matches',{accountSetId:f.set,draftRef:draft});assert.equal(invalid.result.invalidations.length,1);
   const read=await h.prepare(f.set,'bank_accounts',{});for(const body of [{draftRef:read,approved:true},{draftRef:read,payload:{}},{draftRef:'finref_'+'a'.repeat(48)}])assert.notEqual((await h.q('/api/account-sets/'+f.set+'/bank/accounts',body)).status,200);
  }
  noBankLeak(h.getLogs());console.log('bank-http PASS: real REST15/rawAgent15, dual profiles independent1130.00/1130.01, same-batch/cache/same-file tracking, ambiguity distinct, confirm/cancel, invalidation and zero difference');
 }finally{await h.close();}
}
