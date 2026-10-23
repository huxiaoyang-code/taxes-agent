import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { harness, runChild } from './auxiliary-storage.test.mjs';
export const MARK = 'SYNTHETIC-AUX-PRIVATE-7ac981';
export const names = ['auxiliary_entities','auxiliary_entries','auxiliary_ledger','auxiliary_party','auxiliary_entity_create','auxiliary_entity_update','auxiliary_allocate','auxiliary_requirement_set'];
export const actions = ['entities','entries','ledger','party','entity-create','entity-update','allocate','requirement'];
export function noLeak(value) { assert.equal(JSON.stringify(value).includes(MARK),false); }
export function input(label, m=1, profileId='small-2011-basic-v1') {
 const enterprise = profileId !== 'small-2011-basic-v1', revenue = enterprise ? '6001' : '5001', capital = enterprise ? '4001' : '3001';
 const v = (sourceVoucherId,period,d,c,a,number) => ({sourceVoucherId,period,date:period+'-15',number,summary:MARK,entries:[{sourceEntryId:sourceVoucherId+'-d',code:d,debit:a,summary:MARK},{sourceEntryId:sourceVoucherId+'-c',code:c,credit:a,summary:MARK}]});
 return {dryRun:false,mode:'create',batchId:MARK+label,source:{system:MARK,enterpriseKey:MARK+label,enterpriseName:MARK},profileId,
 payload:{account_set:{name:MARK,start_period:'2025-12'},opening_balances:[{code:'1122',debit:1000*m},{code:capital,credit:1000*m}],vouchers:[v('sale','2025-12','1122',revenue,600*m,1),v('receipt','2025-12','1002','1122',200*m,2)]},
 auxiliaryAppendix:{version:1,requestId:MARK+label,reason:MARK,entities:[{ref:'c',kind:'party',code:MARK,name:MARK}],openings:[{openingCode:'1122',allocations:[{partyRef:'c',debit:1000*m}]}],entries:[{sourceVoucherId:'sale',sourceEntryId:'sale-d',allocations:[{partyRef:'c',debit:600*m}]},{sourceVoucherId:'receipt',sourceEntryId:'receipt-c',allocations:[{partyRef:'c',credit:200*m}]}]}};
}
export async function httpHarness() {
 process.env.WORKBENCH_TEST_KEEP_FIXTURES='1'; process.env.KEEP_FIXTURES='1';
 const h = await harness({install:false});
 const child = spawn(process.execPath,[fileURLToPath(new URL('../server/server.mjs',import.meta.url))],{windowsHide:true,env:{...process.env,PORT:'0',HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
 let logs='',closed=false; const done=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;resolve({code,signal});}));
 child.stdout.on('data',d=>{logs+=d;}); child.stderr.on('data',d=>{logs+=d;});
 const deadline=Date.now()+20000;
 while(!/http:\/\/127\.0\.0\.1:(\d+)/.test(logs)) { if(closed||Date.now()>deadline) {child.kill(); await done;h.db.close();throw new Error('synthetic_backend_start_failed');} await new Promise(r=>setTimeout(r,40)); }
 const base=logs.match(/http:\/\/127\.0\.0\.1:(\d+)/)[0];
 const request=async(path,body,method='POST')=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});return {status:r.status,data:await r.json()};};
 const install=async()=>{const r=await runChild([fileURLToPath(new URL('../scripts/local-auxiliary.mjs',import.meta.url)),'install','--db',h.dbPath,'--out',join(h.root,'before-http-aux')]);assert.equal(r.code,0);assert.equal(r.closed,true);console.log('aux install child close exit0');};
 const close=async()=>{if(!closed)child.kill();const result=await done;assert.equal(closed,true);h.db.close();noLeak(logs);console.log('backend child close '+JSON.stringify(result)+'; database closed; fixtures retained');};
 return {...h,base,request,install,close,getLogs:()=>logs};
}
async function main() {
 const h=await httpHarness(), {request:q}=h;
 let checks=0; const check=()=>checks++;
 try {
  const missing=await q('/api/import/incremental',input('missing'));assert.equal(missing.data.error,'aux_not_installed');check();
  await h.install();
  const requests=[input('A'),input('B',2,'enterprise-2019-general-basic-v1')],sets=[];
  for(const [i,req] of requests.entries()) {
   const preview=await q('/api/import/incremental',{...req,dryRun:true});assert.equal(preview.data.dryRun,true);assert.equal(preview.data.auxiliary.status,'preview');
   const created=await q('/api/import/incremental',req);assert.equal(created.status,201);assert.equal(created.data.auxiliary.durability,'committed');sets.push(created.data.accountSetId);
   const replay=await q('/agent/tools/book_import_incremental',req);assert.equal(replay.data.auxiliary.status,'replayed');check();
   const set=created.data.accountSetId,m=i+1;
   assert.equal((await q(`/api/account-sets/${set}/auxiliary/ledger`,{period:'2025-12',code:'1122'})).data.totals.closing,1400*m);
   const entries=(await q(`/api/account-sets/${set}/auxiliary/entries`,{})).data.items;
   const target=entries.find(e=>e.code==='1122'&&e.debit===600*m).entryId;
   for(const route of ['rest','agent']) {
    const run=async(idx,args)=>{const r=await q(route==='rest'?`/api/account-sets/${set}/auxiliary/${actions[idx]}`:`/agent/tools/${names[idx]}`,{accountSetId:set,...args});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
    const entity=(await run(4,{kind:'project',code:MARK+route,name:MARK,requestId:MARK+route})).result;assert.equal(entity.durability,'committed');
    await run(5,{entityId:entity.id,name:MARK+'renamed',reason:MARK});
    const alloc=await run(6,{entryId:target,allocations:[{projectId:entity.id,debit:600*m}],requestId:MARK+'alloc'+route,reason:MARK});assert.equal(alloc.result.durability,'committed');
    await run(7,{code:'1122',party:false,reason:MARK});
    assert.ok((await run(0,{})).items.length>=2);assert.ok((await run(1,{})).items.some(e=>e.entryId===target));
    assert.equal((await run(2,{period:'2025-12',code:'1122',groupBy:['project','department','party']})).totals.closing,1400*m);
    assert.equal((await run(3,{entryId:target})).status,'unknown');check();
   }
   const sale=entries.find(e=>e.code==='1122'&&e.debit===600*m);
   assert.equal((await q(`/api/account-sets/${set}/vouchers/${sale.voucherId}/unpost`,{})).data.status,'draft');
   assert.equal((await q(`/api/account-sets/${set}/auxiliary/ledger`,{period:'2025-12',code:'1122'})).data.totals.closing,800*m);
   assert.equal((await q(`/api/account-sets/${set}/vouchers/${sale.voucherId}/post`,{})).data.status,'posted');
   assert.equal((await q(`/api/account-sets/${set}/auxiliary/ledger`,{period:'2025-12',code:'1122'})).data.totals.closing,1400*m);
   const next={dryRun:false,mode:'append',accountSetId:set,batchId:MARK+'jan'+i,source:req.source,payload:{account_set:req.payload.account_set,vouchers:[{sourceVoucherId:'jan',period:'2026-01',date:'2026-01-15',number:1,entries:[{sourceEntryId:'jd',code:'1002',debit:600*m},{sourceEntryId:'jc',code:'1122',credit:600*m}]}]},auxiliaryAppendix:{version:1,requestId:MARK+'jan'+i,reason:MARK,entities:[],entries:[],openings:[]}};
   assert.equal((await q('/agent/tools/book_import_incremental',next)).data.auxiliary.durability,'committed');
   assert.equal((await q(`/api/account-sets/${set}/auxiliary/ledger`,{period:'2026-01',code:'1122'})).data.totals.closing,800*m);check();
  }
  const [a,b]=sets, path=`/api/account-sets/${a}/auxiliary/entities`;
  for(const body of [{accountSetId:b},{account_set_id:b},{accountSetId:a,account_set_id:b},{accountSetId:true},{dbPath:MARK},{install:true},null,[]]) {assert.notEqual((await q(path,body)).status,200);check();}
  assert.equal((await q(path,{account_set_id:String(a)})).status,200);
  for(const action of ['install','constructor','__proto__','bogus']) assert.notEqual((await q(`/api/account-sets/${a}/auxiliary/${action}`,{})).status,200);
  const other=(await q(`/api/account-sets/${b}/auxiliary/entities`,{kind:'party'})).data.items[0].id;
  const entry=(await q(`/api/account-sets/${a}/auxiliary/entries`,{})).data.items.find(e=>e.code==='1122'&&e.debit>0).entryId;
  assert.equal((await q(`/api/account-sets/${a}/auxiliary/allocate`,{entryId:entry,allocations:[{partyId:other,debit:10}],requestId:MARK+'cross',reason:MARK})).data.error,'aux_dimension_invalid');
  const own=(await q(path,{kind:'party'})).data.items[0].id;
  assert.equal((await q(`/api/account-sets/${a}/auxiliary/entity-update`,{entityId:own,active:false,reason:MARK})).status,200);
  assert.equal((await q(`/api/account-sets/${a}/auxiliary/allocate`,{entryId:entry,allocations:[{partyId:own,debit:10}],requestId:MARK+'inactive',reason:MARK})).data.error,'aux_dimension_invalid');
  for(const amount of [-1,'no',0.001]) assert.equal((await q(`/api/account-sets/${a}/auxiliary/allocate`,{entryId:entry,allocations:[{partyId:own,debit:amount}],requestId:MARK+'bad'+amount,reason:MARK})).data.error,'aux_amount_invalid');
  const before=h.db.prepare('SELECT COUNT(*) n FROM aux_receipts').get().n;
  const bad=structuredClone(requests[0]);bad.auxiliaryAppendix.reason='changed';assert.equal((await q('/api/import/incremental',bad)).data.error,'aux_import_request_conflict');assert.equal(h.db.prepare('SELECT COUNT(*) n FROM aux_receipts').get().n,before);
  const legacy=structuredClone(requests[1]);delete legacy.auxiliaryAppendix;assert.equal((await q('/api/import/incremental',legacy)).data.status,'idempotent_replay');
  const added={...legacy,auxiliaryAppendix:{version:1,requestId:MARK+'completed-empty',reason:MARK,entities:[],entries:[],openings:[]}};
  const fresh=await q('/api/import/incremental',added);assert.equal(fresh.data.status,'idempotent_replay');assert.equal(fresh.data.auxiliary.status,'applied');assert.equal(fresh.data.durability,'committed');
  for(const [appendix,code] of [[null,'aux_import_invalid'],[{},'aux_import_version_invalid'],[{...added.auxiliaryAppendix,entries:null},'aux_import_invalid']]) {const r=await q('/api/import/incremental',{...legacy,auxiliaryAppendix:appendix});assert.equal(r.data.error,code);assert.equal(JSON.stringify(r.data).includes('回滚'),false);}
  h.db.prepare("UPDATE periods SET status='closed' WHERE account_set_id=? AND period='2025-12'").run(a);
  assert.equal((await q(`/api/account-sets/${a}/auxiliary/allocate`,{entryId:entry,allocations:[],requestId:MARK+'closed',reason:MARK})).data.error,'aux_period_closed');
  console.log('auxiliary-http PASS checks='+checks+'; 8 REST + 8 Agent per profile; AR1000→1400→800 / double');
 } finally {await h.close();}
}
if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)) await main();
