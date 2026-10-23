import {fileURLToPath} from 'node:url';
import {assert,fs,join,harness,runChild} from './auxiliary-storage.test.mjs';
const h=await harness({install:false});
try {
 const {db,dbPath,root,A,makeSet,voucher}=h; const setId=makeSet('cli'),v=voucher(setId,'2025-12',[{code:'1122',debit:19.37},{code:'5001',credit:19.37}]);A.postVoucher(setId,v.id);
 const cli=new URL('../scripts/local-auxiliary.mjs',import.meta.url);let sequence=0;
 async function call(command,input,extra=[]) {const file=join(root,'input-'+(++sequence)+'.json');if(input!==undefined)fs.writeFileSync(file,JSON.stringify(input));const r=await runChild([fileURLToPath(cli),command,'--db',dbPath,...(input===undefined?[]:['--input',file]),...extra]);assert.equal(r.closed,true);assert.equal(r.timedOut,false);return {...r,json:JSON.parse(r.stdout)};}
 const install=await call('install',undefined,['--out',join(root,'cli-install-backup')]);assert.equal(install.code,0,install.stdout+install.stderr);assert.equal(install.json.result.status,'installed');
 const entity=await call('entity-create',{accountSetId:setId,kind:'party',code:'C',name:'Synthetic Party',requestId:'cli-entity'});assert.equal(entity.code,0);const partyId=entity.json.result.id;
 const entries=await call('entries',{accountSetId:setId,voucherId:v.id});assert.equal(entries.code,0);const entryId=entries.json.result.find(e=>e.code==='1122').entryId;
 const input={accountSetId:setId,entryId,allocations:[{partyId,debit:19.37}],requestId:'cli-bind',reason:'explicit post-import binding'};
 assert.equal((await call('allocate',input)).json.result.status,'applied');assert.equal((await call('allocate',input)).json.result.status,'replayed');
 const report=await call('ledger',{accountSetId:setId,period:'2025-12',code:'1122',groupBy:['party']});assert.equal(report.json.result.totals.closing,19.37);assert.equal(report.json.result.groups[0].partyId,partyId);
 assert.equal((await call('party',{accountSetId:setId,entryId})).json.result.status,'confirmed');
 const conflict=await call('allocate',{...input,allocations:[{partyId,debit:18}]});assert.equal(conflict.code,2);assert.equal(conflict.json.code,'aux_request_conflict');
 assert.equal((await call('entity-update',{accountSetId:setId,entityId:partyId,name:'Renamed',reason:'rename'})).code,0);
 assert.equal((await call('entities',{accountSetId:setId,kind:'party'})).json.result[0].name,'Renamed');
 console.log('auxiliary-cli PASS: real install/write/list/query/replay/conflict; '+sequence+' owned child close events');
} finally {h.db.close();console.log('auxiliary-cli database closed');}
