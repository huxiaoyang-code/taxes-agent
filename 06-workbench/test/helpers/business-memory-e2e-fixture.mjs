// 独立E2E合成夹具：仅创建全新临时账库；TTY流是测试模拟，不代表真实操作者批准。
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {McpStdioClient} from '../../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {createContext,writeBundle} from '../../../05-reconstruction/codex/hosts/shared/config.mjs';
import {buildConfig} from '../../../05-reconstruction/codex/hosts/claude-code/adapter.mjs';
import {readFinanceCall} from '../../server/finance-call-chain.mjs';
import {syntheticVoucherEvidence} from './synthetic-posting-evidence.mjs';

export const REPO_ROOT=fileURLToPath(new URL('../../../',import.meta.url));
export const WORKBENCH_ROOT=join(REPO_ROOT,'06-workbench');
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
const writeJson=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');

// 脚本按本次来源取数；测试的独立预期是下方手算常量，不复用这个算法。
export const DAILY_RENT_SCRIPT=`import fs from 'node:fs';
const i=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const rows=JSON.parse(fs.readFileSync(i.sources[0].snapshotPath,'utf8')).rows;
fs.writeFileSync(i.outputDir+'/started.json',JSON.stringify({started:true}));
if(i.parameters.delay_ms)await new Promise(r=>setTimeout(r,Math.min(i.parameters.delay_ms,3000)));
if(i.parameters.fail_mode)throw Error('SYNTHETIC_EXPECTED_SCRIPT_FAILURE');
const utc=s=>Date.parse(s+'T00:00:00Z'),day=86400000;
const start=utc(i.parameters.period+'-01'),end=Date.UTC(Number(i.parameters.period.slice(0,4)),Number(i.parameters.period.slice(5,7)),1)-day;
const seen=new Set(),detail=[];
for(const r of rows){
 if(seen.has(r.invoice_number))continue;seen.add(r.invoice_number);
 if(!Number.isFinite(r.net_rent)||!Number.isFinite(utc(r.lease_start))||!Number.isFinite(utc(r.lease_end)))throw Error('SYNTHETIC_REQUIRED_RENT_FIELD_MISSING');
 const days=(utc(r.lease_end)-utc(r.lease_start))/day+1;
 const overlap=Math.max(0,(Math.min(end,utc(r.lease_end))-Math.max(start,utc(r.lease_start)))/day+1);
 detail.push({invoice_number:r.invoice_number,lease_days:days,overlap_days:overlap,net_rent:r.net_rent,recognized:Math.round(r.net_rent*overlap/days*100)/100});
}
fs.writeFileSync(i.outputDir+'/租金确认结果.json',JSON.stringify({period:i.parameters.period,total:Math.round(detail.reduce((s,r)=>s+r.recognized,0)*100)/100,detail,method:'daily_accrual'},null,2));
console.log('LOCAL_ONLY_SYNTHETIC_DAILY_RENT_SCRIPT');`;

export const DUE_RENT_SCRIPT=`import fs from 'node:fs';
const i=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const rows=JSON.parse(fs.readFileSync(i.sources[0].snapshotPath,'utf8')).rows;
const seen=new Set(),detail=[];
for(const r of rows){if(seen.has(r.invoice_number))continue;seen.add(r.invoice_number);if(r.contract_due_date.slice(0,7)===i.parameters.period)detail.push({invoice_number:r.invoice_number,recognized:r.net_rent});}
fs.writeFileSync(i.outputDir+'/租金确认结果.json',JSON.stringify({period:i.parameters.period,total:detail.reduce((s,r)=>s+r.recognized,0),detail,method:'contract_due_month'},null,2));`;

const septemberA=[
 {invoice_number:'RENT-001',business_key:'LEASE-A1',lease_start:'2026-09-16',lease_end:'2026-10-15',contract_due_date:'2026-09-01',invoice_date:'2026-08-20',net_rent:3000,gross_rent:3090},
 {invoice_number:'RENT-002',business_key:'LEASE-A2',lease_start:'2026-09-01',lease_end:'2026-10-31',contract_due_date:'2026-10-15',invoice_date:'2026-08-21',net_rent:6100,gross_rent:6283},
];
const octoberA=[
 {...septemberA[1],net_rent:12200,gross_rent:12566},
 {...septemberA[0],net_rent:4500,gross_rent:4635},
 {invoice_number:'RENT-003',business_key:'LEASE-A3',lease_start:'2026-10-20',lease_end:'2026-11-18',contract_due_date:'2026-11-01',invoice_date:'2026-10-02',net_rent:6000,gross_rent:6180},
];
const septemberB=septemberA.map((r,n)=>({...r,business_key:'LEASE-B'+(n+1),net_rent:n===0?10000:8000}));
const octoberB=septemberB.map(r=>({...r,net_rent:r.net_rent*2}));

export function rentalDefinition(runId,kind='daily'){
 return {
  title:'LOCAL_ONLY_SYNTHETIC_企业租赁收入方法',
  applicability:{objectScope:'account_set',dateField:kind==='daily'?'service_period':'document_date',amountBasis:'net',deduplicateBy:'invoice_number',businessView:'accounting',requiredConditions:kind==='daily'?['contract_overlaps_period','source_rows_required','operator_policy_unverified']:['income_tax_contract_due_basis','source_rows_required','operator_policy_unverified']},
  inputs:[
   {key:'rows',meaning:'rows',field:'rows',sourceRole:'lease_contract',type:'array',source:'source_snapshot',sourceIndex:0,required:true},
   {key:'period',meaning:'period',field:'current_period',sourceRole:'current_parameters',type:'string',source:'current_parameters',required:true},
   {key:'lease_start',meaning:'date',field:'contract_start',sourceRole:'lease_contract',type:'string',source:'source_snapshot',sourceIndex:0},
   {key:'lease_end',meaning:'date',field:'contract_end',sourceRole:'lease_contract',type:'string',source:'source_snapshot',sourceIndex:0},
   {key:'contract_due_date',meaning:'date',field:'contract_due_date',sourceRole:'lease_contract',type:'string',source:'source_snapshot',sourceIndex:0},
   {key:'net_rent',meaning:'amount',field:'net_rent',sourceRole:'lease_contract',type:'number',source:'source_snapshot',sourceIndex:0},
   {key:'delay_ms',meaning:'other',field:'other',sourceRole:'current_parameters',type:'integer',source:'current_parameters'},
   {key:'fail_mode',meaning:'other',field:'other',sourceRole:'current_parameters',type:'boolean',source:'current_parameters'},
  ],
  transformation:{kind:'proportional_allocation',allocationBasis:kind==='daily'?'daily_accrual':'contract_period',deduplicateBy:'invoice_number',rounding:'half_up_cent',missingValues:'reject',steps:[
   {op:'deduplicate',inputs:['rows'],keys:['invoice_number'],output:'unique_rows'},
   ...(kind==='daily'?[{op:'date_overlap',inputs:['unique_rows'],fromField:'lease_start',throughField:'lease_end',periodField:'period',unit:'days',output:'overlap_days'},{op:'day_count',fromField:'lease_start',throughField:'lease_end',unit:'days',output:'lease_days'},{op:'multiply',inputs:['net_rent','overlap_days'],output:'rent_days'},{op:'divide',inputs:['rent_days','lease_days'],output:'recognized_rent'}]:[{op:'filter_period',inputs:['unique_rows'],field:'contract_due_date',periodField:'period',output:'due_rows'}]),
   {op:'sum',inputs:kind==='daily'?['recognized_rent']:['due_rows'],amountField:'net_rent',output:'total'},
  ]},
  accounts:[{role:'receivable',code:'1122',side:'debit'},{role:'main_income',code:'500101',side:'credit'}],
  execution:{kind:'calculation_record',runId},gaps:['policy_unverified'],
 };
}

export function logicalSnapshot(dbPath){
 const db=new DatabaseSync(dbPath,{readOnly:true});
 try{
  db.exec('PRAGMA query_only=ON');
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return JSON.stringify({schema,tables:schema.filter(s=>s.type==='table').map(s=>[s.name,db.prepare('SELECT * FROM "'+s.name.replaceAll('"','""')+'" ORDER BY rowid').all()])});
 }finally{db.close();}
}

async function seed(root,{includeNegativeHistory=true}={}){
 const data=join(root,'data'),sourceA=join(root,'september-source'),sourceB=join(root,'october-source'),auditA=join(root,'september-audit'),auditB=join(root,'october-audit');
 for(const path of [root,data,sourceA,sourceB])mkdirSync(path,{recursive:true});
 process.env.WORKBENCH_DATA_DIR=data;process.env.FINANCE_DATABASE_PATH=join(data,'workbench.db');process.env.FINANCE_SOURCE_ROOT=sourceA;process.env.FINANCE_AUDIT_DIR=auditA;delete process.env.FINANCE_BUSINESS_SESSION;
 const A=await import('../../server/accounting.mjs'),{db}=await import('../../server/db.mjs');
 const {resolveDirectFinanceTarget}=await import('../../server/direct-finance-target.mjs');
 const fixture={version:'synthetic-business-memory-e2e/1',root,data,dbPath:join(data,'workbench.db'),sourceA,sourceB,auditA,auditB,expected:{septemberA:4500,octoberA:10850,septemberB:10000,octoberB:16000,octoberDepreciation:1000},humanApproval:false,modelInvoked:false};
 try{
  fixture.a=A.createAccountSet({name:'LOCAL_ONLY_SYNTHETIC_甲出租企业',start_period:'2026-01',profileId:'small-2011-basic-v1',enterprise:{enterpriseKey:'SYNTHETIC-E2E-LEASE-A'}}).id;
  fixture.b=A.createAccountSet({name:'LOCAL_ONLY_SYNTHETIC_乙出租企业',start_period:'2026-01',profileId:'small-2011-basic-v1',enterprise:{enterpriseKey:'SYNTHETIC-E2E-LEASE-B'}}).id;
  for(const id of [fixture.a,fixture.b])A.addAccount(id,{code:'500101',name:'租金收入',category:'损益',direction:'credit'});
  fixture.originalA=join(sourceA,'甲9月租赁原件.json');fixture.originalB=join(sourceA,'乙9月租赁原件.json');fixture.currentA=join(sourceB,'甲10月新租赁原件.json');fixture.currentB=join(sourceB,'乙10月新租赁原件.json');
  writeJson(fixture.originalA,{rows:[...septemberA,septemberA[0]]});writeJson(fixture.originalB,{rows:[...septemberB,septemberB[0]]});
  writeJson(fixture.currentA,{rows:[...octoberA,octoberA[1],octoberA[0],octoberA[1]]});writeJson(fixture.currentB,{rows:[octoberB[1],octoberB[0],octoberB[1]]});
  const voucher=(id,period,amount,status='posted',number=1)=>A.createVoucher(id,syntheticVoucherEvidence({period,voucher_date:period+'-28',number,status,summary:'合成租赁历史',entries:[{code:'1122',debit:amount},{code:'500101',credit:amount}]},sourceA));
  fixture.voucherA=voucher(fixture.a,'2026-09',4500).id;fixture.voucherB=voucher(fixture.b,'2026-09',10000).id;
  if(includeNegativeHistory){fixture.draft=voucher(fixture.a,'2026-09',999,'draft',2).id;fixture.currentVoucher=voucher(fixture.a,'2026-10',777).id;fixture.futureVoucher=voucher(fixture.a,'2026-11',888).id;}
  fixture.asset=A.addAssetCard(fixture.a,{name:'合成已入账出租设备',kind:'fixed',original_cost:12000,residual_rate:0,useful_life_months:12,start_period:'2026-10',acquired_period:'2026-09',ledger_status:'booked'}).id;
  // 这里装配已存在的封账历史状态；不把装配操作计为期间封账业务验收。
  db.prepare("UPDATE periods SET status='closed' WHERE account_set_id IN (?,?) AND period='2026-09'").run(fixture.a,fixture.b);
  fixture.scopeA=resolveDirectFinanceTarget({accountSetId:fixture.a,period:'2026-10'},fixture.dbPath).scope;fixture.scopeB=resolveDirectFinanceTarget({accountSetId:fixture.b,period:'2026-10'},fixture.dbPath).scope;
  writeJson(join(root,'fixture.json'),fixture);writeJson(join(root,'独立预期.json'),{说明:'以下常量由独立手算给出，非读取被测计算器结果生成；均为合成资料。',甲9月:'3000×15/30 + 6100×30/61 = 4500',甲10月:'12200×31/61 + 4500×15/30 + 6000×12/30 = 10850；重复票行不再加计',乙9月:'合同到期月为9月的RENT-001为10000',乙10月:'合同到期月为10月的RENT-002新金额为16000',折旧10月:'12000÷12=1000',...fixture.expected});
  return fixture;
 }finally{db.close();}
}

export function createSyntheticFixture(requestedRoot,{includeNegativeHistory=true}={}){
 const root=requestedRoot??mkdtempSync(join(tmpdir(),'business-memory-e2e-'));
 if(!isAbsolute(root)||!existsSync(root)||readdirSync(root).length)throw Error('synthetic_root_must_be_absolute_existing_empty');
 const result=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--seed',root,...(includeNegativeHistory?[]:['--positive-only'])],{cwd:WORKBENCH_ROOT,encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,NODE_NO_WARNINGS:'1',FINANCE_BUSINESS_SESSION:undefined}});
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);return readJson(join(root,'fixture.json'));
}

export async function completeHistoricalFixture(f,{includeNegativeHistory=true}={}){
 // 先生成配置，再由正常启动器绑定实际9月session，最后让真实MCP自动观察归属。
 // 这里禁止手工标注scope；否则测试会掩盖正常工具调用无法进入历史目录的故障。
 const sessions={};
 for(const [name,id,script,path]of [['a',f.a,DAILY_RENT_SCRIPT,f.originalA],['b',f.b,DUE_RENT_SCRIPT,f.originalB]]){
  const workspace=join(f.root,'history-september-'+name),context=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:f.dbPath,sourceRoot:f.sourceA,auditDir:f.auditA,outputDir:workspace});writeBundle(context,buildConfig(context));
  const prepared=spawnSync(process.execPath,[join(workspace,'start-business-session.mjs'),'--account-set-id',String(id),'--period','2026-09','--prepare-only'],{cwd:workspace,encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,WORKBENCH_DATA_DIR:f.data,FINANCE_BUSINESS_SESSION:undefined,NODE_NO_WARNINGS:'1'}});assert.equal(prepared.status,0,prepared.stderr+'\n'+prepared.stdout);assert.equal(JSON.parse(prepared.stdout).scope.accountSetId,id);sessions[name]=join(workspace,'.finance/business-session.json');
  const client=await startMcp(f,{sessionPath:sessions[name]});
  try{
   const result=await client.call('finance_calculation_run',{title:'合成已留存租金计算',engine:'javascript',script,parameters:{period:'2026-09'},sources:[{path}]});assert.equal(result.isError,false,result.text);assert.equal(result.data.status,'executed');f[name==='a'?'historyA':'historyB']=result.data;
   const record=readJson(result.data.recordPath),call=await readFinanceCall({auditDir:f.auditA,callId:record.callId});assert.equal(call.end.scopeState,'observed','正常绑定MCP计算必须自动观察实际scope');assert.equal(call.end.scope.accountSetId,id);assert.equal(call.end.scope.period,'2026-09');assert.equal(call.end.scope.enterpriseKey,name==='a'?f.scopeA.enterpriseKey:f.scopeB.enterpriseKey);assert.equal(call.end.scope.databaseInstanceId,f.scopeA.databaseInstanceId);
  }finally{await client.close();}
  const {searchBusinessCases}=await import('../../server/business-memory.mjs'),recalled=await searchBusinessCases({target:{accountSetId:id,period:'2026-10'},objectKey:f[name==='a'?'historyA':'historyB'].runId},{dbPath:f.dbPath,sourceRoot:f.sourceB,auditDir:f.auditB,sessionPath:''});assert.equal(recalled.cases.length,1,'9月MCP结束后立即换10月两个授权根，不手工prepare仍须恢复历史');assert.equal(recalled.cases[0].status,'executed_unreviewed');
  if(name==='a'&&includeNegativeHistory){const failureClient=await startMcp(f,{sessionPath:sessions[name]});try{const failed=await failureClient.call('finance_calculation_run',{title:'合成历史失败计算',engine:'javascript',script:"throw Error('SYNTHETIC_HISTORICAL_FAILURE');",parameters:{period:'2026-09'},sources:[{path}]});assert.equal(failed.isError,true);assert.equal(failed.data.status,'failed');f.failedHistory=failed.data;}finally{await failureClient.close();}}
 }
 if(includeNegativeHistory){
  const client=await startMcp(f);try{const result=await client.call('finance_calculation_run',{title:'合成未绑定计算',engine:'javascript',script:"import fs from 'node:fs';const i=JSON.parse(fs.readFileSync(process.argv[2]));fs.writeFileSync(i.outputDir+'/未绑定.json','{}');",parameters:{period:'2026-09'},sources:[]});assert.equal(result.isError,false,result.text);f.unboundHistory=result.data;const record=readJson(result.data.recordPath),call=await readFinanceCall({auditDir:f.auditA,callId:record.callId});assert.equal(call.end.scopeState,'unknown','未绑定不能靠普通period参数冒充企业归属');}finally{await client.close();}
 }
 assert.equal(calculationOutput(f.historyA).total,4500);assert.equal(calculationOutput(f.historyB).total,10000);f.historySessions=sessions;f.historyScopeOrigin='generated_bound_session_real_stdio_mcp';writeJson(join(f.root,'fixture.json'),f);return f;
}

export function calculationOutput(result){
 const output=result.outputs.find(o=>o.path.endsWith('租金确认结果.json'));assert(output,'必须返回实际新产物索引');return readJson(output.path);
}
export async function startMcp(fixture,{sourceRoot=fixture.sourceA,auditDir=fixture.auditA,sessionPath,dbPath=fixture.dbPath,apiBase='http://127.0.0.1:1'}={}){
 const client=new McpStdioClient(join(REPO_ROOT,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{cwd:WORKBENCH_ROOT,timeoutMs:30000,env:{WORKBENCH_DATA_DIR:fixture.data,FINANCE_DATABASE_PATH:dbPath,FINANCE_SOURCE_ROOT:sourceRoot,FINANCE_AUDIT_DIR:auditDir,FINANCE_BUSINESS_SESSION:sessionPath??'',FINANCE_MCP_PROFILE:'direct',FINANCE_API_BASE:apiBase,NODE_NO_WARNINGS:'1'}}).start();
 await client.initialize('independent-synthetic-business-memory-e2e');return client;
}
export async function startBackend(fixture){
 const child=spawn(process.execPath,[join(WORKBENCH_ROOT,'server/server.mjs')],{cwd:WORKBENCH_ROOT,stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...process.env,WORKBENCH_DATA_DIR:fixture.data,FINANCE_DATABASE_PATH:fixture.dbPath,FINANCE_SOURCE_ROOT:fixture.sourceB,FINANCE_AUDIT_DIR:fixture.auditB,FINANCE_BUSINESS_SESSION:'',PORT:'0',HOST:'127.0.0.1',NODE_NO_WARNINGS:'1'}});
 let stderr='';child.stderr.on('data',b=>{stderr+=b;});
 const apiBase=await new Promise((accept,reject)=>{let stdout='';const timer=setTimeout(()=>reject(Error('synthetic_backend_start_timeout '+stderr.slice(0,1000))),15000);child.stdout.on('data',b=>{stdout+=b;const match=/http:\/\/127\.0\.0\.1:\d+/.exec(stdout);if(match){clearTimeout(timer);accept(match[0]);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('synthetic_backend_exit '+code+' '+stderr.slice(0,1000)));});child.once('error',e=>{clearTimeout(timer);reject(e);});});
 return {child,apiBase};
}

export async function selectSyntheticMethod(args,options,{effectiveFrom=args.target.period,effectiveTo='',sequence=1}={}){
 const {selectBusinessMethodInteractively}=await import('../../server/business-memory.mjs');
 const input=new PassThrough(),output=new PassThrough();input.isTTY=true;output.isTTY=true;
 const prompts=['操作者姓名（声明）：','核对依据与选择/变更理由：','生效期间（回车使用 ','终止期间（可留空，跨期延续）：','仅确认上述版本请输入'];
 const answers=['SYNTHETIC_TTY_FIXTURE','合成流选择版本测试 '+sequence+'；不是实际操作者批准',effectiveFrom,effectiveTo,'选择 '+args.methodRef];
 let index=0,transcript='',cursor=0;
 output.on('data',chunk=>{transcript+=String(chunk);if(index<prompts.length&&transcript.slice(cursor).includes(prompts[index])){cursor=transcript.length;const answer=answers[index++];setImmediate(()=>input.write(answer+'\n'));}});
 const timeout=setTimeout(()=>input.destroy(Error('synthetic_tty_selection_timeout')),10000);
 try{const selected=await selectBusinessMethodInteractively(args,options,{input,output});assert.equal(selected.status,'selected');assert.equal(index,5);return {selected,transcript,simulation:true,humanApproval:false};}
 finally{clearTimeout(timeout);input.destroy();output.destroy();}
}
export async function waitUntil(predicate,timeoutMs=5000){
 const start=Date.now();while(Date.now()-start<timeoutMs){const value=predicate();if(value)return value;await new Promise(r=>setTimeout(r,25));}throw Error('synthetic_wait_timeout');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--seed'){
 const root=process.argv[3];if(!root||!isAbsolute(root))throw Error('synthetic_seed_absolute_root_required');await seed(root,{includeNegativeHistory:process.argv[4]!=='--positive-only'});console.log(JSON.stringify({status:'synthetic_fixture_created',root,modelInvoked:false,humanApproval:false}));
}
