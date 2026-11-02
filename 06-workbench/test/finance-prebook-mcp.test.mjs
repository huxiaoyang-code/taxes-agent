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
 try{await client.initialize();const tools=(await client.rpc('tools/list')).result.tools;assert(tools.some(t=>t.name==='finance_prebook_review'));const contract=await client.call('finance_record_contract',{recordType:'prebook'});assert.equal(contract.isError,false);assert.equal(contract.data.inputSchema.properties.facts.properties.taxpayer.properties.vatStatus.enum.join(','),'general,small,unknown');
  const input=writePrebookFixture(root,prebookFacts(),'normal');const response=await client.call('finance_prebook_review',{inputPath:input.inputPath});assert.equal(response.isError,false,response.text);assert.equal(response.data.tax.amounts.due,1200);assert(readFileSync(response.data.evidence.reviewPath,'utf8').includes('账前资料核对'));assert.equal(readFileSync(sentinel,'utf8'),'SYNTHETIC NO DATABASE ACCESS');
  for(const privateText of ['SUPPLIER-A','SYNTHETIC-ENTERPRISE','INPUT-001',input.originalPath])assert(!JSON.stringify(response).includes(privateText));
  const invalid=await client.call('finance_prebook_review',{inputPath:'PRIVATE-INVALID-PATH'});assert.equal(invalid.isError,true);assert(!invalid.text.includes('PRIVATE-INVALID-PATH'));
  const tampered=writePrebookFixture(root,prebookFacts(),'bad');const raw=JSON.parse(readFileSync(tampered.inputPath));raw.facts.sales[0].netAmount='999.00';writeFileSync(tampered.inputPath,JSON.stringify(raw));const mismatch=await client.call('finance_prebook_review',{inputPath:tampered.inputPath});assert.equal(mismatch.isError,true);assert.match(mismatch.text,/finance_prebook_source_value_mismatch/);
  const ends=readdirSync(audit,{withFileTypes:true}).filter(e=>e.isDirectory()&&e.name!=='prebook').map(e=>JSON.parse(readFileSync(join(audit,e.name,'end.json'),'utf8')));assert(ends.filter(e=>e.status==='failed').length>=2);assert(ends.some(e=>e.businessOutcome==='ready_for_bookkeeping_review'));assert.equal(readFileSync(sentinel,'utf8'),'SYNTHETIC NO DATABASE ACCESS');
 }finally{await client.close();}
});
