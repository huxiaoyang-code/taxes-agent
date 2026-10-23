import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {McpStdioClient} from './mcp-stdio-client.mjs';
import {startServer,post} from '../../../../06-workbench/test/local-audit-http.test.mjs';
const backend=await startServer();let client,closed;
try {
 const set=await post(backend,'/api/account-sets',{name:'MCP合成',start_period:'2026-01',enterprise:{enterpriseKey:'MCP-SYN'}});assert.equal(set.status,201);
 client=new McpStdioClient(join(import.meta.dirname,'server.mjs'),{cwd:import.meta.dirname,env:{...backend.fixture.env,FINANCE_API_BASE:backend.base}}).start();
 closed=new Promise(resolve=>client.child.once('close',(code,signal)=>{console.log('MCP child actual close',code,signal);resolve({code,signal});}));
 await client.initialize('audit-test');
 const operationId=randomUUID(),args={accountSetId:set.body.id,period:'2026-01',voucher_date:'2026-01-03',status:'posted',entries:[{code:'1002',debit:200},{code:'5001',credit:200}],operationId};
 const first=await client.call('voucher_create',args);assert.equal(first.isError,false,first.text);assert.equal(first.data.applied,true,first.text);
 const second=await client.call('voucher_create',args);assert.equal(second.isError,false,second.text);assert.equal(second.data.applied,true);
 const bad=await client.call('voucher_create',{...args,entries:[{code:'1002',debit:201},{code:'5001',credit:201}]});assert.equal(bad.isError,true,bad.text);assert.equal(bad.data.error.code,'audit_operation_conflict',bad.text);assert.equal(bad.data.applied,false,bad.text);
 const raw=await fetch(backend.base+`/api/account-sets/${set.body.id}/vouchers?period=2026-01`);const vouchers=await raw.json();assert.equal(vouchers.length,1,JSON.stringify(vouchers));
 console.log(JSON.stringify({groups:4,root:backend.fixture.root,vouchers:1,stableOperationId:operationId}));
}finally {
 if(client){client.child.stdin.end();const timer=setTimeout(()=>client.child.kill(),5000);await closed;clearTimeout(timer);}
 await backend.close();
}
