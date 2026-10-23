import assert from 'node:assert/strict';
import { harness } from './auxiliary-storage.test.mjs';
import { input, MARK, noLeak, names } from './auxiliary-http.test.mjs';
process.env.WORKBENCH_TEST_KEEP_FIXTURES='1';process.env.KEEP_FIXTURES='1';
const h=await harness();
const E=await import('../server/finance-model-entry.mjs');
const {createFinanceModelAdapter}=await import('../server/finance-model-adapter.mjs');
const {summarizeWriteResult,summarizeQueryResult}=await import('../server/finance-output-policy.mjs');
const {callAgentTool}=await import('../server/agent-tools.mjs');
const allRows=()=>JSON.stringify(h.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all().concat(h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>({name,rows:h.db.prepare('SELECT * FROM \"'+name+'\" ORDER BY rowid').all()}))));
const logs=[], originals={};for(const k of ['log','warn','error']){originals[k]=console[k];console[k]=(...a)=>{logs.push(a.join(' '));originals[k](...a);};}
let checks=0;const ok=async(name,args,applied)=>{const r=await E.callModelTool(name,args);noLeak(r);assert.equal(r.ok,true,JSON.stringify(r));if(applied!==undefined)assert.equal(r.applied,applied);checks++;return r;};
const mustReject=async(name,args)=>{const r=await E.callModelTool(name,args);assert.equal(r.ok,false);noLeak(r);checks++;return r;};
try {
 // Real GL totals can exceed the model bound while the local ledger remains legal and exact.
 for(const negative of [false,true]) {
  const set=h.makeSet('model-ledger-limit-'+(negative?'negative':'positive'));
  h.A.setOpeningBalances(set,[{code:'1122',...(negative?{credit:700000000000.07}:{debit:700000000000.07})},{code:'3001',...(negative?{debit:700000000000.07}:{credit:700000000000.07})}]);
  const first=h.voucher(set,'2025-12',negative?[{code:'5001',debit:400000000000.11},{code:'1122',credit:400000000000.11}]:[{code:'1122',debit:400000000000.11},{code:'5001',credit:400000000000.11}]);h.A.postVoucher(set,first.id);
  const second=h.voucher(set,'2025-12',negative?[{code:'1122',debit:0.03},{code:'1002',credit:0.03}]:[{code:'1002',debit:0.03},{code:'1122',credit:0.03}]);h.A.postVoucher(set,second.id);
  const raw=h.X.auxiliaryLedger(h.db,{accountSetId:set,period:'2025-12',code:'1122'});
  assert.equal(raw.totals.closing,negative?-1100000000000.15:1100000000000.15);
  const summary=summarizeQueryResult('auxiliary_ledger',raw);assert.equal(summary.summaryUnavailable,true);assert.deepEqual(summary.projection,{});
  const rejected=await mustReject('auxiliary_ledger',{accountSetId:set,period:'2025-12',code:'1122'});assert.equal(rejected.localRef,undefined);
 }
 const ledgerTotalKeys=['opening','debit','credit','closing','debitBalance','creditBalance'];
 const ledgerDTO=totals=>({accountSetId:1,period:'2026-01',groupBy:[],groups:[],totals});
 const ledgerZeros=Object.fromEntries(ledgerTotalKeys.map(k=>[k,0]));
 for(const key of ledgerTotalKeys) {
  for(const bound of [1000000000000,-1000000000000]) {
   const totals={...ledgerZeros,[key]:bound},value=ledgerDTO(totals),summary=summarizeQueryResult('auxiliary_ledger',value);
   assert.equal(summary.summaryUnavailable,false);assert.equal(summary.projectionDropped,0);for(const name of ledgerTotalKeys)assert.equal(summary.projection[name],totals[name]);
   const adapter=createFinanceModelAdapter({executeRaw:()=>value}),result=await adapter.callModelTool('auxiliary_ledger',{accountSetId:1});assert.equal(result.ok,true);assert.ok(result.localRef);for(const name of ledgerTotalKeys)assert.equal(result.projection[name],totals[name]);noLeak(result);checks++;
  }
  for(const excessive of [1000000000000.01,-1000000000000.01,Infinity,NaN,90071992547409.91]) {
   const value=ledgerDTO({...ledgerZeros,[key]:excessive}),summary=summarizeQueryResult('auxiliary_ledger',value);assert.equal(summary.summaryUnavailable,true);assert.deepEqual(summary.projection,{});
   const adapter=createFinanceModelAdapter({executeRaw:()=>value}),result=await adapter.callModelTool('auxiliary_ledger',{accountSetId:1});assert.equal(result.ok,false);assert.equal(result.localRef,undefined);noLeak(result);checks++;
  }
 }
 // Independent decimal expectation: 900000000000.01 + 999 * 0.01 = 900000000010.00.
 const precisionRows=Array.from({length:1000},(_,i)=>({entryId:i+1,voucherId:1,lineNo:i+1,period:'2026-01',status:'posted',code:'1002',debit:i===0?900000000000.01:0.01,credit:0}));
 precisionRows.push({entryId:1001,voucherId:1,lineNo:1001,period:'2026-01',status:'posted',code:'3001',debit:0,credit:900000000010});
 const precisionDTO={accountSetId:1,items:precisionRows};
 const precision=summarizeQueryResult('auxiliary_entries',precisionDTO);
 assert.equal(precision.summaryUnavailable,false);assert.deepEqual(precision.projection,{entryCount:1001,debit:900000000010,credit:900000000010});assert.equal(precision.projectionDropped,0);
 const preciseAdapter=createFinanceModelAdapter({executeRaw:()=>precisionDTO});
 const preciseEnvelope=await preciseAdapter.callModelTool('auxiliary_entries',{accountSetId:1});assert.equal(preciseEnvelope.ok,true);assert.equal(preciseEnvelope.projection.debit,900000000010);assert.equal(preciseEnvelope.projection.credit,900000000010);noLeak(preciseEnvelope);checks++;
 // Legal per-row values must fail closed when their total exceeds the model numeric bound or safe cents range.
 for(const amounts of [[600000000000,600000000000],Array(100).fill(999999999999.99)]) {
  const excessive={accountSetId:1,items:amounts.map((debit,i)=>({...precisionRows[0],entryId:i+1,lineNo:i+1,debit}))};
  const summary=summarizeQueryResult('auxiliary_entries',excessive);assert.equal(summary.summaryUnavailable,true);assert.deepEqual(summary.projection,{});
  const adapter=createFinanceModelAdapter({executeRaw:()=>excessive});const rejected=await adapter.callModelTool('auxiliary_entries',{accountSetId:1});assert.equal(rejected.ok,false);assert.equal(rejected.localRef,undefined);noLeak(rejected);checks++;
 }
 const requests=[input('modelA'),input('modelB',2,'enterprise-2019-general-basic-v1')],sets=[];
 for(const [i,req] of requests.entries()) {
  const imp=await ok('book_import_incremental',req,true);sets.push(imp.accountSetId);const set=imp.accountSetId;
  assert.equal(imp.projection.auxiliary.status,'applied');
  const rawImport=E.readLocalReference({ref:imp.localRef,accountSetId:set,operation:imp.operation}).value;
  assert.equal(rawImport.auxiliary.proof,undefined);assert.equal(rawImport.auxiliary.entities,undefined);
  await ok('book_import_incremental',req,false);
  await ok('book_import_incremental',{...req,dryRun:true},false);
  const entity=await ok('auxiliary_entity_create',{accountSetId:set,kind:'project',code:MARK+'model',name:MARK,requestId:MARK+'model'},true);
  const pid=entity.projection.entityId;
  await ok('auxiliary_entity_create',{accountSetId:set,kind:'project',code:MARK+'model',name:MARK,requestId:MARK+'model'},false);
  await ok('auxiliary_entity_update',{accountSetId:set,entityId:pid,name:MARK+'renamed',reason:MARK},true);
  const entities=await ok('auxiliary_entities',{accountSetId:set});assert.equal(entities.projection.partyCount,1);
  const entries=await ok('auxiliary_entries',{accountSetId:set});const detail=E.readLocalReference({ref:entries.localRef,accountSetId:set,operation:entries.operation});assert.ok(JSON.stringify(detail.value).includes(MARK));
  assert.equal(E.computeLocalReference({ref:entries.localRef,accountSetId:set,operation:entries.operation,op:'sum',path:'items.[].debit'}).value,800*(i+1));
  const eid=detail.value.items.find(e=>e.code==='1122'&&e.debit>0).entryId;
  await ok('auxiliary_allocate',{accountSetId:set,entryId:eid,allocations:[{projectId:pid,debit:600*(i+1)}],requestId:MARK+'alloc',reason:MARK},true);
  await ok('auxiliary_requirement_set',{accountSetId:set,code:'1122',party:false,reason:MARK},true);
  const party=await ok('auxiliary_party',{accountSetId:set,entryId:eid});assert.equal(party.projection.status,'unknown');
  const ledger=await ok('auxiliary_ledger',{accountSetId:set,period:'2025-12',code:'1122'});assert.equal(ledger.projection.closing,1400*(i+1));
  const context={ref:ledger.localRef,accountSetId:set,operation:ledger.operation};
  assert.equal(E.computeLocalReference({...context,op:'sum',path:'groups.[].closing'}).value,1400*(i+1));
  for(const patch of [{accountSetId:set+100},{operation:'auxiliary_entries'},{channel:'local'},{channel:{}},{local:true}])assert.throws(()=>E.readLocalReference({...context,...patch}));
  E.revokeLocalReference(context);assert.throws(()=>E.readLocalReference(context));
  const before=h.db.prepare('SELECT COUNT(*) n FROM aux_entities').get().n;
  h.db.exec('BEGIN');try {const unchanged=allRows(),staged=await mustReject('auxiliary_entity_create',{accountSetId:set,kind:'party',code:'PENDING',name:MARK,requestId:MARK+'pending'});assert.equal(staged.error.code,'audit_transaction_conflict');assert.equal(staged.applied,false);assert.equal(staged.localRef,null);assert.equal(staged.rawValuesIncluded,false);assert.equal(h.db.isTransaction,true);assert.equal(allRows(),unchanged);}finally{h.db.exec('ROLLBACK');}
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM aux_entities').get().n,before);
  const completed={...req,auxiliaryAppendix:{version:1,requestId:MARK+'empty-new',reason:MARK,entities:[],entries:[],openings:[]}};
  const added=await ok('book_import_incremental',completed,true);assert.equal(added.projection.status,'idempotent_replay');assert.equal(added.projection.auxiliary.entityCount,0);
  await ok('book_import_incremental',completed,false);
  h.db.exec('BEGIN');try {const unchanged=allRows(),pending=await mustReject('book_import_incremental',completed);assert.equal(pending.error.code,'audit_transaction_conflict');assert.equal(pending.applied,false);assert.equal(pending.localRef,null);assert.equal(pending.rawValuesIncluded,false);assert.equal(h.db.isTransaction,true);assert.equal(allRows(),unchanged);}finally{h.db.exec('ROLLBACK');}
  const bad={...req,auxiliaryAppendix:{...req.auxiliaryAppendix,reason:MARK+'changed'}};await mustReject('book_import_incremental',bad);
 }
 for(const args of [{accountSetId:true},{accountSetId:sets[0],dbPath:MARK},{accountSetId:sets[0],account_set_id:sets[1]},{accountSetId:sets[0],account_set_id:null},new Proxy({accountSetId:sets[0]},{}),{accountSetId:sets[0],dbPath:undefined},Object.defineProperty({accountSetId:sets[0]},'kind',{enumerable:true,get(){throw Error(MARK);}})])await mustReject('auxiliary_entities',args);
 await assert.rejects(callAgentTool('auxiliary_entities',{accountSetId:sets[0],account_set_id:sets[1]}),/account_set_id_conflict/);
 const malformed=[{}, {accountSetId:sets[0],items:[{}]}, {accountSetId:sets[0],items:[{id:1,account_set_id:sets[1],kind:'party',code:MARK,name:MARK,active:1}]}, {accountSetId:'bad',items:[]}];
 for(const value of malformed){const a=createFinanceModelAdapter({executeRaw:()=>value});const r=await a.callModelTool('auxiliary_entities',{accountSetId:sets[0]});assert.equal(r.ok,false);noLeak(r);checks++;}
 for(const [name,value] of [['auxiliary_entries',{accountSetId:sets[0],items:[{}]}],['auxiliary_ledger',{accountSetId:sets[0],period:'2025-12',groupBy:[],groups:[],totals:{closing:1}}],['auxiliary_party',{accountSetId:sets[0],entryId:1,status:MARK}]]) {const a=createFinanceModelAdapter({executeRaw:()=>value});assert.equal((await a.callModelTool(name,{accountSetId:sets[0]})).ok,false);}
 const base={dryRun:false,ok:true,status:'idempotent_replay',accountSetId:sets[0],replayed:true,durability:'committed',created:{accountSetId:sets[0]},auxiliary:{version:1,status:'applied',entityCount:0,mappingCount:0,allocationTargetCount:0,durability:'committed'}};
 assert.equal(summarizeWriteResult('book_import_incremental',base).applied,true);
 for(const changed of [{durability:'unknown'},{status:'staged'},{status:MARK},{ok:false}, {auxiliary:{...base.auxiliary,status:'staged',durability:'pending_outer_commit'},durability:'pending_outer_commit'}, {auxiliary:{...base.auxiliary,status:'replayed',durability:'pending_outer_commit'},durability:'pending_outer_commit'}, {auxiliary:{...base.auxiliary,entityCount:-1}}, {created:{accountSetId:sets[1]}}]) {const r=summarizeWriteResult('book_import_incremental',{...base,...changed});assert.equal(r.applied,'unknown');noLeak(r);}
 assert.equal(summarizeWriteResult('book_import_incremental',{...base,dryRun:true,durability:undefined,auxiliary:{version:1,status:'replayed',entityCount:1,mappingCount:1,allocationTargetCount:1}}).applied,false);
 const unknownStatus=createFinanceModelAdapter({executeRaw:()=>({...base,status:MARK})});const rejectedStatus=await unknownStatus.callModelTool('book_import_incremental',{});assert.equal(rejectedStatus.applied,'unknown');assert.equal(rejectedStatus.localRef,null);noLeak(rejectedStatus);
 for(const name of ['auxiliary_entity_update','auxiliary_requirement_set']) {const a=createFinanceModelAdapter({executeRaw:()=>({accountSetId:sets[0],result:{id:1,account_set_id:sets[0],kind:'party',code:MARK,name:MARK,active:1,status:'replayed',project:false,department:false,party:false,durability:'committed'}})});const r=await a.callModelTool(name,{accountSetId:sets[0]});assert.equal(r.applied,'unknown');assert.equal(r.localRef,null);}
 const fake=createFinanceModelAdapter({executeRaw:()=>({...base,batch:{accountSetId:sets[1]}})});const mismatch=await fake.callModelTool('book_import_incremental',{});assert.equal(mismatch.ok,false);assert.equal(mismatch.localRef,null);
 const malformedWrite=createFinanceModelAdapter({executeRaw:()=>({accountSetId:sets[0],result:{id:1,kind:MARK,durability:'committed'}})});const invalid=await malformedWrite.callModelTool('auxiliary_entity_create',{accountSetId:sets[0]});assert.equal(invalid.applied,'unknown');assert.equal(invalid.localRef,null);noLeak(invalid);
 let now=1000;const timed=E.createFinanceModelEntry({policyOptions:{ttlMs:1,now:()=>now}});const ref=await timed.callModelTool('auxiliary_entities',{accountSetId:sets[0]});now+=2;assert.throws(()=>timed.readLocalReference({ref:ref.localRef,accountSetId:sets[0],operation:ref.operation}));
 for(const name of names){const rejected=E.createFinanceModelEntry({executeRaw:()=>{throw Object.assign(Error(MARK),{code:'aux_commit_unknown',details:MARK});}});const r=await rejected.callModelTool(name,{accountSetId:sets[0]});assert.equal(r.ok,false);noLeak(r);}
 noLeak(logs);console.log('auxiliary-model-boundary PASS checks='+checks+'; real refs, dual-layer evidence, scope, invalid DTO, expiry/revoke');
} finally {h.db.close();for(const k of Object.keys(originals))console[k]=originals[k];console.log('auxiliary-model-boundary database closed; fixtures retained');}
