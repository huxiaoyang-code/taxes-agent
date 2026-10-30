// 真实MCP协议接线与拒绝留痕；只用临时目录，不调用模型或真实业务库。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';

test('汇总工具在direct面按合同原生注册，字段拒绝不反射私密属性且自动留痕',{timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'finance-summary-mcp-')),auditDir=join(root,'records'),repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
 process.env.WORKBENCH_DATA_DIR=join(root,'data');const A=await import(pathToFileURL(join(repo,'06-workbench/server/accounting.mjs')).href),{db}=await import(pathToFileURL(join(repo,'06-workbench/server/db.mjs')).href);let accountSetId;try{accountSetId=A.createAccountSet({name:'Synthetic safe diagnostics',start_period:'2026-03',profileId:'small-2011-basic-v1',enterprise:{enterpriseKey:'SYNTHETIC-DIAGNOSTICS'}}).id;}finally{db.close();}
 const original=join(root,'PRIVATE-SOURCE-FILE.json'),inputs={profitTotalYtd:12000,validPriorYearLossOffset:2000,otherPrepaymentAdjustments:0,prepaidThisYear:0};writeFileSync(original,JSON.stringify({...inputs,privateName:'PRIVATE-NEVER-RETURN'}));
 const client=new McpStdioClient(join(repo,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{cwd:repo,env:{FINANCE_MCP_PROFILE:'direct',FINANCE_AUDIT_DIR:auditDir,FINANCE_DATABASE_PATH:join(root,'data/workbench.db'),FINANCE_API_BASE:'http://127.0.0.1:9',NODE_NO_WARNINGS:'1'}}).start();
 try{
  await client.initialize('synthetic-summary-integration');const tools=(await client.rpc('tools/list')).result.tools,tool=tools.find(t=>t.name==='finance_tax_summary_calculate');assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,true);assert(!tools.some(t=>t.name.startsWith('harness_')));
  const contract=await client.call('finance_record_contract',{recordType:'tax_summary'});assert.equal(contract.isError,false,contract.text);assert.equal(contract.structured.recordType,'tax_summary');assert.ok(contract.structured.kinds.includes('cit_prepayment'));assert.ok(contract.structured.kinds.includes('salary_pit_cumulative'));
  const rejected=await client.call('finance_tax_summary_calculate',{target:{accountSetId:1,period:'2026-03'},kind:'cit_prepayment',originals:[],inputs:{'PRIVATE-UNSAFE-KEY':'PRIVATE-UNSAFE-VALUE'},bindings:[]});assert.equal(rejected.isError,true);assert(!JSON.stringify(rejected).includes('PRIVATE-UNSAFE-KEY'));assert(!JSON.stringify(rejected).includes('PRIVATE-UNSAFE-VALUE'));
  const args={target:{accountSetId,period:'2026-03'},kind:'cit_prepayment',originals:[{id:'source',path:original}],inputs:{...inputs,validPriorYearLossOffset:9999},bindings:Object.keys(inputs).map(key=>({inputPointer:'/'+key,originalId:'source',locator:{jsonPointer:'/'+key},transform:'decimal'}))};
  const wrong=await client.call('finance_tax_summary_calculate',args);assert.equal(wrong.isError,true);const diagnostics=wrong.structured?.details?.safeDiagnostics??wrong.data?.details?.safeDiagnostics;assert.equal(diagnostics?.version,'finance-summary-diagnostics/1',wrong.text);assert.ok(diagnostics.problems.some(row=>row.inputPointer==='/validPriorYearLossOffset'));for(const secret of ['PRIVATE-SOURCE-FILE','PRIVATE-NEVER-RETURN','9999'])assert(!JSON.stringify(wrong).includes(secret));
  const recovered=await client.call('finance_tax_summary_calculate',{...args,inputs});assert.equal(recovered.isError,false,recovered.text);assert.equal(recovered.structured.status,'conditional_calculated');
 }finally{await client.close();}
 const rows=readdirSync(auditDir).filter(name=>/^\d{8}T/.test(name));assert.equal(rows.length,4);const refused=rows.map(id=>JSON.parse(readFileSync(join(auditDir,id,'begin.json')))).find(row=>row.tool==='finance_tax_summary_calculate');assert.ok(refused);const end=JSON.parse(readFileSync(join(auditDir,refused.callId,'end.json')));assert.equal(end.status,'failed');
});
