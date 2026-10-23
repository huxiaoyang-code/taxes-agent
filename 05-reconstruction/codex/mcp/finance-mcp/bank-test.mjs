import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {McpStdioClient} from './mcp-stdio-client.mjs';
import {TOOLS,MODEL_PLAIN_TOOL_NAMES,MODEL_WRITE_TOOL_NAMES,validateArgs} from './tools.mjs';
import {bankHttpHarness,bankFixture,exerciseBank,noBankLeak,BANK_MARK} from '../../../../06-workbench/test/bank-http.test.mjs';
const names=['bank_accounts','bank_account_register','bank_import_preview','bank_import','bank_batches','bank_transactions','bank_ambiguities','bank_ambiguity_resolve','bank_candidates','bank_confirm','bank_cancel','bank_matches','bank_reconcile','bank_status','bank_audit'];
const writes=['bank_account_register','bank_import','bank_ambiguity_resolve','bank_confirm','bank_cancel','bank_reconcile'];
const h=await bankHttpHarness();let client,proxy,closePromise;let logs='',mode='real';const routes=[],proxyErrors=[];
try{
 proxy=createServer((req,res)=>{void (async()=>{
  routes.push(req.url);let body='';for await(const c of req)body+=c;
  const data=JSON.parse(body);if(req.url.startsWith('/agent/model-tools/bank_')){assert.deepEqual(Object.keys(data).sort(),['accountSetId','draftRef']);noBankLeak(data);}
  if(mode==='broken'){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:BANK_MARK,stack:BANK_MARK}));return;}
  if(mode==='malformed'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,raw:BANK_MARK}));return;}
  if(mode==='disconnect'){req.socket.destroy();return;}
  try{const r=await fetch(h.base+req.url,{method:'POST',headers:{'content-type':'application/json'},body});const txt=await r.text();res.writeHead(r.status,{'content-type':'application/json'});res.end(mode==='afterCommit'?JSON.stringify({ok:true,raw:BANK_MARK}):txt);}catch{res.writeHead(500);res.end('{}');}
 })().catch(e=>{proxyErrors.push(String(e));res.writeHead(500);res.end('{}');});});
 await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
 client=new McpStdioClient(fileURLToPath(new URL('./server.mjs',import.meta.url)),{env:{...process.env,FINANCE_API_BASE:'http://127.0.0.1:'+proxy.address().port,FINANCE_API_TIMEOUT_MS:'1500'}}).start();
 const childEvidence={pid:client.child.pid,command:[process.execPath,client.serverPath],startedAt:new Date().toISOString(),actualClose:false};fs.writeFileSync(join(h.root,'stdio-child.json'),JSON.stringify(childEvidence,null,2));
 closePromise=new Promise(resolve=>client.child.once('close',(code,signal)=>{Object.assign(childEvidence,{code,signal,actualClose:true,closedAt:new Date().toISOString()});fs.writeFileSync(join(h.root,'stdio-child.json'),JSON.stringify(childEvidence,null,2));resolve({code,signal,actualClose:true});}));client.child.stdout.on('data',d=>logs+=d);client.child.stderr.on('data',d=>logs+=d);
 await client.initialize('bank-entry-synthetic');const listed=(await client.rpc('tools/list')).result.tools;
 assert.equal(TOOLS.length,91);assert.equal(new Set(TOOLS.map(t=>t.name)).size,91);assert.equal(MODEL_PLAIN_TOOL_NAMES.length,50);assert.equal(MODEL_WRITE_TOOL_NAMES.length,24);assert.equal(new Set(MODEL_WRITE_TOOL_NAMES).size,24);
 assert.deepEqual(MODEL_WRITE_TOOL_NAMES.filter(n=>n.startsWith('bank_')).sort(),writes.sort());
 for(const name of names){assert.ok(listed.some(t=>t.name===name));const t=TOOLS.find(t=>t.name===name);assert.equal(t.inputSchema.additionalProperties,false);assert.deepEqual(Object.keys(t.inputSchema.properties).sort(),['accountSetId','draftRef','operationId']);assert.equal(t.inputSchema.properties.operationId.type,'string');assert.equal(t.inputSchema.required.includes('operationId'),false);for(const operationId of ['stable-id-1','UUID:01.abc_2'])assert.deepEqual(validateArgs(t.inputSchema,{accountSetId:1,draftRef:'bankdraft_'+'a'.repeat(48),operationId}),[]);for(const operationId of ['',null,3,'bad space','a'.repeat(65)])assert.ok(validateArgs(t.inputSchema,{accountSetId:1,draftRef:'bankdraft_'+'a'.repeat(48),operationId}).includes('audit_operation_invalid'));assert.equal(MODEL_PLAIN_TOOL_NAMES.includes(name),true);}
 for(const name of ['bank_draft_prepare','bank_draft_read','bank_draft_approve','finance_output_read','finance_output_compute'])assert.equal(listed.some(t=>t.name===name),false);
 const call=async(tool,args)=>{const r=await client.call(tool,args);noBankLeak(r);assert.equal(r.isError,false,JSON.stringify(r));assert.equal(r.data.ok,true);assert.equal(r.data.channel,'model');assert.equal(r.data.rawValuesIncluded,false);assert.deepEqual(r.data,r.structured);return r.data;};
 const fixtures=[];
 for(const [i,profile]of ['small-2011-basic-v1','enterprise-2019-general-basic-v1'].entries()){
  const f=await bankFixture(h,'mcp-'+i,profile,i);fixtures.push(f);const result=await exerciseBank(h,f,call);
  assert.equal(result.imp.applied,true);assert.equal(result.replay.applied,false);assert.equal(result.sameBatch.applied,false);assert.equal(result.newBatch.applied,true);assert.equal(result.reconcile.applied,true);assert.equal(result.reconcile.projection.bookClosing,1130+i/100);assert.equal(result.reconcile.projection.difference,0);assert.equal(result.reconcile.projection.adjustedBook,1060+i/100);assert.equal(result.reconcile.projection.adjustedBank,1060+i/100);assert.equal(result.reconcile.projection.status,'reconciled');
  assert.deepEqual(result.reconcile.projection.bookReceived,{count:1,total:30});assert.deepEqual(result.reconcile.projection.bookPaid,{count:2,total:100});assert.deepEqual(result.reconcile.projection.bankReceived,{count:1,total:5});assert.deepEqual(result.reconcile.projection.bankPaid,{count:2,total:75});
  assert.equal(result.oneCent.projection.difference,-0.01);assert.equal(result.oneCent.projection.statementDifference,0.01);assert.equal(result.oneCent.projection.status,'pending_review');assert.equal(result.candidates.projection.candidateCount,2);assert.equal(result.candidates.projection.selection,'requires_manual_choice');assert.equal(result.crossConfirmed.applied,true);
  const ref=await h.prepare(f.set,'bank_transactions',f.s),query=await call('bank_transactions',{accountSetId:f.set,draftRef:ref});
  const local=await h.q('/api/finance-output/read',{accountSetId:f.set,operation:'bank_transactions',ref:query.localRef});assert.equal(local.status,200);assert.ok(JSON.stringify(local.data.value).includes(BANK_MARK));
  const compute=await h.q('/api/finance-output/compute',{accountSetId:f.set,operation:'bank_transactions',ref:query.localRef,op:'sum',path:'result.transactions.[].amountCents'});assert.equal(compute.status,200);assert.equal(compute.data.value,28017);
  const cross=await client.call('bank_status',{accountSetId:f.set,draftRef:ref});assert.equal(cross.isError,true);noBankLeak(cross);
  for(const bad of [{accountSetId:f.set,draftRef:ref,approved:true},{accountSetId:f.set,draftRef:ref,reason:BANK_MARK},{accountSetId:f.set,draftRef:'finref_'+'a'.repeat(48)}]){const r=await client.call('bank_status',bad);assert.equal(r.isError,true);noBankLeak(r);}
  await h.q('/api/account-sets/'+f.set+'/bank-drafts/revoke',{draftRef:ref});
 }
 const f=fixtures[0],ref=await h.prepare(f.set,'bank_accounts',{}),wrongScope=await client.call('bank_accounts',{accountSetId:fixtures[1].set,draftRef:ref});assert.equal(wrongScope.isError,true);noBankLeak(wrongScope);
 for(const failure of ['broken','malformed','disconnect']){mode=failure;for(const name of names){const before=routes.length,r=await client.call(name,{accountSetId:f.set,draftRef:ref});assert.equal(r.isError,true);noBankLeak(r);assert.equal(routes.length,before+1);assert.equal(routes.at(-1),'/agent/model-tools/'+name);if(writes.includes(name))assert.equal(r.data.writeOutcome,'unknown');}}
 mode='real';
 const writeRef=await h.prepare(f.set,'bank_reconcile',{...f.s,period:'2026-01',asOf:'2026-01-10',coverageFrom:'2026-01-01',coverageTo:'2026-01-31',statementSource:BANK_MARK,statementOpenCents:100000,statementCloseCents:113000},true);
 const before=h.db.prepare('SELECT COUNT(*) n FROM bank_reconcile_runs').get().n;mode='afterCommit';const unknown=await client.call('bank_reconcile',{accountSetId:f.set,draftRef:writeRef});assert.equal(unknown.isError,true);assert.equal(unknown.data.writeOutcome,'unknown');assert.equal(h.db.prepare('SELECT COUNT(*) n FROM bank_reconcile_runs').get().n,before+1);
 mode='real';const replay=await call('bank_reconcile',{accountSetId:f.set,draftRef:writeRef});assert.equal(replay.applied,false);assert.equal(h.db.prepare('SELECT COUNT(*) n FROM bank_reconcile_runs').get().n,before+1);
 assert.deepEqual(proxyErrors,[]);assert.equal(routes.some(r=>r.startsWith('/agent/tools/')),false);noBankLeak(logs);noBankLeak(h.getLogs());
 console.log('bank-MCP PASS real stdio15 x2 profiles; 1130/1130.01, draft input only, controlled model summaries/local read+compute; same-batch false/new-file true; committed malformed transport unknown then cached replay zero duplicate; no raw retry');
}finally{
 if(client){await client.close();console.log('bank MCP actualclose '+JSON.stringify(await closePromise));noBankLeak(logs);}
 if(proxy)await new Promise(resolve=>proxy.close(resolve));
 await h.close();
}
