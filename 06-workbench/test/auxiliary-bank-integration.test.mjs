import {assert,harness} from './auxiliary-storage.test.mjs';
const h=await harness({bank:true});
try {
 const {db,A,X,makeSet,entity,allocate,voucher}=h; const B=await import('../server/bank-reconciliation.mjs');
 const mapping={columns:{date:'date',summary:'summary',amount:'amount',direction:'direction',refId:'ref'},amountMode:'amount_direction',directionLabels:{inflow:['in'],outflow:['out']},currency:'CNY'};
 for(const [suffix,profile,capital,expense] of [['A','small-2011-basic-v1','3001','5602'],['B','enterprise-2019-general-basic-v1','4001','6602']]) {
  const accountSetId=makeSet('bank-'+suffix,profile),bankAccountId='BANK-'+suffix,sourceId='statement'; const scope={accountSetId,bankAccountId};
  A.setOpeningBalances(accountSetId,[{code:'1002',debit:1000},{code:capital,credit:1000}]);B.registerBankAccount(db,{...scope,sourceId,glAccountCode:'1002'});
  const make=(inflow,value)=>{const v=voucher(accountSetId,'2025-12',inflow?[{code:'1002',debit:value},{code:'1122',credit:value}]:[{code:expense,debit:value},{code:'1002',credit:value}]);A.postVoucher(accountSetId,v.id);return {v,e:X.listAuxiliaryEntries(db,{accountSetId,voucherId:v.id}).find(e=>e.code==='1002').entryId};};
  const incoming=make(true,200),missingIn=make(true,50),outgoing=make(false,100);make(false,30);
  const imported=B.importBankBatch(db,{...scope,sourceId,batchId:'batch-'+suffix,period:'2025-12',mapping,csvText:'date,summary,amount,direction,ref\n2025-12-15,not party proof,200,in,R1\n2025-12-15,bank only,20,in,R2\n2025-12-15,payment,100,out,R3\n2025-12-15,fee,10,out,R4\n'});
  assert.equal(imported.transactionIds.length,4);const transactionId=imported.transactionIds[0];const match=B.confirmMatch(db,{...scope,transactionId,voucherId:incoming.v.id,entryId:incoming.e,reason:'manual evidence'});assert.equal(match.match.status,'confirmed');assert.equal(match.match.entryId,incoming.e);
  B.confirmMatch(db,{...scope,transactionId:imported.transactionIds[2],voucherId:outgoing.v.id,entryId:outgoing.e,reason:'manual payment'});
  assert.equal(X.entryPartyAllocation(db,{accountSetId,entryId:incoming.e}).status,'unknown');const p=entity(accountSetId,'party','C1'),q=entity(accountSetId,'party','C2');
  const sources=JSON.stringify(db.prepare('SELECT * FROM bank_transactions').all());const amounts=JSON.stringify(db.prepare('SELECT * FROM voucher_entries').all());
  allocate(accountSetId,{entryId:incoming.e},[{partyId:p,debit:120},{partyId:q,debit:80}]);assert.equal(X.entryPartyAllocation(db,{accountSetId,entryId:incoming.e}).status,'ambiguous');
  allocate(accountSetId,{entryId:incoming.e},[{partyId:p,debit:200}]);const party=X.entryPartyAllocation(db,{accountSetId,entryId:incoming.e});assert.equal(party.status,'confirmed');assert.equal(party.partyId,p);
  const foreign=makeSet('bank-foreign-'+suffix),foreignParty=entity(foreign,'party','C1');assert.throws(()=>allocate(accountSetId,{entryId:incoming.e},[{partyId:foreignParty,debit:200}]),/dimension_invalid/);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM bank_transactions').all()),sources);assert.equal(JSON.stringify(db.prepare('SELECT * FROM voucher_entries').all()),amounts);assert.equal(B.refreshMatchStates(db,scope).invalidated.length,0);
  const r=B.reconcileBank(db,{...scope,period:'2025-12',asOf:'2025-12-31',coverageFrom:'2025-12-01',coverageTo:'2025-12-31',statementSource:'synthetic independent statement',statementOpenCents:100000,statementCloseCents:111000});
  assert.equal(r.book.closingCents,112000);assert.equal(r.adjusted.bookCents,113000);assert.equal(r.adjusted.bankCents,113000);assert.equal(r.adjusted.differenceCents,0);
  A.unpostVoucher(accountSetId,incoming.v.id);assert.equal(B.refreshMatchStates(db,scope).invalidated.length,1);assert.equal(X.entryPartyAllocation(db,{accountSetId,entryId:incoming.e}).partyId,p);A.postVoucher(accountSetId,incoming.v.id);
  assert.equal(B.cancelMatch(db,{...scope,matchId:match.match.id??match.match.matchId,reason:'cancel stale'}).match.status,'cancelled');
  console.log(suffix+' bank+aux: actual entry identity; unknown/ambiguous/confirmed; 1130 reconciliation unchanged');
 }
 console.log('auxiliary-bank-integration PASS');
} finally {h.db.close();console.log('auxiliary-bank-integration database closed');}
