// This worker only creates a new synthetic snapshot. It cannot select a user DB.
import {mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
const root=process.argv[2];if(!root||!isAbsolute(root)||existsSync(root))throw Error('harness2_seed_new_absolute_required');
mkdirSync(root);process.env.WORKBENCH_DATA_DIR=join(root,'data');
const {db}=await import('../server/db.mjs');
const A=await import('../server/accounting.mjs');
const set=A.createAccountSet({name:'SYNTHETIC-HARNESS2-A',start_period:'2026-01',profileId:'small-2011-basic-v1',enterprise:{enterpriseKey:'SYNTHETIC-HARNESS2-A'}});
const {discoverHarnessTarget}=await import('../server/harness-target.mjs');
const target=await discoverHarnessTarget(join(root,'data/workbench.db'));
const scope={enterpriseKey:'SYNTHETIC-HARNESS2-A',accountSetId:set.id,databaseInstanceId:target.databaseInstanceId,period:'2026-01',currency:'CNY'};
const {initHarness}=await import('../server/harness-runtime.mjs');await initHarness(join(root,'harness-store'),scope);
for(const name of ['materials-store','review-store'])mkdirSync(join(root,name));
writeFileSync(join(root,'synthetic.json'),JSON.stringify({version:'finance-harness2-synthetic/1',scope}));
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
console.log(JSON.stringify({status:'prepared',modelInvoked:false}));
