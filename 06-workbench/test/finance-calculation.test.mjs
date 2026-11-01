// 合成资料经正常direct MCP实际运行；不启动模型，不访问真实账库。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {createContext} from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../05-reconstruction/codex/hosts/claude-code/adapter.mjs';
import {assertQuarterArguments} from '../scripts/quarter-host.mjs';
import {listFinanceCalls,readFinanceCall} from '../server/finance-call-chain.mjs';

const root=mkdtempSync(join(tmpdir(),'finance-calculation-synthetic-')),sourceRoot=join(root,'originals'),auditDir=join(root,'calls');mkdirSync(sourceRoot);
const original=join(sourceRoot,'付款明细.csv'),originalText='单据号,付款金额（元）,用途\n付01,1000.00,货款及设备\n';writeFileSync(original,originalText);
const sentinelDb=join(root,'untouched.db');writeFileSync(sentinelDb,'SYNTHETIC DO NOT OPEN DATABASE');
const py=process.env.FINANCE_PYTHON_PATH??spawnSync('python',['-c','import sys;print(sys.executable)'],{encoding:'utf8',shell:false,windowsHide:true}).stdout?.trim();
const client=new McpStdioClient(fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url)),{cwd:root,timeoutMs:20000,env:{FINANCE_MCP_PROFILE:'direct',FINANCE_SOURCE_ROOT:sourceRoot,FINANCE_AUDIT_DIR:auditDir,FINANCE_DATABASE_PATH:sentinelDb,WORKBENCH_DATA_DIR:join(root,'unused-backend'),FINANCE_API_BASE:'http://127.0.0.1:1',FINANCE_PYTHON_PATH:py??'',SYNTHETIC_SECRET:'must-not-reach-child'}});
const script=`import fs from 'node:fs';
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const rows=fs.readFileSync(input.sources[0].snapshotPath,'utf8').trim().split(/\\r?\\n/).map(row=>row.split(','));
const total=Number(rows[1][1]),goods=total*input.parameters.ratio;
const result={货款:goods,设备款:total-goods,缺少成本:input.parameters.cost??null,比较期间:input.parameters.period};
fs.writeFileSync(input.outputDir+'/中文账表.json',JSON.stringify(result,null,2));
fs.writeFileSync(input.outputDir+'/中文工作底稿.csv','项目,金额（元）\\n货款,'+goods+'\\n设备款,'+(total-goods)+'\\n成本,未知\\n');
console.log(JSON.stringify({环境未继承:!process.env.SYNTHETIC_SECRET&&!process.env.FINANCE_DATABASE_PATH}));`;
const base={title:'现金流拆分计算记录',engine:'javascript',script,sources:[{path:original}],parameters:{ratio:0.8,cost:null,period:'2025-12'},notes:['按收付用途声明的80%比例计算；比例适用性待人工核对。','成本资料未给，保持未知，不补零。']};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function tree(path,prefix=''){return Object.fromEntries(readdirSync(path,{withFileTypes:true}).flatMap(e=>e.isDirectory()?Object.entries(tree(join(path,e.name),prefix+e.name+'/')):[[prefix+e.name,sha(readFileSync(join(path,e.name)))]]));}
test('正常direct发现与无账套/HTTP的真实JS、Python计算、失败、修订及留证',{timeout:60000},async t=>{
 client.start();await client.initialize();
 try{
  const tools=(await client.rpc('tools/list')).result.tools,spec=tools.find(t=>t.name==='finance_calculation_run');assert(spec);assert.deepEqual(spec.annotations,{readOnlyHint:false,destructiveHint:true,openWorldHint:true,idempotentHint:false});
  let first;
  await t.test('比例拆分和未知值实际执行，原始表头与派生产物分别留证',async()=>{
   const response=await client.call('finance_calculation_run',base);assert.equal(response.isError,false,response.text);first=response.data;
   assert.equal(first.status,'executed');assert.equal(first.kind,'derived_calculation');assert.equal(first.businessStatus,'unreviewed');
   const output=JSON.parse(readFileSync(first.outputs.find(o=>o.path.endsWith('.json')).path));assert.deepEqual(output,{货款:800,设备款:200,缺少成本:null,比较期间:'2025-12'});
   const record=JSON.parse(readFileSync(first.recordPath));assert.deepEqual(record.sources[0].structure.headers,[['单据号','付款金额（元）','用途']]);assert.equal(record.sources[0].kind,'source_snapshot');assert.equal(record.execution.exitCode,0);assert(record.execution.durationMs>=0);assert.match(record.runtime.version,/v\d+/);assert.equal(record.sourceChecks[0].sourceUnchanged,true);
   const dir=resolve(first.recordPath,'..');assert.equal(readFileSync(join(dir,'script.mjs'),'utf8'),script);assert.equal(JSON.parse(readFileSync(join(dir,'input.json'))).parameters.cost,null);assert.equal(JSON.parse(readFileSync(join(dir,'stdout.txt'))).环境未继承,true);assert.equal(readFileSync(original,'utf8'),originalText);assert.equal(readFileSync(sentinelDb,'utf8'),'SYNTHETIC DO NOT OPEN DATABASE');
   const html=readFileSync(first.reviewPath,'utf8');assert.match(html,/执行成功不代表业务已核/);assert.match(html,/付款金额（元）/);assert.match(html,/中文工作底稿/);
   const calls=await listFinanceCalls({auditDir}),call=await readFinanceCall({auditDir,callId:calls.calls.find(c=>c.tool==='finance_calculation_run').callId});assert.equal(call.output.runId,first.runId);assert(call.end.metadata.artifactRefs.includes(first.recordPath));assert.equal(record.executionFileChecks.every(c=>c.unchanged),true);
  });
  await t.test('修订只追加新版本，旧脚本和所有旧产物不变，伪引用拒绝',async()=>{
   const oldDir=resolve(first.recordPath,'..'),before=tree(oldDir),response=await client.call('finance_calculation_run',{...base,rerunOf:first.runId,parameters:{...base.parameters,ratio:0.7}});assert.equal(response.isError,false,response.text);assert.notEqual(response.data.runId,first.runId);assert.deepEqual(tree(oldDir),before);
   const newer=JSON.parse(readFileSync(response.data.recordPath));assert.equal(newer.rerunOf.runId,first.runId);assert.equal(newer.rerunOf.recordSha256,sha(readFileSync(first.recordPath)));assert.equal(JSON.parse(readFileSync(response.data.outputs.find(o=>o.path.endsWith('.json')).path)).货款,700);
   const absent=await client.call('finance_calculation_run',{...base,rerunOf:'00000000-0000-0000-0000-000000000000'});assert.equal(absent.isError,true);assert.match(absent.text,/finance_calculation_previous_missing/);
  });
  await t.test('脚本失败保留实际错误与已写文件，超时单独记录',async()=>{
   const response=await client.call('finance_calculation_run',{...base,script:`import fs from 'node:fs';const i=JSON.parse(fs.readFileSync(process.argv[2]));fs.writeFileSync(i.outputDir+'/部分结果.txt','已计算部分');console.error('缺少采购事实，停止计算');throw Error('synthetic missing input');`});assert.equal(response.isError,true);assert.equal(response.data.status,'failed');assert.equal(response.data.outputs.length,1);const record=JSON.parse(readFileSync(response.data.recordPath));assert.notEqual(record.execution.exitCode,0);assert.match(readFileSync(join(resolve(response.data.recordPath,'..'),'stderr.txt'),'utf8'),/缺少采购事实/);
   const timeout=await client.call('finance_calculation_run',{title:'超时合成检查',engine:'javascript',script:'while(true){}',sources:[],timeoutMs:100});assert.equal(timeout.isError,true);assert.equal(JSON.parse(readFileSync(timeout.data.recordPath)).execution.reason,'timeout');
  });
  await t.test('Python可用时经同一入口真实执行，纯计算无需原件或账套',async t=>{
   if(!py){t.skip('当前环境未提供Python；不是Python通过证明。');return;}
   const response=await client.call('finance_calculation_run',{title:'Python中文表计算',engine:'python',sources:[],parameters:{amount:'1000',ratio:'0.25',missing:null},script:`import json,sys\nfrom decimal import Decimal\nfrom pathlib import Path\ni=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))\np=i['parameters']\nresult={'分配金额':str(Decimal(p['amount'])*Decimal(p['ratio'])),'未知事实':p['missing']}\nPath(i['outputDir'],'结果.json').write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')\nprint('calculated')\n`});assert.equal(response.isError,false,response.text);assert.deepEqual(JSON.parse(readFileSync(response.data.outputs[0].path)),{分配金额:'250.00',未知事实:null});assert.match(JSON.parse(readFileSync(response.data.recordPath)).runtime.version,/Python 3/);
  });
  await t.test('越界来源在执行前拒绝，来源locator保留明确行列',async()=>{
   const outside=await client.call('finance_calculation_run',{...base,sources:[{path:sentinelDb}]});assert.equal(outside.isError,true);assert.equal(outside.data.error.code,'finance_calculation_source_forbidden');assert.equal(JSON.parse(readFileSync(outside.data.recordPath)).execution,undefined);
   const located=await client.call('finance_calculation_run',{...base,sources:[{path:original,locator:{row:2,column:'付款金额（元）'}}]});assert.equal(located.isError,false,located.text);assert.equal(JSON.parse(readFileSync(located.data.recordPath)).sources[0].structure.selectedValue,'1000.00');
  });
  await t.test('执行中改动输入会留失败证据，不能将已变脚本或输入用作旧版引用',async()=>{
   const changed=await client.call('finance_calculation_run',{title:'输入误改检查',engine:'javascript',sources:[],script:"import fs from 'node:fs'; fs.writeFileSync(process.argv[2], '{}');"});assert.equal(changed.isError,true);assert.equal(changed.data.error.code,'finance_calculation_execution_input_changed');
   const rerun=await client.call('finance_calculation_run',{...base,rerunOf:changed.data.runId});assert.equal(rerun.isError,true);assert.match(rerun.text,/finance_calculation_previous_changed/);
  });
  await t.test('自动摘要不能解析的编码保持未解析，不阻止脚本处理原字节',async()=>{
   const path=join(sourceRoot,'其他编码.csv'),bytes=Buffer.from([0xc4,0xe3,0xba,0xc3,10,49]);writeFileSync(path,bytes);
   const response=await client.call('finance_calculation_run',{title:'其他编码原件计算',engine:'javascript',sources:[{path}],script:"import fs from 'node:fs'; const i=JSON.parse(fs.readFileSync(process.argv[2])); const b=fs.readFileSync(i.sources[0].snapshotPath); fs.writeFileSync(i.outputDir+'/字节数.json',JSON.stringify({字节数:b.length}));"});assert.equal(response.isError,false,response.text);assert.equal(JSON.parse(readFileSync(response.data.outputs[0].path)).字节数,6);assert.equal(JSON.parse(readFileSync(response.data.recordPath)).sources[0].structure.status,'unparsed');assert.deepEqual(readFileSync(path),bytes);
  });
 }finally{await client.close();}
});
test('四宿主共享配置可显式传原件和Python位置，脚本工具不自动列入只读允许',()=>{
 const c=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:sentinelDb,outputDir:join(root,'new-host'),sourceRoot,pythonPath:py||process.execPath});assert.equal(c.mcpEnv.FINANCE_SOURCE_ROOT,sourceRoot);assert.equal(c.mcpEnv.FINANCE_PYTHON_PATH,py||process.execPath);
 const config=buildConfig(c),settings=JSON.parse(config.files.find(f=>f.path==='.claude/settings.json').content);assert(settings.permissions.ask.includes('mcp__finance__finance_calculation_run'));assert(!settings.permissions.allow.includes('mcp__finance__finance_calculation_run'));
});
test('工作根获准时，两次真实调用复用派生输出只记中性输入快照',{timeout:30000},async()=>{
 const work=mkdtempSync(join(tmpdir(),'finance-calculation-reuse-')),calls=join(work,'calls');
 const reuseClient=new McpStdioClient(fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url)),{cwd:work,env:{FINANCE_MCP_PROFILE:'direct',FINANCE_SOURCE_ROOT:work,FINANCE_AUDIT_DIR:calls,FINANCE_DATABASE_PATH:sentinelDb,FINANCE_API_BASE:'http://127.0.0.1:1'}}).start();
 try{
  await reuseClient.initialize();
  const first=await reuseClient.call('finance_calculation_run',{title:'首次派生计算',engine:'javascript',sources:[],script:"import fs from 'node:fs'; const i=JSON.parse(fs.readFileSync(process.argv[2])); fs.writeFileSync(i.outputDir+'/derived.json',JSON.stringify({金额:125}));"});assert.equal(first.isError,false,first.text);assert.equal(first.data.outputs[0].kind,'derived_calculation');
  const second=await reuseClient.call('finance_calculation_run',{title:'复用派生计算',engine:'javascript',sources:[{path:first.data.outputs[0].path,locator:{jsonPointer:'/金额'}}],script:"import fs from 'node:fs'; const i=JSON.parse(fs.readFileSync(process.argv[2])); const s=JSON.parse(fs.readFileSync(i.sources[0].snapshotPath)); fs.writeFileSync(i.outputDir+'/result.json',JSON.stringify({金额:s.金额*2}));"});assert.equal(second.isError,false,second.text);assert.equal(JSON.parse(readFileSync(second.data.outputs[0].path)).金额,250);
  const record=JSON.parse(readFileSync(second.data.recordPath));assert.equal(record.sources[0].kind,'source_snapshot');assert.equal(record.sources[0].structure.selectedValue,125);assert.equal(record.sourceChecks[0].sourceUnchanged,true);assert(!JSON.stringify(record).includes('original_snapshot'));
  const html=readFileSync(second.data.reviewPath,'utf8');assert.match(html,/输入文件快照，来源性质待核/);assert.match(html,/路径授权及哈希不证明原件真实性/);assert(!html.includes('原件结构与选取位置'));assert(!html.includes('原件快照及结构'));
  const call=await readFinanceCall({auditDir:calls,callId:record.callId});assert(call.end.metadata.sources.some(s=>s.locator==='calculation_source_snapshot'));assert(!JSON.stringify(call).includes('calculation_original_snapshot'));assert.equal(JSON.parse(readFileSync(first.data.recordPath)).outputs[0].kind,'derived_calculation');
 }finally{await reuseClient.close();}
});
test('通用计算中的历史/比较期不是写账scope，原生凭证期间与来源保护保留',()=>{
 const config={workspace:root,sourceRoot,databasePath:sentinelDb};
 assert.equal(assertQuarterArguments(config,{...base,parameters:{period:'2024-12',start_period:'2022-01'}},'finance_calculation_run'),true);
 assert.throws(()=>assertQuarterArguments(config,{accountSetId:1,period:'2025-12'},'voucher_create'),/第一季度/);
 assert.throws(()=>assertQuarterArguments(config,{...base,sources:[{path:sentinelDb}]},'finance_calculation_run'),/获准原件目录/);
});
