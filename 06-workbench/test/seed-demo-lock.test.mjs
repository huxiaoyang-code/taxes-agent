import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync,lstatSync,realpathSync,writeFileSync } from 'node:fs';
import { resolve,dirname,join } from 'node:path';
import { spawn } from 'node:child_process';
const root=resolve('../../../.agent-runs','s-'+randomUUID());mkdirSync(root,{recursive:true});
for(let p=root;;p=dirname(p)){assert.equal(lstatSync(p).isSymbolicLink(),false);assert.equal(realpathSync.native(p).toLowerCase(),p.toLowerCase());if(dirname(p)===p)break;}
Object.assign(process.env,{TEMP:root,TMP:root,WORKBENCH_DATA_DIR:join(root,'d'),KEEP_FIXTURES:'1',WORKBENCH_TEST_KEEP_FIXTURES:'1'});console.log('FIXTURES '+root);
function run(args){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:process.cwd(),env:{...process.env},windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',exit;child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('exit',(code,signal)=>exit={code,signal});child.on('error',reject);child.on('close',(code,signal)=>{assert.deepEqual(exit,{code,signal});console.log('CHILD_EXIT_CLOSE '+JSON.stringify({pid:child.pid,code,signal}));resolve({code,signal,stdout,stderr});});});}
let db;
try {
 ({db}=await import('../server/db.mjs'));const A=await import('../server/accounting.mjs'),L=await import('../server/local-write-lock.mjs');
 const removed=A.createAccountSet({name:'id history',start_period:'2026-01',enterprise:{enterpriseKey:'HISTORY'}});A.deleteAccountSet(removed.id);
 const initialAudit=db.prepare('SELECT * FROM audit_events ORDER BY seq').all();
 const first=await run(['scripts/seed-demo.mjs']);assert.equal(first.code,0,first.stdout+first.stderr);writeFileSync(join(root,'seed-first.log'),first.stdout+first.stderr);const seeded=JSON.parse(first.stdout);assert.ok(seeded.accountSetId>1);assert.deepEqual({assets:seeded.assets,liabilities:seeded.liabilities,equity:seeded.equity,januaryProfit:seeded.januaryProfit,februaryProfit:seeded.februaryProfit,ytdProfit:seeded.ytdProfit,operatingCash:seeded.operatingCash,reconciles:seeded.reconciles},{assets:107400,liabilities:6300,equity:101100,januaryProfit:8000,februaryProfit:-6900,ytdProfit:1100,operatingCash:11300,reconciles:true});
 for(const event of initialAudit)assert.deepEqual({...db.prepare('SELECT * FROM audit_events WHERE seq=?').get(event.seq)},{...event});
 const tables=['account_sets','accounts','periods','opening_balances','vouchers','voucher_entries','asset_cards','asset_depreciation_runs','import_voucher_sources','import_batches'];
 const facts=()=>JSON.stringify(tables.map(t=>({table:t,rows:db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()})));
 const baseline=facts();const sequence=db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all();
 const nonforce=await run(['scripts/seed-demo.mjs']);assert.equal(nonforce.code,1);assert.equal(facts(),baseline);
 const held=L.acquireWriteResources(db,[`account-set:${seeded.accountSetId}`]);try{const blocked=await run(['scripts/seed-demo.mjs','--force']);assert.equal(blocked.code,1,blocked.stdout+blocked.stderr);assert.match(blocked.stderr,/lock_active/);assert.equal(facts(),baseline);}finally{L.releaseWriteResources(db,held);}
 // Mid-seed real SQLite RAISE rejects after the outer deletes old books, all deletions roll back.
 db.exec("CREATE TRIGGER synthetic_seed_raise BEFORE INSERT ON vouchers BEGIN SELECT RAISE(ABORT,'synthetic_seed_raise'); END");
 try{const raised=await run(['scripts/seed-demo.mjs','--force']);writeFileSync(join(root,'seed-raise.log'),raised.stdout+raised.stderr);assert.equal(raised.code,1,raised.stdout+raised.stderr);assert.equal(facts(),baseline);}finally{db.exec('DROP TRIGGER synthetic_seed_raise');}
 for(const row of sequence){const now=db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(row.name);assert.ok(now.seq>=row.seq,row.name+' never regresses');}
 const second=await run(['scripts/seed-demo.mjs','--force']);assert.equal(second.code,0,second.stdout+second.stderr);const rebuilt=JSON.parse(second.stdout);assert.ok(rebuilt.accountSetId>seeded.accountSetId);assert.equal(rebuilt.assets,107400);assert.equal(rebuilt.ytdProfit,1100);
 const other=A.createAccountSet({name:'protected auxiliary history',start_period:'2026-01',enterprise:{enterpriseKey:'AUX-HISTORY'}});
 const AS=await import('../server/auxiliary-storage.mjs'),X=await import('../server/auxiliary-accounting.mjs');await AS.ensureAuxiliarySchema(db,{dbPath:join(process.env.WORKBENCH_DATA_DIR,'workbench.db'),outDir:join(root,'aux')});X.createAuxiliaryEntity(db,{accountSetId:other.id,kind:'party',code:'HISTORY',name:'Synthetic',requestId:'history-entity'});
 const protectedFacts=facts(),auditBefore=db.prepare('SELECT * FROM audit_events ORDER BY seq').all(),auxBefore=db.prepare('SELECT * FROM aux_entities').all();
 const blockedHistory=await run(['scripts/seed-demo.mjs','--force']);assert.equal(blockedHistory.code,1,blockedHistory.stdout+blockedHistory.stderr);assert.equal(facts(),protectedFacts);assert.deepEqual(db.prepare('SELECT * FROM aux_entities').all(),auxBefore);for(const event of auditBefore)assert.deepEqual({...db.prepare('SELECT * FROM audit_events WHERE seq=?').get(event.seq)},{...event});
 writeFileSync(join(root,'facts.json'),JSON.stringify({first:seeded,rebuilt,originalSequence:sequence,sequence:db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),events:db.prepare('SELECT COUNT(*) n FROM audit_events').get().n}));
 console.log('seed-demo-lock: non-1 IDs, exact amounts, no sequence reset, active conflict, mid-RAISE rollback, atomic force and auxiliary history refusal passed');
}finally{if(db){db.close();console.log('DB_CLOSED');}}
