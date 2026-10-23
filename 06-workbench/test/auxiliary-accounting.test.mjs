import {assert,suite} from './auxiliary-storage.test.mjs';
await suite('auxiliary-accounting',async h=>{
 const {db,A,X,makeSet,entity,allocate,voucher}=h;
 for(const [suffix,profile,mult] of [['A','small-2011-basic-v1',1],['B','enterprise-2019-general-basic-v1',2]]) {
  const setId=makeSet(suffix,profile),revenue=mult===1?'5001':'6001',capital=mult===1?'3001':'4001';
  A.setOpeningBalances(setId,[{code:'1122',debit:1000*mult},{code:'1002',debit:9000*mult},{code:capital,credit:10000*mult}]);
  const p1=entity(setId,'project','P1'),p2=entity(setId,'project','P2'),d1=entity(setId,'department','D1'),d2=entity(setId,'department','D2'),c1=entity(setId,'party','C1'),c2=entity(setId,'party','C2');
  const t1={projectId:p1,departmentId:d1,partyId:c1},t2={projectId:p1,departmentId:d2,partyId:c1},t3={projectId:p2,departmentId:d2,partyId:c2};
  allocate(setId,{openingCode:'1122'},[{...t1,debit:1200*mult},{...t3,credit:200*mult}]);
  A.setOpeningBalances(setId,[{code:'1122',debit:1000*mult}]);assert.equal(db.prepare('SELECT COUNT(*) n FROM aux_allocations WHERE account_set_id=?').get(setId).n,2);
  assert.throws(()=>A.setOpeningBalances(setId,[{code:'1122',debit:1100*mult},{code:capital,credit:10100*mult}]),/aux_opening_reallocation_required/);assert.equal(A.getOpeningBalances(setId).find(r=>r.code==='1122').debit,1000*mult);
  function post(period,dr,cr,value,parts) {const v=voucher(setId,period,[{code:dr,debit:value*mult},{code:cr,credit:value*mult}]);const e=db.prepare("SELECT id FROM voucher_entries WHERE voucher_id=? AND code='1122'").get(v.id).id;if(parts)allocate(setId,{entryId:e},parts);A.postVoucher(setId,v.id);return {v,e};}
  const sale=post('2025-12','1122',revenue,600,[{...t1,debit:400*mult},{...t2,debit:200*mult}]);
  post('2025-12','1002','1122',300,[{...t1,credit:300*mult}]);post('2025-12','1002','1122',100,[{...t3,credit:100*mult}]);post('2025-12','1122',revenue,200);
  const dec=X.auxiliaryLedger(db,{accountSetId:setId,period:'2025-12',code:'1122'});assert.deepEqual(dec.totals,{opening:1000*mult,debit:800*mult,credit:400*mult,closing:1400*mult,debitBalance:1700*mult,creditBalance:300*mult});
  assert.deepEqual(dec.groups.map(g=>g.closing).sort((a,b)=>a-b),[-300*mult,200*mult,200*mult,1300*mult]);
  const party=X.auxiliaryLedger(db,{accountSetId:setId,period:'2025-12',code:'1122',groupBy:['party']});assert.equal(party.groups.find(g=>g.partyId===c1).closing,1500*mult);assert.equal(party.groups.find(g=>g.partyId===c2).closing,-300*mult);
  assert.equal(X.auxiliaryLedger(db,{accountSetId:setId,period:'2025-12',code:'1002'}).totals.closing,9400*mult);
  A.unpostVoucher(setId,sale.v.id);assert.equal(X.auxiliaryLedger(db,{accountSetId:setId,period:'2025-12',code:'1122'}).totals.closing,800*mult);assert.throws(()=>A.deleteVoucher(setId,sale.v.id),/aux_entry_reallocation_required/);A.postVoucher(setId,sale.v.id);
  assert.equal(X.auxiliaryLedger(db,{accountSetId:setId,period:'2025-12',code:'1122'}).totals.closing,1400*mult);
  post('2026-01','1002','1122',500,[{...t1,credit:300*mult},{...t2,credit:200*mult}]);post('2026-01',revenue,'1122',100,[{...t1,credit:100*mult}]);
  const jan=X.auxiliaryLedger(db,{accountSetId:setId,period:'2026-01',code:'1122'});assert.deepEqual(jan.totals,{opening:1400*mult,debit:0,credit:600*mult,closing:800*mult,debitBalance:1100*mult,creditBalance:300*mult});assert.deepEqual(jan.groups.map(g=>g.closing).sort((a,b)=>a-b),[-300*mult,0,200*mult,900*mult]);assert.equal(X.auxiliaryLedger(db,{accountSetId:setId,period:'2026-01',code:'1002'}).totals.closing,9900*mult);
  const draft=voucher(setId,'2026-01',[{code:'1122',debit:33},{code:revenue,credit:33}]);assert.equal(X.auxiliaryLedger(db,{accountSetId:setId,period:'2026-01',code:'1122'}).totals.closing,800*mult);assert.throws(()=>voucher(setId,'2026-01',[{code:'1122',debit:-1},{code:revenue,credit:-1}]));
  X.updateAuxiliaryEntity(db,{accountSetId:setId,entityId:c1,name:'Renamed',reason:'rename'});assert.equal(X.auxiliaryLedger(db,{accountSetId:setId,period:'2026-01',code:'1122',groupBy:['party']}).groups.find(g=>g.partyId===c1).closing,900*mult);
  X.updateAuxiliaryEntity(db,{accountSetId:setId,entityId:c1,active:false,reason:'retire'});assert.throws(()=>allocate(setId,{entryId:sale.e},[{...t1,debit:600*mult}]),/dimension_invalid/);assert.equal(X.entryPartyAllocation(db,{accountSetId:setId,entryId:sale.e}).partyId,c1);
  console.log(suffix+' independent amounts: AR 1000/1400/800; bank 9000/9400/9900 scaled '+mult+'; December gross balances 1700/300 scaled '+mult);
 }
});
