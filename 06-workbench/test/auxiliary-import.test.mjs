import { assert, fs, join, DatabaseSync, harness } from './auxiliary-storage.test.mjs';
import { fileURLToPath } from 'node:url';
process.env.WORKBENCH_TEST_KEEP_FIXTURES = '1';
const h = await harness({ install: false });
const { db, dbPath, root, A, X, S, LB } = h;
console.log('FIXTURES '+root);
const IM = await import('../server/import-incremental.mjs');
const C = await import('../server/local-audit-coordinator.mjs');
async function runChild(args,{env={},timeout=60000,cwd}={}){
 const {spawn}=await import('node:child_process');
 return await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',exit,spawnError,timedOut=false;
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',e=>spawnError=e);child.on('exit',(code,signal)=>exit={code,signal});
  const timer=setTimeout(()=>{timedOut=true;child.kill();},timeout);
  child.on('close',(code,signal)=>{clearTimeout(timer);if(spawnError)return reject(spawnError);try{assert.deepEqual(exit,{code,signal});assert.equal(timedOut,false,'owned child timeout');console.log('AUX_CHILD_EXIT_CLOSE '+JSON.stringify({pid:child.pid,code,signal}));resolve({code,signal,stdout,stderr,timedOut,closed:true});}catch(e){reject(e);}});
 });
}
function importResources(input,before){
 const setId=input.mode==='append'?input.accountSetId:before.import_enterprise_account_sets.find(r=>r.enterprise_key===input.source.enterpriseKey)?.account_set_id;
 return [`book:${input.source.enterpriseKey}`,...(setId?[`account-set:${setId}`]:[])];
}
function assertEpochs(after,before,resources){
 const prior=new Map((before.local_batch_lock_epochs??[]).map(r=>[r.resource_key,r.last_token])),current=new Map((after.local_batch_lock_epochs??[]).map(r=>[r.resource_key,r.last_token])),expected=new Map();
 for(const key of resources)expected.set(key,(expected.get(key)??0)+1);
 assert.deepEqual([...current.keys()].sort(),[...new Set([...prior.keys(),...expected.keys()])].sort(),'only acquired resources may add epoch history');
 for(const [key,token] of current){assert.ok(Number.isSafeInteger(token)&&token>0);assert.equal(token,(prior.get(key)??0)+(expected.get(key)??0),'exact epoch acquisition count '+key);}
 assert.deepEqual(after.local_batch_locks,before.local_batch_locks);assert.equal(after.local_batch_locks.length,0,'all active locks released');
}
function assertOnlyEpochs(after,before,resources){assert.deepEqual({...after,local_batch_lock_epochs:before.local_batch_lock_epochs},before,'all business, audit, sequence, component and instance rows remain exact');assertEpochs(after,before,resources);}

function assertAuditAppend(after,before,actions,message,state='failure',resources=[]) {
 const row=v=>typeof v==='string'?JSON.parse(v):v;
 const business=value=>Object.fromEntries(Object.entries(value).filter(([name])=>!['audit_events','audit_operations','local_batch_lock_epochs'].includes(name)).map(([name,rows])=>[name,name==='sqlite_sequence'?rows.filter(v=>row(v).name!=='audit_events'):rows]));
 assert.deepEqual(business(after),business(before),message);assertEpochs(after,before,resources);
 for(const table of ['audit_events','audit_operations'])for(const original of before[table]??[])assert.ok((after[table]??[]).some(v=>JSON.stringify(v)===JSON.stringify(original)),table+' history must remain exact');
 const added=table=>(after[table]??[]).filter(v=>!(before[table]??[]).some(old=>JSON.stringify(old)===JSON.stringify(v))).map(row);
 const events=added('audit_events').sort((a,b)=>a.seq-b.seq),ops=added('audit_operations');
 assert.deepEqual(events.map(e=>e.action),actions);assert.equal(ops.length,actions.length);
 for(const event of events){
  const operation=ops.find(o=>o.operation_id===event.operation_id&&o.attempt===event.attempt&&o.database_instance_id===event.database_instance_id);assert.ok(operation);
  if(state==='failure')assert.ok(['failed','rejected'].includes(operation.state));else assert.equal(operation.state,state);
  assert.equal(event.outcome,operation.state);assert.equal(event.action,operation.action);assert.ok(operation.receipt_json);
  const receipt=JSON.parse(operation.receipt_json);
  assert.deepEqual(Object.keys(receipt).sort(),['receiptVersion','databaseInstanceId','operationId','attempt','state','resultCode','reasonCode','eventId','eventSeq','targets','resultRefs','resultDigest'].sort());
  assert.equal(receipt.receiptVersion,2);assert.equal(receipt.operationId,operation.operation_id);assert.equal(receipt.databaseInstanceId,operation.database_instance_id);assert.equal(receipt.attempt,operation.attempt);assert.equal(receipt.state,operation.state);assert.equal(receipt.eventId,event.event_id);assert.equal(receipt.eventSeq,event.seq);assert.equal(receipt.resultCode,event.result_code);assert.equal(receipt.reasonCode,event.reason_code);assert.match(receipt.resultDigest,/^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.targets,{accountSetId:event.account_set_id,voucherId:event.voucher_id,period:event.period,jobId:event.job_id,itemId:event.item_id,stageId:event.stage_id,correlation:event.correlation});
 }
 const seq=value=>(value.sqlite_sequence??[]).map(row).find(r=>r.name==='audit_events')?.seq??0;
 assert.equal(seq(after)-seq(before),actions.length);
}

const auditSnapshot=()=>Object.fromEntries(JSON.parse(snapshot()));
function observedReplay(fn,input,action='import.create'){const before=auditSnapshot(),out=fn();assertAuditAppend(auditSnapshot(),before,[action],'business replay only appends one no_change receipt','no_change',importResources(input,before));return out;}
let count = 0;
function check(name, fn) { fn(); count++; console.log('ok ' + count + ' ' + name); }
function snapshot({ audit = true } = {}) {
  return JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .filter(r => audit || !['import_batches'].includes(r.name))
    .map(r => [r.name, db.prepare('SELECT * FROM "' + r.name + '" ORDER BY rowid').all()]));
}
const clone = value => structuredClone(value);
const part = (debit = 0, credit = 0, projectRef = 'P1', departmentRef = 'D1', partyRef = 'C1') => ({ projectRef, departmentRef, partyRef, debit, credit });
const entities = () => ['P1', 'P2', 'D1', 'D2', 'C1', 'C2'].map(ref => ({ ref, kind: ref[0] === 'P' ? 'project' : ref[0] === 'D' ? 'department' : 'party', code: ref, name: 'Same display' }));
const appendix = requestId => ({ version: 1, requestId, reason: 'Synthetic explicit source binding', entities: entities(), entries: [], openings: [] });
function voucher(sid, period, debitCode, creditCode, amount, number) {
  return { sourceVoucherId: sid, period, date: period + '-15', number, summary: 'Synthetic same summary',
    entries: [{ sourceEntryId: sid + '-debit', code: debitCode, summary: 'Same entry', debit: amount },
      { sourceEntryId: sid + '-credit', code: creditCode, summary: 'Same entry', credit: amount }] };
}
function fixture(label, multiplier = 1, profileId = 'small-2011-basic-v1') {
  const revenue = profileId === 'small-2011-basic-v1' ? '5001' : '6001';
  const capital = profileId === 'small-2011-basic-v1' ? '3001' : '4001';
  const input = { dryRun: false, mode: 'create', batchId: label + '-create', profileId,
    source: { system: 'synthetic', enterpriseKey: 'AUX-IMPORT-' + label },
    payload: { account_set: { name: 'Synthetic ' + label, start_period: '2025-12' },
      opening_balances: [{ code: '1122', debit: 1000 * multiplier }, { code: '1002', debit: 9000 * multiplier }, { code: capital, credit: 10000 * multiplier }],
      vouchers: [voucher('sale', '2025-12', '1122', revenue, 600 * multiplier, 1),
        voucher('receipt1', '2025-12', '1002', '1122', 300 * multiplier, 2),
        voucher('receipt2', '2025-12', '1002', '1122', 100 * multiplier, 3),
        voucher('unassigned', '2025-12', '1122', revenue, 200 * multiplier, 4)] }, auxiliaryAppendix: appendix(label + '-aux') };
  input.auxiliaryAppendix.openings = [{ openingCode: '1122', allocations: [part(1200 * multiplier), part(0, 200 * multiplier, 'P2', 'D2', 'C2')] }];
  input.auxiliaryAppendix.entries = [
    { sourceVoucherId: 'sale', sourceEntryId: 'sale-debit', allocations: [part(400 * multiplier), part(200 * multiplier, 0, 'P1', 'D2')] },
    { sourceVoucherId: 'receipt1', sourceEntryId: 'receipt1-credit', allocations: [part(0, 300 * multiplier)] },
    { sourceVoucherId: 'receipt2', sourceEntryId: 'receipt2-credit', allocations: [part(0, 100 * multiplier, 'P2', 'D2', 'C2')] }];
  return input;
}
function existingEntities(setId) {
  return entities().map(e => ({ ...e, existingId: X.listAuxiliaryEntities(db, { accountSetId: setId }).find(r => r.kind === e.kind && r.code === e.code).id }));
}
function assertRolledBack(input, pattern, executing=false) {
 const before=auditSnapshot();assert.throws(()=>IM.importIncremental(input),pattern);
 if(!executing){assertOnlyEpochs(auditSnapshot(),before,importResources(input,before));return;}
 const after=auditSnapshot(),oldBatch=before.import_batches.find(b=>b.batch_id===input.batchId),failed=after.import_batches.find(b=>b.batch_id===input.batchId);
 assert.equal(failed.status,'failed');assert.equal(failed.attempts,(oldBatch?.attempts??0)+1);assert.equal(failed.account_set_id,input.mode==='append'?input.accountSetId:null);assert.equal(failed.source_system,input.source.system);assert.equal(failed.enterprise_key,input.source.enterpriseKey);
 assert.deepEqual(after.import_batches.filter(b=>b.batch_id!==input.batchId),before.import_batches.filter(b=>b.batch_id!==input.batchId));
 const compare={...after,import_batches:before.import_batches};assertAuditAppend(compare,before,[input.mode==='append'?'import.append':'import.create'],'failure metadata and terminal together; business rows unchanged','failure',importResources(input,before));
}

try {
  check('aux missing is rejected without business writes and records only its acquired epoch', () => { const before = auditSnapshot(),input=fixture('missing'); assert.throws(() => IM.importIncremental(input), /aux_not_installed/); assertOnlyEpochs(auditSnapshot(),before,importResources(input,before)); });
  const cli = await runChild([fileURLToPath(new URL('../scripts/local-auxiliary.mjs', import.meta.url)), 'install', '--db', dbPath, '--out', join(root, 'cli-before-install')]);
  assert.equal(cli.code, 0, cli.stderr); assert.equal(cli.closed, true); S.assertAuxiliaryReady(db);
  console.log('actual install CLI close exit0');
  const inputs = [fixture('small'), fixture('enterprise', 2, 'enterprise-2019-general-basic-v1')], sets = [];
  for (const [i, input] of inputs.entries()) {
    const m = i + 1;
    check('create dryRun all tables unchanged profile ' + m, () => { const before = snapshot(); const preview = IM.importIncremental({ ...input, dryRun: true }); assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(snapshot(), before); });
    const result = IM.importIncremental(input); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.durability, 'committed'); assert.equal(result.auxiliary.status, 'applied'); sets.push(result.accountSetId);
    check('independent December gross/net and dimension aggregation profile ' + m, () => {
      const all = X.auxiliaryLedger(db, { accountSetId: result.accountSetId, period: '2025-12', code: '1122' });
      assert.deepEqual(all.totals, { opening: 1000 * m, debit: 800 * m, credit: 400 * m, closing: 1400 * m, debitBalance: 1700 * m, creditBalance: 300 * m });
      assert.equal(X.auxiliaryLedger(db, { accountSetId: result.accountSetId, period: '2025-12', code: '1002' }).totals.closing, 9400 * m);
      const party = X.auxiliaryLedger(db, { accountSetId: result.accountSetId, period: '2025-12', code: '1122', groupBy: ['party'] });
      const ids = new Map(X.listAuxiliaryEntities(db, { accountSetId: result.accountSetId, kind: 'party' }).map(r => [r.code, r.id]));
      assert.equal(party.groups.find(g => g.partyId === ids.get('C1')).closing, 1500 * m);
      assert.equal(party.groups.find(g => g.partyId === ids.get('C2')).closing, -300 * m);
    });
    check('same appendix business replay appends exact no_change audit profile ' + m, () => { const before = snapshot(); const replay = observedReplay(()=>IM.importIncremental(input),input); assert.equal(replay.status, 'idempotent_replay'); assert.equal(replay.auxiliary.status, 'replayed');  });
    const next = { dryRun: false, mode: 'append', accountSetId: result.accountSetId, batchId: input.batchId + '-jan', source: input.source,
      payload: { account_set: clone(input.payload.account_set), vouchers: [voucher('jan-receipt', '2026-01', '1002', '1122', 500 * m, 1), voucher('reversal', '2026-01', m === 1 ? '5001' : '6001', '1122', 100 * m, 2)] },
      auxiliaryAppendix: { ...appendix('jan-' + m), entities: existingEntities(result.accountSetId), entries: [
        { sourceVoucherId: 'jan-receipt', sourceEntryId: 'jan-receipt-credit', allocations: [part(0, 300 * m), part(0, 200 * m, 'P1', 'D2')] },
        { sourceVoucherId: 'reversal', sourceEntryId: 'reversal-credit', allocations: [part(0, 100 * m)] }] } };
    check('append dryRun zero writes profile ' + m, () => { const before = snapshot(); const preview = IM.importIncremental({ ...next, dryRun: true }); assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(snapshot(), before); });
    assert.equal(IM.importIncremental(next).ok, true);
    check('independent January and bank carried balances profile ' + m, () => {
      const report = X.auxiliaryLedger(db, { accountSetId: result.accountSetId, period: '2026-01', code: '1122' });
      assert.equal(report.totals.opening, 1400 * m); assert.equal(report.totals.debit, 0); assert.equal(report.totals.credit, 600 * m); assert.equal(report.totals.closing, 800 * m);
      assert.equal(X.auxiliaryLedger(db, { accountSetId: result.accountSetId, period: '2026-01', code: '1002' }).totals.closing, 9900 * m);
      assert.deepEqual(report.groups.map(g => g.closing).sort((a, b) => a - b), [-300 * m, 0, 200 * m, 900 * m]);
    });
  }
  check('stable technical ID replays exact original DTO and changed request conflicts without any table writes',()=>{const input=fixture('stable-tech'),operationId='aux-import-stable-tech';const first=C.withRequestMetadata({operationId},()=>IM.importIncremental(input));assert.equal(first.ok,true);const before=auditSnapshot();assert.deepEqual(C.withRequestMetadata({operationId},()=>IM.importIncremental(input)),first);assertOnlyEpochs(auditSnapshot(),before,importResources(input,before));const changed=clone(input);changed.auxiliaryAppendix.reason+=' changed';const replayed=auditSnapshot();assert.throws(()=>C.withRequestMetadata({operationId},()=>IM.importIncremental(changed)),e=>e.code==='audit_operation_conflict');assertOnlyEpochs(auditSnapshot(),replayed,[]);});
  check('same entity codes are isolated between real profiles', () => { const a = X.listAuxiliaryEntities(db, { accountSetId: sets[0] }), b = X.listAuxiliaryEntities(db, { accountSetId: sets[1] }); assert.equal(a.some(x => b.some(y => y.id === x.id)), false); });
  check('changed same request conflicts and completed audit remains intact', () => { const changed = clone(inputs[0]); changed.auxiliaryAppendix.reason = 'Changed'; assertRolledBack(changed, /request_conflict/); assert.equal(IM.getImportBatch(inputs[0].batchId).batch.status, 'completed'); });
  check('legacy no appendix replay preserves core fingerprints and all auxiliary rows', () => { const old = clone(inputs[0]); delete old.auxiliaryAppendix; const before = snapshot(); assert.equal(observedReplay(()=>IM.importIncremental(old),old).ok, true); });
  check('metadata does not change core content fingerprint', () => { const original = db.prepare('SELECT content_fingerprint,voucher_fingerprint FROM import_voucher_sources WHERE account_set_id=? ORDER BY source_voucher_id').all(sets[0]); const old = clone(inputs[0]); delete old.auxiliaryAppendix; old.payload.vouchers.forEach(v => v.entries.forEach(e => { delete e.sourceEntryId; })); assert.equal(IM.importIncremental(old).ok, true); assert.deepEqual(db.prepare('SELECT content_fingerprint,voucher_fingerprint FROM import_voucher_sources WHERE account_set_id=? ORDER BY source_voucher_id').all(sets[0]), original); });
  for (const [label, mutate, pattern, acquired=false] of [
    ['unknown shape', x => { x.auxiliaryAppendix.path = 'forbidden'; }, /aux_import_invalid/],
    ['wrong version', x => { x.auxiliaryAppendix.version = 2; }, /version_invalid/],
    ['missing raw source entry', x => { delete x.payload.vouchers[0].entries[0].sourceEntryId; }, /aux_import_invalid/, true],
    ['duplicate raw source entry', x => { x.payload.vouchers[0].entries[1].sourceEntryId = 'sale-debit'; }, /identity_duplicate/, true],
    ['derived voucher identity', x => { x.auxiliaryAppendix.entries[0].sourceVoucherId = 'derived:fake'; }, /explicit_identity/],
    ['duplicate appendix identity', x => { x.auxiliaryAppendix.entries.push(clone(x.auxiliaryAppendix.entries[0])); }, /identity_duplicate/],
    ['wrong dimension kind', x => { x.auxiliaryAppendix.entries[0].allocations[0].partyRef = 'D1'; }, /ref_invalid/],
    ['amount over GL', x => { x.auxiliaryAppendix.entries[0].allocations[0].debit = 9999; }, /exceeds_entry/, true],
    ['negative amount', x => { x.auxiliaryAppendix.entries[0].allocations[0].debit = -1; }, /amount_invalid/],
    ['subcent amount', x => { x.auxiliaryAppendix.entries[0].allocations[0].debit = 0.001; }, /amount_invalid/],
  ]) check(label + ' static rejection', () => { const input = fixture(label.replaceAll(' ', '-')); mutate(input); const before = auditSnapshot(); assert.throws(() => IM.importIncremental(input), pattern); assertOnlyEpochs(auditSnapshot(),before,acquired?importResources(input,before):[]); });
  check('prototype/accessor attacks refused without evaluation', () => { const x = fixture('prototype'); x.auxiliaryAppendix = JSON.parse('{"__proto__":{},"version":1}'); assert.throws(() => IM.importIncremental(x), /aux_import_invalid/); const y = fixture('getter'); Object.defineProperty(y.auxiliaryAppendix, 'reason', { get() { throw Error('getter executed'); }, enumerable: true }); assert.throws(() => IM.importIncremental(y), /aux_import_invalid/); });
  check('sparse arrays and extra properties refuse static shapes', () => {
    for (const mutate of [x => { x.auxiliaryAppendix.entities.length++; }, x => { x.auxiliaryAppendix.entries.extra = 'forbidden'; }, x => { Object.setPrototypeOf(x.auxiliaryAppendix.openings, null); }]) {
      const x = fixture('array-shape'); mutate(x); const before = snapshot(); assert.throws(() => IM.importIncremental(x), /aux_import_invalid/); assert.equal(snapshot(), before);
    }
  });
  check('data-only appendix rejects proxy callback surfaces', () => {
    const x = fixture('proxy'); x.auxiliaryAppendix = new Proxy(x.auxiliaryAppendix, { getPrototypeOf() { throw Error('proxy callback executed'); } }); const before = snapshot(); assert.throws(() => IM.importIncremental(x), /aux_import_invalid/); assert.equal(snapshot(), before);
  });
  check('unknown requested and persisted profiles reject without business writes', () => {
    const x = fixture('unknown-profile'); x.profileId = 'future-synthetic-profile'; const before = snapshot(); assert.equal(IM.importIncremental(x).ok, false); assert.equal(snapshot(), before);
    db.exec('BEGIN');
    try { db.prepare('UPDATE account_sets SET accounting_profile_id=? WHERE id=?').run('future-synthetic-profile', sets[0]); const mutated = snapshot(); assert.equal(IM.importIncremental(inputs[0]).ok, false); assert.equal(snapshot(), mutated); }
    finally { db.exec('ROLLBACK'); }
  });
  check('entity name and active edits cause old appendix replay conflict', () => {
    const entity = X.listAuxiliaryEntities(db, { accountSetId: sets[0], kind: 'party' })[0];
    for (const change of [{ name: 'Edited synthetic name' }, { active: false }]) {
      try { X.updateAuxiliaryEntity(db, { accountSetId: sets[0], entityId: entity.id, reason: 'synthetic state test', ...change }); assert.throws(() => IM.importIncremental(inputs[0]), /replay_state_conflict/); } finally { X.updateAuxiliaryEntity(db,{accountSetId:sets[0],entityId:entity.id,name:entity.name,active:!!entity.active,reason:'restore synthetic state'}); }
    }
  });
  // Inject only named write boundaries, retaining the real SQLite transaction and all real business calls.
  for (const [caseIndex, testCase] of ['create', 'append'].flatMap(mode => ['entity', 'second-map', 'allocation', 'request-receipt'].map(phase => ({ mode, phase }))).entries()) check(testCase.mode + ' ' + testCase.phase + ' failure rolls back every business table', () => {
    const { mode, phase } = testCase;
    const input = fixture('fault-' + mode + '-' + phase), prepare = db.prepare.bind(db); let maps = 0, fired = false;
    if (mode === 'append') {
      input.mode = 'append'; input.accountSetId = sets[0]; input.source = inputs[0].source;
      input.payload.account_set = clone(inputs[0].payload.account_set); input.payload.opening_balances = [];
      input.auxiliaryAppendix.openings = [];
      input.auxiliaryAppendix.entities.forEach(e => { e.code += '-fault-' + phase; });
      input.payload.vouchers.forEach((v, i) => { v.sourceVoucherId += '-fault-' + phase; v.number = 100 + caseIndex * 10 + i; v.entries.forEach(e => { e.sourceEntryId += '-fault-' + phase; }); });
      input.auxiliaryAppendix.entries.forEach(e => { e.sourceVoucherId += '-fault-' + phase; e.sourceEntryId += '-fault-' + phase; });
    }
    db.prepare = function(sql) {
      const statement = prepare(sql);
      if (/INSERT INTO aux_entities/.test(sql) && phase === 'entity') return { run() { fired = true; throw Error('synthetic entity boundary'); } };
      if (/INSERT INTO aux_allocations/.test(sql) && phase === 'allocation') return { run() { fired = true; throw Error('synthetic allocation boundary'); } };
      if (/INSERT INTO aux_receipts/.test(sql)) return { ...statement, run(...args) {
        if ((phase === 'second-map' && String(args[1]).startsWith('aux-import:map:') && ++maps === 2)
          || (phase === 'request-receipt' && String(args[1]).startsWith('aux-import:request:'))) { fired = true; throw Error('synthetic receipt boundary'); }
        return statement.run(...args);
      } };
      return statement;
    };
    try { assertRolledBack(input, /aux_import_failed/,true); assert.equal(fired, true); }
    finally { db.prepare = prepare; }
    assert.equal(IM.getImportBatch(input.batchId).batch.status, 'failed');
    assert.equal(IM.importIncremental(input).ok, true);
  });
  for(const boundary of ['failed-metadata','audit-terminal'])check('aux execution '+boundary+' fault preserves pending and zero partial failure records',()=>{
   const input=fixture('atomic-'+boundary),operationId='aux-atomic-'+boundary,prepare=db.prepare.bind(db);let bodyFault=false,terminalFault=0;
   db.function('aux_failure_marker',()=>{terminalFault++;return 0;});
   db.exec(boundary==='failed-metadata'?"CREATE TEMP TRIGGER fault_aux_i BEFORE INSERT ON import_batches WHEN NEW.status='failed' BEGIN SELECT aux_failure_marker();SELECT RAISE(ABORT,'synthetic');END":"CREATE TEMP TRIGGER fault_aux_i BEFORE INSERT ON audit_events WHEN NEW.action='import.create' BEGIN SELECT aux_failure_marker();SELECT RAISE(ABORT,'synthetic');END");
   const before=auditSnapshot();db.prepare=sql=>/INSERT INTO aux_entities/.test(sql)?{run(){bodyFault=true;throw Error('synthetic aux body failure');}}:prepare(sql);
   try{assert.throws(()=>C.withRequestMetadata({operationId},()=>IM.importIncremental(input)),e=>e.code==='audit_unavailable'&&C.operationErrorEvidence(e)?.applied==='unknown');assert.equal(bodyFault,true);assert.equal(terminalFault,1);const after=auditSnapshot(),ops=after.audit_operations.filter(o=>o.operation_id===operationId);assert.equal(ops.length,1);assert.equal(ops[0].state,'pending');assertOnlyEpochs({...after,audit_operations:after.audit_operations.filter(o=>o.operation_id!==operationId)},before,importResources(input,before));const frozen=auditSnapshot();assert.throws(()=>C.withRequestMetadata({operationId},()=>IM.importIncremental(input)),e=>e.code==='audit_operation_pending');assertOnlyEpochs(auditSnapshot(),frozen,importResources(input,frozen));}finally{db.prepare=prepare;db.exec('DROP TRIGGER fault_aux_i');}
  });
  const legacy = fixture('legacy-late'); delete legacy.auxiliaryAppendix;
  legacy.payload.vouchers = [{ sourceVoucherId: 'twins', period: '2025-12', date: '2025-12-01', number: 1,
    entries: [{ code: '1122', summary: 'twin', debit: 50 }, { code: '1122', summary: 'twin', debit: 50 }, { code: '5001', credit: 100 }] }];
  legacy.payload.opening_balances = [];
  const legacySet = IM.importIncremental(legacy).accountSetId;
  const twins = X.listAuxiliaryEntries(db, { accountSetId: legacySet }).filter(e => e.code === '1122');
  const late = { ...clone(legacy), auxiliaryAppendix: { ...appendix('late'), entities: [entities()[4]], entries: [{ sourceVoucherId: 'twins', sourceEntryId: 'explicit-second-twin', allocations: [{ partyRef: 'C1', debit: 50 }] }] } };
  check('old completed twin entries require explicit actual ID', () => { const before = auditSnapshot(); assert.throws(() => IM.importIncremental(late), /actual_entry_required/); assertOnlyEpochs(auditSnapshot(),before,importResources(late,before)); });
  late.auxiliaryAppendix.entries[0].actualEntryId = twins[1].entryId;
  late.auxiliaryAppendix.entries.push({ sourceVoucherId: 'twins', sourceEntryId: 'unallocated-credit', actualEntryId: X.listAuxiliaryEntries(db, { accountSetId: legacySet }).find(e => e.code === '5001').entryId, allocations: [] });
  assert.equal(IM.importIncremental(late).auxiliary.status, 'applied');
  check('explicit second equal row bound; first remains unallocated; replay unchanged', () => { assert.equal(X.entryPartyAllocation(db, { accountSetId: legacySet, entryId: twins[0].entryId }).status, 'unknown'); assert.equal(X.entryPartyAllocation(db, { accountSetId: legacySet, entryId: twins[1].entryId }).status, 'confirmed'); const before = snapshot(); assert.equal(observedReplay(()=>IM.importIncremental(late),late).auxiliary.status, 'replayed'); });
  check('new request cannot overwrite existing/manual allocation', () => { const x = clone(late); x.auxiliaryAppendix.requestId = 'overwrite'; x.auxiliaryAppendix.entities[0].existingId = X.listAuxiliaryEntities(db, { accountSetId: legacySet })[0].id; assertRolledBack(x, /allocation_exists/); });
  const extra = clone(late); extra.auxiliaryAppendix.requestId = 'extra'; extra.auxiliaryAppendix.entities[0].existingId = X.listAuxiliaryEntities(db, { accountSetId: legacySet })[0].id;
  extra.auxiliaryAppendix.entries[0].sourceEntryId = 'explicit-first-twin'; extra.auxiliaryAppendix.entries[0].actualEntryId = twins[0].entryId;
  check('different request explicitly adds previously unallocated target', () => { assert.equal(IM.importIncremental(extra).auxiliary.status, 'applied'); });
  check('same mapping cannot move to the other equal row', () => { const x = clone(late); x.auxiliaryAppendix.entries[0].actualEntryId = twins[0].entryId; assertRolledBack(x, /request_conflict|mapping_conflict/); });
  check('cross-batch dedupe reuses historical mapping, no core duplicates', () => { const x = clone(extra); x.mode = 'append'; x.accountSetId = legacySet; x.batchId = 'legacy-cross-batch'; x.auxiliaryAppendix.requestId = 'cross-batch'; x.auxiliaryAppendix.entries = [clone(late.auxiliaryAppendix.entries[1])]; delete x.auxiliaryAppendix.entries[0].actualEntryId; const core = db.prepare('SELECT * FROM import_voucher_sources ORDER BY id').all(); assert.equal(IM.importIncremental(x).ok, true); assert.deepEqual(db.prepare('SELECT * FROM import_voucher_sources ORDER BY id').all(), core); });
  check('cross-account entity IDs cannot bind', () => { const x = clone(extra); x.auxiliaryAppendix.requestId = 'cross-set'; x.auxiliaryAppendix.entries = []; x.auxiliaryAppendix.entities[0].existingId = X.listAuxiliaryEntities(db, { accountSetId: sets[1], kind: 'party' })[0].id; assertRolledBack(x, /entity_conflict/); });
  check('cross-account actual entry ID and reused source row identity refuse binding', () => {
    const x = clone(extra); x.auxiliaryAppendix.requestId = 'wrong-actual'; x.auxiliaryAppendix.entries = [{ sourceVoucherId: 'twins', sourceEntryId: 'new-identity', actualEntryId: X.listAuxiliaryEntries(db, { accountSetId: sets[1] })[0].entryId, allocations: [] }]; assertRolledBack(x, /mapping_conflict/);
    x.auxiliaryAppendix.entries[0].actualEntryId = twins[0].entryId; assertRolledBack(x, /mapping_conflict/);
  });
  check('native allocation receipt cannot collide with appendix namespace', () => {
    const x = clone(extra); x.auxiliaryAppendix.requestId = 'native-collision'; x.auxiliaryAppendix.entries = [];
    const scope = { protocol: 'aux-import/v1', sourceSystem: x.source.system, enterpriseKey: x.source.enterpriseKey };
    const requestId = 'aux-import:request:' + S.auxFingerprint([scope, x.auxiliaryAppendix.requestId]);
    const credit = X.listAuxiliaryEntries(db, { accountSetId: legacySet }).find(e => e.code === '5001').entryId;
    X.replaceAuxiliaryAllocations(db, { accountSetId: legacySet, entryId: credit, allocations: [], requestId, reason: 'synthetic reserved namespace collision' });
    assertRolledBack(x, /request_conflict/);
  });
  check('source unposting refuses replay and re-post restores same identity', () => { const vid = twins[0].voucherId; A.unpostVoucher(legacySet, vid); assert.equal(IM.importIncremental(late).ok, false); A.postVoucher(legacySet, vid); assert.equal(IM.importIncremental(late).ok, true); });
  check('closed source and later period reject appendix', () => { const vid = twins[0].voucherId; A.carryForwardProfit(legacySet, '2025-12', { yearEnd: true }); A.setPeriodStatus(legacySet, '2025-12', 'closed'); assert.throws(() => IM.importIncremental(late), /aux_period_closed/); A.setPeriodStatus(legacySet, '2025-12', 'open'); A.ensurePeriod(legacySet, '2026-01'); db.prepare("UPDATE periods SET status='closed' WHERE account_set_id=? AND period='2026-01'").run(legacySet); assert.throws(() => IM.importIncremental(late), /later_period_closed/); db.prepare("UPDATE periods SET status='open' WHERE account_set_id=? AND period='2026-01'").run(legacySet); assert.equal(db.prepare('SELECT status FROM vouchers WHERE id=?').get(vid).status, 'posted'); });
  check('two connections contention performs no partial writes', () => { const other = new DatabaseSync(dbPath); const before = snapshot(); try { other.exec('BEGIN IMMEDIATE'); assert.throws(() => IM.importIncremental(fixture('lock')), e=>e.code==='audit_admission_busy'); } finally { other.exec('ROLLBACK'); other.close(); } assert.equal(snapshot({ audit: false }), JSON.stringify(JSON.parse(before).filter(([name]) => name !== 'import_batches'))); });
  check('caller-owned transaction cannot authorize import and remains unchanged', () => { const input = fixture('nested'), before = snapshot(); db.exec('BEGIN'); try { assert.throws(()=>IM.importIncremental(input),e=>e.code==='audit_transaction_conflict');assert.equal(db.isTransaction,true);assert.equal(snapshot(),before); } finally { db.exec('ROLLBACK'); } assert.equal(snapshot(), before); });
  check('completed core new appendix cannot inherit caller transaction authority', () => {
    const x = clone(extra); x.auxiliaryAppendix.requestId = 'late-nested'; x.auxiliaryAppendix.entries = [];
    const before = snapshot(); db.exec('BEGIN'); try { assert.throws(()=>IM.importIncremental(x),e=>e.code==='audit_transaction_conflict');assert.equal(db.isTransaction,true);assert.equal(snapshot(),before); } finally { db.exec('ROLLBACK'); } assert.equal(snapshot(), before);
  });
  check('saved mapping detects ID deletion/rebuild after explicit allocation removal', () => {
    const entry = twins[1], allocations = X.entryPartyAllocation(db, { accountSetId: legacySet, entryId: entry.entryId }); assert.equal(allocations.status, 'confirmed');
    X.replaceAuxiliaryAllocations(db, { accountSetId: legacySet, entryId: entry.entryId, allocations: [], requestId: 'clear-second', reason: 'synthetic old row rebuild' });
    const before=auditSnapshot(),original=db.prepare('SELECT * FROM voucher_entries WHERE id=?').get(entry.entryId),sequence=db.prepare("SELECT seq FROM sqlite_sequence WHERE name='voucher_entries'").get().seq;
    let replacement;
    // Import must observe a committed fixture; it never inherits a caller transaction.
    db.exec('BEGIN');try{db.prepare('DELETE FROM voucher_entries WHERE id=?').run(entry.entryId);replacement=Number(db.prepare('INSERT INTO voucher_entries(voucher_id,line_no,code,summary,debit,credit) VALUES(?,?,?,?,?,?)').run(entry.voucherId,entry.lineNo,'1122','twin',50,0).lastInsertRowid);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    try{assert.throws(()=>IM.importIncremental(late),/mapping_conflict/);}
    finally{
     db.exec('BEGIN');try{db.prepare('DELETE FROM voucher_entries WHERE id=?').run(replacement);const columns=Object.keys(original);db.prepare('INSERT INTO voucher_entries('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...columns.map(k=>original[k]));db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='voucher_entries'").run(sequence);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    }
    assertOnlyEpochs(auditSnapshot(),before,importResources(late,before));
    const beforeLine=auditSnapshot();db.prepare('UPDATE voucher_entries SET line_no=1 WHERE id=?').run(entry.entryId);
    try{assert.throws(()=>IM.importIncremental(late),/mapping_conflict/);}finally{db.prepare('UPDATE voucher_entries SET line_no=? WHERE id=?').run(original.line_no,entry.entryId);}
    assertOnlyEpochs(auditSnapshot(),beforeLine,importResources(late,beforeLine));assert.throws(()=>IM.importIncremental(late),/replay_state_conflict/);
  });
  const backup = await LB.createBackup({ dbPath, outDir: join(root, 'official-appendix-backup') }); assert.equal(backup.ok, true, JSON.stringify(backup)); assert.equal((await LB.verifyBackup({ backupDir: backup.backupDir })).ok, true);
  const restored = await LB.restoreNew({ backupDir: backup.backupDir, targetDir: join(root, 'restored-appendix') }); assert.equal(restored.ok, true);
  const restoredDb = new DatabaseSync(join(restored.targetDir, 'workbench.db'));
  try { assert.deepEqual(restoredDb.prepare("SELECT * FROM aux_receipts WHERE request_id LIKE 'aux-import:%' ORDER BY account_set_id,request_id").all(), db.prepare("SELECT * FROM aux_receipts WHERE request_id LIKE 'aux-import:%' ORDER BY account_set_id,request_id").all()); assert.equal(restoredDb.prepare('PRAGMA foreign_key_check').all().length, 0); } finally { restoredDb.close(); }
  const moduleUrl = new URL('../server/import-incremental.mjs', import.meta.url).href, dbUrl = new URL('../server/db.mjs', import.meta.url).href;
  const continued = await runChild(['--input-type=module', '-e', `const {db}=await import(${JSON.stringify(dbUrl)});const I=await import(${JSON.stringify(moduleUrl)});try{const replay=I.importIncremental(${JSON.stringify(inputs[0])});if(!replay.ok||replay.auxiliary.status!=='replayed')throw Error('restored replay');const next=${JSON.stringify(fixture('restored-new'))};if(!I.importIncremental(next).ok)throw Error('restored continue');console.log('restored mapping replay and continued core+aux committed');}finally{db.close();}`], { env: { WORKBENCH_DATA_DIR: restored.targetDir } });
  assert.equal(continued.code, 0, continued.stderr); assert.equal(continued.closed, true); console.log(continued.stdout.trim());
  for (const boundary of ['begin-after', 'commit-after', 'rollback-before', 'release-after']) {
    const target = await LB.restoreNew({ backupDir: backup.backupDir, targetDir: join(root, 'unknown-' + boundary) }); assert.equal(target.ok, true);
    const child = await runChild(['--input-type=module', '-e', `import assert from 'node:assert/strict';${assertEpochs.toString()};${assertOnlyEpochs.toString()};const {db}=await import(${JSON.stringify(dbUrl)});const I=await import(${JSON.stringify(moduleUrl)});const C=await import(${JSON.stringify(new URL('../server/local-audit-coordinator.mjs',import.meta.url).href)});const mode=${JSON.stringify(boundary)},input=${JSON.stringify(fixture('unknown-' + boundary))},exec=db.exec.bind(db);let injected=false,rollbackLost=false;const all=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]));const before=all();db.exec=function(sql){if(mode==='release-after'&&injected&&sql==='ROLLBACK'){rollbackLost=true;throw Error('synthetic unknown outer rollback');}const held=db.prepare('SELECT 1 FROM local_batch_locks WHERE resource_key=?').get('book:'+input.source.enterpriseKey),pending=db.prepare('SELECT 1 FROM audit_operations WHERE operation_id=?').get('aux-unknown-'+mode);const hit=mode==='begin-after'?sql==='BEGIN IMMEDIATE'&&held&&!pending:mode==='commit-after'?sql==='COMMIT'&&held&&pending:mode==='rollback-before'?sql==='ROLLBACK'&&held&&pending:sql.startsWith('RELEASE audit_body_');if(!injected&&hit){injected=true;if(mode!=='rollback-before')exec(sql);throw Error('synthetic unknown boundary');}return exec(sql);};if(mode==='rollback-before'){const prepare=db.prepare.bind(db);db.prepare=sql=>/INSERT INTO aux_entities/.test(sql)?{run(){throw Error('synthetic body failure');}}:prepare(sql);}try{let error;try{C.withRequestMetadata({operationId:'aux-unknown-'+mode},()=>I.importIncremental(input));}catch(e){error=e;}assert.equal(error?.code,'audit_commit_unknown');assert.equal(injected,true);if(mode==='release-after')assert.equal(rollbackLost,true);const proof=C.operationErrorEvidence(error);assert.equal(proof.applied,'unknown');assert.equal(proof.needsLocalReview,true);if(db.isTransaction)exec('ROLLBACK');const W=await import(${JSON.stringify(new URL('../server/local-write-lock.mjs',import.meta.url).href)});assert.equal(W.cleanupWriteResources(db).pending,false);assert.equal(db.isTransaction,false);const after=all();for(const [name,rows] of Object.entries(before)){if(['audit_operations','audit_events','local_batch_lock_epochs'].includes(name))continue;assert.deepEqual(after[name],rows,name+' no partial business/failed metadata');}assertEpochs(after,before,['book:'+input.source.enterpriseKey]);assert.deepEqual(after.audit_events,before.audit_events);const added=after.audit_operations.filter(o=>!before.audit_operations.some(old=>old.operation_id===o.operation_id&&old.database_instance_id===o.database_instance_id&&old.attempt===o.attempt));assert.equal(added.length,mode==='begin-after'?0:1);assert.deepEqual(after.audit_operations.filter(o=>!added.includes(o)),before.audit_operations);for(const op of added){assert.equal(op.state,'pending');assert.equal(op.operation_id,'aux-unknown-'+mode);assert.equal(op.attempt,1);assert.equal(op.database_instance_id,proof.receipt?.databaseInstanceId??before.audit_database_instances.find(i=>i.is_active===1).instance_id);}const frozen=all();assert.throws(()=>C.withRequestMetadata({operationId:'aux-unknown-'+mode},()=>I.importIncremental(input)),e=>e.code==='audit_unavailable');assertOnlyEpochs(all(),frozen,['book:'+input.source.enterpriseKey]);console.log(mode+' exact audit unknown, pending retained, no automatic retry');}finally{if(db.isTransaction)exec('ROLLBACK');db.close();}`], { env: { WORKBENCH_DATA_DIR: target.targetDir } });
    assert.equal(child.code, 0, child.stderr); assert.equal(child.closed, true); console.log(child.stdout.trim());
  }
  console.log('auxiliary-import PASS ' + count + ' checks; actual CLI/restore/unknown children closed; fixtures retained');
} finally { db.close(); console.log('auxiliary-import database closed'); }
