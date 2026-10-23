import {assert,suite,DatabaseSync,fs,join} from './auxiliary-storage.test.mjs';
await suite('auxiliary-core-integration',async h=>{
 const {db,dbPath,A,X,S,makeSet,entity,allocate,voucher}=h;
 const a=makeSet('core'),p=entity(a,'party','P'),v=voucher(a,'2025-12',[{code:'1002',debit:20},{code:'1122',credit:20}]); const e=X.listAuxiliaryEntries(db,{accountSetId:a,voucherId:v.id}).find(r=>r.code==='1122').entryId;
 const input={accountSetId:a,entryId:e,allocations:[{partyId:p,credit:10}],requestId:'stable',reason:'explicit binding'};
 assert.equal(X.replaceAuxiliaryAllocations(db,input).status,'applied'); const snapshot=JSON.stringify(db.prepare('SELECT * FROM aux_operations').all());assert.equal(X.replaceAuxiliaryAllocations(db,input).status,'replayed');assert.equal(JSON.stringify(db.prepare('SELECT * FROM aux_operations').all()),snapshot);
 assert.throws(()=>X.replaceAuxiliaryAllocations(db,{...input,allocations:[{partyId:p,credit:11}]}),/request_conflict/);
 A.postVoucher(a,v.id);assert.equal(X.replaceAuxiliaryAllocations(db,input).status,'replayed');assert.equal(X.entryPartyAllocation(db,{accountSetId:a,entryId:e}).status,'ambiguous');
 const before=JSON.stringify(db.prepare('SELECT * FROM aux_allocations').all()),receipts=db.prepare('SELECT COUNT(*) n FROM aux_receipts').get().n;
 assert.throws(()=>S.auxTransaction(db,()=>{allocate(a,{entryId:e},[{partyId:p,credit:20}],'rollback-1');X.createAuxiliaryEntity(db,{accountSetId:a,kind:'party',code:'ROLLBACK',name:'rollback',requestId:'rollback-entity'});allocate(a,{entryId:e},[{partyId:999999,credit:20}],'rollback-2');}),/dimension_invalid/);
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM aux_allocations').all()),before);assert.equal(db.prepare('SELECT COUNT(*) n FROM aux_receipts').get().n,receipts);assert.equal(db.prepare("SELECT COUNT(*) n FROM aux_entities WHERE code='ROLLBACK'").get().n,0);
 const other=new DatabaseSync(dbPath);try {other.exec('BEGIN IMMEDIATE');assert.throws(()=>allocate(a,{entryId:e},[{partyId:p,credit:20}]),/locked/);}finally {other.exec('ROLLBACK');other.close();}
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM aux_allocations').all()),before);
 X.setAuxiliaryRequirement(db,{accountSetId:a,code:'1122',party:true,reason:'complete parties'});assert.equal(A.periodEndCheck(a,'2025-12').blocking.some(b=>b.code==='auxiliary_incomplete'),true);
 allocate(a,{entryId:e},[{partyId:p,credit:20}]);assert.equal(A.periodEndCheck(a,'2025-12').blocking.some(b=>b.code==='auxiliary_incomplete'),false);
 A.setPeriodStatus(a,'2025-12','closed');assert.throws(()=>allocate(a,{entryId:e},[]),/aux_period_closed/);A.setPeriodStatus(a,'2025-12','open');
 A.ensurePeriod(a,'2026-01');db.prepare("UPDATE periods SET status='closed' WHERE account_set_id=? AND period='2026-01'").run(a);assert.throws(()=>allocate(a,{entryId:e},[]),/later_period_closed/);db.prepare("UPDATE periods SET status='open' WHERE account_set_id=? AND period='2026-01'").run(a);
 A.unpostVoucher(a,v.id);allocate(a,{entryId:e},[]);A.deleteVoucher(a,v.id);assert.equal(db.prepare('SELECT COUNT(*) n FROM aux_allocations WHERE entry_id=?').get(e).n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM aux_operations WHERE action='allocation_replace'").get().n>=3,true);
 assert.throws(()=>db.prepare("INSERT OR REPLACE INTO aux_receipts SELECT * FROM aux_receipts LIMIT 1").run(),/history_immutable/);
 const IM=await import('../server/import-incremental.mjs');const imported=IM.importIncremental({dryRun:false,mode:'create',batchId:'aux-import-1',source:{system:'synthetic',enterpriseKey:'SYNTH-IMPORT'},payload:{account_set:{name:'Synthetic Import',start_period:'2025-12'},vouchers:[{sourceVoucherId:'SRC-1',period:'2025-12',date:'2025-12-01',number:1,entries:[{code:'1122',debit:100},{code:'5001',credit:100}]}]}});
 assert.equal(imported.ok,true,JSON.stringify(imported));const setId=db.prepare("SELECT account_set_id FROM import_enterprise_account_sets WHERE enterprise_key='SYNTH-IMPORT'").get().account_set_id;
 const entry=X.listAuxiliaryEntries(db,{accountSetId:setId}).find(r=>r.code==='1122');assert.equal(entry.sourceVoucherId,'SRC-1');const party=entity(setId,'party','IMPORT');allocate(setId,{entryId:entry.entryId},[{partyId:party,debit:100}],'after-import');
 const sourceBefore=JSON.stringify(db.prepare('SELECT * FROM import_voucher_sources').all());const batchBefore=JSON.stringify(db.prepare('SELECT * FROM import_batches').all());
 const replay=IM.importIncremental({dryRun:false,mode:'create',batchId:'aux-import-1',source:{system:'synthetic',enterpriseKey:'SYNTH-IMPORT'},payload:{account_set:{name:'Synthetic Import',start_period:'2025-12'},vouchers:[{sourceVoucherId:'SRC-1',period:'2025-12',date:'2025-12-01',number:1,entries:[{code:'1122',debit:100},{code:'5001',credit:100}]}]}});
 assert.equal(replay.ok,true);assert.equal(JSON.stringify(db.prepare('SELECT * FROM import_voucher_sources').all()),sourceBefore);assert.equal(JSON.stringify(db.prepare('SELECT * FROM import_batches').all()),batchBefore);assert.equal(X.auxiliaryLedger(db,{accountSetId:setId,period:'2025-12',code:'1122'}).totals.closing,100);
 // Real derived-voucher recalculation must preserve all original rows on auxiliary rejection.
 const derived=makeSet('derived'),dp=entity(derived,'party','P'),sale=voucher(derived,'2025-12',[{code:'1122',debit:31},{code:'5001',credit:31}]);A.postVoucher(derived,sale.id);
 const carry=A.carryForwardProfit(derived,'2025-12').voucher;
 const ce=X.listAuxiliaryEntries(db,{accountSetId:derived,voucherId:carry.id}).find(r=>r.code==='5001');allocate(derived,{entryId:ce.entryId},[{partyId:dp,debit:31}]);A.unpostVoucher(derived,carry.id);
 const derivedBefore=JSON.stringify({v:A.listVouchers(derived),a:db.prepare('SELECT * FROM aux_allocations WHERE account_set_id=?').all(derived),o:db.prepare('SELECT * FROM aux_operations WHERE account_set_id=?').all(derived)});
 assert.throws(()=>A.carryForwardProfit(derived,'2025-12'),/aux_entry_reallocation_required/);
 assert.equal(JSON.stringify({v:A.listVouchers(derived),a:db.prepare('SELECT * FROM aux_allocations WHERE account_set_id=?').all(derived),o:db.prepare('SELECT * FROM aux_operations WHERE account_set_id=?').all(derived)}),derivedBefore);
 const opening=makeSet('opening-atomic'),op=entity(opening,'party','P');A.setOpeningBalances(opening,[{code:'1002',debit:900},{code:'1122',debit:100},{code:'3001',credit:1000}]);allocate(opening,{openingCode:'1122'},[{partyId:op,debit:100}]);const openingBefore=A.getOpeningBalances(opening);
 assert.throws(()=>A.setOpeningBalances(opening,[{code:'1002',debit:800},{code:'1122',debit:200}]),/aux_opening_reallocation_required/);assert.deepEqual(A.getOpeningBalances(opening),openingBefore);
 A.setPeriodStatus(opening,'2025-12','closed');assert.throws(()=>X.updateAuxiliaryEntity(db,{accountSetId:opening,entityId:op,name:'closed rename',reason:'test'}),/aux_period_closed/);A.setPeriodStatus(opening,'2025-12','open');
 // These faults use real SQLite connections; only the named exec boundary is injected.
 const snap=await h.LB.createBackup({dbPath:h.dbPath,outDir:join(h.root,'transaction-fault-seed')});assert.equal(snap.ok,true);
 const connection=label=>{const path=join(h.root,label+'.db');fs.copyFileSync(join(snap.backupDir,h.LB.SNAPSHOT_FILE),path);const c=new DatabaseSync(path);c.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE');return {c,path};};
 {
  const {c,path}=connection('commit-busy'),reader=new DatabaseSync(path);try{reader.exec('BEGIN');reader.prepare('SELECT * FROM aux_entities').all();assert.throws(()=>S.auxTransaction(c,()=>c.prepare('UPDATE aux_entities SET name=? WHERE id=?').run('busy',p)),/locked/);assert.equal(c.isTransaction,false);reader.exec('ROLLBACK');assert.equal(S.auxTransaction(c,()=>({ok:true})).durability,'committed');}finally{reader.close();c.close();}
 }
 {
  const {c}=connection('nested-staged');try{c.exec('BEGIN');const result=X.createAuxiliaryEntity(c,{accountSetId:a,kind:'party',code:'STAGED',name:'staged',requestId:'staged'});assert.equal(result.durability,'pending_outer_commit');c.exec('ROLLBACK');assert.equal(c.prepare("SELECT COUNT(*) n FROM aux_entities WHERE code='STAGED'").get().n,0);}finally{c.close();}
 }
 for(const mode of ['commit-after','rollback-before','release-after']) {
  const {c}=connection(mode),exec=c.exec.bind(c);let injected=false;
  if(mode==='release-after')exec('BEGIN');
  c.exec=function(sql){if(!injected&&((mode==='commit-after'&&sql==='COMMIT')||(mode==='rollback-before'&&sql==='ROLLBACK')||(mode==='release-after'&&sql.startsWith('RELEASE aux_')))){injected=true;if(mode!=='rollback-before')exec(sql);throw new Error('synthetic boundary fault');}return exec(sql);};
  try {assert.throws(()=>S.auxTransaction(c,()=>{c.prepare('UPDATE aux_entities SET name=? WHERE id=?').run(mode,p);if(mode==='rollback-before')throw new Error('body fault');return {status:'applied'};}),/aux_commit_unknown/);assert.equal(injected,true);assert.throws(()=>X.listAuxiliaryEntities(c,{accountSetId:a}),/aux_connection_quarantined/);assert.throws(()=>S.auxTransaction(c,()=>({status:'applied'})),/aux_connection_quarantined/);await assert.rejects(S.ensureAuxiliarySchema(c,{dbPath:h.dbPath,outDir:join(h.root,'must-not-install')}),/aux_connection_quarantined/);}finally{if(c.isTransaction)exec('ROLLBACK');c.close();}
 }
 console.log('derived recompute and multi-account opening rollback; actual COMMIT_BUSY; commit/rollback/release unknown quarantine; caller savepoint durability verified');
 console.log('real core lifecycle, configured close checks, two-connection lock, nested rollback, immutable receipts and unchanged import replay verified');
});
