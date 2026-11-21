import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {listAgencyRules,getAgencyRuleDetail} from '../server/agency-rule-catalog.mjs';
import {callDirectFinanceTool} from '../server/direct-finance.mjs';
import {readFinanceCall} from '../server/finance-call-chain.mjs';

test('在线策略查询只保存准许外发的参数，拒绝项不进入审计文件或返回值',async()=>{
 const root=mkdtempSync(join(tmpdir(),'finance-policy-audit-'));
 const audit=join(root,'audit');
 const marker='SYNTH_AUDIT_PRIVATE';
 const article='https://www.gov.cn/zhengce/synthetic-example.htm';
 const client=new McpStdioClient(fileURLToPath(new URL('./helpers/official-policy-stdio.mjs',import.meta.url)),{
  cwd:root,env:{FINANCE_MCP_PROFILE:'direct',FINANCE_AUDIT_DIR:audit,FINANCE_DATABASE_PATH:join(root,marker+'.db'),FINANCE_API_BASE:'http://127.0.0.1:1/'+marker}
 }).start();
 const call=async args=>{
  const {result}=await client.rpc('tools/call',{name:'finance_rules',arguments:args});
  assert.ok(!JSON.stringify(result).includes(marker));
  const record=await readFinanceCall({auditDir:audit,callId:result._meta.financeCall.callId});
  assert.equal(record.integrity,'verified');
  assert.deepEqual(record.begin.scope,{});
  assert.equal(record.begin.configuredTarget,null);
  assert.deepEqual(record.end.scope,{});
  assert.deepEqual(record.begin.sources,[]);
  return {result,record};
 };
 try{
  await client.initialize();
  const rejected=[
   {action:'open',url:article+'?token='+marker},
   {action:'open',url:'https://user:'+marker+'@www.gov.cn/zhengce/test.htm'},
   {action:'search',query:'密码：'+marker},{action:'search',query:'客户名称：'+marker},
   {action:'search',query:'合成政策',target:{accountSetId:1,enterpriseKey:marker},scope:{enterpriseKey:marker}},
   {action:'search',query:'合成政策',businessEvidence:{mappings:[{parameterLabel:marker}]}},
   {action:marker,url:article},{query:'合成查询 '+marker},{[marker]:marker,sourcePath:marker}
  ];
  for(const args of rejected){
   const {result,record}=await call(args);
   assert.equal(result.isError,true);
   assert.deepEqual(record.input,{inputRedacted:true});
   assert.equal(record.output.inputRedacted,true);
   assert.equal(result.structuredContent.source,undefined);
  }
  assert.equal(existsSync(join(root,'requests.jsonl')),false);
  const search=await call({action:'search',query:'  合成政策  ',page:1,limit:1});
  assert.equal(search.result.isError,undefined);
  assert.deepEqual(search.record.input,{action:'search',query:'合成政策',page:1,limit:1});
  const open=await call({action:'open',url:article+'#'+marker,limit:12});
  assert.equal(open.result.structuredContent.status,'read');
  assert.deepEqual(open.record.input,{action:'open',url:article,limit:12});
  assert.equal(open.record.output.source.url,article);
  for(const file of readdirSync(audit,{recursive:true}).filter(path=>path.endsWith('.json'))){
   assert.ok(!readFileSync(join(audit,file),'utf8').includes(marker),file);
  }
  assert.ok(!readFileSync(join(root,'requests.jsonl'),'utf8').includes(marker));
 }finally{await client.close();}
});

test('直接分派也按工具合同拒绝混入账套或漏选线上操作的参数',async()=>{
 for(const args of [{query:'合成政策'},{action:'open',url:'https://www.gov.cn/',accountSetId:1}]){
  await assert.rejects(callDirectFinanceTool('finance_rules',args),{code:'finance_input_invalid'});
 }
});

test('默认 MCP 搜公开政策、读官方原文并保留本机规则复算', {timeout:30000}, async()=>{
 const root=mkdtempSync(join(tmpdir(),'finance-policy-mcp-'));
 const database=join(root,'SYNTHETIC-PRIVATE-ENTERPRISE.db'), audit=join(root,'audit');
 const client=new McpStdioClient(fileURLToPath(new URL('./helpers/official-policy-stdio.mjs',import.meta.url)),{
  cwd:root,env:{FINANCE_MCP_PROFILE:'direct',FINANCE_AUDIT_DIR:audit,FINANCE_DATABASE_PATH:database,FINANCE_SOURCE_ROOT:root,FINANCE_API_BASE:'http://127.0.0.1:1'}
 }).start();
 const call=(args)=>client.call('finance_rules',args);
 const networkLog=join(root,'requests.jsonl');
 try{
  const init=await client.initialize();
  assert.equal(init.result.protocolVersion,'2025-06-18');
  const spec=(await client.rpc('tools/list')).result.tools.find(tool=>tool.name==='finance_rules');
  assert.equal(spec.annotations.readOnlyHint,true);
  assert.equal(spec.annotations.openWorldHint,true);
  assert.match(spec.description,/action=search/);
  assert.match(spec.description,/action=open/);
  const skill=await client.call('skills_read',{resource:'tax-review/references/official-policy.md'});
  assert.match(skill.data.markdown,/expectedSha256/);
  assert.match(skill.data.markdown,/核查日期/);

  const catalog=await call({});
  assert.deepEqual(catalog.data,listAgencyRules());
  const {ruleId,revision}=catalog.data.rules[0];
  assert.deepEqual((await call({ruleId,revision,filters:{limit:1}})).data,getAgencyRuleDetail(ruleId,revision));
  assert.deepEqual((await call({revision,filters:{limit:1}})).data,listAgencyRules({limit:1}));

  for(const args of [
   {query:'合成政策'},{action:'search',query:'合成政策',ruleId},{action:'search',query:'合成政策',url:'https://www.gov.cn/'},
   {action:'open',url:'https://www.gov.cn/',page:2},{action:'search',query:'合成政策',limit:21},
   {action:'search',query:'合成政策',target:{accountSetId:1}},{action:'search',query:'合成政策',originals:[{path:database}]},
   {action:'search',query:'合成政策',businessEvidence:{}},{action:'open',url:'https://www.gov.cn/',expectedSha256:'bad'},
   {action:'search',query:'合成政策','SYNTHETIC-PRIVATE-ENTERPRISE':'private'}
  ]){
   const invalid=await call(args);
   assert.equal(invalid.isError,true,invalid.text);
   assert.equal(invalid.data.error,'invalid_arguments');
   assert.match(invalid.text,/choose_policy_operation/);
   assert.ok(!invalid.text.includes('SYNTHETIC-PRIVATE-ENTERPRISE'));
  }
  const privateTerm=await call({action:'search',query:database});
  assert.equal(privateTerm.isError,true,privateTerm.text);
  assert.equal(privateTerm.data.error,'invalid_arguments');
  assert.ok(!privateTerm.text.includes(database));
  const forbidden=await client.rpc('tools/call',{name:'finance_rules',arguments:{action:'search',query:'合成政策',sourcePath:database}});
  const deniedRecord=join(audit,forbidden.result._meta.financeCall.callId);
  assert.equal(forbidden.result.isError,true);
  assert.deepEqual(JSON.parse(readFileSync(join(deniedRecord,'begin.json'),'utf8')).sources,[]);
  assert.equal(existsSync(join(deniedRecord,'business-evidence.json')),false);
  assert.equal(existsSync(networkLog),false);
  const found=await call({action:'search',query:'合成政策',page:1,limit:2});
  assert.equal(found.isError,false,found.text);
  assert.equal(found.data.status,'results',found.text);
  assert.ok(found.data.providers.every(source=>source.status==='searched'),found.text);
  const hit=found.data.results.find(row=>row.title==='合成税务公告');
  assert.equal(hit?.url,'https://www.gov.cn/zhengce/synthetic-example.htm');
  assert.equal(found.text.includes('第一条 合成条文'),false);
  const raw=await client.rpc('tools/call',{name:'finance_rules',arguments:{action:'open',url:hit.url,limit:6}});
  const first=raw.result.structuredContent;
  assert.equal(first.status,'read',JSON.stringify(first));
  assert.equal(first.source.title,hit.title);
  assert.equal(first.source.url,hit.url);
  assert.match(first.source.sha256,/^[a-f0-9]{64}$/);
  assert.ok(first.nextOffset>0);
  const recorded=JSON.parse(readFileSync(join(audit,raw.result._meta.financeCall.callId,'result.json'),'utf8'));
  assert.equal(recorded.source.sha256,first.source.sha256);
  const rest=await call({action:'open',url:hit.url,offset:first.nextOffset,expectedSha256:first.source.sha256});
  assert.equal(rest.isError,false,rest.text);
  assert.match(first.text+rest.data.text,/第一条 合成条文仅供程序验证/);
  const attachment=await call({action:'open',url:first.attachments[0].url});
  assert.equal(attachment.data.status,'attachment_unread',attachment.text);
  assert.equal(attachment.data.text,undefined);
  const stale=await call({action:'open',url:hit.url,offset:first.nextOffset,expectedSha256:'0'.repeat(64)});
  assert.equal(stale.isError,true,stale.text);
  assert.notEqual(stale.data.status,'read');
  const empty=await call({action:'search',query:'合成无匹配'});
  assert.equal(empty.isError,false,empty.text);
  assert.equal(empty.data.status,'no_results');
  assert.deepEqual(empty.data.results,[]);
  const partial=await call({action:'search',query:'合成部分来源'});
  assert.equal(partial.isError,false,partial.text);
  assert.equal(partial.data.status,'partial');
  assert.ok(partial.data.providers.some(source=>source.status==='unavailable'));
  assert.ok(partial.data.results.some(row=>row.url===hit.url));
  const offline=await call({action:'search',query:'合成断网'});
  assert.equal(offline.isError,true,offline.text);
  assert.equal(offline.data.status,'unavailable');
  assert.deepEqual(offline.data.results,[]);
  assert.ok(!offline.text.includes(catalog.data.catalogDigest));
  const requests=readFileSync(networkLog,'utf8');
  const requestedHosts=new Set(requests.trim().split('\n').map(row=>new URL(JSON.parse(row).url).hostname));
  for(const source of ['sousuo.www.gov.cn','search.mof.gov.cn','www.chinatax.gov.cn'])assert.ok(requestedHosts.has(source),source);
  for(const value of [database,'SYNTHETIC-PRIVATE-ENTERPRISE','accountSetId','businessEvidence','localhost','127.0.0.1'])assert.ok(!requests.includes(value),value);
  assert.equal(existsSync(database),false);
 }finally{await client.close();}
});
