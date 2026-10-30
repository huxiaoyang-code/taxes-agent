import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// 等待精确的自有 ChildProcess close 事件，包括 spawn 失败。
export async function closeOwnedChild(child, closed) {
 const wait = (ms) => new Promise((resolve,reject) => {
  const timer=setTimeout(()=>reject(Error('owned_child_close_timeout')),ms);
  closed.then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)});
 });
 if(child.exitCode===null && child.signalCode===null) child.kill();
 try {return await wait(5000);} catch(error) {
  if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
  return await wait(5000);
 }
}
export async function withBackend(run) {
 const directory=mkdtempSync(join(tmpdir(),'enterprise-http-'));
 const child=spawn(process.execPath,[join(import.meta.dirname,'../server/server.mjs')],{env:{...process.env,WORKBENCH_DATA_DIR:directory,PORT:'0',HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
 let spawnError=null;
 child.on('error',error=>{spawnError=error.code || 'spawn_failed'});
 const stopped=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal,spawnError})));
 let errors=''; child.stderr.on('data',c=>errors+=c);
 try {
 const port=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('startup_timeout '+errors)),15000);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',()=>{clearTimeout(timer);reject(Error('startup_exit '+errors))});child.stdout.on('data',c=>{output+=c;const m=output.match(/127\.0\.0\.1:(\d+)\//);if(m){clearTimeout(timer);resolve(m[1]);}})});
 const base='http://127.0.0.1:'+port;
 const http=async(method,path,body)=>{const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const text=await response.text();let data;try{data=JSON.parse(text)}catch{}return {status:response.status,data,text};};
 await run({http,base,directory});
 } finally {const closed=await closeOwnedChild(child,stopped); console.log('owned HTTP child close confirmed; fixture retained',directory,JSON.stringify(closed));}
}
if(import.meta.url===pathToFileURL(process.argv[1]).href){
test('HTTP incremental explicit invalid profile aliases never default and are zero-write',async()=>withBackend(async({http})=>{
 for(const field of ['profileId','profile_id']) for(const value of ['',null,123]) for(const dryRun of [true,false]) {
  const result=await http('POST','/api/import/incremental',{[field]:value,dryRun,batchId:'INVALID-'+field+'-'+String(value)+'-'+dryRun,source:{system:'profile-negative',enterpriseKey:'PROFILE-NEGATIVE'},payload:{account_set:{name:'synthetic',start_period:'2026-01'}}});
  assert.equal(result.status,400,JSON.stringify(result.data));assert.equal(result.data.validation.profileError.code,'accounting_profile_unknown');
 }
 assert.deepEqual((await http('GET','/api/account-sets')).data,[]);
}));
test('HTTP required identity/profile errors are fixed and zero-write; concurrent NFKC identity creates one book',async()=>withBackend(async({http})=>{
 const before=(await http('GET','/api/account-sets')).data;
 for(const [body,code] of [[{name:'synthetic',start_period:'2026-01'},'enterprise_identity_required'],[{name:'synthetic',start_period:'2026-01',enterprise:{enterpriseKey:{} }},'enterprise_identity_invalid'],[{name:'synthetic',start_period:'2026-01',enterprise:{enterpriseKey:'bad-profile'},profileId:'UNKNOWN'},'accounting_profile_unknown']]){const r=await http('POST','/api/account-sets',body);assert.equal(r.status,400);assert.equal(r.data.error,code);}
 assert.deepEqual((await http('GET','/api/account-sets')).data,before);
 const requests=['ABC',' ＡＢＣ '].map(enterpriseKey=>http('POST','/api/account-sets',{name:'同名',start_period:'2026-01',enterprise:{enterpriseKey}}));
 const results=await Promise.all(requests);assert.deepEqual(results.map(r=>r.status).sort(),[201,400]);assert.equal(results.find(r=>r.status===400).data.error,'enterprise_already_bound');
 assert.equal((await http('POST','/api/account-sets',{name:'同名',start_period:'2026-01',enterprise:{enterpriseKey:'OTHER'}})).status,201);
 assert.equal((await http('GET','/api/account-sets')).data.length,2);
}));
test('HTTP legacy JSON/four CSV/texts/files dryRun/apply require envelope identity and preserve amounts',async()=>withBackend(async({http})=>{
 const t=(await http('GET','/api/import/templates')).data; assert.equal(t.profileId,'small-2011-basic-v1');
 const texts=Object.fromEntries(['meta','accounts','openings','vouchers'].map(k=>[k,t[k]]));
 const parsed=await http('POST','/api/import/parse',{texts});assert.equal(parsed.data.validation.ok,false);assert.equal(parsed.data.validation.identityError.code,'enterprise_identity_required');
 const p={account_set:{name:'legacy',start_period:'2026-01'},opening_balances:[{code:'1002',debit:88},{code:'3001',credit:88}]};
 for(const body of [{payload:p},{texts},{files:Object.fromEntries(Object.entries(texts).map(([k,v])=>[k,Buffer.from(v).toString('base64')]))}]){
  const missing=await http('POST','/api/import/account-set',{...body,dryRun:false}); assert.equal(missing.data.created,null);assert.equal(missing.data.validation.ok,false);
 }
 assert.equal((await http('GET','/api/account-sets')).data.length,0);
 for(const [i,body] of [{payload:p},{texts},{files:Object.fromEntries(Object.entries(texts).map(([k,v])=>[k,Buffer.from(v).toString('base64')]))}].entries()){
  const envelope={...body,enterprise:{enterpriseKey:'CSV-OR-JSON-'+i},profileId:'small-2011-basic-v1'};
  const preview=await http('POST','/api/import/account-set',envelope);assert.equal(preview.data.validation.ok,true,JSON.stringify(preview.data));
  const applied=await http('POST','/api/import/account-set',{...envelope,dryRun:false});assert.ok(applied.data.created);
  const duplicate=await http('POST','/api/import/account-set',{...envelope,dryRun:false});assert.equal(duplicate.data.validation.identityError.code,'enterprise_already_bound');
 }
}));
test('Agent/MCP-model creation uses same domain, keeps fixed codes and excludes identity/name from model output',async()=>withBackend(async({http})=>{
 const input={name:'SENSITIVE-SYNTHETIC-NAME',start_period:'2026-01',enterprise:{enterpriseKey:'SENSITIVE-SYNTHETIC-KEY'}};
 const result=await http('POST','/agent/model-tools/account_set_create',input);assert.equal(result.data.applied,true,JSON.stringify(result.data));
 assert.equal(result.text.includes(input.name),false);assert.equal(result.text.includes(input.enterprise.enterpriseKey),false);
 const duplicate=await http('POST','/agent/model-tools/account_set_create',input);assert.equal(duplicate.data.error.code,'enterprise_already_bound');assert.equal(duplicate.text.includes(input.enterprise.enterpriseKey),false);
 const missing=await http('POST','/agent/model-tools/account_set_create',{name:'s',start_period:'2026-01'});assert.equal(missing.data.error.code,'enterprise_identity_required');
}));
test('local historical identity association requires confirmation, is idempotent and preserves balances',async()=>withBackend(async({http,directory})=>{
 const set=(await http('POST','/api/account-sets',{name:'historical',start_period:'2026-01',enterprise:{enterpriseKey:'TO-REMOVE'}})).data;
 await http('PUT',`/api/account-sets/${set.id}/opening-balances`,{items:[{code:'1002',debit:77},{code:'3001',credit:77}]});
 const before=(await http('GET',`/api/account-sets/${set.id}/reports/trial-balance?period=2026-01`)).data;
 const sql=spawnSync(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(join(directory,'workbench.db'))});db.prepare('DELETE FROM import_enterprise_account_sets WHERE account_set_id=?').run(${set.id});db.close();`],{env:{...process.env},encoding:'utf8',timeout:15000,killSignal:'SIGKILL'});assert.equal(sql.status,0,sql.stderr);
 const path=`/api/account-sets/${set.id}/enterprise`, enterprise={enterpriseKey:'HISTORICAL-CONFIRMED'};
 assert.equal((await http('GET',path)).data.enterprise,null);
 assert.equal((await http('POST',path,{enterprise})).data.error,'account_set_binding_confirmation_required');
 assert.equal((await http('POST',path,{enterprise,confirmNewBinding:true})).data.status,'bound');
 assert.equal((await http('POST',path,{enterprise})).data.status,'no_change');
 assert.equal((await http('POST',path,{enterprise:{enterpriseKey:'DIFFERENT'},confirmNewBinding:true})).data.error,'account_set_bound_to_other_enterprise');
 assert.deepEqual((await http('GET',`/api/account-sets/${set.id}/reports/trial-balance?period=2026-01`)).data,before);
}));
}
