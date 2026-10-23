import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
export const WORKBENCH=resolve(import.meta.dirname,'..');
export function fixtureEnv(prefix='audit-entry-') {
 const root=fs.mkdtempSync(join(tmpdir(),prefix));for(let p=resolve(root);;p=dirname(p)){assert.equal(fs.lstatSync(p).isSymbolicLink(),false);assert.equal(fs.realpathSync.native(p).toLowerCase(),resolve(p).toLowerCase());if(dirname(p)===p)break;}
 return {root,env:{...process.env,TEMP:root,TMP:root,WORKBENCH_DATA_DIR:join(root,'data'),KEEP_FIXTURES:'1',WORKBENCH_TEST_KEEP_FIXTURES:'1',REPORT_OFFICE_PYTHON:process.env.REPORT_OFFICE_PYTHON??'C:/Users/35007/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'}};
}
export async function runChild(args,{cwd=WORKBENCH,env=process.env,input}={}) {
 return await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',error;const timer=setTimeout(()=>child.kill(),60000);child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',e=>error=e);child.on('close',(code,signal)=>{clearTimeout(timer);console.log('child actual close',code,signal);if(error)reject(error);else resolve({code,signal,stdout,stderr});});child.stdin.end(input);});
}
export async function startServer(fixture=fixtureEnv()) {
 const code=`import './server/server.mjs';import {db} from './server/db.mjs';process.on('message',m=>{if(m==='close'){if(db.isTransaction)db.exec('ROLLBACK');db.close();console.log('DB actual close');process.exit(0);}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:WORKBENCH,env:{...fixture.env,PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let output='',errors='',closed=false;
 const closePromise=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>{closed=true;console.log('server child actual close',code,signal);resolve({code,signal,output,errors});});});
 child.stderr.on('data',c=>errors+=c);
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server startup timeout '+errors)),20000);child.stdout.on('data',c=>{output+=c;const m=output.match(/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]));}});child.once('close',()=>{clearTimeout(timer);reject(Error(errors));});});
 return {fixture,base:`http://127.0.0.1:${port}`,async close(){if(!closed)child.send('close');const result=await closePromise;assert.equal(result.code,0,result.errors);assert.match(result.output,/DB actual close/);return result;}};
}
export async function post(server,path,body,id=randomUUID()) {const response=await fetch(server.base+path,{method:'POST',headers:{'content-type':'application/json','X-Workbench-Operation-Id':id},body:JSON.stringify(body)});return {status:response.status,id:response.headers.get('x-workbench-operation-id'),body:await response.json()};}
if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)) {
 const server=await startServer();try {
  const id=randomUUID(),input={name:'HTTP合成',start_period:'2026-01',enterprise:{enterpriseKey:'HTTP-SYN'}};
  const first=await post(server,'/api/account-sets',input,id);assert.equal(first.status,201,JSON.stringify(first));assert.equal(first.id,id);
  assert.deepEqual((await post(server,'/api/account-sets',input,id)).body,first.body);
  assert.equal((await post(server,'/api/account-sets',{...input,name:'冲突'},id)).body.error,'audit_operation_conflict');
  const rawId=randomUUID(),raw={accountSetId:first.body.id,period:'2026-01',voucher_date:'2026-01-03',status:'posted',entries:[{code:'1002',debit:200},{code:'5001',credit:200}],operationId:rawId};
  const rawResult=await post(server,'/agent/tools/voucher_create',raw,rawId);assert.equal(rawResult.status,200,JSON.stringify(rawResult));
  const modelId=randomUUID(),model=await post(server,'/agent/model-tools/voucher_unpost',{accountSetId:first.body.id,voucherId:rawResult.body.id,operationId:modelId},modelId);assert.equal(model.body.ok,true,JSON.stringify(model));
  const bad=await post(server,'/agent/tools/voucher_post',{accountSetId:first.body.id,voucherId:rawResult.body.id,operationId:randomUUID()},randomUUID());assert.equal(bad.body.error,'audit_operation_conflict');
  const noId=async(path,body)=>{const response=await fetch(server.base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,id:response.headers.get('x-workbench-operation-id'),body:await response.json()};};
  const bankBase=`/api/account-sets/${first.body.id}`;
  const draft=await noId(bankBase+'/bank-drafts',{tool:'bank_account_register',payload:{bankAccountId:'HTTP-BANK',sourceId:'SYN',glAccountCode:'1002'},confirm:true});assert.equal(draft.status,200,JSON.stringify(draft));
  const registered=await noId(bankBase+'/bank/account-register',{draftRef:draft.body.draftRef});assert.equal(registered.status,200,JSON.stringify(registered));assert.equal(registered.id,draft.body.operationId);
  const rejected=await post(server,bankBase+'/bank/account-register',{draftRef:draft.body.draftRef},randomUUID());assert.equal(rejected.body.error,'audit_operation_conflict');
  const preview=await noId(bankBase+'/bank-drafts',{tool:'bank_import_preview',payload:{bankAccountId:'HTTP-BANK',sourceId:'SYN',batchId:'HTTP-BATCH',period:'2026-01',csvText:'date,amount,direction,ref\n2026-01-03,200,in,SYN\n',mapping:{columns:{date:'date',amount:'amount',direction:'direction',refId:'ref'},amountMode:'amount_direction',directionLabels:{inflow:['in'],outflow:['out']},currency:'CNY'}}});
  const previewed=await noId(bankBase+'/bank/import-preview',{draftRef:preview.body.draftRef});assert.equal(previewed.status,200,JSON.stringify(previewed));assert.equal(previewed.id,preview.body.operationId);
  const approved=await noId(bankBase+'/bank-drafts/approve-import',{previewRef:preview.body.draftRef});assert.equal(approved.status,200,JSON.stringify(approved));
  const imported=await noId(bankBase+'/bank/import',{draftRef:approved.body.draftRef});assert.equal(imported.status,200,JSON.stringify(imported));assert.equal(imported.id,approved.body.operationId);
  const receiptCheck=await runChild(['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(join(server.fixture.env.WORKBENCH_DATA_DIR,'workbench.db'))},{readOnly:true});try{console.log(JSON.stringify(db.prepare('SELECT operation_id,state FROM audit_operations WHERE operation_id=?').get(${JSON.stringify(approved.body.operationId)})));}finally{db.close();console.log('DB actual close');}`],{env:server.fixture.env});assert.equal(receiptCheck.code,0,receiptCheck.stderr);assert.equal(JSON.parse(receiptCheck.stdout.split('\n')[0]).operation_id,imported.id);
  console.log(JSON.stringify({groups:7,root:server.fixture.root,accountSetId:first.body.id,rawVoucherId:rawResult.body.id,bankOperationId:imported.id}));
 }finally{await server.close();}
}
