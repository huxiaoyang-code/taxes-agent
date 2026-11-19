// 真实临时 SQLite、自建合成原件与实际计算执行；不读取现有账库或宿主记忆。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import * as S from '../server/business-memory-storage.mjs';
import * as B from '../server/business-memory-bootstrap.mjs';
import * as LB from '../server/local-backup.mjs';
import { resolveDirectFinanceTarget } from '../server/direct-finance-target.mjs';
import { syntheticVoucherEvidence } from './helpers/synthetic-posting-evidence.mjs';
import { McpStdioClient } from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import { createContext, writeBundle } from '../../05-reconstruction/codex/hosts/shared/config.mjs';
import { buildConfig } from '../../05-reconstruction/codex/hosts/claude-code/adapter.mjs';

const hash = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const logical = db => JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name}) => [name,db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]));
test('企业记忆存储、历史初始化与严格备份恢复',async t => {
 const root=fs.mkdtempSync(join(tmpdir(),'business-memory-storage-')),data=join(root,'data'),sources=join(root,'sources'),audit=join(root,'calls');
 fs.mkdirSync(data); fs.mkdirSync(sources); process.env.WORKBENCH_DATA_DIR=data; process.env.FINANCE_SOURCE_ROOT=sources; process.env.FINANCE_AUDIT_DIR=audit;
 const {db}=await import('../server/db.mjs'), A=await import('../server/accounting.mjs'), I=await import('../server/import-storage.mjs');
 const dbPath=join(data,'workbench.db'), opts={dbPath,auditDir:audit,sourceRoot:sources};
 let sessionSequence=0;
 const readJson=path=>JSON.parse(fs.readFileSync(path,'utf8'));
 async function recordedClient({accountSetId,period:boundPeriod='2026-01',bound=true}={}) {
  let session='';
  if (bound) {
   const workspace=join(root,'normal-session-'+(++sessionSequence)),context=createContext({nodePath:process.execPath,apiBase:'http://127.0.0.1:1',databasePath:dbPath,sourceRoot:sources,auditDir:audit,outputDir:workspace});writeBundle(context,buildConfig(context));
   const prepared=spawnSync(process.execPath,[join(workspace,'start-business-session.mjs'),'--account-set-id',String(accountSetId),'--period',boundPeriod,'--prepare-only'],{cwd:workspace,env:{...process.env,WORKBENCH_DATA_DIR:data,WORKBENCH_DATABASE_MODE:'readwrite',FINANCE_BUSINESS_SESSION:''},encoding:'utf8',windowsHide:true,timeout:60000});
   assert.equal(prepared.status,0,prepared.stderr+'\n'+prepared.stdout);assert.equal(JSON.parse(prepared.stdout).scope.accountSetId,accountSetId);
   session=join(workspace,'.finance','business-session.json');
  }
  const client=new McpStdioClient(fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url)),{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{WORKBENCH_DATA_DIR:data,WORKBENCH_DATABASE_MODE:'readwrite',FINANCE_DATABASE_PATH:dbPath,FINANCE_AUDIT_DIR:audit,FINANCE_SOURCE_ROOT:sources,FINANCE_BUSINESS_SESSION:session,FINANCE_MCP_PROFILE:'direct',FINANCE_API_BASE:'http://127.0.0.1:1'},timeoutMs:30000}).start();
  await client.initialize('synthetic-business-memory-storage');return client;
 }
 async function selectSyntheticVersion(target,methodRef) {
  const {selectBusinessMethodInteractively}=await import('../server/business-memory.mjs'),input=new PassThrough(),output=new PassThrough();input.isTTY=true;output.isTTY=true;
  const prompts=['操作者姓名（声明）：','核对依据与选择/变更理由：','生效期间（回车使用 ','终止期间（可留空，跨期延续）：','仅确认上述版本请输入'],answers=['SYNTHETIC_STORAGE_TEST','合成TTY合同测试，不代表真人财税审核',target.period,'','选择 '+methodRef];let cursor=0,index=0,transcript='';
  output.on('data',chunk=>{transcript+=String(chunk);if(index<prompts.length&&transcript.slice(cursor).includes(prompts[index])){cursor=transcript.length;const answer=answers[index++];setImmediate(()=>input.write(answer+'\n'));}});
  const timeout=setTimeout(()=>input.destroy(Error('synthetic_selection_timeout')),10000);
  try {const selected=await selectBusinessMethodInteractively({target,methodRef},opts,{input,output});assert.equal(selected.status,'selected');assert.equal(index,5);return selected;}finally{clearTimeout(timeout);input.destroy();output.destroy();}
 }
 const a=A.createAccountSet({name:'合成出租企业甲',start_period:'2026-01',profileId:'small-2011-basic-v1',enterprise:{enterpriseKey:'SYNTH-MEMORY-A',enterpriseName:'合成出租企业甲'}}).id;
 const b=A.createAccountSet({name:'合成出租企业乙',start_period:'2026-01',profileId:'small-2011-basic-v1',enterprise:{enterpriseKey:'SYNTH-MEMORY-B',enterpriseName:'合成出租企业乙'}}).id;
 A.addAccount(a,{code:'500101',name:'租金收入',category:'损益',direction:'credit'});
 const make=(id,p,n,posted=true)=>{
  const raw={period:p,voucher_date:p+'-15',number:n,status:posted?'posted':'draft',entries:[{code:'1002',debit:1200},{code:id===a?'500101':'5001',credit:1200}]};
  return A.createVoucher(id,syntheticVoucherEvidence(raw,sources));
 };
 const jan=make(a,'2026-01',1), draft=make(a,'2026-01',2,false), current=make(a,'2026-02',1),future=make(a,'2026-03',1),other=make(b,'2026-01',1);
 // 此测试专门装配已有旧账状态，不把fixture构造冒称期间封账业务验收。
 const asset=A.addAssetCard(a,{name:'合成设备',kind:'fixed',original_cost:12000,residual_rate:0,useful_life_months:12,start_period:'2026-02',acquired_period:'2026-01',ledger_status:'booked'});
 db.prepare("UPDATE periods SET status='closed' WHERE account_set_id=? AND period='2026-01'").run(a);
 I.insertSourceBinding(db,{sourceSystem:'synthetic-import',enterpriseKey:'SYNTH-MEMORY-A'});
 const entries=db.prepare('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY line_no').all(jan.id),voucher=db.prepare('SELECT * FROM vouchers WHERE id=?').get(jan.id);
 db.prepare('INSERT INTO import_voucher_sources(source_system,enterprise_key,source_voucher_id,account_set_id,voucher_id,voucher_fingerprint,content_fingerprint,batch_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('synthetic-import','SYNTH-MEMORY-A','SOURCE-A-JAN',a,jan.id,I.persistedVoucherFingerprint(voucher,entries),'a'.repeat(64),'synthetic-batch',new Date().toISOString());
 const target={accountSetId:a,period:'2026-02'},scope=resolveDirectFinanceTarget(target,dbPath).scope;
 let prepared,originalAssetMethod,operatorVersion,initialCase,methodHistoryCase;
 try {
  await t.test('R01/R02/R03：显式账库、三类历史来源、状态、租金主题与未知算法',async()=>{
   assert.equal(S.inspectBusinessMemorySchema(db).state,'not_installed');
   const before=logical(db),databaseBytes=fs.readFileSync(dbPath),walBytes=fs.existsSync(dbPath+'-wal') ? fs.readFileSync(dbPath+'-wal') : null,observed=B.observeBusinessMemory({target},opts);
   assert.equal(logical(db),before,'首次只读观察不创建记忆表');
   assert.deepEqual(fs.readFileSync(dbPath),databaseBytes);if(walBytes)assert.deepEqual(fs.readFileSync(dbPath+'-wal'),walBytes);
   assert.equal(observed.summary.assetCount,1); assert.equal(observed.summary.importSourceCount,1);
   assert.equal(observed.summary.sourceBindingCount,1); assert.equal(observed.summary.voucherCount,4);
   const vcase=observed.cases.find(c=>c.sourceKey==='voucher:'+jan.id);
   assert.equal(vcase.topic,'rental_income'); assert.equal(vcase.status,'closed_posted');
   assert.ok(vcase.sourceRefs.some(s=>s.kind==='import'&&s.sourceVoucherId==='SOURCE-A-JAN'&&s.unchanged));
   assert.ok(vcase.sourceRefs.some(s=>s.kind==='posting_evidence'&&s.sources.every(s=>s.state==='unchanged')));
   assert.ok(observed.cases.find(c=>c.sourceKey==='voucher:'+draft.id).status==='draft');
   assert.ok(observed.methods.filter(m=>m.topic==='rental_income').every(m=>m.authority==='observed_history'&&!m.definition.execution));
   assert.ok(observed.methods.find(m=>m.topic==='rental_income').definition.gaps.includes('algorithm_unknown'));
   const deterministic=observed.methods.find(m=>m.topic==='depreciation');
   assert.equal(deterministic.authority,'ledger_fact'); assert.equal(deterministic.configuration[0].usefulLifeMonths,12);
   assert.equal(deterministic.definition.execution.tool,'depreciation_run');
   const readOnly=new DatabaseSync(dbPath,{readOnly:true});try{assert.throws(()=>S.readBusinessMemoryState(readOnly,scope),/finance_memory_not_prepared/);assert.throws(()=>S.appendBusinessMemoryMethodVersion(readOnly,scope,{}));}finally{readOnly.close();}
   process.env.FINANCE_DATABASE_PATH=join(root,'wrong-do-not-create.db');
   prepared=await B.prepareBusinessMemory({target},opts); assert.equal(prepared.scope.enterpriseKey,'SYNTH-MEMORY-A');
   assert.equal(fs.existsSync(process.env.FINANCE_DATABASE_PATH),false); assert.equal(S.inspectBusinessMemorySchema(db).ok,true);
   const install=db.prepare('SELECT * FROM business_memory_component_migrations').get(); assert.match(install.backup_sha256,/^[a-f0-9]{64}$/);
   const migrationBackup=fs.readdirSync(data).find(n=>n.startsWith('business-memory-install-')); const verified=LB.verifyBackup({backupDir:join(data,migrationBackup)}); assert.equal(verified.ok,true,JSON.stringify(verified));
   assert.ok(!(verified.manifest.components??[]).some(c=>c.name==='business-memory'),'迁移前备份不含尚未安装结构');
   const page=S.searchBusinessMemoryCases(db,scope,{topic:'rental_income',limit:100});
   assert.equal(page.total,2); assert.equal(page.items[0].status,'closed_posted'); assert.ok(page.items.every(c=>c.period<'2026-02'));
   assert.ok(!page.items.some(c=>c.sourceKey==='voucher:'+current.id||c.sourceKey==='voucher:'+future.id));
   initialCase=S.getBusinessMemoryCase(db,scope,vcase.caseRef);
   originalAssetMethod=S.listBusinessMemoryMethods(db,scope,{topic:'depreciation',limit:100}).items[0];
  });
  await t.test('R04/R14：不可覆盖版本、并发修订、企业隔离与原凭证保护',async()=>{
   const candidate={topic:'rental_income',objectKey:'LEASE-SYNTH',effectiveFrom:'2026-02',authority:'candidate',definition:{applicability:{dateField:'service_period',amountBasis:'tax_exclusive'},transformation:{kind:'proportional_allocation',allocationBasis:'contract_period'},gaps:['policy_unverified']},evidenceRefs:[{caseRef:initialCase.caseRef,sha256:initialCase.fingerprint}],expectedRevision:0};
   const v1=S.appendBusinessMemoryMethodVersion(db,scope,candidate); assert.equal(v1.revision,1);
   assert.throws(()=>S.appendBusinessMemoryMethodVersion(db,scope,candidate),/revision_conflict/);
   operatorVersion=S.appendBusinessMemoryMethodVersion(db,scope,{...candidate,authority:'operator_decision',expectedRevision:1,supersedes:v1.methodRef,reason:'此处仅为本机存储原语fixture，模型工具不具备操作者确认权'});
   assert.equal(operatorVersion.revision,2); assert.notEqual(v1.methodRef,operatorVersion.methodRef);
   for(const sql of ['UPDATE business_memory_versions SET content_digest=content_digest','DELETE FROM business_memory_versions','INSERT OR REPLACE INTO business_memory_versions SELECT * FROM business_memory_versions LIMIT 1'])assert.throws(()=>db.exec(sql),/history_immutable/);
   const bscope=resolveDirectFinanceTarget({accountSetId:b,period:'2026-02'},dbPath).scope;
   assert.equal(S.getBusinessMemoryMethod(db,bscope,v1.methodRef),null); assert.equal(S.searchBusinessMemoryCases(db,bscope,{limit:100}).total,0);
   assert.throws(()=>S.assertBusinessMemoryScope(db,{...scope,enterpriseKey:bscope.enterpriseKey}),/scope_mismatch/);
   assert.throws(()=>S.assertBusinessMemoryScope(db,{...scope,databaseInstanceId:randomUUID()}),/scope_mismatch/);
   assert.throws(()=>A.createVoucher(b,{period:'2026-02',voucher_date:'2026-02-15',status:'posted',entries:[{code:'1002',debit:1},{code:'5001',credit:1}]}),/posting_needs_review/);
   const run=S.recordBusinessMemoryRun(db,scope,{methodRef:originalAssetMethod.methodRef,status:'fixture_observed',resultRef:'synthetic-result'}); assert.equal(run.methodVersion,originalAssetMethod.version);
   assert.throws(()=>db.exec('DELETE FROM business_memory_runs'),/history_immutable/);
   const beforeRollback=logical(db),observation=B.observeBusinessMemory({target},opts);let checks=0;
   assert.throws(()=>S.replaceBusinessMemoryIndex(db,scope,observation,{verify:()=>{if(++checks===2)throw S.businessMemoryError('finance_memory_sources_changed');}}),/finance_memory_sources_changed/);
   assert.equal(logical(db),beforeRollback,'提交前发现来源变化时，索引、状态及方法版本整体回滚');
   assert.equal(S.inspectBusinessMemorySchema(db).ok,true);
  });
  await t.test('R01/R02/R11：真实计算来源关联、读日志不污染、修改来源使依据失效',async()=>{
   const source=join(sources,'calculation.JSON'); fs.writeFileSync(source,JSON.stringify({amount:100}));
   const args={title:'合成历史比例计算',engine:'javascript',script:"import fs from 'node:fs'; const i=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); fs.writeFileSync(i.outputDir+'/allocation.json',JSON.stringify({value:i.parameters.amount/2}));",parameters:{amount:100},sources:[{path:source}]};
   const client=await recordedClient({accountSetId:a});let result;
   try {
    const response=await client.call('finance_calculation_run',args);assert.equal(response.isError,false,response.text);result=response.data;assert.equal(result.status,'executed');
    const actualCall=readJson(join(audit,readJson(result.recordPath).callId,'end.json'));assert.equal(actualCall.scopeState,'observed');assert.equal(actualCall.scope.accountSetId,a);assert.equal(actualCall.scope.enterpriseKey,scope.enterpriseKey);assert.equal(actualCall.scope.databaseInstanceId,scope.databaseInstanceId);assert.equal(actualCall.scope.period,'2026-01');
    const failed=await client.call('finance_calculation_run',{...args,script:'process.exit(2)'});assert.equal(failed.isError,true,failed.text);assert.equal(failed.data.status,'failed');
   } finally { await client.close(); }
   const before=B.observeBusinessMemory({target},opts);
   const calculation=before.cases.find(c=>c.topic==='calculation'&&c.summary.runId===result.runId); assert.equal(calculation.status,'executed_unreviewed');
   assert.equal(S.getBusinessMemoryCase(db,scope,calculation.caseRef).status,'executed_unreviewed','普通绑定计算的end落盘后自动持久化，无需测试补prepare');
   assert.ok(before.cases.some(c=>c.topic==='calculation'&&c.status==='failed'));
   assert.equal(before.methods.find(m=>m.topic==='calculation'&&m.objectKey===result.runId).definition.execution.script,args.script);
   assert.ok(before.methods.filter(m=>m.topic==='calculation').every(m=>m.authority==='observed_history'));
   await B.prepareBusinessMemory({target},opts);const persisted=S.readBusinessMemoryState(db,scope);
   const reader=await recordedClient({bound:false});try {
    const context=await reader.call('finance_company_context',{target});assert.equal(context.isError,false,context.text);
    const unbound=await reader.call('finance_calculation_run',{title:'合成未绑定计算',engine:'javascript',script:'console.log(3)',parameters:{period:'2026-01'},sources:[]});assert.equal(unbound.isError,false,unbound.text);
    const call=readJson(join(audit,readJson(unbound.data.recordPath).callId,'end.json'));assert.equal(call.scopeState,'unknown');assert.ok(!B.observeBusinessMemory({target},opts).cases.some(c=>c.summary.runId===unbound.data.runId),'普通period参数不能猜企业归属');
   } finally { await reader.close(); }
   assert.equal(B.observeBusinessMemory({target},opts).fingerprint,persisted.fingerprint,'只读调用记录不能让记忆永久stale');
   const beforeRead=logical(db);fs.writeFileSync(source,JSON.stringify({amount:101}));
   const after=B.observeBusinessMemory({target},opts);assert.notEqual(after.fingerprint,persisted.fingerprint);assert.equal(logical(db),beforeRead);
   assert.notEqual(after.cases.find(c=>c.caseRef===calculation.caseRef).fingerprint,calculation.fingerprint);
   assert.equal(S.getBusinessMemoryMethod(db,scope,operatorVersion.methodRef).methodRef,operatorVersion.methodRef);
   // 原资产参数未变，计算来源修订不使无关确定性资产方法失效。
   for(const e of originalAssetMethod.evidenceRefs)assert.equal(after.sourceState.references[e.ref],e.sha256);
   const originalPath=initialCase.sourceRefs.find(s=>s.kind==='posting_evidence').sources[0].path;fs.appendFileSync(originalPath,' ');
   const changed=B.observeBusinessMemory({target},opts).cases.find(c=>c.caseRef===initialCase.caseRef);assert.notEqual(changed.fingerprint,initialCase.fingerprint);assert.ok(changed.gaps.includes('source_version_unverified'));
   assert.equal(S.getBusinessMemoryCase(db,scope,initialCase.caseRef).fingerprint,initialCase.fingerprint,'只读观察没有暗刷新');
   await B.prepareBusinessMemory({target},opts);assert.equal(S.getBusinessMemoryCase(db,scope,initialCase.caseRef).fingerprint,changed.fingerprint);
  });
  await t.test('R01/R03/R06：真实绑定MCP方法执行进入下月历史，脚本、参数和不可变版本逐项核验',async()=>{
   const january={accountSetId:a,period:'2026-01'},client=await recordedClient({accountSetId:a});let run,selected;
   const script="import fs from 'node:fs';const i=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));fs.writeFileSync(i.outputDir+'/method-result.json',JSON.stringify({value:i.parameters.amount/i.parameters.divisor,period:i.parameters.period}));";
   try {
    const proposal=await client.call('finance_memory_propose',{target:january,topic:'calculation',objectKey:'SYNTHETIC-METHOD-RUN-HISTORY',effectiveFrom:'2026-01',definition:{title:'合成按已选版本执行',applicability:{objectScope:'account_set',businessView:'accounting'},inputs:[{key:'amount',meaning:'amount',field:'other',type:'number',source:'current_parameters',required:true},{key:'period',meaning:'period',field:'current_period',type:'string',source:'current_parameters',required:true},{key:'divisor',meaning:'ratio',type:'number',source:'constant',default:2}],transformation:{kind:'script'},execution:{kind:'script',engine:'javascript',script},gaps:['policy_unverified']},evidenceRefs:[]});assert.equal(proposal.isError,false,proposal.text);
    selected=await selectSyntheticVersion(january,proposal.data.methodRef);
    const result=await client.call('finance_method_run',{target:january,methodRef:selected.methodRef,parameters:{amount:14}});assert.equal(result.isError,false,result.text);run=result.data;assert.equal(run.status,'executed');assert.equal(run.result.kind,'derived_calculation');assert.equal(readJson(run.result.outputs[0].path).value,7);
   } finally {await client.close();}
   const observed=B.observeBusinessMemory({target},opts),c=observed.cases.find(c=>c.summary.runId===run.result.runId);assert.equal(c.status,'executed_unreviewed');assert.equal(c.authority,'observed_history');assert.equal(c.methodRef,selected.methodRef);assert.equal(c.methodVersion,run.methodVersion);
   methodHistoryCase=c;
   const provenance=c.sourceRefs.find(s=>s.kind==='calculation_record').provenance;assert.equal(provenance.methodRef,selected.methodRef);assert.equal(provenance.methodRunId,run.runRef.slice(3));
   assert.equal(S.getBusinessMemoryCase(db,scope,c.caseRef).status,'executed_unreviewed','method_run正常响应前已经自动收录案例');
   const recorded=observed.methods.find(m=>m.topic==='calculation'&&m.objectKey===run.result.runId);assert.equal(recorded.authority,'observed_history');assert.equal(recorded.definition.execution.script,script);
   await B.prepareBusinessMemory({target},opts);assert.ok(S.searchBusinessMemoryCases(db,scope,{topic:'calculation',objectKey:run.result.runId}).items.some(item=>item.caseRef===c.caseRef));
   const dir=join(audit,'calculations',run.result.runId),recordPath=join(dir,'record.json'),requestPath=join(dir,'request.json'),inputPath=join(dir,'input.json'),scriptPath=join(dir,'script.mjs'),beginPath=join(audit,'methods',run.runRef.slice(3),'begin.json');
   const originals=new Map([recordPath,requestPath,inputPath,scriptPath,beginPath].map(path=>[path,fs.readFileSync(path)])),before=logical(db);
   const unknown=()=>{const changed=B.observeBusinessMemory({target},opts);assert.equal(changed.cases.find(item=>item.caseRef===c.caseRef).status,'unknown');assert.equal(changed.sourceState.referenceStates[c.caseRef],'changed');assert.ok(!changed.methods.some(m=>m.objectKey===run.result.runId),'失去已核执行版本时不能生成可复用脚本方法');};
   try {
    fs.appendFileSync(scriptPath,'\nconsole.log("synthetic altered script");');unknown();fs.writeFileSync(scriptPath,originals.get(scriptPath));
    // 同时重算计算器内部摘要也不能替换外层MCP实参及数据库绑定的不可变版本。
    const request=readJson(requestPath),input=readJson(inputPath),record=readJson(recordPath);request.parameters.amount=999;input.parameters.amount=999;record.parameters.amount=999;
    fs.writeFileSync(requestPath,JSON.stringify(request));fs.writeFileSync(inputPath,JSON.stringify(input));record.request={sha256:hash(requestPath),bytes:fs.statSync(requestPath).size};record.input={sha256:hash(inputPath),bytes:fs.statSync(inputPath).size};fs.writeFileSync(recordPath,JSON.stringify(record));unknown();
    for(const path of [recordPath,requestPath,inputPath])fs.writeFileSync(path,originals.get(path));
    const begin=readJson(beginPath);begin.scope.accountSetId=b;fs.writeFileSync(beginPath,JSON.stringify(begin));unknown();
   } finally {for(const [path,value]of originals)fs.writeFileSync(path,value);}
   assert.equal(logical(db),before,'版本及执行文件核验保持只读');assert.equal(B.observeBusinessMemory({target},opts).cases.find(item=>item.caseRef===c.caseRef).status,'executed_unreviewed');
   await assert.rejects(B.prepareBusinessMemory({target},{...opts,readOnly:true}),/finance_memory_readonly/);assert.equal(logical(db),before);
  });
  await t.test('R04/R11：跨月份与新进程重启保留版本，同企业其他新账只影响相关依据',async()=>{
   const a1=B.observeBusinessMemory({target},opts), march={accountSetId:a,period:'2026-03'},a2=B.observeBusinessMemory({target:march},opts);assert.equal(a1.fingerprint,a2.fingerprint);
   const count=db.prepare("SELECT COUNT(*) n FROM business_memory_versions WHERE account_set_id=? AND topic='depreciation'").get(a).n;
   await B.prepareBusinessMemory({target:march},opts);assert.equal(db.prepare("SELECT COUNT(*) n FROM business_memory_versions WHERE account_set_id=? AND topic='depreciation'").get(a).n,count);
   const before=B.observeBusinessMemory({target},opts).fingerprint;make(b,'2026-02',3);assert.equal(B.observeBusinessMemory({target},opts).fingerprint,before,'另一企业的业务不污染本企业记忆');
   const script=`const S=await import(${JSON.stringify(new URL('../server/business-memory-storage.mjs',import.meta.url).href)});const B=await import(${JSON.stringify(new URL('../server/business-memory-bootstrap.mjs',import.meta.url).href)});const {DatabaseSync}=await import('node:sqlite');const observed=B.observeBusinessMemory(${JSON.stringify({target})},${JSON.stringify(opts)});const db=new DatabaseSync(${JSON.stringify(dbPath)},{readOnly:true});try{const method=S.getBusinessMemoryMethod(db,observed.scope,${JSON.stringify(operatorVersion.methodRef)});process.stdout.write(JSON.stringify({authority:method.authority,revision:method.revision,methodRef:method.methodRef,fingerprint:observed.fingerprint}));}finally{db.close();}`;
   const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(child.status,0,child.stderr);const reloaded=JSON.parse(child.stdout);assert.equal(reloaded.methodRef,operatorVersion.methodRef);assert.equal(reloaded.authority,'operator_decision');assert.equal(reloaded.fingerprint,before);
   const readonlyScript=`const {db}=await import(${JSON.stringify(new URL('../server/db.mjs',import.meta.url).href)});const S=await import(${JSON.stringify(new URL('../server/business-memory-storage.mjs',import.meta.url).href)});try{if(!S.inspectBusinessMemorySchema(db).ok||db.prepare('PRAGMA query_only').get().query_only!==1)throw Error('readonly memory admission');process.stdout.write('readonly current memory admitted');}finally{db.close();}`;
   const readBefore=logical(db),readonly=spawnSync(process.execPath,['--input-type=module','-e',readonlyScript],{env:{...process.env,WORKBENCH_DATA_DIR:data,WORKBENCH_DATABASE_MODE:'readonly'},encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(readonly.status,0,readonly.stderr);assert.match(readonly.stdout,/readonly current memory admitted/);assert.equal(logical(db),readBefore);
   assert.equal(S.inspectBusinessMemorySchema(db).ok,true);
  });
  await t.test('R04/R11：跨期换资料及记录根，旧案例留存且不会越权读取旧原件',async()=>{
   const source=join(sources,'stable-formula.json');fs.writeFileSync(source,JSON.stringify({value:60}));
   const args={title:'合成可跨期资料算法',engine:'javascript',script:'console.log(60/3)',parameters:{ratio:3},sources:[{path:source}]};
   const client=await recordedClient({accountSetId:a});let result;try {const response=await client.call('finance_calculation_run',args);assert.equal(response.isError,false,response.text);result=response.data;assert.equal(result.status,'executed');}finally{await client.close();}
   await B.prepareBusinessMemory({target},opts);
   const oldObservation=B.observeBusinessMemory({target},opts),oldCase=oldObservation.cases.find(c=>c.summary.runId===result.runId);
   const version=S.listBusinessMemoryMethods(db,scope,{topic:'calculation',objectKey:result.runId,limit:100}).items[0];
   const selected=S.appendBusinessMemoryMethodVersion(db,scope,{topic:version.topic,objectKey:version.objectKey,effectiveFrom:'2026-02',authority:'operator_decision',definition:version.definition,evidenceRefs:version.evidenceRefs,supersedes:version.methodRef,expectedRevision:version.revision});
   const nextSources=join(root,'march-sources'),nextAudit=join(root,'march-calls');fs.mkdirSync(nextSources);fs.mkdirSync(nextAudit);
   const nextOptions={...opts,sourceRoot:nextSources,auditDir:nextAudit},nextTarget={accountSetId:a,period:'2026-03'};
   const sourceOnly=B.observeBusinessMemory({target:nextTarget},{...opts,sourceRoot:nextSources});assert.equal(sourceOnly.fingerprint,oldObservation.fingerprint,'仍能读取旧记录时也不能因授权根变化抹掉已知来源修订');
   const read=fs.readFileSync;
   fs.readFileSync=function(path,...args){const p=String(path);assert.ok(!p.startsWith(sources)&&!p.startsWith(audit),'不得读取新工作区未授权的旧资料或旧调用记录');return read.call(this,path,...args);};syncBuiltinESMExports();
   try {
    const moved=B.observeBusinessMemory({target:nextTarget},nextOptions);
    assert.equal(moved.cases.find(c=>c.caseRef===oldCase.caseRef).fingerprint,oldCase.fingerprint);
    assert.equal(moved.sourceState.referenceStates[oldCase.caseRef],'unavailable');
    const methodRef='method:'+methodHistoryCase.methodRef,method=S.getBusinessMemoryMethod(db,scope,methodHistoryCase.methodRef);
    assert.equal(moved.sourceState.references[methodRef],S.businessMemoryDigest(method));assert.equal(moved.sourceState.referenceStates[methodRef],'current');
    assert.equal(moved.fingerprint,oldObservation.fingerprint,'仅切换授权根不伪造来源修订');
    // 缓存自报的版本摘要不能被直接复制成当前可信引用。
    const cachedRow=db.prepare('SELECT content_json FROM business_memory_cases WHERE case_ref=?').get(methodHistoryCase.caseRef),spoof=JSON.parse(cachedRow.content_json);
    spoof.sourceRefs.find(s=>s.kind==='calculation_record').provenance.methodDigest='0'.repeat(64);const encoded=S.canonicalBusinessMemory(spoof);
    db.prepare('UPDATE business_memory_cases SET content_json=?,content_digest=? WHERE case_ref=?').run(encoded,createHash('sha256').update(encoded).digest('hex'),methodHistoryCase.caseRef);
    try {const checked=B.observeBusinessMemory({target:nextTarget},nextOptions);assert.notEqual(checked.sourceState.references[methodRef],'0'.repeat(64));assert.equal(checked.sourceState.referenceStates[methodRef],'changed');assert.equal(checked.sourceState.referenceStates[methodHistoryCase.caseRef],'changed');}
    finally {db.prepare('UPDATE business_memory_cases SET content_json=?,content_digest=? WHERE case_ref=?').run(cachedRow.content_json,createHash('sha256').update(cachedRow.content_json).digest('hex'),methodHistoryCase.caseRef);}
    await B.prepareBusinessMemory({target:nextTarget},nextOptions);
    const stored=S.getBusinessMemoryMethod(db,{...scope,period:'2026-03'},selected.methodRef);assert.equal(stored.definition.execution.script,args.script);
    assert.equal(S.getBusinessMemoryCase(db,scope,oldCase.caseRef).fingerprint,oldCase.fingerprint);
   } finally { fs.readFileSync=read;syncBuiltinESMExports(); }
   const afterRestart=spawnSync(process.execPath,['--input-type=module','-e',`const B=await import(${JSON.stringify(new URL('../server/business-memory-bootstrap.mjs',import.meta.url).href)}); const o=B.observeBusinessMemory(${JSON.stringify({target:nextTarget})},${JSON.stringify(nextOptions)});process.stdout.write(JSON.stringify({fingerprint:o.fingerprint,case:o.cases.find(c=>c.caseRef===${JSON.stringify(oldCase.caseRef)})}));`],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(afterRestart.status,0,afterRestart.stderr);assert.equal(JSON.parse(afterRestart.stdout).case.fingerprint,oldCase.fingerprint);
   // 显式回到原授权目录后，文件真实消失必须与不可访问分开。
   fs.unlinkSync(source);const missing=B.observeBusinessMemory({target},opts);assert.equal(missing.sourceState.referenceStates[oldCase.caseRef],'changed');assert.notEqual(missing.cases.find(c=>c.caseRef===oldCase.caseRef).fingerprint,oldCase.fingerprint);
   await B.prepareBusinessMemory({target},opts);
   await B.prepareBusinessMemory({target},opts);
  });
  await t.test('R04/R14：原生整账删除清理记忆，账套存在时版本与执行记录仍不可单独删除',async()=>{
   const newSet=suffix=>A.createAccountSet({name:'合成删除兼容'+suffix,start_period:'2026-01',profileId:'small-2011-basic-v1',enterprise:{enterpriseKey:'SYNTH-MEMORY-DELETE-'+suffix,enterpriseName:'合成删除兼容'+suffix}}).id;
   const memoryRows=id=>S.BUSINESS_MEMORY_TABLES.filter(table=>table!=='business_memory_component_migrations').map(table=>[table,db.prepare('SELECT * FROM '+table+' WHERE account_set_id=? ORDER BY rowid').all(id)]);
   const otherBefore=memoryRows(a),anotherBefore=memoryRows(b);
   const empty=newSet('EMPTY');await B.prepareBusinessMemory({target:{accountSetId:empty,period:'2026-02'}},opts);
   assert.equal(db.prepare('SELECT COUNT(*) n FROM business_memory_state WHERE account_set_id=?').get(empty).n,1);
   A.deleteAccountSet(empty);
   assert.equal(db.prepare('SELECT COUNT(*) n FROM account_sets WHERE id=?').get(empty).n,0);
   assert.ok(memoryRows(empty).every(([,rows])=>rows.length===0),'prepare空账后原删除入口仍可完成');
   const populated=newSet('WITH-HISTORY');make(populated,'2026-01',1);
   const deletingTarget={accountSetId:populated,period:'2026-02'};await B.prepareBusinessMemory({target:deletingTarget},opts);
   const deletingScope=resolveDirectFinanceTarget(deletingTarget,dbPath).scope;
   const candidate={topic:'calculation',objectKey:'deletion-fixture',effectiveFrom:'2026-02',authority:'candidate',definition:{execution:{kind:'script',engine:'javascript',script:'console.log(1)'},gaps:[]},evidenceRefs:[]};
   const v1=S.appendBusinessMemoryMethodVersion(db,deletingScope,{...candidate,expectedRevision:0});
   const v2=S.appendBusinessMemoryMethodVersion(db,deletingScope,{...candidate,expectedRevision:1,supersedes:v1.methodRef});
   S.recordBusinessMemoryRun(db,deletingScope,{methodRef:v2.methodRef,status:'synthetic_fixture'});
   const beforeDelete=memoryRows(populated);assert.ok(beforeDelete.every(([,rows])=>rows.length>0));
   for(const table of ['business_memory_topics','business_memory_versions','business_memory_runs']) {
    assert.throws(()=>db.prepare('DELETE FROM '+table+' WHERE account_set_id=?').run(populated),/finance_memory_history_immutable/);
    assert.throws(()=>db.prepare('INSERT OR REPLACE INTO '+table+' SELECT * FROM '+table+' WHERE account_set_id=? LIMIT 1').run(populated),/finance_memory_history_immutable/);
   }
   for(const table of ['business_memory_versions','business_memory_runs'])assert.throws(()=>db.prepare('UPDATE '+table+' SET status=status WHERE account_set_id=?'.replace('SET status=status',table==='business_memory_versions'?'SET authority=authority':'SET status=status')).run(populated),/finance_memory_history_immutable/);
   assert.deepEqual(memoryRows(populated),beforeDelete);
   // 经原生accounting审计入口删除整账；条件触发器成功意味着SQLite级联阶段父行已经不存在。
   A.deleteAccountSet(populated);
   assert.equal(db.prepare('SELECT COUNT(*) n FROM account_sets WHERE id=?').get(populated).n,0);
   assert.ok(memoryRows(populated).every(([,rows])=>rows.length===0));
   assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_operations WHERE action='account_set.delete' AND state='succeeded'").get().n,2);
   assert.deepEqual(memoryRows(a),otherBefore);assert.deepEqual(memoryRows(b),anotherBefore);
   assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(S.inspectBusinessMemorySchema(db).ok,true);
  });
  await t.test('R04/R14：严格备份、恢复pending、显式激活后新实例沿用版本与全表保留',async()=>{
   const outDir=join(root,'official-backup'),before=logical(db),backup=LB.createBackup({dbPath,outDir});assert.equal(backup.ok,true,JSON.stringify(backup));assert.equal(logical(db),before);
   const component=backup.manifest.components.find(c=>c.name==='business-memory');assert.equal(component.version,1);assert.deepEqual(component.tables,[...S.BUSINESS_MEMORY_TABLES]);assert.equal(LB.verifyBackup({backupDir:outDir}).ok,true);
   const ledgerDir=join(root,'restore-ledger');fs.mkdirSync(ledgerDir);const args={backupDir:outDir,targetDir:join(root,'restored'),ledgerPath:join(ledgerDir,'ledger.db'),operationId:randomUUID()};
   const restored=LB.restoreNew(args);assert.equal(restored.ok,true,JSON.stringify(restored)); const file=join(args.targetDir,'workbench.db');
   const targetDb=new DatabaseSync(file,{readOnly:true});try{for(const table of S.BUSINESS_MEMORY_TABLES)assert.deepEqual(targetDb.prepare('SELECT * FROM '+table+' ORDER BY rowid').all(),db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());assert.equal(S.inspectBusinessMemorySchema(targetDb).ok,true);}finally{targetDb.close();}
   await assert.rejects(B.prepareBusinessMemory({target},{...opts,dbPath:file}),/restore_target_pending/);
   const plan={version:1,targetInstanceId:restored.receipt.targetInstanceId,jobs:[]};
   const activate=await LB.activateRestoreTarget({...args,outDir:join(root,'activation-protection'),plan});assert.equal(activate.ok,true,JSON.stringify(activate));
   const actual=resolveDirectFinanceTarget(target,file).scope;assert.notEqual(actual.databaseInstanceId,scope.databaseInstanceId);
   const reopened=new DatabaseSync(file,{readOnly:true});try{assert.equal(S.getBusinessMemoryMethod(reopened,actual,operatorVersion.methodRef).revision,2);assert.equal(S.inspectBusinessMemorySchema(reopened).ok,true);}finally{reopened.close();}
   const refreshed=await B.prepareBusinessMemory({target},{...opts,dbPath:file});assert.equal(refreshed.prepared,true);assert.equal(refreshed.scope.enterpriseKey,scope.enterpriseKey);
   const again=LB.createBackup({dbPath:file,outDir:join(root,'restored-backup')});assert.equal(again.ok,true,JSON.stringify(again));assert.equal(LB.verifyBackup({backupDir:again.backupDir}).ok,true);
  });
  await t.test('R04/R14：缺索引、附加触发器、内容修订和未来结构一律拒绝备份',async()=>{
   const good=LB.createBackup({dbPath,outDir:join(root,'tamper-source')});assert.equal(good.ok,true,JSON.stringify(good));
   const mutations=[
    ['index',d=>d.exec('DROP INDEX business_memory_cases_search')],
    ['trigger',d=>d.exec("CREATE TRIGGER rogue_memory AFTER INSERT ON account_sets BEGIN DELETE FROM business_memory_cases; END")],
    ['content',d=>{d.exec('DROP TRIGGER business_memory_versions_immutable_update');d.exec("UPDATE business_memory_versions SET content_json='{}'");}],
    ['future',d=>{d.exec('DROP TRIGGER business_memory_component_migrations_immutable_update');d.exec('PRAGMA ignore_check_constraints=ON; UPDATE business_memory_component_migrations SET version=2');}],
   ];
   for(const [name,mutate] of mutations){
    const file=join(root,'tamper-'+name+'.db');fs.copyFileSync(join(good.backupDir,LB.SNAPSHOT_FILE),file);const c=new DatabaseSync(file);try{mutate(c);assert.equal(S.inspectBusinessMemorySchema(c).ok,false);}finally{c.close();}
    const rejected=LB.createBackup({dbPath:file,outDir:join(root,'reject-'+name)});assert.equal(rejected.ok,false,name);assert.equal(rejected.code,'source_structure_invalid',JSON.stringify(rejected));
   }
   assert.equal(S.inspectBusinessMemorySchema(db).ok,true);
  });
 } finally { db.close(); console.log('合成企业记忆测试目录 '+root); }
});
