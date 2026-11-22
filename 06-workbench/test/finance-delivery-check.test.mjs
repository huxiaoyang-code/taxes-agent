import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {createContext,writeBundle} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../05-reconstruction/codex/hosts/dsh/adapter.mjs';
import {prepareBoundBusinessSession} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {createSyntheticFixture} from './helpers/business-memory-e2e-fixture.mjs';

test('在真实 MCP 读回合成导出小计、已解释事项及次月交接，修复后再次评分',async()=>{
 const root=mkdtempSync(join(tmpdir(),'delivery-review-')),sourceRoot=join(root,'originals'),databasePath=join(root,'books.db');
 mkdirSync(sourceRoot);
 const db=new DatabaseSync(databasePath);
 db.exec(`CREATE TABLE account_sets(id INTEGER); INSERT INTO account_sets VALUES(1);
 CREATE TABLE audit_database_instances(instance_id TEXT,is_active INTEGER);INSERT INTO audit_database_instances VALUES('98765432-1234-4234-8234-123456789abc',1);
 CREATE TABLE import_enterprise_account_sets(account_set_id INTEGER,enterprise_key TEXT);INSERT INTO import_enterprise_account_sets VALUES(1,'synthetic');
 CREATE TABLE accounts(account_set_id,code,name,category,direction,contra);INSERT INTO accounts VALUES(1,'1002','银行','资产','debit',0),(1,'2202','应付','负债','credit',0);
 CREATE TABLE opening_balances(account_set_id,code,debit,credit);INSERT INTO opening_balances VALUES(1,'1002',20,0),(1,'2202',0,20);
 CREATE TABLE vouchers(id,account_set_id,period,kind,status);INSERT INTO vouchers VALUES(1,1,'2026-09','ordinary','posted'),(2,1,'2026-10','ordinary','posted');
 CREATE TABLE voucher_entries(voucher_id,line_no,code,debit,credit);INSERT INTO voucher_entries VALUES(1,1,'1002',0,3),(1,2,'2202',3,0),(2,1,'1002',0,2),(2,2,'2202',2,0);`);
 db.close();
 const context=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath,sourceRoot,outputDir:join(root,'host')});
 writeBundle(context,buildConfig(context));
 const target={accountSetId:1,period:'2026-10'};
 await prepareBoundBusinessSession(context.outputDir,target);
 const balanceFile='2026-10_余额.csv',handoffFile='交接.md',outputs=join(context.outputDir,'outputs');
 const balance='科目编码,期初方向,期初余额,本期借方,本期贷方,期末方向,期末余额\n1002,借,17,0,2,借,15\n2202,贷,17,2,0,贷,15\n资产小计,借,17,0,2,借,15\n负债小计,贷,17,2,0,贷,15\n';
 writeFileSync(join(outputs,balanceFile),balance.replace('小计,借,17,0,2','小计,借,17,0,4'));
 mkdirSync(join(sourceRoot,'客户原件'));
 writeFileSync(join(sourceRoot,'客户原件','银行.csv'),'业务标识,金额\nTX1020,2\n');
 const handoff='2026-10 核对。2026-11 承接。\n已解释 客户原件/银行.csv TX1020 以前期回执核销。';
 writeFileSync(join(outputs,handoffFile),handoff);
 const request={balanceFile,handoffFile,references:[{file:'客户原件/银行.csv',line:2,id:'TX1020',disposition:'explained'}]};
 const client=new McpStdioClient(context.serverPath,{env:context.mcpEnv}).start();
 try{
  await client.initialize();
  async function check(deliveryCheck){const r=await client.call('finance_period_review',{target,deliveryCheck});assert.equal(r.isError,false,JSON.stringify(r.data));assert.equal(r.data.periodComplete,false);return r.data.delivery;}
  const first=await check(request);
  assert.equal(first.status,'needs_repair');
  assert.deepEqual(first.issues.map(i=>[i.line,i.field]),[[4,'本期贷方']]);
  writeFileSync(join(outputs,balanceFile),balance);
  const repaired=await check(request);
  assert.equal(repaired.status,'checked');assert.equal(repaired.verifiedReferences,1);assert.notEqual(first.digests.balance,repaired.digests.balance);
  const reference=request.references[0];
  writeFileSync(join(outputs,handoffFile),handoff.replace('TX1020','TX10'));
  assert.equal((await check({...request,references:[{...reference,id:'TX10'}]})).status,'needs_repair');
  writeFileSync(join(outputs,handoffFile),handoff+' 实付9999元');
  assert.equal((await check(request)).status,'needs_repair');
  for(const claim of ['实付-2元','实付2万元','实付2万','实付2亿元','实付2美元']){
   writeFileSync(join(outputs,handoffFile),handoff+' '+claim);
   const wrong=await check({...request,references:[{...reference,amounts:[{column:'金额',value:'2.00'}]}]});
   assert.equal(wrong.status,'needs_repair',claim);
  }
  writeFileSync(join(outputs,handoffFile),handoff+' 实付+2元');
  assert.equal((await check({...request,references:[{...reference,amounts:[{column:'金额',value:'2.00'}]}]})).status,'checked');
  writeFileSync(join(outputs,handoffFile),handoff);
  assert.equal((await check({...request,references:[]})).status,'partial');
  writeFileSync(join(outputs,handoffFile),handoff+'\n待办 TX1001 2026-11 缺回单影响应付核销');
  assert.equal((await check(request)).issues[0].code,'handoff_item_reference_missing');
  assert.equal((await check({...request,missingMaterials:[{id:'TX1001',period:'2026-11',impact:'缺回单影响应付核销'}]})).status,'needs_materials');
  writeFileSync(join(outputs,handoffFile),handoff.replace('已解释','待办'));
  assert.equal((await check(request)).status,'needs_repair');
  assert.equal((await check({...request,references:[{...request.references[0],disposition:'outstanding'}]})).status,'needs_materials');
  assert.equal((await check({...request,balanceFile:'../2026-10_余额.csv'})).status,'needs_repair');
 }finally{await client.close();}
});

test('读回原生余额表的主体、所属期、双边金额、本年合计和试算勾稽',async t=>{
 const f=createSyntheticFixture(),target={accountSetId:f.a,period:'2026-10'};
 const oldDir=process.env.WORKBENCH_DATA_DIR;
 process.env.WORKBENCH_DATA_DIR=f.data;
 t.after(()=>{if(oldDir===undefined)delete process.env.WORKBENCH_DATA_DIR;else process.env.WORKBENCH_DATA_DIR=oldDir;});
 const {buildReportExport}=await import('../server/report-export.mjs');
 const {db}=await import('../server/db.mjs');t.after(()=>db.close());
 const {ensurePeriod}=await import('../server/accounting.mjs');ensurePeriod(f.b,target.period);
 const report=(id,period)=>buildReportExport(id,{kind:'trial-balance',period});
 const actual=report(f.a,target.period),other=report(f.b,target.period),prior=report(f.a,'2026-09');
 const context=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:f.dbPath,sourceRoot:f.sourceA,outputDir:join(f.root,'native-export-review')});
 writeBundle(context,buildConfig(context));await prepareBoundBusinessSession(context.outputDir,target);
 const outputs=join(context.outputDir,'outputs'),handoffFile='交接.md',balanceFile=actual.filename;
 writeFileSync(join(f.sourceA,'原始账款.csv'),'业务标识,金额\nSYNTH-777,777.00\n');
 writeFileSync(join(outputs,handoffFile),'2026-10 至 2026-11\n已解释 原始账款.csv SYNTH-777');
 const req={balanceFile,handoffFile,references:[{file:'原始账款.csv',line:2,id:'SYNTH-777',disposition:'explained'}]};
 const client=new McpStdioClient(context.serverPath,{env:context.mcpEnv}).start();
 t.after(()=>client.close());await client.initialize();
 async function check(body){
  writeFileSync(join(outputs,balanceFile),body);
  const r=await client.call('finance_period_review',{target,deliveryCheck:req});
  assert.equal(r.isError,false,r.text);return r.data.delivery;
 }
 const initial=await check(actual.body);
 assert.equal(initial.status,'checked',JSON.stringify(initial.issues));assert.equal(initial.accounts,actual.report.data.lines.length);
 assert((await check(other.body)).issues.some(i=>i.field==='账套ID'));
 assert((await check(prior.body)).issues.some(i=>i.field==='期间'));
 const lines=actual.body.split('\r\n');
 function mutation(label,column,expected,replacement){
  const index=lines.findIndex(l=>l.startsWith('"'+label+'",'));
  assert(index>=0);
  const fields=lines[index].split(',');
  assert.equal(fields[column],expected);
  fields[column]=replacement;
  return {body:lines.with(index,fields.join(',')).join('\r\n'),line:index+1};
 }
 for(const [label,column,expected,field] of [
  ['1122',3,'4500.00','期初借方'],['1122',5,'777.00','本期借方'],['500101',8,'5277.00','本年贷方'],
  ['合计',10,'5277.00','期末贷方'],['本年累计',1,'5277.00','本年累计借方']]){
  const change=mutation(label,column,expected,'12.34'),result=await check(change.body);
  assert.equal(result.status,'needs_repair');
  assert.deepEqual(result.issues.map(i=>[i.line,i.field]),[[change.line,field]]);
 }
 const omitted=lines.filter(l=>!l.startsWith('"1001",')).join('\r\n');
 assert((await check(omitted)).issues.some(i=>i.code==='balance_account_omitted'&&i.accountCode==='1001'));
 assert((await check(lines.filter(l=>!l.startsWith('"合计",')).join('\r\n'))).issues.some(i=>i.code==='balance_total_missing_or_duplicate'));
 assert.equal((await check(actual.body)).status,'checked');
});
