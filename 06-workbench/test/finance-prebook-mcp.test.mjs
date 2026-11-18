// 实际stdio工具发现、失败自动留痕与敏感原值投影验证；不启动模型或HTTP。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {prebookFacts,writePrebookFixture} from './helpers/prebook-fixture.mjs';
const root=mkdtempSync(join(tmpdir(),'prebook-mcp-synthetic-')),audit=join(root,'audit'),sentinel=join(root,'never-opened.db');writeFileSync(sentinel,'SYNTHETIC NO DATABASE ACCESS');
test('direct MCP可发现账前合同，真实调用不触碰账库、异常有自动记录',{timeout:30000},async()=>{
 const client=new McpStdioClient(fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url)),{cwd:root,env:{FINANCE_MCP_PROFILE:'direct',FINANCE_SOURCE_ROOT:root,FINANCE_AUDIT_DIR:audit,FINANCE_DATABASE_PATH:sentinel,FINANCE_API_BASE:'http://127.0.0.1:1'}}).start();
 try{await client.initialize();const tools=(await client.rpc('tools/list')).result.tools;
  for(const name of ['finance_baseline_materials','finance_prebook_review'])assert.equal(Object.hasOwn(tools.find(t=>t.name===name).inputSchema.properties,'businessEvidence'),false);
  for(const name of ['finance_baseline_read','finance_baseline_save']){
   assert(!tools.some(tool=>tool.name===name));
   const removed=await client.call(name,{target:{accountSetId:1,period:'2026-03'}});
   assert(removed.isError,removed.text);assert.equal(removed.data.error,'unknown_tool');
  }
  assert(Object.hasOwn(tools.find(t=>t.name==='finance_calculation_run').inputSchema.properties,'businessEvidence'));
  const contract=await client.call('finance_record_contract',{recordType:'prebook'});assert.equal(contract.isError,false);assert.equal(contract.data.inputSchema.properties.version.const,'finance-prebook-input/2');assert.equal(contract.data.inputSchema.properties.facts.properties.taxpayer.properties.vatStatus.enum.join(','),'general,small,unknown');
  const input=writePrebookFixture(root,prebookFacts(),'normal');const response=await client.call('finance_prebook_review',{inputPath:input.inputPath});assert.equal(response.isError,false,response.text);assert.equal(response.data.tax.amounts.due,1200);assert(readFileSync(response.data.evidence.reviewPath,'utf8').includes('账前资料核对'));assert.equal(readFileSync(sentinel,'utf8'),'SYNTHETIC NO DATABASE ACCESS');
  for(const privateText of ['SUPPLIER-A','SYNTHETIC-ENTERPRISE','INPUT-001',input.originalPath])assert(!JSON.stringify(response).includes(privateText));
  const outside=join(root,'PRIVATE-INVALID-PATH.json');writeFileSync(outside,'原件原文');
  const invalid=await client.rpc('tools/call',{name:'finance_prebook_review',arguments:{inputPath:outside}});
  assert.equal(invalid.result.isError,true);assert.equal(invalid.result.structuredContent.error,'finance_prebook_prepared_path_outside_root');assert(!JSON.stringify(invalid).includes('PRIVATE-INVALID-PATH'));
  const rejectedCall=invalid.result._meta.financeCall.callId,begin=JSON.parse(readFileSync(join(audit,rejectedCall,'begin.json'),'utf8'));
  assert.deepEqual(begin.sources,[]);
  const legacyBinding={businessLabel:'合成旁路',method:'不应运行',mappings:[{inputPointer:'/target',parameterLabel:'合成目标',transform:'identity',sources:[{path:outside,jsonPointer:''}]}]};
  const forbidden=await client.rpc('tools/call',{name:'finance_baseline_materials',arguments:{target:{accountSetId:1,period:'2026-03'},businessEvidence:legacyBinding}});
  assert.equal(forbidden.result.isError,true);assert.equal(forbidden.result.structuredContent.error,'invalid_arguments');
  const forbiddenId=forbidden.result._meta.financeCall.callId,forbiddenEnd=JSON.parse(readFileSync(join(audit,forbiddenId,'end.json'),'utf8'));
  assert.deepEqual(forbiddenEnd.loadedSources,[]);assert(!Object.hasOwn(forbiddenEnd.metadata,'businessEvidence'));
  const tampered=writePrebookFixture(root,prebookFacts(),'bad');const raw=JSON.parse(readFileSync(tampered.inputPath));raw.facts.sales[0].netAmount='999.00';writeFileSync(tampered.inputPath,JSON.stringify(raw));const mismatch=await client.call('finance_prebook_review',{inputPath:tampered.inputPath});assert.equal(mismatch.isError,true);assert.match(mismatch.text,/finance_prebook_source_value_mismatch/);
  const oldPath=join(audit,'agent-materials','legacy.json');writeFileSync(oldPath,JSON.stringify({version:'finance-prebook-input/1'}));
  const old=await client.call('finance_prebook_review',{inputPath:oldPath});assert.equal(old.isError,true);assert.equal(old.data.error,'finance_prebook_prepared_version_required');assert.deepEqual(old.data.details.nextSteps[0].arguments,{recordType:'prebook'});
  const ends=readdirSync(audit,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^\d{8}T/.test(e.name)).map(e=>JSON.parse(readFileSync(join(audit,e.name,'end.json'),'utf8')));assert(ends.filter(e=>e.status==='failed').length>=3);assert(ends.some(e=>e.businessOutcome==='ready_for_bookkeeping_review'&&e.loadedSources.some(source=>source.path===input.originalPath)));assert.equal(readFileSync(sentinel,'utf8'),'SYNTHETIC NO DATABASE ACCESS');
 }finally{await client.close();}
});
