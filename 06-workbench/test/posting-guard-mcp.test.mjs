// 实际默认direct MCP → HTTP → 领域守卫；仅使用合成临时库和原件。
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {syntheticVoucherEvidence} from './helpers/synthetic-posting-evidence.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url));
test('默认direct返回可纠正/待审核且支持补证post和纠正关联',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'posting-mcp-')),source=join(dir,'originals');mkdirSync(source);
 const env={...process.env,WORKBENCH_DATA_DIR:dir,FINANCE_SOURCE_ROOT:source,FINANCE_DATABASE_PATH:join(dir,'workbench.db'),FINANCE_AUDIT_DIR:join(dir,'calls'),FINANCE_MCP_PROFILE:'direct',PORT:'0',HOST:'127.0.0.1'};
 const backend=spawn(process.execPath,[join(repo,'06-workbench/server/server.mjs')],{env,stdio:['ignore','pipe','pipe']});let stderr='',client;
 backend.stderr.on('data',b=>{stderr+=b;});
 try{const base=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('backend_start_timeout '+stderr)),15000);backend.stdout.on('data',b=>{output+=b;const m=/http:\/\/127\.0\.0\.1:\d+/.exec(output);if(m){clearTimeout(timer);resolve(m[0]);}});backend.on('exit',()=>{clearTimeout(timer);reject(Error('backend_exit '+stderr));});});
 client=new McpStdioClient(join(repo,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{env:{...env,FINANCE_API_BASE:base},cwd:repo,timeoutMs:15000}).start();await client.initialize('posting-guard');
 const made=await client.call('account_set_create',{enterprise:{enterpriseKey:'SYNTHETIC-POSTING-MCP'},name:'合成入账保护',start_period:'2026-01'});assert.equal(made.isError,false,made.text);const accountSetId=made.data.accountSetId;
 const raw={accountSetId,period:'2026-02',voucher_date:'2026-02-28',entries:[{code:'1002',debit:100},{code:'1001',credit:100}]};
 const invalid=await client.call('voucher_create',syntheticVoucherEvidence({...raw,voucher_date:'2026-02-31',status:'posted'},source));assert.equal(invalid.data?.nextAction,'correct_input',invalid.text);assert.equal(invalid.data.needsLocalReview,false);const previous=invalid.data.postingGuard.attemptId;
 const fixed=await client.call('voucher_create',syntheticVoucherEvidence({...raw,status:'posted',correctionOf:previous},source));assert.equal(fixed.isError,false,fixed.text);assert.equal(fixed.data.applied,true);
 const pending=await client.call('voucher_create',{...raw,status:'posted'});assert.equal(pending.data?.nextAction,'human_review',pending.text);assert.equal(pending.data.applied,false);
 const mismatch=syntheticVoucherEvidence({...raw,status:'posted'},source);mismatch.entries=[{code:'1002',debit:101},{code:'1001',credit:101}];const rejected=await client.call('voucher_create',mismatch);assert.equal(rejected.data?.nextAction,'correct_input',rejected.text);
 const drafted=await client.call('voucher_create',raw);assert.equal(drafted.isError,false,drafted.text);const voucherId=drafted.data.projection.voucherId;
 const posted=await client.call('voucher_post',{accountSetId,voucherId,businessEvidence:syntheticVoucherEvidence(raw,source).businessEvidence});assert.equal(posted.isError,false,posted.text);assert.equal(posted.data.applied,true);
 }finally{await client?.close();backend.kill();}
});
