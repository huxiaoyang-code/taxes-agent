import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,linkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {captureWorkpaperAmount,workpaperDetails} from '../server/direct-finance-details.mjs';
import {RECORD_EXAMPLES} from '../server/direct-finance-contracts.mjs';
import {readFinanceCall} from '../server/finance-call-chain.mjs';
import {validateModelEnvelope} from '../../05-reconstruction/codex/mcp/finance-mcp/finance-model-transport.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const root=mkdtempSync(join(tmpdir(),'direct-posting-process-')),dataDir=join(root,'账库'),sourceRoot=join(root,'原件'),auditDir=join(root,'调用记录');
mkdirSync(sourceRoot);mkdirSync(auditDir);process.env.WORKBENCH_DATA_DIR=dataDir;process.env.FINANCE_AUDIT_DIR=auditDir;process.env.FINANCE_SOURCE_ROOT=sourceRoot;
const dbPath=join(dataDir,'workbench.db');
const A=await import('../server/accounting.mjs');
const set=A.createAccountSet({name:'跨进程合成企业',profileId:'small-2011-basic-v1',start_period:'2026-03',enterprise:{enterpriseKey:'SYNTHETIC-CROSS-PROCESS'}});
const other=A.createAccountSet({name:'隔离合成企业',profileId:'small-2011-basic-v1',start_period:'2026-03',enterprise:{enterpriseKey:'SYNTHETIC-OTHER'}});
const target={accountSetId:set.id,period:'2026-03'},entity={kind:'company',industry:'trade',profileId:'small-2011-basic-v1',businessStartDate:'2026-03-01',vatStatus:'general',vatPeriod:'monthly',vatReliefWaived:false,incomeLevyMethod:'actual_accounts',bookkeepingMethod:'double_entry'};
const base=(id,type,data)=>({...structuredClone(RECORD_EXAMPLES[type]),enterpriseKey:'SYNTHETIC-CROSS-PROCESS',id,type,date:'2026-03-15',businessIdentity:{issuerKey:'SYNTHETIC',documentNumber:id,event:type},originalRefs:[{originalId:'original',locator:id,extractionReason:'合成原件明确载明该业务'}],...data});
const records=[base('E','entity',{entity}),base('F','expense',{certifiedDate:'2026-03-15'})],original=join(sourceRoot,'费用原件.json');
writeFileSync(original,JSON.stringify({凭证日期:'2026-03-15',records}));
const deadline=(promise,ms=12000)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('合成进程超时')),ms);timer.unref();})]);
async function backend(){
 const child=spawn(process.execPath,[fileURLToPath(new URL('../server/server.mjs',import.meta.url))],{env:{...process.env,PORT:'0',FINANCE_DATABASE_PATH:'',WORKBENCH_DATA_DIR:dataDir},stdio:['ignore','pipe','pipe']});
 let output='';child.stderr.on('data',b=>{output+=b;});
 const url=await deadline(new Promise((resolve,reject)=>{child.stdout.on('data',b=>{output+=b;const m=/127\.0\.0\.1:(\d+)\//.exec(output);if(m)resolve(`http://127.0.0.1:${m[1]}`);});child.once('error',reject);child.once('exit',c=>reject(Error(`后端启动失败 ${c}: ${output}`)));}));return {child,url};
}
function mcp(url){
 const child=spawn(process.execPath,[fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url))],{env:{...process.env,FINANCE_DATABASE_PATH:dbPath,FINANCE_API_BASE:url},stdio:['pipe','pipe','pipe']});
 const pending=new Map();let id=0;child.stderr.resume();createInterface({input:child.stdout}).on('line',line=>{try{const r=JSON.parse(line);pending.get(r.id)?.(r);pending.delete(r.id);}catch{}});
 return {child,call:async(name,args)=>{const n=++id,p=new Promise(resolve=>pending.set(n,resolve));child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method:'tools/call',params:{name,arguments:args}})+'\n');const r=await deadline(p);assert(!r.error,JSON.stringify(r));return r.result;}};
}
test('实际 MCP 底稿跨 HTTP 正式入账，持久来源校验与拒绝边界',async t=>{
 const server=await backend(),client=mcp(server.url);t.after(()=>{client.child.kill();server.child.kill();});
 const produced=await client.call('finance_workpaper',{target,originals:[{id:'original',path:original}],records});assert(!produced.isError,JSON.stringify(produced));
 const result=produced.structuredContent,callId=result.evidence.callRef,artifactPath=join(auditDir,'artifacts',callId,'workpaper.json'),paper=JSON.parse(readFileSync(artifactPath));
 const voucherIndex=paper.accounting.vouchers.findIndex(v=>v.entries.some(e=>Number(e.debit)>0)),voucher=paper.accounting.vouchers[voucherIndex];assert(voucher);
 const reference=(entryIndex,field)=>({artifactRef:result.vouchers.detailRef,voucherIndex,entryIndex,field}),first=voucher.entries.findIndex(e=>Number(e.debit)>0),ref=reference(first,'debit');
 const privateContext={dbPath},capture=(r=ref,tgt=target)=>captureWorkpaperAmount(tgt,r,privateContext);
 await t.test('另一进程的成功持久引用可核验，公共分页仍不开放持久读取',async()=>{
  const record=await readFinanceCall({auditDir,callId});assert.equal(record.integrity,'verified');assert.equal(record.sourceCurrentness,'unchanged');
  assert.equal(capture().selectedValue,Number(voucher.entries[first].debit));assert.throws(()=>workpaperDetails({target,artifactRef:ref.artifactRef,section:'vouchers'}),{code:'finance_details_reference_untrusted'});
 });
 const args={accountSetId:set.id,period:'2026-03',voucher_date:'2026-03-15',status:'posted',summary:'合成实际费用入账',entries:voucher.entries.map(e=>({code:e.code,debit:e.debit,credit:e.credit})),businessEvidence:{businessLabel:'合成费用',method:'原生底稿逐项取数，日期取原件',mappings:[{inputPointer:'/voucher_date',parameterLabel:'凭证日期',transform:'identity',sources:[{path:original,jsonPointer:'/凭证日期'}]},...voucher.entries.flatMap((e,i)=>['debit','credit'].filter(field=>Number(e[field])!==0).map(field=>({inputPointer:`/entries/${i}/${field}`,parameterLabel:'原生分录金额',transform:'identity',sources:[{calculation:reference(i,field)}]})))]}};
 await t.test('真实 MCP→HTTP 写账通过，后端不依赖 FINANCE_DATABASE_PATH 环境猜实际库',async()=>{
  const posted=await client.call('voucher_create',args);assert(!posted.isError,JSON.stringify(posted));const envelope=posted.structuredContent??JSON.parse(posted.content[0].text);assert(validateModelEnvelope(envelope).ok,JSON.stringify(envelope));assert.equal(envelope.ok,true);assert.equal(envelope.applied,true);assert.equal(envelope.projection.status,'posted');assert.equal(A.listVouchers(set.id,{period:'2026-03'}).filter(v=>v.status==='posted').length,1);
 });
 await t.test('账套或期间不同、伪造引用及越界引用均拒绝',()=>{
  assert.throws(()=>capture(ref,{...target,accountSetId:other.id}),{code:'finance_details_scope_conflict'});assert.throws(()=>capture(ref,{...target,period:'2026-04'}),{code:'finance_details_scope_conflict'});
  for(const artifactRef of ['finance-artifact:../workpaper.json','finance-artifact:forged/workpaper.json',ref.artifactRef.replace('workpaper.json','input.json')])assert.throws(()=>capture({...ref,artifactRef}),{code:'finance_details_reference_untrusted'});
  assert.throws(()=>capture({...ref,entryIndex:999}),{code:'finance_details_amount_missing'});
 });
 await t.test('未配置共享审计根不会接受请求自带路径',()=>{delete process.env.FINANCE_AUDIT_DIR;try{assert.throws(()=>capture({...ref,auditDir}),{code:'finance_details_audit_root_required'});}finally{process.env.FINANCE_AUDIT_DIR=auditDir;}});
 const mutate=(path,fn,check)=>{const old=readFileSync(path);try{writeFileSync(path,fn(old));check();}finally{writeFileSync(path,old);}};
 await t.test('原件变化与底稿变化分别拒绝',()=>{
  mutate(original,b=>Buffer.concat([b,Buffer.from('\n')]),()=>assert.throws(capture,{code:'finance_details_source_changed'}));
  mutate(artifactPath,b=>Buffer.concat([b,Buffer.from('\n')]),()=>assert.throws(capture,{code:'finance_details_artifact_changed'}));
 });
 await t.test('失败调用、错误签发工具、记录摘要破损均拒绝',()=>{
  const endPath=join(auditDir,callId,'end.json'),beginPath=join(auditDir,callId,'begin.json');
  mutate(endPath,b=>JSON.stringify({...JSON.parse(b),status:'failed'}),()=>assert.throws(capture,{code:'finance_details_reference_untrusted'}));
  mutate(beginPath,b=>JSON.stringify({...JSON.parse(b),tool:'voucher_create'}),()=>assert.throws(capture,{code:'finance_details_reference_untrusted'}));
  mutate(join(auditDir,callId,'result.json'),b=>Buffer.concat([b,Buffer.from('\n')]),()=>assert.throws(capture,{code:'finance_details_record_changed'}));
 });
 await t.test('未允许工具即使重算记录摘要也不成为计算签发者',()=>{
  const beginPath=join(auditDir,callId,'begin.json'),endPath=join(auditDir,callId,'end.json');
  mutate(beginPath,b=>JSON.stringify({...JSON.parse(b),tool:'voucher_create'}),()=>mutate(endPath,b=>JSON.stringify({...JSON.parse(b),beginSha256:hash(readFileSync(beginPath))}),()=>assert.throws(capture,{code:'finance_details_reference_untrusted'})));
 });
 await t.test('规则版本、数据库实例与有效期独立核验',()=>{
  const beginPath=join(auditDir,callId,'begin.json'),endPath=join(auditDir,callId,'end.json'),resultPath=join(auditDir,callId,'result.json');
  mutate(endPath,b=>JSON.stringify({...JSON.parse(b),ruleVersion:'伪造规则版本'}),()=>assert.throws(capture,{code:'finance_details_record_changed'}));
  mutate(beginPath,b=>JSON.stringify({...JSON.parse(b),startedAt:'2020-01-01T00:00:00Z'}),()=>mutate(endPath,b=>JSON.stringify({...JSON.parse(b),beginSha256:hash(readFileSync(beginPath))}),()=>assert.throws(capture,{code:'finance_details_reference_expired'})));
  const old=[artifactPath,resultPath,endPath].map(path=>[path,readFileSync(path)]);
  try{
   const fakePaper=JSON.parse(old[0][1]);fakePaper.scope.databaseInstanceId='synthetic-wrong-instance';writeFileSync(artifactPath,JSON.stringify(fakePaper));
   const fakeResult=JSON.parse(old[1][1]);fakeResult.evidence.result.sha256=hash(readFileSync(artifactPath));fakeResult.evidence.result.bytes=readFileSync(artifactPath).length;writeFileSync(resultPath,JSON.stringify(fakeResult));
   const fakeEnd=JSON.parse(old[2][1]);fakeEnd.scope.databaseInstanceId=fakePaper.scope.databaseInstanceId;fakeEnd.output.sha256=hash(readFileSync(resultPath));fakeEnd.output.bytes=readFileSync(resultPath).length;writeFileSync(endPath,JSON.stringify(fakeEnd));
   assert.throws(capture,{code:'finance_details_scope_conflict'});
  }finally{for(const [path,b] of old)writeFileSync(path,b);}
 });
 await t.test('硬链接产物拒绝读取',()=>{const link=join(root,'底稿硬链接');linkSync(artifactPath,link);try{assert.throws(capture,{code:'finance_details_source_invalid'});}finally{unlinkSync(link);}});
 await t.test('来源变化之后 HTTP 正式写入拒绝且已入账数量不增',async()=>{
  const old=readFileSync(original);try{writeFileSync(original,Buffer.concat([old,Buffer.from('\n')]));const response=await fetch(server.url+'/agent/model-tools/voucher_create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)}),out=await response.json();assert(validateModelEnvelope(out).ok,JSON.stringify(out));assert.equal(out.ok,false);assert.equal(A.listVouchers(set.id,{period:'2026-03'}).filter(v=>v.status==='posted').length,1);}finally{writeFileSync(original,old);}
 });
 console.log(`合成跨进程证据目录：${root}`);
});
