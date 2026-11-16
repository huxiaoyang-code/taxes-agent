// 生产 SQLite + 真实 direct MCP/HTTP；全部资料由本测试合成，不访问现有业务目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {syntheticVoucherEvidence} from './helpers/synthetic-posting-evidence.mjs';
import * as M from '../server/business-memory.mjs';
import {retainDirectMethodProjection,readDirectMethodProjection} from '../server/finance-direct-method-result.mjs';
import {withFinanceCall} from '../server/finance-call-chain.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function waitUntil(check,timeout=10000){const started=Date.now();while(Date.now()-started<timeout){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('synthetic_condition_timeout');}
test('方法只复用已标记的既有direct投影，JSON仿形不能冒充且保留执行当时快照',()=>{
 const visible={version:'finance-tax-summary-result/1',status:'conditional_calculated',amounts:{due:800},conditions:[{code:'synthetic_condition',state:'unverified'}],scenarios:[]};
 assert.equal(readDirectMethodProjection('finance_tax_summary_calculate',visible),null);
 retainDirectMethodProjection('finance_tax_summary_calculate',visible);
 assert.equal(readDirectMethodProjection('finance_tax_summary_calculate',JSON.parse(JSON.stringify(visible))),null);
 assert.equal(readDirectMethodProjection('finance_workpaper',visible),null);
 visible.amounts.due=999;assert.equal(readDirectMethodProjection('finance_tax_summary_calculate',visible).amounts.due,800);
 assert.throws(()=>retainDirectMethodProjection('finance_tax_summary_calculate',{version:'unknown',raw:'PRIVATE'}),{code:'finance_memory_native_result_unconfirmed'});
});
async function simulatedLocalSelection(args,options,{effectiveFrom=args.target.period,effectiveTo=''}={}){
 const input=new PassThrough(),output=new PassThrough();input.isTTY=true;output.isTTY=true;output.columns=120;
 const prompts=['操作者姓名（声明）：','核对依据与选择/变更理由：','生效期间（回车使用','终止期间（可留空，跨期延续）：','仅确认上述版本请输入'],answers=['合成操作者','测试夹具明确选择所显示的合成脚本版本，不代表真实业务审核',effectiveFrom,effectiveTo,`选择 ${args.methodRef}`];let index=0,buffer='';
 output.on('data',bytes=>{buffer+=bytes.toString('utf8');if(index<prompts.length&&buffer.includes(prompts[index])){const answer=answers[index++];buffer='';setImmediate(()=>input.write(answer+'\n'));}});
 try{return await M.selectBusinessMethodInteractively(args,options,{input,output});}finally{input.destroy();output.destroy();}
}
test('企业方法固定投影、选择、同版本跨期真实执行、原生守卫和会话范围',{timeout:120000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'business-memory-domain-')),data=join(root,'data'),sources=join(root,'sources'),audit=join(root,'calls');mkdirSync(data);mkdirSync(sources);
 process.env.WORKBENCH_DATA_DIR=data;process.env.FINANCE_SOURCE_ROOT=sources;process.env.FINANCE_AUDIT_DIR=audit;process.env.FINANCE_BUSINESS_SESSION='';
 const {db}=await import('../server/db.mjs'),A=await import('../server/accounting.mjs');
 const dbPath=join(data,'workbench.db'),options={dbPath,sourceRoot:sources,auditDir:audit};process.env.FINANCE_DATABASE_PATH=dbPath;
 const a=A.createAccountSet({name:'PRIVATE-合成甲',start_period:'2026-01',profileId:'small-2011-basic-v1',enterprise:{enterpriseKey:'PRIVATE-SYNTHETIC-A'}}).id,b=A.createAccountSet({name:'PRIVATE-合成乙',start_period:'2026-01',profileId:'small-2011-basic-v1',enterprise:{enterpriseKey:'PRIVATE-SYNTHETIC-B'}}).id;
 A.addAccount(a,{code:'500101',name:'租金收入',category:'损益',direction:'credit'});
 A.setOpeningBalances(a,[{code:'1601',debit:12000},{code:'3001',credit:12000}]);
 const voucher=A.createVoucher(a,syntheticVoucherEvidence({period:'2026-01',voucher_date:'2026-01-15',status:'posted',number:1,summary:'PRIVATE-合同原文',entries:[{code:'1002',debit:1200},{code:'500101',credit:1200}]},sources));
 const historicalCarry=A.carryForwardProfit(a,'2026-01');assert(historicalCarry.voucher?.id);A.postVoucher(a,historicalCarry.voucher.id);
 A.addAssetCard(a,{name:'PRIVATE-设备',original_cost:12000,residual_rate:0,useful_life_months:12,start_period:'2026-02',acquired_period:'2026-01'});
 const target={accountSetId:a,period:'2026-02'},logical=()=>JSON.stringify(db.prepare('SELECT * FROM vouchers ORDER BY id').all());
 let client,backend,base,candidate,selected;
 const script="import fs from 'node:fs'; const i=JSON.parse(fs.readFileSync(process.argv[2])); const rows=JSON.parse(fs.readFileSync(i.sources[0].snapshotPath)); const unique=new Map(rows.map(r=>[r.invoice_number,r])); const amount=[...unique.values()].filter(r=>r.period===i.parameters.period).reduce((n,r)=>n+r.net_rent,0)*i.parameters.ratio; fs.writeFileSync(i.outputDir+'/rent.json',JSON.stringify({amount,period:i.parameters.period}));";
 const definition={title:'PRIVATE-租赁取数方法',applicability:{objectScope:'account_set',dateField:'service_period',amountBasis:'tax_exclusive',deduplicateBy:'invoice_number',businessView:'accounting',requiredConditions:['contract_overlaps_period']},inputs:[{key:'ratio',meaning:'ratio',field:'allocation_ratio',sourceRole:'lease_contract',type:'number',required:true,source:'current_parameters'}],transformation:{kind:'proportional_allocation',allocationBasis:'fixed_ratio',rounding:'half_up_cent',missingValues:'reject',steps:[{op:'deduplicate',inputs:['rows'],keys:['invoice_number'],output:'unique_rows'},{op:'filter_period',inputs:['unique_rows'],periodField:'period',output:'current_rows'},{op:'sum',inputs:['current_rows'],amountField:'net_rent',output:'total'},{op:'allocate',inputs:['total','ratio'],unit:'fixed_ratio',output:'recognized_rent'}]},accounts:[{role:'main_income',code:'500101',side:'credit'}],execution:{kind:'script',engine:'javascript',script},gaps:['policy_unverified']};
 const startClient=(session='')=>new McpStdioClient(join(repo,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{cwd:root,env:{FINANCE_MCP_PROFILE:'direct',FINANCE_DATABASE_PATH:dbPath,FINANCE_SOURCE_ROOT:sources,FINANCE_AUDIT_DIR:audit,FINANCE_API_BASE:base??'http://127.0.0.1:1',FINANCE_BUSINESS_SESSION:session},timeoutMs:20000}).start();
 try{
  await t.test('未准备只读上下文不建表；准备后真实MCP读取实际历史分录与业务方法',async()=>{
   assert.equal((await M.readCompanyContext({target},options)).status,'unprepared');assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='business_memory_state'").get(),undefined);
   const prepared=await M.prepareBusinessMemory({target},options);assert.equal(prepared.status,'prepared');
   client=startClient();await client.initialize();const listed=(await client.rpc('tools/list')).result.tools;
   for(const name of ['finance_company_context','finance_method_read','finance_case_search'])assert.equal(listed.find(s=>s.name===name).annotations.readOnlyHint,true);
   for(const name of ['finance_memory_prepare','finance_memory_propose','finance_method_run'])assert.equal(listed.find(s=>s.name===name).annotations.readOnlyHint,false);
   const context=(await client.call('finance_company_context',{target})).data;assert.equal(context.status,'ready');
   const method=context.methods.find(m=>m.topic==='depreciation');assert.equal(method.executable,true);const view=await client.call('finance_method_read',{target,methodRef:method.methodRef});assert.equal(view.isError,false,view.text);assert.equal(view.data.definition.transformation.kind,'straight_line');assert.equal(view.data.definition.transformation.assetConfiguration[0].usefulLifeMonths,12);
   const before=logical(),cases=await client.call('finance_case_search',{target,topic:'rental_income'});assert.equal(cases.isError,false,cases.text);assert.equal(cases.data.cases[0].entries[0].debit,1200);assert.equal(cases.data.cases[0].entries[1].role,'main_income');assert.equal(cases.data.cases[0].voucher.voucherId,voucher.id);assert.equal(logical(),before);
   const safe=JSON.stringify([context,view.data,cases.data]);for(const secret of ['PRIVATE-','500101',sources,script])assert(!safe.includes(secret),secret);
  });
  await t.test('模型只能提出candidate，固定投影保留输入语义、去重与分摊步骤，CLI拒绝pipe',async()=>{
   const response=await client.call('finance_memory_propose',{target,topic:'rental_income',objectKey:'synthetic-lease',effectiveFrom:'2026-02',definition,evidenceRefs:[]});assert.equal(response.isError,false,response.text);candidate=response.data.methodRef;
   const selfApprove=await client.call('finance_memory_propose',{target,topic:'rental_income',effectiveFrom:'2026-02',authority:'operator_decision',definition,evidenceRefs:[]});assert.equal(selfApprove.isError,true);
   const blocked=await client.call('finance_method_run',{target,methodRef:candidate,parameters:{p0:0.8},sources:[]});assert.equal(blocked.isError,true);assert.match(blocked.text,/local_selection_required/);
   const view=(await client.call('finance_method_read',{target,methodRef:candidate})).data;assert.equal(view.definition.inputs[0].field,'allocation_ratio');assert.equal(view.definition.inputs[0].parameterKey,'ratio');assert.deepEqual(view.definition.transformation.steps[0].keys,['invoice_number']);assert.equal(view.definition.transformation.steps[2].amountField,'net_rent');assert(!JSON.stringify(view).includes('PRIVATE-'));
   const piped=spawnSync(process.execPath,[join(repo,'06-workbench/scripts/review-business-method.mjs'),'--db',dbPath,'--account-set-id',String(a),'--period','2026-02','--method-ref',candidate],{env:{...process.env,FINANCE_BUSINESS_SESSION:''},encoding:'utf8',input:'yes\n'});assert.notEqual(piped.status,0);assert.match(piped.stderr,/finance_memory_interactive_required/);
   selected=await simulatedLocalSelection({target,methodRef:candidate},options);assert.equal(selected.status,'selected');assert.notEqual(selected.methodRef,candidate);
  });
  await t.test('同一已选脚本版本消费两期不同金额/顺序/重复行，进程重启后返回真实新产物',async()=>{
   const feb=join(sources,'feb.json');writeFileSync(feb,JSON.stringify([{invoice_number:'F2',period:'2026-02',net_rent:250},{invoice_number:'F1',period:'2026-02',net_rent:750},{invoice_number:'F1',period:'2026-02',net_rent:750}]));
   const run=await client.call('finance_method_run',{target,methodRef:selected.methodRef,parameters:{p0:0.8},sources:[{path:feb}]});assert.equal(run.isError,false,run.text);assert.equal(run.data.status,'executed');assert.equal(JSON.parse(readFileSync(run.data.result.outputs[0].path)).amount,800);
   const free=await client.call('finance_method_run',{target,methodRef:selected.methodRef,script:'console.log(0)',sources:[]});assert.equal(free.isError,true);
   await client.close();client=startClient();await client.initialize();const march=join(sources,'march.json');writeFileSync(march,JSON.stringify([{invoice_number:'M2',period:'2026-03',net_rent:500},{invoice_number:'M1',period:'2026-03',net_rent:1500},{invoice_number:'M2',period:'2026-03',net_rent:500}]));
   const next=await client.call('finance_method_run',{target:{accountSetId:a,period:'2026-03'},methodRef:selected.methodRef,parameters:{ratio:0.8},sources:[{path:march}]});assert.equal(next.isError,false,next.text);assert.equal(next.data.methodVersion,run.data.methodVersion);assert.equal(next.data.execution.scriptSha256,run.data.execution.scriptSha256);assert.equal(JSON.parse(readFileSync(next.data.result.outputs[0].path)).amount,1600);
   const cross=await client.call('finance_method_run',{target:{accountSetId:b,period:'2026-03'},methodRef:selected.methodRef,sources:[]});assert.equal(cross.isError,true);
   const rows=db.prepare('SELECT content_json FROM business_memory_runs WHERE version_id=?').all(selected.methodRef).map(r=>JSON.parse(r.content_json));assert(rows.some(r=>r.period==='2026-02'&&r.status==='executed'));assert(rows.some(r=>r.period==='2026-03'&&r.status==='executed'));
  });
  await t.test('季度原生方法保留既有报告/数据包索引、摘要及来源摘要，可继续交付',async()=>{
   const quarterTarget={accountSetId:a,period:'2026-03'},direct=await client.call('finance_quarter_review',{target:quarterTarget});assert.equal(direct.isError,false,direct.text);
   const proposal=await client.call('finance_memory_propose',{target:quarterTarget,topic:'reconciliation',objectKey:'synthetic-quarter-review',effectiveFrom:'2026-03',definition:{applicability:{objectScope:'account_set'},inputs:[],transformation:{kind:'native_calculation'},execution:{kind:'native',tool:'finance_quarter_review',argsTemplate:{}}},evidenceRefs:[]});assert.equal(proposal.isError,false,proposal.text);
   const selection=await simulatedLocalSelection({target:quarterTarget,methodRef:proposal.data.methodRef},options);
   const run=await client.call('finance_method_run',{target:quarterTarget,methodRef:selection.methodRef});assert.equal(run.isError,false,run.text);assert.equal(run.data.result.version,direct.data.version);assert.deepEqual(run.data.result.summary,direct.data.summary);assert.equal(run.data.result.snapshotDigest,direct.data.snapshotDigest);
   assert(existsSync(run.data.result.reportRef));assert(existsSync(run.data.result.bundleRef));assert.match(run.data.result.bundleSha256,/^[a-f0-9]{64}$/);assert(run.data.result.bundleBytes>100);assert.match(readFileSync(run.data.result.reportRef,'utf8'),/季度账务复核/);
  });
  await t.test('缺少本期金额不能用旧月default继续；明确constant比例可保留默认配置',async()=>{
   const save=async(objectKey,inputs)=>{
    const proposal=await M.proposeBusinessMethod({target,topic:'rental_income',objectKey,effectiveFrom:'2026-02',definition:{applicability:{objectScope:'account_set'},inputs,execution:{kind:'script',engine:'javascript',script:"import fs from 'node:fs';const i=JSON.parse(fs.readFileSync(process.argv[2]));fs.writeFileSync(i.outputDir+'/amount.json',JSON.stringify(i.parameters));"}},evidenceRefs:[]},options);
    return simulatedLocalSelection({target,methodRef:proposal.methodRef},options);
   };
   const current=await save('current-input-default',[{key:'net_rent',meaning:'amount',field:'net_rent',type:'number',required:true,source:'current_parameters',default:99999}]);
   const before=db.prepare('SELECT COUNT(*) n FROM business_memory_runs').get().n;
   await assert.rejects(M.runBusinessMethod({target,methodRef:current.methodRef,sources:[]},options),{code:'finance_memory_current_input_required'});assert.equal(db.prepare('SELECT COUNT(*) n FROM business_memory_runs').get().n,before);
   const constant=await save('constant-ratio-default',[{key:'share',meaning:'ratio',field:'allocation_ratio',type:'number',required:true,source:'constant',default:0.5}]);
   const run=await M.runBusinessMethod({target,methodRef:constant.methodRef,sources:[]},options);assert.equal(run.status,'executed');assert.equal(JSON.parse(readFileSync(run.result.outputs[0].path)).share,0.5);
  });
  await t.test('同一已选版本的constant只能省略或传保存值，异值和缺少保存值均不能启动执行',async()=>{
   const constantScript="import fs from 'node:fs';const i=JSON.parse(fs.readFileSync(process.argv[2]));fs.writeFileSync(i.outputDir+'/constant.json',JSON.stringify({amount:i.parameters.amount*i.parameters.ratio,zero:i.parameters.zero,flag:i.parameters.flag,empty:i.parameters.empty,nil:i.parameters.nil}));";
   const constantDefinition={applicability:{objectScope:'account_set'},inputs:[{key:'amount',meaning:'amount',type:'number',required:true,source:'current_parameters'},{key:'ratio',meaning:'ratio',type:'number',source:'constant',default:0.5},{key:'zero',meaning:'other',type:'number',source:'constant',default:0},{key:'flag',meaning:'other',type:'boolean',source:'constant',default:false},{key:'empty',meaning:'other',type:'string',source:'constant',default:''},{key:'nil',meaning:'other',type:'null',source:'constant',default:null}],execution:{kind:'script',engine:'javascript',script:constantScript}};
   const proposal=await M.proposeBusinessMethod({target,topic:'rental_income',objectKey:'immutable-constant-values',effectiveFrom:'2026-02',definition:constantDefinition,evidenceRefs:[]},options),choice=await simulatedLocalSelection({target,methodRef:proposal.methodRef},options);
   for(const parameters of [{amount:100},{amount:100,ratio:0.5,zero:0,flag:false,empty:'',nil:null}]){
    const response=await client.call('finance_method_run',{target,methodRef:choice.methodRef,parameters,sources:[]});assert.equal(response.isError,false,response.text);assert.equal(response.data.methodRef,choice.methodRef);assert.deepEqual(JSON.parse(readFileSync(response.data.result.outputs[0].path)),{amount:50,zero:0,flag:false,empty:'',nil:null});
   }
   const before=db.prepare('SELECT COUNT(*) n FROM business_memory_runs').get().n;
   for(const parameters of [{amount:100,ratio:0.8},{amount:100,p1:0.8},{amount:100,zero:1},{amount:100,flag:true},{amount:100,empty:'changed'},{amount:100,nil:'null'}]){
    const rejected=await client.call('finance_method_run',{target,methodRef:choice.methodRef,parameters,sources:[]});assert.equal(rejected.isError,true);assert.match(rejected.text,/finance_memory_constant_conflict/);
   }
   assert.equal(db.prepare('SELECT COUNT(*) n FROM business_memory_runs').get().n,before);
   const incomplete=await M.proposeBusinessMethod({target,topic:'other',objectKey:'missing-constant-value',effectiveFrom:'2026-02',definition:{applicability:{objectScope:'account_set'},inputs:[{key:'ratio',meaning:'ratio',type:'number',source:'constant'}],execution:{kind:'script',engine:'javascript',script:constantScript}},evidenceRefs:[]},options),missing=await simulatedLocalSelection({target,methodRef:incomplete.methodRef},options),view=await M.readBusinessMethod({target,methodRef:missing.methodRef},options);
   assert.equal(view.executable,false);assert.equal(view.status,'needs_local_selection');assert(view.definition.gaps.includes('constant_value_missing'));assert.equal(view.definition.inputs[0].constantState,'missing_saved_value');
   await assert.rejects(M.runBusinessMethod({target,methodRef:missing.methodRef,parameters:{ratio:0.8}},options),{code:'finance_memory_constant_value_missing'});
  });
  await t.test('typed对象命中不能覆盖额外自由适用条件，全部结构化后仍须逐条件匹配',async()=>{
   const path=join(sources,'mixed-condition.json');writeFileSync(path,JSON.stringify({business_key:'LEASE-A1',property_use:'COMMERCIAL',amount:100}));
   const objectScript="import fs from 'node:fs';const i=JSON.parse(fs.readFileSync(process.argv[2]));const o=JSON.parse(fs.readFileSync(i.sources[0].snapshotPath));fs.writeFileSync(i.outputDir+'/object.json',JSON.stringify({amount:o.amount}));",typed={sourceIndex:0,jsonPointer:'/business_key',operator:'equals',expected:'LEASE-A1',field:'business_key'};
   const save=async(objectKey,applicability)=>{const proposal=await M.proposeBusinessMethod({target,topic:'other',objectKey,effectiveFrom:'2026-02',definition:{applicability,inputs:[],execution:{kind:'script',engine:'javascript',script:objectScript}},evidenceRefs:[]},options);return simulatedLocalSelection({target,methodRef:proposal.methodRef},options);};
   for(const [index,free]of [{scope:'property_use must be RESIDENTIAL'},{conditions:['property_use must be RESIDENTIAL']},{scope:'only RESIDENTIAL',conditions:['approved for residential use']}].entries()){
    const selectedMixed=await save('mixed-typed-free-'+index,{objectScope:'business_object',matchConditions:[typed],...free}),view=await M.readBusinessMethod({target,methodRef:selectedMixed.methodRef,sources:[{path}]},options);
    assert.equal(view.applicability.resolution,'unresolved');assert.equal(view.executable,false);assert.equal(view.status,'needs_local_selection');
    const rejected=await client.call('finance_method_run',{target,methodRef:selectedMixed.methodRef,sources:[{path}]});assert.equal(rejected.isError,true);assert.match(rejected.text,/finance_memory_applicability_unresolved/);
   }
   const complete=await save('all-typed-object',{objectScope:'business_object',matchConditions:[typed,{sourceIndex:0,jsonPointer:'/property_use',operator:'equals',expected:'RESIDENTIAL'}]});
   const wrong=await client.call('finance_method_run',{target,methodRef:complete.methodRef,sources:[{path}]});assert.equal(wrong.isError,true);assert.match(wrong.text,/finance_memory_object_mismatch/);
   writeFileSync(path,JSON.stringify({business_key:'LEASE-A1',property_use:'RESIDENTIAL',amount:100}));const accepted=await client.call('finance_method_run',{target,methodRef:complete.methodRef,sources:[{path}]});assert.equal(accepted.isError,false,accepted.text);assert.equal(JSON.parse(readFileSync(accepted.data.result.outputs[0].path)).amount,100);
  });
  await t.test('独立进程在匹配后换源或换源再还原，实际snapshot不同版时脚本均未执行',async()=>{
   const fillers=[join(sources,'race-padding-0.bin'),join(sources,'race-padding-1.bin')];for(const path of fillers)writeFileSync(path,Buffer.alloc(8*1024*1024,83));
   for(const restore of [false,true]){
    const path=join(sources,'snapshot-race-'+restore+'.json'),first=JSON.stringify({business_key:'LEASE-A1',amount:100}),second=JSON.stringify({business_key:'LEASE-A2',amount:200});writeFileSync(path,first);
    const script="import fs from 'node:fs';const i=JSON.parse(fs.readFileSync(process.argv[2]));const o=JSON.parse(fs.readFileSync(i.sources[2].snapshotPath));fs.writeFileSync(i.outputDir+'/object.json',JSON.stringify(o));";
    const proposal=await M.proposeBusinessMethod({target,topic:'other',objectKey:'snapshot-race-'+restore,effectiveFrom:'2026-02',definition:{applicability:{objectScope:'business_object',matchConditions:[{sourceIndex:2,jsonPointer:'/business_key',operator:'equals',expected:'LEASE-A1',field:'business_key'}]},inputs:[],execution:{kind:'script',engine:'javascript',script}},evidenceRefs:[]},options),choice=await simulatedLocalSelection({target,methodRef:proposal.methodRef},options);
    const control=await client.call('finance_method_run',{target,methodRef:choice.methodRef,sources:[...fillers.map(path=>({path})),{path}]});assert.equal(control.isError,false,control.text);assert.equal(control.data.status,'executed');assert.deepEqual(JSON.parse(readFileSync(control.data.result.outputs[0].path)),{business_key:'LEASE-A1',amount:100});
    const controlRecord=JSON.parse(readFileSync(control.data.result.recordPath)),controlCheck=controlRecord.methodSourceVersionChecks.find(check=>check.sourceIndex===2);assert.equal(controlRecord.execution.exitCode,0);assert.equal(controlCheck.matched,true);assert.equal(controlCheck.expectedSha256,digest(first));assert.equal(controlCheck.adoptedSha256,digest(first));assert.equal(controlRecord.sources.length,3);
    const ready=join(root,'race-ready-'+restore),changed=join(root,'race-changed-'+restore),methodRoot=join(audit,'methods'),calculationRoot=join(audit,'calculations');
    const workerOptions={methodRoot,calculationRoot,oldMethods:readdirSync(methodRoot),oldCalculations:readdirSync(calculationRoot),methodRef:choice.methodRef,path,first,second,restore,ready,changed};
    const workerScript=`import fs from 'node:fs';import path from 'node:path';const o=${JSON.stringify(workerOptions)};const end=Date.now()+15000;let switched=false;fs.writeFileSync(o.ready,'ready');while(Date.now()<end){if(!switched){for(const id of fs.readdirSync(o.methodRoot)){if(o.oldMethods.includes(id))continue;const file=path.join(o.methodRoot,id,'begin.json');try{if(JSON.parse(fs.readFileSync(file)).methodRef!==o.methodRef)continue;fs.writeFileSync(o.path,o.second);fs.writeFileSync(o.changed,'changed');switched=true;if(!o.restore)process.exit(0);break;}catch{}}}else{for(const id of fs.readdirSync(o.calculationRoot)){if(o.oldCalculations.includes(id))continue;if(fs.existsSync(path.join(o.calculationRoot,id,'sources','2.json'))){fs.writeFileSync(o.path,o.first);process.exit(0);}}}}process.exit(72);`;
    const worker=spawn(process.execPath,['--input-type=module','--eval',workerScript],{env:{SystemRoot:process.env.SystemRoot??'',WINDIR:process.env.WINDIR??''},stdio:['ignore','ignore','pipe'],windowsHide:true});let diagnostic='';worker.stderr.on('data',bytes=>{diagnostic+=bytes;});const exited=new Promise(resolve=>worker.on('close',resolve));
    try{
     await waitUntil(()=>{if(worker.exitCode!==null)throw Error('synthetic_race_worker_exit '+diagnostic);return existsSync(ready);});
     const response=await client.call('finance_method_run',{target,methodRef:choice.methodRef,sources:[...fillers.map(path=>({path})),{path}]});assert.equal(await exited,0,diagnostic);assert(existsSync(changed));assert.equal(response.isError,true,response.text);assert.notEqual(response.data.status,'executed');
     const actual=JSON.parse(readFileSync(response.data.result.recordPath)),check=actual.methodSourceVersionChecks.find(check=>check.sourceIndex===2);assert(check);assert.equal(check.matched,false);assert.equal(check.expectedSha256,digest(first));assert.equal(check.adoptedSha256,digest(second));assert.equal(actual.execution,undefined,'来源快照版本不符必须在启动脚本前拒绝');assert.equal(actual.outputs.length,0);assert.equal(actual.error.code,'finance_calculation_method_source_changed');if(restore)assert.equal(readFileSync(path,'utf8'),first);
    }finally{if(worker.exitCode===null)worker.kill();writeFileSync(path,first);}
   }
  });
  await t.test('native对象必须与实际原件及读取版本一致，未适配接口明确不可执行',async()=>{
   const firstPath=join(sources,'native-object-a1.json'),secondPath=join(sources,'native-object-a2.json'),scope=M.resolveBusinessMemoryTarget(target,options).scope;
   const inputsA={outputVat:900,certifiedInputVat:500,inputVatTransferOut:0,openingCarryCredit:0,prepaidVat:0},inputsB={...inputsA,outputVat:1300},first=JSON.stringify({scope,business_key:'LEASE-A1',inputs:inputsA}),second=JSON.stringify({scope,business_key:'LEASE-A2',inputs:inputsB});writeFileSync(firstPath,first);writeFileSync(secondPath,second);
   const app={objectScope:'business_object',matchConditions:[{sourceIndex:0,jsonPointer:'/business_key',operator:'equals',expected:'LEASE-A1',field:'business_key'}]},bindings=[{inputPointer:'',originalId:'source',locator:{jsonPointer:'/inputs'}}];
   const proposal=await M.proposeBusinessMethod({target,topic:'vat_treatment',objectKey:'native-object-a1',effectiveFrom:'2026-02',definition:{applicability:app,inputs:[{key:'vat_inputs',meaning:'source_data',type:'object',source:'current_parameters',required:true},{key:'vat_originals',meaning:'source_data',type:'array',source:'current_parameters',required:true}],execution:{kind:'native',tool:'finance_tax_summary_calculate',argsTemplate:{kind:'vat_general',inputs:{$parameter:'vat_inputs'},originals:{$parameter:'vat_originals'},bindings}}},evidenceRefs:[]},options),choice=await simulatedLocalSelection({target,methodRef:proposal.methodRef},options);
   const actualA=await client.call('finance_method_run',{target,methodRef:choice.methodRef,sources:[{path:firstPath}],parameters:{vat_inputs:inputsA,vat_originals:[{id:'source',path:firstPath}]}});assert.equal(actualA.isError,false,actualA.text);assert.equal(actualA.data.result.amounts.due,400);assert.equal(actualA.data.result.status,'conditional_calculated');
   const actualB=await client.call('finance_tax_summary_calculate',{target,kind:'vat_general',inputs:inputsB,originals:[{id:'source',path:secondPath}],bindings});assert.equal(actualB.isError,false,actualB.text);assert.equal(actualB.data.amounts.due,800);
   const mismatch=await client.call('finance_method_run',{target,methodRef:choice.methodRef,sources:[{path:firstPath}],parameters:{vat_inputs:inputsB,vat_originals:[{id:'source',path:secondPath}]}});assert.equal(mismatch.isError,true,mismatch.text);assert.notEqual(mismatch.data.status,'executed');assert.equal(mismatch.data.error.code,'finance_memory_native_object_source_mismatch');
   const {callDirectFinanceTool}=await import('../server/direct-finance.mjs');let invoked=false;
   const swapped=await M.runBusinessMethod({target,methodRef:choice.methodRef,sources:[{path:firstPath}],parameters:{vat_inputs:inputsB,vat_originals:[{id:'source',path:firstPath}]}},{...options,invokeNativeTool:async(name,nativeArgs)=>{
    invoked=true;assert.equal(nativeArgs.originals[0].sha256,digest(first));
    const swap=spawnSync(process.execPath,['--input-type=module','--eval',`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(firstPath)},${JSON.stringify(second)});`],{encoding:'utf8',windowsHide:true});assert.equal(swap.status,0,swap.stderr);
    try{return retainDirectMethodProjection(name,await withFinanceCall({tool:name,args:nativeArgs,auditDir:audit},()=>callDirectFinanceTool(name,nativeArgs)));}finally{writeFileSync(firstPath,first);}
   }});
   assert.equal(invoked,true);assert.equal(readFileSync(firstPath,'utf8'),first);assert.equal(swapped.status,'unknown');assert.equal(swapped.error.code,'finance_summary_source_digest_mismatch');assert.equal(swapped.result,null);
   const unsupported=await M.proposeBusinessMethod({target,topic:'other',objectKey:'native-object-ledger-only',effectiveFrom:'2026-02',definition:{applicability:app,inputs:[],execution:{kind:'native',tool:'period_end_check',argsTemplate:{}}},evidenceRefs:[]},options),unavailable=await simulatedLocalSelection({target,methodRef:unsupported.methodRef},options),view=await M.readBusinessMethod({target,methodRef:unavailable.methodRef,sources:[{path:firstPath}]},options);
   assert.equal(view.status,'not_supported');assert.equal(view.executable,false);assert.equal(view.nativeObjectBinding,'not_supported');await assert.rejects(M.runBusinessMethod({target,methodRef:unavailable.methodRef,sources:[{path:firstPath}]},options),{code:'finance_memory_native_object_binding_unsupported'});
  });
  await t.test('回溯生效和有限区间替代按最新选择revision唯一生效，区间外恢复旧版',async()=>{
   const proposal=await M.proposeBusinessMethod({target,topic:'rental_income',objectKey:'synthetic-lease',effectiveFrom:'2026-01',definition,evidenceRefs:[]},options);
   const backdated=await simulatedLocalSelection({target,methodRef:proposal.methodRef},options,{effectiveFrom:'2026-01'});
   const original=await M.readBusinessMethod({target,methodRef:selected.methodRef},options),newer=await M.readBusinessMethod({target,methodRef:backdated.methodRef},options);assert.equal(original.status,'superseded');assert.equal(original.supersededBy,backdated.methodRef);assert.equal(newer.executable,true);
   const finiteProposal=await M.proposeBusinessMethod({target,topic:'rental_income',objectKey:'synthetic-lease',effectiveFrom:'2026-02',definition,evidenceRefs:[]},options),finite=await simulatedLocalSelection({target,methodRef:finiteProposal.methodRef},options,{effectiveFrom:'2026-02',effectiveTo:'2026-02'});
   const feb=await M.readCompanyContext({target,topics:['rental_income'],limit:50},options),march=await M.readCompanyContext({target:{accountSetId:a,period:'2026-03'},topics:['rental_income'],limit:50},options);
   const objectRef=original.objectRef;assert.deepEqual(feb.methods.filter(m=>m.objectRef===objectRef&&m.executable).map(m=>m.methodRef),[finite.methodRef]);assert.deepEqual(march.methods.filter(m=>m.objectRef===objectRef&&m.executable).map(m=>m.methodRef),[backdated.methodRef]);
   const read=await M.readBusinessMethod({target,methodRef:finite.methodRef},options);assert.equal(read.replacementPolicy,'latest_selected_revision_in_effective_period');assert(read.replaces.includes(backdated.methodRef));
  });
  await t.test('真实HTTP原生折旧受原幂等保护，成功写入自动刷新索引；绑定会话拒绝ordinary跨账套',async()=>{
   await client.close();
   backend=spawn(process.execPath,[join(repo,'06-workbench/server/server.mjs')],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',FINANCE_BUSINESS_SESSION:''},stdio:['ignore','pipe','pipe'],windowsHide:true});let diagnostic='';backend.stderr.on('data',d=>{diagnostic+=d;});
   base=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('synthetic_backend_timeout '+diagnostic)),15000);backend.stdout.on('data',d=>{out+=d;const match=/http:\/\/127\.0\.0\.1:\d+/.exec(out);if(match){clearTimeout(timer);resolve(match[0]);}});backend.on('exit',()=>{clearTimeout(timer);reject(Error('synthetic_backend_exit '+diagnostic));});});
   const session=join(root,'session.json'),binding=M.resolveBusinessMemoryTarget(target,options);writeFileSync(session,JSON.stringify({version:'finance-business-session/1',databasePath:dbPath,scope:binding.scope}));
   client=startClient(session);await client.initialize();
   const historyLedger=await client.call('ledger_query',{accountSetId:a,code:'1002',period:'2026-01'});assert.equal(historyLedger.isError,false,historyLedger.text);assert.equal(historyLedger.data.projection.closingBalance,1200);
   const historyQuery=await client.call('finance_query',{accountSetId:a,nodeId:'report.trial_balance',period:'2026-01'});assert.equal(historyQuery.isError,false,historyQuery.text);assert.equal(historyQuery.data.operation,'finance_query:report.trial_balance');
   const historyCheck=await client.call('period_end_check',{accountSetId:a,period:'2026-01'});assert.equal(historyCheck.isError,false,historyCheck.text);
   const crossHistory=await client.call('ledger_query',{accountSetId:b,code:'1002',period:'2026-01'});assert.equal(crossHistory.isError,true);assert.match(crossHistory.text,/finance_memory_session_conflict/);
   const beforeHistoryWrite=db.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?').get(a).n,historyWrite=await client.call('voucher_create',{accountSetId:a,period:'2026-01',voucher_date:'2026-01-31',status:'draft',entries:[{code:'1002',debit:100},{code:'1001',credit:100}]});assert.equal(historyWrite.isError,true);assert.match(historyWrite.text,/finance_memory_session_conflict/);assert.equal(db.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?').get(a).n,beforeHistoryWrite);
   const pastMemory=await client.call('finance_company_context',{target:{accountSetId:a,period:'2026-01'}});assert.equal(pastMemory.isError,true);assert.match(pastMemory.text,/finance_memory_session_conflict/);
   const contextBefore=(await client.call('finance_company_context',{target,limit:50})).data,assetMethod=contextBefore.methods.find(m=>m.topic==='depreciation'&&m.executable),carryMethod=contextBefore.methods.find(m=>m.topic==='carry_forward'&&m.authority==='observed_history');assert(assetMethod);assert(carryMethod);
   const selectedAsset=await simulatedLocalSelection({target,methodRef:assetMethod.methodRef},options),selectedCarry=await simulatedLocalSelection({target,methodRef:carryMethod.methodRef},options),method={methodRef:selectedAsset.methodRef};
   for(const selectedNative of [selectedAsset,selectedCarry]){
    const view=await M.readBusinessMethod({target,methodRef:selectedNative.methodRef},options);assert.equal(view.executable,true);assert.equal(view.applicability.resolution,'account_set');assert.equal(view.definition.applicability.unstructuredScopePresent,false);
    const nextPeriod=await M.readBusinessMethod({target:{accountSetId:a,period:'2026-03'},methodRef:selectedNative.methodRef},options);assert.equal(nextPeriod.executable,true);assert.equal(nextPeriod.methodRef,selectedNative.methodRef);
   }
   const run=await client.call('finance_method_run',{target,methodRef:method.methodRef});assert.equal(run.isError,false,run.text);assert.equal(run.data.result.modelResult.applied,true);assert.equal(db.prepare("SELECT COUNT(*) n FROM vouchers WHERE account_set_id=? AND kind='depreciation' AND period='2026-02'").get(a).n,1);
   const context=(await client.call('finance_company_context',{target})).data;assert.equal(context.status,'ready');
   const repeat=await client.call('finance_method_run',{target,methodRef:method.methodRef});assert.equal(repeat.isError,false,repeat.text);assert.equal(db.prepare("SELECT COUNT(*) n FROM vouchers WHERE account_set_id=? AND kind='depreciation' AND period='2026-02'").get(a).n,1);
   const wrong=await client.call('depreciation_run',{accountSetId:b,period:'2026-02'});assert.equal(wrong.isError,true);assert.match(wrong.text,/finance_memory_session_conflict/);
   const comparison=await client.call('finance_calculation_run',{title:'合成比较期',engine:'javascript',script:'console.log(1)',sources:[],parameters:{period:'2020-01'}});assert.equal(comparison.isError,false,comparison.text);
   const wrongData=join(root,'wrong-backend');mkdirSync(wrongData);
   const setup=`const {db}=await import(${JSON.stringify(new URL('../server/db.mjs',import.meta.url).href)});const A=await import(${JSON.stringify(new URL('../server/accounting.mjs',import.meta.url).href)});const id=A.createAccountSet({name:'合成错误后端',start_period:'2026-01',profileId:'small-2011-basic-v1',enterprise:{enterpriseKey:'SYNTHETIC-WRONG-BACKEND'}}).id;A.setOpeningBalances(id,[{code:'1601',debit:12000},{code:'3001',credit:12000}]);A.addAssetCard(id,{name:'合成设备',original_cost:12000,residual_rate:0,useful_life_months:12,start_period:'2026-02',acquired_period:'2026-01'});db.close();`;
   const setupResult=spawnSync(process.execPath,['--input-type=module','--eval',setup],{env:{...process.env,WORKBENCH_DATA_DIR:wrongData,FINANCE_BUSINESS_SESSION:''},encoding:'utf8',windowsHide:true});assert.equal(setupResult.status,0,setupResult.stderr);
   const wrongBackend=spawn(process.execPath,[join(repo,'06-workbench/server/server.mjs')],{env:{...process.env,WORKBENCH_DATA_DIR:wrongData,HOST:'127.0.0.1',PORT:'0',FINANCE_BUSINESS_SESSION:''},stdio:['ignore','pipe','pipe'],windowsHide:true});let wrongDiagnostic='';wrongBackend.stderr.on('data',d=>{wrongDiagnostic+=d;});
   try{
    const wrongBase=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('synthetic_wrong_backend_timeout '+wrongDiagnostic)),15000);wrongBackend.stdout.on('data',d=>{out+=d;const match=/http:\/\/127\.0\.0\.1:\d+/.exec(out);if(match){clearTimeout(timer);resolve(match[0]);}});wrongBackend.on('exit',()=>{clearTimeout(timer);reject(Error('synthetic_wrong_backend_exit '+wrongDiagnostic));});});
    await client.close();base=wrongBase;client=startClient(session);await client.initialize();
    const wrongDb=new DatabaseSync(join(wrongData,'workbench.db'),{readOnly:true});try{
     assert.equal(wrongDb.prepare("SELECT COUNT(*) n FROM vouchers WHERE kind='depreciation'").get().n,0);
     const denied=await client.call('finance_method_run',{target,methodRef:method.methodRef});assert.equal(denied.isError,true,denied.text);assert.equal(denied.data.status,'unknown');assert.equal(wrongDb.prepare("SELECT COUNT(*) n FROM vouchers WHERE kind='depreciation'").get().n,0,'API指向另一个有效账库时，身份头须在任何原生写入前拒绝');
    }finally{wrongDb.close();}
   }finally{wrongBackend.kill();}
  });
  await t.test('原件变化与已过账事实分别披露，刷新缓存不能把变更案例重新标current/preferred',async()=>{
   const originalFile=readdirSync(sources).map(name=>join(sources,name)).find(path=>{try{return JSON.parse(readFileSync(path)).凭证日期==='2026-01-15';}catch{return false;}});assert(originalFile);
   const originalText=readFileSync(originalFile,'utf8'),value=JSON.parse(originalText);value.分录[0].debit=1201;writeFileSync(originalFile,JSON.stringify(value));
   for(const refresh of [false,true]){
    if(refresh)await M.prepareBusinessMemory({target},options);
    const result=await M.searchBusinessCases({target,topic:'rental_income'},options),history=result.cases.find(c=>c.voucher?.voucherId===voucher.id);
    assert.equal(history.ledgerFact.status,'posted');assert.equal(history.entries[0].debit,1200);assert.equal(history.sourceEvidence.status,'changed');assert.equal(history.freshness,'changed');assert.equal(history.preferred,false);assert(history.gaps.includes('source_version_unverified'));if(refresh)assert.equal(result.cacheState,'current');
   }
  });
  await t.test('readonly进程不能通过新RW连接绕开写保护，所有记忆写入口拒绝且读可用',async()=>{
   const before=db.prepare('SELECT revision FROM business_memory_state WHERE account_set_id=? AND period=?').get(a,target.period).revision,previous=process.env.WORKBENCH_DATABASE_MODE;
   process.env.WORKBENCH_DATABASE_MODE='readonly';db.exec('PRAGMA query_only=ON');
   try{
    await assert.rejects(M.prepareBusinessMemory({target},options),{code:'finance_memory_readonly'});
    await assert.rejects(M.proposeBusinessMethod({target,topic:'rental_income',effectiveFrom:'2026-02',definition,evidenceRefs:[]},options),{code:'finance_memory_readonly'});
    await assert.rejects(M.runBusinessMethod({target,methodRef:selected.methodRef},options),{code:'finance_memory_readonly'});
    await assert.rejects(M.selectBusinessMethodInteractively({target,methodRef:candidate},options),{code:'finance_memory_readonly'});
    assert.equal((await M.readCompanyContext({target},options)).scopeVerified,true);assert.equal(db.prepare('SELECT revision FROM business_memory_state WHERE account_set_id=? AND period=?').get(a,target.period).revision,before);
   }finally{if(previous===undefined)delete process.env.WORKBENCH_DATABASE_MODE;else process.env.WORKBENCH_DATABASE_MODE=previous;db.exec('PRAGMA query_only=OFF');}
  });
 }finally{await client?.close();backend?.kill();db.close();}
});
