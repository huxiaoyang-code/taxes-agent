// 宿主程序回归；业务计算/独立oracle另测，不把本套称为完整账期验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {PassThrough} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {prepareQuarterWorkspace,loadQuarterWorkspace,assertQuarterArguments,openQuarterHost,PRODUCT_ROOT} from '../scripts/quarter-host.mjs';
import {readQuarterMaterial} from '../scripts/quarter-read.mjs';
import {main as runSession} from '../scripts/quarter-session.mjs';
import {validateQuarterSheets} from '../scripts/quarter-export.mjs';
function workspace(){const root=mkdtempSync(join(tmpdir(),'quarter-host-')),source=join(root,'public'),pluginRoot=join(root,'plugin','finance');mkdirSync(source);mkdirSync(join(pluginRoot,'.claude-plugin'),{recursive:true});mkdirSync(join(pluginRoot,'skills'));writeFileSync(join(pluginRoot,'.claude-plugin','plugin.json'),JSON.stringify({name:'finance',version:'0.0.0'}));writeFileSync(join(source,'业务委托.md'),'请核对2026年第一季度账目、凭证和报表。');writeFileSync(join(source,'业务明细.csv'),'单据号,金额（元）,说明\n业01,120.00,购入材料\n业02,30.00,办公支出\n');writeFileSync(join(source,'业务资料.json'),JSON.stringify({利润:12000,亏损:2000,调整:0,已预缴:0}));const prepared=prepareQuarterWorkspace({materialsDir:source,workspace:join(root,'季度账目'),pluginRoot,maintenanceDir:join(root,'maintenance')});return {root,source,pluginRoot,prepared,config:loadQuarterWorkspace(prepared.workspace)};}
test('准备仅复制业务原件，维护侧信息分离，拒绝覆盖和维护/答案文件',()=>{const f=workspace();assert(existsSync(f.prepared.taskPath));assert(!existsSync(join(f.config.workspace,'maintenance')));assert.match(readFileSync(f.prepared.maintenanceRecord,'utf8'),/人工构造/);assert.throws(()=>prepareQuarterWorkspace({materialsDir:f.source,workspace:f.config.workspace,pluginRoot:f.pluginRoot,maintenanceDir:join(f.root,'maintenance')}),/必须全新/);writeFileSync(join(f.source,'oracle.py'),'hidden');assert.throws(()=>prepareQuarterWorkspace({materialsDir:f.source,workspace:join(f.root,'other'),pluginRoot:f.pluginRoot,maintenanceDir:join(f.root,'maintenance')}),/维护或答案/);});
test('正常写账参数允许，账库/文件/期间越界拒绝，不注入operationId',()=>{const f=workspace(),args={accountSetId:1,period:'2026-02',operationId:'operator-keeps-original-id',businessEvidence:{mappings:[{sources:[{path:join(f.config.sourceRoot,'业务明细.csv')}]}]}};assert.equal(assertQuarterArguments(f.config,args),true);assert.equal(args.operationId,'operator-keeps-original-id');for(const bad of [{dbPath:join(f.root,'real.db')},{period:'2026-04'},{businessEvidence:{path:join(f.root,'private.json')}}])assert.throws(()=>assertQuarterArguments(f.config,bad));const path=join(f.config.workspace,'.quarter-host.json'),config=JSON.parse(readFileSync(path));writeFileSync(path,JSON.stringify({...config,databasePath:join(f.root,'outside.db')}));assert.throws(()=>loadQuarterWorkspace(f.config.workspace),/隔离工作目录/);});
test('仅新增资产的顶层起提期间采用历史卡片语义，业务操作期间不放宽',()=>{
 const {config}=workspace(),asset={accountSetId:1,name:'历史货架',acquired_period:'2024-12',start_period:'2025-01',original_cost:60000,opening_accumulated:12000,useful_life_months:60};
 assert.equal(assertQuarterArguments(config,asset,'asset_create'),true);
 assert.deepEqual(asset,{accountSetId:1,name:'历史货架',acquired_period:'2024-12',start_period:'2025-01',original_cost:60000,opening_accumulated:12000,useful_life_months:60});
 for(const [tool,args]of [['account_set_create',{start_period:'2025-01'}],['depreciation_run',{period:'2025-01'}],['depreciation_run',{period:'2026-04'}],['voucher_create',{period:'2026-04'}],['asset_create',{...asset,period:'2025-01'}],['asset_create',{nested:{start_period:'2025-01'}}],['asset_create',{start_period:['2025-01']}],[undefined,asset]])assert.throws(()=>assertQuarterArguments(config,args,tool),/第一季度/);
 assert.equal(assertQuarterArguments(config,{period:'2026-03'},'depreciation_run'),true);
});
test('真实临时账库保存历史资产日期和金额，原生日期守卫仍执行',{timeout:45000},async()=>{
 const {config}=workspace(),host=await openQuarterHost(config),asset={accountSetId:1,name:'历史货架',acquired_period:'2024-12',start_period:'2025-01',original_cost:60000,opening_accumulated:12000,useful_life_months:60};
 const value=result=>{assert.notEqual(result.isError,true);return JSON.parse(result.content[0].text);};
 try{
  assert.equal(value(await host.call('account_set_create',{name:'历史卡片程序核对',start_period:'2026-01',enterprise:{enterpriseKey:'SYNTHETIC-HISTORICAL-ASSET'},profileId:'small-2011-basic-v1'})).ok,true);
  await assert.rejects(host.call('account_set_create',{name:'越界',start_period:'2025-01'}),/第一季度/);
  for(const period of ['2025-12','2026-04'])await assert.rejects(host.call('depreciation_run',{accountSetId:1,period}),/第一季度/);
  assert.equal((await host.call('asset_create',{...asset,start_period:'2025-13'})).isError,true);
  assert.equal(value(await host.call('asset_create',asset)).ok,true);
 }finally{await host.close();}
 const db=new DatabaseSync(config.databasePath,{readOnly:true});try{
  const rows=db.prepare('SELECT acquired_period,start_period,original_cost,opening_accumulated,useful_life_months FROM asset_cards').all();
  assert.equal(rows.length,1);assert.deepEqual({...rows[0]},{acquired_period:'2024-12',start_period:'2025-01',original_cost:60000,opening_accumulated:12000,useful_life_months:60});
  assert.equal(db.prepare('SELECT COUNT(*) count FROM asset_depreciation_runs').get().count,0);
 }finally{db.close();}
});
test('资料读取时留完整结构/版本，页范围准确，拒绝越界且不估算tokens',()=>{const f=workspace(),page=readQuarterMaterial(f.config,{file:'业务明细.csv',offset:1,limit:1});assert.deepEqual(page.data.headers,['单据号','金额（元）','说明']);assert.equal(page.data.rows[0].row,3);assert.equal(page.data.rows[0].values[0],'业02');const dirs=readdirSync(join(f.config.auditDir,'原件读取')),record=JSON.parse(readFileSync(join(f.config.auditDir,'原件读取',dirs[0],'阅读记录.json')));assert.equal(record.stage,'material_read');assert.equal(record.structure.rowCount,2);assert.equal(record.selection.returnedRows,1);assert.equal(record.agentTelemetry.tokens,null);assert.equal(record.sha256,page.sha256);assert.throws(()=>readQuarterMaterial(f.config,{file:'../private/gold.json'}),/相对文件名/);});
test('持久会话按需提供单工具原生合同，拒绝流程数组，正常工具走真实HTTP与MCP',{timeout:45000},async()=>{const f=workspace(),input=new PassThrough(),output=new PassThrough(),chunks=[];output.on('data',chunk=>chunks.push(chunk.toString()));const pending=runSession(['--workspace',f.config.workspace],input,output);input.end(JSON.stringify({method:'tools/list'})+'\n'+JSON.stringify({method:'tool_schema',name:'account_set_create'})+'\n'+JSON.stringify([])+'\n'+JSON.stringify({tool:'account_set_create',args:{name:'宿主程序核对公司',start_period:'2026-01',enterprise:{enterpriseKey:'SYNTHETIC-HOST-ONLY'},profileId:'small-2011-basic-v1'}})+'\n'+JSON.stringify({tool:'account_context',args:{accountSetId:1}})+'\n'+JSON.stringify({method:'close'})+'\n');await pending;const rows=chunks.join('').trim().split(/\r?\n/).map(JSON.parse);assert.equal(rows[0].ready,true);const tools=rows.find(row=>row.tools).tools;for(const name of ['voucher_create','voucher_post','depreciation_run','carry_forward_profit','finance_workpaper'])assert.ok(tools.some(tool=>tool.name===name));assert(!tools.some(tool=>Object.hasOwn(tool,'inputSchema')));assert.ok(rows.find(row=>row.tool).tool.inputSchema);assert.ok(rows.some(row=>row.isError&&/一次只接收/.test(row.message)));const replies=rows.filter(row=>row.result);assert.equal(replies.length,2);for(const reply of replies){assert.notEqual(reply.result.isError,true);const value=JSON.parse(reply.result.content[0].text);assert.equal(value.channel,'model');assert.equal(value.rawValuesIncluded,false);assert.equal(value.ok,true);}assert.ok(readdirSync(f.config.auditDir).some(name=>/^宿主-.*\.json$/.test(name)));});
test('导出只接受中文原生表结构及明确数值类型，技术标识不混前台',()=>{const sheet={name:'试算平衡表',columns:['科目编码','期末余额（元）'],columnTypes:['code','money'],rows:[['1002',100.2]],unit:'元'};assert.equal(validateQuarterSheets({sheets:[sheet]}),true);assert.throws(()=>validateQuarterSheets({sheets:[{...sheet,rows:[['1002','100.20']]}]}),/须由原生报告/);assert.throws(()=>validateQuarterSheets({sheets:[{...sheet,rows:[['posted',100]]}]}),/未翻译状态/);});
