import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from './mcp-stdio-client.mjs';
import { TOOLS, MODEL_PLAIN_TOOL_NAMES, MODEL_WRITE_TOOL_NAMES } from './tools.mjs';
import { httpHarness, input, MARK, noLeak, names } from '../../../../06-workbench/test/auxiliary-http.test.mjs';
const h=await httpHarness();let client,proxy;let stdio='',mode='real';const routes=[];let closePromise;
try {
 await h.install();
 proxy=createServer(async(req,res)=>{
  routes.push(req.url);let body='';for await(const c of req)body+=c;
  if(mode==='broken'){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:MARK,details:MARK}));return;}
  if(mode==='malformed'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,raw:MARK}));return;}
  if(mode==='disconnect'){req.socket.destroy();return;}
  try {const r=await fetch(h.base+req.url,{method:'POST',headers:{'content-type':'application/json'},body});res.writeHead(r.status,{'content-type':'application/json'});res.end(await r.text());}catch{res.writeHead(500);res.end('proxy_failed');}
 });
 await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
 client=new McpStdioClient(fileURLToPath(new URL('./server.mjs',import.meta.url)),{env:{...process.env,FINANCE_API_BASE:'http://127.0.0.1:'+proxy.address().port,FINANCE_API_TIMEOUT_MS:'1500'}}).start();
 closePromise=new Promise(resolve=>client.child.once('close',(code,signal)=>resolve({code,signal})));
 client.child.stdout.on('data',d=>{stdio+=d;});client.child.stderr.on('data',d=>{stdio+=d;});
 await client.initialize('auxiliary-synthetic');
 const listed=await client.rpc('tools/list'),list=listed.result.tools;
 for(const name of names){const t=TOOLS.find(t=>t.name===name);assert.equal(t.status,'available');assert.equal(t.origin,'local');assert.equal(MODEL_PLAIN_TOOL_NAMES.includes(name),true);assert.equal(list.some(t=>t.name===name),true);}
 for(const name of names.slice(4))assert.equal(MODEL_WRITE_TOOL_NAMES.includes(name),true);
 assert.equal(MODEL_WRITE_TOOL_NAMES.length,24);assert.deepEqual(MODEL_WRITE_TOOL_NAMES.filter(n=>n.startsWith("bank_")).sort(),["bank_account_register","bank_ambiguity_resolve","bank_cancel","bank_confirm","bank_import","bank_reconcile"]);assert.equal(new Set(MODEL_WRITE_TOOL_NAMES).size,24);
 assert.equal(TOOLS.find(t=>t.name==='book_import_incremental').inputSchema.properties.auxiliaryAppendix.additionalProperties,false);
 for(const forbidden of ['localRead','localCompute','finance_output_read','finance_output_compute','raw'])assert.equal(list.some(t=>t.name===forbidden),false);
 let calls=0;
 const call=async(name,args,applied)=>{const r=await client.call(name,args);noLeak(r);assert.equal(r.isError,false,r.text);assert.equal(r.data.channel,'model');assert.equal(r.data.rawValuesIncluded,false);assert.deepEqual(r.structured,r.data);if(applied!==undefined)assert.equal(r.data.applied,applied);calls++;return r.data;};
 const sets=[];
 for(const [i,req] of [input('mcpA'),input('mcpB',2,'enterprise-2019-general-basic-v1')].entries()) {
  const imp=await call('book_import_incremental',req,true),set=imp.accountSetId;sets.push(set);
  await call('book_import_incremental',req,false);
  const extra={...req,auxiliaryAppendix:{version:1,requestId:MARK+'empty-MCP',reason:MARK,entities:[],entries:[],openings:[]}};
  const fresh=await call('book_import_incremental',extra,true);assert.equal(fresh.projection.status,'idempotent_replay');assert.equal(fresh.projection.auxiliary.status,'applied');
  await call('book_import_incremental',{...extra,dryRun:true},false);
  const project=await call('auxiliary_entity_create',{accountSetId:set,kind:'project',code:MARK+'project',name:MARK,requestId:MARK+'entity'},true);
  await call('auxiliary_entity_update',{accountSetId:set,entityId:project.projection.entityId,name:MARK+'renamed',reason:MARK},true);
  await call('auxiliary_entities',{accountSetId:set});
  const entries=await call('auxiliary_entries',{accountSetId:set});
  const local=await h.request('/api/finance-output/read',{ref:entries.localRef,accountSetId:set,operation:entries.operation});assert.equal(local.status,200);assert.ok(JSON.stringify(local.data.value).includes(MARK));
  const eid=local.data.value.items.find(e=>e.code==='1122'&&e.debit>0).entryId;
  await call('auxiliary_allocate',{accountSetId:set,entryId:eid,allocations:[{projectId:project.projection.entityId,debit:600*(i+1)}],requestId:MARK+'allocate',reason:MARK},true);
  await call('auxiliary_requirement_set',{accountSetId:set,code:'1122',party:false,reason:MARK},true);
  await call('auxiliary_party',{accountSetId:set,entryId:eid});
  const ledger=await call('auxiliary_ledger',{accountSetId:set,period:'2025-12',code:'1122'});assert.equal(ledger.projection.closing,1400*(i+1));
  const computed=await h.request('/api/finance-output/compute',{ref:ledger.localRef,accountSetId:set,operation:ledger.operation,op:'sum',path:'groups.[].closing'});assert.equal(computed.data.value,1400*(i+1));
  const next={dryRun:false,mode:'append',accountSetId:set,batchId:MARK+'mcp-jan'+i,source:req.source,payload:{account_set:req.payload.account_set,vouchers:[{sourceVoucherId:'jan',period:'2026-01',date:'2026-01-15',number:1,entries:[{sourceEntryId:'jd',code:'1002',debit:600*(i+1)},{sourceEntryId:'jc',code:'1122',credit:600*(i+1)}]}]},auxiliaryAppendix:{version:1,requestId:MARK+'mcp-jan',reason:MARK,entities:[],entries:[],openings:[]}};
  await call('book_import_incremental',next,true);assert.equal((await call('auxiliary_ledger',{accountSetId:set,period:'2026-01',code:'1122'})).projection.closing,800*(i+1));
  const bad=await client.call('book_import_incremental',{...req,auxiliaryAppendix:null});assert.equal(bad.isError,true);noLeak(bad);
 }
 for(const failure of ['broken','malformed','disconnect']) {
  mode=failure;
  for(const name of names) {const before=routes.length,r=await client.call(name,{accountSetId:sets[0],kind:'party',code:MARK,name:MARK,requestId:MARK,entityId:1,entryId:1,allocations:[],reason:MARK,period:'2025-12'});assert.equal(r.isError,true);noLeak(r);assert.equal(routes.length,before+1);assert.equal(routes.at(-1),'/agent/model-tools/'+name);if(names.slice(4).includes(name))assert.equal(r.data.writeOutcome,'unknown');}
 }
 assert.equal(routes.some(p=>p.startsWith('/agent/tools/')),false);noLeak(stdio);noLeak(h.getLogs());
 console.log('auxiliary MCP PASS calls='+calls+'; real stdio/model/SQLite eight tools, appendix, local refs and no raw retry');
} finally {
 if(client){await client.close();const r=await closePromise;console.log('MCP child close '+JSON.stringify(r));noLeak(stdio);}
 if(proxy)await new Promise(resolve=>proxy.close(resolve));
 await h.close();
}
